// URL fetching and content parsing (/url command)
import { dom, state, scrollChatToEnd } from './state.js';
import { setAvatarState } from './avatar.js';
import { markdownToHtml } from './markdown.js';
import { saveChat } from './settings.js';
import { makePreview } from './utils.js';
import { getPromptLanguage, t } from './i18n.js';

const CHUNK_CHAR_LIMIT = 3000; // Split transcripts longer than this

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
function urlError(reason) {
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

  // Reply right after the produced content (in place) or at the end (fresh). bg jobs
  // are always in-place (cursor set) and run the reply headless.
  const runReply = async () => {
    if (!_regenerateReply) return;
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
      urlError(data.error || data.content || "获取失败");
      saveChat();
      if (state.activeTabId === tabId && _renderChat) _renderChat();
      if (!bg) { setAvatarState("idle"); if (_setGenerating) _setGenerating(false); }
      return;
    }

    if (data.type === "unsupported") {
      placeMsg(tab, { role: "assistant", content: `⚠️ ${data.content}`, timestamp: Date.now() }, cursor);
      urlError(data.content);
      saveChat();
      if (state.activeTabId === tabId && _renderChat) _renderChat();
      if (!bg) { setAvatarState("idle"); if (_setGenerating) _setGenerating(false); }
      return;
    }

    // Display fetched content in an assistant bubble
    let displayContent = "";
    const hasRealTranscript = data.type === "youtube" && data.content && !data.content.startsWith("[");
    if (data.type === "youtube") {
      // Show video info card
      const infoParts = [`📺 **${data.title}**`, url, ""];
      if (data.channel) infoParts.push(`频道：${data.channel}`);
      if (data.duration) infoParts.push(`时长：${data.duration}`);
      if (data.viewCount) infoParts.push(`播放：${Number(data.viewCount).toLocaleString()} 次`);
      if (data.uploadDate) {
        const d = data.uploadDate.replace(/-/g, "").slice(0, 8);
        if (d.length === 8) infoParts.push(`日期：${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}`);
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
      msgObj.generatedThumbnails = [await makePreview(data.thumbnail)];
      msgObj.ytVideoId = data.videoId;
    } else if (data.type === "webpage" && Array.isArray(data.images) && data.images.length) {
      msgObj.generatedThumbnails = await Promise.all(data.images.map((img) => makePreview(img)));
    }
    placeMsg(tab, msgObj, cursor);
    saveChat();
    if (state.activeTabId === tabId && _renderChat) _renderChat();

    if (!bg) { state.currentAbortController = null; if (_setGenerating) _setGenerating(false); }

    // For YouTube, ask AI to format the transcript into readable text
    if (hasRealTranscript) {
      await formatTranscriptChunked(data.title, data.content, tab, tabId, undefined, cursor, bg);
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
      // For non-YouTube: if prompt exists, add user message with prompt; otherwise let AI process normally
      if (prompt) {
        placeMsg(tab, { role: "user", content: prompt, timestamp: Date.now() }, cursor);
        saveChat();
        if (state.activeTabId === tabId && _renderChat) _renderChat();
      }
      await runReply();
    }
  } catch (error) {
    if (pending) pending.remove();
    if (error.name === "AbortError") {
      // User cancelled
    } else {
      placeMsg(tab, { role: "assistant", content: `⚠️ 获取失败：${error.message}`, timestamp: Date.now() }, cursor);
      urlError(`获取失败：${error.message}`);
      saveChat();
      if (state.activeTabId === tabId && _renderChat) _renderChat();
    }
    if (!bg) { setAvatarState("idle"); if (_setGenerating) _setGenerating(false); }
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

// Split transcript into chunks at line boundaries
function splitTranscript(text, limit) {
  const lines = text.split("\n");
  const chunks = [];
  let current = "";
  for (const line of lines) {
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
async function formatTranscriptChunked(title, transcript, tab, tabId, source, cursor = null, bg = null) {
  const chunks = splitTranscript(transcript, CHUNK_CHAR_LIMIT);
  const totalChunks = chunks.length;

  // Add a user message indicating transcript formatting, with the raw transcript appended
  const instructions = totalChunks > 1
    ? `请将以下YouTube视频「${title}」的原始字幕整理成易读的文本（共${totalChunks}段）。要求：\n1. 添加标点符号，连成完整的句子和段落\n2. 适当分段换行（按语义自然分段）\n3. 不要改变原意，不要添加内容\n4. 不要省略任何字幕内容`
    : `请将以下YouTube视频「${title}」的原始字幕整理成易读的文本。要求：\n1. 添加标点符号，连成完整的句子和段落\n2. 适当分段换行（按语义自然分段）\n3. 不要改变原意，不要添加内容\n4. 不要省略任何字幕内容`;
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

  try {
    for (let i = 0; i < chunks.length; i++) {
      if (abortController.signal.aborted) break;

      if (bg) bg.label(t("bg_formattingSubs", { i: i + 1, n: totalChunks }));
      // Show progress between chunks
      if (i > 0 && pending && textEl) {
        fullContent += `\n\n---\n*正在整理第 ${i + 1}/${totalChunks} 段...*\n\n`;
        textEl.innerHTML = markdownToHtml(fullContent);
        scrollChatToEnd();
      } else if (i > 0 && pending && !textEl) {
        const body = pending.querySelector(".markdownBody");
        if (body) body.innerHTML = '<span class="thinking-text">正在整理字幕 (' + (i + 1) + '/' + totalChunks + ')<span class="thinking-dots"><span>.</span><span>.</span><span>.</span><span>.</span><span>.</span><span>.</span></span></span>';
      }

      const chunkPrompt = i === 0
        ? `请整理以下字幕片段（第${i + 1}/${totalChunks}段），添加标点并分段，不要省略内容：\n\n${chunks[i]}`
        : `请继续整理下一段字幕（第${i + 1}/${totalChunks}段），保持与前面相同的格式风格，添加标点并分段，不要省略内容：\n\n${chunks[i]}`;

      const messages = [
        { role: "system", content: `你是字幕整理助手。将原始字幕片段整理为易读文本：添加标点符号、连成完整句子、适当分段。不要改变原意，不要添加或省略内容。直接输出整理后的文本，不要加任何前缀说明。` },
        { role: "user", content: chunkPrompt },
      ];

      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: abortController.signal,
        body: JSON.stringify({
          model: dom.modelSelect.value,
          messages,
          options: { temperature: 0.3 },
          timeout: parseInt(dom.imageTimeoutInput?.value, 10) || 120,
        }),
      });

      if (!response.ok) {
        const errData = await response.json();
        throw new Error(errData.error || "请求失败");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      function appendLine(line) {
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

      // Add separator between chunks
      if (i < chunks.length - 1) {
        fullContent += "\n\n";
        if (state.activeTabId === tabId && textEl) {
          textEl.innerHTML = markdownToHtml(fullContent);
        }
      }
    }

    // Remove progress markers from final content
    fullContent = fullContent.replace(/\n\n---\n\*正在整理第 \d+\/\d+ 段\.\.\.\*\n\n/g, "\n\n");
    // Save final result
    fullContent = fullContent.trim() || "整理失败，请重试。";
    fullContent = `**📝 整理好的字幕**\n\n${fullContent}`;
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
      urlError(`字幕整理失败：${error.message}`);
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
          urlError(`语音识别失败：${errMsg}`);
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
          urlError(`语音识别失败：${msg.message || msg.error}`);
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
      urlError("语音识别未返回内容");
      saveChat();
      if (state.activeTabId === tabId && _renderChat) _renderChat();
      if (!bg) { setAvatarState("idle"); if (_setGenerating) _setGenerating(false); state.currentAbortController = null; }
    }
  } catch (error) {
    if (pending) pending.remove();
    if (error.name !== "AbortError") {
      placeMsg(tab, { role: "assistant", content: `⚠️ 语音识别失败：${error.message}`, timestamp: Date.now() }, cursor);
      urlError(`语音识别失败：${error.message}`);
      saveChat();
      if (state.activeTabId === tabId && _renderChat) _renderChat();
    }
    if (!bg) { setAvatarState("idle"); if (_setGenerating) _setGenerating(false); state.currentAbortController = null; }
  }
}