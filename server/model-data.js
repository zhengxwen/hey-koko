// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

// Third-party DATA a model needs at run time — not weights (those live on the ComfyUI
// box), but small files such as the system prompts an upsampler was fine-tuned against.
// Same policy as the prompt-writing skills (server/skills-manifest.json): the files are
// someone else's work, so the repository commits only their pinned URL + sha256
// (server/model-data-manifest.json) and the bytes are fetched to this machine on demand,
// into ~/.hey-koko/model-data/<group>/.
//
// "On demand" means the first run that needs a file downloads it (once, verified), so
// nothing has to be prepared by hand; `node scripts/fetch-model-data.js` does the same
// ahead of time for a machine that will be offline.

const fs = require("fs");
const path = require("path");
const https = require("https");
const crypto = require("crypto");

const config = require("./config");
const MANIFEST = require("./model-data-manifest.json");

const DATA_DIR = path.join(config.DATA_DIR, "model-data");
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

function fetchUrl(url, redirects = 4) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 15000 }, (res) => {
      // Hugging Face answers /resolve/ with a RELATIVE 307 to its own cache path.
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        resolve(fetchUrl(new URL(res.headers.location, url).href, redirects - 1));
        return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode}`)); return; }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

function entryOf(group, rel) {
  const entry = MANIFEST[group] && MANIFEST[group].files && MANIFEST[group].files[rel];
  if (!entry) throw new Error(`model-data: no manifest entry for ${group}/${rel}`);
  return entry;
}

function pathOf(group, rel) { return path.join(DATA_DIR, group, rel); }

function readVerified(abs, entry) {
  try {
    const buf = fs.readFileSync(abs);
    return sha256(buf) === entry.sha256 ? buf : null;
  } catch { return null; }
}

// One download per file at a time: two runs that both find it missing share the fetch.
const inflight = new Map();

// The file's bytes — from disk when present and intact, otherwise downloaded, checked
// against the pinned sha256 and saved. A file that is on disk but does not match (a
// truncated write, a hand edit) is fetched again rather than trusted. A download whose
// hash differs means upstream changed the file: refused, because the pinned manifest no
// longer describes it — updating is a deliberate manifest edit, never a silent drift.
async function modelDataFile(group, rel) {
  const entry = entryOf(group, rel);
  const abs = pathOf(group, rel);
  const onDisk = readVerified(abs, entry);
  if (onDisk) return onDisk;
  const key = `${group}/${rel}`;
  if (!inflight.has(key)) {
    inflight.set(key, (async () => {
      const buf = await fetchUrl(entry.url);
      const got = sha256(buf);
      if (got !== entry.sha256) throw new Error(`sha256 mismatch for ${key} (got ${got.slice(0, 12)}…) — upstream changed the file; the manifest needs updating`);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      const tmp = `${abs}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, abs);
      return buf;
    })().finally(() => inflight.delete(key)));
  }
  return inflight.get(key);
}

module.exports = { MANIFEST, DATA_DIR, modelDataFile, pathOf, readVerified, entryOf };
