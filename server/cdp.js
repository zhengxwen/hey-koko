// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

// Co-browsing bridge: read pages from the user's dedicated CDP-enabled Chrome.
//
// The user runs a SEPARATE Chrome instance (own --user-data-dir, so their private
// daily browser is never touched) with --remote-debugging-port; hey-koko attaches
// over the Chrome DevTools Protocol and reads the LIVE DOM — which sees logged-in
// pages and SPA-rendered content that a plain server-side fetch cannot. v1 is
// strictly read-only: list tabs + extract page content. Zero dependencies: Node 22's
// built-in fetch + WebSocket speak the whole protocol.
//
// Launch (macOS): open -na "Google Chrome" --args \
//   --user-data-dir="$HOME/.hey-koko/chrome" --remote-debugging-port=9222
// (Chrome 136+ ignores --remote-debugging-port on the DEFAULT profile dir, so a
// dedicated profile is not just hygiene — it is the only way the port opens.)

const path = require("path");
const fs = require("fs");
const { spawn, execFileSync } = require("child_process");
const config = require("./config");
const { sendJson, readBody } = require("./utils");
const { extractArticle, extractCleanContent, trafilaturaAvailable, optimizeImage } = require("./url-fetch");

// Fed back to the model as the tool result when the browser is unreachable, so it
// can tell the user exactly how to start the shared browser.
const LAUNCH_HINT = 'The co-browsing Chrome is not running (CDP port unreachable). ' +
  'Ask the user to start it first — on macOS run ./start-cobrowsing-chrome.command in the hey-koko ' +
  'folder, or: open -na "Google Chrome" --args --user-data-dir="$HOME/.hey-koko/chrome" ' +
  '--remote-debugging-port=9222 — then retry.';

// ---- CDP plumbing ----

// Real web-page targets only: no devtools/extension/service-worker targets, and no
// chrome:// internals — those are never what "read this page" means.
async function listPageTargets() {
  const res = await fetch(config.BROWSER_CDP.cdpBase + "/json/list", { signal: AbortSignal.timeout(3000) });
  if (!res.ok) throw new Error(`CDP /json/list HTTP ${res.status}`);
  const all = await res.json();
  return (Array.isArray(all) ? all : []).filter(
    (t) => t.type === "page" && /^(https?|file):/i.test(t.url || "") && t.webSocketDebuggerUrl,
  );
}

// One-shot Runtime.evaluate on a target: connect, evaluate, disconnect. CDP needs no
// domain enabling for evaluate, so a single round-trip suffices; keeping no sockets
// open means we never hold a DevTools session that would block the user's own DevTools.
function cdpEval(wsUrl, expression, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let ws;
    try { ws = new WebSocket(wsUrl); } catch (e) { reject(e); return; }
    const timer = setTimeout(() => { try { ws.close(); } catch { /* ignore */ } reject(new Error("CDP timeout")); }, timeoutMs);
    const done = (fn, v) => { clearTimeout(timer); try { ws.close(); } catch { /* ignore */ } fn(v); };
    ws.onerror = () => done(reject, new Error("CDP socket error"));
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id !== 1) return; // stray protocol events
      if (msg.error) return done(reject, new Error(msg.error.message || "CDP error"));
      const r = msg.result || {};
      if (r.exceptionDetails) return done(reject, new Error(r.exceptionDetails.text || "page JS exception"));
      done(resolve, r.result ? r.result.value : undefined);
    };
  });
}

// Viewport screenshot of a target (JPEG). Page.bringToFront first: a HEADFUL
// background tab isn't being rendered, so capturing it fails without fronting —
// a no-op for the already-active tab; the caller restores the user's tab after.
function cdpCapture(wsUrl, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    let ws;
    try { ws = new WebSocket(wsUrl); } catch (e) { reject(e); return; }
    const timer = setTimeout(() => { try { ws.close(); } catch { /* ignore */ } reject(new Error("CDP capture timeout")); }, timeoutMs);
    const done = (fn, v) => { clearTimeout(timer); try { ws.close(); } catch { /* ignore */ } fn(v); };
    ws.onerror = () => done(reject, new Error("CDP socket error"));
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Page.bringToFront" }));
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.error) return done(reject, new Error(msg.error.message || "CDP error"));
      if (msg.id === 1) ws.send(JSON.stringify({ id: 2, method: "Page.captureScreenshot", params: { format: "jpeg", quality: 80 } }));
      else if (msg.id === 2) done(resolve, (msg.result && msg.result.data) || "");
    };
  });
}

// The tab the user is looking at: focused beats merely-visible (one visible tab per
// window, but only one window has focus) beats first-listed. Chrome not frontmost →
// nothing hasFocus, the visible tie-break still picks a sensible tab per /json order
// (roughly most-recently-active first).
async function findActiveTarget(targets) {
  const scores = await Promise.all(targets.map((t) =>
    cdpEval(t.webSocketDebuggerUrl, '(document.visibilityState === "visible" ? 1 : 0) + (document.hasFocus() ? 1 : 0)', 2500)
      .catch(() => -1),
  ));
  let best = 0;
  for (let i = 1; i < targets.length; i++) if (scores[i] > scores[best]) best = i;
  return targets[best];
}

// ---- content extraction (reuses the /url pipeline) ----

// Collapse markdown image refs to placeholders — the tool feeds an LLM, raw image
// URLs are pure token waste. Same policy as extractCleanContent's own output.
function collapseImages(md) {
  return String(md || "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_, alt) => {
      const a = (alt || "").trim();
      return a && a.length <= 60 ? `[image: ${a}]` : "[image]";
    })
    .replace(/(\[image[^\]]*\])(\s*\n\s*\[image[^\]]*\])+/g, "$1")
    .replace(/\n{3,}/g, "\n\n");
}

// Live DOM → clean article text. Same preference order as /url: trafilatura sidecar
// when installed (best-in-class boilerplate removal), zero-dep JS heuristic otherwise
// or when trafilatura returns nothing usable. maxImages=0: text only, no downloads.
async function extractFromHtml(html, url) {
  if (await trafilaturaAvailable()) {
    try {
      const r = await extractArticle(html, url, 0);
      const body = collapseImages(r.text || "").trim();
      if (body.length >= 40) return { text: body, title: (r.meta && r.meta.title) || "" };
    } catch { /* degrade to the JS path below */ }
  }
  const r = await extractCleanContent(html, url);
  return { text: r.text, title: "" };
}

// ---- request handlers ----

// GET /api/browser/tabs → { tabs: [{index, id, title, url, active}] }
async function browserTabs(req, res) {
  let targets;
  try { targets = await listPageTargets(); } catch { sendJson(res, 200, { error: "unreachable", hint: LAUNCH_HINT }); return; }
  const active = targets.length > 1 ? await findActiveTarget(targets) : targets[0];
  sendJson(res, 200, {
    tabs: targets.map((t, i) => ({ index: i + 1, id: t.id, title: t.title || "", url: t.url, active: t === active })),
  });
}

// body.tab: "" / absent → active tab; "3" → 1-based index from browserTabs;
// anything else → case-insensitive substring of URL or title (first match wins).
function resolveTarget(targets, tab) {
  const spec = String(tab || "").trim();
  if (!spec) return null; // caller falls back to the active tab
  if (/^\d+$/.test(spec)) return targets[Number(spec) - 1] || undefined;
  const q = spec.toLowerCase();
  return targets.find((t) => (t.url || "").toLowerCase().includes(q) || (t.title || "").toLowerCase().includes(q));
}

// POST /api/browser/read { tab?, maxChars? } → { title, url, text, selection, truncated }
async function browserRead(req, res) {
  let body = {};
  try { body = await readBody(req); } catch { /* treat as empty */ }
  let targets;
  try { targets = await listPageTargets(); } catch { sendJson(res, 200, { error: "unreachable", hint: LAUNCH_HINT }); return; }
  if (!targets.length) { sendJson(res, 200, { error: "no_tabs" }); return; }

  let target = resolveTarget(targets, body.tab);
  if (target === undefined) {
    sendJson(res, 200, { error: "tab_not_found", tabs: targets.map((t, i) => `${i + 1}. ${t.title} (${t.url})`) });
    return;
  }
  if (!target) target = targets.length > 1 ? await findActiveTarget(targets) : targets[0];

  // Viewport screenshot, best-effort: Page.bringToFront is required for a headful
  // BACKGROUND tab (not rendered otherwise), so remember the user's current tab and
  // hand focus straight back afterwards. A capture failure never breaks the read.
  const maybeCapture = async (target) => {
    try {
      const active = targets.length > 1 ? await findActiveTarget(targets) : targets[0];
      const raw = await cdpCapture(target.webSocketDebuggerUrl);
      if (active && active.id !== target.id) {
        fetch(`${config.BROWSER_CDP.cdpBase}/json/activate/${active.id}`).catch(() => { /* focus restore is best-effort */ });
      }
      if (!raw) return null;
      // Retina viewports capture at 2x (easily >1MB) — shrink via the shared
      // image backend when present; keep the original when it's missing.
      try {
        const o = await optimizeImage(Buffer.from(raw, "base64"), "image/jpeg");
        return { image: o.buf.toString("base64"), imageMime: o.ct };
      } catch { return { image: raw, imageMime: "image/jpeg" }; }
    } catch { return null; }
  };

  try {
    // Selection-only mode (--sel): repeated per-passage reads of a page whose full
    // text is already in the conversation. Skips the outerHTML transfer AND the
    // extraction pipeline — the snapshot is just title/url/selection.
    const selOnly = body.selectionOnly === true;
    const snapExpr = `(() => ({
      title: document.title || "",
      url: location.href,
      selection: String(window.getSelection ? window.getSelection().toString() : "").slice(0, 8000),
      html: ${selOnly ? '""' : '(document.documentElement ? document.documentElement.outerHTML : "")'},
    }))()`;
    // One evaluate grabs everything live (SPAs mutate title/url after load; the
    // selection is often the very thing the user is asking about).
    const snap = await cdpEval(target.webSocketDebuggerUrl, snapExpr);

    if (selOnly) {
      if (!snap) { sendJson(res, 200, { error: "empty page" }); return; }
      if (!snap.selection) { sendJson(res, 200, { error: "no_selection" }); return; }
      // No auto screenshot here — --sel is the deliberately lightweight mode.
      const shot = body.vision === true ? await maybeCapture(target) : null;
      sendJson(res, 200, {
        title: snap.title, url: snap.url, text: "", selection: snap.selection,
        truncated: false, ...(shot || {}),
      });
      return;
    }

    if (!snap || !snap.html) { sendJson(res, 200, { error: "empty page" }); return; }
    const ex = await extractFromHtml(snap.html, snap.url);
    const cap = Math.min(Number(body.maxChars) || 20000, config.URL_CONTENT_MAX_CHARS);
    const text = String(ex.text || "").trim();

    // body.vision === true forces a screenshot; "auto" captures only when the
    // extracted text is near-empty (canvas charts, embedded PDF viewer, WebGL —
    // pages whose content the DOM extraction can't see).
    const wantShot = body.vision === true || (body.vision === "auto" && text.length < 200);
    const shot = wantShot ? await maybeCapture(target) : null;

    sendJson(res, 200, {
      title: ex.title || snap.title,
      url: snap.url,
      text: text.slice(0, cap),
      selection: snap.selection || "",
      truncated: text.length > cap,
      ...(shot ? { ...shot, visionAuto: body.vision === "auto" } : {}),
    });
  } catch (e) {
    sendJson(res, 200, { error: e.message || "read failed" });
  }
}

// ---- launching the co-browsing Chrome ----

// Chrome/Chromium executable on non-mac platforms; "" when none found.
function findChromeExe() {
  if (process.platform === "win32") {
    const cands = [
      path.join(process.env["ProgramFiles"] || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
      path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
      path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
    ];
    return cands.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || "";
  }
  for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
    try { execFileSync("which", [name], { stdio: "ignore" }); return name; } catch { /* keep looking */ }
  }
  return "";
}

// Main browser process of the co-browsing instance: matches the dedicated profile
// dir but NOT the "--type=" helper processes (renderer/gpu/utility) that inherit it.
function findCobrowsePid(profileDir) {
  try {
    const out = execFileSync("ps", ["ax", "-o", "pid=,command="], { encoding: "utf8" });
    for (const line of out.split("\n")) {
      if (line.includes(`--user-data-dir=${profileDir}`) && !line.includes("--type=")) {
        return Number(line.trim().split(/\s+/)[0]) || 0;
      }
    }
  } catch { /* fall through */ }
  return 0;
}

// Bring the already-running co-browsing Chrome to the foreground (macOS only).
// Targeted by PID via System Events — `tell application "Google Chrome"` would be
// ambiguous with the user's private Chrome running as a second app instance.
// Best-effort: the first call may pop a one-time macOS automation permission prompt.
function frontCobrowseChrome(profileDir) {
  if (process.platform !== "darwin") return false;
  const pid = findCobrowsePid(profileDir);
  if (!pid) return false;
  try {
    execFileSync("osascript", ["-e",
      `tell application "System Events" to set frontmost of (first process whose unix id is ${pid}) to true`,
    ], { timeout: 5000, stdio: "ignore" });
    return true;
  } catch { return false; }
}

// POST /api/browser/launch — start the dedicated co-browsing Chrome on the SERVER
// machine (the same machine the CDP bridge connects to, which matters when the
// frontend is opened from another device). Same profile+port contract as
// start-cobrowsing-chrome.command. Already running → no relaunch (it would only pile on
// windows); instead bring the existing instance to the foreground.
async function browserLaunch(req, res) {
  let host = "127.0.0.1", port = 9222;
  try { const u = new URL(config.BROWSER_CDP.cdpBase); host = u.hostname; port = Number(u.port) || 9222; } catch { /* keep defaults */ }
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
    sendJson(res, 200, { error: `cdpBase points at ${host} — start Chrome on that machine instead.` });
    return;
  }
  try {
    await listPageTargets();
    frontCobrowseChrome(path.join(config.DATA_DIR, "chrome"));
    sendJson(res, 200, { ok: true, already: true });
    return;
  } catch { /* not running — launch (a fresh `open -na` fronts itself) */ }

  const args = [`--user-data-dir=${path.join(config.DATA_DIR, "chrome")}`, `--remote-debugging-port=${port}`];
  try {
    if (process.platform === "darwin") {
      spawn("open", ["-na", "Google Chrome", "--args", ...args], { detached: true, stdio: "ignore" }).unref();
    } else {
      const exe = findChromeExe();
      if (!exe) { sendJson(res, 200, { error: "No Chrome/Chromium found on the server machine." }); return; }
      spawn(exe, args, { detached: true, stdio: "ignore" }).unref();
    }
    sendJson(res, 200, { ok: true });
  } catch (e) {
    sendJson(res, 200, { error: e.message || "launch failed" });
  }
}

module.exports = { browserTabs, browserRead, browserLaunch };
