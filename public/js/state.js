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
  comfyParamTargetFps: document.querySelector("#comfyParamTargetFps"),
  comfyParamInterpMethod: document.querySelector("#comfyParamInterpMethod"),
  comfyParamUpscaleDenoise: document.querySelector("#comfyParamUpscaleDenoise"),
  comfyParamUpscaleModel: document.querySelector("#comfyParamUpscaleModel"),
  comfyParamTorchCompile: document.querySelector("#comfyParamTorchCompile"),
  comfyModelHint: document.querySelector("#comfyModelHint"),
  comfyModelWarn: document.querySelector("#comfyModelWarn"),
  comfyParamBerniniMode: document.querySelector("#comfyParamBerniniMode"),
  comfyParamBerniniTask: document.querySelector("#comfyParamBerniniTask"),
  comfyParamRefMaxSize: document.querySelector("#comfyParamRefMaxSize"),
  comfyParamPhantomImgCfg: document.querySelector("#comfyParamPhantomImgCfg"),
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
  activeSpeechButton: null,
  speechAbortController: null,
  activeTranslationAbort: null,
  avatarState: "idle",
  blinkTimer: null,
  expressionTimer: null,
  currentThemeMode: "system",
  currentThemeAccent: "teal",
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
  comfyMultiImageModels: new Set(),  // ComfyUI edit models that accept 2-3 reference images
  scrollPin: null,                   // when set (resend/edit in place), auto-scroll holds this scrollTop instead of jumping to the bottom
  _pinClearTimer: null,              // delayed release of scrollPin once generation fully ends
  stickToBottom: true,               // streaming auto-scroll only while the user sits near the bottom (so they can scroll up mid-generation)
  animateMaskPoint: null,            // Wan Animate REPLACE: user's ⚙-picked {x,y} (0–1) of which person to replace; null = auto center
};

// Auto-scroll the chat. Normally jumps to the bottom (new content), but while a
// resend/edit regenerates in place, state.scrollPin holds the position so the
// view doesn't jump away from the message being edited.
export function scrollChatToEnd() {
  if (state.scrollPin != null) dom.messagesEl.scrollTop = state.scrollPin;
  else dom.messagesEl.scrollTop = dom.messagesEl.scrollHeight;
  refreshScrollState();
}

// Streaming/progress auto-scroll that yields to the user: only follows new
// content while they're still near the bottom. Dragging up to read mid-stream
// flips state.stickToBottom off (via refreshScrollState on the scroll event),
// and this becomes a no-op until they return to the bottom.
export function scrollChatToEndIfPinned() {
  if (state.stickToBottom) scrollChatToEnd();
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