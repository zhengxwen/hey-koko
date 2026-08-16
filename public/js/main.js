// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

// Main entry point - imports and initializes all modules
import { dom, state, refreshScrollState, onMessagesScroll } from './state.js';
import { readFileAsDataUrl, convertToJpeg, normalizeOrientation, makePreview, escapeHtml, genId,
         mediaSrc, mediaBase64, isMediaRef, galleryThumbUrl, galleryIdOf, cacheGalleryThumb,
         fileIntoGallery, sniffImageMime, fileInlineMedia, inlineMediaSlots } from './utils.js';
import { markdownToHtml } from './markdown.js';
import { initTheme } from './theme.js';
import { initAvatar, updateCloudBadge, relocalizeAvatarPicker } from './avatar.js';
import { pauseOrStopSpeech, populateVoiceList } from './speech.js';
import { saveCurrentSettings, saveTabs, saveTabsNow, saveChat, loadSavedSettings, addUserNameToHistory, renderUserNameDropdown, syncPersonaEditable } from './settings.js';
import { loadTabs, getActiveTab, renderTabs, addChatTab, switchTab, clearSelectedImage, clearSelectedFile, clearSelectedVideo, clearSelectedAudio, createTab, migrateImageFields, setRenderChat as tabsSetRenderChat, setRenderAttachments as tabsSetRenderAttachments, updateLockedState } from './tabs.js';
import { initOllama, loadModels, loadImageModels, loadComfyModels, refreshBgWorkers, loadEmbedModels, updateImageGenOptions, updateComfyMultiHint, openModelBrowser, openComfyModelPicker, syncComfyModelPickLabel, relocalizeComfyModels, relocalizeBrowseOption, BROWSE_MODELS_VALUE } from './ollama.js';
import { setDeps as imageGenSetDeps, videoThumbnail, videoNaturalSize, comfyModelSupportsRefMask } from './image-gen.js';
import { setDeps as voiceGenSetDeps } from './voice-gen.js';
import { setRenderChat as translateSetRenderChat, stopTranslation } from './translate.js';
import { renderChat, sendMessage, setGenerating, regenerateReply, analyzeMedia, generateProactiveReply, markStopping, showSendError, initHighlightUI } from './chat.js';
import { setDeps as urlFetchSetDeps, handleUrlCommand, handleMultiUrlCommand } from './url-fetch.js';
import { setToolCmdDeps } from './tool-cmd.js';
import { showCommandPopup, hideCommandPopup, moveCommandSelection, selectActiveCommand } from './commands.js';
import { loadMentionDocs, loadMentionArchives, mentionContext, showMentionPopup, hideMentionPopup, moveMentionSelection, selectActiveMention, isMentionPopupOpen } from './mentions.js';
import { initLightbox, initVideoLightbox, openMediaViewer } from './lightbox.js';
import { initArchive } from './archive.js';
import { initLibrary, runLibraryImport, notifyLibraryJobsChanged, openLibraryPanel, openLibraryDoc } from './library.js';
import { initAsk } from './ask.js';
import { renderPersonalityOptions, saveCurrentPersonaAsPreset, renameCurrentPreset, deleteCurrentPreset, writeBackPersonaToPreset, isBuiltinKey, getCustomPreset, resolveImportedPersonality, resolvePersonaText, renderPersonaSummary } from './presets.js';
import { DEFAULT_AI_NAME } from './constants.js';
import { applyUILanguage, t, getPrompt, composerAiName } from './i18n.js';
import { refreshModelMaxContext, renderContextMeter, getLlmTimeout } from './context-meter.js';
import { loadMemories, getMemories, addMemory, updateMemory, removeMemory, setMemoryChangeHandler } from './memory.js';
import { loadReminders, getReminders, removeReminder, describeReminder, setReminderChangeHandler, setDeliverHandler, startScheduler } from './proactive.js';
import { initPanelResize } from './panel-resize.js';
import { openMaskModal } from './mask-paint.js';
import { setBgDeps, restoreBgJobsOnLoad, restoreBgWorkersOnLoad, toggleBgDrawer, closeBgDrawer, enqueueBgJob } from './bg-jobs.js';
import { connectServerQueue } from './server-queue.js';   // Option B: SSE stream of server-side gen jobs
import { initTabGuard } from './tab-guard.js';   // warn when hey-koko is open in 2+ tabs (shared IndexedDB, last save wins)
import { imageName, imageMarker, isImageMarkerAlt } from './mail-images.js';   // twin of server/mail-images.js

// Safety net: #chatLoading starts VISIBLE to cover the startup freeze and is hidden
// after the first render below. If ANY startup step throws before that (top-level
// module abort), the overlay would otherwise stay up forever with its bouncing dots
// covering the chat. This timer is registered before all the awaits, so it fires no
// matter what and force-hides the overlay. It can't hide it early during a real
// synchronous freeze (single-threaded), so it only ever kicks in on failure.
setTimeout(() => {
  const el = document.querySelector("#chatLoading");
  if (el && !el.hidden) el.hidden = true;
}, 8000);

// Wire up circular dependencies
tabsSetRenderChat(renderChat);
tabsSetRenderAttachments(renderStagedAttachments);
translateSetRenderChat(renderChat);
imageGenSetDeps({ setGenerating, renderChat });
voiceGenSetDeps({ setGenerating, renderChat });
urlFetchSetDeps({ setGenerating, renderChat, regenerateReply, showSendError });
setToolCmdDeps({ setGenerating, renderChat, regenerateReply, showSendError });
setBgDeps({ renderChat, analyzeMedia, regenerateReply, parseDocumentHeadless, handleUrlCommand, handleMultiUrlCommand, refreshWorkers: refreshBgWorkers, libraryImport: runLibraryImport, onJobsChanged: notifyLibraryJobsChanged, openLibrary: openLibraryPanel });

// Background Jobs drawer toggle + close.
if (dom.bgJobsBtn) dom.bgJobsBtn.addEventListener("click", (e) => { e.stopPropagation(); toggleBgDrawer(); });
{
  const bgClose = document.querySelector("#bgJobsCloseBtn");
  if (bgClose) bgClose.addEventListener("click", () => closeBgDrawer());
}
// Clicking the empty chat area — or focusing the message input — collapses the
// background-jobs drawer (the user is turning their attention back to the conversation).
// Only blank space counts: e.target must be the container itself, not a bubble or a
// button inside it (e.g. a placeholder's "go to background jobs" button, which would
// otherwise open the drawer and have this same click immediately close it again).
dom.messagesEl.addEventListener("click", (e) => {
  if (state.bgDrawerOpen && e.target === dom.messagesEl) closeBgDrawer();
});
if (dom.messageInput) dom.messageInput.addEventListener("focus", () => { if (state.bgDrawerOpen) closeBgDrawer(); });

// Initialize mermaid
if (typeof mermaid !== "undefined") {
  const mermaidTheme = document.documentElement.getAttribute("data-mode") === "dark" ? "dark" : "default";
  mermaid.initialize({ startOnLoad: false, theme: mermaidTheme, flowchart: { nodeSpacing: 20, rankSpacing: 30 } });
}

// Initialize highlight.js
if (typeof hljs !== "undefined") {
  hljs.configure({ ignoreUnescapedHTML: true });
}

// Initialize theme system
initTheme(saveCurrentSettings);

// Initialize avatar
initAvatar();

// AI name: load from localStorage and enable double-click edit
{
  const savedAiName = localStorage.getItem("aiName");
  if (savedAiName) dom.aiName.textContent = savedAiName;
  dom.aiName.addEventListener("dblclick", () => {
    const current = dom.aiName.textContent;
    const input = document.createElement("input");
    input.type = "text";
    input.value = current;
    input.className = "aiNameInput";
    dom.aiName.textContent = "";
    dom.aiName.appendChild(input);
    input.focus();
    input.select();
    const commit = () => {
      const newName = input.value.trim() || DEFAULT_AI_NAME;
      dom.aiName.textContent = newName;
      localStorage.setItem("aiName", newName);
      // Built-in persona texts embed the AI name — re-resolve the current one so
      // the prompt follows the rename (custom presets are the user's own words).
      const sel = dom.personalitySelect.value;
      if (isBuiltinKey(sel)) {
        dom.persona.value = resolvePersonaText(sel, newName);
        saveCurrentSettings();
      }
      // "Say something to <name>…" carries the name, so it has to follow the rename too.
      applyInputPlaceholder();
    };
    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") input.blur();
      if (e.key === "Escape") { input.value = current; input.blur(); }
    });
  });
}

// Load tabs from storage (async — IndexedDB)
{
  const loaded = await loadTabs();
  state.tabs = loaded.tabs;
  state.activeTabId = loaded.activeTabId || state.tabs[0].id;
  if (!state.tabs.some((tab) => tab.id === state.activeTabId)) state.activeTabId = state.tabs[0].id;
}

// Load long-term memories + reminders (async — IndexedDB)
await loadMemories();
await loadReminders();

// Load saved settings. This also builds the personality dropdown (built-ins +
// custom presets) and restores the saved selection, so a "cp_…" value resolves.
loadSavedSettings();

// Restore active tab's personality
{
  const initialTab = getActiveTab();
  if (initialTab && initialTab.personality) {
    dom.personalitySelect.value = initialTab.personality;
    dom.persona.value = initialTab.persona || resolvePersonaText(initialTab.personality);
  }
  syncPersonaEditable();
  renderPersonaSummary();
}

// Personality select handler
dom.personalitySelect.addEventListener("change", () => {
  const val = dom.personalitySelect.value;
  dom.persona.value = resolvePersonaText(val);
  if (!isBuiltinKey(val)) dom.persona.focus();   // temp/custom are editable — jump in
  syncPersonaEditable();
  renderPersonaSummary();
  const currentTab = getActiveTab();
  if (currentTab) {
    currentTab.personality = val;
    currentTab.persona = dom.persona.value;
    saveTabs();
  }
});

// Voice list (unified: say + neural engines)
populateVoiceList();

// Panel tabs
document.querySelectorAll(".panelTab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".panelTab").forEach((t) => { t.classList.remove("isActive"); t.setAttribute("aria-selected", "false"); });
    document.querySelectorAll(".panelTabContent").forEach((c) => c.classList.remove("isActive"));
    tab.classList.add("isActive");
    tab.setAttribute("aria-selected", "true");
    document.querySelector(`.panelTabContent[data-panel-content="${tab.dataset.panelTab}"]`).classList.add("isActive");
  });
});

// Language selectors
dom.uiLanguageSelect.addEventListener("change", () => {
  dom.promptLanguageSelect.value = dom.uiLanguageSelect.value;
  applyUILanguage();
  renderPersonalityOptions(); // re-localize built-in option + group labels (dropdown is dynamic)
  // Built-in persona texts exist per language — follow the language switch too
  // (custom presets are the user's own words and stay untouched).
  {
    const sel = dom.personalitySelect.value;
    if (isBuiltinKey(sel)) dom.persona.value = resolvePersonaText(sel);
  }
  populateVoiceList(); // re-localize voice optgroup + option labels
  relocalizeComfyModels(); // rebuild ComfyUI dropdown so its i18n labels (optgroups + image-upscale) follow the switch
  relocalizeBrowseOption(); // re-label the "browse all models" option (dynamically added, so applyI18n misses it)
  updateComfyMultiHint(); // model hint line / option tooltips / ⚙ placeholders are localized
  renderMemoryList();   // empty-state text is localized (memory_empty)
  renderReminderList(); // empty-state text is localized (reminder_listEmpty)
  relocalizeAvatarPicker(); // avatar tooltips are localized (avatar_*)
  renderChat();
  saveCurrentSettings();
});
dom.promptLanguageSelect.addEventListener("change", () => {
  saveCurrentSettings();
});
dom.showThinkingCheckbox.addEventListener("change", () => {
  saveCurrentSettings();
});
if (dom.sendTimeToggle) {
  dom.sendTimeToggle.addEventListener("change", saveCurrentSettings);
}
if (dom.toolsToggle) {
  // The sub-options (knowledge library / co-browsing Chrome) only make sense while
  // tool use is on, so hide their rows when the master toggle is off (and reflect
  // the loaded state). The launch button also greys out with its own checkbox off.
  const syncToolSubRows = () => {
    const show = dom.toolsToggle.checked;
    for (const cb of [dom.libraryToolToggle, dom.browserToolToggle]) {
      const row = cb?.closest(".toolSubToggle");
      if (row) row.style.display = show ? "" : "none";
    }
    if (dom.browserLaunchBtn) dom.browserLaunchBtn.disabled = !(dom.browserToolToggle?.checked ?? true);
  };
  dom.toolsToggle.addEventListener("change", () => { saveCurrentSettings(); syncToolSubRows(); });
  dom.libraryToolToggle?.addEventListener("change", saveCurrentSettings);
  dom.browserToolToggle?.addEventListener("change", () => { saveCurrentSettings(); syncToolSubRows(); });
  syncToolSubRows();
}
if (dom.browserLaunchBtn) {
  // Launch the co-browsing Chrome on the server machine; flash the outcome on the
  // button itself, then restore. Disabled while the request is in flight and
  // whenever the co-browsing checkbox is off.
  dom.browserLaunchBtn.addEventListener("click", async () => {
    const btn = dom.browserLaunchBtn;
    btn.disabled = true;
    let msg = "btn_browserLaunchFailed";
    try {
      const res = await fetch("/api/browser/launch", { method: "POST" });
      const data = await res.json();
      if (!data.error) msg = data.already ? "btn_browserLaunchAlready" : "btn_browserLaunched";
    } catch { /* keep failure message */ }
    btn.textContent = t(msg);
    setTimeout(() => {
      btn.textContent = t("btn_browserLaunch");
      btn.disabled = !(dom.browserToolToggle?.checked ?? true);
    }, 2500);
  });
}
if (dom.libraryDistillToggle) {
  dom.libraryDistillToggle.addEventListener("change", saveCurrentSettings);
}
if (dom.libraryRerankToggle) {
  dom.libraryRerankToggle.addEventListener("change", saveCurrentSettings);
}

// Apply i18n on startup
applyUILanguage();

// Duplicate-tab warning (needs t() ready, hence after applyUILanguage)
initTabGuard();

// Slider display handlers
dom.requestTimeoutInput.addEventListener("input", () => {
  dom.requestTimeoutValue.textContent = dom.requestTimeoutInput.value;
});
// "change" fires once on release (not per drag tick) — persist the slider on its own,
// instead of riding along with the next unrelated saveCurrentSettings() call.
dom.requestTimeoutInput.addEventListener("change", saveCurrentSettings);

dom.speechRateInput.addEventListener("input", () => {
  dom.speechRateValue.textContent = dom.speechRateInput.value;
});

// ESC while reading: first press pauses, a second press (while paused) stops.
document.addEventListener("keydown", (e) => {
  if (!state.activeSpeechButton) return;
  if (e.key === "Escape") pauseOrStopSpeech();
});

// Chat form submit
dom.chatForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (state.currentAbortController) {
    markStopping();
    state.currentAbortController.abort();
    return;
  }

  if (state.imageGenAbortController) {
    markStopping();
    state.imageGenAbortController.abort();
    return;
  }

  const content = dom.messageInput.value.trim();
  if (!content && !state.selectedImage && !state.selectedFile && !state.selectedVideo && !state.selectedAudio) return;

  // Sending always returns the user to the bottom, even if they'd scrolled up.
  state.stickToBottom = true;

  saveCurrentSettings();
  const image = state.selectedImage;
  const file = state.selectedFile;
  const video = state.selectedVideo;
  const audio = state.selectedAudio;
  dom.messageInput.value = "";
  // Sent — drop the saved draft so it doesn't reappear on tab switch.
  const _activeTab = getActiveTab();
  if (_activeTab) _activeTab.draft = "";
  clearSelectedImage();
  clearSelectedFile();
  clearSelectedVideo();
  clearSelectedAudio();

  if (file && file.multi) {
    // Multiple documents: each becomes its own background job (the queue runs them
    // serially, so parsing/summary never blocks the page).
    for (const f of file.multi) {
      const tab = getActiveTab();
      const userContent = content || `📄 **${f.name}**`;
      tab.messages.push({ role: "user", content: userContent, timestamp: Date.now() });
      saveChat();
      renderChat();
      if (f.needsParse) {
        await enqueueDocParse(f.rawFile, f.name, f.ext, content);
      } else {
        sendMessage(content, null, undefined, f);
      }
    }
  } else if (file && file.needsParse) {
    // Show the "📄 name" user bubble, then parse + summarize in the background queue.
    const tab = getActiveTab();
    const userContent = content || `📄 **${file.name}**`;
    tab.messages.push({ role: "user", content: userContent, timestamp: Date.now() });
    saveChat();
    renderChat();
    await enqueueDocParse(file.rawFile, file.name, file.ext, content);
  } else {
    sendMessage(content, image, undefined, file, video, audio);
  }
});

// Message input keyboard
dom.messageInput.addEventListener("keydown", (event) => {
  const qPopup = document.querySelector("#quickPromptPopup");
  // /ask @mention popup takes priority: navigate/select/close it before anything else.
  if (isMentionPopupOpen()) {
    if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); selectActiveMention(); return; }
    if (event.key === "ArrowDown") { event.preventDefault(); moveMentionSelection(1); return; }
    if (event.key === "ArrowUp") { event.preventDefault(); moveMentionSelection(-1); return; }
    if (event.key === "Escape") { event.preventDefault(); hideMentionPopup(); return; }
  }
  if (event.key === "Enter" && !event.shiftKey) {
    if (!dom.commandPopup.hidden) {
      event.preventDefault();
      selectActiveCommand();
      return;
    }
    if (!qPopup.hidden) {
      event.preventDefault();
      selectActiveQuickPrompt();
      return;
    }
    event.preventDefault();
    dom.chatForm.requestSubmit();
  }
  if (!dom.commandPopup.hidden) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveCommandSelection(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveCommandSelection(-1);
    } else if (event.key === "Escape") {
      event.preventDefault();
      hideCommandPopup();
    } else if (event.key === "Tab") {
      event.preventDefault();
      selectActiveCommand();
    }
  }
  if (!qPopup.hidden) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveQuickPromptSelection(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveQuickPromptSelection(-1);
    } else if (event.key === "Escape") {
      event.preventDefault();
      qPopup.hidden = true;
    } else if (event.key === "Tab") {
      event.preventDefault();
      selectActiveQuickPrompt();
    }
  }
});

// Command autocomplete on input
dom.messageInput.addEventListener("input", () => {
  // Don't show command popup if quick prompt is visible
  if (!quickPromptPopup.hidden) {
    hideCommandPopup();
    return;
  }
  const val = dom.messageInput.value;
  if (val.startsWith("/") && !val.includes("\n")) {
    const cmd = val.split(/\s/)[0];
    if (cmd === val.trimEnd()) {
      showCommandPopup(cmd);
    } else {
      hideCommandPopup();
    }
  } else {
    hideCommandPopup();
  }
});

// "@" autocomplete: library docs / "#" archives inside "/ask …", tool aliases inside "/tool …".
dom.messageInput.addEventListener("input", () => {
  const ctx = mentionContext(dom.messageInput);
  if (ctx) showMentionPopup(ctx.partial, ctx.sigil, ctx.mode);
  else hideMentionPopup();
});
dom.messageInput.addEventListener("blur", () => setTimeout(hideMentionPopup, 150));

// Auto-save when model selections change
let lastPickedModel = dom.modelSelect.value;
// Re-read the selection at the moment the user reaches for the dropdown. `change` alone
// is not enough to keep this current: the value is also set PROGRAMMATICALLY (settings
// load, a tab switch, loadModels rebuilding the list) and assigning .value fires no
// event — so the variable would still hold whatever the list held at page load, which is
// "" (the options arrive asynchronously). Restoring that emptied the dropdown entirely.
const rememberPickedModel = () => {
  if (dom.modelSelect.value && dom.modelSelect.value !== BROWSE_MODELS_VALUE) lastPickedModel = dom.modelSelect.value;
};
dom.modelSelect.addEventListener("focus", rememberPickedModel);
dom.modelSelect.addEventListener("mousedown", rememberPickedModel);
dom.modelSelect.addEventListener("change", () => {
  // The last dropdown entry is an ACTION, not a model: restore the previous
  // selection and open the full-catalog picker instead.
  if (dom.modelSelect.value === BROWSE_MODELS_VALUE) {
    dom.modelSelect.value = lastPickedModel;
    // The remembered model can be gone (removed with `ollama rm`, or dropped from the
    // provider allowlist) — assigning a value no option carries leaves selectedIndex at
    // -1 and the dropdown blank. Fall back to the first real entry, and announce it:
    // the visible selection is the one that will actually be used.
    if (dom.modelSelect.selectedIndex < 0) {
      const first = [...dom.modelSelect.options].find((o) => o.value && o.value !== BROWSE_MODELS_VALUE && !o.disabled);
      if (first) {
        dom.modelSelect.value = first.value;
        lastPickedModel = first.value;
        saveCurrentSettings();
        refreshModelMaxContext(first.value);
        updateCloudBadge();
      }
    }
    openModelBrowser();
    return;
  }
  lastPickedModel = dom.modelSelect.value;
  saveCurrentSettings();
  refreshModelMaxContext(dom.modelSelect.value);
  updateCloudBadge();
});
dom.imageModelSelect.addEventListener("change", () => { saveCurrentSettings(); updateImageGenOptions(); renderStagedImagePreview(); renderChat(); });
dom.comfyModelSelect?.addEventListener("change", () => { syncComfyModelPickLabel(); saveCurrentSettings(); updateImageGenOptions(); updateComfyMultiHint(); applyInputPlaceholder(); renderStagedImagePreview(); renderChat(); });
// The <select> is hidden behind a 4-column picker (one column per model type) — the
// flat list had grown past what a dropdown can usefully convey.
dom.comfyModelPickBtn?.addEventListener("click", () => openComfyModelPicker());
dom.voiceSelect.addEventListener("change", saveCurrentSettings);
// Persist the default image size as soon as it's picked (not only on send/Save).
dom.defaultImageSize?.addEventListener("change", saveCurrentSettings);
if (dom.numCtxSelect) {
  dom.numCtxSelect.addEventListener("change", () => {
    saveCurrentSettings();
    renderContextMeter();
  });
}
// ⚙ next to the LLM model select — holds the context-window setting (same modal
// pattern as the ComfyUI / ask parameter popups).
{
  const modal = dom.llmParamsModal;
  const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); close(); } };
  const close = () => {
    if (modal) modal.hidden = true;
    document.removeEventListener("keydown", onKey);
  };
  dom.llmParamsBtn?.addEventListener("click", () => {
    if (!modal) return;
    modal.hidden = false;
    document.addEventListener("keydown", onKey);
  });
  dom.llmParamsClose?.addEventListener("click", close);
  modal?.addEventListener("mousedown", (e) => { if (e.target === modal) close(); });
  // Both caps feed buildMessages, so a change also refreshes the context meter.
  for (const el of [dom.llmMaxImages, dom.llmMaxMessages]) {
    el?.addEventListener("change", () => {
      saveCurrentSettings();
      renderContextMeter();
    });
  }
  // The timeout changes nothing about what gets sent, so no meter refresh.
  dom.llmTimeout?.addEventListener("change", saveCurrentSettings);
}
// ⚙ next to the Basic tab's one-line personality summary — same modal pattern again.
{
  const modal = dom.personaModal;
  const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); close(); } };
  const close = () => {
    if (modal) modal.hidden = true;
    document.removeEventListener("keydown", onKey);
  };
  dom.personaBtn?.addEventListener("click", () => {
    if (!modal) return;
    modal.hidden = false;
    document.addEventListener("keydown", onKey);
  });
  dom.personaModalClose?.addEventListener("click", close);
  modal?.addEventListener("mousedown", (e) => { if (e.target === modal) close(); });
}
// Marks that the user EXPLICITLY picked a PDF engine (vs. the app-chosen default).
// Needed because in WKWebView a `selected hidden` <option> silently falls through to
// the first visible option (pdf.js) at load — see syncPdfEngineOptions.
const PDF_ENGINE_PICKED_KEY = "heykoko-pdf-engine-picked";
if (dom.pdfEngineSelect) {
  dom.pdfEngineSelect.addEventListener("change", () => {
    try { localStorage.setItem(PDF_ENGINE_PICKED_KEY, "1"); } catch {}
    saveCurrentSettings();
  });
}
if (dom.embedModelSelect) {
  // Capture the value before the user opens the dropdown (options load async).
  let prevEmbedModel = dom.embedModelSelect.value;
  dom.embedModelSelect.addEventListener("focus", () => { prevEmbedModel = dom.embedModelSelect.value; });
  dom.embedModelSelect.addEventListener("change", () => {
    if (dom.embedModelSelect.value === prevEmbedModel) return;
    if (!confirm(t("embed_changeConfirm"))) {
      dom.embedModelSelect.value = prevEmbedModel; // revert
      return;
    }
    prevEmbedModel = dom.embedModelSelect.value;
    saveCurrentSettings();
  });
}

// --- Long-term memory manager ---
function renderMemoryList() {
  const list = dom.memoryList;
  if (!list) return;
  const mems = getMemories();
  list.innerHTML = "";
  if (!mems.length) {
    const empty = document.createElement("div");
    empty.className = "memoryEmpty";
    empty.textContent = t("memory_empty");
    list.appendChild(empty);
    return;
  }
  for (const m of mems) {
    const row = document.createElement("div");
    row.className = "memoryItem";

    const span = document.createElement("span");
    span.className = "memoryItemText";
    span.textContent = m.text;
    span.title = t("memory_editHint");
    span.addEventListener("click", () => {
      const next = prompt(t("memory_editPrompt"), m.text);
      if (next !== null) updateMemory(m.id, next);
    });

    const del = document.createElement("button");
    del.type = "button";
    del.className = "memoryItemDelete";
    del.title = t("memory_deleteTitle");
    del.textContent = "×";
    del.addEventListener("click", () => removeMemory(m.id));

    row.appendChild(span);
    row.appendChild(del);
    list.appendChild(row);
  }
}

// Re-render the list whenever memories change (add/edit/delete, incl. /memory)
setMemoryChangeHandler(renderMemoryList);
renderMemoryList();

if (dom.memoryAddBtn && dom.memoryInput) {
  const addFromInput = () => {
    const text = dom.memoryInput.value.trim();
    if (!text) return;
    addMemory(text);
    dom.memoryInput.value = "";
    dom.memoryInput.focus();
  };
  dom.memoryAddBtn.addEventListener("click", addFromInput);
  dom.memoryInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addFromInput();
    }
  });
}

// Fuzzy similarity for catching near-duplicate memories (not just exact matches)
function memoryNormalize(s) {
  return s.replace(/[\s，。、,.;:!?！？「」“”"'()（）]/g, "").toLowerCase();
}
function memoryBigrams(s) {
  const g = new Set();
  if (s.length === 1) { g.add(s); return g; }
  for (let i = 0; i < s.length - 1; i++) g.add(s.slice(i, i + 2));
  return g;
}
function memoryIsSimilar(a, b) {
  const na = memoryNormalize(a), nb = memoryNormalize(b);
  if (!na || !nb) return false;
  if (na === nb || na.includes(nb) || nb.includes(na)) return true;
  const ga = memoryBigrams(na), gb = memoryBigrams(nb);
  let inter = 0;
  for (const x of ga) if (gb.has(x)) inter++;
  return inter / (ga.size + gb.size - inter) >= 0.5;
}

// Extract durable facts from the current tab's conversation into memory
// The gallery overlay: everything ever generated, read off disk (js/gallery.js).
import("./gallery.js").then((g) => {
  g.setGalleryDeps({
    renderChat,
    setInput: (text) => {
      if (!dom.messageInput) return;
      dom.messageInput.value = text;
      dom.messageInput.focus();
      dom.messageInput.dispatchEvent(new Event("input", { bubbles: true }));  // autosize + button state
    },
    // Stage a gallery artifact as an attachment on the next message. Goes through
    // selectFile(), the same path a dropped file takes, so previews, limits and the
    // image/video/audio routing are whatever they already are.
    attachMedia: async (url, name) => {
      if (getActiveTab().locked) return;
      try {
        const file = await mediaUrlToFile(url, name);
        if (file) await selectFile(file);
      } catch { /* the frame stays in the strip; nothing was staged */ }
    },
  });
  g.initGallery();
});

// The video editor overlay: trim + stitch gallery clips (js/video-edit.js).
import("./video-edit.js").then((ve) => ve.initVideoEditor());

// Cmd+F find bar for the macOS app shell (WKWebView has none). Browsers keep
// their own — this only exposes window.__hkOpenFind for the app menu to call.
import("./find-bar.js").then((fb) => fb.initFindBar());

if (dom.memoryExtractBtn) {
  let extracting = false;
  dom.memoryExtractBtn.addEventListener("click", async () => {
    if (extracting) return;
    const tab = getActiveTab();

    // Build a plain transcript of the real conversation (skip commands/previews/summaries)
    const transcript = (tab?.messages || [])
      .filter((m) => (m.role === "user" || m.role === "assistant")
        && !m.isFilePreview && !m.isCompactSummary
        && m.content && !/^\/(memory|compact|title|clear|note|url|imagine|[01])(\s|$)/.test(m.content))
      .slice(-40)
      .map((m) => `${m.role === "user" ? "User" : "AI"}: ${m.content.slice(0, 600)}`)
      .join("\n");

    const flash = (key) => {
      dom.memoryExtractBtn.textContent = t(key);
      setTimeout(() => { dom.memoryExtractBtn.textContent = t("memory_extract"); }, 2500);
    };

    if (!transcript.trim()) {
      flash("memory_extractEmpty");
      return;
    }

    extracting = true;
    dom.memoryExtractBtn.disabled = true;
    dom.memoryExtractBtn.textContent = t("memory_extracting");

    const existing = getMemories().map((m) => `- ${m.text}`).join("\n");
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: dom.modelSelect.value,
          messages: [
            { role: "system", content: getPrompt("memoryExtract") },
            { role: "user", content: getPrompt("memoryExtractUser", existing, transcript) },
          ],
          options: { temperature: 0.3 },
          timeout: getLlmTimeout(),
        }),
      });
      if (!response.ok) throw new Error("request failed");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let full = "";
      const consume = (line) => {
        if (!line.trim()) return;
        try { full += JSON.parse(line).message?.content || ""; } catch {}
      };
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) consume(line);
      }
      buffer += decoder.decode();
      if (buffer.trim()) consume(buffer);

      // Strip any <think> reasoning, then parse one fact per line
      const cleaned = full.replace(/<think>[\s\S]*?<\/think>/gi, "");
      const facts = cleaned
        .split("\n")
        .map((l) => l.replace(/^[-*•\d.)\s]+/, "").trim())
        .filter((l) => l.length > 1 && l.length < 300);

      let added = 0;
      for (const f of facts) {
        const current = getMemories();
        if (current.some((m) => m.text === f)) continue; // exact dup — skip silently
        const similar = current.find((m) => memoryIsSimilar(m.text, f));
        if (similar && !confirm(t("memory_dupConfirm", { existing: similar.text, fact: f }))) continue;
        if (addMemory(f)) added++;
      }
      if (added > 0) {
        dom.memoryExtractBtn.textContent = t("memory_extractDone", { count: added });
        setTimeout(() => { dom.memoryExtractBtn.textContent = t("memory_extract"); }, 2500);
      } else {
        flash("memory_extractNone");
      }
    } catch {
      flash("memory_extractNone");
    } finally {
      extracting = false;
      dom.memoryExtractBtn.disabled = false;
    }
  });
}

// --- Proactive messages: reminder list + settings wiring + scheduler ---
function renderReminderList() {
  const list = dom.reminderList;
  if (!list) return;
  const items = getReminders();
  list.innerHTML = "";
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "memoryEmpty";
    empty.textContent = t("reminder_listEmpty");
    list.appendChild(empty);
    return;
  }
  for (const r of items) {
    const row = document.createElement("div");
    row.className = "reminderItem";

    const when = document.createElement("span");
    when.className = "reminderWhen";
    when.textContent = describeReminder(r);

    const text = document.createElement("span");
    text.className = "reminderText";
    text.textContent = r.text;

    const del = document.createElement("button");
    del.type = "button";
    del.className = "memoryItemDelete";
    del.title = t("reminder_deleteTitle");
    del.textContent = "×";
    del.addEventListener("click", () => removeReminder(r.id));

    row.appendChild(when);
    row.appendChild(text);
    row.appendChild(del);
    list.appendChild(row);
  }
}

setDeliverHandler(generateProactiveReply);
setReminderChangeHandler(renderReminderList);
renderReminderList();

for (const el of [dom.dailyGreetingToggle, dom.dailyGreetingTime, dom.idleNudgeToggle, dom.idleNudgeMinutes]) {
  if (el) el.addEventListener("change", saveCurrentSettings);
}

startScheduler();

// The persona textarea has no per-field auto-save (unlike the selects/toggles), so it
// saves itself: debounced while typing + immediately on blur. This is what the old
// "Save settings" button existed for — now removed as redundant.
let personaSaveTimer = null;
dom.persona.addEventListener("input", () => {
  writeBackPersonaToPreset();   // keep the named preset's text in sync while editing
  clearTimeout(personaSaveTimer);
  personaSaveTimer = setTimeout(saveCurrentSettings, 500);
});
dom.persona.addEventListener("blur", () => {
  writeBackPersonaToPreset();
  clearTimeout(personaSaveTimer);
  saveCurrentSettings();
});

// Custom-preset management buttons (Save as… / Rename / Delete)
dom.presetSaveAs.addEventListener("click", saveCurrentPersonaAsPreset);
dom.presetRename.addEventListener("click", renameCurrentPreset);
dom.presetDelete.addEventListener("click", deleteCurrentPreset);

// userName history dropdown
dom.userNameDropdownBtn.addEventListener("click", () => {
  renderUserNameDropdown();
  dom.userNameDropdown.hidden = !dom.userNameDropdown.hidden;
});
dom.userName.addEventListener("change", () => {
  const val = dom.userName.value.trim();
  if (val) addUserNameToHistory(val);
  saveCurrentSettings();
});
document.addEventListener("click", (e) => {
  if (!dom.userNameDropdown.hidden &&
      !dom.userNameDropdown.contains(e.target) &&
      e.target !== dom.userNameDropdownBtn) {
    dom.userNameDropdown.hidden = true;
  }
});

// File input
dom.fileInput.addEventListener("change", async () => {
  const files = [...(dom.fileInput.files || [])];
  dom.fileInput.value = "";
  if (files.length === 0) return;
  if (files.length === 1) {
    await selectFile(files[0]);
  } else {
    await selectMultipleFiles(files);
  }
});

// Add tab button
dom.addTab.addEventListener("click", addChatTab);

// Remove image button
dom.removeImage.addEventListener("click", clearSelectedImage);

// Remove file button
dom.removeFile.addEventListener("click", clearSelectedFile);

// Remove video button
dom.removeVideo.addEventListener("click", () => { clearSelectedVideo(); renderStagedImagePreview(); });
if (dom.removeAudio) dom.removeAudio.addEventListener("click", clearSelectedAudio);

// --- Wan Animate REPLACE: pick which person to swap (SAM2 seed point) ---
// The source frame is whatever the replace job will use: the video's poster frame,
// else the (first) staged scene image. Clicking stores a NORMALISED {x,y} in state,
// which comfyOverrides() forwards as opts.maskPoint → SAM2's positive seed.
function maskPointSource() {
  // With several source clips staged the Replace point is pinned to the FIRST one.
  const vids = getStagedVideos();
  if (vids[0]?.thumbnail) return vids[0].thumbnail;
  const imgs = getStagedImages();
  return imgs.length ? (imgs[0].preview || (imgs[0].base64 ? `data:image/png;base64,${imgs[0].base64}` : null)) : null;
}
function refreshMaskPointLabel() {
  if (!dom.comfyMaskPointLabel) return;
  const p = state.animateMaskPoint;
  dom.comfyMaskPointLabel.textContent = p
    ? t("comfy_maskPoint_set", { x: Math.round(p.x * 100), y: Math.round(p.y * 100) })
    : t("comfy_maskPoint");
}
function placeMaskMarker() {
  const p = state.animateMaskPoint;
  const m = dom.maskPointMarker;
  if (!m) return;
  if (!p) { m.hidden = true; return; }
  m.style.left = `${p.x * 100}%`;
  m.style.top = `${p.y * 100}%`;
  m.hidden = false;
}
function openMaskPointModal() {
  const src = maskPointSource();
  if (!src) { alert(t("comfy_maskPoint_noSource")); return; }
  dom.maskPointImage.src = src;
  placeMaskMarker();
  dom.maskPointModal.hidden = false;
}
function closeMaskPointModal() { if (dom.maskPointModal) dom.maskPointModal.hidden = true; }

dom.comfyMaskPointBtn?.addEventListener("click", openMaskPointModal);
dom.maskPointClose?.addEventListener("click", closeMaskPointModal);
dom.maskPointModal?.addEventListener("click", (e) => { if (e.target === dom.maskPointModal) closeMaskPointModal(); });

// About modal — click the "Hey-Koko" title to show the app icon + version.
function closeAboutModal() { if (dom.aboutModal) dom.aboutModal.hidden = true; }
dom.aboutBtn?.addEventListener("click", () => { if (dom.aboutModal) dom.aboutModal.hidden = false; });
dom.aboutModalClose?.addEventListener("click", closeAboutModal);
dom.aboutModal?.addEventListener("click", (e) => { if (e.target === dom.aboutModal) closeAboutModal(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && dom.aboutModal && !dom.aboutModal.hidden) closeAboutModal(); });
// Click on the frame → normalised point (clamped to [0,1]).
dom.maskPointImage?.addEventListener("click", (e) => {
  const r = dom.maskPointImage.getBoundingClientRect();
  if (!r.width || !r.height) return;
  const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
  state.animateMaskPoint = { x, y };
  placeMaskMarker();
});
dom.maskPointClear?.addEventListener("click", () => {
  state.animateMaskPoint = null;
  placeMaskMarker();
  refreshMaskPointLabel();
  closeMaskPointModal();
});
dom.maskPointConfirm?.addEventListener("click", () => {
  refreshMaskPointLabel();
  closeMaskPointModal();
});

// Streaming auto-scroll yields to the user: track whether they're near the
// bottom, and offer a one-click jump back when they've scrolled up.
dom.messagesEl.addEventListener("scroll", onMessagesScroll, { passive: true });
dom.scrollToBottomBtn?.addEventListener("click", () => {
  dom.messagesEl.scrollTop = dom.messagesEl.scrollHeight;
  refreshScrollState();
});

// Composer resize handle — drag the invisible bar straddling the top of the input
// box to make it taller/shorter. The composer's `auto` grid row grows/shrinks and
// the messages area (the `1fr` row) absorbs the change. Session-only (not persisted);
// double-click resets. A reload starts back at the default height.
{
  const resizer = document.querySelector("#composerResizer");
  const input = dom.messageInput;
  const MIN_FLOOR = 48;
  // The controls beside the input are bottom-aligned, and the 🎨 filmstrip toggle is
  // absolutely positioned ABOVE its column (bottom: 100% + 4px), so it sits outside
  // that column's own box. Shrink the input below their combined footprint and 🎨
  // escapes above the composer. Measure it rather than hardcoding a number, so the
  // floor keeps tracking the CSS if those buttons change.
  const controlsMin = () => {
    const col = document.querySelector(".composerStackCol");
    if (!col) return 0;
    const box = col.getBoundingClientRect();
    let top = box.top;
    for (const child of col.children) {
      const r = child.getBoundingClientRect();
      if (r.height) top = Math.min(top, r.top);   // absolute children included
    }
    return Math.ceil(box.bottom - top);
  };
  const minH = () => Math.max(MIN_FLOOR, controlsMin());
  const maxH = () => Math.max(minH(), Math.round((dom.chatArea?.clientHeight || window.innerHeight) * 0.6));
  const applyHeight = (h) => {
    const clamped = Math.max(minH(), Math.min(Math.round(h), maxH()));
    input.style.height = clamped + "px";
    input.style.maxHeight = clamped + "px";   // override the CSS 150px cap so it can grow past it
  };
  if (resizer && input) {
    let startY = 0, startH = 0, dragging = false;
    const onMove = (e) => { if (dragging) applyHeight(startH + (startY - e.clientY)); }; // drag up → grow
    const onUp = (e) => {
      if (!dragging) return;
      dragging = false;
      resizer.classList.remove("isDragging");
      document.body.classList.remove("isResizingComposer");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      try { resizer.releasePointerCapture(e.pointerId); } catch {}
    };
    resizer.addEventListener("pointerdown", (e) => {
      dragging = true;
      startY = e.clientY;
      startH = input.getBoundingClientRect().height;
      resizer.classList.add("isDragging");
      document.body.classList.add("isResizingComposer");
      try { resizer.setPointerCapture(e.pointerId); } catch {}
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      e.preventDefault();
    });
    // Double-click restores the default (CSS-driven) height.
    resizer.addEventListener("dblclick", () => {
      input.style.height = "";
      input.style.maxHeight = "";
    });
  }
}

// Stop translation button
dom.stopTranslateBtn.addEventListener("click", stopTranslation);

// Quick prompt button
{
  const quickPromptBtn = document.querySelector("#quickPromptBtn");
  const quickPromptPopup = document.querySelector("#quickPromptPopup");

  let quickPromptActiveIndex = 0;

  function showQuickPromptPopup() {
    quickPromptPopup.hidden = false;
    quickPromptActiveIndex = 0;
    const items = quickPromptPopup.querySelectorAll(".quickPromptItem");
    items.forEach((el, i) => el.classList.toggle("isActive", i === 0));
  }

  quickPromptBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (quickPromptPopup.hidden) {
      showQuickPromptPopup();
    } else {
      quickPromptPopup.hidden = true;
    }
    dom.messageInput.focus();
  });

  quickPromptPopup.addEventListener("click", (e) => {
    const item = e.target.closest(".quickPromptItem");
    if (!item) return;
    selectActiveQuickPrompt();
  });

  quickPromptPopup.addEventListener("mouseenter", (e) => {
    const item = e.target.closest(".quickPromptItem");
    if (!item) return;
    const items = [...quickPromptPopup.querySelectorAll(".quickPromptItem")];
    const idx = items.indexOf(item);
    if (idx >= 0) {
      quickPromptActiveIndex = idx;
      items.forEach((el, i) => el.classList.toggle("isActive", i === idx));
    }
  }, true);

  document.addEventListener("click", (e) => {
    if (!quickPromptPopup.hidden && !quickPromptBtn.contains(e.target) && !quickPromptPopup.contains(e.target)) {
      quickPromptPopup.hidden = true;
    }
  });

  // Quick prompt on input
  dom.messageInput.addEventListener("input", () => {
    const val = dom.messageInput.value;
    if (val.startsWith("?") && !val.includes("\n")) {
      const cmd = val.split(/\s/)[0];
      if (cmd === val.trimEnd()) {
        showQuickPromptPopup();
      } else {
        quickPromptPopup.hidden = true;
      }
    } else {
      quickPromptPopup.hidden = true;
    }
  });

  window.moveQuickPromptSelection = function(dir) {
    const items = quickPromptPopup.querySelectorAll(".quickPromptItem");
    if (!items.length) return;
    let next = quickPromptActiveIndex + dir;
    if (next < 0) next = items.length - 1;
    if (next >= items.length) next = 0;
    quickPromptActiveIndex = next;
    items.forEach((el, i) => el.classList.toggle("isActive", i === next));
  };

  window.selectActiveQuickPrompt = function() {
    const items = quickPromptPopup.querySelectorAll(".quickPromptItem");
    const active = items[quickPromptActiveIndex];
    if (!active) { quickPromptPopup.hidden = true; return; }
    const prompt = active.dataset.prompt + " ";
    const input = dom.messageInput;
    const start = input.selectionStart;
    const end = input.selectionEnd;
    const val = input.value;
    // If triggered by "?" prefix, replace the "?" and insert prompt; otherwise insert at cursor
    if (val.startsWith("?") && !val.includes("\n") && val.split(/\s/)[0] === val.trimEnd()) {
      input.value = prompt;
      input.selectionStart = input.selectionEnd = prompt.length;
    } else {
      input.value = val.slice(0, start) + prompt + val.slice(end);
      input.selectionStart = input.selectionEnd = start + prompt.length;
    }
    input.focus();
    quickPromptPopup.hidden = true;
  };

  // Ctrl+/ shortcut to toggle quick prompt popup
  document.addEventListener("keydown", (e) => {
    if (e.key === "/" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (quickPromptPopup.hidden) {
        hideCommandPopup();
        showQuickPromptPopup();
        dom.messageInput.focus();
      } else {
        quickPromptPopup.hidden = true;
        hideCommandPopup();
      }
    }
  });
}

// Ask-suggest button (AI generates questions in chat bubble)
{
  const askSuggestBtn = document.querySelector("#askSuggestBtn");
  let askSuggestAbort = null;

  askSuggestBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (state.currentAbortController || state.imageGenAbortController) return;
    if (getActiveTab().locked) return;

    const tab = getActiveTab();
    const tabId = state.activeTabId;

    // Show thinking bubble in chat
    const thinkingBubble = document.createElement("div");
    thinkingBubble.className = "message assistant thinking ask-suggest-bubble";
    const body = document.createElement("div");
    body.className = "markdownBody";
    body.innerHTML = `<span class="thinking-text">${t("msg_thinkingQuestion")}<span class="thinking-dots"><span>.</span><span>.</span><span>.</span><span>.</span><span>.</span><span>.</span></span></span>`;
    thinkingBubble.appendChild(body);
    dom.messagesEl.appendChild(thinkingBubble);
    dom.messagesEl.scrollTop = dom.messagesEl.scrollHeight;

    // Show the "pause" button
    askSuggestAbort = new AbortController();
    setGenerating(true);
    state.currentAbortController = askSuggestAbort;

    // Build context from recent messages
    const recentMessages = tab.messages.slice(-6);
    const contextStr = recentMessages.map(m => `${m.role === "user" ? "User" : "AI"}: ${m.content.slice(0, 200)}`).join("\n");

    const systemPrompt = getPrompt("askSuggestSystem");
    const userPrompt = contextStr
      ? getPrompt("askSuggestUser", contextStr)
      : getPrompt("askSuggestNoContext");

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: askSuggestAbort.signal,
        body: JSON.stringify({
          model: dom.modelSelect.value,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt }
          ],
          options: { temperature: 0.9, top_p: 0.9 },
          stream: false,
        }),
      });

      if (!response.ok) {
        throw new Error("Request failed");
      }

      // Read streaming ndjson response
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let fullContent = "";

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
            const chunk = data.message?.content || "";
            fullContent += chunk;
          } catch {}
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) {
        try {
          const data = JSON.parse(buffer);
          const chunk = data.message?.content || "";
          fullContent += chunk;
        } catch {}
      }

      // Remove thinking bubble
      thinkingBubble.remove();

      // Parse questions from response
      const questions = fullContent
        .split("\n")
        .map(l => l.replace(/^\d+[\.\)、]\s*/, "").trim())
        .filter(l => l.length > 0 && l.length < 200)
        .slice(0, 5);

      if (questions.length === 0) return;

      // Show questions in a new AI chat bubble
      const questionBubble = document.createElement("div");
      questionBubble.className = "message assistant ask-suggest-bubble";
      const qBody = document.createElement("div");
      qBody.className = "markdownBody";
      const title = document.createElement("p");
      title.textContent = t("msg_askSuggestTitle");
      title.style.marginBottom = "6px";
      title.style.fontWeight = "600";
      qBody.appendChild(title);
      for (const q of questions) {
        const item = document.createElement("div");
        item.className = "askSuggestItem";
        item.textContent = q;
        item.addEventListener("click", () => {
          // Remove the question bubble
          questionBubble.remove();
          // Send as user message
          sendMessage(q);
        });
        qBody.appendChild(item);
      }
      questionBubble.appendChild(qBody);
      dom.messagesEl.appendChild(questionBubble);
      dom.messagesEl.scrollTop = dom.messagesEl.scrollHeight;
    } catch (error) {
      // Remove thinking bubble on error/abort
      thinkingBubble.remove();
      if (error.name !== "AbortError") {
        const errBubble = document.createElement("div");
        errBubble.className = "message system";
        errBubble.textContent = t("msg_genQuestionFailed");
        dom.messagesEl.appendChild(errBubble);
      }
    } finally {
      askSuggestAbort = null;
      setGenerating(false);
    }
  });
}

// Chat area drag/drop for files.
//
// Two sources land here: real OS files (dataTransfer has "Files"), and an image
// dragged OUT OF a chat bubble — that arrives as a URL (text/uri-list / text/plain,
// a data: or http image src), NOT a File. Without special handling the textarea's
// default drop inserts the raw "data:image/…;base64,…" text. Detect that URL and
// convert it into a File so it attaches as a real image instead.
function draggedImageUrl(dt) {
  if (!dt) return null;
  const raw = (dt.getData("text/uri-list") || dt.getData("text/plain") || "").trim();
  if (!raw) return null;
  // uri-list may hold several lines (comments start with #); take the first URL.
  const url = raw.split(/\r?\n/).find((l) => l && !l.startsWith("#")) || "";
  if (/^data:image\//i.test(url)) return url;
  // A frame dragged out of the gallery filmstrip. Accepted whatever it is — a clip
  // staged as a source video is as useful here as a reference image — and it is our
  // own endpoint, so there is nothing to sniff.
  if (/^https?:\/\/[^/]+\/api\/gallery\/file\//i.test(url)) return url;
  if (/^https?:\/\//i.test(url) && /\.(jpe?g|png|gif|webp|bmp|avif)(\?|#|$)/i.test(url)) return url;
  return null;
}

// Fetch a URL and hand it to the normal attachment path as a File. `name` keeps the
// gallery's own filename when there is one; selectFile() routes by mime, so an image
// becomes a reference image and a clip becomes a staged source video.
async function mediaUrlToFile(url, name) {
  const res = await fetch(url);
  const blob = await res.blob();
  const ext = (blob.type.split("/")[1] || "png").split("+")[0].replace("jpeg", "jpg");
  let base = name;
  if (!base) {
    const last = decodeURIComponent(String(url).split("?")[0].split("/").pop() || "");
    base = /\.[a-z0-9]{2,5}$/i.test(last) ? last : `dropped-media.${ext}`;
  }
  return new File([blob], base, { type: blob.type });
}

async function imageUrlToFile(url) {
  const file = await mediaUrlToFile(url);
  // Anything that is not an image only gets through on the gallery path, which
  // carries its own filename; a bare dragged URL still has to be a picture.
  return file && (file.type.startsWith("image/") || file.type.startsWith("video/") ||
                  file.type.startsWith("audio/")) ? file : null;
}

// When dragging a bubble image, the browser puts the <img>'s own src on the
// dataTransfer — but that src is the light THUMBNAIL; the full-res original lives on
// dataset.fullSrc. Override the drag payload with the full-res URL so a drop attaches
// the original, not the thumbnail. Delegated so it covers every image grid at once.
dom.messagesEl.addEventListener("dragstart", (event) => {
  const img = event.target;
  if (!(img instanceof HTMLImageElement)) return;
  const full = img.dataset.fullSrc;
  if (!full || full === img.src) return;
  try {
    event.dataTransfer.clearData();
    event.dataTransfer.setData("text/uri-list", full);
    event.dataTransfer.setData("text/plain", full);
    event.dataTransfer.effectAllowed = "copy";
  } catch {}
});

// The drop zone is the COMPOSER (chat box), not the whole chat area — the user must
// drag the file/image onto the input box to attach it, and the "release to add file"
// hint only shows there.
dom.chatForm.addEventListener("dragover", (event) => {
  const dt = event.dataTransfer;
  // During dragover getData() is blocked (protected mode), so we can only read
  // `types`. A bubble-image drag always carries "text/uri-list"; use that as the
  // overlay trigger and validate the actual URL in the drop handler.
  const isImageDrag = dt.types.includes("Files") || dt.types.includes("text/uri-list");
  if (!isImageDrag) return;
  if (getActiveTab().locked) return;
  event.preventDefault();
  dom.chatForm.classList.add("isDraggingImage");
});

dom.chatForm.addEventListener("dragleave", (event) => {
  if (!dom.chatForm.contains(event.relatedTarget)) {
    dom.chatForm.classList.remove("isDraggingImage");
  }
});

dom.chatForm.addEventListener("drop", async (event) => {
  const dt = event.dataTransfer;
  const hasFiles = dt.types.includes("Files");
  const imgUrl = hasFiles ? null : draggedImageUrl(dt);
  if (!hasFiles && !imgUrl) return;
  event.preventDefault();
  dom.chatForm.classList.remove("isDraggingImage");
  if (getActiveTab().locked) return;

  if (imgUrl) {
    try {
      const file = await imageUrlToFile(imgUrl);
      if (file) await selectFile(file);
    } catch {}
    return;
  }

  const files = [...dt.files];
  if (files.length === 0) return;
  if (files.length === 1) {
    await selectFile(files[0]);
  } else {
    await selectMultipleFiles(files);
  }
});

// Clear chat button
dom.clearChat.addEventListener("click", () => {
  getActiveTab().messages = [];
  saveChat();
  renderChat();
});

// Export chat
// --- Conversation export (Markdown / PDF / JSON) ---
function exportTimeStr(ts, withSeconds = false) {
  if (!ts) return "";
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  const base = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  return withSeconds ? `${base}:${p(d.getSeconds())}` : base;
}

function exportImgSrc(img) {
  return img ? mediaSrc(img) : null;
}

function exportImages(m) {
  const out = [];
  if (m.displayImages?.length) out.push(...m.displayImages);
  if (m.generatedImages?.length) out.push(...m.generatedImages);
  else if (m.isFilePreview && m.contextImages?.length) out.push(...m.contextImages);
  // Generated videos are represented by their poster thumbnails in exports.
  if (m.generatedVideoThumbnails?.length) out.push(...m.generatedVideoThumbnails.filter(Boolean));
  return out.map(exportImgSrc).filter(Boolean);
}

// An export leaves this machine (mailed, archived, opened on another computer), so it
// must carry its own bytes: pull every gallery reference back inline first. Returns a
// copy — the live conversation keeps its references.
const REF_MEDIA_FIELDS = ["generatedImages", "generatedVideos", "generatedMeshes",
                          "generatedThumbnails", "generatedVideoThumbnails",
                          "contextImages", "displayImages"];
async function materializeTab(tab) {
  const messages = await Promise.all(tab.messages.map(async (msg) => {
    const m = { ...msg };
    for (const f of REF_MEDIA_FIELDS) {
      if (Array.isArray(m[f]) && m[f].some(isMediaRef)) {
        m[f] = await Promise.all(m[f].map(async (v) => {
          try { return await mediaBase64(v); } catch { return v; }   // deleted file → leave the ref
        }));
      }
    }
    return m;
  }));
  return { ...tab, messages };
}

function exportNames() {
  const you = (dom.userName.value || "").split(/[,，、\s]+/).filter(Boolean)[0] || "You";
  const ai = dom.aiName?.textContent?.trim() || DEFAULT_AI_NAME;
  return { you, ai };
}

function downloadBlob(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function exportJson(tab) {
  const messages = tab.messages.map((msg) => {
    const m = { ...msg };
    // `id` is an internal runtime key (DOM diffing / upsert-by-id) with no meaning in
    // the exported conversation — drop it. Import backfills a fresh one.
    delete m.id;
    if (m.timestamp) m.timestamp = exportTimeStr(m.timestamp, true);
    // Videos ride along (generatedVideos + videoMimes/videoNames/videoWidths/videoHeights,
    // kept by the spread above) so the export replays them on import. This makes the JSON
    // heavy — the intended trade-off for a self-contained export that includes video.
    // displayImages is just a 360px thumbnail of contextImages — redundant in the
    // export. Drop it; import regenerates the thumbnail from contextImages.
    if (m.contextImages?.length) delete m.displayImages;
    // generatedThumbnails is only rendered when generatedImages is ABSENT (URL/file
    // previews). When the full generatedImages exist, the grid uses them directly and
    // the thumbnails are never read — so drop them. No import-side regen needed (unlike
    // displayImages, nothing reads generatedThumbnails while generatedImages is present).
    if (m.generatedImages?.length) delete m.generatedThumbnails;
    return m;
  });
  // userName and persona are hey-koko-local identity/settings, not part of the
  // conversation — don't export them. For a custom preset, tab.personality holds an
  // opaque local id ("cp_…") that means nothing elsewhere — export the human-readable
  // preset NAME instead (import re-binds it to a same-named local preset). Built-ins
  // keep their stable key (sweet/mature/…), re-resolved per language on import.
  const cp = getCustomPreset(tab.personality);
  const payload = { title: tab.title, personality: cp ? cp.name : tab.personality };
  payload.messages = messages;
  const data = JSON.stringify(payload, null, 2);
  downloadBlob(`${tab.title || t("msg_defaultChatTitle")}.json`, data, "application/json");
}

function exportMarkdown(tab) {
  const { you, ai } = exportNames();
  const lines = [`# ${tab.title || t("msg_defaultChatTitle")}`, "", `*${exportTimeStr(Date.now())} · ${you} & ${ai}*`, ""];
  for (const m of tab.messages) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    const who = m.role === "user" ? you : ai;
    const ts = m.timestamp ? ` · ${exportTimeStr(m.timestamp)}` : "";
    lines.push(`### ${who}${ts}`, "");
    if (m.content) lines.push(m.content);
    const imgs = exportImages(m);
    if (imgs.length) lines.push(`${m.content ? "\n" : ""}_${t("msg_exportImageCount", { n: imgs.length })}_`);
    lines.push("");
  }
  downloadBlob(`${tab.title || t("msg_defaultChatTitle")}.md`, lines.join("\n"), "text/markdown");
}

function exportPdf(tab) {
  const { you, ai } = exportNames();
  const win = window.open("", "_blank");
  if (!win) { alert("Popup blocked — allow popups to export PDF."); return; }
  const rows = tab.messages.filter((m) => m.role === "user" || m.role === "assistant").map((m) => {
    const who = m.role === "user" ? you : ai;
    const ts = m.timestamp ? exportTimeStr(m.timestamp) : "";
    const body = m.role === "assistant"
      ? `<div class="body">${markdownToHtml(m.content || "")}</div>`
      : `<div class="body plain">${escapeHtml(m.content || "")}</div>`;
    const imgs = exportImages(m).map((s) => `<img src="${s}" />`).join("");
    return `<div class="msg ${m.role}"><div class="who">${escapeHtml(who)}<span class="ts">${ts}</span></div>${body}${imgs ? `<div class="imgs">${imgs}</div>` : ""}</div>`;
  }).join("");
  const css = `
    body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;max-width:760px;margin:32px auto;padding:0 20px;color:#1a1a1a;line-height:1.6}
    h1{font-size:22px;border-bottom:2px solid #eee;padding-bottom:8px}
    .meta{color:#888;font-size:13px;margin-bottom:24px}
    .msg{margin:14px 0;padding:10px 14px;border-radius:10px;page-break-inside:avoid}
    .msg.user{background:#eef5f4}.msg.assistant{background:#faf7f9}
    .who{font-weight:700;font-size:13px;margin-bottom:4px}
    .ts{font-weight:400;color:#aaa;margin-left:8px;font-size:12px}
    .body{font-size:14px}.plain{white-space:pre-wrap}
    .imgs img{max-width:100%;border-radius:8px;margin-top:8px}
    pre{background:#f4f4f4;padding:10px;border-radius:8px;overflow-x:auto;font-size:12.5px;white-space:pre-wrap;overflow-wrap:break-word}
    code{font-family:ui-monospace,Menlo,monospace}
    table{border-collapse:collapse}td,th{border:1px solid #ddd;padding:4px 8px}
    @media print{.msg{background:#fff !important;border:1px solid #eee}}`;
  const pdfTitle = escapeHtml(tab.title || t("msg_defaultChatTitle"));
  win.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${pdfTitle}</title><style>${css}</style></head><body><h1>${pdfTitle}</h1><div class="meta">${exportTimeStr(Date.now())} · ${escapeHtml(you)} &amp; ${escapeHtml(ai)}</div>${rows}<script>window.onload=function(){setTimeout(function(){window.print();},300);};<\/script></body></html>`);
  win.document.close();
}

// Export menu (Markdown / PDF / JSON)
{
  const exportBtn = document.querySelector("#exportChat");
  const exportMenu = document.querySelector("#exportMenu");
  exportBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    exportMenu.hidden = !exportMenu.hidden;
  });
  exportMenu.addEventListener("click", (e) => {
    const fmt = e.target.closest("button")?.dataset.fmt;
    if (!fmt) return;
    exportMenu.hidden = true;
    const tab = getActiveTab();
    materializeTab(tab).then((full) => {
      if (fmt === "md") exportMarkdown(full);
      else if (fmt === "pdf") exportPdf(full);
      else if (fmt === "json") exportJson(full);
    });
  });
  document.addEventListener("click", (e) => {
    if (!exportMenu.hidden && !e.target.closest(".exportWrapper")) exportMenu.hidden = true;
  });
}

// Import chat
document.querySelector("#importChat").addEventListener("change", async (event) => {
  const files = [...(event.target.files || [])];
  if (files.length === 0) return;
  const MB = 1024 * 1024;
  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
  // A very large import (video-heavy JSON) parses on the main thread and can blow
  // the JS string/parse limit — confirm before committing to the freeze/risk.
  if (totalBytes > 150 * MB && !confirm(t("msg_importLargeConfirm", { size: Math.round(totalBytes / MB) }))) {
    event.target.value = "";
    return;
  }
  // Show the loading overlay across the blocking parse when it's big enough to
  // freeze the UI (a double-rAF lets it PAINT before JSON.parse locks the thread).
  const loadEl = document.querySelector("#chatLoading");
  const showOverlay = !!loadEl && totalBytes > 20 * MB;
  if (showOverlay) {
    loadEl.hidden = false;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  }
  try {
  for (const file of files) {
    try {
      let text, data;
      try {
        text = await file.text();
        data = JSON.parse(text);
      } catch (pe) {
        // A file past the engine's max string / parse size throws RangeError — turn
        // it into a clear "too large" message. Real JSON syntax errors rethrow so
        // the outer catch still shows their detail.
        if (pe instanceof RangeError) throw new Error(t("msg_importTooLarge", { name: file.name }));
        throw pe;
      }
      if (!Array.isArray(data.messages)) throw new Error(t("msg_invalidChatFile"));
      const messages = await Promise.all(data.messages.map(async (msg) => {
        const m = { ...msg };
        if (!m.id) m.id = genId();   // exports drop the internal id → mint a fresh one
        if (typeof m.timestamp === "string") {
          m.timestamp = new Date(m.timestamp.replace(" ", "T")).getTime();
        }
        // Map legacy image field names (images/previewImage[s]) onto the current
        // contextImages/displayImages so older exported JSON still imports correctly.
        migrateImageFields(m);
        // Exports drop displayImages (a 360px thumbnail derivable from contextImages).
        // Regenerate it for uploaded-image bubbles so they render an inline thumbnail —
        // but NOT for file/bg previews, which legitimately have contextImages and no
        // displayImages (they render via generatedThumbnails / the file-preview path).
        // A slot that is already a gallery reference has a thumbnail on the server —
        // point at it rather than downloading the full picture to shrink it again.
        if (!m.isFilePreview && m.contextImages?.length && !m.displayImages?.length) {
          m.displayImages = await Promise.all(m.contextImages.map(
            (v) => (isMediaRef(v) ? galleryThumbUrl(galleryIdOf(v)) : makePreview(mediaSrc(v)))));
        }
        // Likewise, exports drop generatedThumbnails when generatedImages exist — the grid
        // now displays the light 480px thumbnail, so regenerate it from the full-res images.
        // Remote (http) full-res can't be canvas-downscaled (CORS), so keep the URL as-is.
        if (m.generatedImages?.length && !m.generatedThumbnails?.length) {
          m.generatedThumbnails = await Promise.all(m.generatedImages.map((img) => {
            if (isMediaRef(img)) return galleryThumbUrl(galleryIdOf(img));   // already on disk
            if (img.startsWith("http")) return img;   // remote full-res: CORS blocks canvas downscaling
            return makePreview(mediaSrc(img), 480);
          }));
        }
        return m;
      }));
      // An export is deliberately self-contained: materializeTab inlines every reference
      // so the file works on a machine that has never seen this gallery. Importing it
      // would therefore pour all of that base64 straight back into IndexedDB — the exact
      // thing references exist to avoid. So file it on the way in, and keep references.
      //
      // Round-tripping your own export costs nothing: the server dedups on a content
      // hash, so each picture lands back on the id it already had. Importing someone
      // else's conversation adds their media to the gallery once, which is the point —
      // it is now media this machine has, on disk, like anything else.
      // Uploading is slower than parsing, so keep (or raise) the overlay across it —
      // otherwise a photo-heavy import looks finished while it is still filing.
      const wasHidden = !!loadEl && loadEl.hidden;
      if (loadEl && inlineMediaSlots(messages).length) loadEl.hidden = false;
      await fileInlineMedia(messages);
      if (loadEl && wasHidden && !showOverlay) loadEl.hidden = true;
      // Resolve the exported personality (built-in key or a custom preset NAME) back
      // to a local selection — re-binding to a matching local preset when we have one.
      // data.persona is intentionally ignored even when present: persona text is
      // hey-koko-local and always comes from the local resolution.
      const resolved = resolveImportedPersonality(data.personality);
      const tab = createTab(data.title || t("msg_importedChatTitle"), messages, resolved.personality);
      if (resolved.persona != null) tab.persona = resolved.persona;
      state.tabs.unshift(tab);
    } catch (e) {
      const msgEl = document.createElement("div");
      msgEl.className = "message system";
      msgEl.textContent = t("msg_importFailed", { name: file.name, error: e.message });
      dom.messagesEl.appendChild(msgEl);
    }
  }
  // Persist NOW (awaitable) so a storage-quota failure on a huge import surfaces
  // here instead of being silently dropped by the debounced saveTabs — otherwise
  // the chat looks imported but vanishes on reload.
  try {
    await saveTabsNow();
  } catch (pe) {
    const warn = document.createElement("div");
    warn.className = "message system";
    const quota = pe && (pe.name === "QuotaExceededError" || /quota/i.test(pe.message || ""));
    warn.textContent = quota ? t("msg_importQuota") : t("msg_importFailed", { name: "", error: pe.message || String(pe) });
    dom.messagesEl.appendChild(warn);
  }
  } finally {
    if (showOverlay) loadEl.hidden = true;
  }
  switchTab(state.tabs[0].id);
  event.target.value = "";
});

// Supported document extensions
const DOC_EXTENSIONS = [".pdf", ".docx", ".pptx", ".eml", ".txt", ".md", ".markdown"];

// Server-side parsing capabilities (detected at startup)
let serverCapabilities = { pandoc: false, mineru: false, unlimitedOcr: false };
async function fetchCapabilities() {
  try {
    const r = await fetch("/api/parse-file/capabilities");
    const caps = await r.json();
    serverCapabilities = caps;
    syncPdfEngineOptions();
    if (!caps.ready) {
      // Server still detecting tools, retry after a few seconds
      setTimeout(fetchCapabilities, 5000);
    }
  } catch {}
}
fetchCapabilities();

// Show the "PDF import engine" picker only when a server-side PDF engine exists, and
// reveal each engine option per capability. With no server engine there's only pdf.js
// (client fallback) → nothing to choose, so the whole control stays hidden.
function syncPdfEngineOptions() {
  const m = !!serverCapabilities.mineru, u = !!serverCapabilities.unlimitedOcr;
  if (dom.pdfEngineOptMineru) dom.pdfEngineOptMineru.hidden = !m;
  if (dom.pdfEngineOptUnlimited) dom.pdfEngineOptUnlimited.hidden = !u;
  if (dom.pdfEngineLabel) dom.pdfEngineLabel.hidden = !(m || u);
  // Resolve the effective selection. The intended default is MinerU, but in WKWebView
  // the `selected hidden` MinerU <option> falls through to the first VISIBLE option
  // (pdf.js) at load — so the value can't be trusted as a deliberate choice. Unless the
  // user EXPLICITLY picked an engine (flag set in the change handler), default to the
  // best available SERVER engine; otherwise a chat-attached PDF would silently use
  // text-only pdf.js and never call MinerU. A still-valid explicit choice is honored.
  if (dom.pdfEngineSelect) {
    const valid = (e) => (e === "mineru" && m) || (e === "unlimited" && u) || e === "pdfjs";
    let userPicked = false;
    try { userPicked = localStorage.getItem(PDF_ENGINE_PICKED_KEY) === "1"; } catch {}
    const v = dom.pdfEngineSelect.value;
    if (!(userPicked && valid(v))) dom.pdfEngineSelect.value = m ? "mineru" : (u ? "unlimited" : "pdfjs");
  }
}

// Resolve the user's PDF-engine preference against what the server actually offers.
// Default (and unknown prefs, e.g. a legacy "auto") behave as MinerU.
function pickPdfEngine(pref, caps) {
  const m = !!caps.mineru, u = !!caps.unlimitedOcr;
  switch (pref) {
    case "unlimited": return u ? "unlimited" : "pdfjs";
    case "pdfjs":     return "pdfjs";
    case "mineru":
    default:          return m ? "mineru" : "pdfjs";
  }
}
function currentPdfEngine() {
  return pickPdfEngine(dom.pdfEngineSelect?.value || "mineru", serverCapabilities);
}

function getFileExtension(name) {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot).toLowerCase() : "";
}

// "YYYYMMDD-HHMMSS" stamp marking when an upload was captured.
function uploadStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// Name an upload "<stamp>-<kind>(-N).<ext>" — the -N suffix is added only when
// several of the same kind are captured together. ext comes from the original
// filename, falling back to the mime subtype, then a per-kind default.
function makeUploadName(stamp, kind, file, idx, count) {
  let ext = getFileExtension(file.name).replace(/^\./, "").toLowerCase();
  if (!ext) {
    const sub = (file.type || "").split("/")[1] || "";
    ext = sub ? (sub === "jpeg" ? "jpg" : sub.split("+")[0]) : (kind === "video" ? "mp4" : "jpg");
  }
  const suffix = count > 1 ? `-${idx + 1}` : "";
  return `${stamp}-${kind}${suffix}.${ext}`;
}

// Normalize the staged image state into a flat array of {base64, preview}.
function getStagedImages() {
  if (!state.selectedImage) return [];
  if (state.selectedImage.multi) return state.selectedImage.multi;
  return [state.selectedImage];
}

// Choose the compose-input placeholder based on context. A selected
// multi-image model takes priority (it works even with no images staged),
// then any staged image (single-edit hint), else the default placeholder.
export function applyInputPlaceholder() {
  const v = dom.comfyModelSelect?.value;
  const isMulti = !!(v && state.comfyMultiImageModels && state.comfyMultiImageModels.has(v));
  const isMesh = !!(v && state.comfyMeshModels && state.comfyMeshModels.has(v));
  if (isMesh && getStagedImages().length === 0) {
    // 3D models need a source image — say so before the user types a prompt.
    dom.messageInput.placeholder = t("input_meshImageHint");
  } else if (isMulti) {
    dom.messageInput.placeholder = t("input_multiImageHint");
  } else if (getStagedImages().length > 0) {
    dom.messageInput.placeholder = t("input_imageEditHint");
  } else {
    dom.messageInput.placeholder = t("input_placeholder", { name: composerAiName() });
  }
}

// Render the compose-area preview for the currently staged image(s).
// Each image gets its own thumbnail with a floating remove (×) button.
function renderStagedImagePreview() {
  const images = getStagedImages();
  dom.imagePreview.querySelectorAll(".previewThumb").forEach(el => el.remove());
  // The static single-image <img> and global × button are unused — all
  // thumbnails are rendered dynamically so each has its own remove button.
  dom.previewImage.hidden = true;
  // .iconButton sets `display: grid`, which overrides the [hidden] attribute,
  // so hide the now-unused global remove button via inline style.
  if (dom.removeImage) dom.removeImage.style.display = "none";

  if (images.length === 0) {
    dom.imagePreview.hidden = true;
    applyInputPlaceholder();
    return;
  }

  // A staged image (or selected multi-image model) re-hints the input.
  applyInputPlaceholder();

  images.forEach((img, idx) => {
    const thumb = document.createElement("div");
    thumb.className = "previewThumb";

    const el = document.createElement("img");
    el.className = "multiPreviewImg";
    el.src = img.preview;
    el.alt = t("msg_previewAlt");
    thumb.appendChild(el);

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "previewThumbRemove";
    btn.setAttribute("aria-label", t("msg_removeImage"));
    btn.textContent = "×";
    btn.addEventListener("click", () => removeStagedImage(idx));
    thumb.appendChild(btn);

    // 🖌 mask, on every staged image and whatever the selected model — the region is
    // the same pixels either way and the model that reads it is only settled when the
    // job runs (/imagine -m can name one the dropdown doesn't show). Two readings:
    //  • inpaint — image #1 (the scene) with a mask-capable model. Single image →
    //    local repaint; multi-image (person-swap) → the mask locks the background
    //    pixel-for-pixel while the person from the other image(s) is composed in.
    //  • subject cutout — reference-driven models (r2v / subject→image), where the
    //    mask says which part of the photo IS the subject.
    // generateImage picks the reading; the title below just reflects the current
    // dropdown, which is the likely one.
    const refMask = comfyModelSupportsRefMask();
    {
      const maskBtn = document.createElement("button");
      maskBtn.type = "button";
      maskBtn.className = "previewThumbMask" + (img.mask ? " hasMask" : "");
      maskBtn.title = img.mask
        ? t(refMask ? "msg_cutoutEditTitle" : "msg_maskEditTitle")
        : t(refMask ? "msg_cutoutPaintTitle" : "msg_maskPaintTitle");
      maskBtn.setAttribute("aria-label", t("msg_maskPaintAria"));
      maskBtn.textContent = "🖌";
      maskBtn.addEventListener("click", async () => {
        // Paint on the full-res image (reconstruct a data URL from the raw base64),
        // not the 360px preview, so the brushed region is precise.
        const b64 = img.base64 || "";
        const fullSrc = b64
          ? `data:${b64.startsWith("/9j/") ? "image/jpeg" : "image/png"};base64,${b64}`
          : img.preview;
        const result = await openMaskModal(fullSrc, img.mask || null);
        // null = cancelled (X / Cancel / Esc) → keep the existing mask untouched.
        // "" = cleared via apply → drop it. A data URL → the new mask.
        if (result !== null) {
          img.mask = result || undefined;
          renderStagedImagePreview();
        }
      });
      thumb.appendChild(maskBtn);
    }

    dom.imagePreview.appendChild(thumb);
  });
  dom.imagePreview.hidden = false;
}

// File a staged attachment and remember, ON the staged object itself, which gallery
// file it turned out to be. That object is the same reference the composer holds, so by
// send time the attachment knows its id and the message can store a reference instead of
// the bytes (see attachUploadedImages / attachVideosToMessage in chat.js).
//
// Content-addressed, so the same picture staged anywhere gets the same id — that is the
// identity masks and the reference graph need. The promise is kept alongside the id
// because sending can outrun the round trip (paste, then Enter); the send path waits
// briefly on it, and falls back to inline bytes if it loses that race.
//
// `preview` is the thumbnail the composer already generated. Handing it to the server
// saves the bubble from pulling the full-size file just to draw a 360px box.
// Natural pixel size of a base64 picture. Cheap (the browser decodes it anyway for the
// preview) and it is the only place the size is knowable without parsing image headers
// server-side. Resolves undefined rather than rejecting: a size we could not read must
// never be able to stop an attachment from being staged.
function imageNaturalSize(b64, mime) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve(undefined);
    img.src = `data:${mime || "image/png"};base64,${b64}`;
  });
}

// `dims` may be a promise (measuring a picture means decoding it). The whole chain is
// assigned to galleryIdPromise SYNCHRONOUSLY: settleGalleryIds awaits that field before
// a send, and a field that only appears an await later would let the send race past it
// and store bytes instead of a reference.
function stageIntoGallery(obj, mime, name, preview, dims) {
  obj.galleryIdPromise = Promise.resolve(dims)
    .then((d) => fileIntoGallery(obj.base64, mime, name, d))
    .then((id) => {
      if (!id) return null;
      obj.galleryId = id;
      if (preview) cacheGalleryThumb(id, preview);
      return id;
    });
  return obj.galleryIdPromise;
}

function addStagedImages(newImages) {
  if (!newImages || newImages.length === 0) return;
  for (const im of newImages) {
    // The staged bytes, not the original file: EXIF rotation is already baked in and
    // exotic formats converted, so this is the picture the conversation will use —
    // which is also the picture whose dimensions belong on the ledger.
    const mime = sniffImageMime(im.base64 || "", im.mime || "image/jpeg");
    stageIntoGallery(im, mime, im.displayName || im.name, im.preview,
                     imageNaturalSize(im.base64 || "", mime));
  }
  state.animateMaskPoint = null; // staging changes the scene → drop any old Replace point
  const all = [...getStagedImages(), ...newImages];
  state.selectedImage = all.length === 1 ? all[0] : { multi: all, preview: all[0].preview };
  renderStagedImagePreview();
}

// Remove a single staged image by index, leaving the rest in place.
function removeStagedImage(index) {
  const images = getStagedImages();
  images.splice(index, 1);
  if (images.length === 0) {
    clearSelectedImage();
  } else {
    state.selectedImage = images.length === 1 ? images[0] : { multi: images, preview: images[0].preview };
    renderStagedImagePreview();
  }
}

// Normalize the staged video state into a flat array. Several source clips can be
// staged for BATCH video-edit (each runs the same workflow once → its own output).
function getStagedVideos() {
  if (!state.selectedVideo) return [];
  if (state.selectedVideo.multi) return state.selectedVideo.multi;
  return [state.selectedVideo];
}

// Stage a speech audio file (single slot — a new pick replaces the previous one).
async function selectAudioFile(file) {
  if (file.size > 30 * 1024 * 1024) {
    const msgEl = document.createElement("div");
    msgEl.className = "message system";
    msgEl.textContent = t("msg_audioTooLarge");
    dom.messagesEl.appendChild(msgEl);
    return;
  }
  const dataUrl = await readFileAsDataUrl(file);
  const duration = await audioDurationOf(dataUrl);
  state.selectedAudio = {
    base64: dataUrl.split(",")[1],
    mime: file.type || "audio/wav",
    name: file.name,
    duration: duration || 0,
  };
  stageIntoGallery(state.selectedAudio, state.selectedAudio.mime, file.name, null);
  clearSelectedFile(); // audio + documents are mutually exclusive (different send paths)
  renderStagedAudioPreview();
  dom.messageInput.focus();
}

// Probe an audio data-URL's duration (seconds; 0 on failure) via a detached <audio>.
function audioDurationOf(src) {
  return new Promise((resolve) => {
    const a = document.createElement("audio");
    a.preload = "metadata";
    let done = false;
    const finish = (val) => { if (done) return; done = true; clearTimeout(timer); resolve(val); };
    a.addEventListener("loadedmetadata", () => finish(isFinite(a.duration) ? a.duration : 0), { once: true });
    a.addEventListener("error", () => finish(0), { once: true });
    const timer = setTimeout(() => finish(0), 4000);
    a.src = src;
  });
}

// Render the compose-area chip for the staged speech audio (single slot).
function renderStagedAudioPreview() {
  if (!dom.audioPreviewName) return;
  dom.audioPreviewName.innerHTML = "";
  const a = state.selectedAudio;
  if (!a) {
    dom.audioPreview.hidden = true;
    return;
  }
  const chip = document.createElement("span");
  chip.className = "fileChip audioChip";
  const secs = a.duration ? ` · ${Math.round(a.duration)}s` : "";
  chip.textContent = `🎤 ${a.name}${secs}`;
  dom.audioPreviewName.appendChild(chip);
  dom.audioPreview.hidden = false;
}

// Render the compose-area preview chips for the staged source video(s). Each chip
// shows the original filename with its own × remove button.
function renderStagedVideoPreview() {
  const videos = getStagedVideos();
  // Bernini's staged images are references WITH a source clip and frame 0 without one,
  // so staging or dropping a clip flips whether they get the 🖌 cutout button.
  renderStagedImagePreview();
  dom.videoPreviewName.innerHTML = "";
  if (videos.length === 0) {
    dom.videoPreview.hidden = true;
    return;
  }
  videos.forEach((v, idx) => {
    const chip = document.createElement("span");
    chip.className = "fileChip videoChip";
    const label = document.createElement("span");
    label.textContent = `🎬 ${v.displayName || v.name}`;
    chip.appendChild(label);
    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "videoChipRemove";
    rm.setAttribute("aria-label", t("msg_removeVideo"));
    rm.textContent = "×";
    rm.addEventListener("click", () => removeStagedVideo(idx));
    chip.appendChild(rm);
    dom.videoPreviewName.appendChild(chip);
  });
  // Batch hint: several clips → each runs the workflow once; the Replace point (if
  // any) is pinned to the first clip.
  if (videos.length > 1) {
    const hint = document.createElement("span");
    hint.className = "videoBatchHint";
    hint.textContent = t("video_batchHint", { n: videos.length }) + " · " + t("video_batchReplaceNote");
    dom.videoPreviewName.appendChild(hint);
  }
  // The global × button clears ALL staged videos; per-chip × removes just one.
  dom.videoPreview.hidden = false;
}

// Append newly staged source videos to the existing selection (no hard count cap).
function addStagedVideos(newVideos) {
  if (!newVideos || newVideos.length === 0) return;
  // Same reason as images, and it matters more here: a staged clip exists as base64
  // inside the tab record and nowhere else. "It came off the user's disk" is not a
  // safety net — the conversation is what has to survive, and IndexedDB is exactly the
  // store that lost everything once. Tens of megabytes per clip also make this the
  // single biggest thing NOT to keep a second copy of.
  for (const v of newVideos) {
    stageIntoGallery(v, v.mime || "video/mp4", v.displayName || v.name, v.thumbnail,
                     (v.width && v.height) ? { width: v.width, height: v.height } : undefined);
  }
  // A new source clip changes the scene → drop any old Replace point. The point is
  // pinned to the FIRST staged video, so only clear it when starting from empty.
  if (getStagedVideos().length === 0) state.animateMaskPoint = null;
  const all = [...getStagedVideos(), ...newVideos];
  state.selectedVideo = all.length === 1 ? all[0] : { multi: all };
  renderStagedVideoPreview();
}

// Remove a single staged video by index, leaving the rest in place.
function removeStagedVideo(index) {
  const videos = getStagedVideos();
  const wasFirst = index === 0;
  videos.splice(index, 1);
  if (videos.length === 0) {
    clearSelectedVideo();
    renderStagedImagePreview();   // the last clip left → Bernini's images are frame 0 again
    return;
  }
  state.selectedVideo = videos.length === 1 ? videos[0] : { multi: videos };
  // The Replace point belonged to the (old) first video — drop it if that one went.
  if (wasFirst) { state.animateMaskPoint = null; refreshMaskPointLabel(); }
  renderStagedVideoPreview();
}

// Render the compose-area preview chips for the staged document file(s).
function renderStagedFilePreview() {
  if (!dom.filePreviewName) return;
  const files = state.selectedFile
    ? (state.selectedFile.multi || [state.selectedFile])
    : [];
  dom.filePreviewName.innerHTML = "";
  if (files.length === 0) {
    dom.filePreview.hidden = true;
    return;
  }
  for (const f of files) {
    const chip = document.createElement("span");
    chip.className = "fileChip";
    chip.textContent = `📄 ${f.name}`;
    dom.filePreviewName.appendChild(chip);
  }
  dom.filePreview.hidden = false;
}

// Repaint every compose-area attachment preview from the current state. Used when
// switching tabs restores a tab's previously-staged attachments.
export function renderStagedAttachments() {
  renderStagedImagePreview();
  renderStagedVideoPreview();
  renderStagedAudioPreview();
  renderStagedFilePreview();
  refreshMaskPointLabel();
}

// File selection helper (images + documents)
async function selectFile(file) {
  if (!file) return;

  const ext = getFileExtension(file.name);
  const isImage = file.type.startsWith("image/");
  const isVideo = file.type.startsWith("video/");
  const isAudio = file.type.startsWith("audio/");
  const isDocument = DOC_EXTENSIONS.includes(ext);

  if (!isImage && !isVideo && !isAudio && !isDocument) {
    const msgEl = document.createElement("div");
    msgEl.className = "message system";
    msgEl.textContent = t("msg_unsupportedFileType");
    dom.messagesEl.appendChild(msgEl);
    return;
  }

  // Audio handling — a speech track for audio-driven video dubbing (InfiniteTalk:
  // source video + this audio → the person re-lip-synced to it). ONE audio at a
  // time (a new pick replaces the old); rides along with staged images/videos,
  // exclusive with documents (those take a different send path).
  if (isAudio) {
    await selectAudioFile(file);
    return;
  }

  // Video handling — short clips are attached for display only; they are never
  // sent to the model (no AI analysis), so we just stage the raw bytes.
  if (isVideo) {
    if (file.size > 100 * 1024 * 1024) {
      const msgEl = document.createElement("div");
      msgEl.className = "message system";
      msgEl.textContent = t("msg_videoTooLarge");
      dom.messagesEl.appendChild(msgEl);
      return;
    }
    const dataUrl = await readFileAsDataUrl(file);
    // Capture a poster frame now so it shows before the clip is played (the same
    // helper the generated-clip backfill uses, so the format is consistent).
    const thumbnail = await videoThumbnail(dataUrl);
    const dims = await videoNaturalSize(dataUrl); // for Bernini source-aspect sizing
    // Source clips ACCUMULATE: several can be staged for batch video-edit (each runs
    // the chosen workflow once → its own output). A video can ride along with staged
    // images; documents use a separate send path, so those stay mutually exclusive.
    addStagedVideos([{
      base64: dataUrl.split(",")[1],
      mime: file.type || "video/mp4",
      name: makeUploadName(uploadStamp(), "video", file, 0, 1),
      displayName: file.name,
      thumbnail,
      width: dims?.w,
      height: dims?.h,
    }]);
    clearSelectedFile();
    dom.messageInput.focus();
    return;
  }

  // Image handling (existing logic)
  if (isImage) {
    if (file.size > 16 * 1024 * 1024) {
      const msgEl = document.createElement("div");
      msgEl.className = "message system";
      msgEl.textContent = t("msg_imageTooLarge");
      dom.messagesEl.appendChild(msgEl);
      clearSelectedImage();
      return;
    }

    const dataUrl = await readFileAsDataUrl(file);
    const needsConvert = !/^image\/(jpeg|png|gif|webp)$/i.test(file.type);
    // Bake EXIF orientation into the pixels for standard formats (so a portrait
    // phone photo uploads as portrait bytes, not landscape-with-a-rotate-flag);
    // convert exotic formats to JPEG as before.
    const sendDataUrl = needsConvert ? await convertToJpeg(dataUrl) : await normalizeOrientation(dataUrl, file.type);
    const preview = await makePreview(sendDataUrl);
    addStagedImages([{ base64: sendDataUrl.split(",")[1], preview, name: makeUploadName(uploadStamp(), "image", file, 0, 1), displayName: file.name }]);
    clearSelectedFile();
    dom.messageInput.focus();
    return;
  }

  // Document handling
  if (file.size > 50 * 1024 * 1024) {
    const msgEl = document.createElement("div");
    msgEl.className = "message system";
    msgEl.textContent = t("msg_fileTooLarge");
    dom.messagesEl.appendChild(msgEl);
    return;
  }

  try {
    let text = "";
    let images = [];

    let tool = "";

    if (ext === ".txt" || ext === ".md" || ext === ".markdown") {
      text = await readFileAsText(file);
      tool = "text";
    } else if (ext === ".pdf" || ext === ".docx" || ext === ".pptx" || ext === ".eml") {
      // Store raw file for deferred parsing (after user bubble is shown)
      const newFile = { name: file.name, rawFile: file, ext, needsParse: true };
      // Accumulate if already has selected file(s)
      if (state.selectedFile && state.selectedFile.needsParse) {
        const existing = state.selectedFile.multi ? state.selectedFile.multi : [state.selectedFile];
        existing.push(newFile);
        state.selectedFile = { multi: existing };
      } else if (state.selectedFile && state.selectedFile.multi) {
        state.selectedFile.multi.push(newFile);
      } else {
        state.selectedFile = newFile;
      }
      clearSelectedImage();
      clearSelectedVideo();
      clearSelectedAudio();
      renderStagedFilePreview();
      dom.messageInput.focus();
      return;
    }

    if (!text.trim() && images.length === 0) {
      const msgEl = document.createElement("div");
      msgEl.className = "message system";
      msgEl.textContent = t("msg_noContentExtracted");
      dom.messagesEl.appendChild(msgEl);
      return;
    }

    const newFile = { name: file.name, text, images, tool };
    // Accumulate if already has selected file(s)
    if (state.selectedFile) {
      const existing = state.selectedFile.multi ? state.selectedFile.multi : [state.selectedFile];
      existing.push(newFile);
      state.selectedFile = { multi: existing };
    } else {
      state.selectedFile = newFile;
    }
    clearSelectedImage();
    clearSelectedVideo();
    clearSelectedAudio();
    renderStagedFilePreview();
    dom.messageInput.focus();
  } catch (e) {
    const msgEl = document.createElement("div");
    msgEl.className = "message system";
    msgEl.textContent = t("msg_fileParseFailed", { error: e.message });
    dom.messagesEl.appendChild(msgEl);
  }
}

// Handle multiple file selection
async function selectMultipleFiles(files) {
  // Speech audio rides along with anything visual (video+audio is the natural drop
  // for InfiniteTalk dubbing): peel audio files off first — the LAST one wins the
  // single audio slot — and let the rest flow through the normal rules.
  const audioFiles = files.filter(f => f.type.startsWith("audio/"));
  if (audioFiles.length) {
    await selectAudioFile(audioFiles[audioFiles.length - 1]);
    files = files.filter(f => !f.type.startsWith("audio/"));
    if (files.length === 0) return;
  }
  // Videos batch together (each becomes its own source clip), but can't be mixed
  // with images/documents in one drop — they take different send paths.
  const hasVideo = files.some(f => f.type.startsWith("video/"));
  if (hasVideo) {
    if (files.some(f => !f.type.startsWith("video/"))) {
      const msgEl = document.createElement("div");
      msgEl.className = "message system";
      msgEl.textContent = t("msg_videoSeparate");
      dom.messagesEl.appendChild(msgEl);
      return;
    }
    const videos = [];
    const validFiles = [];
    for (const file of files) {
      if (file.size > 100 * 1024 * 1024) {
        const msgEl = document.createElement("div");
        msgEl.className = "message system";
        msgEl.textContent = t("msg_videoTooLargeSkip", { name: file.name });
        dom.messagesEl.appendChild(msgEl);
        continue;
      }
      const dataUrl = await readFileAsDataUrl(file);
      const thumbnail = await videoThumbnail(dataUrl);
      const dims = await videoNaturalSize(dataUrl);
      videos.push({ base64: dataUrl.split(",")[1], mime: file.type || "video/mp4", thumbnail, width: dims?.w, height: dims?.h, _file: file });
      validFiles.push(file);
    }
    if (videos.length === 0) return;
    const stamp = uploadStamp();
    videos.forEach((v, i) => { v.name = makeUploadName(stamp, "video", validFiles[i], i, videos.length); v.displayName = validFiles[i].name; delete v._file; });
    addStagedVideos(videos);
    clearSelectedFile();
    dom.messageInput.focus();
    return;
  }
  const hasImage = files.some(f => f.type.startsWith("image/"));
  const hasNonImage = files.some(f => !f.type.startsWith("image/"));

  // If images are mixed with non-images, reject
  if (hasImage && hasNonImage) {
    const msgEl = document.createElement("div");
    msgEl.className = "message system";
    msgEl.textContent = t("msg_mixedImageFiles");
    dom.messagesEl.appendChild(msgEl);
    return;
  }

  if (hasImage) {
    // All images: collect into a single multi-image selection
    const images = [];
    const validFiles = [];
    for (const file of files) {
      if (file.size > 16 * 1024 * 1024) {
        const msgEl = document.createElement("div");
        msgEl.className = "message system";
        msgEl.textContent = t("msg_imageTooLargeSkip", { name: file.name });
        dom.messagesEl.appendChild(msgEl);
        continue;
      }
      const dataUrl = await readFileAsDataUrl(file);
      const needsConvert = !/^image\/(jpeg|png|gif|webp)$/i.test(file.type);
      // Bake EXIF orientation into the pixels (portrait phone photos upload as
      // portrait bytes) for standard formats; convert exotic formats to JPEG.
      const sendDataUrl = needsConvert ? await convertToJpeg(dataUrl) : await normalizeOrientation(dataUrl, file.type);
      const preview = await makePreview(sendDataUrl);
      images.push({ base64: sendDataUrl.split(",")[1], preview });
      validFiles.push(file);
    }
    if (images.length === 0) return;
    // Stamp the whole batch with one time; -1/-2 distinguishes them.
    const stamp = uploadStamp();
    images.forEach((img, i) => { img.name = makeUploadName(stamp, "image", validFiles[i], i, images.length); img.displayName = validFiles[i].name; });
    // Append to any already-staged images (don't replace)
    addStagedImages(images);
    clearSelectedFile();
    dom.messageInput.focus();
  } else {
    // All documents: store in state, show in preview, process on send
    const validFiles = [];
    for (const file of files) {
      const ext = getFileExtension(file.name);
      const isDocument = DOC_EXTENSIONS.includes(ext);
      if (!isDocument) {
        const msgEl = document.createElement("div");
        msgEl.className = "message system";
        msgEl.textContent = t("msg_unsupportedFileNamed", { name: file.name });
        dom.messagesEl.appendChild(msgEl);
        continue;
      }
      if (file.size > 50 * 1024 * 1024) {
        const msgEl = document.createElement("div");
        msgEl.className = "message system";
        msgEl.textContent = t("msg_fileTooLargeSkip", { name: file.name });
        dom.messagesEl.appendChild(msgEl);
        continue;
      }
      validFiles.push({ name: file.name, rawFile: file, ext, needsParse: true });
    }
    if (validFiles.length === 0) return;
    state.selectedFile = validFiles.length === 1 ? validFiles[0] : { multi: validFiles };
    clearSelectedImage();
    clearSelectedVideo();
    clearSelectedAudio();
    // Show all file names in preview
    dom.filePreviewName.innerHTML = "";
    for (const f of validFiles) {
      const chip = document.createElement("span");
      chip.className = "fileChip";
      chip.textContent = `📄 ${f.name}`;
      dom.filePreviewName.appendChild(chip);
    }
    dom.filePreview.hidden = false;
    dom.messageInput.focus();
  }
}

async function tryServerParse(file, onProgress = null, pdfEngine = null) {
  try {
    const formData = new FormData();
    formData.append("file", file);
    // Tell the server which PDF engine to use (mineru | unlimited); absent → server default.
    const headers = (pdfEngine === "mineru" || pdfEngine === "unlimited")
      ? { "x-pdf-engine": pdfEngine } : {};
    const response = await fetch("/api/parse-file", { method: "POST", body: formData, headers });

    const contentType = response.headers.get("content-type") || "";

    // Handle streaming ndjson (MinerU with progress)
    if (contentType.includes("ndjson")) {
      // Foreground shows a status bubble; a headless (background-job) caller passes
      // onProgress and gets the progress text routed there instead (no DOM).
      let progressEl = null;
      if (!onProgress) {
        progressEl = document.createElement("div");
        progressEl.className = "message system fileParseProgress";
        progressEl.textContent = t("msg_parsingFile");
        dom.messagesEl.appendChild(progressEl);
        dom.messagesEl.scrollTop = dom.messagesEl.scrollHeight;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let result = null;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop();

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const data = JSON.parse(line);
            if (data.progress) {
              if (onProgress) onProgress(`⏳ ${data.progress}`);
              else { progressEl.textContent = `⏳ ${data.progress}`; dom.messagesEl.scrollTop = dom.messagesEl.scrollHeight; }
            } else if (data.error) {
              if (progressEl) progressEl.textContent = `❌ ${data.error}`;
              return null;
            } else if (data.text !== undefined) {
              result = data;
            }
          } catch {}
        }
      }

      if (progressEl) progressEl.remove();
      return result;
    }

    // Handle regular JSON response (Pandoc)
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      if (data.fallback) return null;
      return null;
    }
    return await response.json();
  } catch {
    return null;
  }
}

async function parseAndSendFile(content, fileInfo) {
  const { name, rawFile, ext } = fileInfo;

  // Show parsing status bubble
  const pending = document.createElement("div");
  pending.className = "message assistant thinking";
  const body = document.createElement("div");
  body.className = "markdownBody";
  body.innerHTML = `<span class="thinking-text">${t("msg_parsingFileShort")}<span class="thinking-dots"><span>.</span><span>.</span><span>.</span><span>.</span><span>.</span><span>.</span></span></span>`;
  pending.appendChild(body);
  dom.messagesEl.appendChild(pending);
  dom.messagesEl.scrollTop = dom.messagesEl.scrollHeight;

  try {
    let text = "";
    let images = [];
    let tool = "";
    let displayThumbnails = null, displayImages = null, displayImageNames = null;

    if (ext === ".eml") {
      // EML: parse locally, optionally convert HTML body via Pandoc
      const raw = await readFileAsText(rawFile);
      const result = parseEml(raw);
      tool = "eml";
      // Email images are DISPLAY-ONLY (never `images`, which feeds contextImages):
      // mail is full of signature logos and banners, and the body now carries
      // [📷 N] markers saying where each one sat. Same policy as /tool @outlook.
      let mailImages = result.images;

      if (result.rawHtml && serverCapabilities.pandoc) {
        // Convert HTML body to Markdown via Pandoc
        try {
          const response = await fetch("/api/parse-html", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ html: result.rawHtml }),
          });
          if (response.ok) {
            const data = await response.json();
            // Remote <img src="https://…"> the server downloaded — renumber after the
            // inline ones so one [📷 N] sequence covers both kinds.
            const merged = mergeRemoteMailImages(data.markdown, mailImages.length, data.images);
            text = result.headers + "\n---\n\n" + merged.markdown;
            if (merged.images.length) mailImages = mailImages.concat(merged.images);
            tool = "eml+pandoc";
          } else {
            text = result.text;
          }
        } catch {
          text = result.text;
        }
      } else {
        text = result.text;
      }
      ({ displayImages, displayImageNames, displayThumbnails } = await buildMailImageDisplay(mailImages));
    } else {
      let serverResult = null;

      if (ext === ".pdf") {
        // pdfjs → client text-only fallback below; mineru/unlimited → server parse.
        const engine = currentPdfEngine();
        if (engine === "mineru" || engine === "unlimited") {
          serverResult = await tryServerParse(rawFile, null, engine);
          // The user explicitly chose an OCR engine (MinerU / Unlimited-OCR). On failure
          // or timeout, DON'T silently fall back to pdf.js text-only — that drops every
          // figure and hides the failure. Surface the error and stop.
          if (!serverResult) {
            pending.remove();
            const label = engine === "mineru" ? "MinerU" : "Unlimited-OCR";
            const msgEl = document.createElement("div");
            msgEl.className = "message system";
            msgEl.textContent = t("msg_ocrFailed", { label });
            dom.messagesEl.appendChild(msgEl);
            dom.messagesEl.scrollTop = dom.messagesEl.scrollHeight;
            return;
          }
        }
      } else if ((ext === ".docx" || ext === ".pptx") && serverCapabilities.pandoc) {
        serverResult = await tryServerParse(rawFile);
      }

      if (serverResult) {
        text = serverResult.text;
        images = serverResult.images || [];
        tool = serverResult.tool || (ext === ".pdf" ? "MinerU" : "Pandoc");
      } else {
        if (ext === ".pdf") {
          text = await extractPdfText(rawFile);
          tool = "pdf.js";
        } else if (ext === ".pptx") {
          const result = await extractPptxContent(rawFile);
          text = result.text;
          images = result.images;
          tool = "jszip";
        } else {
          const result = await extractDocxContent(rawFile);
          text = result.text;
          images = result.images;
          tool = "mammoth";
        }
      }
    }

    // An image-only email has no `images` (they're display-only now) — count those
    // too, or it would be reported as "nothing extracted".
    if (!text.trim() && images.length === 0 && !(displayImages && displayImages.length)) {
      pending.remove();
      const msgEl = document.createElement("div");
      msgEl.className = "message system";
      msgEl.textContent = t("msg_noContentExtracted");
      dom.messagesEl.appendChild(msgEl);
      return;
    }

    pending.remove();
    const parsedFile = { name, text, images, tool, displayThumbnails, displayImages, displayImageNames };
    sendMessage(content, null, undefined, parsedFile);
  } catch (e) {
    pending.remove();
    const msgEl = document.createElement("div");
    msgEl.className = "message system";
    msgEl.textContent = t("msg_fileParseFailed", { error: e.message });
    dom.messagesEl.appendChild(msgEl);
  }
}

// Remote images the server downloaded (parse-file.js downloadEmailImages) come back
// named image_01… and referenced inline as ![](image_01.jpg) — the same numbering the
// inline (cid:) images already use. Renumber them to follow those so one sequence
// covers both, and label each ref "📷 N" like the inline ones.
function mergeRemoteMailImages(markdown, cidCount, serverImages) {
  const list = (serverImages || []).map((img, i) => {
    const n = cidCount + i + 1;
    const mime = img.mime || "image/jpeg";
    return { ...img, oldName: img.name, n, name: imageName(n, mime), mime };
  });
  const byOldName = new Map(list.filter((im) => im.oldName).map((im) => [im.oldName, im]));
  // ONE pass over the markdown: replacing name by name would cascade (renaming
  // image_01→image_02 makes the next rule rewrite it again). The server numbers its
  // downloads from image_01 too, so a name alone can't tell a downloaded image from an
  // inline one — but the inline refs are ours and always carry the "📷 N" alt text.
  const md = String(markdown || "").replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (whole, alt, name) => {
    if (isImageMarkerAlt(alt)) return whole;   // already an inline ref
    const hit = byOldName.get(name);
    return hit ? imageMarker(hit.n, hit.mime) : whole;
  });
  return { markdown: md, images: list.map(({ oldName, n, ...img }) => img) };
}

// Email images are shown in the file-preview bubble but never handed to the model:
// full-res for download/lightbox, thumbnails for the grid, uniform names matching the
// [📷 N] markers in the body. Shared by the live and headless (.eml) parse paths.
async function buildMailImageDisplay(mailImages) {
  const list = (mailImages || []).filter((im) => im && im.base64);
  if (!list.length) return { displayImages: null, displayImageNames: null, displayThumbnails: null };
  return {
    displayImages: list.map((im) => im.base64),
    displayImageNames: list.map((im, i) => im.name || imageName(i + 1, im.mime)),
    displayThumbnails: await Promise.all(
      list.map((im) => makePreview(`data:${im.mime || "image/png"};base64,${im.base64}`, 480))
    ),
  };
}

// ---- headless document parsing (for the background queue) ------------------
// Chunked base64 helpers (btoa/String.fromCharCode would overflow on a 20 MB file).
function bytesToB64(bytes) {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}
function b64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// The DOM-free core of parseAndSendFile: reconstruct the file from base64 and parse
// it (server MinerU/Pandoc with onProgress, or client fallbacks, or EML), returning
// { text, images, tool, displayThumbnails }. Injected into bg-jobs via setBgDeps so a
// `docfull` job can parse a document headlessly with phase progress.
async function parseDocumentHeadless(fileB64, name, ext, content, onProgress) {
  const rawFile = new File([b64ToBytes(fileB64)], name);
  let text = "", images = [], tool = "", displayThumbnails = null, displayImages = null, displayImageNames = null;

  if (ext === ".eml") {
    const raw = await rawFile.text();
    const result = parseEml(raw);
    tool = "eml";
    // Display-only, exactly like the live path above (see buildMailImageDisplay).
    let mailImages = result.images;
    if (result.rawHtml && serverCapabilities.pandoc) {
      try {
        const response = await fetch("/api/parse-html", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ html: result.rawHtml }),
        });
        if (response.ok) {
          const data = await response.json();
          const merged = mergeRemoteMailImages(data.markdown, mailImages.length, data.images);
          text = result.headers + "\n---\n\n" + merged.markdown;
          if (merged.images.length) mailImages = mailImages.concat(merged.images);
          tool = "eml+pandoc";
        } else text = result.text;
      } catch { text = result.text; }
    } else text = result.text;
    ({ displayImages, displayImageNames, displayThumbnails } = await buildMailImageDisplay(mailImages));
  } else {
    let serverResult = null;
    let chosenOcr = "";
    if (ext === ".pdf") {
      const engine = currentPdfEngine();
      if (engine === "mineru" || engine === "unlimited") {
        chosenOcr = engine === "mineru" ? "MinerU" : "Unlimited-OCR";
        serverResult = await tryServerParse(rawFile, onProgress, engine);
      }
    } else if ((ext === ".docx" || ext === ".pptx") && serverCapabilities.pandoc) {
      serverResult = await tryServerParse(rawFile, onProgress);
    }
    if (serverResult) {
      text = serverResult.text;
      images = serverResult.images || [];
      tool = serverResult.tool || (ext === ".pdf" ? "MinerU" : "Pandoc");
    } else if (chosenOcr) {
      // User explicitly chose an OCR engine — fail the job instead of silently
      // degrading to pdf.js text-only (which would drop all figures).
      throw new Error(t("msg_ocrFailedShort", { engine: chosenOcr }));
    } else if (ext === ".pdf") {
      text = await extractPdfText(rawFile); tool = "pdf.js";
    } else if (ext === ".pptx") {
      const r = await extractPptxContent(rawFile); text = r.text; images = r.images; tool = "jszip";
    } else {
      const r = await extractDocxContent(rawFile); text = r.text; images = r.images; tool = "mammoth";
    }
  }
  return { text, images, tool, displayThumbnails, displayImages, displayImageNames };
}

// Read a raw document into a docfull background job (parse + preview + summary run
// detached). The "📄 name" user bubble is pushed by the caller beforehand.
async function enqueueDocParse(rawFile, name, ext, content) {
  const buf = await rawFile.arrayBuffer();
  const fileB64 = bytesToB64(new Uint8Array(buf));
  enqueueBgJob({ tabId: state.activeTabId, kind: "docfull", label: t("bg_parsing"), payload: { fileB64, name, ext, content } });
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(reader.result));
    reader.addEventListener("error", () => reject(reader.error));
    reader.readAsText(file);
  });
}

function parseEml(raw) {
  // Split headers and body
  const splitIdx = raw.indexOf("\r\n\r\n") !== -1 ? raw.indexOf("\r\n\r\n") : raw.indexOf("\n\n");
  const headerSection = raw.slice(0, splitIdx);
  const bodySection = raw.slice(splitIdx + (raw[splitIdx] === "\r" ? 4 : 2));

  // Parse headers (handle folded lines)
  const unfoldedHeaders = headerSection.replace(/\r?\n[ \t]+/g, " ");
  const headerLines = unfoldedHeaders.split(/\r?\n/);
  const headers = {};
  for (const line of headerLines) {
    const colonIdx = line.indexOf(":");
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim().toLowerCase();
      const value = line.slice(colonIdx + 1).trim();
      headers[key] = value;
    }
  }

  // Decode base64 string to Uint8Array
  function base64ToBytes(b64) {
    const binStr = atob(b64);
    const bytes = new Uint8Array(binStr.length);
    for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
    return bytes;
  }

  // Decode bytes with charset
  function decodeBytes(bytes, charset) {
    try {
      return new TextDecoder(charset || "utf-8").decode(bytes);
    } catch {
      return new TextDecoder("utf-8").decode(bytes);
    }
  }

  // Decode MIME encoded words (=?charset?encoding?text?=)
  function decodeMimeWord(str) {
    return str.replace(/=\?([^?]+)\?([BQ])\?([^?]*)\?=/gi, (_, charset, encoding, text) => {
      if (encoding.toUpperCase() === "B") {
        return decodeBytes(base64ToBytes(text), charset);
      } else {
        // Quoted-printable
        const decoded = text.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (__, hex) =>
          String.fromCharCode(parseInt(hex, 16))
        );
        const bytes = new Uint8Array(decoded.length);
        for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
        return decodeBytes(bytes, charset);
      }
    });
  }

  const from = decodeMimeWord(headers["from"] || "");
  const to = decodeMimeWord(headers["to"] || "");
  const cc = decodeMimeWord(headers["cc"] || "");
  const subject = decodeMimeWord(headers["subject"] || "");
  const date = headers["date"] || "";
  const contentType = headers["content-type"] || "text/plain";

  // Extract boundary for multipart
  const boundaryMatch = contentType.match(/boundary="?([^";\r\n]+)"?/i);
  const images = [];
  const placedImages = new Set();   // indices annotateHtmlImages anchored in the body
  const seenHashes = new Map();
  let imageCounter = 0;
  let bodyText = "";

  // Recursively process multipart parts
  function processParts(body, outerBoundary) {
    const parts = body.split(new RegExp(`--${outerBoundary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:--)?`));
    let plainBody = "";
    let htmlBody = "";

    for (const part of parts) {
      if (!part.trim()) continue;
      const partSplit = part.indexOf("\r\n\r\n") !== -1 ? part.indexOf("\r\n\r\n") : part.indexOf("\n\n");
      if (partSplit === -1) continue;

      const partHeaderStr = part.slice(0, partSplit);
      const partHeaders = partHeaderStr.toLowerCase();
      const partBody = part.slice(partSplit + (part[partSplit] === "\r" ? 4 : 2)).trim();

      // Check if this part is itself multipart (nested) — use original case for boundary
      const nestedBoundary = partHeaderStr.match(/boundary="?([^";\r\n]+)"?/i);
      if (nestedBoundary) {
        const nested = processParts(partBody, nestedBoundary[1]);
        if (!plainBody && nested.plain) plainBody = nested.plain;
        if (!htmlBody && nested.html) htmlBody = nested.html;
        continue;
      }

      if (partHeaders.includes("text/plain") && !plainBody) {
        plainBody = decodePartBody(partBody, partHeaders);
      } else if (partHeaders.includes("text/html") && !htmlBody) {
        htmlBody = decodePartBody(partBody, partHeaders);
      } else if (partHeaders.includes("image/")) {
        // Extract inline image
        const mimeMatch = partHeaders.match(/content-type:\s*(image\/[a-z]+)/i);
        const mime = mimeMatch ? mimeMatch[1] : "image/png";
        const base64Data = partBody.replace(/\s+/g, "");

        const hashKey = base64Data.length + ":" + base64Data.slice(0, 64);
        if (!seenHashes.has(hashKey)) {
          imageCounter++;
          const name = imageName(imageCounter, mime);
          seenHashes.set(hashKey, name);
          // Keep the part's Content-ID and original filename (original case — partHeaders
          // is lowercased): the HTML body references inline images as <img src="cid:…">,
          // and these are what let annotateHtmlImages put a marker at the right spot.
          const cid = (partHeaderStr.match(/content-id:\s*<?([^>\r\n]+)>?/i) || [])[1] || "";
          const fname = (partHeaderStr.match(/filename="?([^";\r\n]+)"?/i)
            || partHeaderStr.match(/\bname="?([^";\r\n]+)"?/i) || [])[1] || "";
          images.push({ name, base64: base64Data, mime, cid: cid.trim(), filename: fname.trim() });
        }
      }
    }
    return { plain: plainBody, html: htmlBody };
  }

  // Replace every <img> that points at an extracted inline image with a "[📷 N]"
  // marker, and drop the rest (spacer gifs, tracking pixels, remote banners). The
  // marker survives the Pandoc conversion as plain text, so the model learns WHERE
  // each image sat even though the images themselves are display-only. Mirrors what
  // /tool @outlook does server-side (office.js htmlToAnnotatedText).
  function annotateHtmlImages(html) {
    if (!html) return html;
    return html.replace(/<img\b[^>]*>/gi, (tag) => {
      const src = ((tag.match(/\bsrc\s*=\s*"([^"]*)"/i) || tag.match(/\bsrc\s*=\s*'([^']*)'/i)
        || tag.match(/\bsrc\s*=\s*([^\s>]+)/i) || [])[1] || "").trim();
      // Remote images stay untouched: the /api/parse-html pass downloads them
      // (parse-file.js downloadEmailImages) so they display offline and the browser
      // never re-requests a tracking URL — stripping them here would silently kill that.
      if (/^https?:/i.test(src)) return tag;
      if (!src.toLowerCase().startsWith("cid:")) return "";
      const ref = src.slice(4).replace(/^</, "").replace(/>$/, "").toLowerCase();
      const idx = images.findIndex((im) => {
        if (im.cid && im.cid.toLowerCase() === ref) return true;
        // Outlook writes cid:image001.png@01DA... — match on the filename stem.
        const stem = (im.filename || "").replace(/\.[^.]+$/, "").toLowerCase();
        return !!stem && ref.includes(stem);
      });
      if (idx < 0) return "";
      // Point the tag at the extracted image's own filename so Pandoc emits a plain
      // ![📷 N](image_0N.png) reference. The bubble resolver maps that name back to
      // this message's image (buildBubbleImageResolver) and renders it INLINE, right
      // where it sat in the mail — the same shape /tool @outlook produces.
      placedImages.add(idx);
      // alt carries the "📷 N" label so Pandoc's ![alt](src) comes out as imageMarker().
      return `<img src="${images[idx].name}" alt="\u{1F4F7} ${idx + 1}">`;
    });
  }

  // <img> survives into the no-Pandoc fallback only if we turn it into markdown first
  // (stripHtml drops every tag).
  function imgTagsToMarkdown(html) {
    return String(html || "").replace(/<img\b[^>]*>/gi, (tag) => {
      const src = ((tag.match(/\bsrc\s*=\s*"([^"]*)"/i) || [])[1] || "").trim();
      const alt = ((tag.match(/\balt\s*=\s*"([^"]*)"/i) || [])[1] || "").trim();
      return src && !/^https?:/i.test(src) ? `\n![${alt}](${src})\n` : "";
    });
  }

  let rawHtml = "";

  if (boundaryMatch) {
    const result = processParts(bodySection, boundaryMatch[1]);
    rawHtml = annotateHtmlImages(result.html || "");

    // Prefer the HTML body when the mail carries inline images: only that branch can
    // place the [📷 N] markers (the text/plain alternative has no image references).
    if (result.plain && !(images.length && result.html)) {
      bodyText = result.plain;
    } else if (result.html) {
      bodyText = stripHtml(imgTagsToMarkdown(rawHtml));
    } else if (result.plain) {
      bodyText = result.plain;
    }
  } else {
    // Simple message
    bodyText = decodePartBody(bodySection, contentType);
    if (contentType.includes("text/html")) {
      rawHtml = annotateHtmlImages(bodyText);
      bodyText = stripHtml(imgTagsToMarkdown(rawHtml));
    }
  }

  function decodePartBody(body, headers) {
    // Extract charset from headers
    const charsetMatch = headers.match(/charset="?([^";\s\r\n]+)"?/i);
    const charset = charsetMatch ? charsetMatch[1] : "utf-8";

    if (/quoted-printable/i.test(headers)) {
      const decoded = body
        .replace(/=\r?\n/g, "")
        .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
      const bytes = new Uint8Array(decoded.length);
      for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
      return decodeBytes(bytes, charset);
    }
    if (/base64/i.test(headers)) {
      try { return decodeBytes(base64ToBytes(body.replace(/\s+/g, "")), charset); } catch { return body; }
    }
    return body;
  }

  function stripHtml(html) {
    return html
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<a\s[^>]*href=3D"([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)")
      .replace(/<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n\n")
      .replace(/<\/div>/gi, "\n")
      .replace(/<\/tr>/gi, "\n")
      .replace(/<\/li>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/gi, " ")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, "\"")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  // Format date to local timezone like "Thu, 2026-06-04 08:42:16 (GMT-5)"
  function formatEmailDate(dateStr) {
    if (!dateStr) return "";
    try {
      const d = new Date(dateStr);
      if (isNaN(d)) return dateStr;
      const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
      const pad = (n) => String(n).padStart(2, "0");
      const day = days[d.getDay()];
      const y = d.getFullYear();
      const m = pad(d.getMonth() + 1);
      const dd = pad(d.getDate());
      const hh = pad(d.getHours());
      const mm = pad(d.getMinutes());
      const ss = pad(d.getSeconds());
      const offset = -d.getTimezoneOffset();
      const sign = offset >= 0 ? "+" : "-";
      const absH = Math.floor(Math.abs(offset) / 60);
      const absM = Math.abs(offset) % 60;
      const tz = absM ? `GMT${sign}${absH}:${pad(absM)}` : `GMT${sign}${absH}`;
      return `${day}, ${y}-${m}-${dd} ${hh}:${mm}:${ss} (${tz})`;
    } catch { return dateStr; }
  }

  // Build formatted output
  let headerText = "";
  if (from) headerText += `**From:** ${from}\n`;
  if (to) headerText += `**To:** ${to}\n`;
  if (cc) headerText += `**CC:** ${cc}\n`;
  if (subject) headerText += `**Subject:** ${subject}\n`;
  if (date) headerText += `**Date:** ${formatEmailDate(date)}\n`;

  let text = headerText;
  if (text) text += "\n---\n\n";
  text += bodyText.trim();

  // Images anchored in the body are already shown there; only the leftovers (plain-text
  // mail, or attachments the HTML never referenced) need the trailing list, so a normal
  // mail no longer ends in a wall of duplicate refs.
  const unplaced = images.filter((_, i) => !placedImages.has(i));
  if (unplaced.length > 0) {
    text += "\n\n---\n\n";
    for (const img of unplaced) text += `![](${img.name})\n`;
  }

  return { text, images, rawHtml, headers: headerText.trim() };
}

async function loadPdfJs() {
  if (window.pdfjsLib) return window.pdfjsLib;
  const pdfjsLib = await import("/vendor/pdfjs/pdf.min.mjs");
  pdfjsLib.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.min.mjs";
  window.pdfjsLib = pdfjsLib;
  return pdfjsLib;
}

async function loadMammoth() {
  if (window.mammoth) return window.mammoth;
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "/vendor/mammoth/mammoth.browser.min.js";
    script.onload = () => resolve(window.mammoth);
    script.onerror = () => reject(new Error("Failed to load mammoth.js"));
    document.head.appendChild(script);
  });
}

async function extractPdfText(file) {
  const pdfjsLib = await loadPdfJs();
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const strings = content.items.map((item) => item.str);
    pages.push(strings.join(""));
  }
  return pages.join("\n\n");
}

async function extractDocxContent(file) {
  const mammoth = await loadMammoth();
  const arrayBuffer = await file.arrayBuffer();
  const images = [];
  const seenHashes = new Map();
  let imageCounter = 0;

  const result = await mammoth.convertToMarkdown(
    { arrayBuffer },
    {
      convertImage: mammoth.images.imgElement(async (imageElement) => {
        const buffer = await imageElement.read();
        // Simple hash for deduplication: use first 64 bytes + length
        const hashKey = buffer.byteLength + ":" + Array.from(new Uint8Array(buffer.slice(0, 64))).join(",");
        if (seenHashes.has(hashKey)) {
          return { src: seenHashes.get(hashKey) };
        }
        imageCounter++;
        const mime = imageElement.contentType || "image/png";
        const ext = mime.split("/")[1] === "png" ? ".png" : mime.split("/")[1] === "gif" ? ".gif" : ".jpg";
        const name = `image_${String(imageCounter).padStart(2, "0")}${ext}`;
        seenHashes.set(hashKey, name);
        const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));
        images.push({ name, base64, mime });
        return { src: name };
      }),
    }
  );

  // Replace <img src="image_XX.ext"> tags with ![](image_XX.ext) markdown
  let text = result.value.replace(/<img[^>]*src="([^"]+)"[^>]*\/?>?/g, "![]($1)");

  return { text, images };
}

async function loadJSZip() {
  if (window.JSZip) return window.JSZip;
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "/vendor/jszip/jszip.min.js";
    script.onload = () => resolve(window.JSZip);
    script.onerror = () => reject(new Error("Failed to load JSZip"));
    document.head.appendChild(script);
  });
}

async function extractPptxContent(file) {
  const JSZip = await loadJSZip();
  const arrayBuffer = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(arrayBuffer);

  // Collect slide files sorted by slide number
  const slideFiles = [];
  zip.forEach((relativePath) => {
    const match = relativePath.match(/^ppt\/slides\/slide(\d+)\.xml$/);
    if (match) slideFiles.push({ path: relativePath, num: parseInt(match[1]) });
  });
  slideFiles.sort((a, b) => a.num - b.num);

  // Extract text from slides
  const parser = new DOMParser();
  const pages = [];
  for (const { path: slidePath, num } of slideFiles) {
    const xml = await zip.file(slidePath).async("string");
    const doc = parser.parseFromString(xml, "application/xml");
    // Get all text nodes from <a:t> elements (PowerPoint text runs)
    const textNodes = doc.getElementsByTagNameNS("http://schemas.openxmlformats.org/drawingml/2006/main", "t");
    const texts = [];
    for (let i = 0; i < textNodes.length; i++) {
      const t = textNodes[i].textContent.trim();
      if (t) texts.push(t);
    }
    if (texts.length > 0) {
      pages.push(`## Slide ${num}\n\n${texts.join("\n")}`);
    }
  }

  // Extract images from ppt/media/
  const images = [];
  const seenHashes = new Map();
  let imageCounter = 0;
  const IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"];

  for (const [relativePath, zipEntry] of Object.entries(zip.files)) {
    if (!relativePath.startsWith("ppt/media/")) continue;
    const ext = relativePath.slice(relativePath.lastIndexOf(".")).toLowerCase();
    if (!IMAGE_EXTS.includes(ext)) continue;

    const data = await zipEntry.async("uint8array");
    const hashKey = data.byteLength + ":" + Array.from(data.slice(0, 64)).join(",");
    if (seenHashes.has(hashKey)) continue;

    imageCounter++;
    const imgExt = ext === ".jpeg" ? ".jpg" : ext;
    const name = `image_${String(imageCounter).padStart(2, "0")}${imgExt}`;
    seenHashes.set(hashKey, name);
    const mime = ext === ".png" ? "image/png" : ext === ".gif" ? "image/gif" : "image/jpeg";
    const base64 = btoa(String.fromCharCode(...data));
    images.push({ name, base64, mime });
  }

  // Add image references at the end if any
  let text = pages.join("\n\n");
  if (images.length > 0) {
    text += "\n\n## Images\n\n";
    for (const img of images) {
      text += `![](${img.name})\n`;
    }
  }

  return { text, images };
}

// Initialize Ollama URL management and scan
initOllama();

// Initialize lightbox
const lightboxApi = initLightbox();
state.openLightbox = lightboxApi.openLightbox;
const videoLightboxApi = initVideoLightbox();
state.openVideoLightbox = videoLightboxApi.openVideoLightbox;
// Mixed image+video runs (the gallery's detail pane). Registered after BOTH viewers
// exist — the coordinator hands over between them, so half of it wired up is worse than
// none of it.
state.openMediaViewer = openMediaViewer;

// Initialize archive
initArchive();

// Initialize knowledge library (imports run as SERVER-side libimport jobs; local-doc
// parsing happens server-side via MinerU/Pandoc, no in-browser parser involved)
initLibrary();
initAsk();               // /ask ⚙ params modal + #libsrc source-link click delegation
loadMentionDocs();       // prime the /ask @mention doc list
loadMentionArchives();   // prime the /ask #mention conversation-archive list

// Knowledge star map: lazy-load the (WebGL/canvas) module only on first open, so
// chat-only users never download it. Entrance lives inside the library panel.
document.querySelector("#starMapBtn")?.addEventListener("click", () => {
  import("./star-map.js").then((m) => m.openStarMap()).catch((e) => console.error("star map failed to load", e));
});

// ⏱ Timeline: library-wide view of every time-qualified relation on one year axis. Lives in the
// library header (it's a whole-library analysis, unrelated to the star map's spatial layout).
document.querySelector("#libraryTimelineBtn")?.addEventListener("click", async () => {
  try {
    // Honor the library's folder-scope dropdown; empty value = whole library.
    const folder = (document.querySelector("#libraryAskFolder")?.value || "").trim();
    const body = folder ? JSON.stringify({ folders: [folder] }) : "{}";
    const [{ openTimeline }, data] = await Promise.all([
      import("./timeline.js"),
      fetch("/api/library/timeline", { method: "POST", headers: { "Content-Type": "application/json" }, body }).then((r) => r.json()),
    ]);
    if (!data || !data.events || !data.events.length) { alert(t("timelineEmpty")); return; }
    openTimeline(data.events, { onOpenDoc: (docId) => openLibraryDoc(docId) });
  } catch (e) { console.error("timeline failed", e); }
});

// Enable drag-to-resize / auto-collapse for the settings panel.
initPanelResize();

// Selection toolbar for highlighting / annotating message text.
initHighlightUI();

// Initial render
saveTabs();
renderTabs();
updateLockedState();
// A render error must NOT skip hiding the overlay (that would leave the bouncing
// dots stuck over the chat) nor abort the rest of startup — catch and carry on.
try { renderChat(); } catch (e) { console.error("[startup] initial renderChat failed:", e); }
// The first render is done — drop the loading overlay that covered the freeze.
{
  const el = document.querySelector("#chatLoading");
  if (el) el.hidden = true;
}
// Restore the active tab's saved input draft.
{
  const _initTab = getActiveTab();
  if (_initTab && _initTab.draft) dom.messageInput.value = _initTab.draft;
}
loadModels().then(() => refreshModelMaxContext(dom.modelSelect.value)).catch(() => {});
loadImageModels().catch(() => {});
// Resume the background-jobs queue only AFTER ComfyUI models are known, so a
// resumed video job routes to the video path (state.comfyVideoModels populated).
loadComfyModels()
  .then(() => applyInputPlaceholder())
  .catch(() => {})
  .finally(() => {
    restoreBgWorkersOnLoad()
      .catch((e) => console.warn("[bg-jobs] worker restore failed:", e))
      .finally(() => {
        refreshBgWorkers();   // ping each worker → online + per-endpoint model list
        connectServerQueue(); // Option B: SSE — must be live before restore so reconnects resolve from the snapshot
        restoreBgJobsOnLoad().catch((e) => console.warn("[bg-jobs] restore failed:", e));
      });
  });
loadEmbedModels().catch(() => {});