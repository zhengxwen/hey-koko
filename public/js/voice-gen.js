// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

// Text-to-speech generation and the /voice command.
// Mirrors image-gen.js: parse the command, show a "generating" bubble, POST to
// the local TTS backend, then store the result on the message as `generatedAudio`
// (rendered as an <audio> + download button in chat.js).
import { dom, state } from './state.js';
import { t } from './i18n.js';
import { setAvatarState, showExpression } from './avatar.js';
import { saveChat } from './settings.js';
import { getTab } from './tabs.js';
import { galleryUrl } from './utils.js';
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
    return { error: t("voc_missingText") };
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
      return { error: t("voc_unknownArg", { arg: unknown ? unknown[1] : rest }) };
    }
    const name = flag[1], val = flag[2];
    if (name === "--use" || name === "-u") {
      if (!val) return { error: t("voc_useNeedsArg") };
      result.voice = val;
    } else {
      if (!val) return { error: t("voc_speedNeedsArg") };
      const n = Number(val);
      if (isNaN(n) || n < 0.5 || n > 2) {
        return { error: t("voc_speedInvalid", { val }) };
      }
      result.rate = n;
    }
    rest = rest.slice(flag[0].length).trim();
  }

  result.text = rest.trim();
  if (!result.text) return { error: t("voc_missingTextAfterArgs") };
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
      const failMsg = t("voc_speechGenFailed", { err: data.error || t("voc_noAudioReturned") });
      sink.fail(failMsg);
      sink.place({ role: "assistant", content: failMsg, timestamp: Date.now() });
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
      // The server files the clip in the gallery and hands back its id; keep the
      // reference rather than the bytes (see js/utils.js).
      generatedAudio: (data.mediaIds && data.mediaIds[0]) ? galleryUrl(data.mediaIds[0]) : data.audio,
      audioMime: data.mime || "audio/wav",
      imagePrompt: parsed.text,
      timestamp: Date.now(),
      genMs: Date.now() - genStart,
    });
    showExpression("happy");
  } catch (error) {
    sink.clearBubble();
    if (error.name !== "AbortError") {
      const errMsg = t("voc_speechGenError", { err: error.message });
      sink.fail(errMsg);
      sink.place({ role: "assistant", content: errMsg, timestamp: Date.now() });
    }
    setAvatarState("idle");
  } finally {
    sink.clearBubble();
    sink.done();
    sink.cleanup();
  }
}