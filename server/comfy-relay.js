// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

// Same-origin bridge from the browser to ComfyUI, for the two things the page used to do
// by talking to ComfyUI directly: the live progress/preview WebSocket and the Stop
// button's /interrupt.
//
// Talking to ComfyUI straight from the page only works when the browser sits next to this
// server. Opened from another device (an iPad over `tailscale serve`) it breaks three ways:
//   - an https page may only open wss://, and ComfyUI does not speak TLS;
//   - "127.0.0.1:8188" means the iPad itself, not the Mac that runs ComfyUI;
//   - away from home the LAN address of the GPU box is unreachable.
// It was also broken for a ComfyUI on this machine all along: ComfyUI refuses a loopback
// request whose Origin port differs from its own (origin_only_middleware), so the page at
// :1314 got 403 from the socket on :8188. Here the server dials ComfyUI itself — the same
// host the server already submits prompts to — and sends no Origin.
//
// The socket is relayed as raw bytes after ComfyUI's 101 answer, so text and binary
// (preview) frames, permessage-deflate and close frames all pass through untouched, and
// ComfyUI sees exactly one socket per client id, as before. ComfyUI is reached over plain
// http/ws only, matching what the page did (the host it holds carries no scheme).

const net = require("net");
const { sendJson, readBody } = require("./utils");

const WS_PATH = "/api/comfy-ws";

// "host:port" as the page holds it → { host, port, hostHeader }, or null. Only a bare
// host with an optional port is accepted — no scheme, path, query, or user info — so the
// relay can only ever reach "http://<host>:<port>/ws" or "/interrupt".
function parseTarget(s) {
  if (typeof s !== "string") return null;
  s = s.trim();
  if (!s || s.length > 255 || /[\s/?#@\\]/.test(s)) return null;
  let u;
  try { u = new URL(`http://${s}`); } catch { return null; }
  if (!u.hostname) return null;
  const port = u.port ? Number(u.port) : 80;
  if (!(port > 0 && port < 65536)) return null;
  return { host: u.hostname.replace(/^\[|\]$/g, ""), port, hostHeader: u.host };
}

// A page on another site must not be able to borrow this bridge: browsers attach Origin to
// every WebSocket handshake and to every POST, and a page cannot forge it. The page's own
// origin matches the Host it was served under — or, behind a reverse proxy such as
// `tailscale serve`, the X-Forwarded-Host the proxy records. No Origin at all means a
// non-browser client, which no web page can drive.
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  let originHost;
  try { originHost = new URL(origin).host.toLowerCase(); } catch { return false; }
  const hosts = [req.headers.host, ...String(req.headers["x-forwarded-host"] || "").split(",")]
    .map((h) => String(h || "").trim().toLowerCase())
    .filter(Boolean);
  return hosts.includes(originHost);
}

// The server's "upgrade" event hands over EVERY upgrade request; anything that is not the
// relay is refused here, since without a handler Node would leave the socket hanging.
function handleUpgrade(req, socket, head) {
  socket.on("error", () => {});
  let settled = false;
  const refuse = (code, text) => {
    if (settled) return;
    settled = true;
    try { socket.end(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); }
    catch { socket.destroy(); }
  };

  let url;
  try { url = new URL(req.url, "http://relay.local"); } catch { refuse(400, "Bad Request"); return; }
  if (url.pathname !== WS_PATH) { refuse(404, "Not Found"); return; }
  if (!sameOrigin(req)) { refuse(403, "Forbidden"); return; }
  const target = parseTarget(url.searchParams.get("host"));
  const clientId = url.searchParams.get("clientId") || "";
  const key = req.headers["sec-websocket-key"];
  if (!target || !clientId || clientId.length > 200 || !key ||
      String(req.headers.upgrade || "").toLowerCase() !== "websocket") {
    refuse(400, "Bad Request");
    return;
  }

  const upstream = net.connect({ host: target.host, port: target.port });
  upstream.on("error", () => {});
  // Budget for connect + handshake only; cleared once the two sockets are joined, since
  // a progress socket legitimately stays quiet for minutes between renders.
  upstream.setTimeout(10000, () => upstream.destroy());
  upstream.on("close", () => {
    if (!settled) refuse(502, "Bad Gateway");
    else socket.destroy();
  });
  socket.on("close", () => upstream.destroy());

  upstream.on("connect", () => {
    const lines = [
      `GET /ws?clientId=${encodeURIComponent(clientId)} HTTP/1.1`,
      `Host: ${target.hostHeader}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${key}`,
      `Sec-WebSocket-Version: ${req.headers["sec-websocket-version"] || "13"}`,
    ];
    // Passed through so the two ends negotiate compression between themselves.
    const ext = req.headers["sec-websocket-extensions"];
    if (ext) lines.push(`Sec-WebSocket-Extensions: ${ext}`);
    upstream.write(lines.join("\r\n") + "\r\n\r\n");
    if (head && head.length) upstream.write(head);
  });

  // Hold ComfyUI's answer until its header block is complete: only a 101 gets joined to
  // the browser, so the relay cannot be turned into a pipe to something that isn't a
  // WebSocket server.
  let pending = Buffer.alloc(0);
  const onHandshake = (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    const end = pending.indexOf("\r\n\r\n");
    if (end < 0) {
      if (pending.length > 16384) upstream.destroy();
      return;
    }
    if (!/^HTTP\/1\.[01] 101\b/.test(pending.subarray(0, 16).toString("latin1"))) {
      upstream.destroy();   // → close handler answers 502
      return;
    }
    settled = true;
    upstream.removeListener("data", onHandshake);
    upstream.setTimeout(0);
    upstream.setNoDelay(true);
    socket.setNoDelay(true);
    socket.write(pending);   // the 101 itself, plus any frames that arrived with it
    pending = null;
    upstream.pipe(socket);
    socket.pipe(upstream);
  };
  upstream.on("data", onHandshake);
}

// POST /api/comfy-interrupt {host} — the Stop button's interrupt, sent by the server.
// Only /interrupt, as the server's own interrupt and the job queue's cancel do. (The page
// also used to POST /queue {clear:true}, but as a JSON cross-origin POST it needed a CORS
// preflight ComfyUI does not answer by default, so it never reached ComfyUI; carrying it
// over now would start wiping prompts that other jobs queued.)
async function handleInterrupt(req, res) {
  if (!sameOrigin(req)) { sendJson(res, 403, { error: "forbidden" }); return; }
  let body;
  try { body = await readBody(req); } catch { sendJson(res, 400, { error: "invalid body" }); return; }
  const target = parseTarget(body && body.host);
  if (!target) { sendJson(res, 400, { error: "invalid host" }); return; }
  try {
    const r = await fetch(`http://${target.hostHeader}/interrupt`, { method: "POST", signal: AbortSignal.timeout(5000) });
    sendJson(res, 200, { ok: r.ok });
  } catch (e) {
    sendJson(res, 502, { error: e.message || "unreachable" });
  }
}

module.exports = { handleUpgrade, handleInterrupt, parseTarget, sameOrigin, WS_PATH };
