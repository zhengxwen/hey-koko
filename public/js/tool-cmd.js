// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

// /tool command — explicit tool invocation: "/tool @chrome 总结一下".
//
// The agentic loop (tools.js) lets the MODEL decide when to call a tool; that needs a
// tool-capable model and turns off streaming. /tool inverts it: the USER names the
// tool, we run it FIRST (prefetch), splice its result into the chat as a context
// bubble (tagged urlPart, same block semantics as /url), then generate a normal
// STREAMED reply — deterministic, works with every chat model. Retrieval tools only;
// action tools (reminders, memory writes) keep their own commands / the agentic loop.
import { dom, state, scrollChatToEnd } from './state.js';
import { setAvatarState } from './avatar.js';
import { saveChat } from './settings.js';
import { makePreview, fileIntoGallery, sniffImageMime, galleryUrl, galleryThumbUrl,
         cacheGalleryThumb } from './utils.js';
import { t, getPrompt } from './i18n.js';

// Dependencies injected from main.js to avoid circular imports (url-fetch.js pattern).
let _setGenerating = null;
let _renderChat = null;
let _regenerateReply = null;
let _showSendError = null;

export function setToolCmdDeps({ setGenerating, renderChat, regenerateReply, showSendError }) {
  _setGenerating = setGenerating;
  _renderChat = renderChat;
  _regenerateReply = regenerateReply;
  _showSendError = showSendError;
}

// The retrieval tools /tool can drive. needsQuery: the prompt doubles as the search
// query, so it can't be empty. descKey feeds the "@" autocomplete popup (mentions.js).
export const TOOL_CMD_ALIASES = [
  { alias: "chrome", icon: "🧭", needsQuery: false, descKey: "toolAlias_chrome" },
  { alias: "word", icon: "📝", needsQuery: false, descKey: "toolAlias_word" },
  { alias: "ppt", icon: "📊", needsQuery: false, descKey: "toolAlias_ppt" },
  { alias: "excel", icon: "📈", needsQuery: false, descKey: "toolAlias_excel" },
  { alias: "outlook", icon: "📧", needsQuery: false, descKey: "toolAlias_outlook" },
  { alias: "clip", icon: "📋", needsQuery: false, descKey: "toolAlias_clip" },
  { alias: "web", icon: "🔎", needsQuery: true, descKey: "toolAlias_web" },
  { alias: "library", icon: "📚", needsQuery: true, descKey: "toolAlias_library" },
  { alias: "memory", icon: "💭", needsQuery: true, descKey: "toolAlias_memory" },
];

// "/tool @chrome[:tabspec] [prompt…]" → { alias, arg, prompt } | { error } | null.
// The optional ":arg" (chrome only: tab number or URL/title substring) must be
// colon-glued to the alias; everything after the first whitespace is the prompt
// (may span lines).
export function parseToolCommand(content) {
  if (!content || !/^\/tool(\s|$)/.test(content)) return null;
  const m = content.match(/^\/tool\s+@([a-z]+)(?::(\S+))?\s*([\s\S]*)$/i);
  if (!m) return { error: t("tool_usage") };
  const alias = m[1].toLowerCase();
  const spec = TOOL_CMD_ALIASES.find((a) => a.alias === alias);
  if (!spec) return { error: t("tool_unknownAlias", { alias, list: TOOL_CMD_ALIASES.map((a) => "@" + a.alias).join(" ") }) };
  let prompt = (m[3] || "").trim();
  // Flags (chrome + word): "--vision"/"-v" forces a viewport screenshot alongside
  // the text (chrome; without it the server still auto-captures when the page has no
  // extractable text); "--sel"/"-s" reads ONLY the selected text — the lightweight
  // mode for repeated per-passage questions on a document already in context.
  let vision = false, sel = false;
  if (alias === "chrome" || alias === "word" || alias === "excel") {
    prompt = prompt.replace(/(^|\s)(--vision|-v|--sel|-s)(?=\s|$)/g, (_, sp, flag) => {
      if (flag === "--vision" || flag === "-v") vision = true; else sel = true;
      return sp;
    }).replace(/\s+/g, " ").trim();
  }
  if (spec.needsQuery && !prompt) return { error: t("tool_needsQuery", { alias: "@" + alias }) };
  return { alias, arg: (m[2] || "").trim(), prompt, vision, sel };
}

function embedModel() {
  return (dom.embedModelSelect?.value || "").trim() || "qwen3-embedding:8b";
}

// Same in-place splice contract as url-fetch.js placeMsg: resend passes a cursor
// pointing right after the command bubble; fresh sends append.
function placeMsg(tab, msg, cursor) {
  msg.urlPart = true;
  if (cursor && cursor.pos >= 0 && cursor.pos <= tab.messages.length) tab.messages.splice(cursor.pos++, 0, msg);
  else tab.messages.push(msg);
}

// ---- per-alias prefetchers: each returns { header, body } for the context bubble ----

async function fetchChrome(arg, vision, sel) {
  const res = await fetch("/api/browser/read", {
    method: "POST", headers: { "Content-Type": "application/json" },
    // "auto" lets the server capture a screenshot anyway when the page has no
    // extractable text (canvas charts, embedded PDF viewer, WebGL). --sel never
    // auto-captures — it is the deliberately lightweight mode.
    body: JSON.stringify({ tab: arg || "", vision: vision ? true : (sel ? false : "auto"), selectionOnly: !!sel }),
  });
  const data = await res.json();
  if (data.error === "unreachable") throw new Error(data.hint);
  if (data.error === "no_tabs") throw new Error(t("tool_noTabs"));
  if (data.error === "tab_not_found") throw new Error(t("tool_tabNotFound", { tabs: (data.tabs || []).join("\n") }));
  if (data.error === "no_selection") throw new Error(t("tool_noSelection"));
  if (data.error) throw new Error(data.error);
  let body = "";
  // Blockquote (not """) — renders as a proper quote in the markdown bubble, and the
  // per-line "> " marking keeps the boundary unambiguous whatever the selection contains.
  if (data.selection) {
    const quoted = data.selection.split("\n").map((l) => "> " + l).join("\n");
    body += `${t("tool_selectionHeader")}\n${quoted}`;
  }
  // --sel: the selection IS the payload; the full page text stays out of context.
  if (!sel) body += `${body ? "\n\n" : ""}${data.text || t("tool_emptyPage")}`;
  if (data.truncated) body += `\n\n${t("tool_truncated")}`;
  if (data.image) body += `\n\n${t("tool_screenshotNote")}`;
  return { header: `🧭 **${data.title || data.url}**\n${data.url}`, body, image: data.image || "", imageMime: data.imageMime || "image/jpeg" };
}

// Word / PowerPoint / Excel / Outlook — the server reads the LIVE app state via
// AppleScript; @clip rides the same endpoint (it is not an app, but the same shape).
const APPS_EXCEL = "Microsoft Excel";

function officeError(data) {
  if (data.error === "not_installed") return t("tool_officeNotInstalled", { app: data.app || "" });
  if (data.error === "not_running") return t("tool_officeNotRunning", { app: data.app || "" });
  if (data.error === "no_doc") return t("tool_officeNoDoc", { app: data.app || "" });
  if (data.error === "no_selection") return data.app === APPS_EXCEL ? t("tool_excelNoSelection") : t("tool_outlookNoSelection");
  if (data.error === "clip_empty") return t("tool_clipEmpty");
  if (data.error === "unsupported") return t("tool_outlookUnsupported");
  if (data.error === "unsupported_platform") return "Office tools are macOS-only.";
  return data.error;
}

async function fetchOffice(alias, sel) {
  const res = await fetch("/api/office/read", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app: alias, selectionOnly: !!sel }),
  });
  const data = await res.json();
  if (data.error) throw new Error(officeError(data));

  if (alias === "word") {
    let body = "";
    if (data.selection) {
      const quoted = data.selection.split("\n").map((l) => "> " + l).join("\n");
      body += `${t("tool_selectionHeader")}\n${quoted}`;
    }
    if (!sel) body += `${body ? "\n\n" : ""}${data.text || t("tool_emptyPage")}`;
    else if (!body) throw new Error(t("tool_noSelection"));
    if (data.truncated) body += `\n\n${t("tool_truncated")}`;
    return { header: `📝 **${data.title}**`, body, image: "", imageMime: "" };
  }

  if (alias === "excel") {
    const scope = sel
      ? t("tool_excelSelection", { address: data.address })
      : t("tool_excelSheet", { sheet: data.sheet });
    let body = data.table || t("tool_emptyPage");
    // Say what was left out rather than passing a silently clipped table off as whole.
    if (data.clipped) body += `\n\n${t("tool_excelClipped", { r: data.shownRows, c: data.shownCols, R: data.rows, C: data.cols })}`;
    return { header: `📈 **${data.title}** · ${scope}`, body, image: "", imageMime: "" };
  }

  if (alias === "clip") {
    // An image on the clipboard is the payload itself → hand it to the model like a
    // pasted screenshot. No body text: the image is right there under the header.
    if (data.image) return { header: `📋 **${t("tool_clipHeader")}**`, body: "", image: data.image, imageMime: data.imageMime || "image/png" };
    return { header: `📋 **${t("tool_clipHeader")}**`, body: data.text.split("\n").map((l) => "> " + l).join("\n"), image: "", imageMime: "" };
  }

  if (alias === "ppt") {
    let body = data.text || t("tool_emptyPage");
    if (data.notes) body += `\n\n${t("tool_pptNotesHeader")}\n${data.notes}`;
    if (data.image) body += `\n\n${t("tool_screenshotNote")}`;
    return {
      header: `📊 **${data.title}** · ${t("tool_pptSlide", { i: data.slideIndex, n: data.slideCount })}`,
      body, image: data.image || "", imageMime: data.imageMime || "image/jpeg",
    };
  }

  // outlook
  let body = `${t("tool_mailFrom")}: ${data.from || "?"}\n${t("tool_mailTo")}: ${data.to || "?"}\n${t("tool_mailDate")}: ${data.date || "?"}\n\n${data.text || t("tool_emptyPage")}`;
  if (data.truncated) body += `\n\n${t("tool_truncated")}`;
  const images = Array.isArray(data.images) ? data.images : [];
  const imageNames = Array.isArray(data.imageNames) ? data.imageNames : [];
  return { header: `📧 **${data.subject || t("tool_mailNoSubject")}**`, body, images, imageNames };
}

async function fetchWeb(query) {
  const res = await fetch("/api/search", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const data = await res.json();
  if (data.error === "captcha") throw new Error(t("tool_searchRateLimited"));
  const results = data.results || [];
  if (!results.length) throw new Error(t("tool_noResults"));
  const body = results.slice(0, 8).map((r, i) => `${i + 1}. **${r.title}**\n${r.snippet}\n(${r.url})`).join("\n\n");
  return { header: `🔎 **${t("tool_webHeader", { query })}**`, body };
}

async function fetchLibrary(query) {
  const res = await fetch("/api/library/retrieve", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, model: embedModel(), topK: 8 }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  const hits = (data.hits || []).slice(0, 8);
  if (!hits.length) throw new Error(t("tool_noLibraryHits"));
  const body = hits.map((h, i) =>
    `${i + 1}. **[${h.title}${h.section ? " · " + h.section : ""}]**\n${String(h.content || "").trim()}`).join("\n\n");
  return { header: `📚 **${t("tool_libraryHeader", { query })}**`, body };
}

async function fetchMemory(query) {
  const res = await fetch("/api/archives/search", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, model: embedModel() }),
  });
  const data = await res.json();
  if (data.needsIndex) throw new Error(t("tool_noArchiveIndex"));
  const results = (data.results || []).filter((r) => r.score > 0.15).slice(0, 5);
  if (!results.length) throw new Error(t("tool_noRecall"));
  const body = results.map((r, i) => `${i + 1}. **[${r.title}]**\n${r.snippet}`).join("\n\n");
  return { header: `💭 **${t("tool_memoryHeader", { query })}**`, body };
}

// ---- command handler (foreground; the fetches are seconds, not minutes) ----

// skipUserBubble: resend re-uses the existing command bubble (cursor set); a fresh
// send adds its own. Mirrors handleUrlCommand's contract.
export async function handleToolCommand(parsed, tab, tabId, cursor = null, skipUserBubble = false, fullContent = "") {
  const inPlace = !!(cursor && cursor.pos >= 0);
  if (!skipUserBubble) {
    tab.messages.push({ role: "user", content: fullContent, timestamp: Date.now() });
    saveChat();
    if (state.activeTabId === tabId && _renderChat) _renderChat();
  }

  const abortController = new AbortController();
  setAvatarState("thinking");
  if (_setGenerating) _setGenerating(true);
  state.currentAbortController = abortController;

  // Animated "running tool" bubble while the prefetch is in flight.
  let pending = null;
  if (state.activeTabId === tabId) {
    pending = document.createElement("div");
    pending.className = "message assistant thinking";
    const body = document.createElement("div");
    body.className = "markdownBody";
    body.innerHTML = `<span class="thinking-text">${t("tool_running", { alias: "@" + parsed.alias })}<span class="thinking-dots"><span>.</span><span>.</span><span>.</span><span>.</span><span>.</span><span>.</span></span></span>`;
    pending.appendChild(body);
    const ref = (cursor && cursor.pos >= 0) ? dom.messagesEl.children[cursor.pos] : null;
    if (ref) dom.messagesEl.insertBefore(pending, ref);
    else dom.messagesEl.appendChild(pending);
    scrollChatToEnd();
  }

  try {
    let result;
    if (parsed.alias === "chrome") result = await fetchChrome(parsed.arg, parsed.vision, parsed.sel);
    else if (["word", "ppt", "outlook", "excel", "clip"].includes(parsed.alias)) result = await fetchOffice(parsed.alias, parsed.sel);
    else if (parsed.alias === "web") result = await fetchWeb(parsed.prompt);
    else if (parsed.alias === "library") result = await fetchLibrary(parsed.prompt);
    else result = await fetchMemory(parsed.prompt);

    if (pending) pending.remove();

    // Context bubble: the tool's result, visible and part of the conversation the
    // reply model reads (exactly how /url injects a fetched page). Images belong to the
    // tool result, so they all display HERE — but in the container that matches their
    // fate, since the two can coexist on one bubble:
    //   generatedImages — display-only. Outlook's inline images are deliberately NOT
    //     forwarded (mostly logos/banners; the body text already carries ![📷 N]
    //     markers), so they land here and the bubble marks them "not sent to the AI".
    //   contextImages   — forwarded to the model. A clipboard image or a chrome/ppt
    //     screenshot IS the payload the model must see, so it goes here, paired with a
    //     displayImages thumbnail exactly like a normal user attachment.
    // trimEnd: an image-only result (clipboard image) has no body — don't leave the
    // separator's blank line dangling after the header.
    const contextMsg = { role: "assistant", content: `${result.header}\n\n${result.body || ""}`.trimEnd(), timestamp: Date.now() };
    const imgArr = Array.isArray(result.images) ? result.images : [];
    if (imgArr.length) {
      // Multi-image (outlook): full grid
      contextMsg.generatedImages = imgArr.map((im) => im.base64);
      contextMsg.generatedThumbnails = await Promise.all(
        imgArr.map((im) => makePreview(`data:${im.mime};base64,${im.base64}`, 480))
      );
      contextMsg.generatedImageNames = Array.isArray(result.imageNames) && result.imageNames.length
        ? result.imageNames
        : imgArr.map((im, i) => `image_${String(i + 1).padStart(2, "0")}.${im.mime === "image/png" ? "png" : "jpg"}`);
    } else if (result.image) {
      // Single image (clipboard paste / chrome-ppt screenshot): sent → contextImages.
      // A screenshot exists nowhere but here, so it is filed like any other attachment
      // and the bubble stores the reference — same rule as a staged upload.
      const preview = await makePreview(`data:${result.imageMime};base64,${result.image}`, 480);
      const id = await fileIntoGallery(result.image, sniffImageMime(result.image, result.imageMime), result.imageName || "");
      if (id) cacheGalleryThumb(id, preview);
      contextMsg.contextImages = [id ? galleryUrl(id) : result.image];
      contextMsg.displayImages = [id ? galleryThumbUrl(id) : preview];
    }
    placeMsg(tab, contextMsg, cursor);

    // Prompt bubble: the clean question (no "/tool @…" prefix).
    const DEFAULT_PROMPT_KEYS = {
      chrome: parsed.sel ? "toolChromeSelDefault" : "toolChromeDefault",
      word: parsed.sel ? "toolChromeSelDefault" : "toolWordDefault",
      ppt: "toolPptDefault",
      outlook: "toolOutlookDefault",
      excel: "toolExcelDefault",
      // The clipboard holds either text or an image — "explain this passage" makes no
      // sense for a screenshot, so the image case gets its own wording.
      clip: result.image ? "toolClipImageDefault" : "toolClipDefault",
    };
    const promptText = parsed.prompt || getPrompt(DEFAULT_PROMPT_KEYS[parsed.alias] || "toolChromeDefault");
    const promptMsg = { role: "user", content: promptText, timestamp: Date.now() };

    // The image itself is carried by the context bubble's contextImages above — it must
    // NOT be duplicated here, or the model would receive it twice.
    placeMsg(tab, promptMsg, cursor);
    saveChat();
    if (state.activeTabId === tabId && _renderChat) _renderChat();

    state.currentAbortController = null;
    if (_setGenerating) _setGenerating(false);

    if (!_regenerateReply) return;
    if (inPlace) { await _regenerateReply(tabId, cursor.pos, cursor.pos - 1, { urlPart: true }); cursor.pos++; }
    else _regenerateReply(tabId, -1, -1, { urlPart: true });
  } catch (e) {
    if (pending) pending.remove();
    placeMsg(tab, { role: "assistant", content: `⚠️ ${e.message || t("tool_failed")}`, timestamp: Date.now() }, cursor);
    if (_showSendError) _showSendError(e.message || t("tool_failed"));
    saveChat();
    if (state.activeTabId === tabId && _renderChat) _renderChat();
    setAvatarState("idle");
    if (_setGenerating) _setGenerating(false);
    state.currentAbortController = null;
  }
}
