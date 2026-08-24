// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

// Shared mutable state and DOM references

export const dom = {
  messagesEl: document.querySelector("#messages"),
  scrollToBottomBtn: document.querySelector("#scrollToBottomBtn"),
  chatTabsEl: document.querySelector("#chatTabs"),
  addTab: document.querySelector("#addTab"),
  chatForm: document.querySelector("#chatForm"),
  chatArea: document.querySelector(".chatArea"),
  messageInput: document.querySelector("#messageInput"),
  modelSelect: document.querySelector("#modelSelect"),
  userName: document.querySelector("#userName"),
  userNameDropdownBtn: document.querySelector("#userNameDropdownBtn"),
  userNameDropdown: document.querySelector("#userNameDropdown"),
  persona: document.querySelector("#persona"),
  personalitySelect: document.querySelector("#personalitySelect"),
  presetSaveAs: document.querySelector("#presetSaveAs"),
  presetRename: document.querySelector("#presetRename"),
  presetDelete: document.querySelector("#presetDelete"),
  clearChat: document.querySelector("#clearChat"),
  fileInput: document.querySelector("#fileInput"),
  imagePreview: document.querySelector("#imagePreview"),
  previewImage: document.querySelector("#previewImage"),
  removeImage: document.querySelector("#removeImage"),
  filePreview: document.querySelector("#filePreview"),
  filePreviewName: document.querySelector("#filePreviewName"),
  removeFile: document.querySelector("#removeFile"),
  videoPreview: document.querySelector("#videoPreview"),
  videoPreviewName: document.querySelector("#videoPreviewName"),
  removeVideo: document.querySelector("#removeVideo"),
  audioPreview: document.querySelector("#audioPreview"),
  audioPreviewName: document.querySelector("#audioPreviewName"),
  removeAudio: document.querySelector("#removeAudio"),
  voiceSelect: document.querySelector("#voiceSelect"),
  autoSpeakCheckbox: document.querySelector("#autoSpeak"),
  speechRateInput: document.querySelector("#speechRate"),
  speechRateValue: document.querySelector("#speechRateValue"),
  imageModelSelect: document.querySelector("#imageModelSelect"),
  defaultImageSize: document.querySelector("#defaultImageSize"),
  requestTimeoutInput: document.querySelector("#requestTimeout"),
  requestTimeoutValue: document.querySelector("#requestTimeoutValue"),
  imageGenOptions: document.querySelector("#imageGenOptions"),
  comfyModelSelect: document.querySelector("#comfyModelSelect"),
  comfyModelPickBtn: document.querySelector("#comfyModelPickBtn"),
  comfyModelPickLabel: document.querySelector("#comfyModelPickLabel"),
  comfyUrlDisplay: document.querySelector("#comfyUrlDisplay"),
  comfyParamsBtn: document.querySelector("#comfyParamsBtn"),
  comfyMultiHint: document.querySelector("#comfyMultiHint"),
  comfyParamsModal: document.querySelector("#comfyParamsModal"),
  comfyParamsClose: document.querySelector("#comfyParamsClose"),
  comfyParamsReset: document.querySelector("#comfyParamsReset"),
  comfyModelInfo: document.querySelector("#comfyModelInfo"),
  comfyParamPositive: document.querySelector("#comfyParamPositive"),
  comfyParamNegative: document.querySelector("#comfyParamNegative"),
  comfyParamSampler: document.querySelector("#comfyParamSampler"),
  comfyParamScheduler: document.querySelector("#comfyParamScheduler"),
  comfyParamSteps: document.querySelector("#comfyParamSteps"),
  comfyParamCfg: document.querySelector("#comfyParamCfg"),
  comfyParamGuidance: document.querySelector("#comfyParamGuidance"),
  comfyParamImageCfg: document.querySelector("#comfyParamImageCfg"),
  comfyParamDenoise: document.querySelector("#comfyParamDenoise"),
  comfyParamPrecision: document.querySelector("#comfyParamPrecision"),
  comfyParamLength: document.querySelector("#comfyParamLength"),
  comfyParamLengthLabel: document.querySelector("#comfyParamLengthLabel"),
  comfyParamLengthHint: document.querySelector("#comfyParamLengthHint"),
  comfyParamUpscaleTarget: document.querySelector("#comfyParamUpscaleTarget"),
  comfyParamUpscaleTargetLabel: document.querySelector("#comfyParamUpscaleTargetLabel"),
  comfyParamRestoreModel: document.querySelector("#comfyParamRestoreModel"),
  comfyParamRestoreModelLabel: document.querySelector("#comfyParamRestoreModelLabel"),
  comfyParamSharpen: document.querySelector("#comfyParamSharpen"),
  comfyParamControlPrep: document.querySelector("#comfyParamControlPrep"),
  comfyParamControlPrepLabel: document.querySelector("#comfyParamControlPrepLabel"),
  comfyParamControlStrength: document.querySelector("#comfyParamControlStrength"),
  comfyParamControlStrengthLabel: document.querySelector("#comfyParamControlStrengthLabel"),
  comfyParamLayerCount: document.querySelector("#comfyParamLayerCount"),
  comfyParamLayerCountLabel: document.querySelector("#comfyParamLayerCountLabel"),
  comfyParamCamStrength: document.querySelector("#comfyParamCamStrength"),
  comfyParamCamStrengthLabel: document.querySelector("#comfyParamCamStrengthLabel"),
  comfyCamPicker: document.querySelector("#comfyCamPicker"),
  comfyCamAzimuth: document.querySelector("#comfyCamAzimuth"),
  comfyCamElevation: document.querySelector("#comfyCamElevation"),
  comfyCamDistance: document.querySelector("#comfyCamDistance"),
  comfyCamAzimuthCaption: document.querySelector("#comfyCamAzimuthCaption"),
  comfyCamElevationCaption: document.querySelector("#comfyCamElevationCaption"),
  comfyCamPrompt: document.querySelector("#comfyCamPrompt"),
  comfyParamSharpenLabel: document.querySelector("#comfyParamSharpenLabel"),
  comfyParamFps: document.querySelector("#comfyParamFps"),
  comfyParamTargetFps: document.querySelector("#comfyParamTargetFps"),
  comfyParamInterpMethod: document.querySelector("#comfyParamInterpMethod"),
  comfyParamTimeout: document.querySelector("#comfyParamTimeout"),
  comfyParamLyrics: document.querySelector("#comfyParamLyrics"),
  comfyParamMusicSeconds: document.querySelector("#comfyParamMusicSeconds"),
  comfyParamMusicCfg: document.querySelector("#comfyParamMusicCfg"),
  comfyParamMusicTiled: document.querySelector("#comfyParamMusicTiled"),
  comfyParamMeshDetail: document.querySelector("#comfyParamMeshDetail"),
  comfyParamShapeTokens: document.querySelector("#comfyParamShapeTokens"),
  comfyParamPaintMesh: document.querySelector("#comfyParamPaintMesh"),
  comfyParamPaintQuality: document.querySelector("#comfyParamPaintQuality"),
  comfyParamKeepBackground: document.querySelector("#comfyParamKeepBackground"),
  comfyParamMeshGaussians: document.querySelector("#comfyParamMeshGaussians"),
  comfyParamMogeDetail: document.querySelector("#comfyParamMogeDetail"),
  comfyParamMogeFov: document.querySelector("#comfyParamMogeFov"),
  comfyParamH3Lora: document.querySelector("#comfyParamH3Lora"),
  comfyParamH3LoraLabel: document.querySelector("#comfyParamH3LoraLabel"),
  comfyParamH3LoraStrength: document.querySelector("#comfyParamH3LoraStrength"),
  comfyParamH3LoraStrengthLabel: document.querySelector("#comfyParamH3LoraStrengthLabel"),
  comfyParamSolAttn: document.querySelector("#comfyParamSolAttn"),
  comfyParamSolAttnLabel: document.querySelector("#comfyParamSolAttnLabel"),
  comfyParamSolTau: document.querySelector("#comfyParamSolTau"),
  comfyParamSolTauLabel: document.querySelector("#comfyParamSolTauLabel"),
  comfyParamSolChunkFF: document.querySelector("#comfyParamSolChunkFF"),
  comfyParamSolChunkFFLabel: document.querySelector("#comfyParamSolChunkFFLabel"),
  comfyParamH3Clip: document.querySelector("#comfyParamH3Clip"),
  comfyParamH3ClipLabel: document.querySelector("#comfyParamH3ClipLabel"),
  comfyParamPanoModel: document.querySelector("#comfyParamPanoModel"),
  comfyParamPanoLora: document.querySelector("#comfyParamPanoLora"),
  comfyParamPanoLoraStrength: document.querySelector("#comfyParamPanoLoraStrength"),
  comfyParamPanoProj: document.querySelector("#comfyParamPanoProj"),
  comfyParamPanoFov: document.querySelector("#comfyParamPanoFov"),
  comfyParamPanoOutpaint: document.querySelector("#comfyParamPanoOutpaint"),
  comfyParamPanoRefine: document.querySelector("#comfyParamPanoRefine"),
  comfyParamMogeSubject: document.querySelector("#comfyParamMogeSubject"),
  comfyParamUpscaleDenoise: document.querySelector("#comfyParamUpscaleDenoise"),
  comfyParamUpscaleModel: document.querySelector("#comfyParamUpscaleModel"),
  comfyParamTorchCompile: document.querySelector("#comfyParamTorchCompile"),
  comfyParamScailMemory: document.querySelector("#comfyParamScailMemory"),
  comfyParamVideoCodec: document.querySelector("#comfyParamVideoCodec"),
  comfyParamVideoCrf: document.querySelector("#comfyParamVideoCrf"),
  comfyModelHint: document.querySelector("#comfyModelHint"),
  comfyModelWarn: document.querySelector("#comfyModelWarn"),
  comfyParamBerniniMode: document.querySelector("#comfyParamBerniniMode"),
  comfyParamBerniniTask: document.querySelector("#comfyParamBerniniTask"),
  comfyParamEasyCache: document.querySelector("#comfyParamEasyCache"),
  comfyParamNoAudio: document.querySelector("#comfyParamNoAudio"),
  comfyParamH3RefSize: document.querySelector("#comfyParamH3RefSize"),
  comfyParamDanceStyle: document.querySelector("#comfyParamDanceStyle"),
  comfyParamDanceAmplitude: document.querySelector("#comfyParamDanceAmplitude"),
  comfyParamDanceDuration: document.querySelector("#comfyParamDanceDuration"),
  comfyParamDanceQuality: document.querySelector("#comfyParamDanceQuality"),
  comfyParamRefMaxSize: document.querySelector("#comfyParamRefMaxSize"),
  comfyParamPhantomImgCfg: document.querySelector("#comfyParamPhantomImgCfg"),
  comfyParamPhantomTurbo: document.querySelector("#comfyParamPhantomTurbo"),
  comfyParamLtxLora: document.querySelector("#comfyParamLtxLora"),
  comfyParamLtxLoraStrength: document.querySelector("#comfyParamLtxLoraStrength"),
  comfyParamKrea2Lora: document.querySelector("#comfyParamKrea2Lora"),
  comfyParamKrea2LoraStrength: document.querySelector("#comfyParamKrea2LoraStrength"),
  comfyParamRelight: document.querySelector("#comfyParamRelight"),
  comfyParamScailSubject: document.querySelector("#comfyParamScailSubject"),
  comfyParamScailRefSubject: document.querySelector("#comfyParamScailRefSubject"),
  comfyParamScailThreshold: document.querySelector("#comfyParamScailThreshold"),
  comfyParamScailMaxObjects: document.querySelector("#comfyParamScailMaxObjects"),
  comfyParamScailIndices: document.querySelector("#comfyParamScailIndices"),
  comfyParamScailSortBy: document.querySelector("#comfyParamScailSortBy"),
  comfyParamScailRecipe: document.querySelector("#comfyParamScailRecipe"),
  comfyParamScailWindow: document.querySelector("#comfyParamScailWindow"),
  comfyParamScailWindowWarn: document.querySelector("#comfyParamScailWindowWarn"),
  comfyParamPoseStrength: document.querySelector("#comfyParamPoseStrength"),
  comfyParamPoseStart: document.querySelector("#comfyParamPoseStart"),
  comfyParamPoseEnd: document.querySelector("#comfyParamPoseEnd"),
  comfyMaskPointBtn: document.querySelector("#comfyMaskPointBtn"),
  comfyTrackBtn: document.querySelector("#comfyTrackBtn"),
  comfyTrackLabel: document.querySelector("#comfyTrackLabel"),
  trackModal: document.querySelector("#trackModal"),
  trackModalClose: document.querySelector("#trackModalClose"),
  trackCanvas: document.querySelector("#trackCanvas"),
  trackUndo: document.querySelector("#trackUndo"),
  trackClear: document.querySelector("#trackClear"),
  trackCancel: document.querySelector("#trackCancel"),
  trackSave: document.querySelector("#trackSave"),
  comfyMaskPointLabel: document.querySelector("#comfyMaskPointLabel"),
  maskPointModal: document.querySelector("#maskPointModal"),
  maskPointClose: document.querySelector("#maskPointClose"),
  aboutBtn: document.querySelector("#aboutBtn"),
  aboutModal: document.querySelector("#aboutModal"),
  aboutModalClose: document.querySelector("#aboutModalClose"),
  maskPointHint: document.querySelector("#maskPointHint"),
  maskPointStage: document.querySelector("#maskPointStage"),
  maskPointImage: document.querySelector("#maskPointImage"),
  maskPointMarker: document.querySelector("#maskPointMarker"),
  maskPointClear: document.querySelector("#maskPointClear"),
  maskPointConfirm: document.querySelector("#maskPointConfirm"),
  llmUrlDisplay: document.querySelector("#llmUrlDisplay"),
  imageUrlDisplay: document.querySelector("#imageUrlDisplay"),
  modeToggle: document.querySelector("#modeToggle"),
  themeColorPicker: document.querySelector("#themeColorPicker"),
  avatarContainer: document.querySelector("#avatarContainer"),
  avatarFace: document.querySelector("#avatarFace"),
  avatarSvg: document.querySelector("#avatarSvg"),
  avatarCloudBadge: document.querySelector("#avatarCloudBadge"),
  avatarPicker: document.querySelector("#avatarPicker"),
  sendButton: document.querySelector("#sendButton"),
  sendStatus: document.querySelector("#sendStatus"),
  bgJobsBtn: document.querySelector("#bgJobsBtn"),
  stopTranslateBtn: document.querySelector("#stopTranslateBtn"),
  commandPopup: document.querySelector("#commandPopup"),
  mentionPopup: document.querySelector("#mentionPopup"),
  aiName: document.querySelector("#aiName"),
  uiLanguageSelect: document.querySelector("#uiLanguageSelect"),
  promptLanguageSelect: document.querySelector("#promptLanguageSelect"),
  allowCloudModels: document.querySelector("#allowCloudModels"),
  showThinkingCheckbox: document.querySelector("#showThinking"),
  sendTimeToggle: document.querySelector("#sendTime"),
  toolsToggle: document.querySelector("#toolsToggle"),
  libraryToolToggle: document.querySelector("#libraryToolToggle"),
  browserToolToggle: document.querySelector("#browserToolToggle"),
  browserLaunchBtn: document.querySelector("#browserLaunchBtn"),
  numCtxSelect: document.querySelector("#numCtxSelect"),
  numCtxDisplay: document.querySelector("#numCtxDisplay"),
  llmParamsBtn: document.querySelector("#llmParamsBtn"),
  llmParamsModal: document.querySelector("#llmParamsModal"),
  llmParamsClose: document.querySelector("#llmParamsClose"),
  llmMaxImages: document.querySelector("#llmMaxImages"),
  llmMaxMessages: document.querySelector("#llmMaxMessages"),
  llmTimeout: document.querySelector("#llmTimeout"),
  comfyOverriddenWarn: document.querySelector("#comfyOverriddenWarn"),
  personaBtn: document.querySelector("#personaBtn"),
  personaModal: document.querySelector("#personaModal"),
  personaModalClose: document.querySelector("#personaModalClose"),
  personaSummary: document.querySelector("#personaSummary"),
  pdfEngineLabel: document.querySelector("#pdfEngineLabel"),
  pdfEngineSelect: document.querySelector("#pdfEngineSelect"),
  pdfEngineOptMineru: document.querySelector("#pdfEngineOptMineru"),
  pdfEngineOptUnlimited: document.querySelector("#pdfEngineOptUnlimited"),
  embedModelSelect: document.querySelector("#embedModelSelect"),
  libraryDistillToggle: document.querySelector("#libraryDistillToggle"),
  libraryRerankToggle: document.querySelector("#libraryRerankToggle"),
  libraryAskParamsBtn: document.querySelector("#libraryAskParamsBtn"),
  libraryAskParamsModal: document.querySelector("#libraryAskParamsModal"),
  libraryAskParamsClose: document.querySelector("#libraryAskParamsClose"),
  libraryAskTopK: document.querySelector("#libraryAskTopK"),
  libraryAskImages: document.querySelector("#libraryAskImages"),
  libraryAskBudget: document.querySelector("#libraryAskBudget"),
  memoryList: document.querySelector("#memoryList"),
  memoryInput: document.querySelector("#memoryInput"),
  memoryAddBtn: document.querySelector("#memoryAddBtn"),
  memoryExtractBtn: document.querySelector("#memoryExtractBtn"),
  dailyGreetingToggle: document.querySelector("#dailyGreetingToggle"),
  dailyGreetingTime: document.querySelector("#dailyGreetingTime"),
  idleNudgeToggle: document.querySelector("#idleNudgeToggle"),
  idleNudgeMinutes: document.querySelector("#idleNudgeMinutes"),
  reminderList: document.querySelector("#reminderList"),
  contextMeter: document.querySelector("#contextMeter"),
  contextMeterFill: document.querySelector("#contextMeterFill"),
  contextMeterText: document.querySelector("#contextMeterText"),
};

export const state = {
  tabs: [],
  activeTabId: null,
  customPresets: [],                 // user-authored personality presets: [{ id:"cp_…", name, text }] — see presets.js. Persisted in SETTINGS_KEY.
  currentAbortController: null,
  imageGenAbortController: null,
  selectedImage: null,
  selectedFile: null,
  selectedVideo: null,
  selectedAudio: null,               // staged speech audio (InfiniteTalk dubbing): { base64, mime, name, duration }
  pendingTracks: null,               // ✏️ motion trajectories for LTX-2.5 Motion Track: [[{x,y},…],…] normalized 0-1 (session-only; cleared when another model is picked)
  activeSpeechButton: null,
  speechAbortController: null,
  activeTranslationAbort: null,
  avatarState: "idle",
  blinkTimer: null,
  expressionTimer: null,
  currentThemeMode: "system",
  currentThemeAccent: "ocean",
  // Composer editor mode (the ✏️ toggle beside 🎨): Enter makes a new line instead of
  // sending, and the input box opens to half the chat window. Session-only.
  composerEditMode: false,
  commandActiveIndex: 0,
  streamingInfo: null,
  pendingGen: null,                  // in-progress image/video/audio gen: { tabId, label, insertIndex }
  bgJobs: [],                        // background-job queue. Per-worker FIFO lanes run in PARALLEL. See bg-jobs.js.
  bgLanes: new Set(),                // workerIds whose serial runner loop is currently draining (parallel across lanes)
  bgWorkers: [],                     // ComfyUI worker endpoints: { id, url, label, enabled, online, models:{image,edit,video,videoIn,multiImage} }
  bgDrawerOpen: false,               // whether the Background Jobs drawer is visible
  comfyModelGroups: [],              // [{key,items}] per model type — feeds the 4-column picker
  comfyVideoModels: new Set(),       // ComfyUI model names that generate video
  comfyMusicModels: new Set(),       // ComfyUI model names whose output is AUDIO ONLY (MiniMax Music 3).
                                     // NOT comfyAudioModels — that one is video models whose clip has sound.
  comfySamplerTunable: new Set(),    // video models whose ⚙ sampler/steps/cfg reach the graph (server-decided)
  comfyVideoInModels: new Set(),     // ComfyUI video models that need a SOURCE video (fps follows source)
  comfyVideoOptionalModels: new Set(), // …of those, the ones a source video is OPTIONAL for (bernini: image alone → i2v)
  comfyAudioInModels: new Set(),     // …video-in models that ALSO need a SPEECH AUDIO file (InfiniteTalk dubbing)
  comfyMultiImageModels: new Set(),  // ComfyUI edit models that accept 2-3 reference images
  comfyRefMaskModels: new Set(),     // models whose attachments are REFERENCES → each staged image gets a 🖌 subject cutout
  foldNextCommandBubble: false,      // set by the ▶ chip on a ```imagine block: the command bubble the next send creates is a RECEIPT of a prompt already on screen (the draft right above it), so it arrives folded — collapsed, and out of the LLM context. One-shot: consumed by the next sendMessage
  scrollPin: null,                   // when set (resend/edit in place), auto-scroll holds this scrollTop instead of jumping to the bottom
  _pinClearTimer: null,              // delayed release of scrollPin once generation fully ends
  stickToBottom: true,               // streaming auto-scroll only while the user sits near the bottom (so they can scroll up mid-generation)
  // Qwen 3D Camera: which of the LoRA's 96 poses the ⚙ dial is on. Kept as KEYS, not
  // as the trained English phrase — the server owns that vocabulary (cameraPrompt).
  camAzimuth: "front",
  camElevation: "eye",
  camDistance: "medium",
  animateMaskPoint: null,            // Wan Animate REPLACE: user's ⚙-picked {x,y} (0–1) of which person to replace; null = auto center
  comfyVramGib: null,                // usable VRAM (GiB) of the target ComfyUI box, from /system_stats; scales Wan Animate's per-pass frame cap (multi-worker → MIN across lanes, for OOM safety). null = unknown → 32GB reference table
  comfyDevices: [],                  // detected ComfyUI GPU(s) for display in the model picker: [{ gpuName, vramGib, hostname }] — one per online endpoint/lane
};

// ── Panel overlays (archive / library / gallery) ───────────────────────────
// All three fill the chat panel edge-to-edge at the same z-index, so each one
// completely covers the others. Only ONE may carry .isOpen at a time — and not just
// for tidiness: .isOpen is `display: flex`, so a covered-but-open panel stays in the
// render tree and Safari's Find still matches (and scroll-highlights) text nobody
// can see.
//
// Opening goes through here so the set can never drift again: this replaces pairwise
// "close the other one" calls at each open site, which is exactly how the gallery
// ended up closing neither of the other two.
const PANEL_OVERLAYS = [
  { id: "archiveOverlay", btn: "retrieveChat" },
  { id: "libraryOverlay", btn: "libraryBtn" },
  { id: "galleryOverlay", btn: "galleryBtn" },
];

// Mirror each panel's open state onto its toolbar button: .isActive for the pressed
// look, aria-pressed so it reads as a toggle to assistive tech.
export function syncPanelOverlayButtons() {
  for (const o of PANEL_OVERLAYS) {
    const btn = document.getElementById(o.btn);
    if (!btn) continue;
    const open = !!document.getElementById(o.id)?.classList.contains("isOpen");
    btn.classList.toggle("isActive", open);
    btn.setAttribute("aria-pressed", open ? "true" : "false");
  }
}

export function isPanelOverlayOpen(id) {
  return !!document.getElementById(id)?.classList.contains("isOpen");
}

// Show exactly one panel overlay and close the rest.
export function openPanelOverlay(id) {
  for (const o of PANEL_OVERLAYS) {
    document.getElementById(o.id)?.classList.toggle("isOpen", o.id === id);
  }
  syncPanelOverlayButtons();
}

export function closePanelOverlay(id) {
  document.getElementById(id)?.classList.remove("isOpen");
  syncPanelOverlayButtons();
}

// ── Shared video audio preference ──────────────────────────────────────────
// One mute/volume setting for EVERY player: the inline bubble clips and the
// full-window viewer. Whatever the user last chose — our slider/icon, the native
// control bar, or the native control bar while in OS fullscreen (same element, same
// `volumechange` event) — becomes the setting the next clip plays at.
//
// Session-scoped on purpose, not persisted: a fresh page load starts muted again so
// audio never surprises the user, which is why every player defaulted to muted.
export const videoAudio = { muted: true, volume: 0.5 };

// Push the shared setting onto a <video>. Safe to call repeatedly (e.g. on play).
export function applyVideoAudio(video) {
  if (!video) return;
  video.muted = videoAudio.muted;
  video.volume = videoAudio.volume;
}

// Record this player's mute/volume changes into the shared setting. No "is this my
// own write?" flag is needed: applyVideoAudio only ever sets the values the pref
// already holds, so the echo it provokes matches and falls out at the first check.
export function trackVideoAudio(video) {
  if (!video) return;
  video.addEventListener("volumechange", () => {
    if (video.muted === videoAudio.muted && video.volume === videoAudio.volume) return;
    // Unmuting a slider that sits at 0 would be silent — snap to 50% instead. The
    // resulting write comes back through here and is what actually gets recorded.
    if (!video.muted && video.volume === 0) { video.volume = 0.5; return; }
    videoAudio.muted = video.muted;
    videoAudio.volume = video.volume === 0 ? 0.5 : video.volume;
  });
}

// ── Programmatic-scroll guard ──────────────────────────────────────────────
// A native scrollbar drag fires NO wheel/touch events — only 'scroll' — so the
// only way to tell a genuine user scroll from our own programmatic scroll is to
// record what we last set and when. onMessagesScroll uses this to release the
// resend/edit pin ONLY on a real user scroll, never on a reveal/auto scroll.
let _autoScrollTop = -1;
let _autoScrollAt = 0;
// Set scrollTop programmatically and remember the (post-clamp) value + timestamp.
// Exported so renderChat's position-restore counts as programmatic too.
export function setScrollTop(top) {
  const el = dom.messagesEl;
  if (!el) return;
  el.scrollTop = top;
  _autoScrollTop = Math.round(el.scrollTop);
  _autoScrollAt = performance.now();
}

// Auto-scroll the chat. Normally jumps to the bottom (new content), but while a
// resend/edit regenerates in place, state.scrollPin holds the position so the
// view doesn't jump away from the message being edited.
export function scrollChatToEnd() {
  setScrollTop(state.scrollPin != null ? state.scrollPin : dom.messagesEl.scrollHeight);
  refreshScrollState();
}

// While a resend/edit holds the view (scrollPin set), don't jump to the bottom —
// but if the regenerating reply grew below the fold, scroll DOWN just enough to
// reveal its newest text (never past the reply into the content after it, and
// never up). Keeps scrollPin synced so it doesn't snap back.
export function revealStreamingTail() {
  const el = dom.messagesEl;
  if (!el) return;
  const bubble = el.querySelector(".streaming-bubble");
  if (!bubble) return;
  const overflow = bubble.getBoundingClientRect().bottom - el.getBoundingClientRect().bottom;
  if (overflow > 0) {
    setScrollTop(el.scrollTop + overflow + 12);
    state.scrollPin = el.scrollTop;
  }
}

// Streaming/progress auto-scroll. Three cases: pinned (resend/edit) → reveal the
// growing reply's tail without jumping; at the bottom → follow the stream down;
// scrolled up to read → leave the view alone. The pin is released only by a real
// user scroll (onMessagesScroll), so reveal can never snap to the conversation end.
export function scrollChatToEndIfPinned() {
  if (state.scrollPin != null) revealStreamingTail();
  else if (state.stickToBottom) scrollChatToEnd();
}

// The chat's 'scroll' event handler. Recomputes scroll state, and — crucially —
// releases the resend/edit pin when the USER (not our own code) scrolls to the
// bottom, so the stream starts following instead of the reveal holding them back.
export function onMessagesScroll() {
  const el = dom.messagesEl;
  if (!el) return;
  const programmatic = (performance.now() - _autoScrollAt < 200) && Math.abs(el.scrollTop - _autoScrollTop) <= 2;
  refreshScrollState();
  if (!programmatic && state.scrollPin != null && state.stickToBottom) state.scrollPin = null;
}

// Pending reveal of the jump-to-bottom button (see refreshScrollState).
let scrollBtnRevealTimer = null;
const SCROLL_BTN_REVEAL_MS = 5000;

// Recompute "pinned to bottom?" from live geometry and toggle the floating
// jump-to-bottom button. Called on user scroll and after each auto-scroll.
// While reading aloud the button stays hidden: the highlight auto-scroll
// intentionally follows sentences far above the bottom, and jumping down
// mid-read would fight it.
//
// Leaving the bottom reveals the button only after a 5s dwell, so briefly
// scrolling up doesn't flash it. Returning to the bottom hides it immediately.
export function refreshScrollState() {
  const el = dom.messagesEl;
  if (!el) return;
  const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
  state.stickToBottom = distance <= 40;
  // NOTE: do NOT release scrollPin here. refreshScrollState runs for PROGRAMMATIC
  // scrolls too (scrollChatToEnd/renderChat), so clearing the pin on "near bottom"
  // made a mid-conversation resend snap to the very bottom. The pin is released in
  // scrollChatToEndIfPinned instead, which only runs on the streaming auto-scroll.
  const btn = dom.scrollToBottomBtn;
  if (!btn) return;

  const eligible = distance > 80 && !state.activeSpeechButton;
  if (!eligible) {
    // Back at the bottom (or reading aloud): hide at once, drop any pending reveal.
    clearTimeout(scrollBtnRevealTimer);
    scrollBtnRevealTimer = null;
    btn.hidden = true;
    return;
  }
  // Arm the reveal once. This runs on EVERY scroll event, so restarting the
  // timer here would let continuous scrolling postpone the button forever.
  if (btn.hidden && scrollBtnRevealTimer === null) {
    scrollBtnRevealTimer = setTimeout(() => {
      scrollBtnRevealTimer = null;
      // Re-check on fire: the user may have returned to the bottom meanwhile.
      const d = el.scrollHeight - el.scrollTop - el.clientHeight;
      if (d > 80 && !state.activeSpeechButton) btn.hidden = false;
    }, SCROLL_BTN_REVEAL_MS);
  }
}