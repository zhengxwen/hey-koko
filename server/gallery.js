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

// The model segment of a generated file's name. This is the canonical id
// ("wan2.2-14b-i2v"), NOT the filename that ran: the id is already lowercase, already
// free of the quantisation token, and stays put when another build is downloaded — so
// the gallery folder sorts and groups by model instead of by build. The exact file and
// its tier are still on the ledger line (model / precisionUsed).
// ":" separates a mode and is not legal in a filename, so it becomes "-".
function shortModel(modelId, model) {
  const base = String(modelId || model || "model")
    .replace(/\.(safetensors|ckpt|gguf|pt|sft)$/i, "")
    .replace(/:/g, "-");
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
    base = `${stamp}_${shortModel(meta.modelId, meta.model)}${seedPart}${idxPart}`;
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
    model: meta.model,          // the exact file that ran — for reproduction / forensics
    modelId: meta.modelId,      // canonical identity — what the UI groups and filters by
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
    migrated: meta.migrated,        // came from the one-time history migration, not a fresh render
    fromArchive: meta.fromArchive,  // which archive it was pulled out of, when migrated
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

function list({ type, model, source, q, rating, before, limit = 60 } = {}) {
  load();
  const needle = String(q || "").toLowerCase();
  let all = [...entries.values()];
  if (type) all = all.filter((e) => e.kind === type);
  // Named values rather than numbers, because "0" would otherwise be ambiguous between
  // "rated exactly zero" and "rated at least zero" (= rated at all). Note every test is
  // written against `e.rating != null`: `>= 3` on an absent rating is false anyway, but
  // `>= 0` would sweep in every unrated file, which is precisely the confusion this
  // whole field exists to avoid.
  if (rating) {
    if (rating === "unrated") all = all.filter((e) => e.rating == null);
    else if (rating === "rated") all = all.filter((e) => e.rating != null);
    else if (rating === "zero") all = all.filter((e) => e.rating === 0);
    else {
      const min = Number(rating);
      if (Number.isFinite(min)) all = all.filter((e) => e.rating != null && e.rating >= min);
    }
  }
  // Match the canonical id: exact, or a "model:" prefix so asking for "bernini" returns
  // every mode of it. Falls back to the raw filename for anything recorded without an id.
  if (model) {
    const want = String(model).toLowerCase();
    all = all.filter((e) => {
      const id = String(e.modelId || "").toLowerCase();
      if (id) return id === want || id.startsWith(want + ":");
      return (e.model || "").toLowerCase().includes(want);
    });
  }
  if (source) all = all.filter((e) => (e.source || "generated") === source);
  if (needle) all = all.filter((e) => `${e.prompt || ""} ${e.originalName || ""} ${e.desc || ""}`.toLowerCase().includes(needle));
  all.sort((a, b) => b.ts - a.ts || (a.path < b.path ? 1 : -1));
  if (before) all = all.filter((e) => e.ts < Number(before));
  const page = all.slice(0, Math.min(500, Math.max(1, Number(limit) || 60)));
  return { items: page, total: all.length, hasMore: all.length > page.length };
}

function stats() {
  load();
  let bytes = 0, images = 0, videos = 0, other = 0;
  // Which models are actually represented, for the gallery's model filter. Counted on the
  // MODEL (everything before the ":"), not the mode: five Bernini tasks are one entry in
  // the picker, and the list filter matches by that same prefix. Counting has to happen
  // here rather than in the browser — /list is paged, so a page never sees every model.
  const modelCount = new Map();
  for (const e of entries.values()) {
    bytes += e.bytes || 0;
    if (e.kind === "image") images++;
    else if (e.kind === "video") videos++;
    else other++;
    const id = String(e.modelId || "").split(":")[0];
    if (id) modelCount.set(id, (modelCount.get(id) || 0) + 1);
  }
  const models = [...modelCount].map(([id, n]) => ({ id, n })).sort((a, b) => b.n - a.n || a.id.localeCompare(b.id));
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
  return { count: entries.size, bytes, images, videos, other, thumbBytes, tombstones: tombstoneCount, dir: GALLERY_DIR, models };
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

// The one user-editable field. It is deliberately NOT the prompt: the prompt is the
// record of what actually produced the file (and what "Run it again" reloads), so it
// stays read-only, and anything the user wants to write for their own retrieval goes
// here. Both are matched by search.
//
// Written the same way as everything else — append a fresh full record; the later
// line wins at load time, and compact() collapses the history.
function describe(id, desc) {
  load();
  const cur = entries.get(id);
  if (!cur) return null;
  const text = String(desc == null ? "" : desc).trim().slice(0, 2000);
  const next = { ...cur };
  if (text) next.desc = text; else delete next.desc;
  entries.set(id, next);
  append(next);
  return next;
}

// Manual score, 0–5 in half steps. UNRATED AND ZERO ARE DIFFERENT THINGS here: no field
// means "not looked at yet", `rating: 0` means "looked at it, it is a reject" — a real
// verdict worth filtering for (and worth deleting in bulk). The library conflates them,
// using 0 as its clear; this one cannot, so clearing is its own value: rating === null.
//
// Written like every other edit — a fresh full record appended to the ledger, later line
// wins. Re-rating the same file a dozen times costs a dozen short lines until compact().
function rate(id, rating) {
  load();
  const cur = entries.get(id);
  if (!cur) return null;
  const next = { ...cur };
  const n = Number(rating);
  if (rating == null || rating === "" || !Number.isFinite(n)) delete next.rating;
  else next.rating = Math.max(0, Math.min(5, Math.round(n * 2) / 2));
  entries.set(id, next);
  append(next);
  return next;
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

// Which archived conversations reference which artifacts. Note archives do not carry
// message ids (they are runtime-only), so an archive reference is shown but cannot be
// jumped into — only open conversations can. Archives live on the
// server, so this half of the reference graph is ours; the browser scans its own
// conversations for the live half and merges the two.
//
// Rescanning 45 compressed archives on every gallery click is wasteful, so the result
// is cached to disk as an inverted index keyed by each archive's mtime+size. A file
// that has not changed is never decompressed again; a changed or new one is re-read
// and only its entries are replaced. The cache is derived data — delete it and the
// next call rebuilds it.
const REFS_CACHE = path.join(GALLERY_DIR, ".archive-refs.json");
const REF_FIELDS = ["generatedImages", "generatedVideos", "generatedMeshes",
                    "generatedAudio", "contextImages", "displayImages",
                    "generatedThumbnails", "generatedVideoThumbnails"];

// Both prefixes count: a slot can point at the artifact or at its thumbnail (a bubble's
// inline preview), and either one means that archive still uses the file.
const REF_PREFIXES = ["/api/gallery/file/", "/api/gallery/thumb/"];

function idsInMessage(msg) {
  const ids = new Set();
  for (const f of REF_FIELDS) {
    const v = msg[f];
    const arr = Array.isArray(v) ? v : typeof v === "string" ? [v] : [];
    for (const s of arr) {
      if (typeof s !== "string") continue;
      const prefix = REF_PREFIXES.find((p) => s.startsWith(p));
      if (prefix) ids.add(decodeURIComponent(s.slice(prefix.length)));
    }
  }
  return ids;
}

function loadRefsCache() {
  try { return JSON.parse(fs.readFileSync(REFS_CACHE, "utf8")) || {}; } catch { return {}; }
}

// { [id]: [{archive, title, msgId, timestamp}] } across every archive.
function archiveRefs() {
  let archive;
  try { archive = require("./archive"); } catch { return {}; }
  let files = [];
  try { files = archive.scanArchiveFilenames(); } catch { return {}; }

  const cache = loadRefsCache();          // { [filename]: { mtime, size, title, hits: [[id, msgId, ts], …] } }
  const next = {};
  let rescanned = 0;
  for (const filename of files) {
    const abs = path.join(config.ARCHIVES_DIR, filename);
    let st;
    try { st = fs.statSync(abs); } catch { continue; }
    const prev = cache[filename];
    if (prev && prev.mtime === st.mtimeMs && prev.size === st.size) { next[filename] = prev; continue; }
    let data;
    try { data = JSON.parse(archive.readArchiveFile(abs)); } catch { continue; }
    const hits = [];
    for (const msg of data.messages || []) {
      // Normalised to null, not left undefined: these round-trip through the JSON
      // cache, where undefined would come back as null and make the cold and warm
      // paths return differently-shaped objects.
      for (const id of idsInMessage(msg)) hits.push([id, msg.id ?? null, msg.timestamp ?? null]);
    }
    next[filename] = { mtime: st.mtimeMs, size: st.size, title: data.title || filename, hits };
    rescanned++;
  }
  if (rescanned || Object.keys(next).length !== Object.keys(cache).length) {
    try {
      ensureDir(GALLERY_DIR);
      const tmp = `${REFS_CACHE}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(next));
      fs.renameSync(tmp, REFS_CACHE);
    } catch { /* the cache is an optimisation, not a requirement */ }
    if (rescanned) console.log(`[gallery] archive reference index: ${rescanned} of ${files.length} archive(s) re-read`);
  }

  const out = {};
  for (const [filename, rec] of Object.entries(next)) {
    for (const [id, msgId, timestamp] of rec.hits) {
      (out[id] ||= []).push({ archive: filename, title: rec.title, msgId, timestamp });
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
  if (entry.kind === "mesh" || entry.kind === "audio") return false;   // nothing to draw
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
      rating: u.searchParams.get("rating") || undefined,
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

async function handleDescribe(req, res) {
  try {
    const body = await readBody(req);
    const e = describe(String(body.id || ""), body.desc);
    if (!e) { sendJson(res, 404, { error: "not in gallery" }); return; }
    sendJson(res, 200, { ok: true, desc: e.desc || "" });
  } catch (e) { sendJson(res, 500, { error: e.message }); }
}

// { id, rating } — a number 0..5 to score, null to un-score. `?? null` throughout, never
// `|| null`: a rating of 0 is a value, not an absence.
async function handleRate(req, res) {
  try {
    const body = await readBody(req);
    const e = rate(String(body.id || ""), body.rating);
    if (!e) { sendJson(res, 404, { error: "not in gallery" }); return; }
    sendJson(res, 200, { ok: true, rating: e.rating ?? null });
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

// Show the file in the OS file manager. The gallery is a folder of real files, and
// getting at them is half the point of putting them on disk. The path never comes
// from the request — only the ledger id does, and it has to already exist.
function handleReveal(req, res) {
  readBody(req).then((body) => {
    const id = String(body.id || "");
    const abs = get(id) && absPathOf(id);
    if (!abs || !fs.existsSync(abs)) { sendJson(res, 404, { error: "not in gallery" }); return; }
    const cmd = process.platform === "darwin" ? ["open", ["-R", abs]]
      : process.platform === "win32" ? ["explorer", [`/select,${abs}`]]
      : ["xdg-open", [path.dirname(abs)]];
    execFile(cmd[0], cmd[1], () => {});
    sendJson(res, 200, { ok: true });
  }).catch((e) => sendJson(res, 500, { error: e.message }));
}

// Files dropped straight onto the gallery. The body is the file itself, not base64
// in JSON: a dropped clip can be hundreds of megabytes, and base64 would inflate it
// by a third and then hand the whole thing to JSON.parse as one string. The metadata
// rides in headers instead.
const MAX_UPLOAD = 2 * 1024 * 1024 * 1024;

function kindForMime(mime, name) {
  const m = String(mime || "").toLowerCase();
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/")) return "audio";
  if (m === "model/gltf-binary" || /\.(glb|gltf)$/i.test(name || "")) return "mesh";
  return null;
}

async function handleUpload(req, res) {
  try {
    const name = decodeURIComponent(req.headers["x-gallery-name"] || "");
    const mime = String(req.headers["content-type"] || "application/octet-stream").split(";")[0];
    const kind = kindForMime(mime, name);
    if (!kind) { sendJson(res, 415, { error: `not a media file (${mime})` }); return; }

    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > MAX_UPLOAD) { req.destroy(); sendJson(res, 413, { error: "file too large" }); return; }
      chunks.push(c);
    }
    const buffer = Buffer.concat(chunks);
    if (!buffer.length) { sendJson(res, 400, { error: "empty file" }); return; }

    // Dedup is on (record's default for uploads): dropping the same picture twice
    // should land on the file that is already there.
    const e = record({ kind, mime, buffer, meta: { source: "upload", originalName: name } });
    sendJson(res, 200, { id: e.path, deduped: !!e.deduped, kind });
  } catch (err) { sendJson(res, 500, { error: err.message }); }
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
  GALLERY_DIR, record, recordMany, get, list, stats, remove, describe, rate, compact, archiveRefs, makeThumb,
  handleList, handleFile, handleThumb, handlePutThumb, handleDelete, handleDescribe, handleRate, handleStats,
  handleRefs, handleCompact, handleImport, handleUpload, handleReveal,
  _reset() { entries = null; hashIndex = null; },   // tests
};
