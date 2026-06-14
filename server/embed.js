const fs = require("fs");
const path = require("path");
const config = require("./config");
const { sendJson, readBody } = require("./utils");
const { readArchiveFile, scanArchiveFilenames } = require("./archive");

const DEFAULT_MODEL = "qwen3-embedding:0.6b";
const MAX_TEXT = 2000;   // chars per archive fed to the embedder
const BATCH = 4;         // keep batches small — long diverse text can crash the runner

function indexPath() { return path.join(config.ARCHIVES_DIR, ".hk-embeddings.json"); }

function loadIndex() {
  try { return JSON.parse(fs.readFileSync(indexPath(), "utf-8")); }
  catch { return { model: null, items: {} }; }
}
function saveIndex(idx) {
  try { fs.writeFileSync(indexPath(), JSON.stringify(idx)); } catch {}
}

// Representative text for one archive: title + message contents, truncated.
function archiveText(filename) {
  try {
    const data = JSON.parse(readArchiveFile(path.join(config.ARCHIVES_DIR, filename)));
    const parts = [data.title || ""];
    for (const m of (data.messages || [])) {
      if ((m.role !== "user" && m.role !== "assistant") || m.isFilePreview) continue;
      if (m.content) parts.push(m.content);
    }
    return parts.join("\n").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
  } catch { return ""; }
}

function hashText(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return `${s.length}:${h}`;
}

async function embedBatch(texts, model) {
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

  let idx = loadIndex();
  if (idx.model && idx.model !== model) idx = { model, items: {} }; // model changed → full rebuild
  idx.model = model;
  if (!idx.items) idx.items = {};

  const files = scanArchiveFilenames();
  for (const f of Object.keys(idx.items)) { if (!files.includes(f)) delete idx.items[f]; } // prune deleted

  const texts = {};
  const todo = [];
  for (const f of files) {
    const txt = archiveText(f);
    texts[f] = txt;
    if (!idx.items[f] || idx.items[f].hash !== hashText(txt)) todo.push(f);
  }

  send({ status: "start", total: files.length, todo: todo.length });
  if (todo.length === 0) { saveIndex(idx); send({ status: "done", indexed: files.length }); res.end(); return; }

  let done = 0, failed = 0;
  // Embed one item; store its vector. Returns true on success.
  async function embedOne(f) {
    try {
      const [vec] = await embedBatch([texts[f] || " "], model);
      if (vec) { idx.items[f] = { hash: hashText(texts[f]), vector: vec }; return true; }
    } catch { /* counted as failed below */ }
    return false;
  }

  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    try {
      const vectors = await embedBatch(batch.map((f) => texts[f] || " "), model);
      batch.forEach((f, j) => {
        if (vectors[j]) idx.items[f] = { hash: hashText(texts[f]), vector: vectors[j] };
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
  if (entries.length === 0 || (idx.model && idx.model !== model)) {
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
      .map(([file, v]) => ({ file, score: cosine(qvec, v.vector) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 50);
    sendJson(res, 200, { results: scored });
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
}

module.exports = { buildArchiveIndex, semanticSearchArchives };
