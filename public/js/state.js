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
  comfyParamLength: document.querySelector("#comfyParamLength"),
  comfyParamFps: document.querySelector("#comfyParamFps"),
  comfyParamTimeout: document.querySelector("#comfyParamTimeout"),
  comfyParamTargetFps: document.querySelector("#comfyParamTargetFps"),
  comfyParamInterpMethod: document.querySelector("#comfyParamInterpMethod"),
  comfyParamUpscaleDenoise: document.querySelector("#comfyParamUpscaleDenoise"),
  comfyParamUpscaleModel: document.querySelector("#comfyParamUpscaleModel"),
  comfyParamTorchCompile: document.querySelector("#comfyParamTorchCompile"),
  comfyParamRelight: document.querySelector("#comfyParamRelight"),
  comfyMaskPointBtn: document.querySelector("#comfyMaskPointBtn"),
  comfyMaskPointLabel: document.querySelector("#comfyMaskPointLabel"),
  maskPointModal: document.querySelector("#maskPointModal"),
  maskPointClose: document.querySelector("#maskPointClose"),
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
  numCtxSelect: document.querySelector("#numCtxSelect"),
  numCtxDisplay: document.querySelector("#numCtxDisplay"),
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
  comfyVideoModels: new Set(),       // ComfyUI model names that generate video
  comfyVideoInModels: new Set(),     // ComfyUI video models that need a SOURCE video (fps follows source)
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

// Recompute "pinned to bottom?" from live geometry and toggle the floating
// jump-to-bottom button. Called on user scroll and after each auto-scroll.
export function refreshScrollState() {
  const el = dom.messagesEl;
  if (!el) return;
  const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
  state.stickToBottom = distance <= 40;
  if (dom.scrollToBottomBtn) dom.scrollToBottomBtn.hidden = distance <= 80;
}