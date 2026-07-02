// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

// Knowledge-library (RAG) backend: stores each imported doc as one compressed
// JSON (text blocks + inline image base64), keeps its per-block vectors in a
// sibling binary .vec, and serves block-level semantic retrieval. Parsing &
// URL fetching are done by the frontend (reusing /api/parse-file, /api/fetch-url);
// this module only does chunking → embed → store → retrieve.

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const config = require("./config");
const { sendJson, readBody } = require("./utils");
const { embedBatch, cosine, hashText, DEFAULT_MODEL } = require("./embed");
const { encodeVectors, decodeVectors } = require("./vecfile");
const claude = require("./claude");
const openai = require("./openai");

const HAS_ZSTD = typeof zlib.zstdCompressSync === "function";
// Under the shared data home (config.DATA_DIR): HEYKOKO_DIR lets a throwaway server
// run against a temp library without ever touching the real ~/.hey-koko/library.
const LIBRARY_DIR = path.join(config.DATA_DIR, "library");
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
    // importedAt: recorded from now on (older docs simply lack it — never faked);
    // hasCard: whether a distillation card (kind:"card") leads the blocks.
    importedAt: doc.importedAt || undefined,
    hasCard: (doc.blocks || []).some(b => b.kind === "card") || undefined,
  });
  saveIndex(arr);
}
function removeFromIndex(id) { saveIndex(loadIndex().filter(d => d.docId !== id)); }

// ---- docId derived from source (file basename / URL), sanitized + deduped --
function deriveDocId(source) {
  let base;
  if (source && source.startsWith("url:")) {
    try {
      const u = new URL(source.slice(4));
      // YouTube URLs → compact "youtube_<videoId>" (hostname+path would be the noisy
      // "www.youtube.com_watch_…"); youtu.be short links carry the id in the path.
      const vid = /(^|\.)youtube\.com$/.test(u.hostname)
        ? (u.searchParams.get("v") || (u.pathname.match(/^\/(?:shorts|live|embed)\/([\w-]+)/) || [])[1])
        : (u.hostname === "youtu.be" ? u.pathname.slice(1).split("/")[0] : null);
      if (vid) base = "youtube_" + vid;
      else base = (u.hostname + u.pathname).replace(/\/+$/, "");
    }
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
      // <br> in a caption (e.g. the YouTube cover's metadata, which must ride the image's
      // single line) becomes a real newline so the stored block content uses \n, not <br>.
      const caption = raw.replace(/!\[[^\]]*\]\([^)]*\)/, "").replace(/<br\s*\/?>/gi, "\n").trim();
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

async function retrieve(query, model, { docId = null, docIds = null, folder = null, topK = 8, rerank = "", language = "" } = {}) {
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
  // cosine top-N candidates → optional LLM listwise rerank → MMR-select topK.
  let cands = pool
    .map(it => ({ it, score: cosine(qvec, it.vec) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(topK * 4, 24));
  if (rerank) cands = await rerankCandidates(query, cands, rerank, topK, language);
  return mmrSelect(cands, topK).map(s => ({ ...s.it, score: s.score, vec: undefined }));
}

// Greedy MMR (maximal marginal relevance): pick topK balancing relevance against
// similarity to what's already picked, λ=0.75. In a big library the same work often
// exists as video+paper+slides — near-duplicate blocks would otherwise crowd the
// whole top-k. Candidate vectors come straight from the cache (tiny: ≤~50² cosines).
const MMR_LAMBDA = 0.75;
function mmrSelect(cands, topK) {
  const picked = [], rest = [...cands];
  while (picked.length < topK && rest.length) {
    let bi = 0, bv = -Infinity;
    for (let i = 0; i < rest.length; i++) {
      const c = rest[i];
      let maxSim = 0;
      for (const p of picked) { const s = cosine(c.it.vec, p.it.vec); if (s > maxSim) maxSim = s; }
      // rel: rerank position (when a rerank ran) beats raw cosine
      const v = MMR_LAMBDA * (c.rel != null ? c.rel : c.score) - (1 - MMR_LAMBDA) * maxSim;
      if (v > bv) { bv = v; bi = i; }
    }
    picked.push(rest.splice(bi, 1)[0]);
  }
  return picked;
}

// One-call listwise LLM rerank: number the candidate snippets, ask the chat model for
// the most-relevant indices in order, keep the top precision zone for MMR. ANY failure
// (bad model, timeout, unparsable output) falls back silently to the vector order.
async function rerankCandidates(query, cands, model, topK, language = "") {
  try {
    const L = distillL(language);
    const lines = cands.map((c, i) => `[${i}] (${c.it.title}${c.it.section ? " · " + c.it.section : ""}) ${String(c.it.content).replace(/\s+/g, " ").slice(0, 200)}`);
    const out = await llmComplete(model, [
      { role: "system", content: L.rerank },
      { role: "user", content: `${L.rerankQuery}${query}\n\n${L.rerankSnippets}\n${lines.join("\n")}` },
    ], { timeoutMs: 30000 });
    const j = parseJsonLoose(out);
    const order = (j && Array.isArray(j.order) ? j.order : []).map(Number).filter(n => Number.isInteger(n) && n >= 0 && n < cands.length);
    if (!order.length) return cands;
    const seen = new Set(order);
    const ranked = [...order.map(i => cands[i]), ...cands.filter((_, i) => !seen.has(i))].slice(0, Math.max(topK * 2, topK));
    // MMR must honor the RERANKED order, not re-sort by cosine — feed it a positional
    // relevance; the hit's displayed score stays the original cosine.
    ranked.forEach((c, i) => { c.rel = 1 - i / ranked.length; });
    return ranked;
  } catch { return cands; }
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

// Import one doc (chunk → embed → write). Shared by the HTTP handler and the
// server-side libimport background job (jobs.js). Throws on failure.
async function importDocInternal(body) {
  const model = body.model || DEFAULT_MODEL;
  const blocks = splitIntoBlocks(body.text || "", body.images || []);
  if (!blocks.length) throw new Error("文档为空，无法导入");
  const vectors = await embedMany(blocks.map(blockEmbedText), model);
  const docId = deriveDocId(body.source || `file:${body.title || "doc"}`);
  const doc = {
    type: "libdoc", schemaVersion: 1,
    docKind: body.docKind || "doc",
    docId, source: body.source || "",
    title: body.title || docId,
    authors: body.authors || "", year: body.year || "",
    tags: body.tags || [], embedModel: model,
    importedAt: Date.now(),
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
  return { docId, blockCount: blocks.length, folder };
}

// POST /api/library/import  { source, docKind, title, authors?, year?, tags?, text, images?[] }
async function importLibrary(req, res) {
  try {
    const body = await readBody(req);
    const r = await importDocInternal(body);
    sendJson(res, 200, { ok: true, ...r });
  } catch (e) { sendJson(res, e.message === "文档为空，无法导入" ? 400 : 500, { error: e.message }); }
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

// Save a doc, re-embedding ONLY hash-changed blocks (unchanged blocks reuse their
// stored vectors). Shared by the HTTP handler and distillDocInternal. Throws on failure.
async function saveDocInternal(doc, model) {
  if (!doc || doc.type !== "libdoc" || !doc.docId) throw new Error("无效的文档");

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
  return { reembedded: toEmbed.length };
}

// POST /api/library/save  { doc, model? } → re-embed only hash-changed blocks
async function saveLibraryDoc(req, res) {
  try {
    const body = await readBody(req);
    const r = await saveDocInternal(body.doc, body.model || DEFAULT_MODEL);
    sendJson(res, 200, { ok: true, ...r });
  } catch (e) { sendJson(res, e.message === "无效的文档" ? 400 : 500, { error: e.message }); }
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
      rerank: (typeof body.rerank === "string" && body.rerank.trim()) || "",   // chat model name; "" = off
      language: body.language || "",   // prompt language for the rerank call
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

// POST /api/library/related  { docId } → { related:[{docId,title,docKind,score}] }
// Top-5 most similar OTHER docs by centroid cosine (mean of each doc's block vectors,
// same embedding model only). Computed on demand from the cache — never persisted,
// so it can't go stale as the library grows.
function docCentroids() {
  const cache = getCache();
  if (!cache.centroids) {
    const acc = new Map();   // docId -> { sum, n, model, title, docKind }
    for (const it of cache.items) {
      if (!it.vec) continue;
      let e = acc.get(it.docId);
      if (!e) { e = { sum: new Float64Array(it.vec.length), n: 0, model: it.model, title: it.title, docKind: it.docKind }; acc.set(it.docId, e); }
      if (e.model !== it.model || e.sum.length !== it.vec.length) continue;
      for (let i = 0; i < it.vec.length; i++) e.sum[i] += it.vec[i];
      e.n++;
    }
    const map = new Map();
    for (const [id, e] of acc) {
      if (!e.n) continue;
      const v = new Float32Array(e.sum.length);
      for (let i = 0; i < v.length; i++) v[i] = e.sum[i] / e.n;
      map.set(id, { vec: v, model: e.model, title: e.title, docKind: e.docKind });
    }
    cache.centroids = map;   // rides the cache → invalidated with it on any write
  }
  return cache.centroids;
}
async function relatedLibraryDocs(req, res) {
  try {
    const body = await readBody(req);
    const cents = docCentroids();
    const me = cents.get(body.docId);
    if (!me) { sendJson(res, 200, { related: [] }); return; }
    const related = [...cents.entries()]
      .filter(([id, c]) => id !== body.docId && c.model === me.model)
      .map(([id, c]) => ({ docId: id, title: c.title, docKind: c.docKind, score: cosine(me.vec, c.vec) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
    sendJson(res, 200, { related });
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

// ---- distillation card (import-time summary + claims + tags) ---------------

// One non-streaming LLM call, routed by model name to the same three backends the
// chat proxy uses (local Ollama / Claude / OpenAI). Also reused by retrieval rerank.
// One automatic retry: a cold-loading local model transiently 500s / returns empty
// (seen with MLX backends), and batch imports hit exactly that on their first doc.
async function llmComplete(model, messages, { timeoutMs = 120000, signal = null } = {}) {
  const once = async () => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
    if (claude.isClaudeModel(model)) return claude.complete(model, messages, { signal: sig });
    if (openai.isOpenAIModel(model)) return openai.complete(model, messages, { signal: sig });
    const r = await fetch(`${config.ollamaUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, stream: false, messages, options: { temperature: 0.1, num_ctx: config.llmTaskCtx } }),
      signal: sig,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `chat HTTP ${r.status}`);
    return (data.message && data.message.content) || "";
  };
  try {
    const out = await once();
    if (String(out).trim()) return out;
    throw new Error("empty completion");
  } catch (e) {
    if (e && e.name === "AbortError" && signal && signal.aborted) throw e;   // user cancel → don't retry
    await new Promise(res => setTimeout(res, 2000));
    return once();
  }
}

// Extract the first JSON object from loose LLM output (may be fenced/prefixed).
// LLMs write raw LaTeX inside JSON strings ("$\rightarrow$") without escaping the
// backslashes. Illegal escapes (\lambda's \l) fail JSON.parse and can be repaired by
// doubling — but \r \n \t \b \f are LEGAL escapes, so JSON.parse "succeeds" and
// silently turns $\rightarrow$ into CR+"ightarrow". Fix BEFORE parsing: inside $...$
// math spans (LaTeX territory — a genuine control-char escape there is implausible),
// make every odd backslash run even, so the parsed markdown keeps $\rightarrow$ intact.
function parseJsonLoose(s) {
  const m = String(s).match(/\{[\s\S]*\}/);
  if (!m) return null;
  const fixed = m[0].replace(/\$[^$"\n]{1,300}\$/g,
    (seg) => seg.replace(/\\+/g, (bs) => (bs.length % 2 ? bs + "\\" : bs)));
  try { return JSON.parse(fixed); } catch { /* try repair below */ }
  // Remaining damage outside math spans: double every backslash that doesn't start a
  // legal escape, then retry.
  try { return JSON.parse(fixed.replace(/\\(?!["\\/bfnrtu])/g, "\\\\")); } catch { return null; }
}
// Deterministic pastel color per tag name (same formula as the frontend's tagColor,
// so server-assigned tags render identically).
function tagColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return `hsl(${h}, 55%, 82%)`;
}

// Sample a doc for the distill prompt: section list + one representative chunk per
// section (openings weighted double). A single huge block (YouTube transcript) is
// sampled head/middle/tail instead — its opening alone is usually just greetings.
const DISTILL_BUDGET = 16000;
function distillSample(doc, tocLabel, budget = DISTILL_BUDGET) {
  const body = (doc.blocks || []).filter(b => b.kind === "text" && !isConvBlock(b));
  if (!body.length) return "";
  const sections = [...new Set(body.map(b => b.section).filter(Boolean))];
  const head = sections.length ? tocLabel + sections.join(" / ") + "\n\n" : "";
  const firstOf = new Map();
  for (const b of body) { const k = b.section || ""; if (!firstOf.has(k)) firstOf.set(k, b); }
  const reps = [...firstOf.values()];
  if (reps.length === 1 && reps[0].content.length > budget) {
    const c = reps[0].content, third = Math.floor((budget - head.length) / 3);
    return head + c.slice(0, third) + "\n……\n" + c.slice(Math.floor(c.length / 2), Math.floor(c.length / 2) + third) + "\n……\n" + c.slice(-third);
  }
  const per = Math.max(500, Math.floor((budget - head.length) / reps.length));
  let out = head;
  reps.forEach((b, i) => {
    if (out.length >= budget) return;
    const cap = i < 2 ? per * 2 : per;   // opening sections (abstract/intro) carry the most signal
    out += (b.section ? `【${b.section}】\n` : "") + b.content.slice(0, cap) + "\n\n";
  });
  return out.slice(0, budget);
}

// Distill & rerank prompts follow the user's PROMPT-LANGUAGE setting (en / zh /
// zh-Hant, dom.promptLanguageSelect) — snapshotted into the job payload at enqueue
// and passed down as `language`. Unknown/missing → zh. The card scaffold (section
// name, **Summary**/**Key points** headings) is localized alongside, since it's
// user-visible stored content. `doc` asks for metadata too; `video` never does
// (YouTube metadata is exact — the input is a whisper transcript: spoken,
// error-prone, padded with greetings/ads/sponsor reads).
const DISTILL_I18N = {
  zh: {
    doc: "你是文献蒸馏助手。根据文档抽样内容完成两件事：\n" +
      "1) 抽取元数据：标题、作者、发表年份；\n" +
      "2) 写一张\"蒸馏卡\"：3-5 句话的摘要（说清这篇讲什么、方法或立场、结论），4-8 条关键要点（各一句话，能带具体结论或数字更好），以及 3-6 个简短主题标签。\n" +
      "只输出 JSON，不要任何解释或代码块标记：\n" +
      "{\"title\":\"...\",\"authors\":\"...\",\"year\":\"...\",\"tags\":[\"...\"],\"summary\":\"...\",\"claims\":[\"...\"]}\n" +
      "作者只保留人名、去掉机构编号和上标数字，多个作者用英文逗号分隔；年份只要 4 位数字，没有就空字符串；标签用简短名词短语；摘要和要点用中文写（专有名词保留原文）。",
    video: "你是视频内容蒸馏助手。给你的是一个视频的字幕抽样（自动语音转写的口语文本，可能有识别错误，抽样取自开头/中间/结尾）。请写一张\"蒸馏卡\"：\n" +
      "1) 3-5 句话的摘要：视频讲了什么主题、讲者的核心观点或演示了什么、结论或建议；\n" +
      "2) 4-8 条关键要点：各一句话，保留具体结论、数字、步骤，以及提到的工具/论文/作品名；\n" +
      "3) 3-6 个简短主题标签。\n" +
      "忽略寒暄、求订阅、广告和赞助商口播等与内容无关的部分。\n" +
      "只输出 JSON，不要任何解释或代码块标记：\n" +
      "{\"tags\":[\"...\"],\"summary\":\"...\",\"claims\":[\"...\"]}\n" +
      "摘要和要点用中文写（专有名词保留原文）。",
    cardSection: "蒸馏卡", summaryHead: "**摘要**", claimsHead: "**要点**", toc: "目录：", transcriptHeading: "字幕整理",
    vTitle: "视频标题：", vChannel: "频道：", vSample: "字幕抽样：",
    rerank: "你是检索精排助手。给定一个查询和编号片段列表，按与查询的相关度从高到低输出片段编号。只输出 JSON，不要任何解释或代码块标记：{\"order\":[编号,…]}。明显不相关的编号可以省略。",
    rerankQuery: "查询：", rerankSnippets: "片段：",
  },
  "zh-Hant": {
    doc: "你是文獻蒸餾助手。根據文件抽樣內容完成兩件事：\n" +
      "1) 抽取元數據：標題、作者、發表年份；\n" +
      "2) 寫一張\"蒸餾卡\"：3-5 句話的摘要（說清這篇講什麼、方法或立場、結論），4-8 條關鍵要點（各一句話，能帶具體結論或數字更好），以及 3-6 個簡短主題標籤。\n" +
      "只輸出 JSON，不要任何解釋或代碼塊標記：\n" +
      "{\"title\":\"...\",\"authors\":\"...\",\"year\":\"...\",\"tags\":[\"...\"],\"summary\":\"...\",\"claims\":[\"...\"]}\n" +
      "作者只保留人名、去掉機構編號和上標數字，多個作者用英文逗號分隔；年份只要 4 位數字，沒有就空字符串；標籤用簡短名詞短語；摘要和要點用繁體中文寫（專有名詞保留原文）。",
    video: "你是影片內容蒸餾助手。給你的是一個影片的字幕抽樣（自動語音轉寫的口語文本，可能有識別錯誤，抽樣取自開頭/中間/結尾）。請寫一張\"蒸餾卡\"：\n" +
      "1) 3-5 句話的摘要：影片講了什麼主題、講者的核心觀點或演示了什麼、結論或建議；\n" +
      "2) 4-8 條關鍵要點：各一句話，保留具體結論、數字、步驟，以及提到的工具/論文/作品名；\n" +
      "3) 3-6 個簡短主題標籤。\n" +
      "忽略寒暄、求訂閱、廣告和贊助商口播等與內容無關的部分。\n" +
      "只輸出 JSON，不要任何解釋或代碼塊標記：\n" +
      "{\"tags\":[\"...\"],\"summary\":\"...\",\"claims\":[\"...\"]}\n" +
      "摘要和要點用繁體中文寫（專有名詞保留原文）。",
    cardSection: "蒸餾卡", summaryHead: "**摘要**", claimsHead: "**要點**", toc: "目錄：", transcriptHeading: "字幕整理",
    vTitle: "影片標題：", vChannel: "頻道：", vSample: "字幕抽樣：",
    rerank: "你是檢索精排助手。給定一個查詢和編號片段列表，按與查詢的相關度從高到低輸出片段編號。只輸出 JSON，不要任何解釋或代碼塊標記：{\"order\":[編號,…]}。明顯不相關的編號可以省略。",
    rerankQuery: "查詢：", rerankSnippets: "片段：",
  },
  en: {
    doc: "You are a document-distillation assistant. From the sampled document content, do two things:\n" +
      "1) Extract metadata: title, authors, publication year.\n" +
      "2) Write a distillation card: a 3-5 sentence summary (what it is about, its method or stance, its conclusions), 4-8 key claims (one sentence each, keeping concrete findings and numbers), and 3-6 short topic tags.\n" +
      "Output ONLY JSON, no explanation or code fences:\n" +
      "{\"title\":\"...\",\"authors\":\"...\",\"year\":\"...\",\"tags\":[\"...\"],\"summary\":\"...\",\"claims\":[\"...\"]}\n" +
      "Authors: names only, strip affiliation numbers and superscripts, comma-separated. Year: 4 digits, or empty if unknown. Tags: short noun phrases. Write the summary and claims in English (keep proper nouns as-is).",
    video: "You are a video-content distillation assistant. You are given a sampled transcript of a video (automatic speech-to-text, may contain recognition errors; sampled from the beginning/middle/end). Write a distillation card:\n" +
      "1) A 3-5 sentence summary: the video's topic, the speaker's core points or what was demonstrated, and the conclusions or recommendations.\n" +
      "2) 4-8 key claims: one sentence each, keeping concrete findings, numbers, steps, and any tools/papers/works mentioned.\n" +
      "3) 3-6 short topic tags.\n" +
      "Ignore greetings, subscribe reminders, ads and sponsor reads.\n" +
      "Output ONLY JSON, no explanation or code fences:\n" +
      "{\"tags\":[\"...\"],\"summary\":\"...\",\"claims\":[\"...\"]}\n" +
      "Write in English (keep proper nouns as-is).",
    cardSection: "Distill Card", summaryHead: "**Summary**", claimsHead: "**Key points**", toc: "TOC: ", transcriptHeading: "Transcript",
    vTitle: "Video title: ", vChannel: "Channel: ", vSample: "Transcript sample:",
    rerank: "You are a retrieval reranker. Given a query and a numbered list of snippets, output the snippet indices ordered from most to least relevant to the query. Output ONLY JSON, no explanation or code fences: {\"order\":[index,…]}. Clearly irrelevant indices may be omitted.",
    rerankQuery: "Query: ", rerankSnippets: "Snippets:",
  },
};
const distillL = (language) => DISTILL_I18N[language] || DISTILL_I18N.zh;

// Generate/refresh a doc's distillation card: LLM → JSON → card block at blocks[0]
// (id "card", kind "card") + tags (+ title/authors/year when metadata:true — false for
// YouTube docs, whose exact metadata the LLM must not overwrite). The save path
// re-embeds ONLY the card (all other blocks reuse their vectors by hash). Throws on failure.
async function distillDocInternal(docId, { metadata = false, model, language = "", signal = null } = {}) {
  if (!model) throw new Error("蒸馏需要指定聊天模型");
  const doc = readDoc(docId);
  if (!doc || doc.type !== "libdoc") throw new Error("文档不存在");
  const L = distillL(language);
  const sample = distillSample(doc, L.toc);
  if (!sample.trim()) throw new Error("文档没有可蒸馏的文本");
  // Videos get the transcript-aware prompt; their exact title/channel (from YouTube)
  // is fed IN as context instead of being asked back out of the LLM.
  const isVideo = doc.docKind === "video";
  const user = isVideo
    ? [`${L.vTitle}${doc.title || ""}`, doc.authors ? `${L.vChannel}${doc.authors}` : "", "", L.vSample, sample].filter(s => s !== "").join("\n")
    : sample;
  const out = await llmComplete(model, [
    { role: "system", content: isVideo ? L.video : L.doc },
    { role: "user", content: user },
  ], { signal });
  const j = parseJsonLoose(out);
  if (!j || (!j.summary && !Array.isArray(j.claims))) throw new Error("蒸馏输出无法解析：" + String(out).slice(0, 120));
  if (metadata) {
    if (j.title && String(j.title).trim()) doc.title = String(j.title).trim();
    if (String(j.authors || "").trim()) doc.authors = String(j.authors).trim();
    if (String(j.year || "").trim()) doc.year = String(j.year).trim();
  }
  if (Array.isArray(j.tags) && j.tags.length) {
    doc.tags = j.tags.filter(Boolean).slice(0, 6).map(name => ({ name: String(name).trim(), color: tagColor(String(name)) }));
  }
  const summary = String(j.summary || "").trim();
  const claims = (Array.isArray(j.claims) ? j.claims : []).map(c => String(c).trim()).filter(Boolean).slice(0, 10);
  const content = [
    summary ? `${L.summaryHead} ${summary}` : "",
    claims.length ? `${L.claimsHead}\n` + claims.map(c => `- ${c}`).join("\n") : "",
  ].filter(Boolean).join("\n\n");
  if (!content) throw new Error("蒸馏输出为空");
  // Replace any existing card, always at blocks[0]. Embed with the DOC's own vector
  // model so the .vec stays one coherent space (hash-reuse needs the same model anyway).
  const card = { id: "card", kind: "card", section: L.cardSection, content, hash: "" };
  doc.blocks = [card, ...(doc.blocks || []).filter(b => b.id !== "card" && b.kind !== "card")];
  const r = await saveDocInternal(doc, doc.embedModel || DEFAULT_MODEL);
  return { ok: true, reembedded: r.reembedded };
}

// POST /api/library/distill  { docId, model, language?, metadata? } → regenerate one
// doc's card inline (the panel's "re-extract" button; batch backfill goes through jobs.js).
async function distillLibraryDoc(req, res) {
  try {
    const body = await readBody(req);
    if (!body.docId || !body.model) { sendJson(res, 400, { error: "docId and model required" }); return; }
    const r = await distillDocInternal(body.docId, { metadata: body.metadata !== false, model: body.model, language: body.language || "" });
    sendJson(res, 200, { ok: true, reembedded: r.reembedded });
  } catch (e) { sendJson(res, 500, { error: e.message }); }
}

// ---- YouTube doc assembly (server-side twin of the old frontend youtube branch) ----
// Turns a /api/youtube-job result into the import body: cover figure (thumbnail +
// metadata caption) under "# title", transcript under "# 字幕整理" — the exact block
// structure the chunker expects. Thumbnail is fetched here (best-effort, stored as-is).
function ytLangName(code) {
  if (!code) return "";
  try { return new Intl.DisplayNames(["en"], { type: "language" }).of(code) || code; }
  catch { return code; }
}
async function buildYoutubeDoc(data, url, language = "") {
  const title = data.title || url;
  const rawDate = String(data.uploadDate || "").replace(/-/g, "").slice(0, 8);
  const uploadDate = rawDate.length === 8 ? `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}` : "";
  const authors = data.channel || "";
  const year = rawDate.length >= 4 ? rawDate.slice(0, 4) : "";
  const metaParts = [url,
    data.channel ? `频道：${data.channel}` : "",
    data.duration ? `时长：${data.duration}` : "",
    uploadDate ? `日期：${uploadDate}` : "",
    data.category ? `分类：${data.category}` : "",
    (data.tags && data.tags.length) ? `标签：${data.tags.slice(0, 15).join("、")}` : "",
    data.language ? `语言：${ytLangName(data.language)}` : ""].filter(Boolean);
  // With a thumbnail the metadata must ride the image's single line (the chunker keeps
  // same-line text as the figure caption) → joined with <br>, which splitIntoBlocks
  // converts back to real newlines in the stored caption.
  let infoLine = metaParts.join("\n");
  const images = [];
  if (data.thumbnail) {
    try {
      const r = await fetch(data.thumbnail);
      if (r.ok) {
        const buf = Buffer.from(await r.arrayBuffer());
        const mime = String(r.headers.get("content-type") || "image/jpeg");
        if (buf.length) {
          images.push({ name: "image_01.jpg", base64: buf.toString("base64"), mime: /^image\//.test(mime) ? mime : "image/jpeg" });
          infoLine = `![](image_01.jpg) ${metaParts.join("<br>")}`;
        }
      }
    } catch { /* cover is optional */ }
  }
  // The formatter's "**📝 …**" display header is chat-bubble dressing — strip it here so
  // the stored doc doesn't start with a noise line right under the transcript heading.
  const transcript = String(data.formattedText || data.rawTranscript || "").replace(/^\*\*📝[^\n]*\*\*\s*\n+/, "");
  const text = [`# ${title}`, "", infoLine, "", `# ${distillL(language).transcriptHeading}`, "",
    transcript].join("\n");
  return { source: `url:${url}`, docKind: "video", title, authors, year, text, images };
}

module.exports = {
  importLibrary, listLibrary, searchLibrary, getLibraryDoc,
  saveLibraryDoc, deleteLibraryDocs, retrieveLibrary, reparseLibrary, LIBRARY_DIR,
  listLibraryDirs, moveLibraryDocs,
  splitIntoBlocks,   // exported for reuse/testing of the chunker
  // server-side libimport job (jobs.js) + distill + related-docs
  importDocInternal, distillDocInternal, distillLibraryDoc, buildYoutubeDoc, llmComplete,
  relatedLibraryDocs,
};
