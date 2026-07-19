// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

// Settings persistence
import { dom, state } from './state.js';
import { SETTINGS_KEY } from './constants.js';
import { getActiveTab } from './tabs.js';
import { dbSaveTabs } from './db.js';
import { t } from './i18n.js';
// Circular at module level (presets.js imports back from here) — fine, both sides
// only call the other's functions at runtime, same as the settings↔tabs pair.
import { isCustomPresetId, resolvePersonaText, renderPersonalityOptions } from './presets.js';

// "Her personality" is only editable for a custom personality — the "new custom"
// sentinel ("temp") or a saved custom preset ("cp_…"). Built-ins are read-only.
export function syncPersonaEditable() {
  const v = dom.personalitySelect.value;
  const isSaved = isCustomPresetId(v);   // an existing named preset
  const isCustom = v === "temp" || isSaved;
  dom.persona.readOnly = !isCustom;
  dom.persona.classList.toggle("isReadonly", !isCustom);
  // Rename/Delete only act on a saved custom preset — disable them otherwise
  // (built-ins, or the unsaved "new custom" slot). Save-as is always available.
  if (dom.presetRename) dom.presetRename.disabled = !isSaved;
  if (dom.presetDelete) dom.presetDelete.disabled = !isSaved;
}

export function saveCurrentSettings() {
  const currentTab = getActiveTab();
  if (currentTab) {
    currentTab.personality = dom.personalitySelect.value;
    currentTab.persona = dom.persona.value;
  }
  saveTabs();
  localStorage.setItem(
    SETTINGS_KEY,
    JSON.stringify({
      model: dom.modelSelect.value,
      imageModel: dom.imageModelSelect.value,
      comfyModel: dom.comfyModelSelect?.value || "",
      comfyParams: {
        positive: dom.comfyParamPositive?.value || "",
        negative: dom.comfyParamNegative?.value || "",
        sampler: dom.comfyParamSampler?.value || "",
        scheduler: dom.comfyParamScheduler?.value || "",
        steps: dom.comfyParamSteps?.value || "",
        cfg: dom.comfyParamCfg?.value || "",
        guidance: dom.comfyParamGuidance?.value || "",
        imageCfg: dom.comfyParamImageCfg?.value || "",
        denoise: dom.comfyParamDenoise?.value || "",
        precision: dom.comfyParamPrecision?.value || "",
        length: dom.comfyParamLength?.value || "",
        fps: dom.comfyParamFps?.value || "",
        timeout: dom.comfyParamTimeout?.value || "",
        targetFps: dom.comfyParamTargetFps?.value || "",
        interpMethod: dom.comfyParamInterpMethod?.value || "rife",
        upscaleDenoise: dom.comfyParamUpscaleDenoise?.value || "",
        upscaleModel: dom.comfyParamUpscaleModel?.value || "",
        torchCompile: dom.comfyParamTorchCompile?.checked || false,
        berniniMode: dom.comfyParamBerniniMode?.value || "",
        berniniTask: dom.comfyParamBerniniTask?.value || "",
        refMaxSize: dom.comfyParamRefMaxSize?.value || "",
        ltxLora: dom.comfyParamLtxLora?.value || "",
        ltxLoraStrength: dom.comfyParamLtxLoraStrength?.value || "",
        phantomImgCfg: dom.comfyParamPhantomImgCfg?.value || "",
        phantomTurbo: dom.comfyParamPhantomTurbo?.checked || false,
        relight: dom.comfyParamRelight?.value || "",
        scailSubject: dom.comfyParamScailSubject?.value || "",
        scailRefSubject: dom.comfyParamScailRefSubject?.value || "",
        scailThreshold: dom.comfyParamScailThreshold?.value || "",
        scailMaxObjects: dom.comfyParamScailMaxObjects?.value || "",
        scailIndices: dom.comfyParamScailIndices?.value || "",
        scailSortBy: dom.comfyParamScailSortBy?.value || "",
        poseStrength: dom.comfyParamPoseStrength?.value || "",
        poseStart: dom.comfyParamPoseStart?.value || "",
        poseEnd: dom.comfyParamPoseEnd?.value || "",
      },
      defaultImageSize: dom.defaultImageSize.value,
      requestTimeout: dom.requestTimeoutInput.value,
      userName: dom.userName.value,
      persona: dom.persona.value,
      personality: dom.personalitySelect.value,
      customPresets: state.customPresets || [],
      voiceName: dom.voiceSelect.value,
      autoSpeak: dom.autoSpeakCheckbox.checked,
      speechRate: dom.speechRateInput.value,
      themeMode: state.currentThemeMode,
      themeAccent: state.currentThemeAccent,
      uiLanguage: dom.uiLanguageSelect?.value || "en",
      promptLanguage: dom.promptLanguageSelect?.value || "en",
      showThinking: dom.showThinkingCheckbox?.checked || false,
      sendTime: dom.sendTimeToggle?.checked ?? true,
      tools: dom.toolsToggle?.checked || false,
      libraryTool: dom.libraryToolToggle?.checked ?? true,
      numCtx: dom.numCtxSelect?.value || "32768",
      pdfEngine: dom.pdfEngineSelect?.value || "mineru",
      embedModel: dom.embedModelSelect?.value || "qwen3-embedding:8b",
      libraryDistill: dom.libraryDistillToggle?.checked ?? true,
      libraryRerank: dom.libraryRerankToggle?.checked || false,
      libraryAskTopK: dom.libraryAskTopK?.value || "6",
      libraryAskImages: dom.libraryAskImages?.value || "3",
      libraryAskBudget: dom.libraryAskBudget?.value || "",   // "" = auto (from num_ctx)
      dailyGreeting: dom.dailyGreetingToggle?.checked || false,
      dailyGreetingTime: dom.dailyGreetingTime?.value || "09:00",
      idleNudge: dom.idleNudgeToggle?.checked || false,
      idleNudgeMinutes: dom.idleNudgeMinutes?.value || "30",
    })
  );
}

function saveChatMessage(message) {
  const stored = { role: message.role };
  if (message.timestamp) stored.timestamp = message.timestamp;
  if (message.genMs) stored.genMs = message.genMs;
  stored.content = message.content;
  if (message.folded) stored.folded = true;
  if (message.locked) stored.locked = true;
  // Uploaded-image fields: displayImages (thumbnails, shown in the bubble) and
  // contextImages (full-res, what's actually sent to the model). See migrateImageFields.
  if (message.displayImages) stored.displayImages = message.displayImages;
  if (message.contextImages) stored.contextImages = message.contextImages;
  // Original upload filenames — injected into the model prompt so the user can refer to
  // an image by name (buildMessages). Persist so it survives reload / resend.
  if (message.imageNames) stored.imageNames = message.imageNames;
  // Inpaint mask (painted on the first image): persist it so the bubble 🖌 can
  // reload/edit it after a refresh and a resend regenerates with it. Without this
  // the mask lives only in memory and vanishes on reload.
  if (message.mask) stored.mask = message.mask;
  if (message.generatedThumbnails && message.generatedThumbnails.length > 0) {
    stored.generatedThumbnails = message.generatedThumbnails;
  }
  if (message.generatedImages && message.generatedImages.length > 0) {
    stored.generatedImages = message.generatedImages;
  }
  if (message.generatedImageNames && message.generatedImageNames.length > 0) {
    stored.generatedImageNames = message.generatedImageNames;
  }
  if (message.generatedVideos && message.generatedVideos.length > 0) {
    stored.generatedVideos = message.generatedVideos;
    stored.videoMime = message.videoMime || "video/mp4";
    // Per-clip source-video metadata (batch video-edit) → resend reconstructs each
    // clip. Legacy scalar fields kept for older single-video bubbles.
    if (message.videoMimes) stored.videoMimes = message.videoMimes;
    if (message.videoNames) stored.videoNames = message.videoNames;
    if (message.videoWidths) stored.videoWidths = message.videoWidths;
    if (message.videoHeights) stored.videoHeights = message.videoHeights;
    if (message.videoName) stored.videoName = message.videoName;
    if (message.videoWidth != null) stored.videoWidth = message.videoWidth;
    if (message.videoHeight != null) stored.videoHeight = message.videoHeight;
  }
  if (message.generatedVideoThumbnails && message.generatedVideoThumbnails.length > 0) {
    stored.generatedVideoThumbnails = message.generatedVideoThumbnails;
  }
  if (message.generatedAudio) {
    stored.generatedAudio = message.generatedAudio;
    stored.audioMime = message.audioMime || "audio/aac";
  }
  if (message.isCompactSummary) stored.isCompactSummary = true;
  if (message.isFilePreview) stored.isFilePreview = true;
  if (message.translation) stored.translation = message.translation;
  // Library-doc chunk bubbles ("import to chat" special tab) carry block metadata
  // so the tab can be written back to the library on archive.
  if (message.isLibraryBlock) {
    stored.isLibraryBlock = true;
    stored.libraryKind = message.libraryKind || "text";
    if (message.librarySection) stored.librarySection = message.librarySection;
    if (message.imageMime) stored.imageMime = message.imageMime;
  }
  // User text highlights / annotations (content-anchored display decorations).
  if (message.highlights && message.highlights.length) stored.highlights = message.highlights;
  if (message.thinking) stored.thinking = message.thinking;
  if (message.autoProcess) stored.autoProcess = message.autoProcess;   // /ask -a search-process trace
  if (message.toolSteps && message.toolSteps.length) stored.toolSteps = message.toolSteps;
  // A background-job placeholder must survive a reload as a placeholder (not a blank
  // bubble): persist its id (the job's reattach anchor) + the placeholder fields so
  // restoreBgJobsOnLoad can re-link the job and renderChat re-renders the placeholder.
  if (message.bgPlaceholder) {
    stored.bgPlaceholder = true;
    if (message.id) stored.id = message.id;
    if (message.jobId) stored.jobId = message.jobId;
    if (message.kind) stored.kind = message.kind;
    if (message.label) stored.label = message.label;
    if (message.status) stored.status = message.status;
  }
  return stored;
}

let _saveTimer = null;

export function saveTabs() {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    const data = state.tabs.map((tab) => ({
      ...tab,
      messages: tab.messages.map(saveChatMessage),
      tags: tab.tags || [],
      personality: tab.personality || "sweet",
      persona: tab.persona || resolvePersonaText(tab.personality),
    }));
    dbSaveTabs(data, state.activeTabId).catch((err) => {
      console.error("[saveTabs] IndexedDB write failed:", err);
    });
  }, 300);
}

export function saveChat() {
  saveTabs();
}

export function loadSavedSettings() {
  const savedSettings = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
  if (savedSettings.model) dom.modelSelect.value = savedSettings.model;
  if (savedSettings.imageModel) dom.imageModelSelect.value = savedSettings.imageModel;
  if (savedSettings.comfyModel && dom.comfyModelSelect) dom.comfyModelSelect.value = savedSettings.comfyModel;
  if (savedSettings.comfyParams) {
    const cp = savedSettings.comfyParams;
    if (dom.comfyParamPositive) dom.comfyParamPositive.value = cp.positive || "";
    if (dom.comfyParamNegative) dom.comfyParamNegative.value = cp.negative || "";
    if (dom.comfyParamSampler) dom.comfyParamSampler.value = cp.sampler || "";
    if (dom.comfyParamScheduler) dom.comfyParamScheduler.value = cp.scheduler || "";
    if (dom.comfyParamSteps) dom.comfyParamSteps.value = cp.steps || "";
    if (dom.comfyParamCfg) dom.comfyParamCfg.value = cp.cfg || "";
    if (dom.comfyParamGuidance) dom.comfyParamGuidance.value = cp.guidance || "";
    if (dom.comfyParamImageCfg) dom.comfyParamImageCfg.value = cp.imageCfg || "";
    if (dom.comfyParamDenoise) dom.comfyParamDenoise.value = cp.denoise || "";
    if (dom.comfyParamPrecision) dom.comfyParamPrecision.value = cp.precision || "";
    if (dom.comfyParamLength) dom.comfyParamLength.value = cp.length || "";
    if (dom.comfyParamFps) dom.comfyParamFps.value = cp.fps || "";
    if (dom.comfyParamTimeout) dom.comfyParamTimeout.value = cp.timeout || "";
    if (dom.comfyParamTargetFps) dom.comfyParamTargetFps.value = cp.targetFps || "";
    if (dom.comfyParamInterpMethod) dom.comfyParamInterpMethod.value = cp.interpMethod || "rife";
    if (dom.comfyParamUpscaleDenoise) dom.comfyParamUpscaleDenoise.value = cp.upscaleDenoise || "";
    // Best-effort — applyComfyModels re-applies this once the option list has loaded.
    if (dom.comfyParamUpscaleModel && cp.upscaleModel) dom.comfyParamUpscaleModel.value = cp.upscaleModel;
    if (dom.comfyParamTorchCompile) dom.comfyParamTorchCompile.checked = !!cp.torchCompile;
    // berniniMode replaced the two separate checkboxes — fall back to the old keys so
    // a saved quality/lightx2v choice survives the upgrade.
    if (dom.comfyParamBerniniMode) dom.comfyParamBerniniMode.value = cp.berniniMode || (cp.berniniLightx2v ? "lightx2v" : cp.berniniQuality ? "quality" : "");
    if (dom.comfyParamBerniniTask) dom.comfyParamBerniniTask.value = cp.berniniTask || "";
    if (dom.comfyParamRefMaxSize) dom.comfyParamRefMaxSize.value = cp.refMaxSize || "";
    // ltxLora is best-effort too — applyComfyModels re-applies it once loras have loaded.
    if (dom.comfyParamLtxLora && cp.ltxLora) dom.comfyParamLtxLora.value = cp.ltxLora;
    if (dom.comfyParamLtxLoraStrength) dom.comfyParamLtxLoraStrength.value = cp.ltxLoraStrength || "";
    if (dom.comfyParamPhantomImgCfg) dom.comfyParamPhantomImgCfg.value = cp.phantomImgCfg || "";
    if (dom.comfyParamPhantomTurbo) dom.comfyParamPhantomTurbo.checked = !!cp.phantomTurbo;
    if (dom.comfyParamRelight) dom.comfyParamRelight.value = cp.relight || "";
    if (dom.comfyParamScailSubject) dom.comfyParamScailSubject.value = cp.scailSubject || "";
    if (dom.comfyParamScailRefSubject) dom.comfyParamScailRefSubject.value = cp.scailRefSubject || "";
    if (dom.comfyParamScailThreshold) dom.comfyParamScailThreshold.value = cp.scailThreshold || "";
    if (dom.comfyParamScailMaxObjects) dom.comfyParamScailMaxObjects.value = cp.scailMaxObjects || "";
    if (dom.comfyParamScailIndices) dom.comfyParamScailIndices.value = cp.scailIndices || "";
    if (dom.comfyParamScailSortBy) dom.comfyParamScailSortBy.value = cp.scailSortBy || "";
    if (dom.comfyParamPoseStrength) dom.comfyParamPoseStrength.value = cp.poseStrength || "";
    if (dom.comfyParamPoseStart) dom.comfyParamPoseStart.value = cp.poseStart || "";
    if (dom.comfyParamPoseEnd) dom.comfyParamPoseEnd.value = cp.poseEnd || "";
  }
  if (savedSettings.defaultImageSize) dom.defaultImageSize.value = savedSettings.defaultImageSize;
  if (savedSettings.requestTimeout) {
    dom.requestTimeoutInput.value = savedSettings.requestTimeout;
    dom.requestTimeoutValue.textContent = savedSettings.requestTimeout;
  }
  if (savedSettings.userName) dom.userName.value = savedSettings.userName;
  if (savedSettings.voiceName) dom.voiceSelect.value = savedSettings.voiceName;
  if (savedSettings.autoSpeak) dom.autoSpeakCheckbox.checked = true;
  if (savedSettings.speechRate) {
    dom.speechRateInput.value = savedSettings.speechRate;
    dom.speechRateValue.textContent = savedSettings.speechRate;
  }
  if (Array.isArray(savedSettings.customPresets)) state.customPresets = savedSettings.customPresets;
  // savedSettings.personality is applied at the END of this function — the dropdown
  // must be rebuilt (with custom presets AND the restored UI language) first, or a
  // "cp_…"/non-static value silently fails against the initial empty <select>.
  if (savedSettings.persona) {
    const savedPersona = savedSettings.persona;
    // Only apply Chinese suffix normalization if persona is in Chinese
    if (/[\u4e00-\u9fff]/.test(savedPersona)) {
      dom.persona.value = savedPersona.includes("加油打气") ? savedPersona : `${savedPersona}，加油打气。`;
    } else {
      dom.persona.value = savedPersona;
    }
  }
  // Language settings
  if (savedSettings.uiLanguage && dom.uiLanguageSelect) dom.uiLanguageSelect.value = savedSettings.uiLanguage;
  if (savedSettings.promptLanguage && dom.promptLanguageSelect) dom.promptLanguageSelect.value = savedSettings.promptLanguage;
  // Thinking
  if (savedSettings.showThinking && dom.showThinkingCheckbox) dom.showThinkingCheckbox.checked = true;
  // Sending time info defaults to ON; respect an explicit saved off-choice.
  if (dom.sendTimeToggle) dom.sendTimeToggle.checked = savedSettings.sendTime !== undefined ? !!savedSettings.sendTime : true;
  // Tool calling defaults to ON; respect an explicit saved off-choice.
  if (dom.toolsToggle) dom.toolsToggle.checked = savedSettings.tools !== undefined ? !!savedSettings.tools : true;
  // The knowledge-library tool sub-toggle: also default ON.
  if (dom.libraryToolToggle) dom.libraryToolToggle.checked = savedSettings.libraryTool !== undefined ? !!savedSettings.libraryTool : true;
  // Context window
  if (savedSettings.numCtx && dom.numCtxSelect) dom.numCtxSelect.value = savedSettings.numCtx;
  if (savedSettings.pdfEngine && dom.pdfEngineSelect) dom.pdfEngineSelect.value = savedSettings.pdfEngine;
  // Embedding model selection is applied by loadEmbedModels (after options load).
  // Library distill card defaults to ON; respect an explicit saved off-choice.
  if (dom.libraryDistillToggle) dom.libraryDistillToggle.checked = savedSettings.libraryDistill !== undefined ? !!savedSettings.libraryDistill : true;
  // Retrieval rerank defaults to OFF (an extra LLM call per /ask).
  if (dom.libraryRerankToggle) dom.libraryRerankToggle.checked = !!savedSettings.libraryRerank;
  // /ask ⚙ parameters (top-K / attached images / full-read budget)
  if (savedSettings.libraryAskTopK && dom.libraryAskTopK) dom.libraryAskTopK.value = savedSettings.libraryAskTopK;
  if (savedSettings.libraryAskImages !== undefined && dom.libraryAskImages) dom.libraryAskImages.value = savedSettings.libraryAskImages;
  if (savedSettings.libraryAskBudget !== undefined && dom.libraryAskBudget) dom.libraryAskBudget.value = savedSettings.libraryAskBudget;
  // Proactive messages
  if (savedSettings.dailyGreeting && dom.dailyGreetingToggle) dom.dailyGreetingToggle.checked = true;
  if (savedSettings.dailyGreetingTime && dom.dailyGreetingTime) dom.dailyGreetingTime.value = savedSettings.dailyGreetingTime;
  if (savedSettings.idleNudge && dom.idleNudgeToggle) dom.idleNudgeToggle.checked = true;
  if (savedSettings.idleNudgeMinutes && dom.idleNudgeMinutes) dom.idleNudgeMinutes.value = savedSettings.idleNudgeMinutes;
  // The personality dropdown is dynamic (built-ins + custom presets, labels follow
  // the UI language) — build it only now that customPresets and uiLanguage are both
  // restored, then apply the saved selection so its option actually exists.
  renderPersonalityOptions();
  if (savedSettings.personality) dom.personalitySelect.value = savedSettings.personality;
}

// --- userName history ---
const USERNAME_HISTORY_KEY = "local-ai-companion-username-history";

export function getUserNameHistory() {
  try {
    return JSON.parse(localStorage.getItem(USERNAME_HISTORY_KEY) || "[]");
  } catch { return []; }
}

export function addUserNameToHistory(name) {
  if (!name) return;
  let history = getUserNameHistory();
  // Remove duplicate, then prepend
  history = history.filter(h => h !== name);
  history.unshift(name);
  // Keep max 10
  if (history.length > 10) history.length = 10;
  localStorage.setItem(USERNAME_HISTORY_KEY, JSON.stringify(history));
}

export function removeUserNameFromHistory(name) {
  let history = getUserNameHistory();
  history = history.filter(h => h !== name);
  localStorage.setItem(USERNAME_HISTORY_KEY, JSON.stringify(history));
}

export function renderUserNameDropdown() {
  const history = getUserNameHistory();
  dom.userNameDropdown.innerHTML = "";
  if (history.length === 0) {
    const empty = document.createElement("div");
    empty.className = "userNameHistoryEmpty";
    empty.textContent = t("msg_noHistory");
    dom.userNameDropdown.appendChild(empty);
    return;
  }
  for (const name of history) {
    const item = document.createElement("div");
    item.className = "userNameHistoryItem";
    const label = document.createElement("span");
    label.textContent = name;
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "deleteHistoryBtn";
    delBtn.textContent = "✕";
    delBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      removeUserNameFromHistory(name);
      renderUserNameDropdown();
    });
    item.appendChild(label);
    item.appendChild(delBtn);
    item.addEventListener("click", () => {
      dom.userName.value = name;
      dom.userNameDropdown.hidden = true;
      saveCurrentSettings();
    });
    dom.userNameDropdown.appendChild(item);
  }
}