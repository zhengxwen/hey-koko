// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

// Third-party UI libraries (KaTeX, Mermaid, highlight.js, pdf.js, mammoth,
// JSZip) are NOT committed to this repo. Instead, vendor-manifest.json pins
// each file to an exact version + sha256, and the frontend always references
// the same-origin path /vendor/<path>. Two ways that path gets satisfied:
//   1. Offline (preferred): scripts/fetch-vendor.js downloads the files into
//      public/vendor/ (gitignored) — start.command/build-app.sh do this by default.
//   2. Online fallback: if a file is missing on disk, this module fetches it
//      from the pinned CDN URL, verifies the checksum, and serves it from an
//      in-memory cache. A checksum mismatch is refused (502), never served.
// Keeping everything same-origin also sidesteps CORS/worker/module-import
// edge cases that a client-side CDN fallback would reintroduce.

const fs = require("fs");
const path = require("path");
const https = require("https");
const crypto = require("crypto");
const config = require("./config");

const MANIFEST = require("./vendor-manifest.json");
const VENDOR_DIR = path.join(config.PUBLIC_DIR, "vendor");

// Verified CDN downloads, kept for the life of the process (~6.5 MB max).
const memCache = new Map();

// All manifest URLs live on cdn.jsdelivr.net; these hosts serve the same
// content and are tried in order. Matters on networks where the primary host
// is blocked or blackholed (common behind some national/corporate firewalls).
const MIRROR_HOSTS = ["cdn.jsdelivr.net", "fastly.jsdelivr.net", "gcore.jsdelivr.net"];

// A blackholed connection would otherwise hang forever (https.get has no
// default timeout) — cap it so callers fail over to the next mirror quickly.
const FETCH_TIMEOUT_MS = 15000;

function fetchUrl(url, redirects = 3) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: FETCH_TIMEOUT_MS }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(fetchUrl(new URL(res.headers.location, url).href, redirects - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error(`timeout after ${FETCH_TIMEOUT_MS / 1000}s for ${url}`)));
    req.on("error", reject);
  });
}

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

// Fetch one manifest entry, trying each mirror until the bytes match the
// pinned sha256. Rejects with the last error only after all mirrors failed.
async function fetchVerified(entry) {
  const urls = entry.url.includes("//cdn.jsdelivr.net/")
    ? MIRROR_HOSTS.map((h) => entry.url.replace("//cdn.jsdelivr.net/", `//${h}/`))
    : [entry.url];
  let lastErr;
  for (const url of urls) {
    try {
      const buf = await fetchUrl(url);
      if (sha256(buf) !== entry.sha256) throw new Error(`checksum mismatch from ${new URL(url).host}`);
      return buf;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

function send(res, rel, buf) {
  const ext = path.extname(rel).toLowerCase();
  res.writeHead(200, {
    "Content-Type": config.MIME_TYPES[ext] || "application/octet-stream",
    // Pinned + immutable content, safe to cache hard (unlike the app's own
    // no-cache HTML/JS). Speeds up reloads in CDN-fallback mode especially.
    "Cache-Control": "public, max-age=86400",
  });
  res.end(buf);
}

// GET /vendor/<path> — disk first, then verified CDN fallback.
async function serveVendor(req, res) {
  const rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\/vendor\//, "");
  const entry = MANIFEST[rel];
  if (!entry) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  // Manifest keys are the only accepted paths, so no traversal is possible,
  // but normalize anyway for defense in depth.
  const filePath = path.normalize(path.join(VENDOR_DIR, rel));
  if (filePath.startsWith(VENDOR_DIR)) {
    try {
      send(res, rel, fs.readFileSync(filePath));
      return;
    } catch { /* not on disk — fall through to CDN */ }
  }
  if (memCache.has(rel)) {
    send(res, rel, memCache.get(rel));
    return;
  }
  try {
    const buf = await fetchVerified(entry);
    memCache.set(rel, buf);
    send(res, rel, buf);
  } catch (err) {
    console.error(`[vendor] CDN fetch failed for ${rel} (all mirrors): ${err.message}`);
    res.writeHead(502);
    res.end("Vendor fetch failed (offline and not downloaded — run scripts/fetch-vendor.js)");
  }
}

// Count of manifest files present and valid-looking on disk (size check only;
// full hash verification is fetch-vendor.js --check's job).
function vendorStatus() {
  let present = 0;
  const entries = Object.entries(MANIFEST);
  for (const [rel, entry] of entries) {
    try {
      if (fs.statSync(path.join(VENDOR_DIR, rel)).size === entry.bytes) present++;
    } catch { /* missing */ }
  }
  return { present, total: entries.length };
}

module.exports = { serveVendor, vendorStatus, fetchVerified, MANIFEST, VENDOR_DIR };
