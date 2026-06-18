// Text-to-speech generation and the /voice command.
// Mirrors image-gen.js: parse the command, show a "generating" bubble, POST to
// the local TTS backend, then store the result on the message as `generatedAudio`
// (rendered as an <audio> + download button in chat.js).
import { dom, state } from './state.js';
import { t } from './i18n.js';
import { setAvatarState } from './avatar.js';
import { saveChat } from './settings.js';
import { getTab } from './tabs.js';
import { markdownToSpeechText } from './speech.js';

let _setGenerating = null;
let _renderChat = null;
export function setDeps({ setGenerating, renderChat }) {
  _setGenerating = setGenerating;
  _renderChat = renderChat;
}

// Parse "/voice [--use|-u <id>] [--speed|-s <n>] <text>". --use/-u takes an
// engine-prefixed id (e.g. kokoro:zm_yunxi or cosyvoice:中文女); omitted → the
// default from settings. Returns { text, voice, rate } or { error }.
export function parseVoiceCommand(input) {
  const match = input.match(/^\/voice\s+([\s\S]+)$/);
  if (!match) return null;
  if (!match[1].trim()) {
    return { error: "缺少文字。用法：/voice <要朗读的文字>" };
  }

  let rest = match[1].trim();
  // rate stays null when no --speed is given → generateSpeech falls back to the
  // Speed slider (so the slider drives /voice too, matching the reader).
  const result = { text: "", voice: "", rate: null };

  while (/^-/.test(rest)) {
    // --use/-u <engine:voice> and --speed/-s <0.5~2>; flag must be its own token.
    const flag = rest.match(/^(--use|-u|--speed|-s)(?=\s|$)(?:\s+(\S+))?/);
    if (!flag) {
      const unknown = rest.match(/^(--?[\w-]+)/);
      return { error: `未知参数 "${unknown ? unknown[1] : rest}"。支持：--use/-u <引擎:音色>, --speed/-s <0.5~2>` };
    }
    const name = flag[1], val = flag[2];
    if (name === "--use" || name === "-u") {
      if (!val) return { error: "--use 需要参数，如：--use cosyvoice:中文男" };
      result.voice = val;
    } else {
      if (!val) return { error: "--speed 需要参数，如：--speed 1.1" };
      const n = Number(val);
      if (isNaN(n) || n < 0.5 || n > 2) {
        return { error: `--speed 值无效："${val}"。需为 0.5~2 之间的数` };
      }
      result.rate = n;
    }
    rest = rest.slice(flag[0].length).trim();
  }

  result.text = rest.trim();
  if (!result.text) return { error: "缺少文字。请在参数后面加上要朗读的内容" };
  return result;
}

export async function generateSpeech(parsed, tabId = state.activeTabId, insertIndex = -1) {
  const tab = getTab(tabId);
  if (!tab) return;
  const genStart = Date.now();

  // --use/-u wins; otherwise the unified voice selector (shared with reading).
  const voice = parsed.voice || dom.voiceSelect.value || "";
  // --speed wins; otherwise fall back to the Speed slider (same as the reader).
  const rate = parsed.rate != null ? parsed.rate : (parseFloat(dom.speechRateInput.value) || 1);
  // Strip markdown / LaTeX so the engine reads clean text (reuses the say path's cleaner).
  const speakText = markdownToSpeechText(parsed.text);

  const abortController = new AbortController();
  state.imageGenAbortController = abortController;
  if (_setGenerating) _setGenerating(true);
  setAvatarState("thinking");

  const dots = `<span class="thinking-dots"><span>.</span><span>.</span><span>.</span><span>.</span><span>.</span><span>.</span></span>`;
  let pending = null;
  if (state.activeTabId === tabId) {
    pending = document.createElement("div");
    pending.className = "message assistant thinking imageGen";
    const body = document.createElement("div");
    body.className = "markdownBody";
    body.innerHTML = `<span class="thinking-text">${t("msg_generatingAudio")}${dots}</span>`;
    pending.appendChild(body);
    const refNode = insertIndex >= 0 ? dom.messagesEl.children[insertIndex] : null;
    if (refNode) dom.messagesEl.insertBefore(pending, refNode);
    else dom.messagesEl.appendChild(pending);
    dom.messagesEl.scrollTop = dom.messagesEl.scrollHeight;
  }

  try {
    const resp = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: abortController.signal,
      body: JSON.stringify({ text: speakText, voice, rate, timeout: 180 }),
    });
    const data = await resp.json();
    if (pending) pending.remove();

    if (!resp.ok || !data.audio) {
      const errMsg = { role: "assistant", content: `语音生成失败：${data.error || "未返回音频"}`, timestamp: Date.now() };
      if (insertIndex >= 0 && insertIndex <= tab.messages.length) tab.messages.splice(insertIndex, 0, errMsg);
      else tab.messages.push(errMsg);
      saveChat();
      if (state.activeTabId === tabId && _renderChat) _renderChat();
      setAvatarState("idle");
      return;
    }

    const replyMsg = {
      role: "assistant",
      content: t("msg_audioDone"),
      generatedAudio: data.audio,
      audioMime: data.mime || "audio/wav",
      imagePrompt: parsed.text,
      timestamp: Date.now(),
      genMs: Date.now() - genStart,
    };
    if (insertIndex >= 0 && insertIndex <= tab.messages.length) tab.messages.splice(insertIndex, 0, replyMsg);
    else tab.messages.push(replyMsg);
    saveChat();
    if (state.activeTabId === tabId && _renderChat) _renderChat();
    setAvatarState("happy");
    setTimeout(() => setAvatarState("idle"), 2000);
  } catch (error) {
    if (pending) pending.remove();
    if (error.name !== "AbortError") {
      const errMsg = { role: "assistant", content: `语音生成出错：${error.message}`, timestamp: Date.now() };
      tab.messages.push(errMsg);
      saveChat();
      if (state.activeTabId === tabId && _renderChat) _renderChat();
    }
    setAvatarState("idle");
  } finally {
    if (_setGenerating) _setGenerating(false);
    state.imageGenAbortController = null;
  }
}
