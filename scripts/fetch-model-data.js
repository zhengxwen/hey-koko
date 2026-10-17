#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

// Download the third-party model data listed in server/model-data-manifest.json into
// ~/.hey-koko/model-data/, verified against the pinned sha256 hashes.
//
// Optional: the server fetches each file itself the first time a run needs it. This is
// for preparing a machine that will be offline when it renders.
//
// Usage: node scripts/fetch-model-data.js [--check]
//   --check  verify what is on disk, download nothing (exit 1 on anything missing/wrong)

const { MANIFEST, modelDataFile, pathOf, readVerified, entryOf } = require("../server/model-data");

const CHECK = process.argv.includes("--check");

(async () => {
  let ok = 0, fetched = 0, failed = 0;
  for (const [group, def] of Object.entries(MANIFEST)) {
    for (const rel of Object.keys(def.files || {})) {
      const abs = pathOf(group, rel);
      if (readVerified(abs, entryOf(group, rel))) { ok++; continue; }
      if (CHECK) { console.error(`MISSING/MISMATCH  ${group}/${rel}`); failed++; continue; }
      try {
        await modelDataFile(group, rel);
        fetched++;
        console.log(`fetched  ${group}/${rel}  (${def.license})`);
      } catch (err) {
        failed++;
        console.error(`FAILED   ${group}/${rel}: ${err.message}`);
      }
    }
  }
  console.log(`model data: ${ok} ok, ${fetched} downloaded, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
