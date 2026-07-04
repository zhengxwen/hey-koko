// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

const fs = require("fs");
const path = require("path");
const config = require("./config");
const { sendJson, readBody } = require("./utils");
const { readArchiveFile, scanArchiveFilenames } = require("./archive");
const { encodeVectors, decodeVectors } = require("./vecfile");
const openai = require("./openai");

const DEFAULT_MODEL = "qwen3-embedding:8b";

// The SAME underlying embedding model can appear under different provider names —
// local Ollama `qwen3-embedding:8b` vs OpenRouter `qwen/qwen3-embedding-8b` are
// byte-compatible vector spaces. Collapse them to ONE canonical id (the LOCAL
// Ollama name) so the .vec index — which records the model to guard the vector
// space — treats them as identical and switching backend does NOT force a full
// re-embed. IMPORTANT: only STORAGE and vector-space COMPARISON use the canonical
// name; the RAW selected name is still what routes the embed call (local vs cloud)
// and what gets sent to the API.
const EMBED_ALIASES = {
  "qwen/qwen3-embedding-8b": "qwen3-embedding:8b",
  "qwen/qwen3-embedding-4b": "qwen3-embedding:4b",
  "qwen/qwen3-embedding-0.6b": "qwen3-embedding:0.6b",
};
function canonicalEmbedModel(model) {
  if (!model) return model;
  return EMBED_ALIASES[String(model).toLowerCase()] || model;
}
const MAX_TEXT = 2000;   // chars per archive fed to the embedder
const BATCH = 4;         // keep batches small — long diverse text can crash the runner

// The index is split like the library: a small JSON of metadata (model, per-archive
// hash/title/snippet + the vector ORDER) beside a compact binary .vec (HKV1: header +
// model name + fp32, zstd-compressed) holding the vectors. In-memory shape is unchanged
// ({ model, items:{ file:{hash,title,snippet,vector} } }) so the build/search code below
// doesn't care how it's persisted.
function metaPath() { return path.join(config.ARCHIVES_DIR, ".hk-embeddings.json"); }
function vecPath() { return path.join(config.ARCHIVES_DIR, ".hk-embeddings.vec"); }

function loadIndex() {
  let meta;
  try { meta = JSON.parse(fs.readFileSync(metaPath(), "utf-8")); }
  catch { return { model: null, items: {} }; }
  const items = meta.items || {};
  if (Array.isArray(meta.order)) {
    // New format: vectors live in the sibling .vec, aligned to `order`.
    let vecs = [];
    try { vecs = decodeVectors(fs.readFileSync(vecPath())).vectors; } catch { /* missing/corrupt → treat as un-embedded */ }
    meta.order.forEach((f, i) => { if (items[f] && vecs[i]) items[f].vector = vecs[i]; });
  }
  // Old format (inline `vector` arrays on each item) is read as-is; it migrates to the
  // split format automatically on the next saveIndex — no re-embedding needed.
  return { model: meta.model || null, items };
}

function saveIndex(idx) {
  try {
    const model = idx.model || DEFAULT_MODEL;
    // Persist only items that actually have a vector; keep meta/order/.vec aligned.
    const order = Object.keys(idx.items).filter((f) => idx.items[f] && idx.items[f].vector);
    fs.writeFileSync(vecPath(), encodeVectors(order.map((f) => idx.items[f].vector), model));
    const items = {};
    for (const f of order) { const it = idx.items[f]; items[f] = { hash: it.hash, title: it.title, snippet: it.snippet }; }
    fs.writeFileSync(metaPath(), JSON.stringify({ model: idx.model, order, items }));
  } catch {}
}

// Representative text + metadata for one archive.
function archiveMeta(filename) {
  try {
    const data = JSON.parse(readArchiveFile(path.join(config.ARCHIVES_DIR, filename)));
    const title = data.title || "";
    const parts = [title];
    for (const m of (data.messages || [])) {
      if ((m.role !== "user" && m.role !== "assistant") || m.isFilePreview) continue;
      if (m.content) parts.push(m.content);
    }
    const text = parts.join("\n").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
    return { text, title, snippet: text.slice(0, 200) };
  } catch { return { text: "", title: filename, snippet: "" }; }
}

function hashText(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return `${s.length}:${h}`;
}

async function embedBatch(texts, model) {
  // Cloud embedding model (allowlisted in openai.json/openrouter.json) → route to
  // /v1/embeddings; anything else → local Ollama. Routing uses the RAW name.
  if (openai.isCloudEmbedModel(model)) return openai.embed(model, texts);
  const res = await fetch(`${config.ollamaUrl}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, input: texts }),
  });
  if (!res.ok) throw new Error(`embed HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return data.embeddings || [];
}

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

// Build / refresh the archive embedding index (streams ndjson progress).
async function buildArchiveIndex(req, res) {
  let body; try { body = await readBody(req); } catch { body = {}; }
  const model = body.model || DEFAULT_MODEL;

  res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" });
  const send = (o) => { try { res.write(JSON.stringify(o) + "\n"); } catch {} };

  // Store/compare the CANONICAL name so switching between the local and cloud
  // build of the same model doesn't invalidate the index (embedBatch below still
  // gets the raw `model` to route local vs cloud).
  const canon = canonicalEmbedModel(model);
  let idx = loadIndex();
  if (idx.model && canonicalEmbedModel(idx.model) !== canon) idx = { model: canon, items: {} }; // model changed → full rebuild
  idx.model = canon;
  if (!idx.items) idx.items = {};

  const files = scanArchiveFilenames();
  for (const f of Object.keys(idx.items)) { if (!files.includes(f)) delete idx.items[f]; } // prune deleted

  const metas = {};
  const todo = [];
  for (const f of files) {
    const meta = archiveMeta(f);
    metas[f] = meta;
    const h = hashText(meta.text);
    // Re-embed if new/changed; also backfill title/snippet onto older index entries.
    if (!idx.items[f] || idx.items[f].hash !== h) todo.push(f);
    else if (idx.items[f].title === undefined) { idx.items[f].title = meta.title; idx.items[f].snippet = meta.snippet; }
  }

  send({ status: "start", total: files.length, todo: todo.length });
  if (todo.length === 0) { saveIndex(idx); send({ status: "done", indexed: files.length }); res.end(); return; }

  let done = 0, failed = 0;
  // Embed one item; store its vector. Returns true on success.
  const store = (f, vec) => { idx.items[f] = { hash: hashText(metas[f].text), vector: vec, title: metas[f].title, snippet: metas[f].snippet }; };
  async function embedOne(f) {
    try {
      const [vec] = await embedBatch([metas[f].text || " "], model);
      if (vec) { store(f, vec); return true; }
    } catch { /* counted as failed below */ }
    return false;
  }

  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    try {
      const vectors = await embedBatch(batch.map((f) => metas[f].text || " "), model);
      batch.forEach((f, j) => {
        if (vectors[j]) store(f, vectors[j]);
        else failed++;
      });
    } catch {
      // Batch crashed the runner — retry each item alone so one big archive can't block the rest.
      for (const f of batch) { if (!(await embedOne(f))) failed++; }
    }
    done += batch.length;
    saveIndex(idx);
    send({ status: "progress", done, todo: todo.length });
  }
  send({ status: "done", indexed: Object.keys(idx.items).length, failed });
  res.end();
}

// Semantic search over the archive index.
async function semanticSearchArchives(req, res) {
  let body; try { body = await readBody(req); } catch { sendJson(res, 400, { error: "invalid body" }); return; }
  const query = (body.query || "").trim();
  const model = body.model || DEFAULT_MODEL;
  if (!query) { sendJson(res, 400, { error: "query required" }); return; }

  const idx = loadIndex();
  const entries = Object.entries(idx.items || {});
  if (entries.length === 0 || (idx.model && canonicalEmbedModel(idx.model) !== canonicalEmbedModel(model))) {
    sendJson(res, 200, { needsIndex: true, results: [] });
    return;
  }

  try {
    // Qwen3-Embedding retrieves better when the query carries a task instruction
    // (documents stay raw). Only apply for qwen models.
    const qtext = /qwen/i.test(model)
      ? `Instruct: Given a search query, retrieve the relevant past conversation.\nQuery: ${query}`
      : query;
    const [qvec] = await embedBatch([qtext], model);
    if (!qvec) { sendJson(res, 500, { error: "embed failed" }); return; }
    const scored = entries
      .map(([file, v]) => ({ file, score: cosine(qvec, v.vector), title: v.title || file, snippet: v.snippet || "" }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 50);
    sendJson(res, 200, { results: scored });
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
}

module.exports = { buildArchiveIndex, semanticSearchArchives, embedBatch, cosine, hashText, DEFAULT_MODEL, canonicalEmbedModel, loadArchiveEmbeddings: loadIndex };