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
  },
  "zh-Hant": {
    sysFullA: "你是知識庫助手。下面是用戶指定的文檔/對話全文",
    sysFullTrunc: "（內容較長，已截斷部分）",
    sysFullB: "，請通讀全文後完成用戶的要求（如理解、總結、生成表格等）。\n\n全文：\n",
    sysRag: "你是知識庫助手。請僅依據下列資料片段回答問題，並用 [n] 標註引用來源；若資料中找不到依據，請直接說明未找到。\n\n資料片段：\n",
    sysRagMore: "另外，以下是從知識庫限定資料夾檢索到的相關片段，可與上文全文互為補充；引用片段時用 [n] 標註來源。\n\n資料片段：\n",
    roleUser: "用戶", roleAssistant: "助手",
    summarize: "請通讀全文，總結主要內容和要點。",
  },
  en: {
    sysFullA: "You are a knowledge-library assistant. Below is the full text of the document(s)/conversation(s) the user selected",
    sysFullTrunc: " (long content, partially truncated)",
    sysFullB: ". Read it all, then carry out the user's request (understand, summarize, build a table, …).\n\nFull text:\n",
    sysRag: "You are a knowledge-library assistant. Answer ONLY from the source snippets below, citing them as [n]; if the snippets don't support an answer, say so plainly.\n\nSource snippets:\n",
    sysRagMore: "Additionally, the snippets below were retrieved from the scoped library folder(s); use them alongside the full text above, citing them as [n].\n\nSource snippets:\n",
    roleUser: "User", roleAssistant: "Assistant",
    summarize: "Read the full text and summarize its main content and key points.",
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
      const context = r.hits.map((h, i) => `[${offset + i + 1}] (${h.title}${h.section ? " · " + h.section : ""}):\n${h.content}`).join("\n\n");
      sourceHits = [...sourceHits, ...r.hits];
      // Drop images that belong to a video doc (transcript screenshots — worthless
      // for Q&A and fatal to text-only chat models). Same rule as the full-read path.
      const videoDocs = new Set(r.hits.filter((h) => h.docKind === "video").map((h) => h.docId));
      const okImages = (r.images || []).filter((im) => !videoDocs.has(im.docId));
      images = [...images, ...okImages].slice(0, askMaxImages());
      sysParts.push((sysParts.length ? askL().sysRagMore : askL().sysRag) + context);
    }
  }
  if (!sysParts.length) return { answer: t("lib_noResults"), hits: [], truncated };
  const sys = sysParts.join("\n\n");
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
  let topK = null, short = false;
  let m;
  // Leading tokens: @doc / @folder/ / #archive mentions, "-n K" (per-ask top-K
  // override, also "-nK"), "-s"/"--short" (answer from retrieved snippets only —
  // the DEFAULT is to read the docs behind the hits in full).
  while ((m = rest.match(/^(?:([@#])(\S+)|-n\s*(\d+)|(--short|-s))(\s+|$)/))) {
    const sig = m[1], tok = m[2];
    if (sig === "#") archives.push(tok);                     // "#archive" → scope to a conversation archive (read whole)
    else if (sig === "@") {
      if (tok.endsWith("/")) folders.push(tok.slice(0, -1));   // "@folder/" → scope to a sub-folder (+ nested)
      else docIds.push(tok);                                    // "@docId"   → scope to one doc (read whole)
    } else if (m[3]) topK = Math.min(50, Math.max(1, parseInt(m[3], 10)));
    else short = true;
    rest = rest.slice(m[0].length);
  }
  return { docIds, folders, archives, topK, short, query: rest.trim() };
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
