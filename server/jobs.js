// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

// Option B: SERVER-SIDE persistent background-job queue for GENERATION (image /
// video / audio) and LIBRARY IMPORTS (kind "libimport": fetch/whisper/parse →
// chunk+embed → distill card). The queue + execution live here, not in the browser,
// so jobs survive page reload / sleep and are shared across clients. The browser
// submits a job spec, subscribes to status + result over SSE, and reattaches the
// result into its conversation by (conversationId, msgId).
//
// Execution is LOOPBACK: the runner POSTs the job's payload to this server's OWN
// already-self-contained /api/generate-comfy | /api/generate-image | /api/tts
// endpoint — so the heavy generation code is reused untouched.
//
// Lanes: one per ComfyUI endpoint (job.comfyUrl) + a shared 'local' lane (audio /
// Ollama image) + a 'lib' lane (library imports — a bulk import batch must never
// block image/video/TTS, and vice versa). Serial within a lane, parallel across.

const crypto = require("crypto");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const config = require("./config");
const { sendJson, readBody } = require("./utils");
const library = require("./library");
const zotero = require("./zotero");
const feeds = require("./feeds");
const renderSlides = require("./render-slides");

const JOBS_FILE = path.join(config.JOBS_DIR, "jobs.json");
// Library file imports spool their raw file here (payload carries the path) so N
// queued PDFs don't sit base64-inflated in queue memory AND in jobs.json.
const SPOOL_DIR = path.join(config.JOBS_DIR, "spool");

let jobs = [];                  // see job shape in submitJob()
const controllers = new Map();  // jobId -> AbortController (runtime only)
const activeLanes = new Set();  // laneId currently draining
const sseClients = new Set();   // SSE res objects

const laneOf = (job) => (job.kind === "libimport" || job.kind === "starmap") ? "lib" : (job.comfyUrl || "local");
function normUrl(u) { if (!u) return ""; return /^https?:\/\//i.test(u) ? u.replace(/\/+$/, "") : "http://" + u.replace(/\/+$/, ""); }

// ---- persistence (metadata only — result base64 stays in memory; a server
// restart drops in-flight results, but the primary durability goal is "browser
// closed while the server keeps running", where memory is retained) ------------
let _persistTimer = null;
function persist() {
  if (_persistTimer) return;
  _persistTimer = setTimeout(() => {
    _persistTimer = null;
    try {
      fs.mkdirSync(config.JOBS_DIR, { recursive: true });
      const clean = jobs.map(({ result, ...j }) => j);   // drop heavy result from disk
      fs.writeFileSync(JOBS_FILE, JSON.stringify(clean));
    } catch (e) { console.warn("[jobs] persist failed:", e.message); }
  }, 200);
}

// Undelivered-result durability: a finished job's (heavy) result is written to a per-job
// side file so it survives a SERVER restart, not just a browser close. jobs.json stays
// metadata-only. The file exists only from "done" until the client acks (delivers) it,
// then it's dropped — so disk usage is bounded by what's pending delivery.
const RESULTS_DIR = path.join(config.JOBS_DIR, "results");
function resultPath(id) { return path.join(RESULTS_DIR, `${id}.json`); }
function saveResult(job) {
  if (!job || !job.result) return;
  try { fs.mkdirSync(RESULTS_DIR, { recursive: true }); fs.writeFileSync(resultPath(job.id), JSON.stringify(job.result)); }
  catch (e) { console.warn("[jobs] saveResult failed:", e.message); }
}
function loadResult(id) {
  try { return JSON.parse(fs.readFileSync(resultPath(id), "utf-8")); } catch { return null; }
}
function dropResult(id) {
  try { fs.unlinkSync(resultPath(id)); } catch { /* not there → fine */ }
}
function load() {
  try {
    const arr = JSON.parse(fs.readFileSync(JOBS_FILE, "utf-8"));
    if (Array.isArray(arr)) {
      jobs = arr
        // running → interrupted (its in-flight work was lost on restart). queued/paused resume.
        .map((j) => j.status === "running" ? { ...j, status: "interrupted", progress: null } : j)
        // A 'done' job kept its result in a side file → re-attach so the SSE snapshot can
        // still deliver it after a restart; drop done jobs whose result file is gone.
        .map((j) => {
          if (j.status !== "done") return j;
          const r = loadResult(j.id);
          return r ? { ...j, result: r } : null;
        })
        .filter(Boolean);
    }
  } catch { jobs = []; }
  // Clean orphan result files (no matching undelivered 'done' job → already delivered / stale).
  try {
    const live = new Set(jobs.filter((j) => j.status === "done").map((j) => j.id));
    for (const f of fs.readdirSync(RESULTS_DIR)) {
      if (!live.has(f.replace(/\.json$/, ""))) dropResult(f.replace(/\.json$/, ""));
    }
  } catch { /* no results dir yet → nothing to clean */ }
  // Clean orphan spool files (no surviving job references them → the raw upload is
  // unreachable). Jobs reference their spool by PATH in payload.spool — a pre-uploaded
  // spool's name is a random uuid, NOT the job id, so never key this on job ids.
  try {
    const live = new Set(jobs.map((j) => (j.payload && j.payload.spool) ? path.basename(j.payload.spool) : ""));
    for (const f of fs.readdirSync(SPOOL_DIR)) {
      if (!live.has(f)) { try { fs.unlinkSync(path.join(SPOOL_DIR, f)); } catch {} }
    }
  } catch { /* no spool dir yet → nothing to clean */ }
}
function dropSpool(job) {
  const sp = job && job.payload && job.payload.spool;
  if (sp) { try { fs.unlinkSync(sp); } catch { /* already gone */ } }
}

// ---- SSE broadcast ----------------------------------------------------------
function publicJob(j) { const { _ctrl, ...rest } = j; return rest; }
function broadcast(event) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of sseClients) { try { res.write(data); } catch {} }
}
const emitUpdate = (job) => broadcast({ type: "update", job: publicJob(job) });

// ---- keep the host awake while the queue has work ---------------------------
// The runner lives on THIS machine's server (ComfyUI is remote, but the queue,
// the loopback POST and the result delivery are all local). So a SYSTEM sleep
// would suspend the runner even though the GPU box keeps rendering. While any job
// is queued or running we hold ONE child process that blocks system idle sleep;
// it's released the moment the queue drains, and self-exits if the server dies so
// a crash can never leave the machine pinned awake. Display/disk may still sleep.
//   macOS   → `caffeinate -i -w <pid>` (built in).
//   Windows → a PowerShell holding SetThreadExecutionState(ES_CONTINUOUS|ES_SYSTEM_REQUIRED);
//             that keep-awake state lasts as long as the calling thread lives, and
//             `Wait-Process -Id <pid>` releases it (thread exits) when the server pid
//             dies — mirroring caffeinate's `-w`.
//   Linux   → `systemd-inhibit` (systemd-logind, present on mainstream distros)
//             holds an inhibitor lock for as long as the wrapped command lives;
//             `tail --pid=<pid>` exits when the server pid dies, releasing the
//             lock — mirroring caffeinate's `-w`. Prefers `idle:sleep` (unlike
//             caffeinate's idle-only it also blocks desktop auto-suspend, which
//             may ignore logind idle inhibitors), but blocking sleep needs a
//             polkit approval that remote (SSH) sessions don't get — so probe
//             first and settle for idle-only there. The probed variant is
//             exec'd so the child IS systemd-inhibit and kill() releases it.
//             Non-systemd distros hit the spawn "error"/instant-exit handlers.
let _sleepGuard = null;
function spawnSleepGuard() {
  if (process.platform === "darwin") {
    return spawn("caffeinate", ["-i", "-w", String(process.pid)], { stdio: "ignore" });
  }
  if (process.platform === "win32") {
    // -EncodedCommand (base64 of UTF-16LE) so Windows arg-quoting can't mangle the
    // embedded C#. 2147483649 = 0x80000001 = ES_CONTINUOUS | ES_SYSTEM_REQUIRED
    // (PowerShell parses 0x80000001 as a negative Int32, hence the [uint32] decimal).
    const script =
      "Add-Type -Namespace Win -Name Power -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint e);'; " +
      "[Win.Power]::SetThreadExecutionState([uint32]2147483649) | Out-Null; " +
      `Wait-Process -Id ${process.pid} -ErrorAction SilentlyContinue`;
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    return spawn("powershell", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { stdio: "ignore", windowsHide: true });
  }
  if (process.platform === "linux") {
    const opts = "--who=hey-koko '--why=background jobs running' --mode=block";
    return spawn("sh", ["-c",
      `if systemd-inhibit --what=idle:sleep ${opts} true 2>/dev/null; then w=idle:sleep; else w=idle; fi; ` +
      `exec systemd-inhibit --what=$w ${opts} tail --pid=${process.pid} -f /dev/null`,
    ], { stdio: "ignore" });
  }
  return null;
}
function updateSleepGuard() {
  if (!["darwin", "win32", "linux"].includes(process.platform)) return; // no guard elsewhere
  const busy = jobs.some((j) => j.status === "queued" || j.status === "running");
  if (busy && !_sleepGuard) {
    try {
      _sleepGuard = spawnSleepGuard();
      if (_sleepGuard) {
        _sleepGuard.on("error", () => { _sleepGuard = null; }); // helper missing → ignore
        _sleepGuard.on("exit", () => { _sleepGuard = null; });
      }
    } catch { _sleepGuard = null; }
  } else if (!busy && _sleepGuard) {
    try { _sleepGuard.kill(); } catch {}
    _sleepGuard = null;
  }
}
process.on("exit", () => { try { _sleepGuard && _sleepGuard.kill(); } catch {} });

// ---- the per-lane runner (parallel across lanes) ----------------------------
function pumpLanes() {
  updateSleepGuard();
  const lanes = new Set(jobs.filter((j) => j.status === "queued").map(laneOf));
  for (const lane of lanes) if (!activeLanes.has(lane)) pumpLane(lane);   // not awaited → concurrent
}
async function pumpLane(laneId) {
  if (activeLanes.has(laneId)) return;
  activeLanes.add(laneId);
  try {
    let job;
    while ((job = jobs.find((j) => j.status === "queued" && laneOf(j) === laneId))) {
      job.status = "running";
      job.startedAt = Date.now();
      persist(); emitUpdate(job);
      try {
        job.result = await runJob(job);
        if (job.status === "running") { job.status = "done"; job.finishedAt = Date.now(); }
      } catch (e) {
        if (!(e && e.name === "AbortError")) { job.status = "error"; job.error = String((e && e.message) || e); }
      }
      controllers.delete(job.id);
      if (!jobs.includes(job)) continue;        // canceled mid-run (already removed + broadcast)
      if (job.status === "done") saveResult(job);   // durable until the client acks
      persist();
      broadcast(job.status === "done" ? { type: "done", job: publicJob(job) } : { type: "update", job: publicJob(job) });
    }
  } finally {
    activeLanes.delete(laneId);
    updateSleepGuard(); // lane drained → release the wake guard if nothing's left
  }
}

// LOOPBACK: run a job by calling our own self-contained generation endpoint.
async function runJob(job) {
  const ctrl = new AbortController();
  controllers.set(job.id, ctrl);

  if (job.kind === "audio") {
    const r = await loopbackPost("/api/tts", job.payload, ctrl.signal);
    let d = {}; try { d = JSON.parse(r.text); } catch {}
    if (!r.ok || !d.audio) throw new Error(d.error || "tts failed");
    return { audio: d.audio, mime: d.mime || "audio/wav" };
  }

  if (job.kind === "analyze") {                  // /api/chat (Ollama vision) → NDJSON stream
    const r = await loopbackPost("/api/chat", job.payload, ctrl.signal);
    if (!r.ok) { let d = {}; try { d = JSON.parse(r.text); } catch {} throw new Error(d.error || `analyze failed (${r.status})`); }
    let content = "";
    for (const line of r.text.split("\n")) {
      if (!line.trim()) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o.error) throw new Error(o.error);
      if (o.message && o.message.content) content += o.message.content;
    }
    return { content };
  }

  if (job.kind === "youtube") {                  // /api/youtube-job → streamed NDJSON (progress + done)
    let result = null, errored = null;
    await loopbackStream("/api/youtube-job", job.payload, ctrl.signal, (line) => {
      let o; try { o = JSON.parse(line); } catch { return; }
      if (o.type === "progress") {                // surface mid-run progress to the SSE clients
        if (o.stage) job.label = o.stage;         // raw stage; the browser maps it to an i18n label
        job.progress = o.progress || null;
        emitUpdate(job);
      } else if (o.type === "done") result = o.result;
      else if (o.type === "error") errored = o.error;
    });
    if (errored) throw new Error(errored);
    if (!result) throw new Error("youtube job: no result");
    return result;
  }

  if (job.kind === "libimport") return runLibImportJob(job, ctrl.signal);
  if (job.kind === "starmap") return require("./star-map").computeStarmap(job, ctrl.signal, emitUpdate);

  const body = { ...job.payload, clientId: job.clientId };
  if (job.comfyUrl) body.comfyUrl = job.comfyUrl;

  if (job.engine === "ollama") {                 // /api/generate-image → NDJSON stream
    const r = await loopbackPost("/api/generate-image", body, ctrl.signal);
    if (!r.ok) { let d = {}; try { d = JSON.parse(r.text); } catch {} throw new Error(d.error || `gen failed (${r.status})`); }
    let out = null;
    for (const line of r.text.split("\n")) {
      if (!line.trim()) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o.type === "done") out = o; else if (o.error) throw new Error(o.error);
    }
    if (!out || !out.images) throw new Error("no result");
    return { images: out.images, model: out.model };
  }

  const r = await loopbackPost("/api/generate-comfy", body, ctrl.signal);   // self-contained JSON result
  let d = {}; try { d = JSON.parse(r.text); } catch {}
  if (!r.ok) throw new Error(d.error || `gen failed (${r.status})`);
  return d;   // { images|videos, videoMime, width, height, fps, length, model, segments, ... }
}

// Loopback POST to our OWN server using Node's http (NOT global fetch): a video gen
// can hold the response for many minutes, which exceeds undici/fetch's default
// ~5-minute headersTimeout and surfaces as "fetch failed". http.request has no such
// idle timeout, so the runner waits as long as the generation takes.
function loopbackPost(path, bodyObj, signal) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(bodyObj));
    const req = http.request({
      host: "127.0.0.1", port: config.PORT, path, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": payload.length },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, text: Buffer.concat(chunks).toString("utf-8") }));
    });
    req.on("error", reject);
    req.setTimeout(0);   // no idle timeout — long video renders are fine
    if (signal) {
      if (signal.aborted) { req.destroy(abortErr()); return; }
      signal.addEventListener("abort", () => { try { req.destroy(abortErr()); } catch {} }, { once: true });
    }
    req.end(payload);
  });
}
// Like loopbackPost but STREAMS: calls onLine(line) for each complete NDJSON line as it
// arrives (so a long job can report mid-run progress) instead of buffering the whole
// response. Keeps a partial-line buffer across chunks. Resolves when the stream ends.
function loopbackStream(path, bodyObj, signal, onLine) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(bodyObj));
    const req = http.request({
      host: "127.0.0.1", port: config.PORT, path, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": payload.length },
    }, (res) => {
      let buffer = "";
      res.setEncoding("utf-8");
      res.on("data", (chunk) => {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) if (line.trim()) { try { onLine(line); } catch {} }
      });
      res.on("end", () => { if (buffer.trim()) { try { onLine(buffer); } catch {} } resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode }); });
    });
    req.on("error", reject);
    req.setTimeout(0);   // no idle timeout — whisper + multi-chunk formatting can be slow
    if (signal) {
      if (signal.aborted) { req.destroy(abortErr()); return; }
      signal.addEventListener("abort", () => { try { req.destroy(abortErr()); } catch {} }, { once: true });
    }
    req.end(payload);
  });
}

function abortErr() { const e = new Error("Aborted"); e.name = "AbortError"; return e; }

// ---- libimport: the whole Knowledge-Library import pipeline, SERVER-side ----
// fetch/whisper (youtube) | fetch-url | parse-file (MinerU/Pandoc) → importDocInternal
// (chunk + embed) → distillDocInternal (card, best-effort). Runs in the 'lib' lane, so a
// batch queued from the browser finishes even with every page closed. Stage names surface
// via job.label as raw keys (fetching/parsing/importing/distilling — plus the youtube
// sub-job's transcribing/downloading/…); the browser maps them to i18n labels.
async function runLibImportJob(job, signal) {
  const p = job.payload || {};
  const stage = (s, progress = null) => { job.label = s; job.progress = progress; emitUpdate(job); };

  if (p.type === "distill") {          // backfill: regenerate one doc's card, no re-import
    stage("distilling");
    const r = await library.distillDocInternal(p.docId, { metadata: false, model: p.chatModel, language: p.language, timeoutS: p.llmTimeoutS, signal });
    return { docId: p.docId, distilled: !!r.ok, reembedded: r.reembedded };
  }
  if (p.type === "citations") {        // backfill: compute in-library citation edges (P4)
    stage("distilling");               // reuse a drawer-known stage label
    const r = await library.computeLibraryCitations(p.docIds);
    return { citations: r.edges, scanned: r.scanned };
  }
  // News feeds (news-feeds.md). feeditem: one blog post from a poll (no html → fetch-url).
  // backfill: one feed's whole history, imported directly by feeds.runBackfill (no sub-jobs).
  if (p.type === "feeditem") {
    stage("fetching");
    // Unified per-site extraction: a WordPress site (e.g. NVIDIA) uses its rich, trafilatura-FREE
    // handler here just like backfill (wp-json → images in position + captions + og:description
    // dek + author/tags); only a non-WordPress site falls to trafilatura. Returns null when the
    // article can't be extracted (empty). See feeds.extractArticleForUrl.
    const ex = await feeds.extractArticleForUrl(p.url, { signal, images: p.images, language: p.language, contentHtml: p.contentHtml, apiBase: p.apiBase });
    if (!ex || !ex.text || !String(ex.text).trim()) throw new Error("empty document");
    stage("importing");
    const card = library.blankCard(p.language);   // news «蒸馏卡» starts BLANK (no excerpt dump)
    const meta = ex.meta || {};
    const imp = await library.importDocInternal({
      source: `url:${p.url}`, docId: p.docId, dedupeUrl: true, docKind: "blog", folder: p.folder,
      title: p.title || ex.title || p.url, authors: (meta.author || "").trim(), tags: meta.tags || [],
      publishedAt: p.publishedAt || ex.publishedAt || "", text: ex.text, images: ex.images || [],
      model: p.embedModel, extraBlocks: card ? [card] : undefined,
    });
    return { docId: imp.docId, blockCount: imp.blockCount, folder: imp.folder, distilled: false };
  }
  if (p.type === "backfill") {
    stage("backfilling");
    return feeds.runBackfill(p.feedId, {
      signal, embedModel: p.embedModel, language: p.language,
      onProgress: (value, max) => stage("backfilling", (max ? { value, max } : null)),
    });
  }

  let source, docKind = p.docKind, title, authors = "", year = "", publishedAt = "", doi = "", citation = null, keywords = [], tags = [], zoteroObj = null, zoteroAbstract = null, zoteroAnnots = [], exactMeta = false, text, images = [], pageImages = [];
  if (p.type === "youtube") {
    stage("fetching");
    let data = null, errored = null;
    await loopbackStream("/api/youtube-job", { url: p.url, language: p.language, model: p.chatModel }, signal, (line) => {
      let o; try { o = JSON.parse(line); } catch { return; }
      if (o.type === "progress") stage(o.stage || "fetching", o.progress || null);
      else if (o.type === "title") { if (o.title) { job.videoTitle = o.title; emitUpdate(job); } }   // early video title → drawer row
      else if (o.type === "done") data = o.result;
      else if (o.type === "error") errored = o.error;
    });
    if (errored) throw new Error(errored);
    if (!data) throw new Error("youtube job: no result");
    // Formatting failed (raw transcript only): FAIL the import loudly — in a batch the
    // user must see which videos need reprocessing, not silently get an unformatted doc.
    if (data.formatError) throw new Error(`字幕整理失败: ${data.formatError}`);
    stage("importing");
    ({ source, docKind, title, authors, year, publishedAt, text, images } = await library.buildYoutubeDoc(data, p.url, p.language));
  } else if (p.type === "url") {
    stage("fetching");
    const r = await loopbackPost("/api/fetch-url", { url: p.url }, signal);
    let d = {}; try { d = JSON.parse(r.text); } catch {}
    if (!r.ok || d.type === "error" || d.type === "unsupported" || !d.content) throw new Error(d.content || `fetch failed (${r.status})`);
    source = `url:${p.url}`; docKind = docKind || "blog"; title = d.title || p.url; text = d.content; publishedAt = d.publishedAt || "";
  } else if (p.type === "text") {
    source = `file:${p.name}`; docKind = docKind || "other"; title = p.title || p.name; text = p.text;
  } else if (p.type === "file") {
    stage("parsing");
    const buf = p.spool ? fs.readFileSync(p.spool) : Buffer.from(p.fileB64 || "", "base64");
    if (!buf.length) throw new Error("file payload missing");
    const parsed = await loopbackParseFile(p.name, buf, signal, (pct) => stage("parsing", pct ? { value: pct, max: 100 } : null), p.llmTimeoutS, p.docKind);
    source = `file:${p.name}`; docKind = docKind || "other"; title = p.name.replace(/\.[^.]+$/, ""); text = parsed.text; images = parsed.images || [];
    // P3: a slides import also renders each page to a whole-page JPEG (best-effort; the
    // same file buffer is already in hand). Graceful — [] when no render backend is present.
    if (docKind === "slides") {
      stage("rendering");
      try { pageImages = await renderSlides.renderPages(buf, p.ext, { timeoutMs: (p.llmTimeoutS ? p.llmTimeoutS * 1000 : undefined) }); } catch (e) { if (e && e.name === "AbortError") throw e; }
    }
    // DOI on the first page → Crossref exact metadata (title/authors/date + citation).
    // When it lands, the distill LLM is told NOT to re-guess metadata (YouTube pattern);
    // a DOI without Crossref (offline) is still recorded on the doc.
    const pm = await library.lookupPaperMeta(text);
    if (pm) {
      doi = pm.doi;
      if (pm.title) { title = pm.title; authors = pm.authors || ""; year = pm.year || ""; publishedAt = pm.publishedAt || ""; exactMeta = true; }
      if (pm.citation) citation = pm.citation;
    }
    // Author keywords are parsed straight from the first page — independent of the DOI,
    // so a paper Crossref can't resolve still gets them.
    keywords = library.extractKeywords(text);
  } else if (p.type === "zotero") {
    // Zotero import DEFAULT path: pull the attachment's plain text via the local API's
    // /fulltext (no GPU, no file access) — MinerU is opt-in per-paper (deep re-parse).
    // Zotero metadata is authoritative → exactMeta so the distill LLM won't overwrite it.
    stage("fetching");
    const itemKey = p.itemKey;
    if (!itemKey) throw new Error("zotero import: itemKey required");
    const meta = await zotero.getItem(itemKey);
    const children = await zotero.getChildren(itemKey);
    const pdf = zotero.pickPdfAttachment(children);
    if (!pdf) throw new Error(`Zotero 条目「${meta.title || itemKey}」没有可用的 PDF 附件`);
    const attachmentKey = (pdf.data || pdf).key;
    // A Zotero "presentation" item is a slide deck: parse it PER-PAGE via MinerU (the
    // page structure is the whole value of a deck), NOT the default /fulltext plain text
    // that has no page boundaries. Reads the PDF straight off disk (same as a deep
    // re-parse). Falls back to /fulltext when the file or MinerU isn't available —
    // still searchable, just without per-slide blocks. See slides-library.md §0.9.
    const isSlides = String(meta.itemType || "").toLowerCase() === "presentation";
    stage("parsing");
    let bodyText = "", slideImages = [];
    if (isSlides) {
      const filePath = zotero.attachmentFilePath(pdf.data || pdf, pdf);
      if (filePath && fs.existsSync(filePath)) {
        try {
          const buf = fs.readFileSync(filePath);
          const parsed = await loopbackParseFile((pdf.data || pdf).filename || `${itemKey}.pdf`, buf, signal,
            (pct) => stage("parsing", pct ? { value: pct, max: 100 } : null), p.llmTimeoutS, "slides");
          bodyText = parsed.text || ""; slideImages = parsed.images || [];
          // P3: render each page to a whole-page JPEG (best-effort) — Zotero decks are
          // PDFs, so this uses the pypdfium2 backend on the same buffer.
          if (bodyText.trim()) {
            stage("rendering");
            try { pageImages = await renderSlides.renderPages(buf, ".pdf", { timeoutMs: (p.llmTimeoutS ? p.llmTimeoutS * 1000 : undefined) }); } catch (e) { if (e && e.name === "AbortError") throw e; }
          }
        } catch (e) { if (e && e.name === "AbortError") throw e; /* fall back to /fulltext below */ }
      }
    }
    if (!bodyText.trim()) {
      const ft = await zotero.getFulltext(attachmentKey);
      bodyText = (ft && ft.content) ? ft.content : "";
    }
    if (!bodyText.trim()) {
      throw new Error(`Zotero 尚未对「${meta.title || itemKey}」建立全文索引——在 Zotero 里打开一次该 PDF 触发索引，或稍后用「🔬 深度重解析」`);
    }
    const annots = await zotero.getAnnotations(attachmentKey);
    source = `zotero:${itemKey}`;
    docKind = isSlides ? "slides" : "paper";
    images = slideImages;
    title = meta.title || itemKey;
    authors = meta.authors || ""; year = meta.year || ""; publishedAt = meta.publishedAt || "";
    doi = meta.doi || "";
    citation = (meta.venue || meta.url || meta.itemType)
      ? { venue: meta.venue || "", type: meta.itemType || "", url: meta.url || "" } : null;
    tags = Array.isArray(meta.tags) ? meta.tags : [];
    exactMeta = !!meta.title;   // Zotero title present → trust its metadata, don't re-guess
    // «Abstract» always leads the doc (injected as a block so it survives even when EMPTY):
    // filled from Zotero's abstractNote when present, else an empty placeholder the user
    // can edit. We never guess it from the body text.
    zoteroAbstract = library.zoteroAbstractBlock(meta.abstract);
    // Annotations become their OWN block(s) appended after the body (built directly, not
    // via the chunker, so a short single highlight isn't dropped as noise). The hash is of
    // the markdown form so import + re-sync agree on "did the highlights change".
    zoteroAnnots = library.zoteroAnnotationBlocks(annots);
    text = `# ${title}\n\n${bodyText}`;
    zoteroObj = {
      key: itemKey, attachmentKey, version: meta.itemVersion || 0,
      collection: p.collectionName || "",
      annotHash: library.zoteroAnnotHash(library.buildZoteroAnnotationSection(annots)),
    };
  } else {
    throw new Error("unknown libimport type");
  }

  if (!text || !String(text).trim()) throw new Error("empty document");
  stage("importing");
  // dedupe only for file imports: their docId comes from the file BASENAME, so two
  // different papers both named main.pdf would otherwise silently overwrite each other
  // (URL/YouTube docIds derive from the URL — same id really is the same doc there).
  // Zotero docs land under zotero/<collection> (plan §0.2); everything else honors the
  // caller's folder (or auto-classify). dedupeDoi (not dedupe) for zotero: its docId is
  // keyed by itemKey, so it overwrites on re-import instead of text-suffixing _2.
  const folder = p.type === "zotero"
    ? (p.collectionName ? `zotero/${p.collectionName}` : "zotero")
    : p.folder;
  const imp = await library.importDocInternal({ source, docKind, folder, title, authors, year, publishedAt, doi, citation, keywords, tags, zotero: zoteroObj, extraBlocks: zoteroAbstract ? [zoteroAbstract] : undefined, appendBlocks: zoteroAnnots, text, images, pageImages, model: p.embedModel, dedupe: p.type === "file", dedupeDoi: p.type === "zotero" });
  // DOI dedup fired: this paper is already in the library under imp.docId. Don't re-embed
  // or re-distill — just tell the drawer it was skipped and which doc holds it.
  if (imp.skippedDoi) {
    dropSpool(job);
    return { docId: imp.docId, blockCount: imp.blockCount, folder: imp.folder, distilled: false, skippedDoi: imp.skippedDoi };
  }
  let distilled = false;
  if (p.distill !== false && p.chatModel) {
    stage("distilling");
    // Card generation is best-effort: an unreachable/misbehaving chat model must not fail
    // the import itself (the doc is already in the library; the backfill action can retry).
    try {
      // metadata:false when Crossref already gave exact values — the LLM must not overwrite them
      const r = await library.distillDocInternal(imp.docId, { metadata: p.type !== "youtube" && !exactMeta, model: p.chatModel, language: p.language, timeoutS: p.llmTimeoutS, signal });
      distilled = !!r.ok;
    } catch (e) {
      if (e && e.name === "AbortError") throw e;
      // Timeout fails the job LOUDLY (user request): a batch import must show which
      // docs still need a card. Other distill errors stay best-effort — the doc itself
      // is already imported either way, and the backfill action can retry.
      if (e && e.code === "DISTILL_TIMEOUT") throw new Error(`${e.message}——文档已入库，可用「补卡」重试`);
      console.warn("[jobs] distill failed:", e && e.message);
    }
  }
  dropSpool(job);
  return { docId: imp.docId, blockCount: imp.blockCount, folder: imp.folder, distilled, dedupedFrom: imp.dedupedFrom || undefined };
}

// Loopback multipart POST to our own /api/parse-file. The response is EITHER one JSON
// object (pandoc DOCX/PPTX — success or {error}) OR NDJSON (MinerU PDF: {progress}
// lines, then a final {text,images,tool} line). onProgress gets the MinerU percentage.
// timeoutS rides the ⚙ "timeout (s)" slider down to MinerU's kill timer (floored at
// 5 min server-side — a long/OCR-heavy PDF must not die at the chat slider's 60s).
function loopbackParseFile(filename, buf, signal, onProgress, timeoutS = 0, docKind = "") {
  return new Promise((resolve, reject) => {
    const boundary = "----hkspool" + crypto.randomUUID().replace(/-/g, "");
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${String(filename).replace(/"/g, "_")}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const payload = Buffer.concat([head, buf, tail]);
    const req = http.request({
      host: "127.0.0.1", port: config.PORT, path: "/api/parse-file", method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": payload.length,
        "x-parse-timeout-s": String(Number(timeoutS) || 0),
        // slides → parse-file rebuilds per-page structure (pptx native / PDF content_list).
        ...(docKind ? { "x-doc-kind": String(docKind) } : {}),
      },
    }, (res) => {
      let buffer = "", last = null, error = null;
      res.setEncoding("utf-8");
      const handleLine = (line) => {
        let o; try { o = JSON.parse(line); } catch { return; }
        if (o.error) error = o.error;
        else if (o.progress && onProgress) { const m = String(o.progress).match(/(\d+)%/); onProgress(m ? Number(m[1]) : 0); }
        if (o.text != null) last = o;
      };
      res.on("data", (chunk) => {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) if (line.trim()) handleLine(line);
      });
      res.on("end", () => {
        if (buffer.trim()) handleLine(buffer);
        if (last && last.text != null) resolve(last);
        else if (error === "mineru_unavailable") reject(new Error("MinerU 不可用：服务端解析 PDF 需要安装 MinerU"));
        else if (error === "pandoc_unavailable") reject(new Error("Pandoc 不可用：服务端解析 DOCX/PPTX 需要安装 Pandoc"));
        else reject(new Error(error || `parse failed (${res.statusCode})`));
      });
    });
    req.on("error", reject);
    req.setTimeout(0);   // MinerU on a long PDF can take minutes
    if (signal) {
      if (signal.aborted) { req.destroy(abortErr()); return; }
      signal.addEventListener("abort", () => { try { req.destroy(abortErr()); } catch {} }, { once: true });
    }
    req.end(payload);
  });
}

// ---- cancel / remove --------------------------------------------------------
function removeJob(job, { keepSpool = false } = {}) { const i = jobs.indexOf(job); if (i >= 0) jobs.splice(i, 1); dropResult(job.id); if (!keepSpool) dropSpool(job); }
function doCancel(job) {
  const ctrl = controllers.get(job.id);
  if (ctrl) { try { ctrl.abort(); } catch {} controllers.delete(job.id); }
  if (job.status === "running" && job.comfyUrl) { try { fetch(`${normUrl(job.comfyUrl)}/interrupt`, { method: "POST" }).catch(() => {}); } catch {} }
  removeJob(job);
  persist();
  updateSleepGuard(); // canceling the last job → drop the wake guard
  broadcast({ type: "removed", id: job.id });
}

// ---- HTTP endpoints ---------------------------------------------------------
async function submitJob(req, res) {
  let body; try { body = await readBody(req); } catch { sendJson(res, 400, { error: "bad body" }); return; }
  const { conversationId, msgId, kind, label, payload, comfyUrl, engine } = body;
  if (!kind || !payload) { sendJson(res, 400, { error: "kind and payload required" }); return; }
  const job = {
    id: crypto.randomUUID(),
    conversationId: conversationId || "", msgId: msgId || "",
    kind, engine: engine || "comfy", label: label || "",
    payload, comfyUrl: normUrl(comfyUrl || ""),
    clientId: body.clientId || crypto.randomUUID(),   // honor the browser's clientId (its ComfyUI progress WS)
    seq: (typeof body.seq === "number") ? body.seq : undefined,   // client batch-enqueue order
    status: "queued", progress: null, result: null, error: "",
    createdAt: Date.now(), startedAt: 0, finishedAt: 0, deliveredAt: 0,
  };
  // Library file import → spool the raw file to disk; the queued payload keeps only the path.
  if (kind === "libimport" && payload.type === "file" && payload.fileB64) {
    try {
      fs.mkdirSync(SPOOL_DIR, { recursive: true });
      const sp = path.join(SPOOL_DIR, `${job.id}.bin`);
      fs.writeFileSync(sp, Buffer.from(payload.fileB64, "base64"));
      job.payload = { ...payload, fileB64: undefined, spool: sp };
    } catch { /* spool failed → keep the inline base64 */ }
  }
  // Pre-uploaded file (POST /api/jobs/upload): the payload references the spool by NAME
  // only — resolve it inside SPOOL_DIR (basename, so a crafted name can't escape).
  else if (kind === "libimport" && payload.type === "file" && payload.spoolName) {
    const sp = path.join(SPOOL_DIR, path.basename(String(payload.spoolName)));
    if (!fs.existsSync(sp)) { sendJson(res, 400, { error: "uploaded file not found（服务器可能已重启，请重新导入）" }); return; }
    job.payload = { ...payload, spoolName: undefined, spool: sp };
  }
  // Insert keeping QUEUED jobs in the client's batch-enqueue (seq) order. Fire-all submits the
  // whole batch up front and each job races through its own source-video upload first, so POST
  // arrival order ≠ the order the user enqueued them. Drop the new job just before the first
  // queued job with a higher seq (so pumpLane's first-queued pick runs them 1→2→3); without a
  // seq (e.g. count>1 image sub-runs) just append.
  if (typeof job.seq === "number") {
    const idx = jobs.findIndex((j) => j.status === "queued" && typeof j.seq === "number" && j.seq > job.seq);
    if (idx >= 0) jobs.splice(idx, 0, job); else jobs.push(job);
  } else {
    jobs.push(job);
  }
  persist(); emitUpdate(job); pumpLanes();
  sendJson(res, 200, { jobId: job.id, clientId: job.clientId });
}

// POST /api/jobs/upload — raw binary body streamed straight into a spool file; returns
// { spoolName } for the subsequent /api/jobs submit. This keeps big files (a 50MB PDF)
// out of the JSON job body: base64 inside JSON.stringify freezes the browser main
// thread and bloats readBody — the exact trap source-video upload hit before it got
// its own raw-binary endpoint. Orphans (uploaded but never submitted) are swept by
// load() on the next server start.
async function uploadSpool(req, res) {
  try {
    fs.mkdirSync(SPOOL_DIR, { recursive: true });
    const name = crypto.randomUUID() + ".bin";
    const ws = fs.createWriteStream(path.join(SPOOL_DIR, name));
    await new Promise((resolve, reject) => {
      req.pipe(ws);
      ws.on("finish", resolve);
      ws.on("error", reject);
      req.on("error", reject);
    });
    sendJson(res, 200, { spoolName: name });
  } catch (e) { sendJson(res, 500, { error: e.message }); }
}

function streamEvents(req, res) {
  res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.write("retry: 3000\n\n");
  res.write(`data: ${JSON.stringify({ type: "snapshot", jobs: jobs.filter((j) => !j.deliveredAt).map(publicJob) })}\n\n`);
  sseClients.add(res);
  const ka = setInterval(() => { try { res.write(": ka\n\n"); } catch {} }, 25000);
  req.on("close", () => { clearInterval(ka); sseClients.delete(res); });
}

async function cancelJob(req, res, id) {
  const job = jobs.find((j) => j.id === id);
  if (job) doCancel(job);
  sendJson(res, 200, { ok: true });
}
async function cancelConversation(req, res) {
  let body; try { body = await readBody(req); } catch { sendJson(res, 400, { error: "bad body" }); return; }
  for (const job of jobs.filter((j) => j.conversationId === body.conversationId && (j.status === "queued" || j.status === "running"))) doCancel(job);
  sendJson(res, 200, { ok: true });
}
async function ackJobs(req, res) {
  let body; try { body = await readBody(req); } catch { sendJson(res, 400, { error: "bad body" }); return; }
  for (const id of (Array.isArray(body.ids) ? body.ids : [])) {
    const j = jobs.find((x) => x.id === id);
    // Failed (error/interrupted) libimport: KEEP the spool file — the drawer's ↻ retry
    // resubmits by the same spoolName and needs the raw upload to still exist (the browser
    // can't re-produce it; the File object is long gone). A successful retry deletes it in
    // runLibImportJob; an abandoned one is swept as an orphan on the next server start.
    if (j) { j.deliveredAt = Date.now(); if (j.status === "done" || j.status === "error" || j.status === "interrupted") removeJob(j, { keepSpool: j.status !== "done" }); }
  }
  persist();
  sendJson(res, 200, { ok: true });
}
async function reorderJobs(req, res) {
  let body; try { body = await readBody(req); } catch { sendJson(res, 400, { error: "bad body" }); return; }
  const order = Array.isArray(body.orderedIds) ? body.orderedIds : [];
  if (order.length) {
    const rank = new Map(order.map((id, i) => [id, i]));
    const ranked = jobs.filter((j) => j.status === "queued" && rank.has(j.id)).sort((a, b) => rank.get(a.id) - rank.get(b.id));
    let qi = 0;
    jobs = jobs.map((j) => (j.status === "queued" && rank.has(j.id)) ? ranked[qi++] : j);
    persist(); broadcast({ type: "snapshot", jobs: jobs.filter((j) => !j.deliveredAt).map(publicJob) });
  }
  sendJson(res, 200, { ok: true });
}

// Pause a not-yet-started job (pumpLane only ever picks 'queued', so a 'paused' job is
// simply skipped) / resume it. Groundwork for the future "client submits the whole queue
// up front" model where pause/resume must live on the server, not just in the browser.
async function pauseJob(req, res, id) {
  const job = jobs.find((j) => j.id === id);
  if (job && job.status === "queued") { job.status = "paused"; persist(); emitUpdate(job); }
  sendJson(res, 200, { ok: true });
}
async function resumeJob(req, res, id) {
  const job = jobs.find((j) => j.id === id);
  if (job && job.status === "paused") { job.status = "queued"; persist(); emitUpdate(job); pumpLanes(); }
  sendJson(res, 200, { ok: true });
}

load();
setTimeout(() => pumpLanes(), 800);   // resume queued jobs on boot

module.exports = { submitJob, uploadSpool, streamEvents, cancelJob, cancelConversation, ackJobs, reorderJobs, pauseJob, resumeJob };
