// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

// Option B: SERVER-SIDE persistent background-job queue for GENERATION (image /
// video / audio). The queue + execution live here, not in the browser, so jobs
// survive page reload / sleep and are shared across clients. The browser submits a
// job spec, subscribes to status + result over SSE, and reattaches the result into
// its conversation by (conversationId, msgId).
//
// Execution is LOOPBACK: the runner POSTs the job's payload to this server's OWN
// already-self-contained /api/generate-comfy | /api/generate-image | /api/tts
// endpoint — so the heavy generation code is reused untouched.
//
// Lanes: one per ComfyUI endpoint (job.comfyUrl) + a shared 'local' lane (audio /
// Ollama image). Serial within a lane (GPU safety), parallel across.

const crypto = require("crypto");
const http = require("http");
const fs = require("fs");
const path = require("path");
const config = require("./config");
const { sendJson, readBody } = require("./utils");

const JOBS_FILE = path.join(config.JOBS_DIR, "jobs.json");

let jobs = [];                  // see job shape in submitJob()
const controllers = new Map();  // jobId -> AbortController (runtime only)
const activeLanes = new Set();  // laneId currently draining
const sseClients = new Set();   // SSE res objects

const laneOf = (job) => job.comfyUrl || "local";
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
function load() {
  try {
    const arr = JSON.parse(fs.readFileSync(JOBS_FILE, "utf-8"));
    if (Array.isArray(arr)) {
      // running → interrupted (its in-flight work was lost on restart); done jobs
      // lost their result on disk → drop them (nothing to deliver). queued resume.
      jobs = arr.filter((j) => j.status !== "done").map((j) => j.status === "running" ? { ...j, status: "interrupted", progress: null } : j);
    }
  } catch { jobs = []; }
}

// ---- SSE broadcast ----------------------------------------------------------
function publicJob(j) { const { _ctrl, ...rest } = j; return rest; }
function broadcast(event) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of sseClients) { try { res.write(data); } catch {} }
}
const emitUpdate = (job) => broadcast({ type: "update", job: publicJob(job) });

// ---- the per-lane runner (parallel across lanes) ----------------------------
function pumpLanes() {
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
      persist();
      broadcast(job.status === "done" ? { type: "done", job: publicJob(job) } : { type: "update", job: publicJob(job) });
    }
  } finally {
    activeLanes.delete(laneId);
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
function abortErr() { const e = new Error("Aborted"); e.name = "AbortError"; return e; }

// ---- cancel / remove --------------------------------------------------------
function removeJob(job) { const i = jobs.indexOf(job); if (i >= 0) jobs.splice(i, 1); }
function doCancel(job) {
  const ctrl = controllers.get(job.id);
  if (ctrl) { try { ctrl.abort(); } catch {} controllers.delete(job.id); }
  if (job.status === "running" && job.comfyUrl) { try { fetch(`${normUrl(job.comfyUrl)}/interrupt`, { method: "POST" }).catch(() => {}); } catch {} }
  removeJob(job);
  persist();
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
    status: "queued", progress: null, result: null, error: "",
    createdAt: Date.now(), startedAt: 0, finishedAt: 0, deliveredAt: 0,
  };
  jobs.push(job);
  persist(); emitUpdate(job); pumpLanes();
  sendJson(res, 200, { jobId: job.id, clientId: job.clientId });
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
    if (j) { j.deliveredAt = Date.now(); if (j.status === "done" || j.status === "error" || j.status === "interrupted") removeJob(j); }
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

load();
setTimeout(() => pumpLanes(), 800);   // resume queued jobs on boot

module.exports = { submitJob, streamEvents, cancelJob, cancelConversation, ackJobs, reorderJobs };
