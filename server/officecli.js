// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

// officecli bridge — read AND write .docx / .xlsx / .pptx with neither Microsoft Office
// nor LibreOffice installed (https://github.com/iOfficeAI/OfficeCLI, Apache-2.0, ~19 MB
// single binary). Optional like every other sidecar here: absent → callers degrade.
//   read  : view text/outline/stats/issues, plus per-page PNG rendering. render-slides.js
//           uses it as the pptx fallback and as the ONLY docx page renderer.
//   write : create + batch + merge — the first path in hey-koko that PRODUCES Office
//           files instead of only parsing them.
//
// Three traps this module exists to hide (all reproduced on v1.0.144 / macOS):
//  1. Resident mode. Any command may leave an `__resident-serve__` process holding the
//     file, and its disk write is deferred until 2-10s after that process goes idle — a
//     non-officecli reader meanwhile sees the PRE-edit bytes. We pin
//     OFFICECLI_RESIDENT_FLUSH=each and still `close` the file in a finally.
//  2. `success: true` is not proof of a write. `import <file> <sheet> data.csv` reports
//     "Imported 3 rows x 3 cols" and leaves a workbook with zero cells. Every write goes
//     through verifyWrite(), which re-reads `view stats` and refuses to call an empty
//     document a success.
//  3. One command per file at a time; concurrent ones fail with `file_locked`. Commands
//     are serialized per absolute path.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const config = require("./config");
const { sendJson, readBody } = require("./utils");
const { guideFor, FORMAT_NAMES } = require("./office-guide");   // the authoring guide /doc loads into a conversation

const EXTS = new Set([".docx", ".xlsx", ".pptx"]);
const OFFICE_DIR = path.join(config.DATA_DIR, "office");   // generated documents live here
const DEFAULT_TIMEOUT_MS = 120000;

function findBin() {
  // An explicit OFFICECLI_BIN still has to exist: the version probe below is async, so a
  // path that is simply wrong would otherwise read as "available" to every caller until it
  // came back.
  if (process.env.OFFICECLI_BIN) {
    try { if (fs.existsSync(process.env.OFFICECLI_BIN)) return process.env.OFFICECLI_BIN; } catch { /* fall through */ }
    console.log(`[officecli] OFFICECLI_BIN=${process.env.OFFICECLI_BIN} does not exist — ignoring`);
    return "";
  }
  const candidates = [
    "/opt/homebrew/bin/officecli", "/usr/local/bin/officecli", "/usr/bin/officecli",
    path.join(os.homedir(), ".officecli", "bin", "officecli"),
    path.join(os.homedir(), ".local", "bin", "officecli"),
  ];
  for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch { /* keep looking */ } }
  try {
    const { execFileSync } = require("child_process");
    const finder = process.platform === "win32" ? "where" : "which";
    const first = execFileSync(finder, ["officecli"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .trim().split(/\r?\n/)[0];
    if (first) return first;
  } catch { /* not on PATH */ }
  return "";
}

let binPath = findBin();
let binVersion = "";

(function detect() {
  if (!binPath) { console.log("[officecli] not found — Office read/write/render via officecli disabled"); return; }
  execFile(binPath, ["--version"], { timeout: 15000 }, (err, stdout) => {
    if (err) { console.log(`[officecli] found at ${binPath} but --version failed (${err.message}); disabling`); binPath = ""; return; }
    binVersion = String(stdout || "").trim().split(/\r?\n/)[0];
    console.log(`[officecli] available (${binPath}, v${binVersion})`);
  });
})();

const available = () => !!binPath;

// ---- command runner ----

// Every officecli invocation goes through here: --json is always appended, the resident
// flush policy is pinned, and the JSON envelope { success, data, error, warnings } is
// normalized to { ok, data, code, message, warnings }. Never throws.
function run(args, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    if (!binPath) return resolve({ ok: false, code: "unavailable", message: "officecli not installed" });
    const argv = args.concat(["--json"]);
    execFile(binPath, argv, {
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      // "each" makes every command flush to disk before returning. Without it a write is
      // only in the resident's memory for another 2-10s, and anything reading the file
      // directly (our own fs.readFileSync, the browser download, a parser) gets stale bytes.
      env: { ...process.env, OFFICECLI_RESIDENT_FLUSH: "each" },
    }, (err, stdout, stderr) => {
      let env = null;
      try { env = JSON.parse(String(stdout || "")); } catch { /* not JSON — handled below */ }
      if (env && typeof env === "object" && "success" in env) {
        const warnings = Array.isArray(env.warnings) ? env.warnings.map((w) => (w && w.message) || String(w)) : [];
        if (env.success) return resolve({ ok: true, data: env.data, warnings });
        const e = env.error || {};
        // `data` rides along on failures too: a rejected batch puts its per-item errors
        // there, and those are the only useful thing to show (see batch()).
        return resolve({ ok: false, code: e.code || "error", message: e.error || e.message || "officecli failed", data: env.data, warnings });
      }
      const detail = String(stderr || "").trim() || (err && err.message) || "no JSON on stdout";
      resolve({ ok: false, code: err && err.killed ? "timeout" : "bad_output", message: detail });
    });
  });
}

// ---- per-file serialization ----
// Two commands on one file race into `file_locked`, so queue them per absolute path.
const chains = new Map();
function withFile(file, fn) {
  const key = path.resolve(file);
  const prev = chains.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  chains.set(key, next.catch(() => {}));
  next.finally(() => { if (chains.get(key) === next) chains.delete(key); }).catch(() => {});
  return next;
}

// Release the resident holding `file` (best-effort; a no-op when none is running).
const closeFile = (file) => run(["close", file], { timeoutMs: 30000 });

// ---- read side ----

const viewModes = new Set(["text", "annotated", "outline", "stats", "issues", "html", "svg", "forms"]);

async function view(file, mode, extra = [], opts = {}) {
  if (!viewModes.has(mode)) return { ok: false, code: "invalid_mode", message: `unknown view mode ${mode}` };
  return withFile(file, async () => {
    try { return await run(["view", file, mode, ...extra], opts); }
    finally { await closeFile(file); }
  });
}

const stats = (file) => view(file, "stats");

// Does this document actually contain anything? officecli reports success on writes that
// silently did nothing (trap 2), so every write path re-reads the document and asks here.
function isNonEmpty(st) {
  if (!st || typeof st !== "object") return false;
  if ("slides" in st) return Number(st.slides) > 0;
  if ("paragraphs" in st) return Number(st.paragraphs) > 0 || Number(st.totalCharacters) > 0;
  if ("sheets" in st) return Number(st.totalCells) > 0;
  return false;
}

// ---- page rendering ----

// Total page/slide count, taken from the "[pages] total=N" warning a screenshot emits.
// docx has no cheap page count otherwise (officecli's stats page-count needs Word+Windows).
function totalFromWarnings(warnings) {
  for (const w of warnings || []) {
    const m = /total=(\d+)/.exec(String(w));
    if (m) return parseInt(m[1], 10);
  }
  return 0;
}

// Render each page of a .pptx/.docx to a PNG → [{page, base64, mime}]. [] on any failure —
// callers treat page images as best-effort enrichment. One officecli call per page (~2.6s
// each on an M-series Mac), so maxPages is a real cost cap, not a formality.
async function renderPages(file, { maxPages = 80, width = 1600, height = 1200, timeoutMs = 300000 } = {}) {
  if (!binPath) return [];
  const ext = path.extname(file).toLowerCase();
  if (ext !== ".pptx" && ext !== ".docx") return [];
  return withFile(file, async () => {
    let tmp;
    try { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "officecli-render-")); } catch { return []; }
    const cleanup = () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ } };
    const shot = async (page) => {
      const out = path.join(tmp, `p${page}.png`);
      const r = await run(["view", file, "screenshot", "--page", String(page), "-o", out,
        "--screenshot-width", String(width), "--screenshot-height", String(height)], { timeoutMs });
      return { r, out };
    };
    const images = [];
    try {
      const first = await shot(1);
      if (!first.r.ok) {
        console.log(`[officecli] render failed for ${path.basename(file)}: ${first.r.message}`);
        return [];
      }
      // Only page 1 knows the page count, so the loop bound comes from its warnings.
      const total = Math.min(totalFromWarnings(first.r.warnings) || 1, maxPages);
      const files = [first.out];
      for (let p = 2; p <= total; p++) {
        const { r, out } = await shot(p);
        if (!r.ok) break;   // partial deck beats none
        files.push(out);
      }
      files.forEach((f, i) => {
        try { images.push({ page: i + 1, base64: fs.readFileSync(f).toString("base64"), mime: "image/png" }); }
        catch { /* skip unreadable page */ }
      });
      return images;
    } finally {
      cleanup();
      await closeFile(file);
    }
  });
}

// One contact sheet of every page (a single call, ~2.6s for a small deck) → {base64, mime}
// or null. Cheap enough to use as a deck cover; renderPages() is the per-page path.
async function renderGrid(file, { cols = 0, width = 1600, timeoutMs = 300000 } = {}) {
  if (!binPath) return null;
  return withFile(file, async () => {
    let tmp;
    try { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "officecli-grid-")); } catch { return null; }
    const out = path.join(tmp, "grid.png");
    try {
      const args = ["view", file, "screenshot", "--grid", ...(cols > 0 ? [String(cols)] : []),
        "-o", out, "--screenshot-width", String(width)];
      const r = await run(args, { timeoutMs });
      if (!r.ok) return null;
      return { base64: fs.readFileSync(out).toString("base64"), mime: "image/png" };
    } catch { return null; }
    finally {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
      await closeFile(file);
    }
  });
}

// ---- write side ----

// `create` refuses to overwrite (code file_exists) and refuses a path a resident still
// pins (file_locked); the documented reliable idiom is close → rm → create.
async function create(file) {
  await closeFile(file);
  try { if (fs.existsSync(file)) fs.rmSync(file); } catch { /* create will report it */ }
  return run(["create", file]);
}

// Apply a batch script (array of {command, ...} objects) in one open/save cycle. The array
// goes through a temp --input file rather than argv: decks run to hundreds of items.
async function batch(file, commands, opts = {}) {
  if (!Array.isArray(commands) || !commands.length) return { ok: false, code: "empty_batch", message: "no commands" };
  let tmp;
  try { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "officecli-batch-")); } catch { return { ok: false, code: "tmp_failed", message: "cannot create temp dir" }; }
  const input = path.join(tmp, "batch.json");
  try {
    fs.writeFileSync(input, JSON.stringify(commands));
    const r = await run(["batch", file, "--input", input], opts);
    if (r.ok) return r;
    // A rejected batch answers with a generic top-level error and the real reasons one
    // level down, per item. Surfacing them matters: this text is what the model reads in
    // order to fix its own ```office block.
    const failed = ((r.data && r.data.results) || []).filter((x) => x && x.success === false);
    if (!failed.length) return r;
    const lines = failed.slice(0, 8).map((f) => `#${(f.index ?? 0) + 1} ${f.item?.command || "?"} ${f.item?.path || f.item?.parent || ""}: ${f.error || f.code}`);
    const more = failed.length > lines.length ? ` (+${failed.length - lines.length} more)` : "";
    const rolledBack = r.data && r.data.summary && r.data.summary.atomicRolledBack;
    return {
      ok: false,
      code: failed[0].code || r.code,
      message: `${failed.length} of ${commands.length} operations failed${rolledBack ? " (all rolled back)" : ""}:\n${lines.join("\n")}${more}`,
      failures: failed.map((f) => ({ index: f.index, code: f.code, error: f.error, item: f.item })),
    };
  } catch (e) {
    return { ok: false, code: "batch_failed", message: e.message || String(e) };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

// Re-read a document we just wrote and refuse to call it a success when it came out empty
// (trap 2). Returns { verified, stats }.
async function verifyWrite(file) {
  const st = await stats(file);
  const data = st.ok ? st.data : null;
  return { verified: isNonEmpty(data), stats: data };
}

// Same filename shape the gallery uses for generated media: local-time YYYYMMDD-HHMMSS,
// then a readable stem. Non-ASCII (CJK) names are kept — every filesystem we target takes
// them — and only path-hostile characters are folded to "_".
function outputPath(name, format, dir) {
  const ext = String(format || "").toLowerCase().replace(/^\./, "");
  const d = new Date();
  const two = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
  const stem = String(name || "document").replace(/[\\/:*?"<>|#&%\s]+/g, "_").replace(/^[_.]+|_+$/g, "").slice(0, 60) || "document";
  let out = path.join(dir || OFFICE_DIR, `${stamp}_${stem}.${ext}`);
  // Two builds inside one second would otherwise collide on `create` (file_exists).
  for (let i = 2; fs.existsSync(out); i++) out = path.join(dir || OFFICE_DIR, `${stamp}_${stem}_${i}.${ext}`);
  return out;
}

// create → batch → verify, the whole write path in one call.
// Returns { ok, file, stats, pages? } / { ok:false, code, message }.
async function build({ format, commands, name, dir, preview = false, maxPages = 12 } = {}) {
  const ext = `.${String(format || "").toLowerCase().replace(/^\./, "")}`;
  if (!EXTS.has(ext)) return { ok: false, code: "unsupported_type", message: `format must be one of ${[...EXTS].join(", ")}` };
  if (!available()) return { ok: false, code: "unavailable", message: "officecli not installed" };
  const target = dir || OFFICE_DIR;
  try { fs.mkdirSync(target, { recursive: true }); } catch { /* create will fail loudly */ }
  const file = outputPath(name, ext, target);

  const result = await withFile(file, async () => {
    try {
      const c = await create(file);
      if (!c.ok) return { ok: false, code: c.code, message: c.message };
      const b = await batch(file, commands);
      if (!b.ok) return { ok: false, code: b.code, message: b.message, failures: b.failures };
      return { ok: true };
    } finally {
      await closeFile(file);   // flush + release before anyone reads the bytes (trap 1)
    }
  });
  if (!result.ok) { try { fs.rmSync(file, { force: true }); } catch { /* best-effort */ } return result; }

  const { verified, stats: st } = await verifyWrite(file);
  if (!verified) {
    // Discard the corpse: leaving a zero-content document in the output dir invites
    // someone downstream to treat it as a real artifact.
    try { fs.rmSync(file, { force: true }); } catch { /* best-effort */ }
    return { ok: false, code: "write_unverified", message: "officecli reported success but the document came out empty", stats: st };
  }
  const out = { ok: true, id: docIdOf(file), file, name: path.basename(file), stats: st, outline: await outline(file) };
  if (preview) out.pages = await renderPages(file, { maxPages });
  return out;
}

// Fill {{key}} placeholders in a template — the cheap path for report/deck generation:
// the model emits a flat JSON object and never touches document paths or XML.
async function merge({ template, data, name, dir, preview = false, maxPages = 12 } = {}) {
  if (!available()) return { ok: false, code: "unavailable", message: "officecli not installed" };
  const ext = path.extname(String(template || "")).toLowerCase();
  if (!EXTS.has(ext)) return { ok: false, code: "unsupported_type", message: "template must be .docx/.xlsx/.pptx" };
  if (!fs.existsSync(template)) return { ok: false, code: "file_not_found", message: `no such template: ${template}` };
  const target = dir || OFFICE_DIR;
  try { fs.mkdirSync(target, { recursive: true }); } catch { /* merge will fail loudly */ }
  const file = outputPath(name || path.basename(template, ext), ext, target);

  const r = await withFile(file, async () => {
    try { return await run(["merge", template, file, "--data", JSON.stringify(data || {})]); }
    finally { await closeFile(file); }
  });
  if (!r.ok) return { ok: false, code: r.code, message: r.message };

  const { verified, stats: st } = await verifyWrite(file);
  if (!verified) {
    try { fs.rmSync(file, { force: true }); } catch { /* best-effort */ }
    return { ok: false, code: "write_unverified", message: "merge produced an empty document", stats: st };
  }
  const out = { ok: true, id: docIdOf(file), file, name: path.basename(file), stats: st };
  if (preview) out.pages = await renderPages(file, { maxPages });
  return out;
}

// ---- working copies, outlines, editing ----

// /doc never edits the file the user pointed at. It takes a COPY into ~/.hey-koko/office/
// and edits that, for two reasons: officecli needs a stable path (a dragged-in file only
// exists as bytes in the browser), and a document open in Word/PowerPoint would have our
// edits overwritten the next time the user saves. The original is left alone; the working
// copy is what gets downloaded at the end.
const docIdOf = (file) => path.basename(file);

// Resolve a working-copy id to its absolute path, refusing anything that tries to climb
// out of the output directory.
function resolveDoc(id) {
  const name = path.basename(String(id || ""));
  if (!name || name !== String(id || "")) return "";
  const abs = path.join(OFFICE_DIR, name);
  if (!abs.startsWith(OFFICE_DIR + path.sep)) return "";
  if (!EXTS.has(path.extname(abs).toLowerCase())) return "";
  try { return fs.statSync(abs).isFile() ? abs : ""; } catch { return ""; }
}

// A compact, path-carrying map of the document — what the model needs in order to target
// an edit. Deliberately not `view annotated`/`html`: those run to tens of thousands of
// characters, and the conversation has to hold this.
async function outline(file, { maxItems = 200 } = {}) {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".pptx") {
    // Slides come from `view text`; the per-SHAPE paths an edit needs only exist in a
    // query, so the two are merged into one slide-ordered listing.
    const [txt, shapes] = await Promise.all([view(file, "text"), withFile(file, async () => {
      try { return await run(["query", file, "shape"]); } finally { await closeFile(file); }
    })]);
    const bySlide = new Map();
    for (const r of (shapes.ok && shapes.data && shapes.data.results) || []) {
      const m = /^\/slide\[(\d+)\]/.exec(r.path || "");
      if (!m) continue;
      const n = parseInt(m[1], 10);
      if (!bySlide.has(n)) bySlide.set(n, []);
      bySlide.get(n).push({ path: r.path, type: r.type || "shape", text: String(r.text || "").slice(0, 300) });
    }
    const slides = ((txt.ok && txt.data && txt.data.slides) || []).slice(0, maxItems).map((sl) => ({
      slide: sl.index, path: sl.path, shapes: bySlide.get(sl.index) || [],
    }));
    return { kind: "slides", count: (txt.ok && txt.data && txt.data.totalSlides) || slides.length, slides };
  }
  if (ext === ".docx") {
    const txt = await view(file, "text");
    const els = ((txt.ok && txt.data && txt.data.elements) || []).slice(0, maxItems).map((e) => ({
      path: e.path, type: e.type || "paragraph", text: String(e.text || "").slice(0, 300),
    }));
    return { kind: "paragraphs", count: (txt.ok && txt.data && txt.data.totalElements) || els.length, elements: els };
  }
  const txt = await view(file, "text");
  return { kind: "sheets", sheets: (txt.ok && txt.data && txt.data.sheets) || [] };
}

// Take a working copy of an existing document (from a path on disk or from uploaded
// bytes) and describe it. Returns { ok, id, name, format, stats, outline, pages? }.
async function openDoc({ path: srcPath, b64, name, preview = false, maxPages = 12 } = {}) {
  if (!available()) return { ok: false, code: "unavailable", message: "officecli not installed" };
  let ext = path.extname(String(name || srcPath || "")).toLowerCase();
  if (!EXTS.has(ext)) return { ok: false, code: "unsupported_type", message: "expected a .docx/.xlsx/.pptx file" };
  let buf;
  if (b64) {
    try { buf = Buffer.from(String(b64).replace(/^data:[^,]+,/, ""), "base64"); } catch { return { ok: false, code: "bad_payload" }; }
  } else if (srcPath) {
    try { buf = fs.readFileSync(srcPath); } catch { return { ok: false, code: "file_not_found", message: `cannot read ${srcPath}` }; }
  } else {
    return { ok: false, code: "file_required", message: "give a path or file bytes" };
  }
  if (!buf.length) return { ok: false, code: "bad_payload", message: "empty file" };
  try { fs.mkdirSync(OFFICE_DIR, { recursive: true }); } catch { /* the write below reports it */ }
  const stem = path.basename(String(name || srcPath), ext);
  const file = outputPath(stem, ext, OFFICE_DIR);
  try { fs.writeFileSync(file, buf); } catch (e) { return { ok: false, code: "write_failed", message: e.message }; }

  const st = await stats(file);
  if (!st.ok) { try { fs.rmSync(file, { force: true }); } catch { /* best-effort */ } return { ok: false, code: st.code, message: st.message }; }
  const out = {
    ok: true, id: docIdOf(file), file, name: `${stem}${ext}`, format: ext.slice(1),
    stats: st.data, outline: await outline(file),
  };
  if (preview) out.pages = await renderPages(file, { maxPages });
  return out;
}

// Apply a batch to an existing working copy. Same verify-then-report discipline as build:
// a batch that "succeeds" into an empty document is a failure.
async function editDoc({ id, commands, preview = false, maxPages = 12 } = {}) {
  if (!available()) return { ok: false, code: "unavailable", message: "officecli not installed" };
  const file = resolveDoc(id);
  if (!file) return { ok: false, code: "file_not_found", message: `unknown document ${id}` };
  if (!Array.isArray(commands) || !commands.length) return { ok: false, code: "empty_batch", message: "no commands" };

  // A rejected batch can leave the document half-edited, so keep the pre-edit bytes and
  // roll back rather than handing back something the user did not ask for.
  let backup = null;
  try { backup = fs.readFileSync(file); } catch { /* proceed without a rollback option */ }

  const r = await withFile(file, async () => {
    try { return await batch(file, commands); }
    finally { await closeFile(file); }
  });
  const restore = () => { if (backup) { try { fs.writeFileSync(file, backup); } catch { /* best-effort */ } } };
  if (!r.ok) { restore(); return { ok: false, code: r.code, message: r.message, failures: r.failures }; }

  const { verified, stats: st } = await verifyWrite(file);
  if (!verified) { restore(); return { ok: false, code: "write_unverified", message: "the edit emptied the document; it was rolled back", stats: st }; }

  const out = { ok: true, id: docIdOf(file), file, stats: st, outline: await outline(file) };
  if (preview) out.pages = await renderPages(file, { maxPages });
  return out;
}

// ---- request handlers ----

// Reject anything that is not an existing Office document. This is a localhost personal
// app (the same trust level as /tool @word reading whatever is open), so any path is
// allowed — but only these three extensions, and only files that exist.
function checkFile(p) {
  const f = String(p || "");
  if (!f) return "file_required";
  if (!EXTS.has(path.extname(f).toLowerCase())) return "unsupported_type";
  try { if (!fs.statSync(f).isFile()) return "file_not_found"; } catch { return "file_not_found"; }
  return "";
}

// GET /api/officecli/status
function handleStatus(req, res) {
  sendJson(res, 200, {
    available: available(),
    version: binVersion,
    bin: binPath,
    formats: [...EXTS],
    outputDir: OFFICE_DIR,
  });
}

// POST /api/officecli/build { format, commands[], name?, preview?, maxPages? }
async function handleBuild(req, res) {
  let body = {};
  try { body = await readBody(req); } catch { /* treat as empty */ }
  const r = await build({
    format: body.format, commands: body.commands, name: body.name,
    preview: body.preview === true, maxPages: Number(body.maxPages) || 12,
  });
  sendJson(res, r.ok ? 200 : 400, r);
}

// POST /api/officecli/merge { template, data, name?, preview?, maxPages? }
async function handleMerge(req, res) {
  let body = {};
  try { body = await readBody(req); } catch { /* treat as empty */ }
  const r = await merge({
    template: body.template, data: body.data, name: body.name,
    preview: body.preview === true, maxPages: Number(body.maxPages) || 12,
  });
  sendJson(res, r.ok ? 200 : 400, r);
}

// POST /api/officecli/preview { file, maxPages?, width?, grid? }
async function handlePreview(req, res) {
  let body = {};
  try { body = await readBody(req); } catch { /* treat as empty */ }
  if (!available()) { sendJson(res, 400, { ok: false, code: "unavailable" }); return; }
  const bad = checkFile(body.file);
  if (bad) { sendJson(res, 400, { ok: false, code: bad }); return; }
  if (body.grid) {
    const g = await renderGrid(body.file, { cols: Number(body.grid) > 1 ? Number(body.grid) : 0, width: Number(body.width) || 1600 });
    sendJson(res, g ? 200 : 400, g ? { ok: true, grid: g } : { ok: false, code: "render_failed" });
    return;
  }
  const pages = await renderPages(body.file, { maxPages: Number(body.maxPages) || 12, width: Number(body.width) || 1600 });
  sendJson(res, 200, { ok: true, pages, count: pages.length });
}

// POST /api/officecli/read { file, mode?, range?, maxLines? }
async function handleRead(req, res) {
  let body = {};
  try { body = await readBody(req); } catch { /* treat as empty */ }
  if (!available()) { sendJson(res, 400, { ok: false, code: "unavailable" }); return; }
  const bad = checkFile(body.file);
  if (bad) { sendJson(res, 400, { ok: false, code: bad }); return; }
  const mode = String(body.mode || "text");
  const extra = [];
  if (body.range) extra.push("--range", String(body.range));
  if (body.maxLines) extra.push("--max-lines", String(Number(body.maxLines)));
  const r = await view(body.file, mode, extra);
  sendJson(res, r.ok ? 200 : 400, r.ok ? { ok: true, mode, data: r.data } : { ok: false, code: r.code, message: r.message });
}

// POST /api/officecli/open { path } | { b64, name }
async function handleOpen(req, res) {
  let body = {};
  try { body = await readBody(req); } catch { /* treat as empty */ }
  const r = await openDoc({
    path: body.path, b64: body.b64, name: body.name,
    preview: body.preview === true, maxPages: Number(body.maxPages) || 12,
  });
  sendJson(res, r.ok ? 200 : 400, r);
}

// POST /api/officecli/edit { id, commands[], preview?, maxPages? }
async function handleEdit(req, res) {
  let body = {};
  try { body = await readBody(req); } catch { /* treat as empty */ }
  const r = await editDoc({
    id: body.id, commands: body.commands,
    preview: body.preview === true, maxPages: Number(body.maxPages) || 12,
  });
  sendJson(res, r.ok ? 200 : 400, r);
}

// GET /api/officecli/file/<id> — download a working copy.
function handleFile(req, res) {
  const id = decodeURIComponent(String(req.url).replace(/^.*\/file\//, "").split("?")[0]);
  const file = resolveDoc(id);
  if (!file) { sendJson(res, 404, { ok: false, code: "file_not_found" }); return; }
  const mime = {
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  }[path.extname(file).toLowerCase()];
  try {
    const buf = fs.readFileSync(file);
    res.writeHead(200, {
      "Content-Type": mime,
      "Content-Length": buf.length,
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`,
    });
    res.end(buf);
  } catch { sendJson(res, 404, { ok: false, code: "file_not_found" }); }
}

// GET /api/officecli/guide?format=pptx — the authoring guide /doc loads into the chat.
function handleGuide(req, res) {
  const format = (String(req.url).match(/[?&]format=([a-z]+)/i) || [])[1] || "";
  const text = guideFor(format);
  if (!text) { sendJson(res, 400, { ok: false, code: "unsupported_type", formats: FORMAT_NAMES }); return; }
  sendJson(res, 200, { ok: true, format, guide: text });
}

module.exports = {
  available, run, view, stats, renderPages, renderGrid, create, batch, build, merge,
  openDoc, editDoc, outline, resolveDoc, docIdOf,
  verifyWrite, closeFile, isNonEmpty, OFFICE_DIR,
  handleStatus, handleBuild, handleMerge, handlePreview, handleRead,
  handleOpen, handleEdit, handleFile, handleGuide,
  _bin: () => binPath,   // tests
};
