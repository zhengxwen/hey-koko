#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

// Download model prompt-writing skills (see server/skills-manifest.json) into
// ~/.hey-koko/skills/, verified against pinned sha256 hashes.
//
// The skill TEXTS are third-party content and deliberately live outside this
// repository — the MiniMax-H3 repo, for one, publishes no license, so its guides
// may only be fetched to the user's own machine, never redistributed. Only this
// manifest of URLs and hashes is committed.
//
// Usage: node scripts/fetch-skills.js [--quiet] [--check] [--force]
//   --quiet  only print when something is downloaded or wrong
//   --check  verify existing files, download nothing (exit 1 on any mismatch)
//   --force  re-download everything even if present and matching
//
// Without the files the app still works — the /skill command simply reports
// that no skills are installed and points here.

const fs = require("fs");
const path = require("path");
const https = require("https");
const crypto = require("crypto");

const config = require("../server/config");
const MANIFEST = require("../server/skills-manifest.json");

const SKILLS_DIR = path.join(config.DATA_DIR, "skills");
const QUIET = process.argv.includes("--quiet");
const CHECK = process.argv.includes("--check");
const FORCE = process.argv.includes("--force");

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

function fetchUrl(url, redirects = 3) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 15000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        resolve(fetchUrl(new URL(res.headers.location, url).href, redirects - 1));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

async function fetchVerified(entry) {
  const buf = await fetchUrl(entry.url);
  const got = sha256(buf);
  // A hash mismatch means upstream changed the file (or the download was tampered
  // with). Either way the pinned manifest no longer describes what we would install,
  // so refuse — updating is a deliberate manifest edit, not a silent drift.
  if (got !== entry.sha256) throw new Error(`sha256 mismatch (got ${got.slice(0, 12)}…)`);
  return buf;
}

function onDiskOk(abs, entry) {
  try { return sha256(fs.readFileSync(abs)) === entry.sha256; } catch { return false; }
}

function saveFile(abs, buf) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  // temp + rename so a killed run never leaves a partial file behind.
  const tmp = `${abs}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, abs);
}

(async () => {
  let ok = 0, downloaded = 0, failed = 0, total = 0;
  for (const [skill, def] of Object.entries(MANIFEST)) {
    for (const [rel, entry] of Object.entries(def.files || {})) {
      total++;
      const abs = path.join(SKILLS_DIR, skill, rel);
      if (!FORCE && onDiskOk(abs, entry)) { ok++; continue; }
      if (CHECK) { console.error(`MISSING/MISMATCH  ${skill}/${rel}`); failed++; continue; }
      try {
        saveFile(abs, await fetchVerified(entry));
        downloaded++;
        if (!QUIET) console.log(`fetched  ${skill}/${rel}  (${(entry.bytes / 1024).toFixed(1)} KB)`);
      } catch (err) {
        failed++;
        console.error(`FAILED   ${skill}/${rel}: ${err.message}`);
      }
    }
  }
  if (!QUIET || downloaded || failed) {
    console.log(`skills: ${ok} ok, ${downloaded} downloaded, ${failed} failed (${total} total) → ${SKILLS_DIR}`);
  }
  process.exit(failed ? 1 : 0);
})();
