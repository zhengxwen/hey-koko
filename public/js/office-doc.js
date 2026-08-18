// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

// /doc — edit and generate Word/PowerPoint/Excel files from the conversation.
//
// The shape is /skill's: opening a document loads TWO things into the chat — a map of
// the document (paths + text, so the model can target an edit) and the officecli
// authoring guide for that format — and then it is ordinary chat. The model answers with
// an ```officecli block, and ▶ on that block applies it. Generation is never implicit: a
// block is a proposal until the user presses the button.
//
// Unlike /imagine's ▶ (which re-submits through the composer so staged attachments and
// the background queue behave identically), ▶ here calls the server directly. There is
// nothing to stage, and round-tripping a JSON body through the message input would put
// an unreadable blob in the user's draft.
//
// The user's own file is never edited. /doc takes a working copy into ~/.hey-koko/office/
// (server side) and edits that: officecli needs a stable path, and a document open in
// Word would overwrite our edits on its next save anyway.
import { dom, state, scrollChatToEnd } from './state.js';
import { setAvatarState } from './avatar.js';
import { saveChat } from './settings.js';
import { getActiveTab } from './tabs.js';
import { readFileAsDataUrl, makePreview } from './utils.js';
import { t, getPrompt } from './i18n.js';

// Injected from main.js — same anti-circular-import contract as tool-cmd.js.
let _setGenerating = null;
let _renderChat = null;
let _regenerateReply = null;
let _showSendError = null;

export function setOfficeDocDeps({ setGenerating, renderChat, regenerateReply, showSendError }) {
  _setGenerating = setGenerating;
  _renderChat = renderChat;
  _regenerateReply = regenerateReply;
  _showSendError = showSendError;
}

export const OFFICE_EXTS = [".docx", ".xlsx", ".pptx"];
const FORMATS = ["pptx", "docx", "xlsx"];
const extOf = (name) => {
  const m = /\.[a-z0-9]+$/i.exec(String(name || ""));
  return m ? m[0].toLowerCase() : "";
};
export const isOfficeFile = (name) => OFFICE_EXTS.includes(extOf(name));

// "/doc" | "/doc new pptx …" | "/doc ~/deck.pptx 把标题改短" → parsed | { error } | null.
// A quoted path keeps its spaces; an unquoted one is taken up to the extension, so
// "/doc ~/My Decks/q4.pptx tighten the titles" still resolves.
export function parseDocCommand(content) {
  if (!content || !/^\/doc(\s|$)/.test(content)) return null;
  const rest = content.replace(/^\/doc\s*/, "");
  if (!rest.trim()) return { mode: "status" };

  const isNew = rest.match(/^new(?:\s+(\S+))?\s*([\s\S]*)$/i);
  if (isNew) {
    const format = String(isNew[1] || "").toLowerCase().replace(/^\./, "");
    if (!format) return { error: t("doc_pickFormat", { list: FORMATS.join(" ") }) };
    if (!FORMATS.includes(format)) return { error: t("doc_unknownFormat", { val: format, list: FORMATS.join(" ") }) };
    return { mode: "new", format, prompt: (isNew[2] || "").trim() };
  }

  const quoted = rest.match(/^"([^"]+)"\s*([\s\S]*)$/) || rest.match(/^'([^']+)'\s*([\s\S]*)$/);
  if (quoted) {
    if (!isOfficeFile(quoted[1])) return { error: t("doc_unsupported", { list: OFFICE_EXTS.join(" ") }) };
    return { mode: "open", path: quoted[1], prompt: (quoted[2] || "").trim() };
  }
  // Unquoted: the extension is the delimiter, not the first space.
  const withExt = rest.match(/^(\S.*?\.(?:docx|xlsx|pptx))(?:\s+([\s\S]*))?$/i);
  if (withExt) return { mode: "open", path: withExt[1], prompt: (withExt[2] || "").trim() };

  // No path at all: a prompt aimed at the document already open in this tab.
  return { mode: "continue", prompt: rest.trim() };
}

// The document this tab is working on, if any.
export const activeDoc = (tab) => (tab && tab.officeDoc) || null;

// ---- rendering the server's outline as something a model can target ----

function outlineMarkdown(outline) {
  if (!outline) return "";
  if (outline.kind === "slides") {
    return (outline.slides || []).map((sl) => {
      const shapes = (sl.shapes || []).map((sh) => {
        const text = String(sh.text || "").replace(/\s+/g, " ").trim();
        return `  - \`${sh.path}\`${sh.type && sh.type !== "shape" ? ` (${sh.type})` : ""}${text ? ` — ${text.slice(0, 120)}` : ""}`;
      }).join("\n");
      return `- **${t("doc_slideN", { n: sl.slide })}** \`${sl.path}\`\n${shapes || `  - ${t("doc_empty")}`}`;
    }).join("\n");
  }
  if (outline.kind === "paragraphs") {
    return (outline.elements || []).map((el) => {
      const text = String(el.text || "").replace(/\s+/g, " ").trim();
      return `- \`${el.path}\`${el.type && el.type !== "paragraph" ? ` (${el.type})` : ""}${text ? ` — ${text.slice(0, 160)}` : ""}`;
    }).join("\n");
  }
  return (outline.sheets || []).map((sh) => {
    const rows = (sh.rows || []).slice(0, 40).map((r) => {
      const cells = Object.entries(r.cells || {}).map(([k, v]) => `${k}=${v}`).join("  ");
      return `  - ${cells}`;
    }).join("\n");
    return `- **${sh.name}**\n${rows || `  - ${t("doc_empty")}`}`;
  }).join("\n");
}

// One-line "4 slides" / "29 paragraphs" / "12 cells" summary from officecli's stats.
function statsLine(stats) {
  if (!stats) return "";
  if ("slides" in stats) return t("doc_statSlides", { n: stats.slides });
  if ("paragraphs" in stats) return t("doc_statParagraphs", { n: stats.paragraphs, words: stats.words || 0 });
  if ("sheets" in stats) return t("doc_statCells", { n: stats.totalCells || 0, sheets: stats.sheets || 1 });
  return "";
}

// Page previews ride along as DISPLAY-only images. The model is given the text outline
// instead: it is what an ```officecli block has to address, it costs a fraction of the
// tokens, and it works with chat models that have no vision at all.
async function attachPages(msg, pages) {
  const list = (pages || []).slice(0, 8);
  if (!list.length) return;
  msg.generatedImages = list.map((p) => p.base64);
  msg.generatedThumbnails = await Promise.all(list.map((p) => makePreview(`data:${p.mime};base64,${p.base64}`, 480)));
  msg.generatedImageNames = list.map((p) => `page_${String(p.page).padStart(2, "0")}.png`);
  msg.notSentToAi = true;
}

// ---- the command ----

export async function handleDocCommand(parsed, tab, tabId, rawContent, stagedFile = null) {
  const push = (msg) => { tab.messages.push(msg); };
  const flush = () => { saveChat(); if (state.activeTabId === tabId && _renderChat) _renderChat(); };
  const say = (text) => { push({ role: "assistant", content: text, timestamp: Date.now() }); flush(); };

  push({ role: "user", content: rawContent, timestamp: Date.now() });
  flush();

  if (parsed.error) { say(t("msg_commandError", { error: parsed.error })); return; }

  // Bare "/doc": what this tab is working on, and how to point it at something.
  if (parsed.mode === "status") {
    const cur = activeDoc(tab);
    say(cur ? t("doc_statusOpen", { name: cur.name }) + "\n\n" + t("doc_usage") : t("doc_usage"));
    return;
  }

  const status = await fetch("/api/officecli/status").then((r) => r.json()).catch(() => null);
  if (!status || !status.available) { say(t("doc_noBinary")); return; }

  // "/doc <prompt>" with a document already open is just another turn about it.
  if (parsed.mode === "continue") {
    const cur = activeDoc(tab);
    if (!cur) { say(t("doc_noActive") + "\n\n" + t("doc_usage")); return; }
    push({ role: "user", content: parsed.prompt, timestamp: Date.now() });
    flush();
    if (_regenerateReply) _regenerateReply(tabId, -1, -1, {});
    return;
  }

  setAvatarState("thinking");
  if (_setGenerating) _setGenerating(true);
  let pending = null;
  if (state.activeTabId === tabId) {
    pending = document.createElement("div");
    pending.className = "message assistant thinking";
    pending.innerHTML = `<div class="markdownBody"><span class="thinking-text">${t("doc_opening")}<span class="thinking-dots"><span>.</span><span>.</span><span>.</span><span>.</span><span>.</span><span>.</span></span></span></div>`;
    dom.messagesEl.appendChild(pending);
    scrollChatToEnd();
  }
  const done = () => {
    if (pending) pending.remove();
    setAvatarState("idle");
    if (_setGenerating) _setGenerating(false);
  };

  try {
    let format = parsed.format || "";
    // "new": no document yet, only the guide. The model's block must carry "format".
    if (parsed.mode === "open") {
      const body = stagedFile
        ? { b64: (await readFileAsDataUrl(stagedFile.rawFile)).split(",")[1], name: stagedFile.name, preview: true, maxPages: 4 }
        : { path: parsed.path, preview: true, maxPages: 4 };
      const opened = await fetch("/api/officecli/open", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      }).then((r) => r.json());
      if (!opened || !opened.ok) throw new Error(docError(opened));
      format = opened.format;
      tab.officeDoc = { id: opened.id, name: opened.name, format };

      const header = `📄 **${opened.name}** — ${statsLine(opened.stats)}`;
      const map = outlineMarkdown(opened.outline);
      const ctx = {
        role: "assistant", timestamp: Date.now(),
        content: `${header}\n\n${t("doc_outlineHeader")}\n\n${map}`.trim(),
      };
      await attachPages(ctx, opened.pages);
      push(ctx);
    }

    // The authoring guide, tagged so folding it turns /doc off for this conversation —
    // the same off switch a /skill guide has.
    const guide = await fetch(`/api/officecli/guide?format=${encodeURIComponent(format)}`).then((r) => r.json());
    if (!guide || !guide.ok) throw new Error((guide && guide.code) || "guide unavailable");
    push({
      role: "assistant", timestamp: Date.now(), officeGuide: true, officeFormat: format,
      content: `🧾 **${t("doc_guideHeader", { format })}**\n\n${guide.guide}`,
    });

    done();
    const promptText = parsed.prompt || getPrompt(parsed.mode === "new" ? "docNewDefault" : "docOpenDefault");
    push({ role: "user", content: promptText, timestamp: Date.now() });
    flush();
    if (_regenerateReply) _regenerateReply(tabId, -1, -1, {});
  } catch (e) {
    done();
    say(`⚠️ ${e.message || t("doc_failed")}`);
    if (_showSendError) _showSendError(e.message || t("doc_failed"));
  }
}

// Server errors arrive as { code, message } — prefer the message (it carries officecli's
// own per-operation reasons), fall back to a localized line for the codes we know.
function docError(res) {
  if (!res) return t("doc_failed");
  const known = {
    unavailable: t("doc_noBinary"),
    unsupported_type: t("doc_unsupported", { list: OFFICE_EXTS.join(" ") }),
    file_not_found: t("doc_notFound"),
    write_unverified: t("doc_unverified"),
    empty_batch: t("doc_emptyBlock"),
  }[res.code];
  return res.message || known || res.code || t("doc_failed");
}

// ---- applying an ```officecli block (the ▶ button) ----

// Accepts the block body: a JSON object, or a bare array of operations for a model that
// skipped the envelope. Returns { commands, format, name } or throws.
export function parseOfficeBlock(raw) {
  const text = String(raw || "").trim();
  if (!text) throw new Error(t("doc_emptyBlock"));
  let obj;
  try { obj = JSON.parse(text); } catch (e) { throw new Error(t("doc_badJson", { error: e.message })); }
  if (Array.isArray(obj)) return { commands: obj };
  if (!obj || typeof obj !== "object") throw new Error(t("doc_badJson", { error: "not an object" }));
  const commands = Array.isArray(obj.commands) ? obj.commands : null;
  if (!commands || !commands.length) throw new Error(t("doc_emptyBlock"));
  return { commands, format: obj.format ? String(obj.format).toLowerCase() : "", name: obj.name || "" };
}

// Run one block: a "format" makes it a new document, otherwise it edits the tab's
// working copy. Both paths report back into the conversation — including failures, which
// carry officecli's per-operation reasons so the next turn can fix the block.
export async function runOfficeBlock(raw, tabId = state.activeTabId) {
  const tab = getActiveTab();
  if (!tab) return;
  const flush = () => { saveChat(); if (state.activeTabId === tabId && _renderChat) _renderChat(); };
  const say = (text, extra = {}) => { tab.messages.push({ role: "assistant", content: text, timestamp: Date.now(), ...extra }); flush(); };

  let block;
  try { block = parseOfficeBlock(raw); } catch (e) { say(`⚠️ ${e.message}`); return; }

  const cur = activeDoc(tab);
  if (!block.format && !cur) { say(`⚠️ ${t("doc_noActive")}`); return; }

  setAvatarState("thinking");
  if (_setGenerating) _setGenerating(true);
  let pending = null;
  if (state.activeTabId === tabId) {
    pending = document.createElement("div");
    pending.className = "message assistant thinking";
    pending.innerHTML = `<div class="markdownBody"><span class="thinking-text">${t("doc_applying")}<span class="thinking-dots"><span>.</span><span>.</span><span>.</span><span>.</span><span>.</span><span>.</span></span></span></div>`;
    dom.messagesEl.appendChild(pending);
    scrollChatToEnd();
  }

  try {
    const url = block.format ? "/api/officecli/build" : "/api/officecli/edit";
    const body = block.format
      ? { format: block.format, name: block.name || t("doc_untitled"), commands: block.commands, preview: true, maxPages: 8 }
      : { id: cur.id, commands: block.commands, preview: true, maxPages: 8 };
    const res = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }).then((r) => r.json());
    if (pending) { pending.remove(); pending = null; }
    if (!res || !res.ok) {
      // A failed block is a conversation turn, not a toast: the model has to read the
      // reason to correct itself, so it lands in the transcript.
      say(`⚠️ ${t("doc_failedApply")}\n\n\`\`\`\n${docError(res)}\n\`\`\`\n\n${t("doc_fixHint")}`);
      return;
    }
    if (block.format) tab.officeDoc = { id: res.id, name: res.name, format: block.format };

    const doc = activeDoc(tab);
    const link = `/api/officecli/file/${encodeURIComponent(doc.id)}`;
    const msg = {
      role: "assistant", timestamp: Date.now(),
      content: [
        `✅ ${t("doc_applied", { n: block.commands.length })} — **${doc.name}**`,
        statsLine(res.stats),
        "",
        `[⬇️ ${t("doc_download")}](${link})`,
      ].filter(Boolean).join("\n"),
    };
    await attachPages(msg, res.pages);
    tab.messages.push(msg);
    // The refreshed map is appended so the model's next block is written against paths
    // that exist NOW — an edit renumbers everything after it. Deliberately NOT folded:
    // folding drops a bubble from the model's context, which is exactly the half that
    // matters here.
    if (res.outline) {
      tab.messages.push({
        role: "assistant", timestamp: Date.now(),
        content: `${t("doc_outlineHeader")}\n\n${outlineMarkdown(res.outline)}`,
      });
    }
    flush();
  } catch (e) {
    if (pending) pending.remove();
    say(`⚠️ ${e.message || t("doc_failed")}`);
    if (_showSendError) _showSendError(e.message || t("doc_failed"));
  } finally {
    if (pending) pending.remove();
    setAvatarState("idle");
    if (_setGenerating) _setGenerating(false);
  }
}
