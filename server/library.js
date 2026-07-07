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
const { embedBatch, cosine, hashText, DEFAULT_MODEL, canonicalEmbedModel } = require("./embed");
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
const FALLBACK_BLOCK_CHARS = 3000; // heading-less long docs: window size when "one section = one block"
                                   // degenerates (see splitIntoBlocks) — keeps retrieval granularity sane
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
  // Single choke point for the model recorded in every .vec — store the CANONICAL
  // name so local/cloud builds of the same model share one vector space (no rebuild).
  fs.writeFileSync(path.join(dir, id + ".vec"), encodeVectors(vectors, canonicalEmbedModel(model)));
}
// → { vectors:[Float32Array], model, dim, count }. Non-HKV1 (legacy/absent) → empty.
function readVectors(id, _blockCount, folder) {
  let buf;
  try { buf = fs.readFileSync(vecPath(id, folder)); } catch { return { vectors: [], model: "", dim: 0, count: 0 }; }
  return decodeVectors(buf);
}
// Remove a doc's .vec so the doc reads as "un-embedded" — used when an embed attempt
// totally failed (model down): a later 🔄 rescan / edit re-attempts. Absent → no-op.
function dropVectors(id, folder) {
  try { fs.unlinkSync(vecPath(id, folder)); } catch { /* already gone */ }
}
// Does this doc have real vectors on disk (an HKV1 .vec with rows)? A missing/legacy
// .vec → false → it's a candidate for deferred embedding on the next rescan.
function hasVectors(id, folder) {
  try { return readVectors(id, 0, folder).vectors.length > 0; } catch { return false; }
}
// Embed every embeddable block of `doc` and write its .vec (keyed by `id`, the resolving
// filename — which can differ from doc.docId for a hand-renamed file). Writes NOTHING on
// TOTAL failure (model produced no vector) so the doc stays un-embedded for a later retry.
// Only touches the .vec (vectors align to the existing block order) — never rewrites the
// doc file, so it's safe to call during a rescan sweep. Returns whether a .vec was written.
async function embedDocVectors(doc, id, folder, model) {
  const vectors = new Array(doc.blocks.length).fill(null);
  const toEmbed = [], idx = [];
  doc.blocks.forEach((b, i) => { if (b.embed !== false) { toEmbed.push(blockEmbedText(b)); idx.push(i); } });
  if (toEmbed.length) {
    const embs = await embedMany(toEmbed, model);
    idx.forEach((bi, k) => { vectors[bi] = embs[k]; });
    if (!idx.some((bi) => vectors[bi])) return false;   // model unavailable → no .vec, retry later
  }
  writeVectors(id, vectors, folder, model);
  return true;
}

// ---- index.json (lightweight per-doc metadata for the list view) ----------
function loadIndex() { try { return JSON.parse(fs.readFileSync(indexFile(), "utf-8")); } catch { return []; } }
let _entityIdx = null;   // { byName: Map<normName,{display,docs:Set}>, byDoc: Map<docId,Set<normName>> }
let _entityFacets = null; // { facets:[{type,entities:[{name,count,docIds}]}] } — type-aware, reads docs
function saveIndex(arr) { ensureDir(); fs.writeFileSync(indexFile(), JSON.stringify(arr)); _entityIdx = null; _entityFacets = null; _aliasMap = null; _entityGraph = null; }

// ---- entity alias unification (structure layer) ---------------------------
// Cross-doc entities fragment ("毕导" vs "毕导THU"; "GraphRAG" vs "Graph RAG"). aliases.json
// holds user-confirmed merge groups + rejected pair suggestions; the resolver folds those
// plus the LLM's own per-doc `aliases` into a canonical-key map so the index/facets/lookup
// all collapse the fragments into one entity. Zero-dep, JSON-backed, editable by hand.
let _aliasStore = null, _aliasMap = null;
function aliasFile() { return path.join(LIBRARY_DIR, "aliases.json"); }
function loadAliasStore() {
  if (_aliasStore) return _aliasStore;
  try {
    const j = JSON.parse(fs.readFileSync(aliasFile(), "utf-8"));
    _aliasStore = { version: 1, groups: Array.isArray(j.groups) ? j.groups : [], rejected: Array.isArray(j.rejected) ? j.rejected : [] };
  } catch { _aliasStore = { version: 1, groups: [], rejected: [] }; }
  return _aliasStore;
}
function saveAliasStore(store) {
  ensureDir();
  fs.writeFileSync(aliasFile(), JSON.stringify(store));
  _aliasStore = store; _aliasMap = null; _entityIdx = null; _entityFacets = null; _entityGraph = null;
}
// Stable order-independent key for a pair of normalized names (rejected-suggestion set).
// Tab-joined (never a NUL byte, which corrupts grep/tooling).
function aliasPairKey(a, b) { return a < b ? `${a}\t${b}` : `${b}\t${a}`; }

// Build normKey → {canonicalKey, display}. Union-find over: (1) confirmed groups in
// aliases.json (authoritative, they set the canonical display); (2) each doc entity's own
// `aliases` (LLM-asserted equivalence). `rejected` pairs are never unioned. Canonical display
// for an unforced component = the member seen in the most docs (tie → longer name, so the
// superset "毕导THU" wins over "毕导"). Cached until any index/alias write.
function aliasResolver() {
  if (_aliasMap) return _aliasMap;
  const store = loadAliasStore();
  const rejected = new Set(store.rejected || []);
  const parent = new Map();
  const find = (x) => {
    if (!parent.has(x)) { parent.set(x, x); return x; }
    let r = x; while (parent.get(r) !== r) r = parent.get(r);
    while (parent.get(x) !== r) { const n = parent.get(x); parent.set(x, r); x = n; }
    return r;
  };
  const union = (a, b) => {
    if (!a || !b || a === b) return;
    if (rejected.has(aliasPairKey(a, b))) return;
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  const freq = new Map();       // normKey -> #docs it appears in
  const dispSeen = new Map();   // normKey -> a representative original-cased display
  const forced = new Map();     // rootKey (post-union) -> forced canonical display (confirmed group)
  const groupSeeds = [];        // [{canonical, keys:[normKey...]}] — re-resolve roots after all unions
  for (const g of (store.groups || [])) {
    const displays = [g.canonical, ...(Array.isArray(g.members) ? g.members : [])].filter(Boolean);
    const keys = displays.map(normalizeEntity).filter(Boolean);
    for (let i = 1; i < keys.length; i++) union(keys[0], keys[i]);
    displays.forEach((d) => { const k = normalizeEntity(d); if (k && !dispSeen.has(k)) dispSeen.set(k, d); });
    if (keys.length) groupSeeds.push({ canonical: g.canonical, key: keys[0] });
  }
  for (const e of loadIndex()) {
    const doc = readDoc(e.docId);
    for (const ent of ((doc && doc.entities) || [])) {
      const nm = String((ent && ent.name) || "").trim();
      const k = normalizeEntity(nm);
      if (!k) continue;
      freq.set(k, (freq.get(k) || 0) + 1);
      if (!dispSeen.has(k)) dispSeen.set(k, nm);
      for (const a of (Array.isArray(ent && ent.aliases) ? ent.aliases : [])) {
        const ak = normalizeEntity(a);
        if (!ak) continue;
        if (!dispSeen.has(ak)) dispSeen.set(ak, String(a).trim());
        union(k, ak);
      }
    }
  }
  for (const g of groupSeeds) forced.set(find(g.key), g.canonical);
  const allKeys = new Set([...parent.keys(), ...freq.keys(), ...dispSeen.keys()]);
  const best = new Map();   // root -> {disp, f, len}
  for (const k of allKeys) {
    const r = find(k);
    if (forced.has(r)) continue;
    const f = freq.get(k) || 0, d = dispSeen.get(k) || k;
    const cur = best.get(r);
    if (!cur || f > cur.f || (f === cur.f && d.length > cur.len)) best.set(r, { disp: d, f, len: d.length });
  }
  const map = new Map();
  for (const k of allKeys) {
    const r = find(k);
    const disp = forced.has(r) ? forced.get(r) : ((best.get(r) && best.get(r).disp) || dispSeen.get(r) || r);
    map.set(k, { canonicalKey: r, display: disp });
  }
  _aliasMap = map;
  return _aliasMap;
}
function canonEntity(normKey) { const m = aliasResolver().get(normKey); return m ? m.canonicalKey : normKey; }
function canonDisplay(normKey) { const m = aliasResolver().get(normKey); return m ? m.display : normKey; }
// Entity inverted index (structure layer): built lazily from index.json's `entities`
// projection, cached until any saveIndex() (index is small → rebuild is ms, no incremental
// maintenance). Powers entity-lookup, shared-entity related, and /ask -a's entity path.
function entityIndex() {
  if (_entityIdx) return _entityIdx;
  const byName = new Map(), byDoc = new Map();
  for (const d of loadIndex()) {
    const names = d.entities || [];
    if (!names.length) continue;
    const set = new Set();
    for (const nm of names) {
      const raw = normalizeEntity(nm);
      if (!raw) continue;
      const key = canonEntity(raw);   // fold aliases → canonical
      set.add(key);
      let e = byName.get(key);
      if (!e) { e = { display: canonDisplay(raw), docs: new Set() }; byName.set(key, e); }
      e.docs.add(d.docId);
    }
    if (set.size) byDoc.set(d.docId, set);
  }
  _entityIdx = { byName, byDoc };
  return _entityIdx;
}
// Type-aware facet aggregate for the star map's entity picker: entities grouped by TYPE,
// each with its docIds and a count. Types live only in the full docs (index.json projects
// names only), so this reads each doc once — cached until any saveIndex (panel is opened
// occasionally, so the ~one-time decompress pass is fine). ENTITY_TYPES order is preserved;
// entities within a type are sorted by count desc.
function entityFacets() {
  if (_entityFacets) return _entityFacets;
  const byType = new Map();   // type -> Map<normName,{name,docs:Set}>
  for (const e of loadIndex()) {
    const doc = readDoc(e.docId);
    for (const ent of ((doc && doc.entities) || [])) {
      const name = String((ent && ent.name) || "").trim();
      const raw = normalizeEntity(name);
      if (!raw) continue;
      const key = canonEntity(raw);   // collapse aliases into one canonical row
      const type = ENTITY_TYPES.includes(ent && ent.type) ? ent.type : "concept";
      let m = byType.get(type);
      if (!m) { m = new Map(); byType.set(type, m); }
      let rec = m.get(key);
      if (!rec) { rec = { name: canonDisplay(raw), docs: new Set() }; m.set(key, rec); }
      rec.docs.add(e.docId);
    }
  }
  const facets = [];
  for (const type of ENTITY_TYPES) {
    const m = byType.get(type);
    if (!m || !m.size) continue;
    const entities = [...m.values()]
      .map((r) => ({ name: r.name, count: r.docs.size, docIds: [...r.docs] }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    facets.push({ type, entities });
  }
  _entityFacets = { facets };
  return _entityFacets;
}
function indexEntryOf(doc) {
  return {
    docId: doc.docId, type: doc.type, docKind: doc.docKind, source: doc.source,
    title: doc.title, authors: doc.authors || "", year: doc.year || "",
    // venue surfaced to the list card (which journal/conference); rest of the citation
    // lives in the full doc only.
    venue: (doc.citation && doc.citation.venue) || undefined,
    tags: doc.tags || [], blockCount: (doc.blocks || []).length,
    // importedAt: recorded from now on (older docs simply lack it — never faked);
    // publishedAt ("YYYY-MM-DD"): the CONTENT's own date (YouTube upload date) — the
    // list view sorts by it, falling back to importedAt;
    // hasCard: whether a distillation card (kind:"card") leads the blocks.
    importedAt: doc.importedAt || undefined,
    publishedAt: doc.publishedAt || undefined,
    rating: doc.rating || undefined,           // manual 1-5 ★ (absent = unrated)
    hasCard: (doc.blocks || []).some(b => b.kind === "card") || undefined,
    // Entity NAMES only (cap 15, ~300B/doc) — the structure layer's index projection.
    // Powers the entity inverted index, shared-entity related, star-map edges, /ask -a.
    // Types/aliases/relations stay in the full doc (readDoc when detail is needed).
    entities: (doc.entities && doc.entities.length)
      ? doc.entities.slice(0, 15).map(e => e.name) : undefined,
  };
}
function upsertIndex(doc) {
  const arr = loadIndex().filter(d => d.docId !== doc.docId);
  arr.push(indexEntryOf(doc));
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
function splitLong(s, max = MAX_BLOCK_CHARS) {
  if (s.length <= max) return [s];
  const out = [];
  let buf = "";
  for (const part of s.split(/(?<=[。.!?！？\n])/)) {
    if (buf.length + part.length > max && buf) { out.push(buf.trim()); buf = ""; }
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

// A paper's references/bibliography section is a dense list of cited TITLES — a strong
// (false) cosine match for many queries while carrying no substance of its own, so it
// crowds retrieval top-k. Such sections stay in the doc for display but are excluded
// from retrieval (embed:false → zero-vector slot, skipped by the cache). Optional
// leading numbering ("7. References", "VII References") is tolerated; anchored to the
// full heading so e.g. "Reference Architecture" is NOT excluded.
const NO_EMBED_SECTION = /^(?:[0-9ivxlc]+[.):：]?\s*)?(references?|bibliography|literature cited|works cited|参考文献|參考文獻)$/i;

// A figure caption on its OWN line right below the image (MinerU's usual layout for
// papers): "Figure 1: …" / "Fig. 2." / "Table 3 …" / "图 1：…" / "表2…", optionally bold.
const FIG_CAPTION_RE = /^[*_]{0,2}(?:figure|fig\.?|table|图|表|圖)[\s*_]*\.?\s*\d/i;
// A table's caption ("Table 3: …" only — a "Figure N" line must never claim a table).
const TABLE_CAPTION_RE = /^[*_]{0,2}(?:table|表)[\s*_]*\.?\s*\d/i;

function splitIntoBlocks(text, images) {
  const imgByName = new Map((images || []).map(im => [im.name, im]));
  const lines = (text || "").split(/\r?\n/);
  // Degenerate-structure fallback: "one section = one block" relies on headings, but
  // MinerU misses them on some layouts (scanned/odd two-column papers), and plain .txt
  // has none — the whole doc would become 32k-char blocks (one retrieval hit = 32k chars
  // of context). <2 headings on a long doc → cut prose into ~3k sentence-boundary
  // windows instead; sections just stay empty.
  const headingCount = lines.reduce((n, l) => n + (/^#{1,6}\s+\S/.test(l) ? 1 : 0), 0);
  const maxBlock = (headingCount < 2 && (text || "").length > 12000) ? FALLBACK_BLOCK_CHARS : MAX_BLOCK_CHARS;
  const blocks = [];
  let section = "", para = [], bid = 0, sectionFigs = [];

  // Figures/tables found inside a section are deferred and flushed right AFTER its
  // text, so an interspersed figure/table never breaks the section's prose into
  // separate chunks.
  const flushFigs = () => {
    for (const fig of sectionFigs) { fig.id = `b${bid++}`; blocks.push(fig); }
    sectionFigs = [];
  };
  // One section = one text block: all paragraphs/lists accumulate (across any figures
  // or tables), and only a genuinely huge section gets split (splitLong) to avoid embed
  // truncation. Then the section's figures/tables follow as their own blocks.
  const emit = () => {
    const content = para.join("\n").trim();
    para = [];
    if (content && !isNoiseBlock(content)) {
      const noEmbed = NO_EMBED_SECTION.test((section || "").trim());
      for (const piece of splitLong(content, maxBlock)) {
        const b = { id: `b${bid++}`, kind: "text", section, content: piece, hash: hashText(piece) };
        if (noEmbed) b.embed = false;
        blocks.push(b);
      }
    }
    flushFigs();
  };

  let pendingFig = null;   // figure/table whose caption may follow on the next non-empty line
  let tableBuf = null;     // in-progress table region: { html:bool, lines:[] }
  // Close the current table region into its own block (kind "table", deferred like a
  // figure). A caption directly ABOVE ("Table 3: …" as the last prose line) is pulled
  // out of the prose into the block; otherwise the next line may still claim it (the
  // pendingFig mechanism, gated on TABLE_CAPTION_RE). A markdown pipe run that lacks a
  // separator row isn't a table at all — its lines go back to the prose.
  const finishTable = () => {
    if (!tableBuf) return;
    const buf = tableBuf; tableBuf = null;
    if (!buf.html && !(buf.lines.length >= 2 && /^\s*\|?[\s:|-]*-[\s:|-]*$/.test(buf.lines[1]))) {
      para.push(...buf.lines);
      return;
    }
    const markup = buf.lines.join("\n").trim();
    if (!markup) return;
    let caption = "";
    for (let i = para.length - 1; i >= 0; i--) {
      const pt = para[i].trim();
      if (!pt) continue;                      // skip blank lines between caption and table
      if (TABLE_CAPTION_RE.test(pt)) { caption = pt; para.splice(i); }
      break;
    }
    const tb = { kind: "table", section, content: (caption ? caption + "\n" : "") + markup, hash: "" };
    tb.hash = hashText(tb.content);
    sectionFigs.push(tb);
    pendingFig = caption ? null : tb;
  };

  for (const raw of lines) {
    const line = stripNoiseTags(raw);
    const t0 = line.trim();
    // ---- table regions (MinerU emits HTML <table>…</table>; pandoc/markdown emit
    // pipe rows) — collected verbatim, then finishTable() turns them into a block.
    if (tableBuf && tableBuf.html) {
      tableBuf.lines.push(line);
      if (/<\/table>/i.test(line)) finishTable();
      continue;
    }
    if (/^<table\b/i.test(t0)) {
      pendingFig = null;
      tableBuf = { html: true, lines: [line] };
      if (/<\/table>/i.test(line)) finishTable();   // whole table on one line (MinerU's usual shape)
      continue;
    }
    if (/^\|.*\|/.test(t0)) {
      if (!tableBuf) { pendingFig = null; tableBuf = { html: false, lines: [] }; }
      tableBuf.lines.push(t0);
      continue;
    }
    if (tableBuf) finishTable();   // pipe run ended → close it before anything else sees this line

    const h = line.match(/^(#{1,6})\s+(.*)/);
    if (h) {
      const name = h[2].trim();
      if (name === section) continue;        // duplicate heading (MinerU repeats it across columns/pages) → stay in one block
      pendingFig = null;
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
      pendingFig = caption ? null : fig;     // same-line caption wins; else watch the next line
      continue;
    }
    // MinerU puts a paper figure's caption on its own line BELOW the image (and a
    // table's sometimes below the table); fold it into that block (its embed text)
    // instead of the prose, so the figure/table becomes retrievable by its caption.
    // Only the first non-empty following line is considered, and only if it looks
    // like a caption of the right kind.
    const t = line.trim();
    if (pendingFig && t) {
      const fig = pendingFig;
      pendingFig = null;
      if (fig.kind === "table" ? TABLE_CAPTION_RE.test(t) : FIG_CAPTION_RE.test(t)) {
        if (fig.kind === "table") fig.content = t + "\n" + fig.content;
        else fig.content = t;
        fig.hash = hashText((fig.imageName || "") + fig.content);
        continue;
      }
    }
    para.push(t === "" ? "" : line);   // accumulate everything else into the section block
  }
  finishTable();
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
// Tables embed as caption + flattened cell text — raw <table> markup / pipe punctuation
// is tag soup to the embedding model and would drown out the actual numbers.
const blockEmbedText = (b) => {
  if (b.kind === "figure") return b.content || "image";
  if (b.kind === "table") {
    const flat = (b.content || "").replace(/<[^>]+>/g, " ").replace(/\|/g, " ").replace(/\s+/g, " ").trim();
    return flat.slice(0, MAX_BLOCK_CHARS) || " ";
  }
  return b.content || " ";
};

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
        content: b.content, hasImage: !!b.image, vec: vecs[i], model: canonicalEmbedModel(vr.model),
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

async function retrieve(query, model, { docId = null, docIds = null, folder = null, folders = null, topK = 8, rerank = "", language = "" } = {}) {
  // docIds (array) scopes to several docs; docId (string) scopes to one;
  // folder (string) / folders (array) scope to sub-folder(s) and everything
  // nested under them; none of them → whole library.
  const set = (docIds && docIds.length) ? new Set(docIds) : null;
  const flist = (folders && folders.length) ? folders : (folder != null ? [folder] : null);
  const inFolder = (it) => flist == null ? true : flist.some(f => it.folder === f || it.folder.startsWith(f + "/"));
  // Only compare against vectors built with the SAME embedding model — a different
  // model is a different vector space (and possibly a different dim), so cosine there
  // is meaningless. The .vec header records the model; we match it to the query's.
  const canon = canonicalEmbedModel(model);
  const pool = getCache().items.filter(it => it.vec && it.model === canon && inFolder(it) && (set ? set.has(it.docId) : (!docId || it.docId === docId)));
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
  // embed:false blocks (a references section) keep a zero-vector slot — never embedded.
  const vectors = new Array(blocks.length).fill(null);
  const toEmbed = [], toEmbedIdx = [];
  blocks.forEach((b, i) => { if (b.embed !== false) { toEmbed.push(blockEmbedText(b)); toEmbedIdx.push(i); } });
  if (toEmbed.length) {
    const embs = await embedMany(toEmbed, model);
    toEmbedIdx.forEach((bi, k) => { vectors[bi] = embs[k]; });
  }
  let docId = deriveDocId(body.source || `file:${body.title || "doc"}`);
  // File imports (dedupe:true): the docId comes from the file's BASENAME, and generic
  // names (main.pdf, paper.pdf) collide across genuinely different documents. Same body
  // text → same docId (an idempotent re-import still overwrites); different text →
  // suffix _2/_3/… so a same-named but unrelated file can never silently destroy an
  // existing doc. Cards/conversation bubbles are ignored in the comparison — they are
  // added after import, not part of the incoming text.
  let dedupedFrom = "";
  if (body.dedupe) {
    const bodyText = (bs) => bs.filter(b => b.kind !== "card" && !isConvBlock(b)).map(b => b.content).join("\n");
    const mine = bodyText(blocks), base = docId;
    for (let n = 2; n <= 50; n++) {          // 50 = runaway guard; beyond it, overwrite
      const existing = readDoc(docId);
      if (!existing || !existing.blocks || bodyText(existing.blocks) === mine) break;
      docId = `${base}_${n}`;
    }
    if (docId !== base) dedupedFrom = base;
  }
  const doc = {
    type: "libdoc", schemaVersion: 1,
    docKind: body.docKind || "doc",
    docId, source: body.source || "",
    title: body.title || docId,
    authors: body.authors || "", year: body.year || "",
    publishedAt: body.publishedAt || "",
    doi: body.doi || "",
    // citation = {venue,volume,issue,pages,type,url}; keywords = author keyword strings.
    // Only stored when non-empty so non-paper docs don't carry empty scaffolding.
    citation: (body.citation && Object.values(body.citation).some(Boolean)) ? body.citation : undefined,
    keywords: (Array.isArray(body.keywords) && body.keywords.length) ? body.keywords : undefined,
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
  // Embedding is DEFERRABLE. If the model was unavailable (every embeddable block came
  // back null) DON'T write a .vec — the doc imports fine but reads as "un-embedded", and
  // a later 🔄 rescan (or any edit) re-attempts. A zero .vec would look embedded yet be
  // dead weight (cosine 0) and would poison the star-map centroid with a zero row.
  const embedFailed = toEmbed.length > 0 && !toEmbedIdx.some((bi) => vectors[bi]);
  if (embedFailed) dropVectors(docId, folder);
  else writeVectors(docId, vectors, folder, model);
  upsertIndex(doc);
  invalidateCache();
  return { docId, blockCount: blocks.length, folder, dedupedFrom, embedded: !embedFailed };
}

// POST /api/library/import  { source, docKind, title, authors?, year?, tags?, text, images?[] }
async function importLibrary(req, res) {
  try {
    const body = await readBody(req);
    const r = await importDocInternal(body);
    sendJson(res, 200, { ok: true, ...r });
  } catch (e) { sendJson(res, e.message === "文档为空，无法导入" ? 400 : 500, { error: e.message }); }
}

// One-time (per process) backfill: video docs imported before publishedAt existed
// carry the upload date only as prose in their meta block ("日期：YYYY-MM-DD" on the
// same line as the video URL). Lift it into the structured field so the list view can
// sort them. Docs whose meta block lacks a date are simply skipped (rescanned only on
// the next server restart — cheap: the scan reads just unresolved video docs, once).
let PUB_BACKFILL_DONE = false;
function backfillPublishedAt() {
  if (PUB_BACKFILL_DONE) return;
  PUB_BACKFILL_DONE = true;
  const arr = loadIndex();
  let changed = false;
  for (const e of arr) {
    if (e.docKind !== "video" || e.publishedAt) continue;
    const doc = readDoc(e.docId);
    if (!doc || doc.publishedAt) continue;
    // Only trust the meta block (it carries the video URL) — a bare 日期： in the
    // transcript body must not become the doc's date.
    const metaBlock = (doc.blocks || []).slice(0, 4).find(b =>
      /youtu\.?be/.test(b.content || "") && /日期[：:]\s*\d{4}-\d{2}-\d{2}/.test(b.content || ""));
    if (!metaBlock) continue;
    doc.publishedAt = metaBlock.content.match(/日期[：:]\s*(\d{4}-\d{2}-\d{2})/)[1];
    // Update the entry IN PLACE (not upsertIndex, which pushes to the end): a
    // backfill must not reshuffle the list's default import order.
    try { writeDoc(doc); e.publishedAt = doc.publishedAt; changed = true; }
    catch { /* read-only fs etc. — retry next restart */ }
  }
  if (changed) saveIndex(arr);
}

// POST /api/library/list  → { docs:[index entries] }
async function listLibrary(_req, res) {
  try {
    backfillPublishedAt();
    sendJson(res, 200, { docs: loadIndex().map(d => ({ ...d, folder: locOf(d.docId) })) });
  } catch (e) { sendJson(res, 500, { error: e.message }); }
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

// POST /api/library/rescan → reconcile index.json with what's ACTUALLY on disk, so
// manual file operations under LIBRARY_DIR (dropping in a doc's .json.zst, moving it
// between sub-folders in Finder, deleting it) all take effect:
//   - added files  → read each doc, append a fresh index entry (type "libdoc" only)
//   - deleted files → drop their ghost index entries
//   - moved files  → handled by the fresh LOC scan (index has no folder; locOf resolves it)
// Every doc on disk is re-read so entries also pick up manual edits to a doc file.
// Probe ONCE whether the embedding model can actually run (installed locally / cloud
// reachable). rescan uses it to decide whether to (re)embed at all — if the model is
// down or unspecified, we skip the vector work and only sync the file list.
async function probeEmbedModel(model) {
  if (!model) return false;
  try { const [v] = await embedBatch([" "], model); return Array.isArray(v) && v.length > 0; }
  catch { return false; }
}

// Reconcile the library with manual file operations (docs dropped in / moved / deleted
// under LIBRARY_DIR) AND bring every doc's vectors up to the current embedding model.
// Streams ndjson progress (start → progress per doc → done). Slow on a big library
// (full read of every doc), hence the live progress. For each doc it (re)embeds when:
//   • no .vec yet (import-time failure or a hand-dropped .json), or
//   • the .vec was built with a DIFFERENT embedding model than the current one.
// If the current model is unavailable/unspecified, embedding is SKIPPED entirely
// (existing .vec files are left untouched) and only the file list is synced.
async function rescanLibrary(req, res) {
  let body = {}; try { body = await readBody(req); } catch { /* no body → defaults */ }
  const model = body.model || DEFAULT_MODEL;
  const canon = canonicalEmbedModel(model);

  res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" });
  const send = (o) => { try { res.write(JSON.stringify(o) + "\n"); } catch {} };

  try {
    invalidateLoc();
    const loc = [...buildLoc().entries()];         // fresh disk truth: [id, folder][]
    const oldOrder = new Map(loadIndex().map((d, i) => [d.docId, i]));
    send({ status: "start", total: loc.length });

    // Gate all (re)embedding on a single availability probe.
    const embedAvailable = await probeEmbedModel(model);
    if (!embedAvailable) send({ status: "model-unavailable", model });

    const entries = [];
    let embedded = 0, reembedded = 0, embedFailed = 0, skipped = 0, done = 0;
    for (const [id, folder] of loc) {
      const doc = readDoc(id, folder);
      if (!doc || doc.type !== "libdoc") { done++; send({ status: "progress", done, total: loc.length }); continue; }

      // Does this doc need (re)embedding? "missing" = no .vec; "model" = built with a
      // different embedding model (canonical compare, so a local↔cloud swap of the same
      // model does NOT count as a change).
      let need = null;
      if (!hasVectors(id, folder)) need = "missing";
      else if (canonicalEmbedModel(readVectors(id, 0, folder).model) !== canon) need = "model";

      if (need) {
        if (embedAvailable) {
          let ok = false;
          try { ok = await embedDocVectors(doc, id, folder, model); } catch { ok = false; }
          if (ok) { if (need === "missing") embedded++; else reembedded++; }
          else embedFailed++;
        } else {
          skipped++;   // model down → leave the existing .vec (or its absence) as-is
        }
      }

      // Key the entry by the FILENAME-derived id, not doc.docId: every path resolution
      // (locOf/docPath/get/delete) goes by filename, so a manually copied/renamed file
      // whose internal docId disagrees must still list under the name that resolves.
      entries.push({ ...indexEntryOf(doc), docId: id });
      done++;
      send({ status: "progress", done, total: loc.length, embedded, reembedded });
    }

    // Keep the list stable: previously-indexed docs in their old order, new ones appended.
    entries.sort((a, b) => (oldOrder.get(a.docId) ?? Infinity) - (oldOrder.get(b.docId) ?? Infinity));
    const added = entries.filter(e => !oldOrder.has(e.docId)).length;
    const removed = [...oldOrder.keys()].filter(id => !entries.some(e => e.docId === id)).length;
    saveIndex(entries);
    invalidateCache();
    send({ status: "done", total: entries.length, added, removed, embedded, reembedded, embedFailed, skipped, modelUnavailable: !embedAvailable });
    res.end();
  } catch (e) { send({ status: "error", message: e.message }); res.end(); }
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

  // Structure layer is REBUILT from the card text on every save — the card is
  // authoritative, so a user hand-editing the **实体**/**关系** sections (or the distill
  // render) is the single source of truth. A card with no such sections clears the layer.
  const cardBlock = (doc.blocks || []).find((b) => b.kind === "card");
  if (cardBlock) {
    const s = cleanStructure(parseStructureSections(cardBlock.content));
    if (s.entities.length) doc.entities = s.entities; else delete doc.entities;
    if (s.relations.length) doc.relations = s.relations; else delete doc.relations;
  }

  const old = readDoc(doc.docId);
  const oldMap = new Map();
  if (old && old.blocks) {
    let ov = { vectors: null, model: "" };
    try { ov = readVectors(doc.docId, old.blocks.length); } catch {}
    // reuse an old vector only if it was built with the SAME model (canonical, so a
    // local↔cloud switch of the same model still reuses instead of re-embedding all)
    if (canonicalEmbedModel(ov.model) === canonicalEmbedModel(model) && ov.vectors && ov.vectors.length) {
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
  // Same deferral rule as import: only skip the .vec when NO embeddable block has a vector
  // (model down AND nothing reusable). Partial success — some blocks reused, some freshly
  // embedded — still writes; a lone null slot just scores 0. Dropping a stale .vec on total
  // failure leaves the doc un-embedded so a rescan/next save retries.
  const embeddable = doc.blocks.some((b) => b.embed !== false);
  const haveAny = doc.blocks.some((b, i) => b.embed !== false && newVecs[i]);
  if (embeddable && !haveAny) dropVectors(doc.docId);
  else writeVectors(doc.docId, newVecs, null, model);
  upsertIndex(doc);
  invalidateCache();
  return { reembedded: toEmbed.length, embedded: !(embeddable && !haveAny) };
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
      folders: Array.isArray(body.folders)
        ? body.folders.filter(f => typeof f === "string" && f.trim()).map(sanitizeFolder).filter(Boolean)
        : null,
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
      map.set(id, { vec: v, model: e.model, title: e.title, docKind: e.docKind, blocks: e.n });
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
    // Centroid path: top-5 by cosine (embedding "feels close").
    const related = me ? [...cents.entries()]
      .filter(([id, c]) => id !== body.docId && c.model === me.model)
      .map(([id, c]) => ({ docId: id, title: c.title, docKind: c.docKind, score: cosine(me.vec, c.vec) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 5) : [];
    // Shared-entity path: docs sharing >=2 entities (explainable "why related").
    const { byName, byDoc } = entityIndex();
    const mine = byDoc.get(body.docId);
    const shared = [];
    if (mine && mine.size) {
      const metaById = new Map(loadIndex().map((d) => [d.docId, d]));
      const counts = new Map();
      for (const key of mine) {
        const e = byName.get(key);
        if (!e) continue;
        for (const other of e.docs) if (other !== body.docId) counts.set(other, (counts.get(other) || 0) + 1);
      }
      for (const [docId, n] of counts) {
        if (n < 2) continue;
        const m = metaById.get(docId) || {};
        const names = [];
        const otherSet = byDoc.get(docId) || new Set();
        for (const key of mine) if (otherSet.has(key)) { const e = byName.get(key); names.push(e ? e.display : key); }
        shared.push({ docId, title: m.title || docId, docKind: m.docKind || "doc", sharedEntities: names.slice(0, 6), sharedCount: n });
      }
      shared.sort((a, b) => b.sharedCount - a.sharedCount);
    }
    // Merge: annotate centroid hits that also share entities, then append shared-only. Cap 8.
    const merged = new Map();
    for (const r of related) merged.set(r.docId, r);
    for (const s of shared) {
      const ex = merged.get(s.docId);
      if (ex) { ex.sharedEntities = s.sharedEntities; ex.sharedCount = s.sharedCount; }
      else merged.set(s.docId, s);
    }
    sendJson(res, 200, { related: [...merged.values()].slice(0, 8) });
  } catch (e) { sendJson(res, 500, { error: e.message }); }
}

// POST /api/library/entity-lookup { names:[...], folders? } →
//   { docs:[{docId,title,docKind,folder,matched:[displayName]}] }
// Exact inverted-index lookup (normalized): the precise counterpart to embedding search
// for "which docs mention X" — used by /ask -a's entity path and future entity chips.
async function entityLookupLibrary(req, res) {
  try {
    const body = await readBody(req);
    const names = (Array.isArray(body.names) ? body.names : []).map((n) => canonEntity(normalizeEntity(n))).filter(Boolean);
    if (!names.length) { sendJson(res, 200, { docs: [] }); return; }
    const { byName } = entityIndex();
    const metaById = new Map(loadIndex().map((d) => [d.docId, d]));
    const folders = Array.isArray(body.folders) && body.folders.length ? body.folders : null;
    const hits = new Map();   // docId -> Set(matched display names)
    for (const key of names) {
      const e = byName.get(key);
      if (!e) continue;
      for (const docId of e.docs) {
        let s = hits.get(docId);
        if (!s) { s = new Set(); hits.set(docId, s); }
        s.add(e.display);
      }
    }
    let docs = [...hits.entries()].map(([docId, matched]) => {
      const m = metaById.get(docId) || {};
      return { docId, title: m.title || docId, docKind: m.docKind || "doc", folder: locOf(docId), matched: [...matched] };
    });
    if (folders) docs = docs.filter((d) => folders.includes(d.folder));
    docs.sort((a, b) => b.matched.length - a.matched.length);
    sendJson(res, 200, { docs });
  } catch (e) { sendJson(res, 500, { error: e.message }); }
}

// GET/POST /api/library/entity-facets → { facets:[{type, entities:[{name,count,docIds}]}] }
// Powers the star map's multi-select entity picker (group by type → click to highlight the
// docs containing the selected entities).
function entityFacetsLibrary(req, res) {
  try { sendJson(res, 200, entityFacets()); }
  catch (e) { sendJson(res, 500, { error: e.message }); }
}

// Bounded Levenshtein (early-exit once a row's min exceeds `max`): only used to spot near-typo
// duplicates, so we never need the exact distance beyond the cutoff.
function editDistWithin(a, b, max) {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > max) return max + 1;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i]; let rowMin = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[n];
}
// Are two normalized entity keys likely the same entity? Conservative to avoid false merges:
//  (1) one is a prefix/suffix of the other, both length >= 2, gap <= 4 chars ("毕导" ⊂ "毕导thu");
//  (2) edit distance <= 1 for keys of length >= 5 (typo / one-space variants like "graph rag").
function aliasSimilar(a, b) {
  if (a === b) return null;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length >= 2 && long.length - short.length <= 4 && (long.startsWith(short) || long.endsWith(short))) return "substr";
  if (short.length >= 5 && editDistWithin(a, b, 1) <= 1) return "typo";
  return null;
}
// Candidate merges the user hasn't confirmed or rejected yet: pairs within the same TYPE that
// look alike (aliasSimilar) but resolve to different canonical entities. Capped; each carries
// the doc counts so the UI can present the bigger one as the default canonical.
function aliasSuggestions(limit = 80) {
  const store = loadAliasStore();
  const rejected = new Set(store.rejected || []);
  const out = [];
  for (const f of entityFacets().facets) {
    const ents = f.entities;   // already canonicalized, sorted by count desc
    for (let i = 0; i < ents.length && out.length < limit; i++) {
      for (let j = i + 1; j < ents.length && out.length < limit; j++) {
        const ka = normalizeEntity(ents[i].name), kb = normalizeEntity(ents[j].name);
        const ca = canonEntity(ka), cb = canonEntity(kb);
        if (ca === cb) continue;                                  // already merged
        if (rejected.has(aliasPairKey(ca, cb))) continue;         // user dismissed this pair
        const why = aliasSimilar(ka, kb);
        if (!why) continue;
        const [big, small] = ents[i].count >= ents[j].count ? [ents[i], ents[j]] : [ents[j], ents[i]];
        out.push({ type: f.type, reason: why, canonical: big.name, other: small.name, canonicalCount: big.count, otherCount: small.count });
      }
    }
  }
  return out;
}
// GET /api/library/aliases → { groups:[{canonical,members,count}], suggestions:[...] }
// The confirmed merge groups (with live doc counts) plus fresh fuzzy candidates for the picker.
function aliasesLibrary(req, res) {
  try {
    const store = loadAliasStore();
    const { byName } = entityIndex();
    const groups = (store.groups || []).map((g) => {
      const key = canonEntity(normalizeEntity(g.canonical));
      const e = byName.get(key);
      return { canonical: g.canonical, members: Array.isArray(g.members) ? g.members : [], count: e ? e.docs.size : 0 };
    });
    sendJson(res, 200, { groups, suggestions: aliasSuggestions() });
  } catch (e) { sendJson(res, 500, { error: e.message }); }
}
// POST /api/library/alias-edit { action, ... } → mutate aliases.json, invalidate caches.
//   merge:   { names:[display...], canonical? }  union all names into one group (extends an
//            existing group if any name already belongs to one); canonical defaults to names[0].
//   unmerge: { canonical }                       delete the group (fragments split apart again).
//   reject:  { a, b }                            never suggest merging this pair again.
async function aliasEditLibrary(req, res) {
  try {
    const body = await readBody(req);
    const store = loadAliasStore();
    store.groups = Array.isArray(store.groups) ? store.groups : [];
    store.rejected = Array.isArray(store.rejected) ? store.rejected : [];
    const action = body.action;
    if (action === "merge") {
      const names = [...new Set((Array.isArray(body.names) ? body.names : []).map((s) => String(s || "").trim()).filter(Boolean))];
      if (names.length < 2) { sendJson(res, 400, { error: "need >=2 names" }); return; }
      const keys = new Set(names.map(normalizeEntity));
      // absorb any existing group that overlaps these names, then rebuild one merged group
      const kept = [], absorbed = [];
      for (const g of store.groups) {
        const gk = [g.canonical, ...(g.members || [])].map(normalizeEntity);
        (gk.some((k) => keys.has(k)) ? absorbed : kept).push(g);
      }
      const all = new Map();   // normKey -> display (first seen wins)
      for (const g of absorbed) for (const d of [g.canonical, ...(g.members || [])]) { const k = normalizeEntity(d); if (k && !all.has(k)) all.set(k, d); }
      for (const d of names) { const k = normalizeEntity(d); if (k && !all.has(k)) all.set(k, d); }
      const canonical = String(body.canonical || names[0]).trim();
      const members = [...all.values()].filter((d) => normalizeEntity(d) !== normalizeEntity(canonical));
      kept.push({ canonical, members });
      store.groups = kept;
    } else if (action === "unmerge") {
      const ck = normalizeEntity(body.canonical);
      store.groups = store.groups.filter((g) => normalizeEntity(g.canonical) !== ck);
    } else if (action === "reject") {
      const a = canonEntity(normalizeEntity(body.a)), b = canonEntity(normalizeEntity(body.b));
      if (a && b && a !== b) { const k = aliasPairKey(a, b); if (!store.rejected.includes(k)) store.rejected.push(k); }
    } else { sendJson(res, 400, { error: "unknown action" }); return; }
    saveAliasStore(store);
    sendJson(res, 200, { ok: true, groups: store.groups.length });
  } catch (e) { sendJson(res, 500, { error: e.message }); }
}

// ---- cross-doc entity graph (structure layer) -----------------------------
// The whole library's entities/relations folded into ONE network: alias-canonicalized nodes
// (with type + doc set) and aggregated directed edges (a head→tail pair carries a label→count
// map + the docs it came from). Reads every doc once; cached until any index/alias write.
let _entityGraph = null;
function entityGraph() {
  if (_entityGraph) return _entityGraph;
  const nodes = new Map();   // canonKey -> { name, type, docs:Set }
  const edges = new Map();   // `${headKey}\t${tailKey}` -> { head, tail, labels:Map<label,count>, docs:Set }
  const byDoc = new Map();   // docId -> Set(entityKey) — powers the co-occurrence neighborhood
  const touch = (rawName, type, docId) => {
    const raw = normalizeEntity(rawName);
    if (!raw) return null;
    const key = canonEntity(raw);
    let n = nodes.get(key);
    if (!n) { n = { name: canonDisplay(raw), type: type || "concept", docs: new Set() }; nodes.set(key, n); }
    else if (type && type !== "concept" && n.type === "concept") n.type = type;   // upgrade from backfill default
    if (docId) { n.docs.add(docId); let s = byDoc.get(docId); if (!s) { s = new Set(); byDoc.set(docId, s); } s.add(key); }
    return key;
  };
  for (const e of loadIndex()) {
    const doc = readDoc(e.docId);
    if (!doc) continue;
    const typeByKey = new Map();
    for (const ent of (doc.entities || [])) {
      const raw = normalizeEntity(ent && ent.name);
      if (raw) typeByKey.set(canonEntity(raw), ENTITY_TYPES.includes(ent && ent.type) ? ent.type : "concept");
    }
    for (const ent of (doc.entities || [])) touch(ent && ent.name, typeByKey.get(canonEntity(normalizeEntity(ent && ent.name))), e.docId);
    for (const r of (doc.relations || [])) {
      if (!Array.isArray(r) || r.length < 3) continue;
      const hk = touch(r[0], typeByKey.get(canonEntity(normalizeEntity(r[0]))), e.docId);
      const tk = touch(r[2], typeByKey.get(canonEntity(normalizeEntity(r[2]))), e.docId);
      if (!hk || !tk || hk === tk) continue;
      const label = String(r[1] || "").trim();
      const ekey = `${hk}\t${tk}`;
      let ed = edges.get(ekey);
      if (!ed) { ed = { head: hk, tail: tk, labels: new Map(), docs: new Set(), times: new Map() }; edges.set(ekey, ed); }
      ed.labels.set(label, (ed.labels.get(label) || 0) + 1);
      ed.docs.add(e.docId);
      const q = r[3];
      const time = (q && typeof q === "object" && !Array.isArray(q)) ? String(q.time || "").trim() : "";
      if (time) ed.times.set(time, (ed.times.get(time) || 0) + 1);   // time qualifier for the timeline layer
    }
  }
  _entityGraph = { nodes, edges, byDoc };
  return _entityGraph;
}
// POST /api/library/entity-neighborhood { name, hops? } →
//   { center, nodes:[{key,name,type,count}], edges:[{head,tail,label,count}], docs:[{docId,title,docKind}] }
// BFS `hops` (1-2) out from the entity, capped for readability. `head`/`tail` on edges are the
// nodes' DISPLAY names (so the client graph reuses the per-doc renderer directly).
function entityNeighborhoodLibrary(req, res) {
  readBody(req).then((body) => {
    const { nodes, edges, byDoc } = entityGraph();
    // Accept one `name` or several `names` (multi-select) — seed the traversal from all of them.
    const rawNames = Array.isArray(body.names) && body.names.length ? body.names : [body.name];
    const seeds = [...new Set(rawNames.map((n) => canonEntity(normalizeEntity(n))).filter((k) => k && nodes.has(k)))];
    if (!seeds.length) { sendJson(res, 200, { center: null, centers: [], nodes: [], edges: [], docs: [] }); return; }
    const hops = Math.min(2, Math.max(1, parseInt(body.hops, 10) || 1));
    const NODE_CAP = 36;   // a ring stays readable up to a few dozen; keep the STRONGEST links
    // relation adjacency (undirected for traversal)
    const adj = new Map();
    for (const ed of edges.values()) {
      if (!adj.has(ed.head)) adj.set(ed.head, new Set());
      if (!adj.has(ed.tail)) adj.set(ed.tail, new Set());
      adj.get(ed.head).add(ed.tail); adj.get(ed.tail).add(ed.head);
    }
    const keep = new Set(seeds);
    // Hop 1: add the seeds' relation neighbors STRONGEST-FIRST (edge weight = total docs on the
    // connecting edges), so a capped graph keeps the most important links, not arbitrary ones.
    const relW = new Map();
    for (const ed of edges.values()) {
      if (seeds.includes(ed.head) && !seeds.includes(ed.tail)) relW.set(ed.tail, (relW.get(ed.tail) || 0) + ed.docs.size);
      if (seeds.includes(ed.tail) && !seeds.includes(ed.head)) relW.set(ed.head, (relW.get(ed.head) || 0) + ed.docs.size);
    }
    for (const [k] of [...relW.entries()].sort((a, b) => b[1] - a[1])) { if (keep.size >= NODE_CAP) break; keep.add(k); }
    // Further hops: plain BFS from what we have so far.
    let frontier = [...keep];
    for (let h = 1; h < hops && keep.size < NODE_CAP; h++) {
      const next = [];
      for (const k of frontier) for (const nb of (adj.get(k) || [])) {
        if (keep.has(nb)) continue;
        if (keep.size >= NODE_CAP) break;
        keep.add(nb); next.push(nb);
      }
      frontier = next;
    }
    // Co-occurrence: many entities never appear in an explicit «§ 关系» triple (so they'd look
    // isolated). Pull in entities that SHARE A DOCUMENT with a seed — { otherKey -> Set(sharedDoc) },
    // most-shared first — so the neighborhood is meaningful even without relations.
    const cooc = new Map();
    for (const seed of seeds) for (const docId of nodes.get(seed).docs) {
      for (const other of (byDoc.get(docId) || [])) {
        if (other === seed || seeds.includes(other)) continue;
        let s = cooc.get(other); if (!s) { s = new Set(); cooc.set(other, s); } s.add(docId);
      }
    }
    for (const [k] of [...cooc.entries()].sort((a, b) => b[1].size - a[1].size)) {
      if (keep.size >= NODE_CAP) break;
      keep.add(k);
    }
    const outNodes = [...keep].map((k) => { const n = nodes.get(k); return { key: k, name: n.name, type: n.type, count: n.docs.size }; });
    const nameOf = (k) => nodes.get(k).name;
    const pk = (a, b) => (a < b ? `${a}\t${b}` : `${b}\t${a}`);
    const outEdges = [];
    const docSet = new Set();
    const relPairs = new Set();   // dedupe co-occurrence against real relations
    for (const ed of edges.values()) {
      if (!keep.has(ed.head) || !keep.has(ed.tail)) continue;
      const label = [...ed.labels.entries()].sort((a, b) => b[1] - a[1])[0][0];   // most-common label wins
      // representative time qualifier: most frequent, ties broken by earliest (timeline layer)
      const time = ed.times && ed.times.size ? [...ed.times.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0] : "";
      outEdges.push({ head: nameOf(ed.head), tail: nameOf(ed.tail), label, count: ed.docs.size, docIds: [...ed.docs].slice(0, 6), time });
      relPairs.add(pk(ed.head, ed.tail));
      for (const d of ed.docs) docSet.add(d);
    }
    // seed → co-occurring entity edges (only where no relation already links the pair)
    for (const seed of seeds) {
      const shared = new Map();   // other -> Set(doc)
      for (const docId of nodes.get(seed).docs) for (const other of (byDoc.get(docId) || [])) {
        if (other === seed || !keep.has(other) || relPairs.has(pk(seed, other))) continue;
        let s = shared.get(other); if (!s) { s = new Set(); shared.set(other, s); } s.add(docId);
      }
      for (const [other, ds] of shared) {
        outEdges.push({ head: nameOf(seed), tail: nameOf(other), label: "", count: ds.size, cooc: true, docIds: [...ds].slice(0, 6) });
        for (const d of ds) docSet.add(d);
      }
    }
    const metaById = new Map(loadIndex().map((d) => [d.docId, d]));
    const docs = [...docSet].map((id) => { const m = metaById.get(id) || {}; return { docId: id, title: m.title || id, docKind: m.docKind || "doc" }; });
    const centers = seeds.map((k) => { const n = nodes.get(k); return { key: k, name: n.name, type: n.type, count: n.docs.size }; });
    sendJson(res, 200, { center: centers[0], centers, nodes: outNodes, edges: outEdges, docs });
  }).catch((e) => sendJson(res, 500, { error: e.message }));
}

// Every time-qualified relation across the library as one flat, time-sorted EVENT list — the
// data behind the dedicated timeline view. Endpoints/names are alias-canonicalized; each event
// keeps its source doc so the view can open it. Optional { names, folders } narrow the scope.
function timelineLibrary(req, res) {
  readBody(req).then((body) => {
    const names = (Array.isArray(body.names) ? body.names : []).map((n) => canonEntity(normalizeEntity(n))).filter(Boolean);
    const nameSet = names.length ? new Set(names) : null;
    // folder scope is prefix-inclusive (a folder + all its sub-folders), matching retrieve()/ask.
    const folders = Array.isArray(body.folders) && body.folders.length ? body.folders : null;
    const events = [];
    for (const it of loadIndex()) {
      if (folders) { const loc = locOf(it.docId); if (!folders.some((f) => loc === f || loc.startsWith(f + "/"))) continue; }
      const doc = readDoc(it.docId);
      for (const r of ((doc && doc.relations) || [])) {
        if (!Array.isArray(r) || r.length < 3) continue;
        const q = r[3];
        const time = (q && typeof q === "object" && !Array.isArray(q)) ? String(q.time || "").trim() : "";
        if (!/^\d{4}(-\d{2}){0,2}$/.test(time)) continue;
        const hk = canonEntity(normalizeEntity(r[0])), tk = canonEntity(normalizeEntity(r[2]));
        if (nameSet && !nameSet.has(hk) && !nameSet.has(tk)) continue;
        events.push({
          time, head: canonDisplay(normalizeEntity(r[0])), rel: String(r[1] || "").trim(), tail: canonDisplay(normalizeEntity(r[2])),
          place: (q.place ? String(q.place).trim() : ""), docId: it.docId, title: it.title || it.docId, docKind: it.docKind || "doc",
        });
      }
    }
    events.sort((a, b) => a.time.localeCompare(b.time));
    const years = events.map((e) => parseInt(e.time.slice(0, 4), 10)).filter(Number.isFinite);
    const span = years.length ? { min: Math.min(...years), max: Math.max(...years) } : null;
    sendJson(res, 200, { events, span, total: events.length });
  }).catch((e) => sendJson(res, 500, { error: e.message }));
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
async function llmComplete(model, messages, { timeoutMs = 300000, signal = null } = {}) {
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
  // embed:false sections (references) are citation noise — keep them out of the sample too.
  const body = (doc.blocks || []).filter(b => b.kind === "text" && b.embed !== false && !isConvBlock(b));
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
  // Opening sections (abstract/intro) carry the most signal; for a paper the LAST
  // section (conclusion) does too — results and limitations often live there. The
  // conclusion sits at the sample's end, exactly where the budget trim cuts, so its
  // slice is carved out FIRST and its space reserved; the middle sections yield.
  let tail = "";
  if (doc.docKind === "paper" && reps.length > 3) {
    const b = reps.pop();
    tail = (b.section ? `【${b.section}】\n` : "") + b.content.slice(0, per * 2) + "\n\n";
  }
  let out = head;
  reps.forEach((b, i) => {
    if (out.length + tail.length >= budget) return;
    const cap = i < 2 ? per * 2 : per;
    out += (b.section ? `【${b.section}】\n` : "") + b.content.slice(0, cap) + "\n\n";
  });
  return (out.slice(0, Math.max(0, budget - tail.length)) + tail).slice(0, budget);
}

// ---- Structure card: entity/relation layer (see docs/plans/structure-card.md) ----
// The distill card's **实体**/**关系** sections are a ROUND-TRIP syntax, not a one-way
// render: renderStructure() emits them, parseStructureSections() reads them back, and
// saveDocInternal re-parses on every save so the CARD TEXT is authoritative (a user can
// hand-edit an entity in and have it become retrievable). doc.entities/doc.relations are
// rebuilt from the text; the index projects entity names only.
const ENTITY_TYPES = ["person", "org", "place", "event", "method", "dataset", "concept", "tool", "product", "work", "policy"];
const TYPE_LABELS = {
  zh:        { person: "人物", org: "机构", place: "地点", event: "事件", method: "方法", dataset: "数据集", concept: "概念", tool: "工具", product: "产品", work: "作品", policy: "政策" },
  "zh-Hant": { person: "人物", org: "機構", place: "地點", event: "事件", method: "方法", dataset: "資料集", concept: "概念", tool: "工具", product: "產品", work: "作品", policy: "政策" },
  en:        { person: "person", org: "org", place: "place", event: "event", method: "method", dataset: "dataset", concept: "concept", tool: "tool", product: "product", work: "work", policy: "policy" },
};
// Reverse map (all languages' labels + the canonical english token) → canonical type,
// so a card distilled in Chinese still parses after the UI is switched to English.
const TYPE_FROM_LABEL = (() => {
  const m = new Map();
  for (const lang of Object.keys(TYPE_LABELS))
    for (const [canon, label] of Object.entries(TYPE_LABELS[lang])) m.set(String(label).toLowerCase(), canon);
  for (const t of ENTITY_TYPES) m.set(t, t);
  return m;
})();
// NFKC + lowercase + trim: folds full/half-width and case so "GraphRAG" == "graphrag".
// CJK internal spaces are meaningful-free (Chinese entities have none) so we don't strip
// them; english spaces ARE significant and preserved. Storage keeps original casing;
// only indexing/matching normalizes.
function normalizeEntity(s) { return String(s || "").normalize("NFKC").toLowerCase().trim(); }

// Validate + canonicalize a raw {entities, relations} (from LLM JSON OR from parsing the
// card text). Dedupe entities by normalized name (cap 20), coerce unknown types to
// concept, cap aliases at 5. Relations: keep [head, rel, tail] triples with an optional
// {time?, place?} qualifier (time must be an ISO YYYY[-MM[-DD]] prefix), cap 15. Lenient
// backfill: a relation endpoint absent from the entity list is appended as a concept
// entity (the LLM often ignores the "names must match" rule — dropping the relation would
// waste it).
function cleanStructure(raw) {
  const ents = [], seen = new Set();
  for (const e of (raw && Array.isArray(raw.entities) ? raw.entities : [])) {
    if (ents.length >= 20) break;
    const name = String((e && e.name) || "").trim();
    if (!name) continue;
    const key = normalizeEntity(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const type = ENTITY_TYPES.includes(e && e.type) ? e.type : "concept";
    const aliases = [...new Set((Array.isArray(e && e.aliases) ? e.aliases : [])
      .map((a) => String(a || "").trim()).filter(Boolean))].slice(0, 5);
    ents.push({ name, type, aliases });
  }
  const rels = [];
  for (const r of (raw && Array.isArray(raw.relations) ? raw.relations : [])) {
    if (rels.length >= 15) break;
    if (!Array.isArray(r) || r.length < 3) continue;
    const head = String(r[0] || "").trim(), rel = String(r[1] || "").trim(), tail = String(r[2] || "").trim();
    if (!head || !rel || !tail) continue;
    const out = [head, rel, tail];
    const q = r[3];
    if (q && typeof q === "object" && !Array.isArray(q)) {
      const qual = {};
      const time = String(q.time || "").trim();
      if (/^\d{4}(-\d{2}){0,2}$/.test(time)) qual.time = time;
      const place = String(q.place || "").trim();
      if (place) qual.place = place;
      if (Object.keys(qual).length) out.push(qual);
    }
    rels.push(out);
  }
  for (const r of rels) {
    for (const endpoint of [r[0], r[2]]) {
      const key = normalizeEntity(endpoint);
      if (key && !seen.has(key)) { seen.add(key); ents.push({ name: endpoint, type: "concept", aliases: [] }); }
    }
  }
  return { entities: ents, relations: rels };
}

// Render the two card sections from cleaned data. Entities inline (one line, ｜-joined,
// aliases in （=…）); relations one-per-line as `- \`head\` —rel(qual)→ \`tail\``. Names are
// backtick-wrapped so ·/｜/spaces inside a name never break the parse. Returns "" when
// there is nothing to render (old cards stay unchanged).
function renderStructure(data, L) {
  const ents = (data && data.entities) || [], rels = (data && data.relations) || [];
  if (!ents.length && !rels.length) return "";
  const typeLabel = (t) => (L.typeLabels && L.typeLabels[t]) || t;
  const parts = [];
  // Alias punctuation follows the language: full-width （=…、…） reads naturally in CJK,
  // half-width (=…, …) in English. Parsing accepts both, so only rendering is localized.
  const aw = L.aliasWrap || ["（", "）"], asep = L.aliasSep || "、";
  if (ents.length) {
    const items = ents.map((e) => {
      const al = (e.aliases && e.aliases.length) ? `${aw[0]}=${e.aliases.join(asep)}${aw[1]}` : "";
      return `\`${e.name}\`·${typeLabel(e.type)}${al}`;
    });
    parts.push(`${L.entitiesHead} ${items.join(" ｜ ")}`);
  }
  if (rels.length) {
    const items = rels.map((r) => {
      const [head, rel, tail, q] = r;
      const qs = (q && (q.time || q.place)) ? "(" + [q.time, q.place].filter(Boolean).join(" · ") + ")" : "";
      return `- \`${head}\` —${rel}${qs}→ \`${tail}\``;
    });
    parts.push(`${L.relationsHead}\n${items.join("\n")}`);
  }
  return parts.join("\n\n");
}

// Parse the **实体**/**关系** sections back out of a card's markdown → {entities, relations}
// (uncleaned — callers pass through cleanStructure). Heads are matched across all three
// languages. Lines that don't fit the syntax are skipped (a hand-edit must never make a
// save throw or swallow text); a missing section → that layer is empty (deleting the
// section is how a user clears it — the text is authoritative).
// Heads carry an optional §-prefix (new cards) — accepted but not required so cards
// distilled before the §-prefix change still parse.
const ENT_HEAD_RE = /^\*\*\s*§?\s*(?:实体|實體|Entities)\s*\*\*/i;
const REL_HEAD_RE = /^\*\*\s*§?\s*(?:关系|關係|Relations)\s*\*\*/i;
const ANY_HEAD_RE = /^\*\*[^*]+\*\*/;
function parseEntityChunk(chunk) {
  const nameM = chunk.match(/`([^`]+)`/);
  if (!nameM) return null;
  const name = nameM[1].trim();
  if (!name) return null;
  let rest = chunk.slice(chunk.indexOf(nameM[0]) + nameM[0].length).trim();
  let aliases = [];
  const aliasM = rest.match(/[（(]\s*=\s*([^）)]+)[）)]/);
  if (aliasM) {
    aliases = aliasM[1].split(/[、,，;；]/).map((s) => s.trim()).filter(Boolean);
    rest = (rest.slice(0, aliasM.index) + rest.slice(aliasM.index + aliasM[0].length)).trim();
  }
  let type = "concept";
  const typeM = rest.match(/^[·・:：]\s*(.+)$/);
  if (typeM) type = TYPE_FROM_LABEL.get(typeM[1].trim().toLowerCase()) || "concept";
  return { name, type, aliases };
}
function parseRelationLine(line) {
  const t = line.replace(/^[-*]\s*/, "").trim();
  const ticks = [...t.matchAll(/`([^`]+)`/g)];
  if (ticks.length < 2) return null;
  const head = ticks[0][1].trim(), tail = ticks[ticks.length - 1][1].trim();
  let mid = t.slice(ticks[0].index + ticks[0][0].length, ticks[ticks.length - 1].index);
  mid = mid.replace(/^\s*[—–-]\s*/, "").replace(/\s*[→>]+\s*$/, "").trim();
  let time = "", place = "";
  const qM = mid.match(/[（(]([^）)]+)[）)]\s*$/);
  if (qM) {
    mid = mid.slice(0, qM.index).trim();
    for (const part of qM[1].split(/[·・|｜]/).map((s) => s.trim()).filter(Boolean)) {
      if (/^\d{4}(-\d{2}){0,2}/.test(part)) time = part; else place = part;
    }
  }
  const rel = mid.trim();
  if (!head || !rel || !tail) return null;
  const qual = {};
  if (time) qual.time = time;
  if (place) qual.place = place;
  return Object.keys(qual).length ? [head, rel, tail, qual] : [head, rel, tail];
}
function parseStructureSections(cardContent) {
  const lines = String(cardContent || "").split("\n");
  const entities = [], relations = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i], trimmed = line.trim();
    if (ENT_HEAD_RE.test(trimmed)) {
      const rest = trimmed.replace(ENT_HEAD_RE, "").trim();
      for (const chunk of rest.split("｜")) {
        const e = parseEntityChunk(chunk.trim());
        if (e) entities.push(e);
      }
    } else if (REL_HEAD_RE.test(trimmed)) {
      for (let j = i + 1; j < lines.length; j++) {
        const t = lines[j].trim();
        if (!t || ANY_HEAD_RE.test(t)) break;   // blank or next section ends the list
        if (/^[-*]\s/.test(t)) { const r = parseRelationLine(t); if (r) relations.push(r); }
        else break;
      }
    }
  }
  return { entities, relations };
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
      "{\"title\":\"...\",\"authors\":\"...\",\"year\":\"...\",\"tags\":[\"...\"],\"summary\":\"...\",\"claims\":[\"...\"],\"entities\":[…],\"relations\":[…]}\n" +
      "作者只保留人名、去掉机构编号和上标数字，多个作者用英文逗号分隔；年份只要 4 位数字，没有就空字符串；标签用简短名词短语；摘要和要点用中文写（专有名词保留原文）。",
    paper: "你是学术论文蒸馏助手。给你的是一篇论文的抽样（目录 + 各章节开头）。完成两件事：\n" +
      "1) 抽取元数据：论文标题、作者、发表年份；\n" +
      "2) 写一张\"蒸馏卡\"：\n" +
      "- 摘要：3-5 句话，按「研究问题 → 方法 → 主要结果 → 意义」组织；\n" +
      "- 关键要点：4-8 条，各一句话，尽量覆盖：核心贡献、方法的一句话概括、关键定量结果（带数据集/基准名和具体数字）、相对已有方法的改进幅度、局限性；\n" +
      "- 3-6 个简短主题标签。\n" +
      "数学公式一律用 $...$ 包裹，不要用 \\(...\\) 或 \\[...\\]。\n" +
      "只输出 JSON，不要任何解释或代码块标记：\n" +
      "{\"title\":\"...\",\"authors\":\"...\",\"year\":\"...\",\"tags\":[\"...\"],\"summary\":\"...\",\"claims\":[\"...\"],\"entities\":[…],\"relations\":[…]}\n" +
      "作者只保留人名、去掉机构编号和上标数字，多个作者用英文逗号分隔；年份只要 4 位数字，没有就空字符串；标签用简短名词短语；摘要和要点用中文写（专有名词、方法名保留原文）。",
    video: "你是视频内容蒸馏助手。给你的是一个视频的字幕抽样（自动语音转写的口语文本，可能有识别错误，抽样取自开头/中间/结尾）。请写一张\"蒸馏卡\"：\n" +
      "1) 3-5 句话的摘要：视频讲了什么主题、讲者的核心观点或演示了什么、结论或建议；\n" +
      "2) 4-8 条关键要点：各一句话，保留具体结论、数字、步骤，以及提到的工具/论文/作品名；\n" +
      "3) 3-6 个简短主题标签。\n" +
      "忽略寒暄、求订阅、广告和赞助商口播等与内容无关的部分。\n" +
      "只输出 JSON，不要任何解释或代码块标记：\n" +
      "{\"tags\":[\"...\"],\"summary\":\"...\",\"claims\":[\"...\"],\"entities\":[…],\"relations\":[…]}\n" +
      "摘要和要点用中文写（专有名词保留原文）。",
    news: "你是新闻/资讯文章蒸馏助手。给你的是一篇新闻或博客文章（文档顶部标注了发布日期）。完成两件事：\n" +
      "1) 抽取元数据：标题、作者（署名记者或来源媒体）、发表年份；\n" +
      "2) 写一张\"蒸馏卡\"：\n" +
      "- 摘要：3-5 句话，说清「谁、在何时何地、做了或发生了什么、各方反应或影响」；\n" +
      "- 关键要点：4-8 条，各一句话，保留具体人物、机构、地点、数字和时间节点；\n" +
      "- 3-6 个简短主题标签。\n" +
      "只输出 JSON，不要任何解释或代码块标记：\n" +
      "{\"title\":\"...\",\"authors\":\"...\",\"year\":\"...\",\"tags\":[\"...\"],\"summary\":\"...\",\"claims\":[\"...\"],\"entities\":[…],\"relations\":[…]}\n" +
      "年份只要 4 位数字，没有就空字符串；标签用简短名词短语；摘要和要点用中文写（人名、机构名、地名保留原文）。",
    structAsk: "\n此外，在上面同一个 JSON 对象里再补充两个字段：\n" +
      "\"entities\": 8-15 个本文涉及的具体实体，每个形如 {\"name\":\"规范名\",\"type\":\"类型\",\"aliases\":[\"别名\"]}；类型只能取 person(人物)/org(机构)/place(地点)/event(事件)/method(方法或模型)/dataset(数据集或基准)/concept(概念)/tool(工具)/product(产品)/work(作品)/policy(政策法规) 之一；名字用规范全称，有通用缩写就用缩写，没有别名就给空数组 []。\n" +
      "\"relations\": 5-10 条实体关系三元组 [\"头\",\"关系\",\"尾\"]，关系用简短动词短语（如 提出/改进/基于/评测于/对比/收购/发布/位于）；头尾实体名必须出现在 entities 列表里；若这条关系有明确的时间或地点，追加第四项对象 {\"time\":\"YYYY-MM-DD\",\"place\":\"...\"}。\n" +
      "时间一律用绝对日期：文档顶部给出了发布日期，正文里的相对时间（如「上周三」「本月初」「去年」）请据此换算成绝对日期，换算不出就省略 time 字段。",
    videoStrict: "\n注意：字幕来自自动语音转写、可能有识别错误——只抽取字幕中明确清楚说出的具体名称，拿不准的宁可不抽，不要臆造实体或关系。",
    cardSection: "«蒸馏卡»", summaryHead: "**§ 摘要**", claimsHead: "**§ 要点**", toc: "目录：", transcriptHeading: "«字幕整理»",
    entitiesHead: "**§ 实体**", relationsHead: "**§ 关系**", pubDateHead: "发布日期：", typeLabels: TYPE_LABELS.zh, aliasWrap: ["（", "）"], aliasSep: "、",
    vTitle: "视频标题：", vChannel: "频道：", vSample: "字幕抽样：",
    rerank: "你是检索精排助手。给定一个查询和编号片段列表，按与查询的相关度从高到低输出片段编号。只输出 JSON，不要任何解释或代码块标记：{\"order\":[编号,…]}。明显不相关的编号可以省略。",
    rerankQuery: "查询：", rerankSnippets: "片段：",
  },
  "zh-Hant": {
    doc: "你是文獻蒸餾助手。根據文件抽樣內容完成兩件事：\n" +
      "1) 抽取元數據：標題、作者、發表年份；\n" +
      "2) 寫一張\"蒸餾卡\"：3-5 句話的摘要（說清這篇講什麼、方法或立場、結論），4-8 條關鍵要點（各一句話，能帶具體結論或數字更好），以及 3-6 個簡短主題標籤。\n" +
      "只輸出 JSON，不要任何解釋或代碼塊標記：\n" +
      "{\"title\":\"...\",\"authors\":\"...\",\"year\":\"...\",\"tags\":[\"...\"],\"summary\":\"...\",\"claims\":[\"...\"],\"entities\":[…],\"relations\":[…]}\n" +
      "作者只保留人名、去掉機構編號和上標數字，多個作者用英文逗號分隔；年份只要 4 位數字，沒有就空字符串；標籤用簡短名詞短語；摘要和要點用繁體中文寫（專有名詞保留原文）。",
    paper: "你是學術論文蒸餾助手。給你的是一篇論文的抽樣（目錄 + 各章節開頭）。完成兩件事：\n" +
      "1) 抽取元數據：論文標題、作者、發表年份；\n" +
      "2) 寫一張\"蒸餾卡\"：\n" +
      "- 摘要：3-5 句話，按「研究問題 → 方法 → 主要結果 → 意義」組織；\n" +
      "- 關鍵要點：4-8 條，各一句話，儘量覆蓋：核心貢獻、方法的一句話概括、關鍵定量結果（帶數據集/基準名和具體數字）、相對已有方法的改進幅度、局限性；\n" +
      "- 3-6 個簡短主題標籤。\n" +
      "數學公式一律用 $...$ 包裹，不要用 \\(...\\) 或 \\[...\\]。\n" +
      "只輸出 JSON，不要任何解釋或代碼塊標記：\n" +
      "{\"title\":\"...\",\"authors\":\"...\",\"year\":\"...\",\"tags\":[\"...\"],\"summary\":\"...\",\"claims\":[\"...\"],\"entities\":[…],\"relations\":[…]}\n" +
      "作者只保留人名、去掉機構編號和上標數字，多個作者用英文逗號分隔；年份只要 4 位數字，沒有就空字符串；標籤用簡短名詞短語；摘要和要點用繁體中文寫（專有名詞、方法名保留原文）。",
    video: "你是影片內容蒸餾助手。給你的是一個影片的字幕抽樣（自動語音轉寫的口語文本，可能有識別錯誤，抽樣取自開頭/中間/結尾）。請寫一張\"蒸餾卡\"：\n" +
      "1) 3-5 句話的摘要：影片講了什麼主題、講者的核心觀點或演示了什麼、結論或建議；\n" +
      "2) 4-8 條關鍵要點：各一句話，保留具體結論、數字、步驟，以及提到的工具/論文/作品名；\n" +
      "3) 3-6 個簡短主題標籤。\n" +
      "忽略寒暄、求訂閱、廣告和贊助商口播等與內容無關的部分。\n" +
      "只輸出 JSON，不要任何解釋或代碼塊標記：\n" +
      "{\"tags\":[\"...\"],\"summary\":\"...\",\"claims\":[\"...\"],\"entities\":[…],\"relations\":[…]}\n" +
      "摘要和要點用繁體中文寫（專有名詞保留原文）。",
    news: "你是新聞/資訊文章蒸餾助手。給你的是一篇新聞或部落格文章（文件頂部標註了發表日期）。完成兩件事：\n" +
      "1) 抽取元數據：標題、作者（署名記者或來源媒體）、發表年份；\n" +
      "2) 寫一張\"蒸餾卡\"：\n" +
      "- 摘要：3-5 句話，說清「誰、在何時何地、做了或發生了什麼、各方反應或影響」；\n" +
      "- 關鍵要點：4-8 條，各一句話，保留具體人物、機構、地點、數字和時間節點；\n" +
      "- 3-6 個簡短主題標籤。\n" +
      "只輸出 JSON，不要任何解釋或代碼塊標記：\n" +
      "{\"title\":\"...\",\"authors\":\"...\",\"year\":\"...\",\"tags\":[\"...\"],\"summary\":\"...\",\"claims\":[\"...\"],\"entities\":[…],\"relations\":[…]}\n" +
      "年份只要 4 位數字，沒有就空字符串；標籤用簡短名詞短語；摘要和要點用繁體中文寫（人名、機構名、地名保留原文）。",
    structAsk: "\n此外，在上面同一個 JSON 物件裡再補充兩個欄位：\n" +
      "\"entities\": 8-15 個本文涉及的具體實體，每個形如 {\"name\":\"規範名\",\"type\":\"類型\",\"aliases\":[\"別名\"]}；類型只能取 person(人物)/org(機構)/place(地點)/event(事件)/method(方法或模型)/dataset(資料集或基準)/concept(概念)/tool(工具)/product(產品)/work(作品)/policy(政策法規) 之一；名字用規範全稱，有通用縮寫就用縮寫，沒有別名就給空陣列 []。\n" +
      "\"relations\": 5-10 條實體關係三元組 [\"頭\",\"關係\",\"尾\"]，關係用簡短動詞短語（如 提出/改進/基於/評測於/對比/收購/發布/位於）；頭尾實體名必須出現在 entities 列表裡；若這條關係有明確的時間或地點，追加第四項物件 {\"time\":\"YYYY-MM-DD\",\"place\":\"...\"}。\n" +
      "時間一律用絕對日期：文件頂部給出了發表日期，正文裡的相對時間（如「上週三」「本月初」「去年」）請據此換算成絕對日期，換算不出就省略 time 欄位。",
    videoStrict: "\n注意：字幕來自自動語音轉寫、可能有識別錯誤——只抽取字幕中明確清楚說出的具體名稱，拿不準的寧可不抽，不要臆造實體或關係。",
    cardSection: "«蒸餾卡»", summaryHead: "**§ 摘要**", claimsHead: "**§ 要點**", toc: "目錄：", transcriptHeading: "«字幕整理»",
    entitiesHead: "**§ 實體**", relationsHead: "**§ 關係**", pubDateHead: "發表日期：", typeLabels: TYPE_LABELS["zh-Hant"], aliasWrap: ["（", "）"], aliasSep: "、",
    vTitle: "影片標題：", vChannel: "頻道：", vSample: "字幕抽樣：",
    rerank: "你是檢索精排助手。給定一個查詢和編號片段列表，按與查詢的相關度從高到低輸出片段編號。只輸出 JSON，不要任何解釋或代碼塊標記：{\"order\":[編號,…]}。明顯不相關的編號可以省略。",
    rerankQuery: "查詢：", rerankSnippets: "片段：",
  },
  en: {
    doc: "You are a document-distillation assistant. From the sampled document content, do two things:\n" +
      "1) Extract metadata: title, authors, publication year.\n" +
      "2) Write a distillation card: a 3-5 sentence summary (what it is about, its method or stance, its conclusions), 4-8 key claims (one sentence each, keeping concrete findings and numbers), and 3-6 short topic tags.\n" +
      "Output ONLY JSON, no explanation or code fences:\n" +
      "{\"title\":\"...\",\"authors\":\"...\",\"year\":\"...\",\"tags\":[\"...\"],\"summary\":\"...\",\"claims\":[\"...\"],\"entities\":[…],\"relations\":[…]}\n" +
      "Authors: names only, strip affiliation numbers and superscripts, comma-separated. Year: 4 digits, or empty if unknown. Tags: short noun phrases. Write the summary and claims in English (keep proper nouns as-is).",
    paper: "You are an academic-paper distillation assistant. You are given a sample of a paper (TOC + the opening of each section). Do two things:\n" +
      "1) Extract metadata: title, authors, publication year.\n" +
      "2) Write a distillation card:\n" +
      "- Summary: 3-5 sentences organized as research question → method → main results → significance.\n" +
      "- Key claims: 4-8, one sentence each, aiming to cover: the core contribution, a one-sentence description of the method, the key quantitative results (with dataset/benchmark names and concrete numbers), the improvement over prior methods, and the limitations.\n" +
      "- 3-6 short topic tags.\n" +
      "Wrap ALL math in $...$ — never use \\(...\\) or \\[...\\].\n" +
      "Output ONLY JSON, no explanation or code fences:\n" +
      "{\"title\":\"...\",\"authors\":\"...\",\"year\":\"...\",\"tags\":[\"...\"],\"summary\":\"...\",\"claims\":[\"...\"],\"entities\":[…],\"relations\":[…]}\n" +
      "Authors: names only, strip affiliation numbers and superscripts, comma-separated. Year: 4 digits, or empty if unknown. Tags: short noun phrases. Write the summary and claims in English (keep proper nouns and method names as-is).",
    video: "You are a video-content distillation assistant. You are given a sampled transcript of a video (automatic speech-to-text, may contain recognition errors; sampled from the beginning/middle/end). Write a distillation card:\n" +
      "1) A 3-5 sentence summary: the video's topic, the speaker's core points or what was demonstrated, and the conclusions or recommendations.\n" +
      "2) 4-8 key claims: one sentence each, keeping concrete findings, numbers, steps, and any tools/papers/works mentioned.\n" +
      "3) 3-6 short topic tags.\n" +
      "Ignore greetings, subscribe reminders, ads and sponsor reads.\n" +
      "Output ONLY JSON, no explanation or code fences:\n" +
      "{\"tags\":[\"...\"],\"summary\":\"...\",\"claims\":[\"...\"],\"entities\":[…],\"relations\":[…]}\n" +
      "Write in English (keep proper nouns as-is).",
    news: "You are a news/article distillation assistant. You are given a news or blog article (its publication date is noted at the top). Do two things:\n" +
      "1) Extract metadata: title, author (bylined reporter or source outlet), publication year.\n" +
      "2) Write a distillation card:\n" +
      "- Summary: 3-5 sentences covering who, when and where, what was done or happened, and the reactions or impact.\n" +
      "- Key claims: 4-8, one sentence each, keeping the specific people, organizations, places, numbers and dates.\n" +
      "- 3-6 short topic tags.\n" +
      "Output ONLY JSON, no explanation or code fences:\n" +
      "{\"title\":\"...\",\"authors\":\"...\",\"year\":\"...\",\"tags\":[\"...\"],\"summary\":\"...\",\"claims\":[\"...\"],\"entities\":[…],\"relations\":[…]}\n" +
      "Year: 4 digits, or empty if unknown. Tags: short noun phrases. Write in English (keep names, orgs and places as-is).",
    structAsk: "\nAdditionally, add two more fields to the SAME JSON object:\n" +
      "\"entities\": 8-15 concrete entities the text is about, each as {\"name\":\"canonical name\",\"type\":\"type\",\"aliases\":[\"alias\"]}; type must be one of person/org/place/event/method/dataset/concept/tool/product/work/policy; use the canonical full name (or the common abbreviation if there is one); empty array [] when there are no aliases.\n" +
      "\"relations\": 5-10 entity triples [\"head\",\"relation\",\"tail\"], relation a short verb phrase (e.g. proposes/improves/based-on/evaluated-on/compared-with/acquires/releases/located-in); head and tail names MUST appear in the entities list; if the relation has a clear time or place, append a fourth object {\"time\":\"YYYY-MM-DD\",\"place\":\"...\"}.\n" +
      "Always use absolute dates: the publication date is given at the top, so convert relative times in the body (\"last Wednesday\", \"earlier this month\", \"last year\") into absolute dates; if you cannot, omit the time field.",
    videoStrict: "\nNote: the transcript is automatic speech-to-text and may contain errors — extract ONLY names clearly and explicitly spoken; when unsure, leave it out rather than inventing entities or relations.",
    cardSection: "«Distill Card»", summaryHead: "**§ Summary**", claimsHead: "**§ Key points**", toc: "TOC: ", transcriptHeading: "«Transcript»",
    entitiesHead: "**§ Entities**", relationsHead: "**§ Relations**", pubDateHead: "Published: ", typeLabels: TYPE_LABELS.en, aliasWrap: ["(", ")"], aliasSep: ", ",
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
async function distillDocInternal(docId, { metadata = false, model, language = "", timeoutS = 0, signal = null } = {}) {
  if (!model) throw new Error("蒸馏需要指定聊天模型");
  const doc = readDoc(docId);
  if (!doc || doc.type !== "libdoc") throw new Error("文档不存在");
  const L = distillL(language);
  const sample = distillSample(doc, L.toc);
  if (!sample.trim()) throw new Error("文档没有可蒸馏的文本");
  // Videos get the transcript-aware prompt; their exact title/channel (from YouTube)
  // is fed IN as context instead of being asked back out of the LLM. Papers get an
  // academic variant (same JSON shape): summary structured as question→method→results→
  // significance, claims required to carry the quantitative results and limitations,
  // and math pinned to $...$ delimiters (the only span parseJsonLoose repairs).
  const isVideo = doc.docKind === "video";
  // The doc's own date (publishedAt, else year) is fed IN so the structure layer can
  // resolve relative times ("last Wednesday") into absolute dates (structAsk instruction).
  const pubDate = String(doc.publishedAt || doc.year || "").trim();
  const dateLine = pubDate ? `${L.pubDateHead}${pubDate}` : "";
  const user = isVideo
    ? [`${L.vTitle}${doc.title || ""}`, doc.authors ? `${L.vChannel}${doc.authors}` : "", dateLine, "", L.vSample, sample].filter(s => s !== "").join("\n")
    : (dateLine ? `${dateLine}\n\n${sample}` : sample);
  // Base template by kind; then append the shared entity/relation ask (structAsk) and,
  // for videos, the stricter "don't invent from ASR noise" note.
  const base = isVideo ? L.video : (doc.docKind === "paper" ? L.paper : (doc.docKind === "blog" ? L.news : L.doc));
  const systemPrompt = base + L.structAsk + (isVideo ? L.videoStrict : "");
  // Per-call budget follows the UI "timeout (s)" slider (snapshotted into the job
  // payload at enqueue) so slow machines can raise it — but never below 300s: the
  // slider bottoms out at 60s (fine for chat), which would starve a distill call
  // (16k-char sample + a full JSON card). Absent/invalid → the same 300s floor.
  const timeoutMs = Math.max(Number(timeoutS) || 0, 300) * 1000;
  let out;
  try {
    out = await llmComplete(model, [
      { role: "system", content: systemPrompt },
      { role: "user", content: user },
    ], { timeoutMs, signal });
  } catch (e) {
    // Surface a timeout as a NAMED failure ("蒸馏超时") so the task drawer can show it —
    // slow machines hit this, and the fix is a longer timeout-slider value, not a retry.
    if (e && e.name === "TimeoutError") {
      const err = new Error(`蒸馏超时（${Math.round((timeoutMs || 300000) / 1000)} 秒）`);
      err.code = "DISTILL_TIMEOUT";
      throw err;
    }
    throw e;
  }
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
  // Entity/relation layer: clean the LLM's JSON then RENDER it into the card text. The
  // card is authoritative — saveDocInternal (below) parses these sections back into
  // doc.entities/doc.relations, so hand-edits and this render share one write path.
  const structure = renderStructure(cleanStructure(j), L);
  const content = [
    summary ? `${L.summaryHead} ${summary}` : "",
    claims.length ? `${L.claimsHead}\n` + claims.map(c => `- ${c}`).join("\n") : "",
    structure,
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
// POST /api/library/rate { docId, rating: 0..5 in 0.5 steps } → { ok, rating } — 0 clears.
// A manual quality mark, shown as ★ in the list and next to the preview title.
async function rateLibraryDoc(req, res) {
  try {
    const body = await readBody(req);
    const docId = String(body.docId || "");
    const rating = Math.max(0, Math.min(5, Math.round((Number(body.rating) || 0) * 2) / 2));
    const doc = readDoc(docId);
    if (!doc) { sendJson(res, 404, { error: "文档不存在" }); return; }
    if (rating) doc.rating = rating; else delete doc.rating;
    writeDoc(doc);
    // Update the index entry IN PLACE — upsertIndex pushes to the end, which would
    // reshuffle the list's default import order on every rating click.
    const arr = loadIndex();
    const e = arr.find((d) => d.docId === docId);
    if (e) { e.rating = rating || undefined; saveIndex(arr); }
    sendJson(res, 200, { ok: true, rating });
  } catch (e) { sendJson(res, 500, { error: e.message }); }
}

// POST /api/library/tag-edit { op: "delete"|"rename", name, newName? }
//   → { ok, changed } — library-wide tag maintenance. Tags are pure metadata (never
// embedded), so this only rewrites doc JSON + the index; NO re-embedding needed.
// rename: if the new name already exists on a doc, the two merge (deduped, keeping the
// existing color). Runs over the whole library by index, editing each entry in place so
// the list's default import order is preserved.
async function editLibraryTag(req, res) {
  try {
    const body = await readBody(req);
    const op = String(body.op || "");
    const name = String(body.name || "").trim();
    const newName = String(body.newName || "").trim();
    if (!name) { sendJson(res, 400, { error: "缺少标签名" }); return; }
    if (op === "rename" && !newName) { sendJson(res, 400, { error: "缺少新标签名" }); return; }
    if (op !== "delete" && op !== "rename") { sendJson(res, 400, { error: "未知操作" }); return; }

    // Apply the op to a [{name,color}] list; returns a NEW list or null if unchanged.
    const apply = (tags) => {
      if (!Array.isArray(tags) || !tags.some((tg) => tg && tg.name === name)) return null;
      if (op === "delete") return tags.filter((tg) => tg && tg.name !== name);
      // rename → newName, then dedupe (a doc may already carry newName).
      const out = []; const seen = new Set();
      for (const tg of tags) {
        if (!tg || !tg.name) continue;
        const nm = tg.name === name ? newName : tg.name;
        if (seen.has(nm)) continue;
        seen.add(nm);
        out.push(tg.name === name ? { name: newName, color: tagColor(newName) } : tg);
      }
      return out;
    };

    const arr = loadIndex();
    let changed = 0;
    for (const e of arr) {
      const doc = readDoc(e.docId);
      if (!doc) continue;
      const next = apply(doc.tags);
      if (!next) continue;
      doc.tags = next;
      writeDoc(doc);
      e.tags = next;   // keep the index entry in sync (in place — no reorder)
      changed++;
    }
    if (changed) { saveIndex(arr); invalidateCache(); }
    sendJson(res, 200, { ok: true, changed });
  } catch (e) { sendJson(res, 500, { error: e.message }); }
}

async function distillLibraryDoc(req, res) {
  try {
    const body = await readBody(req);
    if (!body.docId || !body.model) { sendJson(res, 400, { error: "docId and model required" }); return; }
    const r = await distillDocInternal(body.docId, { metadata: body.metadata !== false, model: body.model, language: body.language || "", timeoutS: body.timeoutS });
    sendJson(res, 200, { ok: true, reembedded: r.reembedded });
  } catch (e) { sendJson(res, 500, { error: e.message }); }
}

// ---- YouTube doc assembly (server-side twin of the old frontend youtube branch) ----
// Turns a /api/youtube-job result into the import body: cover figure (thumbnail +
// metadata caption) under "# title", transcript under "# «字幕整理»" — the exact block
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
  return { source: `url:${url}`, docKind: "video", title, authors, year, publishedAt: uploadDate, text, images };
}

// ---- paper metadata via DOI → Crossref -------------------------------------
// Peer-reviewed papers carry their DOI on the first page (header/footer/footnote);
// Crossref then gives the EXACT title/authors/date. Same spirit as YouTube imports:
// feed precise metadata IN instead of asking the distill LLM to guess it back out of
// the sample (which mangles author lists and hallucinates years). Only the HEAD of
// the parsed text is scanned — the references section is full of OTHER papers' DOIs.
// Returns null when no DOI is found; { doi } alone when Crossref is unreachable
// (the caller then falls back to LLM metadata but still records the DOI).
const DOI_RE = /\b10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+/;
async function lookupPaperMeta(text) {
  const m = String(text || "").slice(0, 6000).match(DOI_RE);
  if (!m) return null;
  const doi = m[0].replace(/[.,;:)]+$/, "");
  try {
    const r = await fetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, {
      headers: { "User-Agent": "hey-koko/1.0 (knowledge-library import)", "Accept": "application/json" },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return { doi };   // 404 = mis-parsed/unregistered DOI → keep it, skip the metadata
    const msg = (await r.json()).message || {};
    const title = (Array.isArray(msg.title) && msg.title[0]) ? String(msg.title[0]).replace(/\s+/g, " ").trim() : "";
    const authors = (msg.author || [])
      .map(a => [a.given, a.family].filter(Boolean).join(" ").trim() || a.name || "")
      .filter(Boolean).join(", ");
    // issued = earliest known publication date; date-parts may be [y], [y,m] or [y,m,d] —
    // publishedAt keeps whatever precision exists (lexicographic sort still works).
    const dp = ((msg.issued || msg["published-print"] || msg["published-online"] || {})["date-parts"] || [])[0] || [];
    const year = dp[0] ? String(dp[0]) : "";
    const publishedAt = dp[0] ? [String(dp[0]), ...dp.slice(1, 3).map(n => String(n).padStart(2, "0"))].join("-") : "";
    // Bibliographic citation block, all from the SAME Crossref call — venue is the
    // headline field (which journal/conference); type distinguishes a real publication
    // (journal-article/proceedings-article) from a preprint (posted-content).
    const citation = {
      venue: (msg["container-title"] || [])[0] || (msg["short-container-title"] || [])[0] || "",
      volume: msg.volume || "",
      issue: msg.issue || "",
      pages: msg.page || msg["article-number"] || "",
      type: msg.type || "",
      url: msg.URL || (doi ? `https://doi.org/${doi}` : ""),
    };
    return { doi, title, authors, year, publishedAt, citation };
  } catch { return { doi }; }
}

// Author-supplied keywords from a paper's first page: a "Keywords:" / "Index Terms—"
// (IEEE em-dash) / "关键词：" line. Only the HEAD is scanned (the word "keywords" also
// appears in prose / related work). Split on ; , 、 ；, strip markdown emphasis, and
// drop anything sentence-shaped (a real keyword is a short phrase, not a clause).
function extractKeywords(text) {
  const head = String(text || "").slice(0, 6000);
  const m = head.match(/(?:key\s?words?|index\s+terms|关\s?键\s?词|關\s?鍵\s?詞)\s*[:：—–]\s*(.+)/i);
  if (!m) return [];
  const line = m[1].split(/\r?\n/)[0].replace(/^[*_\s]+/, "").replace(/[.*_\s]+$/, "");
  const parts = line.split(/[;,、；，]/).map(s => s.replace(/[*_`]/g, "").trim()).filter(Boolean);
  return parts.filter(p => p.length <= 60 && p.split(/\s+/).length <= 8).slice(0, 12);
}

module.exports = {
  importLibrary, listLibrary, searchLibrary, getLibraryDoc,
  saveLibraryDoc, deleteLibraryDocs, retrieveLibrary, reparseLibrary, LIBRARY_DIR,
  listLibraryDirs, moveLibraryDocs, rescanLibrary, rateLibraryDoc, editLibraryTag,
  splitIntoBlocks,   // exported for reuse/testing of the chunker
  // server-side libimport job (jobs.js) + distill + related-docs
  importDocInternal, distillDocInternal, distillLibraryDoc, buildYoutubeDoc, llmComplete,
  relatedLibraryDocs, docCentroids, lookupPaperMeta, extractKeywords,
  locOf,   // docId → on-disk folder ("" = root); used by the star map for folder scoping
  // structure-card entity/relation layer (docs/plans/structure-card.md)
  entityLookupLibrary, entityIndex, entityFacetsLibrary, entityFacets,
  aliasesLibrary, aliasEditLibrary, aliasResolver, aliasSuggestions,   // entity alias unification
  entityNeighborhoodLibrary, entityGraph,   // cross-doc entity network graph
  timelineLibrary,   // dedicated timeline view (time-qualified relations)
  cleanStructure, renderStructure, parseStructureSections, normalizeEntity,   // exported for testing
};
