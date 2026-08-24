// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

// Chat rendering, message handling, and sending
import { dom, state, scrollChatToEnd, scrollChatToEndIfPinned, refreshScrollState, setScrollTop, applyVideoAudio, trackVideoAudio } from './state.js';
import { escapeHtml, formatTimestamp, formatDuration, mediaFilename, stripHeadingEmphasis,
         readFileAsDataUrl, makePreview, convertToJpeg, normalizeOrientation,
         mediaSrc, mediaBase64, isMediaRef, galleryUrl, galleryThumbUrl, galleryIdOf, galleryName,
         fileIntoGallery, sniffImageMime, cacheGalleryThumb } from './utils.js';
import { markdownToHtml, highlightCodeBlocks, renderMermaidDiagrams, addBlockCopyButtons } from './markdown.js';
import { renderRelationGraph } from './relation-graph.js';
import { setAvatarState, showExpression, detectExpression, isCloudModel, resetAvatarIdle } from './avatar.js';
import { speakMessage, stopSpeech } from './speech.js';
import { saveChat, saveTabs } from './settings.js';
import { getActiveTab, getTab, createTab, switchTab, renderTabs, renderAttachments } from './tabs.js';
import { parseNoteCommand, parseImagineCommands, videoThumbnail, extractKeyFrames, comfyModelSupportsRefMask } from './image-gen.js';
import { openMaskModal } from './mask-paint.js';
import { galleryRefsFor, deleteGalleryFiles, galleryRateWidget, galleryEntryCached, openGalleryAt } from './gallery.js';
import { parseVoiceCommand } from './voice-gen.js';
import { translateMessage } from './translate.js';
import { parseUrlCommand } from './url-fetch.js';
import { parseToolCommand, handleToolCommand } from './tool-cmd.js';
import { parseDocCommand, handleDocCommand } from './office-doc.js';
import { isTranscriptSection, transcriptMark, cardMark } from './library.js';
import { parseAskCommand, handleAskCommand, handleAutoAsk } from './ask.js';
import { kindIcon } from './mentions.js';
// -m/--model resolution lives with the model index it reads (ollama.js). Safe direction:
// ollama.js never reaches chat.js, so this adds no cycle.
import { resolveModelToken } from './ollama.js';
import { buildPendingGenBubble } from './pending-gen.js';
import { enqueueBgJob, releaseEnhancingJob, cancelBgJob, retryBgJob, resumeBgJob, openBgDrawer } from './bg-jobs.js';
import { chatFetch } from './server-queue.js';
import { t, getPrompt, getPromptLanguage } from './i18n.js';
import { getNumCtx, getLlmTimeout, recordContextUsage, renderContextMeter } from './context-meter.js';
import { addMemory, getMemoryPromptBlock } from './memory.js';
import { parseRemind, addReminder, describeReminder, markActivity } from './proactive.js';
import { activeToolSchemas, executeTool, getToolLabel } from './tools.js';
import { applyHighlights, captureAnchor, highlightsInSelection, registerHighlightHost, resolveHighlightHost } from './highlight.js';

// Streaming markdown re-render throttle. Ollama streams a chunk (often a single
// token/character) at a time; re-parsing the whole message and swapping the
// bubble's innerHTML on every chunk makes the bubble flicker. We coalesce those
// updates so the DOM is rebuilt at most once per STREAM_RENDER_MS, with a
// trailing render so the final content always lands. Only one reply streams into
// the active tab at a time, so a single module-level throttle is enough.
//
// 200ms ≈ 5 repaints/sec — a smooth token-by-token stream without the per-character
// flicker (each render re-parses the whole message + swaps innerHTML). Raising it
// (e.g. 1000ms) coalesces harder but feels chunky; lowering it (~120/60ms) is
// smoother still at the cost of more full re-renders on long replies.
const STREAM_RENDER_MS = 200;
let _streamRenderTimer = null;
let _streamRenderLast = 0;
let _streamRenderPending = null;
// Schedule a render. `fn` should read the latest content live (it may run later),
// so re-querying the element / reading the content variable inside fn is correct.
function scheduleStreamRender(fn) {
  _streamRenderPending = fn;
  const now = performance.now();
  const wait = STREAM_RENDER_MS - (now - _streamRenderLast);
  if (wait <= 0) {
    _streamRenderLast = now;
    _streamRenderPending = null;
    fn();
  } else if (!_streamRenderTimer) {
    _streamRenderTimer = setTimeout(() => {
      _streamRenderTimer = null;
      _streamRenderLast = performance.now();
      const pending = _streamRenderPending;
      _streamRenderPending = null;
      if (pending) pending();
    }, wait);
  }
}
// Cancel any pending trailing render. Callers paint the authoritative final
// content synchronously (settle render / renderChat) right after this, so we
// just drop the queued timer rather than firing it against a stale/detached node.
function cancelStreamRender() {
  if (_streamRenderTimer) { clearTimeout(_streamRenderTimer); _streamRenderTimer = null; }
  _streamRenderPending = null;
  _streamRenderLast = 0;
}

// Render streaming thinking text into its box and keep it pinned to the newest
// line. The box has a max-height (300px) so it becomes its own scroll container;
// replacing innerHTML resets scrollTop to the top, hiding freshly-streamed lines
// below the fold — so re-pin to the bottom after each render while it streams.
function renderThinkingInto(el, md) {
  if (!el) return;
  el.innerHTML = markdownToHtml(md);
  el.scrollTop = el.scrollHeight;
}

// "Sending/Receiving / Stopping" status pill (bottom-right, blue). Shown IMMEDIATELY on
// send/resend/edit (no delay) and animated via CSS (fade-in + pulse). The "sending"
// pill covers the gap between clicking send and the response starting — it's dropped
// the moment the response begins streaming (sendSucceeded), NOT when the reply finishes.
let _sendStatusTimer = null;
let _sendStatusKind = null; // 'sending' | 'stopping' | 'error' | null
let _sendStatusImageCount = 0; // images carried by the in-flight request (annotates the pill)
let _sendStatusTrimCount = 0; // older messages dropped from the in-flight request (context full)
// "Sending/Receiving…", upgraded to "…(incl. N images)" when the outgoing request
// carries images. Computed live so setSendingImageCount can refresh the visible pill.
function sendingStatusText() {
  let base = _sendStatusImageCount > 0
    ? t("status_sendingImages", { n: _sendStatusImageCount })
    : t("status_sending");
  // Context-full trimming is never silent: annotate how many older messages were dropped.
  if (_sendStatusTrimCount > 0) base += " " + t("status_sendingTrimmed", { n: _sendStatusTrimCount });
  // Cloud requests leave the machine — prefix the pill with ☁️ (mirrors the avatar badge).
  return isCloudModel() ? "☁️ " + base : base;
}
function scheduleStatus(kind, key) {
  clearTimeout(_sendStatusTimer);
  _sendStatusKind = kind;
  // Each fresh send resets the image annotation; the count is filled in once the
  // outgoing payload is built (setSendingImageCount), before the response returns.
  if (kind === 'sending') { _sendStatusImageCount = 0; _sendStatusTrimCount = 0; }
  const el = dom.sendStatus;
  if (!el) return;
  // Show the pill IMMEDIATELY (no 2s delay) so send/resend/edit get instant feedback;
  // the CSS fades+pulses it in. It's still dropped on first response chunk (fast case).
  // Starting a new request also clears any lingering red error pill.
  el.classList.remove('isError');
  el.textContent = kind === 'sending' ? sendingStatusText() : t(key);
  el.hidden = false;
}

// Total images in an outgoing Ollama messages array (`images` is Ollama's field name).
function countOutgoingImages(messages) {
  let n = 0;
  for (const m of (messages || [])) n += m.images?.length || 0;
  return n;
}

// Annotate the live "sending" pill with how many images the request carries. Called
// once the payload is built; a no-op if the pill is no longer the sending pill (e.g.
// the response already started, or the user pressed stop).
function setSendingImageCount(n) {
  _sendStatusImageCount = n || 0;
  if (_sendStatusKind === 'sending' && dom.sendStatus && !dom.sendStatus.hidden) {
    dom.sendStatus.textContent = sendingStatusText();
  }
}

// Annotate the live "sending" pill with how many older messages the context-budget
// trim dropped from this request (0 = full history sent). Same lifecycle as
// setSendingImageCount.
function setSendingTrimCount(n) {
  _sendStatusTrimCount = n || 0;
  if (_sendStatusKind === 'sending' && dom.sendStatus && !dom.sendStatus.hidden) {
    dom.sendStatus.textContent = sendingStatusText();
  }
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

// Turn the status pill RED and show the error reason (paired with "Sending/Receiving…").
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
// Pressing stop/pause: switch to "Stopping". If a pill is already visible
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

// WebKit/Safari (this app runs in WKWebView) sometimes fails to REJECT a pending
// `reader.read()` when the underlying fetch is aborted, so a streaming read loop can
// hang forever — the reply never stops and the UI stays stuck on "Stopping".
// Canceling the reader on abort makes the pending read() resolve `{done:true}`, which
// cleanly breaks the loop; `signal.aborted` still tells us it was a user stop. Call
// this right after getReader() on every streaming response.
function cancelReaderOnAbort(reader, signal) {
  if (!signal) return;
  const cancel = () => { try { reader.cancel(); } catch { /* already closed */ } };
  if (signal.aborted) { cancel(); return; }
  signal.addEventListener("abort", cancel, { once: true });
}

// Short label for a queued /imagine job (first prompt, or a generic fallback).
function bgImagineLabel(cmds, isVideo, isMesh, isMusic) {
  const txt = cmds.map((c) => c.prompt).filter(Boolean).join("; ").trim();
  if (txt) return txt.length > 48 ? txt.slice(0, 48) + "…" : txt;
  return isMusic ? t("bg_kindMusic") : isMesh ? t("bg_kindMesh") : isVideo ? t("bg_kindVideo") : t("bg_kindImage");
}

// Generation (image/video/audio) always runs through the background queue. This
// builds the image/video job from the parsed /imagine commands — shared by a fresh
// send and a resend so the model is snapshotted the same way in both.
// Gallery references → raw base64, for the paths that must ship bytes. Both helpers
// pass anything that is already inline straight through, so an old conversation costs
// nothing extra.
async function resolveMediaList(list) {
  if (!Array.isArray(list) || !list.some(isMediaRef)) return list;
  return await Promise.all(list.map((v) => mediaBase64(v)));
}

async function resolveSourceClip(clip) {
  if (!clip || !isMediaRef(clip.base64)) return clip;
  return { ...clip, base64: await mediaBase64(clip.base64) };
}

// buildMessages() is synchronous and stays that way — it is called from three places
// mid-send and reads nothing but the tab. So the references it copies into
// `message.images` are turned back into bytes HERE, one step before the request goes
// out. This is the whole reason storing references is affordable: the bytes exist on
// disk, and the only moment anything needs them in memory is the moment they are sent.
//
// One fetch per distinct id per request (same picture in two bubbles = one fetch), and
// the file route is cacheable, so a long conversation re-sent repeatedly mostly hits the
// browser cache. An image whose file has gone (deleted from the gallery) is dropped from
// the outgoing turn rather than sent as a URL string the model would read as garbage;
// the bubble still shows the broken slot, so the loss is visible rather than silent.
async function hydrateOutgoingImages(messages) {
  const cache = new Map();
  const load = (v) => {
    if (!cache.has(v)) cache.set(v, mediaBase64(v).catch(() => null));
    return cache.get(v);
  };
  for (const m of messages) {
    if (!Array.isArray(m.images) || !m.images.some(isMediaRef)) continue;
    const resolved = await Promise.all(m.images.map((v) => (isMediaRef(v) ? load(v) : v)));
    m.images = resolved.filter(Boolean);
    if (!m.images.length) delete m.images;
  }
  return messages;
}

async function enqueueImagineGen(validCmds, tabId, images, videos, mask, insertIndex = -1, audio = null, refMasks = null) {
  // Media re-used as INPUT (a generated clip fed back in as the source of an edit,
  // a generated image used as a reference) may be a gallery reference; the request
  // bodies downstream carry bytes, so pull them back here — the one boundary where
  // stored media turns into an outgoing payload.
  images = await resolveMediaList(images);
  videos = Array.isArray(videos) ? await Promise.all(videos.map(resolveSourceClip)) : await resolveSourceClip(videos);
  audio = await resolveSourceClip(audio);   // the InfiniteTalk speech track, same rule
  // "-m/--model <id>[@tier]" picks the model for THIS run, overriding the dropdown
  // WITHOUT touching it. Resolved here, before anything else reads the selection, so the
  // job kind below follows the chosen model — a video id typed while the dropdown holds
  // an image model has to produce a video job, not an image job that then runs a video
  // workflow. All /imagine lines in one send share one job, hence one model: disagreeing
  // -m values are refused rather than silently resolved to whichever came first.
  const tokens = [...new Set(validCmds.map((c) => c && c.modelToken).filter(Boolean))];
  let pickedComfy = "", pickedTier = "";
  if (tokens.length) {
    const fail = (msg) => {
      const tab = getTab(tabId);
      if (tab) {
        tab.messages.push({ role: "assistant", content: t("msg_commandError", { error: msg }), timestamp: Date.now() });
        saveChat();
        if (state.activeTabId === tabId) renderChat();
      }
    };
    if (tokens.length > 1) { fail(t("img_modelConflict", { list: tokens.join(", ") })); return; }
    const r = resolveModelToken(tokens[0]);
    if (r.error) {
      const list = (r.candidates || []).join(", ");
      // A catalogue of nothing but model-free tools explains the odd suggestions
      // ("closest: image-upscale") far better than a typo would — say so.
      const comfyHint = r.toolsOnly ? ` ${t("img_checkComfy")}` : "";
      fail(r.error === "unknown" ? t("img_modelUnknown", { val: tokens[0], list }) + comfyHint
        : r.error === "ambiguous" ? t("img_modelAmbiguous", { val: tokens[0], list })
        : r.error === "tier" ? t("img_modelTier", { val: r.id, tier: r.tier, list })
        : t("img_modelNoList"));
      return;
    }
    pickedComfy = r.value;
    pickedTier = r.tier;
  }
  // A ComfyUI video model (no Ollama image model) routes through generateVideo —
  // capture model + kind at submit time so a later dropdown change can't redirect it.
  // With -m in play the Ollama image model is bypassed outright: the flag names a
  // ComfyUI model, so this run is a ComfyUI run whatever the other dropdown says.
  const comfyModel = pickedComfy || (dom.comfyModelSelect ? dom.comfyModelSelect.value : "");
  const imageModel = pickedComfy ? "" : dom.imageModelSelect.value;
  const isVideo = !imageModel && comfyModel && state.comfyVideoModels.has(comfyModel);
  // A ComfyUI 3D model → a "mesh" job (routes through generateMesh; .glb/.spz result).
  const isMesh = !imageModel && comfyModel && state.comfyMeshModels && state.comfyMeshModels.has(comfyModel);
  // A ComfyUI audio-only model → a "music" job (routes through generateMusic; a song).
  const isMusic = !imageModel && comfyModel && state.comfyMusicModels && state.comfyMusicModels.has(comfyModel);
  const modelOverride = { imageModel, comfyModel };
  // "@tier" is a per-run ⚙ precision: stamp it on every command's options so it travels
  // with the request the same way the panel's value would.
  if (pickedTier) for (const c of validCmds) if (c && c.options) c.options.precision = pickedTier;
  // BATCH video-edit: one bg job per source clip (each runs the same workflow → its
  // own output). All jobs share the reference images + mask point; the Replace point
  // is pinned to the FIRST clip server-side. No source video (or an image model that
  // can't consume clips) → a single job.
  const clips = isVideo ? (Array.isArray(videos) ? videos.filter(Boolean) : (videos ? [videos] : [])) : [];
  const multi = clips.length > 1;
  const jobs = clips.length ? clips : [null];
  // --enhance is run UP-FRONT here (foreground — the tab is active right after Send, so
  // it can never hit the background-tab freeze that stalls queue advancement). Jobs are
  // created in the 'enhancing' state (bubble shows "enhancing prompt"); pumpLane skips them
  // until releaseEnhancingJob flips them to 'queued' with the rewritten prompt in tow.
  const needsEnhance = validCmds.some((c) => c.enhance && c.prompt && c.prompt.trim());
  const created = jobs.map((clip, i) => enqueueBgJob({
    tabId,
    kind: isMusic ? "music" : isMesh ? "mesh" : isVideo ? "video" : "image",
    // Tag the label with "(N/M)" so the jobs drawer distinguishes a batch's clips.
    label: bgImagineLabel(validCmds, isVideo, isMesh, isMusic) + (multi ? ` (${i + 1}/${clips.length})` : ""),
    // Keep batch order: each placeholder lands AFTER the previous one.
    insertIndex: insertIndex >= 0 ? insertIndex + i : -1,
    status: needsEnhance ? "enhancing" : "queued",
    payload: {
      parsedInput: validCmds,
      initImages: images || null,
      // Speech audio rides ON the source clip (InfiniteTalk needs both; a batch dubs
      // every clip with the same track) — no separate payload field to thread through.
      // With NO clip it rides a video-less wrapper: the audio-only models (Wan Dancer,
      // InfiniteTalk photo-speaks) take a photo + audio and generateVideo only reads
      // sourceVideo.base64 / .speechAudio, so the wrapper is safe downstream.
      initVideo: clip ? (audio ? { ...clip, speechAudio: audio } : clip) : (audio ? { speechAudio: audio } : null),
      maskB64: mask || null,
      // Per-image subject cutouts for the reference-driven models; baked into the
      // pictures at run time so the stored originals stay intact for a resend.
      refMasks: (refMasks && refMasks.some(Boolean)) ? refMasks : null,
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
  // Phantom subject-to-video: rephrase from the REFERENCE IMAGES (a vision model
  // describes each subject distinctly — see PHANTOM_ENHANCE_PROMPTS). Only for the
  // Phantom comfy model with images attached; every other model keeps the text-only
  // enhancer. The reference images ride along so the rephraser can actually see them.
  const isPhantom = /phantom/i.test(dom.comfyModelSelect?.value || "");
  const subjectRef = isPhantom && Array.isArray(images) && images.length > 0;
  try {
    for (const cmd of validCmds) {
      if (!(cmd.enhance && cmd.prompt && cmd.prompt.trim())) continue;
      try {
        const r = await fetch("/api/enhance-prompt", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: enhanceAbort.signal,
          body: JSON.stringify({ model: dom.modelSelect.value, prompt: cmd.prompt, language: getPromptLanguage(), edit: mode === "edit", video: mode === "video", subjectRef, images: subjectRef ? images : undefined }),
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
async function enqueueAnalyzeJob(parsed, tabId, image, video, anchorIndex, insertIndex = -1) {
  // Same boundary rule as enqueueImagineGen: a persisted job payload holds bytes, so
  // a re-analysed clip stored as a gallery reference is pulled back here.
  video = await resolveSourceClip(video);
  let payloadImage = null;
  if (image) {
    if (image.multi) payloadImage = { multi: await Promise.all(image.multi.map(async (im) => ({ base64: await mediaBase64(im.base64) }))) };
    else { payloadImage = { base64: await mediaBase64(image.base64) }; if (image.mask) payloadImage.mask = image.mask; }
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
  const KIND_ICON = { image: '🖼', video: '🎬', audio: '🔊', mesh: '🧊', analyze: '🔍', url: '🔗', doc: '📄', docfull: '📄', libimport: '📚' };
  const el = document.createElement('div');
  el.className = `message assistant bgPlaceholder bgPlaceholder-${message.status || 'queued'}`;
  el.dataset.msgId = message.id;
  const body = document.createElement('div');
  body.className = 'markdownBody';
  let statusTxt;
  switch (message.status) {
    case 'running': statusTxt = [message.stage, message.seg, message.elapsed].filter(Boolean).join(' · '); break;   // "finalizing… · segment N/M · 1:23"
    case 'paused': statusTxt = t('bg_statusPaused'); break;
    case 'enhancing': statusTxt = t('bg_statusEnhancing'); break;
    case 'done': statusTxt = t('bg_statusDone'); break;
    case 'error': statusTxt = t('bg_statusError'); break;
    case 'interrupted': statusTxt = t('bg_statusInterrupted'); break;
    case 'canceled': statusTxt = t('bg_statusCanceled'); break;
    default: statusTxt = message.queuePos ? t('bg_statusQueued', { n: message.queuePos }) : t('bg_statusQueuedPlain');
  }
  // The label is "generating… · <model> · <extra>". Keep the action text at normal
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
    // Indeterminate (a no-progress phase like the post-sampling encode) overrides a stale
    // numeric % so the bar animates instead of freezing at the last value.
    const hasNum = message.progress && message.progress.max && !message.indeterminate;
    const bar = document.createElement('div');
    bar.className = hasNum ? 'bgPhBar' : 'bgPhBar indeterminate';
    const fill = document.createElement('div');
    fill.className = 'bgPhBarFill';
    if (hasNum) fill.style.width = Math.min(100, Math.round(message.progress.value / message.progress.max * 100)) + '%';
    bar.appendChild(fill);
    body.appendChild(bar);
  }
  // Multi-image batch: completed images stream in one-by-one (bg sink addImage) so
  // the user sees each as it finishes instead of waiting for the whole batch.
  if (message.liveImages && message.liveImages.length) {
    const grid = document.createElement('div');
    grid.className = 'imageGrid bgPhImages';
    for (const src of message.liveImages) {
      const wrapper = document.createElement('div');
      wrapper.className = 'imageWrapper';
      const img = document.createElement('img');
      img.className = 'generatedImage';
      img.src = src;
      wrapper.appendChild(img);
      grid.appendChild(wrapper);
    }
    body.appendChild(grid);
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
  // /analyze: the frame map + extracted frames arrive the moment extraction ends
  // (sink.thinking → syncPlaceholder). Shown folded BELOW the status line (the
  // placeholder stacks as a column) so the "analyzing frame by frame (N/M)" progress stays on top.
  const think = buildThinkingDetails(message.thinkingMd, message.thinkingFrames);
  if (think) el.appendChild(think);
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
  if (message.contextImages && message.contextImages.length > imgIndex) {
    message.contextImages.splice(imgIndex, 1);
  }
  if (message.displayImages && message.displayImages.length > imgIndex) {
    message.displayImages.splice(imgIndex, 1);
  }
  // Filenames are parallel arrays — splice them too, or every later image inherits its
  // neighbour's name. For contextImages that is not merely cosmetic: imageNames becomes
  // the name→order map prepended to the outgoing prompt (see buildMessages).
  if (message.imageNames && message.imageNames.length > imgIndex) {
    message.imageNames.splice(imgIndex, 1);
  }
  if (message.generatedImageNames && message.generatedImageNames.length > imgIndex) {
    message.generatedImageNames.splice(imgIndex, 1);
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
// stages several clips). Per-clip metadata is stored as parallel arrays
// (videoNames/videoMimes/videoWidths/videoHeights); legacy scalar fields are folded
// into these on load (see migrateVideoFields), so only the arrays are read here.
function messageSourceVideos(m) {
  if (!m || !Array.isArray(m.generatedVideos) || !m.generatedVideos.length) return [];
  const names = Array.isArray(m.videoNames) ? m.videoNames : [];
  const mimes = Array.isArray(m.videoMimes) ? m.videoMimes : [];
  const widths = Array.isArray(m.videoWidths) ? m.videoWidths : [];
  const heights = Array.isArray(m.videoHeights) ? m.videoHeights : [];
  const thumbs = Array.isArray(m.generatedVideoThumbnails) ? m.generatedVideoThumbnails : [];
  return m.generatedVideos.map((b64, i) => ({
    base64: b64,
    mime: mimes[i] || "video/mp4",
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
// resend / batch dispatch.
function attachVideosToMessage(userMessage, videos) {
  if (!videos || !videos.length) return;
  // Reference once filed, bytes only as the fallback — same rule as the images above,
  // and the one that actually decides whether a tab record is 200KB or 200MB.
  userMessage.generatedVideos = videos.map(v => (v.galleryId ? galleryUrl(v.galleryId) : v.base64));
  userMessage.videoMimes = videos.map(v => v.mime || "video/mp4");
  // Same naming rule as the pictures: the gallery filename is the one name, so a clip's
  // download name matches what it is called everywhere else.
  userMessage.videoNames = videos.map(v => galleryName(v.galleryId) || v.name || null);
  if (videos.some(v => v.thumbnail || v.galleryId)) {
    userMessage.generatedVideoThumbnails = videos.map(
      (v) => (v.galleryId ? galleryThumbUrl(v.galleryId) : v.thumbnail || null));
  }
  if (videos.some(v => v.width != null)) userMessage.videoWidths = videos.map(v => v.width ?? null);
  if (videos.some(v => v.height != null)) userMessage.videoHeights = videos.map(v => v.height ?? null);
}

// Stamp a user bubble with the staged speech audio (InfiniteTalk dubbing). Reuses the
// /voice player fields (generatedAudio + audioMime → <audio> + download) so it renders
// and persists like generated speech; name/duration ride along for resend.
function attachAudioToMessage(userMessage, audio) {
  if (!audio || !audio.base64) return;
  userMessage.generatedAudio = audio.galleryId ? galleryUrl(audio.galleryId) : audio.base64;
  userMessage.audioMime = audio.mime || "audio/wav";
  if (audio.name) userMessage.audioName = audio.name;
  if (audio.duration) userMessage.audioDuration = audio.duration;
}

// Rebuild the staged-audio object from a user bubble (resend path).
function messageSourceAudio(m) {
  if (!m || m.role !== "user" || !m.generatedAudio) return null;
  return { base64: m.generatedAudio, mime: m.audioMime || "audio/wav", name: m.audioName || undefined, duration: m.audioDuration || 0 };
  // NB: base64 may be a gallery reference; enqueueImagineGen resolves it (resolveSourceAudio).
}

// Stamp a user bubble with a staged image upload (single staged object, or a
// { multi:[...] } selection). Parallel arrays carry the distinct roles:
//   contextImages     — the full-res picture, the ONLY images forwarded to the model
//   displayImages     — its 360px thumbnail, shown in the bubble only
//   imageNames        — the GALLERY filename of each picture (galleryName), which is
//                       the one name every surface uses: the download/caption name and
//                       the manifest injected into the model prompt (see buildMessages).
//                       Derived from the reference stored alongside it, so the two can
//                       never drift. Falls back to the upload's own filename for a
//                       picture the gallery never took (upload failed / offline), and to
//                       null for a pasted image with no name at all. A single-image
//                       inpaint mask rides along too.
// Wait — briefly — for the gallery ids of everything staged on this send. Paste-then-Enter
// can outrun the upload, and an attachment whose id has not landed yet gets stored as
// bytes instead of a reference. A few seconds of patience usually avoids that. Capped,
// because the alternative to losing the race is a stuck Send button, and inline bytes
// are a fallback every reader already handles.
//
// A video is worth waiting longer for than an image: it is the payload whose second copy
// actually hurts, and it is also the slowest to upload.
function settleGalleryIds(...staged) {
  const pending = [];
  for (const s of staged) {
    if (!s) continue;
    for (const item of (s.multi || (Array.isArray(s) ? s : [s]))) {
      if (item && item.galleryIdPromise) pending.push(item.galleryIdPromise);
    }
  }
  if (!pending.length) return Promise.resolve();
  return Promise.race([
    Promise.all(pending),
    new Promise((r) => setTimeout(r, 6000)),
  ]);
}

function attachUploadedImages(userMessage, image) {
  if (!image) return;
  const list = image.multi || [image];
  // Both slots hold a gallery reference once the file is on disk (main.js
  // stageIntoGallery), and the bytes only while it is not — a picture is stored once,
  // in the gallery, not a second time base64-inflated inside IndexedDB. There is no
  // parallel id array: the reference IS the id (galleryIdOf), which is what keeps the
  // two from ever disagreeing. Slots stay mixed-format per element, so a bubble whose
  // upload failed, or one written before any of this, is still perfectly valid.
  userMessage.contextImages = list.map((img) => (img.galleryId ? galleryUrl(img.galleryId) : img.base64));
  userMessage.displayImages = list.map((img) => (img.galleryId ? galleryThumbUrl(img.galleryId) : img.preview));
  // Name from the gallery id — the same value that just went into contextImages — so
  // the name and the picture are two views of one fact. The upload's own filename is
  // only a fallback for a picture the gallery refused.
  const displayNames = list.map((img) => galleryName(img.galleryId) || img.displayName || null);
  if (displayNames.some(Boolean)) userMessage.imageNames = displayNames;
  // Painted masks ride along as ONE per-image array, whatever the model. Which way a
  // region is read — an inpaint region on the first image, or a subject cutout — is a
  // question for the model that ends up running (see generateImage), not for the one
  // that happened to be selected while painting: /imagine -m can name another.
  const masks = list.map((img) => img.mask || undefined);
  if (masks.some(Boolean)) userMessage.imageMasks = masks;
}

// The four parallel image arrays, zipped into one slot per picture and back. Merging
// pictures from several bubbles means reordering all four in lockstep, and doing that
// four times over is exactly how one of them ends up off by one.
function messageImageSlots(m) {
  const ctx = Array.isArray(m?.contextImages) ? m.contextImages : [];
  return ctx.map((src, i) => ({
    src,
    // Never null: the thumbnail is what the bubble actually renders (<img src>), so a
    // slot with no preview falls back to the full picture rather than a broken image.
    display: m.displayImages?.[i] || src,
    name: m.imageNames?.[i] || null,
    mask: m.imageMasks?.[i] || undefined,
  }));
}

function setMessageImageSlots(m, slots) {
  if (!slots.length) return;
  m.contextImages = slots.map((s) => s.src);
  m.displayImages = slots.map((s) => s.display);
  const names = slots.map((s) => s.name || null);
  if (names.some(Boolean)) m.imageNames = names;
  const masks = slots.map((s) => s.mask || undefined);
  if (masks.some(Boolean)) m.imageMasks = masks;
}

// Disambiguate repeated filenames by suffixing -1, -2 (before the extension) so each
// image gets a UNIQUE label for the model; unique names are left untouched. Empty slots
// fall back to "image-N" (e.g. pasted images carry no filename).
//   ["a.png","a.png","b.png"] -> ["a-1.png","a-2.png","b.png"]
function dedupeImageNames(names) {
  const filled = names.map((n, i) => n || `image-${i + 1}`);
  const total = new Map();
  for (const n of filled) total.set(n, (total.get(n) || 0) + 1);
  const seen = new Map();
  return filled.map((n) => {
    if (total.get(n) <= 1) return n;
    const k = (seen.get(n) || 0) + 1; seen.set(n, k);
    const dot = n.lastIndexOf(".");
    return dot > 0 ? `${n.slice(0, dot)}-${k}${n.slice(dot)}` : `${n}-${k}`;
  });
}

// What KIND of guide a skill ships, and therefore how it must be framed. Guides differ
// in nature, not just wording: a strong-format spec is obeyed literally, prose teaches
// an approach, and a vendor's own rewriter system prompt is authoritative about the
// finished prompt but wrong about the output format (it expects one silent JSON-ish
// shot, not a conversation). Framing one as another is the failure that drops the
// dispatch line or invents sections the guide never had. Unknown/absent → strict.
const SKILL_WRAPPERS = {
  prose: "skillWrapperProse",
  rewriter: "skillWrapperRewriter",
};

// ---- /skill: load a model's official prompt-writing guide into the chat ----------
// Syntax:  /skill                     → list installed skills (no LLM call)
//          /skill 想法…               → guide for the ComfyUI dropdown's current model
//          /skill -m h3 想法…         → guide for an explicitly named model
// The -m matcher is /imagine's (resolveModelToken): same completion semantics, same
// refusal to guess on an ambiguous prefix.
function parseSkillCommand(content) {
  if (!/^\/skill(\s|$)/.test(content)) return null;
  let rest = content.replace(/^\/skill\s*/, "");
  const result = { modelToken: "", prompt: "" };
  // The short flag lives in the SAME regex as the long one — a separate check is how
  // "-m" once fell through into the prompt text (see /imagine's history).
  const mFlag = rest.match(/^(?:--model|-m)\s+(\S+)\s*/);
  if (mFlag) {
    result.modelToken = mFlag[1].toLowerCase();
    rest = rest.slice(mFlag[0].length);
  }
  result.prompt = rest.trim();
  return result;
}

// The canonical id of the model the ComfyUI dropdown currently points at, or "".
// comfyModelIndex rows carry { id, value }; the select's value is the file name.
function currentComfyModelId() {
  const val = dom.comfyModelSelect ? dom.comfyModelSelect.value : "";
  const entry = (state.comfyModelIndex || []).find((m) => m.value === val);
  return entry ? entry.id : "";
}

// The installed skills' own canonical ids — /skill's model vocabulary when the ComfyUI
// catalogue is empty (box off, IP moved). Writing a prompt is precisely the work that
// happens BEFORE the render machine needs to be reachable, so /skill must resolve from
// the manifest alone. Same discipline as resolveModelToken: ambiguity is refused with
// candidates, never guessed.
async function skillOwnModels() {
  try {
    const skills = ((await (await fetch("/api/skills")).json()).skills || []).filter((s) => s.installed);
    return skills.flatMap((s) => (s.ids && s.ids.length ? s.ids : s.models));
  } catch { return []; }
}

function matchSkillToken(token, ids) {
  if (ids.includes(token)) return { id: token };
  const hits = ids.filter((x) => x.startsWith(token) || x.includes(token));
  if (hits.length === 1) return { id: hits[0] };
  if (hits.length > 1) return { error: "ambiguous", candidates: hits };
  return { error: "unknown", candidates: ids.slice(0, 6) };
}

// Is this bubble a /skill guide? `skillGuide` is the marker, but conversations from
// before it existed have to keep working — prompt mode governs whether the composer
// holds on to its references, so failing to recognise an older guide silently breaks
// the render at the end of the workshop. Those bubbles are still identifiable: the
// header opens with 📖 in every locale.
const GUIDE_HEADER = "\u{1F4D6}";
function isGuideBubble(m) {
  if (!m || m.role !== "assistant") return false;
  return !!m.skillGuide || (typeof m.content === "string" && m.content.startsWith(GUIDE_HEADER));
}

// Guide bubbles still governing this conversation: injected by /skill and not folded
// (folding is the documented off switch — a folded guide is out of the model's context,
// so it governs nothing).
function activeGuides(tab) {
  return (tab.messages || []).filter((m) => isGuideBubble(m) && !m.folded);
}

// Every picture and clip the user has put into the CURRENT workshop, oldest first.
// A ▶ dispatch sends these along with whatever is staged in the composer: the whole
// conversation is one prompt-writing session, so a reference attached three turns ago
// while describing the shot is as much a part of the render as the one still in the
// composer — and staged attachments are session state (an in-memory Map, wiped by a
// reload) while the conversation and its ▶ button persist, so a prompt polished
// yesterday would otherwise dispatch with no reference at all and die at the GPU.
//
// Two bounds keep it from dragging in things that are not references:
//   · messages AFTER the active guide only — never some unrelated photo from earlier;
//   · UNFOLDED user bubbles only. Folded is the app's "this no longer counts" mark, and
//     it is what every ▶-dispatched command bubble already carries — without this, each
//     dispatch would re-collect the copies the previous one made.
function workshopMedia(tab) {
  const msgs = tab.messages || [];
  const out = { images: [], videos: [] };
  let start = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (isGuideBubble(msgs[i]) && !msgs[i].folded) { start = i; break; }
  }
  if (start < 0) return out;   // no prompt mode → nothing to gather
  for (let i = start + 1; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role !== "user" || m.folded) continue;
    out.images.push(...messageImageSlots(m));
    out.videos.push(...messageSourceVideos(m));
  }
  return out;
}

// Key a picture/clip by the slot the bubble stores — a gallery reference once the file
// is on disk, the bytes while it is not. Same string ⇒ same file, which is what makes
// the composer's copy of a picture and the bubble's copy collapse into one.
const mediaSlotKey = (v) => (v && v.galleryId ? galleryUrl(v.galleryId) : v && v.base64) || "";

function activeGuideModels(tab) {
  return [...new Set(activeGuides(tab).map((m) => m.skillGuide))];
}

// Fold every active guide and report what they covered. Called when a NEW guide is
// about to take over; folding rather than deleting keeps the history intact and lets
// the user undo it with one click on ▼.
function foldActiveGuides(tab) {
  const out = [];
  for (const m of activeGuides(tab)) {
    m.folded = true;
    out.push({ model: m.skillGuide, kind: m.skillKind || "" });
  }
  return out;
}

async function handleSkillCommand(cmd, tab, tabId, rawContent, image, video, at = -1) {
  // at ≥ 0 = resend: the command bubble already sits at `at` mid-conversation, so
  // nothing pushes a duplicate of it and every output splices in right after it
  // (the stale reply/guide at at+1 was already removed by resendChatMessage).
  const resend = at >= 0;
  let pos = at + 1;
  const insert = (msg) => {
    if (resend) tab.messages.splice(pos++, 0, msg);
    else tab.messages.push(msg);
  };
  const say = (text) => {
    insert({ role: "assistant", content: text, timestamp: Date.now() });
    saveChat();
    if (state.activeTabId === tabId) renderChat();
  };
  const pushUser = () => {
    if (resend) return;
    tab.messages.push({ role: "user", content: rawContent, timestamp: Date.now() });
  };

  // Bare "/skill" = the catalogue, not a conversation turn: which skills are on disk,
  // which models they map to, and whether the current dropdown pick has one. Doubles
  // as the post-fetch self-check, so it must never cost an LLM call. "-m" without an
  // idea is different — naming a model IS asking to load its guide (handled below).
  if (!cmd.prompt && !cmd.modelToken) {
    pushUser();
    let skillsList = [];
    try { skillsList = (await (await fetch("/api/skills")).json()).skills || []; } catch { /* server down → empty */ }
    const installed = skillsList.filter((s) => s.installed);
    if (!installed.length) { say(t("skill_noneInstalled")); return; }
    const curId = currentComfyModelId();
    const rows = installed.map((s) => {
      // One indented line per MODEL: the canonical id (what -m takes) plus its human
      // name from the server's label table. The manifest prefix that groups them
      // ("minimax-h3") is deliberately not shown — it is a matching rule, not a model,
      // and -m would reject it as ambiguous, so printing it invites a command that
      // cannot work. The ✓ marks the id the dropdown is actually on.
      const ids = s.ids && s.ids.length ? s.ids : s.models;
      const lines = ids.map((id) => {
        const label = (s.labels && s.labels[id]) || id;
        const named = label === id ? `\`${id}\`` : `\`${id}\` — ${label}`;
        return `  - ${named}${curId === id ? `  ✓ ${t("skill_currentModel")}` : ""}`;
      }).join("\n");
      return `- **${s.name}**\n${lines || `  - ${t("skill_listModels")}: —`}`;
    }).join("\n");
    say(`${t("skill_listHeader")}\n\n${rows}\n\n${t("skill_usage")}`);
    return;
  }

  // Which model is this guide for? -m wins; otherwise the dropdown — you are writing
  // a prompt for whatever you are about to render with. Every path here must work
  // with ComfyUI unreachable: the live catalogue is preferred for its labels and
  // tier knowledge, the skills' own id list is the always-available fallback.
  let modelId = "";
  if (cmd.modelToken) {
    const r = resolveModelToken(cmd.modelToken);
    if (!r.error) {
      modelId = r.id;
    } else {
      const fb = matchSkillToken(cmd.modelToken, await skillOwnModels());
      if (fb.id) {
        modelId = fb.id;
      } else {
        // Prefer the live catalogue's error when there IS a live catalogue (its
        // suggestions cover every model); otherwise speak from the skill list.
        const err = r.error !== "noModels" ? r : fb;
        const list = (err.candidates || []).join(", ");
        const comfyHint = err.toolsOnly ? ` ${t("img_checkComfy")}` : "";
        pushUser();
        say(t("msg_commandError", { error:
          err.error === "ambiguous" ? t("img_modelAmbiguous", { val: cmd.modelToken, list })
          : t("img_modelUnknown", { val: cmd.modelToken, list }) + comfyHint }));
        return;
      }
    }
  } else {
    modelId = currentComfyModelId();
    if (!modelId) {
      // Dropdown unknown (catalogue empty). One installed skill → it is the only
      // thing /skill could mean, so use it; several → ask for -m rather than guess.
      const own = await skillOwnModels();
      const distinct = [...new Set(own)];
      if (distinct.length === 1) modelId = distinct[0];
      else if (distinct.length > 1 && own.length) { pushUser(); say(t("skill_pickModel", { list: distinct.join(", ") })); return; }
      else { pushUser(); say(t("skill_noCurrentModel")); return; }
    }
  }

  // Fetch the guide. A model without a skill is an error with a map, never a silent
  // fallback to some other model's guide — the wrong format spec is worse than none.
  let composed;
  try {
    composed = await (await fetch("/api/skills/compose", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: modelId }),
    })).json();
  } catch (e) { pushUser(); say(t("msg_commandError", { error: e.message })); return; }
  if (!composed || composed.error || composed.none) {
    pushUser();
    const inst = (composed && composed.installed || []).join(", ");
    // Nothing was loaded, so nothing is folded — a typo or an unsupported model must
    // not silently destroy the guide the user is working under. But saying only "no
    // skill for wan2.2" reads as "you now have no guide", when in fact the previous
    // model's guide is still in context and still the loudest instruction there:
    // the next draft would come out in ITS format, carrying ITS dispatch line, and ▶
    // would render on the wrong model. Name what is still governing.
    const stillOn = activeGuideModels(tab);
    const stillNote = stillOn.length ? ` ${t("skill_guideStillActive", { list: stillOn.join(", ") })}` : "";
    say(composed && composed.error ? t("msg_commandError", { error: composed.error })
      : inst ? t("skill_noSkillForModel", { model: modelId, list: inst }) + stillNote
      : t("skill_noneInstalled") + stillNote);
    return;
  }

  // What is staged right now, told to the assistant in words: it cannot see the
  // composer, and for the base guide the staged pictures are what decide between
  // T2VA / I2VA / FL2VA — a decision the conversation should make knowingly.
  // Load-only (no idea yet) gets the "pending" wording: the pictures are staged but
  // will only ARRIVE with the user's next message — "look at them" now would invite
  // a vision hallucination about images the model has not been sent.
  const imgCount = image ? (image.multi ? image.multi.length : 1) : 0;
  const vidCount = video ? (video.multi ? video.multi.length : 1) : 0;
  // The model's trained duration window rides along when the manifest knows it —
  // the assistant must refuse a duration the render would silently clamp, because a
  // 15s clip cut from a prompt whose timing notation says 30.00s is mis-paced
  // end to end (server snapLength clamps without saying so).
  const durNote = composed.duration && composed.duration.maxSec
    ? " " + getPrompt("skillDurationNote", composed.duration.minSec, composed.duration.maxSec)
    : "";
  // Ref2VA ground rules ride only on the ref guide: the failure modes they guard
  // against (invented subject_definitions from an unseen picture, references mapped
  // to the wrong subjects, "I meant this as the first frame") only exist when the
  // prompt is ABOUT reference images.
  const refNote = composed.mode === "ref" ? " " + getPrompt("skillRefNote") : "";
  // Optional dispatch-line extras. Nx batch is universal (every model renders variants);
  // --size is manifest-gated per model because the valid tokens differ (H3 tops out at
  // its native 1376×768 — offering "1080p" there would render nothing better, just
  // slower). No sizes in the manifest → the note simply never mentions --size. Framed
  // as "only when the user asked" so the assistant doesn't decorate every dispatch line.
  const flagsNote = " " + getPrompt("skillFlagsNote", composed.sizes || []);
  // Per-skill overrides that CONTRADICT the guide (a vendor recommending a model this
  // app cannot run, an API this app never calls). They ride last so they are the final
  // word the assistant reads before the guide itself.
  const caveatNote = composed.caveats && composed.caveats.length
    ? " " + getPrompt("skillCaveatsNote", composed.caveats.map((c, i) => `(${i + 1}) ${c}`).join(" "))
    : "";
  // The staged note is mode-aware: under the ref guide the pictures are Ref2VA
  // reference subjects, and with nothing staged the right move is to ask for them —
  // the base wording ("assume T2VA", "image count decides I2VA/FL2VA") describes
  // modes that do not exist on the r2v weights.
  const isRef = composed.mode === "ref";
  const stagedNote = getPrompt(cmd.prompt ? "skillStaged" : "skillStagedPending", imgCount, vidCount, isRef) + durNote + refNote + flagsNote + caveatNote;

  // The guide bubble. Header states the off switch (fold = pause); the guide itself
  // sits inside <details> — collapsed ON SCREEN, but fully part of the outgoing
  // context. The message-level fold is deliberately NOT used for display: folded
  // bubbles are excluded from the model context entirely, which is exactly why
  // folding this bubble later works as the exit from prompt mode.
  // Retire whatever guide was governing before this one. Two guides at once is not a
  // richer context, it is a contradiction: each says "follow this format EXACTLY", so
  // the assistant has to pick one — and re-loading the SAME guide just pays its ~4-6k
  // tokens twice. Folding is the existing off switch, so this is precisely the action
  // the user would take by hand, and it is reversible: unfold to bring the old one back.
  const superseded = foldActiveGuides(tab);
  const supersededNote = superseded.length
    ? ` ${getPrompt("skillSupersededNote", [...new Set(superseded.map((g) => g.model))].join(", "))}` : "";
  // Switching between an IMAGE guide and a VIDEO one is a different kind of switch: it
  // is usually two parallel pieces of work, not one replacing the other, and folding
  // back and forth is where you eventually forget to fold and draft in the wrong
  // format. Suggest a separate tab — but only suggest: opening one is the user's move,
  // and there are real cases (a still, then that still driving a ref-to-video) where a
  // shared context is exactly right. Silent on unknown kinds (guides from before the
  // manifest declared one) rather than guessing.
  const kindClash = composed.kind && superseded.some((g) => g.kind && g.kind !== composed.kind);
  const newTabNote = kindClash ? ` ${getPrompt("skillNewTabHint")}` : "";
  const guideMsg = {
    role: "assistant",
    // The model this guide governs + the media kind it writes for, so a later /skill
    // (or a failed one) can find it and tell an image↔video switch from a plain one.
    // Guide bubbles from before these fields existed simply won't be folded automatically.
    skillGuide: modelId,
    skillKind: composed.kind || "",
    content: `${getPrompt("skillHeader", composed.name, composed.mode)}${supersededNote}${newTabNote}\n\n` +
      `${getPrompt(SKILL_WRAPPERS[composed.style] || "skillWrapper", modelId, stagedNote)}\n\n` +
      `<details>\n<summary>${getPrompt("skillGuideSummary")}</summary>\n\n${composed.text}\n\n</details>`,
    timestamp: Date.now(),
  };
  // Load-only: "/skill -m <model>" with no idea. The command line and the guide go
  // into the chat, the composer keeps whatever is staged, and NO reply is generated —
  // the guide's header is the confirmation, and the user speaks when ready. Their
  // next plain message carries the staged pictures and gets the first draft.
  if (!cmd.prompt) {
    pushUser();
    insert(guideMsg);
    saveChat();
    if (state.activeTabId === tabId) renderChat();
    if (image || video) {
      if (image) state.selectedImage = image;
      if (video) state.selectedVideo = video;
      renderAttachments();
    }
    return;
  }

  insert(guideMsg);

  // The user's idea, with the staged pictures attached so a vision model can see the
  // reference subjects it is writing about. On resend the idea already lives inside
  // the command bubble at `at` (a prompt-ful /skill line survives in history only
  // when it errored, or via edit-then-enter) — adding a second idea bubble would
  // send the same words twice, so only the guide goes in.
  if (!resend) {
    const userMessage = { role: "user", content: cmd.prompt, timestamp: Date.now() };
    await settleGalleryIds(image);
    attachUploadedImages(userMessage, image);
    tab.messages.push(userMessage);
  }
  saveChat();
  if (state.activeTabId === tabId) renderChat();

  // Give the attachments BACK to the composer: main.js's send handler cleared them,
  // but the /imagine this conversation is building toward needs them still staged —
  // consuming them here would force the user to re-attach everything at the end.
  if (image || video) {
    if (image) state.selectedImage = image;
    if (video) state.selectedVideo = video;
    renderAttachments();
  }

  // First draft, as a normal streamed reply — in place on resend (context truncated
  // to the freshly inserted guide, reply right after it), appended otherwise.
  if (resend) await regenerateReply(tabId, pos, pos - 1);
  else await regenerateReply(tabId, -1, -1);
}

function deleteMessageVideo(msgIndex, vidIndex) {
  const tab = getActiveTab();
  if (tab.locked) return;
  const message = tab.messages[msgIndex];
  if (!message) return;
  // Splice EVERY parallel array together or the columns drift: an uploaded clip
  // carries per-clip mime/name/width/height, so dropping only the video itself would
  // leave clip N wearing clip N-1's filename and dimensions (same idiom as
  // deleteMessageMesh below).
  for (const key of ["generatedVideos", "generatedVideoThumbnails", "videoMimes",
                     "videoNames", "videoWidths", "videoHeights"]) {
    if (message[key] && message[key].length > vidIndex) message[key].splice(vidIndex, 1);
  }
  saveChat();
  const scrollY = dom.messagesEl.scrollTop;
  renderChat();
  dom.messagesEl.scrollTop = scrollY;
}

function deleteMessageMesh(msgIndex, meshIndex) {
  const tab = getActiveTab();
  if (tab.locked) return;
  const message = tab.messages[msgIndex];
  if (!message) return;
  // Splice all three parallel arrays together, or the name/mime columns drift.
  for (const key of ["generatedMeshes", "meshMimes", "meshNames"]) {
    if (message[key] && message[key].length > meshIndex) message[key].splice(meshIndex, 1);
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
  // /ask on resend / edit-then-enter: regenerate the library answer in place (the old
  // answer at index+1 was already removed above). The user bubble stays at `index`.
  const askResend = parseAskCommand(message.content);
  if (askResend && askResend.auto && askResend.query) {
    // Auto mode regenerates in place — re-plans + re-searches (may differ run to run).
    handleAutoAsk(askResend.query, tab, { folders: askResend.folders, dims: askResend.dims }, index + 1);
    return;
  }
  if (askResend && !askResend.auto && (askResend.query ||
      ((askResend.docIds.length || askResend.archives.length) && !askResend.folders.length))) {
    // Question-less but doc/archive-scoped asks regenerate too (default summary).
    handleAskCommand(askResend.query, tab, { docIds: askResend.docIds, folders: askResend.folders, archives: askResend.archives, topK: askResend.topK, short: askResend.short }, index + 1);
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

  // Handle /tool command on resend — drop the old output block (tagged urlPart, same
  // contract as /url) and re-run the prefetch + reply in place.
  const toolResend = parseToolCommand(message.content);
  if (toolResend) {
    while (tab.messages[index + 1]?.urlPart && !tab.messages[index + 1].locked) {
      tab.messages.splice(index + 1, 1);
    }
    saveChat();
    renderChat();
    if (toolResend.error) {
      tab.messages.splice(index + 1, 0, { role: "assistant", content: toolResend.error, timestamp: Date.now() });
      saveChat();
      renderChat();
      return;
    }
    handleToolCommand(toolResend, tab, state.activeTabId, { pos: index + 1 }, true, message.content);
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
    const imageObj = message.contextImages?.length
      ? { multi: message.contextImages.map((b) => ({ base64: b })) }
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

  // /skill on resend — re-run the command in place instead of leaking it to the LLM
  // as plain text. Catalogue and load-only re-inject (a guide bubble's content is
  // frozen at /skill time, so 🔄 on the command line is how a stale guide gets the
  // current wrapper); a prompt-ful line drafts right here (it survives in history
  // only when it errored, or via edit-then-enter).
  const skillResend = parseSkillCommand(message.content);
  if (skillResend) {
    handleSkillCommand(skillResend, tab, state.activeTabId, message.content, null, null, index);
    return;
  }

  const imagineCmds = parseImagineCommands(message.content);
  if (imagineCmds) {
    const firstError = imagineCmds.find((cmd) => cmd && cmd.error);
    const srcVids = messageSourceVideos(message);
    const hasAttach = !!((message.contextImages && message.contextImages.length) || srcVids.length);
    const validCmds = imagineCmds.filter((cmd) => cmd && !cmd.error && (cmd.prompt || hasAttach));
    if (firstError) {
      tab.messages.splice(index + 1, 0, { role: "assistant", content: t("msg_commandError", { error: firstError.error }), timestamp: Date.now() });
      saveChat();
      renderChat();
    } else if (validCmds.length === 0) {
      tab.messages.splice(index + 1, 0, { role: "assistant", content: t("msg_commandError", { error: t("chat_needPromptOrMedia") }), timestamp: Date.now() });
      saveChat();
      renderChat();
    } else {
      // Resend of image/video gen also goes to the background queue (reached only
      // when the queue is empty — a non-empty queue is blocked above with a dialog).
      // The placeholder lands right after the resent user bubble (index + 1).
      enqueueImagineGen(validCmds, state.activeTabId, message.contextImages || null, srcVids, message.mask || null, index + 1, messageSourceAudio(message), message.imageMasks || null);
    }
  } else {
    // Truncate context to the resent bubble: only messages up to and including
    // index are sent to the AI, and the new reply is inserted right after it.
    dispatchReply(state.activeTabId, index + 1, index);
  }
}

// The bubble's rendered HTML, cleaned of app chrome, for the clipboard's rich flavour.
// Rendering it from the DOM rather than re-running the markdown pipeline is deliberate:
// what gets copied is then exactly what is on screen, KaTeX formulas and mermaid SVGs
// included. Returns "" when there is nothing to copy — the caller then goes plain-text.
function bubbleRichHtml(bubbleEl) {
  if (!bubbleEl) return "";
  // `:scope >` on purpose: a collapsed <details> "thinking" block is a separate child,
  // and the copy button copies the ANSWER, not the reasoning that led to it.
  const body = bubbleEl.querySelector(":scope > .markdownBody, :scope > .plainBody");
  if (!body) return "";
  const clone = body.cloneNode(true);
  // Ours, not the message's: the floating 📋 on code/svg/mermaid blocks (markdown.js).
  clone.querySelectorAll("button, .mdCopyBtn").forEach((el) => el.remove());
  // KaTeX emits every formula TWICE — MathML for screen readers plus the visual HTML —
  // and hides the MathML with its stylesheet. The stylesheet doesn't travel with the
  // clipboard, so leaving it in pastes every formula doubled.
  clone.querySelectorAll(".katex-mathml").forEach((el) => el.remove());
  return clone.innerHTML.trim();
}

// Copy a message bubble to the clipboard. Two flavours go on at once: text/html so a
// rich-text target (Word, Mail, Notes, Docs) keeps the headings, tables, lists and
// emphasis, and text/plain — the markdown source — so a code editor or terminal still
// receives something sensible. Falls back to a hidden contenteditable + execCommand
// where the async Clipboard API is unavailable (an insecure origin: hey-koko is often
// opened over a plain-http LAN address), which keeps the formatting there too.
async function copyMessageText(text, btn, bubbleEl) {
  const value = typeof text === "string" ? text : "";
  const html = bubbleRichHtml(bubbleEl);
  const legacyCopy = () => {
    const holder = document.createElement("div");
    if (html) holder.innerHTML = html; else holder.textContent = value;
    holder.contentEditable = "true";
    holder.style.position = "fixed";
    holder.style.left = "-9999px";
    holder.style.opacity = "0";
    document.body.appendChild(holder);
    const sel = window.getSelection();
    const saved = sel && sel.rangeCount ? [...Array(sel.rangeCount).keys()].map((i) => sel.getRangeAt(i)) : [];
    const range = document.createRange();
    range.selectNodeContents(holder);
    sel?.removeAllRanges();
    sel?.addRange(range);
    // execCommand copies the SELECTION, which is what carries the formatting along.
    document.execCommand("copy");
    sel?.removeAllRanges();
    for (const r of saved) sel?.addRange(r);   // put the user's own selection back
    document.body.removeChild(holder);
  };
  try {
    if (navigator.clipboard && window.isSecureContext && html && typeof ClipboardItem === "function") {
      await navigator.clipboard.write([new ClipboardItem({
        "text/html": new Blob([html], { type: "text/html" }),
        "text/plain": new Blob([value], { type: "text/plain" }),
      })]);
    } else if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(value);   // nothing rendered to copy
    } else {
      legacyCopy();
    }
  } catch {
    // A refused rich write (unsupported flavour, permissions) must still copy something.
    try { legacyCopy(); } catch { return; }
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
        timeout: getLlmTimeout(),
      }),
    });

    if (!response.ok) {
      const data = await response.json();
      throw new Error(cleanErrorMessage(data.error) || t("chat_requestFailed"));
    }

    const reader = response.body.getReader();
    cancelReaderOnAbort(reader, abortController.signal);   // WebKit: unblock a hung read() on Stop
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
        scheduleStreamRender(() => {
          const t = dom.messagesEl.querySelector('.streaming-bubble > .markdownBody');
          if (t) { t.innerHTML = markdownToHtml(content); scrollChatToEndIfPinned(); }
        });
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

    cancelStreamRender();
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
    cancelStreamRender();
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

// Read one of the optional LLM caps (⚙ panel). Returns null for "no limit" — the
// default — which is what an empty field, whitespace or a bogus value all mean.
// 0 is a real value (send no images at all), so it must survive the check.
function llmCap(input) {
  const raw = (input?.value ?? "").trim();
  if (!raw) return null;
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n >= 0 ? n : null;
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
  // "Send time info" toggle (⚙ More options; default on) gates BOTH the absolute clock
  // (A) and the reply-gap note (B).
  const sendTime = dom.sendTimeToggle?.checked !== false;
  // (A) Give the model an absolute clock so it can be time-aware (e.g. "this late?").
  const timeBlock = sendTime ? `\n\n${getPrompt("currentTimeContext", new Date())}` : "";
  const system = `${dom.persona.value}

${nameInstruction}${getPrompt("personaSuffix")}${memoryBlock}${timeBlock}`;

  // Find the last compact boundary - only include messages after it
  let startIndex = 0;
  for (let i = sourceMessages.length - 1; i >= 0; i--) {
    if (sourceMessages[i].isCompactSummary) {
      startIndex = i;
      break;
    }
  }
  const relevantMessages = sourceMessages.slice(startIndex);

  // (B) Time-away awareness: when a user turn lands >4h after the previous included
  // turn, prepend a "the user replied N hours/days/weeks later" note (ephemeral —
  // outgoing payload only). lastTs tracks the previous included message's timestamp.
  const GAP_MS = 4 * 60 * 60 * 1000;
  let lastTs = null;

  // (C) Optional user caps from the LLM ⚙ panel. Both default to empty = no limit.
  // The image budget is resolved HERE, before the mapping loop, rather than by
  // stripping images afterwards: the loop bakes an image name→order list into the
  // outgoing text, and that list has to describe exactly the images that survive.
  // Budget is spent newest-first, since the images nearest the question matter most.
  // (C1) Duplicate pictures. A reference image legitimately rides many bubbles — the
  // prompt workshop re-attaches the same file to every iteration turn — and at ~768
  // tokens a copy, six rounds with two references waste ~9k tokens re-sending pictures
  // the model already has. Identity is the gallery id, which the slot IS (galleryIdOf),
  // so this is exact rather than a guess; slots still holding raw bytes have no stable
  // identity and are never deduped (dropping a picture we cannot PROVE is a duplicate
  // is the one unacceptable outcome). The newest occurrence is kept — nearest the question.
  //
  // Granularity is the whole BUBBLE, all-or-nothing, and that is the load-bearing part:
  // a prompt refers to its references by position ("subject_definitions … image 2"), and
  // the renderer feeds the command bubble's list in stored order. If dedup could strip
  // image 1 and keep image 2, the model would see a one-image array whose ordinals no
  // longer match what ComfyUI will be handed — mapping the wrong subject, silently, for
  // twenty GPU-minutes. So a bubble either sends its complete ordered set or none of it,
  // and a bubble that sends none still states that set BY NAME in text, so "the first
  // picture" keeps resolving.
  const maxImages = llmCap(dom.llmMaxImages);
  const dupTurn = new Set();       // bubbles whose whole image set is carried by a later one
  {
    const seenIds = new Set();
    for (let i = relevantMessages.length - 1; i >= 0; i--) {
      const imgs = relevantMessages[i].contextImages;
      if (!imgs?.length) continue;
      const ids = imgs.map(galleryIdOf);
      if (ids.every((id) => id && seenIds.has(id))) dupTurn.add(relevantMessages[i]);
      else for (const id of ids) if (id) seenIds.add(id);
    }
  }
  // (C2) The ⚙ image cap, charged newest-first over the bubbles that still carry images.
  // Unchanged semantics: a partially funded bubble keeps its LAST images.
  const imageBudget = new Map();   // message object → how many of its images to send
  if (maxImages != null) {
    let left = maxImages;
    for (let i = relevantMessages.length - 1; i >= 0; i--) {
      const msg = relevantMessages[i];
      const n = msg.contextImages?.length || 0;
      if (!n || dupTurn.has(msg)) continue;
      const take = Math.min(n, left);
      imageBudget.set(msg, take);
      left -= take;
    }
  }
  // The images this bubble may send: its whole set, the newest `take` of them, or null.
  const sendableImages = (msg) => {
    const imgs = msg.contextImages;
    if (!imgs?.length || dupTurn.has(msg)) return null;
    if (maxImages == null) return imgs;
    const take = imageBudget.get(msg) || 0;
    return take > 0 ? imgs.slice(-take) : null;
  };
  // The ordered "1. name  2. name" manifest for a bubble's images. `count` says how many
  // of them the model is actually being handed, so names stay aligned with the array it
  // receives (the cap takes a tail slice); pass the full length for a deduped bubble,
  // where the list is the whole point and no array accompanies it.
  const imageManifest = (msg, count) => {
    if (!msg.imageNames?.some(Boolean)) return "";
    const names = msg.imageNames.slice(0, msg.contextImages.length).slice(-count);
    const labeled = dedupeImageNames(names);
    return labeled.map((nm, i) => `${i + 1}. ${nm}`).join("  ");
  };

  const mapped = [];
  let summaryMappedIdx = -1;
  for (const msg of relevantMessages) {
    // Folded bubbles are excluded from the model context entirely — this runs
    // before the compact-summary/file-preview branches so folding ANY bubble
    // (including those) keeps it out of what's sent. The fold button's tooltip
    // tells the user this.
    if (msg.folded) continue;
    // Background-job placeholders carry no content — never send them to the model.
    if (msg.bgPlaceholder) continue;
    // Include compact summary as system context
    if (msg.isCompactSummary) {
      summaryMappedIdx = mapped.length;
      mapped.push({ role: "system", content: `${getPrompt("summaryContext")}${msg.content}` });
      if (msg.timestamp) lastTs = msg.timestamp;
      continue;
    }
    // Skip the /compact command itself
    if (msg.role === "user" && /^\/compact\s*$/.test(msg.content)) continue;
    // Skip /memory command (the fact is already injected via long-term memory)
    if (msg.role === "user" && /^\/memory(\s|$)/.test(msg.content)) continue;
    // Skip /remind command line
    if (msg.role === "user" && /^\/remind(\s|$)/.test(msg.content)) continue;
    // Skip /search command line (results are injected as the assistant bubble that follows)
    if (msg.role === "user" && /^\/search(\s|$)/.test(msg.content)) continue;
    // Skip /analyze command line (its analysis is the assistant bubble that follows)
    if (msg.role === "user" && /^\/analyze(\s|$)/.test(msg.content)) continue;
    // File preview bubbles: send to LLM as user-role (contains the parsed file content)
    if (msg.isFilePreview) {
      const message = { role: "user", content: msg.content };
      // `images` here is Ollama's chat-API field name — keep it; the source is our
      // stored contextImages.
      const imgs = sendableImages(msg);
      if (imgs) message.images = imgs;
      mapped.push(message);
      if (msg.timestamp) lastTs = msg.timestamp;
      continue;
    }
    // Images only survive on a USER turn: both cloud backends read `images` solely in
    // their user branch (toAnthropicMessages / toOpenAIMessages) and would silently drop
    // them otherwise, and the Anthropic/OpenAI APIs reject image blocks on an assistant
    // turn anyway. So an assistant bubble that carries contextImages — e.g. a /tool
    // context bubble holding a clipboard image or a screenshot — is forwarded as a user
    // turn, exactly like the file-preview branch above. Display role is unaffected.
    // Note this keys off the STORED images, not the capped ones: a bubble whose images
    // were all cut is plain text now, so it should go back to being an assistant turn.
    const msgImages = sendableImages(msg);
    const sendRole = (msg.role === "assistant" && msgImages) ? "user" : msg.role;
    const message = { role: sendRole, content: msg.content };
    // Ephemeral context prefixes (prepended to the OUTGOING content only, never stored):
    // the time-away note first, then the attached-image name map.
    let prefix = "";
    if (sendTime && msg.role === "user" && lastTs && msg.timestamp && (msg.timestamp - lastTs) > GAP_MS) {
      prefix += `${getPrompt("timeGapContext", (msg.timestamp - lastTs) / 3600000)}\n\n`;
    }
    // A bubble whose whole picture set is the SAME files a later turn carries: name that
    // set, in its own order, instead of letting a turn that reads "use the character in
    // this picture" arrive with nothing attached and no way to resolve "the first one".
    // Costs a line of text; saves ~768 tokens per picture not re-sent.
    if (dupTurn.has(msg)) {
      const n = msg.contextImages.length;
      prefix += `${getPrompt("imageDedupContext", n, imageManifest(msg, n))}\n\n`;
    }
    if (msgImages) {
      message.images = msgImages;
      // When the upload kept original filenames, prepend a name→order list so the user
      // can refer to an image by filename ("describe chart.png") or position. The model
      // receives images as a bare ordered array (no labels), so this mapping lives in
      // the text — and it is what keeps "image 2" in a draft pointing at the same file
      // ComfyUI will receive second.
      const list = imageManifest(msg, msgImages.length);
      if (list) prefix += `${getPrompt("imageNamesContext", msgImages.length, list)}\n\n`;
    }
    if (prefix) message.content = `${prefix}${msg.content || ""}`.trimEnd();
    mapped.push(message);
    if (msg.timestamp) lastTs = msg.timestamp;
  }

  // Fit the history into the configured context window (num_ctx) instead of a fixed
  // message cap: estimate tokens, and only when the total exceeds the budget drop the
  // OLDEST messages until it fits. The compact summary (if any) is pinned, and the
  // newest message is always kept. Estimates are heuristic (CJK ≈ 1 token/char,
  // other text ≈ 4 chars/token, image ≈ 768 tokens) — Ollama does the real count;
  // this only decides which messages to include. What got dropped is surfaced on the
  // tab (context meter + sending pill) so trimming is never silent.
  const IMAGE_TOKENS = 768;
  const estText = (s) => {
    s = s || "";
    const cjk = (s.match(/[\u2E80-\uFFFD]/g) || []).length;
    return Math.ceil(cjk + (s.length - cjk) / 4);
  };
  const estMsg = (m) => estText(m.content) + (m.images?.length || 0) * IMAGE_TOKENS + 8;
  const numCtx = getNumCtx();
  const budget = numCtx - Math.max(1024, numCtx >> 3); // reserve room for the reply
  let total = estText(system) + mapped.reduce((sum, m) => sum + estMsg(m), 0);
  const dropFrom = summaryMappedIdx === 0 ? 1 : 0; // pin the compact summary
  let dropTo = dropFrom;
  while (total > budget && dropTo < mapped.length - 1) {
    total -= estMsg(mapped[dropTo]);
    dropTo++;
  }
  let omitted = dropTo - dropFrom;
  let kept = dropFrom > 0 ? [mapped[0], ...mapped.slice(dropTo)] : mapped.slice(dropTo);

  // User cap on how much conversation goes out (LLM ⚙; empty = no limit). Applied on
  // top of the num_ctx fit, keeping the newest turns and still pinning the compact
  // summary. Anything it drops is added to the omitted count so the context meter and
  // the sending pill keep telling the truth about what was left out.
  const maxMessages = llmCap(dom.llmMaxMessages);
  if (maxMessages != null && maxMessages > 0) {
    const pinned = dropFrom > 0 ? 1 : 0;          // the compact summary, if present
    const body = kept.slice(pinned);
    if (body.length > maxMessages) {
      omitted += body.length - maxMessages;
      kept = [...kept.slice(0, pinned), ...body.slice(-maxMessages)];
    }
  }

  tab.ctxOmittedMsgs = omitted;
  tab.ctxSentMsgs = kept.length;
  if (tab === getActiveTab()) renderContextMeter();

  return [{ role: "system", content: system }, ...kept];
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

  // Build limited message context. `/0` and `/1` restrict the CONVERSATION history,
  // not the attachments — so images ride along exactly as they do on a normal send.
  // `images` is Ollama's chat-API field name; the cloud backends read the same field
  // (user turns only, hence the role rewrite for an image-bearing assistant bubble,
  // mirroring buildMessages).
  const system = `${dom.persona.value}\n\n${getPrompt("personaSuffix")}`;
  const messages = [{ role: "system", content: system }];
  if (mode === "1") {
    // Include the previous message bubble (the one before the /1 command)
    const prevIdx = insertIndex - 2; // -1 is the /1 user msg, -2 is the one before
    if (prevIdx >= 0 && tab.messages[prevIdx]) {
      const prev = tab.messages[prevIdx];
      const prevImgs = prev.contextImages?.length ? prev.contextImages : null;
      const prevMsg = { role: prevImgs && prev.role === "assistant" ? "user" : prev.role, content: prev.content };
      if (prevImgs) prevMsg.images = prevImgs;
      messages.push(prevMsg);
    }
  }
  // The /0 or /1 bubble itself is the one just inserted before insertIndex.
  const selfMsg = tab.messages[insertIndex - 1];
  const selfImgs = selfMsg?.contextImages?.length ? selfMsg.contextImages : null;
  const userMsg = { role: "user", content: userContent };
  if (selfImgs) userMsg.images = selfImgs;
  messages.push(userMsg);

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
      timeout: getLlmTimeout(),
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
      throw new Error(cleanErrorMessage(data.error) || t("chat_requestFailed"));
    }

    const reader = response.body.getReader();
    cancelReaderOnAbort(reader, abortController.signal);   // WebKit: unblock a hung read() on Stop
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
          setAvatarState("talking");   // /0,/1 isolated replies are always foreground (no bg job)
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
          scheduleStreamRender(() => {
            const thinkEl = dom.messagesEl.querySelector('.streaming-bubble .thinking-content');
            if (thinkEl) { renderThinkingInto(thinkEl, thinkingContent); scrollChatToEndIfPinned(); }
          });
        }
        return;
      }

      if (chunk) {
        if (!thinkingDone && thinkingContent && showThinking) {
          thinkingDone = true;
          cancelStreamRender();
          if (state.activeTabId === tabId) {
            const thinkEl = dom.messagesEl.querySelector('.streaming-bubble .thinking-content');
            if (thinkEl) thinkEl.innerHTML = markdownToHtml(thinkingContent);
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
          setAvatarState("talking");   // /0,/1 isolated replies are always foreground (no bg job)
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
          scheduleStreamRender(() => {
            const md = dom.messagesEl.querySelector('.streaming-bubble > .markdownBody');
            if (md) { md.innerHTML = markdownToHtml(content); scrollChatToEndIfPinned(); }
          });
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

    cancelStreamRender();
    content = content.trim() || t("chat_zonedOut");
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
    cancelStreamRender();
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
    const messages = await hydrateOutgoingImages(buildMessages(tabId, contextEndIndex));
    // Surface how many images this request carries on the "sending" pill (foreground only —
    // bg jobs run headless without it).
    if (!bg) {
      setSendingImageCount(countOutgoingImages(messages));
      setSendingTrimCount((getTab(tabId) || getActiveTab())?.ctxOmittedMsgs || 0);
    }
    const fetchBody = {
      model: dom.modelSelect.value,
      messages,
      options: { temperature: 0.85, top_p: 0.9, num_ctx: getNumCtx() },
      timeout: getLlmTimeout(),
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
      throw new Error(cleanErrorMessage(data.error) || t("chat_requestFailed"));
    }

    const reader = response.body.getReader();
    cancelReaderOnAbort(reader, abortController.signal);   // WebKit: unblock a hung read() on Stop
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
          setAvatarState("talking");   // /0,/1 isolated replies are always foreground (no bg job)
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
          scheduleStreamRender(() => {
            const thinkEl = dom.messagesEl.querySelector('.streaming-bubble .thinking-content');
            if (thinkEl) { renderThinkingInto(thinkEl, thinkingContent); scrollChatToEndIfPinned(); }
          });
        }
        return;
      }

      // Handle content tokens
      if (chunk) {
        if (!thinkingDone && thinkingContent && showThinking) {
          thinkingDone = true;
          cancelStreamRender();
          if (state.activeTabId === tabId) {
            const thinkEl = dom.messagesEl.querySelector('.streaming-bubble .thinking-content');
            if (thinkEl) thinkEl.innerHTML = markdownToHtml(thinkingContent);
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
          setAvatarState("talking");   // /0,/1 isolated replies are always foreground (no bg job)
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
          scheduleStreamRender(() => {
            const md = dom.messagesEl.querySelector('.streaming-bubble > .markdownBody');
            if (md) { md.innerHTML = markdownToHtml(content); scrollChatToEndIfPinned(); }
          });
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

    cancelStreamRender();
    content = content.trim() || t("chat_zonedOut");
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
    cancelStreamRender();
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
        bubble.textContent = `${error.message}\n\n${t("chat_ollamaHint")}`;
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
    const messages = await hydrateOutgoingImages(
      [...buildMessages(tabId, contextEndIndex), { role: "user", content: instruction }]);
    setSendingImageCount(countOutgoingImages(messages));
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: abortController.signal,
      body: JSON.stringify({
        model: dom.modelSelect.value,
        messages,
        options: { temperature: 0.85, top_p: 0.9, num_ctx: getNumCtx() },
        timeout: getLlmTimeout(),
      }),
    });
    if (!response.ok) {
      const d = await response.json();
      throw new Error(cleanErrorMessage(d.error) || t("chat_requestFailed"));
    }

    const reader = response.body.getReader();
    cancelReaderOnAbort(reader, abortController.signal);   // WebKit: unblock a hung read() on Stop
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
        scheduleStreamRender(() => {
          const md = dom.messagesEl.querySelector('.streaming-bubble > .markdownBody');
          if (md) { md.innerHTML = markdownToHtml(content); scrollChatToEndIfPinned(); }
        });
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

    cancelStreamRender();
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
    cancelStreamRender();
    state.streamingInfo = null;
    const bubble = dom.messagesEl.querySelector('.streaming-bubble');
    if (bubble) bubble.remove();
  } finally {
    state.streamingInfo = null;
    setGenerating(false);
    state.currentAbortController = null;
    resetAvatarIdle();   // leaves a just-set expression alone; it reverts itself
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

// Run one tool but never let a hung tool (slow fetch, etc.) stall the whole loop.
function runToolWithTimeout(name, args, ms = 25000) {
  return Promise.race([
    Promise.resolve(executeTool(name, args)),
    new Promise((resolve) => setTimeout(() => resolve(`Tool "${name}" timed out after ${Math.round(ms / 1000)}s.`), ms)),
  ]).catch((e) => `Tool "${name}" failed: ${e && e.message ? e.message : e}`);
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
    // Reset to a clean single-body layout each call: a prior STREAMING turn may
    // have restructured pending into thinking-details + content, and tool-status
    // updates must land in the main bubble, not inside a collapsed thinking block.
    pending.className = "message assistant thinking";
    pending.innerHTML =
      `<div class="markdownBody"><span class="thinking-text">${text}<span class="thinking-dots"><span>.</span><span>.</span><span>.</span><span>.</span><span>.</span><span>.</span></span></span></div>`;
    scrollChatToEnd();
  };
  setPending(t("msg_thinking"));

  const genStart = Date.now();
  const messages = await hydrateOutgoingImages(buildMessages(tabId, contextEndIndex));
  // Tell the model what tools exist and when to use them (in the prompt language).
  // Mention search_library only when the knowledge-library tool is actually active.
  if (messages[0] && messages[0].role === "system") {
    let toolsHint = getPrompt("toolsSystem");
    if (activeToolSchemas().some((s) => s.function.name === "search_library")) {
      toolsHint += ` ${getPrompt("toolsSystemLibrary")}`;
    }
    messages[0].content += `\n\n${toolsHint}`;
  }
  setSendingImageCount(countOutgoingImages(messages));
  setSendingTrimCount((getTab(tabId) || getActiveTab())?.ctxOmittedMsgs || 0);
  const toolSteps = [];
  const seen = new Map(); // tool-call signature -> cached result (kills repeat loops)
  const showThinking = dom.showThinkingCheckbox?.checked || false;
  let thinkingContent = "";
  let finalContent = "";
  let forceText = false;
  let genError = null;

  // Run one agent turn and return an Ollama-shaped message {content, thinking,
  // tool_calls}. LOCAL Ollama streams (stream:true) so text + thinking appear
  // live (char-by-char) even in tool mode, while tool_calls are still collected
  // to drive the loop. CLOUD models keep stream:false — the Claude/OpenAI proxies
  // deliver tool-turns non-streaming by design (see server backends).
  async function runAgentTurn(useTools) {
    const isCloud = isCloudModel();
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: abortController.signal,
      body: JSON.stringify({
        model: dom.modelSelect.value,
        messages,
        ...(useTools ? { tools: activeToolSchemas() } : {}),
        ...(showThinking ? { think: true } : {}),
        stream: !isCloud,
        options: { temperature: 0.7, num_ctx: getNumCtx() },
        timeout: getLlmTimeout(),
      }),
    });
    if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(cleanErrorMessage(d.error) || t("chat_requestFailed")); }
    if (isCloud) return (await res.json()).message || {};

    // Stream the local turn into the pending bubble, live.
    const reader = res.body.getReader();
    cancelReaderOnAbort(reader, abortController.signal);   // WebKit: unblock a hung read() on Stop
    const decoder = new TextDecoder();
    let buffer = "", content = "", thinking = "", toolCalls = [];
    let live = null;   // { md, thinkEl } — built lazily on the first token
    const buildLive = () => {
      if (live || state.activeTabId !== tabId || !pending) return;
      pending.classList.remove("thinking");
      pending.innerHTML = "";
      let thinkEl = null;
      if (showThinking) {
        const details = document.createElement("details");
        details.className = "thinking-details";
        details.open = true;
        details.innerHTML = `<summary><span class="thinking-text">${t("msg_thinkingInProgress")}<span class="thinking-dots"><span>.</span><span>.</span><span>.</span><span>.</span><span>.</span><span>.</span></span></span></summary><div class="thinking-content markdownBody"></div>`;
        pending.appendChild(details);
        thinkEl = details.querySelector(".thinking-content");
      }
      const md = document.createElement("div");
      md.className = "markdownBody";
      pending.appendChild(md);
      live = { md, thinkEl };
      setAvatarState("talking");
    };
    const flush = (line) => {
      if (!line.trim()) return;
      let data; try { data = JSON.parse(line); } catch { return; }
      const m = data.message || {};
      if (Array.isArray(m.tool_calls) && m.tool_calls.length) toolCalls.push(...m.tool_calls);
      if (m.thinking) {
        thinking += m.thinking;   // always collect (stored on the reply); render only when shown
        if (showThinking) {
          buildLive();
          if (live?.thinkEl) scheduleStreamRender(() => { if (live?.thinkEl) { renderThinkingInto(live.thinkEl, thinking); scrollChatToEndIfPinned(); } });
        }
      }
      if (m.content) {
        content += m.content;
        buildLive();
        // Real content began — collapse the live thinking block.
        if (live?.thinkEl && thinking) {
          const details = pending?.querySelector(".thinking-details");
          if (details && details.open) { details.open = false; const s = details.querySelector("summary"); if (s) s.textContent = t("msg_thinkingSummary"); }
        }
        if (live?.md) scheduleStreamRender(() => { if (live?.md) { live.md.innerHTML = markdownToHtml(content); scrollChatToEndIfPinned(); } });
      }
    };
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const l of lines) flush(l);
    }
    buffer += decoder.decode();
    if (buffer.trim()) flush(buffer);
    cancelStreamRender();
    return { content, thinking, tool_calls: toolCalls };
  }

  try {
    for (let iter = 0; iter < 6; iter++) {
      const useTools = iter < 5 && !forceText; // last turn / repeat detected: force a text answer
      const msg = await runAgentTurn(useTools);
      if (msg.thinking) thinkingContent += (thinkingContent ? "\n\n" : "") + msg.thinking;
      const toolCalls = msg.tool_calls || [];

      if (toolCalls.length && useTools) {
        // Echo back any Claude thinking blocks (opaque; server-provided) so the
        // cloud backend can replay them verbatim before the tool_use — required
        // when thinking is on. Undefined for local Ollama, so it's dropped there.
        messages.push({ role: "assistant", content: msg.content || "", tool_calls: toolCalls, thinking_blocks: msg.thinking_blocks });
        // Execute this turn's NEW tool calls in parallel (deduped), each with a timeout.
        const toSig = (c) => (c.function?.name || "") + ":" + JSON.stringify(c.function?.arguments || {});
        const newBySig = new Map();
        for (const c of toolCalls) {
          const sig = toSig(c);
          if (!seen.has(sig) && !newBySig.has(sig)) newBySig.set(sig, c);
        }
        if (newBySig.size) {
          setPending(`🔧 ${t("tools_using", { tool: toolCalls.map((c) => getToolLabel(c.function?.name, c.function?.arguments)).join(" · ") })}`);
          setAvatarState("thinking");
          await Promise.all([...newBySig.values()].map(async (c) => {
            const fn = c.function || {};
            const result = await runToolWithTimeout(fn.name, fn.arguments);
            seen.set(toSig(c), result);
            toolSteps.push({ name: fn.name, args: fn.arguments, result: String(result) });
          }));
        }
        // Feed a tool result back for every call the model made, in its order.
        for (const call of toolCalls) {
          messages.push({ role: "tool", tool_name: call.function?.name, content: String(seen.get(toSig(call)) ?? "").slice(0, 4000) });
        }
        // Model only re-asked tools it already ran → it's looping; force a text answer next.
        if (!newBySig.size) forceText = true;
        setPending(t("msg_thinking"));
        continue;
      }
      finalContent = (msg.content || "").trim();
      break;
    }
  } catch (error) {
    genError = error;   // only GENERATION (network/tool) errors belong in an error bubble
  }

  if (pending) pending.remove();

  if (genError) {
    if (genError.name !== "AbortError") {
      const errReply = { role: "assistant", content: `⚠️ ${genError.message}`, timestamp: Date.now() };
      if (insertIndex >= 0 && insertIndex <= tab.messages.length) tab.messages.splice(insertIndex, 0, errReply);
      else tab.messages.push(errReply);
      saveChat();
      if (state.activeTabId === tabId) renderChat();
      showSendError(genError.message);
    }
  } else if (finalContent) {
    const reply = { role: "assistant", content: finalContent, timestamp: Date.now(), genMs: Date.now() - genStart };
    if (toolSteps.length) reply.toolSteps = toolSteps;
    if (thinkingContent) reply.thinking = thinkingContent;
    if (insertIndex >= 0 && insertIndex <= tab.messages.length) tab.messages.splice(insertIndex, 0, reply);
    else tab.messages.push(reply);
    saveChat();
    // Rendering is BEST-EFFORT and separate from generation: the reply is already
    // valid, so a DOM glitch here (e.g. WebKit "object can not be found" while
    // re-rendering the tool-steps block) must NOT surface as a ⚠️ generation error.
    try {
      if (state.activeTabId === tabId) renderChat();
      showExpression(detectExpression(finalContent));
      if (dom.autoSpeakCheckbox.checked && state.activeTabId === tabId) {
        const btn = dom.messagesEl.querySelector(".message.assistant:last-child .speakMessage");
        if (btn) speakMessage(finalContent, btn);
      }
    } catch (e) {
      console.error("[agenticReply] post-render error (reply is fine):", e);
    }
  }

  // Always clear generation state — no throw can reach here now (render is guarded).
  resetAvatarIdle();   // leaves a just-set expression alone; it reverts itself
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

// Parse /analyze [-f N] [-d] [-a] [extra question]. `-f`/`--frames` sets how many frames
// to sample from a video (1–32, default 8); extracted frames always show folded in the
// thinking block as thumbnails — `-d`/`--debug` swaps in the FULL-RES frames actually
// sent to the model (to debug what the model really sees); `-a`/`--all`
// sends every image/frame in ONE multi-image request (default is per-item map-reduce —
// see analyzeMedia; a model that only accepts one image per request needs the default,
// and --all on such a model is the user's own call). Null if not /analyze.
function parseAnalyzeCommand(input) {
  const m = input.match(/^\/analyze(?:\s+([\s\S]+))?\s*$/i);
  if (!m) return null;
  let rest = (m[1] || "").trim();
  let frames = null, debug = false, all = false;
  rest = rest.replace(/(?:^|\s)(?:-d|--debug)(?=\s|$)/i, () => { debug = true; return " "; });
  rest = rest.replace(/(?:^|\s)(?:-a|--all)(?=\s|$)/i, () => { all = true; return " "; });
  rest = rest.replace(/(?:^|\s)(?:-f|--frames)\s+(\d+)(?=\s|$)/i, (_, n) => {
    frames = Math.min(32, Math.max(1, parseInt(n, 10)));
    return " ";
  });
  return { prompt: rest.trim(), frames, debug, all };
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
    let frameScenes = []; // per-frame flag: picked at a scene change (⚡ in the map) vs density fill
    let frameThumbs = []; // small display thumbs for the folded thinking block (never sent to the model)
    let dedupDropped = 0; // near-duplicate frames removed by extractKeyFrames
    const frameTarget = parsed.frames || 8;
    // Sample the video into UP TO N still frames — scene-change keyframes plus
    // density-floor fill, near-duplicates deduped (extractKeyFrames; a static clip
    // legitimately yields fewer than N). Frames are sent as SEPARATE images in
    // chronological order — the model refers to them by frame number (#1..#N),
    // which is far more reliable than mapping moments to timestamps. The actual
    // timestamps are surfaced to the user as a frame→time table (not to the model).
    const framesFromVideo = async (b64, mime) => {
      showPending(t("analyze_extracting"));
      const src = mediaSrc(b64, mime || "video/mp4");
      const { frames, dropped } = await extractKeyFrames(src, frameTarget);
      frameTimes = frames.map(f => f.t);
      frameScenes = frames.map(f => !!f.scene);
      frameThumbs = frames.map(f => rawBase64(f.thumb || f.url));   // fallback path has no thumb
      dedupDropped = dropped;
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
        const hasImg = m.contextImages?.length, hasVid = m.generatedVideos?.length;
        if (!hasImg && !hasVid) continue;
        // Vision analysis ships bytes: pull anything stored as a gallery reference back.
        const imgs = hasImg ? (await resolveMediaList(m.contextImages)).map(rawBase64) : [];
        videoFrames = hasVid ? await framesFromVideo(m.generatedVideos[0], m.videoMimes?.[0]) : [];
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
    // Annotate the foreground "sending" pill with the image count (video frames aren't
    // counted as images; pure-video analysis leaves the pill unannotated).
    if (!bg) setSendingImageCount(imageCount);


    // 2. Build the thinking content now (before any model call) so it shows folded
    // in the pending/streaming bubble: frame→time map (⚡ marks scene-change picks,
    // plus the dedup tally), and the -d frame screenshots.
    if (frameTimes.length) {
      // The frame→time map is a single inline row (⚡ marks scene-change picks), not a
      // vertical bullet list; the thumbnails below carry the same #N + time captions.
      const row = frameTimes.map((s, i) => t("analyze_frameRow", { n: i + 1, t: (s || 0).toFixed(1) }) + (frameScenes[i] ? "⚡" : "")).join(" · ");
      const legend = frameScenes.some(Boolean) ? `\n${t("analyze_frameSceneLegend")}` : "";
      const dropNote = dedupDropped ? `\n${t("analyze_dedupDropped", { n: dedupDropped })}` : "";
      thinkingMd = `${t("analyze_frameMap")}${legend}${dropNote}\n\n${row}`;
    }
    // The extracted frames are ALWAYS shown folded in the thinking block, visible as
    // soon as extraction finishes (display thumbnails; -d/--debug swaps in the
    // full-res frames actually sent to the model). Carried as { b64, scene, n, t }
    // objects so scene picks get a ⚡ badge + highlight and each thumb is captioned.
    // They ride reply.thinkingFrames, which buildMessages never forwards — they can't
    // enter future chat context.
    if (videoFrames.length) {
      const srcFrames = parsed.debug ? videoFrames : frameThumbs;
      debugFrames = srcFrames.map((b64, i) => ({ b64, scene: !!frameScenes[i], n: i + 1, t: frameTimes[i] }));
      thinkingMd = `${t("analyze_debugFrames", { frames: videoFrames.length })}\n\n${thinkingMd || ""}`.trim();
    }
    // Background job: push the frames + map onto the placeholder bubble right now
    // (the foreground streaming bubble gets them via syncThinking on the next
    // showPending) — the user sees what was extracted while the analysis runs.
    if (bg && bg.thinking) bg.thinking(thinkingMd, debugFrames);

    // One non-streamed /api/chat call (map phase): read the whole NDJSON body,
    // return the concatenated answer text.
    const chatOnce = async (msgs) => {
      const r = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: abortController.signal,
        body: JSON.stringify({ model: dom.modelSelect.value, messages: msgs, options: { temperature: 0.5, num_ctx: getNumCtx() }, timeout: getLlmTimeout() }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(cleanErrorMessage(d.error) || t("chat_requestFailed"));
      }
      let out = "";
      for (const line of (await r.text()).split("\n")) {
        if (!line.trim()) continue;
        let o; try { o = JSON.parse(line); } catch { continue; }
        if (o.error) throw new Error(cleanErrorMessage(o.error) || t("chat_requestFailed"));
        out += o.message?.content || "";
      }
      return out.trim();
    };

    // 3. Build the analysis request as a self-contained turn (a dedicated "visual
    // analysis expert" system prompt, NOT the chat persona; no prior conversation
    // context). Two modes:
    //  - map-reduce (DEFAULT for >1 image): describe each image/frame in its own
    //    single-image call (full resolution per item; works on models that only
    //    accept one image per request), then a text-only reduce call synthesizes
    //    the final answer from the labeled notes. The per-item notes are folded
    //    into the thinking block.
    //  - --all (or a single image): everything in ONE multi-image turn, exactly
    //    the pre-existing behavior. If the model can't take multiple images,
    //    --all was the user's own call.
    const mapReduce = !parsed.all && images.length > 1;
    let messages;
    if (mapReduce) {
      // The map loop runs in-page (N+1 calls can't ride the single-server-job
      // chatFetch channel), so no server SSE will ever flip a bg job to running.
      if (bg) bg.markRunning();
      const notes = [];
      for (let i = 0; i < images.length; i++) {
        const isFrame = i >= imageCount;
        const label = isFrame
          ? t("analyze_itemFrame", { n: i - imageCount + 1, t: (frameTimes[i - imageCount] || 0).toFixed(1) })
          : t("analyze_itemImage", { n: i + 1 });
        showPending(t("analyze_workingMap", { i: i + 1, n: images.length }));
        let mapPrompt = t("analyze_mapPrompt", { label });
        if (parsed.prompt) mapPrompt += `\n\n${t("analyze_mapFocus", { q: parsed.prompt })}`;
        const desc = await chatOnce([
          { role: "system", content: isFrame ? t("analyze_mapFrameSystem") : t("analyze_mapImageSystem") },
          { role: "user", content: mapPrompt, images: [images[i]] },
        ]);
        notes.push(`**${label}**\n\n${desc || "—"}`);
      }
      // Fold the per-item notes into the thinking block (carried onto the final
      // reply). The streaming bubble's details were inserted pre-map with only the
      // frame map — drop them so syncThinking re-inserts the full version.
      thinkingMd = `${thinkingMd ? `${thinkingMd}\n\n---\n\n` : ""}${t("analyze_mapNotes")}\n\n${notes.join("\n\n")}`;
      if (bg && bg.thinking) bg.thinking(thinkingMd, debugFrames);
      if (!bg && state.activeTabId === tabId) {
        const det = dom.messagesEl.querySelector(".streaming-bubble > .thinking-details");
        if (det) det.remove();
      }
      const reduceIntro = kind === "mixed" ? t("analyze_reduceMixedIntro", { images: imageCount, frames: frameCount })
        : kind === "video" ? t("analyze_reduceVideoIntro", { frames: frameCount })
        : t("analyze_reduceImageIntro", { images: imageCount });
      const reduceTask = parsed.prompt ? t("analyze_reduceAsk", { q: parsed.prompt }) : t("analyze_reduceSummarize");
      messages = [
        { role: "system", content: t("analyze_reduceSystem") },
        { role: "user", content: `${reduceIntro}\n\n${notes.join("\n\n")}\n\n${reduceTask}` },
      ];
      showPending(t("analyze_workingReduce"));
    } else {
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
      messages = [
        { role: "system", content: systemPrompt },
        { role: "user", content: instruction, images },
      ];
      const working = kind === "mixed" ? t("analyze_workingMixed", { images: imageCount, frames: frameCount })
        : kind === "video" ? t("analyze_workingVideo", { frames: frameCount })
        : t("analyze_workingImage");
      showPending(working);
    }

    // 4. Run the (final) model call. A background --all job submits the single
    // /api/chat call to the server-side queue so it survives a page close/reload
    // (chatFetch reconnects by serverJobId, no re-inference); map-reduce stays
    // in-page end to end — a second chatFetch on the same bgJob would be mistaken
    // for a reconnect and return the first call's result, so its reduce streams
    // like the foreground path (the job dies with the page, like url/docfull).
    let content = "";
    if (bg && bg.server && !mapReduce) {
      const resp = await chatFetch(
        { model: dom.modelSelect.value, messages, options: { temperature: 0.5, num_ctx: getNumCtx() }, timeout: getLlmTimeout() },
        { bgJob: bg.server.bgJob, conversationId: bg.server.conversationId, msgId: bg.server.msgId, label: bg.server.label, signal: abortController.signal });
      if (!resp.ok) throw new Error(cleanErrorMessage((await resp.json()).error) || t("chat_requestFailed"));
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
          timeout: getLlmTimeout(),
        }),
      });
      if (!response.ok) {
        const d = await response.json().catch(() => ({}));
        throw new Error(cleanErrorMessage(d.error) || t("chat_requestFailed"));
      }

      // Stream the answer into the bubble.
      const reader = response.body.getReader();
      cancelReaderOnAbort(reader, abortController.signal);   // WebKit: unblock a hung read() on Stop
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
          scheduleStreamRender(() => {
            const md = dom.messagesEl.querySelector('.streaming-bubble > .markdownBody');
            if (md) { md.innerHTML = markdownToHtml(content); scrollChatToEndIfPinned(); }
          });
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

    cancelStreamRender();
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
    cancelStreamRender();
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
      resetAvatarIdle();   // leaves a just-set expression alone; it reverts itself
      state.currentAbortController = null;
    }
  }
}

export async function sendMessage(content, image, tabId = state.activeTabId, file = null, video = null, audio = null) {
  const tab = getTab(tabId);
  if (!tab) return;
  if (tab.locked) return;

  // A newly sent message always scrolls to the bottom — drop any resend scroll pin.
  state.scrollPin = null;

  // One-shot flag from the ▶ chip (markdown.js). Read and cleared HERE, at the single
  // entry point, so a send that never reaches the /imagine branch can't leave it armed
  // for the user's next real message.
  const foldCommandBubble = state.foldNextCommandBubble;
  state.foldNextCommandBubble = false;

  markActivity();

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

  // Handle /ask command — query the knowledge library (retrieve + cited answer).
  // Supports "/ask @docId1 @docId2 question" to scope the search to specific docs.
  const ask = parseAskCommand(content);
  if (ask !== null) {
    // Auto mode (-a): the assistant plans its own keywords, searches, reads, answers.
    // Needs a real task to plan from.
    if (ask.auto) {
      if (!ask.query) {
        tab.messages.push({ role: "user", content, timestamp: Date.now() });
        tab.messages.push({ role: "assistant", content: t("auto_usage"), timestamp: Date.now() });
        saveChat();
        if (state.activeTabId === tabId) renderChat();
        return;
      }
      await handleAutoAsk(ask.query, tab, { folders: ask.folders, dims: ask.dims });
      return;
    }
    // No question is fine when whole docs/archives are mentioned (defaults to a
    // summary); folder scope still needs a real question (retrieval must embed it).
    const askCanDefault = (ask.docIds.length || ask.archives.length) && !ask.folders.length;
    if (!ask.query && !askCanDefault) {
      tab.messages.push({ role: "user", content, timestamp: Date.now() });
      tab.messages.push({ role: "assistant", content: t("library_askUsage"), timestamp: Date.now() });
      saveChat();
      if (state.activeTabId === tabId) renderChat();
      return;
    }
    await handleAskCommand(ask.query, tab, { docIds: ask.docIds, folders: ask.folders, archives: ask.archives, topK: ask.topK, short: ask.short });
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

  // Handle /tool command — explicit tool prefetch (run the named tool, splice its
  // result in, then a normal streamed reply). Foreground: these fetches are seconds.
  const toolCmd = content ? parseToolCommand(content) : null;
  if (toolCmd) {
    if (toolCmd.error) {
      tab.messages.push({ role: "user", content, timestamp: Date.now() });
      tab.messages.push({ role: "assistant", content: toolCmd.error, timestamp: Date.now() });
      saveChat();
      if (state.activeTabId === tabId) renderChat();
      return;
    }
    await handleToolCommand(toolCmd, tab, tabId, null, false, content);
    return;
  }

  // Handle /skill — load a video model's official prompt-writing guide into THIS
  // conversation, then iterate on the prompt in ordinary chat (the guide bubble stays
  // in context; folding it is the off switch). Generation stays a separate, manual
  // /imagine: the whole point is polishing the prompt before any GPU time is spent.
  const skillCmd = content ? parseSkillCommand(content) : null;
  if (skillCmd) {
    await handleSkillCommand(skillCmd, tab, tabId, content, image, video);
    return;
  }

  // Handle /doc — open a Word/PowerPoint/Excel file (as a working copy) and load its
  // map + the officecli authoring guide, then edit it by conversation. A /doc that
  // arrives with a document STAGED in the composer never reaches here: main.js routes
  // that case directly, because a staged .docx/.pptx is otherwise consumed by the
  // parse-into-text pipeline before sendMessage sees it.
  const docCmd = content ? parseDocCommand(content) : null;
  if (docCmd) {
    await handleDocCommand(docCmd, tab, tabId, content, null);
    return;
  }

  // Handle /0 (no context) and /1 (previous message only) commands
  const isolatedMatch = content && content.match(/^\/(0|1)\s+([\s\S]+)/);
  if (isolatedMatch) {
    const mode = isolatedMatch[1]; // "0" or "1"
    const actualContent = isolatedMatch[2];
    const userMessage = { role: "user", content, timestamp: Date.now() };
    // Staged images belong on this bubble like on any other send — isolating the
    // CONTEXT shouldn't drop the attachment the question is about.
    await settleGalleryIds(image);
    attachUploadedImages(userMessage, image);
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
    // Dispatched by ▶ from a draft that is already on screen: the command bubble would
    // repeat that prompt verbatim, on screen and in the model's context. Fold it — the
    // existing fold both collapses the bubble and drops it from buildMessages. Nothing
    // is lost: the full command still lives here as the resend anchor and the record of
    // which attachments produced the clip, one ▼ away. A HAND-TYPED /imagine is never
    // folded — there is no draft above it, so that bubble IS the only record.
    if (foldCommandBubble) userMessage.folded = true;
    // Attached video(s) are the SOURCE for a video-edit model (Bernini / Animate).
    // Several clips can be staged → each runs the workflow once (batch). They ride on
    // the user bubble for display (reusing the generatedVideos field).
    let imagineVideos = stagedVideoList(video);
    // An attached image turns /imagine into image-to-image (instruction editing).
    await settleGalleryIds(image, imagineVideos, audio);
    if (image) attachUploadedImages(userMessage, image);
    if (imagineVideos.length) attachVideosToMessage(userMessage, imagineVideos);
    // ▶ dispatch: the render also gets everything the WORKSHOP attached (workshopMedia),
    // not only what is still staged in the composer. Merged rather than replaced, and
    // keyed by the stored slot so the composer's copy of a picture and the bubble's copy
    // are one picture, not two — a model handed the same reference twice reads it as two
    // subjects. Conversation order decides position (that order IS the identity mapping
    // for multi-reference models); a duplicate keeps its earlier place but takes the
    // composer's 🖌 mask, which is the freshly painted one. Only ▶ does this — a
    // hand-typed /imagine keeps meaning exactly what it says, attachments and all.
    if (foldCommandBubble) {
      const past = workshopMedia(tab);
      const byKey = new Map();
      for (const s of past.images) if (s.src) byKey.set(s.src, s);
      for (const s of messageImageSlots(userMessage)) {
        const seen = byKey.get(s.src);
        if (!seen) { byKey.set(s.src, s); continue; }
        seen.mask = s.mask || seen.mask;
        seen.name = s.name || seen.name;
      }
      setMessageImageSlots(userMessage, [...byKey.values()]);
      const staged = new Set(imagineVideos.map(mediaSlotKey));
      const extra = past.videos.filter((v) => !staged.has(mediaSlotKey(v)));
      if (extra.length) {
        imagineVideos = [...extra, ...imagineVideos];
        attachVideosToMessage(userMessage, imagineVideos);
      }
    }
    // Speech audio (InfiniteTalk dubbing) rides the user bubble + the gen payload.
    attachAudioToMessage(userMessage, audio);
    tab.messages.push(userMessage);
    const firstError = imagineCmds.find((cmd) => cmd && cmd.error);
    // A bare "/imagine" (no prompt) is valid only when something is attached
    // (image or video) — the gen is then attachment-driven (video edit / img2img).
    const hasAttach = !!(userMessage.contextImages?.length || imagineVideos.length);
    const validCmds = imagineCmds.filter((cmd) => cmd && !cmd.error && (cmd.prompt || hasAttach));
    if (firstError) {
      tab.messages.push({ role: "assistant", content: t("msg_commandError", { error: firstError.error }), timestamp: Date.now() });
      saveChat();
      if (state.activeTabId === tabId) renderChat();
    } else if (validCmds.length === 0) {
      tab.messages.push({ role: "assistant", content: t("msg_commandError", { error: t("chat_needPromptOrMedia") }), timestamp: Date.now() });
      saveChat();
      if (state.activeTabId === tabId) renderChat();
    } else {
      // Generation ALWAYS goes to the background queue. One source clip → one job;
      // multiple clips fan out (cartesian with each command's count).
      saveChat();
      if (state.activeTabId === tabId) renderChat();
      enqueueImagineGen(validCmds, tabId, userMessage.contextImages || null, imagineVideos, userMessage.mask || null, -1, audio, userMessage.imageMasks || null);
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
    // /analyze inspects only the FIRST staged clip (vision analysis isn't batched).
    const analyzeVideos = stagedVideoList(video);
    await settleGalleryIds(image, analyzeVideos);
    attachUploadedImages(userMessage, image);
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
      let base = hasImages ? getPrompt("fileSummarizeImages") : getPrompt("fileSummarize");
      autoPrompt = content ? `${base}\n\n${getPrompt("fileUserNote", content)}` : base;
    } else if (content) {
      autoPrompt = content;
    } else {
      autoPrompt = getPrompt("fileReadWait");
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
      assistantPreview.contextImages = file.images.map((img) => img.base64);
      // Keep each embedded image's own filename (e.g. from a PDF/DOCX) for its download name.
      if (file.images.some((img) => img.name)) {
        assistantPreview.imageNames = file.images.map((img) => img.name || null);
      }
    }
    // Display-only images (email inline + downloaded HTML images): shown in the
    // bubble with download/lightbox, but kept out of `images` so they never enter
    // the model context — the body's [📷 N] markers say where each one sat.
    if (file.displayThumbnails && file.displayThumbnails.length > 0) {
      assistantPreview.generatedThumbnails = file.displayThumbnails;
      if (file.displayImages && file.displayImages.length) assistantPreview.generatedImages = file.displayImages;
      if (file.displayImageNames && file.displayImageNames.length) assistantPreview.generatedImageNames = file.displayImageNames;
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

  // Uploaded video(s) ride along on the user bubble for display only. They reuse the
  // generatedVideos field so they render/persist like generated clips, but
  // buildMessages() never forwards videos to the model — so there's no AI analysis.
  const plainVideos = stagedVideoList(video);
  await settleGalleryIds(image, plainVideos, audio);
  attachUploadedImages(userMessage, image);
  attachVideosToMessage(userMessage, plainVideos);
  // Uploaded speech audio: display-only on a plain send (a player on the bubble);
  // it only drives generation via /imagine with an audio-capable video model.
  attachAudioToMessage(userMessage, audio);

  tab.messages.push(userMessage);
  saveChat();
  if (state.activeTabId === tabId) renderChat();

  // Sending consumes the composer — in prompt-workshop mode too. This used to hand
  // the pictures back while a /skill guide was active, so the ▶ dispatch at the end
  // would still have its reference subjects; workshopMedia() now gathers those from
  // the user bubbles after the guide instead (masks included — they ride along in
  // msg.imageMasks), so the composer no longer has to hold them. Handing them back
  // just meant every send in a tab that once ran /skill left its pictures sitting in
  // the box, long after the prompt was written.

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
  const mimes = message.videoMimes || [];
  const thumbs = await Promise.all(message.generatedVideos.map((v, i) => {
    const vmime = mimes[i] || "video/mp4";
    return videoThumbnail(mediaSrc(v, vmime));
  }));
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
// Is this media slot worth rendering? Raw base64 shorter than ~100 chars is
// truncated garbage, but a gallery reference is a 60-character URL — the length test
// must not apply to it. Every media grid uses this instead of a bare length check.
function hasMedia(v) {
  if (typeof v !== "string" || !v) return false;
  // Only the gallery prefix counts as a short-but-valid slot; a leading "/" alone
  // would also match every JPEG, whose base64 starts with "/9j/".
  if (isMediaRef(v) || v.startsWith("http") || v.startsWith("data:") || v.startsWith("blob:")) return true;
  return v.length > 100;
}

function base64ByteLength(src) {
  if (!src || src.startsWith("http") || isMediaRef(src)) return 0;   // a URL/gallery ref carries no size
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
// timestampStamp + mediaFilename now live in utils.js (shared with archive/library
// so their lightbox captions use the same names).

// "Replace image" overlay, sitting just left of the download button on a user
// bubble's image. Picks a new file and writes it back over that slot, mirroring
// the upload pipeline (EXIF-normalise / convert exotic formats / 360px preview)
// so the swapped image behaves exactly like an originally-uploaded one.
// The × that removes one image from a bubble. Shared by both grids: generatedImages
// (display-only output) and contextImages (attachments / tool payloads shown above the
// text) — deleteMessageImage splices whichever arrays the message actually has.
// Every gallery id a bubble slot points at. deleteMessageImage/deleteMessageVideo
// splice the same index out of each parallel array, so the file behind the × is
// whatever those arrays hold there — the artifact and, where it is a separate file,
// its poster/thumbnail. Slots holding inline bytes (older conversations) yield no id.
function slotGalleryIds(msg, idx, kind) {
  const fields = kind === "video"
    ? ["generatedVideos", "generatedVideoThumbnails"]
    : ["generatedImages", "generatedThumbnails", "contextImages", "displayImages"];
  const ids = new Set();
  for (const f of fields) {
    const v = Array.isArray(msg?.[f]) ? msg[f][idx] : null;
    const id = v ? galleryIdOf(v) : null;
    if (id) ids.add(id);
  }
  return [...ids];
}

// ─── ★ on a generated picture/clip ────────────────────────────────────────────
// Rating is a gallery property, so a render can only be graded from the panel — which
// means opening it, finding the file, and losing the conversation you were judging it
// in. The ★ in the corner of an AI bubble's picture is the same control in the place
// where the judgement actually happens. Only files the gallery holds can carry a score,
// so pre-gallery inline bytes get no button.
function mediaRateId(msg, idx, kind) {
  const first = kind === "video"
    ? [msg?.generatedVideos?.[idx]]
    : [msg?.generatedImages?.[idx], msg?.generatedThumbnails?.[idx]];
  for (const v of first) {
    const id = v ? galleryIdOf(v) : null;
    if (id) return id;
  }
  return null;
}

// "★4.5" / "★0" / "☆" — the label IS the current score, so a rated file shows its grade
// without opening anything (and stays visible, unlike the hover-only buttons).
function paintRateButton(btn, rating) {
  btn.textContent = rating == null ? "☆" : `★${rating}`;
  btn.classList.toggle("isRated", rating != null);
  btn.title = rating == null ? t("rate_btnUnrated") : t("gal_rateValue", { n: rating });
}

let _ratePopover = null;
function closeRatePopover() {
  if (!_ratePopover) return;
  document.removeEventListener("keydown", _ratePopover.onKey, true);
  document.removeEventListener("mousedown", _ratePopover.onAway, true);
  _ratePopover.el.remove();
  _ratePopover = null;
}

// The star strip itself, floating next to the button it belongs to. Fixed-positioned
// against the button's rect rather than parented to the bubble: the picture grid clips
// and scrolls, and a popover inside it would be cut in half.
async function openRatePopover(btn, id) {
  closeRatePopover();
  const entry = await galleryEntryCached(id);
  if (!entry) { paintRateButton(btn, null); return; }   // file is gone — nothing to grade
  const pop = document.createElement("div");
  pop.className = "mediaRatePopover";
  pop.appendChild(galleryRateWidget(entry, (r) => paintRateButton(btn, r)));
  document.body.appendChild(pop);

  const r = btn.getBoundingClientRect();
  const w = pop.offsetWidth || 240;
  // Below the button by default, flipped above when the bubble sits near the bottom,
  // and pulled back inside the viewport horizontally.
  const left = Math.min(Math.max(6, r.left), window.innerWidth - w - 6);
  const below = r.bottom + 6;
  const fitsBelow = below + pop.offsetHeight + 6 < window.innerHeight;
  pop.style.left = `${left}px`;
  pop.style.top = fitsBelow ? `${below}px` : `${Math.max(6, r.top - pop.offsetHeight - 6)}px`;

  const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); closeRatePopover(); } };
  const onAway = (e) => { if (!pop.contains(e.target) && e.target !== btn) closeRatePopover(); };
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("mousedown", onAway, true);
  _ratePopover = { el: pop, onKey, onAway };
}

// The two corner buttons on a generated picture/clip: ★ score at the bottom-left,
// 🎨 "show me this one in the gallery" at the top-left. Opposite corners, so each is
// positioned on its own (CSS) and this only has to hand both back — a fragment rather
// than a wrapper, since they end up in different corners of the same wrapper.
function makeMediaCornerButtons(id) {
  const row = document.createDocumentFragment();

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "mediaRateBtn";
  btn.dataset.rateId = id;
  btn.setAttribute("aria-label", t("rate_btnUnrated"));
  paintRateButton(btn, null);
  // The score is on disk, not in the message — read it once per file per session
  // (galleryEntryCached), then paint. A miss leaves the empty ☆.
  galleryEntryCached(id).then((e) => { if (e) paintRateButton(btn, e.rating ?? null); });
  btn.addEventListener("click", (e) => {
    e.stopPropagation();       // don't open the lightbox
    if (_ratePopover) { closeRatePopover(); return; }   // second press closes it
    openRatePopover(btn, id);
  });
  row.appendChild(btn);

  const jump = document.createElement("button");
  jump.type = "button";
  jump.className = "mediaGalleryBtn";
  jump.title = t("rate_openInGallery");
  jump.setAttribute("aria-label", t("rate_openInGallery"));
  jump.textContent = "🎨";
  jump.addEventListener("click", (e) => {
    e.stopPropagation();
    closeRatePopover();
    openGalleryAt(id);         // clears the facets, un-hides a hidden file, reveals the tile
  });
  row.appendChild(jump);
  return row;
}

// A score set in the gallery panel (or on another copy of the same picture) repaints
// every ★ on screen for that file — registered once, for the lifetime of the page.
document.addEventListener("hk-gallery-rating", (e) => {
  const { id, rating } = e.detail || {};
  if (!id) return;
  for (const btn of document.querySelectorAll(`.mediaRateBtn[data-rate-id="${CSS.escape(id)}"]`)) {
    paintRateButton(btn, rating ?? null);
  }
});

// Every gallery id anywhere on a message — what the bubble's own × is about to drop
// its references to. Same field list the gallery panel scans for the reverse question
// ("who points at this file"), so the two halves can never disagree.
const MSG_MEDIA_FIELDS = ["generatedImages", "generatedThumbnails", "contextImages", "displayImages",
                          "generatedVideos", "generatedVideoThumbnails",
                          "generatedAudio", "generatedMeshes"];
function messageGalleryIds(msg) {
  const ids = new Set();
  for (const f of MSG_MEDIA_FIELDS) {
    const v = msg?.[f];
    const arr = Array.isArray(v) ? v : typeof v === "string" ? [v] : [];
    for (const item of arr) {
      const id = item ? galleryIdOf(item) : null;
      if (id) ids.add(id);
    }
  }
  return [...ids];
}

// The × on a picture/clip in a bubble. A file that lives in the gallery is ONE copy
// that this bubble merely points at, so "take it out of this bubble" and "delete the
// file" are two different acts — and which one is right depends on who else points at
// it. The dialog says that (other conversations, archives), then offers both. Media
// still stored as inline bytes has no such question: it exists only here, so the
// plain confirm stands. Resolves to "cancel" | "bubble" | "gallery".
async function confirmMediaDelete({ ids, msg, fallbackKey,
                                   titleKey = "delMedia_title",
                                   leadKey = "delMedia_inGallery",
                                   keepKey = "delMedia_bubbleOnly" }) {
  if (!ids.length) return confirm(t(fallbackKey)) ? "bubble" : "cancel";

  // Refs for every id behind this slot, merged. The bubble the × belongs to is not
  // "someone else" — drop it, or every file would report a reference of its own.
  const live = new Map();
  const archived = new Map();
  for (const id of ids) {
    let r;
    try { r = await galleryRefsFor(id); } catch { r = { live: [], archived: [] }; }
    for (const h of r.live || []) {
      if (msg && h.msgId && h.msgId === msg.id) continue;
      live.set(`${h.tabId}/${h.msgId}`, h);
    }
    for (const a of r.archived || []) archived.set(`${a.archive}/${a.msgId}`, a);
  }
  const others = [...live.values()];
  const arch = [...archived.values()];

  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "scanModalBackdrop";
    const modal = document.createElement("div");
    modal.className = "scanModal mediaDeleteModal";
    modal.innerHTML = `
      <div class="scanModalHeader">
        <h3 class="scanModalTitle">${escapeHtml(t(titleKey))}</h3>
        <button type="button" class="scanModalClose" aria-label="Close">✕</button>
      </div>
      <div class="mediaDeleteBody"></div>
      <div class="mediaDeleteActions">
        <button type="button" class="secondary mediaDeleteCancel">${escapeHtml(t("delMedia_cancel"))}</button>
        <button type="button" class="primary mediaDeleteBubble">${escapeHtml(t(keepKey))}</button>
        <button type="button" class="danger mediaDeleteBoth">${escapeHtml(t("delMedia_alsoGallery"))}</button>
      </div>`;
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    const body = modal.querySelector(".mediaDeleteBody");
    const line = (cls, text) => {
      const p = document.createElement("p");
      p.className = cls;
      p.textContent = text;
      body.appendChild(p);
      return p;
    };
    line("mediaDeleteLead", t(leadKey));
    const names = document.createElement("ul");
    names.className = "mediaDeleteFiles";
    // A whole bubble can carry a dozen files; the list is here to make the delete
    // concrete, not to enumerate everything, so it stops and says how many are left.
    for (const id of ids.slice(0, 8)) {
      const li = document.createElement("li");
      li.textContent = galleryName(id) || id;   // the ledger name, or the id itself
      names.appendChild(li);
    }
    if (ids.length > 8) {
      const li = document.createElement("li");
      li.className = "mediaDeleteMore";
      li.textContent = t("delMedia_more", { n: ids.length - 8 });
      names.appendChild(li);
    }
    body.appendChild(names);

    const total = others.length + arch.length;
    if (!total) {
      line("mediaDeleteRefs", t("delMedia_onlyHere"));
    } else {
      line("mediaDeleteRefs", t("delMedia_alsoUsed", { n: total }));
      const ul = document.createElement("ul");
      ul.className = "mediaDeleteRefList";
      const rows = [
        ...others.map((h) => t("delMedia_refChat", { title: h.tabTitle || "—" })
          + (h.excerpt ? ` · ${h.excerpt}` : "")),
        ...arch.map((a) => t("delMedia_refArchive", { title: a.title || a.archive })),
      ];
      // A file used in fifty places would push the buttons off screen; the count above
      // is the real answer, this list is only there to make it concrete.
      for (const text of rows.slice(0, 6)) {
        const li = document.createElement("li");
        li.textContent = text;
        ul.appendChild(li);
      }
      if (rows.length > 6) {
        const li = document.createElement("li");
        li.className = "mediaDeleteMore";
        li.textContent = t("delMedia_more", { n: rows.length - 6 });
        ul.appendChild(li);
      }
      body.appendChild(ul);
      line("mediaDeleteWarn", t("delMedia_warn"));
    }

    const done = (answer) => {
      document.removeEventListener("keydown", onKey);
      backdrop.remove();
      resolve(answer);
    };
    const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); done("cancel"); } };
    modal.querySelector(".scanModalClose").addEventListener("click", () => done("cancel"));
    modal.querySelector(".mediaDeleteCancel").addEventListener("click", () => done("cancel"));
    modal.querySelector(".mediaDeleteBubble").addEventListener("click", () => done("bubble"));
    modal.querySelector(".mediaDeleteBoth").addEventListener("click", () => done("gallery"));
    backdrop.addEventListener("mousedown", (e) => { if (e.target === backdrop) done("cancel"); });
    document.addEventListener("keydown", onKey);
    modal.querySelector(".mediaDeleteBubble").focus();
  });
}

function makeImageDeleteButton(msgIndex, imgIdx) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "imageDeleteBtn";
  btn.title = t("chat_delImgTitle");
  btn.setAttribute("aria-label", t("chat_delImgTitle"));
  btn.textContent = "×";
  btn.addEventListener("click", async (e) => {
    e.stopPropagation();          // don't open the lightbox
    const msg = getActiveTab()?.messages?.[msgIndex];
    const ids = slotGalleryIds(msg, imgIdx, "image");
    const answer = await confirmMediaDelete({ ids, msg, fallbackKey: "chat_confirmDelImg" });
    if (answer === "cancel") return;
    // File first, bubble second: if the delete fails, the reference is still there to
    // try again from, rather than a bubble emptied of a file that never went away.
    if (answer === "gallery") await deleteGalleryFiles(ids);
    deleteMessageImage(msgIndex, imgIdx);
  });
  return btn;
}

function makeReplaceImageButton(msgIndex, imgIdx) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "messageReplaceBtn";
  btn.title = t("chat_replaceImgTitle");
  btn.setAttribute("aria-label", t("chat_replaceImgTitle"));
  btn.textContent = "⬆";
  btn.addEventListener("click", (e) => {
    e.stopPropagation();          // don't open the lightbox
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) return;
      if (file.size > 16 * 1024 * 1024) { alert(t("msg_imageTooLarge")); return; }
      const tab = getActiveTab();
      const msg = tab?.messages?.[msgIndex];
      if (!msg) return;
      const dataUrl = await readFileAsDataUrl(file);
      // Same normalisation as a fresh upload: bake EXIF orientation for standard
      // formats, transcode exotic ones to JPEG.
      const needsConvert = !/^image\/(jpeg|png|gif|webp)$/i.test(file.type);
      const sendDataUrl = needsConvert ? await convertToJpeg(dataUrl) : await normalizeOrientation(dataUrl, file.type);
      const preview = await makePreview(sendDataUrl);
      if (!Array.isArray(msg.contextImages)) return;
      // A swapped-in picture is an attachment like any other: file it, then store the
      // reference. Waited on rather than fired off, because unlike the send path there
      // is no deadline here — nothing is blocked on this finishing.
      const b64 = sendDataUrl.split(",")[1];
      const id = await fileIntoGallery(b64, sniffImageMime(b64, file.type || "image/jpeg"), file.name);
      if (id) cacheGalleryThumb(id, preview);
      msg.contextImages[imgIdx] = id ? galleryUrl(id) : b64;
      if (Array.isArray(msg.displayImages)) msg.displayImages[imgIdx] = id ? galleryThumbUrl(id) : preview;
      // imageNames is optional (pasted images have none) — materialise it so the
      // replacement's name is used for the download/caption and the model prompt. Same
      // rule as a fresh attach: the gallery name, falling back to the file's own.
      if (!Array.isArray(msg.imageNames)) msg.imageNames = new Array(msg.contextImages.length).fill(null);
      msg.imageNames[imgIdx] = galleryName(id) || file.name;
      // Masks are painted ON pixels, so neither kind survives a swapped picture: the
      // inpaint mask belongs to image #0, a subject cutout to this exact index.
      if (imgIdx === 0 && msg.mask) delete msg.mask;
      if (Array.isArray(msg.imageMasks) && msg.imageMasks[imgIdx]) {
        msg.imageMasks[imgIdx] = undefined;
        if (!msg.imageMasks.some(Boolean)) delete msg.imageMasks;
      }
      saveChat();
      renderChat();
    });
    input.click();
  });
  return btn;
}

// The small bottom-right "download" overlay shared by image/video previews.
// The tooltip (title + aria-label) leads with the action ("Download image") and
// then the filename and, when known, the size.
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
  const full = actionLabel ? `${actionLabel}: ${label}` : label;
  dl.title = full;
  dl.setAttribute("aria-label", full);
  dl.textContent = "⬇";
  return dl;
}

// Build the collapsible "thinking" <details> block: optional markdown text plus an
// optional grid of frame screenshots (used by /analyze and its -d flag). Shared by
// renderMessage, the bg placeholder, and the live /analyze streaming bubble. Returns
// null if both empty. `frames` is either an array of base64 strings (legacy) or of
// { b64, scene, n, t } objects (/analyze video frames) — the latter get a "frame N · Xs"
// caption and, for scene-change picks, a ⚡ badge + highlight ring.
function buildThinkingDetails(thinkingText, frames) {
  if (!thinkingText && !(frames && frames.length)) return null;
  const details = document.createElement("details");
  details.className = "thinking-details";
  const inner = thinkingText ? markdownToHtml(thinkingText) : "";
  details.innerHTML = `<summary>${t("msg_thinkingSummary")}</summary><div class="thinking-content markdownBody">${inner}</div>`;
  if (frames && frames.length) {
    const content = details.querySelector(".thinking-content");
    const grid = document.createElement("div");
    grid.className = "imageGrid frameThumbGrid";
    for (const f of frames) {
      const obj = (typeof f === "object" && f) ? f : { b64: f };
      const wrapper = document.createElement("div");
      wrapper.className = obj.scene ? "imageWrapper frameThumb isScene" : "imageWrapper frameThumb";
      const img = document.createElement("img");
      img.className = "generatedImage";
      img.src = obj.b64.startsWith("data:") ? obj.b64 : `data:image/jpeg;base64,${obj.b64}`;
      wrapper.appendChild(img);
      if (obj.scene) {
        const badge = document.createElement("span");
        badge.className = "frameSceneBadge";
        badge.textContent = "⚡";
        wrapper.appendChild(badge);
      }
      if (obj.n != null) {
        const cap = document.createElement("span");
        cap.className = "frameCaption";
        cap.textContent = obj.t != null ? t("analyze_frameCaption", { n: obj.n, t: (obj.t || 0).toFixed(1) }) : `#${obj.n}`;
        wrapper.appendChild(cap);
      }
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
let videoPauseObserver = null;
const videoObjectUrls = new Set();
const videoLazyData = new WeakMap(); // video element → { data, mime } until loaded

function resetVideoLazyLoading() {
  if (videoLazyObserver) { videoLazyObserver.disconnect(); videoLazyObserver = null; }
  if (videoPauseObserver) { videoPauseObserver.disconnect(); videoPauseObserver = null; }
  for (const url of videoObjectUrls) URL.revokeObjectURL(url);
  videoObjectUrls.clear();
}

// Pause a playing clip once it scrolls fully out of the chat viewport, so a video
// the user scrolled past doesn't keep playing (and blaring audio) off-screen. It
// stays observed for the element's lifetime — scrolling it back into view just
// leaves it paused (the user presses play again). Companion to videoLazyObserver
// but with no rootMargin: it fires on ACTUAL visibility, not the load-ahead band.
function observeVideoPause(video) {
  if (!videoPauseObserver) {
    videoPauseObserver = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting && !e.target.paused) e.target.pause();
      }
    }, { root: dom.messagesEl, threshold: 0 });
  }
  videoPauseObserver.observe(video);
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
  // A gallery reference is just a URL: the browser range-streams it from disk, which
  // beats decoding tens of megabytes of base64 into a blob. Inline base64 (old
  // conversations, imported JSON) still goes through the blob path.
  video.src = isMediaRef(stash.data) ? stash.data : base64ToBlobUrl(stash.data, stash.mime);
}
// The fullscreen video viewer (lightbox.js) navigates across clips that may still
// be lazy — let it force any source video's blob src in.
state.loadVideoNow = loadVideoNow;

function lazyLoadVideo(video, base64, mime) {
  video.preload = "none"; // nothing loads until it nears the viewport
  videoLazyData.set(video, { data: base64, mime });
  observeVideoPause(video); // pause it if the user scrolls it out of view mid-play
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

// Build a resolver that maps a markdown ![](name) filename to THIS bubble's own
// image thumbnail src (exact filename match against the bubble's name arrays).
// Only same-bubble images resolve; anything else returns null → stays literal text.
function buildBubbleImageResolver(genThumbs, genFull, genNames, userThumbs, userFull, userNames) {
  const norm = (s) => (hasMedia(s) ? mediaSrc(s) : null);   // filenames/short strings aren't media
  const map = new Map();
  const add = (name, thumb, full) => {
    if (!name) return;
    const src = norm(thumb) || norm(full);
    if (!src) return;
    const entry = { src, full: norm(full) || src }; // src=thumbnail, full=lightbox image
    const k = String(name).trim().toLowerCase();
    if (!k) return;
    if (!map.has(k)) map.set(k, entry);
    const base = k.split(/[\\/]/).pop();
    if (base && !map.has(base)) map.set(base, entry);
  };
  const feed = (names, thumbs, full) => {
    if (!Array.isArray(names)) return;
    names.forEach((nm, i) => add(nm, thumbs?.[i], full?.[i]));
  };
  feed(genNames, genThumbs, genFull);           // generated / doc images
  feed(userNames, userThumbs, userFull);        // user-attached images in the same bubble
  if (!map.size) return null;
  return (url) => {
    let k;
    try { k = decodeURIComponent(String(url).trim()); } catch { k = String(url).trim(); }
    k = k.toLowerCase();
    return map.get(k) || map.get(k.split(/[\\/]/).pop()) || null;
  };
}

// Convert an epoch-ms timestamp to the local "YYYY-MM-DDTHH:MM:SS" string that a
// <input type="datetime-local" step="1"> expects (its value is always local time).
function tsToDatetimeLocal(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// Double-click-the-timestamp editor: a small modal with a native date+time picker,
// prefilled to the bubble's current time. Save writes the new epoch-ms back.
function openTimestampEditor(index) {
  const tab = getActiveTab();
  const msg = tab.messages[index];
  if (!msg || !msg.timestamp) return;

  const backdrop = document.createElement("div");
  backdrop.className = "scanModalBackdrop";
  const modal = document.createElement("div");
  modal.className = "scanModal timestampEditModal";
  modal.innerHTML = `
    <div class="scanModalHeader">
      <h3 class="scanModalTitle">${escapeHtml(t("editTime_title"))}</h3>
      <button type="button" class="scanModalClose" aria-label="Close">✕</button>
    </div>
    <div class="timestampEditBody">
      <input type="datetime-local" step="1" class="timestampEditInput" />
    </div>
    <div class="timestampEditActions">
      <button type="button" class="secondary timestampEditCancel">${escapeHtml(t("editTime_cancel"))}</button>
      <button type="button" class="primary timestampEditSave">${escapeHtml(t("editTime_save"))}</button>
    </div>`;
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  const input = modal.querySelector(".timestampEditInput");
  input.value = tsToDatetimeLocal(msg.timestamp);

  const close = () => {
    document.removeEventListener("keydown", onKey);
    backdrop.remove();
  };
  const save = () => {
    if (!input.value) return;
    const ms = new Date(input.value).getTime();
    if (Number.isNaN(ms)) return;
    tab.messages[index].timestamp = ms;
    saveChat();
    renderChat();
    close();
  };
  const onKey = (e) => {
    if (e.key === "Escape") { e.preventDefault(); close(); }
    if (e.key === "Enter") { e.preventDefault(); save(); }
  };

  modal.querySelector(".scanModalClose").addEventListener("click", close);
  modal.querySelector(".timestampEditCancel").addEventListener("click", close);
  modal.querySelector(".timestampEditSave").addEventListener("click", save);
  backdrop.addEventListener("mousedown", (e) => { if (e.target === backdrop) close(); });
  document.addEventListener("keydown", onKey);

  input.focus();
}

// ─── Bubble edit history ──────────────────────────────────────────────────────
// Every committed in-bubble edit stashes the version it replaced in msg.editHistory
// (oldest first), so editing a message is never a one-way door: the 🕘 button next
// to 复制 lists the older versions and puts one back. A restore is itself an edit —
// it stashes what it replaces — so it can be undone the same way. Capped, oldest
// falling off first, so a heavily reworked message can't grow the tab's stored
// record without bound.
const EDIT_HISTORY_MAX = 30;

function pushEditHistory(msg, previous) {
  if (!msg || typeof previous !== "string" || !previous) return;
  const list = Array.isArray(msg.editHistory) ? msg.editHistory : (msg.editHistory = []);
  // `at` is when THAT version came into being (the bubble's own clock while it was
  // the live text) — not when it was replaced. A version and its time travel
  // together: committing an edit re-stamps the bubble, restoring puts the old
  // stamp back with the old text.
  list.push({ content: previous, at: msg.timestamp || Date.now() });
  if (list.length > EDIT_HISTORY_MAX) list.splice(0, list.length - EDIT_HISTORY_MAX);
}

// The 🕘 popup: current version on top, previous versions newest-first, each with
// 恢复 / × of its own.
function openEditHistory(index) {
  const tab = getActiveTab();
  const msg = tab?.messages?.[index];
  if (!msg?.editHistory?.length) return;

  const backdrop = document.createElement("div");
  backdrop.className = "scanModalBackdrop";
  const modal = document.createElement("div");
  modal.className = "scanModal editHistoryModal";
  modal.innerHTML = `
    <div class="scanModalHeader">
      <h3 class="scanModalTitle">${escapeHtml(t("hist_title"))}</h3>
      <span class="scanModalStatus editHistoryCount"></span>
      <button type="button" class="scanModalClose" aria-label="Close">✕</button>
    </div>
    <div class="editHistoryList"></div>
    <div class="editHistoryActions">
      <button type="button" class="secondary editHistoryClear">${escapeHtml(t("hist_clear"))}</button>
      <button type="button" class="primary editHistoryDone">${escapeHtml(t("hist_done"))}</button>
    </div>`;
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  const listEl = modal.querySelector(".editHistoryList");
  const countEl = modal.querySelector(".editHistoryCount");

  const close = () => {
    document.removeEventListener("keydown", onKey);
    backdrop.remove();
  };
  const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); close(); } };
  // Repaint the bubble under the popup so a restore shows at once. renderChat()
  // rebuilds the message list only — the popup lives on document.body, untouched.
  const commit = () => {
    const scrollY = dom.messagesEl.scrollTop;
    saveChat();
    renderChat();
    dom.messagesEl.scrollTop = scrollY;
  };

  const makeCard = ({ label, when, text, current, i }) => {
    const row = document.createElement("div");
    row.className = "editHistoryItem" + (current ? " isCurrent" : "");
    const head = document.createElement("div");
    head.className = "editHistoryHead";
    const name = document.createElement("span");
    name.className = "editHistoryLabel";
    name.textContent = label;
    head.appendChild(name);
    const time = document.createElement("span");
    time.className = "editHistoryTime";
    time.textContent = when ? formatTimestamp(when) : "";
    head.appendChild(time);
    if (!current) {
      const restore = document.createElement("button");
      restore.type = "button";
      restore.className = "editHistoryRestore";
      restore.textContent = t("hist_restore");
      restore.addEventListener("click", () => {
        pushEditHistory(msg, msg.content);   // what it replaces joins the log
        msg.content = text;
        // The bubble carries the restored version's own time, not the time of the
        // restore — putting an old version back puts its clock back with it.
        if (when) msg.timestamp = when;
        commit();
        close();   // the restore is done — get out of the way and show the bubble
      });
      head.appendChild(restore);
      const del = document.createElement("button");
      del.type = "button";
      del.className = "editHistoryDelete";
      del.title = t("hist_delete");
      del.setAttribute("aria-label", t("hist_delete"));
      del.textContent = "×";
      del.addEventListener("click", () => {
        msg.editHistory.splice(i, 1);
        if (!msg.editHistory.length) delete msg.editHistory;
        commit();
        paint();
      });
      head.appendChild(del);
    }
    row.appendChild(head);
    const body = document.createElement("div");
    body.className = "editHistoryText";
    body.textContent = text;
    row.appendChild(body);
    return row;
  };

  const paint = () => {
    const hist = msg.editHistory || [];
    if (!hist.length) { close(); return; }   // last version deleted → nothing left to manage
    countEl.textContent = t("hist_count", { n: hist.length });
    listEl.textContent = "";
    listEl.appendChild(makeCard({ label: t("hist_current"), when: msg.timestamp, text: msg.content, current: true }));
    for (let i = hist.length - 1; i >= 0; i--) {
      listEl.appendChild(makeCard({ label: t("hist_version", { n: i + 1 }), when: hist[i].at, text: hist[i].content, i }));
    }
  };
  paint();

  modal.querySelector(".editHistoryClear").addEventListener("click", () => {
    if (!confirm(t("hist_clearConfirm"))) return;
    delete msg.editHistory;
    commit();
    close();
  });
  modal.querySelector(".scanModalClose").addEventListener("click", close);
  modal.querySelector(".editHistoryDone").addEventListener("click", close);
  backdrop.addEventListener("mousedown", (e) => { if (e.target === backdrop) close(); });
  document.addEventListener("keydown", onKey);
}

function renderMessage(role, content, displayImages, index, timestamp, generatedImages, generatedThumbnails, generatedVideos, videoMimes, generatedAudio, audioMime, generatedVideoThumbnails) {
  const item = document.createElement("div");
  item.className = `message ${role}`;

  if (timestamp) {
    const ts = document.createElement("div");
    ts.className = "messageTimestamp";
    ts.textContent = formatTimestamp(timestamp);
    // Double-click the timestamp → edit it in a small popup (date + time picker).
    if (Number.isInteger(index)) {
      ts.classList.add("isEditable");
      ts.title = t("editTime_title");
      ts.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        if (getActiveTab().locked) return;
        openTimestampEditor(index);
      });
    }
    item.appendChild(ts);
  }

  // Library chunk bubbles: the FIRST chunk shows the source filename as a header;
  // every chunk shows its section name as a small tag above the content.
  const _libTab = Number.isInteger(index) ? getActiveTab() : null;
  const _libMsg = _libTab ? _libTab.messages[index] : null;
  if (_libMsg && _libMsg.searching) item.classList.add("librarySearching");   // /ask "searching…" pulse
  if (_libMsg && _libMsg.isLibraryBlock && _libTab.libraryDocId &&
      _libTab.messages.findIndex((m) => m.isLibraryBlock) === index) {
    const meta = _libTab.libraryMeta || {};
    const fname = (meta.source || "").replace(/^(file|url):/, "") || meta.title || _libTab.libraryDocId || "";
    if (fname) {
      const fileTag = document.createElement("div");
      fileTag.className = "libraryFileNameTag";
      // kind icon (📺 video / 📄 paper / …); older tabs may predate docKind in meta → 📄
      fileTag.textContent = `${meta.docKind ? kindIcon(meta.docKind) : "📄"} ${fname}`;
      item.appendChild(fileTag);
    }
  }
  if (_libMsg && _libMsg.isLibraryBlock && _libMsg.librarySection) {
    const secTag = document.createElement("div");
    secTag.className = "librarySectionTag";
    secTag.textContent = stripHeadingEmphasis(_libMsg.librarySection);   // strip literal ** from `## **X**` section labels
    // A video's transcript section is ASR+LLM-reformatted speech, not verbatim → ✏️
    // badge, hover/click for the explanation (shared helper — same as the library panel).
    const _libMeta = (_libTab && _libTab.libraryMeta) || {};
    if (_libMeta.docKind === "video" && isTranscriptSection(_libMsg.librarySection)) {
      secTag.appendChild(transcriptMark());
    } else if (_libMsg.libraryKind === "card") {
      // distill-card bubble: 📇 badge after "distill card" — AI-generated summary, not original content
      secTag.appendChild(cardMark());
    }
    item.appendChild(secTag);
  }

  if (Number.isInteger(index)) {
    item.dataset.msgIndex = index;
    item.addEventListener("mousedown", (e) => {
      // The bubble is drag-to-reorder, but pressing on its text (to select) or on
      // its media/controls (to drag the image/video out, scrub, click a button)
      // must NOT start a bubble drag — only a press on the bubble's own chrome does.
      const noDrag = e.target.closest(
        ".plainBody, .markdownBody, .editMessageInput, textarea, .messageTimestamp, " +
        "img, video, canvas, .imageWrapper, .videoWrapper, .meshWrapper, button, input, a"
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
      copyButton.addEventListener("click", () => copyMessageText(content, copyButton, item));
      leftActions.appendChild(copyButton);
    }

    // 🕘 sits right of 复制 — and only on a bubble that actually has older versions.
    if (_libMsg?.editHistory?.length) {
      const historyButton = document.createElement("button");
      historyButton.className = "messageAction historyMessage";
      historyButton.type = "button";
      historyButton.title = t("hist_btn", { n: _libMsg.editHistory.length });
      historyButton.setAttribute("aria-label", t("hist_title"));
      historyButton.textContent = "🕘";
      historyButton.addEventListener("click", () => openEditHistory(index));
      leftActions.appendChild(historyButton);
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
      // Deleting a whole bubble is a confirmed act now — and when the bubble carries
      // media filed in the gallery, the same three-way question the per-picture × asks:
      // drop the references, or delete the files as well.
      deleteButton.addEventListener("click", async () => {
        const tab = getActiveTab();
        const msg = tab?.messages?.[index];
        if (!msg || tab.locked || msg.locked) return;   // pinned/locked: no dialog for a no-op
        const ids = messageGalleryIds(msg);
        const answer = await confirmMediaDelete({
          ids, msg, fallbackKey: "delMsg_confirm",
          titleKey: "delMsg_title", leadKey: "delMedia_inGalleryMsg", keepKey: "delMedia_msgOnly",
        });
        if (answer === "cancel") return;
        if (answer === "gallery") await deleteGalleryFiles(ids);
        deleteChatMessage(index);
      });
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

  if (displayImages) {
    const previews = Array.isArray(displayImages) ? displayImages : [displayImages];
    // Original upload filenames + full-res bytes, when kept, so the download uses
    // the real name and the original image (falling back to the thumbnail).
    const msg = Number.isInteger(index) ? getActiveTab().messages[index] : null;
    // Download/caption name = the image's ORIGINAL filename (imageNames); falls
    // back to a timestamp name in mediaFilename when there's none (e.g. pasted images).
    const dlNames = msg?.imageNames;
    const fullImages = msg?.contextImages;
    // User bubbles: one shared media row (images + video on the same line).
    // Otherwise multiple images render in a compact grid; a single image stays inline.
    // A folded USER bubble still shows its pictures (see .foldShowsMedia in the CSS):
    // the text is what folding is meant to hide, while the images are what makes the
    // collapsed bubble recognisable. Marked here because "user bubble with images" is
    // fixed at render time, unlike .isFolded which toggles on click.
    if (mediaRowEnabled && previews.length) item.classList.add("foldShowsMedia");
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
      image.alt = t("chat_altUserImage");
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
            : mediaSrc(full))
        : src;
      const fname = mediaFilename(dlNames?.[imgIdx], timestamp, "image", imageExtFromSrc(dlSrc), imgIdx, previews.length);
      image.dataset.filename = fname; // shown as the lightbox caption
      // × is top-right on every bubble; on a user bubble the 🖌 mask button moves to
      // the top-LEFT (see .messageMaskBtn) so the two no longer share that corner.
      if (Number.isInteger(index)) {
        wrapper.appendChild(makeImageDeleteButton(index, imgIdx));
      }
      // Swap this image for a different file (user bubbles only — the message has
      // to be addressable by index so the new bytes can be written back).
      if (role === "user" && Number.isInteger(index)) {
        wrapper.appendChild(makeReplaceImageButton(index, imgIdx));
      }
      wrapper.appendChild(makeDownloadButton("imageDownloadBtn", dlSrc, fname, base64ByteLength(dlSrc), t("btn_downloadImage")));
      // 🖌 on EVERY image of a USER bubble, always — the model that will read the mask
      // is chosen at generation time (the dropdown, or /imagine -m), so hiding the brush
      // on the model that happens to be selected while looking at an old bubble would be
      // gating on the wrong thing. The painted region is stored per image in
      // msg.imageMasks[imgIdx]; how it is READ — inpaint region on image 0, or subject
      // cutout — is decided against the running model in generateImage. msg.mask is the
      // older single-mask slot, still honoured for messages that carry one.
      const bubbleRefMask = comfyModelSupportsRefMask();
      if (role === "user" && Number.isInteger(index)) {
        const has = !!(msg?.imageMasks?.[imgIdx] || (imgIdx === 0 && msg?.mask));
        const maskBtn = document.createElement("button");
        maskBtn.type = "button";
        maskBtn.className = "messageMaskBtn" + (has ? " hasMask" : "");
        maskBtn.title = has
          ? t(bubbleRefMask ? "chat_cutoutEditTitle" : "chat_maskEditTitle")
          : t(bubbleRefMask ? "chat_cutoutPaintTitle" : "chat_maskPaintTitle");
        maskBtn.setAttribute("aria-label", t("msg_maskPaintAria"));
        maskBtn.textContent = "🖌";
        maskBtn.addEventListener("click", async (e) => {
          e.stopPropagation();
          const tab = getActiveTab();
          const mm = tab?.messages?.[index];
          if (!mm) return;
          const b64 = mm.contextImages?.[imgIdx] || "";
          const fullSrc = b64
            ? mediaSrc(b64)
            : src;
          const prior = mm.imageMasks?.[imgIdx] || (imgIdx === 0 ? mm.mask || null : null);
          const result = await openMaskModal(fullSrc, prior);
          if (result === null) return; // cancelled (X / Cancel / Esc) → leave the mask untouched
          // Sparse by design: index i holds image i's region, holes are "no mask".
          const masks = mm.imageMasks || (mm.imageMasks = []);
          masks[imgIdx] = result || undefined;   // "" = cleared via apply → drop it
          if (!masks.some(Boolean)) delete mm.imageMasks;
          // The older single-mask slot would otherwise shadow an edit of image 0.
          if (imgIdx === 0) delete mm.mask;
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
    // Resolve markdown ![](name) against THIS bubble's own images (e.g. library-doc
    // inline refs) → inline thumbnail; refs to anything not in this bubble stay text.
    const resolveImage = buildBubbleImageResolver(
      generatedThumbnails, generatedImages, _libMsg?.generatedImageNames,
      displayImages, _libMsg?.contextImages, _libMsg?.imageNames
    );
    text.innerHTML = markdownToHtml(content, resolveImage ? { resolveImage } : undefined);
    // Re-apply persisted highlights/notes (content-anchored, so they survive
    // re-renders and markdown edits that don't touch the highlighted phrase).
    if (_libMsg?.highlights?.length) applyHighlights(text, _libMsg.highlights);
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
        // Committing an edit only rewrites the text — it never re-runs the message.
        // Re-running is the 重发 / resend button's job, so no key in this editor can
        // fire a generation, and the edited text can be read over before anything is
        // spent on it. (No in-page-job guard is needed here either: nothing is
        // dispatched. resendChatMessage still carries its own.)
        function finishEdit(save) {
          const newContent = input.value.trim();
          if (save && newContent && newContent !== original) {
            const scrollY = dom.messagesEl.scrollTop;
            const tab = getActiveTab();
            // Stash the version this edit replaces (with its own time), so 🕘 can
            // bring both back, and stamp the bubble with this version's birth time.
            pushEditHistory(tab.messages[index], original);
            tab.messages[index].content = newContent;
            tab.messages[index].timestamp = Date.now();
            saveChat();
            renderChat();
            dom.messagesEl.scrollTop = scrollY;
          } else {
            input.replaceWith(text);
          }
        }
        input.addEventListener("keydown", (e) => {
          // Enter and Ctrl+Enter both just save; Shift+Enter is a new line.
          if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); finishEdit(true); }
          if (e.key === "Escape") { finishEdit(false); }
        });
        input.addEventListener("blur", () => finishEdit(false));
      });
    }
    item.appendChild(text);
    textEl = text;
    // Distill-card bubble: visualize its «§ Relations» section as a node-link relation graph
    // below the text (parsed from the card markdown; null when the card has no relations).
    if (_libMsg?.libraryKind === "card") {
      try { const g = renderRelationGraph(content, { open: false }); if (g) item.appendChild(g); } catch (e) { console.warn("[relGraph]", e); }
    }
  }

  // Inline grid shows the light 480px generatedThumbnails; the full-res generatedImages
  // ride along as dataset.fullSrc for the lightbox/download (set below). Fall back to the
  // full-res for display only when no thumbnail exists (legacy data / URL-only previews).
  const gridImages = generatedThumbnails && generatedThumbnails.length > 0 ? generatedThumbnails : generatedImages;
  if (gridImages && gridImages.length > 0) {
    const validImages = gridImages.filter(hasMedia);
    const fullImages = generatedImages && generatedImages.length > 0 ? generatedImages : null;
    const ytId = Number.isInteger(index) && getActiveTab().messages[index]?.ytVideoId;

    if (validImages.length > 0) {
      const grid = document.createElement("div");
      grid.className = "imageGrid";

      // Only `contextImages` reach the model (see buildMessages); `generatedImages` is
      // display-only. The two can coexist on one bubble — a tool writes each image into
      // whichever container matches its fate — so the field alone decides the marker.
      // (The file-preview fallback below derives this grid from contextImages instead,
      // hence the check against the message field rather than the grid contents.)
      const notSentToAi = !!(_libMsg?.generatedImages?.length);

      for (let i = 0; i < validImages.length; i++) {
        const imgData = validImages[i];
        const wrapper = document.createElement("div");
        wrapper.className = "imageWrapper";
        if (notSentToAi) {
          wrapper.classList.add("notSentToAi");
          wrapper.title = t("chat_notSentToAi");
        }
        const img = document.createElement("img");
        img.className = "generatedImage";
        img.src = mediaSrc(imgData);
        if (fullImages && fullImages[i]) {
          img.dataset.fullSrc = mediaSrc(fullImages[i]);
        } else if (ytId) {
          img.dataset.fullSrc = `https://img.youtube.com/vi/${ytId}/maxresdefault.jpg`;
        }
        img.alt = t("chat_altGenImage");
        img.onerror = () => { img.alt = t("chat_altImgLoadFail"); img.style.display = "none"; };
        wrapper.appendChild(img);
        if (Number.isInteger(index)) {
          wrapper.appendChild(makeImageDeleteButton(index, i));
        }
        // ★ (top-left) on the AI's own renders — the bubble is where they get judged.
        if (role === "assistant") {
          const rateId = mediaRateId(_libMsg, i, "image");
          if (rateId) wrapper.appendChild(makeMediaCornerButtons(rateId));
        }
        // Download button (bottom-right) — full-res src when available.
        const dlSrc = img.dataset.fullSrc || img.src;
        // Per-image download/lightbox filename: library figure bubbles carry
        // generatedImageNames (image_01.jpg); a file preview's embedded images (PDF/DOCX)
        // carry imageNames — used only when the grid is showing those embedded
        // images (no separate display thumbnails), so the index stays aligned. Else a
        // timestamp default (mediaFilename's fallback).
        const gmsg = Number.isInteger(index) ? getActiveTab().messages[index] : null;
        const gimgName = gmsg?.generatedImageNames?.[i]
          || (gmsg?.isFilePreview && !(generatedThumbnails && generatedThumbnails.length) ? gmsg?.imageNames?.[i] : null);
        const iname = mediaFilename(gimgName || null, timestamp, "image", imageExtFromSrc(dlSrc), i, validImages.length);
        img.dataset.filename = iname; // shown as the lightbox caption
        wrapper.appendChild(makeDownloadButton("imageDownloadBtn", dlSrc, iname, base64ByteLength(dlSrc), t("btn_downloadImage")));
        grid.appendChild(wrapper);
      }
      // Assistant bubbles: separate the body text from the images shown below it
      // with a thin divider.
      if (content && role === "assistant") {
        const divider = document.createElement("hr");
        divider.className = "bubbleImageDivider";
        item.appendChild(divider);
      }
      item.appendChild(grid);
    }
  }

  // AI-generated videos (ComfyUI WAN etc.) — base64 mp4/webm as <video>.
  if (generatedVideos && generatedVideos.length > 0) {
    const vmimes = Array.isArray(videoMimes) ? videoMimes : [];
    // User bubbles share the media row built above (images + video, same line,
    // above the text); everyone else gets a standalone grid below the text.
    const vgrid = mediaRowEnabled ? null : document.createElement("div");
    if (vgrid) vgrid.className = "videoGrid";
    for (let vi = 0; vi < generatedVideos.length; vi++) {
      const vData = generatedVideos[vi];
      if (!hasMedia(vData)) continue;
      // Per-clip mime (a batch can mix codecs); fall back to the first, then mp4.
      const vmime = vmimes[vi] || vmimes[0] || "video/mp4";
      const vext = vmime.includes("webm") ? "webm" : vmime.includes("quicktime") ? "mov" : "mp4";
      const wrapper = document.createElement("div");
      wrapper.className = "videoWrapper";
      const video = document.createElement("video");
      video.className = "generatedVideo";
      video.controls = true;
      video.loop = true;
      video.playsInline = true;
      // If the browser can't decode this clip — an H.265 render on Firefox, or a Mac
      // without a HEVC decoder — the <video> would just sit black with no explanation.
      // On an actual decode/format error, surface a note pointing at the download button
      // (already present below), so the file stays usable and the bubble still shows it.
      // Fires only on failure, so a universally-playable h264 clip never shows it.
      video.addEventListener("error", async () => {
        if (wrapper.querySelector(".videoUnplayableNote")) return;
        const note = document.createElement("div");
        note.className = "videoUnplayableNote";
        note.textContent = t("msg_videoUnplayable");
        wrapper.appendChild(note);
        // "I can't decode this" and "it isn't there any more" reach the <video> as the
        // same error event, and blaming the codec for a file the user deleted from the
        // gallery sends them hunting for a decoder they do not need. The server knows
        // which it is, so ask — one byte, via Range, exactly the request that just
        // failed. Only for gallery references: inline bytes cannot go missing.
        if (!isMediaRef(vData)) return;
        try {
          const r = await fetch(mediaSrc(vData, vmime), { headers: { Range: "bytes=0-0" } });
          if (r.status === 404) note.textContent = t("msg_videoGone");
        } catch { /* offline or blocked — leave the codec note, it is the likelier cause */ }
      });
      // No autoplay — the user presses play. Muted by default so audio (LTX) never
      // surprises the user; they raise the volume themselves via the slider/icon or
      // the native controls. The poster shows immediately; the heavy video bytes load
      // lazily (streamable blob URL) only once it scrolls near view — see
      // lazyLoadVideo — so a tab full of large clips doesn't stall every refresh.
      // Use the captured thumbnail as the poster so a still shows before playback.
      const vthumb = generatedVideoThumbnails && generatedVideoThumbnails[vi];
      if (vthumb) video.poster = mediaSrc(vthumb, "image/jpeg");
      applyVideoAudio(video);
      trackVideoAudio(video);
      lazyLoadVideo(video, vData, vmime);
      // Only one video plays at a time — starting this one pauses the others.
      video.addEventListener("play", () => {
        dom.messagesEl.querySelectorAll("video.generatedVideo").forEach((other) => {
          if (other !== video && !other.paused) other.pause();
        });
        // Adopt the current shared setting: this element may have been built before
        // the user adjusted the volume on some other clip.
        applyVideoAudio(video);
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
        if (!video.muted && video.volume === 0) { video.volume = 0.5; }
      });
      // Keep the slider/icon in sync whether the user uses this, the native bar, or
      // the native bar in OS fullscreen — all three land on the same element.
      const syncVolUi = () => {
        const v = video.muted ? 0 : video.volume;
        volSlider.value = String(v);
        volIcon.textContent = v === 0 ? "🔇" : v < 0.5 ? "🔉" : "🔊";
      };
      video.addEventListener("volumechange", syncVolUi);
      syncVolUi();   // the shared setting was applied above, before these controls existed
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

      // Fullscreen button (top-left) — opens the custom viewer with ‹ › prev/next
      // across all the conversation's clips (native video fullscreen has no such nav).
      const fsBtn = document.createElement("button");
      fsBtn.className = "videoFullscreenBtn";
      fsBtn.type = "button";
      fsBtn.title = t("btn_fullscreenVideo");
      fsBtn.setAttribute("aria-label", t("btn_fullscreenVideo"));
      fsBtn.textContent = "⛶";
      fsBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (state.openVideoLightbox) state.openVideoLightbox(video);
      });
      wrapper.appendChild(fsBtn);

      // Picture-in-Picture button. WKWebView/Safari don't implement the standard
      // requestPictureInPicture; they use the older webkitSetPresentationMode. We only
      // show the button when WebKit actually reports PiP support, so a button that
      // appears is a button that works (the native control's PiP can be flaky here).
      const pipNative = typeof video.webkitSupportsPresentationMode === "function"
        && video.webkitSupportsPresentationMode("picture-in-picture");
      const pipStd = !!document.pictureInPictureEnabled;
      if (pipNative || pipStd) {
        const pipBtn = document.createElement("button");
        pipBtn.className = "videoPipBtn";
        pipBtn.type = "button";
        pipBtn.title = t("btn_pipVideo");
        pipBtn.setAttribute("aria-label", t("btn_pipVideo"));
        pipBtn.textContent = "⧉";
        pipBtn.addEventListener("click", async (e) => {
          e.stopPropagation();
          try {
            if (pipNative && typeof video.webkitSetPresentationMode === "function") {
              const inPip = video.webkitPresentationMode === "picture-in-picture";
              video.webkitSetPresentationMode(inPip ? "inline" : "picture-in-picture");
            } else if (document.pictureInPictureElement === video) {
              await document.exitPictureInPicture();
            } else {
              await video.requestPictureInPicture();
            }
          } catch { /* user gesture / state issues — ignore */ }
        });
        wrapper.appendChild(pipBtn);
      }

      // Delete button (top-right) — removes just this video from the message,
      // uploaded source clips included (a resend then runs with the ones that remain).
      if (Number.isInteger(index)) {
        const del = document.createElement("button");
        del.className = "videoDeleteBtn";
        del.type = "button";
        del.title = t("btn_deleteVideo");
        del.setAttribute("aria-label", t("btn_deleteVideo"));
        del.textContent = "×";
        del.addEventListener("click", async (e) => {
          e.stopPropagation();
          const msg = getActiveTab()?.messages?.[index];
          const ids = slotGalleryIds(msg, vi, "video");
          const answer = await confirmMediaDelete({ ids, msg, fallbackKey: "confirm_deleteVideo" });
          if (answer === "cancel") return;
          if (answer === "gallery") await deleteGalleryFiles(ids);
          deleteMessageVideo(index, vi);
        });
        wrapper.appendChild(del);
      }
      // ★ (top-left) on a generated clip — same control, same rules as the picture grid.
      if (role === "assistant") {
        const rateId = mediaRateId(_libMsg, vi, "video");
        if (rateId) wrapper.appendChild(makeMediaCornerButtons(rateId));
      }
      // Download button (bottom-right) — an <a download> pointing at the (data) URL.
      // Tooltip shows the filename and decoded byte size.
      // An uploaded clip keeps its own upload filename; generated clips fall back to
      // the timestamp. Uploaded source clips store per-clip names in videoNames[]
      // (legacy scalar videoName is folded into it on load, see migrateVideoFields).
      const msg = Number.isInteger(index) ? getActiveTab().messages[index] : null;
      const uploadedName = msg && Array.isArray(msg.videoNames) ? msg.videoNames[vi] : null;
      const vname = mediaFilename(uploadedName || null, timestamp, "video", vext, vi, generatedVideos.length);
      video.dataset.filename = vname; // shown as the lightbox caption
      // Lazy href: reuses the already-loaded blob URL if the video is loaded,
      // else builds one on demand (see makeDownloadButton) — avoids decoding the
      // clip at render time just to populate the link.
      wrapper.appendChild(makeDownloadButton("videoDownloadBtn",
        () => video.currentSrc || video.src || (isMediaRef(vData) ? vData : base64ToBlobUrl(vData, vmime)),
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

  // Generated 3D models (.glb/.spz) — a compact card per file: 🧊 + filename + a
  // download button (lazy blob href, so nothing decodes until the user reaches for
  // it). The interactive GLB viewer (P1) layers a canvas onto this card; the card
  // itself is the no-WebGL fallback and the .spz (splat) presentation.
  {
    const meshMsg = Number.isInteger(index) ? getActiveTab().messages[index] : null;
    const meshes = meshMsg && Array.isArray(meshMsg.generatedMeshes) ? meshMsg.generatedMeshes : [];
    if (meshes.length) {
      const mgrid = document.createElement("div");
      mgrid.className = "meshGrid";
      for (let mi = 0; mi < meshes.length; mi++) {
        const data = meshes[mi];
        if (!hasMedia(data)) continue;
        const mmime = (meshMsg.meshMimes && meshMsg.meshMimes[mi]) || "model/gltf-binary";
        const rawName = (meshMsg.meshNames && meshMsg.meshNames[mi]) || "";
        const mext = (rawName.match(/\.(glb|gltf|spz|ply|ksplat)$/i) || [, "glb"])[1].toLowerCase();
        const wrapper = document.createElement("div");
        wrapper.className = "meshWrapper";
        // Interactive GLB viewer (lazy): a poster canvas above the card; click to
        // orbit. Splats (.spz) and non-WebGL browsers keep the card-only fallback.
        // The canvas gets its own positioning box so the floating buttons land on
        // the VIEWPORT (like a video's) rather than on the file card below it.
        // The file card is a FALLBACK, not a caption: when the viewer is up you can
        // already see the model and the ⬇ button carries the name, so a row spelling
        // out ComfyUI's internal filename ("paint_ms9k…_00001_.glb") is pure noise.
        // It comes back whenever there IS nothing else to show.
        let carded = false;
        const showCard = () => {
          if (carded) return;
          carded = true;
          const card = document.createElement("div");
          card.className = "meshCard";
          card.innerHTML = `<span class="meshIcon">🧊</span>`;
          const label = document.createElement("span");
          label.className = "meshLabel";
          label.textContent = rawName ? rawName.replace(/^.*\//, "") : `model.${mext}`;
          card.appendChild(label);
          wrapper.appendChild(card);
        };
        let btnHost = wrapper;
        if (mmime === "model/gltf-binary") {
          const view = document.createElement("div");
          view.className = "meshView";
          const mc = document.createElement("canvas");
          mc.className = "meshCanvas";
          view.appendChild(mc);
          wrapper.appendChild(view);
          btnHost = view;
          import("./glb-viewer.js").then((v) => {
            if (!v.isSupported()) { mc.hidden = true; showCard(); return; }
            v.attachMesh(mc, () => mediaBase64(data), { name: rawName, cacheKey: `${rawName}:${data.length}:${data.slice(0, 32)}`, onFallback: showCard,
              // "panorama" = a sphere you stand inside; "forward" = a window in
              // front of the camera. Both are looked out of rather than orbited.
              view: meshMsg.meshView });
          }).catch(() => { mc.hidden = true; showCard(); });
        } else {
          showCard();   // a splat file has no viewer at all
        }
        const mname = mediaFilename(rawName ? rawName.replace(/^.*\//, "") : null, timestamp, "model", mext, mi, meshes.length);
        // Appended AFTER the canvas so they paint over the interactive GL overlay,
        // which mounts itself directly after it. Lazy href — the base64→blob decode
        // happens on hover/focus, not at render.
        btnHost.appendChild(makeDownloadButton("meshDownloadBtn", () => (isMediaRef(data) ? data : base64ToBlobUrl(data, mmime)), mname, base64ByteLength(data), t("btn_downloadMesh")));
        if (role !== "user") {
          const del = document.createElement("button");
          del.className = "meshDeleteBtn";
          del.textContent = "×";
          del.title = t("btn_deleteMesh");
          del.addEventListener("click", () => deleteMessageMesh(index, mi));
          btnHost.appendChild(del);
        }
        mgrid.appendChild(wrapper);
      }
      if (mgrid.children.length) item.appendChild(mgrid);
    }
  }

  // AI-generated speech (/voice command) — base64 wav as <audio> + download.
  if (hasMedia(generatedAudio)) {
    const amime = audioMime || "audio/wav";
    const aext = amime.includes("aac") ? "aac" : amime.includes("mpeg") ? "mp3" : amime.includes("ogg") ? "ogg" : "wav";
    const src = mediaSrc(generatedAudio, amime);
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
    // Reflect the toggle's arrow + tooltip for a given state. Folded shows ▼ with
    // a preview and the "not sent to the model" note; unfolded shows ▲ and the
    // collapse hint (which also states the not-sent behaviour).
    const setFoldUI = (isFolded) => {
      foldToggle.innerHTML = isFolded ? "&#x25BC;" : "&#x25B2;"; // ▼ or ▲
      if (isFolded) {
        const ts = timestamp ? formatTimestamp(timestamp) : "";
        const preview = content.length > 80 ? content.substring(0, 80) + "..." : content;
        const tooltipText = ts ? `${ts}\n${preview}` : preview;
        foldToggle.title = `${tooltipText}\n${t("fold_notSent")}`;
      } else {
        foldToggle.title = t("fold_collapseHint");
      }
    };
    // Initial state: a message persisted as folded loads collapsed, so show ▼.
    setFoldUI(!!getActiveTab().messages[index]?.folded);
    foldToggle.addEventListener("click", () => {
      const isFolded = item.classList.toggle("isFolded");
      setFoldUI(isFolded);
      const tab = getActiveTab();
      if (tab.messages[index]) {
        if (isFolded) {
          tab.messages[index].folded = true;
        } else {
          delete tab.messages[index].folded;
        }
        saveChat();
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
    addBlockCopyButtons();
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
    // inline images as previews); otherwise derive the grid from contextImages.
    const genImages = message.generatedImages || (message.isFilePreview && !message.generatedThumbnails?.length && message.contextImages?.length
      ? message.contextImages.map((img) => mediaSrc(img))
      : undefined);
    const previews = message.displayImages;
    const el = renderMessage(message.role, message.content, previews, index, message.timestamp, genImages, message.generatedThumbnails, message.generatedVideos, message.videoMimes, message.generatedAudio, message.audioMime, message.generatedVideoThumbnails);
    // Tag with the stable id so the jobs drawer can scroll a finished job into view.
    if (el && message.id) el.dataset.msgId = message.id;
    // Backfill posters for videos generated before thumbnails existed, so they
    // also get a still for export/archive and a poster on next render.
    if (message.generatedVideos?.length && !message.generatedVideoThumbnails?.length) {
      backfillVideoThumbnails(message);
    }
    // Insert thinking details block if present
    if (el && (message.thinking || message.thinkingFrames?.length)) {
      // `:scope >` so we get the message's OWN body, not a nested `.markdownBody`
      // inside an already-inserted thinking/tool block — inserting before a non-child
      // throws WebKit's "The object can not be found here." NotFoundError.
      const markdownBody = el.querySelector(":scope > .markdownBody");
      const details = buildThinkingDetails(message.thinking, message.thinkingFrames);
      if (markdownBody && details) el.insertBefore(details, markdownBody);
    }
    // Insert the /ask -a "search process" block (queries/dims/docs) — rendered like the
    // thinking block (collapsed, above the answer) and, like thinking, kept OUT of the
    // message content so it never re-enters the conversation context (buildMessages
    // sends only content). Same pattern as the tool-steps block below.
    if (el && message.autoProcess) {
      // `:scope >` so we get the message's OWN body, not a nested `.markdownBody`
      // inside an already-inserted thinking/tool block — inserting before a non-child
      // throws WebKit's "The object can not be found here." NotFoundError.
      const markdownBody = el.querySelector(":scope > .markdownBody");
      if (markdownBody) {
        const details = document.createElement("details");
        details.className = "thinking-details";
        details.innerHTML = `<summary>${t("auto_processHeader")}</summary><div class="thinking-content markdownBody">${markdownToHtml(message.autoProcess)}</div>`;
        el.insertBefore(details, markdownBody);
      }
    }
    // Insert tool-call details block (which tools the AI used, args + results)
    if (el && message.toolSteps && message.toolSteps.length) {
      // `:scope >` so we get the message's OWN body, not a nested `.markdownBody`
      // inside an already-inserted thinking/tool block — inserting before a non-child
      // throws WebKit's "The object can not be found here." NotFoundError.
      const markdownBody = el.querySelector(":scope > .markdownBody");
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
      copyBtn.addEventListener("click", () => copyMessageText(message.translation, copyBtn, transEl));
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
  addBlockCopyButtons();
  renderContextMeter();

  // Rebuilding innerHTML above resets scrollTop to 0; while a resend/edit is
  // regenerating in place, restore the pinned position so the view stays put.
  // Otherwise, if the user had scrolled up, keep their spot instead of snapping
  // to the bottom; only a pinned (at-bottom) view follows new content down.
  // setScrollTop (not a raw assignment) so this restore counts as a PROGRAMMATIC
  // scroll — otherwise a near-bottom pin restore would look like a user scroll and
  // release the pin (see onMessagesScroll).
  if (state.scrollPin != null) setScrollTop(state.scrollPin);
  else if (keepPosition) setScrollTop(prevScrollTop);
  refreshScrollState();
  updateHighlightsUI();   // keep the highlights browser badge/list in sync
}

// ── Text highlighting / annotation ────────────────────────────────────────
// A floating toolbar appears when the user selects text inside a message bubble:
// a highlighter pen (applies the last-used style) + a dropdown of colors,
// underline, strikethrough, a comment action, and an eraser. Highlights are
// stored on the message (content-anchored, see highlight.js) and re-applied on
// every render, so they persist and don't touch the underlying markdown.
const HL_COLORS = [
  { style: "yellow", dot: "#f2c94c" },
  { style: "green",  dot: "#6fcf76" },
  { style: "blue",   dot: "#6aa9f4" },
  { style: "pink",   dot: "#eb5f7a" },
  { style: "purple", dot: "#b07ce8" },
];
let hlLastStyle = "yellow";
let hlTarget = null;   // { bodyEl, msgIndex } — the bubble the selection is in
let hlBar = null, hlPopover = null, hlPopoverTextarea = null;
let hlSpeakBtn = null;   // the toolbar's speak button — doubles as the stop control
let hlSpeechTimer = null;
let hlPopoverTarget = null;  // { msgIndex, hlIdx }
// Drag state for the pen handle. hlManualPos = the user dragged the toolbar, so a
// still-active selection must NOT snap it back to the selection rect.
let hlDragging = false, hlDragMoved = false, hlDragDX = 0, hlDragDY = 0, hlManualPos = false;
// Snapshot of the selection taken on tool-button press. On touch, tapping a
// button collapses the live selection before the click fires, so we fall back to
// this cloned range. See getHlRange().
let hlCapturedRange = null;
// True briefly while a tool button is being pressed — so the selectionchange that
// a touch tap triggers (collapsing the selection) doesn't hide the toolbar and
// wipe hlTarget before the button's click handler runs.
let hlButtonPressing = false;

function hideHlToolbar() {
  // While the selection is being read aloud the toolbar must stay put — it holds the
  // only stop control. Losing the selection (the usual hide trigger) is expected here,
  // since clicking the button or anywhere else collapses it.
  if (hlSpeakBtn && state.activeSpeechButton === hlSpeakBtn) return;
  if (hlBar) { hlBar.hidden = true; hlBar.classList.remove("expanded"); }
  hlTarget = null;
  hlManualPos = false;
  hlCapturedRange = null;
}
// The range a highlight action should operate on: the live selection if it's
// still there, else the snapshot captured on button-press (touch).
function getHlRange() {
  const sel = window.getSelection();
  if (sel && sel.rangeCount && !sel.isCollapsed) return sel.getRangeAt(0);
  return hlCapturedRange;
}
// ── Drag the floating toolbar by its pen handle (mouse + touch) ──
function hlDragBegin(x, y) {
  const rect = hlBar.getBoundingClientRect();
  hlDragDX = x - rect.left;
  hlDragDY = y - rect.top;
  hlDragging = true;
  hlDragMoved = false;
}
function hlDragTo(x, y) {
  if (!hlDragging) return;
  hlDragMoved = true;
  hlBar.style.left = Math.round(x - hlDragDX) + "px";
  hlBar.style.top = Math.round(y - hlDragDY) + "px";
}
function hlDragFinish() {
  if (!hlDragging) return;
  hlDragging = false;
  if (hlDragMoved) hlManualPos = true;    // keep dragged position
  else hlBar.classList.add("expanded");   // a tap (no drag) expands — needed on touch (no hover)
}
function onHlMouseMove(e) { hlDragTo(e.clientX, e.clientY); }
function onHlMouseUp() {
  document.removeEventListener("mousemove", onHlMouseMove);
  document.removeEventListener("mouseup", onHlMouseUp);
  hlDragFinish();
}
function onHlTouchMove(e) {
  if (!hlDragging || !e.touches[0]) return;
  e.preventDefault();   // block page scroll while dragging
  hlDragTo(e.touches[0].clientX, e.touches[0].clientY);
}
function onHlTouchEnd() {
  document.removeEventListener("touchmove", onHlTouchMove);
  document.removeEventListener("touchend", onHlTouchEnd);
  document.removeEventListener("touchcancel", onHlTouchEnd);
  hlDragFinish();
}
function hideHlPopover() {
  if (hlPopover) hlPopover.hidden = true;
  hlPopoverTarget = null;
}

// Place a fixed-position element above `rect` (or below if there's no room),
// clamped into the viewport.
function positionHlFloat(el, rect) {
  el.hidden = false;
  const w = el.offsetWidth, h = el.offsetHeight;
  let top = rect.top - h - 8;
  if (top < 8) top = rect.bottom + 8;
  let left = rect.left + rect.width / 2 - w / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
  el.style.top = Math.round(top) + "px";
  el.style.left = Math.round(left) + "px";
}

// The chat host: message bubbles own their highlights on tab.messages[i].
const HL_CHAT_HOST = {
  resolve(bodyEl) {
    if (bodyEl.parentElement?.classList.contains("message") !== true) return null;
    const idx = bodyEl.closest(".message")?.dataset.msgIndex;
    return idx == null ? null : { msgIndex: Number(idx) };
  },
  list(ctx) {
    const m = getActiveTab()?.messages?.[ctx.msgIndex];
    return m ? (m.highlights = m.highlights || []) : null;
  },
  commit(ctx) {
    const m = getActiveTab()?.messages?.[ctx.msgIndex];
    if (m && m.highlights && !m.highlights.length) delete m.highlights;
    saveChat();
    renderChat();
  },
  scope(ctx) { return dom.messagesEl.querySelector(`.message[data-msg-index="${ctx.msgIndex}"]`); },
};

// Apply `style` to the current selection. If `withNote`, open the note editor on
// the freshly-created highlight afterwards.
function applyHlStyle(style, withNote = false) {
  const range = getHlRange();
  if (!hlTarget || !range) { hideHlToolbar(); return; }
  const anchor = captureAnchor(hlTarget.bodyEl, range);
  const { host, ctx } = hlTarget;
  hideHlToolbar();
  if (!anchor) return;
  const arr = host.list(ctx);
  if (!arr) return;
  if (!STYLE_IS_DECORATION(style)) hlLastStyle = style;
  arr.push({ style, quote: anchor.quote, prefix: anchor.prefix });
  const newIdx = arr.length - 1;
  host.commit(ctx);
  window.getSelection()?.removeAllRanges();
  if (withNote) openHlNote(host, ctx, newIdx, true);
}
// Colors are the "primary" styles the pen remembers; underline/strike don't
// change the pen's default.
function STYLE_IS_DECORATION(style) { return style === "underline" || style === "strike"; }

// Remove any highlights overlapping the current selection.
function clearHlSelection() {
  const range = getHlRange();
  if (!hlTarget || !range) { hideHlToolbar(); return; }
  const { host, ctx } = hlTarget;
  const arr = host.list(ctx) || [];
  const idxs = highlightsInSelection(hlTarget.bodyEl, range, arr);
  hideHlToolbar();
  if (!idxs.length) return;
  const drop = new Set(idxs);
  for (let i = arr.length - 1; i >= 0; i--) if (drop.has(i)) arr.splice(i, 1);
  host.commit(ctx);
  window.getSelection()?.removeAllRanges();
}

// Copy the currently selected text to the clipboard.
function copyHlSelection() {
  const range = getHlRange();
  const text = range ? range.toString() : "";
  hideHlToolbar();
  if (text) navigator.clipboard?.writeText(text).catch(() => {});
}

// Read the selection aloud. Unlike copy this does NOT hide the toolbar: speech is
// long-running, so the button has to stay put to double as the stop control.
// Plain toggle — click reads, click again stops. No pause state (that is the
// bubble speak button's contract, not this one), so this deliberately bypasses
// speakMessage's click handling and calls stopSpeech directly.
// The button sits outside any .message, so speakMessage takes its no-highlighting
// path and simply reads the text it is given.
function speakHlSelection(btn) {
  if (state.activeSpeechButton === btn) {   // already reading → stop outright
    stopSpeech();
    dismissHlToolbarAfterSpeech();
    return;
  }
  const range = getHlRange();
  const text = range ? range.toString().trim() : "";
  if (!text) return;
  speakMessage(text, btn);
  // speakMessage sets a tooltip describing pause / sentence-jump controls; neither
  // applies here. It assigns synchronously, so this override lands after it.
  // stopSpeech() restores the idle "Speak" title on its own.
  btn.title = t("hl_speakStop");
  // hideHlToolbar is suppressed for the duration, so something has to put the bar
  // away once the reading ends on its own. speech.js exposes no "finished" hook, so
  // watch the flag it clears; the poll stops with the speech.
  clearInterval(hlSpeechTimer);
  hlSpeechTimer = setInterval(() => {
    if (state.activeSpeechButton === btn) return;
    clearInterval(hlSpeechTimer);
    hlSpeechTimer = null;
    dismissHlToolbarAfterSpeech();
  }, 400);
}

// Put the toolbar away once reading stops — but only if the selection is gone. If the
// user still has text selected they are likely to act on it again, so leave the bar.
function dismissHlToolbarAfterSpeech() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) { hideHlToolbar(); return; }
  // Kept open: collapse back to the pen unless the pointer is actually on the bar —
  // mouseleave was suppressed during the reading, so nothing else will fire it.
  if (hlBar && !hlBar.matches(":hover")) hlBar.classList.remove("expanded");
}

// Open the note editor for highlight `hlIdx` owned by (host, ctx), anchored to its
// rendered span. `focusNew` selects-all so an empty note is ready to type.
function openHlNote(host, ctx, hlIdx, focusNew = false) {
  const arr = host.list(ctx);
  if (!arr || !arr[hlIdx]) return;
  const scope = host.scope(ctx);
  const span = scope?.querySelector(`.hlmark[data-hl-idx="${hlIdx}"]`);
  hlPopoverTarget = { host, ctx, hlIdx };
  hlPopoverTextarea.value = arr[hlIdx].note || "";
  // Mark the swatch matching this highlight's current color.
  hlPopover.querySelectorAll(".hlNoteSwatch").forEach((sw) =>
    sw.classList.toggle("active", sw.dataset.style === arr[hlIdx].style));
  positionHlFloat(hlPopover, (span || scope || document.body).getBoundingClientRect());
  hlPopoverTextarea.focus();
  if (focusNew) hlPopoverTextarea.select();
}

// Recolor the highlight the note editor is open on (keeps the note text).
function setHlNoteColor(style) {
  if (!hlPopoverTarget) return;
  const { host, ctx, hlIdx } = hlPopoverTarget;
  const hl = host.list(ctx)?.[hlIdx];
  if (!hl) return;
  hl.style = style;
  hlLastStyle = style;   // remember for the next comment
  const note = hlPopoverTextarea.value.trim();
  if (note) hl.note = note; else delete hl.note;
  host.commit(ctx);
  openHlNote(host, ctx, hlIdx, false);   // reopen on the recolored highlight
}

function saveHlNote() {
  if (!hlPopoverTarget) return;
  const { host, ctx, hlIdx } = hlPopoverTarget;
  const hl = host.list(ctx)?.[hlIdx];
  hideHlPopover();
  if (!hl) return;
  const note = hlPopoverTextarea.value.trim();
  if (note) hl.note = note; else delete hl.note;
  host.commit(ctx);
}

// Delete the highlight the note editor is open on (removes highlight + note).
function deleteHlFromNote() {
  if (!hlPopoverTarget) return;
  const { host, ctx, hlIdx } = hlPopoverTarget;
  const arr = host.list(ctx);
  hideHlPopover();
  if (!arr) return;
  arr.splice(hlIdx, 1);
  host.commit(ctx);
}

// Icon-only toolbar button; its label lives in the tooltip (title).
function buildHlBtn(label, onClick, opts = {}) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "hlBtn";
  b.title = label;
  b.setAttribute("aria-label", label);
  if (opts.dot) {
    const dot = document.createElement("span");
    dot.className = "hlDot";
    dot.style.background = opts.dot;
    b.appendChild(dot);
  } else if (opts.glyph) {
    b.textContent = opts.glyph;
  }
  b.addEventListener("click", onClick);
  return b;
}

export function initHighlightUI() {
  // Collapsed = a translucent pen (also the drag handle). Hovering reveals a
  // compact horizontal row of icon-only buttons (labels are tooltips).
  hlBar = document.createElement("div");
  hlBar.className = "hlToolbar";
  hlBar.hidden = true;

  const pen = document.createElement("button");
  pen.type = "button";
  pen.className = "hlPen";
  pen.textContent = "✏️";
  pen.title = t("hl_drag");
  pen.addEventListener("mousedown", (e) => {
    e.preventDefault();                       // keep the text selection alive
    hlDragBegin(e.clientX, e.clientY);
    document.addEventListener("mousemove", onHlMouseMove);
    document.addEventListener("mouseup", onHlMouseUp);
  });
  pen.addEventListener("touchstart", (e) => {
    if (!e.touches[0]) return;
    e.preventDefault();                       // keep selection + suppress scroll/synthetic click
    hlDragBegin(e.touches[0].clientX, e.touches[0].clientY);
    document.addEventListener("touchmove", onHlTouchMove, { passive: false });
    document.addEventListener("touchend", onHlTouchEnd);
    document.addEventListener("touchcancel", onHlTouchEnd);
  }, { passive: false });
  hlBar.appendChild(pen);

  const tools = document.createElement("div");
  tools.className = "hlTools";
  for (const c of HL_COLORS) {
    tools.appendChild(buildHlBtn(t("hl_" + c.style), () => applyHlStyle(c.style), { dot: c.dot }));
  }
  const div = document.createElement("div"); div.className = "hlDiv"; tools.appendChild(div);
  tools.appendChild(buildHlBtn(t("hl_underline"), () => applyHlStyle("underline"), { glyph: "U̲" }));
  tools.appendChild(buildHlBtn(t("hl_strike"), () => applyHlStyle("strike"), { glyph: "S̶" }));
  tools.appendChild(buildHlBtn(t("hl_comment"), () => applyHlStyle(hlLastStyle, true), { glyph: "💬" }));
  tools.appendChild(buildHlBtn(t("hl_clear"), () => clearHlSelection(), { glyph: "✕" }));
  tools.appendChild(buildHlBtn(t("btn_copy"), () => copyHlSelection(), { glyph: "📋" }));
  // Speak. No glyph here: speech.js drives this button's state by overwriting its
  // textContent with word labels ("Pause"/"Resume"/"Speak"), which would wreck a
  // 26px icon square — so .hlSpeak hides the text and draws the icon via ::before,
  // switching on the isSpeaking/isPaused classes speech.js already toggles.
  const speakBtn = buildHlBtn(t("btn_speak"), () => speakHlSelection(speakBtn));
  speakBtn.classList.add("hlSpeak");
  hlSpeakBtn = speakBtn;
  tools.appendChild(speakBtn);
  hlBar.appendChild(tools);

  // Keep the text selection alive when pressing the tool buttons (mousedown would
  // otherwise collapse it before the click fires). The pen handles its own.
  tools.addEventListener("mousedown", (e) => e.preventDefault());
  // On touch, a tap collapses the selection before the click fires, so snapshot
  // it on press (pointerdown fires for both mouse and touch, before collapse).
  tools.addEventListener("pointerdown", () => {
    const sel = window.getSelection();
    if (sel && sel.rangeCount && !sel.isCollapsed) hlCapturedRange = sel.getRangeAt(0).cloneRange();
    hlButtonPressing = true;                       // survive the tap-induced selectionchange
    setTimeout(() => { hlButtonPressing = false; }, 700);
  });
  // Expand only when the pointer actively moves over the bar — so it always
  // spawns as the small collapsed square, even if it appears under the cursor
  // (CSS :hover would expand it immediately in that case).
  hlBar.addEventListener("mouseover", () => hlBar.classList.add("expanded"));
  hlBar.addEventListener("mouseleave", () => {
    // Collapsing hides .hlTools entirely (display:none), which would take the stop
    // control away mid-reading — stay expanded until the speech ends.
    if (hlSpeakBtn && state.activeSpeechButton === hlSpeakBtn) return;
    hlBar.classList.remove("expanded");
  });
  document.body.appendChild(hlBar);

  // Note editor popover.
  hlPopover = document.createElement("div");
  hlPopover.className = "hlNotePopover";
  hlPopover.hidden = true;
  hlPopoverTextarea = document.createElement("textarea");
  hlPopoverTextarea.className = "hlNoteInput";
  hlPopoverTextarea.rows = 3;
  hlPopoverTextarea.placeholder = t("hl_notePlaceholder");
  // Color swatches — recolor the annotated highlight without leaving the editor.
  const noteColors = document.createElement("div");
  noteColors.className = "hlNoteColors";
  for (const c of HL_COLORS) {
    const sw = document.createElement("button");
    sw.type = "button";
    sw.className = "hlNoteSwatch";
    sw.dataset.style = c.style;
    sw.title = t("hl_" + c.style);
    sw.style.background = c.dot;
    sw.addEventListener("click", () => setHlNoteColor(c.style));
    noteColors.appendChild(sw);
  }
  const noteActions = document.createElement("div");
  noteActions.className = "hlNoteActions";
  const saveBtn = document.createElement("button");
  saveBtn.type = "button"; saveBtn.className = "hlNoteSave"; saveBtn.textContent = t("hl_noteSave");
  saveBtn.addEventListener("click", saveHlNote);
  const delBtn = document.createElement("button");
  delBtn.type = "button"; delBtn.className = "hlNoteDelete"; delBtn.textContent = t("hl_noteDelete");
  delBtn.addEventListener("click", deleteHlFromNote);
  noteActions.append(delBtn, saveBtn);
  hlPopover.append(noteColors, hlPopoverTextarea, noteActions);
  hlPopoverTextarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); saveHlNote(); }
    if (e.key === "Escape") { e.preventDefault(); hideHlPopover(); }
  });
  document.body.appendChild(hlPopover);

  // Selection finished (mouse or touch) → show the toolbar. Deferred so the
  // selection is final by the time we read it.
  const onSelectionEnd = (e) => {
    if (hlDragging || hlBar.contains(e.target) || hlPopover.contains(e.target)) return;
    setTimeout(() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) { hideHlToolbar(); return; }
      const range = sel.getRangeAt(0);
      const bodyOf = (node) => {
        const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
        return el?.closest(".markdownBody, .plainBody") || null;
      };
      const startBody = bodyOf(range.startContainer);
      const endBody = bodyOf(range.endContainer);
      // The selection must stay within one highlightable body, owned by a
      // registered host (chat bubble or knowledge-library block).
      if (!startBody || startBody !== endBody) { hideHlToolbar(); return; }
      const resolved = resolveHighlightHost(startBody);
      if (!resolved) { hideHlToolbar(); return; }
      hlTarget = { bodyEl: startBody, host: resolved.host, ctx: resolved.ctx };
      hlBar.classList.remove("expanded");   // always spawn collapsed
      // Keep a dragged position; otherwise anchor to the selection.
      if (hlManualPos) hlBar.hidden = false;
      else positionHlFloat(hlBar, range.getBoundingClientRect());
    }, 0);
  };
  document.addEventListener("mouseup", onSelectionEnd);
  document.addEventListener("touchend", onSelectionEnd);

  // Selection cleared → toolbar disappears (but not when the collapse was caused
  // by pressing a tool button on touch).
  document.addEventListener("selectionchange", () => {
    if (hlDragging || hlButtonPressing) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) hideHlToolbar();
  });

  // Click a 💬 marker → open its note editor. Document-level so it works in both
  // the chat and the knowledge-library preview (host resolved from the marker).
  document.addEventListener("click", (e) => {
    const mk = e.target.closest(".hlNoteMark");
    if (!mk) return;
    const resolved = resolveHighlightHost(mk.closest(".markdownBody, .plainBody"));
    if (!resolved) return;
    openHlNote(resolved.host, resolved.ctx, Number(mk.dataset.hlIdx));
  });

  registerHighlightHost(HL_CHAT_HOST);

  // Dismiss on outside interaction / scroll. A press outside the toolbar starts a
  // new selection (or clicks away), so drop any dragged position.
  const onOutsidePress = (e) => {
    if (hlBar.contains(e.target)) return;
    hlManualPos = false;
    if (!hlBar.hidden) hideHlToolbar();
    if (!hlPopover.hidden && !hlPopover.contains(e.target) && !e.target.closest(".hlNoteMark")) hideHlPopover();
  };
  document.addEventListener("mousedown", onOutsidePress);
  document.addEventListener("touchstart", onOutsidePress, { passive: true });
  dom.messagesEl.addEventListener("scroll", () => { hideHlToolbar(); hideHlPopover(); }, true);

  initHighlightsPanel();
}

// ── Highlights & notes browser (right-docked panel) ────────────────────────
let hlPanel = null, hlPanelBtn = null, hlPanelBadge = null, hlCountEl = null,
    hlListEl = null, hlChipsEl = null, hlSearchEl = null;
let hlPanelFilter = "all";   // "all" | "notes" | a color style
let hlPanelQuery = "";
let hlAvoidRaf = 0;
const HL_DECO_GLYPH = { underline: "U̲", strike: "S̶" };

// Keep the floating opener pinned to the right edge, but if its home spot covers
// a user bubble, drop it DOWN to the first visible assistant bubble's row (whose
// right side is empty, since assistant bubbles are left-aligned). rAF-throttled.
const HL_BTN_HOME_TOP = 10;
function avoidUserBubbles() {
  if (!hlPanelBtn || hlPanelBtn.hidden) return;
  const op = (hlPanelBtn.offsetParent || dom.messagesEl).getBoundingClientRect();
  const view = dom.messagesEl.getBoundingClientRect();
  const btnH = hlPanelBtn.offsetHeight || 34;
  const setTop = (px) => { hlPanelBtn.style.top = px + "px"; };
  const overlapsUser = () => {
    const rr = hlPanelBtn.getBoundingClientRect();
    for (const b of dom.messagesEl.querySelectorAll(".message.user")) {
      const br = b.getBoundingClientRect();
      if (br.bottom <= rr.top || br.top >= rr.bottom) continue;   // no vertical overlap
      if (br.right <= rr.left || br.left >= rr.right) continue;    // no horizontal overlap
      return true;
    }
    return false;
  };
  setTop(HL_BTN_HOME_TOP);
  if (!overlapsUser()) return;                       // home spot is clear
  // Blocked → try each visible assistant bubble from the top, park beside the
  // first one where the button no longer covers a user bubble.
  for (const a of dom.messagesEl.querySelectorAll(".message.assistant")) {
    const ar = a.getBoundingClientRect();
    if (ar.bottom <= view.top) continue;             // above the viewport
    if (ar.top >= view.bottom) break;                // below the viewport
    let top = ar.top - op.top + 6;
    top = Math.max(HL_BTN_HOME_TOP, Math.min(top, view.bottom - op.top - btnH - 8));
    setTop(top);
    if (!overlapsUser()) return;
  }
  setTop(HL_BTN_HOME_TOP);                            // no clear spot → back home
}
function scheduleAvoid() {
  if (hlAvoidRaf) return;
  hlAvoidRaf = requestAnimationFrame(() => { hlAvoidRaf = 0; avoidUserBubbles(); });
}
function hlColorDot(style) { return (HL_COLORS.find((x) => x.style === style) || {}).dot || null; }

// Every highlight in the active tab, in document order.
function gatherHighlights() {
  const tab = getActiveTab();
  const out = [];
  tab?.messages?.forEach((m, msgIndex) => {
    (m.highlights || []).forEach((hl, hlIdx) => {
      out.push({ msgIndex, hlIdx, style: hl.style, quote: hl.quote || "", note: hl.note || "" });
    });
  });
  return out;
}

// Scroll the chat to a highlight and flash it.
function jumpToHighlight(msgIndex, hlIdx) {
  const el = dom.messagesEl.querySelector(`.message[data-msg-index="${msgIndex}"] .hlmark[data-hl-idx="${hlIdx}"]`);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.add("hlFlash");
  setTimeout(() => el.classList.remove("hlFlash"), 1500);
}

function deleteHighlightFromPanel(msgIndex, hlIdx) {
  const msg = getActiveTab()?.messages?.[msgIndex];
  if (!msg?.highlights) return;
  msg.highlights.splice(hlIdx, 1);
  if (!msg.highlights.length) delete msg.highlights;
  saveChat();
  renderChat();   // re-renders chat + (via updateHighlightsUI) the panel
}

function renderHighlightsPanel(items = gatherHighlights()) {
  if (!hlListEl) return;
  const q = hlPanelQuery.trim().toLowerCase();
  const filtered = items.filter((it) => {
    if (hlPanelFilter === "notes") { if (!it.note) return false; }
    else if (hlPanelFilter !== "all" && it.style !== hlPanelFilter) return false;
    if (q && !(it.quote.toLowerCase().includes(q) || it.note.toLowerCase().includes(q))) return false;
    return true;
  });
  hlListEl.innerHTML = "";
  if (!filtered.length) {
    const empty = document.createElement("div");
    empty.className = "highlightsEmpty";
    empty.textContent = t("hl_panelEmpty");
    hlListEl.appendChild(empty);
    return;
  }
  for (const it of filtered) {
    const card = document.createElement("div");
    card.className = "hlCard";
    const top = document.createElement("div");
    top.className = "hlCardTop";
    const chip = document.createElement("span");
    const dot = hlColorDot(it.style);
    if (dot) { chip.className = "hlCardChip"; chip.style.background = dot; }
    else { chip.className = "hlCardChip deco"; chip.textContent = HL_DECO_GLYPH[it.style] || ""; }
    const quote = document.createElement("div");
    quote.className = "hlCardQuote";
    quote.textContent = it.quote;
    top.append(chip, quote);
    card.appendChild(top);
    if (it.note) {
      const note = document.createElement("div");
      note.className = "hlCardNote";
      note.textContent = "💬 " + it.note;
      card.appendChild(note);
    }
    const actions = document.createElement("div");
    actions.className = "hlCardActions";
    const mkBtn = (label, glyph, fn) => {
      const b = document.createElement("button");
      b.type = "button"; b.className = "hlCardBtn"; b.title = label; b.textContent = glyph;
      b.addEventListener("click", (e) => { e.stopPropagation(); fn(); });
      return b;
    };
    actions.appendChild(mkBtn(t("hl_comment"), "✎", () => { jumpToHighlight(it.msgIndex, it.hlIdx); openHlNote(HL_CHAT_HOST, { msgIndex: it.msgIndex }, it.hlIdx); }));
    actions.appendChild(mkBtn(t("btn_copy"), "📋", () => { if (it.quote) navigator.clipboard?.writeText(it.quote).catch(() => {}); }));
    actions.appendChild(mkBtn(t("hl_noteDelete"), "🗑", () => deleteHighlightFromPanel(it.msgIndex, it.hlIdx)));
    card.appendChild(actions);
    card.addEventListener("click", () => jumpToHighlight(it.msgIndex, it.hlIdx));
    hlListEl.appendChild(card);
  }
}

function openHighlightsPanel() { document.querySelector(".shell")?.classList.add("hlOpen"); renderHighlightsPanel(); }
function closeHighlightsPanel() { document.querySelector(".shell")?.classList.remove("hlOpen"); }
function toggleHighlightsPanel() {
  const shell = document.querySelector(".shell");
  if (shell?.classList.contains("hlOpen")) closeHighlightsPanel(); else openHighlightsPanel();
}

// Keep the opener badge + open panel in sync with the data. Called from renderChat.
function updateHighlightsUI() {
  if (!hlPanelBtn) return;
  const items = gatherHighlights();
  const n = items.length;
  hlPanelBtn.hidden = n === 0;
  hlPanelBadge.hidden = n === 0;
  hlPanelBadge.textContent = String(n);
  if (hlCountEl) hlCountEl.textContent = n ? `(${n})` : "";
  if (n === 0) closeHighlightsPanel();
  else if (document.querySelector(".shell")?.classList.contains("hlOpen")) renderHighlightsPanel(items);
  scheduleAvoid();
}

function initHighlightsPanel() {
  hlPanel = document.getElementById("highlightsPanel");
  hlPanelBtn = document.getElementById("highlightsPanelBtn");
  hlPanelBadge = document.getElementById("highlightsPanelBadge");
  hlCountEl = document.getElementById("highlightsCount");
  hlListEl = document.getElementById("highlightsList");
  hlChipsEl = document.getElementById("highlightsChips");
  hlSearchEl = document.getElementById("highlightsSearch");
  if (!hlPanel) return;
  document.getElementById("highlightsTitle").textContent = t("hl_panelTitle");
  hlSearchEl.placeholder = t("hl_searchPlaceholder");
  hlPanelBtn.title = t("hl_panelTitle");
  const addChip = (key, label, dot) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.dataset.filter = key;
    const active = key === hlPanelFilter;
    if (dot) {
      // Color filter → a round color swatch (not a text pill).
      chip.className = "highlightsChip colorChip" + (active ? " active" : "");
      chip.style.background = dot;
      chip.title = label || t("hl_" + key);
    } else {
      chip.className = "highlightsChip" + (active ? " active" : "");
      chip.textContent = label;
      chip.title = label || key;
    }
    chip.addEventListener("click", () => {
      hlPanelFilter = key;
      hlChipsEl.querySelectorAll(".highlightsChip").forEach((c) => c.classList.toggle("active", c.dataset.filter === key));
      renderHighlightsPanel();
    });
    hlChipsEl.appendChild(chip);
  };
  addChip("all", t("hl_filterAll"));
  addChip("notes", t("hl_filterNotes"));
  for (const c of HL_COLORS) addChip(c.style, "", c.dot);
  hlSearchEl.addEventListener("input", () => { hlPanelQuery = hlSearchEl.value; renderHighlightsPanel(); });
  hlPanelBtn.addEventListener("click", toggleHighlightsPanel);
  document.getElementById("highlightsCloseBtn")?.addEventListener("click", closeHighlightsPanel);
  // Re-check bubble collisions as the chat scrolls or the window resizes.
  dom.messagesEl.addEventListener("scroll", scheduleAvoid, { passive: true });
  window.addEventListener("resize", scheduleAvoid);
  updateHighlightsUI();
}