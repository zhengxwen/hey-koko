// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

// The gallery: every generated (and, later, uploaded) media file lands on disk under
// ~/.hey-koko/gallery/ with an append-only ledger, instead of living only as base64
// inside a browser IndexedDB record. A video costs tens of GPU-minutes; it must not
// die with a cleared browser store.
//
// Layout:
//   gallery/2026-08/20260806-143012_wan22-t2v_s123456789.mp4   ← the artifact
//   gallery/2026-08/.20260806-143012_wan22-t2v_s123456789.mp4.jpg  ← thumbnail (derived)
//   gallery/index.jsonl                                        ← the ledger
//
// The ledger is JSON Lines, append-only: one JSON object per line, deletes appended as
// tombstones. A torn write costs at most the last line (skipped on load) instead of the
// whole index — the same failure mode that made the IndexedDB "one big record" design
// lose everything. Thumbnails are a derived cache: never in the ledger, deletable at
// will, regenerated on demand.
//
// IDs are the gallery-relative path ("2026-08/<name>.mp4"). One key, never two, so the
// ledger and the filesystem cannot drift apart.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");
const config = require("./config");
const { sendJson, readBody, findCommand } = require("./utils");

const GALLERY_DIR = path.join(config.DATA_DIR, "gallery");
const INDEX_FILE = path.join(GALLERY_DIR, "index.jsonl");

const MIME_EXT = {
  "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif",
  "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov",
  "audio/mpeg": "mp3", "audio/wav": "wav", "audio/flac": "flac",
  "model/gltf-binary": "glb",
};
const EXT_MIME = Object.fromEntries(Object.entries(MIME_EXT).map(([m, e]) => [e, m]));

// ---------------------------------------------------------------- ledger state

let entries = null;          // Map<id, entry> — live entries, tombstones applied
let hashIndex = null;        // Map<contentHash, id> — upload dedup
let tombstoneCount = 0;

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

// Replay index.jsonl into memory. Unparseable lines are skipped, not fatal: a torn
// final line from a hard kill must not take the whole gallery down with it.
function load() {
  if (entries) return;
  entries = new Map();
  hashIndex = new Map();
  tombstoneCount = 0;
  let raw = "";
  try { raw = fs.readFileSync(INDEX_FILE, "utf8"); } catch { return; }
  let bad = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { bad++; continue; }
    if (rec.op === "delete") {
      const gone = entries.get(rec.path);
      if (gone?.contentHash) hashIndex.delete(gone.contentHash);
      entries.delete(rec.path);
      tombstoneCount++;
    } else if (rec.path) {
      entries.set(rec.path, rec);
      if (rec.contentHash) hashIndex.set(rec.contentHash, rec.path);
    }
  }
  if (bad) console.warn(`[gallery] skipped ${bad} unparseable ledger line(s)`);
  console.log(`[gallery] ${entries.size} item(s) loaded from ledger`);
}

function append(rec) {
  ensureDir(GALLERY_DIR);
  fs.appendFileSync(INDEX_FILE, JSON.stringify(rec) + "\n");
}

// ---------------------------------------------------------------- naming

function two(n) { return String(n).padStart(2, "0"); }

function monthOf(d) { return `${d.getFullYear()}-${two(d.getMonth() + 1)}`; }

function stampOf(d) {
  return `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-` +
         `${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
}

// Filesystem-safe, still readable. CJK and other non-ASCII stay (APFS/ext4/NTFS all
// take them); only path-hostile characters go.
function sanitize(s, max) {
  // Also strips # & % — those are path-legal but would have to survive a URL
  // round-trip to /api/gallery/file/<id>, and % in particular risks double-decoding.
  return String(s || "")
    .replace(/[/\\:*?"<>|#&%\x00-\x1f]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, max);
}

// "wan2.2_t2v_high_noise_14B_fp8_scaled.safetensors" → "wan2.2-t2v-high-noise-14b-fp8"
// Underscores become dashes here (and only here) so the "_" field separators in the
// filename stay readable; an upload's original name keeps its own underscores.
function shortModel(model) {
  const base = String(model || "model").replace(/\.(safetensors|ckpt|gguf|pt|sft)$/i, "");
  return sanitize(base.toLowerCase().replace(/_/g, "-"), 32) || "model";
}

function extFor(mime, kind) {
  if (MIME_EXT[mime]) return MIME_EXT[mime];
  const guess = String(mime || "").split("/")[1];
  if (guess && /^[a-z0-9]{2,5}$/.test(guess)) return guess;
  return kind === "video" ? "mp4" : kind === "mesh" ? "glb" : "png";
}

// Same-second collisions get -b, -c, … then a random tail. Uniqueness is on the FULL
// filename, which is also what the thumbnail name (".<filename>.jpg") keys off.
function uniquePath(dirAbs, rel, base, ext) {
  for (let i = 0; i < 26; i++) {
    const name = i === 0 ? `${base}.${ext}` : `${base}-${String.fromCharCode(97 + i)}.${ext}`;
    if (!fs.existsSync(path.join(dirAbs, name))) return { name, id: `${rel}/${name}` };
  }
  const name = `${base}-${crypto.randomBytes(3).toString("hex")}.${ext}`;
  return { name, id: `${rel}/${name}` };
}

// ---------------------------------------------------------------- write

// Record one artifact: write the file, append the ledger line, return the entry.
// `meta.ts` may back-date the record (history migration) — the file's mtime is set to
// match so Finder's time order agrees with the filename.
function record({ kind, mime, b64, buffer, meta = {} }) {
  load();
  const buf = buffer || Buffer.from(String(b64 || "").replace(/^data:[^,]+,/, ""), "base64");
  if (!buf.length) throw new Error("empty media buffer");

  const source = meta.source === "upload" ? "upload" : "generated";

  // Content dedup, for every path that registers media we did not just render: the same
  // reference image gets dragged in over and over, and history migration re-imports the
  // same bytes from every message that copied them. Live renders skip it — their pixels
  // are unique by construction, and hashing a multi-hundred-MB video is not free.
  let contentHash;
  const wantDedup = meta.dedup !== undefined ? !!meta.dedup : source === "upload";
  if (wantDedup) {
    contentHash = crypto.createHash("sha256").update(buf).digest("hex");
    const hit = hashIndex.get(contentHash);
    if (hit && entries.has(hit) && fs.existsSync(path.join(GALLERY_DIR, hit))) {
      return { ...entries.get(hit), deduped: true };
    }
  }

  const when = meta.ts ? new Date(meta.ts) : new Date();
  const rel = monthOf(when);
  const dirAbs = path.join(GALLERY_DIR, rel);
  ensureDir(dirAbs);

  const ext = extFor(mime, kind);
  const stamp = stampOf(when);
  let base;
  if (source === "upload") {
    const stem = sanitize(String(meta.originalName || "").replace(/\.[^.]+$/, ""), 40);
    base = `${stamp}_upload${stem ? `_${stem}` : ""}`;
  } else {
    const seedPart = meta.seed !== undefined && meta.seed !== null ? `_s${meta.seed}` : "";
    const idxPart = meta.batchIndex ? `_${meta.batchIndex + 1}` : "";
    base = `${stamp}_${shortModel(meta.model)}${seedPart}${idxPart}`;
  }

  const { name, id } = uniquePath(dirAbs, rel, base, ext);
  const abs = path.join(dirAbs, name);
  const tmp = `${abs}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, abs);
  if (meta.ts) { try { fs.utimesSync(abs, when, when); } catch { /* cosmetic only */ } }

  const entry = {
    path: id,
    ts: when.getTime(),
    kind: kind || "image",
    source,
    mime: mime || EXT_MIME[ext] || "application/octet-stream",
    bytes: buf.length,
    model: meta.model,
    prompt: meta.prompt,
    negative: meta.negative,
    seed: meta.seed,
    width: meta.width,
    height: meta.height,
    fps: meta.fps,
    length: meta.length,
    precisionUsed: meta.precisionUsed,
    params: meta.params,
    conversationId: meta.conversationId,
    msgId: meta.msgId,
    batchIndex: meta.batchIndex,
    originalName: meta.originalName,
    partial: meta.partial,          // salvaged prefix of an interrupted render
    contentHash,
  };
  for (const k of Object.keys(entry)) if (entry[k] === undefined) delete entry[k];

  entries.set(id, entry);
  if (contentHash) hashIndex.set(contentHash, id);
  append(entry);
  return entry;
}

// Never let a bookkeeping failure break a generation that already succeeded: the user's
// pixels matter more than the ledger line. Returns ids (nulls dropped).
function recordMany(items) {
  const ids = [];
  for (const it of items) {
    try {
      ids.push(record(it).path);
    } catch (err) {
      console.error(`[gallery] record failed: ${err.message}`);
      ids.push(null);
    }
  }
  return ids;
}

// ---------------------------------------------------------------- read

function get(id) { load(); return entries.get(id) || null; }

function absPathOf(id) {
  const abs = path.normalize(path.join(GALLERY_DIR, id));
  // Ledger membership is the real gate (ids are keys, not user input), but normalize
  // and re-check the prefix anyway.
  return abs.startsWith(GALLERY_DIR) ? abs : null;
}

function list({ type, model, source, q, before, limit = 60 } = {}) {
  load();
  const needle = String(q || "").toLowerCase();
  let all = [...entries.values()];
  if (type) all = all.filter((e) => e.kind === type);
  if (model) all = all.filter((e) => (e.model || "").includes(model));
  if (source) all = all.filter((e) => (e.source || "generated") === source);
  if (needle) all = all.filter((e) => `${e.prompt || ""} ${e.originalName || ""}`.toLowerCase().includes(needle));
  all.sort((a, b) => b.ts - a.ts || (a.path < b.path ? 1 : -1));
  if (before) all = all.filter((e) => e.ts < Number(before));
  const page = all.slice(0, Math.min(500, Math.max(1, Number(limit) || 60)));
  return { items: page, total: all.length, hasMore: all.length > page.length };
}

function stats() {
  load();
  let bytes = 0, images = 0, videos = 0, other = 0;
  for (const e of entries.values()) {
    bytes += e.bytes || 0;
    if (e.kind === "image") images++;
    else if (e.kind === "video") videos++;
    else other++;
  }
  let thumbBytes = 0;
  const walk = (dir) => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of ents) {
      if (d.isDirectory()) walk(path.join(dir, d.name));
      else if (d.name.startsWith(".") && d.name.endsWith(".jpg")) {
        try { thumbBytes += fs.statSync(path.join(dir, d.name)).size; } catch { /* raced */ }
      }
    }
  };
  walk(GALLERY_DIR);
  return { count: entries.size, bytes, images, videos, other, thumbBytes, tombstones: tombstoneCount, dir: GALLERY_DIR };
}

// ---------------------------------------------------------------- delete

function thumbPathOf(id) {
  const abs = absPathOf(id);
  if (!abs) return null;
  return path.join(path.dirname(abs), `.${path.basename(abs)}.jpg`);
}

function remove(ids) {
  load();
  let removed = 0;
  for (const id of ids || []) {
    if (!entries.has(id)) continue;
    const abs = absPathOf(id);
    if (abs) {
      try { fs.unlinkSync(abs); } catch { /* already gone */ }
      const th = thumbPathOf(id);
      if (th) { try { fs.unlinkSync(th); } catch { /* none */ } }
    }
    const gone = entries.get(id);
    if (gone?.contentHash) hashIndex.delete(gone.contentHash);
    entries.delete(id);
    append({ op: "delete", path: id, ts: Date.now() });
    tombstoneCount++;
    removed++;
  }
  return { removed };
}

// Rewrite the ledger without tombstones/orphans. The one place a full rewrite is
// allowed — temp file + rename, so a crash mid-compact leaves the old ledger intact.
function compact() {
  load();
  ensureDir(GALLERY_DIR);
  const tmp = `${INDEX_FILE}.tmp-${process.pid}`;
  const live = [...entries.values()].filter((e) => {
    const abs = absPathOf(e.path);
    return abs && fs.existsSync(abs);
  });
  fs.writeFileSync(tmp, live.map((e) => JSON.stringify(e)).join("\n") + (live.length ? "\n" : ""));
  fs.renameSync(tmp, INDEX_FILE);
  const dropped = entries.size - live.length;
  entries = null;   // force reload
  load();
  return { kept: live.length, dropped };
}

// ---------------------------------------------------------------- references

// Which archived conversations reference these ids. Archives live on the server, so
// this half of the reference graph is ours; the browser scans its own IndexedDB for
// the live tabs and merges the two.
function archiveRefs() {
  let archive;
  try { archive = require("./archive"); } catch { return {}; }
  const out = {};
  let files = [];
  try { files = archive.scanArchiveFilenames(); } catch { return out; }
  for (const filename of files) {
    let data;
    try { data = JSON.parse(archive.readArchiveFile(path.join(config.ARCHIVES_DIR, filename))); }
    catch { continue; }
    const title = data.title || filename;
    for (const msg of data.messages || []) {
      for (const m of msg.genMedia || []) {
        if (!m || !m.id) continue;
        (out[m.id] ||= []).push({ archive: filename, title, msgId: msg.id, timestamp: msg.timestamp });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- thumbnails

let ffmpegPath;   // undefined = unprobed, null = absent, string = path
function ffmpeg() {
  if (ffmpegPath !== undefined) return Promise.resolve(ffmpegPath);
  return findCommand("ffmpeg").then((p) => (ffmpegPath = p));
}

const THUMB_EDGE = 360;
const SCALE_FILTER = `scale='if(gt(iw,ih),${THUMB_EDGE},-2)':'if(gt(iw,ih),-2,${THUMB_EDGE})'`;

function runFfmpeg(bin, args) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: 60000 }, (err) => resolve(!err));
  });
}

// Build the thumbnail for one item, if we can. Videos grab a frame at 0.5s (0s for
// very short clips); images are just scaled — one tool, both media types.
async function makeThumb(id) {
  const entry = get(id);
  const abs = absPathOf(id);
  const out = thumbPathOf(id);
  if (!entry || !abs || !out || !fs.existsSync(abs)) return false;
  if (entry.kind === "mesh" || entry.kind === "audio") return false;
  const bin = await ffmpeg();
  if (!bin) return false;
  const tmp = `${out}.tmp-${process.pid}.jpg`;
  const common = ["-frames:v", "1", "-vf", SCALE_FILTER, "-q:v", "5", "-y", tmp];
  let ok = entry.kind === "video"
    ? await runFfmpeg(bin, ["-ss", "0.5", "-i", abs, ...common])
    : await runFfmpeg(bin, ["-i", abs, ...common]);
  if (!ok && entry.kind === "video") ok = await runFfmpeg(bin, ["-i", abs, ...common]);  // clip shorter than 0.5s
  if (!ok) { try { fs.unlinkSync(tmp); } catch {} return false; }
  try { fs.renameSync(tmp, out); } catch { return false; }
  return true;
}

// ---------------------------------------------------------------- HTTP handlers

function idFromUrl(url, prefix) {
  const raw = decodeURIComponent(url.split("?")[0]).slice(prefix.length);
  return raw.replace(/^\/+/, "");
}

function handleList(req, res) {
  try {
    const u = new URL(req.url, "http://127.0.0.1");
    sendJson(res, 200, list({
      type: u.searchParams.get("type") || undefined,
      model: u.searchParams.get("model") || undefined,
      source: u.searchParams.get("source") || undefined,
      q: u.searchParams.get("q") || undefined,
      before: u.searchParams.get("before") || undefined,
      limit: u.searchParams.get("limit") || undefined,
    }));
  } catch (e) { sendJson(res, 500, { error: e.message }); }
}

function handleFile(req, res) {
  const id = idFromUrl(req.url, "/api/gallery/file/");
  const entry = get(id);
  const abs = entry && absPathOf(id);
  if (!entry || !abs || !fs.existsSync(abs)) {
    sendJson(res, 404, { error: "not in gallery" });
    return;
  }
  res.writeHead(200, {
    "Content-Type": entry.mime || "application/octet-stream",
    "Content-Length": fs.statSync(abs).size,
    // Content at a given id never changes (a re-render mints a new id), so caching is
    // safe and worth a lot for video. Deliberately NOT "immutable"/a year: deleting
    // from the gallery has to actually stop showing the artifact, so a reload
    // revalidates and a day at most papers over it.
    "Cache-Control": "public, max-age=86400",
  });
  fs.createReadStream(abs).pipe(res);
}

// Thumbnail contract, uniform for every media type so the grid is just <img>:
//   cached thumb → it; else generate (ffmpeg) → it; else an image → the original;
//   else 404, which tells the browser to make one and POST it back.
async function handleThumb(req, res) {
  const id = idFromUrl(req.url, "/api/gallery/thumb/");
  const entry = get(id);
  if (!entry) { sendJson(res, 404, { error: "not in gallery" }); return; }
  const th = thumbPathOf(id);
  if (th && !fs.existsSync(th)) { try { await makeThumb(id); } catch { /* fall through */ } }
  if (th && fs.existsSync(th)) {
    res.writeHead(200, {
      "Content-Type": "image/jpeg",
      "Content-Length": fs.statSync(th).size,
      "Cache-Control": "public, max-age=604800",
    });
    fs.createReadStream(th).pipe(res);
    return;
  }
  if (entry.kind === "image") { handleFile({ url: `/api/gallery/file/${encodeURIComponent(id)}` }, res); return; }
  sendJson(res, 404, { error: "no thumbnail" });
}

// Browser-generated thumbnail (no ffmpeg on this machine): cache it so every later
// view — and every other client — gets it for free.
async function handlePutThumb(req, res) {
  try {
    const body = await readBody(req);
    const id = String(body.id || "");
    if (!get(id)) { sendJson(res, 404, { error: "not in gallery" }); return; }
    const th = thumbPathOf(id);
    const buf = Buffer.from(String(body.jpeg || "").replace(/^data:[^,]+,/, ""), "base64");
    if (!th || !buf.length) { sendJson(res, 400, { error: "bad thumbnail" }); return; }
    const tmp = `${th}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, th);
    sendJson(res, 200, { ok: true });
  } catch (e) { sendJson(res, 500, { error: e.message }); }
}

async function handleDelete(req, res) {
  try {
    const body = await readBody(req);
    sendJson(res, 200, remove(body.ids || []));
  } catch (e) { sendJson(res, 500, { error: e.message }); }
}

function handleStats(req, res) {
  try { sendJson(res, 200, stats()); } catch (e) { sendJson(res, 500, { error: e.message }); }
}

function handleRefs(req, res) {
  try { sendJson(res, 200, { archives: archiveRefs() }); } catch (e) { sendJson(res, 500, { error: e.message }); }
}

async function handleCompact(req, res) {
  try { sendJson(res, 200, compact()); } catch (e) { sendJson(res, 500, { error: e.message }); }
}

// Register media the server did not generate: dragged-in uploads (P1) and the
// migration of already-existing chat media (P3).
async function handleImport(req, res) {
  try {
    const body = await readBody(req);
    const items = Array.isArray(body.items) ? body.items : [body];
    const out = items.map((it) => {
      try {
        const e = record({
          kind: it.kind || "image",
          mime: it.mime,
          b64: it.b64,
          // Anything arriving through import is a copy of bytes that may already be
          // filed, so dedup unless the caller explicitly opts out.
          meta: { dedup: true, ...(it.meta || {}), source: it.meta?.source || "upload" },
        });
        return { id: e.path, deduped: !!e.deduped };
      } catch (err) {
        return { error: err.message };
      }
    });
    sendJson(res, 200, { items: out });
  } catch (e) { sendJson(res, 500, { error: e.message }); }
}

module.exports = {
  GALLERY_DIR, record, recordMany, get, list, stats, remove, compact, archiveRefs, makeThumb,
  handleList, handleFile, handleThumb, handlePutThumb, handleDelete, handleStats, handleRefs,
  handleCompact, handleImport,
  _reset() { entries = null; hashIndex = null; },   // tests
};
