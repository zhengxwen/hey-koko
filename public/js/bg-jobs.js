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
import { setServerQueueDeps, cancelServerJob, ackServerJob, pauseServerJob, resumeServerJob, reorderServerJobs, cancelConversationServerJobs, serverJobTiming } from './server-queue.js';   // Option B

// renderChat + the analysis generators are injected (chat.js imports this module, so
// importing it back would be circular). Set from main.js via setBgDeps.
let _renderChat = null;
let _analyzeMedia = null;
let _regenerateReply = null;
let _parseDocumentHeadless = null;
let _handleUrlCommand = null;
let _handleMultiUrlCommand = null;
let _refreshWorkers = null;   // re-scan worker endpoints (ollama.refreshBgWorkers), injected
let _libraryImport = null;    // library.runLibraryImport — any import → library doc, injected
let _onJobsChanged = null;    // library.notifyLibraryJobsChanged — refresh the import-task count
let _openLibrary = null;      // library.openLibraryPanel — clicking a library job returns there
export function setBgDeps({ renderChat, analyzeMedia, regenerateReply, parseDocumentHeadless, handleUrlCommand, handleMultiUrlCommand, refreshWorkers, libraryImport, onJobsChanged, openLibrary }) {
  if (renderChat) _renderChat = renderChat;
  if (analyzeMedia) _analyzeMedia = analyzeMedia;
  if (regenerateReply) _regenerateReply = regenerateReply;
  if (parseDocumentHeadless) _parseDocumentHeadless = parseDocumentHeadless;
  if (handleUrlCommand) _handleUrlCommand = handleUrlCommand;
  if (handleMultiUrlCommand) _handleMultiUrlCommand = handleMultiUrlCommand;
  if (refreshWorkers) _refreshWorkers = refreshWorkers;
  if (libraryImport) _libraryImport = libraryImport;
  if (onJobsChanged) _onJobsChanged = onJobsChanged;
  if (openLibrary) _openLibrary = openLibrary;
}
function rerender() { if (_renderChat) _renderChat(); }

// Runtime-only AbortControllers, keyed by job id. NOT stored on the job objects
// (which get structured-cloned into IndexedDB and can't hold a controller).
const jobControllers = new Map();

// Monotonic batch-enqueue counter. Each bg job gets an increasing `seq` at enqueue, so the
// SERVER can run a fire-all batch in the ORDER THE USER ENQUEUED IT — not the order the jobs
// happened to win the race through their (concurrent) source-video uploads. Seeded past the
// max persisted seq on reload so it stays monotonic across sessions.
let _enqueueSeq = 0;

// Per-lane SUBMISSION gate. Video jobs each upload their source clip to ComfyUI before they can
// submit, and those uploads finish in a RACE — so without coordination the server receives (and
// immediately starts) them out of enqueue order. fireJob runs in enqueue order, so we chain each
// video job's POST /api/jobs behind the previous one's: uploads still run concurrently, but the
// submissions go out 1→2→3. Keyed by lane (laneOf), value = the tail promise of the chain.
const laneSubmitChain = new Map();

// ---- keep-awake -------------------------------------------------------------
// Sleep prevention is owned by the SERVER (server/jobs.js holds a `caffeinate` while
// its job queue is non-empty), so the host Mac stays awake regardless of whether this
// tab is visible — no client-side Screen Wake Lock here.

// ---- persistence -----------------------------------------------------------

// Strip runtime-only fields before persisting (controllers live in the Map; the
// preview is a transient blob: URL that's meaningless after a reload).
function persist() {
  const clean = state.bgJobs.map(({ preview, seg, _fired, _inflight, _runLabel, _submitWait, _submitRelease, _failReason, ...j }) => j);
  dbSaveJobs(clean).catch((e) => console.warn('[bg-jobs] persist failed:', e));
}
// Let the server-queue client persist a job's serverJobId (so a reload can reconnect),
// and feed mid-run progress for server-side jobs (e.g. /url youtube) back onto the local
// job → drawer/placeholder repaint (the live-progress channel non-ComfyUI jobs lacked).
setServerQueueDeps({
  persist,
  onProgress: (sjob) => {
    const job = state.bgJobs.find((j) => j.serverJobId === sjob.id);
    if (!job) return;
    // The SERVER decides what's actually running (jobs are submitted up front but run
    // one-at-a-time per lane). First time the server reports this job running → flip the
    // bg status 'queued'→'running' so the drawer shows the real progression.
    const becameRunning = job.status === 'queued';
    if (becameRunning) { job.status = 'running'; if (job._runLabel) job.label = job._runLabel; startElapsedTicker(); }
    // Elapsed clock follows the SERVER's authoritative start time (the queue server shares
    // this machine's wall clock). This is what makes elapsed correct across a page reload:
    // a job that ran for minutes on the server while the page was gone shows that real
    // elapsed instead of restarting from 0 the moment the SSE re-reports it running.
    if (sjob.startedAt) job.startedAt = sjob.startedAt;
    else if (becameRunning && !job.startedAt) job.startedAt = Date.now();
    const lbl = bgProgressLabel(sjob.label, sjob.progress);
    if (lbl) job.label = lbl;
    job.progress = sjob.progress || null;
    if (becameRunning) { persist(); refreshPlaceholders(); }
    else { renderDrawer(); updatePlaceholderBar(job); }
  },
});

// Map a server job's progress STAGE → a localized drawer label (server stays i18n-free,
// only emits the stage name + {value,max}). whisper % shows via job.progress in statusText.
function bgProgressLabel(stage, progress) {
  switch (stage) {
    case 'transcribing': return t('bg_transcribing');
    case 'downloading': return t('bg_downloadingAudio');
    case 'converting': return t('bg_convertingAudio');
    case 'formatting': return t('bg_formattingSubs', progress ? { i: progress.value + 1, n: progress.max } : { i: 1, n: 1 });
    // libimport (server-side library import) stages
    case 'fetching': return t('bg_fetchingContent');
    case 'parsing': return t('bg_parsing');
    case 'importing': return t('lib_importing');
    case 'distilling': return t('bg_distilling');
    default: return '';
  }
}

// ---- queue helpers ---------------------------------------------------------

export function bgQueueActive() {
  return state.bgJobs.some((j) => j.status === 'queued' || j.status === 'running');
}

// Active IN-PAGE jobs (analysis: analyze/docfull/url — they splice output at a captured
// cursor, so a concurrent resend/edit would shift positions and corrupt them). Server-side
// GENERATION jobs (serverJobId set) are detached + reattach by msgId, so they DON'T block
// resend/edit — that's the whole point of running them in the background.
export function bgInPageActive() {
  return state.bgJobs.some((j) => !j.serverJobId && (j.status === 'queued' || j.status === 'running'));
}

// Active (queued/running) jobs belonging to a conversation — used by archive/delete
// to warn + cancel before the conversation goes away (covers both in-page analysis
// jobs and server-side gen jobs, which are all entries in state.bgJobs).
export function tabActiveJobCount(tabId) {
  return state.bgJobs.filter((j) => j.tabId === tabId && (j.status === 'queued' || j.status === 'running' || j.status === 'paused')).length;
}
export function cancelTabJobs(tabId) {
  for (const j of state.bgJobs.filter((j) => j.tabId === tabId && (j.status === 'queued' || j.status === 'running' || j.status === 'paused'))) cancelBgJob(j.id);
  cancelConversationServerJobs(tabId);   // server-side belt-and-suspenders
}

function unfinishedCount() {
  return state.bgJobs.filter((j) => j.status === 'queued' || j.status === 'running' || j.status === 'paused').length;
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
export function setBgWorkerStatus(url, { online, models, hostname }) {
  const w = state.bgWorkers.find((x) => x.url === url);
  if (!w) return;
  if (online !== undefined) w.online = online;
  if (models !== undefined) w.models = models;
  if (hostname !== undefined && hostname !== w.hostname) { w.hostname = hostname; persistWorkers(); }
  renderDrawer();
}

// ---- enqueue ---------------------------------------------------------------

// Add a job to the FIFO queue and drop a placeholder message into its source tab.
// payload carries everything needed to (re)run the generator headlessly. insertIndex
// places the placeholder bubble (e.g. right after the resent user bubble); -1 appends.
export function enqueueBgJob({ tabId, kind, label, payload, insertIndex = -1, status = 'queued', enhancedPrompt = null, noPlaceholder = false }) {
  const tab = getTab(tabId);
  if (!tab) return null;
  const msgId = genId();
  const job = {
    id: genId(),
    tabId,
    msgId,
    kind,
    noPlaceholder,        // drawer-only job (e.g. library imports): no in-chat placeholder bubble
    label: label || '',
    // The queued/enqueue-time label (persisted, never overwritten by a running-phase
    // label). A running job's label is swapped to an "in progress" text (e.g. "正在获取内容")
    // — on reload a re-queued job restores baseLabel so a NOT-yet-started row never shows it.
    baseLabel: label || '',
    // 'enhancing' = prompt is being rewritten up-front (foreground); pumpLane only
    // picks 'queued', so the job stays parked until releaseEnhancingJob flips it.
    status,
    progress: null,
    payload,
    enhancedPrompt,        // shown in the placeholder bubble (set at enqueue)
    error: '',
    createdAt: Date.now(),
    seq: _enqueueSeq++,   // batch-enqueue order → server runs the batch in THIS order (not upload-race order)
  };
  state.bgJobs.push(job);
  assignWorker(job);   // pick which backend/lane runs it (snapshot, like modelOverride)
  // Persisted placeholder bubble — at insertIndex (resend/edit: just after the user
  // bubble) or appended (fresh sends). Reattach is by msgId, so position is free.
  // noPlaceholder jobs (library imports) run drawer-only: no in-chat bubble at all.
  if (!noPlaceholder) {
    const placeholder = {
      id: msgId,
      role: 'assistant',
      content: '',          // keep .content access safe; never sent to the model
      bgPlaceholder: true,
      jobId: job.id,
      kind,
      label: job.label,
      status,
      enhancedPrompt,
      timestamp: Date.now(),
    };
    if (insertIndex >= 0 && insertIndex <= tab.messages.length) tab.messages.splice(insertIndex, 0, placeholder);
    else tab.messages.push(placeholder);
  }
  saveChat();
  persist();
  refreshPlaceholders();
  pumpQueue();
  return job;
}

// Flip a job created in the 'enhancing' state to 'queued' once its prompt rewrite is
// done — stamping the enhanced text (shown in the placeholder + carried in the payload)
// and kicking the lane runner. Called from enqueueImagineGen after /api/enhance-prompt.
export function releaseEnhancingJob(job, enhancedPrompt) {
  // Canceled DURING enhancement (cancelBgJob spliced it out of state.bgJobs while the
  // /api/enhance-prompt call was still in flight) → must NOT enter the queue. The
  // membership check is the real guard; status alone isn't enough (cancel doesn't
  // change job.status, it removes the job).
  if (!job || job.status !== 'enhancing' || !state.bgJobs.includes(job)) return;
  if (enhancedPrompt) job.enhancedPrompt = enhancedPrompt;
  job.status = 'queued';
  persist();
  refreshPlaceholders();
  pumpQueue();
}

// ---- the serial runner -----------------------------------------------------

// FIRE EVERY queued job UP FRONT. Each job's generator submits it to the SERVER queue
// (jobs.js) in this call's first async chunk — which runs at Send time, FOREGROUND — and
// the SERVER serializes execution per ComfyUI lane (+ persists results to disk). So once
// the jobs are submitted, the whole queue drains server-side EVEN IF this tab is later
// frozen/closed; the browser just renders results as they arrive (live, or via the SSE
// snapshot on return). Execution order/status is the SERVER's truth — reflected here via
// onProgress (server 'running' → bg 'running'), so we never fake-'running' a job that's
// actually still queued behind others on the GPU.
export function pumpQueue() {
  const lanes = new Set(state.bgJobs.filter((j) => j.status === 'queued' && !j._fired).map(laneOf));
  for (const wid of lanes) pumpLane(wid);
}
function pumpLane(workerId) {
  let job;
  while ((job = state.bgJobs.find((j) => j.status === 'queued' && !j._fired && laneOf(j) === workerId))) {
    fireJob(job);   // not awaited — concurrent submit; the server serializes the actual runs
  }
}

// Run ONE job: its generator submits to the server + awaits + renders the result; we then
// finalize (ack / auto-remove). NOTE: status stays 'queued' until the SERVER starts it
// (onProgress flips it to 'running') — we don't set 'running' here, since many jobs are
// fired at once but only one runs on the GPU at a time.
async function fireJob(job) {
  job._fired = true;                                  // runtime-only guard (stripped from persist)
  job._inflight = true;                               // a generator is actively running for this job (vs merely _fired)
  job._failReason = null;                             // fresh run — clear any stale sink.fail() from a previous attempt
  // Chain this VIDEO job's server submission behind the previous one in its lane (fireJob runs
  // in enqueue order), so a fire-all batch reaches the queue 1→2→3 despite the concurrent
  // source-video upload race. submitAndAwait awaits _submitWait before POSTing, then calls
  // _submitRelease the instant the job is on the server (not when it finishes rendering).
  // Guards: only enroll a job that will actually POST — NOT a reconnecting job (serverJobId
  // already set, won't re-POST) and NOT one that already holds a slot (a pause→resume re-fire
  // must reuse the in-flight slot, never orphan it — that would deadlock the whole lane).
  if (job.kind === 'video' && !job.serverJobId && !job._submitRelease) {
    const lane = laneOf(job);
    const prev = laneSubmitChain.get(lane) || Promise.resolve();
    let release;
    const mine = new Promise((r) => { release = r; });
    laneSubmitChain.set(lane, prev.then(() => mine));
    job._submitWait = prev;
    job._submitRelease = release;
  }
  // startedAt (the elapsed clock) is stamped when the job ACTUALLY starts running on the GPU
  // — in onProgress (server SSE) / markRunning — NOT here. Fire-all submits every job up front
  // but the server runs them one at a time, so stamping it here would make a job that waited
  // in the queue show its whole wait as "elapsed" the instant it finally starts.
  startElapsedTicker();
  try {
    await runJob(job);
    // Generators handle their own failures (they place an error bubble in chat and return
    // normally) — sink.fail(reason) is how they tell US it failed, so the job stays in the
    // drawer marked 'error' with the reason instead of being auto-removed as 'done'.
    if (job.status !== 'canceled') {
      if (job._failReason) { job.status = 'error'; job.error = job._failReason; }
      else job.status = 'done';
    }
  } catch (e) {
    if (e && e.bgCanceled) job.status = 'canceled';
    else { job.status = 'error'; job.error = (e && e.message) || String(e); }
  }
  job._inflight = false;
  // Belt-and-suspenders: never leave the lane chain stalled if this job died before submitting
  // (submitAndAwait already releases on a normal submit/reconnect; releasing twice is a no-op).
  if (job._submitRelease) { job._submitRelease(); job._submitRelease = null; }
  jobControllers.delete(job.id);
  // Option B: server-side gen job finished → ack it (server drops the delivered result).
  // On error/interrupted clear serverJobId so a retry submits a fresh job.
  if (job.serverJobId) {
    ackServerJob(job.serverJobId);
    if (job.status !== 'done') job.serverJobId = null;
  }
  // Auto-remove a successfully-finished job — its result is already in the chat.
  if (job.status === 'done') {
    const i = state.bgJobs.indexOf(job);
    if (i >= 0) state.bgJobs.splice(i, 1);
  }
  persist();
  refreshPlaceholders();
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
  } else if (job.kind === 'libimport') {
    await runLibImport(job, sink);
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
  if (images.length) {
    previewMsg.contextImages = images.map((img) => img.base64);
    // Keep each embedded image's own filename (e.g. from a PDF/DOCX) for its download name.
    if (images.some((img) => img.name)) previewMsg.imageNames = images.map((img) => img.name || null);
  }
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
  // Failed (sink.fail was called) → KEEP the placeholder: it becomes the in-chat error
  // marker with a working ↻ (retry re-anchors at it; without it a retry finds no msgId
  // and silently no-ops). On success the real bubbles replaced it — drop it.
  if (!job._failReason) removePlaceholder(job);
}

// libimport: import anything (file/text/url/youtube) into the Knowledge Library HEADLESS
// (parse/fetch/whisper/format + embed + enrich, with progress in the drawer). No chat
// output — the result is a library doc; the placeholder is dropped when it finishes.
async function runLibImport(job, sink) {
  if (_libraryImport) await _libraryImport(job.payload || {}, sink);
  removePlaceholder(job);
}

// Background sink: same shape as foregroundSink, but writes to the job record +
// placeholder + drawer instead of the live state.pendingGen bubble.
function makeBgSink(job, controller) {
  // STABLE ComfyUI progress clientId for this job: the server queues the ComfyUI
  // prompt under it, so reusing it on a post-reload reconnect lets the browser
  // re-subscribe to the SAME WS stream → live progress resumes (a fresh id would
  // miss the running prompt's broadcasts and sit at 0% until completion). Generated
  // once + persisted; cleared on retry (that's a brand-new server run).
  if (!job.comfyClientId) {
    job.comfyClientId = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `hk-${job.id}`;
    persist();
  }
  // Jobs are submitted to the server up front but run one-at-a-time per lane, so a job
  // stays 'queued' until it's ACTUALLY rendering. The first real render signal (ComfyUI
  // progress / preview / segment) flips it → 'running'. This is the reliable signal for a
  // count>1 job too (whose N server jobs aren't tracked by a single serverJobId, so
  // onProgress can't flip it).
  const markRunning = () => {
    if (job.status !== 'queued') return;
    // A server-queued job (single serverJobId) is flipped to 'running' ONLY by the
    // server's SSE (setServerQueueDeps.onProgress). The server serializes each lane, so
    // it alone knows which job is actually on the GPU. We must NOT flip from the ComfyUI
    // progress WS here: ComfyUI broadcasts the running prompt's progress/preview frames to
    // EVERY open client socket, so a sibling still queued behind it would otherwise be
    // fooled into showing 'running' too (the "三个一起运行" bug). markRunning stays the flip
    // path only for a count>1 job, whose N sub-runs share no single serverJobId to track.
    if (job.serverJobId) return;
    job.status = 'running';
    if (job._runLabel) job.label = job._runLabel;   // now show the generator's "正在生成…" label
    if (!job.startedAt) job.startedAt = Date.now();  // elapsed clock starts NOW (actual run), not at fire time
    startElapsedTicker();
    persist();
    refreshPlaceholders();
  };
  return {
    background: true,
    signal: controller.signal,
    tabId: job.tabId,
    // Option B: identifies this job to the server queue so generation runs server-side
    // (image/video/audio). Generators submit via comfyFetch/ttsFetch when this is set.
    server: { bgJob: job, conversationId: job.tabId, msgId: job.msgId, label: job.label, comfyUrl: job.workerUrl || '', comfyClientId: job.comfyClientId },
    lock() {},                 // never lock the send button for a background run
    started() { return true; }, // placeholder already exists
    // While the job is still QUEUED on the server (fired up front but not yet its turn on
    // the GPU), keep the queued label — stash the generator's "正在生成…" label and only
    // apply it once the job actually starts (markRunning / onProgress).
    start(kind, label) { if (label) { if (job.status === 'running') job.label = label; else job._runLabel = label; } refreshPlaceholders(); },
    label(l) { if (job.status === 'running') job.label = l; else job._runLabel = l; refreshPlaceholders(); },
    enhanced() {},             // surfaced in the final message instead
    addImage() {},             // results delivered via place()
    // Generator-reported failure: the run ends "normally" (error bubble already placed in
    // chat) but the JOB failed — record why so fireJob marks it 'error' (stays in the
    // drawer with the reason) instead of 'done' (auto-removed). First reason wins.
    fail(reason) { if (!job._failReason) job._failReason = String(reason || '').trim() || t('bg_statusError'); },
    // Progress ticks are frequent → update the drawer + poke the placeholder's bar
    // directly in the DOM, never a full chat re-render.
    progress(v, m) {
      if (!m) return;
      markRunning();
      // Still 'queued' → this frame is CROSS-TALK from the sibling that's actually on the
      // GPU (ComfyUI broadcasts progress to every open socket). Ignore it so a waiting job
      // never shows a bar / "running" %.
      if (job.status !== 'running') return;
      job.progress = { value: v, max: m }; renderDrawer(); updatePlaceholderBar(job);
    },
    // Live preview frame → shown in the drawer row. Revoke the prior blob URL.
    preview(url) {
      markRunning();
      if (job.status !== 'running') { try { URL.revokeObjectURL(url); } catch {} return; }   // cross-talk frame for a still-queued job → drop it (free the blob)
      if (job.preview && job.preview !== url && job.preview.startsWith('blob:')) { try { URL.revokeObjectURL(job.preview); } catch {} }
      job.preview = url;
      renderDrawer();
    },
    eta() {},
    // Multi-segment video: "第 N/M 段" — surface which chunk is rendering. Changes only
    // at chunk boundaries; refresh the drawer/placeholder then (progress() also redraws).
    seg(x) { markRunning(); if (job.status !== 'running') return; if (job.seg !== x) { job.seg = x; renderDrawer(); updatePlaceholderBar(job); } },
    indeterminate() {},
    clearBubble() {},          // placeholder persists until place() swaps it
    // Swap the placeholder message for the real result (keeping its id/position).
    place(msg) {
      const found = findMsg(job.msgId);
      if (!found) return; // canceled / deleted mid-run — drop the result
      msg.id = job.msgId;
      // Generation bubbles (image/video/audio): record the SERVER-authoritative generation
      // time + duration, so the bubble shows when it was actually produced (and the ⏱ how
      // long it took) — correct even if the page was closed for the whole render. Scoped to
      // pure generation kinds so it never touches the youtube-reply / analyze place() paths.
      if (job.kind === 'image' || job.kind === 'video' || job.kind === 'audio') {
        const timing = serverJobTiming(job.serverJobId);
        if (timing && timing.finishedAt) msg.timestamp = timing.finishedAt;
        if (timing && timing.startedAt && timing.finishedAt && msg.genMs == null) msg.genMs = timing.finishedAt - timing.startedAt;
      }
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
  found.msg.enhancedPrompt = job.enhancedPrompt;   // server-side --enhance preview (before render)
  return true;
}

// Tick a running job's placeholder progress bar in place (no full chat re-render).
// Keeps the placeholder message's progress in sync for the next renderChat, and—if
// its tab is visible—pokes the bar's width directly, flipping it determinate.
function updatePlaceholderBar(job) {
  const found = findMsg(job.msgId);
  if (found && found.msg.bgPlaceholder) { found.msg.label = job.label; found.msg.progress = job.progress; found.msg.seg = job.seg; found.msg.elapsed = runningElapsed(job); }
  if (state.activeTabId !== job.tabId) return;
  const el = document.querySelector(`[data-msg-id="${job.msgId}"]`);
  if (!el) return;
  // Follow the job's label in place so the in-chat placeholder tracks phase changes
  // (e.g. a /url youtube job going 正在获取内容… → 正在整理字幕（i/n）…), matching the
  // drawer. Same " · " split as the bubble's initial render (main label + detail).
  const parts = (job.label || '').split(' · ');
  const labelEl = el.querySelector('.bgPhLabel');
  if (labelEl) labelEl.textContent = parts[0] || '';
  const modelEl = el.querySelector('.bgPhModel');
  if (modelEl) modelEl.textContent = parts.slice(1).join(' · ');
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
  // If it was parked at the lane submit-gate, free the slot so later video jobs aren't blocked
  // behind a job that's now gone.
  if (job._submitRelease) { job._submitRelease(); job._submitRelease = null; }
  if (job.serverJobId) cancelServerJob(job.serverJobId);   // Option B: cancel it on the server too
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
  job.comfyClientId = null; // brand-new server run → fresh ComfyUI progress stream
  job.startedAt = null;   // fresh elapsed clock — this is a brand-new run, not a resume
  job._fired = false;     // allow the fire-all runner to pick it up again
  assignWorker(job);   // re-route on retry — may land on a different online machine (failover)
  persist();
  refreshPlaceholders();
  pumpQueue();
}

// Pause a not-yet-started job so the runner skips it (status 'paused' ≠ 'queued').
export function pauseBgJob(jobId) {
  const job = state.bgJobs.find((j) => j.id === jobId);
  if (!job || job.status !== 'queued') return;
  // Fire-all submits jobs to the server up front, so pausing must happen THERE: the
  // server skips a 'paused' job (only while it's still waiting — a job already rendering
  // ignores it). The job's generator keeps awaiting, so resume just lets it run.
  if (job.serverJobId) pauseServerJob(job.serverJobId);
  job.status = 'paused';
  persist();
  refreshPlaceholders();
}
// Resume a paused job → back into the queue (and kick the runner).
export function resumeBgJob(jobId) {
  const job = state.bgJobs.find((j) => j.id === jobId);
  if (!job || job.status !== 'paused') return;
  job.status = 'queued';
  if (job.serverJobId) {
    resumeServerJob(job.serverJobId);   // server re-queues it; the ALREADY-awaiting generator renders the result
    // do NOT reset _fired here — re-firing would start a second generator for this job
  } else if (!job._inflight) {
    job._fired = false;                 // never actually fired → let pumpQueue fire it
  }
  // else: a generator is already running for this job (parked at the submit gate). Leave _fired
  // set — it proceeds when the gate opens. Re-firing would start a 2nd generator AND orphan the
  // lane's chain slot (the new fireJob would overwrite _submitRelease), deadlocking the lane.
  persist();
  refreshPlaceholders();
  pumpQueue();
}

// Pause EVERY not-yet-started (queued) job at once — batches the server-pause calls and
// does a single re-render (vs. pauseBgJob's per-job persist/refresh). Running/paused jobs
// are untouched.
export function pauseAllQueued() {
  let changed = false;
  for (const job of state.bgJobs) {
    if (job.status !== 'queued') continue;
    if (job.serverJobId) pauseServerJob(job.serverJobId);
    job.status = 'paused';
    changed = true;
  }
  if (!changed) return;
  persist();
  refreshPlaceholders();
}

// Resume EVERY paused job at once — same per-job rules as resumeBgJob (server re-queue
// vs. local re-fire, _inflight guard) but batched into one persist/re-render + pump.
export function resumeAllPaused() {
  let changed = false;
  for (const job of state.bgJobs) {
    if (job.status !== 'paused') continue;
    job.status = 'queued';
    if (job.serverJobId) resumeServerJob(job.serverJobId);
    else if (!job._inflight) job._fired = false;
    // else: a generator is already parked at the submit gate — leave _fired set (see resumeBgJob)
    changed = true;
  }
  if (!changed) return;
  persist();
  refreshPlaceholders();
  pumpQueue();
}

// Turn a failed job's live error placeholder into a PERMANENT chat bubble (strip the
// bgPlaceholder flag + bake the error text into content), so it survives clearing the task
// list and a reload instead of being pruned as an orphan placeholder. No-op if the bubble
// is already gone.
function finalizeErrorBubble(job) {
  const found = findMsg(job.msgId);
  if (!found || !found.msg.bgPlaceholder) return;
  const m = found.msg;
  const mainLabel = (job.label || '').split(' · ')[0] || t('bg_statusError');
  m.content = `⚠️ ${mainLabel}${job.error ? '：' + job.error : ''}`;
  m.role = 'assistant';
  if (!m.timestamp) m.timestamp = Date.now();
  delete m.bgPlaceholder;
  delete m.jobId; delete m.status; delete m.label; delete m.error;
  m.progress = null; m.seg = null; m.enhancedPrompt = null;
}

// Delete ALL tasks in the drawer (after user confirmation). Failed jobs (error/interrupted)
// KEEP their bubble in the chat — the placeholder is finalized into a permanent error note;
// only the drawer entry is removed. Everything else (running/queued/paused) is canceled via
// cancelBgJob, which drops its placeholder. (Done jobs already auto-removed.)
export function clearAllJobs() {
  if (!state.bgJobs.length) return;
  const n = state.bgJobs.length;
  if (!confirm(t('bg_clearAllConfirm', { n }))) return;
  for (const job of [...state.bgJobs]) {
    if (job.status === 'error' || job.status === 'interrupted') {
      finalizeErrorBubble(job);
      const idx = state.bgJobs.indexOf(job);
      if (idx >= 0) state.bgJobs.splice(idx, 1);
    } else {
      cancelBgJob(job.id);   // aborts runner + cancels server job + removes placeholder
    }
  }
  saveChat();
  persist();
  refreshPlaceholders();
}

// ---- navigation ------------------------------------------------------------

// Jump to a job's bubble: switch to its tab and scroll the placeholder into view.
export function jumpToJob(jobId) {
  const job = state.bgJobs.find((j) => j.id === jobId);
  if (!job) return;
  closeBgDrawer();
  // Library-import jobs have no chat bubble — clicking one returns to the library panel.
  if (job.kind === 'libimport') { if (_openLibrary) _openLibrary(); return; }
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
    case 'paused': return t('bg_statusPaused');
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
  // Mirror the new order to the SERVER queue so it actually RUNS in this order — not just
  // displays it. Only already-submitted jobs (serverJobId set) can be reordered server-side; a
  // job still parked at the submit gate takes its place when it lands (enqueue order).
  const lane = laneOf(src);
  const orderedIds = state.bgJobs
    .filter((j) => j.status === 'queued' && laneOf(j) === lane && j.serverJobId)
    .map((j) => j.serverJobId);
  if (orderedIds.length) reorderServerJobs(orderedIds);
  refreshPlaceholders();    // updates queue positions (排队第 N 位) + redraws the drawer
}

export function renderDrawer() {
  updateBadge();
  if (_onJobsChanged) _onJobsChanged();   // let the library panel refresh its import-task count
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
  const summary = buildJobsSummary();
  if (summary) list.appendChild(summary);
  list.appendChild(buildJobsActions());
  const showHeaders = lanes.length > 1;
  for (const wid of lanes) {
    if (showHeaders) list.appendChild(buildLaneHeader(wid, byLane.get(wid)));
    for (const job of sortLaneForDisplay(byLane.get(wid))) list.appendChild(buildJobRow(job));
  }
}

// One-line tally at the top of the list: "N running · M queued · K paused" (only the
// non-zero parts). Returns null when nothing is pending (only finished/failed rows left).
function buildJobsSummary() {
  const running = state.bgJobs.filter((j) => j.status === 'running').length;
  const queued = state.bgJobs.filter((j) => j.status === 'queued').length;
  const paused = state.bgJobs.filter((j) => j.status === 'paused').length;
  const parts = [];
  if (running) parts.push(t('bg_sumRunning', { n: running }));
  if (queued) parts.push(t('bg_sumQueued', { n: queued }));
  if (paused) parts.push(t('bg_sumPaused', { n: paused }));
  if (!parts.length) return null;
  const el = document.createElement('div');
  el.className = 'bgJobsSummary';
  el.textContent = parts.join(' · ');
  return el;
}

// Bulk-action row under the summary: "pause all waiting" (only when some are queued) +
// "resume all" (only when some are paused) + "delete all" (always, since the list is
// non-empty when this renders).
function buildJobsActions() {
  const bar = document.createElement('div');
  bar.className = 'bgJobsActions';
  const queued = state.bgJobs.filter((j) => j.status === 'queued').length;
  if (queued) {
    const pauseAll = document.createElement('button');
    pauseAll.type = 'button';
    pauseAll.className = 'bgJobsActionBtn';
    pauseAll.textContent = t('bg_pauseAll', { n: queued });
    pauseAll.addEventListener('click', pauseAllQueued);
    bar.appendChild(pauseAll);
  }
  const paused = state.bgJobs.filter((j) => j.status === 'paused').length;
  if (paused) {
    const resumeAll = document.createElement('button');
    resumeAll.type = 'button';
    resumeAll.className = 'bgJobsActionBtn';
    resumeAll.textContent = t('bg_resumeAll', { n: paused });
    resumeAll.addEventListener('click', resumeAllPaused);
    bar.appendChild(resumeAll);
  }
  const clearAll = document.createElement('button');
  clearAll.type = 'button';
  clearAll.className = 'bgJobsActionBtn danger';
  clearAll.textContent = t('bg_clearAll');
  clearAll.addEventListener('click', clearAllJobs);
  bar.appendChild(clearAll);
  return bar;
}

// Display order within a lane: running first, then waiting (queued), then paused, then
// finished/failed. Stable sort → queued jobs keep their (drag-reorderable) FIFO order.
// Display-only: the actual run order still follows state.bgJobs insertion order.
const BG_STATUS_ORDER = { running: 0, queued: 1, paused: 2, interrupted: 3, error: 3, canceled: 4, done: 4 };
function sortLaneForDisplay(jobs) {
  return jobs
    .map((job, i) => ({ job, i }))   // index keeps the sort stable across all engines
    .sort((a, b) => ((BG_STATUS_ORDER[a.job.status] ?? 9) - (BG_STATUS_ORDER[b.job.status] ?? 9)) || (a.i - b.i))
    .map((x) => x.job);
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

// Human-readable address of the machine actually running this job — "host:port (hostname)"
// for a ComfyUI worker, or the configured local backend for the 'local' lane. Used to
// append the real execution host to the jump tooltip while a job is running.
function jobMachine(job) {
  if (job.workerUrl) {
    const w = state.bgWorkers.find((x) => x.url === job.workerUrl);
    return job.workerUrl + (w && w.hostname ? ` (${w.hostname})` : '');
  }
  // 'local' lane (Ollama image / local ComfyUI / TTS): the comfy display already
  // carries the " (hostname)" suffix the server resolved.
  if (job.kind === 'image' || job.kind === 'video') {
    const d = (dom.comfyUrlDisplay?.textContent || '').trim();
    if (d) return d;
  }
  return t('bg_machineLocal');
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

// One-line fine print above the label: WHERE the job came from (source tab / the
// library) + WHAT it works on when the label alone doesn't say (URL, doc name,
// analysis instruction, target model). Answers "which job is whose" in a long queue.
function jobContext(job) {
  const parts = [];
  if (job.kind === 'libimport') {
    parts.push('📚 ' + t('bg_srcLibrary'));
  } else {
    const tab = getTab(job.tabId);
    if (tab && tab.title) parts.push('💬 ' + clipCtx(tab.title, 24));
  }
  const detail = jobDetail(job);
  if (detail) parts.push(detail);
  return parts.join(' · ');
}
function clipCtx(s, n) { s = String(s || '').trim(); return s.length > n ? s.slice(0, n) + '…' : s; }
function shortUrl(u) { return clipCtx(String(u || '').replace(/^https?:\/\/(www\.)?/, ''), 44); }
// Kind-specific detail — only what the label DOESN'T already carry (the image/audio
// label is the prompt/text itself; url/analyze/doc labels are generic phase texts).
function jobDetail(job) {
  const p = job.payload || {};
  if (job.kind === 'url') {
    const urls = (p.entries || []).map((e) => e && e.url).filter(Boolean);
    if (urls.length) return shortUrl(urls[0]) + (urls.length > 1 ? ` +${urls.length - 1}` : '');
  } else if (job.kind === 'analyze') {
    const q = p.parsed && p.parsed.prompt;
    if (q && q.trim()) return clipCtx(q, 44);
  } else if (job.kind === 'docfull') {
    return clipCtx(p.name || '', 44);
  } else if (job.kind === 'image' || job.kind === 'video') {
    const m = p.modelOverride || {};
    return clipCtx(m.comfyModel || m.imageModel || '', 44);
  } else if (job.kind === 'libimport') {
    // url/youtube imports: a page's label IS its URL, but youtube's is a generic
    // "fetching" text → show the address only when it isn't already the label.
    if (p.url && p.url !== job.label && p.url !== job.baseLabel) return shortUrl(p.url);
  }
  return '';
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
    // While running, show WHICH machine is actually executing it (incl. hostname).
    main.title = job.status === 'running'
      ? `${t('bg_jumpTitle')} · ${jobMachine(job)}`
      : t('bg_jumpTitle');
    main.addEventListener('click', () => jumpToJob(job.id));
    const icon = `<span class="bgJobIcon">${KIND_ICON[job.kind] || '⚙'}</span>`;
    const ctx = jobContext(job);
    const ctxLine = ctx ? `<span class="bgJobCtx" title="${escapeText(ctx)}">${escapeText(ctx)}</span>` : '';
    const label = `<span class="bgJobLabel">${escapeText(job.label || job.kind)}</span>`;
    // Failed/interrupted: append WHY (job.error) after the status, with the full text on
    // hover (it truncates with an ellipsis if long).
    const errReason = (job.status === 'error' || job.status === 'interrupted') && job.error ? job.error : '';
    const statusStr = errReason ? `${statusText(job)} · ${errReason}` : statusText(job);
    const status = `<span class="bgJobStatus"${errReason ? ` title="${escapeText(errReason)}"` : ''}>${escapeText(statusStr)}</span>`;
    let bar = '';
    if (job.status === 'running') {
      if (job.progress && job.progress.max) {
        const pct = Math.min(100, Math.round(job.progress.value / job.progress.max * 100));
        bar = `<div class="bgJobBar"><div class="bgJobBarFill" style="width:${pct}%"></div></div>`;
      } else {
        // No numeric progress yet (ComfyUI queue/startup, parse/analyze phases) → animated
        // indeterminate bar so the row reads as "working", not frozen.
        bar = `<div class="bgJobBar indeterminate"><div class="bgJobBarFill"></div></div>`;
      }
    }
    // Live ComfyUI preview frame while the job renders (same stream the foreground
    // bubble uses). job.preview is a blob: URL maintained by the background sink.
    let preview = '';
    if (job.status === 'running' && job.preview) {
      preview = `<img class="bgJobPreview" src="${job.preview}" alt="preview">`;
    }
    main.innerHTML = `${ctxLine}<div class="bgJobTop">${icon}${label}</div>${status}${bar}${preview}`;

    // Control buttons (retry / pause / resume) go on the LEFT — right after the drag
    // handle — so they never sit under the × (which is pinned to the top-right corner
    // and would otherwise overlap a right-aligned button).
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
    // Not-yet-started job: pause (⏸) it so the runner skips it, or resume (▶) a paused one.
    if (job.status === 'queued' || job.status === 'paused') {
      const actions = document.createElement('div');
      actions.className = 'bgJobActions';
      const paused = job.status === 'paused';
      const pr = document.createElement('button');
      pr.type = 'button';
      pr.className = 'bgJobRetry bgJobPauseToggle';
      pr.textContent = paused ? '▶' : '⏸';
      pr.title = paused ? t('bg_resume') : t('bg_pause');
      pr.addEventListener('click', (e) => { e.stopPropagation(); paused ? resumeBgJob(job.id) : pauseBgJob(job.id); });
      actions.appendChild(pr);
      row.appendChild(actions);
    }
    row.appendChild(main);   // label fills the middle; the × (below) overlays only its tail end
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
    // Option B: a server-side gen job (has serverJobId) kept running on the server while
    // the page was gone → requeue so it re-runs + RECONNECTS by serverJobId (the SSE
    // snapshot delivers the result). In-page jobs (no serverJobId) can't resume → interrupted.
    if (j.status === 'running') {
      // Keep the persisted progress/seg on a resumable server job so it shows the
      // last-known % (e.g. "运行中 47%") right away, then live updates resume once the
      // re-run re-subscribes to ComfyUI with the job's stable comfyClientId — instead
      // of snapping back to 0%. In-page jobs can't resume → interrupted (clear progress).
      // Re-queued but NOT yet re-started → drop the "in progress" label (e.g. "正在获取内容")
      // back to the queued label; the re-run re-applies the running label once it starts.
      if (j.serverJobId) { j.status = 'queued'; if (j.baseLabel) j.label = j.baseLabel; }
      else { j.status = 'interrupted'; j.progress = null; j.seg = null; }
    }
    // Reload landed mid-enhancement (the foreground rewrite never finished) → just run
    // it: the payload still holds the raw prompt, so generation proceeds un-enhanced.
    if (j.status === 'enhancing') j.status = 'queued';
  }
  state.bgJobs = jobs;
  // Keep the batch-order counter monotonic across reloads (persisted jobs carry their seq).
  for (const j of jobs) if (typeof j.seq === 'number' && j.seq >= _enqueueSeq) _enqueueSeq = j.seq + 1;
  persist();
  // Drop ORPHAN placeholder bubbles — a bgPlaceholder message whose job is gone (it
  // finished/was canceled before the page died, or is stale data). Otherwise it sticks
  // as a frozen placeholder. (A pre-fix placeholder that lost its bgPlaceholder flag is
  // now an indistinguishable empty bubble — the user removes those with the × manually.)
  const jobMsgIds = new Set(jobs.map((j) => j.msgId));
  const isEmptyJunk = (m) => !m.bgPlaceholder && m.role === 'assistant' && (!m.content || !m.content.trim())
    && !m.generatedImages && !m.generatedVideos && !m.generatedAudio && !m.generatedThumbnails
    && !m.generatedVideoThumbnails && !m.contextImages && !m.thinking && !m.toolSteps
    && !m.isFilePreview && !m.isCompactSummary && !m.translation;
  let removed = false;
  for (const tab of state.tabs) {
    if (!Array.isArray(tab.messages)) continue;
    for (let i = tab.messages.length - 1; i >= 0; i--) {
      const m = tab.messages[i];
      if (!m) continue;
      // Orphan placeholder (job gone), or a pre-fix corrupted placeholder that lost its
      // flag and is now just an empty content-less bubble → remove (it shows nothing).
      if ((m.bgPlaceholder && !jobMsgIds.has(m.id)) || isEmptyJunk(m)) { tab.messages.splice(i, 1); removed = true; }
    }
  }
  if (removed) saveChat();
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