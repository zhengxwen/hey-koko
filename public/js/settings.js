// Settings persistence
import { dom, state } from './state.js';
import { SETTINGS_KEY, PERSONALITY_PRESETS } from './constants.js';
import { getActiveTab } from './tabs.js';
import { dbSaveTabs } from './db.js';
import { t } from './i18n.js';

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
        sampler: dom.comfyParamSampler?.value || "",
        scheduler: dom.comfyParamScheduler?.value || "",
        steps: dom.comfyParamSteps?.value || "",
        cfg: dom.comfyParamCfg?.value || "",
        guidance: dom.comfyParamGuidance?.value || "",
        imageCfg: dom.comfyParamImageCfg?.value || "",
        denoise: dom.comfyParamDenoise?.value || "",
        length: dom.comfyParamLength?.value || "",
        fps: dom.comfyParamFps?.value || "",
      },
      defaultImageSize: dom.defaultImageSize.value,
      imageTimeout: dom.imageTimeoutInput.value,
      userName: dom.userName.value,
      persona: dom.persona.value,
      personality: dom.personalitySelect.value,
      voiceName: dom.voiceSelect.value,
      autoSpeak: dom.autoSpeakCheckbox.checked,
      speechRate: dom.speechRateInput.value,
      themeMode: state.currentThemeMode,
      themeAccent: state.currentThemeAccent,
      uiLanguage: dom.uiLanguageSelect?.value || "en",
      promptLanguage: dom.promptLanguageSelect?.value || "en",
      showThinking: dom.showThinkingCheckbox?.checked || false,
      tools: dom.toolsToggle?.checked || false,
      numCtx: dom.numCtxSelect?.value || "32768",
      embedModel: dom.embedModelSelect?.value || "qwen3-embedding:0.6b",
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
  if (message.previewImage) stored.previewImage = message.previewImage;
  if (message.previewImages) stored.previewImages = message.previewImages;
  if (message.images) stored.images = message.images;
  if (message.generatedThumbnails && message.generatedThumbnails.length > 0) {
    stored.generatedThumbnails = message.generatedThumbnails;
  }
  if (message.generatedImages && message.generatedImages.length > 0) {
    stored.generatedImages = message.generatedImages;
  }
  if (message.generatedVideos && message.generatedVideos.length > 0) {
    stored.generatedVideos = message.generatedVideos;
    stored.videoMime = message.videoMime || "video/mp4";
  }
  if (message.isCompactSummary) stored.isCompactSummary = true;
  if (message.isFilePreview) stored.isFilePreview = true;
  if (message.translation) stored.translation = message.translation;
  if (message.thinking) stored.thinking = message.thinking;
  if (message.toolSteps && message.toolSteps.length) stored.toolSteps = message.toolSteps;
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
      persona: tab.persona || PERSONALITY_PRESETS[tab.personality] || PERSONALITY_PRESETS.sweet,
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
    if (dom.comfyParamSampler) dom.comfyParamSampler.value = cp.sampler || "";
    if (dom.comfyParamScheduler) dom.comfyParamScheduler.value = cp.scheduler || "";
    if (dom.comfyParamSteps) dom.comfyParamSteps.value = cp.steps || "";
    if (dom.comfyParamCfg) dom.comfyParamCfg.value = cp.cfg || "";
    if (dom.comfyParamGuidance) dom.comfyParamGuidance.value = cp.guidance || "";
    if (dom.comfyParamImageCfg) dom.comfyParamImageCfg.value = cp.imageCfg || "";
    if (dom.comfyParamDenoise) dom.comfyParamDenoise.value = cp.denoise || "";
    if (dom.comfyParamLength) dom.comfyParamLength.value = cp.length || "";
    if (dom.comfyParamFps) dom.comfyParamFps.value = cp.fps || "";
  }
  if (savedSettings.defaultImageSize) dom.defaultImageSize.value = savedSettings.defaultImageSize;
  if (savedSettings.imageTimeout) {
    dom.imageTimeoutInput.value = savedSettings.imageTimeout;
    dom.imageTimeoutValue.textContent = savedSettings.imageTimeout;
  }
  if (savedSettings.userName) dom.userName.value = savedSettings.userName;
  if (savedSettings.voiceName) dom.voiceSelect.value = savedSettings.voiceName;
  if (savedSettings.autoSpeak) dom.autoSpeakCheckbox.checked = true;
  if (savedSettings.speechRate) {
    dom.speechRateInput.value = savedSettings.speechRate;
    dom.speechRateValue.textContent = savedSettings.speechRate;
  }
  if (savedSettings.personality) dom.personalitySelect.value = savedSettings.personality;
  if (savedSettings.persona) {
    const savedPersona = savedSettings.persona.replaceAll("澪", "Bella");
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
  // Tool calling defaults to ON; respect an explicit saved off-choice.
  if (dom.toolsToggle) dom.toolsToggle.checked = savedSettings.tools !== undefined ? !!savedSettings.tools : true;
  // Context window
  if (savedSettings.numCtx && dom.numCtxSelect) dom.numCtxSelect.value = savedSettings.numCtx;
  // Embedding model selection is applied by loadEmbedModels (after options load).
  // Proactive messages
  if (savedSettings.dailyGreeting && dom.dailyGreetingToggle) dom.dailyGreetingToggle.checked = true;
  if (savedSettings.dailyGreetingTime && dom.dailyGreetingTime) dom.dailyGreetingTime.value = savedSettings.dailyGreetingTime;
  if (savedSettings.idleNudge && dom.idleNudgeToggle) dom.idleNudgeToggle.checked = true;
  if (savedSettings.idleNudgeMinutes && dom.idleNudgeMinutes) dom.idleNudgeMinutes.value = savedSettings.idleNudgeMinutes;
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
