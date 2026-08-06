#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

// Download the pinned third-party UI libraries (see server/vendor-manifest.json)
// into public/vendor/ so hey-koko runs fully offline. Every file is verified
// against its sha256 before being kept; fetching (mirrors, timeouts, checksum)
// is shared with the server's runtime CDN fallback in server/vendor.js.
// Files already present and matching are skipped, so re-runs are cheap no-ops.
//
// Usage: node scripts/fetch-vendor.js [--quiet] [--check] [--force]
//   --quiet  only print when something is downloaded or wrong
//   --check  verify existing files, download nothing (exit 1 on any mismatch)
//   --force  re-download everything even if present and matching
//
// Skipping this script entirely is fine: the server falls back to fetching
// missing files from the pinned CDN URLs at runtime (checksum-verified too).

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { fetchVerified, MANIFEST, VENDOR_DIR } = require("../server/vendor");

const QUIET = process.argv.includes("--quiet");
const CHECK = process.argv.includes("--check");
const FORCE = process.argv.includes("--force");

const CONCURRENCY = 6;

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

function onDiskOk(rel, entry) {
  try {
    return sha256(fs.readFileSync(path.join(VENDOR_DIR, rel))) === entry.sha256;
  } catch {
    return false;
  }
}

function saveFile(rel, buf) {
  const out = path.join(VENDOR_DIR, rel);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  // Write via temp + rename so a killed run never leaves a partial file
  // that would then fail verification confusingly.
  const tmp = `${out}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, out);
}

(async () => {
  let ok = 0, downloaded = 0, failed = 0;
  const todo = [];
  for (const [rel, entry] of Object.entries(MANIFEST)) {
    if (!FORCE && onDiskOk(rel, entry)) { ok++; continue; }
    if (CHECK) {
      console.error(`MISSING/MISMATCH  ${rel}`);
      failed++;
      continue;
    }
    todo.push([rel, entry]);
  }

  if (todo.length) {
    // Preflight with the smallest pending file: if no mirror is reachable,
    // bail out once with a clear message instead of timing out 31 times
    // (offline machine, blocked CDN). Bounded by mirrors × 15 s.
    todo.sort((a, b) => a[1].bytes - b[1].bytes);
    const [rel0, entry0] = todo[0];
    try {
      saveFile(rel0, await fetchVerified(entry0));
      downloaded++;
      if (!QUIET) console.log(`fetched  ${rel0}  (${(entry0.bytes / 1024).toFixed(0)} KB)`);
    } catch (err) {
      console.error(`CDN unreachable (${err.message}) — skipping the remaining ${todo.length - 1} files.`);
      console.error("The app still works: missing files load from the CDN at runtime once online.");
      process.exit(1);
    }

    // Small worker pool over the rest.
    const rest = todo.slice(1);
    let next = 0;
    async function worker() {
      while (next < rest.length) {
        const [rel, entry] = rest[next++];
        try {
          saveFile(rel, await fetchVerified(entry));
          downloaded++;
          if (!QUIET) console.log(`fetched  ${rel}  (${(entry.bytes / 1024).toFixed(0)} KB)`);
        } catch (err) {
          failed++;
          console.error(`FAILED   ${rel}: ${err.message}`);
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rest.length) }, worker));
  }

  const total = Object.keys(MANIFEST).length;
  if (!QUIET || downloaded || failed) {
    console.log(`vendor: ${ok} ok, ${downloaded} downloaded, ${failed} failed (${total} total) → ${VENDOR_DIR}`);
  }
  process.exit(failed ? 1 : 0);
})();
