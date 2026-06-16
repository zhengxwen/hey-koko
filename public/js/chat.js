// Chat rendering, message handling, and sending
import { dom, state } from './state.js';
import { PERSONALITY_PRESETS, TAG_COLORS } from './constants.js';
import { escapeHtml, formatTimestamp, makePreview } from './utils.js';
import { markdownToHtml, highlightCodeBlocks, renderMermaidDiagrams } from './markdown.js';
import { setAvatarState, showExpression, detectExpression } from './avatar.js';
import { speakMessage, stopSpeech } from './speech.js';
import { saveChat, saveTabs } from './settings.js';
import { getActiveTab, getTab, createTab, switchTab, renderTabs } from './tabs.js';
import { parseNoteCommand, parseImagineCommands, generateImage } from './image-gen.js';
import { translateMessage } from './translate.js';
import { parseUrlCommand, handleUrlCommand, handleMultiUrlCommand } from './url-fetch.js';
import { t, getPrompt, getPromptLanguage } from './i18n.js';
import { getNumCtx, recordContextUsage, renderContextMeter } from './context-meter.js';
import { addMemory, getMemoryPromptBlock } from './memory.js';
import { parseRemind, addReminder, describeReminder, markActivity } from './proactive.js';
import { TOOL_SCHEMAS, executeTool, getToolLabel } from './tools.js';

export function setGenerating(active) {
  if (active) {
    dom.sendButton.textContent = t("btn_stop");
    dom.sendButton.classList.add("isStop");
  } else {
    dom.sendButton.textContent = t("btn_send");
    dom.sendButton.classList.remove("isStop");
    state.currentAbortController = null;
  }
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
  if (getActiveTab().locked) return;
  stopSpeech();
  getActiveTab().messages.splice(index, 1);
  saveChat();
  renderChat();
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

function resendChatMessage(index) {
  if (state.currentAbortController || state.imageGenAbortController) return;
  const tab = getActiveTab();
  if (tab.locked) return;
  const message = tab.messages[index];
  if (!message || message.role !== "user") return;

  if (tab.messages[index + 1]?.role === "assistant") {
    tab.messages.splice(index + 1, 1);
  }
  saveChat();
  renderChat();

  if (parseNoteCommand(message.content)) return;
  const searchResend = message.content.match(/^\/search\s+([\s\S]+)/);
  if (searchResend) {
    // The results bubble (index+1) was already removed above; drop the answer too,
    // then the command bubble, and re-run the search fresh.
    if (tab.messages[index + 1]?.role === "assistant") tab.messages.splice(index + 1, 1);
    tab.messages.splice(index, 1);
    saveChat();
    renderChat();
    handleSearchCommand(searchResend[1].trim(), tab, state.activeTabId, message.content);
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
    handleCompactCommand(tab, state.activeTabId);
    return;
  }
  if (/^\/title(\s|$)/.test(message.content)) {
    handleTitleCommand(tab, state.activeTabId, message.content);
    return;
  }

  // Handle /url command on resend
  const urlTarget = parseUrlCommand(message.content);
  if (urlTarget) {
    if (urlTarget.entries.length === 1) {
      handleUrlCommand(urlTarget.entries[0].url, tab, state.activeTabId, message.content, urlTarget.entries[0].prompt);
    } else {
      handleMultiUrlCommand(urlTarget.entries, tab, state.activeTabId, message.content);
    }
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

  const imagineCmds = parseImagineCommands(message.content);
  if (imagineCmds) {
    const firstError = imagineCmds.find((cmd) => cmd && cmd.error);
    if (firstError) {
      tab.messages.splice(index + 1, 0, { role: "assistant", content: t("msg_commandError", { error: firstError.error }), timestamp: Date.now() });
      saveChat();
      renderChat();
    } else {
      const validCmds = imagineCmds.filter((cmd) => cmd && cmd.prompt);
      generateImage(validCmds, state.activeTabId, index + 1);
    }
  } else {
    dispatchReply(state.activeTabId, index + 1);
  }
}

export async function imagineFromContent(index) {
  if (state.currentAbortController || state.imageGenAbortController) return;
  const tab = getActiveTab();
  const message = tab.messages[index];
  if (!message || !message.content) return;

  const imageModel = dom.imageModelSelect.value;
  if (!imageModel) {
    const errMsg = { role: "assistant", content: t("msg_noImageModel"), timestamp: Date.now() };
    tab.messages.splice(index + 1, 0, errMsg);
    saveChat();
    renderChat();
    return;
  }

  const placeholderMsg = { role: "user", content: `${t("msg_generatingPrompt")}...`, timestamp: Date.now() };
  tab.messages.splice(index + 1, 0, placeholderMsg);
  saveChat();
  renderChat();

  const placeholderEl = dom.messagesEl.children[index + 1];
  if (placeholderEl) {
    const body = placeholderEl.querySelector(".plainBody");
    if (body) {
      body.innerHTML = `<span class="thinking-text">${t("msg_generatingPrompt")}<span class="thinking-dots"><span>.</span><span>.</span><span>.</span><span>.</span><span>.</span><span>.</span></span></span>`;
    }
  }

  const abortController = new AbortController();
  state.currentAbortController = abortController;
  setGenerating(true);
  setAvatarState("thinking");

  try {
    const res = await fetch("/api/content-to-imagine", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: abortController.signal,
      body: JSON.stringify({ model: dom.modelSelect.value, content: message.content, language: dom.promptLanguageSelect?.value || "en" }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Request failed");

    let prompts = data.prompts || "";
    const lines = prompts.split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .map((l) => l.startsWith("/imagine") ? l : `/imagine ${l}`);

    if (lines.length === 0) {
      placeholderMsg.content = "无法从内容中提取图片提示词。";
      saveChat();
      renderChat();
      return;
    }

    const imagineContent = lines.join("\n");
    placeholderMsg.content = imagineContent;
    saveChat();
    renderChat();

    const imagineCmds = parseImagineCommands(imagineContent);
    if (imagineCmds) {
      const firstError = imagineCmds.find((cmd) => cmd && cmd.error);
      if (firstError) {
        tab.messages.splice(index + 2, 0, { role: "assistant", content: t("msg_commandError", { error: firstError.error }), timestamp: Date.now() });
        saveChat();
        renderChat();
      } else {
        const validCmds = imagineCmds.filter((cmd) => cmd && cmd.prompt);
        generateImage(validCmds, state.activeTabId, index + 2);
      }
    }
  } catch (error) {
    if (error.name === "AbortError") {
      const placeholderIndex = tab.messages.indexOf(placeholderMsg);
      if (placeholderIndex !== -1) tab.messages.splice(placeholderIndex, 1);
      saveChat();
      renderChat();
    } else {
      placeholderMsg.content = `生成图片提示词失败：${error.message}`;
      saveChat();
      renderChat();
    }
  } finally {
    setGenerating(false);
    state.currentAbortController = null;
    setAvatarState("idle");
  }
}

async function handleCompactCommand(tab, tabId) {
  if (tab.messages.length === 0) return;

  // Collect messages to compact (everything up to now)
  const messagesToCompact = tab.messages.map(({ role, content }) => ({ role, content }));
  if (messagesToCompact.length === 0) return;

  // Add user message bubble showing /compact
  tab.messages.push({ role: "user", content: "/compact", timestamp: Date.now() });
  saveChat();
  if (state.activeTabId === tabId) renderChat();

  // Show thinking bubble
  setAvatarState("thinking");
  setGenerating(true);
  const abortController = new AbortController();
  state.currentAbortController = abortController;

  state.streamingInfo = { tabId, content: '', phase: 'thinking', insertIndex: -1, thinkingText: t("msg_compressing") };
  if (state.activeTabId === tabId) {
    const pending = document.createElement("div");
    pending.className = "message assistant thinking streaming-bubble";
    const body = document.createElement("div");
    body.className = "markdownBody";
    body.innerHTML = `<span class="thinking-text">${t("msg_compressing")}<span class="thinking-dots"><span>.</span><span>.</span><span>.</span><span>.</span><span>.</span><span>.</span></span></span>`;
    pending.appendChild(body);
    dom.messagesEl.appendChild(pending);
    dom.messagesEl.scrollTop = dom.messagesEl.scrollHeight;
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
      throw new Error(data.error || "请求失败");
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
          dom.messagesEl.scrollTop = dom.messagesEl.scrollHeight;
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
    tab.messages.push(summaryMessage);
    saveChat();
    if (state.activeTabId === tabId) renderChat();
  } catch (error) {
    state.streamingInfo = null;
    const bubble = dom.messagesEl.querySelector('.streaming-bubble');
    if (bubble) bubble.remove();
    if (error.name !== "AbortError") {
      tab.messages.push({ role: "assistant", content: t("msg_compressFail", { error: error.message }), timestamp: Date.now() });
      saveChat();
      if (state.activeTabId === tabId) renderChat();
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
        dom.messagesEl.scrollTop = dom.messagesEl.scrollHeight;
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
    dom.messagesEl.scrollTop = dom.messagesEl.scrollHeight;
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
      throw new Error(data.error || "请求失败");
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
          setAvatarState("talking");
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
            dom.messagesEl.scrollTop = dom.messagesEl.scrollHeight;
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
            dom.messagesEl.scrollTop = dom.messagesEl.scrollHeight;
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
    const reply = { role: "assistant", content, timestamp: Date.now() };
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
        const reply = { role: "assistant", content: content.trim(), timestamp: Date.now() };
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

export async function regenerateReply(tabId = state.activeTabId, insertIndex = -1, contextEndIndex = -1) {
  const tab = getTab(tabId);
  if (!tab) return;

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
    const refNode = insertIndex >= 0 ? dom.messagesEl.children[insertIndex] : null;
    if (refNode) {
      dom.messagesEl.insertBefore(pending, refNode);
    } else {
      dom.messagesEl.appendChild(pending);
    }
    dom.messagesEl.scrollTop = dom.messagesEl.scrollHeight;
  }

  let content = "";
  let thinkingContent = "";
  let usageStats = null;
  let aborted = false;
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
      throw new Error(data.error || "请求失败");
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
          setAvatarState("talking");
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
            dom.messagesEl.scrollTop = dom.messagesEl.scrollHeight;
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
            dom.messagesEl.scrollTop = dom.messagesEl.scrollHeight;
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
    if (state.activeTabId === tabId) {
      const md = dom.messagesEl.querySelector('.streaming-bubble > .markdownBody');
      if (md) md.innerHTML = markdownToHtml(content);
    }
    const reply = { role: "assistant", content, timestamp: Date.now() };
    if (thinkingContent) reply.thinking = thinkingContent;
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
  } catch (error) {
    state.streamingInfo = null;
    if (error.name === "AbortError") {
      aborted = true;
      if (content.trim()) {
        if (state.activeTabId === tabId) {
          const md = dom.messagesEl.querySelector('.streaming-bubble > .markdownBody');
          if (md) md.innerHTML = markdownToHtml(content);
        }
        const reply = { role: "assistant", content: content.trim(), timestamp: Date.now() };
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

// Deliver a proactive message (reminder / greeting / nudge) into the active tab.
// The model phrases it in character using `instruction`; nothing is added as a
// user message. Returns when done (used by the scheduler to serialize firings).
export async function generateProactiveReply(instruction, tabId = state.activeTabId) {
  const tab = getTab(tabId);
  if (!tab || tab.locked) return;
  if (state.currentAbortController || state.imageGenAbortController) return;

  const abortController = new AbortController();
  state.currentAbortController = abortController;
  setGenerating(true);
  setAvatarState("thinking");
  state.streamingInfo = { tabId, content: '', phase: 'thinking', insertIndex: -1 };

  if (state.activeTabId === tabId) {
    const pending = document.createElement("div");
    pending.className = "message assistant thinking streaming-bubble";
    const body = document.createElement("div");
    body.className = "markdownBody";
    body.innerHTML = `<span class="thinking-text">${t("msg_thinking")}<span class="thinking-dots"><span>.</span><span>.</span><span>.</span><span>.</span><span>.</span><span>.</span></span></span>`;
    pending.appendChild(body);
    dom.messagesEl.appendChild(pending);
    dom.messagesEl.scrollTop = dom.messagesEl.scrollHeight;
  }

  let content = "";
  try {
    const messages = [...buildMessages(tabId), { role: "user", content: instruction }];
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
      throw new Error(d.error || "请求失败");
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
          dom.messagesEl.scrollTop = dom.messagesEl.scrollHeight;
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

    tab.messages.push({ role: "assistant", content, timestamp: Date.now() });
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
async function handleSearchCommand(raw, tab, tabId, fullContent) {
  const { query, deep, deepCount, count, timelimit } = parseSearchOptions(raw);

  tab.messages.push({ role: "user", content: fullContent, timestamp: Date.now() });
  if (!query) {
    tab.messages.push({ role: "assistant", content: t("search_usage"), timestamp: Date.now() });
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
    dom.messagesEl.appendChild(pending);
    dom.messagesEl.scrollTop = dom.messagesEl.scrollHeight;
  }

  const finish = (assistantContent) => {
    if (pending) pending.remove();
    if (assistantContent) tab.messages.push({ role: "assistant", content: assistantContent, timestamp: Date.now() });
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

    if (data.error === "captcha") { finish(`⚠️ ${t("search_captcha")}`); return; }
    if (!res.ok || !data.results || data.results.length === 0) { finish(`⚠️ ${t("search_noResults")}`); return; }

    if (pending) pending.remove();
    const lines = [`🔎 **${t("search_resultsFor", { query })}**`, ""];
    data.results.forEach((r, i) => {
      lines.push(`${i + 1}. [${r.title}](${r.url})`);
      if (r.snippet) lines.push(`   ${r.snippet}`);
    });
    tab.messages.push({ role: "assistant", content: lines.join("\n"), timestamp: Date.now() });
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
    await generateProactiveReply(instruction, tabId);
  } catch (error) {
    if (error.name === "AbortError") {
      if (pending) pending.remove();
      saveChat();
      if (state.activeTabId === tabId) renderChat();
      setAvatarState("idle");
      setGenerating(false);
      state.currentAbortController = null;
    } else {
      finish(`⚠️ ${t("search_failed", { error: error.message })}`);
    }
  }
}

// Agentic reply: model can call tools (datetime/calculate/web_search/recall_memory)
// in a loop. Uses stream:false (local models call tools more reliably non-streamed),
// so the final answer renders at once after a "using tools" indicator.
export async function agenticReply(tabId = state.activeTabId) {
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
      dom.messagesEl.appendChild(pending);
    }
    pending.querySelector(".markdownBody").innerHTML =
      `<span class="thinking-text">${text}<span class="thinking-dots"><span>.</span><span>.</span><span>.</span><span>.</span><span>.</span><span>.</span></span></span>`;
    dom.messagesEl.scrollTop = dom.messagesEl.scrollHeight;
  };
  setPending(t("msg_thinking"));

  const messages = buildMessages(tabId);
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
      if (!res.ok) { const d = await res.json(); throw new Error(d.error || "请求失败"); }
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
      tab.messages.push({ role: "assistant", content: `⚠️ ${error.message}`, timestamp: Date.now() });
      saveChat();
      if (state.activeTabId === tabId) renderChat();
    }
    setAvatarState("idle");
    setGenerating(false);
    state.currentAbortController = null;
    return;
  }

  if (pending) pending.remove();
  if (finalContent) {
    const reply = { role: "assistant", content: finalContent, timestamp: Date.now() };
    if (toolSteps.length) reply.toolSteps = toolSteps;
    if (thinkingContent) reply.thinking = thinkingContent;
    tab.messages.push(reply);
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
// otherwise the normal streaming path. (insertIndex only applies to the latter.)
function dispatchReply(tabId, insertIndex = -1) {
  if (dom.toolsToggle?.checked) agenticReply(tabId);
  else regenerateReply(tabId, insertIndex);
}

export async function sendMessage(content, image, tabId = state.activeTabId, file = null) {
  const tab = getTab(tabId);
  if (!tab) return;
  if (tab.locked) return;

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

  // Handle /url command
  const urlTarget = parseUrlCommand(content);
  if (urlTarget) {
    if (urlTarget.entries.length === 1) {
      await handleUrlCommand(urlTarget.entries[0].url, tab, tabId, content, urlTarget.entries[0].prompt);
    } else {
      await handleMultiUrlCommand(urlTarget.entries, tab, tabId, content);
    }
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
    tab.messages.push(userMessage);
    const firstError = imagineCmds.find((cmd) => cmd && cmd.error);
    if (firstError) {
      tab.messages.push({ role: "assistant", content: t("msg_commandError", { error: firstError.error }), timestamp: Date.now() });
      saveChat();
      if (state.activeTabId === tabId) renderChat();
    } else {
      saveChat();
      if (state.activeTabId === tabId) renderChat();
      const validCmds = imagineCmds.filter((cmd) => cmd && cmd.prompt);
      generateImage(validCmds, tabId);
    }
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

    // Auto-trigger LLM reply for PDF/DOCX
    if (isPdfOrDocx) {
      regenerateReply(tabId);
    }
    return;
  }

  const userMessage = {
    role: "user",
    content: content || getPrompt("imageFallback"),
    timestamp: Date.now(),
  };

  if (image) {
    if (image.multi) {
      userMessage.images = image.multi.map(img => img.base64);
      userMessage.previewImages = image.multi.map(img => img.preview);
    } else {
      userMessage.images = [image.base64];
      userMessage.previewImages = [image.preview];
    }
    userMessage.previewImage = userMessage.previewImages[0]; // backward compat
  }

  tab.messages.push(userMessage);
  saveChat();
  if (state.activeTabId === tabId) renderChat();

  // Tools enabled (and no image — vision + tools is unreliable on local models) → agent loop.
  if (dom.toolsToggle?.checked && !image) {
    agenticReply(tabId);
  } else {
    regenerateReply(tabId);
  }
}

function renderMessage(role, content, previewImage, index, timestamp, generatedImages, generatedThumbnails) {
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
      if (!e.target.closest(".plainBody, .markdownBody, .editMessageInput, textarea")) {
        item.draggable = true;
      } else {
        item.draggable = false;
      }
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

      const imagineButton = document.createElement("button");
      imagineButton.className = "messageAction imagineFromContent";
      imagineButton.type = "button";
      imagineButton.title = t("btn_imagine");
      imagineButton.setAttribute("aria-label", t("btn_imagine"));
      imagineButton.textContent = t("btn_imagine");
      imagineButton.addEventListener("click", () => imagineFromContent(index));
      leftActions.appendChild(imagineButton);
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

  if (previewImage) {
    const previews = Array.isArray(previewImage) ? previewImage : [previewImage];
    // Multiple images render in a compact grid; a single image stays inline.
    const container = previews.length > 1
      ? Object.assign(document.createElement("div"), { className: "messageImages" })
      : item;
    previews.forEach((src, imgIdx) => {
      const image = document.createElement("img");
      image.className = "messageImage";
      image.src = src;
      image.alt = "用户上传的图片";
      if (Number.isInteger(index)) {
        image.dataset.msgIndex = index;
        image.dataset.imgIndex = imgIdx;
      }
      container.appendChild(image);
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
        function finishEdit(save, triggerSend = true) {
          const newContent = input.value.trim();
          if (save && newContent && newContent !== original) {
            const scrollY = dom.messagesEl.scrollTop;
            const tab = getActiveTab();
            tab.messages[index].content = newContent;
            if (triggerSend) tab.messages[index].timestamp = Date.now();
            if (role === "user" && triggerSend) {
              // Handle /0 and /1 — do NOT remove existing assistant reply
              const isoMatch = newContent.match(/^\/(0|1)\s+([\s\S]+)/);
              if (isoMatch) {
                saveChat();
                renderChat();
                const insertIdx = index + 1;
                isolatedReply(isoMatch[2], isoMatch[1], getActiveTab(), state.activeTabId, insertIdx);
              } else if (/^\/(memory|remind)(\s|$)/.test(newContent)) {
                // Already took effect when first sent; editing only updates the
                // displayed text — don't re-execute and don't trigger a reply.
                saveChat();
                renderChat();
              } else if (/^\/search(\s|$)/.test(newContent)) {
                // Re-run the web search with the edited query.
                const q = newContent.replace(/^\/search\s*/, "").trim();
                if (q) {
                  // Remove the old results bubble + answer, and the command bubble itself.
                  if (tab.messages[index + 1]?.role === "assistant") tab.messages.splice(index + 1, 1);
                  if (tab.messages[index + 1]?.role === "assistant") tab.messages.splice(index + 1, 1);
                  tab.messages.splice(index, 1);
                  saveChat();
                  renderChat();
                  handleSearchCommand(q, getActiveTab(), state.activeTabId, newContent);
                } else {
                  saveChat();
                  renderChat();
                }
              } else {
              if (tab.messages[index + 1]?.role === "assistant") {
                tab.messages.splice(index + 1, 1);
              }
              saveChat();
              renderChat();
              if (parseNoteCommand(newContent)) {
                // do nothing
              } else if (/^\/compact\s*$/.test(newContent)) {
                handleCompactCommand(tab, state.activeTabId);
              } else if (parseUrlCommand(newContent)) {
                const urlParsed = parseUrlCommand(newContent);
                if (urlParsed.entries.length === 1) {
                  handleUrlCommand(urlParsed.entries[0].url, tab, state.activeTabId, newContent, urlParsed.entries[0].prompt);
                } else {
                  handleMultiUrlCommand(urlParsed.entries, tab, state.activeTabId, newContent);
                }
              } else {
                const imagineCmds = parseImagineCommands(newContent);
                if (imagineCmds) {
                  const firstError = imagineCmds.find((cmd) => cmd && cmd.error);
                  if (firstError) {
                    tab.messages.splice(index + 1, 0, { role: "assistant", content: t("msg_commandError", { error: firstError.error }), timestamp: Date.now() });
                    saveChat();
                    renderChat();
                  } else {
                    const validCmds = imagineCmds.filter((cmd) => cmd && cmd.prompt);
                    generateImage(validCmds, state.activeTabId, index + 1);
                  }
                } else {
                  dispatchReply(state.activeTabId, index + 1);
                }
              }
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
        grid.appendChild(wrapper);
      }
      item.appendChild(grid);
    }
  }

  dom.messagesEl.appendChild(item);
  dom.messagesEl.scrollTop = dom.messagesEl.scrollHeight;

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

  return item;
}

export function renderChat() {
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

    const genImages = message.generatedImages || (message.isFilePreview && message.images?.length
      ? message.images.map(img => img.startsWith("data:") ? img : `data:${img.startsWith("/9j/") ? "image/jpeg" : "image/png"};base64,${img}`)
      : undefined);
    const previews = message.previewImages || (message.previewImage ? [message.previewImage] : undefined);
    const el = renderMessage(message.role, message.content, previews, index, message.timestamp, genImages, message.generatedThumbnails);
    // Insert thinking details block if present and setting enabled
    if (el && message.thinking) {
      const markdownBody = el.querySelector(".markdownBody");
      if (markdownBody) {
        const details = document.createElement("details");
        details.className = "thinking-details";
        details.innerHTML = `<summary>${t("msg_thinkingSummary")}</summary><div class="thinking-content markdownBody">${markdownToHtml(message.thinking)}</div>`;
        el.insertBefore(details, markdownBody);
      }
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
      dom.messagesEl.scrollTop = dom.messagesEl.scrollHeight;
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

      const imgBtn = document.createElement("button");
      imgBtn.className = "messageAction imagineFromContent";
      imgBtn.type = "button";
      imgBtn.title = t("btn_imagine");
      imgBtn.textContent = t("btn_imagine");
      imgBtn.addEventListener("click", () => imagineFromContent(index));
      transActions.appendChild(imgBtn);

      transEl.appendChild(transActions);

      const transActionsRight = document.createElement("div");
      transActionsRight.className = "messageActions messageActionsRight";

      const closeBtn = document.createElement("button");
      closeBtn.className = "messageAction deleteMessage";
      closeBtn.type = "button";
      closeBtn.title = t("tooltip_closeTranslation");
      closeBtn.textContent = "×";
      closeBtn.addEventListener("click", () => {
        delete message.translation;
        saveChat();
        renderChat();
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
      dom.messagesEl.scrollTop = dom.messagesEl.scrollHeight;
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
    dom.messagesEl.scrollTop = dom.messagesEl.scrollHeight;
  }

  highlightCodeBlocks();
  renderMermaidDiagrams();
  renderContextMeter();
}
