// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const config = require("./config");

// Locate an executable on PATH, cross-platform: `where` on Windows, `which`
// elsewhere. Resolves to the first match (absolute path) or null if not found.
// Both commands may print several lines; we keep the first.
function findCommand(cmd) {
  return new Promise((resolve) => {
    const finder = process.platform === "win32" ? "where" : "which";
    execFile(finder, [cmd], (err, stdout) => {
      if (err || !stdout.trim()) resolve(null);
      else resolve(stdout.trim().split(/\r?\n/)[0].trim());
    });
  });
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function serveStatic(req, res) {
  const requestedPath = req.url === "/" ? "/index.html" : decodeURIComponent(req.url);
  const filePath = path.normalize(path.join(config.PUBLIC_DIR, requestedPath));

  if (!filePath.startsWith(config.PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    // No caching: this is a local dev tool, so always serve the latest
    // HTML/CSS/JS instead of a stale browser-cached copy.
    res.writeHead(200, {
      "Content-Type": config.MIME_TYPES[ext] || "application/octet-stream",
      "Cache-Control": "no-cache, no-store, must-revalidate",
    });
    res.end(data);
  });
}

async function readBody(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return JSON.parse(body || "{}");
}

// Strip emoji and collapse repeated sentence-final punctuation before TTS — both
// the macOS `say` reader and the local neural engines read these badly. Shared by
// server/speech.js (reading) and server/tts.js (/voice generation).
const EMOJI_RE = /[\u{1F600}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}\u{1F1E0}-\u{1F1FF}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F7E0}-\u{1F7FF}\u{231A}-\u{231B}\u{23E9}-\u{23F3}\u{23F8}-\u{23FA}\u{25AA}-\u{25AB}\u{25B6}\u{25C0}\u{25FB}-\u{25FE}\u{2934}-\u{2935}\u{2B05}-\u{2B07}\u{2B1B}-\u{2B1C}\u{2B50}\u{2B55}\u{3030}\u{303D}\u{3297}\u{3299}]/gu;

function cleanSpeechText(s) {
  return String(s || "")
    .replace(EMOJI_RE, "")
    .replace(/([。？！；：.!?;:])\1+/g, "$1")
    .trim();
}

// "Cannot connect. Check the base URL and network." was true and useless: it named
// neither the address tried nor what went wrong, and the one detail that answers both
// (fetch's cause code) was being put in a field the browser never displays. Say which
// endpoint refused and why — those two facts are the whole diagnosis.
// Which addresses the name actually resolved to. When a host has several (two NICs,
// or IPv4 + a fistful of IPv6 privacy addresses) and the service listens on exactly
// one of them, "timed out" alone is unreadable — the connect went to an address that
// is real but not serving. Best-effort and time-boxed: a diagnosis must never be the
// slow part of reporting a failure.
async function resolvedAddresses(url) {
  let host = "";
  try { host = new URL(url).hostname; } catch { return ""; }
  if (/^[\d.]+$/.test(host) || host.includes(":")) return "";   // already a literal
  try {
    const dns = require("dns").promises;
    const all = await Promise.race([
      dns.lookup(host, { all: true }),
      new Promise((resolve) => setTimeout(() => resolve(null), 1000)),
    ]);
    if (!all || !all.length) return "";
    const list = all.map((a) => a.address);
    const shown = list.slice(0, 6).join(", ") + (list.length > 6 ? `, +${list.length - 6} more` : "");
    return list.length > 1
      ? ` The name resolves to ${list.length} addresses (${shown}) — a server bound to just one of them is reachable only at that one.`
      : ` The name resolves to ${shown}.`;
  } catch { return ""; }
}

async function describeFetchError(error, url, what) {
  const code = error?.cause?.code || error?.code || "";
  const why = {
    ECONNREFUSED: "connection refused — nothing is listening on that port, or the server accepts only connections from its own machine (a llama.cpp/vLLM started with --host 127.0.0.1 does exactly this; start it with --host 0.0.0.0, or tunnel the port)",
    ENOTFOUND: "host not found — check the name",
    EAI_AGAIN: "host lookup failed — check the name and DNS",
    ETIMEDOUT: "timed out — the address is not answering",
    UND_ERR_CONNECT_TIMEOUT: "timed out — the address is not answering",
    ECONNRESET: "the connection was reset by the far end",
    EHOSTUNREACH: "no route to that host",
    ENETUNREACH: "the network is unreachable from here",
    CERT_HAS_EXPIRED: "the server's TLS certificate has expired",
  }[code] || (error?.message ? String(error.message) : "unknown error");
  const where = (code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT" || code === "ECONNREFUSED" || code === "EHOSTUNREACH")
    ? await resolvedAddresses(url)
    : "";
  return `Cannot reach ${what} at ${url}: ${why}.${where}`;
}

module.exports = { sendJson, serveStatic, readBody, cleanSpeechText, findCommand, describeFetchError };