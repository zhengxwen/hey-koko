// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

// Chat rendering, message handling, and sending
import { dom, state, scrollChatToEnd, scrollChatToEndIfPinned, refreshScrollState } from './state.js';
import { TAG_COLORS } from './constants.js';
import { escapeHtml, formatTimestamp, formatDuration } from './utils.js';
import { markdownToHtml, highlightCodeBlocks, renderMermaidDiagrams } from './markdown.js';
import { setAvatarState, showExpression, detectExpression } from './avatar.js';
import { speakMessage, stopSpeech } from './speech.js';
import { saveChat, saveTabs } from './settings.js';
import { getActiveTab, getTab, createTab, switchTab, renderTabs } from './tabs.js';
import { parseNoteCommand, parseImagineCommands, videoThumbnail, extractVideoFrames, comfyModelSupportsMask } from './image-gen.js';
import { openMaskModal } from './mask-paint.js';
import { parseVoiceCommand } from './voice-gen.js';
import { translateMessage } from './translate.js';
import { parseUrlCommand } from './url-fetch.js';
import { buildPendingGenBubble } from './pending-gen.js';
import { enqueueBgJob, releaseEnhancingJob, cancelBgJob, retryBgJob, resumeBgJob, openBgDrawer } from './bg-jobs.js';
import { chatFetch } from './server-queue.js';
import { t, getPrompt, getPromptLanguage } from './i18n.js';
import { getNumCtx, recordContextUsage, renderContextMeter } from './context-meter.js';
import { addMemory, getMemoryPromptBlock } from './memory.js';
import { parseRemind, addReminder, describeReminder, markActivity } from './proactive.js';
import { TOOL_SCHEMAS, executeTool, getToolLabel } from './tools.js';

// "正在发送/接收中 / 正在停止中" status pill (bottom-right, blue). Shown IMMEDIATELY on
// send/resend/edit (no delay) and animated via CSS (fade-in + pulse). The "sending"
// pill covers the gap between clicking send and the response starting — it's dropped
// the moment the response begins streaming (sendSucceeded), NOT when the reply finishes.
let _sendStatusTimer = null;
let _sendStatusKind = null; // 'sending' | 'stopping' | 'error' | null
function scheduleStatus(kind, key) {
  clearTimeout(_sendStatusTimer);
  _sendStatusKind = kind;
  const el = dom.sendStatus;
  if (!el) return;
  // Show the pill IMMEDIATELY (no 2s delay) so send/resend/edit get instant feedback;
  // the CSS fades+pulses it in. It's still dropped on first response chunk (fast case).
  // Starting a new request also clears any lingering red error pill.
  el.classList.remove('isError');
  el.textContent = t(key);
  el.hidden = false;
}
function clearSendStatus() {
  // A red error pill is sticky — keep it (it auto-dismisses, or a new send clears it),
  // so the finally's setGenerating(false) doesn't wipe the error before it's read.
  if (_sendStatusKind === 'error') return;
  clearTimeout(_sendStatusTimer);
  _sendStatusKind = null;
  if (dom.sendStatus) { dom.sendStatus.hidden = true; dom.sendStatus.classList.remove('isError'); }
}
// Backends often wrap the real error in nested JSON, e.g.
//   {"error":"{\"error\":{\"code\":400,\"message\":\"...too many tokens...\"}}"}
// Peel it down to the human-readable message so bubbles/pills don't show raw JSON.
export function cleanErrorMessage(raw) {
  let s = (raw == null ? "" : String(raw)).trim();
  for (let i = 0; i < 6 && (s.startsWith("{") || s.startsWith("[")); i++) {
    let obj;
    try { obj = JSON.parse(s); } catch { break; }
    const next = (obj && (obj.error?.message ?? obj.message ?? obj.error)) ?? null;
    if (next == null) break;
    s = (typeof next === "object" ? JSON.stringify(next) : String(next)).trim();
  }
  return s;
}

// Turn the status pill RED and show the error reason (paired with "正在发送/接收中…").
// Sticky (survives setGenerating(false)); auto-dismisses after a while. Exported so
// dependency-injected modules (url-fetch.js) can surface their errors the same way.
export function showSendError(msg) {
  clearTimeout(_sendStatusTimer);
  _sendStatusKind = 'error';
  const el = dom.sendStatus;
  if (!el) return;
  el.textContent = `⚠️ ${(cleanErrorMessage(msg) || t('status_error')).replace(/\s+/g, ' ').trim().slice(0, 200)}`;
  el.classList.add('isError');
  el.hidden = false;
  _sendStatusTimer = setTimeout(() => {
    if (_sendStatusKind !== 'error') return;
    _sendStatusKind = null;
    el.hidden = true;
    el.classList.remove('isError');
  }, 15000);
}
// The response started coming back → "send" succeeded → drop the Sending pill.
// Leaves a Stopping pill alone (the user is mid-cancel).
function sendSucceeded() {
  if (_sendStatusKind === 'stopping') return;
  clearSendStatus();
}
// Pressing stop/pause: switch to "正在停止中". If a pill is already visible
// (sending was slow), swap text immediately; otherwise only reveal it if the
// stop itself takes >2s.
export function markStopping() {
  const el = dom.sendStatus;
  if (!el) return;
  if (!el.hidden) {
    clearTimeout(_sendStatusTimer);
    _sendStatusKind = 'stopping';
    el.textContent = t("status_stopping");
  } else {
    scheduleStatus('stopping', "status_stopping");
  }
}

export function setGenerating(active) {
  if (active) {
    // A new (or chained) generation phase started — keep the scroll pin alive.
    clearTimeout(state._pinClearTimer);
    dom.sendButton.textContent = t("btn_stop");
    dom.sendButton.classList.add("isStop");
    scheduleStatus('sending', "status_sending");
  } else {
    dom.sendButton.textContent = t("btn_send");
    dom.sendButton.classList.remove("isStop");
    clearSendStatus();
    state.currentAbortController = null;
    // Release the resend/edit scroll pin shortly after generation ends. The small
    // delay lets multi-phase commands (e.g. /search → answer) keep the pin across
    // the brief gap when they toggle generating off between phases.
    clearTimeout(state._pinClearTimer);
    state._pinClearTimer = setTimeout(() => { state.scrollPin = null; }, 150);
  }
}

// Short label for a queued /imagine job (first prompt, or a generic fallback).
function bgImagineLabel(cmds, isVideo) {
  const txt = cmds.map((c) => c.prompt).filter(Boolean).join("; ").trim();
  if (txt) return txt.length > 48 ? txt.slice(0, 48) + "…" : txt;
  return isVideo ? t("bg_kindVideo") : t("bg_kindImage");
}

// Generation (image/video/audio) always runs through the background queue. This
// builds the image/video job from the parsed /imagine commands — shared by a fresh
// send and a resend so the model is snapshotted the same way in both.
async function enqueueImagineGen(validCmds, tabId, images, videos, mask, insertIndex = -1) {
  // A ComfyUI video model (no Ollama image model) routes through generateVideo —
  // capture model + kind at submit time so a later dropdown change can't redirect it.
  const isVideo = !dom.imageModelSelect.value && dom.comfyModelSelect && state.comfyVideoModels.has(dom.comfyModelSelect.value);
  const modelOverride = { imageModel: dom.imageModelSelect.value, comfyModel: dom.comfyModelSelect ? dom.comfyModelSelect.value : "" };
  // BATCH video-edit: one bg job per source clip (each runs the same workflow → its
  // own output). All jobs share the reference images + mask point; the Replace point
  // is pinned to the FIRST clip server-side. No source video (or an image model that
  // can't consume clips) → a single job.
  const clips = isVideo ? (Array.isArray(videos) ? videos.filter(Boolean) : (videos ? [videos] : [])) : [];
  const multi = clips.length > 1;
  const jobs = clips.length ? clips : [null];
  // --enhance is run UP-FRONT here (foreground — the tab is active right after Send, so
  // it can never hit the background-tab freeze that stalls queue advancement). Jobs are
  // created in the 'enhancing' state (bubble shows "正在增强提示词"); pumpLane skips them
  // until releaseEnhancingJob flips them to 'queued' with the rewritten prompt in tow.
  const needsEnhance = validCmds.some((c) => c.enhance && c.prompt && c.prompt.trim());
  const created = jobs.map((clip, i) => enqueueBgJob({
    tabId,
    kind: isVideo ? "video" : "image",
    // Tag the label with "(N/M)" so the jobs drawer distinguishes a batch's clips.
    label: bgImagineLabel(validCmds, isVideo) + (multi ? ` (${i + 1}/${clips.length})` : ""),
    // Keep batch order: each placeholder lands AFTER the previous one.
    insertIndex: insertIndex >= 0 ? insertIndex + i : -1,
    status: needsEnhance ? "enhancing" : "queued",
    payload: {
      parsedInput: validCmds,
      initImages: images || null,
      initVideo: clip || null,
      maskB64: mask || null,
      modelOverride,
    },
  }));
  if (!needsEnhance) return;

  // During enhancement, behave like a normal chat turn: the Send button becomes Stop
  // (setGenerating + currentAbortController, which the form-submit handler aborts). Stop
  // FULLY cancels these jobs — they never reach the queue. After enhancement the button
  // returns to Send and the actual generation runs non-blocking in the background.
  const enhanceAbort = new AbortController();
  state.currentAbortController = enhanceAbort;
  setGenerating(true);
  let stopped = false;
  enhanceAbort.signal.addEventListener("abort", () => {
    stopped = true;
    for (const job of created) if (job) cancelBgJob(job.id);
  }, { once: true });

  // Rewrite each --enhance command ONCE (shared across this send's jobs since they share
  // the validCmds array → payload). Store the result on the command (read at run time as
  // enhancedPrompt||prompt; raw prompt kept for the record/resend) and clear the flag.
  const mode = isVideo ? "video" : (images ? "edit" : "plain");
  try {
    for (const cmd of validCmds) {
      if (!(cmd.enhance && cmd.prompt && cmd.prompt.trim())) continue;
      try {
        const r = await fetch("/api/enhance-prompt", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: enhanceAbort.signal,
          body: JSON.stringify({ model: dom.modelSelect.value, prompt: cmd.prompt, language: getPromptLanguage(), edit: mode === "edit", video: mode === "video" }),
        });
        const d = await r.json();
        if (r.ok && d.enhanced && d.enhanced.trim()) cmd.enhancedPrompt = d.enhanced.trim();
      } catch (e) {
        if (e.name === "AbortError") break;   // user hit Stop → bail (jobs already canceled)
        // other failures are non-fatal: fall back to the raw prompt
      }
      cmd.enhance = false;
    }
  } finally {
    if (state.currentAbortController === enhanceAbort) setGenerating(false); // clears currentAbortController too
  }
  if (stopped) return;   // canceled mid-enhancement → do NOT enqueue

  const enhancedText = [...new Set(validCmds.map((c) => c.enhancedPrompt).filter(Boolean))].join("\n");
  for (const job of created) releaseEnhancingJob(job, enhancedText || null);
}

// /analyze (image/video vision) also runs through the background queue. Builds a
// slim media payload (base64 only — preview blobs / names aren't needed headlessly)
// so the job can re-run the vision pass detached from the live bubble. anchorIndex
// lets the no-attachment fallback find the nearest preceding media bubble at run time.
function enqueueAnalyzeJob(parsed, tabId, image, video, anchorIndex, insertIndex = -1) {
  let payloadImage = null;
  if (image) {
    if (image.multi) payloadImage = { multi: image.multi.map((im) => ({ base64: im.base64 })) };
    else { payloadImage = { base64: image.base64 }; if (image.mask) payloadImage.mask = image.mask; }
  }
  const payloadVideo = video ? { base64: video.base64, mime: video.mime || "video/mp4" } : null;
  enqueueBgJob({
    tabId,
    kind: "analyze",
    label: t("bg_analyzing"),
    insertIndex,
    payload: { parsed, image: payloadImage, video: payloadVideo, anchorIndex },
  });
}

// Does THIS user bubble's reply region currently hold a running in-page job? An
// in-page analysis job (analyze/url/docfull) splices its output at a captured cursor,
// so re-running the SAME bubble while its job runs would corrupt/duplicate it. Other
// bubbles (no active job of their own) — and any server-side gen job (detached,
// reattach by msgId) — do NOT block. The region runs from index+1 to the next real
// user turn (urlPart user bubbles belong to the block).
function bubbleHasActiveInPageJob(tab, index) {
  if (!tab) return false;
  for (let i = index + 1; i < tab.messages.length; i++) {
    const m = tab.messages[i];
    if (!m) continue;
    if (m.role === "user" && !m.urlPart) break;
    if (m.bgPlaceholder && m.jobId) {
      const job = state.bgJobs.find((j) => j.id === m.jobId);
      if (job && !job.serverJobId && (job.status === "queued" || job.status === "running")) return true;
    }
  }
  return false;
}

// Pops a DIALOG and returns true if resending/editing THIS bubble is blocked (its own
// in-page job is still running). The caller restores any edited text.
function bgBlockResend(index) {
  if (!bubbleHasActiveInPageJob(getActiveTab(), index)) return false;
  alert(t('bg_queueBusyAlert'));
  return true;
}

// Build a placeholder bubble for a background job sitting in the chat at its
// original position. Mirrors the jobs-drawer status text; offers jump + cancel.
function renderBgPlaceholder(message) {
  const KIND_ICON = { image: '🖼', video: '🎬', audio: '🔊', analyze: '🔍', url: '🔗', doc: '📄', docfull: '📄' };
  const el = document.createElement('div');
  el.className = `message assistant bgPlaceholder bgPlaceholder-${message.status || 'queued'}`;
  el.dataset.msgId = message.id;
  const body = document.createElement('div');
  body.className = 'markdownBody';
  let statusTxt;
  switch (message.status) {
    case 'running': statusTxt = [message.seg, message.elapsed].filter(Boolean).join(' · '); break;   // "第 N/M 段 · 1:23"
    case 'paused': statusTxt = t('bg_statusPaused'); break;
    case 'enhancing': statusTxt = t('bg_statusEnhancing'); break;
    case 'done': statusTxt = t('bg_statusDone'); break;
    case 'error': statusTxt = t('bg_statusError'); break;
    case 'interrupted': statusTxt = t('bg_statusInterrupted'); break;
    case 'canceled': statusTxt = t('bg_statusCanceled'); break;
    default: statusTxt = message.queuePos ? t('bg_statusQueued', { n: message.queuePos }) : t('bg_statusQueuedPlain');
  }
  // The label is "正在生成… · <model> · <extra>". Keep the action text at normal
  // size and render everything after the first " · " (the long model name etc.) small.
  const labelParts = (message.label || '').split(' · ');
  const mainLabel = labelParts[0] || '';
  const detail = labelParts.slice(1).join(' · ');
  body.innerHTML = `<span class="bgPhIcon">${KIND_ICON[message.kind] || '⚙'}</span>`
    + `<span class="bgPhLabel">${escapeHtml(mainLabel)}</span>`
    + (detail ? `<span class="bgPhModel">${escapeHtml(detail)}</span>` : '')
    // Always render the status span while running so the live chunk-badge poke has a target.
    + ((statusTxt || message.status === 'running') ? `<span class="bgPhStatus">${escapeHtml(statusTxt)}</span>` : '');
  // Server-side --enhance: the rewritten prompt arrives mid-run (before the render) and
  // is shown here so the user sees it up-front, not only with the final result.
  if (message.enhancedPrompt) {
    const enh = document.createElement('div');
    enh.className = 'bgPhEnhanced';
    enh.innerHTML = `<div class="enhancedLabel">${t('msg_enhancedPrompt')}</div><blockquote>${escapeHtml(message.enhancedPrompt)}</blockquote>`;
    body.appendChild(enh);
  }
  // Running jobs get a progress bar: determinate (width %) once numeric progress
  // arrives (generation), indeterminate animated otherwise (parse/url/analyze phases).
  if (message.status === 'running') {
    const hasNum = message.progress && message.progress.max;
    const bar = document.createElement('div');
    bar.className = hasNum ? 'bgPhBar' : 'bgPhBar indeterminate';
    const fill = document.createElement('div');
    fill.className = 'bgPhBarFill';
    if (hasNum) fill.style.width = Math.min(100, Math.round(message.progress.value / message.progress.max * 100)) + '%';
    bar.appendChild(fill);
    body.appendChild(bar);
  }
  const actions = document.createElement('div');
  actions.className = 'bgPhActions';
  const goto = document.createElement('button');
  goto.type = 'button';
  goto.className = 'bgPhGoto';
  goto.textContent = t('bg_goto');
  goto.addEventListener('click', () => openBgDrawer(message.jobId));
  actions.appendChild(goto);
  if (message.status === 'error' || message.status === 'interrupted') {
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'bgPhRetry';
    retry.textContent = t('bg_retry');
    retry.addEventListener('click', () => retryBgJob(message.jobId));
    actions.appendChild(retry);
  }
  if (message.status === 'paused') {
    const resume = document.createElement('button');
    resume.type = 'button';
    resume.className = 'bgPhRetry';
    resume.textContent = t('bg_resume');
    resume.addEventListener('click', () => resumeBgJob(message.jobId));
    actions.appendChild(resume);
  }
  body.appendChild(actions);
  el.appendChild(body);
  // Close (×) — identical to a normal bubble's delete button: a hover-revealed
  // round action pinned to the top-right corner (reuses .messageAction.deleteMessage).
  const rightActions = document.createElement('div');
  rightActions.className = 'messageActions messageActionsRight';
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'messageAction deleteMessage';
  del.title = t('bg_cancel');
  del.setAttribute('aria-label', 'cancel');
  del.textContent = '×';
  del.addEventListener('click', () => cancelBgJob(message.jobId));
  rightActions.appendChild(del);
  el.appendChild(rightActions);
  return el;
}

function forkConversation(index) {
  const tab = getActiveTab();
  const forkedMessages = tab.messages.slice(0, index + 1).map((m) => ({ ...m }));
  const newTab = createTab(`${tab.title} ${t("msg_fork")}`, forkedMessages, tab.personality);
  newTab.persona = tab.persona;
  if (tab.tags && tab.tags.length > 0) {
    newTab.tags = tab.tags.map(t => ({ ...t }));
  }
  const tabIndex = state.tabs.indexOf(tab);
  state.tabs.splice(tabIndex, 0, newTab);
  switchTab(newTab.id);
}

function deleteChatMessage(index) {
  const tab = getActiveTab();
  if (tab.locked) return;
  if (tab.messages[index]?.locked) return; // pinned bubble — can't delete
  stopSpeech();
  const scrollY = dom.messagesEl.scrollTop;
  tab.messages.splice(index, 1);
  saveChat();
  renderChat();
  dom.messagesEl.scrollTop = scrollY;
}

function deleteMessageImage(msgIndex, imgIndex) {
  const tab = getActiveTab();
  if (tab.locked) return;
  const message = tab.messages[msgIndex];
  if (!message) return;
  if (message.generatedImages && message.generatedImages.length > imgIndex) {
    message.generatedImages.splice(imgIndex, 1);
  }
  if (message.generatedThumbnails && message.generatedThumbnails.length > imgIndex) {
    message.generatedThumbnails.splice(imgIndex, 1);
  }
  if (message.images && message.images.length > imgIndex) {
    message.images.splice(imgIndex, 1);
  }
  saveChat();
  const scrollY = dom.messagesEl.scrollTop;
  renderChat();
  dom.messagesEl.scrollTop = scrollY;
}

// Reconstruct the source-video object (for Bernini v2v/rv2v) from a stored user
// message, so resend / edit-then-enter re-trigger the video edit with the same
// source clip. The uploaded source rides on the message's generatedVideos field.
// Reconstruct ALL source-video objects from a stored user bubble (batch video-edit
// stages several clips). Per-clip metadata is stored as parallel arrays; older
// single-video bubbles used scalar videoName/videoWidth/videoHeight — fall back to
// those so resend still works on legacy messages.
function messageSourceVideos(m) {
  if (!m || !Array.isArray(m.generatedVideos) || !m.generatedVideos.length) return [];
  const names = Array.isArray(m.videoNames) ? m.videoNames : (m.videoName ? [m.videoName] : []);
  const mimes = Array.isArray(m.videoMimes) ? m.videoMimes : [];
  const widths = Array.isArray(m.videoWidths) ? m.videoWidths : (m.videoWidth != null ? [m.videoWidth] : []);
  const heights = Array.isArray(m.videoHeights) ? m.videoHeights : (m.videoHeight != null ? [m.videoHeight] : []);
  const thumbs = Array.isArray(m.generatedVideoThumbnails) ? m.generatedVideoThumbnails : [];
  return m.generatedVideos.map((b64, i) => ({
    base64: b64,
    mime: mimes[i] || m.videoMime || "video/mp4",
    name: names[i] || undefined,
    thumbnail: thumbs[i] || undefined,
    width: widths[i] ?? undefined,
    height: heights[i] ?? undefined,
  }));
}

// Back-compat single-source helper (analyze re-runs only the first clip).
function messageSourceVideo(m) {
  return messageSourceVideos(m)[0] || null;
}

// Normalize the staged-video send form (single object or {multi:[...]}) to an array.
function stagedVideoList(video) {
  if (!video) return [];
  if (video.multi) return video.multi;
  return [video];
}

// Stamp a user bubble with the staged source video(s). They reuse generatedVideos so
// they render/persist like generated clips; per-clip metadata rides as parallel arrays
// (videoNames/videoMimes/videoWidths/videoHeights) so each can be reconstructed for
// resend / batch dispatch. videoMime stays scalar — it only drives the <video> type.
function attachVideosToMessage(userMessage, videos) {
  if (!videos || !videos.length) return;
  userMessage.generatedVideos = videos.map(v => v.base64);
  userMessage.videoMime = videos[0].mime || "video/mp4";
  userMessage.videoMimes = videos.map(v => v.mime || "video/mp4");
  userMessage.videoNames = videos.map(v => v.name || null);
  if (videos.some(v => v.thumbnail)) userMessage.generatedVideoThumbnails = videos.map(v => v.thumbnail || null);
  if (videos.some(v => v.width != null)) userMessage.videoWidths = videos.map(v => v.width ?? null);
  if (videos.some(v => v.height != null)) userMessage.videoHeights = videos.map(v => v.height ?? null);
}

function deleteMessageVideo(msgIndex, vidIndex) {
  const tab = getActiveTab();
  if (tab.locked) return;
  const message = tab.messages[msgIndex];
  if (!message) return;
  if (message.generatedVideos && message.generatedVideos.length > vidIndex) {
    message.generatedVideos.splice(vidIndex, 1);
  }
  if (message.generatedVideoThumbnails && message.generatedVideoThumbnails.length > vidIndex) {
    message.generatedVideoThumbnails.splice(vidIndex, 1);
  }
  saveChat();
  const scrollY = dom.messagesEl.scrollTop;
  renderChat();
  dom.messagesEl.scrollTop = scrollY;
}

function resendChatMessage(index) {
  if (state.currentAbortController || state.imageGenAbortController) return;
  // Block only if THIS bubble's own in-page job is still running (would clobber it).
  if (bgBlockResend(index)) return;
  const tab = getActiveTab();
  if (tab.locked) return;
  const message = tab.messages[index];
  if (!message || message.role !== "user") return;

  // Pin the scroll position so regenerating a mid-conversation message (here or via
  // double-click edit, which delegates here) doesn't jump the view to the bottom.
  state.scrollPin = dom.messagesEl.scrollTop;

  // A locked reply is kept; the new reply is inserted before it (at index+1). A bg
  // placeholder (a running job's bubble) is NOT removed — that would orphan the job.
  if (tab.messages[index + 1]?.role === "assistant" && !tab.messages[index + 1].locked && !tab.messages[index + 1].bgPlaceholder) {
    tab.messages.splice(index + 1, 1);
  }
  saveChat();
  renderChat();

  if (parseNoteCommand(message.content)) return;
  const searchResend = message.content.match(/^\/search\s+([\s\S]+)/);
  if (searchResend) {
    // The sources bubble (index+1) was already removed above; drop the answer too.
    // Keep the /search command bubble in place and regenerate right after it, with
    // context truncated to this bubble (contextEndIndex=index). Locked replies stay.
    if (tab.messages[index + 1]?.role === "assistant" && !tab.messages[index + 1].locked && !tab.messages[index + 1].bgPlaceholder) tab.messages.splice(index + 1, 1);
    saveChat();
    renderChat();
    handleSearchCommand(searchResend[1].trim(), tab, state.activeTabId, message.content, index + 1, index);
    return;
  }
  const rememberResend = message.content.match(/^\/memory\s+([\s\S]+)/);
  if (rememberResend) {
    const fact = rememberResend[1].trim();
    addMemory(fact);
    tab.messages.splice(index + 1, 0, { role: "assistant", content: t("msg_remembered", { fact }), timestamp: Date.now() });
    saveChat();
    renderChat();
    return;
  }
  if (/^\/compact\s*$/.test(message.content)) {
    // Resend in place: compact only messages before this bubble (contextEndIndex=index),
    // insert the summary right after it (insertIndex=index+1).
    handleCompactCommand(tab, state.activeTabId, index + 1, index);
    return;
  }
  if (/^\/title(\s|$)/.test(message.content)) {
    handleTitleCommand(tab, state.activeTabId, message.content);
    return;
  }

  // Handle /url command on resend — re-run the whole chain in the background queue
  // (reached only when the queue is empty; non-empty is blocked above with a dialog).
  const urlTarget = parseUrlCommand(message.content);
  if (urlTarget) {
    // Remove the old /url output block (messages tagged urlPart) right after this
    // bubble; the placeholder + new output land right after it. Locked stay.
    while (tab.messages[index + 1]?.urlPart && !tab.messages[index + 1].locked) {
      tab.messages.splice(index + 1, 1);
    }
    saveChat();
    renderChat();
    enqueueBgJob({ tabId: state.activeTabId, kind: "url", label: t("bg_fetchingUrl"), insertIndex: index + 1, payload: { entries: urlTarget.entries, fullContent: message.content } });
    return;
  }

  // Handle /0 and /1 commands on resend
  const isolatedMatch = message.content.match(/^\/(0|1)\s+([\s\S]+)/);
  if (isolatedMatch) {
    const mode = isolatedMatch[1];
    const actualContent = isolatedMatch[2];
    const insertIndex = index + 1;
    isolatedReply(actualContent, mode, tab, state.activeTabId, insertIndex);
    return;
  }

  // Handle /analyze on resend — re-run the vision analysis in place. Reconstruct
  // the attached media from the stored bubble (images + optional source video); if
  // the bubble carried none, the fallback scans the bubbles before it (anchor=index-1).
  const analyzeResend = parseAnalyzeCommand(message.content);
  if (analyzeResend) {
    const imageObj = message.images?.length
      ? { multi: message.images.map((b) => ({ base64: b })) }
      : null;
    // Resend of vision analysis also goes to the queue (reached only when empty — a
    // non-empty queue is blocked above). Placeholder lands right after this bubble.
    enqueueAnalyzeJob(analyzeResend, state.activeTabId, imageObj, messageSourceVideo(message), index - 1, index + 1);
    return;
  }

  const voiceCmd = parseVoiceCommand(message.content);
  if (voiceCmd) {
    if (voiceCmd.error) {
      tab.messages.splice(index + 1, 0, { role: "assistant", content: t("msg_commandError", { error: voiceCmd.error }), timestamp: Date.now() });
      saveChat();
      renderChat();
    } else {
      // Resend of audio gen also goes to the background queue (reached only when
      // the queue is empty — a non-empty queue is blocked above with a dialog). The
      // placeholder lands right after the resent user bubble (index + 1).
      enqueueBgJob({ tabId: state.activeTabId, kind: "audio", label: voiceCmd.text.slice(0, 48), payload: { parsed: voiceCmd }, insertIndex: index + 1 });
    }
    return;
  }

  const imagineCmds = parseImagineCommands(message.content);
  if (imagineCmds) {
    const firstError = imagineCmds.find((cmd) => cmd && cmd.error);
    const srcVids = messageSourceVideos(message);
    const hasAttach = !!((message.images && message.images.length) || srcVids.length);
    const validCmds = imagineCmds.filter((cmd) => cmd && !cmd.error && (cmd.prompt || hasAttach));
    if (firstError) {
      tab.messages.splice(index + 1, 0, { role: "assistant", content: t("msg_commandError", { error: firstError.error }), timestamp: Date.now() });
      saveChat();
      renderChat();
    } else if (validCmds.length === 0) {
      tab.messages.splice(index + 1, 0, { role: "assistant", content: t("msg_commandError", { error: "缺少提示词，或附带一张图片 / 一段视频再发送。" }), timestamp: Date.now() });
      saveChat();
      renderChat();
    } else {
      // Resend of image/video gen also goes to the background queue (reached only
      // when the queue is empty — a non-empty queue is blocked above with a dialog).
      // The placeholder lands right after the resent user bubble (index + 1).
      enqueueImagineGen(validCmds, state.activeTabId, message.images || null, srcVids, message.mask || null, index + 1);
    }
  } else {
    // Truncate context to the resent bubble: only messages up to and including
    // index are sent to the AI, and the new reply is inserted right after it.
    dispatchReply(state.activeTabId, index + 1, index);
  }
}

// Copy a message bubble's text to the clipboard, flashing the button label to
// confirm. Falls back to a hidden textarea + execCommand when the async
// Clipboard API is unavailable (insecure origin / older browser).
async function copyMessageText(text, btn) {
  const value = typeof text === "string" ? text : "";
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(value);
    } else {
      const ta = document.createElement("textarea");
      ta.value = value;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
  } catch {
    return;
  }
  if (btn) {
    const original = btn.textContent;
    btn.textContent = t("btn_copied");
    btn.classList.add("copied");
    setTimeout(() => {
      btn.textContent = original;
      btn.classList.remove("copied");
    }, 1200);
  }
}

async function handleCompactCommand(tab, tabId, insertIndex = -1, contextEndIndex = -1) {
  if (tab.messages.length === 0) return;
  const inPlace = insertIndex >= 0;

  // Collect messages to compact: on resend, only those before the resent /compact
  // bubble (contextEndIndex); on a fresh command, everything so far (the bubble is
  // pushed below, after this map).
  const compactSource = inPlace ? tab.messages.slice(0, contextEndIndex) : tab.messages;
  const messagesToCompact = compactSource.map(({ role, content }) => ({ role, content }));
  if (messagesToCompact.length === 0) return;

  // Fresh command: add the /compact user bubble. On resend it already exists in place.
  if (!inPlace) {
    tab.messages.push({ role: "user", content: "/compact", timestamp: Date.now() });
    saveChat();
    if (state.activeTabId === tabId) renderChat();
  }

  // Show thinking bubble
  setAvatarState("thinking");
  setGenerating(true);
  const abortController = new AbortController();
  state.currentAbortController = abortController;

  state.streamingInfo = { tabId, content: '', phase: 'thinking', insertIndex, thinkingText: t("msg_compressing") };
  if (state.activeTabId === tabId) {
    const pending = document.createElement("div");
    pending.className = "message assistant thinking streaming-bubble";
    const body = document.createElement("div");
    body.className = "markdownBody";
    body.innerHTML = `<span class="thinking-text">${t("msg_compressing")}<span class="thinking-dots"><span>.</span><span>.</span><span>.</span><span>.</span><span>.</span><span>.</span></span></span>`;
    pending.appendChild(body);
    const refNode = inPlace ? dom.messagesEl.children[insertIndex] : null;
    if (refNode) dom.messagesEl.insertBefore(pending, refNode);
    else dom.messagesEl.appendChild(pending);
    scrollChatToEnd();
  }

  try {
    const compactPrompt = [
      { role: "system", content: getPrompt("compactSummary") },
      ...messagesToCompact,
      { role: "user", content: getPrompt("compactUserPrompt") },
    ];

    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: abortController.signal,
      body: JSON.stringify({
        model: dom.modelSelect.value,
        messages: compactPrompt,
        options: { temperature: 0.3, num_ctx: getNumCtx() },
        timeout: parseInt(dom.imageTimeoutInput.value, 10) || 120,
      }),
    });

    if (!response.ok) {
      const data = await response.json();
      throw new Error(cleanErrorMessage(data.error) || "请求失败");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let firstChunkReceived = false;

    function appendStreamLine(line) {
      if (!line.trim()) return;
      const data = JSON.parse(line);
      const chunk = data.message?.content || "";
      if (!chunk) return;

      if (!firstChunkReceived) {
        firstChunkReceived = true;
        if (state.streamingInfo) state.streamingInfo.phase = 'streaming';
        setAvatarState("talking");
        if (state.activeTabId === tabId) {
          const bubble = dom.messagesEl.querySelector('.streaming-bubble');
          if (bubble) {
            bubble.innerHTML = "";
            bubble.classList.remove("thinking");
            const t = document.createElement("div");
            t.className = "markdownBody";
            bubble.appendChild(t);
          }
        }
      }

      content += chunk;
      if (state.streamingInfo) state.streamingInfo.content = content;
      if (state.activeTabId === tabId) {
        const t = dom.messagesEl.querySelector('.streaming-bubble > .markdownBody');
        if (t) {
          t.innerHTML = markdownToHtml(content);
          scrollChatToEndIfPinned();
        }
      }
    }

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) appendStreamLine(line);
    }
    buffer += decoder.decode();
    if (buffer.trim()) appendStreamLine(buffer);

    content = content.trim();
    if (!content) {
      state.streamingInfo = null;
      const bubble = dom.messagesEl.querySelector('.streaming-bubble');
      if (bubble) bubble.remove();
      setAvatarState("idle");
      setGenerating(false);
      return;
    }

    // Add the compact summary as a special message
    const summaryMessage = {
      role: "assistant",
      content: t("msg_contextSummary", { content }),
      timestamp: Date.now(),
      isCompactSummary: true,
    };
    state.streamingInfo = null;
    if (inPlace && insertIndex <= tab.messages.length) tab.messages.splice(insertIndex, 0, summaryMessage);
    else tab.messages.push(summaryMessage);
    saveChat();
    if (state.activeTabId === tabId) renderChat();
  } catch (error) {
    state.streamingInfo = null;
    const bubble = dom.messagesEl.querySelector('.streaming-bubble');
    if (bubble) bubble.remove();
    if (error.name !== "AbortError") {
      const errMsg = { role: "assistant", content: t("msg_compressFail", { error: error.message }), timestamp: Date.now() };
      if (inPlace && insertIndex <= tab.messages.length) tab.messages.splice(insertIndex, 0, errMsg);
      else tab.messages.push(errMsg);
      saveChat();
      if (state.activeTabId === tabId) renderChat();
      showSendError(error.message);
    }
  } finally {
    state.streamingInfo = null;
    setAvatarState("idle");
    setGenerating(false);
    state.currentAbortController = null;
  }
}

function getTagColor(tagName) {
  // Match existing tag color across all tabs
  for (const t of state.tabs) {
    for (const tg of (t.tags || [])) {
      if ((tg?.name || "").trim() === tagName) return tg.color;
    }
  }
  // Random color for new tag
  return TAG_COLORS[Math.floor(Math.random() * TAG_COLORS.length)];
}

function parseTitleCommand(content) {
  const raw = content.replace(/^\/title\s*/, '');
  const tags = [];
  let hasBrackets = false;
  // Extract [tags] - content inside brackets, split by space or comma
  const cleaned = raw.replace(/\[([^\]]*)\]/g, (_, inner) => {
    hasBrackets = true;
    inner.split(/[\s,，]+/).filter(Boolean).forEach(t => tags.push(t));
    return '';
  }).trim();
  return { title: cleaned.replace(/[\r\n]+/g, ' ').trim(), tags, hasBrackets };
}

async function handleTitleCommand(tab, tabId, content) {
  const { title, tags, hasBrackets } = parseTitleCommand(content);

  // Add user message
  tab.messages.push({ role: "user", content, timestamp: Date.now() });
  saveChat();
  if (state.activeTabId === tabId) renderChat();

  let finalTitle = title;

  // If no title provided, use AI to generate one
  if (!finalTitle) {
    if (tab.messages.filter(m => m.role === "user" || m.role === "assistant").length <= 1) {
      finalTitle = `Chat ${state.tabs.indexOf(tab) + 1}`;
    } else {
      setAvatarState("thinking");
      setGenerating(true);
      const abortController = new AbortController();
      state.currentAbortController = abortController;

      // Show thinking bubble
      state.streamingInfo = { tabId, content: '', phase: 'thinking', insertIndex: -1, thinkingText: t("msg_generatingTitle") };
      if (state.activeTabId === tabId) {
        const pending = document.createElement("div");
        pending.className = "message assistant thinking streaming-bubble";
        const body = document.createElement("div");
        body.className = "markdownBody";
        body.innerHTML = `<span class="thinking-text">${t("msg_generatingTitle")}<span class="thinking-dots"><span>.</span><span>.</span><span>.</span><span>.</span><span>.</span><span>.</span></span></span>`;
        pending.appendChild(body);
        dom.messagesEl.appendChild(pending);
        scrollChatToEnd();
      }

      try {
        const recentMessages = tab.messages.filter(m => !m.isFilePreview && !m.isCompactSummary && !/^\/title(\s|$)/.test(m.content)).slice(0, 4);
        const prompt = [
          { role: "system", content: getPrompt("titleGeneration") },
          ...recentMessages.map(m => ({ role: m.role, content: m.content })),
        ];
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: abortController.signal,
          body: JSON.stringify({
            model: dom.modelSelect.value,
            messages: prompt,
            options: { temperature: 0.3 },
            timeout: parseInt(dom.imageTimeoutInput.value, 10) || 120,
          }),
        });
        if (response.ok) {
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          let result = "";
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";
            for (const line of lines) {
              if (!line.trim()) continue;
              try {
                const data = JSON.parse(line);
                result += data.message?.content || "";
              } catch {}
            }
          }
          if (buffer.trim()) {
            try { const data = JSON.parse(buffer); result += data.message?.content || ""; } catch {}
          }
          finalTitle = result.replace(/[\r\n]+/g, ' ').replace(/^["'"""'']+|["'"""'']+$/g, '').trim();
          if (finalTitle.length > 16) finalTitle = finalTitle.slice(0, 16);
        }
      } catch (e) {
        if (e.name !== "AbortError") {
          finalTitle = tab.title; // Keep original on error
          showSendError(e.message);
        }
      } finally {
        state.streamingInfo = null;
        const bubble = dom.messagesEl.querySelector('.streaming-bubble');
        if (bubble) bubble.remove();
        setAvatarState("idle");
        setGenerating(false);
        state.currentAbortController = null;
      }
    }
  }

  // Apply title
  if (finalTitle) {
    tab.title = finalTitle;
  }

  // Apply tags: only if brackets were present in the command
  if (hasBrackets) {
    if (tags.length === 0) {
      // "/title []" clears tags
      tab.tags = [];
    } else {
      if (!tab.tags) tab.tags = [];
      for (const tagName of tags) {
        const exists = tab.tags.some(t => (t?.name || "").trim() === tagName);
        if (!exists) {
          tab.tags.push({ name: tagName, color: getTagColor(tagName) });
        }
      }
    }
  }

  saveTabs();
  renderTabs();

  // Show confirmation as assistant message
  let confirmMsg = t("msg_titleUpdated", { title: tab.title });
  if (hasBrackets && tags.length > 0) confirmMsg += t("msg_tagsAdded", { tags: tags.join(', ') });
  if (hasBrackets && tags.length === 0) confirmMsg += t("msg_tagsCleared");
  tab.messages.push({ role: "assistant", content: confirmMsg, timestamp: Date.now() });
  saveChat();
  if (state.activeTabId === tabId) renderChat();
}

function buildMessages(tabId = state.activeTabId, contextEndIndex = -1) {
  const tab = getTab(tabId) || getActiveTab();
  // Optionally only consider messages up to (and including) contextEndIndex.
  const sourceMessages = contextEndIndex >= 0 ? tab.messages.slice(0, contextEndIndex + 1) : tab.messages;
  const rawNames = (dom.userName.value || "").trim();
  let nameInstruction = "";
  if (rawNames) {
    const names = rawNames.split(/[,，、\s]+/).filter(Boolean);
    nameInstruction = names.length > 1
      ? getPrompt("nameInstructionMulti", names)
      : getPrompt("nameInstructionSingle", names[0]);
  }
  const memoryBlock = getMemoryPromptBlock(getPrompt("memoryHeader"));
  const system = `${dom.persona.value}

${nameInstruction}${getPrompt("personaSuffix")}${memoryBlock}`;

  // Find the last compact boundary - only include messages after it
  let startIndex = 0;
  for (let i = sourceMessages.length - 1; i >= 0; i--) {
    if (sourceMessages[i].isCompactSummary) {
      startIndex = i;
      break;
    }
  }
  const relevantMessages = sourceMessages.slice(startIndex).slice(-24);

  const mapped = [];
  for (const msg of relevantMessages) {
    // Background-job placeholders carry no content — never send them to the model.
    if (msg.bgPlaceholder) continue;
    // Include compact summary as system context
    if (msg.isCompactSummary) {
      mapped.push({ role: "system", content: `${getPrompt("summaryContext")}${msg.content}` });
      continue;
    }
    // Skip the /compact command itself
    if (msg.role === "user" && /^\/compact\s*$/.test(msg.content)) continue;
    // Skip /title command and its response
    if (msg.role === "user" && /^\/title(\s|$)/.test(msg.content)) continue;
    // Skip /memory command (the fact is already injected via long-term memory)
    if (msg.role === "user" && /^\/memory(\s|$)/.test(msg.content)) continue;
    // Skip /remind command line
    if (msg.role === "user" && /^\/remind(\s|$)/.test(msg.content)) continue;
    // Skip /search command line (results are injected as the assistant bubble that follows)
    if (msg.role === "user" && /^\/search(\s|$)/.test(msg.content)) continue;
    // Skip /analyze command line (its analysis is the assistant bubble that follows)
    if (msg.role === "user" && /^\/analyze(\s|$)/.test(msg.content)) continue;
    if (msg.role === "assistant" && /^✅ 标题已更新为/.test(msg.content)) continue;
    // File preview bubbles: send to LLM as user-role (contains the parsed file content)
    if (msg.isFilePreview) {
      const message = { role: "user", content: msg.content };
      if (msg.images?.length) message.images = msg.images;
      mapped.push(message);
      continue;
    }
    if (msg.folded) continue;
    const message = { role: msg.role, content: msg.content };
    if (msg.images?.length) message.images = msg.images;
    mapped.push(message);
  }

  return [{ role: "system", content: system }, ...mapped];
}

// Handle /0 and /1 isolated context commands
async function isolatedReply(userContent, mode, tab, tabId, insertIndex) {
  const abortController = new AbortController();
  state.currentAbortController = abortController;
  setGenerating(true);
  setAvatarState("thinking");
  state.streamingInfo = { tabId, content: '', phase: 'thinking', insertIndex };

  if (state.activeTabId === tabId) {
    const pending = document.createElement("div");
    pending.className = "message assistant thinking streaming-bubble";
    const body = document.createElement("div");
    body.className = "markdownBody";
    body.innerHTML = `<span class="thinking-text">${t("msg_thinking")}<span class="thinking-dots"><span>.</span><span>.</span><span>.</span><span>.</span><span>.</span><span>.</span></span></span>`;
    pending.appendChild(body);
    dom.messagesEl.appendChild(pending);
    scrollChatToEnd();
  }

  // Build limited message context
  const system = `${dom.persona.value}\n\n${getPrompt("personaSuffix")}`;
  const messages = [{ role: "system", content: system }];
  if (mode === "1") {
    // Include the previous message bubble (the one before the /1 command)
    const prevIdx = insertIndex - 2; // -1 is the /1 user msg, -2 is the one before
    if (prevIdx >= 0 && tab.messages[prevIdx]) {
      const prev = tab.messages[prevIdx];
      messages.push({ role: prev.role, content: prev.content });
    }
  }
  messages.push({ role: "user", content: userContent });

  let content = "";
  let thinkingContent = "";
  let usageStats = null;
  let aborted = false;
  const genStart = Date.now();
  const showThinking = dom.showThinkingCheckbox?.checked || false;
  try {
    const fetchBody = {
      model: dom.modelSelect.value,
      messages,
      options: { temperature: 0.85, top_p: 0.9, num_ctx: getNumCtx() },
      timeout: parseInt(dom.imageTimeoutInput.value, 10) || 120,
    };
    if (showThinking) fetchBody.think = true;

    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: abortController.signal,
      body: JSON.stringify(fetchBody),
    });

    if (!response.ok) {
      const data = await response.json();
      throw new Error(cleanErrorMessage(data.error) || "请求失败");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let firstChunkReceived = false;
    let thinkingDone = false;

    function appendStreamLine(line) {
      if (!line.trim()) return;
      const data = JSON.parse(line);
      if (data.prompt_eval_count || data.eval_count) {
        const tps = data.eval_count && data.eval_duration
          ? (data.eval_count / (data.eval_duration / 1e9))
          : null;
        usageStats = {
          prompt: data.prompt_eval_count || (usageStats?.prompt || 0),
          eval: data.eval_count || (usageStats?.eval || 0),
          tps,
        };
      }
      const thinkChunk = data.message?.thinking || "";
      const chunk = data.message?.content || "";
      if (!thinkChunk && !chunk) return;

      if (thinkChunk && showThinking) {
        thinkingContent += thinkChunk;
        if (!firstChunkReceived) {
          firstChunkReceived = true;
          if (state.streamingInfo) state.streamingInfo.phase = 'streaming';
          if (!bg) setAvatarState("talking");
          if (state.activeTabId === tabId) {
            const bubble = dom.messagesEl.querySelector('.streaming-bubble');
            if (bubble) {
              bubble.innerHTML = "";
              bubble.classList.remove("thinking");
              const details = document.createElement("details");
              details.className = "thinking-details";
              details.open = true;
              details.innerHTML = `<summary><span class="thinking-text">${t("msg_thinkingInProgress")}<span class="thinking-dots"><span>.</span><span>.</span><span>.</span><span>.</span><span>.</span><span>.</span></span></span></summary><div class="thinking-content markdownBody"></div>`;
              bubble.appendChild(details);
              const md = document.createElement("div");
              md.className = "markdownBody";
              bubble.appendChild(md);
            }
          }
        }
        if (state.activeTabId === tabId) {
          const thinkEl = dom.messagesEl.querySelector('.streaming-bubble .thinking-content');
          if (thinkEl) {
            thinkEl.innerHTML = markdownToHtml(thinkingContent);
            scrollChatToEndIfPinned();
          }
        }
        return;
      }

      if (chunk) {
        if (!thinkingDone && thinkingContent && showThinking) {
          thinkingDone = true;
          if (state.activeTabId === tabId) {
            const details = dom.messagesEl.querySelector('.streaming-bubble .thinking-details');
            if (details) {
              details.open = false;
              const summary = details.querySelector('summary');
              if (summary) summary.textContent = t("msg_thinkingSummary");
            }
          }
        }

        if (!firstChunkReceived) {
          firstChunkReceived = true;
          if (state.streamingInfo) state.streamingInfo.phase = 'streaming';
          if (!bg) setAvatarState("talking");
          if (state.activeTabId === tabId) {
            const bubble = dom.messagesEl.querySelector('.streaming-bubble');
            if (bubble) {
              bubble.innerHTML = "";
              bubble.classList.remove("thinking");
              const md = document.createElement("div");
              md.className = "markdownBody";
              bubble.appendChild(md);
            }
          }
        }

        content += chunk;
        if (state.streamingInfo) state.streamingInfo.content = content;
        if (state.activeTabId === tabId) {
          const md = dom.messagesEl.querySelector('.streaming-bubble > .markdownBody');
          if (md) {
            md.innerHTML = markdownToHtml(content);
            scrollChatToEndIfPinned();
          }
        }
      }
    }

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) appendStreamLine(line);
    }
    buffer += decoder.decode();
    if (buffer.trim()) appendStreamLine(buffer);

    content = content.trim() || "我刚才有点走神了，你再说一次好吗？";
    state.streamingInfo = null;
    const reply = { role: "assistant", content, timestamp: Date.now(), genMs: Date.now() - genStart };
    if (thinkingContent) reply.thinking = thinkingContent;
    if (insertIndex >= 0 && insertIndex <= tab.messages.length) {
      tab.messages.splice(insertIndex, 0, reply);
    } else {
      tab.messages.push(reply);
    }
    saveChat();
    if (state.activeTabId === tabId) renderChat();
    showExpression(detectExpression(content));
  } catch (error) {
    state.streamingInfo = null;
    if (error.name === "AbortError") {
      aborted = true;
      if (content.trim()) {
        const reply = { role: "assistant", content: content.trim(), timestamp: Date.now(), genMs: Date.now() - genStart };
        if (thinkingContent) reply.thinking = thinkingContent;
        if (insertIndex >= 0 && insertIndex <= tab.messages.length) {
          tab.messages.splice(insertIndex, 0, reply);
        } else {
          tab.messages.push(reply);
        }
        saveChat();
        if (state.activeTabId === tabId) renderChat();
      } else {
        const bubble = dom.messagesEl.querySelector('.streaming-bubble');
        if (bubble) bubble.remove();
      }
    } else {
      const bubble = dom.messagesEl.querySelector('.streaming-bubble');
      if (bubble) {
        bubble.className = "message system";
        bubble.textContent = `${error.message}`;
      }
      showSendError(error.message);
    }
    setAvatarState("idle");
  } finally {
    state.streamingInfo = null;
    setGenerating(false);
    if (usageStats) {
      recordContextUsage(tab, usageStats.prompt, usageStats.eval, usageStats.tps);
      if (state.activeTabId === tabId) renderContextMeter();
    }
  }
  return aborted;
}

export async function regenerateReply(tabId = state.activeTabId, insertIndex = -1, contextEndIndex = -1, replyMeta = {}, bg = null) {
  const tab = getTab(tabId);
  if (!tab) return;

  // A background job (bg set) runs headless: it uses bg.signal instead of the global
  // abort controller, never touches the send-button lock / avatar / streaming bubble,
  // and swaps its placeholder via bg.place() at the end (position is by msgId).
  const abortController = bg ? { signal: bg.signal } : new AbortController();
  if (!bg) {
    state.currentAbortController = abortController;
    setGenerating(true);
    setAvatarState("thinking");
    state.streamingInfo = { tabId, content: '', phase: 'thinking', insertIndex };
  }
  if (!bg && state.activeTabId === tabId) {
    const pending = document.createElement("div");
    pending.className = "message assistant thinking streaming-bubble";
    const body = document.createElement("div");
    body.className = "markdownBody";
    body.innerHTML = `<span class="thinking-text">${t("msg_thinking")}<span class="thinking-dots"><span>.</span><span>.</span><span>.</span><span>.</span><span>.</span><span>.</span></span></span>`;
    pending.appendChild(body);
    const refNode = insertIndex >= 0 ? dom.messagesEl.children[insertIndex] : null;
    if (refNode) {
      dom.messagesEl.insertBefore(pending, refNode);
    } else {
      dom.messagesEl.appendChild(pending);
    }
    scrollChatToEnd();
  }

  let content = "";
  let thinkingContent = "";
  let usageStats = null;
  let aborted = false;
  const genStart = Date.now();
  const showThinking = dom.showThinkingCheckbox?.checked || false;

  try {
    const fetchBody = {
      model: dom.modelSelect.value,
      messages: buildMessages(tabId, contextEndIndex),
      options: { temperature: 0.85, top_p: 0.9, num_ctx: getNumCtx() },
      timeout: parseInt(dom.imageTimeoutInput.value, 10) || 120,
    };
    if (showThinking) fetchBody.think = true;

    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: abortController.signal,
      body: JSON.stringify(fetchBody),
    });

    if (!response.ok) {
      const data = await response.json();
      throw new Error(cleanErrorMessage(data.error) || "请求失败");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let firstChunkReceived = false;
    let thinkingDone = false;

    function appendStreamLine(line) {
      if (!line.trim()) return;
      const data = JSON.parse(line);
      if (data.prompt_eval_count || data.eval_count) {
        const tps = data.eval_count && data.eval_duration
          ? (data.eval_count / (data.eval_duration / 1e9))
          : null;
        usageStats = {
          prompt: data.prompt_eval_count || (usageStats?.prompt || 0),
          eval: data.eval_count || (usageStats?.eval || 0),
          tps,
        };
      }
      const thinkChunk = data.message?.thinking || "";
      const chunk = data.message?.content || "";
      if (!thinkChunk && !chunk) return;

      // Handle thinking tokens
      if (thinkChunk && showThinking) {
        thinkingContent += thinkChunk;
        if (!firstChunkReceived) {
          firstChunkReceived = true;
          if (state.streamingInfo) state.streamingInfo.phase = 'streaming';
          if (!bg) setAvatarState("talking");
          if (state.activeTabId === tabId) {
            const bubble = dom.messagesEl.querySelector('.streaming-bubble');
            if (bubble) {
              bubble.innerHTML = "";
              bubble.classList.remove("thinking");
              const details = document.createElement("details");
              details.className = "thinking-details";
              details.open = true;
              details.innerHTML = `<summary><span class="thinking-text">${t("msg_thinkingInProgress")}<span class="thinking-dots"><span>.</span><span>.</span><span>.</span><span>.</span><span>.</span><span>.</span></span></span></summary><div class="thinking-content markdownBody"></div>`;
              bubble.appendChild(details);
              const md = document.createElement("div");
              md.className = "markdownBody";
              bubble.appendChild(md);
            }
          }
        }
        if (state.activeTabId === tabId) {
          const thinkEl = dom.messagesEl.querySelector('.streaming-bubble .thinking-content');
          if (thinkEl) {
            thinkEl.innerHTML = markdownToHtml(thinkingContent);
            scrollChatToEndIfPinned();
          }
        }
        return;
      }

      // Handle content tokens
      if (chunk) {
        if (!thinkingDone && thinkingContent && showThinking) {
          thinkingDone = true;
          if (state.activeTabId === tabId) {
            const details = dom.messagesEl.querySelector('.streaming-bubble .thinking-details');
            if (details) {
              details.open = false;
              const summary = details.querySelector('summary');
              if (summary) summary.textContent = t("msg_thinkingSummary");
            }
          }
        }

        if (!firstChunkReceived) {
          firstChunkReceived = true;
          if (state.streamingInfo) state.streamingInfo.phase = 'streaming';
          if (!bg) setAvatarState("talking");
          if (state.activeTabId === tabId) {
            const bubble = dom.messagesEl.querySelector('.streaming-bubble');
            if (bubble) {
              bubble.innerHTML = "";
              bubble.classList.remove("thinking");
              const md = document.createElement("div");
              md.className = "markdownBody";
              bubble.appendChild(md);
            }
          }
        }

        content += chunk;
        if (state.streamingInfo) state.streamingInfo.content = content;
        if (state.activeTabId === tabId) {
          const md = dom.messagesEl.querySelector('.streaming-bubble > .markdownBody');
          if (md) {
            md.innerHTML = markdownToHtml(content);
            scrollChatToEndIfPinned();
          }
        }
      }
    }

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) appendStreamLine(line);
    }

    buffer += decoder.decode();
    if (buffer.trim()) appendStreamLine(buffer);

    content = content.trim() || "我刚才有点走神了，你再说一次好吗？";
    if (!bg) state.streamingInfo = null;
    if (!bg && state.activeTabId === tabId) {
      const md = dom.messagesEl.querySelector('.streaming-bubble > .markdownBody');
      if (md) md.innerHTML = markdownToHtml(content);
    }
    const reply = { role: "assistant", content, timestamp: Date.now(), genMs: Date.now() - genStart, ...replyMeta };
    if (thinkingContent) reply.thinking = thinkingContent;
    if (bg) {
      // Multi-message bg job (docfull/url) passes a real insertIndex (the cursor) →
      // splice there, keeping the placeholder below. Single-result job (insertIndex<0)
      // → swap the placeholder by msgId (Phase 2 behavior).
      if (insertIndex >= 0 && insertIndex <= tab.messages.length) {
        tab.messages.splice(insertIndex, 0, reply);
        bg.commit();
      } else {
        bg.place(reply);
      }
    } else {
      if (insertIndex >= 0 && insertIndex <= tab.messages.length) {
        tab.messages.splice(insertIndex, 0, reply);
      } else {
        tab.messages.push(reply);
      }
      saveChat();
      if (state.activeTabId === tabId) renderChat();
      showExpression(detectExpression(content));
      if (dom.autoSpeakCheckbox.checked && state.activeTabId === tabId) {
        const lastSpeakBtn = dom.messagesEl.querySelector(".message.assistant:last-child .speakMessage");
        if (lastSpeakBtn) speakMessage(content, lastSpeakBtn);
      }
    }
  } catch (error) {
    if (bg) {
      if (error.name === "AbortError") return;  // canceled — the job is already removed
      throw error;                               // let the queue mark it errored + retryable
    }
    state.streamingInfo = null;
    if (error.name === "AbortError") {
      aborted = true;
      if (content.trim()) {
        if (state.activeTabId === tabId) {
          const md = dom.messagesEl.querySelector('.streaming-bubble > .markdownBody');
          if (md) md.innerHTML = markdownToHtml(content);
        }
        const reply = { role: "assistant", content: content.trim(), timestamp: Date.now(), genMs: Date.now() - genStart, ...replyMeta };
        if (thinkingContent) reply.thinking = thinkingContent;
        if (insertIndex >= 0 && insertIndex <= tab.messages.length) {
          tab.messages.splice(insertIndex, 0, reply);
        } else {
          tab.messages.push(reply);
        }
        saveChat();
        if (state.activeTabId === tabId) renderChat();
      } else {
        const bubble = dom.messagesEl.querySelector('.streaming-bubble');
        if (bubble) bubble.remove();
      }
    } else {
      const bubble = dom.messagesEl.querySelector('.streaming-bubble');
      if (bubble) {
        bubble.className = "message system";
        bubble.textContent = `${error.message}\n\n提示：先打开 Ollama，并下载模型，例如：ollama pull qwen2.5:7b`;
      }
      showSendError(error.message);
    }
    setAvatarState("idle");
  } finally {
    if (!bg) {
      state.streamingInfo = null;
      setGenerating(false);
    }
    if (usageStats) {
      recordContextUsage(tab, usageStats.prompt, usageStats.eval, usageStats.tps);
      if (!bg && state.activeTabId === tabId) renderContextMeter();
    }
  }
  return aborted;
}

// Deliver a proactive message (reminder / greeting / nudge) into the active tab.
// The model phrases it in character using `instruction`; nothing is added as a
// user message. Returns when done (used by the scheduler to serialize firings).
export async function generateProactiveReply(instruction, tabId = state.activeTabId, insertIndex = -1, contextEndIndex = -1) {
  const tab = getTab(tabId);
  if (!tab || tab.locked) return;
  if (state.currentAbortController || state.imageGenAbortController) return;
  const inPlace = insertIndex >= 0;

  const abortController = new AbortController();
  state.currentAbortController = abortController;
  setGenerating(true);
  setAvatarState("thinking");
  state.streamingInfo = { tabId, content: '', phase: 'thinking', insertIndex };

  if (state.activeTabId === tabId) {
    const pending = document.createElement("div");
    pending.className = "message assistant thinking streaming-bubble";
    const body = document.createElement("div");
    body.className = "markdownBody";
    body.innerHTML = `<span class="thinking-text">${t("msg_thinking")}<span class="thinking-dots"><span>.</span><span>.</span><span>.</span><span>.</span><span>.</span><span>.</span></span></span>`;
    pending.appendChild(body);
    const refNode = inPlace ? dom.messagesEl.children[insertIndex] : null;
    if (refNode) dom.messagesEl.insertBefore(pending, refNode);
    else dom.messagesEl.appendChild(pending);
    scrollChatToEnd();
  }

  let content = "";
  try {
    const messages = [...buildMessages(tabId, contextEndIndex), { role: "user", content: instruction }];
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: abortController.signal,
      body: JSON.stringify({
        model: dom.modelSelect.value,
        messages,
        options: { temperature: 0.85, top_p: 0.9, num_ctx: getNumCtx() },
        timeout: parseInt(dom.imageTimeoutInput.value, 10) || 120,
      }),
    });
    if (!response.ok) {
      const d = await response.json();
      throw new Error(cleanErrorMessage(d.error) || "请求失败");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let firstChunk = false;
    function appendLine(line) {
      if (!line.trim()) return;
      const data = JSON.parse(line);
      const chunk = data.message?.content || "";
      if (!chunk) return;
      if (!firstChunk) {
        firstChunk = true;
        if (state.streamingInfo) state.streamingInfo.phase = 'streaming';
        setAvatarState("talking");
        if (state.activeTabId === tabId) {
          const bubble = dom.messagesEl.querySelector('.streaming-bubble');
          if (bubble) {
            bubble.innerHTML = "";
            bubble.classList.remove("thinking");
            const md = document.createElement("div");
            md.className = "markdownBody";
            bubble.appendChild(md);
          }
        }
      }
      content += chunk;
      if (state.streamingInfo) state.streamingInfo.content = content;
      if (state.activeTabId === tabId) {
        const md = dom.messagesEl.querySelector('.streaming-bubble > .markdownBody');
        if (md) {
          md.innerHTML = markdownToHtml(content);
          scrollChatToEndIfPinned();
        }
      }
    }

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) appendLine(line);
    }
    buffer += decoder.decode();
    if (buffer.trim()) appendLine(buffer);

    content = content.trim();
    state.streamingInfo = null;
    const bubble = dom.messagesEl.querySelector('.streaming-bubble');
    if (bubble) bubble.remove();
    if (!content) return;

    const reply = { role: "assistant", content, timestamp: Date.now() };
    if (inPlace && insertIndex <= tab.messages.length) tab.messages.splice(insertIndex, 0, reply);
    else tab.messages.push(reply);
    saveChat();
    if (state.activeTabId === tabId) renderChat();
    showExpression(detectExpression(content));
    if (dom.autoSpeakCheckbox.checked && state.activeTabId === tabId) {
      const lastSpeakBtn = dom.messagesEl.querySelector(".message.assistant:last-child .speakMessage");
      if (lastSpeakBtn) speakMessage(content, lastSpeakBtn);
    }
  } catch (error) {
    // Proactive failures are silent — just clean up the pending bubble.
    state.streamingInfo = null;
    const bubble = dom.messagesEl.querySelector('.streaming-bubble');
    if (bubble) bubble.remove();
  } finally {
    state.streamingInfo = null;
    setGenerating(false);
    state.currentAbortController = null;
    setAvatarState("idle");
  }
}

// Parse /search flags: --deep[=N] / --read, --n N, --day/week/month/year.
function parseSearchOptions(raw) {
  let deep = false, deepCount = 3, count = 6, timelimit = "";
  let q = raw;
  q = q.replace(/(?:^|\s)--deep(?:=(\d+))?(?=\s|$)/i, (_, n) => { deep = true; if (n) deepCount = Math.min(3, Math.max(1, +n)); return " "; });
  q = q.replace(/(?:^|\s)--read(?=\s|$)/i, () => { deep = true; return " "; });
  q = q.replace(/(?:^|\s)--(?:n|num)\s+(\d+)(?=\s|$)/i, (_, n) => { count = Math.min(10, Math.max(1, +n)); return " "; });
  q = q.replace(/(?:^|\s)--(day|week|month|year)(?=\s|$)/i, (_, t) => { timelimit = { day: "d", week: "w", month: "m", year: "y" }[t.toLowerCase()]; return " "; });
  return { query: q.replace(/\s+/g, " ").trim(), deep, deepCount, count, timelimit };
}

// Web search via DuckDuckGo: fetch results, show them as a sources bubble, then
// let the model answer the query using those results (and, with --deep, the
// fetched page contents) as context.
async function handleSearchCommand(raw, tab, tabId, fullContent, insertIndex = -1, contextEndIndex = -1) {
  const { query, deep, deepCount, count, timelimit } = parseSearchOptions(raw);
  const inPlace = insertIndex >= 0;
  // On resend the /search command bubble already exists in place; bubbles produced
  // here are spliced in right after it (incrementing cursor). On a fresh command
  // everything is appended at the end.
  let cursor = insertIndex;
  const place = (msg) => {
    if (inPlace && cursor <= tab.messages.length) tab.messages.splice(cursor++, 0, msg);
    else tab.messages.push(msg);
  };

  if (!inPlace) tab.messages.push({ role: "user", content: fullContent, timestamp: Date.now() });
  if (!query) {
    place({ role: "assistant", content: t("search_usage"), timestamp: Date.now() });
    saveChat();
    if (state.activeTabId === tabId) renderChat();
    return;
  }
  saveChat();
  if (state.activeTabId === tabId) renderChat();

  setAvatarState("thinking");
  setGenerating(true);
  const abortController = new AbortController();
  state.currentAbortController = abortController;

  let pending = null;
  if (state.activeTabId === tabId) {
    pending = document.createElement("div");
    pending.className = "message assistant thinking";
    const body = document.createElement("div");
    body.className = "markdownBody";
    const label = deep ? t("search_searchingDeep") : t("search_searching");
    body.innerHTML = `<span class="thinking-text">${label}<span class="thinking-dots"><span>.</span><span>.</span><span>.</span><span>.</span><span>.</span><span>.</span></span></span>`;
    pending.appendChild(body);
    const refNode = inPlace ? dom.messagesEl.children[insertIndex] : null;
    if (refNode) dom.messagesEl.insertBefore(pending, refNode);
    else dom.messagesEl.appendChild(pending);
    scrollChatToEnd();
  }

  const finish = (assistantContent) => {
    if (pending) pending.remove();
    if (assistantContent) place({ role: "assistant", content: assistantContent, timestamp: Date.now() });
    saveChat();
    if (state.activeTabId === tabId) renderChat();
    setAvatarState("idle");
    setGenerating(false);
    state.currentAbortController = null;
  };

  try {
    const res = await fetch("/api/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: abortController.signal,
      body: JSON.stringify({ query, deep, deepCount, count, timelimit, language: getPromptLanguage() }),
    });
    const data = await res.json();

    if (data.error === "captcha") { showSendError(t("search_captcha")); finish(`⚠️ ${t("search_captcha")}`); return; }
    if (!res.ok || !data.results || data.results.length === 0) { finish(`⚠️ ${t("search_noResults")}`); return; }

    if (pending) pending.remove();
    const lines = [`🔎 **${t("search_resultsFor", { query })}**`, ""];
    data.results.forEach((r, i) => {
      lines.push(`${i + 1}. [${r.title}](${r.url})`);
      if (r.snippet) lines.push(`   ${r.snippet}`);
    });
    place({ role: "assistant", content: lines.join("\n"), timestamp: Date.now() });
    saveChat();
    if (state.activeTabId === tabId) renderChat();

    // Hand off to the model: answer the query grounded in the results above
    // (or the fetched page excerpts when --deep was used).
    setGenerating(false);
    setAvatarState("idle");
    state.currentAbortController = null;
    let instruction = getPrompt("searchAnswer", query);
    if (deep) {
      const excerpts = data.results
        .filter((r) => r.content && r.content.length > 50)
        .map((r, i) => `【${i + 1}. ${r.title} — ${r.url}】\n${r.content}`)
        .join("\n\n");
      if (excerpts) instruction = getPrompt("searchAnswerDeep", query, excerpts);
    }
    // The answer goes right after the sources bubble (cursor), grounded in context
    // up to and including that sources bubble (cursor - 1).
    await generateProactiveReply(instruction, tabId, inPlace ? cursor : -1, inPlace ? cursor - 1 : -1);
  } catch (error) {
    if (error.name === "AbortError") {
      if (pending) pending.remove();
      saveChat();
      if (state.activeTabId === tabId) renderChat();
      setAvatarState("idle");
      setGenerating(false);
      state.currentAbortController = null;
    } else {
      const m = t("search_failed", { error: error.message });
      showSendError(m);
      finish(`⚠️ ${m}`);
    }
  }
}

// Agentic reply: model can call tools (datetime/calculate/web_search/recall_memory)
// in a loop. Uses stream:false (local models call tools more reliably non-streamed),
// so the final answer renders at once after a "using tools" indicator.
export async function agenticReply(tabId = state.activeTabId, insertIndex = -1, contextEndIndex = -1) {
  const tab = getTab(tabId);
  if (!tab || tab.locked) return;

  const abortController = new AbortController();
  state.currentAbortController = abortController;
  setGenerating(true);
  setAvatarState("thinking");

  let pending = null;
  const setPending = (text) => {
    if (state.activeTabId !== tabId) return;
    if (!pending) {
      pending = document.createElement("div");
      pending.className = "message assistant thinking";
      const body = document.createElement("div");
      body.className = "markdownBody";
      pending.appendChild(body);
      // Insert right after the resent bubble when regenerating; else append.
      const refNode = insertIndex >= 0 ? dom.messagesEl.children[insertIndex] : null;
      if (refNode) dom.messagesEl.insertBefore(pending, refNode);
      else dom.messagesEl.appendChild(pending);
    }
    pending.querySelector(".markdownBody").innerHTML =
      `<span class="thinking-text">${text}<span class="thinking-dots"><span>.</span><span>.</span><span>.</span><span>.</span><span>.</span><span>.</span></span></span>`;
    scrollChatToEnd();
  };
  setPending(t("msg_thinking"));

  const genStart = Date.now();
  const messages = buildMessages(tabId, contextEndIndex);
  const toolSteps = [];
  const seen = new Map(); // tool-call signature -> cached result (kills repeat loops)
  const showThinking = dom.showThinkingCheckbox?.checked || false;
  let thinkingContent = "";
  let finalContent = "";
  let forceText = false;
  try {
    for (let iter = 0; iter < 6; iter++) {
      const useTools = iter < 5 && !forceText; // last turn / repeat detected: force a text answer
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: abortController.signal,
        body: JSON.stringify({
          model: dom.modelSelect.value,
          messages,
          ...(useTools ? { tools: TOOL_SCHEMAS } : {}),
          ...(showThinking ? { think: true } : {}),
          stream: false,
          options: { temperature: 0.7, num_ctx: getNumCtx() },
          timeout: parseInt(dom.imageTimeoutInput.value, 10) || 120,
        }),
      });
      if (!res.ok) { const d = await res.json(); throw new Error(cleanErrorMessage(d.error) || "请求失败"); }
      const msg = (await res.json()).message || {};
      if (msg.thinking) thinkingContent += (thinkingContent ? "\n\n" : "") + msg.thinking;
      const toolCalls = msg.tool_calls || [];

      if (toolCalls.length && useTools) {
        messages.push({ role: "assistant", content: msg.content || "", tool_calls: toolCalls });
        let anyNew = false;
        for (const call of toolCalls) {
          const fn = call.function || {};
          const sig = fn.name + ":" + JSON.stringify(fn.arguments || {});
          let result;
          if (seen.has(sig)) {
            result = seen.get(sig); // already computed — reuse, don't re-run
          } else {
            anyNew = true;
            setPending(`🔧 ${t("tools_using", { tool: getToolLabel(fn.name, fn.arguments) })}`);
            setAvatarState("thinking");
            result = await executeTool(fn.name, fn.arguments);
            seen.set(sig, result);
            toolSteps.push({ name: fn.name, args: fn.arguments, result: String(result) });
          }
          messages.push({ role: "tool", tool_name: fn.name, content: String(result).slice(0, 4000) });
        }
        // Model only re-asked tools it already ran → it's looping; force a text answer next.
        if (!anyNew) forceText = true;
        setPending(t("msg_thinking"));
        continue;
      }
      finalContent = (msg.content || "").trim();
      break;
    }
  } catch (error) {
    if (pending) pending.remove();
    if (error.name !== "AbortError") {
      const errReply = { role: "assistant", content: `⚠️ ${error.message}`, timestamp: Date.now() };
      if (insertIndex >= 0 && insertIndex <= tab.messages.length) tab.messages.splice(insertIndex, 0, errReply);
      else tab.messages.push(errReply);
      saveChat();
      if (state.activeTabId === tabId) renderChat();
      showSendError(error.message);
    }
    setAvatarState("idle");
    setGenerating(false);
    state.currentAbortController = null;
    return;
  }

  if (pending) pending.remove();
  if (finalContent) {
    const reply = { role: "assistant", content: finalContent, timestamp: Date.now(), genMs: Date.now() - genStart };
    if (toolSteps.length) reply.toolSteps = toolSteps;
    if (thinkingContent) reply.thinking = thinkingContent;
    if (insertIndex >= 0 && insertIndex <= tab.messages.length) tab.messages.splice(insertIndex, 0, reply);
    else tab.messages.push(reply);
    saveChat();
    if (state.activeTabId === tabId) renderChat();
    showExpression(detectExpression(finalContent));
    if (dom.autoSpeakCheckbox.checked && state.activeTabId === tabId) {
      const btn = dom.messagesEl.querySelector(".message.assistant:last-child .speakMessage");
      if (btn) speakMessage(finalContent, btn);
    }
  }
  setAvatarState("idle");
  setGenerating(false);
  state.currentAbortController = null;
}

// Route a regenerated reply through the agent loop when tools are enabled,
// otherwise the normal streaming path. Both honor insertIndex/contextEndIndex so
// a resent bubble truncates context to itself and inserts the reply right after.
function dispatchReply(tabId, insertIndex = -1, contextEndIndex = -1) {
  if (dom.toolsToggle?.checked) agenticReply(tabId, insertIndex, contextEndIndex);
  else regenerateReply(tabId, insertIndex, contextEndIndex);
}

// Parse /analyze [-f N] [-d] [extra question]. `-f`/`--frames` sets how many frames to
// sample from a video (1–32, default 8); `-d`/`--debug` shows the extracted frames in
// the chat instead of analyzing (to verify they actually differ). Null if not /analyze.
function parseAnalyzeCommand(input) {
  const m = input.match(/^\/analyze(?:\s+([\s\S]+))?\s*$/i);
  if (!m) return null;
  let rest = (m[1] || "").trim();
  let frames = null, debug = false;
  rest = rest.replace(/(?:^|\s)(?:-d|--debug)(?=\s|$)/i, () => { debug = true; return " "; });
  rest = rest.replace(/(?:^|\s)(?:-f|--frames)\s+(\d+)(?=\s|$)/i, (_, n) => {
    frames = Math.min(32, Math.max(1, parseInt(n, 10)));
    return " ";
  });
  return { prompt: rest.trim(), frames, debug };
}

// Strip a data-URL prefix so we hand the model raw base64 (what Ollama expects).
function rawBase64(s) {
  return s.includes(",") && s.startsWith("data:") ? s.split(",")[1] : s;
}

// Run the vision model over the media on the just-sent /analyze bubble (attached
// image/video) or, if none was attached, the most recent user bubble carrying
// media. Video is sampled into frames first. Streams the answer like a reply.
export async function analyzeMedia(parsed, tabId, image, video, insertIndex = -1, anchorIndex = -1, bg = null) {
  const tab = getTab(tabId);
  if (!tab) return;
  if (!bg && (state.currentAbortController || state.imageGenAbortController)) return;

  // On resend/edit the result is spliced right after the /analyze bubble
  // (insertIndex); on a fresh command it's appended at the end. A background job
  // (bg set) instead swaps its placeholder via bg.place() — position is by msgId.
  const inPlace = insertIndex >= 0;
  const place = (msg) => {
    if (bg) { bg.place(msg); return; }
    if (inPlace && insertIndex <= tab.messages.length) tab.messages.splice(insertIndex, 0, msg);
    else tab.messages.push(msg);
  };
  // Foreground persists + rerenders after place(); the bg sink's place() already does.
  const commit = () => { if (bg) return; saveChat(); if (state.activeTabId === tabId) renderChat(); };

  const abortController = bg ? { signal: bg.signal } : new AbortController();
  if (!bg) {
    state.currentAbortController = abortController;
    setGenerating(true);
    setAvatarState("thinking");
  }

  // The collapsible "thinking" content (frame→time map + optional -d frames). Filled
  // in once the frames are sampled, then shown folded in the pending/streaming bubble
  // (and carried onto the final reply), so it's visible during "analyzing video…".
  let thinkingMd = "";
  let debugFrames = null;
  const syncThinking = (bubble) => {
    if (!bubble || bubble.querySelector(":scope > .thinking-details")) return;
    const el = buildThinkingDetails(thinkingMd, debugFrames);
    if (el) bubble.insertBefore(el, bubble.firstChild);
  };

  const showPending = (text) => {
    if (bg) { bg.label(text); return; }  // headless: surface phase text in the drawer/placeholder
    if (state.activeTabId !== tabId) return;
    let bubble = dom.messagesEl.querySelector('.streaming-bubble');
    if (!bubble) {
      bubble = document.createElement("div");
      bubble.className = "message assistant thinking streaming-bubble";
      const body = document.createElement("div");
      body.className = "markdownBody";
      bubble.appendChild(body);
      const refNode = inPlace ? dom.messagesEl.children[insertIndex] : null;
      if (refNode) dom.messagesEl.insertBefore(bubble, refNode);
      else dom.messagesEl.appendChild(bubble);
    }
    syncThinking(bubble);
    const mainBody = bubble.querySelector(":scope > .markdownBody");
    if (mainBody) mainBody.innerHTML =
      `<span class="thinking-text">${text}<span class="thinking-dots"><span>.</span><span>.</span><span>.</span><span>.</span><span>.</span><span>.</span></span></span>`;
    scrollChatToEnd();
  };

  const cleanupPending = () => {
    if (bg) return;
    const bubble = dom.messagesEl.querySelector('.streaming-bubble');
    if (bubble) bubble.remove();
  };

  try {
    // 1. Resolve the media to analyze and turn it into a flat array of frames.
    let images = [];
    let kind = "";
    let frameTimes = []; // timestamps (s) of the sampled frames, shown to the user as a map
    const frameTarget = parsed.frames || 8;
    // Sample the video into N still frames and send them as SEPARATE images in
    // chronological order — the model refers to them by frame number (#1..#N),
    // which is far more reliable than mapping moments to timestamps. The actual
    // timestamps are surfaced to the user as a frame→time table (not to the model).
    const framesFromVideo = async (b64, mime) => {
      showPending(t("analyze_extracting"));
      const src = b64.startsWith("data:") ? b64 : `data:${mime || "video/mp4"};base64,${b64}`;
      const frames = await extractVideoFrames(src, frameTarget);
      frameTimes = frames.map(f => f.t);
      return frames.map(f => rawBase64(f.url));
    };

    // When both an image and a video are present they're MERGED into one turn:
    // the uploaded image(s) first, then the sampled video frames. kindOf() labels
    // the result so the right system prompt / instruction is chosen below.
    let imageCount = 0, frameCount = 0;
    const kindOf = (imgs, frames) => (imgs && frames) ? "mixed" : (frames ? "video" : "image");
    const uploaded = image
      ? (image.multi ? image.multi.map(img => rawBase64(img.base64)) : [rawBase64(image.base64)])
      : [];

    // frameCount = number of video frames (each sent as its own image); imageCount =
    // standalone uploaded images. kindOf() picks image/video/mixed from the two.
    let videoFrames = [];
    if (image || video) {
      videoFrames = video ? await framesFromVideo(video.base64, video.mime) : [];
      imageCount = uploaded.length;
      frameCount = videoFrames.length;
      images = [...uploaded, ...videoFrames];
      kind = kindOf(uploaded.length, frameCount);
    } else {
      // Fall back to the nearest preceding user bubble with media. anchorIndex is
      // the bubble just before the /analyze command (resend passes index-1; a fresh
      // command defaults to the second-to-last message = the bubble before it).
      const start = anchorIndex >= 0 ? anchorIndex : tab.messages.length - 2;
      for (let i = start; i >= 0; i--) {
        const m = tab.messages[i];
        if (m.role !== "user") continue;
        const hasImg = m.images?.length, hasVid = m.generatedVideos?.length;
        if (!hasImg && !hasVid) continue;
        const imgs = hasImg ? m.images.map(rawBase64) : [];
        videoFrames = hasVid ? await framesFromVideo(m.generatedVideos[0], m.videoMime) : [];
        imageCount = imgs.length;
        frameCount = videoFrames.length;
        images = [...imgs, ...videoFrames];
        kind = kindOf(imgs.length, frameCount);
        break;
      }
    }

    if (!images.length) {
      cleanupPending();
      place({ role: "assistant", content: t("analyze_noMedia"), timestamp: Date.now() });
      commit();
      return;
    }


    // 2. Build the analysis request as a self-contained turn: a dedicated
    // "visual analysis expert" system prompt (NOT the chat persona) and a single
    // user turn carrying the frames + instruction — no prior conversation context.
    let basePrompt, systemPrompt;
    if (kind === "mixed") {
      basePrompt = t("analyze_mixedPrompt", { images: imageCount, frames: frameCount });
      systemPrompt = t("analyze_mixedSystem");
    } else if (kind === "video") {
      basePrompt = t("analyze_videoPrompt", { frames: frameCount });
      systemPrompt = t("analyze_videoSystem");
    } else {
      basePrompt = t("analyze_imagePrompt");
      systemPrompt = t("analyze_imageSystem");
    }
    const instruction = parsed.prompt ? `${basePrompt}\n\n${parsed.prompt}` : basePrompt;
    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: instruction, images },
    ];

    // Build the thinking content now (before the model call) so it shows folded in
    // the pending/streaming bubble: frame→time map, plus the -d frame screenshots.
    if (frameTimes.length) {
      const rows = frameTimes.map((s, i) => t("analyze_frameRow", { n: i + 1, t: (s || 0).toFixed(1) })).join("\n");
      thinkingMd = `${t("analyze_frameMap")}\n\n${rows}`;
    }
    if (parsed.debug && videoFrames.length) {
      debugFrames = videoFrames;
      thinkingMd = `${t("analyze_debugFrames", { frames: videoFrames.length })}\n\n${thinkingMd || ""}`.trim();
    }

    const working = kind === "mixed" ? t("analyze_workingMixed", { images: imageCount, frames: frameCount })
      : kind === "video" ? t("analyze_workingVideo", { frames: frameCount })
      : t("analyze_workingImage");
    showPending(working);

    // 3. Run the vision model. A background (server) job submits the /api/chat call to
    // the server-side queue so it survives a page close/reload (chatFetch reconnects by
    // serverJobId, no re-inference); the foreground streams the answer into the bubble.
    let content = "";
    if (bg && bg.server) {
      const resp = await chatFetch(
        { model: dom.modelSelect.value, messages, options: { temperature: 0.5, num_ctx: getNumCtx() }, timeout: parseInt(dom.imageTimeoutInput.value, 10) || 120 },
        { bgJob: bg.server.bgJob, conversationId: bg.server.conversationId, msgId: bg.server.msgId, label: bg.server.label, signal: abortController.signal });
      if (!resp.ok) throw new Error(cleanErrorMessage((await resp.json()).error) || "请求失败");
      content = ((await resp.json()).content || "");
    } else {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: abortController.signal,
        body: JSON.stringify({
          model: dom.modelSelect.value,
          messages,
          options: { temperature: 0.5, num_ctx: getNumCtx() },
          timeout: parseInt(dom.imageTimeoutInput.value, 10) || 120,
        }),
      });
      if (!response.ok) {
        const d = await response.json().catch(() => ({}));
        throw new Error(cleanErrorMessage(d.error) || "请求失败");
      }

      // Stream the answer into the bubble.
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let firstChunk = false;
      const appendLine = (line) => {
        if (!line.trim()) return;
        const data = JSON.parse(line);
        const chunk = data.message?.content || "";
        if (!chunk) return;
        if (!firstChunk) {
          firstChunk = true;
          if (!bg) setAvatarState("talking");
          if (!bg && state.activeTabId === tabId) {
            const bubble = dom.messagesEl.querySelector('.streaming-bubble');
            // Clear ONLY the main body (the thinking <details> stays folded above it).
            if (bubble) { bubble.classList.remove("thinking"); const mb = bubble.querySelector(":scope > .markdownBody"); if (mb) mb.innerHTML = ""; }
          }
        }
        content += chunk;
        if (!bg && state.activeTabId === tabId) {
          const md = dom.messagesEl.querySelector('.streaming-bubble > .markdownBody');
          if (md) { md.innerHTML = markdownToHtml(content); scrollChatToEndIfPinned(); }
        }
      };

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) appendLine(line);
      }
      buffer += decoder.decode();
      if (buffer.trim()) appendLine(buffer);
    }

    cleanupPending();
    content = content.trim();
    if (content) {
      // Carry the same thinking content (frame→time map; -d frame screenshots) onto
      // the final reply — it already showed folded during streaming.
      const reply = { role: "assistant", content, timestamp: Date.now() };
      if (thinkingMd) reply.thinking = thinkingMd;
      if (debugFrames) reply.thinkingFrames = debugFrames;
      place(reply);
      commit();
      if (!bg) showExpression(detectExpression(content));
    } else if (bg) {
      // A background job can't show an inline empty-result bubble — surface it to the
      // queue so the drawer/placeholder offers a retry instead of silently finishing.
      throw new Error(t("bg_analyzeEmpty"));
    }
  } catch (error) {
    cleanupPending();
    if (error.name === "AbortError") {
      // Canceled (foreground stop or a bg job cancel) — nothing to place.
    } else if (bg) {
      throw error;  // let the queue mark the job errored + retryable
    } else {
      place({ role: "assistant", content: `⚠️ ${error.message}`, timestamp: Date.now() });
      commit();
      showSendError(error.message);
    }
  } finally {
    if (!bg) {
      setGenerating(false);
      setAvatarState("idle");
      state.currentAbortController = null;
    }
  }
}

export async function sendMessage(content, image, tabId = state.activeTabId, file = null, video = null) {
  const tab = getTab(tabId);
  if (!tab) return;
  if (tab.locked) return;

  // A newly sent message always scrolls to the bottom — drop any resend scroll pin.
  state.scrollPin = null;

  markActivity();

  // Handle /retry [Nx] — re-answer my last message N times, each a fresh reply
  // appended after the previous (no duplicate user bubble; old replies kept).
  const retryMatch = content && content.match(/^\/retry(?:\s+(\d+)x)?\s*$/i);
  if (retryMatch) {
    let lastUserIdx = -1;
    for (let i = tab.messages.length - 1; i >= 0; i--) {
      if (tab.messages[i].role === "user") { lastUserIdx = i; break; }
    }
    if (lastUserIdx === -1) return; // nothing to retry
    const times = Math.min(8, Math.max(1, parseInt(retryMatch[1], 10) || 1));
    for (let k = 0; k < times; k++) {
      const wasAborted = await regenerateReply(tabId, -1, lastUserIdx);
      if (wasAborted) break; // user hit stop — abandon the rest of the batch
    }
    return;
  }

  // Handle /remind command — schedule a proactive reminder
  if (content && /^\/remind(\s|$)/.test(content)) {
    const parsed = parseRemind(content);
    tab.messages.push({ role: "user", content, timestamp: Date.now() });
    if (parsed.error) {
      tab.messages.push({ role: "assistant", content: t(parsed.error), timestamp: Date.now() });
    } else {
      addReminder(parsed.reminder);
      tab.messages.push({ role: "assistant", content: t("msg_reminderSet", { when: describeReminder(parsed.reminder), text: parsed.reminder.text }), timestamp: Date.now() });
    }
    saveChat();
    if (state.activeTabId === tabId) renderChat();
    return;
  }

  // Handle /search command — web search via DuckDuckGo
  if (content && /^\/search(\s|$)/.test(content)) {
    const raw = content.replace(/^\/search\s*/, "").trim();
    await handleSearchCommand(raw, tab, tabId, content);
    return;
  }

  // Handle /clear command
  if (content && /^\/clear\s*$/.test(content)) {
    tab.messages = [];
    delete tab.ctxPromptTokens;
    delete tab.ctxEvalTokens;
    delete tab.ctxTokensPerSec;
    saveChat();
    renderChat();
    return;
  }

  // Handle /memory command — store a durable fact about the user
  const rememberMatch = content && content.match(/^\/memory\s+([\s\S]+)/);
  if (rememberMatch) {
    const fact = rememberMatch[1].trim();
    addMemory(fact);
    tab.messages.push({ role: "user", content, timestamp: Date.now() });
    tab.messages.push({ role: "assistant", content: t("msg_remembered", { fact }), timestamp: Date.now() });
    saveChat();
    if (state.activeTabId === tabId) renderChat();
    return;
  }

  // Handle /compact command
  if (content && /^\/compact\s*$/.test(content)) {
    await handleCompactCommand(tab, tabId);
    return;
  }

  // Handle /title command
  if (content && /^\/title(\s|$)/.test(content)) {
    await handleTitleCommand(tab, tabId, content);
    return;
  }

  // Handle /url command — the whole chain (fetch → maybe whisper → format → reply)
  // runs in the background queue (whisper transcription especially can be slow).
  const urlTarget = parseUrlCommand(content);
  if (urlTarget) {
    tab.messages.push({ role: "user", content, timestamp: Date.now() });
    saveChat();
    if (state.activeTabId === tabId) renderChat();
    enqueueBgJob({ tabId, kind: "url", label: t("bg_fetchingUrl"), payload: { entries: urlTarget.entries, fullContent: content } });
    return;
  }

  // Handle /0 (no context) and /1 (previous message only) commands
  const isolatedMatch = content && content.match(/^\/(0|1)\s+([\s\S]+)/);
  if (isolatedMatch) {
    const mode = isolatedMatch[1]; // "0" or "1"
    const actualContent = isolatedMatch[2];
    const userMessage = { role: "user", content, timestamp: Date.now() };
    tab.messages.push(userMessage);
    saveChat();
    if (state.activeTabId === tabId) renderChat();
    const insertIndex = tab.messages.length;
    await isolatedReply(actualContent, mode, tab, tabId, insertIndex);
    return;
  }

  const noteCmd = content ? parseNoteCommand(content) : null;
  if (noteCmd) {
    const userMessage = { role: "user", content, timestamp: Date.now() };
    tab.messages.push(userMessage);
    if (noteCmd.error) {
      tab.messages.push({ role: "assistant", content: t("msg_commandError", { error: noteCmd.error }), timestamp: Date.now() });
    }
    saveChat();
    if (state.activeTabId === tabId) renderChat();
    return;
  }

  const imagineCmds = content ? parseImagineCommands(content) : null;
  if (imagineCmds) {
    const userMessage = { role: "user", content, timestamp: Date.now() };
    // An attached image turns /imagine into image-to-image (instruction editing).
    if (image) {
      if (image.multi) {
        userMessage.images = image.multi.map(img => img.base64);
        userMessage.previewImages = image.multi.map(img => img.preview);
        userMessage.imageNames = image.multi.map(img => img.name || null);
      } else {
        userMessage.images = [image.base64];
        userMessage.previewImages = [image.preview];
        userMessage.imageNames = [image.name || null];
        // Inpaint mask painted on a single staged image (white = repaint region).
        // Persisted on the message so a resend reproduces the same masked edit.
        if (image.mask) userMessage.mask = image.mask;
      }
      userMessage.previewImage = userMessage.previewImages[0];
    }
    // Attached video(s) are the SOURCE for a video-edit model (Bernini / Animate).
    // Several clips can be staged → each runs the workflow once (batch). They ride on
    // the user bubble for display (reusing the generatedVideos field).
    const imagineVideos = stagedVideoList(video);
    attachVideosToMessage(userMessage, imagineVideos);
    tab.messages.push(userMessage);
    const firstError = imagineCmds.find((cmd) => cmd && cmd.error);
    // A bare "/imagine" (no prompt) is valid only when something is attached
    // (image or video) — the gen is then attachment-driven (video edit / img2img).
    const hasAttach = !!(image || imagineVideos.length);
    const validCmds = imagineCmds.filter((cmd) => cmd && !cmd.error && (cmd.prompt || hasAttach));
    if (firstError) {
      tab.messages.push({ role: "assistant", content: t("msg_commandError", { error: firstError.error }), timestamp: Date.now() });
      saveChat();
      if (state.activeTabId === tabId) renderChat();
    } else if (validCmds.length === 0) {
      tab.messages.push({ role: "assistant", content: t("msg_commandError", { error: "缺少提示词，或附带一张图片 / 一段视频再发送。" }), timestamp: Date.now() });
      saveChat();
      if (state.activeTabId === tabId) renderChat();
    } else {
      // Generation ALWAYS goes to the background queue. One source clip → one job;
      // multiple clips fan out (cartesian with each command's count).
      saveChat();
      if (state.activeTabId === tabId) renderChat();
      enqueueImagineGen(validCmds, tabId, userMessage.images || null, imagineVideos, userMessage.mask || null);
    }
    return;
  }

  const voiceCmd = content ? parseVoiceCommand(content) : null;
  if (voiceCmd) {
    const userMessage = { role: "user", content, timestamp: Date.now() };
    tab.messages.push(userMessage);
    saveChat();
    if (state.activeTabId === tabId) renderChat();
    if (voiceCmd.error) {
      tab.messages.push({ role: "assistant", content: t("msg_commandError", { error: voiceCmd.error }), timestamp: Date.now() });
      saveChat();
      if (state.activeTabId === tabId) renderChat();
    } else {
      // Audio generation ALWAYS goes to the background queue.
      enqueueBgJob({ tabId, kind: "audio", label: voiceCmd.text.slice(0, 48), payload: { parsed: voiceCmd } });
    }
    return;
  }

  // Handle /analyze — feed the attached image(s)/video (or the most recent bubble
  // with media) to the vision model and ask it to describe/analyze the content.
  const analyzeCmd = content ? parseAnalyzeCommand(content) : null;
  if (analyzeCmd) {
    const userMessage = { role: "user", content, timestamp: Date.now() };
    if (image) {
      if (image.multi) {
        userMessage.images = image.multi.map(img => img.base64);
        userMessage.previewImages = image.multi.map(img => img.preview);
        userMessage.imageNames = image.multi.map(img => img.name || null);
      } else {
        userMessage.images = [image.base64];
        userMessage.previewImages = [image.preview];
        userMessage.imageNames = [image.name || null];
        // Inpaint mask painted on a single staged image (white = repaint region).
        // Persisted on the message so a resend reproduces the same masked edit.
        if (image.mask) userMessage.mask = image.mask;
      }
      userMessage.previewImage = userMessage.previewImages[0];
    }
    // /analyze inspects only the FIRST staged clip (vision analysis isn't batched).
    const analyzeVideos = stagedVideoList(video);
    attachVideosToMessage(userMessage, analyzeVideos);
    tab.messages.push(userMessage);
    // anchorIndex = the bubble just before this /analyze command, for the
    // no-attachment fallback that scans backwards for the nearest media bubble.
    const anchorIndex = tab.messages.length - 2;
    saveChat();
    if (state.activeTabId === tabId) renderChat();
    // Vision analysis ALWAYS goes to the background queue (it can be slow — frame
    // sampling + a multi-image vision pass).
    enqueueAnalyzeJob(analyzeCmd, tabId, image, analyzeVideos[0] || null, anchorIndex);
    return;
  }

  // Handle document file upload
  if (file) {
    // User bubble was already shown before parsing; skip creating another one

    // Build auto-prompt for PDF/DOCX
    const ext = file.name.split(".").pop().toLowerCase();
    const isPdfOrDocx = ext === "pdf" || ext === "docx";
    let autoPrompt;
    if (isPdfOrDocx) {
      const hasImages = file.images && file.images.length > 0;
      let base = hasImages
        ? `请对这篇文章做一个全面的总结，然后逐一描述每张图片的内容。`
        : `请对这篇文章做一个全面的总结。`;
      autoPrompt = content ? `${base}\n\n用户补充: ${content}` : base;
    } else if (content) {
      autoPrompt = content;
    } else {
      autoPrompt = `请阅读以上文件内容并等待我的提问。`;
    }

    // Show parsed content as assistant preview bubble
    const toolLabel = file.tool ? ` (via ${file.tool})` : "";
    let previewContent = `📄 **FILE: ${file.name}**${toolLabel}\n\n${file.text}`;
    const assistantPreview = {
      role: "assistant",
      content: previewContent,
      timestamp: Date.now(),
      isFilePreview: true,
    };
    if (file.images && file.images.length > 0) {
      assistantPreview.images = file.images.map((img) => img.base64);
    }
    // Display-only thumbnails (e.g. images downloaded from email HTML): shown in
    // the bubble but kept out of `images` so they never enter the model context.
    if (file.displayThumbnails && file.displayThumbnails.length > 0) {
      assistantPreview.generatedThumbnails = file.displayThumbnails;
    }
    tab.messages.push(assistantPreview);

    // Show prompt as a user message bubble after the file preview
    const promptMessage = {
      role: "user",
      content: autoPrompt,
      timestamp: Date.now(),
    };
    tab.messages.push(promptMessage);

    saveChat();
    if (state.activeTabId === tabId) renderChat();

    // Auto-summarize PDF/DOCX in the background queue — large docs mean long context
    // and a slow first reply, so it shouldn't block the live bubble. The placeholder
    // appends after the prompt; regenerateReply (headless) swaps in the summary.
    if (isPdfOrDocx) {
      enqueueBgJob({ tabId, kind: "doc", label: t("bg_analyzingDoc"), payload: { contextEndIndex: -1, replyMeta: {} } });
    }
    return;
  }

  const userMessage = {
    role: "user",
    content: content || (image ? getPrompt("imageFallback") : ""),
    timestamp: Date.now(),
  };

  if (image) {
    if (image.multi) {
      userMessage.images = image.multi.map(img => img.base64);
      userMessage.previewImages = image.multi.map(img => img.preview);
      userMessage.imageNames = image.multi.map(img => img.name || null);
    } else {
      userMessage.images = [image.base64];
      userMessage.previewImages = [image.preview];
      userMessage.imageNames = [image.name || null];
    }
    userMessage.previewImage = userMessage.previewImages[0]; // backward compat
  }

  // Uploaded video(s) ride along on the user bubble for display only. They reuse the
  // generatedVideos field so they render/persist like generated clips, but
  // buildMessages() never forwards videos to the model — so there's no AI analysis.
  const plainVideos = stagedVideoList(video);
  attachVideosToMessage(userMessage, plainVideos);

  tab.messages.push(userMessage);
  saveChat();
  if (state.activeTabId === tabId) renderChat();

  // A video with no accompanying text/image is purely an upload — nothing for the
  // model to respond to, so don't trigger a reply.
  if (plainVideos.length && !content && !image) return;

  // Tools enabled (and no image — vision + tools is unreliable on local models) → agent loop.
  if (dom.toolsToggle?.checked && !image) {
    agenticReply(tabId);
  } else {
    regenerateReply(tabId);
  }
}

// Generate poster thumbnails for a message's videos that predate the thumbnail
// feature, then persist them. Runs once per message (guarded by a transient flag).
async function backfillVideoThumbnails(message) {
  if (message._thumbBackfilling) return;
  message._thumbBackfilling = true;
  const vmime = message.videoMime || "video/mp4";
  const thumbs = await Promise.all(message.generatedVideos.map((v) =>
    videoThumbnail(v.startsWith("data:") ? v : `data:${vmime};base64,${v}`)));
  if (thumbs.some(Boolean)) {
    message.generatedVideoThumbnails = thumbs;
    saveChat();
  }
}

// Human-readable byte size for download tooltips (empty when unknown).
function formatFileSize(bytes) {
  if (!bytes || bytes < 0) return "";
  return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

// Decoded byte length of a base64 (or data:) string. 0 for remote URLs.
function base64ByteLength(src) {
  if (!src || src.startsWith("http")) return 0;
  const data = src.startsWith("data:") ? src.slice(src.indexOf(",") + 1) : src;
  const pad = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor(data.length * 3 / 4) - pad);
}

// File extension (no dot) for an image src — from the data: mime, the URL path,
// or the raw base64 magic bytes. Defaults to png.
function imageExtFromSrc(src) {
  if (!src) return "png";
  if (src.startsWith("data:")) {
    const sub = src.slice(5, src.indexOf(";") === -1 ? undefined : src.indexOf(";")).split("/")[1];
    if (sub) return sub === "jpeg" ? "jpg" : sub.split("+")[0];
  } else if (src.startsWith("http")) {
    const m = src.split(/[?#]/)[0].match(/\.(png|jpe?g|webp|gif|bmp|avif)$/i);
    return m ? (m[1].toLowerCase() === "jpeg" ? "jpg" : m[1].toLowerCase()) : "jpg";
  }
  return src.startsWith("/9j/") ? "jpg" : "png";
}

// "YYYYMMDD-HHMMSS" from a timestamp (ms; now if absent) for default filenames.
function timestampStamp(ts) {
  const d = ts ? new Date(ts) : new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// Default download filename when the media has no name of its own: the owning
// message's timestamp + kind (+ index when the message holds several), e.g.
// "20260620-130910-image.png". `name`, if given, wins (kept with its extension).
function mediaFilename(name, ts, kind, ext, idx, count) {
  if (name) return /\.[a-z0-9]+$/i.test(name) ? name : `${name}.${ext}`;
  const suffix = count > 1 ? `-${idx + 1}` : "";
  return `${timestampStamp(ts)}-${kind}${suffix}.${ext}`;
}

// The small bottom-right "download" overlay shared by image/video previews.
// The tooltip (title + aria-label) carries the filename and, when known, size.
function makeDownloadButton(className, href, filename, bytes, actionLabel) {
  const dl = document.createElement("a");
  dl.className = className;
  // href may be a function (lazy): resolve it to a real URL on the first hover/
  // focus/press — before the activating click — so a lazily-loaded video's blob
  // URL isn't built (decoding the whole clip) until the user actually reaches for
  // the download. These events all fire ahead of the click that triggers the save.
  if (typeof href === "function") {
    dl.href = "#";
    const resolve = () => {
      if (dl.dataset.hrefResolved) return;
      const url = href();
      if (url) { dl.href = url; dl.dataset.hrefResolved = "1"; }
    };
    dl.addEventListener("pointerenter", resolve);
    dl.addEventListener("pointerdown", resolve);
    dl.addEventListener("focus", resolve);
  } else {
    dl.href = href;
  }
  dl.download = filename;
  const size = formatFileSize(bytes);
  const label = size ? `${filename} · ${size}` : filename;
  dl.title = label;
  dl.setAttribute("aria-label", actionLabel ? `${actionLabel}: ${label}` : label);
  dl.textContent = "⬇";
  return dl;
}

// Build the collapsible "thinking" <details> block: optional markdown text plus an
// optional grid of frame screenshots (used by /analyze and its -d flag). Shared by
// renderMessage and the live /analyze streaming bubble. Returns null if both empty.
function buildThinkingDetails(thinkingText, frames) {
  if (!thinkingText && !(frames && frames.length)) return null;
  const details = document.createElement("details");
  details.className = "thinking-details";
  const inner = thinkingText ? markdownToHtml(thinkingText) : "";
  details.innerHTML = `<summary>${t("msg_thinkingSummary")}</summary><div class="thinking-content markdownBody">${inner}</div>`;
  if (frames && frames.length) {
    const content = details.querySelector(".thinking-content");
    const grid = document.createElement("div");
    grid.className = "imageGrid";
    for (const f of frames) {
      const wrapper = document.createElement("div");
      wrapper.className = "imageWrapper";
      const img = document.createElement("img");
      img.className = "generatedImage";
      img.src = f.startsWith("data:") ? f : `data:image/jpeg;base64,${f}`;
      wrapper.appendChild(img);
      grid.appendChild(wrapper);
    }
    content.appendChild(grid);
  }
  return details;
}

// --- Lazy video loading -----------------------------------------------------
// Assigning a base64 data: URL as a <video> src forces the browser to decode the
// whole clip up front (data: URLs can't be streamed or range-requested), so a tab
// holding a few large videos makes every refresh crawl while they all decode at
// once. Instead we keep the poster visible and only build a STREAMABLE blob object
// URL — with preload="metadata" the browser then reads just the header, not the
// whole file — once the video scrolls near the visible area. The object URLs are
// revoked on the next renderChat so they don't leak.
let videoLazyObserver = null;
const videoObjectUrls = new Set();
const videoLazyData = new WeakMap(); // video element → { data, mime } until loaded

function resetVideoLazyLoading() {
  if (videoLazyObserver) { videoLazyObserver.disconnect(); videoLazyObserver = null; }
  for (const url of videoObjectUrls) URL.revokeObjectURL(url);
  videoObjectUrls.clear();
}

function base64ToBlobUrl(b64, mime) {
  const raw = b64.startsWith("data:") ? b64.slice(b64.indexOf(",") + 1) : b64;
  const bin = atob(raw);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  videoObjectUrls.add(url);
  return url;
}

function loadVideoNow(video) {
  const stash = videoLazyData.get(video);
  if (!stash) return;
  videoLazyData.delete(video);
  video.preload = "metadata"; // header only — the full clip decodes on play
  video.src = base64ToBlobUrl(stash.data, stash.mime);
}

function lazyLoadVideo(video, base64, mime) {
  video.preload = "none"; // nothing loads until it nears the viewport
  videoLazyData.set(video, { data: base64, mime });
  if (!videoLazyObserver) {
    videoLazyObserver = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        loadVideoNow(e.target);
        videoLazyObserver.unobserve(e.target);
      }
    }, { root: dom.messagesEl, rootMargin: "400px" }); // load a bit before it's in view
  }
  videoLazyObserver.observe(video);
}

function renderMessage(role, content, previewImage, index, timestamp, generatedImages, generatedThumbnails, generatedVideos, videoMime, generatedAudio, audioMime, generatedVideoThumbnails) {
  const item = document.createElement("div");
  item.className = `message ${role}`;

  if (timestamp) {
    const ts = document.createElement("div");
    ts.className = "messageTimestamp";
    ts.textContent = formatTimestamp(timestamp);
    item.appendChild(ts);
  }

  if (Number.isInteger(index)) {
    item.dataset.msgIndex = index;
    item.addEventListener("mousedown", (e) => {
      // The bubble is drag-to-reorder, but pressing on its text (to select) or on
      // its media/controls (to drag the image/video out, scrub, click a button)
      // must NOT start a bubble drag — only a press on the bubble's own chrome does.
      const noDrag = e.target.closest(
        ".plainBody, .markdownBody, .editMessageInput, textarea, " +
        "img, video, .imageWrapper, .videoWrapper, button, input, a"
      );
      item.draggable = !noDrag;
    });
    item.addEventListener("mouseup", () => { item.draggable = false; });
    item.addEventListener("dragstart", (e) => {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("application/msg-index", String(index));
      item.classList.add("isDragging");
    });
    item.addEventListener("dragend", () => {
      item.draggable = false;
      item.classList.remove("isDragging");
      document.querySelectorAll(".message.dragOver").forEach((el) => el.classList.remove("dragOver"));
    });
    item.addEventListener("dragover", (e) => {
      if (!e.dataTransfer.types.includes("application/msg-index")) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      item.classList.add("dragOver");
    });
    item.addEventListener("dragleave", () => { item.classList.remove("dragOver"); });
    item.addEventListener("drop", (e) => {
      if (!e.dataTransfer.types.includes("application/msg-index")) return;
      e.preventDefault();
      item.classList.remove("dragOver");
      const fromIndex = Number(e.dataTransfer.getData("application/msg-index"));
      const toIndex = index;
      if (fromIndex === toIndex) return;
      const tab = getActiveTab();
      const [moved] = tab.messages.splice(fromIndex, 1);
      tab.messages.splice(toIndex, 0, moved);
      saveChat();
      renderChat();
    });
  }

  const canSpeak = role === "assistant" && content && content !== "thinking-placeholder";
  // /memory and /remind already acted when first sent; resending them is meaningless.
  // (/search IS resendable — it re-runs the web search.)
  const isNonResendableCmd = role === "user" && /^\/(memory|remind)(\s|$)/.test(content || "");
  const canResend = role === "user" && Number.isInteger(index) && !isNonResendableCmd;
  const canTranslate = Number.isInteger(index) && content && content !== "thinking-placeholder";

  if (canSpeak || canResend || canTranslate || Number.isInteger(index)) {
    const leftActions = document.createElement("div");
    leftActions.className = "messageActions messageActionsLeft";
    const rightActions = document.createElement("div");
    rightActions.className = "messageActions messageActionsRight";

    if (canSpeak) {
      const speakButton = document.createElement("button");
      speakButton.className = "messageAction speakMessage";
      speakButton.type = "button";
      speakButton.title = t("btn_speak");
      speakButton.setAttribute("aria-label", t("btn_speak"));
      speakButton.textContent = t("btn_speak");
      speakButton.addEventListener("click", () => speakMessage(content, speakButton));
      leftActions.appendChild(speakButton);
    }

    if (canResend) {
      const resendButton = document.createElement("button");
      resendButton.className = "messageAction resendMessage";
      resendButton.type = "button";
      resendButton.title = t("btn_resend");
      resendButton.setAttribute("aria-label", t("btn_resend"));
      resendButton.textContent = t("btn_resend");
      resendButton.addEventListener("click", () => resendChatMessage(index));
      leftActions.appendChild(resendButton);
    }

    if (canTranslate) {
      const translateButton = document.createElement("button");
      translateButton.className = "messageAction translateMessage";
      translateButton.type = "button";
      translateButton.title = t("btn_translateEn");
      translateButton.setAttribute("aria-label", t("btn_translateEn"));
      translateButton.textContent = t("btn_translateEn");
      translateButton.addEventListener("click", () => translateMessage(index, "en"));
      leftActions.appendChild(translateButton);

      const translateChButton = document.createElement("button");
      translateChButton.className = "messageAction translateMessage";
      translateChButton.type = "button";
      translateChButton.title = t("btn_translateZh");
      translateChButton.setAttribute("aria-label", t("btn_translateZh"));
      translateChButton.textContent = t("btn_translateZh");
      translateChButton.addEventListener("click", () => translateMessage(index, "zh"));
      leftActions.appendChild(translateChButton);

      const copyButton = document.createElement("button");
      copyButton.className = "messageAction copyMessage";
      copyButton.type = "button";
      copyButton.title = t("btn_copy");
      copyButton.setAttribute("aria-label", t("btn_copy"));
      copyButton.textContent = "📋";
      copyButton.addEventListener("click", () => copyMessageText(content, copyButton));
      leftActions.appendChild(copyButton);
    }

    if (Number.isInteger(index)) {
      const forkButton = document.createElement("button");
      forkButton.className = "messageAction forkMessage";
      forkButton.type = "button";
      forkButton.title = t("btn_fork");
      forkButton.setAttribute("aria-label", t("btn_fork"));
      forkButton.textContent = t("btn_fork");
      forkButton.addEventListener("click", () => forkConversation(index));
      rightActions.appendChild(forkButton);
    }

    if (Number.isInteger(index)) {
      const deleteButton = document.createElement("button");
      deleteButton.className = "messageAction deleteMessage";
      deleteButton.type = "button";
      deleteButton.title = "×";
      deleteButton.setAttribute("aria-label", "delete");
      deleteButton.textContent = "×";
      deleteButton.addEventListener("click", () => deleteChatMessage(index));
      rightActions.appendChild(deleteButton);
    }

    if (leftActions.children.length) item.appendChild(leftActions);
    if (rightActions.children.length) item.appendChild(rightActions);
  }

  // For user bubbles we group the uploaded image(s) AND the uploaded video into a
  // single flex row placed above the text (the video block below fills it too).
  const mediaRowEnabled = role === "user";
  let mediaRow = null;
  let textEl = null;

  if (previewImage) {
    const previews = Array.isArray(previewImage) ? previewImage : [previewImage];
    // Original upload filenames + full-res bytes, when kept, so the download uses
    // the real name and the original image (falling back to the thumbnail).
    const msg = Number.isInteger(index) ? getActiveTab().messages[index] : null;
    const imageNames = msg?.imageNames;
    const fullImages = msg?.images;
    // User bubbles: one shared media row (images + video on the same line).
    // Otherwise multiple images render in a compact grid; a single image stays inline.
    const container = mediaRowEnabled
      ? (mediaRow = Object.assign(document.createElement("div"), { className: "messageMediaRow" }))
      : (previews.length > 1
          ? Object.assign(document.createElement("div"), { className: "messageImages" })
          : item);
    previews.forEach((src, imgIdx) => {
      const wrapper = document.createElement("div");
      wrapper.className = "imageWrapper messageImageWrapper";
      const image = document.createElement("img");
      image.className = "messageImage";
      image.src = src;
      image.alt = "用户上传的图片";
      if (Number.isInteger(index)) {
        image.dataset.msgIndex = index;
        image.dataset.imgIndex = imgIdx;
      }
      wrapper.appendChild(image);
      // Download the original image when we still have it; else the thumbnail.
      const full = fullImages?.[imgIdx];
      const dlSrc = full
        ? (full.startsWith("data:") || full.startsWith("http")
            ? full
            : `data:${full.startsWith("/9j/") ? "image/jpeg" : "image/png"};base64,${full}`)
        : src;
      const fname = mediaFilename(imageNames?.[imgIdx], timestamp, "image", imageExtFromSrc(dlSrc), imgIdx, previews.length);
      wrapper.appendChild(makeDownloadButton("imageDownloadBtn", dlSrc, fname, base64ByteLength(dlSrc), t("btn_downloadImage")));
      // Inpaint mask: on a SINGLE-image USER bubble, when a mask-capable ComfyUI
      // model is selected, float a 🖌 button (top-right) to paint/edit the region.
      // The mask is stored on the message; a resend then regenerates with it.
      if (role === "user" && previews.length === 1 && Number.isInteger(index) && comfyModelSupportsMask()) {
        const maskBtn = document.createElement("button");
        maskBtn.type = "button";
        maskBtn.className = "messageMaskBtn" + (msg?.mask ? " hasMask" : "");
        maskBtn.title = msg?.mask ? "编辑修改区域蒙版（已设置，重发以应用）" : "涂抹要修改的区域（局部重绘，重发以应用）";
        maskBtn.setAttribute("aria-label", "涂抹蒙版");
        maskBtn.textContent = "🖌";
        maskBtn.addEventListener("click", async (e) => {
          e.stopPropagation();
          const tab = getActiveTab();
          const mm = tab?.messages?.[index];
          if (!mm) return;
          const b64 = mm.images?.[0] || "";
          const fullSrc = b64
            ? (b64.startsWith("data:") || b64.startsWith("http") ? b64 : `data:${b64.startsWith("/9j/") ? "image/jpeg" : "image/png"};base64,${b64}`)
            : src;
          const result = await openMaskModal(fullSrc, mm.mask || null);
          mm.mask = result || undefined; // null = cleared/cancelled → drop the mask
          saveChat();
          renderChat();
        });
        wrapper.appendChild(maskBtn);
      }
      container.appendChild(wrapper);
    });
    if (container !== item) item.appendChild(container);
  }

  if (content) {
    const text = document.createElement("div");
    text.className = role === "assistant" ? "markdownBody" : "plainBody";
    text.innerHTML = markdownToHtml(content);
    if ((role === "user" || role === "assistant") && Number.isInteger(index)) {
      text.addEventListener("dblclick", () => {
        if (getActiveTab().locked) return;
        const original = getActiveTab().messages[index]?.content || "";
        const textWidth = text.offsetWidth;
        const input = document.createElement("textarea");
        input.className = "editMessageInput";
        input.style.width = textWidth + "px";
        input.value = original;
        input.rows = Math.max(2, original.split("\n").length);
        text.replaceWith(input);
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
        // Grow the box to show the whole message (wrapped lines included), capped at
        // half the viewport so long messages scroll within the textarea instead of
        // taking over the screen. Keep growing as the user types.
        const autosizeInput = () => {
          input.style.height = "auto";
          input.style.height = Math.min(input.scrollHeight + 2, Math.round(window.innerHeight * 0.5)) + "px";
        };
        autosizeInput();
        input.addEventListener("input", autosizeInput);
        function finishEdit(save, triggerSend = true) {
          const newContent = input.value.trim();
          // Editing a user bubble re-runs it (a generation edit re-queues; text
          // edits regenerate in place). Only an in-page analysis job blocks this (it
          // splices in place) — server-side gen jobs are detached and don't. Refuse
          // with a dialog + restore the original text (revert this edit) instead.
          if (save && triggerSend && role === "user" && newContent && newContent !== original
              && !/^\/(memory|remind)(\s|$)/.test(newContent) && bubbleHasActiveInPageJob(getActiveTab(), index)) {
            alert(t('bg_queueBusyAlert'));
            input.replaceWith(text);
            return;
          }
          if (save && newContent && newContent !== original) {
            const scrollY = dom.messagesEl.scrollTop;
            const tab = getActiveTab();
            tab.messages[index].content = newContent;
            if (triggerSend) tab.messages[index].timestamp = Date.now();
            if (role === "user" && triggerSend) {
              // /memory and /remind already took effect when first sent; editing
              // only updates the displayed text — don't re-execute (this mirrors why
              // the resend button is hidden for them). Everything else behaves
              // exactly like the resend button — context truncation, in-place
              // insertion and locked-safe cleanup all come from resendChatMessage,
              // so the two paths can never drift apart again.
              if (/^\/(memory|remind)(\s|$)/.test(newContent)) {
                saveChat();
                renderChat();
              } else {
                saveChat();
                resendChatMessage(index);
              }
            } else {
              saveChat();
              renderChat();
              dom.messagesEl.scrollTop = scrollY;
            }
          } else {
            input.replaceWith(text);
          }
        }
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter" && e.ctrlKey) { e.preventDefault(); finishEdit(true, false); }
          if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey) { e.preventDefault(); finishEdit(true); }
          if (e.key === "Escape") { finishEdit(false); }
        });
        input.addEventListener("blur", () => finishEdit(false));
      });
    }
    item.appendChild(text);
    textEl = text;
  }

  const displayImages = generatedImages && generatedImages.length > 0 ? generatedImages : generatedThumbnails;
  if (displayImages && displayImages.length > 0) {
    const validImages = displayImages.filter((img) => img && (img.startsWith("http") || img.length > 100));
    const fullImages = generatedImages && generatedImages.length > 0 ? generatedImages : null;
    const ytId = Number.isInteger(index) && getActiveTab().messages[index]?.ytVideoId;

    if (validImages.length > 0) {
      const grid = document.createElement("div");
      grid.className = "imageGrid";

      for (let i = 0; i < validImages.length; i++) {
        const imgData = validImages[i];
        const wrapper = document.createElement("div");
        wrapper.className = "imageWrapper";
        const img = document.createElement("img");
        img.className = "generatedImage";
        if (imgData.startsWith("data:")) {
          img.src = imgData;
        } else if (imgData.startsWith("http")) {
          img.src = imgData;
        } else {
          const mime = imgData.startsWith("/9j/") ? "image/jpeg" : "image/png";
          img.src = `data:${mime};base64,${imgData}`;
        }
        if (fullImages && fullImages[i]) {
          const full = fullImages[i];
          if (full.startsWith("data:")) {
            img.dataset.fullSrc = full;
          } else if (full.startsWith("http")) {
            img.dataset.fullSrc = full;
          } else {
            const fmime = full.startsWith("/9j/") ? "image/jpeg" : "image/png";
            img.dataset.fullSrc = `data:${fmime};base64,${full}`;
          }
        } else if (ytId) {
          img.dataset.fullSrc = `https://img.youtube.com/vi/${ytId}/maxresdefault.jpg`;
        }
        img.alt = "AI 生成的图片";
        img.onerror = () => { img.alt = "图片加载失败"; img.style.display = "none"; };
        wrapper.appendChild(img);
        if (Number.isInteger(index)) {
          const delBtn = document.createElement("button");
          delBtn.className = "imageDeleteBtn";
          delBtn.type = "button";
          delBtn.title = "删除图片";
          delBtn.textContent = "×";
          delBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            if (!confirm("确定要删除这张图片吗？")) return;
            deleteMessageImage(index, i);
          });
          wrapper.appendChild(delBtn);
        }
        // Download button (bottom-right) — full-res src when available.
        const dlSrc = img.dataset.fullSrc || img.src;
        const iname = mediaFilename(null, timestamp, "image", imageExtFromSrc(dlSrc), i, validImages.length);
        wrapper.appendChild(makeDownloadButton("imageDownloadBtn", dlSrc, iname, base64ByteLength(dlSrc), t("btn_downloadImage")));
        grid.appendChild(wrapper);
      }
      item.appendChild(grid);
    }
  }

  // AI-generated videos (ComfyUI WAN etc.) — base64 mp4/webm as <video>.
  if (generatedVideos && generatedVideos.length > 0) {
    const vmime = videoMime || "video/mp4";
    // User bubbles share the media row built above (images + video, same line,
    // above the text); everyone else gets a standalone grid below the text.
    const vgrid = mediaRowEnabled ? null : document.createElement("div");
    if (vgrid) vgrid.className = "videoGrid";
    const vext = vmime.includes("webm") ? "webm" : vmime.includes("quicktime") ? "mov" : "mp4";
    for (let vi = 0; vi < generatedVideos.length; vi++) {
      const vData = generatedVideos[vi];
      if (!vData || vData.length < 100) continue;
      const wrapper = document.createElement("div");
      wrapper.className = "videoWrapper";
      const video = document.createElement("video");
      video.className = "generatedVideo";
      video.controls = true;
      video.loop = true;
      video.playsInline = true;
      // No autoplay — the user presses play. Muted by default so audio (LTX) never
      // surprises the user; they raise the volume themselves via the slider/icon or
      // the native controls. The poster shows immediately; the heavy video bytes load
      // lazily (streamable blob URL) only once it scrolls near view — see
      // lazyLoadVideo — so a tab full of large clips doesn't stall every refresh.
      // Use the captured thumbnail as the poster so a still shows before playback.
      const vthumb = generatedVideoThumbnails && generatedVideoThumbnails[vi];
      if (vthumb) video.poster = vthumb.startsWith("data:") ? vthumb : `data:image/jpeg;base64,${vthumb}`;
      video.muted = true;
      lazyLoadVideo(video, vData, vmime);
      // Only one video plays at a time — starting this one pauses the others.
      video.addEventListener("play", () => {
        dom.messagesEl.querySelectorAll("video.generatedVideo").forEach((other) => {
          if (other !== video && !other.paused) other.pause();
        });
      });
      wrapper.appendChild(video);

      // Volume slider — shown ONLY when the video has an audio track (LTX with
      // audio); WAN/Hunyuan are silent so it stays hidden. Synced with the native
      // controls' volume both ways.
      const volWrap = document.createElement("div");
      volWrap.className = "videoVolume";
      volWrap.hidden = true;
      const volIcon = document.createElement("button");
      volIcon.type = "button";
      volIcon.className = "videoVolumeIcon";
      volIcon.textContent = "🔇";
      volIcon.title = t("video_volume");
      volIcon.setAttribute("aria-label", t("video_volume"));
      const volSlider = document.createElement("input");
      volSlider.type = "range";
      volSlider.min = "0";
      volSlider.max = "1";
      volSlider.step = "0.05";
      volSlider.value = "0";
      volSlider.className = "videoVolumeSlider";
      volSlider.setAttribute("aria-label", t("video_volume"));
      volWrap.append(volIcon, volSlider);
      wrapper.appendChild(volWrap);
      volSlider.addEventListener("input", () => {
        video.muted = false;
        video.volume = Number(volSlider.value);
      });
      volIcon.addEventListener("click", () => {
        video.muted = !video.muted;
        if (!video.muted && video.volume === 0) { video.volume = 1; }
      });
      // Keep the slider/icon in sync whether the user uses this or the native bar.
      video.addEventListener("volumechange", () => {
        const v = video.muted ? 0 : video.volume;
        volSlider.value = String(v);
        volIcon.textContent = v === 0 ? "🔇" : v < 0.5 ? "🔉" : "🔊";
      });
      // Detect an audio track and reveal the slider. mozHasAudio/audioTracks are
      // ready at metadata (Firefox/Safari); Chrome only sets
      // webkitAudioDecodedByteCount once audio decodes, so also check on play.
      const hasAudio = (vd) => !!(vd.mozHasAudio || vd.webkitAudioDecodedByteCount || (vd.audioTracks && vd.audioTracks.length));
      const revealIfAudio = () => {
        if (!hasAudio(video)) return;
        volWrap.hidden = false;
        video.removeEventListener("loadeddata", revealIfAudio);
        video.removeEventListener("play", revealIfAudio);
        video.removeEventListener("timeupdate", revealIfAudio);
      };
      video.addEventListener("loadeddata", revealIfAudio);
      video.addEventListener("play", revealIfAudio);
      video.addEventListener("timeupdate", revealIfAudio);

      // Delete button (top-right) — removes just this video from the message.
      // User-bubble videos are uploads the message depends on, so they're not
      // individually deletable (no × shown); delete the whole bubble instead.
      if (Number.isInteger(index) && role !== "user") {
        const del = document.createElement("button");
        del.className = "videoDeleteBtn";
        del.type = "button";
        del.title = t("btn_deleteVideo");
        del.setAttribute("aria-label", t("btn_deleteVideo"));
        del.textContent = "×";
        del.addEventListener("click", (e) => {
          e.stopPropagation();
          if (!confirm(t("confirm_deleteVideo"))) return;
          deleteMessageVideo(index, vi);
        });
        wrapper.appendChild(del);
      }
      // Download button (bottom-right) — an <a download> pointing at the (data) URL.
      // Tooltip shows the filename and decoded byte size.
      // An uploaded clip keeps its own upload filename; generated clips fall back to
      // the timestamp. Uploaded source clips store per-clip names in videoNames[]
      // (legacy single-video bubbles used the scalar videoName).
      const msg = Number.isInteger(index) ? getActiveTab().messages[index] : null;
      const uploadedName = msg ? (Array.isArray(msg.videoNames) ? msg.videoNames[vi] : (generatedVideos.length === 1 ? msg.videoName : null)) : null;
      const vname = mediaFilename(uploadedName || null, timestamp, "video", vext, vi, generatedVideos.length);
      // Lazy href: reuses the already-loaded blob URL if the video is loaded,
      // else builds one on demand (see makeDownloadButton) — avoids decoding the
      // clip at render time just to populate the link.
      wrapper.appendChild(makeDownloadButton("videoDownloadBtn",
        () => video.currentSrc || video.src || base64ToBlobUrl(vData, vmime),
        vname, base64ByteLength(vData), t("btn_downloadVideo")));
      if (mediaRowEnabled) {
        // Lazily create the row when there were no images, then keep it above text.
        if (!mediaRow) mediaRow = Object.assign(document.createElement("div"), { className: "messageMediaRow" });
        mediaRow.appendChild(wrapper);
      } else {
        vgrid.appendChild(wrapper);
      }
    }
    if (mediaRowEnabled) {
      // A freshly-created row (video-only message) isn't in the DOM yet — insert it
      // above the text. If the row already held images it's connected; leave it.
      if (mediaRow && !mediaRow.isConnected) item.insertBefore(mediaRow, textEl);
    } else if (vgrid.children.length) {
      item.appendChild(vgrid);
    }
  }

  // AI-generated speech (/voice command) — base64 wav as <audio> + download.
  if (generatedAudio && generatedAudio.length > 100) {
    const amime = audioMime || "audio/wav";
    const aext = amime.includes("aac") ? "aac" : amime.includes("mpeg") ? "mp3" : amime.includes("ogg") ? "ogg" : "wav";
    const src = generatedAudio.startsWith("data:") ? generatedAudio : `data:${amime};base64,${generatedAudio}`;
    const wrapper = document.createElement("div");
    wrapper.className = "audioWrapper";
    const audio = document.createElement("audio");
    audio.className = "generatedAudio";
    audio.controls = true;
    audio.preload = "metadata";
    audio.src = src;
    wrapper.appendChild(audio);
    const aname = mediaFilename(null, timestamp, "audio", aext, 0, 1);
    wrapper.appendChild(makeDownloadButton("audioDownloadBtn", src, aname, base64ByteLength(generatedAudio), t("btn_downloadAudio")));
    item.appendChild(wrapper);
  }

  dom.messagesEl.appendChild(item);
  scrollChatToEnd();

  // Add fold/unfold toggle
  if (content && content !== "thinking-placeholder" && Number.isInteger(index)) {
    const foldToggle = document.createElement("button");
    foldToggle.className = "messageFoldToggle";
    foldToggle.type = "button";
    foldToggle.title = t("archive_collapse");
    foldToggle.innerHTML = "&#x25B2;"; // ▲
    foldToggle.addEventListener("click", () => {
      const isFolded = item.classList.toggle("isFolded");
      foldToggle.innerHTML = isFolded ? "&#x25BC;" : "&#x25B2;"; // ▼ or ▲
      if (isFolded) {
        const ts = timestamp ? formatTimestamp(timestamp) : "";
        const preview = content.length > 80 ? content.substring(0, 80) + "..." : content;
        const tooltipText = ts ? `${ts}\n${preview}` : preview;
        foldToggle.title = tooltipText;
      } else {
        foldToggle.title = t("archive_collapse");
      }
      if (Number.isInteger(index)) {
        const tab = getActiveTab();
        if (tab.messages[index]) {
          if (isFolded) {
            tab.messages[index].folded = true;
          } else {
            delete tab.messages[index].folded;
          }
          saveChat();
        }
      }
    });
    item.appendChild(foldToggle);
  }

  // Per-message lock: a floating 🔒 at the bottom-right pins the bubble so it
  // can't be deleted (its × is disabled) or replaced on resend.
  if (Number.isInteger(index)) {
    const lockBtn = document.createElement("button");
    lockBtn.className = "messageLockToggle";
    lockBtn.type = "button";
    const applyLockUI = (locked) => {
      lockBtn.textContent = locked ? "🔒" : "🔓";
      lockBtn.title = locked ? t("btn_unlockBubble") : t("btn_lockBubble");
      lockBtn.setAttribute("aria-label", lockBtn.title);
      lockBtn.classList.toggle("isLocked", locked);
      item.classList.toggle("bubbleLocked", locked);
      const del = item.querySelector(".deleteMessage");
      if (del) del.disabled = locked;
    };
    applyLockUI(!!(getActiveTab().messages[index]?.locked));
    lockBtn.addEventListener("click", () => {
      const m = getActiveTab().messages[index];
      if (!m) return;
      m.locked = !m.locked;
      applyLockUI(m.locked);
      saveChat();
    });
    item.appendChild(lockBtn);
  }

  return item;
}

export function renderChat() {
  // Capture position before the rebuild so we can keep the user where they were
  // when they've scrolled up (e.g. reading history while a reply finishes).
  const prevScrollTop = dom.messagesEl.scrollTop;
  const keepPosition = state.scrollPin == null && !state.stickToBottom;
  // Free the previous render's video blob URLs + observer before tearing down the DOM.
  resetVideoLazyLoading();
  dom.messagesEl.innerHTML = "";
  const chat = getActiveTab().messages;
  if (chat.length === 0) {
    const rawName = (dom.userName.value || "").split(/[,，、\s]+/).filter(Boolean)[0] || "";
    const promptLang = getPromptLanguage();
    const greetDefault = t("msg_greetDefault", null, promptLang);
    const greetName = rawName || greetDefault;
    const greeting = greetName ? t("msg_greeting", { name: greetName }, promptLang) : t("msg_greetingNoName", null, promptLang);
    renderMessage("assistant", greeting);
    highlightCodeBlocks();
    renderMermaidDiagrams();
    return;
  }

  chat.forEach((message, index) => {
    // Skip old-style translation messages (backward compat)
    if (message.isTranslation) return;

    // Background-job placeholder: a status bubble at the job's original position.
    if (message.bgPlaceholder) {
      dom.messagesEl.appendChild(renderBgPlaceholder(message));
      return;
    }

    // For file previews, prefer display-only thumbnails (which already bundle any
    // inline images as previews); otherwise derive the grid from `images`.
    const genImages = message.generatedImages || (message.isFilePreview && !message.generatedThumbnails?.length && message.images?.length
      ? message.images.map(img => img.startsWith("data:") ? img : `data:${img.startsWith("/9j/") ? "image/jpeg" : "image/png"};base64,${img}`)
      : undefined);
    const previews = message.previewImages || (message.previewImage ? [message.previewImage] : undefined);
    const el = renderMessage(message.role, message.content, previews, index, message.timestamp, genImages, message.generatedThumbnails, message.generatedVideos, message.videoMime, message.generatedAudio, message.audioMime, message.generatedVideoThumbnails);
    // Tag with the stable id so the jobs drawer can scroll a finished job into view.
    if (el && message.id) el.dataset.msgId = message.id;
    // Backfill posters for videos generated before thumbnails existed, so they
    // also get a still for export/archive and a poster on next render.
    if (message.generatedVideos?.length && !message.generatedVideoThumbnails?.length) {
      backfillVideoThumbnails(message);
    }
    // Insert thinking details block if present
    if (el && (message.thinking || message.thinkingFrames?.length)) {
      const markdownBody = el.querySelector(".markdownBody");
      const details = buildThinkingDetails(message.thinking, message.thinkingFrames);
      if (markdownBody && details) el.insertBefore(details, markdownBody);
    }
    // Insert tool-call details block (which tools the AI used, args + results)
    if (el && message.toolSteps && message.toolSteps.length) {
      const markdownBody = el.querySelector(".markdownBody");
      if (markdownBody) {
        const body = message.toolSteps
          .map((s) => `**🔧 ${getToolLabel(s.name, s.args)}**\n\n\`\`\`\n${(s.result || "").slice(0, 1500)}\n\`\`\``)
          .join("\n\n");
        const details = document.createElement("details");
        details.className = "thinking-details tool-details";
        details.innerHTML = `<summary>🔧 ${t("tools_used", { count: message.toolSteps.length })}</summary><div class="thinking-content markdownBody">${markdownToHtml(body)}</div>`;
        el.insertBefore(details, markdownBody);
      }
    }
    // Show how long this assistant reply took to generate, next to the timestamp
    if (el && message.role === "assistant" && message.genMs) {
      const tsEl = el.querySelector(".messageTimestamp");
      if (tsEl) {
        const genEl = document.createElement("span");
        genEl.className = "messageGenTime";
        genEl.textContent = `⏱ ${t("msg_genTime", { time: formatDuration(message.genMs) })}`;
        tsEl.appendChild(genEl);
      }
    }
    if (message.isCompactSummary && el) {
      el.classList.add("compactSummary");
    }
    if (message.folded && el) {
      el.classList.add("isFolded");
      const toggle = el.querySelector(".messageFoldToggle");
      if (toggle) {
        toggle.innerHTML = "&#x25BC;";
        const ts = message.timestamp ? formatTimestamp(message.timestamp) : "";
        const preview = (message.content || "").length > 80 ? message.content.substring(0, 80) + "..." : (message.content || "");
        toggle.title = ts ? `${ts}\n${preview}` : preview;
      }
    }
    if (message.isTranslating && el) {
      // Show translating state as a side-by-side translation bubble
      const row = document.createElement("div");
      row.className = "message-row";
      el.remove();
      el.classList.add("message-row-left");
      row.appendChild(el);
      const transEl = document.createElement("div");
      transEl.className = `message ${message.role} message-row-right translation-bubble`;
      const transBody = document.createElement("div");
      transBody.className = message.role === "assistant" ? "markdownBody" : "plainBody";
      transBody.innerHTML = `<span class="thinking-text">${t("msg_translating")}<span class="thinking-dots"><span>.</span><span>.</span><span>.</span><span>.</span><span>.</span><span>.</span></span></span>`;
      transEl.appendChild(transBody);
      row.appendChild(transEl);
      dom.messagesEl.appendChild(row);
      scrollChatToEnd();
    } else if (message.translation && el) {
      // Render side-by-side: original + translation
      const row = document.createElement("div");
      row.className = "message-row";
      el.remove();
      el.classList.add("message-row-left");
      row.appendChild(el);
      const transEl = document.createElement("div");
      transEl.className = `message ${message.role} message-row-right translation-bubble`;

      // Timestamp
      const transTs = document.createElement("div");
      transTs.className = "messageTimestamp";
      transTs.textContent = t("label_translation");
      transEl.appendChild(transTs);

      // Action buttons
      const transActions = document.createElement("div");
      transActions.className = "messageActions messageActionsLeft";

      const speakBtn = document.createElement("button");
      speakBtn.className = "messageAction speakMessage";
      speakBtn.type = "button";
      speakBtn.title = t("btn_speak");
      speakBtn.textContent = t("btn_speak");
      speakBtn.addEventListener("click", () => speakMessage(message.translation, speakBtn));
      transActions.appendChild(speakBtn);

      const copyBtn = document.createElement("button");
      copyBtn.className = "messageAction copyMessage";
      copyBtn.type = "button";
      copyBtn.title = t("btn_copy");
      copyBtn.setAttribute("aria-label", t("btn_copy"));
      copyBtn.textContent = "📋";
      copyBtn.addEventListener("click", () => copyMessageText(message.translation, copyBtn));
      transActions.appendChild(copyBtn);

      transEl.appendChild(transActions);

      const transActionsRight = document.createElement("div");
      transActionsRight.className = "messageActions messageActionsRight";

      const closeBtn = document.createElement("button");
      closeBtn.className = "messageAction deleteMessage";
      closeBtn.type = "button";
      closeBtn.title = t("tooltip_closeTranslation");
      closeBtn.textContent = "×";
      closeBtn.addEventListener("click", () => {
        const scrollY = dom.messagesEl.scrollTop;
        delete message.translation;
        saveChat();
        renderChat();
        dom.messagesEl.scrollTop = scrollY;
      });
      transActionsRight.appendChild(closeBtn);

      transEl.appendChild(transActionsRight);

      // Translation body
      const transBody = document.createElement("div");
      transBody.className = message.role === "assistant" ? "markdownBody" : "plainBody";
      transBody.innerHTML = markdownToHtml(message.translation);
      transEl.appendChild(transBody);

      row.appendChild(transEl);
      dom.messagesEl.appendChild(row);
      scrollChatToEnd();
    }
  });

  // Restore streaming bubble if there's an active stream for this tab
  if (state.streamingInfo && state.streamingInfo.tabId === state.activeTabId) {
    const bubble = document.createElement("div");
    bubble.className = "message assistant streaming-bubble";
    if (state.streamingInfo.phase === 'thinking') {
      bubble.classList.add("thinking");
      const body = document.createElement("div");
      body.className = "markdownBody";
      const label = state.streamingInfo.thinkingText || t("msg_thinking");
      body.innerHTML = `<span class="thinking-text">${label}<span class="thinking-dots"><span>.</span><span>.</span><span>.</span><span>.</span><span>.</span><span>.</span></span></span>`;
      bubble.appendChild(body);
    } else {
      // The response is now streaming content → the "send" succeeded, so drop the
      // delayed "Sending…" pill (idempotent; won't touch a "Stopping…" pill).
      sendSucceeded();
      const body = document.createElement("div");
      body.className = "markdownBody";
      body.innerHTML = markdownToHtml(state.streamingInfo.content);
      bubble.appendChild(body);
    }
    const idx = state.streamingInfo.insertIndex;
    const refNode = idx >= 0 ? dom.messagesEl.children[idx] : null;
    if (refNode) {
      dom.messagesEl.insertBefore(bubble, refNode);
    } else {
      dom.messagesEl.appendChild(bubble);
    }
    scrollChatToEnd();
  }

  // Restore an in-progress media-generation (image/video/audio) bubble so it
  // survives a tab switch — same approach as the streaming bubble above. Rebuilt
  // from state.pendingGen (label, enhanced prompt, images, progress, preview), so
  // the live update helpers re-find it by class and keep streaming into it.
  if (state.pendingGen && state.pendingGen.tabId === state.activeTabId) {
    // The image/video/audio gen bubble is showing → the request started, so drop
    // the delayed "Sending…" pill (leaves a "Stopping…" pill alone).
    sendSucceeded();
    const bubble = buildPendingGenBubble(state.pendingGen);
    const idx = state.pendingGen.insertIndex;
    const refNode = (idx != null && idx >= 0) ? dom.messagesEl.children[idx] : null;
    if (refNode) dom.messagesEl.insertBefore(bubble, refNode);
    else dom.messagesEl.appendChild(bubble);
    scrollChatToEnd();
  }

  highlightCodeBlocks();
  renderMermaidDiagrams();
  renderContextMeter();

  // Rebuilding innerHTML above resets scrollTop to 0; while a resend/edit is
  // regenerating in place, restore the pinned position so the view stays put.
  // Otherwise, if the user had scrolled up, keep their spot instead of snapping
  // to the bottom; only a pinned (at-bottom) view follows new content down.
  if (state.scrollPin != null) dom.messagesEl.scrollTop = state.scrollPin;
  else if (keepPosition) dom.messagesEl.scrollTop = prevScrollTop;
  refreshScrollState();
}