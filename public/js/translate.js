// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

// Translation functionality
import { dom, state } from './state.js';
import { saveChat } from './settings.js';
import { getActiveTab } from './tabs.js';
import { t, getPrompt } from './i18n.js';

let _renderChat = null;
export function setRenderChat(fn) { _renderChat = fn; }

export async function translateMessage(index, lang = "en") {
  if (state.currentAbortController || state.imageGenAbortController) return;
  const tab = getActiveTab();
  const message = tab.messages[index];
  if (!message) return;

  const targetLang = lang === "zh" ? "Chinese" : "English";

  // Remove existing translation and set translating state
  delete message.translation;
  message.isTranslating = true;
  saveChat();
  if (_renderChat) _renderChat();

  const abortController = new AbortController();
  state.activeTranslationAbort = abortController;
  dom.sendButton.hidden = true;
  dom.stopTranslateBtn.hidden = false;

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: dom.modelSelect.value,
        messages: [
          { role: "system", content: getPrompt("translator", targetLang) },
          { role: "user", content: message.content },
        ],
        options: { temperature: 0.3 },
        timeout: parseInt(dom.imageTimeoutInput.value, 10) || 120,
      }),
      signal: abortController.signal,
    });

    if (!response.ok) throw new Error(t("msg_translateFail"));

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
        const data = JSON.parse(line);
        result += data.message?.content || "";
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      const data = JSON.parse(buffer);
      result += data.message?.content || "";
    }

    message.translation = result.trim() || t("msg_translateFailShort");
  } catch (e) {
    if (e.name === "AbortError") {
      delete message.translation;
    } else {
      message.translation = t("msg_translateFailDetail", { error: e.message });
    }
  }
  if (state.activeTranslationAbort === abortController) state.activeTranslationAbort = null;
  dom.sendButton.hidden = false;
  dom.stopTranslateBtn.hidden = true;
  delete message.isTranslating;
  saveChat();
  if (_renderChat) _renderChat();
}

export function stopTranslation() {
  if (state.activeTranslationAbort) {
    state.activeTranslationAbort.abort();
    state.activeTranslationAbort = null;
  }
}