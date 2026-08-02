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
  comfyParamFps: document.querySelector("#comfyParamFps"),
  comfyParamTimeout: document.querySelector("#comfyParamTimeout"),
  comfyParamMeshDetail: document.querySelector("#comfyParamMeshDetail"),
  comfyParamShapeTokens: document.querySelector("#comfyParamShapeTokens"),
  comfyParamPaintMesh: document.querySelector("#comfyParamPaintMesh"),
  comfyParamPaintQuality: document.querySelector("#comfyParamPaintQuality"),
  comfyParamKeepBackground: document.querySelector("#comfyParamKeepBackground"),
  comfyParamMeshGaussians: document.querySelector("#comfyParamMeshGaussians"),
  comfyParamMogeDetail: document.querySelector("#comfyParamMogeDetail"),
  comfyParamMogeFov: document.querySelector("#comfyParamMogeFov"),
  comfyParamPanoModel: document.querySelector("#comfyParamPanoModel"),
  comfyParamPanoLora: document.querySelector("#comfyParamPanoLora"),
  comfyParamPanoLoraStrength: document.querySelector("#comfyParamPanoLoraStrength"),
  comfyParamPanoProj: document.querySelector("#comfyParamPanoProj"),
  comfyParamPanoFov: document.querySelector("#comfyParamPanoFov"),
  comfyParamPanoOutpaint: document.querySelector("#comfyParamPanoOutpaint"),
  comfyParamPanoRefine: document.querySelector("#comfyParamPanoRefine"),
  comfyParamMogeSubject: document.querySelector("#comfyParamMogeSubject"),
  comfyParamTargetFps: document.querySelector("#comfyParamTargetFps"),
  comfyParamInterpMethod: document.querySelector("#comfyParamInterpMethod"),
  comfyParamUpscaleDenoise: document.querySelector("#comfyParamUpscaleDenoise"),
  comfyParamUpscaleModel: document.querySelector("#comfyParamUpscaleModel"),
  comfyParamTorchCompile: document.querySelector("#comfyParamTorchCompile"),
  comfyParamVideoCodec: document.querySelector("#comfyParamVideoCodec"),
  comfyParamVideoCrf: document.querySelector("#comfyParamVideoCrf"),
  comfyModelHint: document.querySelector("#comfyModelHint"),
  comfyModelWarn: document.querySelector("#comfyModelWarn"),
  comfyParamBerniniMode: document.querySelector("#comfyParamBerniniMode"),
  comfyParamBerniniTask: document.querySelector("#comfyParamBerniniTask"),
  comfyParamDanceStyle: document.querySelector("#comfyParamDanceStyle"),
  comfyParamDanceAmplitude: document.querySelector("#comfyParamDanceAmplitude"),
  comfyParamDanceDuration: document.querySelector("#comfyParamDanceDuration"),
  comfyParamDanceQuality: document.querySelector("#comfyParamDanceQuality"),
  comfyParamRefMaxSize: document.querySelector("#comfyParamRefMaxSize"),
  comfyParamPhantomImgCfg: document.querySelector("#comfyParamPhantomImgCfg"),
  comfyParamPhantomTurbo: document.querySelector("#comfyParamPhantomTurbo"),
  comfyParamLtxLora: document.querySelector("#comfyParamLtxLora"),
  comfyParamLtxLoraStrength: document.querySelector("#comfyParamLtxLoraStrength"),
  comfyParamRelight: document.querySelector("#comfyParamRelight"),
  comfyParamScailSubject: document.querySelector("#comfyParamScailSubject"),
  comfyParamScailRefSubject: document.querySelector("#comfyParamScailRefSubject"),
  comfyParamScailThreshold: document.querySelector("#comfyParamScailThreshold"),
  comfyParamScailMaxObjects: document.querySelector("#comfyParamScailMaxObjects"),
  comfyParamScailIndices: document.querySelector("#comfyParamScailIndices"),
  comfyParamScailSortBy: document.querySelector("#comfyParamScailSortBy"),
  comfyParamPoseStrength: document.querySelector("#comfyParamPoseStrength"),
  comfyParamPoseStart: document.querySelector("#comfyParamPoseStart"),
  comfyParamPoseEnd: document.querySelector("#comfyParamPoseEnd"),
  comfyMaskPointBtn: document.querySelector("#comfyMaskPointBtn"),
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
  showThinkingCheckbox: document.querySelector("#showThinking"),
  sendTimeToggle: document.querySelector("#sendTime"),
  toolsToggle: document.querySelector("#toolsToggle"),
  libraryToolToggle: document.querySelector("#libraryToolToggle"),
  browserToolToggle: document.querySelector("#browserToolToggle"),
  browserLaunchBtn: document.querySelector("#browserLaunchBtn"),
  numCtxSelect: document.querySelector("#numCtxSelect"),
  numCtxDisplay: document.querySelector("#numCtxDisplay"),
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
  activeSpeechButton: null,
  speechAbortController: null,
  activeTranslationAbort: null,
  avatarState: "idle",
  blinkTimer: null,
  expressionTimer: null,
  currentThemeMode: "system",
  currentThemeAccent: "ocean",
  commandActiveIndex: 0,
  streamingInfo: null,
  pendingGen: null,                  // in-progress image/video/audio gen: { tabId, label, insertIndex }
  bgJobs: [],                        // background-job queue. Per-worker FIFO lanes run in PARALLEL. See bg-jobs.js.
  bgLanes: new Set(),                // workerIds whose serial runner loop is currently draining (parallel across lanes)
  bgWorkers: [],                     // ComfyUI worker endpoints: { id, url, label, enabled, online, models:{image,edit,video,videoIn,multiImage} }
  bgDrawerOpen: false,               // whether the Background Jobs drawer is visible
  comfyModelGroups: [],              // [{key,items}] per model type — feeds the 4-column picker
  comfyVideoModels: new Set(),       // ComfyUI model names that generate video
  comfySamplerTunable: new Set(),    // video models whose ⚙ sampler/steps/cfg reach the graph (server-decided)
  comfyVideoInModels: new Set(),     // ComfyUI video models that need a SOURCE video (fps follows source)
  comfyVideoOptionalModels: new Set(), // …of those, the ones a source video is OPTIONAL for (bernini: image alone → i2v)
  comfyAudioInModels: new Set(),     // …video-in models that ALSO need a SPEECH AUDIO file (InfiniteTalk dubbing)
  comfyMultiImageModels: new Set(),  // ComfyUI edit models that accept 2-3 reference images
  scrollPin: null,                   // when set (resend/edit in place), auto-scroll holds this scrollTop instead of jumping to the bottom
  _pinClearTimer: null,              // delayed release of scrollPin once generation fully ends
  stickToBottom: true,               // streaming auto-scroll only while the user sits near the bottom (so they can scroll up mid-generation)
  animateMaskPoint: null,            // Wan Animate REPLACE: user's ⚙-picked {x,y} (0–1) of which person to replace; null = auto center
};

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