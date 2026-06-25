const os = require("os");
const net = require("net");
const dns = require("dns");

// Reverse-resolve the host in a URL to a hostname, so the UI can show
// "127.0.0.1:11434 (localhost)". Only IP literals are looked up — if the URL
// already uses a name there's nothing to add. Uses getnameinfo (lookupService)
// rather than dns.reverse so /etc/hosts and mDNS (.local) are consulted, which
// is how 127.0.0.1 -> localhost and LAN names resolve. Returns "" on
// failure/timeout (a LAN IP can hang or simply have no name).
async function hostnameFor(url) {
  let host;
  try {
    host = new URL(/^https?:\/\//i.test(url) ? url : "http://" + url).hostname;
  } catch {
    return "";
  }
  if (!net.isIP(host)) return "";
  return await new Promise((resolve) => {
    let done = false;
    const finish = (val) => { if (!done) { done = true; resolve(val); } };
    const timer = setTimeout(() => finish(""), 1500);
    dns.lookupService(host, 0, (err, hostname) => {
      clearTimeout(timer);
      // getnameinfo echoes the IP back when no name exists — treat that as none.
      const name = !err && hostname && hostname !== host ? hostname.replace(/\.$/, "") : "";
      finish(name);
    });
  });
}

// All of this host's non-internal IPv4 addresses. A machine often has several
// (Wi-Fi, Ethernet, VPN, Docker bridge…), so we can't assume the LAN one is
// first — we scan every /24 the host sits on.
function getLocalIPv4s() {
  const out = [];
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) {
        out.push(iface.address);
      }
    }
  }
  return out;
}

// Probe a single host:port. `path` lets each service hit a cheap endpoint that
// confirms it's the service we want (Ollama answers on "/", ComfyUI on
// "/system_stats"). Returns the base URL on success, null otherwise.
async function checkHost(host, port, path, signal) {
  const url = `http://${host}:${port}`;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    if (signal) signal.addEventListener("abort", () => controller.abort());
    try {
      const resp = await fetch(url + path, { signal: controller.signal });
      if (resp.ok) return url;
    } finally {
      clearTimeout(timeout);
    }
  } catch {}
  return null;
}

// Stream discovered service instances over Server-Sent Events so the client can
// show each one the moment it's found and cancel the rest by closing the
// connection. Localhost is probed first so the local machine surfaces first.
// `probe(host, signal)` resolves to a URL string or null.
function streamScan(req, res, probe) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  let closed = false;
  const abort = new AbortController();
  const send = (obj) => {
    if (closed) return;
    try {
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    } catch {}
  };

  // Client disconnected (selection made or ESC pressed) → stop scanning.
  req.on("close", () => {
    closed = true;
    try {
      abort.abort();
    } catch {}
  });

  (async () => {
    // Local machine first.
    const localhost = await probe("127.0.0.1", abort.signal);
    if (localhost) send({ type: "found", url: localhost });

    // Then every /24 the host sits on (skip our own IPs — localhost covers us).
    const selfIps = new Set(getLocalIPv4s());
    const subnets = [...new Set([...selfIps].map((ip) => ip.split(".").slice(0, 3).join(".")))];
    if (subnets.length && !closed) {
      const promises = [];
      for (const subnet of subnets) {
        for (let i = 1; i <= 254; i++) {
          const ip = `${subnet}.${i}`;
          if (ip === "127.0.0.1" || selfIps.has(ip)) continue;
          promises.push(probe(ip, abort.signal).then((r) => r && send({ type: "found", url: r })));
        }
      }
      await Promise.all(promises);
    }

    send({ type: "done" });
    if (!closed) {
      try {
        res.end();
      } catch {}
    }
  })();
}

function scanOllamaStream(req, res) {
  streamScan(req, res, (host, signal) => checkHost(host, 11434, "/", signal));
}

function scanComfyStream(req, res) {
  streamScan(req, res, (host, signal) => checkHost(host, 8188, "/system_stats", signal));
}

module.exports = { scanOllamaStream, scanComfyStream, hostnameFor };
