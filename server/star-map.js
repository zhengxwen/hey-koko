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
const starmapPath = (source) => path.join(config.DATA_DIR, `starmap.${source}.json`);

// Gather { id, vec, title, kind, snippet }[] + per-id tags from one source.
// library → per-doc centroid (mean of block vectors); archive → one vector per
// conversation. Both share the same embedding space now (8b), but a map only ever
// projects ONE source at a time, so mixed models never meet here.
function gather(source) {
  if (source === "archive") {
    const idx = embed.loadArchiveEmbeddings();
    const items = [];
    for (const [file, it] of Object.entries(idx.items || {})) {
      if (it.vector) items.push({ id: file, vec: it.vector, title: it.title || file, kind: "chat", snippet: it.snippet || "" });
    }
    return { items, model: idx.model || "", tags: new Map() };
  }
  // library
  const cents = library.docCentroids();   // Map<docId, { vec, model, title, docKind, blocks }>
  // Different embedding models are different vector spaces (often different DIMS) —
  // mixing them would give the odd doc a garbage position/cluster. Keep only the
  // majority model's docs; stragglers need a re-embed to (re)appear on the map.
  const counts = new Map();
  for (const [, c] of cents) counts.set(c.model, (counts.get(c.model) || 0) + 1);
  let model = "";
  for (const [m, n] of counts) if (!model || n > (counts.get(model) || 0)) model = m;
  const items = [];
  let excluded = 0;
  for (const [docId, c] of cents) {
    if (c.model !== model) { excluded++; continue; }
    items.push({ id: docId, vec: c.vec, title: c.title || docId, kind: c.docKind || "doc", snippet: "", blocks: c.blocks || 0 });
  }
  if (excluded) console.warn(`[starmap] ${excluded} doc(s) excluded: embedding model ≠ ${model}`);
  const tags = new Map();
  try {
    const index = JSON.parse(fs.readFileSync(path.join(library.LIBRARY_DIR, "index.json"), "utf-8"));
    for (const e of index) tags.set(e.docId, (e.tags || []).map((t) => (typeof t === "string" ? t : t.name)));
  } catch { /* no index yet */ }
  return { items, model, tags };
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
  const setLabel = (s) => { if (job) { job.label = s; if (emitUpdate) emitUpdate(job); } };

  const { items, model, tags } = gather(source);
  setLabel(`星图:读取 ${items.length} 个向量…`);
  if (!items.length) {
    const empty = { source, n: 0, model, builtAt: Date.now(), clusters: [], docs: [] };
    fs.writeFileSync(starmapPath(source), JSON.stringify(empty));
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
      // top-3 semantic neighbours (indices into docs) — the frontend draws these
      // as constellation edges on hover/selection and as "related" chips.
      ...(nn && nn[i] && nn[i].length ? { nn: nn[i] } : {}),
    }));
    const result = { source, n: docs.length, model, builtAt: Date.now(), clusters, docs };
    fs.writeFileSync(starmapPath(source), JSON.stringify(result));
    return { source, n: docs.length };
  } finally {
    try { fs.unlinkSync(inPath); } catch { /* ignore */ }
  }
}

// Current number of mappable items for a source — the cheap staleness signal (a cache
// built for N docs is out of date once the library holds a different count). library →
// index.json length; archive → embeddings index size.
function currentCount(source) {
  try {
    if (source === "archive") return Object.keys(embed.loadArchiveEmbeddings().items || {}).length;
    return JSON.parse(fs.readFileSync(path.join(library.LIBRARY_DIR, "index.json"), "utf-8")).length;
  } catch { return 0; }
}

// HTTP: return the cached map for a source (POST /api/library/starmap { source }).
// Missing cache → { stale: true } so the frontend can prompt "build the star map".
// Present but built for a different doc count → still returned (so the user sees the
// old map) with { outdated: true, currentN } so the UI can offer a rebuild.
async function serveStarmap(req, res) {
  let body; try { body = await readBody(req); } catch { body = {}; }
  const source = SOURCES.has(body && body.source) ? body.source : "library";
  try {
    const cached = JSON.parse(fs.readFileSync(starmapPath(source), "utf-8"));
    const now = currentCount(source);
    if (now !== cached.n) { cached.outdated = true; cached.currentN = now; }
    sendJson(res, 200, cached);
  } catch {
    sendJson(res, 200, { source, stale: true, n: 0, docs: [], clusters: [] });
  }
}

module.exports = { computeStarmap, serveStarmap, starmapPath, SOURCES };
