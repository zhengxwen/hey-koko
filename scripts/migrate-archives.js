#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

// Move the media inside archived conversations into the gallery.
//
// The in-app migration (settings → "Move media to the gallery") walks the tabs the
// browser is holding. Archives are the other half: they live on the server as
// compressed JSON with their images and videos inlined as base64, so nothing on the
// client can reach them without downloading and re-uploading megabytes. This does it
// where the files already are.
//
// Every archive is copied to ~/.hey-koko/backup/chat-<timestamp>/ before anything is
// rewritten. Re-running is safe: a reference is left alone.
//
// Usage:
//   node scripts/migrate-archives.js            # migrate
//   node scripts/migrate-archives.js --dry-run  # report only
//
// Restart hey-koko afterwards so the running server reloads the ledger.

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const config = require("../server/config");
const gallery = require("../server/gallery");
const { readArchiveFile, scanArchiveFilenames } = require("../server/archive");

const DRY = process.argv.includes("--dry-run");

// The fields holding real content. Deliberately NOT generatedThumbnails/displayImages:
// those are the small render-time copies of the same pictures, and filing them would
// litter the gallery with a duplicate of every image. They stay inline, which is also
// what keeps the archive list preview working with no extra fetches.
const FIELDS = [
  { field: "contextImages", kind: "image", source: "upload", nameField: "imageNames" },
  { field: "generatedImages", kind: "image", source: "generated", mimeField: "imageMime", nameField: "generatedImageNames" },
  { field: "generatedVideos", kind: "video", source: "generated", mimesField: "videoMimes", defaultMime: "video/mp4", nameField: "videoNames" },
  { field: "generatedMeshes", kind: "mesh", source: "generated", mimesField: "meshMimes", defaultMime: "model/gltf-binary", nameField: "meshNames" },
  // /voice clips: a scalar field, not an array — normalised below.
  { field: "generatedAudio", kind: "audio", source: "generated", mimeField: "audioMime", defaultMime: "audio/aac", nameField: "audioName", scalar: true },
];

const GALLERY_PREFIX = "/api/gallery/file/";
const isRef = (v) => typeof v === "string" && v.startsWith(GALLERY_PREFIX);
const galleryUrl = (id) => GALLERY_PREFIX + String(id).split("/").map(encodeURIComponent).join("/");

// Most media fields are arrays; generatedAudio is a lone string.
function asArray(v) {
  return Array.isArray(v) ? v : typeof v === "string" ? [v] : [];
}

function isInlineBlob(v) {
  return typeof v === "string" && v.length > 100 && !isRef(v) &&
         !v.startsWith("http") && !v.startsWith("blob:");
}

function sniffMime(v, fallback) {
  if (v.startsWith("data:")) return v.slice(5, v.indexOf(";")) || fallback;
  if (v.startsWith("/9j/")) return "image/jpeg";
  if (v.startsWith("iVBOR")) return "image/png";
  if (v.startsWith("UklGR")) return "image/webp";
  if (v.startsWith("R0lGOD")) return "image/gif";
  return fallback;
}

function writeArchive(filePath, obj) {
  const buf = Buffer.from(JSON.stringify(obj, null, 2), "utf-8");
  const out = filePath.endsWith(".zst") ? zlib.zstdCompressSync(buf)
    : filePath.endsWith(".gz") ? zlib.gzipSync(buf) : buf;
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, out);
  fs.renameSync(tmp, filePath);
}

// Copy every archive before a single byte is rewritten. scanArchiveFilenames() skips
// dotfiles, so the embeddings index rides along explicitly — it is derived data, but a
// restore that silently drops it would leave semantic search pointing at nothing.
function backupArchives(files) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const dir = path.join(config.DATA_DIR, "backup", `chat-${stamp}`);
  const extras = [];
  try {
    for (const e of fs.readdirSync(config.ARCHIVES_DIR, { withFileTypes: true })) {
      if (e.isFile() && e.name.startsWith(".") && e.name !== ".DS_Store") extras.push(e.name);
    }
  } catch { /* none */ }
  for (const f of [...files, ...extras]) {
    const src = path.join(config.ARCHIVES_DIR, f);
    const dst = path.join(dir, f);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
  return dir;
}

const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

(function main() {
  const files = scanArchiveFilenames();
  if (!files.length) { console.log("No archives found."); return; }

  // Pass 1: see what is actually there before touching anything.
  let inlineBytes = 0, inlineCount = 0;
  const parsed = new Map();
  for (const f of files) {
    let data;
    try { data = JSON.parse(readArchiveFile(path.join(config.ARCHIVES_DIR, f))); }
    catch (e) { console.warn(`  ! unreadable, skipped: ${f} (${e.message})`); continue; }
    parsed.set(f, data);
    for (const msg of data.messages || []) {
      for (const spec of FIELDS) {
        for (const v of asArray(msg[spec.field])) {
          if (isInlineBlob(v)) { inlineCount++; inlineBytes += v.length; }
        }
      }
    }
  }
  console.log(`${parsed.size} archive(s), ${inlineCount} inline blob(s), ${mb(inlineBytes)} of base64.`);
  if (!inlineCount) { console.log("Nothing to migrate."); return; }
  if (DRY) { console.log("(dry run — nothing written)"); return; }

  const backupDir = backupArchives([...parsed.keys()]);
  console.log(`Backup: ${backupDir}`);

  let moved = 0, failed = 0, deduped = 0, rewritten = 0;
  for (const [f, data] of parsed) {
    let touched = false;
    for (const msg of data.messages || []) {
      const ts = typeof msg.timestamp === "string"
        ? new Date(msg.timestamp.replace(" ", "T")).getTime()
        : msg.timestamp;
      for (const spec of FIELDS) {
        // A scalar field is handled through a one-element view so the loop below is
        // the same code either way; the write goes back through setSlot.
        const arr = spec.scalar ? asArray(msg[spec.field]) : msg[spec.field];
        if (!Array.isArray(arr) || !arr.length) continue;
        const mimes = spec.mimesField && Array.isArray(msg[spec.mimesField]) ? msg[spec.mimesField] : null;
        const names = spec.nameField && Array.isArray(msg[spec.nameField]) ? msg[spec.nameField]
          : spec.nameField && typeof msg[spec.nameField] === "string" ? [msg[spec.nameField]] : null;
        for (let i = 0; i < arr.length; i++) {
          if (!isInlineBlob(arr[i])) continue;
          const mime = (mimes && mimes[i]) || (spec.mimeField && msg[spec.mimeField]) ||
                       sniffMime(arr[i], spec.defaultMime || "image/png");
          try {
            const e = gallery.record({
              kind: spec.kind, mime, b64: arr[i],
              meta: {
                source: spec.source, dedup: true,
                ts: Number.isFinite(ts) ? ts : undefined,
                prompt: msg.imagePrompt || undefined,
                params: msg.imageOptions || undefined,
                seed: msg.imageOptions && msg.imageOptions.seed,
                originalName: (names && names[i]) || undefined,
                batchIndex: i || undefined,
                migrated: true, fromArchive: f,
              },
            });
            if (e.deduped) deduped++;
            if (spec.scalar) msg[spec.field] = galleryUrl(e.path);
            else arr[i] = galleryUrl(e.path);
            moved++;
            touched = true;
          } catch (err) {
            console.warn(`  ! ${f}: ${err.message}`);
            failed++;
          }
        }
      }
    }
    if (touched) {
      writeArchive(path.join(config.ARCHIVES_DIR, f), data);
      rewritten++;
    }
  }

  const after = files.reduce((n, f) => {
    try { return n + fs.statSync(path.join(config.ARCHIVES_DIR, f)).size; } catch { return n; }
  }, 0);
  const before = files.reduce((n, f) => {
    try { return n + fs.statSync(path.join(backupDir, f)).size; } catch { return n; }
  }, 0);

  console.log(`\nMoved ${moved} file(s)${deduped ? ` (${deduped} were duplicates of one another)` : ""}` +
              `${failed ? `, ${failed} failed` : ""}; rewrote ${rewritten} archive(s).`);
  console.log(`Archives on disk: ${mb(before)} → ${mb(after)}`);
  console.log(`Gallery: ${gallery.stats().count} item(s), ${mb(gallery.stats().bytes)}`);
  console.log("\nRestart hey-koko so the running server picks up the ledger.");
})();
