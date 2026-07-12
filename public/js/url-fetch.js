// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

// URL fetching and content parsing (/url command)
import { dom, state, scrollChatToEnd } from './state.js';
import { setAvatarState } from './avatar.js';
import { markdownToHtml } from './markdown.js';
import { saveChat } from './settings.js';
import { makePreview } from './utils.js';
import { getPromptLanguage, t } from './i18n.js';
import { youtubeFetch, serverJobTiming } from './server-queue.js';

const CHUNK_CHAR_LIMIT = 6000; // Split transcripts longer than this

// Prompt/scaffold strings for the transcript formatter, keyed by the user's prompt
// language. Kept in sync with the server twin (server/url-fetch.js FORMAT_I18N) —
// this copy only serves the foreground (non-server-queue) /url path.
const FORMAT_I18N = {
  zh: {
    system: (title, channel) =>
      "你是字幕整理助手。将原始字幕片段整理为易读文本：添加标点符号、连成完整句子、适当分段；在话题明显切换处插入一行简短的 Markdown 小标题（如「## 小标题」，用字幕本身的语言书写），没有明显切换就不加。不要改变原意，不要添加或省略内容，不要翻译。直接输出整理后的文本，不要加任何前缀说明。"
      + (title ? `\n视频标题：《${title}》` : "") + (channel ? `\n频道：${channel}` : "")
      + (title || channel ? "\n字幕来自自动识别，专有名词可能听错——请结合标题/频道纠正明显的错别字。" : ""),
    first: (i, n, chunk) => `请整理以下字幕片段（第${i}/${n}段），添加标点并分段，不要省略内容：\n\n${chunk}`,
    cont: (i, n, tail, chunk) => `上一段整理结果的结尾（仅供衔接上下文，不要重复输出）：\n…${tail}\n\n请继续整理下一段字幕（第${i}/${n}段），与上文自然衔接，添加标点并分段，不要省略内容：\n\n${chunk}`,
    header: "**📝 整理好的字幕**",
    intro: (title, n) => `请将以下YouTube视频「${title}」的原始字幕整理成易读的文本${n > 1 ? `（共${n}段）` : ""}。要求：\n1. 添加标点符号，连成完整的句子和段落\n2. 适当分段换行（按语义自然分段）\n3. 不要改变原意，不要添加内容\n4. 不要省略任何字幕内容`,
  },
  "zh-Hant": {
    system: (title, channel) =>
      "你是字幕整理助手。將原始字幕片段整理為易讀文本：添加標點符號、連成完整句子、適當分段；在話題明顯切換處插入一行簡短的 Markdown 小標題（如「## 小標題」，用字幕本身的語言書寫），沒有明顯切換就不加。不要改變原意，不要添加或省略內容，不要翻譯。直接輸出整理後的文本，不要加任何前綴說明。"
      + (title ? `\n影片標題：《${title}》` : "") + (channel ? `\n頻道：${channel}` : "")
      + (title || channel ? "\n字幕來自自動識別，專有名詞可能聽錯——請結合標題/頻道糾正明顯的錯別字。" : ""),
    first: (i, n, chunk) => `請整理以下字幕片段（第${i}/${n}段），添加標點並分段，不要省略內容：\n\n${chunk}`,
    cont: (i, n, tail, chunk) => `上一段整理結果的結尾（僅供銜接上下文，不要重複輸出）：\n…${tail}\n\n請繼續整理下一段字幕（第${i}/${n}段），與上文自然銜接，添加標點並分段，不要省略內容：\n\n${chunk}`,
    header: "**📝 整理好的字幕**",
    intro: (title, n) => `請將以下YouTube影片「${title}」的原始字幕整理成易讀的文本${n > 1 ? `（共${n}段）` : ""}。要求：\n1. 添加標點符號，連成完整的句子和段落\n2. 適當分段換行（按語義自然分段）\n3. 不要改變原意，不要添加內容\n4. 不要省略任何字幕內容`,
  },
  en: {
    system: (title, channel) =>
      "You are a subtitle cleanup assistant. Turn raw subtitle fragments into readable text: add punctuation, join fragments into complete sentences, and break the text into natural paragraphs. Where the topic clearly changes, insert one short Markdown subheading line (e.g. \"## Topic\", written in the transcript's own language); add none if there is no clear change. Do not change the meaning, do not add or omit content, and do not translate. Output only the cleaned text with no preamble."
      + (title ? `\nVideo title: "${title}"` : "") + (channel ? `\nChannel: ${channel}` : "")
      + (title || channel ? "\nThe transcript comes from automatic speech recognition and may mis-hear proper nouns — use the title/channel to fix obvious errors." : ""),
    first: (i, n, chunk) => `Please clean up the following subtitle fragment (part ${i}/${n}). Add punctuation and paragraphs; do not omit content:\n\n${chunk}`,
    cont: (i, n, tail, chunk) => `End of the previous cleaned part (context only — do not repeat it):\n…${tail}\n\nPlease continue with the next fragment (part ${i}/${n}), flowing naturally from the text above. Add punctuation and paragraphs; do not omit content:\n\n${chunk}`,
    header: "**📝 Formatted transcript**",
    intro: (title, n) => `Please clean up the raw subtitles of the YouTube video "${title}" into readable text${n > 1 ? ` (${n} parts)` : ""}. Requirements:\n1. Add punctuation and join fragments into complete sentences\n2. Break into natural paragraphs\n3. Do not change the meaning or add content\n4. Do not omit any subtitle content`,
  },
};
const fmtL = (language) => FORMAT_I18N[language] || FORMAT_I18N.zh;

// Dependencies injected from main.js to avoid circular imports
let _setGenerating = null;
let _renderChat = null;
let _regenerateReply = null;
let _showSendError = null;

export function setDeps({ setGenerating, renderChat, regenerateReply, showSendError }) {
  _setGenerating = setGenerating;
  _renderChat = renderChat;
  _regenerateReply = regenerateReply;
  _showSendError = showSendError;
}

// Surface a /url failure as the red status pill (best-effort; dep may be unset).
function urlError(reason, bg) {
  // Background run: mark the JOB failed too (bg.fail), so it stays in the jobs drawer
  // as "失败 · <reason>" instead of vanishing as done. Foreground: toast only.
  if (bg && bg.fail) bg.fail(reason);
  if (_showSendError) _showSendError(reason);
}

// On resend, a /url command regenerates in place: every message it produces is
// tagged `urlPart: true` (so a later resend can remove exactly this block) and
// spliced at a shared mutable cursor { pos } right after the command bubble.
// On a fresh send, cursor is null and messages are appended at the end.
function placeMsg(tab, msg, cursor) {
  msg.urlPart = true;
  if (cursor && cursor.pos >= 0 && cursor.pos <= tab.messages.length) tab.messages.splice(cursor.pos++, 0, msg);
  else tab.messages.push(msg);
}
function placePending(pending, cursor) {
  const ref = (cursor && cursor.pos >= 0) ? dom.messagesEl.children[cursor.pos] : null;
  if (ref) dom.messagesEl.insertBefore(pending, ref);
  else dom.messagesEl.appendChild(pending);
}

export function parseUrlCommand(content) {
  if (!content) return null;
  const firstLine = content.split("\n")[0];
  // Must start with /url
  if (!/^\/url(\s|$)/.test(firstLine)) return null;

  // Parse all lines: each URL entry can have its own prompt
  const entries = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // /url [optional prompt text] URL — extract prompt text before URL on /url lines
    const urlLineMatch = trimmed.match(/^\/url\s+(.*?)\s*(https?:\/\/\S+)$/i);
    if (urlLineMatch) {
      entries.push({ url: urlLineMatch[2], prompt: (urlLineMatch[1] || "").trim() });
    } else {
      // /url URL (no prompt)
      const simpleMatch = trimmed.match(/^\/url\s+(\S+)/);
      if (simpleMatch && /^https?:\/\//i.test(simpleMatch[1])) {
        entries.push({ url: simpleMatch[1], prompt: "" });
      } else if (simpleMatch && !/^https?:\/\//i.test(simpleMatch[1])) {
        // /url word... — treat as URL (will get https:// prepended later)
        entries.push({ url: simpleMatch[1], prompt: "" });
      } else if (/^https?:\/\//i.test(trimmed)) {
        entries.push({ url: trimmed, prompt: "" });
      }
      // else: comment line, skip
    }
  }
  return entries.length > 0 ? { entries } : null;
}

export async function handleUrlCommand(url, tab, tabId, fullContent, prompt, cursor = null, skipUserBubble = false, bg = null) {
  // Ensure URL has protocol
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  const inPlace = !!(cursor && cursor.pos >= 0);

  // On resend the command bubble already exists in place (skipUserBubble); a fresh
  // send (or a continuation /url line in multi-url) adds its own command bubble.
  if (!skipUserBubble) placeMsg(tab, { role: "user", content: fullContent || `/url ${url}`, timestamp: Date.now() }, cursor);
  saveChat();
  if (state.activeTabId === tabId && _renderChat) _renderChat();

  // /url youtube as a server-side bg job: the slow fetch+transcribe+format runs on the
  // server (survives reload) and progress streams back to the drawer. We only place the
  // result bubbles here. Webpages / foreground / non-server paths fall through unchanged.
  if (bg && bg.server && /youtube\.com|youtu\.be/.test(url)) {
    await handleYoutubeServerJob(url, tab, tabId, prompt, cursor, bg);
    return;
  }

  // Reply right after the produced content (in place) or at the end (fresh). bg jobs
  // are always in-place (cursor set) and run the reply headless.
  const runReply = async () => {
    if (!_regenerateReply) return;
    // The whole /url chain runs as a bg job, so regenerateReply(bg) is headless — it never
    // shows the foreground "thinking" bubble. Flip the job placeholder (which sits right
    // below the just-spliced content/prompt bubbles) to the thinking label so the reply
    // phase reads as "正在想…" instead of lingering on the fetch label until the answer pops in.
    if (bg && bg.label) bg.label(t("msg_thinking"));
    if (inPlace) { await _regenerateReply(tabId, cursor.pos, cursor.pos - 1, { urlPart: true }, bg); cursor.pos++; }
    else _regenerateReply(tabId, -1, -1, { urlPart: true });
  };

  // Show thinking state with animated bubble (foreground); a bg job surfaces phase
  // text in the drawer/placeholder via bg.label instead.
  const abortController = bg ? { signal: bg.signal } : new AbortController();
  if (!bg) {
    setAvatarState("thinking");
    if (_setGenerating) _setGenerating(true);
    state.currentAbortController = abortController;
  } else {
    bg.label(t("bg_fetchingContent"));
  }

  // Add animated "fetching" bubble
  let pending = null;
  if (!bg && state.activeTabId === tabId) {
    pending = document.createElement("div");
    pending.className = "message assistant thinking";
    const body = document.createElement("div");
    body.className = "markdownBody";
    body.innerHTML = '<span class="thinking-text">正在获取内容<span class="thinking-dots"><span>.</span><span>.</span><span>.</span><span>.</span><span>.</span><span>.</span></span></span>';
    pending.appendChild(body);
    placePending(pending, cursor);
    scrollChatToEnd();
  }

  try {
    const res = await fetch("/api/fetch-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: abortController.signal,
      body: JSON.stringify({ url, language: getPromptLanguage() }),
    });
    const data = await res.json();

    // Remove the pending bubble
    if (pending) pending.remove();

    if (!res.ok || data.type === "error") {
      placeMsg(tab, { role: "assistant", content: `⚠️ ${data.error || data.content || "获取失败"}`, timestamp: Date.now() }, cursor);
      urlError(data.error || data.content || "获取失败", bg);
      saveChat();
      if (state.activeTabId === tabId && _renderChat) _renderChat();
      if (!bg) { setAvatarState("idle"); if (_setGenerating) _setGenerating(false); }
      return;
    }

    if (data.type === "unsupported") {
      placeMsg(tab, { role: "assistant", content: `⚠️ ${data.content}`, timestamp: Date.now() }, cursor);
      urlError(data.content, bg);
      saveChat();
      if (state.activeTabId === tabId && _renderChat) _renderChat();
      if (!bg) { setAvatarState("idle"); if (_setGenerating) _setGenerating(false); }
      return;
    }

    // Display fetched content in an assistant bubble
    let displayContent = "";
    // Structured flag from /api/fetch-url — do not infer from the text shape: real
    // transcripts can begin with "[" (e.g. a "[Music]" first cue).
    const hasRealTranscript = data.type === "youtube" && data.content && !data.noTranscript;
    if (data.type === "youtube") {
      // Show video info card
      const infoParts = [`📺 **${data.title}**`, url, ""];
      if (data.channel) infoParts.push(t("yt_channel", { x: data.channel }));
      if (data.duration) infoParts.push(t("yt_duration", { x: data.duration }));
      if (data.viewCount) infoParts.push(t("yt_views", { x: Number(data.viewCount).toLocaleString() }));
      if (data.uploadDate) {
        const d = data.uploadDate.replace(/-/g, "").slice(0, 8);
        if (d.length === 8) infoParts.push(t("yt_date", { x: `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}` }));
      }
      // Extract hashtags from description
      if (data.description) {
        const tags = data.description.match(/#[^\s#]+/g);
        if (tags && tags.length > 0) infoParts.push("", tags.join(" "));
      }
      // If no real transcript, show the message in the same bubble
      if (!hasRealTranscript && data.content) {
        infoParts.push("", data.content);
      }
      displayContent = infoParts.join("\n");
    } else {
      displayContent = `🌐 **${data.title || url}**\n${url}\n\n${data.content}`;
    }

    // Show content as assistant message
    const msgObj = { role: "assistant", content: displayContent, timestamp: Date.now() };
    if (data.type === "youtube" && data.thumbnail) {
      msgObj.generatedThumbnails = [await makePreview(data.thumbnail, 480)];
      msgObj.ytVideoId = data.videoId;
    } else if (data.type === "webpage" && Array.isArray(data.images) && data.images.length) {
      msgObj.generatedThumbnails = await Promise.all(data.images.map((img) => makePreview(img, 480)));
    }
    placeMsg(tab, msgObj, cursor);
    saveChat();
    if (state.activeTabId === tabId && _renderChat) _renderChat();

    if (!bg) { state.currentAbortController = null; if (_setGenerating) _setGenerating(false); }

    // For YouTube, ask AI to format the transcript into readable text
    if (hasRealTranscript) {
      await formatTranscriptChunked(data.title, data.content, tab, tabId, undefined, cursor, bg, data.channel || "");
      // After transcript is formatted, if there's a prompt, send it
      if (prompt) {
        placeMsg(tab, { role: "user", content: prompt, timestamp: Date.now() }, cursor);
        saveChat();
        if (state.activeTabId === tabId && _renderChat) _renderChat();
        await runReply();
      }
    } else if (data.type === "youtube" && data.videoId && !hasRealTranscript) {
      // No subtitles — try audio transcription via whisper
      await transcribeYouTubeFromAudio(data.videoId, data.title, tab, tabId, cursor, bg);
      // After transcription, if there's a prompt, send it
      if (prompt) {
        placeMsg(tab, { role: "user", content: prompt, timestamp: Date.now() }, cursor);
        saveChat();
        if (state.activeTabId === tabId && _renderChat) _renderChat();
        await runReply();
      }
    } else if (data.type !== "youtube") {
      // For non-YouTube: only reply when the user actually asked something. A bare
      // `/url <link>` just imports the page (bubble 1) — no auto AI summary. With a
      // prompt, add the user message and let the AI answer against the fetched content.
      if (prompt) {
        placeMsg(tab, { role: "user", content: prompt, timestamp: Date.now() }, cursor);
        saveChat();
        if (state.activeTabId === tabId && _renderChat) _renderChat();
        await runReply();
      } else if (!bg) {
        // Import-only (no prompt): no runReply() to close out the avatar, so idle it here.
        setAvatarState("idle");
      }
    }
  } catch (error) {
    if (pending) pending.remove();
    if (error.name === "AbortError") {
      // User cancelled
    } else {
      placeMsg(tab, { role: "assistant", content: `⚠️ 获取失败：${error.message}`, timestamp: Date.now() }, cursor);
      urlError(`获取失败：${error.message}`, bg);
      saveChat();
      if (state.activeTabId === tabId && _renderChat) _renderChat();
    }
    if (!bg) { setAvatarState("idle"); if (_setGenerating) _setGenerating(false); }
  }
}

// Build the YouTube "video info card" assistant bubble (title / channel / duration
// / … + thumbnail). Shared so the immediate early placement and the final job
// result produce an identical bubble under the same upsert id (idempotent).
async function buildYoutubeInfoMsg(url, data) {
  const infoParts = [`📺 **${data.title || url}**`, url, ''];
  if (data.channel) infoParts.push(t('yt_channel', { x: data.channel }));
  if (data.duration) infoParts.push(t('yt_duration', { x: data.duration }));
  if (data.viewCount) infoParts.push(t('yt_views', { x: Number(data.viewCount).toLocaleString() }));
  if (data.uploadDate) { const d = String(data.uploadDate).replace(/-/g, '').slice(0, 8); if (d.length === 8) infoParts.push(t('yt_date', { x: `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}` })); }
  if (data.description) { const tags = data.description.match(/#[^\s#]+/g); if (tags && tags.length) infoParts.push('', tags.join(' ')); }
  const infoMsg = { role: 'assistant', content: infoParts.join('\n'), timestamp: Date.now() };
  if (data.thumbnail) { try { infoMsg.generatedThumbnails = [await makePreview(data.thumbnail, 480)]; } catch {} infoMsg.ytVideoId = data.videoId; }
  return infoMsg;
}

// /url youtube via the server-side queue: the server does fetch → (whisper) transcribe →
// format (all the slow work; survives reload), with progress streaming to the drawer via
// the onProgress channel. Here we only place the result bubbles, using stable ids derived
// from the placeholder msgId so a reconnect-after-reload re-run upserts (never duplicates).
async function handleYoutubeServerJob(url, tab, tabId, prompt, cursor, bg) {
  const base = bg.server.msgId;
  const upsertById = (id, msg) => {
    msg.id = id; msg.urlPart = true;
    for (const tb of state.tabs) {
      if (!Array.isArray(tb.messages)) continue;
      const i = tb.messages.findIndex((m) => m && m.id === id);
      if (i >= 0) {
        // Reconnect re-run (reload) upserts over an already-placed bubble — keep the
        // ORIGINAL generation time/duration so a refresh never re-stamps it to "now".
        const prev = tb.messages[i];
        if (prev.timestamp) msg.timestamp = prev.timestamp;
        if (prev.genMs && msg.genMs == null) msg.genMs = prev.genMs;
        tb.messages[i] = msg; return;
      }
    }
    if (cursor && cursor.pos >= 0 && cursor.pos <= tab.messages.length) tab.messages.splice(cursor.pos++, 0, msg);
    else tab.messages.push(msg);
  };
  const commit = () => { saveChat(); if (state.activeTabId === tabId && _renderChat) _renderChat(); };

  bg.label(t('bg_fetchingContent'));

  // Zero-waste fast path: fetch the metadata (+ subtitles, if any) ONCE on the
  // client so the info card shows immediately, then hand that same data to the
  // server job via `prefetch` so the server skips its own fetch — only the slow
  // transcribe(if needed)+format runs server-side. If this fails (or returns
  // nothing usable) we fall back to letting the job fetch everything itself.
  let prefetch = null;
  try {
    const r0 = await fetch('/api/fetch-url', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, language: getPromptLanguage() }), signal: bg.signal,
    });
    if (r0.ok) {
      const d0 = await r0.json();
      if (d0 && d0.type === 'youtube' && (d0.title || d0.thumbnail)) {
        // Immediate info card while the job runs — no timestamp yet (the job hasn't
        // finished). The final upsert stamps the server-authoritative genTs; upsertById's
        // preservation then keeps that across a reload instead of re-stamping "now".
        const infoNow = await buildYoutubeInfoMsg(url, d0); infoNow.timestamp = 0;
        upsertById(base + ':info', infoNow);   // first bubble, now
        commit();
        const hasRealTranscript = !!(d0.content && !d0.noTranscript);
        prefetch = {
          title: d0.title || '', channel: d0.channel || '', duration: d0.duration || '',
          viewCount: d0.viewCount || '', uploadDate: d0.uploadDate || '', description: d0.description || '',
          thumbnail: d0.thumbnail || '', videoId: d0.videoId,
          rawTranscript: hasRealTranscript ? d0.content : null,   // null → server whisper-transcribes
        };
      }
    }
  } catch (e) {
    if (e && e.name === 'AbortError') throw e;   // canceled mid-fetch — let the queue handle it
    // otherwise non-fatal: prefetch stays null → the job fetches everything itself
  }

  let data, ok;
  try {
    const r = await youtubeFetch(
      { url, language: getPromptLanguage(), model: dom.modelSelect.value, prefetch },
      { bgJob: bg.server.bgJob, conversationId: bg.server.conversationId, msgId: bg.server.msgId, label: bg.server.label, signal: bg.signal });
    ok = r.ok; data = await r.json();
  } catch (e) {
    if (e && e.name === 'AbortError') throw e;   // canceled mid-run — let the queue handle it
    ok = false; data = { error: (e && e.message) || '获取失败' };
  }
  data = data || {};

  // Server-authoritative generation time/duration (same wall clock as us) — correct even
  // if the page was closed for the whole job: finishedAt = when the server actually produced
  // the result, genMs = how long the background work (whisper + format) took. Falls back to
  // now / null if the timing snapshot isn't available (e.g. inline-fetch path).
  const timing = serverJobTiming(bg.server.bgJob && bg.server.bgJob.serverJobId);
  const genTs = timing && timing.finishedAt ? timing.finishedAt : Date.now();
  const genMs = timing && timing.startedAt && timing.finishedAt ? (timing.finishedAt - timing.startedAt) : null;

  // 1. video info card — stable id, NEVER the placeholder msgId (that's reserved for the reply).
  // Same id as the early placement above, so this refreshes it rather than duplicating.
  // Only rebuild when the result actually carries video info: a bare error result (e.g.
  // "whisper-cli 未安装" fails before any metadata) has no title/thumbnail, and rebuilding
  // from it would clobber the good prefetch-placed card with a bare-URL one.
  if (data.title || data.thumbnail || data.videoId) {
    const infoMsg = await buildYoutubeInfoMsg(url, data);
    infoMsg.timestamp = genTs;
    upsertById(base + ':info', infoMsg);
  } else {
    // Keep the existing card; just give the "pending" card (timestamp 0) its final time.
    for (const tb of state.tabs) {
      const m = Array.isArray(tb.messages) && tb.messages.find((x) => x && x.id === base + ':info');
      if (m) { if (!m.timestamp) m.timestamp = genTs; break; }
    }
  }

  if (ok && data.formattedText) {
    // 2a. success → only the cleaned transcript (no raw-subtitle user bubble). Record when it
    // was generated (genTs) + how long it took (genMs → renderChat shows the ⏱ on the bubble).
    upsertById(base + ':fmt', { role: 'assistant', content: data.formattedText, timestamp: genTs, genMs });
  } else {
    // 2b. failure → raw transcript as a fallback user bubble (if any) + the error.
    // formatError = the server transcribed fine but formatting failed; the raw
    // transcript rides along in the "done" result so it can be shown here.
    const errMsg = data.formatError || data.error || '字幕整理失败';
    if (data.rawTranscript) {
      const label = data.source === 'whisper' ? '**[语音识别结果]**' : '**[原始字幕]**';
      upsertById(base + ':raw', { role: 'user', content: `${label}\n\n${data.rawTranscript}`, timestamp: genTs });
    }
    upsertById(base + ':fmt', { role: 'assistant', content: `⚠️ ${errMsg}`, timestamp: genTs });
    commit();
    urlError(errMsg, bg);
    return;
  }
  // Render the finished transcript now, so "📝 整理好的字幕" lands on its own first.
  commit();

  // 3. optional prompt → reply (front-end; needs conversation context). The reply swaps the
  // placeholder msgId via bg.place() → idempotent on reconnect, no extra stable id needed.
  // Pop the user's question bubble FIRST (its own render) BEFORE generating the reply — so the
  // job's continued "running" after the transcript is clearly the reply to that question.
  if (prompt) {
    upsertById(base + ':prompt', { role: 'user', content: prompt, timestamp: Date.now() });
    commit();
    if (_regenerateReply) await _regenerateReply(tabId, cursor.pos, cursor.pos - 1, { urlPart: true }, bg);
  }
}

// Handle multiple URLs sequentially
export async function handleMultiUrlCommand(entries, tab, tabId, fullContent, cursor = null, bg = null) {
  const inPlace = !!(cursor && cursor.pos >= 0);
  for (let i = 0; i < entries.length; i++) {
    // On resend the first entry reuses the existing command bubble; continuation
    // entries add their own `/url …` bubble (spliced at the shared cursor).
    await handleUrlCommand(entries[i].url, tab, tabId, i === 0 ? fullContent : `/url ${entries[i].url}`, entries[i].prompt, cursor, inPlace && i === 0, bg);
  }
}

// Split transcript into chunks at line boundaries.
// Safety net for a single line longer than the limit (e.g. captions that arrived as one
// long line): force-cut it at whitespace/punctuation so it can never become a mega-chunk.
function splitOverlongLine(line, limit) {
  const parts = [];
  while (line.length > limit) {
    let cut = -1;
    for (let j = limit; j > limit * 0.5; j--) {
      if (/[\s。.!?！？，,;；]/.test(line[j])) { cut = j + 1; break; }
    }
    if (cut <= 0) cut = limit;
    parts.push(line.slice(0, cut).trimEnd());
    line = line.slice(cut);
  }
  if (line) parts.push(line);
  return parts;
}
function splitTranscript(text, limit) {
  const chunks = [];
  let current = "";
  for (const line of text.split("\n").flatMap((l) => (l.length > limit ? splitOverlongLine(l, limit) : [l]))) {
    if (current.length + line.length + 1 > limit && current.length > 0) {
      chunks.push(current);
      current = line;
    } else {
      current += (current ? "\n" : "") + line;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

// Process transcript in chunks, streaming each chunk's AI response
// source: "subtitle" (default) or "whisper" (from audio transcription)
async function formatTranscriptChunked(title, transcript, tab, tabId, source, cursor = null, bg = null, channel = "") {
  const L = fmtL(getPromptLanguage());
  const chunks = splitTranscript(transcript, CHUNK_CHAR_LIMIT);
  const totalChunks = chunks.length;

  // Add a user message indicating transcript formatting, with the raw transcript appended
  const instructions = L.intro(title, totalChunks);
  const label = source === "whisper" ? "**[语音识别结果]**" : "**[原始字幕]**";
  const userMsg = `${instructions}\n\n${label}\n\n${transcript}`;
  placeMsg(tab, { role: "user", content: userMsg, timestamp: Date.now() }, cursor);
  saveChat();
  if (state.activeTabId === tabId && _renderChat) _renderChat();

  // Process chunks sequentially, streaming into one assistant bubble
  const abortController = bg ? { signal: bg.signal } : new AbortController();
  if (!bg) {
    if (_setGenerating) _setGenerating(true);
    setAvatarState("thinking");
    state.currentAbortController = abortController;
  } else {
    bg.label(t("bg_formattingSubs", { i: 1, n: totalChunks }));
  }

  let pending = null;
  let textEl = null;
  let fullContent = "";

  if (!bg && state.activeTabId === tabId) {
    pending = document.createElement("div");
    pending.className = "message assistant thinking";
    const body = document.createElement("div");
    body.className = "markdownBody";
    body.innerHTML = '<span class="thinking-text">正在整理字幕 (1/' + totalChunks + ')<span class="thinking-dots"><span>.</span><span>.</span><span>.</span><span>.</span><span>.</span><span>.</span></span></span>';
    pending.appendChild(body);
    placePending(pending, cursor);
    scrollChatToEnd();
  }

  const systemPrompt = L.system(title, channel);
  const nonWs = (s) => String(s).replace(/\s+/g, "").length;
  const progressMarker = /\n\n---\n\*正在整理第 \d+\/\d+ 段\.\.\.\*\n\n/g;

  // One model call for one chunk, streaming its text into fullContent (and the live bubble).
  const streamChunk = async (messages) => {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: abortController.signal,
      body: JSON.stringify({
        model: dom.modelSelect.value,
        messages,
        // num_ctx mirrors server config.llmTaskCtx — Ollama's tiny default would silently
        // truncate a 6k-char chunk plus its equal-length rewrite.
        options: { temperature: 0.3, num_ctx: 24576 },
        timeout: parseInt(dom.requestTimeoutInput?.value, 10) || 120,
      }),
    });

    if (!response.ok) {
      const errData = await response.json();
      throw new Error(errData.error || "请求失败");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const appendLine = (line) => {
      if (!line.trim()) return;
      const parsed = JSON.parse(line);
      const chunk = parsed.message?.content || "";
      if (!chunk) return;

      if (!bg && !textEl && pending) {
        pending.innerHTML = "";
        pending.classList.remove("thinking");
        setAvatarState("talking");
        textEl = document.createElement("div");
        textEl.className = "markdownBody";
        pending.appendChild(textEl);
      }

      fullContent += chunk;
      if (state.activeTabId === tabId && textEl) {
        textEl.innerHTML = markdownToHtml(fullContent);
        scrollChatToEnd();
      }
    };

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
  };

  try {
    for (let i = 0; i < chunks.length; i++) {
      if (abortController.signal.aborted) break;

      if (bg) bg.label(t("bg_formattingSubs", { i: i + 1, n: totalChunks }));
      // Tail of the cleaned text so far (progress markers stripped) — carried into the
      // next prompt so sentences broken at the chunk boundary knit back together.
      const tail = fullContent.replace(progressMarker, "\n\n").trimEnd().slice(-200);
      // Show progress between chunks
      if (i > 0 && pending && textEl) {
        fullContent += `\n\n---\n*正在整理第 ${i + 1}/${totalChunks} 段...*\n\n`;
        textEl.innerHTML = markdownToHtml(fullContent);
        scrollChatToEnd();
      } else if (i > 0 && pending && !textEl) {
        const body = pending.querySelector(".markdownBody");
        if (body) body.innerHTML = '<span class="thinking-text">正在整理字幕 (' + (i + 1) + '/' + totalChunks + ')<span class="thinking-dots"><span>.</span><span>.</span><span>.</span><span>.</span><span>.</span><span>.</span></span></span>';
      }

      const messages = [
        { role: "system", content: systemPrompt },
        { role: "user", content: i === 0 ? L.first(1, totalChunks, chunks[i]) : L.cont(i + 1, totalChunks, tail, chunks[i]) },
      ];

      const chunkStart = fullContent.length;
      await streamChunk(messages);
      // Anti-summarize guard: cleaned text should be about as long as its raw input; a much
      // shorter result means the model condensed it — retry once and keep the longer answer.
      const firstTry = fullContent.slice(chunkStart);
      if (nonWs(firstTry) < nonWs(chunks[i]) * 0.6) {
        fullContent = fullContent.slice(0, chunkStart);
        try {
          await streamChunk(messages);
          if (nonWs(fullContent.slice(chunkStart)) < nonWs(firstTry)) fullContent = fullContent.slice(0, chunkStart) + firstTry;
        } catch (e) {
          if (e.name === "AbortError") throw e;
          fullContent = fullContent.slice(0, chunkStart) + firstTry;
        }
        if (state.activeTabId === tabId && textEl) textEl.innerHTML = markdownToHtml(fullContent);
      }
      // Both attempts empty for a non-empty chunk: continuing would silently drop the
      // chunk's entire content from the result — fail loudly instead (mirrors the
      // server twin in server/url-fetch.js formatTranscriptServer).
      if (!nonWs(fullContent.slice(chunkStart)) && nonWs(chunks[i])) {
        throw new Error(`模型对第 ${i + 1}/${totalChunks} 段返回了空结果`);
      }

      // Add separator between chunks
      if (i < chunks.length - 1) {
        fullContent += "\n\n";
        if (state.activeTabId === tabId && textEl) {
          textEl.innerHTML = markdownToHtml(fullContent);
        }
      }
    }

    // Remove progress markers from final content
    fullContent = fullContent.replace(progressMarker, "\n\n");
    // Save final result
    fullContent = fullContent.trim() || "整理失败，请重试。";
    fullContent = `${L.header}\n\n${fullContent}`;
    if (state.activeTabId === tabId && textEl) textEl.innerHTML = markdownToHtml(fullContent);
    placeMsg(tab, { role: "assistant", content: fullContent, timestamp: Date.now() }, cursor);
    saveChat();
    if (state.activeTabId === tabId && _renderChat) _renderChat();
  } catch (error) {
    if (error.name === "AbortError") {
      if (fullContent.trim()) {
        placeMsg(tab, { role: "assistant", content: fullContent.trim(), timestamp: Date.now() }, cursor);
        saveChat();
        if (state.activeTabId === tabId && _renderChat) _renderChat();
      } else if (pending) {
        pending.remove();
      }
    } else {
      if (pending) pending.remove();
      placeMsg(tab, { role: "assistant", content: `⚠️ 字幕整理失败：${error.message}`, timestamp: Date.now() }, cursor);
      urlError(`字幕整理失败：${error.message}`, bg);
      saveChat();
      if (state.activeTabId === tabId && _renderChat) _renderChat();
    }
  } finally {
    if (!bg) {
      setAvatarState("idle");
      if (_setGenerating) _setGenerating(false);
      state.currentAbortController = null;
    }
  }
}

// Transcribe YouTube audio when no subtitles are available
async function transcribeYouTubeFromAudio(videoId, title, tab, tabId, cursor = null, bg = null) {
  const abortController = bg ? { signal: bg.signal } : new AbortController();
  if (!bg) {
    if (_setGenerating) _setGenerating(true);
    setAvatarState("thinking");
    state.currentAbortController = abortController;
  } else {
    bg.label(t("bg_transcribing"));
  }

  // Add a progress bubble
  let pending = null;
  if (!bg && state.activeTabId === tabId) {
    pending = document.createElement("div");
    pending.className = "message assistant thinking";
    const body = document.createElement("div");
    body.className = "markdownBody";
    body.innerHTML = '<span class="thinking-text">正在通过语音识别获取内容<span class="thinking-dots"><span>.</span><span>.</span><span>.</span><span>.</span><span>.</span><span>.</span></span></span>';
    pending.appendChild(body);
    placePending(pending, cursor);
    scrollChatToEnd();
  }

  try {
    const response = await fetch("/api/youtube-transcribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: abortController.signal,
      body: JSON.stringify({ videoId }),
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error || "转录请求失败");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let transcriptText = "";
    let hasError = false;
    let downloadInfo = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.status === "downloading" || msg.status === "converting") {
          if (bg) bg.label(msg.message);
          if (pending) {
            const body = pending.querySelector(".markdownBody");
            if (body) body.innerHTML = `<span class="thinking-text">${msg.message}<span class="thinking-dots"><span>.</span><span>.</span><span>.</span><span>.</span><span>.</span><span>.</span></span></span>`;
          }
        } else if (msg.status === "downloaded") {
          downloadInfo = msg.message;
          if (bg) bg.label(msg.message);
          if (pending) {
            const body = pending.querySelector(".markdownBody");
            if (body) body.innerHTML = `<span class="thinking-text">${msg.message}<span class="thinking-dots"><span>.</span><span>.</span><span>.</span><span>.</span><span>.</span><span>.</span></span></span>`;
          }
        } else if (msg.status === "transcribing") {
          const display = downloadInfo ? `${downloadInfo}\n${msg.message}` : msg.message;
          if (bg) bg.label(display);
          if (pending) {
            const body = pending.querySelector(".markdownBody");
            if (body) body.innerHTML = `<span class="thinking-text">${display.replace('\n', '<br>')}<span class="thinking-dots"><span>.</span><span>.</span><span>.</span><span>.</span><span>.</span><span>.</span></span></span>`;
          }
        } else if (msg.status === "done") {
          transcriptText = msg.text || "";
        } else if (msg.status === "error" || msg.error) {
          hasError = true;
          const errMsg = msg.message || msg.error || "转录失败";
          if (pending) pending.remove();
          pending = null;
          placeMsg(tab, { role: "assistant", content: `⚠️ 语音识别失败：${errMsg}`, timestamp: Date.now() }, cursor);
          urlError(`语音识别失败：${errMsg}`, bg);
          saveChat();
          if (state.activeTabId === tabId && _renderChat) _renderChat();
        }
      }
    }
    // Process remaining buffer
    if (buffer.trim()) {
      try {
        const msg = JSON.parse(buffer);
        if (msg.status === "done") transcriptText = msg.text || "";
        else if (msg.status === "error" || msg.error) {
          hasError = true;
          if (pending) pending.remove();
          pending = null;
          placeMsg(tab, { role: "assistant", content: `⚠️ 语音识别失败：${msg.message || msg.error}`, timestamp: Date.now() }, cursor);
          urlError(`语音识别失败：${msg.message || msg.error}`, bg);
          saveChat();
          if (state.activeTabId === tabId && _renderChat) _renderChat();
        }
      } catch {}
    }

    if (pending) pending.remove();

    if (hasError) {
      if (!bg) { setAvatarState("idle"); if (_setGenerating) _setGenerating(false); state.currentAbortController = null; }
      return;
    }

    if (transcriptText) {
      // Process transcript same as subtitle flow
      if (!bg) { state.currentAbortController = null; if (_setGenerating) _setGenerating(false); setAvatarState("idle"); }
      await formatTranscriptChunked(title, transcriptText, tab, tabId, "whisper", cursor, bg);
    } else {
      placeMsg(tab, { role: "assistant", content: "⚠️ 语音识别未返回内容", timestamp: Date.now() }, cursor);
      urlError("语音识别未返回内容", bg);
      saveChat();
      if (state.activeTabId === tabId && _renderChat) _renderChat();
      if (!bg) { setAvatarState("idle"); if (_setGenerating) _setGenerating(false); state.currentAbortController = null; }
    }
  } catch (error) {
    if (pending) pending.remove();
    if (error.name !== "AbortError") {
      placeMsg(tab, { role: "assistant", content: `⚠️ 语音识别失败：${error.message}`, timestamp: Date.now() }, cursor);
      urlError(`语音识别失败：${error.message}`, bg);
      saveChat();
      if (state.activeTabId === tabId && _renderChat) _renderChat();
    }
    if (!bg) { setAvatarState("idle"); if (_setGenerating) _setGenerating(false); state.currentAbortController = null; }
  }
}