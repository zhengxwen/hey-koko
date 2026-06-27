// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

// Text-to-speech generation and the /voice command.
// Mirrors image-gen.js: parse the command, show a "generating" bubble, POST to
// the local TTS backend, then store the result on the message as `generatedAudio`
// (rendered as an <audio> + download button in chat.js).
import { dom, state } from './state.js';
import { t } from './i18n.js';
import { setAvatarState } from './avatar.js';
import { saveChat } from './settings.js';
import { getTab } from './tabs.js';
import { ttsFetch } from './server-queue.js';   // Option B: run TTS on the server queue
import { markdownToSpeechText } from './speech.js';
import { foregroundSink } from './gen-sink.js';

let _setGenerating = null;
let _renderChat = null;
export function setDeps({ setGenerating, renderChat }) {
  _setGenerating = setGenerating;
  _renderChat = renderChat;
}

// Parse "/voice [--use|-u <id>] [--speed|-s <n>] <text>". --use/-u takes an
// engine-prefixed id (e.g. kokoro:zm_yunxi); omitted → the
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
      if (!val) return { error: "--use 需要参数，如：--use kokoro:zm_yunxi" };
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

export async function generateSpeech(parsed, tabId = state.activeTabId, insertIndex = -1, sink = null) {
  const tab = getTab(tabId);
  if (!tab) return;
  const genStart = Date.now();

  // --use/-u wins; otherwise the unified voice selector (shared with reading).
  const voice = parsed.voice || dom.voiceSelect.value || "";
  // --speed wins; otherwise fall back to the Speed slider (same as the reader).
  const rate = parsed.rate != null ? parsed.rate : (parseFloat(dom.speechRateInput.value) || 1);
  // Strip markdown / LaTeX so the engine reads clean text (reuses the say path's cleaner).
  const speakText = markdownToSpeechText(parsed.text);

  // Foreground unless a background sink was handed in by the jobs runner. The sink
  // owns the AbortController, the send-button lock, the progress bubble and where
  // the final message lands (live bubble vs. background placeholder).
  if (!sink) sink = foregroundSink({ tabId, insertIndex, setGenerating: _setGenerating, renderChat: _renderChat, saveChat, getTab });
  sink.lock(true);
  setAvatarState("thinking");
  // Track in state so the spinner survives a tab switch (see pending-gen.js).
  sink.start("audio", t("msg_generatingAudio"));

  try {
    const ttsBody = { text: speakText, voice, rate, timeout: 180 };
    // Option B: a background /voice job runs on the SERVER queue (survives reload);
    // ttsFetch returns a Response-like {ok,json} so the handling below is unchanged.
    const resp = sink.server
      ? await ttsFetch(ttsBody, { bgJob: sink.server.bgJob, conversationId: sink.server.conversationId, msgId: sink.server.msgId, label: sink.server.label, signal: sink.signal })
      : await fetch("/api/tts", { method: "POST", headers: { "Content-Type": "application/json" }, signal: sink.signal, body: JSON.stringify(ttsBody) });
    const data = await resp.json();
    sink.clearBubble();

    if (!resp.ok || !data.audio) {
      sink.place({ role: "assistant", content: `语音生成失败：${data.error || "未返回音频"}`, timestamp: Date.now() });
      setAvatarState("idle");
      return;
    }

    // Decoded byte size of the base64 clip → human-readable (KB/MB).
    const pad = data.audio.endsWith("==") ? 2 : data.audio.endsWith("=") ? 1 : 0;
    const bytes = Math.max(0, Math.floor(data.audio.length * 3 / 4) - pad);
    const sizeStr = bytes >= 1024 * 1024
      ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
      : `${Math.max(1, Math.round(bytes / 1024))} KB`;

    sink.place({
      role: "assistant",
      content: t("msg_audioDone", { size: sizeStr }),
      generatedAudio: data.audio,
      audioMime: data.mime || "audio/wav",
      imagePrompt: parsed.text,
      timestamp: Date.now(),
      genMs: Date.now() - genStart,
    });
    setAvatarState("happy");
    setTimeout(() => setAvatarState("idle"), 2000);
  } catch (error) {
    sink.clearBubble();
    if (error.name !== "AbortError") {
      sink.place({ role: "assistant", content: `语音生成出错：${error.message}`, timestamp: Date.now() });
    }
    setAvatarState("idle");
  } finally {
    sink.clearBubble();
    sink.done();
    sink.cleanup();
  }
}