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

const HAS_ZSTD = typeof zlib.zstdCompressSync === "function";
const LIBRARY_DIR = path.join(os.homedir(), "ai_library");
const DOC_EXT = HAS_ZSTD ? ".json.zst" : ".json.gz";
const MAX_BLOCK_CHARS = 4000;     // one section = one block; only split a genuinely huge section
const MIN_BLOCK_CHARS = 16;       // drop noise blocks (stray tags, page numbers) below this
const EMBED_BATCH = 8;

function ensureDir() {
  if (!fs.existsSync(LIBRARY_DIR)) fs.mkdirSync(LIBRARY_DIR, { recursive: true });
}

// ---- paths ----------------------------------------------------------------
function docPath(id) { return path.join(LIBRARY_DIR, id + DOC_EXT); }
function vecPath(id) { return path.join(LIBRARY_DIR, id + ".vec"); }
function indexFile() { return path.join(LIBRARY_DIR, "index.json"); }

// ---- compressed doc JSON read/write (same zstd scheme as archives) --------
function writeDoc(doc) {
  ensureDir();
  const buf = Buffer.from(JSON.stringify(doc), "utf-8");
  const out = HAS_ZSTD ? zlib.zstdCompressSync(buf) : zlib.gzipSync(buf);
  fs.writeFileSync(docPath(doc.docId), out);
}
function readDoc(id) {
  const p = docPath(id);
  if (!fs.existsSync(p)) return null;
  try {
    const raw = fs.readFileSync(p);
    const txt = p.endsWith(".zst") ? zlib.zstdDecompressSync(raw).toString("utf-8")
              : p.endsWith(".gz") ? zlib.gunzipSync(raw).toString("utf-8")
              : raw.toString("utf-8");
    return JSON.parse(txt);
  } catch { return null; }
}

// ---- binary vectors: Float32 little-endian, blockCount * dim --------------
function writeVectors(id, vectors) {
  const dim = vectors.find(Boolean)?.length || 0;
  const flat = new Float32Array(vectors.length * dim);
  vectors.forEach((v, b) => {
    if (!v) return; // missing → leave zeros
    for (let i = 0; i < dim; i++) flat[b * dim + i] = v[i];
  });
  fs.writeFileSync(vecPath(id), Buffer.from(flat.buffer));
}
function readVectors(id, blockCount) {
  const buf = fs.readFileSync(vecPath(id));
  const flat = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));
  const dim = blockCount ? flat.length / blockCount : 0;
  const out = [];
  for (let b = 0; b < blockCount; b++) out.push(flat.subarray(b * dim, (b + 1) * dim));
  return out;
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
  let section = "", para = [], bid = 0;

  // One section = one text block (paragraphs, lists, tables all accumulate);
  // only a genuinely huge section gets split (splitLong) to avoid embed truncation.
  const emit = () => {
    const content = para.join("\n").trim();
    para = [];
    if (!content || isNoiseBlock(content)) return;
    for (const piece of splitLong(content)) blocks.push({ id: `b${bid++}`, kind: "text", section, content: piece, hash: hashText(piece) });
  };

  for (const raw of lines) {
    const line = stripNoiseTags(raw);
    const h = line.match(/^(#{1,6})\s+(.*)/);
    if (h) { emit(); section = h[2].trim(); continue; }   // section boundary → flush the block
    const img = raw.match(/!\[[^\]]*\]\((image_\d+\.\w+)\)/);
    if (img) {
      emit();   // figure is its own block (carries the inline image)
      const im = imgByName.get(img[1]);
      const caption = raw.replace(/!\[[^\]]*\]\([^)]*\)/, "").trim();
      const block = { id: `b${bid++}`, kind: "figure", section, content: caption || img[1], hash: hashText(img[1] + caption) };
      if (im) { block.image = im.base64; block.imageMime = im.mime; }
      blocks.push(block);
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
    const doc = readDoc(meta.docId);
    if (!doc || !doc.blocks) continue;
    let vecs;
    try { vecs = readVectors(meta.docId, doc.blocks.length); } catch { continue; }
    doc.blocks.forEach((b, i) => {
      if (b.embed === false) return;   // stored for the conversation but not retrievable
      items.push({
        docId: meta.docId, title: doc.title, docKind: doc.docKind,
        blockId: b.id, idx: i, section: b.section, kind: b.kind,
        content: b.content, hasImage: !!b.image, vec: vecs[i],
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

async function retrieve(query, model, { docId = null, topK = 8 } = {}) {
  const pool = getCache().items.filter(it => it.vec && (!docId || it.docId === docId));
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
    writeDoc(doc);
    writeVectors(docId, vectors);
    upsertIndex(doc);
    invalidateCache();
    sendJson(res, 200, { ok: true, docId, blockCount: blocks.length });
  } catch (e) { sendJson(res, 500, { error: e.message }); }
}

// POST /api/library/list  → { docs:[index entries] }
async function listLibrary(_req, res) {
  try { sendJson(res, 200, { docs: loadIndex() }); }
  catch (e) { sendJson(res, 500, { error: e.message }); }
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
      let oldVecs = null;
      try { oldVecs = readVectors(doc.docId, old.blocks.length); } catch {}
      old.blocks.forEach((b, i) => oldMap.set(b.id, { hash: b.hash, vec: oldVecs ? oldVecs[i] : null }));
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
    writeVectors(doc.docId, newVecs);
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
      try { fs.existsSync(docPath(id)) && fs.unlinkSync(docPath(id)); } catch {}
      try { fs.existsSync(vecPath(id)) && fs.unlinkSync(vecPath(id)); } catch {}
      removeFromIndex(id);
      deleted.push(id);
    }
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
    const hits = await retrieve(query, model, { docId: body.docId || null, topK: body.topK || 8 });
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
    writeVectors(doc.docId, vectors);
    upsertIndex(doc);
    invalidateCache();
    sendJson(res, 200, { ok: true, blockCount: blocks.length, conversationKept: convBlocks.length });
  } catch (e) { sendJson(res, 500, { error: e.message }); }
}

module.exports = {
  importLibrary, listLibrary, searchLibrary, getLibraryDoc,
  saveLibraryDoc, deleteLibraryDocs, retrieveLibrary, reparseLibrary, LIBRARY_DIR,
  splitIntoBlocks,   // exported for reuse/testing of the chunker
};
