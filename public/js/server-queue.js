// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

// Option B client side: GENERATION jobs (image / video / audio) execute on the
// SERVER queue (server/jobs.js) so they survive page reload / sleep. The browser
// still drives the placeholder + drawer via the existing in-page bg-jobs entry, but
// the actual generation is submitted to the server and its result is awaited over a
// shared SSE stream — so closing the page doesn't kill the work, and reopening
// reconnects to the same job by its serverJobId.
//
// The integration point is a Response-LIKE wrapper (comfyFetch / ttsFetch): it
// returns `{ ok, json:()=>result }` so the existing generateImage/Video/Speech
// downstream (which does `await r.json()`) keeps working unchanged.

import { state } from './state.js';

let _es = null;                       // the SSE connection
const awaiters = new Map();           // serverJobId -> { resolve, reject }
const lastJobs = new Map();           // serverJobId -> latest public job (from snapshot/update/done)
let _persist = () => {};              // injected: persist state.bgJobs (so serverJobId survives reload)
let _onProgress = () => {};           // injected: mid-run progress (server job → bgJob.progress/label → drawer)
export function setServerQueueDeps({ persist, onProgress }) { if (persist) _persist = persist; if (onProgress) _onProgress = onProgress; }

// ---- shared SSE connection --------------------------------------------------
export function connectServerQueue() {
  if (_es) return;
  try { _es = new EventSource('/api/jobs/events'); } catch { _es = null; return; }
  _es.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'snapshot') { for (const j of (msg.jobs || [])) ingest(j); }
    else if (msg.type === 'update' || msg.type === 'done') ingest(msg.job);
    else if (msg.type === 'removed') settle(msg.id, null, new Error('canceled'));
  };
  _es.onerror = () => { /* EventSource auto-reconnects (server sends retry:) */ };
}

// Record a job's latest state + settle any awaiter on a terminal status.
function ingest(job) {
  if (!job || !job.id) return;
  lastJobs.set(job.id, job);
  if (job.status === 'running') _onProgress(job);   // mid-run progress/label → drawer (no settle)
  else if (job.status === 'done') settle(job.id, job.result, null);
  else if (job.status === 'error' || job.status === 'interrupted') settle(job.id, null, new Error(job.error || 'job failed'));
}
function settle(jobId, result, err) {
  const a = awaiters.get(jobId);
  if (!a) return;
  awaiters.delete(jobId);
  if (err) a.reject(err); else a.resolve(result);
}

// ---- submit + await ---------------------------------------------------------
// meta: { bgJob, kind, engine, comfyUrl, conversationId, msgId, label, clientId, signal }
// Release a job's lane submit-gate → lets the NEXT video job in the lane POST. Idempotent.
function releaseSubmitGate(bgJob) {
  if (bgJob && bgJob._submitRelease) { bgJob._submitRelease(); bgJob._submitRelease = null; }
}

async function submitAndAwait(payload, meta) {
  let jobId = meta.bgJob && meta.bgJob.serverJobId;
  if (!jobId) {
    // Batch order: wait until the previous video job in this lane has POSTed (fireJob's
    // laneSubmitChain), so the server receives — and starts — the batch in enqueue order even
    // though each clip's source-video upload finished in a different order.
    if (meta.bgJob && meta.bgJob._submitWait) { try { await meta.bgJob._submitWait; } catch {} }
    // Canceled WHILE parked at the gate? serverJobId was still null then, so cancelBgJob issued no
    // server cancel — bail now (gate already freed in cancelBgJob) instead of POSTing a phantom job.
    if (meta.signal && meta.signal.aborted) { releaseSubmitGate(meta.bgJob); throw domAbort(); }
    const r = await fetch('/api/jobs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId: meta.conversationId || '', msgId: meta.msgId || '',
        kind: meta.kind, engine: meta.engine || 'comfy', comfyUrl: meta.comfyUrl || '',
        label: meta.label || '', clientId: meta.clientId || undefined,
        seq: (meta.bgJob && typeof meta.bgJob.seq === 'number') ? meta.bgJob.seq : undefined,   // batch-enqueue order
        payload,
      }),
    });
    if (!r.ok) { releaseSubmitGate(meta.bgJob); throw new Error(`submit failed (${r.status})`); }
    const d = await r.json();
    jobId = d.jobId;
    if (meta.bgJob) { meta.bgJob.serverJobId = jobId; _persist(); }   // remember so a reload can reconnect
  }
  // This job is on the server now (fresh submit OR reconnect) → release the next one in the lane.
  releaseSubmitGate(meta.bgJob);
  return await new Promise((resolve, reject) => {
    awaiters.set(jobId, { resolve, reject });
    // reconnect case: the result may already be in the last snapshot
    const known = lastJobs.get(jobId);
    if (known) {
      if (known.status === 'done') { awaiters.delete(jobId); resolve(known.result); return; }
      if (known.status === 'error' || known.status === 'interrupted') { awaiters.delete(jobId); reject(new Error(known.error || 'job failed')); return; }
      // A 'running' update can race AHEAD of the bgJob.serverJobId assignment above (the
      // server emits 'running' synchronously, before this POST's response returns), so
      // onProgress saw no matching bgJob and skipped the flip. Re-apply it now that
      // serverJobId is known — otherwise the gated markRunning leaves the job that's
      // ACTUALLY on the GPU stuck showing 'queued'.
      if (known.status === 'running') _onProgress(known);
    }
    if (meta.signal) {
      if (meta.signal.aborted) { awaiters.delete(jobId); reject(domAbort()); return; }
      meta.signal.addEventListener('abort', () => {
        if (awaiters.has(jobId)) { awaiters.delete(jobId); reject(domAbort()); }
        cancelServerJob(jobId);   // stop/abort → also cancel the server job
      }, { once: true });
    }
  });
}
function domAbort() { try { return new DOMException('Aborted', 'AbortError'); } catch { const e = new Error('Aborted'); e.name = 'AbortError'; return e; } }

// Response-like wrappers — drop-in for the `fetch(...)` the generators used. The
// downstream `await r.json()` then receives the SAME result shape the old endpoint
// returned (comfy: {images|videos,…}; tts: {audio,mime}).
export function comfyFetch(payload, meta) {
  return submitAndAwait(payload, { ...meta, engine: 'comfy' }).then(
    (data) => ({ ok: true, json: async () => data }),
    (err) => { if (err && err.name === 'AbortError') throw err; return { ok: false, json: async () => ({ error: (err && err.message) || 'failed' }) }; },
  );
}
export function ttsFetch(payload, meta) {
  return submitAndAwait(payload, { ...meta, kind: 'audio', engine: 'tts' }).then(
    (data) => ({ ok: true, json: async () => data }),
    (err) => { if (err && err.name === 'AbortError') throw err; return { ok: false, json: async () => ({ error: (err && err.message) || 'failed' }) }; },
  );
}
// Vision analysis (/analyze): submit the /api/chat call to the server queue so it
// survives a page close/reload. Result is { content } (the full answer text).
export function chatFetch(payload, meta) {
  return submitAndAwait(payload, { ...meta, kind: 'analyze', engine: 'chat' }).then(
    (data) => ({ ok: true, json: async () => data }),
    (err) => { if (err && err.name === 'AbortError') throw err; return { ok: false, json: async () => ({ error: (err && err.message) || 'failed' }) }; },
  );
}
// /url youtube: server fetches/transcribes/formats; result is the processed transcript blob.
// Mid-run progress (whisper %, formatting N/M) flows via the SSE `onProgress` channel.
export function youtubeFetch(payload, meta) {
  return submitAndAwait(payload, { ...meta, kind: 'youtube', engine: 'youtube' }).then(
    (data) => ({ ok: true, json: async () => data }),
    (err) => { if (err && err.name === 'AbortError') throw err; return { ok: false, json: async () => ({ error: (err && err.message) || 'failed' }) }; },
  );
}
// Knowledge-library import: the whole pipeline (fetch/whisper/parse → embed → distill
// card) runs as ONE server job in the 'lib' lane; result is { docId, blockCount, … }.
export function libImportFetch(payload, meta) {
  return submitAndAwait(payload, { ...meta, kind: 'libimport', engine: 'lib' }).then(
    (data) => ({ ok: true, json: async () => data }),
    (err) => { if (err && err.name === 'AbortError') throw err; return { ok: false, json: async () => ({ error: (err && err.message) || 'failed' }) }; },
  );
}

// Server-authoritative timing for a settled (or running) job — used to stamp a
// generated bubble with the REAL generation time/duration (server's startedAt/finishedAt,
// same wall clock as us). Correct even if the page was closed during the job: the value
// comes from the SSE snapshot/done, not from when the client happened to reattach.
export function serverJobTiming(serverJobId) {
  if (!serverJobId) return null;
  const j = lastJobs.get(serverJobId);
  if (!j) return null;
  return { startedAt: j.startedAt || 0, finishedAt: j.finishedAt || 0 };
}

// ---- control (used by bg-jobs cancel/reorder + archive) ---------------------
export function cancelServerJob(serverJobId) {
  if (!serverJobId) return;
  awaiters.delete(serverJobId);
  fetch(`/api/jobs/${serverJobId}/cancel`, { method: 'POST' }).catch(() => {});
}
export function pauseServerJob(serverJobId) {
  if (!serverJobId) return;
  fetch(`/api/jobs/${serverJobId}/pause`, { method: 'POST' }).catch(() => {});
}
export function resumeServerJob(serverJobId) {
  if (!serverJobId) return;
  fetch(`/api/jobs/${serverJobId}/resume`, { method: 'POST' }).catch(() => {});
}
export function ackServerJob(serverJobId) {
  if (!serverJobId) return;
  fetch('/api/jobs/ack', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [serverJobId] }) }).catch(() => {});
}
export function reorderServerJobs(orderedIds) {
  fetch('/api/jobs/reorder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ orderedIds }) }).catch(() => {});
}
export function cancelConversationServerJobs(conversationId) {
  return fetch('/api/jobs/cancel-conversation', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversationId }) }).catch(() => {});
}
