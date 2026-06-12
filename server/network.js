const os = require("os");
const config = require("./config");
const { sendJson } = require("./utils");

function getLocalSubnet() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) {
        const parts = iface.address.split(".");
        return parts.slice(0, 3).join(".");
      }
    }
  }
  return null;
}

function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) {
        return iface.address;
      }
    }
  }
  return null;
}

async function checkOllama(host) {
  const url = `http://${host}:11434`;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);
    const resp = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (resp.ok) return url;
  } catch {}
  return null;
}

async function scanOllama(res, body = {}) {
  const includeLocal = body.includeLocal !== false;
  const results = [];

  // Check localhost first
  if (includeLocal) {
    const localhost = await checkOllama("127.0.0.1");
    if (localhost) results.push(localhost);
  }

  // Scan LAN subnet
  const subnet = getLocalSubnet();
  const localIp = subnet ? getLocalIp() : null;
  if (subnet) {
    const promises = [];
    for (let i = 1; i <= 254; i++) {
      const ip = `${subnet}.${i}`;
      if (ip === "127.0.0.1") continue;
      if (!includeLocal && ip === localIp) continue;
      promises.push(checkOllama(ip).then(r => r ? results.push(r) : null));
    }
    await Promise.all(promises);
  }

  // Auto-select: localhost first, then first found
  if (results.length > 0) {
    config.ollamaUrl = results[0]; // localhost is already first if found
  }

  sendJson(res, 200, { selected: config.ollamaUrl, found: results });
}

module.exports = { scanOllama };
