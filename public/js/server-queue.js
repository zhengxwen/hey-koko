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
async function submitAndAwait(payload, meta) {
  let jobId = meta.bgJob && meta.bgJob.serverJobId;
  if (!jobId) {
    const r = await fetch('/api/jobs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId: meta.conversationId || '', msgId: meta.msgId || '',
        kind: meta.kind, engine: meta.engine || 'comfy', comfyUrl: meta.comfyUrl || '',
        label: meta.label || '', clientId: meta.clientId || undefined, payload,
      }),
    });
    if (!r.ok) throw new Error(`submit failed (${r.status})`);
    const d = await r.json();
    jobId = d.jobId;
    if (meta.bgJob) { meta.bgJob.serverJobId = jobId; _persist(); }   // remember so a reload can reconnect
  }
  return await new Promise((resolve, reject) => {
    awaiters.set(jobId, { resolve, reject });
    // reconnect case: the result may already be in the last snapshot
    const known = lastJobs.get(jobId);
    if (known) {
      if (known.status === 'done') { awaiters.delete(jobId); resolve(known.result); return; }
      if (known.status === 'error' || known.status === 'interrupted') { awaiters.delete(jobId); reject(new Error(known.error || 'job failed')); return; }
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
