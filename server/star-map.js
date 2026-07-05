// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

// Knowledge star-map: project the library/archive embeddings to 2D via UMAP
// (Python umap-learn in the shared ~/venv/heykoko venv) + KMeans constellations,
// label each cluster by its docs' tags/titles, and cache the result to
// starmap.<source>.json under the data dir. The heavy compute runs as a
// background "starmap" job (jobs.js); the browser only ever reads the cache via
// POST /api/library/starmap. No third-party npm deps — UMAP lives in the venv.

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const config = require("./config");
const library = require("./library");
const embed = require("./embed");
const { sendJson, readBody } = require("./utils");

const SOURCES = new Set(["library", "archive"]);
const MIN_SCOPED = 8;   // fewest docs a folder scope needs before UMAP re-projection is worthwhile

// ---- folder scoping (B: re-project a chosen set of folders) ---------------
// A scope is a set of library folders. We normalize it (trim, strip slashes,
// dedup, COLLAPSE nested — "a" already covers "a/b" — then sort) so any two
// equivalent selections map to the same cache. Empty scope = the whole library.
function normFolders(folders) {
  if (!Array.isArray(folders)) return [];
  const clean = [...new Set(folders
    .map((f) => path.normalize(String(f || "")).replace(/\\/g, "/").replace(/^\/+|\/+$/g, ""))
    .filter(Boolean))];
  // Drop any folder that sits under another selected folder (nested → redundant).
  const kept = clean.filter((f) => !clean.some((g) => g !== f && (f === g || f.startsWith(g + "/"))));
  return kept.sort();
}
// Is a doc's folder inside the scope? Empty scope → everything is in scope.
function inScope(folder, folders) {
  if (!folders.length) return true;
  const f = folder || "";
  return folders.some((g) => f === g || f.startsWith(g + "/"));
}
// FNV-1a 32-bit → base36; stable, no Date/random (safe for cache keys).
function hashScope(folders) {
  const s = folders.join("\n");
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}
// Cache path: whole-library keeps the legacy name; a folder scope gets sel-<hash>.
function starmapPath(source, folders) {
  const scope = normFolders(folders);
  if (source !== "archive" && scope.length) {
    return path.join(config.DATA_DIR, `starmap.${source}.sel-${hashScope(scope)}.json`);
  }
  return path.join(config.DATA_DIR, `starmap.${source}.json`);
}
// Keep only the newest KEEP_SCOPED sel-* caches per source; evict older by mtime.
// The whole-library cache and archive are never touched.
const KEEP_SCOPED = 5;
function evictOldScoped(source) {
  try {
    const pref = `starmap.${source}.sel-`;
    const files = fs.readdirSync(config.DATA_DIR)
      .filter((f) => f.startsWith(pref) && f.endsWith(".json"))
      .map((f) => { const p = path.join(config.DATA_DIR, f); return { p, m: fs.statSync(p).mtimeMs }; })
      .sort((a, b) => b.m - a.m);
    for (const { p } of files.slice(KEEP_SCOPED)) { try { fs.unlinkSync(p); } catch { /* ignore */ } }
  } catch { /* ignore */ }
}

// Gather { id, vec, title, kind, snippet }[] + per-id tags from one source.
// library → per-doc centroid (mean of block vectors); archive → one vector per
// conversation. Both share the same embedding space now (8b), but a map only ever
// projects ONE source at a time, so mixed models never meet here.
function gather(source, folders = []) {
  if (source === "archive") {
    const idx = embed.loadArchiveEmbeddings();
    const items = [];
    for (const [file, it] of Object.entries(idx.items || {})) {
      if (it.vector) items.push({ id: file, vec: it.vector, title: it.title || file, kind: "chat", snippet: it.snippet || "" });
    }
    return { items, model: idx.model || "", tags: new Map() };
  }
  const scope = normFolders(folders);
  // library
  const cents = library.docCentroids();   // Map<docId, { vec, model, title, docKind, blocks }>
  // Different embedding models are different vector spaces (often different DIMS) —
  // mixing them would give the odd doc a garbage position/cluster. Keep only the
  // majority model's docs; stragglers need a re-embed to (re)appear on the map.
  const counts = new Map();
  for (const [, c] of cents) counts.set(c.model, (counts.get(c.model) || 0) + 1);
  let model = "";
  for (const [m, n] of counts) if (!model || n > (counts.get(model) || 0)) model = m;
  // A corrupt .vec file can decode to a vector of the WRONG length or one holding NaN/Inf
  // (a bad header that still "fits" won't throw in decodeVectors). Feeding either to UMAP
  // makes the whole build crash or hang, so pin the expected dimension (the most common
  // among the majority model's docs) and drop anything that doesn't match — one bad file
  // no longer takes down the map.
  const dimCounts = new Map();
  for (const [, c] of cents) if (c.model === model && c.vec) dimCounts.set(c.vec.length, (dimCounts.get(c.vec.length) || 0) + 1);
  let dim = 0;
  for (const [d, n] of dimCounts) if (d && (!dim || n > (dimCounts.get(dim) || 0))) dim = d;
  const items = [];
  let excluded = 0, corrupt = 0;
  for (const [docId, c] of cents) {
    if (c.model !== model) { excluded++; continue; }
    if (!isCleanVec(c.vec, dim)) { corrupt++; continue; }   // wrong-dim / NaN / Inf → skip
    const folder = library.locOf(docId) || "";
    if (!inScope(folder, scope)) continue;   // B: restrict to the chosen folders
    items.push({ id: docId, vec: c.vec, title: c.title || docId, kind: c.docKind || "doc", snippet: "", blocks: c.blocks || 0, folder });
  }
  if (excluded) console.warn(`[starmap] ${excluded} doc(s) excluded: embedding model ≠ ${model}`);
  if (corrupt) console.warn(`[starmap] ${corrupt} doc(s) excluded: corrupt vector (wrong dim ≠ ${dim}, or NaN/Inf) — re-embed to restore`);
  const tags = new Map();
  const years = new Map();   // docId → content YEAR (publishedAt date > year field), for the timeline
  try {
    const index = JSON.parse(fs.readFileSync(path.join(library.LIBRARY_DIR, "index.json"), "utf-8"));
    for (const e of index) {
      tags.set(e.docId, (e.tags || []).map((t) => (typeof t === "string" ? t : t.name)));
      const y = yearOf(e.publishedAt) || yearOf(e.year);
      if (y) years.set(e.docId, y);
    }
  } catch { /* no index yet */ }
  for (const it of items) { const y = years.get(it.id); if (y) it.year = y; }
  return { items, model, tags };
}

// A vector is usable only if it's the expected length and every component is finite.
function isCleanVec(v, dim) {
  if (!v || dim === 0 || v.length !== dim) return false;
  for (let i = 0; i < v.length; i++) if (!Number.isFinite(v[i])) return false;
  return true;
}

// First 4-digit year in a date/year string ("2024-01-15" / "2024" / 2024) → int or null.
function yearOf(v) {
  if (v == null) return null;
  const m = String(v).match(/\b(19|20)\d{2}\b/);
  if (!m) return null;
  const y = parseInt(m[0], 10);
  return y >= 1900 && y <= 2100 ? y : null;
}

// Write the vectors as a raw float32 matrix the python side reads with np.fromfile.
// Layout: [n u32-le][dim u32-le][ n*dim float32-le ]. Host is little-endian (arm/x86).
function writeMatrix(vecs) {
  const n = vecs.length, dim = n ? vecs[0].length : 0;
  const header = Buffer.alloc(8);
  header.writeUInt32LE(n, 0);
  header.writeUInt32LE(dim, 4);
  const flat = new Float32Array(n * dim);
  for (let i = 0; i < n; i++) flat.set(vecs[i], i * dim);
  const body = Buffer.from(flat.buffer, flat.byteOffset, flat.byteLength);
  const p = path.join(os.tmpdir(), `heykoko-umap-${process.pid}-${Date.now()}.f32`);
  fs.writeFileSync(p, Buffer.concat([header, body]));
  return p;
}

// Is the UMAP projector actually runnable — i.e. does config.umapPython exist AND
// have umap-learn importable? Probed with a FAST `find_spec` (locates the module
// without triggering umap's multi-second import). Cached per interpreter: a success
// sticks (nothing to recheck), a failure re-probes after 15s so installing the venv
// mid-session is picked up without a server restart. The frontend reads this on every
// star-map open (via serveStarmap) so it can WARN before offering a doomed build.
let _umapProbe = null;   // { ok, python, at }
function checkUmap() {
  const py = config.umapPython;
  if (_umapProbe && _umapProbe.python === py && (_umapProbe.ok || Date.now() - _umapProbe.at < 15000)) {
    return Promise.resolve(_umapProbe);
  }
  return new Promise((resolve) => {
    const done = (ok) => { _umapProbe = { ok, python: py, at: Date.now() }; resolve(_umapProbe); };
    let proc;
    try {
      proc = spawn(py, ["-c", "import importlib.util,sys; sys.exit(0 if importlib.util.find_spec('umap') else 3)"]);
    } catch { done(false); return; }
    proc.on("error", () => done(false));
    proc.on("close", (code) => done(code === 0));
  });
}

// Spawn the python projector; resolves { xy:[[x,y]...], cluster:[int...] }.
function runUmap(inPath, signal) {
  return new Promise((resolve, reject) => {
    const py = config.umapPython;
    const proc = spawn(py, [path.join(__dirname, "umap_project.py"), inPath], { signal });
    let out = "", err = "";
    proc.stdout.on("data", (d) => (out += d));
    proc.stderr.on("data", (d) => (err += d));
    proc.on("error", (e) => reject(new Error(
      `cannot spawn ${py}: ${e.message} — is ~/venv/heykoko set up with umap-learn? (see docs/local-python.md)`)));
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(`umap_project.py exited ${code}: ${err.slice(-500)}`));
      try { resolve(JSON.parse(out.trim().split("\n").pop())); }
      catch (e) { reject(new Error(`bad umap output: ${e.message}; stderr: ${err.slice(-300)}`)); }
    });
  });
}

// Name each cluster by its most common doc tags; fall back to salient title words.
const STOP = new Set("the a an of to and or in on for with from vs 的 了 是 全 解析 选购".split(/\s+/));
function labelClusters(items, clusterIds, tagsById, k) {
  const out = [];
  for (let c = 0; c < k; c++) {
    const members = items.filter((_, i) => clusterIds[i] === c);
    if (!members.length) { out.push({ id: c, size: 0, label: `簇 ${c + 1}` }); continue; }
    const freq = {};
    for (const m of members) for (const t of (tagsById.get(m.id) || [])) freq[t] = (freq[t] || 0) + 1;
    let labels = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 3).map((e) => e[0]);
    if (!labels.length) {
      const wf = {};
      for (const m of members) for (const w of String(m.title).split(/[\s_,\-#()·:：、，。]+/)) {
        const lw = w.toLowerCase();
        if (lw.length > 1 && !STOP.has(lw)) wf[w] = (wf[w] || 0) + 1;
      }
      labels = Object.entries(wf).sort((a, b) => b[1] - a[1]).slice(0, 3).map((e) => e[0]);
    }
    out.push({ id: c, size: members.length, label: labels.join(" · ") || `簇 ${c + 1}` });
  }
  return out;
}

// Background-job entry: build & cache the map for one source. Reports progress via
// job.label/emitUpdate when called from the queue; returns a small summary.
async function computeStarmap(job, signal, emitUpdate) {
  const source = (job && job.payload && job.payload.source) || "library";
  if (!SOURCES.has(source)) throw new Error(`unknown starmap source: ${source}`);
  const scope = normFolders(job && job.payload && job.payload.folders);
  const scoped = source !== "archive" && scope.length > 0;
  const outPath = starmapPath(source, scope);
  const setLabel = (s) => { if (job) { job.label = s; if (emitUpdate) emitUpdate(job); } };

  const { items, model, tags } = gather(source, scope);
  setLabel(`星图:读取 ${items.length} 个向量…`);
  // Re-projecting a folder scope needs enough points for UMAP to lay out sensibly;
  // below the floor we cache a `tooFew` marker so the frontend can explain instead
  // of building a degenerate 3-dot map. The whole-library map has no such floor.
  if (scoped && items.length < MIN_SCOPED) {
    const thin = { source, folders: scope, n: items.length, model, builtAt: Date.now(), clusters: [], docs: [], tooFew: true, minDocs: MIN_SCOPED };
    fs.writeFileSync(outPath, JSON.stringify(thin));
    if (scoped) evictOldScoped(source);
    return { source, n: items.length, tooFew: true };
  }
  if (!items.length) {
    const empty = { source, ...(scoped ? { folders: scope } : {}), n: 0, model, builtAt: Date.now(), clusters: [], docs: [] };
    fs.writeFileSync(outPath, JSON.stringify(empty));
    return { source, n: 0 };
  }

  const inPath = writeMatrix(items.map((it) => it.vec));
  try {
    setLabel(`星图:UMAP 投影 ${items.length} 点…`);
    const { xy, cluster, nn } = await runUmap(inPath, signal);
    const k = cluster.length ? Math.max(...cluster) + 1 : 0;
    const clusters = labelClusters(items, cluster, tags, k);
    const docs = items.map((it, i) => ({
      id: it.id, title: it.title, kind: it.kind,
      x: xy[i] ? xy[i][0] : 0, y: xy[i] ? xy[i][1] : 0,
      cluster: cluster[i] != null ? cluster[i] : 0,
      ...(it.snippet ? { snippet: it.snippet } : {}),
      ...(it.blocks ? { blocks: it.blocks } : {}),
      // on-disk folder ("" = root) — drives the A-mode folder FILTER on the full map.
      ...(it.folder ? { folder: it.folder } : {}),
      // content year (publishedAt / year) — drives the timeline scrubber.
      ...(it.year ? { year: it.year } : {}),
      // top-3 semantic neighbours (indices into docs) — the frontend draws these
      // as constellation edges on hover/selection and as "related" chips.
      ...(nn && nn[i] && nn[i].length ? { nn: nn[i] } : {}),
    }));
    const result = { source, ...(scoped ? { folders: scope } : {}), n: docs.length, model, builtAt: Date.now(), clusters, docs };
    fs.writeFileSync(outPath, JSON.stringify(result));
    if (scoped) evictOldScoped(source);
    return { source, n: docs.length };
  } finally {
    try { fs.unlinkSync(inPath); } catch { /* ignore */ }
  }
}

// Current number of mappable items for a source (+ optional folder scope) — the cheap
// staleness signal (a cache built for N docs is out of date once the count changes).
// archive → embeddings index size; library whole → index.json length; library scope →
// count docs whose folder is in scope.
function currentCount(source, folders = []) {
  try {
    if (source === "archive") return Object.keys(embed.loadArchiveEmbeddings().items || {}).length;
    const index = JSON.parse(fs.readFileSync(path.join(library.LIBRARY_DIR, "index.json"), "utf-8"));
    const scope = normFolders(folders);
    if (!scope.length) return index.length;
    return index.filter((e) => inScope(library.locOf(e.docId) || "", scope)).length;
  } catch { return 0; }
}

// HTTP: return the cached map for a source (POST /api/library/starmap { source }).
// Missing cache → { stale: true } so the frontend can prompt "build the star map".
// Present but built for a different doc count → still returned (so the user sees the
// old map) with { outdated: true, currentN } so the UI can offer a rebuild.
async function serveStarmap(req, res) {
  let body; try { body = await readBody(req); } catch { body = {}; }
  const source = SOURCES.has(body && body.source) ? body.source : "library";
  const scope = normFolders(body && body.folders);
  // Whether a (re)build is even possible — the frontend warns the user if not.
  const umap = await checkUmap();
  try {
    const cached = JSON.parse(fs.readFileSync(starmapPath(source, scope), "utf-8"));
    // A `tooFew` marker isn't a real map — don't slap an "outdated" badge on it.
    if (!cached.tooFew) {
      const now = currentCount(source, scope);
      if (now !== cached.n) { cached.outdated = true; cached.currentN = now; }
    }
    cached.umapReady = umap.ok; cached.umapPython = umap.python;
    sendJson(res, 200, cached);
  } catch {
    sendJson(res, 200, { source, ...(scope.length ? { folders: scope } : {}), stale: true, n: 0, docs: [], clusters: [], umapReady: umap.ok, umapPython: umap.python });
  }
}

module.exports = { computeStarmap, serveStarmap, starmapPath, SOURCES, _test: { normFolders, inScope, hashScope, isCleanVec, gather } };
