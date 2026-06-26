// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

// Background Jobs: a serial (FIFO) queue for long-running generations so the user
// can keep chatting while video / image / audio renders run "detached" from the
// live bubble. Each job owns a persisted placeholder message in its source tab
// (the bubble position) and shows up in the right-hand drawer; when it finishes,
// the result replaces the placeholder in place.
//
// This is the (B) "in-page background" model: the work still runs in this page's
// JS, so a reload interrupts an in-flight job — its payload is persisted so it can
// resume (queued) or be retried (interrupted).
import { state, dom } from './state.js';
import { genId } from './utils.js';
import { dbSaveJobs, dbLoadJobs, dbSaveWorkers, dbLoadWorkers } from './db.js';
import { saveChat } from './settings.js';
import { getTab, switchTab } from './tabs.js';
import { t } from './i18n.js';
import { generateImage } from './image-gen.js';
import { generateSpeech } from './voice-gen.js';

// renderChat + the analysis generators are injected (chat.js imports this module, so
// importing it back would be circular). Set from main.js via setBgDeps.
let _renderChat = null;
let _analyzeMedia = null;
let _regenerateReply = null;
let _parseDocumentHeadless = null;
let _handleUrlCommand = null;
let _handleMultiUrlCommand = null;
let _refreshWorkers = null;   // re-scan worker endpoints (ollama.refreshBgWorkers), injected
export function setBgDeps({ renderChat, analyzeMedia, regenerateReply, parseDocumentHeadless, handleUrlCommand, handleMultiUrlCommand, refreshWorkers }) {
  if (renderChat) _renderChat = renderChat;
  if (analyzeMedia) _analyzeMedia = analyzeMedia;
  if (regenerateReply) _regenerateReply = regenerateReply;
  if (parseDocumentHeadless) _parseDocumentHeadless = parseDocumentHeadless;
  if (handleUrlCommand) _handleUrlCommand = handleUrlCommand;
  if (handleMultiUrlCommand) _handleMultiUrlCommand = handleMultiUrlCommand;
  if (refreshWorkers) _refreshWorkers = refreshWorkers;
}
function rerender() { if (_renderChat) _renderChat(); }

// Runtime-only AbortControllers, keyed by job id. NOT stored on the job objects
// (which get structured-cloned into IndexedDB and can't hold a controller).
const jobControllers = new Map();

// ---- persistence -----------------------------------------------------------

// Strip runtime-only fields before persisting (controllers live in the Map; the
// preview is a transient blob: URL that's meaningless after a reload).
function persist() {
  const clean = state.bgJobs.map(({ preview, seg, ...j }) => j);
  dbSaveJobs(clean).catch((e) => console.warn('[bg-jobs] persist failed:', e));
}

// ---- queue helpers ---------------------------------------------------------

export function bgQueueActive() {
  return state.bgJobs.some((j) => j.status === 'queued' || j.status === 'running');
}

function unfinishedCount() {
  return state.bgJobs.filter((j) => j.status === 'queued' || j.status === 'running').length;
}

// Locate a message by its stable id across all tabs.
function findMsg(msgId) {
  for (const tab of state.tabs) {
    if (!Array.isArray(tab.messages)) continue;
    const index = tab.messages.findIndex((m) => m && m.id === msgId);
    if (index >= 0) return { tab, index, msg: tab.messages[index] };
  }
  return null;
}

// Queue position (1-based) among still-queued jobs IN THE SAME LANE; 0 if not queued.
function queuePosition(job) {
  if (job.status !== 'queued') return 0;
  const wid = laneOf(job);
  const queued = state.bgJobs.filter((j) => j.status === 'queued' && laneOf(j) === wid);
  return queued.indexOf(job) + 1;
}

// ---- worker registry + scheduler -------------------------------------------
// A "worker" is a backend that runs a job. Each ComfyUI endpoint is its own lane
// (GPU bottleneck → serial within, parallel across machines). Everything non-ComfyUI
// (audio / analyze / docfull / url) shares the synthetic 'local' lane.

function laneOf(job) { return job.workerId || 'local'; }

// The enabled ComfyUI workers. If none are configured yet, fall back to a single
// synthetic worker built from the currently-configured endpoint (back-compat = 1 lane).
function comfyWorkers() {
  const ws = state.bgWorkers.filter((w) => w.enabled);
  if (ws.length) return ws;
  // Drop any " (hostname)" suffix the display shows — we need the bare address.
  const url = (dom.comfyUrlDisplay?.textContent || '').replace(/\s*\(.*\)\s*$/, '').trim();
  return url ? [{ id: 'comfy:' + url, url, label: url, enabled: true, online: true, models: null }] : [];
}

// Does a worker have this model? null models = unknown (not yet scanned) → assume yes
// so a freshly-added worker isn't excluded before its first scan.
function workerHasModel(w, model) {
  if (!model) return true;
  if (!w.models) return true;
  const m = w.models;
  return (m.image && m.image.has(model)) || (m.edit && m.edit.has(model)) || (m.video && m.video.has(model));
}

// Lane load = queued + running jobs already on that worker.
function laneLoad(workerId) {
  return state.bgJobs.filter((j) => laneOf(j) === workerId && (j.status === 'queued' || j.status === 'running')).length;
}

// Pick which backend runs a job. ComfyUI jobs go to the least-busy enabled+online
// worker that has the model; others go to 'local'. Snapshot onto the job (like
// modelOverride) so a later config change can't redirect a queued job.
function assignWorker(job) {
  if (job.kind !== 'image' && job.kind !== 'video') { job.workerId = 'local'; job.workerUrl = null; return; }
  const model = (job.payload && job.payload.modelOverride && job.payload.modelOverride.comfyModel) || job.payload?.model || '';
  const all = comfyWorkers();
  if (!all.length) { job.workerId = 'local'; job.workerUrl = null; return; } // no comfy → Ollama image path
  const online = all.filter((w) => w.online !== false);
  let cands = online.filter((w) => workerHasModel(w, model));
  if (!cands.length) cands = online.length ? online : all;  // fall back: any online, else any
  cands.sort((a, b) => laneLoad('comfy:' + a.url) - laneLoad('comfy:' + b.url));
  const w = cands[0];
  job.workerId = 'comfy:' + w.url;
  job.workerUrl = w.url;
}

// Persist the worker list (strip runtime-only online/models).
function persistWorkers() {
  const clean = state.bgWorkers.map(({ online, models, ...w }) => w);
  dbSaveWorkers(clean).catch((e) => console.warn('[bg-jobs] worker persist failed:', e));
}

export function getBgWorkers() { return state.bgWorkers; }
export function addBgWorker(url) {
  const u = (url || '').trim().replace(/\/+$/, '');
  if (!u) return null;
  if (state.bgWorkers.some((w) => w.url === u)) return null;  // dedupe
  const w = { id: 'comfy:' + u, url: u, label: u, enabled: true, online: undefined, models: null };
  state.bgWorkers.push(w);
  persistWorkers();
  renderDrawer();
  return w;
}
export function removeBgWorker(id) {
  const i = state.bgWorkers.findIndex((w) => w.id === id || w.url === id);
  if (i >= 0) { state.bgWorkers.splice(i, 1); persistWorkers(); renderDrawer(); }
}
export function setBgWorkerEnabled(id, on) {
  const w = state.bgWorkers.find((x) => x.id === id || x.url === id);
  if (w) { w.enabled = !!on; persistWorkers(); renderDrawer(); }
}
// Called by the health/scan code with a freshly-scanned model set + online flag.
export function setBgWorkerStatus(url, { online, models }) {
  const w = state.bgWorkers.find((x) => x.url === url);
  if (!w) return;
  if (online !== undefined) w.online = online;
  if (models !== undefined) w.models = models;
  renderDrawer();
}

// ---- enqueue ---------------------------------------------------------------

// Add a job to the FIFO queue and drop a placeholder message into its source tab.
// payload carries everything needed to (re)run the generator headlessly. insertIndex
// places the placeholder bubble (e.g. right after the resent user bubble); -1 appends.
export function enqueueBgJob({ tabId, kind, label, payload, insertIndex = -1 }) {
  const tab = getTab(tabId);
  if (!tab) return null;
  const msgId = genId();
  const job = {
    id: genId(),
    tabId,
    msgId,
    kind,
    label: label || '',
    status: 'queued',
    progress: null,
    payload,
    error: '',
    createdAt: Date.now(),
  };
  state.bgJobs.push(job);
  assignWorker(job);   // pick which backend/lane runs it (snapshot, like modelOverride)
  // Persisted placeholder bubble — at insertIndex (resend/edit: just after the user
  // bubble) or appended (fresh sends). Reattach is by msgId, so position is free.
  const placeholder = {
    id: msgId,
    role: 'assistant',
    content: '',          // keep .content access safe; never sent to the model
    bgPlaceholder: true,
    jobId: job.id,
    kind,
    label: job.label,
    status: 'queued',
    timestamp: Date.now(),
  };
  if (insertIndex >= 0 && insertIndex <= tab.messages.length) tab.messages.splice(insertIndex, 0, placeholder);
  else tab.messages.push(placeholder);
  saveChat();
  persist();
  refreshPlaceholders();
  pumpQueue();
  return job;
}

// ---- the serial runner -----------------------------------------------------

// Start a serial runner for every lane that has queued work and isn't already
// draining. Lanes run in PARALLEL (each ComfyUI machine + the 'local' lane), so a
// video on box A renders while an image renders on box B and an analysis runs locally.
export function pumpQueue() {
  const lanes = new Set(state.bgJobs.filter((j) => j.status === 'queued').map(laneOf));
  for (const wid of lanes) { if (!state.bgLanes.has(wid)) pumpLane(wid); }  // not awaited → concurrent
}

// Drain ONE lane serially (FIFO within a worker protects its GPU).
async function pumpLane(workerId) {
  if (state.bgLanes.has(workerId)) return;
  state.bgLanes.add(workerId);
  try {
    let job;
    while ((job = state.bgJobs.find((j) => j.status === 'queued' && laneOf(j) === workerId))) {
      job.status = 'running';
      job.progress = null;
      job.seg = null;
      job.startedAt = Date.now();   // for the live elapsed-time display
      persist();
      refreshPlaceholders();
      startElapsedTicker();
      try {
        await runJob(job);
        if (job.status === 'running') job.status = 'done';
      } catch (e) {
        if (e && e.bgCanceled) {
          job.status = 'canceled';
        } else {
          job.status = 'error';
          job.error = (e && e.message) || String(e);
        }
      }
      jobControllers.delete(job.id);
      // Auto-remove a successfully-finished job — its result is already in the chat,
      // so the drawer entry is just clutter. Errors/interrupted stay (retryable).
      if (job.status === 'done') {
        const i = state.bgJobs.indexOf(job);
        if (i >= 0) state.bgJobs.splice(i, 1);
      }
      persist();
      refreshPlaceholders();
    }
  } finally {
    state.bgLanes.delete(workerId);
  }
}

// Dispatch a job to the matching generator, headless, via a background sink.
async function runJob(job) {
  const controller = new AbortController();
  jobControllers.set(job.id, controller);
  const sink = makeBgSink(job, controller);
  const p = job.payload || {};
  if (job.kind === 'audio') {
    await generateSpeech(p.parsed, job.tabId, -1, sink);
  } else if (job.kind === 'analyze') {
    // Vision analysis: -1 insertIndex (bg.place swaps by msgId); anchorIndex feeds the
    // no-attachment fallback that scans backwards for the nearest media bubble.
    await _analyzeMedia(p.parsed, job.tabId, p.image || null, p.video || null, -1, p.anchorIndex ?? -1, sink);
  } else if (job.kind === 'doc' || job.kind === 'chat') {
    // Document summary / headless chat reply: builds context from the conversation
    // (placeholder is skipped by buildMessages) and swaps the placeholder via bg.place.
    await _regenerateReply(job.tabId, -1, p.contextEndIndex ?? -1, p.replyMeta || {}, sink);
  } else if (job.kind === 'docfull') {
    await runDocFull(job, sink);
  } else if (job.kind === 'url') {
    await runUrl(job, sink);
  } else {
    // image OR video — generateImage routes to generateVideo for a video model.
    // modelOverride pins the model captured at submit time, so switching the model
    // dropdown afterwards doesn't change a queued job's destination. job.workerUrl
    // (set by the scheduler) pins WHICH ComfyUI machine runs it — its parallel lane.
    const mo = (p.modelOverride && job.workerUrl) ? { ...p.modelOverride, comfyUrl: job.workerUrl } : (p.modelOverride || null);
    await generateImage(p.parsedInput, job.tabId, -1, p.initImages || null,
      p.initVideo || null, p.maskB64 || null, sink, mo);
  }
}

// ---- multi-message jobs (docfull / url) -----------------------------------
// These produce SEVERAL bubbles at the placeholder position instead of swapping
// it for one. The pattern: point a cursor at the placeholder's live index, let the
// headless runner splice real messages there (placeholder drifts down, showing the
// current phase), then remove the placeholder when the run finishes.

// Remove a job's placeholder bubble (used by multi-message jobs once they've spliced
// their real result bubbles in front of it).
function removePlaceholder(job) {
  const found = findMsg(job.msgId);
  if (found && found.msg.bgPlaceholder) {
    found.tab.messages.splice(found.index, 1);
    saveChat();
    if (state.activeTabId === job.tabId) rerender();
  }
}

// docfull: parse a document (MinerU PDF / Pandoc DOCX·PPTX / client fallbacks / EML)
// HEADLESS with phase progress, then drop a file-preview + auto-prompt (+ summary for
// PDF/DOCX) at the placeholder position.
async function runDocFull(job, sink) {
  const p = job.payload || {};
  const found = findMsg(job.msgId);
  if (!found) return; // canceled before it started
  sink.label(t('bg_parsing'));
  const parsed = await _parseDocumentHeadless(p.fileB64, p.name, p.ext, p.content || '', (txt) => {
    if (txt) sink.label(txt);
  });
  const text = (parsed && parsed.text) || '';
  const images = (parsed && parsed.images) || [];
  if (!text.trim() && !images.length) throw new Error(t('bg_parseEmpty'));
  const tool = (parsed && parsed.tool) || '';
  const displayThumbnails = parsed && parsed.displayThumbnails;

  // Build the same two bubbles sendMessage's file branch builds (verbatim prompts).
  const ext = (p.ext || '').replace(/^\./, '').toLowerCase();
  const isPdfOrDocx = ext === 'pdf' || ext === 'docx';
  let autoPrompt;
  if (isPdfOrDocx) {
    const base = images.length
      ? '请对这篇文章做一个全面的总结，然后逐一描述每张图片的内容。'
      : '请对这篇文章做一个全面的总结。';
    autoPrompt = p.content ? `${base}\n\n用户补充: ${p.content}` : base;
  } else if (p.content) {
    autoPrompt = p.content;
  } else {
    autoPrompt = '请阅读以上文件内容并等待我的提问。';
  }
  const previewMsg = {
    id: genId(), role: 'assistant',
    content: `📄 **FILE: ${p.name}**${tool ? ` (via ${tool})` : ''}\n\n${text}`,
    timestamp: Date.now(), isFilePreview: true,
  };
  if (images.length) previewMsg.images = images.map((img) => img.base64);
  if (displayThumbnails && displayThumbnails.length) previewMsg.generatedThumbnails = displayThumbnails;
  const promptMsg = { id: genId(), role: 'user', content: autoPrompt, timestamp: Date.now() };

  // Splice both right before the placeholder (its index may have shifted during parse).
  const f2 = findMsg(job.msgId);
  if (!f2) return; // canceled mid-parse
  const tab = f2.tab;
  let pos = f2.index;
  tab.messages.splice(pos++, 0, previewMsg);
  tab.messages.splice(pos++, 0, promptMsg);
  saveChat();
  if (state.activeTabId === job.tabId) rerender();

  // PDF/DOCX auto-summarize: insert the reply at the cursor (just before placeholder).
  if (isPdfOrDocx) {
    await _regenerateReply(job.tabId, pos, pos - 1, {}, sink);
  }
  removePlaceholder(job);
}

// url: run the whole /url chain (fetch → maybe whisper → format → reply) HEADLESS,
// splicing its bubbles before the placeholder via a cursor.
async function runUrl(job, sink) {
  const found = findMsg(job.msgId);
  if (!found) return;
  const tab = found.tab;
  const cursor = { pos: found.index };
  const p = job.payload || {};
  const entries = p.entries || [];
  if (entries.length === 1) {
    await _handleUrlCommand(entries[0].url, tab, job.tabId, p.fullContent, entries[0].prompt, cursor, true, sink);
  } else {
    await _handleMultiUrlCommand(entries, tab, job.tabId, p.fullContent, cursor, sink);
  }
  removePlaceholder(job);
}

// Background sink: same shape as foregroundSink, but writes to the job record +
// placeholder + drawer instead of the live state.pendingGen bubble.
function makeBgSink(job, controller) {
  return {
    background: true,
    signal: controller.signal,
    tabId: job.tabId,
    lock() {},                 // never lock the send button for a background run
    started() { return true; }, // placeholder already exists
    start(kind, label) { if (label) job.label = label; refreshPlaceholders(); },
    label(l) { job.label = l; refreshPlaceholders(); },
    enhanced() {},             // surfaced in the final message instead
    addImage() {},             // results delivered via place()
    addVideo() {},
    // Progress ticks are frequent → update the drawer + poke the placeholder's bar
    // directly in the DOM, never a full chat re-render.
    progress(v, m) { if (m) { job.progress = { value: v, max: m }; renderDrawer(); updatePlaceholderBar(job); } },
    // Live preview frame → shown in the drawer row. Revoke the prior blob URL.
    preview(url) {
      if (job.preview && job.preview !== url && job.preview.startsWith('blob:')) { try { URL.revokeObjectURL(job.preview); } catch {} }
      job.preview = url;
      renderDrawer();
    },
    eta() {},
    // Multi-segment video: "第 N/M 段" — surface which chunk is rendering. Changes only
    // at chunk boundaries; refresh the drawer/placeholder then (progress() also redraws).
    seg(x) { if (job.seg !== x) { job.seg = x; renderDrawer(); updatePlaceholderBar(job); } },
    indeterminate() {},
    clearBubble() {},          // placeholder persists until place() swaps it
    // Swap the placeholder message for the real result (keeping its id/position).
    place(msg) {
      const found = findMsg(job.msgId);
      if (!found) return; // canceled / deleted mid-run — drop the result
      msg.id = job.msgId;
      found.tab.messages[found.index] = msg;
      saveChat();
      if (state.activeTabId === job.tabId) rerender();
    },
    commit() {
      saveChat();
      if (state.activeTabId === job.tabId) rerender();
    },
    done() {
      job.progress = null;
      if (job.preview && job.preview.startsWith('blob:')) { try { URL.revokeObjectURL(job.preview); } catch {} }
      job.preview = null;
      renderDrawer();
    },
    cleanup() { jobControllers.delete(job.id); },
  };
}

// Copy a job's status onto its placeholder bubble's fields (if it's still a
// placeholder — once replaced by a result it's a normal message we leave alone).
// Does NOT re-render; callers batch a single rerender after syncing.
function syncPlaceholder(job) {
  const found = findMsg(job.msgId);
  if (!found || !found.msg.bgPlaceholder) return false;
  found.msg.status = job.status;
  found.msg.label = job.label;
  found.msg.error = job.error;
  found.msg.progress = job.progress;   // so a renderChat redraws the bar at the right %
  found.msg.seg = job.seg;             // "第 N/M 段" for multi-segment video
  found.msg.elapsed = runningElapsed(job);   // "1:23" elapsed since the job started
  found.msg.queuePos = queuePosition(job);
  return true;
}

// Tick a running job's placeholder progress bar in place (no full chat re-render).
// Keeps the placeholder message's progress in sync for the next renderChat, and—if
// its tab is visible—pokes the bar's width directly, flipping it determinate.
function updatePlaceholderBar(job) {
  const found = findMsg(job.msgId);
  if (found && found.msg.bgPlaceholder) { found.msg.progress = job.progress; found.msg.seg = job.seg; found.msg.elapsed = runningElapsed(job); }
  if (state.activeTabId !== job.tabId) return;
  const el = document.querySelector(`[data-msg-id="${job.msgId}"]`);
  if (!el) return;
  const segEl = el.querySelector('.bgPhStatus');   // live "第 N/M 段 · 1:23"
  if (segEl) segEl.textContent = phStatusText(job);
  const bar = el.querySelector('.bgPhBar');
  const fill = el.querySelector('.bgPhBarFill');
  if (!bar || !fill || !job.progress || !job.progress.max) return;
  const pct = Math.min(100, Math.round(job.progress.value / job.progress.max * 100));
  bar.classList.remove('indeterminate');
  fill.style.width = pct + '%';
}

// Re-sync every placeholder (queue positions shift as jobs finish), then re-render
// the chat + drawer once. For DISCRETE events only (enqueue / status change /
// cancel / label) — never per progress tick (those call renderDrawer() alone).
function refreshPlaceholders() {
  cancelActiveDrag();   // a job started/finished/was added → abort any in-flight reorder
  for (const job of state.bgJobs) syncPlaceholder(job);
  rerender();
  renderDrawer();
}

// ---- cancel / retry --------------------------------------------------------

// Cancel & remove a job: abort if running, drop its placeholder (or result) bubble.
export function cancelBgJob(jobId) {
  const job = state.bgJobs.find((j) => j.id === jobId);
  if (!job) return;
  const ctrl = jobControllers.get(jobId);
  if (ctrl) { try { ctrl.abort(); } catch {} jobControllers.delete(jobId); }
  // Remove the bubble (placeholder or already-finished result) from its tab.
  const found = findMsg(job.msgId);
  if (found) { found.tab.messages.splice(found.index, 1); saveChat(); }
  const idx = state.bgJobs.indexOf(job);
  if (idx >= 0) state.bgJobs.splice(idx, 1);
  persist();
  refreshPlaceholders();
}

// Re-queue an interrupted/errored job using its persisted payload.
export function retryBgJob(jobId) {
  const job = state.bgJobs.find((j) => j.id === jobId);
  if (!job) return;
  job.status = 'queued';
  job.error = '';
  job.progress = null;
  assignWorker(job);   // re-route on retry — may land on a different online machine (failover)
  persist();
  refreshPlaceholders();
  pumpQueue();
}

// ---- navigation ------------------------------------------------------------

// Jump to a job's bubble: switch to its tab and scroll the placeholder into view.
export function jumpToJob(jobId) {
  const job = state.bgJobs.find((j) => j.id === jobId);
  if (!job) return;
  closeBgDrawer();
  if (state.activeTabId !== job.tabId) switchTab(job.tabId);
  setTimeout(() => {
    const el = document.querySelector(`[data-msg-id="${job.msgId}"]`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, 60);
}

// ---- drawer UI -------------------------------------------------------------

const KIND_ICON = { image: '🖼', video: '🎬', audio: '🔊', analyze: '🔍', url: '🔗', doc: '📄', docfull: '📄' };

export function openBgDrawer(flashJobId) {
  state.bgDrawerOpen = true;
  const d = document.querySelector('#bgJobsDrawer');
  if (d) d.classList.add('isOpen');
  renderDrawer();
  if (flashJobId) flashJobRow(flashJobId);
}

// Briefly flash a job's drawer row to draw the eye to it (e.g. after the user taps
// "go to background jobs" on its placeholder bubble). No-op if the row is gone
// (e.g. the job already finished and was auto-removed).
function flashJobRow(jobId) {
  setTimeout(() => {
    const list = document.querySelector('#bgJobsList');
    const row = list?.querySelector(`.bgJobRow[data-job-id="${jobId}"]`);
    if (!row) return;
    // Reveal the row by scrolling ONLY the list's own vertical scroll. NOT
    // row.scrollIntoView() — while the drawer is mid-slide the row is still off
    // the right edge, so scrollIntoView scrolls an ancestor horizontally and the
    // chat visibly jumps left until the animation settles, then snaps back.
    const r = row.getBoundingClientRect();
    const lr = list.getBoundingClientRect();
    if (r.top < lr.top) list.scrollTop -= (lr.top - r.top) + 8;
    else if (r.bottom > lr.bottom) list.scrollTop += (r.bottom - lr.bottom) + 8;
    row.classList.remove('bgJobFlash');
    void row.offsetWidth;            // restart the animation if it's still applied
    row.classList.add('bgJobFlash');
    const clear = () => row.classList.remove('bgJobFlash');
    row.addEventListener('animationend', clear, { once: true });
    setTimeout(clear, 1000);         // fallback (animationend can be flaky when backgrounded)
  }, 60);
}
export function closeBgDrawer() {
  state.bgDrawerOpen = false;
  const d = document.querySelector('#bgJobsDrawer');
  if (d) d.classList.remove('isOpen');
}
export function toggleBgDrawer() {
  if (state.bgDrawerOpen) closeBgDrawer(); else openBgDrawer();
}

// Elapsed time a running job has taken so far → "m:ss" / "h:mm:ss".
function fmtElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`;
}
function runningElapsed(job) { return job.startedAt ? fmtElapsed(Date.now() - job.startedAt) : ''; }
// Combined running status for a placeholder bubble: "第 N/M 段 · 1:23".
function phStatusText(job) { return [job.seg, runningElapsed(job)].filter(Boolean).join(' · '); }

// 1-second ticker that refreshes the elapsed time on every running job (drawer rows +
// the visible placeholder) without a full chat re-render. Self-stops when none run.
let _elapsedTimer = null;
function startElapsedTicker() {
  if (_elapsedTimer) return;
  _elapsedTimer = setInterval(() => {
    const running = state.bgJobs.filter((j) => j.status === 'running');
    if (!running.length) { clearInterval(_elapsedTimer); _elapsedTimer = null; return; }
    renderDrawer();   // drawer rows show elapsed in their status text
    for (const job of running) {
      const found = findMsg(job.msgId);
      if (found && found.msg.bgPlaceholder) found.msg.elapsed = runningElapsed(job);
      if (state.activeTabId !== job.tabId) continue;
      const el = document.querySelector(`[data-msg-id="${job.msgId}"] .bgPhStatus`);
      if (el) el.textContent = phStatusText(job);
    }
  }, 1000);
}

function statusText(job) {
  switch (job.status) {
    case 'queued': { const p = queuePosition(job); return p ? t('bg_statusQueued', { n: p }) : t('bg_statusQueuedPlain'); }
    case 'running': {
      const pct = job.progress && job.progress.max
        ? Math.min(100, Math.round(job.progress.value / job.progress.max * 100)) : null;
      const base = pct != null ? t('bg_statusRunningPct', { pct }) : t('bg_statusRunning');
      const head = job.seg ? `${job.seg} · ${base}` : base;   // "第 N/M 段 · 运行中 94%"
      const el = runningElapsed(job);
      return el ? `${head} · ${el}` : head;                    // … · 1:23
    }
    case 'done': return t('bg_statusDone');
    case 'error': return t('bg_statusError');
    case 'canceled': return t('bg_statusCanceled');
    case 'interrupted': return t('bg_statusInterrupted');
    default: return job.status;
  }
}

export function updateBadge() {
  const badge = document.querySelector('#bgJobsBadge');
  if (!badge) return;
  const n = unfinishedCount();
  badge.textContent = n ? String(n) : '';
  badge.hidden = n === 0;
}

// ---- reorder (drag) of queued jobs -----------------------------------------
// Only not-yet-started (queued) jobs can be reordered, by dragging their drawer
// rows. A drag is CANCELED if the queue changes underneath it (a job starts or
// finishes) — cancelActiveDrag is called from refreshPlaceholders on every status
// transition, so the stale drop becomes a no-op.
let bgDrag = null;          // { jobId } while a queued row is being dragged
let bgDragCanceled = false; // set when a start/finish aborts the in-flight drag

function cancelActiveDrag() {
  if (!bgDrag) return;
  bgDrag = null;
  bgDragCanceled = true;
  renderDrawer();           // rebuild fresh now that bgDrag is cleared (guard passes)
}

// Move queued job `srcId` to just before (or after, per `after`) queued job `tgtId`.
// No-op (just redraw) if either is no longer queued — e.g. it started/finished between
// dragstart and drop.
function reorderQueued(srcId, tgtId, after) {
  const src = state.bgJobs.find((j) => j.id === srcId);
  const tgt = state.bgJobs.find((j) => j.id === tgtId);
  if (!src || !tgt || src === tgt || src.status !== 'queued' || tgt.status !== 'queued' || laneOf(src) !== laneOf(tgt)) { renderDrawer(); return; }
  state.bgJobs.splice(state.bgJobs.indexOf(src), 1);
  const to = state.bgJobs.indexOf(tgt) + (after ? 1 : 0);
  state.bgJobs.splice(to, 0, src);
  persist();
  refreshPlaceholders();    // updates queue positions (排队第 N 位) + redraws the drawer
}

export function renderDrawer() {
  updateBadge();
  const list = document.querySelector('#bgJobsList');
  if (!list) return;
  // Don't rebuild the list mid-drag — replacing the dragged row breaks the gesture.
  // (Progress ticks still call this; they just skip until the drag ends or is canceled.)
  if (bgDrag) return;
  list.innerHTML = '';
  list.appendChild(buildWorkersBar());   // ComfyUI worker endpoints (parallel lanes) manager
  if (!state.bgJobs.length) {
    const empty = document.createElement('div');
    empty.className = 'bgJobsEmpty';
    empty.textContent = t('bg_empty');
    list.appendChild(empty);
    return;
  }
  // Group jobs by lane (worker). Lanes run in PARALLEL, so when more than one is in
  // play show a header per lane — the user sees what's running on which machine.
  const lanes = [];
  const byLane = new Map();
  for (const job of state.bgJobs) {
    const wid = laneOf(job);
    if (!byLane.has(wid)) { byLane.set(wid, []); lanes.push(wid); }
    byLane.get(wid).push(job);
  }
  const showHeaders = lanes.length > 1;
  for (const wid of lanes) {
    if (showHeaders) list.appendChild(buildLaneHeader(wid, byLane.get(wid)));
    for (const job of byLane.get(wid)) list.appendChild(buildJobRow(job));
  }
}

// The ComfyUI workers manager shown at the top of the drawer: each endpoint as a chip
// (online dot + model count, click to enable/disable, × to remove) + an Add button.
function buildWorkersBar() {
  const bar = document.createElement('div');
  bar.className = 'bgWorkersBar';
  const title = document.createElement('div');
  title.className = 'bgWorkersTitle';
  title.textContent = t('bg_workers');
  bar.appendChild(title);
  const chips = document.createElement('div');
  chips.className = 'bgWorkersChips';
  const reload = () => { if (_refreshWorkers) _refreshWorkers(); else renderDrawer(); };
  for (const w of state.bgWorkers) {
    const chip = document.createElement('span');
    chip.className = 'bgWorkerChip' + (w.enabled ? '' : ' disabled') + (w.online === false ? ' offline' : '');
    chip.title = w.url;
    const mc = w.models ? (w.models.image.size + w.models.edit.size + w.models.video.size) : 0;
    const meta = w.online === false ? t('bg_workerOffline') : t('bg_workerModels', { n: mc });
    chip.innerHTML = `<span class="bgWorkerDot">${w.online === false ? '○' : '●'}</span>`
      + `<span class="bgWorkerLabel">${escapeText(w.label)}</span>`
      + `<span class="bgWorkerMeta">${escapeText(meta)}</span>`;
    chip.addEventListener('click', () => { setBgWorkerEnabled(w.id, !w.enabled); reload(); });
    const x = document.createElement('button');
    // Same × look as a chat bubble's delete button; .bgWorkerRemove only resizes it.
    x.type = 'button'; x.className = 'messageAction deleteMessage bgWorkerRemove'; x.innerHTML = '<span class="bgWorkerX">×</span>'; x.title = t('bg_workerRemove');
    x.addEventListener('click', (e) => { e.stopPropagation(); removeBgWorker(w.id); reload(); });
    chip.appendChild(x);
    chips.appendChild(chip);
  }
  const add = document.createElement('button');
  add.type = 'button'; add.className = 'bgWorkerAdd'; add.textContent = '+ ' + t('bg_workerAdd');
  add.addEventListener('click', () => {
    const url = prompt('ComfyUI host:port', '127.0.0.1:8188');
    if (url && url.trim()) { addBgWorker(url); reload(); }
  });
  chips.appendChild(add);
  bar.appendChild(chips);
  return bar;
}

function laneLabel(wid) {
  if (wid === 'local') return t('bg_laneLocal');
  const w = state.bgWorkers.find((x) => x.id === wid);
  return (w && w.label) || wid.replace(/^comfy:/, '');
}
function buildLaneHeader(wid, jobs) {
  const h = document.createElement('div');
  h.className = 'bgLaneHeader';
  const running = jobs.filter((j) => j.status === 'running').length;
  const queued = jobs.filter((j) => j.status === 'queued').length;
  const w = wid === 'local' ? null : state.bgWorkers.find((x) => x.id === wid);
  const dot = wid === 'local' ? '' : `<span class="bgLaneDot ${w && w.online === false ? 'off' : 'on'}"></span>`;
  h.innerHTML = `${dot}<span class="bgLaneName">${escapeText(laneLabel(wid))}</span>`
    + `<span class="bgLaneCounts">${escapeText(t('bg_laneCounts', { running, queued }))}</span>`;
  return h;
}

function buildJobRow(job) {
  {
    const row = document.createElement('div');
    row.className = `bgJobRow bgJob-${job.status}`;
    row.dataset.jobId = job.id;

    // Only not-yet-started jobs can be dragged (via the ⠿ handle) to reorder the queue.
    if (job.status === 'queued') {
      const clearCue = () => row.classList.remove('bgDragOverTop', 'bgDragOverBottom');
      // Whether the pointer is in the lower half of this row → drop AFTER it, else before.
      const isAfter = (e) => { const r = row.getBoundingClientRect(); return e.clientY > r.top + r.height / 2; };
      // Drag is armed only by a mousedown on the handle, so clicking the row body
      // (which jumps to the bubble) never starts a drag.
      row.draggable = false;
      row.addEventListener('dragstart', (e) => {
        bgDrag = { jobId: job.id }; bgDragCanceled = false;
        if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', job.id); } catch {} }
      });
      row.addEventListener('dragover', (e) => {
        if (!bgDrag || bgDrag.jobId === job.id) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        const after = isAfter(e);
        row.classList.toggle('bgDragOverBottom', after);
        row.classList.toggle('bgDragOverTop', !after);
      });
      row.addEventListener('dragleave', clearCue);
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        const after = isAfter(e);
        clearCue();
        row.draggable = false;
        const src = (bgDrag && !bgDragCanceled) ? bgDrag.jobId : null;
        bgDrag = null; bgDragCanceled = false;
        if (src && src !== job.id) reorderQueued(src, job.id, after);
        else renderDrawer();
      });
      row.addEventListener('dragend', () => {
        clearCue();
        row.draggable = false;
        if (bgDrag) { bgDrag = null; bgDragCanceled = false; renderDrawer(); }
      });
      row.addEventListener('mouseup', () => { row.draggable = false; });
      const handle = document.createElement('span');
      handle.className = 'bgJobHandle';
      handle.textContent = '⠿';
      handle.title = t('bg_reorder');
      handle.addEventListener('mousedown', () => { row.draggable = true; });
      row.appendChild(handle);
    }

    const main = document.createElement('button');
    main.type = 'button';
    main.className = 'bgJobMain';
    main.title = t('bg_jumpTitle');
    main.addEventListener('click', () => jumpToJob(job.id));
    const icon = `<span class="bgJobIcon">${KIND_ICON[job.kind] || '⚙'}</span>`;
    const label = `<span class="bgJobLabel">${escapeText(job.label || job.kind)}</span>`;
    const status = `<span class="bgJobStatus">${escapeText(statusText(job))}</span>`;
    let bar = '';
    if (job.status === 'running' && job.progress && job.progress.max) {
      const pct = Math.min(100, Math.round(job.progress.value / job.progress.max * 100));
      bar = `<div class="bgJobBar"><div class="bgJobBarFill" style="width:${pct}%"></div></div>`;
    }
    // Live ComfyUI preview frame while the job renders (same stream the foreground
    // bubble uses). job.preview is a blob: URL maintained by the background sink.
    let preview = '';
    if (job.status === 'running' && job.preview) {
      preview = `<img class="bgJobPreview" src="${job.preview}" alt="preview">`;
    }
    main.innerHTML = `<div class="bgJobTop">${icon}${label}</div>${status}${bar}${preview}`;
    row.appendChild(main);

    if (job.status === 'error' || job.status === 'interrupted') {
      const actions = document.createElement('div');
      actions.className = 'bgJobActions';
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'bgJobRetry';
      retry.textContent = '↻';
      retry.title = t('bg_retry');
      retry.addEventListener('click', (e) => { e.stopPropagation(); retryBgJob(job.id); });
      actions.appendChild(retry);
      row.appendChild(actions);
    }
    // Close (×) — same look as a chat bubble's delete button (.messageAction
    // .deleteMessage); .bgJobCancel only pins it to the row's top-right corner.
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'messageAction deleteMessage bgJobCancel';
    del.textContent = '×';
    del.title = (job.status === 'running' || job.status === 'queued') ? t('bg_cancel') : t('bg_remove');
    del.addEventListener('click', (e) => { e.stopPropagation(); cancelBgJob(job.id); });
    row.appendChild(del);

    return row;
  }
}

function escapeText(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---- startup restore -------------------------------------------------------

// Load the persisted queue. A job that was 'running' when the page died can't be
// recovered (its in-page work is gone) → mark 'interrupted' (retryable). 'queued'
// jobs still have their payload, so the runner resumes them.
export async function restoreBgJobsOnLoad() {
  let jobs = [];
  try { jobs = await dbLoadJobs(); } catch { jobs = []; }
  for (const j of jobs) {
    if (j.status === 'running') { j.status = 'interrupted'; j.progress = null; }
  }
  state.bgJobs = jobs;
  persist();
  // Re-sync placeholders to their restored status + render chat/drawer.
  refreshPlaceholders();
  pumpQueue();
}

// Load the persisted ComfyUI worker list (runtime online/models start unknown — the
// health/scan code refreshes them). Call before restoreBgJobsOnLoad so lanes resolve.
export async function restoreBgWorkersOnLoad() {
  let workers = [];
  try { workers = await dbLoadWorkers(); } catch { workers = []; }
  state.bgWorkers = workers.map((w) => ({ ...w, online: undefined, models: null }));
  renderDrawer();
}