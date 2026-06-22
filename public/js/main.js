// Main entry point - imports and initializes all modules
import { dom, state, scrollChatToEnd, refreshScrollState } from './state.js';
import { SETTINGS_KEY, PERSONALITY_PRESETS, getPersonalityPreset } from './constants.js';
import { readFileAsDataUrl, convertToJpeg, makePreview, escapeHtml } from './utils.js';
import { markdownToHtml } from './markdown.js';
import { initTheme } from './theme.js';
import { initAvatar } from './avatar.js';
import { stopSpeech, populateVoiceList, speakAdjacent } from './speech.js';
import { saveCurrentSettings, saveTabs, saveChat, loadSavedSettings, addUserNameToHistory, renderUserNameDropdown, syncPersonaEditable } from './settings.js';
import { loadTabs, getActiveTab, renderTabs, addChatTab, switchTab, clearSelectedImage, clearSelectedFile, clearSelectedVideo, createTab, setRenderChat as tabsSetRenderChat, updateLockedState } from './tabs.js';
import { initOllama, loadModels, loadImageModels, loadComfyModels, loadEmbedModels, updateImageGenOptions, updateComfyMultiHint } from './ollama.js';
import { setDeps as imageGenSetDeps, videoThumbnail, videoNaturalSize } from './image-gen.js';
import { setDeps as voiceGenSetDeps } from './voice-gen.js';
import { setRenderChat as translateSetRenderChat, stopTranslation } from './translate.js';
import { renderChat, sendMessage, setGenerating, regenerateReply, generateProactiveReply, markStopping, showSendError } from './chat.js';
import { setDeps as urlFetchSetDeps } from './url-fetch.js';
import { showCommandPopup, hideCommandPopup, moveCommandSelection, selectActiveCommand } from './commands.js';
import { initLightbox } from './lightbox.js';
import { initArchive } from './archive.js';
import { applyUILanguage, getUILanguage, t, getPrompt } from './i18n.js';
import { refreshModelMaxContext, renderContextMeter } from './context-meter.js';
import { loadMemories, getMemories, addMemory, updateMemory, removeMemory, setMemoryChangeHandler } from './memory.js';
import { loadReminders, getReminders, removeReminder, describeReminder, setReminderChangeHandler, setDeliverHandler, startScheduler } from './proactive.js';
import { initPanelResize } from './panel-resize.js';

// Wire up circular dependencies
tabsSetRenderChat(renderChat);
translateSetRenderChat(renderChat);
imageGenSetDeps({ setGenerating, renderChat });
voiceGenSetDeps({ setGenerating, renderChat });
urlFetchSetDeps({ setGenerating, renderChat, regenerateReply, showSendError });

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
      const newName = input.value.trim() || "Bella";
      dom.aiName.textContent = newName;
      localStorage.setItem("aiName", newName);
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

// Load saved settings
loadSavedSettings();

// Restore active tab's personality
{
  const initialTab = getActiveTab();
  if (initialTab && initialTab.personality) {
    dom.personalitySelect.value = initialTab.personality;
    dom.persona.value = initialTab.persona || getPersonalityPreset(initialTab.personality, getUILanguage()) || PERSONALITY_PRESETS.sweet;
  }
  syncPersonaEditable();
}

// Personality select handler
dom.personalitySelect.addEventListener("change", () => {
  const val = dom.personalitySelect.value;
  if (val === "temp") {
    dom.persona.value = "";
    dom.persona.focus();
  } else {
    dom.persona.value = getPersonalityPreset(val, getUILanguage()) || PERSONALITY_PRESETS.sweet;
  }
  syncPersonaEditable();
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
  populateVoiceList(); // re-localize voice optgroup + option labels
  renderChat();
  saveCurrentSettings();
});
dom.promptLanguageSelect.addEventListener("change", () => {
  saveCurrentSettings();
});
dom.showThinkingCheckbox.addEventListener("change", () => {
  saveCurrentSettings();
});
if (dom.toolsToggle) {
  dom.toolsToggle.addEventListener("change", saveCurrentSettings);
}

// Apply i18n on startup
applyUILanguage();

// Slider display handlers
dom.imageTimeoutInput.addEventListener("input", () => {
  dom.imageTimeoutValue.textContent = dom.imageTimeoutInput.value;
});

dom.speechRateInput.addEventListener("input", () => {
  dom.speechRateValue.textContent = dom.speechRateInput.value;
});

// ESC to stop speech
document.addEventListener("keydown", (e) => {
  if (!state.activeSpeechButton) return;
  if (e.key === "Escape") {
    stopSpeech();
    return;
  }
  // While reading, ←/→ read the previous/next message — only when focus is
  // inside the bubble being read (so arrow keys elsewhere, e.g. the composer,
  // are untouched).
  if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    const curMsg = state.activeSpeechButton.closest(".message");
    if (!curMsg || !curMsg.contains(document.activeElement)) return;
    e.preventDefault();
    speakAdjacent(e.key === "ArrowLeft" ? -1 : 1);
  }
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
  if (!content && !state.selectedImage && !state.selectedFile && !state.selectedVideo) return;

  // Sending always returns the user to the bottom, even if they'd scrolled up.
  state.stickToBottom = true;

  saveCurrentSettings();
  const image = state.selectedImage;
  const file = state.selectedFile;
  const video = state.selectedVideo;
  dom.messageInput.value = "";
  // Sent — drop the saved draft so it doesn't reappear on tab switch.
  const _activeTab = getActiveTab();
  if (_activeTab) _activeTab.draft = "";
  clearSelectedImage();
  clearSelectedFile();
  clearSelectedVideo();

  if (file && file.multi) {
    // Multiple documents: process sequentially
    for (const f of file.multi) {
      const tab = getActiveTab();
      const userContent = content || `📄 **${f.name}**`;
      tab.messages.push({ role: "user", content: userContent, timestamp: Date.now() });
      saveChat();
      renderChat();
      if (f.needsParse) {
        await parseAndSendFile(content, f);
      } else {
        sendMessage(content, null, undefined, f);
      }
    }
  } else if (file && file.needsParse) {
    // Show user bubble first (with file name), then parse
    const tab = getActiveTab();
    const userContent = content || `📄 **${file.name}**`;
    tab.messages.push({ role: "user", content: userContent, timestamp: Date.now() });
    saveChat();
    renderChat();
    await parseAndSendFile(content, file);
  } else {
    sendMessage(content, image, undefined, file, video);
  }
});

// Message input keyboard
dom.messageInput.addEventListener("keydown", (event) => {
  const qPopup = document.querySelector("#quickPromptPopup");
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

// Auto-save when model selections change
dom.modelSelect.addEventListener("change", () => {
  saveCurrentSettings();
  refreshModelMaxContext(dom.modelSelect.value);
});
dom.imageModelSelect.addEventListener("change", () => { saveCurrentSettings(); updateImageGenOptions(); });
dom.comfyModelSelect?.addEventListener("change", () => { saveCurrentSettings(); updateImageGenOptions(); updateComfyMultiHint(); applyInputPlaceholder(); });
dom.voiceSelect.addEventListener("change", saveCurrentSettings);
if (dom.numCtxSelect) {
  dom.numCtxSelect.addEventListener("change", () => {
    saveCurrentSettings();
    renderContextMeter();
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
          timeout: parseInt(dom.imageTimeoutInput.value, 10) || 120,
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

// Save settings button
dom.saveSettings.addEventListener("click", () => {
  saveCurrentSettings();
  // Show confirmation in chat
  const msgEl = document.createElement("div");
  msgEl.className = "message system";
  msgEl.textContent = "设定已保存。";
  dom.messagesEl.appendChild(msgEl);
  dom.messagesEl.scrollTop = dom.messagesEl.scrollHeight;
});

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
dom.removeVideo.addEventListener("click", clearSelectedVideo);

// Streaming auto-scroll yields to the user: track whether they're near the
// bottom, and offer a one-click jump back when they've scrolled up.
dom.messagesEl.addEventListener("scroll", refreshScrollState, { passive: true });
dom.scrollToBottomBtn?.addEventListener("click", () => {
  dom.messagesEl.scrollTop = dom.messagesEl.scrollHeight;
  refreshScrollState();
});

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
    const prompt = active.dataset.prompt;
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

    // Show "暂停" button
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
        throw new Error("请求失败");
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
        errBubble.textContent = "生成问题失败";
        dom.messagesEl.appendChild(errBubble);
      }
    } finally {
      askSuggestAbort = null;
      setGenerating(false);
    }
  });
}

// Chat area drag/drop for files
dom.chatArea.addEventListener("dragover", (event) => {
  if (!event.dataTransfer.types.includes("Files")) return;
  if (getActiveTab().locked) return;
  event.preventDefault();
  dom.chatArea.classList.add("isDraggingImage");
});

dom.chatArea.addEventListener("dragleave", (event) => {
  if (!dom.chatArea.contains(event.relatedTarget)) {
    dom.chatArea.classList.remove("isDraggingImage");
  }
});

dom.chatArea.addEventListener("drop", async (event) => {
  if (!event.dataTransfer.types.includes("Files")) return;
  event.preventDefault();
  dom.chatArea.classList.remove("isDraggingImage");
  if (getActiveTab().locked) return;
  const files = [...event.dataTransfer.files];
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
  if (!img) return null;
  if (img.startsWith("data:") || img.startsWith("http")) return img;
  const mime = img.startsWith("/9j/") ? "image/jpeg" : "image/png";
  return `data:${mime};base64,${img}`;
}

function exportImages(m) {
  const out = [];
  if (m.previewImages?.length) out.push(...m.previewImages);
  else if (m.previewImage) out.push(m.previewImage);
  if (m.generatedImages?.length) out.push(...m.generatedImages);
  else if (m.isFilePreview && m.images?.length) out.push(...m.images);
  // Generated videos are represented by their poster thumbnails in exports.
  if (m.generatedVideoThumbnails?.length) out.push(...m.generatedVideoThumbnails.filter(Boolean));
  return out.map(exportImgSrc).filter(Boolean);
}

function exportNames() {
  const you = (dom.userName.value || "").split(/[,，、\s]+/).filter(Boolean)[0] || "You";
  const ai = dom.aiName?.textContent?.trim() || "Bella";
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
    if (m.timestamp) m.timestamp = exportTimeStr(m.timestamp, true);
    // Don't export the heavy video data — keep only the poster thumbnail.
    if (m.generatedVideos) { delete m.generatedVideos; delete m.videoMime; }
    return m;
  });
  const payload = { title: tab.title, userName: dom.userName.value, personality: tab.personality };
  // "Her personality" is only a user-authored value for the custom preset; for
  // the built-in types it's derived from the preset, so don't export it.
  if (tab.personality === "temp") payload.persona = tab.persona;
  payload.messages = messages;
  const data = JSON.stringify(payload, null, 2);
  downloadBlob(`${tab.title || "对话"}.json`, data, "application/json");
}

function exportMarkdown(tab) {
  const { you, ai } = exportNames();
  const lines = [`# ${tab.title || "对话"}`, "", `*${exportTimeStr(Date.now())} · ${you} & ${ai}*`, ""];
  for (const m of tab.messages) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    const who = m.role === "user" ? you : ai;
    const ts = m.timestamp ? ` · ${exportTimeStr(m.timestamp)}` : "";
    lines.push(`### ${who}${ts}`, "");
    if (m.content) lines.push(m.content);
    const imgs = exportImages(m);
    if (imgs.length) lines.push(`${m.content ? "\n" : ""}_[图片 ×${imgs.length}]_`);
    lines.push("");
  }
  downloadBlob(`${tab.title || "对话"}.md`, lines.join("\n"), "text/markdown");
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
    pre{background:#f4f4f4;padding:10px;border-radius:8px;overflow-x:auto;font-size:12.5px}
    code{font-family:ui-monospace,Menlo,monospace}
    table{border-collapse:collapse}td,th{border:1px solid #ddd;padding:4px 8px}
    @media print{.msg{background:#fff !important;border:1px solid #eee}}`;
  win.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(tab.title || "对话")}</title><style>${css}</style></head><body><h1>${escapeHtml(tab.title || "对话")}</h1><div class="meta">${exportTimeStr(Date.now())} · ${escapeHtml(you)} &amp; ${escapeHtml(ai)}</div>${rows}<script>window.onload=function(){setTimeout(function(){window.print();},300);};<\/script></body></html>`);
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
    if (fmt === "md") exportMarkdown(tab);
    else if (fmt === "pdf") exportPdf(tab);
    else if (fmt === "json") exportJson(tab);
  });
  document.addEventListener("click", (e) => {
    if (!exportMenu.hidden && !e.target.closest(".exportWrapper")) exportMenu.hidden = true;
  });
}

// Import chat
document.querySelector("#importChat").addEventListener("change", async (event) => {
  const files = event.target.files;
  if (!files || files.length === 0) return;
  for (const file of files) {
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!Array.isArray(data.messages)) throw new Error("无效的对话文件");
      const messages = data.messages.map((msg) => {
        const m = { ...msg };
        if (typeof m.timestamp === "string") {
          m.timestamp = new Date(m.timestamp.replace(" ", "T")).getTime();
        }
        return m;
      });
      const tab = createTab(data.title || "导入的对话", messages, data.personality || null);
      if (data.persona) tab.persona = data.persona;
      state.tabs.unshift(tab);
    } catch (e) {
      const msgEl = document.createElement("div");
      msgEl.className = "message system";
      msgEl.textContent = `导入失败（${file.name}）：${e.message}`;
      dom.messagesEl.appendChild(msgEl);
    }
  }
  switchTab(state.tabs[0].id);
  event.target.value = "";
});

// Supported document extensions
const DOC_EXTENSIONS = [".pdf", ".docx", ".pptx", ".eml", ".txt", ".md", ".markdown"];

// Server-side parsing capabilities (detected at startup)
let serverCapabilities = { pandoc: false, mineru: false };
async function fetchCapabilities() {
  try {
    const r = await fetch("/api/parse-file/capabilities");
    const caps = await r.json();
    serverCapabilities = caps;
    if (!caps.ready) {
      // Server still detecting tools, retry after a few seconds
      setTimeout(fetchCapabilities, 5000);
    }
  } catch {}
}
fetchCapabilities();

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
  if (isMulti) {
    dom.messageInput.placeholder = t("input_multiImageHint");
  } else if (getStagedImages().length > 0) {
    dom.messageInput.placeholder = t("input_imageEditHint");
  } else {
    dom.messageInput.placeholder = t("input_placeholder");
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
    el.alt = "预览";
    thumb.appendChild(el);

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "previewThumbRemove";
    btn.setAttribute("aria-label", "移除图片");
    btn.textContent = "×";
    btn.addEventListener("click", () => removeStagedImage(idx));
    thumb.appendChild(btn);

    dom.imagePreview.appendChild(thumb);
  });
  dom.imagePreview.hidden = false;
}

// Append newly staged images to the existing selection (instead of replacing).
function addStagedImages(newImages) {
  if (!newImages || newImages.length === 0) return;
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

// File selection helper (images + documents)
async function selectFile(file) {
  if (!file) return;

  const ext = getFileExtension(file.name);
  const isImage = file.type.startsWith("image/");
  const isVideo = file.type.startsWith("video/");
  const isDocument = DOC_EXTENSIONS.includes(ext);

  if (!isImage && !isVideo && !isDocument) {
    const msgEl = document.createElement("div");
    msgEl.className = "message system";
    msgEl.textContent = "不支持的文件类型。请选择图片、视频、PDF、DOCX、PPTX、EML、TXT 或 MD 文件。";
    dom.messagesEl.appendChild(msgEl);
    return;
  }

  // Video handling — short clips are attached for display only; they are never
  // sent to the model (no AI analysis), so we just stage the raw bytes.
  if (isVideo) {
    if (file.size > 30 * 1024 * 1024) {
      const msgEl = document.createElement("div");
      msgEl.className = "message system";
      msgEl.textContent = "视频太大了，请选择 30MB 以内的短视频。";
      dom.messagesEl.appendChild(msgEl);
      return;
    }
    const dataUrl = await readFileAsDataUrl(file);
    // Capture a poster frame now so it shows before the clip is played (the same
    // helper the generated-clip backfill uses, so the format is consistent).
    const thumbnail = await videoThumbnail(dataUrl);
    const dims = await videoNaturalSize(dataUrl); // for Bernini source-aspect sizing
    state.selectedVideo = {
      base64: dataUrl.split(",")[1],
      mime: file.type || "video/mp4",
      name: makeUploadName(uploadStamp(), "video", file, 0, 1),
      thumbnail,
      width: dims?.w,
      height: dims?.h,
    };
    // A video can ride along with staged images, but only one video at a time
    // (assigning state.selectedVideo replaces any previous one). Documents use a
    // separate send path that ignores videos, so those stay mutually exclusive.
    clearSelectedFile();
    dom.videoPreviewName.textContent = `🎬 ${file.name}`;
    dom.videoPreview.hidden = false;
    dom.messageInput.focus();
    return;
  }

  // Image handling (existing logic)
  if (isImage) {
    if (file.size > 8 * 1024 * 1024) {
      const msgEl = document.createElement("div");
      msgEl.className = "message system";
      msgEl.textContent = "图片太大了，请选择 8MB 以内的图片。";
      dom.messagesEl.appendChild(msgEl);
      clearSelectedImage();
      return;
    }

    const dataUrl = await readFileAsDataUrl(file);
    const needsConvert = !/^image\/(jpeg|png|gif|webp)$/i.test(file.type);
    const sendDataUrl = needsConvert ? await convertToJpeg(dataUrl) : dataUrl;
    const preview = await makePreview(dataUrl);
    addStagedImages([{ base64: sendDataUrl.split(",")[1], preview, name: makeUploadName(uploadStamp(), "image", file, 0, 1) }]);
    clearSelectedFile();
    dom.messageInput.focus();
    return;
  }

  // Document handling
  if (file.size > 20 * 1024 * 1024) {
    const msgEl = document.createElement("div");
    msgEl.className = "message system";
    msgEl.textContent = "文件太大了，请选择 20MB 以内的文件。";
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
      // Show all file names
      const allFiles = state.selectedFile.multi || [state.selectedFile];
      dom.filePreviewName.innerHTML = "";
      for (const f of allFiles) {
        const chip = document.createElement("span");
        chip.className = "fileChip";
        chip.textContent = `📄 ${f.name}`;
        dom.filePreviewName.appendChild(chip);
      }
      dom.filePreview.hidden = false;
      dom.messageInput.focus();
      return;
    }

    if (!text.trim() && images.length === 0) {
      const msgEl = document.createElement("div");
      msgEl.className = "message system";
      msgEl.textContent = "无法从该文件中提取内容。";
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
    const allFiles = state.selectedFile.multi || [state.selectedFile];
    dom.filePreviewName.innerHTML = "";
    for (const f of allFiles) {
      const chip = document.createElement("span");
      chip.className = "fileChip";
      chip.textContent = `📄 ${f.name}`;
      dom.filePreviewName.appendChild(chip);
    }
    dom.filePreview.hidden = false;
    dom.messageInput.focus();
  } catch (e) {
    const msgEl = document.createElement("div");
    msgEl.className = "message system";
    msgEl.textContent = `文件解析失败：${e.message}`;
    dom.messagesEl.appendChild(msgEl);
  }
}

// Handle multiple file selection
async function selectMultipleFiles(files) {
  // Videos are attached one at a time (display-only, no AI analysis).
  if (files.some(f => f.type.startsWith("video/"))) {
    const msgEl = document.createElement("div");
    msgEl.className = "message system";
    msgEl.textContent = "视频请单独上传，一次一个。";
    dom.messagesEl.appendChild(msgEl);
    return;
  }
  const hasImage = files.some(f => f.type.startsWith("image/"));
  const hasNonImage = files.some(f => !f.type.startsWith("image/"));

  // If images are mixed with non-images, reject
  if (hasImage && hasNonImage) {
    const msgEl = document.createElement("div");
    msgEl.className = "message system";
    msgEl.textContent = "多文件上传时，如果包含图片，则所有文件都必须是图片。";
    dom.messagesEl.appendChild(msgEl);
    return;
  }

  if (hasImage) {
    // All images: collect into a single multi-image selection
    const images = [];
    const validFiles = [];
    for (const file of files) {
      if (file.size > 8 * 1024 * 1024) {
        const msgEl = document.createElement("div");
        msgEl.className = "message system";
        msgEl.textContent = `图片 ${file.name} 太大了（超过 8MB），已跳过。`;
        dom.messagesEl.appendChild(msgEl);
        continue;
      }
      const dataUrl = await readFileAsDataUrl(file);
      const needsConvert = !/^image\/(jpeg|png|gif|webp)$/i.test(file.type);
      const sendDataUrl = needsConvert ? await convertToJpeg(dataUrl) : dataUrl;
      const preview = await makePreview(dataUrl);
      images.push({ base64: sendDataUrl.split(",")[1], preview });
      validFiles.push(file);
    }
    if (images.length === 0) return;
    // Stamp the whole batch with one time; -1/-2 distinguishes them.
    const stamp = uploadStamp();
    images.forEach((img, i) => { img.name = makeUploadName(stamp, "image", validFiles[i], i, images.length); });
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
        msgEl.textContent = `不支持的文件类型：${file.name}`;
        dom.messagesEl.appendChild(msgEl);
        continue;
      }
      if (file.size > 20 * 1024 * 1024) {
        const msgEl = document.createElement("div");
        msgEl.className = "message system";
        msgEl.textContent = `文件 ${file.name} 太大了（超过 20MB），已跳过。`;
        dom.messagesEl.appendChild(msgEl);
        continue;
      }
      validFiles.push({ name: file.name, rawFile: file, ext, needsParse: true });
    }
    if (validFiles.length === 0) return;
    state.selectedFile = validFiles.length === 1 ? validFiles[0] : { multi: validFiles };
    clearSelectedImage();
    clearSelectedVideo();
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

async function tryServerParse(file) {
  try {
    const formData = new FormData();
    formData.append("file", file);
    const response = await fetch("/api/parse-file", { method: "POST", body: formData });

    const contentType = response.headers.get("content-type") || "";

    // Handle streaming ndjson (MinerU with progress)
    if (contentType.includes("ndjson")) {
      // Show progress element
      let progressEl = document.createElement("div");
      progressEl.className = "message system fileParseProgress";
      progressEl.textContent = "⏳ 正在解析文件...";
      dom.messagesEl.appendChild(progressEl);
      dom.messagesEl.scrollTop = dom.messagesEl.scrollHeight;

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
              progressEl.textContent = `⏳ ${data.progress}`;
              dom.messagesEl.scrollTop = dom.messagesEl.scrollHeight;
            } else if (data.error) {
              progressEl.textContent = `❌ ${data.error}`;
              return null;
            } else if (data.text !== undefined) {
              result = data;
            }
          } catch {}
        }
      }

      progressEl.remove();
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
  body.innerHTML = '<span class="thinking-text">正在解析文件<span class="thinking-dots"><span>.</span><span>.</span><span>.</span><span>.</span><span>.</span><span>.</span></span></span>';
  pending.appendChild(body);
  dom.messagesEl.appendChild(pending);
  dom.messagesEl.scrollTop = dom.messagesEl.scrollHeight;

  try {
    let text = "";
    let images = [];
    let tool = "";
    let displayThumbnails = null;

    if (ext === ".eml") {
      // EML: parse locally, optionally convert HTML body via Pandoc
      const raw = await readFileAsText(rawFile);
      const result = parseEml(raw);
      images = result.images;
      tool = "eml";

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
            text = result.headers + "\n---\n\n" + data.markdown;
            // Images linked in the email HTML are downloaded server-side and
            // shown as display-only thumbnails (NOT sent to the model). Inline
            // (cid:) attachments stay in `images` so vision still sees them.
            if (data.images && data.images.length) {
              const cidUrls = images.map((img) => `data:${img.mime || "image/png"};base64,${img.base64}`);
              const htmlUrls = data.images.map((img) => `data:${img.mime || "image/jpeg"};base64,${img.base64}`);
              displayThumbnails = await Promise.all([...cidUrls, ...htmlUrls].map(makePreview));
            }
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
    } else {
      const canServer = (ext === ".pdf" && serverCapabilities.mineru) ||
                        (ext === ".docx" && serverCapabilities.pandoc) ||
                        (ext === ".pptx" && serverCapabilities.pandoc);
      let serverResult = null;

      if (canServer) {
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

    if (!text.trim() && images.length === 0) {
      pending.remove();
      const msgEl = document.createElement("div");
      msgEl.className = "message system";
      msgEl.textContent = "无法从该文件中提取内容。";
      dom.messagesEl.appendChild(msgEl);
      return;
    }

    pending.remove();
    const parsedFile = { name, text, images, tool, displayThumbnails };
    sendMessage(content, null, undefined, parsedFile);
  } catch (e) {
    pending.remove();
    const msgEl = document.createElement("div");
    msgEl.className = "message system";
    msgEl.textContent = `文件解析失败：${e.message}`;
    dom.messagesEl.appendChild(msgEl);
  }
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
        const ext = mime.split("/")[1] === "png" ? ".png" : mime.split("/")[1] === "gif" ? ".gif" : ".jpg";
        const base64Data = partBody.replace(/\s+/g, "");

        const hashKey = base64Data.length + ":" + base64Data.slice(0, 64);
        if (!seenHashes.has(hashKey)) {
          imageCounter++;
          const name = `image_${String(imageCounter).padStart(2, "0")}${ext}`;
          seenHashes.set(hashKey, name);
          images.push({ name, base64: base64Data, mime });
        }
      }
    }
    return { plain: plainBody, html: htmlBody };
  }

  let rawHtml = "";

  if (boundaryMatch) {
    const result = processParts(bodySection, boundaryMatch[1]);
    rawHtml = result.html || "";

    if (result.plain) {
      bodyText = result.plain;
    } else if (result.html) {
      bodyText = stripHtml(result.html);
    }
  } else {
    // Simple message
    bodyText = decodePartBody(bodySection, contentType);
    if (contentType.includes("text/html")) {
      rawHtml = bodyText;
      bodyText = stripHtml(bodyText);
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

  if (images.length > 0) {
    text += "\n\n---\n\n";
    for (const img of images) {
      text += `![](${img.name})\n`;
    }
  }

  return { text, images, rawHtml, headers: headerText.trim() };
}

async function loadPdfJs() {
  if (window.pdfjsLib) return window.pdfjsLib;
  const pdfjsLib = await import("https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.min.mjs");
  pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.worker.min.mjs";
  window.pdfjsLib = pdfjsLib;
  return pdfjsLib;
}

async function loadMammoth() {
  if (window.mammoth) return window.mammoth;
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.8.0/mammoth.browser.min.js";
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
    script.src = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";
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

// Initialize archive
initArchive();

// Enable drag-to-resize / auto-collapse for the settings panel.
initPanelResize();

// Initial render
saveTabs();
renderTabs();
updateLockedState();
renderChat();
// Restore the active tab's saved input draft.
{
  const _initTab = getActiveTab();
  if (_initTab && _initTab.draft) dom.messageInput.value = _initTab.draft;
}
loadModels().then(() => refreshModelMaxContext(dom.modelSelect.value)).catch(() => {});
loadImageModels().catch(() => {});
loadComfyModels().then(() => applyInputPlaceholder()).catch(() => {});
loadEmbedModels().catch(() => {});
