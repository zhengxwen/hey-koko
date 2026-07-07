// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

// The `/ask` command + the library panel's ask-box generation core. Retrieval is
// server-side (/api/library/retrieve); generation reuses /api/chat and streams the
// answer. Extracted from library.js so library.js stays about the panel/import/CRUD,
// and so the planned agentic "deep" mode (/ask -d) has a focused home.
//
// No static import of library.js (that would be a cycle): the panel's open-doc /
// open-panel are injected via setAskDeps(), and chat.js is loaded lazily inside
// handleAskCommand. library.js imports runLibraryQuery/initAsk/setAskDeps from here.

import { dom, state } from './state.js';
import { genId, postJson } from './utils.js';
import { t, getPromptLanguage } from './i18n.js';
import { getNumCtx } from './context-meter.js';
import { kindIcon, mentionDocName, mentionDocIcon, mentionArchiveName } from './mentions.js';
import { saveTabs, saveCurrentSettings } from './settings.js';
import { openArchivedChat } from './archive.js';

const embedModel = () => (dom.embedModelSelect?.value || "").trim() || "qwen3-embedding:8b";

// Panel hooks injected by library.js's initLibrary (avoids a static cycle): open the
// library panel, and open a specific doc in it. Used by the #libsrc source links.
let _openLibrary = null;
let _openDoc = null;
export function setAskDeps({ openLibrary, openDoc } = {}) {
  if (openLibrary) _openLibrary = openLibrary;
  if (openDoc) _openDoc = openDoc;
}

// Peel a nested-JSON error down to its human message (mirror of chat.js's export;
// kept local so this module needn't statically import chat.js — that pairing is a
// cycle, resolved via the dynamic import in handleAskCommand).
function cleanErrorMessage(raw) {
  let s = (raw == null ? "" : String(raw)).trim();
  for (let i = 0; i < 6 && (s.startsWith("{") || s.startsWith("[")); i++) {
    let obj;
    try { obj = JSON.parse(s); } catch { break; }
    const next = (obj && (obj.error?.message ?? obj.message ?? obj.error)) ?? null;
    if (next == null) break;
    s = (typeof next === "object" ? JSON.stringify(next) : String(next)).trim();
  }
  return s;
}

// ---- /ask ⚙ parameters (gear button next to the embedding-model select) ----
// Fall back to the long-standing defaults when a field is empty or out of range.
const askTopK = () => { const v = parseInt(dom.libraryAskTopK?.value, 10); return (v >= 1 && v <= 50) ? v : 6; };
const askMaxImages = () => { const v = parseInt(dom.libraryAskImages?.value, 10); return (v >= 0 && v <= 10) ? v : 3; };
// Full-read budget: an explicit number wins; EMPTY = auto-size to the context-length
// setting — (num_ctx − 8k reserve for question/snippets/answer) × ~4 chars/token,
// floored at 8k chars. 32k ctx → ~98k chars, i.e. the old fixed 100000 default.
// (~4 chars/token fits English; CJK-heavy docs run denser and may still truncate.)
const autoFullBudget = () => Math.max(8000, (getNumCtx() - 8192) * 4);
// Rough token estimate: CJK runs ~1 token/char, everything else ~4 chars/token.
// Used to keep the full-read prompt inside num_ctx on Chinese-heavy docs, where
// the character budget alone (sized for English) overshoots the window badly.
function estimateTokens(s) {
  let cjk = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if ((c >= 0x2E80 && c <= 0x9FFF) || (c >= 0xAC00 && c <= 0xD7AF) ||
        (c >= 0xF900 && c <= 0xFAFF) || (c >= 0xFF00 && c <= 0xFFEF)) cjk++;
  }
  return Math.ceil(cjk + (s.length - cjk) / 4);
}
const askFullBudget = () => { const v = parseInt(dom.libraryAskBudget?.value, 10); return v >= 1000 ? v : autoFullBudget(); };

// For "/ask @doc …" (scoped): pull the WHOLE text of the chosen docs (document body
// only, skipping conversation bubbles) up to a char budget, plus a few figures. The
// model then reads the entire article(s) instead of a handful of retrieved snippets —
// so instructions like "帮我理解，生成表格" work on the full paper.
const FULL_DOC_BUDGET = 100000;   // ~25k tokens; needs the chat model's num_ctx to be large enough

// /ask generation prompts follow the PROMPT-LANGUAGE setting (same rule as the
// server's rerank/distill prompts). sysFull/sysRag get the assembled context
// appended; roleUser/roleAssistant label archive transcripts; summarize is the
// default question for a scoped "/ask @doc" with no question.
const ASK_I18N = {
  zh: {
    sysFullA: "你是知识库助手。下面是用户指定的文档/对话全文",
    sysFullTrunc: "（内容较长，已截断部分）",
    sysFullB: "，请通读全文后完成用户的要求（如理解、总结、生成表格等）。\n\n全文：\n",
    sysRag: "你是知识库助手。请仅依据下列资料片段回答问题，并用 [n] 标注引用来源；若资料中找不到依据，请直接说明未找到。\n\n资料片段：\n",
    sysRagMore: "另外，以下是从知识库限定文件夹检索到的相关片段，可与上文全文互为补充；引用片段时用 [n] 标注来源。\n\n资料片段：\n",
    roleUser: "用户", roleAssistant: "助手",
    summarize: "请通读全文，总结主要内容和要点。",
    slidesHint: "\n注意：部分来源是幻灯片页（要点式残句 + 演讲备注），请基于页面要点和备注作答，不要臆测未写明的论证细节；引用幻灯片时可指出具体页码。",
    pgPrev: "上一页", pgThis: "本页", pgNext: "下一页",
  },
  "zh-Hant": {
    sysFullA: "你是知識庫助手。下面是用戶指定的文檔/對話全文",
    sysFullTrunc: "（內容較長，已截斷部分）",
    sysFullB: "，請通讀全文後完成用戶的要求（如理解、總結、生成表格等）。\n\n全文：\n",
    sysRag: "你是知識庫助手。請僅依據下列資料片段回答問題，並用 [n] 標註引用來源；若資料中找不到依據，請直接說明未找到。\n\n資料片段：\n",
    sysRagMore: "另外，以下是從知識庫限定資料夾檢索到的相關片段，可與上文全文互為補充；引用片段時用 [n] 標註來源。\n\n資料片段：\n",
    roleUser: "用戶", roleAssistant: "助手",
    summarize: "請通讀全文，總結主要內容和要點。",
    slidesHint: "\n注意：部分來源是簡報頁（要點式殘句 + 演講備註），請基於頁面要點和備註作答，不要臆測未寫明的論證細節；引用簡報時可指出具體頁碼。",
    pgPrev: "上一頁", pgThis: "本頁", pgNext: "下一頁",
  },
  en: {
    sysFullA: "You are a knowledge-library assistant. Below is the full text of the document(s)/conversation(s) the user selected",
    sysFullTrunc: " (long content, partially truncated)",
    sysFullB: ". Read it all, then carry out the user's request (understand, summarize, build a table, …).\n\nFull text:\n",
    sysRag: "You are a knowledge-library assistant. Answer ONLY from the source snippets below, citing them as [n]; if the snippets don't support an answer, say so plainly.\n\nSource snippets:\n",
    sysRagMore: "Additionally, the snippets below were retrieved from the scoped library folder(s); use them alongside the full text above, citing them as [n].\n\nSource snippets:\n",
    roleUser: "User", roleAssistant: "Assistant",
    summarize: "Read the full text and summarize its main content and key points.",
    slidesHint: "\nNote: some sources are slide pages (terse bullet fragments + speaker notes). Answer from the page's points and notes; don't infer argument details that aren't stated. When citing a slide, you may give the page number.",
    pgPrev: "prev page", pgThis: "this page", pgNext: "next page",
  },
};
const askL = () => ASK_I18N[getPromptLanguage()] || ASK_I18N.en;

async function fullDocsContext(docIds, budget = FULL_DOC_BUDGET, signal = null, maxImages = 3) {
  let text = "", truncated = false;
  const docs = [], images = [];
  for (const id of docIds) {
    if (text.length >= budget) { truncated = true; break; }
    let doc;
    try { const r = await postJson("/api/library/get", { docId: id }, signal); doc = r && r.doc; }
    catch (e) { if (e && e.name === "AbortError") throw e; /* else skip this doc */ }
    if (!doc) continue;
    docs.push({ docId: doc.docId, title: doc.title, docKind: doc.docKind });
    // A video doc's "figures" are transcript screenshots/thumbnails — no value for
    // Q&A and they break text-only chat models ("No endpoints found that support
    // image input"). Read its text only, skip the images.
    const takeImages = doc.docKind !== "video";
    let body = `# ${doc.title}\n\n`, lastSec = null;
    for (const b of (doc.blocks || [])) {
      if (b.kind === "user" || b.kind === "reply" || b.kind === "note") continue;   // skip conversation
      if (b.kind === "figure") { if (takeImages && images.length < maxImages && b.image) images.push({ image: b.image }); continue; }
      if (b.section && b.section !== lastSec) { body += `## ${b.section}\n\n`; lastSec = b.section; }
      body += (b.content || "") + "\n\n";
    }
    if (text.length + body.length > budget) { body = body.slice(0, budget - text.length); truncated = true; }
    text += body;
  }
  return { text: text.trim(), truncated, docs, images };
}

// Like fullDocsContext but for conversation archives ("/ask #archive …"): load the
// whole archived conversation(s) and render as a plain 用户/助手 transcript so the
// model can answer questions about that discussion. Text-only (archive images skipped).
async function fullArchivesContext(archiveNames, budget = FULL_DOC_BUDGET, signal = null) {
  if (!archiveNames || !archiveNames.length) return { text: "", truncated: false, sources: [] };
  let text = "", truncated = false;
  const sources = [];
  let results = null;
  try { const r = await postJson("/api/archives/load", { filenames: archiveNames }, signal); results = r && r.results; }
  catch (e) { if (e && e.name === "AbortError") throw e; /* else skip */ }
  for (const item of (results || [])) {
    if (!item || !item.data) continue;
    if (text.length >= budget) { truncated = true; break; }
    const conv = item.data;
    const title = conv.title || item.filename;
    sources.push({ archive: item.filename, title, docKind: "chat" });
    let body = `# ${title}\n\n`;
    for (const m of (conv.messages || [])) {
      const content = (m && m.content || "").trim();
      if (!content) continue;
      body += `**${m.role === "user" ? askL().roleUser : askL().roleAssistant}**: ${content}\n\n`;
    }
    if (text.length + body.length > budget) { body = body.slice(0, budget - text.length); truncated = true; }
    text += body;
  }
  return { text: text.trim(), truncated, sources };
}

// Shared by the panel ask-box and the chat /ask command: retrieve → generate.
// Streams the answer token-by-token through onToken(accumulatedText) if given;
// resolves to the final { answer, hits }. /api/chat returns ndjson (one JSON
// per line, {message:{content},done}) — same format chat.js consumes.
export async function runLibraryQuery(query, { docId = null, docIds = null, archives = null, folder = null, folders = null, topK = null, short = false, onPicked = null, onToken = null, signal = null } = {}) {
  const folderList = (folders && folders.length) ? folders : (folder ? [folder] : []);
  const effTopK = (topK >= 1 && topK <= 50) ? topK : askTopK();   // "-n K" beats the ⚙ setting
  const rerank = () => dom.libraryRerankToggle && dom.libraryRerankToggle.checked ? dom.modelSelect.value : "";
  let fullRead = !!((docIds && docIds.length) || (archives && archives.length));
  // SHORT mode (-s / the panel box): classic snippet RAG with [n] citations — for
  // whole-library asks and alongside full-read when @folder/ is also mentioned.
  let doRetrieve = short && (!fullRead || folderList.length > 0);
  // DEFAULT mode: retrieval only PICKS documents — whole-library or @folder/ hits
  // are deduped to docIds and those docs are read WHOLE (merged with any explicit
  // @doc mentions). #archive-only asks skip picking (the archive IS the scope).
  if (!short) {
    if (folderList.length > 0 || !fullRead) {
      const r = await postJson("/api/library/retrieve", {
        query, model: embedModel(), docId,
        folder: folderList[0] || null, folders: folderList,
        topK: effTopK, attachImages: false,
        rerank: rerank(), language: getPromptLanguage(),
      }, signal);
      const picked = [...new Set((r.hits || []).map((h) => h.docId))];
      docIds = [...new Set([...(docIds || []), ...picked])];
      // Let the caller show WHICH docs got picked before the long read+answer
      // phase starts (the /ask bubble swaps "searching…" for the doc list).
      if (onPicked && docIds.length) onPicked(docIds);
    }
    fullRead = !!((docIds && docIds.length) || (archives && archives.length));
    if (!fullRead) return { answer: t("lib_noResults"), hits: [], truncated: false };
  }
  const sysParts = [];
  let sourceHits = [], images = [], truncated = false;
  if (fullRead) {
    // Scoped to specific docs / archives → READ THE WHOLE source(s).
    const full = await fullDocsContext(docIds || [], askFullBudget(), signal, askMaxImages());
    const arch = await fullArchivesContext(archives || [], askFullBudget(), signal);
    let combined = [full.text, arch.text].filter(Boolean).join("\n\n---\n\n");
    if (combined) {
      sourceHits = [...full.docs, ...arch.sources];
      images = full.images || [];
      truncated = full.truncated || arch.truncated;
      // Auto mode: the char budget assumes ~4 chars/token (English). Chinese-heavy
      // text runs ~1 token/char and can still blow past num_ctx — estimate tokens
      // and trim proportionally. An EXPLICIT ⚙ budget is trusted as-is.
      const explicitBudget = parseInt(dom.libraryAskBudget?.value, 10) >= 1000;
      const maxTok = Math.max(2000, getNumCtx() - 8192);
      const est = estimateTokens(combined);
      if (!explicitBudget && est > maxTok) {
        combined = combined.slice(0, Math.floor(combined.length * maxTok / est));
        truncated = true;
      }
      sysParts.push(askL().sysFullA + (truncated ? askL().sysFullTrunc : "") + askL().sysFullB + combined);
    }
  }
  if (doRetrieve) {
    // Semantic retrieval of the most relevant chunks, cite [n].
    // rerank: when the toggle is on, the server runs one extra chat-model call to
    // reorder the candidates (silently falls back to vector order on any failure).
    // folders: send BOTH shapes — a pre-restart server only knows the single
    // `folder` (first one), a restarted one honors the whole list.
    const r = await postJson("/api/library/retrieve", {
      query, model: embedModel(), docId,
      folder: folderList[0] || null, folders: folderList,
      topK: effTopK, attachImages: askMaxImages() > 0, maxImages: askMaxImages(),
      rerank: rerank(),
      language: getPromptLanguage(),   // prompt language for the rerank call
    }, signal);
    if (r.hits && r.hits.length) {
      // [n] numbering continues after any full-read sources so the citations in the
      // answer line up with the numbered sources footer.
      const offset = sourceHits.length;
      const L = askL();
      // Slides hits carry ±1 page text (server attachSlideNeighbors) — expand them into
      // a prev/this/next page block so a terse single page reads in context.
      const bodyOf = (h) => {
        const n = h.neighbors;
        if (!n || (!n.prev && !n.next)) return h.content;
        const parts = [];
        if (n.prev) parts.push(`（${L.pgPrev} · ${n.prev.section}）${n.prev.content}`);
        parts.push(`（${L.pgThis} · ${h.section}）${h.content}`);
        if (n.next) parts.push(`（${L.pgNext} · ${n.next.section}）${n.next.content}`);
        return parts.join("\n");
      };
      const context = r.hits.map((h, i) => `[${offset + i + 1}] (${h.title}${h.section ? " · " + h.section : ""}):\n${bodyOf(h)}`).join("\n\n");
      sourceHits = [...sourceHits, ...r.hits];
      // Drop images that belong to a video doc (transcript screenshots — worthless
      // for Q&A and fatal to text-only chat models). Same rule as the full-read path.
      const videoDocs = new Set(r.hits.filter((h) => h.docKind === "video").map((h) => h.docId));
      const okImages = (r.images || []).filter((im) => !videoDocs.has(im.docId));
      images = [...images, ...okImages].slice(0, askMaxImages());
      sysParts.push((sysParts.length ? askL().sysRagMore : askL().sysRag) + context);
      // Slides-source caveat appended AFTER the RAG preamble (so it doesn't flip the
      // sysRag/sysRagMore selection above): terse pages, answer from points + notes.
      if (r.hits.some((h) => h.docKind === "slides")) sysParts.push(L.slidesHint);
    }
  }
  if (!sysParts.length) return { answer: t("lib_noResults"), hits: [], truncated };
  // ③ Structure-layer: prepend relation facts about any entity named in the query, so
  // relation questions are grounded in the graph. Empty (no-op) when no entity is named.
  const relFacts = await relationFactsBlock(query, folderList, signal);
  const sys = relFacts + sysParts.join("\n\n");
  const userMsg = { role: "user", content: query };
  if (images && images.length) userMsg.images = images.map((im) => im.image);

  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: dom.modelSelect.value,
      messages: [{ role: "system", content: sys }, userMsg],
      stream: true,
      // num_ctx MUST ride along like normal chat does — without it Ollama falls back
      // to the model's default window (often 4k) and silently truncates the big
      // full-read prompt, question included → empty/garbage answers.
      options: { temperature: 0.3, num_ctx: getNumCtx() },
    }),
    signal,
  });
  // A failed request (e.g. OpenRouter 429 rate-limit on a :free model) still carries
  // a JSON error body — surface it instead of a blank "(no answer)".
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const j = JSON.parse(await res.text()); msg = cleanErrorMessage(j.error ?? j) || msg; } catch { /* keep status */ }
    throw new Error(msg);
  }
  if (!res.body) return { answer: t("lib_noAnswer"), hits: sourceHits, truncated };

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "", answer = "", streamErr = null;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const m = JSON.parse(line);
        // Some backends stream a 200 then emit an inline {"error":…} line — capture
        // it so a mid-stream failure doesn't collapse into a silent "(no answer)".
        if (m.error && !answer) streamErr = cleanErrorMessage(m.error);
        const tok = (m.message && m.message.content) || "";
        if (tok) { answer += tok; if (onToken) onToken(answer); }
      } catch { /* ignore partial / non-JSON lines */ }
    }
  }
  if (!answer && streamErr) throw new Error(streamErr);
  return { answer: answer || t("lib_noAnswer"), hits: sourceHits, truncated };
}

// Encode a source ref as a "#libsrc=…" hash href — markdownToHtml turns [label](#…)
// into a link, and the delegated click handler in initAsk jumps to the doc block (or
// archived conversation). encodeURIComponent leaves ( ) ! ' * alone; ( ) would break
// the [text](url) markdown regex, so re-encode those by hand.
function srcHref(h) {
  const ref = h.archive ? { a: h.archive }
    : h.docId ? { d: h.docId, ...(h.blockId ? { b: h.blockId } : {}) } : null;
  if (!ref) return null;
  return "#libsrc=" + encodeURIComponent(JSON.stringify(ref))
    .replace(/[()!'*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}
// Markdown link for a doc/archive ref (#libsrc scheme). [ ] in a title would break
// the markdown link syntax; an ASCII "|" makes the renderer read consecutive lines
// as a TABLE (seen with "… | 4K" video titles) — soften to the box-drawing
// lookalike │ (U+2502, width-neutral in both Latin and CJK text).
export function srcLinkMd(label, ref) {
  const safe = label.replace(/[[\]]/g, " ").replace(/\|/g, "│");
  const href = srcHref(ref);
  return href ? `[${safe}](${href})` : safe;
}
function sourcesMarkdown(hits) {
  if (!hits || !hits.length) return "";
  return `\n\n---\n**${t("lib_sources")}**\n` + hits.map((h, i) =>
    `${i + 1}. ${srcLinkMd(`${kindIcon(h.docKind)} ${h.title}${h.section ? " · " + h.section : ""}`, h)}`
  ).join("\n");
}

// Open the library panel, load a doc, and flash the cited block — used by the
// chat-side /ask source links (blockId absent → just open the doc at the top).
export async function openLibrarySource(hit) {
  if (!_openLibrary || !_openDoc) return;
  _openLibrary();
  await _openDoc(hit.docId);
  if (!hit.blockId) return;
  const el = document.getElementById(`lib-block-${hit.blockId}`);
  if (el) {
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("libraryBlockHighlight");
    setTimeout(() => el.classList.remove("libraryBlockHighlight"), 1600);
  }
}

// "/ask [@doc | @folder/ | #archive …] [-n K] [-s|--short] question" →
// { docIds, folders, archives, topK, short, query } (or null if not an /ask).
// Leading mentions (no spaces) scope the query: @docId reads a whole library doc,
// @folder/ scopes retrieval to a sub-folder, #archive reads a whole conversation
// archive. The rest is the question. No mentions → whole-library search.
export function parseAskCommand(content) {
  if (!/^\/ask(\s|$)/.test(content || "")) return null;
  let rest = content.replace(/^\/ask\s*/, "");
  const docIds = [], folders = [], archives = [];
  let topK = null, short = false, auto = false, dims = null;
  let m;
  // Leading tokens: @doc / @folder/ / #archive mentions, "-n K" (per-ask top-K
  // override, also "-nK"), "-a"/"--auto" (agentic auto-retrieval), "-s"/"--short"
  // (snippet-only), '--dims "a, b"|a,b' (comparison columns for auto mode; quoted
  // form — straight "…" or CJK-IME curly “…” — admits spaces). Captures:
  //   1 mention sigil, 2 mention tok, 3 -n digits, 4/5/6 --dims value (quoted "/
  //   curly “ / bare), 7 --auto|-a, 8 --short|-s.
  while ((m = rest.match(/^(?:([@#])(\S+)|-n\s*(\d+)|--dims\s+(?:"([^"]*)"|“([^”]*)”|(\S+))|(--auto|-a)|(--short|-s))(\s+|$)/))) {
    const sig = m[1], tok = m[2];
    const dimsVal = m[4] ?? m[5] ?? m[6];
    if (sig === "#") archives.push(tok);                     // "#archive" → scope to a conversation archive (read whole)
    else if (sig === "@") {
      if (tok.endsWith("/")) folders.push(tok.slice(0, -1));   // "@folder/" → scope to a sub-folder (+ nested)
      else docIds.push(tok);                                    // "@docId"   → scope to one doc (read whole)
    } else if (m[3]) topK = Math.min(50, Math.max(1, parseInt(m[3], 10)));
    else if (dimsVal != null) dims = dimsVal.split(/[,，、]/).map((s) => s.trim()).filter(Boolean).slice(0, 12);
    else if (m[7]) auto = true;
    else short = true;
    rest = rest.slice(m[0].length);
  }
  if (dims && !dims.length) dims = null;
  return { docIds, folders, archives, topK, short, auto, dims, query: rest.trim() };
}

// scope: { docIds:[], folders:[], archives:[] }. A folder mention (@folder/) scopes
// RETRIEVAL to that sub-folder (+ nested); doc mentions (@docId) READ the whole doc(s);
// archive mentions (#archive) READ the whole conversation archive(s). Mixing folders
// with docs/archives does BOTH: full text of the docs/archives + snippets retrieved
// from the folder(s) go into one combined context.
// insertAt: null → fresh send (append the "/ask …" user bubble + answer at the end).
// A number → resend/edit: the user bubble already exists; insert the answer there.
export async function handleAskCommand(query, tab, scope = {}, insertAt = null) {
  const docIds = (scope && scope.docIds) || [];
  const folders = (scope && scope.folders) || [];
  const archives = (scope && scope.archives) || [];
  const fullReadIds = docIds.length ? docIds : null;          // docs → read whole
  const fullReadArchives = archives.length ? archives : null; // archives → read whole
  const askOptTopK = (scope && scope.topK) || null;           // "-n K" per-ask top-K
  const askShort = !!(scope && scope.short);                  // "-s/--short" snippet mode
  // Loaded up front (async) so the abort/button plumbing below is synchronous. Dynamic
  // import avoids a top-level chat.js⇄ask.js cycle.
  const { renderChat, setGenerating } = await import('./chat.js');
  const rerender = async () => { saveTabs(); renderChat(); };
  const now = Date.now();
  // Name the scope in the "searching…" bubble: folders by path, docs/archives by full
  // name, each doc with its KIND icon (📺 for a YouTube video, 📄 for a paper, …).
  const nameLines = [
    ...folders.map((f) => `📁 ${f}/`),
    ...(fullReadIds ? fullReadIds.map((d) => srcLinkMd(`${mentionDocIcon(d)} ${mentionDocName(d)}`, { docId: d })) : []),
    ...(fullReadArchives ? fullReadArchives.map((a) => srcLinkMd(`💬 ${mentionArchiveName(a)}`, { archive: a })) : []),
  ];
  const scopedNames = nameLines.length ? "\n\n" + nameLines.join("\n\n") : "";
  // Label reflects WHAT we're doing: full-reading a saved conversation (#archive) or a
  // document (@doc) reads the whole thing, not the library-retrieval "searching" path.
  let label = t("lib_searching");
  if (fullReadArchives && !fullReadIds) label = t("lib_readingArchive");
  else if (fullReadIds) label = t("lib_readingDoc");   // docs (or docs + archives)
  // `searching:true` makes renderMessage animate this bubble (pulsing) while we wait.
  const amsg = { id: genId(), role: "assistant", content: label + scopedNames, searching: true, timestamp: now + 1 };
  if (insertAt == null) {
    const toks = [...folders.map((f) => `@${f}/`), ...docIds.map((d) => `@${d}`), ...archives.map((a) => `#${a}`)];
    if (askOptTopK) toks.push(`-n ${askOptTopK}`);   // keep flags in the bubble so a
    if (askShort) toks.push("-s");                   // resend re-parses them intact
    const mentionStr = toks.length ? toks.join(" ") + " " : "";
    tab.messages.push({ id: genId(), role: "user", content: `/ask ${mentionStr}${query}`, timestamp: now });
    tab.messages.push(amsg);
  } else {
    tab.messages.splice(insertAt, 0, amsg);   // user "/ask …" bubble already sits at insertAt-1
  }
  // Wire into the chat send/stop button: while the ask runs, the button reads "stop"
  // and the form-submit handler aborts this controller (state.currentAbortController).
  const abort = new AbortController();
  state.currentAbortController = abort;
  setGenerating(true);
  await rerender();
  const started = Date.now();   // run-time clock → shown as "⏱ 用时 …" on the answer bubble
  let streamed = false;
  // "/ask @doc" / "/ask #archive" with no question → default to a summary request
  // (full-read only; retrieval needs a real question to embed). The user bubble
  // keeps what was typed; only the query sent to the model is substituted.
  const effQuery = (!query && (fullReadIds || fullReadArchives)) ? askL().summarize : query;
  try {
    let last = 0;
    const { answer, hits, truncated } = await runLibraryQuery(effQuery, {
      docIds: fullReadIds,
      archives: fullReadArchives,
      folders,
      topK: askOptTopK,
      short: askShort,
      // Default (full) mode picks docs via retrieval first — show the picked list
      // in the pulsing bubble while the model reads them and starts answering.
      onPicked: (ids) => {
        amsg.content = t("lib_readingDoc") + "\n\n" +
          ids.map((d) => srcLinkMd(`${mentionDocIcon(d)} ${mentionDocName(d)}`, { docId: d })).join("\n\n");
        rerender();
      },
      signal: abort.signal,
      onToken: (acc) => {
        streamed = true;
        amsg.searching = false;   // first token in → stop the animation
        amsg.content = acc;
        const now2 = Date.now();
        if (now2 - last > 120) { last = now2; rerender(); }   // throttle full re-render
      },
    });
    amsg.searching = false;       // also covers the no-token (no-results) path
    amsg.content = answer + sourcesMarkdown(hits)
      + (truncated ? `\n\n${t("lib_truncatedNote")}` : "");
  } catch (e) {
    amsg.searching = false;
    if (e && e.name === "AbortError") {
      // User hit "stop": keep whatever streamed so far, mark it interrupted.
      amsg.content = (streamed && amsg.content ? amsg.content + "\n\n" : "") + t("lib_askStopped");
    } else {
      amsg.content = t("lib_askFailed") + e.message;
    }
  } finally {
    // Record how long the ask ran (success, stop, or error) — renderMessage shows it as
    // "⏱ 用时 …" next to the bubble's timestamp, same as normal assistant replies.
    amsg.genMs = Date.now() - started;
    // Only clear if still ours — a newer generation may have taken over the button.
    if (state.currentAbortController === abort) setGenerating(false);
  }
  await rerender();
}

// ======================================================================
// Auto mode (/ask -a) — agentic auto-retrieval. The model plans its own search
// keywords, searches the library over one or more rounds, reads what it finds, and
// answers. Context-safe: if the matched docs fit num_ctx they're read in one shot
// (fast path); if not, each is read alone into a compact note and the answer is
// synthesized from the notes (slow / map-reduce path). See docs/plans/auto-ask.md.
// ======================================================================

const AUTO_ROUNDS = 3;    // max planning rounds (loop-until-dry)
const AUTO_MAXDOCS = 12;  // hard cap on docs read per run

// Prompt fragments, per PROMPT-LANGUAGE setting (like ASK_I18N). Functions take
// interpolation args. Kept terse; the model does the work.
const AUTO_PROMPTS = {
  zh: {
    planSys: '你是知识库检索规划助手。根据用户任务，生成 1-5 个用于向量检索的简短查询（关键词或短语，覆盖任务的不同方面）。若任务涉及具体命名实体（人名、机构、方法/模型名、数据集、地点等），把它们列进 entities 做精确查找（没有就空数组）。再判断这是否是需要跨多篇文档对比的任务；若是且用户未给出对比维度，提出 2-6 个对比维度。只输出 JSON，不要任何解释或代码块：{"queries":["…"],"entities":["…"],"isCompare":true或false,"dims":["…"]}',
    planMoreSys: '你是知识库检索规划助手。下面是已从知识库读到的文档笔记。判断现有信息是否足以回答任务：足够则 done 置 true；不够则给出 1-3 个补充检索查询以覆盖缺失的方面。只输出 JSON：{"done":true或false,"queries":["…"]}',
    readSys: '阅读下面这篇文档，抽取与任务最相关的要点，用简洁的要点列表（每行以 - 开头）输出，忽略无关内容。',
    readSchemaSys: (dims) => `阅读下面这篇文档，针对以下每个维度用一两句话总结该文档的情况。维度：${dims}。用 markdown 输出，每个维度一行，格式「**维度名**：内容」。`,
    synthFull: '你是知识库助手。下面是检索到并通读的多篇文档全文，请据此完成任务（如总结、生成表格）。',
    synthFullCompare: (dims) => `你是知识库助手。下面是检索到的多篇文档全文。请就任务对这些文档进行跨文档对比，按维度（${dims}）组织成一个 markdown 对比表格（列＝维度，行＝文档），并在表格后给出简要差异分析。`,
    synthNotes: '你是知识库助手。下面是从多篇文档中提取的笔记，请据此完成任务，并注明结论来自哪篇（用文档标题）。',
    synthNotesCompare: (dims) => `你是知识库助手。下面是从多篇文档中按维度提取的笔记。请生成一个 markdown 对比表格（列＝维度：${dims}，行＝各文档标题），并在表格后给出差异分析。`,
    taskLabel: '任务：', docLabel: (t) => `文档标题：${t}\n\n正文：\n`, notesLabel: '已读文档笔记：\n', fullLabel: '文档全文：\n',
  },
  'zh-Hant': {
    planSys: '你是知識庫檢索規劃助手。根據用戶任務，生成 1-5 個用於向量檢索的簡短查詢（關鍵詞或短語，覆蓋任務的不同方面）。若任務涉及具體命名實體（人名、機構、方法/模型名、資料集、地點等），把它們列進 entities 做精確查找（沒有就空陣列）。再判斷這是否是需要跨多篇文件對比的任務；若是且用戶未給出對比維度，提出 2-6 個對比維度。只輸出 JSON，不要任何解釋或代碼塊：{"queries":["…"],"entities":["…"],"isCompare":true或false,"dims":["…"]}',
    planMoreSys: '你是知識庫檢索規劃助手。下面是已從知識庫讀到的文件筆記。判斷現有資訊是否足以回答任務：足夠則 done 置 true；不夠則給出 1-3 個補充檢索查詢以覆蓋缺失的方面。只輸出 JSON：{"done":true或false,"queries":["…"]}',
    readSys: '閱讀下面這篇文件，抽取與任務最相關的要點，用簡潔的要點列表（每行以 - 開頭）輸出，忽略無關內容。',
    readSchemaSys: (dims) => `閱讀下面這篇文件，針對以下每個維度用一兩句話總結該文件的情況。維度：${dims}。用 markdown 輸出，每個維度一行，格式「**維度名**：內容」。`,
    synthFull: '你是知識庫助手。下面是檢索到並通讀的多篇文件全文，請據此完成任務（如總結、生成表格）。',
    synthFullCompare: (dims) => `你是知識庫助手。下面是檢索到的多篇文件全文。請就任務對這些文件進行跨文件對比，按維度（${dims}）組織成一個 markdown 對比表格（列＝維度，行＝文件），並在表格後給出簡要差異分析。`,
    synthNotes: '你是知識庫助手。下面是從多篇文件中提取的筆記，請據此完成任務，並註明結論來自哪篇（用文件標題）。',
    synthNotesCompare: (dims) => `你是知識庫助手。下面是從多篇文件中按維度提取的筆記。請生成一個 markdown 對比表格（列＝維度：${dims}，行＝各文件標題），並在表格後給出差異分析。`,
    taskLabel: '任務：', docLabel: (t) => `文件標題：${t}\n\n正文：\n`, notesLabel: '已讀文件筆記：\n', fullLabel: '文件全文：\n',
  },
  en: {
    planSys: 'You are a knowledge-library retrieval planner. From the user\'s task, produce 1-5 short vector-search queries (keywords/phrases covering different facets). If the task involves specific named entities (people, orgs, method/model names, datasets, places), list them in `entities` for exact lookup (empty array if none). Also judge whether this is a task that compares MULTIPLE documents; if so and the user gave no comparison dimensions, propose 2-6 dimensions. Output ONLY JSON, no prose or code fences: {"queries":["…"],"entities":["…"],"isCompare":true or false,"dims":["…"]}',
    planMoreSys: 'You are a knowledge-library retrieval planner. Below are notes already read from the library. Decide whether the info suffices to answer the task: set done=true if so; otherwise give 1-3 additional search queries covering the missing facets. Output ONLY JSON: {"done":true or false,"queries":["…"]}',
    readSys: 'Read the document below and extract the points most relevant to the task as a concise bullet list (each line starting with -), ignoring irrelevant content.',
    readSchemaSys: (dims) => `Read the document below and summarize it against EACH of these dimensions in a sentence or two. Dimensions: ${dims}. Output markdown, one line per dimension as "**dimension**: …".`,
    synthFull: 'You are a knowledge-library assistant. Below is the full text of several retrieved documents; use it to carry out the task (summarize, build a table, …).',
    synthFullCompare: (dims) => `You are a knowledge-library assistant. Below is the full text of several retrieved documents. Compare them across the task, organized as a markdown comparison table (columns = dimensions: ${dims}, rows = documents), followed by a brief difference analysis.`,
    synthNotes: 'You are a knowledge-library assistant. Below are notes extracted from several documents; use them to carry out the task and attribute conclusions to the document (by title) they came from.',
    synthNotesCompare: (dims) => `You are a knowledge-library assistant. Below are per-dimension notes from several documents. Produce a markdown comparison table (columns = dimensions: ${dims}, rows = document titles), followed by a difference analysis.`,
    taskLabel: 'Task: ', docLabel: (t) => `Document title: ${t}\n\nBody:\n`, notesLabel: 'Notes read so far:\n', fullLabel: 'Full text:\n',
  },
};
const autoL = () => AUTO_PROMPTS[getPromptLanguage()] || AUTO_PROMPTS.en;

// Lenient JSON extraction for the planner's output: pull the first {...}, strip a
// trailing comma, JSON.parse. Auto-mode planning JSON has no LaTeX so this is far
// simpler than the server's parseJsonLoose.
function lightParseJson(s) {
  const m = String(s || "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { /* try repair */ }
  try { return JSON.parse(m[0].replace(/,\s*([}\]])/g, "$1")); } catch { return null; }
}

// One /api/chat turn, accumulating the streamed reply into a string. Reused for the
// planning / per-doc read / synthesis calls. onToken(acc) streams the synthesis; the
// others omit it and just await the full text. Mirrors runLibraryQuery's error and
// stream handling (429 body surfaced, inline {"error"} line surfaced).
async function chatOnce(messages, { signal = null, onToken = null, temperature = 0.3 } = {}) {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: dom.modelSelect.value, messages, stream: true, options: { temperature, num_ctx: getNumCtx() } }),
    signal,
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const j = JSON.parse(await res.text()); msg = cleanErrorMessage(j.error ?? j) || msg; } catch { /* keep status */ }
    throw new Error(msg);
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "", out = "", streamErr = null;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const m = JSON.parse(line);
        if (m.error && !out) streamErr = cleanErrorMessage(m.error);
        const tok = (m.message && m.message.content) || "";
        if (tok) { out += tok; if (onToken) onToken(out); }
      } catch { /* ignore partial / non-JSON lines */ }
    }
  }
  if (!out && streamErr) throw new Error(streamErr);
  return out;
}

// Run each query through /api/library/retrieve and union the hit docIds (first-seen
// order, best score first within a query), skipping anything already in `seen` or in
// this batch. Returns [{docId,title,docKind}]. Folder-scoped when folders given.
async function retrieveUnion(queries, { folders = [], seen = new Set(), signal = null, entities = [] } = {}) {
  const out = [], batch = new Set();
  // Entity path FIRST: exact inverted-index lookup for the planner's named entities —
  // the precise complement to embedding search ("which docs mention X"). These are
  // high-confidence hits, so they lead the union.
  if (entities && entities.length) {
    try {
      const r = await postJson("/api/library/entity-lookup", { names: entities, folders }, signal);
      for (const d of (r.docs || [])) {
        if (!d.docId || seen.has(d.docId) || batch.has(d.docId)) continue;
        batch.add(d.docId);
        out.push({ docId: d.docId, title: d.title, docKind: d.docKind });
      }
    } catch (e) { if (e && e.name === "AbortError") throw e; /* entity path is additive */ }
  }
  for (const q of queries) {
    let r;
    try {
      r = await postJson("/api/library/retrieve", {
        query: q, model: embedModel(),
        folder: folders[0] || null, folders,
        topK: askTopK(), attachImages: false,
        rerank: dom.libraryRerankToggle && dom.libraryRerankToggle.checked ? dom.modelSelect.value : "",
        language: getPromptLanguage(),
      }, signal);
    } catch (e) { if (e && e.name === "AbortError") throw e; continue; }
    for (const h of (r.hits || [])) {
      if (!h.docId || seen.has(h.docId) || batch.has(h.docId)) continue;
      batch.add(h.docId);
      out.push({ docId: h.docId, title: h.title, docKind: h.docKind });
    }
  }
  return out;
}

// ② Relation-hop expansion: given the docs already read, ask the server for docs that are
// STRUCTURALLY related (one relation hop away in the cross-doc graph — e.g. docs about a
// read paper's authors/institution). The structural complement to embedding search; gives
// the auto loop direction that keyword re-planning can't. Best-effort, additive.
async function expandRelations(docIds, folders = [], signal = null) {
  try { const r = await postJson("/api/library/expand", { docIds, folders }, signal); return (r && r.docs) || []; }
  catch (e) { if (e && e.name === "AbortError") throw e; return []; }
}

// ③ Relation direct-answer: the relation triples in the library that involve entities named
// in the query (alias-folded), as a compact fact block to PREPEND to the answer's system
// prompt — so "谁发表了X" / "X和Y什么关系" are answered from the graph, not just prose.
// Returns "" when the query names no known entity. Best-effort.
async function relationFactsBlock(query, folders = [], signal = null) {
  try {
    const r = await postJson("/api/library/relations", { query, folders }, signal);
    if (!r || !r.relations || !r.relations.length) return "";
    const lines = r.relations.map((rel) => `- ${rel.head} —${rel.rel}→ ${rel.tail}${rel.time ? `（${rel.time}）` : ""}`);
    return t("auto_relFactsHeader") + "\n" + lines.join("\n") + "\n\n";
  } catch (e) { if (e && e.name === "AbortError") throw e; return ""; }
}

// Planner call. round 1: returns {queries, isCompare, dims}. Later rounds (with
// accumulated notes): returns {done, queries}. Any failure → a safe fallback so the
// run degrades to a single-round plain retrieval instead of erroring out.
async function planQueries(task, { notes = [], round = 1, signal = null } = {}) {
  const L = autoL();
  let messages;
  if (round === 1 || !notes.length) {
    messages = [{ role: "system", content: L.planSys }, { role: "user", content: L.taskLabel + task }];
  } else {
    const notesText = notes.map((n) => `【${n.title}】\n${n.note}`).join("\n\n");
    messages = [{ role: "system", content: L.planMoreSys }, { role: "user", content: L.taskLabel + task + "\n\n" + L.notesLabel + notesText }];
  }
  let j = null;
  try { j = lightParseJson(await chatOnce(messages, { signal, temperature: 0.2 })); }
  catch (e) { if (e && e.name === "AbortError") throw e; }
  if (!j) return round === 1 ? { queries: [task], entities: [], isCompare: false, dims: null } : { done: true, queries: [], entities: [] };
  const queries = Array.isArray(j.queries) ? j.queries.filter((q) => typeof q === "string" && q.trim()).slice(0, 5) : [];
  const dims = Array.isArray(j.dims) ? j.dims.filter((d) => typeof d === "string" && d.trim()).slice(0, 8) : null;
  const entities = Array.isArray(j.entities) ? j.entities.filter((e) => typeof e === "string" && e.trim()).slice(0, 8) : [];
  return { queries: queries.length ? queries : (round === 1 ? [task] : []), entities, isCompare: !!j.isCompare, dims, done: !!j.done };
}

// Fetch ONE doc's full body text (reusing fullDocsContext, which skips conversation
// blocks + video images and truncates to the budget). → {title, docKind, text, truncated}.
async function fetchDocText(docId, budget, signal) {
  const r = await fullDocsContext([docId], budget, signal, 0);
  const meta = (r.docs && r.docs[0]) || { title: docId, docKind: "doc" };
  return { docId, title: meta.title, docKind: meta.docKind, text: r.text, truncated: r.truncated };
}

// Read ONE doc into a compact note (map-reduce map step). Schema-first when dims given
// (aligned per-dimension note for comparison); free-form bullets otherwise.
async function readDocNote(task, doc, dims, signal) {
  const L = autoL();
  const sys = dims && dims.length ? L.readSchemaSys(dims.join(" / ")) + "\n\n" + L.taskLabel + task
                                   : L.readSys + "\n\n" + L.taskLabel + task;
  const user = L.docLabel(doc.title) + doc.text;
  return chatOnce([{ role: "system", content: sys }, { role: "user", content: user }], { signal, temperature: 0.2 });
}

// The collapsible retrieval-notes sub-bubble (markdown <details>). Each note header is
// a clickable #libsrc link to its doc; the body is the note's markdown.
function notesDetails(notes) {
  if (!notes || !notes.length) return "";
  const body = notes.map((n) =>
    `${srcLinkMd(`${kindIcon(n.docKind)} ${n.title}`, { docId: n.docId })}\n\n${n.note}`
  ).join("\n\n");
  return `\n\n<details>\n<summary>${t("auto_notesHeader", { n: notes.length })}</summary>\n\n${body}\n\n</details>`;
}


// Orchestrator for "/ask -a …". Same bubble/abort/setGenerating plumbing as
// handleAskCommand. scope may carry { folders, dims }. insertAt like handleAskCommand.
export async function handleAutoAsk(task, tab, scope = {}, insertAt = null) {
  const folders = (scope && scope.folders) || [];
  const explicitDims = (scope && scope.dims && scope.dims.length) ? scope.dims : null;
  const { renderChat, setGenerating } = await import('./chat.js');
  const rerender = async () => { saveTabs(); renderChat(); };
  const now = Date.now();
  const amsg = { id: genId(), role: "assistant", content: t("auto_planning", { round: 1 }), searching: true, timestamp: now + 1 };
  if (insertAt == null) {
    const toks = ["-a", ...folders.map((f) => `@${f}/`)];
    if (explicitDims) toks.push(`--dims "${explicitDims.join(", ")}"`);
    tab.messages.push({ id: genId(), role: "user", content: `/ask ${toks.join(" ")} ${task}`, timestamp: now });
    tab.messages.push(amsg);
  } else {
    tab.messages.splice(insertAt, 0, amsg);
  }
  const abort = new AbortController();
  state.currentAbortController = abort;
  setGenerating(true);
  await rerender();
  const started = Date.now();
  let streamed = false;
  const signal = abort.signal;
  // Live process trace: `log` = persisted step lines (queries, dims, docs found —
  // shown live AND kept as the final "search process" collapsible); `status` = the
  // transient current-activity line (reading X / synthesizing). The bubble shows both.
  const log = [];
  let status = "";
  const showTrace = () => { amsg.content = [log.join("\n\n"), status].filter(Boolean).join("\n\n"); rerender(); };
  const addLog = (line) => { log.push(line); status = ""; showTrace(); };
  const setStatus = (s) => { status = s; showTrace(); };
  let lastPaint = 0;
  const paint = () => { const n = Date.now(); if (n - lastPaint > 120) { lastPaint = n; rerender(); } };
  try {
    let dims = explicitDims, wantCompare = !!explicitDims, dimsDecided = !!explicitDims;
    const seen = new Set(), notes = [], docMeta = [];
    let truncatedAny = false;
    const budget = Math.max(2000, getNumCtx() - 8192);   // synth/read token budget
    if (explicitDims) addLog(t("auto_dims", { dims: explicitDims.join(" / ") }));
    // ③ relation facts about entities named in the task — prepended to synthesis (both
    // paths). "" when the task names no known entity. Fetched once up front.
    const relFacts = await relationFactsBlock(task, folders, signal);

    // ---- GATHER: plan → retrieve → read, looping until done / dry / caps ----
    for (let round = 1; round <= AUTO_ROUNDS && seen.size < AUTO_MAXDOCS; round++) {
      setStatus(t("auto_planning", { round }));
      const plan = await planQueries(task, { notes, round, signal });
      if (round === 1 && !dimsDecided) {
        wantCompare = plan.isCompare;
        if (wantCompare && plan.dims && plan.dims.length) dims = plan.dims;
        dimsDecided = true;
        if (dims && dims.length) addLog(t("auto_dims", { dims: dims.join(" / ") }));
      }
      if (plan.done && round > 1) break;
      const queries = plan.queries && plan.queries.length ? plan.queries : [task];
      const planEntities = plan.entities || [];
      // Show the ACTUAL queries the model chose (backticked so they read as terms).
      addLog(t("auto_traceRound", { round }) + queries.map((q) => "`" + q + "`").join(" / "));
      if (planEntities.length) addLog(t("auto_traceEntities") + planEntities.map((e) => "`" + e + "`").join(" / "));
      setStatus(t("auto_searching", { n: queries.length }));
      let fresh = await retrieveUnion(queries, { folders, seen, signal, entities: planEntities });
      // ② Relation-hop expansion (once we've read something): pull docs structurally
      // linked to what we've read — neighbors in the relation graph, which embedding /
      // keyword search would miss. Additive; dedup against seen + this round's fresh.
      if (seen.size) {
        const relDocs = await expandRelations([...seen], folders, signal);
        const relFresh = relDocs.filter((d) => !seen.has(d.docId) && !fresh.some((f) => f.docId === d.docId));
        if (relFresh.length) {
          addLog(t("auto_relExpand", { n: relFresh.length }) + "\n" +
            relFresh.map((d) => `* ${srcLinkMd(`${kindIcon(d.docKind)} ${d.title}`, { docId: d.docId })}${d.via && d.via.length ? ` — 🔗 ${d.via.join("、")}` : ""}`).join("\n"));
          fresh = fresh.concat(relFresh);
        }
      }
      if (!fresh.length) { addLog(t("auto_traceDry")); break; }   // dry
      const take = fresh.slice(0, AUTO_MAXDOCS - seen.size);
      // Show which docs surfaced, one per bullet line, each a clickable library link.
      addLog(t("auto_traceFound", { n: take.length }) + "\n" +
        take.map((d) => `* ${srcLinkMd(`${kindIcon(d.docKind)} ${d.title}`, { docId: d.docId })}`).join("\n"));

      // FAST PATH (round 1 only): if all fresh docs fit the window and it's not a
      // comparison, read them together in one call — cheapest, most faithful, and
      // avoids per-doc notes entirely.
      if (round === 1 && !wantCompare) {
        const full = await fullDocsContext(take.map((d) => d.docId), askFullBudget(), signal, 0);
        if (full.text && estimateTokens(full.text) <= budget) {
          // Promote the live trace to the top "search process" block; body streams answer.
          amsg.autoProcess = log.join("\n\n");
          amsg.content = t("auto_synth");
          rerender();
          const L = autoL();
          const sys = relFacts + L.synthFull + "\n\n" + L.fullLabel + full.text;
          const answer = await chatOnce([{ role: "system", content: sys }, { role: "user", content: L.taskLabel + task }],
            { signal, temperature: 0.3, onToken: (acc) => { streamed = true; amsg.searching = false; amsg.content = acc; paint(); } });
          amsg.searching = false;
          amsg.content = (answer || t("lib_noAnswer")) + sourcesMarkdown(full.docs) + (full.truncated ? `\n\n${t("lib_truncatedNote")}` : "");
          return;   // done — finally block still runs (paints via rerender)
        }
      }

      // SLOW PATH: read each fresh doc alone into a compact note (map-reduce).
      // Capture the prior-rounds count ONCE — `seen` grows inside the loop (seen.add
      // below), so reading seen.size per-iteration would double-count (17/12 bug).
      const doneBefore = seen.size;
      const total = Math.min(AUTO_MAXDOCS, doneBefore + take.length);
      let i = 0;
      for (const d of take) {
        i++;
        setStatus(t("auto_traceReading", { i: doneBefore + i, n: total, title: d.title }));
        seen.add(d.docId);
        let info;
        try { info = await fetchDocText(d.docId, askFullBudget(), signal); }   // per-doc read budget (chars), reuses the ⚙/auto budget
        catch (e) { if (e && e.name === "AbortError") throw e; continue; }
        if (!info.text) continue;
        truncatedAny = truncatedAny || info.truncated;
        const note = await readDocNote(task, info, dims, signal);
        if (!note.trim()) continue;
        notes.push({ docId: d.docId, title: info.title, docKind: info.docKind, note: note.trim() });
        docMeta.push({ docId: d.docId, title: info.title, docKind: info.docKind });
      }
    }

    if (!notes.length) { amsg.searching = false; amsg.content = t("lib_noResults"); return; }

    // ---- SYNTHESIZE from the accumulated notes ----
    // Promote the live trace to the top "search process" block; body streams the answer.
    amsg.autoProcess = log.join("\n\n");
    amsg.content = t("auto_synth");
    rerender();
    const L = autoL();
    const notesText = notes.map((n) => `【${n.title}】\n${n.note}`).join("\n\n");
    const sys = relFacts + (wantCompare && dims && dims.length ? L.synthNotesCompare(dims.join(" / ")) : L.synthNotes)
      + "\n\n" + L.notesLabel + notesText;
    const answer = await chatOnce([{ role: "system", content: sys }, { role: "user", content: L.taskLabel + task }],
      { signal, temperature: 0.3, onToken: (acc) => { streamed = true; amsg.searching = false; amsg.content = acc; paint(); } });
    amsg.searching = false;
    amsg.content = (answer || t("lib_noAnswer")) + notesDetails(notes) + sourcesMarkdown(docMeta)
      + (truncatedAny ? `\n\n${t("lib_truncatedNote")}` : "");
  } catch (e) {
    amsg.searching = false;
    // Keep the streamed partial answer if any; the process trace lives in autoProcess
    // (set in `finally`) so it survives even an abort during the gather phase.
    const kept = streamed && amsg.content ? amsg.content + "\n\n" : "";
    amsg.content = kept + (e && e.name === "AbortError" ? t("lib_askStopped") : t("lib_askFailed") + e.message);
  } finally {
    // Backstop: ensure the search-process trace is captured at the top even on the
    // no-results / abort-during-gather paths (the synth paths already set it).
    if (log.length && !amsg.autoProcess) amsg.autoProcess = log.join("\n\n");
    amsg.genMs = Date.now() - started;
    if (state.currentAbortController === abort) setGenerating(false);
    await rerender();   // in finally so the fast-path `return` still paints the result
  }
}

// Wire the ⚙ /ask-params modal (gear next to the embedding-model select) and the
// delegated #libsrc source-link clicks. Called once from main.js on startup.
export function initAsk() {
  // ---- /ask ⚙ parameters modal ----
  const askParamsModal = dom.libraryAskParamsModal;
  const onAskParamsKey = (e) => { if (e.key === "Escape") { e.preventDefault(); closeAskParams(); } };
  function closeAskParams() {
    if (askParamsModal) askParamsModal.hidden = true;
    document.removeEventListener("keydown", onAskParamsKey);
  }
  dom.libraryAskParamsBtn?.addEventListener("click", () => {
    if (!askParamsModal) return;
    // Placeholder shows what "empty = auto" resolves to right now (tracks num_ctx).
    if (dom.libraryAskBudget) dom.libraryAskBudget.placeholder = String(autoFullBudget());
    askParamsModal.hidden = false;
    document.addEventListener("keydown", onAskParamsKey);
  });
  dom.libraryAskParamsClose?.addEventListener("click", closeAskParams);
  for (const el of [dom.libraryAskTopK, dom.libraryAskImages, dom.libraryAskBudget]) {
    el?.addEventListener("change", () => saveCurrentSettings());
  }

  // ---- chat-side /ask source links (#libsrc=…) → jump to the doc block / archive ----
  document.addEventListener("click", (e) => {
    const a = e.target.closest && e.target.closest('a[href^="#libsrc="]');
    if (!a) return;
    e.preventDefault();
    let ref;
    try { ref = JSON.parse(decodeURIComponent(a.getAttribute("href").slice("#libsrc=".length))); } catch { return; }
    if (ref.a) openArchivedChat(ref.a);
    else if (ref.d) openLibrarySource({ docId: ref.d, blockId: ref.b });
  });
}
