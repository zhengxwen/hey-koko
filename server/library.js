// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

// Knowledge-library (RAG) backend: stores each imported doc as one compressed
// JSON (text blocks + inline image base64), keeps its per-block vectors in a
// sibling binary .vec, and serves block-level semantic retrieval. Parsing &
// URL fetching are done by the frontend (reusing /api/parse-file, /api/fetch-url);
// this module only does chunking → embed → store → retrieve.

const fs = require("fs");
const path = require("path");
const os = require("os");
const zlib = require("zlib");
const { sendJson, readBody } = require("./utils");
const { embedBatch, cosine, hashText, DEFAULT_MODEL } = require("./embed");
const { encodeVectors, decodeVectors } = require("./vecfile");

const HAS_ZSTD = typeof zlib.zstdCompressSync === "function";
const LIBRARY_DIR = path.join(os.homedir(), ".hey-koko", "library");
const DOC_EXT = HAS_ZSTD ? ".json.zst" : ".json.gz";
const MAX_BLOCK_CHARS = 32000;    // one section = one block; only split a genuinely huge section
                                  // (qwen3-embedding handles ~32k tokens; 32k chars ≈ 8k tokens, still within)
const MIN_BLOCK_CHARS = 16;       // drop noise blocks (stray tags, page numbers) below this
const EMBED_BATCH = 8;

function ensureDir() {
  if (!fs.existsSync(LIBRARY_DIR)) fs.mkdirSync(LIBRARY_DIR, { recursive: true });
}

// Standard top-level folders new imports are auto-sorted into (see classifyFolder).
// Pre-created so the move popup / ask-scope menus always list them, even empty.
const CATEGORY_DIRS = ["paper", "youtube", "pdf", "url", "doc"];
function ensureCategoryDirs() {
  ensureDir();
  for (const d of CATEGORY_DIRS) {
    const p = path.join(LIBRARY_DIR, d);
    if (!fs.existsSync(p)) { try { fs.mkdirSync(p, { recursive: true }); } catch {} }
  }
}

// Auto-classify a NEW import into a top-level folder by its source type:
// YouTube links → youtube, other web URLs → url, PDFs → pdf, everything else → doc.
function classifyFolder(source) {
  const s = String(source || "");
  if (s.startsWith("url:")) {
    const u = s.slice(4);
    return /(?:\/\/|\.)(?:youtube\.com|youtu\.be|youtube-nocookie\.com)(?:\/|$)/i.test(u) ? "youtube" : "url";
  }
  if (s.startsWith("file:")) return /\.pdf$/i.test(s.slice(5)) ? "pdf" : "doc";
  return "doc";
}

// Normalize a user-supplied sub-folder to a safe relative path ("" = root).
// Returns null if it would escape LIBRARY_DIR (path traversal).
function sanitizeFolder(dir) {
  const n = path.normalize(String(dir || "")).replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (n === "" || n === ".") return "";
  if (n === ".." || n.startsWith("../")) return null;
  return n;
}

// ---- folder-aware paths ---------------------------------------------------
// Docs may live in sub-folders under LIBRARY_DIR for organization; a doc's two
// files (<id>.json.zst + <id>.vec) always sit together in the SAME folder.
// docId stays a bare key — we resolve it to its on-disk folder by scanning the
// tree and taking the FIRST match, so a duplicate id across folders never
// conflicts (docId never needs a path). The scan is cached, rebuilt on writes.
let LOC = null;   // Map docId -> folder ("" = library root)
function buildLoc() {
  ensureDir();
  const map = new Map();
  const walk = (dir, rel) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      if (e.isDirectory()) { walk(path.join(dir, e.name), rel ? `${rel}/${e.name}` : e.name); continue; }
      const ext = e.name.endsWith(".json.zst") ? ".json.zst" : e.name.endsWith(".json.gz") ? ".json.gz" : null;
      if (!ext) continue;
      const id = e.name.slice(0, -ext.length);
      if (!map.has(id)) map.set(id, rel);   // 取第一个：忽略其它同名副本，docId 不冲突
    }
  };
  walk(LIBRARY_DIR, "");
  LOC = map;
  return map;
}
function locOf(id) { return (LOC || buildLoc()).get(id) || ""; }
function invalidateLoc() { LOC = null; }

function folderDir(folder) { return folder ? path.join(LIBRARY_DIR, folder) : LIBRARY_DIR; }
function docPath(id, folder) {
  const dir = folderDir(folder == null ? locOf(id) : folder);
  const zst = path.join(dir, id + ".json.zst");
  const gz = path.join(dir, id + ".json.gz");
  if (fs.existsSync(zst)) return zst;
  if (fs.existsSync(gz)) return gz;
  return path.join(dir, id + DOC_EXT);   // not yet on disk → canonical ext for a new write
}
function vecPath(id, folder) { return path.join(folderDir(folder == null ? locOf(id) : folder), id + ".vec"); }
function indexFile() { return path.join(LIBRARY_DIR, "index.json"); }

// ---- compressed doc JSON read/write (same zstd scheme as archives) --------
// folder defaults to the doc's current on-disk folder (save/reparse stay in
// place), or "" for a brand-new doc (import lands at root; user moves later).
function writeDoc(doc, folder) {
  const f = folder == null ? locOf(doc.docId) : folder;
  const dir = folderDir(f);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const buf = Buffer.from(JSON.stringify(doc), "utf-8");
  const out = HAS_ZSTD ? zlib.zstdCompressSync(buf) : zlib.gzipSync(buf);
  fs.writeFileSync(path.join(dir, doc.docId + DOC_EXT), out);
  invalidateLoc();
}
function readDoc(id, folder) {
  const p = docPath(id, folder);
  if (!fs.existsSync(p)) return null;
  try {
    const raw = fs.readFileSync(p);
    const txt = p.endsWith(".zst") ? zlib.zstdDecompressSync(raw).toString("utf-8")
              : p.endsWith(".gz") ? zlib.gunzipSync(raw).toString("utf-8")
              : raw.toString("utf-8");
    return JSON.parse(txt);
  } catch { return null; }
}

// ---- binary vectors: zstd-compressed, self-describing header + fp32 data ---
// The binary .vec format (HKV1 header + model name + fp32, zstd-compressed) lives in
// ./vecfile.js and is shared with the archive embedding index. These two wrappers just
// add the library's per-doc file IO (folder resolution) around encode/decode.
function writeVectors(id, vectors, folder, model = "") {
  const f = folder == null ? locOf(id) : folder;
  const dir = folderDir(f);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, id + ".vec"), encodeVectors(vectors, model));
}
// → { vectors:[Float32Array], model, dim, count }. Non-HKV1 (legacy/absent) → empty.
function readVectors(id, _blockCount, folder) {
  let buf;
  try { buf = fs.readFileSync(vecPath(id, folder)); } catch { return { vectors: [], model: "", dim: 0, count: 0 }; }
  return decodeVectors(buf);
}

// ---- index.json (lightweight per-doc metadata for the list view) ----------
function loadIndex() { try { return JSON.parse(fs.readFileSync(indexFile(), "utf-8")); } catch { return []; } }
function saveIndex(arr) { ensureDir(); fs.writeFileSync(indexFile(), JSON.stringify(arr)); }
function upsertIndex(doc) {
  const arr = loadIndex().filter(d => d.docId !== doc.docId);
  arr.push({
    docId: doc.docId, type: doc.type, docKind: doc.docKind, source: doc.source,
    title: doc.title, authors: doc.authors || "", year: doc.year || "",
    tags: doc.tags || [], blockCount: (doc.blocks || []).length,
  });
  saveIndex(arr);
}
function removeFromIndex(id) { saveIndex(loadIndex().filter(d => d.docId !== id)); }

// ---- docId derived from source (file basename / URL), sanitized + deduped --
function deriveDocId(source) {
  let base;
  if (source && source.startsWith("url:")) {
    try { const u = new URL(source.slice(4)); base = (u.hostname + u.pathname).replace(/\/+$/, ""); }
    catch { base = source.slice(4); }
  } else if (source && source.startsWith("file:")) {
    base = source.slice(5).replace(/\.[^.]+$/, "");
  } else {
    base = (source || "doc").replace(/\.[^.]+$/, "");
  }
  base = base.replace(/[^\w一-龥.-]+/g, "_").replace(/^[_.]+|[_.]+$/g, "").slice(0, 80) || "doc";
  // Same source (basename / URL) → same docId → re-import overwrites = incremental update.
  return base;
}

// ---- chunking: Markdown → blocks (text / figure / table), no overlap ------
function splitLong(s) {
  if (s.length <= MAX_BLOCK_CHARS) return [s];
  const out = [];
  let buf = "";
  for (const part of s.split(/(?<=[。.!?！？\n])/)) {
    if (buf.length + part.length > MAX_BLOCK_CHARS && buf) { out.push(buf.trim()); buf = ""; }
    buf += part;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

// Strip standalone structural tags MinerU/Pandoc leave behind (e.g. </details>).
function stripNoiseTags(line) {
  return line.replace(/<\/?(details|summary|div|span|figure|figcaption)\b[^>]*>/gi, "").trimEnd();
}
// Noise if, stripped of tags + markdown punctuation, almost nothing real remains.
function isNoiseBlock(s) {
  return s.replace(/<[^>]+>/g, "").replace(/[\s#>*|_~`-]+/g, "").length < MIN_BLOCK_CHARS;
}

function splitIntoBlocks(text, images) {
  const imgByName = new Map((images || []).map(im => [im.name, im]));
  const lines = (text || "").split(/\r?\n/);
  const blocks = [];
  let section = "", para = [], bid = 0, sectionFigs = [];

  // Figures found inside a section are deferred and flushed right AFTER its text,
  // so an interspersed figure never breaks the section's prose into separate chunks.
  const flushFigs = () => {
    for (const fig of sectionFigs) { fig.id = `b${bid++}`; blocks.push(fig); }
    sectionFigs = [];
  };
  // One section = one text block: all paragraphs/lists/tables accumulate (across any
  // figures), and only a genuinely huge section gets split (splitLong) to avoid embed
  // truncation. Then the section's figures follow as their own blocks.
  const emit = () => {
    const content = para.join("\n").trim();
    para = [];
    if (content && !isNoiseBlock(content)) {
      for (const piece of splitLong(content)) blocks.push({ id: `b${bid++}`, kind: "text", section, content: piece, hash: hashText(piece) });
    }
    flushFigs();
  };

  for (const raw of lines) {
    const line = stripNoiseTags(raw);
    const h = line.match(/^(#{1,6})\s+(.*)/);
    if (h) {
      const name = h[2].trim();
      if (name === section) continue;        // duplicate heading (MinerU repeats it across columns/pages) → stay in one block
      emit(); section = name; continue;      // real section boundary → flush text + its figures
    }
    const img = raw.match(/!\[[^\]]*\]\((image_\d+\.\w+)\)/);
    if (img) {
      // figure is its own block (carries the inline image) but is DEFERRED, not emitted
      // inline — so it doesn't split the surrounding prose.
      const im = imgByName.get(img[1]);
      const caption = raw.replace(/!\[[^\]]*\]\([^)]*\)/, "").trim();
      // keep the original image filename (e.g. image_01.jpg) so downloads/lightbox use it
      const fig = { kind: "figure", section, content: caption || img[1], imageName: img[1], hash: hashText(img[1] + caption) };
      if (im) { fig.image = im.base64; fig.imageMime = im.mime; }
      sectionFigs.push(fig);
      continue;
    }
    para.push(line.trim() === "" ? "" : line);   // accumulate everything else into the section block
  }
  emit();
  return blocks;
}

// ---- embedding (batched, with per-item fallback so one bad block can't fail all) ----
async function embedMany(texts, model) {
  const out = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const part = texts.slice(i, i + EMBED_BATCH).map(t => (t && t.trim()) ? t : " ");
    let embs;
    try { embs = await embedBatch(part, model); }
    catch {
      embs = [];
      for (const t of part) { try { const [v] = await embedBatch([t], model); embs.push(v || null); } catch { embs.push(null); } }
    }
    for (const e of embs) out.push(e || null);
  }
  return out;
}
const blockEmbedText = (b) => (b.kind === "figure" ? (b.content || "image") : (b.content || " "));

// ---- in-memory retrieval cache (rebuilt only when the library changes) -----
let CACHE = null;
function invalidateCache() { CACHE = null; }
function buildCache() {
  const items = [];
  for (const meta of loadIndex()) {
    const folder = locOf(meta.docId);
    const doc = readDoc(meta.docId, folder);
    if (!doc || !doc.blocks) continue;
    let vr;
    try { vr = readVectors(meta.docId, doc.blocks.length, folder); } catch { continue; }
    if (!vr.vectors.length) continue;   // legacy/absent .vec (no HKV1 header) → skip; re-embed to migrate
    const vecs = vr.vectors;
    doc.blocks.forEach((b, i) => {
      if (b.embed === false) return;   // stored for the conversation but not retrievable
      items.push({
        docId: meta.docId, title: doc.title, docKind: doc.docKind, folder,
        blockId: b.id, idx: i, section: b.section, kind: b.kind,
        content: b.content, hasImage: !!b.image, vec: vecs[i], model: vr.model,
      });
    });
  }
  CACHE = { items };
  return CACHE;
}
function getCache() { return CACHE || buildCache(); }

const QWEN_INSTRUCT = "Instruct: Given a search query, retrieve the relevant passage from the knowledge base.\nQuery: ";
async function embedQuery(query, model) {
  const qtext = /qwen/i.test(model) ? `${QWEN_INSTRUCT}${query}` : query;
  const [qvec] = await embedBatch([qtext], model);
  return qvec;
}

async function retrieve(query, model, { docId = null, docIds = null, folder = null, topK = 8 } = {}) {
  // docIds (array) scopes to several docs; docId (string) scopes to one;
  // folder (string) scopes to a sub-folder and everything nested under it;
  // none of them → whole library.
  const set = (docIds && docIds.length) ? new Set(docIds) : null;
  const inFolder = (it) => folder == null ? true : (it.folder === folder || it.folder.startsWith(folder + "/"));
  // Only compare against vectors built with the SAME embedding model — a different
  // model is a different vector space (and possibly a different dim), so cosine there
  // is meaningless. The .vec header records the model; we match it to the query's.
  const pool = getCache().items.filter(it => it.vec && it.model === model && inFolder(it) && (set ? set.has(it.docId) : (!docId || it.docId === docId)));
  if (!pool.length) return [];
  const qvec = await embedQuery(query, model);
  if (!qvec) return [];
  return pool
    .map(it => ({ it, score: cosine(qvec, it.vec) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(s => ({ ...s.it, score: s.score, vec: undefined }));
}

// On-demand figures: for each hit, pull inline base64 of figure blocks within
// ±1 of the hit (the hit itself or an adjacent figure), capped at maxImages.
function attachImages(hits, maxImages) {
  const picked = [];
  const seen = new Set();
  const docCache = new Map();
  for (const h of hits) {
    if (picked.length >= maxImages) break;
    let doc = docCache.get(h.docId);
    if (doc === undefined) { doc = readDoc(h.docId); docCache.set(h.docId, doc); }
    if (!doc || !doc.blocks) continue;
    for (let j = h.idx - 1; j <= h.idx + 1; j++) {
      const b = doc.blocks[j];
      if (!b || b.kind !== "figure" || !b.image) continue;
      const key = `${h.docId}:${b.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      picked.push({ docId: h.docId, title: h.title, blockId: b.id, image: b.image, imageMime: b.imageMime });
      if (picked.length >= maxImages) break;
    }
  }
  return picked;
}

// ---- HTTP handlers --------------------------------------------------------

// POST /api/library/import  { source, docKind, title, authors?, year?, tags?, text, images?[] }
async function importLibrary(req, res) {
  try {
    const body = await readBody(req);
    const model = body.model || DEFAULT_MODEL;
    const blocks = splitIntoBlocks(body.text || "", body.images || []);
    if (!blocks.length) { sendJson(res, 400, { error: "文档为空，无法导入" }); return; }
    const vectors = await embedMany(blocks.map(blockEmbedText), model);
    const docId = deriveDocId(body.source || `file:${body.title || "doc"}`);
    const doc = {
      type: "libdoc", schemaVersion: 1,
      docKind: body.docKind || "doc",
      docId, source: body.source || "",
      title: body.title || docId,
      authors: body.authors || "", year: body.year || "",
      tags: body.tags || [], embedModel: model,
      blocks,
    };
    // Folder precedence: an explicit body.folder (e.g. the "本地论文" importer → paper)
    // always wins; otherwise a re-import keeps its current folder (never undo a manual
    // move); otherwise a new doc is auto-classified by source (youtube/pdf/url/doc).
    const requested = (typeof body.folder === "string" && body.folder.trim()) ? sanitizeFolder(body.folder) : null;
    const known = (LOC || buildLoc()).has(docId);
    const folder = requested != null ? requested : (known ? locOf(docId) : classifyFolder(body.source));
    writeDoc(doc, folder);
    writeVectors(docId, vectors, folder, model);
    upsertIndex(doc);
    invalidateCache();
    sendJson(res, 200, { ok: true, docId, blockCount: blocks.length, folder });
  } catch (e) { sendJson(res, 500, { error: e.message }); }
}

// POST /api/library/list  → { docs:[index entries] }
async function listLibrary(_req, res) {
  try { sendJson(res, 200, { docs: loadIndex().map(d => ({ ...d, folder: locOf(d.docId) })) }); }
  catch (e) { sendJson(res, 500, { error: e.message }); }
}

// POST /api/library/dirs → { dirs:[""(root), "papers", "papers/ml", …] }
async function listLibraryDirs(_req, res) {
  try {
    ensureCategoryDirs();
    const dirs = [""];   // root represented as ""
    const walk = (dir, rel) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.isDirectory() && !e.name.startsWith(".")) {
          const r = rel ? `${rel}/${e.name}` : e.name;
          dirs.push(r);
          walk(path.join(dir, e.name), r);
        }
      }
    };
    walk(LIBRARY_DIR, "");
    sendJson(res, 200, { dirs: dirs.sort() });
  } catch (e) { sendJson(res, 500, { error: e.message }); }
}

// POST /api/library/move  { docIds:[], targetDir } → move each doc's .json + .vec
// into targetDir (created if needed). docId is unchanged; if a same-id file is
// already in the target it is overwritten (move wins).
async function moveLibraryDocs(req, res) {
  try {
    const body = await readBody(req);
    const targetDir = sanitizeFolder(body.targetDir || "");
    if (targetDir === null) { sendJson(res, 400, { error: "Invalid target directory" }); return; }
    const destDir = folderDir(targetDir);
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
    const moved = [], errors = [];
    for (const id of (body.docIds || [])) {
      if (typeof id !== "string" || id.includes("/") || id.includes("..")) { errors.push({ docId: id, error: "Invalid id" }); continue; }
      const cur = locOf(id);
      if (cur === targetDir) continue;   // already there
      try {
        const srcDoc = docPath(id, cur);
        if (fs.existsSync(srcDoc)) fs.renameSync(srcDoc, path.join(destDir, path.basename(srcDoc)));
        const srcVec = vecPath(id, cur);
        if (fs.existsSync(srcVec)) fs.renameSync(srcVec, path.join(destDir, id + ".vec"));
        moved.push(id);
      } catch (e) { errors.push({ docId: id, error: e.message }); }
    }
    invalidateLoc();
    invalidateCache();
    sendJson(res, 200, { moved, errors });
  } catch (e) { sendJson(res, 500, { error: e.message }); }
}

// POST /api/library/search { query, model? } → doc-level results by best block score
async function searchLibrary(req, res) {
  try {
    const body = await readBody(req);
    const query = (body.query || "").trim();
    const model = body.model || DEFAULT_MODEL;
    if (!query) { sendJson(res, 400, { error: "query required" }); return; }
    const hits = await retrieve(query, model, { topK: 50 });
    const best = new Map();
    for (const h of hits) {
      const cur = best.get(h.docId);
      if (!cur || h.score > cur.score) best.set(h.docId, { docId: h.docId, title: h.title, docKind: h.docKind, score: h.score });
    }
    sendJson(res, 200, { results: [...best.values()].sort((a, b) => b.score - a.score) });
  } catch (e) { sendJson(res, 500, { error: e.message }); }
}

// POST /api/library/get  { docId } → { doc }  (full doc incl. inline images)
async function getLibraryDoc(req, res) {
  try {
    const body = await readBody(req);
    const doc = readDoc(body.docId);
    if (!doc) { sendJson(res, 404, { error: "文档不存在" }); return; }
    sendJson(res, 200, { doc });
  } catch (e) { sendJson(res, 500, { error: e.message }); }
}

// POST /api/library/save  { doc, model? } → re-embed only hash-changed blocks
async function saveLibraryDoc(req, res) {
  try {
    const body = await readBody(req);
    const doc = body.doc;
    const model = body.model || DEFAULT_MODEL;
    if (!doc || doc.type !== "libdoc" || !doc.docId) { sendJson(res, 400, { error: "无效的文档" }); return; }

    const old = readDoc(doc.docId);
    const oldMap = new Map();
    if (old && old.blocks) {
      let ov = { vectors: null, model: "" };
      try { ov = readVectors(doc.docId, old.blocks.length); } catch {}
      // reuse an old vector only if it was built with the SAME model (else re-embed all)
      if (ov.model === model && ov.vectors && ov.vectors.length) {
        old.blocks.forEach((b, i) => oldMap.set(b.id, { hash: b.hash, vec: ov.vectors[i] || null }));
      }
    }

    const newVecs = new Array(doc.blocks.length).fill(null);
    const toEmbed = [], toEmbedIdx = [];
    doc.blocks.forEach((b, i) => {
      b.hash = hashText(blockEmbedText(b));
      if (b.embed === false) return;   // not vectorized → leave a zero-vector slot
      const prev = oldMap.get(b.id);
      if (prev && prev.hash === b.hash && prev.vec) newVecs[i] = prev.vec;
      else { toEmbed.push(blockEmbedText(b)); toEmbedIdx.push(i); }
    });
    if (toEmbed.length) {
      const embs = await embedMany(toEmbed, model);
      toEmbedIdx.forEach((di, k) => { newVecs[di] = embs[k]; });
    }
    writeDoc(doc);
    writeVectors(doc.docId, newVecs, null, model);
    upsertIndex(doc);
    invalidateCache();
    sendJson(res, 200, { ok: true, reembedded: toEmbed.length });
  } catch (e) { sendJson(res, 500, { error: e.message }); }
}

// POST /api/library/delete  { docIds:[] }
async function deleteLibraryDocs(req, res) {
  try {
    const body = await readBody(req);
    const deleted = [];
    for (const id of (body.docIds || [])) {
      if (typeof id !== "string" || id.includes("/") || id.includes("..")) continue;
      const folder = locOf(id);
      try { fs.existsSync(docPath(id, folder)) && fs.unlinkSync(docPath(id, folder)); } catch {}
      try { fs.existsSync(vecPath(id, folder)) && fs.unlinkSync(vecPath(id, folder)); } catch {}
      removeFromIndex(id);
      deleted.push(id);
    }
    invalidateLoc();
    invalidateCache();
    sendJson(res, 200, { ok: true, deleted });
  } catch (e) { sendJson(res, 500, { error: e.message }); }
}

// POST /api/library/retrieve  { query, model?, docId?, topK?, attachImages?, maxImages? }
//   → { hits:[{docId,title,docKind,blockId,section,kind,content,score}], images:[{...base64}] }
// Generation is done by the frontend (reusing /api/chat) from these hits.
async function retrieveLibrary(req, res) {
  try {
    const body = await readBody(req);
    const query = (body.query || "").trim();
    const model = body.model || DEFAULT_MODEL;
    if (!query) { sendJson(res, 400, { error: "query required" }); return; }
    const hits = await retrieve(query, model, {
      docId: body.docId || null,
      docIds: Array.isArray(body.docIds) ? body.docIds : null,
      folder: (typeof body.folder === "string" && body.folder.trim()) ? sanitizeFolder(body.folder) : null,
      topK: body.topK || 8,
    });
    const images = body.attachImages ? attachImages(hits, body.maxImages || 3) : [];
    sendJson(res, 200, {
      hits: hits.map(h => ({
        docId: h.docId, title: h.title, docKind: h.docKind, blockId: h.blockId,
        section: h.section, kind: h.kind, content: h.content, score: h.score, hasImage: h.hasImage,
      })),
      images,
    });
  } catch (e) { sendJson(res, 500, { error: e.message }); }
}

// A conversation/annotation block (question, reply, or /note) — carries a role and
// renders as a chat bubble. NOT part of the document body, so it must survive a
// reparse intact instead of being re-chunked into role-less text.
const isConvBlock = (b) => b && (b.kind === "user" || b.kind === "reply" || b.kind === "note");

// POST /api/library/reparse  { docId, text, images?, model? }
// Re-chunk an edited full-markdown into fresh DOCUMENT blocks (keeps metadata),
// then re-append the doc's existing conversation bubbles (Q&A/notes) unchanged so
// editing the article never destroys the conversation. Document chunks + note
// blocks are (re)embedded; plain user/reply bubbles keep a zero-vector slot.
async function reparseLibrary(req, res) {
  try {
    const body = await readBody(req);
    const model = body.model || DEFAULT_MODEL;
    const old = readDoc(body.docId);
    if (!old) { sendJson(res, 404, { error: "文档不存在" }); return; }
    const convBlocks = (old.blocks || []).filter(isConvBlock);   // preserve the conversation
    const newChunks = splitIntoBlocks(body.text || "", body.images || []);
    if (!newChunks.length && !convBlocks.length) { sendJson(res, 400, { error: "内容为空，无法重新分块" }); return; }
    // re-id sequentially so freshly-chunked ids can't collide with preserved conv ids
    const blocks = [...newChunks, ...convBlocks].map((b, i) => ({ ...b, id: `b${i}` }));
    const vectors = new Array(blocks.length).fill(null);
    const toEmbed = [], toEmbedIdx = [];
    blocks.forEach((b, i) => {
      b.hash = hashText(blockEmbedText(b));
      if (b.embed === false) return;   // plain Q/A bubble → not retrievable, zero slot
      toEmbed.push(blockEmbedText(b)); toEmbedIdx.push(i);
    });
    if (toEmbed.length) {
      const embs = await embedMany(toEmbed, model);
      toEmbedIdx.forEach((di, k) => { vectors[di] = embs[k]; });
    }
    const doc = { ...old, blocks };
    writeDoc(doc);
    writeVectors(doc.docId, vectors, null, model);
    upsertIndex(doc);
    invalidateCache();
    sendJson(res, 200, { ok: true, blockCount: blocks.length, conversationKept: convBlocks.length });
  } catch (e) { sendJson(res, 500, { error: e.message }); }
}

module.exports = {
  importLibrary, listLibrary, searchLibrary, getLibraryDoc,
  saveLibraryDoc, deleteLibraryDocs, retrieveLibrary, reparseLibrary, LIBRARY_DIR,
  listLibraryDirs, moveLibraryDocs,
  splitIntoBlocks,   // exported for reuse/testing of the chunker
};
