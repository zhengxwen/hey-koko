// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

// Knowledge Library (RAG) frontend: import docs (local files / URL / text) by
// reusing the existing parse + fetch pipelines, browse each doc as an editable
// bubble stream, semantic-search, and ask the whole library (panel box + the
// chat-side /ask command). Retrieval is server-side; generation reuses /api/chat.

import { dom, state } from './state.js';
import { escapeHtml, makePreview } from './utils.js';
import { markdownToHtml, renderMermaidDiagrams, highlightCodeBlocks } from './markdown.js';
import { saveTabs } from './settings.js';
import { createTab, switchTab } from './tabs.js';
import { t, getPromptLanguage } from './i18n.js';
import { setMentionDocs, mentionDocName, mentionArchiveName } from './mentions.js';
import { enqueueBgJob, openBgDrawer } from './bg-jobs.js';
import { youtubeFetch } from './server-queue.js';

const KIND_ICON = { paper: "📄", slides: "📊", blog: "🌐", video: "📺", doc: "📝", chat: "💬", other: "📎" };
const genId = () => `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const isYoutubeUrl = (u) => /youtube\.com|youtu\.be/.test(u || "");
// Set by initLibrary so the background import jobs can refresh the list / task count.
let _refreshLibraryList = null;
let _updateTaskCount = null;
let _openLibrary = null;

// Called by bg-jobs (via setBgDeps onJobsChanged) whenever the job list/status changes,
// so the library header shows how many imports are still queued/running.
export function notifyLibraryJobsChanged() { if (_updateTaskCount) _updateTaskCount(); }
// Open the library panel — used by bg-jobs to return here when a library import task
// (which has no chat bubble) is clicked in the task drawer.
export function openLibraryPanel() { if (_openLibrary) _openLibrary(); }
const embedModel = () => (dom.embedModelSelect?.value || "").trim() || "qwen3-embedding:0.6b";
const kindIcon = (k) => KIND_ICON[k] || "📎";
// Papers can have dozens of authors — show at most the first 3 in the list view.
function shortAuthors(authors) {
  if (!authors) return "";
  const list = authors.split(/[,，;；]/).map((s) => s.trim()).filter(Boolean);
  return list.length <= 3 ? list.join(", ") : list.slice(0, 3).join(", ") + " " + t("lib_etAl");
}

// parseDocumentHeadless is injected from main.js (reuses MinerU/Pandoc + pdf.js fallback).
let _parseDocumentHeadless = null;
export function setLibraryDeps({ parseDocumentHeadless }) {
  if (parseDocumentHeadless) _parseDocumentHeadless = parseDocumentHeadless;
}

function fileToB64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(",")[1] || "");
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

async function postJson(url, body, signal = null) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
    signal,
  });
  return res.json();
}

// Run ANY library import as a background job (see bg-jobs.js runLibImport). Dispatches on
// payload.type — 'file' (parse a doc: PDF/DOCX/… via _parseDocumentHeadless), 'text'
// (already-read .txt/.md), 'url' (fetch a webpage), 'youtube' (same server pipeline as
// chat /url: cover + whisper + subtitle formatting). Every branch produces {source,
// docKind, title, text, images}, then one shared save → enrich → list-refresh. Progress
// streams to the drawer via sink.label / the youtube SSE; throws so failures show an error.
export async function runLibraryImport(payload, sink) {
  const type = payload.type;
  let source, docKind, title, text, images = [];
  const folder = payload.folder || undefined;

  if (type === "youtube") {
    sink.label(t("bg_fetchingContent"));
    const r = await youtubeFetch(
      { url: payload.url, language: getPromptLanguage(), model: dom.modelSelect.value },
      { bgJob: sink.server.bgJob, conversationId: sink.server.conversationId, msgId: sink.server.msgId, label: sink.server.label, signal: sink.signal },
    );
    const data = await r.json();
    if (!r.ok || !data || data.error) throw new Error((data && data.error) || t("lib_fetchFailed", { error: "?" }));
    title = data.title || payload.url;
    // normalize YouTube's "20260701" → "2026-07-01" (same as the chat info card)
    const rawDate = String(data.uploadDate || "").replace(/-/g, "").slice(0, 8);
    const uploadDate = rawDate.length === 8 ? `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}` : "";
    // metadata folded onto ONE line so it can ride as the cover figure's caption
    const metaLine = [payload.url,
      data.channel ? `频道：${data.channel}` : "",
      data.duration ? `时长：${data.duration}` : "",
      uploadDate ? `日期：${uploadDate}` : ""].filter(Boolean).join("　·　");
    // First "bubble" = title-tagged cover figure (image + metadata caption). A cover is
    // optional; without one the metadata rides as a plain text line under the title.
    let infoLine = metaLine;
    if (data.thumbnail) {
      try {
        const dataUrl = await makePreview(data.thumbnail, 720);   // server returns a base64 data URL → no CORS taint
        const raw = (dataUrl.split(",")[1]) || "";
        if (raw) { images.push({ name: "image_01.jpg", base64: raw, mime: "image/jpeg" }); infoLine = `![](image_01.jpg) ${metaLine}`; }
      } catch { /* cover is optional */ }
    }
    source = `url:${payload.url}`; docKind = "video";
    // A heading between the cover and the transcript forces them into SEPARATE blocks
    // (§title = cover, §字幕整理 = transcript) → two bubbles, cover first, subs second.
    text = [`# ${title}`, "", infoLine, "", "# 字幕整理", "",
      (data.formattedText || data.rawTranscript || "")].join("\n");
  } else if (type === "url") {
    sink.label(t("bg_fetchingContent"));
    const data = await postJson("/api/fetch-url", { url: payload.url }, sink.signal);
    if (data.type === "error" || data.type === "unsupported" || !data.content) throw new Error(data.content || t("lib_fetchFailed", { error: "?" }));
    source = `url:${payload.url}`; docKind = "blog"; title = data.title || payload.url; text = data.content;
  } else if (type === "text") {
    source = `file:${payload.name}`; docKind = payload.docKind || "other"; title = payload.title; text = payload.text;
  } else if (type === "file") {
    sink.label(t("bg_parsing"));
    if (!_parseDocumentHeadless) throw new Error(t("lib_parserNotReady"));
    const parsed = await _parseDocumentHeadless(payload.fileB64, payload.name, payload.ext, "", (p) => { if (p) sink.label(p); });
    if (!parsed || !(parsed.text || "").trim()) throw new Error(t("lib_parseEmpty", { name: payload.name }));
    source = `file:${payload.name}`; docKind = payload.docKind || "other";
    title = payload.name.replace(/\.[^.]+$/, ""); text = parsed.text; images = parsed.images || [];
  } else {
    throw new Error("unknown import type");
  }

  sink.label(t("lib_importing"));
  const res = await postJson("/api/library/import", { source, docKind, folder, title, text, images, model: embedModel() }, sink.signal);
  if (res.error) throw new Error(res.error);
  // Enrich metadata (title/authors/year/tags) for docs/webpages; skip YouTube — it already
  // has an accurate title (the LLM would only risk overwriting it with transcript guesses).
  if (res.docId && type !== "youtube") { sink.label(t("lib_enriching", { name: title })); await enrichDoc(res.docId); }
  if (_refreshLibraryList) { try { await _refreshLibraryList(); } catch { /* panel maybe closed */ } }
}

// Shared by the panel ask-box and the chat /ask command: retrieve → generate.
// Streams the answer token-by-token through onToken(accumulatedText) if given;
// resolves to the final { answer, hits }. /api/chat returns ndjson (one JSON
// per line, {message:{content},done}) — same format chat.js consumes.
// For "/ask @doc …" (scoped): pull the WHOLE text of the chosen docs (document body
// only, skipping conversation bubbles) up to a char budget, plus a few figures. The
// model then reads the entire article(s) instead of a handful of retrieved snippets —
// so instructions like "帮我理解，生成表格" work on the full paper.
const FULL_DOC_BUDGET = 100000;   // ~25k tokens; needs the chat model's num_ctx to be large enough
async function fullDocsContext(docIds, budget = FULL_DOC_BUDGET, signal = null) {
  let text = "", truncated = false;
  const docs = [], images = [];
  for (const id of docIds) {
    if (text.length >= budget) { truncated = true; break; }
    let doc;
    try { const r = await postJson("/api/library/get", { docId: id }, signal); doc = r && r.doc; }
    catch (e) { if (e && e.name === "AbortError") throw e; /* else skip this doc */ }
    if (!doc) continue;
    docs.push({ docId: doc.docId, title: doc.title, docKind: doc.docKind });
    let body = `# ${doc.title}\n\n`, lastSec = null;
    for (const b of (doc.blocks || [])) {
      if (b.kind === "user" || b.kind === "reply" || b.kind === "note") continue;   // skip conversation
      if (b.kind === "figure") { if (images.length < 3 && b.image) images.push({ image: b.image }); continue; }
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
      body += `**${m.role === "user" ? "用户" : "助手"}**：${content}\n\n`;
    }
    if (text.length + body.length > budget) { body = body.slice(0, budget - text.length); truncated = true; }
    text += body;
  }
  return { text: text.trim(), truncated, sources };
}

async function runLibraryQuery(query, { docId = null, docIds = null, archives = null, folder = null, onToken = null, signal = null } = {}) {
  const scoped = !!((docIds && docIds.length) || (archives && archives.length));
  let sys, sourceHits, images;
  if (scoped) {
    // Scoped to specific docs / archives → READ THE WHOLE source(s), don't retrieve snippets.
    const full = await fullDocsContext(docIds || [], FULL_DOC_BUDGET, signal);
    const arch = await fullArchivesContext(archives || [], FULL_DOC_BUDGET, signal);
    const combined = [full.text, arch.text].filter(Boolean).join("\n\n---\n\n");
    if (!combined) return { answer: t("lib_noResults"), hits: [] };
    sourceHits = [...full.docs, ...arch.sources];
    images = full.images;
    const truncated = full.truncated || arch.truncated;
    sys = `你是知识库助手。下面是用户指定的文档/对话全文${truncated ? "（内容较长，已截断部分）" : ""}，请通读全文后完成用户的要求（如理解、总结、生成表格等）。\n\n全文：\n${combined}`;
  } else {
    // Whole-library → semantic retrieval of the most relevant chunks, cite [n].
    const r = await postJson("/api/library/retrieve", {
      query, model: embedModel(), docId, folder, topK: 6, attachImages: true, maxImages: 3,
    }, signal);
    if (!r.hits || !r.hits.length) return { answer: t("lib_noResults"), hits: [] };
    sourceHits = r.hits;
    images = r.images;
    const context = r.hits.map((h, i) => `[${i + 1}] (${h.title}${h.section ? " · " + h.section : ""}):\n${h.content}`).join("\n\n");
    sys = `你是知识库助手。请仅依据下列资料片段回答问题，并用 [n] 标注引用来源；若资料中找不到依据，请直接说明未找到。\n\n资料片段：\n${context}`;
  }
  const userMsg = { role: "user", content: query };
  if (images && images.length) userMsg.images = images.map((im) => im.image);

  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: dom.modelSelect.value,
      messages: [{ role: "system", content: sys }, userMsg],
      stream: true,
      options: { temperature: 0.3 },
    }),
    signal,
  });
  if (!res.ok || !res.body) return { answer: t("lib_noAnswer"), hits: sourceHits };

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "", answer = "";
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
        const tok = (m.message && m.message.content) || "";
        if (tok) { answer += tok; if (onToken) onToken(answer); }
      } catch { /* ignore partial / non-JSON lines */ }
    }
  }
  return { answer: answer || t("lib_noAnswer"), hits: sourceHits };
}

function sourcesMarkdown(hits) {
  if (!hits || !hits.length) return "";
  return `\n\n---\n**${t("lib_sources")}**\n` + hits.map((h, i) =>
    `${i + 1}. ${kindIcon(h.docKind)} ${h.title}${h.section ? " · " + h.section : ""}`).join("\n");
}

// Turn each library block into its OWN assistant chat bubble: text → content,
// figure → caption in content + image in generatedImages. Block metadata rides
// along (isLibraryBlock/libraryKind/librarySection) so the tab can be written
// back to the library later. Reuses normal-tab edit/delete/reorder as-is.
function docToBlockMessages(doc) {
  return (doc.blocks || []).map((b) => {
    const msg = { id: genId(), role: b.role || "assistant", content: b.content || "", timestamp: Date.now() };
    if (b.kind === "note") {
      // restore as a /note user bubble so it stays a (vectorized) note on write-back
      msg.role = "user";
      msg.content = `/note ${b.content || ""}`;
    } else if (b.kind === "user" || b.kind === "reply") {
      // plain conversation bubble — kept in the doc but not vectorized; role/content as-is
    } else {
      // original document chunk (text/figure/table) → re-marked for chunk write-back
      msg.isLibraryBlock = true;
      msg.libraryKind = b.kind || "text";
      if (b.section) msg.librarySection = b.section;
    }
    if (b.image) {
      msg.generatedImages = [b.image];
      msg.imageMime = b.imageMime || "image/png";
      if (b.imageName) msg.generatedImageNames = [b.imageName];   // original filename → download/lightbox
    }
    return msg;
  });
}

// A block is a "conversation/annotation" turn (question, reply, or /note),
// NOT part of the document body. These must never be flattened into the markdown
// editor or re-chunked — they carry a role and render as chat bubbles.
function isConversationBlock(b) {
  return b && (b.kind === "user" || b.kind === "reply" || b.kind === "note");
}

// Rebuild the full markdown of a doc (for the markdown editor) and collect its
// images so the edited markdown can be re-chunked server-side. ONLY the document
// body is rebuilt — conversation bubbles are excluded so editing/re-chunking the
// article never destroys the conversation (server re-appends it on reparse).
function docToMarkdown(doc) {
  let md = "", lastSec = null, ic = 0;
  const images = [];
  for (const b of (doc.blocks || [])) {
    if (isConversationBlock(b)) continue;   // keep Q&A/notes out of the markdown editor
    if (b.section && b.section !== lastSec) { md += `\n# ${b.section}\n\n`; lastSec = b.section; }
    if (b.kind === "figure") {
      ic++;
      const ext = (b.imageMime || "image/png").includes("jpeg") ? "jpg" : "png";
      const name = `image_${String(ic).padStart(2, "0")}.${ext}`;
      md += `![](${name})\n\n`;
      if (b.image) images.push({ name, base64: b.image, mime: b.imageMime || "image/png" });
    } else {
      md += (b.content || "") + "\n\n";
    }
  }
  return { md: md.trim(), images };
}

// Rebuild a library doc from a special tab's chunk bubbles (current bubble order
// = new block order; deleted bubbles drop out; edited content/images carry over)
// and save. Non-chunk bubbles (user questions, plain AI replies) are ignored.
export async function writeTabToLibrary(tab) {
  // ALL bubbles are written back (chunks + questions + replies + notes), preserving
  // role and order. Only original chunks (isLibraryBlock) and /note user bubbles are
  // vectorized (embed:true); plain conversation bubbles are stored but not retrievable.
  const blocks = tab.messages
    .filter((m) => (m.content && m.content.trim()) || (m.generatedImages && m.generatedImages.length))
    .map((m, i) => {
      const b = { id: `b${i}`, role: m.role, section: m.librarySection || "", content: m.content || "" };
      const addImg = () => { if (m.generatedImages && m.generatedImages[0]) { b.image = m.generatedImages[0]; b.imageMime = m.imageMime || "image/png"; if (m.generatedImageNames && m.generatedImageNames[0]) b.imageName = m.generatedImageNames[0]; } };
      if (m.isLibraryBlock) {
        b.kind = m.libraryKind || "text"; b.embed = true; addImg();
      } else if (m.role === "user" && /^\/note\s/.test(m.content || "")) {
        b.kind = "note"; b.embed = true;
        b.content = m.content.replace(/^\/note\s+/, "").trim();
      } else {
        b.kind = m.role === "user" ? "user" : "reply"; b.embed = false; addImg();
      }
      return b;
    });
  let meta = tab.libraryMeta || {};
  try { const r = await postJson("/api/library/get", { docId: tab.libraryDocId }); if (r && r.doc) meta = r.doc; } catch {}
  const doc = {
    type: "libdoc", schemaVersion: 1,
    docKind: meta.docKind || "doc", docId: tab.libraryDocId,
    source: meta.source || "", title: meta.title || tab.libraryDocId,
    authors: meta.authors || "", year: meta.year || "", tags: meta.tags || [],
    blocks,
  };
  return postJson("/api/library/save", { doc, model: embedModel() });
}

// Extract the first JSON object from loose LLM output (may be fenced/prefixed).
function parseJsonLoose(s) {
  const m = String(s).match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}
// Deterministic pastel color per tag name (no per-tag state needed).
function tagColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return `hsl(${h}, 55%, 82%)`;
}

// After import, ask the chat model to extract title/authors/year + topic tags
// from the doc's opening blocks, then save (blocks unchanged → 0 re-embed).
async function enrichDoc(docId) {
  try {
    const { doc } = await postJson("/api/library/get", { docId });
    if (!doc || !doc.blocks) return;
    const head = doc.blocks.slice(0, 6).map((b) => b.content).filter(Boolean).join("\n").slice(0, 2000);
    if (!head.trim()) return;
    const sys = "你是文献元数据抽取助手。根据文档开头内容，抽取标题、作者、发表年份，并生成 3-5 个简短主题标签。只输出 JSON，不要任何解释或代码块标记：{\"title\":\"...\",\"authors\":\"...\",\"year\":\"...\",\"tags\":[\"...\"]}。作者只保留人名、去掉机构编号和上标数字，多个作者用英文逗号分隔（如 \"N. Gharahdaghi, P.-J. Yeh, L. Ceron-Gutierrez\"）；年份只要 4 位数字，没有就空字符串；标签用简短名词短语。";
    const data = await postJson("/api/chat", {
      model: dom.modelSelect.value,
      messages: [{ role: "system", content: sys }, { role: "user", content: head }],
      stream: false, options: { temperature: 0.1 },
    });
    const j = parseJsonLoose((data.message && data.message.content) || "");
    if (!j) return;
    if (j.title && String(j.title).trim()) doc.title = String(j.title).trim();
    doc.authors = String(j.authors || "").trim();
    doc.year = String(j.year || "").trim();
    if (Array.isArray(j.tags)) {
      doc.tags = j.tags.filter(Boolean).slice(0, 6).map((name) => ({ name: String(name).trim(), color: tagColor(String(name)) }));
    }
    await postJson("/api/library/save", { doc, model: embedModel() });  // blocks unchanged → 0 re-embed
  } catch { /* enrichment is best-effort */ }
}

// ---- /ask command (chat-side): inserts Q + A(+sources) into the conversation ----
// "/ask [@doc | @folder/ | #archive …] question" → { docIds, folders, archives, query }
// (or null if not an /ask). Leading mentions (no spaces) scope the query: @docId reads
// a whole library doc, @folder/ scopes retrieval to a sub-folder, #archive reads a whole
// conversation archive. The rest is the question. No mentions → whole-library search.
export function parseAskCommand(content) {
  if (!/^\/ask(\s|$)/.test(content || "")) return null;
  let rest = content.replace(/^\/ask\s*/, "");
  const docIds = [], folders = [], archives = [];
  let m;
  while ((m = rest.match(/^([@#])(\S+)\s*/))) {
    const sig = m[1], tok = m[2];
    if (sig === "#") archives.push(tok);                     // "#archive" → scope to a conversation archive (read whole)
    else if (tok.endsWith("/")) folders.push(tok.slice(0, -1));   // "@folder/" → scope to a sub-folder (+ nested)
    else docIds.push(tok);                                    // "@docId"   → scope to one doc (read whole)
    rest = rest.slice(m[0].length);
  }
  return { docIds, folders, archives, query: rest.trim() };
}

// scope: { docIds:[], folders:[], archives:[] }. A folder mention (@folder/) scopes
// RETRIEVAL to that sub-folder (+ nested); doc mentions (@docId) READ the whole doc(s);
// archive mentions (#archive) READ the whole conversation archive(s). Folder wins over
// full-read if both are present (a folder can hold many docs, so full-read isn't apt).
// insertAt: null → fresh send (append the "/ask …" user bubble + answer at the end).
// A number → resend/edit: the user bubble already exists; insert the answer there.
export async function handleAskCommand(query, tab, scope = {}, insertAt = null) {
  const docIds = (scope && scope.docIds) || [];
  const folders = (scope && scope.folders) || [];
  const archives = (scope && scope.archives) || [];
  const folder = folders.length ? folders[0] : null;      // one sub-folder, retrieval-scoped
  const fullReadIds = (!folder && docIds.length) ? docIds : null;        // docs → read whole (only when no folder)
  const fullReadArchives = (!folder && archives.length) ? archives : null;  // archives → read whole (only when no folder)
  // Loaded up front (async) so the abort/button plumbing below is synchronous. Dynamic
  // import avoids a top-level chat.js⇄library.js cycle.
  const { renderChat, setGenerating } = await import('./chat.js');
  const rerender = async () => { saveTabs(); renderChat(); };
  const now = Date.now();
  // Name the scope in the "searching…" bubble: folders by path, docs/archives by full name.
  const nameLines = [
    ...folders.map((f) => `📁 ${f}/`),
    ...(fullReadIds ? fullReadIds.map((d) => `📄 ${mentionDocName(d)}`) : []),
    ...(fullReadArchives ? fullReadArchives.map((a) => `💬 ${mentionArchiveName(a)}`) : []),
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
  try {
    let last = 0;
    const { answer, hits } = await runLibraryQuery(query, {
      docIds: fullReadIds,
      archives: fullReadArchives,
      folder,
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
    amsg.content = answer + sourcesMarkdown(hits);
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

export function initLibrary() {
  const overlay = document.querySelector("#libraryOverlay");
  const openBtn = document.querySelector("#libraryBtn");
  const closeBtn = document.querySelector("#libraryCloseBtn");
  const listEl = document.querySelector("#libraryList");
  const searchEl = document.querySelector("#librarySearch");
  const tagBar = document.querySelector("#libraryTagBar");
  const preview = document.querySelector("#libraryPreview");
  const previewTitle = document.querySelector("#libraryPreviewTitle");
  const previewContent = document.querySelector("#libraryPreviewContent");
  const previewEmpty = document.querySelector("#libraryPreviewEmpty");
  const statusEl = document.querySelector("#libraryStatus");
  const deleteBtn = document.querySelector("#libraryDeleteBtn");
  const moveBtn = document.querySelector("#libraryMoveBtn");
  const askFolderSel = document.querySelector("#libraryAskFolder");
  const importBtn = document.querySelector("#libraryImportBtn");
  const importMenu = document.querySelector("#libraryImportMenu");
  const taskCountEl = document.querySelector("#libraryTaskCount");
  const importPaperItem = document.querySelector("#libraryImportPaper");
  const importFilesItem = document.querySelector("#libraryImportFiles");
  const importTextItem = document.querySelector("#libraryImportText");
  const importUrlItem = document.querySelector("#libraryImportUrl");
  const paperInput = document.querySelector("#libraryPaperInput");
  const fileInput = document.querySelector("#libraryFileInput");
  const textInput = document.querySelector("#libraryTextInput");
  const askInput = document.querySelector("#libraryAskInput");
  const askSend = document.querySelector("#libraryAskSend");
  const askScoped = document.querySelector("#libraryAskScoped");

  let docs = [];
  let selected = new Set();
  let scores = null;          // Map<docId, score> when a semantic search is active
  let activeTagFilter = null;
  let currentDoc = null;
  let allDirs = [""];         // every folder under the library (for move popup + ask scope)

  const setStatus = (s) => { statusEl.textContent = s || ""; };
  const updateSelectionUI = () => {
    deleteBtn.disabled = selected.size === 0;
    moveBtn.disabled = selected.size === 0;
  };

  // Reset the right pane to its empty state (on panel open, and after the shown doc is deleted).
  const clearPreview = () => {
    currentDoc = null;
    previewContent.innerHTML = "";
    previewTitle.textContent = "";
    preview.classList.remove("isOpen");
    previewEmpty.style.display = "";
    askScoped.checked = false;
    askScoped.disabled = true;
  };

  // ---- open / close ----
  function open() {
    overlay.classList.add("isOpen");
    clearPreview();   // reset right pane to empty state
    refreshList();
  }
  _openLibrary = open;
  openBtn.addEventListener("click", open);
  closeBtn.addEventListener("click", () => overlay.classList.remove("isOpen"));

  // ---- import menu ----
  importBtn.addEventListener("click", (e) => { e.stopPropagation(); importMenu.hidden = !importMenu.hidden; });
  document.addEventListener("click", (e) => { if (!importMenu.contains(e.target) && e.target !== importBtn) importMenu.hidden = true; });
  importPaperItem.addEventListener("click", () => { importMenu.hidden = true; paperInput.click(); });
  importFilesItem.addEventListener("click", () => { importMenu.hidden = true; fileInput.click(); });
  importTextItem.addEventListener("click", () => { importMenu.hidden = true; textInput.click(); });
  importUrlItem.addEventListener("click", () => { importMenu.hidden = true; importUrl(); });
  // "本地论文" → always docKind:paper, stored in the paper/ folder.
  paperInput.addEventListener("change", () => { importFiles([...paperInput.files], { folder: "paper", docKind: "paper" }); paperInput.value = ""; });
  fileInput.addEventListener("change", () => { importFiles([...fileInput.files]); fileInput.value = ""; });
  textInput.addEventListener("change", () => { importFiles([...textInput.files]); textInput.value = ""; });

  function docKindForExt(ext) {
    if (ext === ".pptx") return "slides";
    if (ext === ".pdf") return "paper";
    return "doc";
  }

  // opts.folder → store all these imports in that sub-folder (overrides auto-classify);
  // opts.docKind → force the doc kind (e.g. the "本地论文" importer forces "paper").
  async function importFiles(files, { folder = null, docKind = null } = {}) {
    if (!files.length) return;
    // Each file becomes its OWN background job (parse + import + enrich runs headless,
    // survives reload, shows in the task list). .txt/.md are read up front (no parser);
    // everything else rides as base64 so the bg runner can parse it later.
    for (const file of files) {
      const ext = "." + file.name.split(".").pop().toLowerCase();
      const dk = docKind || docKindForExt(ext);
      let payload;
      if (ext === ".txt" || ext === ".md" || ext === ".markdown") {
        payload = { type: "text", name: file.name, title: file.name.replace(/\.[^.]+$/, ""), text: await file.text(), folder, docKind: dk };
      } else {
        payload = { type: "file", name: file.name, ext, fileB64: await fileToB64(file), folder, docKind: dk };
      }
      enqueueBgJob({ tabId: state.activeTabId, kind: "libimport", label: file.name, payload, noPlaceholder: true });
    }
    setStatus(t("lib_importQueued"));
  }

  async function importUrl() {
    const url = prompt(t("lib_urlPrompt"));
    if (!url || !url.trim()) return;
    const u = url.trim();
    // Webpage OR YouTube → a background job (fetch/parse/whisper/format + import + enrich
    // run headless, shown in the task list). YouTube gets the full /url pipeline (cover +
    // whisper + subtitle formatting); other URLs just fetch the page text.
    enqueueBgJob({
      tabId: state.activeTabId, kind: "libimport",
      label: isYoutubeUrl(u) ? t("bg_fetchingContent") : u,
      payload: { type: isYoutubeUrl(u) ? "youtube" : "url", url: u },
      noPlaceholder: true,
    });
    setStatus(t("lib_importQueued"));
  }

  // ---- list ----
  async function refreshList() {
    try { const d = await postJson("/api/library/list", {}); docs = d.docs || []; }
    catch { docs = []; }
    setMentionDocs(docs);   // keep the /ask @mention list in sync with the library
    await refreshFolders();
    renderTagBar();
    renderList();
  }
  _refreshLibraryList = refreshList;   // let the bg import jobs refresh the list on finish

  // Header badge: how many library imports are still queued/running (drawer-only jobs).
  function updateTaskCount() {
    if (!taskCountEl) return;
    const n = (state.bgJobs || []).filter((j) => j.kind === "libimport" && (j.status === "queued" || j.status === "running")).length;
    taskCountEl.textContent = n ? t("lib_taskCount", { n }) : "";
    taskCountEl.hidden = !n;
  }
  _updateTaskCount = updateTaskCount;
  updateTaskCount();
  // Clicking the badge closes the library and opens the background-task drawer (the
  // drawer sits below the library overlay, so it must close first to be visible).
  if (taskCountEl) {
    taskCountEl.title = t("lib_taskCountHint");
    taskCountEl.addEventListener("click", () => { overlay.classList.remove("isOpen"); openBgDrawer(); });
  }

  // Pull every folder under the library → fill the ask-scope <select> (keeps the
  // current selection if it still exists) and cache for the move popup.
  async function refreshFolders() {
    try { const r = await postJson("/api/library/dirs", {}); allDirs = r.dirs || [""]; }
    catch { allDirs = [""]; }
    const prev = askFolderSel.value;
    askFolderSel.innerHTML = "";
    for (const dir of allDirs) {
      const opt = document.createElement("option");
      opt.value = dir;
      opt.textContent = dir === "" ? t("lib_scopeWholeLibrary") : "📁 " + dir;
      askFolderSel.appendChild(opt);
    }
    askFolderSel.value = allDirs.includes(prev) ? prev : "";
  }

  function renderTagBar() {
    const allTags = new Map();
    docs.forEach((d) => (d.tags || []).forEach((tg) => { if (tg && tg.name && !allTags.has(tg.name)) allTags.set(tg.name, tg.color || "#e0e0e0"); }));
    tagBar.innerHTML = "";
    allTags.forEach((color, name) => {
      const chip = document.createElement("span");
      chip.className = "archiveTagChip" + (activeTagFilter === name ? " isActive" : "");
      chip.textContent = name;
      chip.style.background = color;
      chip.addEventListener("click", () => {
        activeTagFilter = activeTagFilter === name ? null : name;
        renderTagBar();
        renderList();
      });
      tagBar.appendChild(chip);
    });
  }

  // One doc card (depth indents it under its folder in the tree view).
  function createCard(d, depth) {
    const card = document.createElement("div");
    card.className = "archiveCard" + (selected.has(d.docId) ? " isSelected" : "");
    if (depth) card.style.paddingLeft = (depth * 16 + 8) + "px";
    const sc = scores && scores.has(d.docId) ? `<span class="archiveCardScore">${Math.round(scores.get(d.docId) * 100)}%</span>` : "";
    const tagsHtml = (d.tags || []).map((tg) => `<span class="archiveCardTag" style="background:${tg.color || "#e0e0e0"}">${escapeHtml(tg.name)}</span>`).join("");
    const meta = [d.docKind, shortAuthors(d.authors), d.year].filter(Boolean).join(" · ");
    card.innerHTML = `
      <input type="checkbox" class="archiveCardCheckbox" ${selected.has(d.docId) ? "checked" : ""} />
      <div class="archiveCardInfo">
        <div class="archiveCardTitle">${sc}${kindIcon(d.docKind)} ${escapeHtml(d.title)}</div>
        <div class="archiveCardMeta"><span>${escapeHtml(meta)}</span><span>${t("lib_blocks", { n: d.blockCount })}</span>${tagsHtml}</div>
      </div>`;
    const cb = card.querySelector(".archiveCardCheckbox");
    cb.addEventListener("click", (e) => {
      e.stopPropagation();
      if (cb.checked) selected.add(d.docId); else selected.delete(d.docId);
      card.classList.toggle("isSelected", cb.checked);
      updateSelectionUI();
    });
    card.addEventListener("click", (e) => { if (e.target !== cb) openDoc(d.docId); });
    return card;
  }

  function renderList() {
    listEl.innerHTML = "";
    let list = [...docs];
    if (activeTagFilter) list = list.filter((d) => (d.tags || []).some((tg) => tg && tg.name === activeTagFilter));
    if (scores) {
      list = list.filter((d) => scores.has(d.docId)).sort((a, b) => scores.get(b.docId) - scores.get(a.docId));
    }
    if (!list.length) {
      listEl.innerHTML = `<div class="archiveEmpty">${docs.length ? t("lib_noMatch") : t("lib_emptyList")}</div>`;
      return;
    }
    // Semantic results / tag filter → flat list in relevance order (skip the tree).
    if (scores || activeTagFilter) {
      list.forEach((d) => listEl.appendChild(createCard(d, 0)));
      return;
    }
    // Otherwise group docs into a collapsible folder tree (same look as archives).
    const root = { dirs: {}, files: [] };
    for (const d of list) {
      const parts = (d.folder || "").split("/").filter(Boolean);
      let node = root;
      for (const part of parts) {
        if (!node.dirs[part]) node.dirs[part] = { dirs: {}, files: [] };
        node = node.dirs[part];
      }
      node.files.push(d);
    }
    const renderNode = (node, container, depth) => {
      Object.keys(node.dirs).sort().forEach((name) => {
        const dirEl = document.createElement("div");
        dirEl.className = "archiveTreeDir isCollapsed";
        const header = document.createElement("div");
        header.className = "archiveTreeDirHeader";
        header.style.paddingLeft = (depth * 16 + 8) + "px";
        header.innerHTML = `<span class="archiveTreeDirArrow">▶</span><span class="archiveTreeDirIcon">📁</span><span class="archiveTreeDirName">${escapeHtml(name)}</span>`;
        const content = document.createElement("div");
        content.className = "archiveTreeDirContent";
        header.addEventListener("click", () => {
          const collapsed = dirEl.classList.toggle("isCollapsed");
          header.querySelector(".archiveTreeDirArrow").textContent = collapsed ? "▶" : "▼";
        });
        dirEl.append(header, content);
        container.appendChild(dirEl);
        renderNode(node.dirs[name], content, depth + 1);
      });
      node.files.forEach((d) => container.appendChild(createCard(d, depth)));
    };
    renderNode(root, listEl, 0);
  }

  // ---- semantic search ----
  searchEl.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); runSearch(); } });
  searchEl.addEventListener("input", () => { if (!searchEl.value.trim()) { scores = null; renderList(); } });
  async function runSearch() {
    const q = searchEl.value.trim();
    if (!q) { scores = null; renderList(); return; }
    listEl.innerHTML = `<div class="archiveEmpty">${t("lib_searchingDots")}</div>`;
    try {
      const { results, error } = await postJson("/api/library/search", { query: q, model: embedModel() });
      if (error) { listEl.innerHTML = `<div class="archiveEmpty">${escapeHtml(t("lib_searchFailed", { error }))}</div>`; return; }
      scores = new Map((results || []).map((r) => [r.docId, r.score]));
      renderList();
    } catch (e) { listEl.innerHTML = `<div class="archiveEmpty">${escapeHtml(t("lib_searchFailed", { error: e.message }))}</div>`; }
  }

  // ---- doc browse (editable bubble stream) ----
  async function openDoc(docId) {
    try {
      const { doc, error } = await postJson("/api/library/get", { docId });
      if (error || !doc) { alert(error || t("lib_loadFailed")); return; }
      currentDoc = doc;
      previewTitle.textContent = `${kindIcon(doc.docKind)} ${doc.title}`;
      previewEmpty.style.display = "none";
      preview.classList.add("isOpen");
      askScoped.disabled = false;   // enable "this doc only" scoping
      renderBlocks(doc);
    } catch (e) { alert(t("lib_loadFailed") + " " + e.message); }
  }

  function renderBlocks(doc) {
    previewContent.innerHTML = "";
    // Per-doc toolbar: re-extract metadata (useful for docs imported before enrich existed).
    const bar = document.createElement("div");
    bar.className = "libraryDocToolbar";
    const reBtn = document.createElement("button");
    reBtn.type = "button";
    reBtn.className = "secondary";
    reBtn.textContent = t("lib_reextract");
    reBtn.addEventListener("click", async () => {
      reBtn.disabled = true;
      setStatus(t("lib_enriching", { name: doc.title }));
      await enrichDoc(doc.docId);
      setStatus("");
      await refreshList();
      openDoc(doc.docId);
    });
    bar.appendChild(reBtn);
    const toChatBtn = document.createElement("button");
    toChatBtn.type = "button";
    toChatBtn.className = "secondary";
    toChatBtn.textContent = t("lib_importToChat");
    toChatBtn.addEventListener("click", () => importDocAsTab(doc));
    bar.appendChild(toChatBtn);
    const metaBtn = document.createElement("button");
    metaBtn.type = "button";
    metaBtn.className = "secondary";
    metaBtn.textContent = t("lib_editMeta");
    metaBtn.addEventListener("click", () => editDocMeta(doc, metaBtn));
    bar.appendChild(metaBtn);
    const editMdBtn = document.createElement("button");
    editMdBtn.type = "button";
    editMdBtn.className = "secondary";
    editMdBtn.textContent = t("lib_editMarkdown");
    editMdBtn.addEventListener("click", () => editDocMarkdown(doc));
    bar.appendChild(editMdBtn);
    previewContent.appendChild(bar);
    // Render as one continuous markdown article (NOT chat bubbles): a section
    // heading appears once when it changes; each block stays individually
    // double-click-editable and scroll-targetable for source citations.
    let lastSection = null;
    let figNo = 0; // sequential figure number → image_NN.ext when no original name
    doc.blocks.forEach((b, idx) => {
      if (b.section && b.section !== lastSection) {
        const h = document.createElement("h3");
        h.className = "libDocSection";
        h.textContent = b.section;
        h.title = t("lib_editSectionHint");
        attachSectionEdit(h, doc, b.section);
        previewContent.appendChild(h);
        lastSection = b.section;
      }
      const div = document.createElement("div");
      div.className = "libDocBlock" + (b.role === "user" ? " libDocBlockUser" : "");
      div.id = `lib-block-${b.id}`;
      if (b.kind === "figure" && b.image) {
        // Filename-style label for the lightbox/download: the original image name when
        // known, else a sequential figure_NN.ext.
        figNo++;
        const ext = (b.imageMime || "image/png").includes("jpeg") ? "jpg" : "png";
        const figName = b.imageName || `figure_${String(figNo).padStart(2, "0")}.${ext}`;
        div.innerHTML =
          `<img class="generatedImage" data-filename="${escapeHtml(figName)}" src="data:${b.imageMime || "image/png"};base64,${b.image}" alt="figure" />` +
          (b.content ? `<div class="libraryFigCaption">${escapeHtml(b.content)}</div>` : "");
      } else {
        div.innerHTML = `<div class="markdownBody">${markdownToHtml(b.content || "")}</div>`;
        attachEdit(div, doc, idx);
      }
      previewContent.appendChild(div);
    });
    // Post-process: syntax-highlight code + render mermaid (reuse markdown.js helpers).
    highlightCodeBlocks(previewContent);
    renderMermaidDiagrams(previewContent);
  }

  // Double-click a section heading to fix OCR typos (e.g. "ABSTR ACT" → "ABSTRACT").
  // Renames the section on every block that carries it; content unchanged → 0 re-embed.
  function attachSectionEdit(h, doc, sectionName) {
    h.addEventListener("dblclick", () => {
      const input = document.createElement("input");
      input.type = "text";
      input.className = "editMessageInput libSectionEdit";
      input.value = sectionName;
      h.replaceWith(input);
      input.focus();
      input.select();
      const finish = async (save) => {
        const nv = input.value.trim();
        if (save && nv && nv !== sectionName) {
          doc.blocks.forEach((b) => { if (b.section === sectionName) b.section = nv; });
          setStatus(t("lib_saving"));
          try { await postJson("/api/library/save", { doc, model: embedModel() }); setStatus(""); }
          catch (e) { setStatus(t("lib_saveFailed") + " " + e.message); }
        }
        renderBlocks(doc);
      };
      input.addEventListener("blur", () => finish(true));
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); finish(true); }
        if (e.key === "Escape") { e.preventDefault(); finish(false); }
      });
    });
  }

  // Double-click a text/table bubble to edit; save re-embeds only that block.
  function attachEdit(div, doc, idx) {
    const body = div.querySelector(".markdownBody");
    if (!body) return;
    body.addEventListener("dblclick", () => {
      const original = doc.blocks[idx].content || "";
      const input = document.createElement("textarea");
      input.className = "editMessageInput";
      input.value = original;
      input.style.width = "100%";
      input.rows = Math.max(2, original.split("\n").length);
      body.replaceWith(input);
      input.focus();
      const finish = async (save) => {
        const nv = input.value;
        if (save && nv !== original) {
          doc.blocks[idx].content = nv;
          setStatus(t("lib_saving"));
          try {
            const r = await postJson("/api/library/save", { doc, model: embedModel() });
            setStatus(r.ok ? t("lib_saved", { n: r.reembedded }) : t("lib_saveFailed"));
            scores = null;   // ranking may have shifted
          } catch (e) { setStatus(t("lib_saveFailed") + " " + e.message); }
        }
        renderBlocks(doc);
      };
      input.addEventListener("blur", () => finish(true));
      input.addEventListener("keydown", (e) => {
        if (e.key === "Escape") { e.preventDefault(); finish(false); }
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); finish(true); }
      });
    });
  }

  // ---- import the current doc as a special editable tab (one bubble per chunk) ----
  function importDocAsTab(doc) {
    const messages = docToBlockMessages(doc);
    const tab = createTab(`📄 ${doc.title}`, messages);
    tab.libraryDocId = doc.docId;   // marks this tab as a library doc → archive writes it back
    tab.libraryMeta = {
      type: doc.type, schemaVersion: doc.schemaVersion, docKind: doc.docKind,
      source: doc.source, title: doc.title, authors: doc.authors, year: doc.year, tags: doc.tags,
    };
    state.tabs.unshift(tab);
    saveTabs();
    switchTab(tab.id);
    overlay.classList.remove("isOpen");
  }

  // ---- edit doc metadata via a small form popup; blocks unchanged → 0 re-embed ----
  function editDocMeta(doc, anchorEl) {
    document.querySelectorAll(".libraryMetaPopup").forEach((e) => e.remove());
    const popup = document.createElement("div");
    popup.className = "archiveMovePopup libraryMetaPopup";
    const titleEl = document.createElement("div");
    titleEl.className = "archiveMovePopupTitle";
    titleEl.textContent = t("lib_editMeta");
    popup.appendChild(titleEl);
    const mkRow = (labelText, val) => {
      const r = document.createElement("div");
      r.className = "libMetaRow";
      const span = document.createElement("span");
      span.textContent = labelText;
      const inp = document.createElement("input");
      inp.type = "text";
      inp.value = val || "";
      r.appendChild(span);
      r.appendChild(inp);
      popup.appendChild(r);
      return inp;
    };
    // docKind is an enum → a <select> (so a mis-classified type, e.g. slides read as
    // paper, can be corrected; the preview/list icon follows it via kindIcon).
    const mkSelectRow = (labelText, value, options) => {
      const r = document.createElement("div");
      r.className = "libMetaRow";
      const span = document.createElement("span");
      span.textContent = labelText;
      const sel = document.createElement("select");
      options.forEach(([val, label]) => {
        const opt = document.createElement("option");
        opt.value = val; opt.textContent = label;
        if ((value || "doc") === val) opt.selected = true;
        sel.appendChild(opt);
      });
      r.appendChild(span); r.appendChild(sel); popup.appendChild(r);
      return sel;
    };
    const titleInp = mkRow(t("lib_metaTitle"), doc.title);
    const kindSel = mkSelectRow(t("lib_metaKind"), doc.docKind, [
      ["paper", t("lib_kindPaper")], ["slides", t("lib_kindSlides")],
      ["blog", t("lib_kindBlog")], ["video", t("lib_kindVideo")], ["doc", t("lib_kindDoc")], ["other", t("lib_kindOther")],
    ]);
    const authorsInp = mkRow(t("lib_metaAuthors"), doc.authors);
    const yearInp = mkRow(t("lib_metaYear"), doc.year);
    const tagsInp = mkRow(t("lib_metaTags"), (doc.tags || []).map((tg) => tg.name).join(", "));
    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "libMetaSave";
    saveBtn.textContent = t("lib_metaSave");
    popup.appendChild(saveBtn);

    const rect = anchorEl.getBoundingClientRect();
    popup.style.position = "fixed";
    popup.style.top = `${rect.bottom + 4}px`;
    popup.style.left = `${rect.left}px`;
    popup.style.bottom = "auto";
    popup.style.zIndex = "1000";
    document.body.appendChild(popup);
    titleInp.focus();

    saveBtn.addEventListener("click", async () => {
      doc.title = titleInp.value.trim() || doc.title;
      doc.docKind = kindSel.value;
      doc.authors = authorsInp.value.trim();
      doc.year = yearInp.value.trim();
      doc.tags = tagsInp.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean).map((name) => ({ name, color: tagColor(name) }));
      popup.remove();
      setStatus(t("lib_saving"));
      try {
        await postJson("/api/library/save", { doc, model: embedModel() });
        setStatus("");
        previewTitle.textContent = `${kindIcon(doc.docKind)} ${doc.title}`;
        await refreshList();
      } catch (e) { setStatus(t("lib_saveFailed") + " " + e.message); }
    });
    setTimeout(() => {
      const close = (e) => { if (!popup.contains(e.target) && e.target !== anchorEl) { popup.remove(); document.removeEventListener("mousedown", close); } };
      document.addEventListener("mousedown", close);
    }, 0);
  }

  // ---- edit the whole doc as raw markdown; server re-chunks into fresh blocks ----
  function editDocMarkdown(doc) {
    const { md, images } = docToMarkdown(doc);
    previewTitle.textContent = `✏️ ${doc.title}`;
    previewEmpty.style.display = "none";
    preview.classList.add("isOpen");
    previewContent.innerHTML = "";
    const bar = document.createElement("div");
    bar.className = "libraryDocToolbar";
    const saveBtn = document.createElement("button");
    saveBtn.type = "button"; saveBtn.className = "secondary"; saveBtn.textContent = t("lib_mdSave");
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button"; cancelBtn.className = "secondary"; cancelBtn.textContent = t("lib_mdCancel");
    bar.append(saveBtn, cancelBtn);
    const ta = document.createElement("textarea");
    ta.className = "libraryMarkdownEditor";
    ta.value = md;
    previewContent.append(bar, ta);
    ta.focus();
    saveBtn.addEventListener("click", async () => {
      setStatus(t("lib_saving"));
      try {
        const r = await postJson("/api/library/reparse", { docId: doc.docId, text: ta.value, images, model: embedModel() });
        if (r.error) { setStatus(t("lib_saveFailed") + " " + r.error); return; }
        setStatus("");
        await refreshList();
        openDoc(doc.docId);   // reload the freshly re-chunked doc
      } catch (e) { setStatus(t("lib_saveFailed") + " " + e.message); }
    });
    cancelBtn.addEventListener("click", () => openDoc(doc.docId));
  }

  // ---- jump from a clicked source citation to its block in the doc ----
  async function jumpToSource(hit) {
    await openDoc(hit.docId);
    const el = document.getElementById(`lib-block-${hit.blockId}`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("libraryBlockHighlight");
      setTimeout(() => el.classList.remove("libraryBlockHighlight"), 1600);
    }
  }
  function renderClickableSources(hits) {
    if (!hits || !hits.length) return;
    const box = document.createElement("div");
    box.className = "librarySources";
    const title = document.createElement("div");
    title.className = "librarySourcesTitle";
    title.textContent = t("lib_sources");
    box.appendChild(title);
    hits.forEach((h, i) => {
      const item = document.createElement("div");
      item.className = "librarySourceItem";
      item.textContent = `${i + 1}. ${kindIcon(h.docKind)} ${h.title}${h.section ? " · " + h.section : ""}`;
      item.addEventListener("click", () => jumpToSource(h));
      box.appendChild(item);
    });
    previewContent.appendChild(box);
  }

  // ---- ask the whole library (panel box) ----
  async function askInPanel(query) {
    if (!query.trim()) return;
    const scopedId = (askScoped.checked && currentDoc) ? currentDoc.docId : null;
    // "this doc only" wins; otherwise scope to the chosen folder ("" = whole library).
    const scopedFolder = scopedId ? null : (askFolderSel.value || null);
    previewTitle.textContent = scopedId && currentDoc ? `🔎 ${currentDoc.title}` : t("lib_askResult");
    previewEmpty.style.display = "none";
    preview.classList.add("isOpen");
    previewContent.innerHTML =
      `<div class="archivePreviewMsg user"><div class="plainBody">${escapeHtml(query)}</div></div>` +
      `<div class="archivePreviewMsg assistant"><div class="markdownBody libraryAnswerBody">${t("lib_searchingDots")}</div></div>`;
    try {
      const { answer, hits } = await runLibraryQuery(query, {
        docId: scopedId, folder: scopedFolder,
        onToken: (acc) => { const el = previewContent.querySelector(".libraryAnswerBody"); if (el) el.innerHTML = markdownToHtml(acc); },
      });
      const el = previewContent.querySelector(".libraryAnswerBody");
      if (el) el.innerHTML = markdownToHtml(answer);
      renderClickableSources(hits);
    } catch (e) {
      const el = previewContent.querySelector(".libraryAnswerBody");
      if (el) el.textContent = t("lib_searchFailed", { error: e.message });
    }
  }
  askSend.addEventListener("click", () => askInPanel(askInput.value));
  askInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); askInPanel(askInput.value); } });

  // ---- delete ----
  deleteBtn.addEventListener("click", async () => {
    if (!selected.size) return;
    if (!confirm(t("lib_confirmDelete", { n: selected.size }))) return;
    const deletedIds = new Set(selected);
    await postJson("/api/library/delete", { docIds: [...selected] });
    selected.clear();
    updateSelectionUI();
    setStatus("");
    // If the doc shown in the preview was just deleted, clear the right pane.
    if (currentDoc && deletedIds.has(currentDoc.docId)) clearPreview();
    await refreshList();
  });

  // ---- move selected docs to a folder ----
  async function doMove(targetDir) {
    try {
      const r = await postJson("/api/library/move", { docIds: [...selected], targetDir });
      if (r.errors && r.errors.length) alert(t("lib_partialMoveFailed", { items: r.errors.map((e) => e.docId).join(", ") }));
      selected.clear();
      updateSelectionUI();
      await refreshList();
    } catch (e) { alert(t("lib_moveFailed", { error: e.message })); }
  }

  moveBtn.addEventListener("click", () => {
    if (!selected.size) return;
    document.querySelectorAll(".archiveMovePopup").forEach((el) => el.remove());
    const popup = document.createElement("div");
    popup.className = "archiveMovePopup";
    const title = document.createElement("div");
    title.className = "archiveMovePopupTitle";
    title.textContent = t("lib_selectTargetDir");
    popup.appendChild(title);
    const list = document.createElement("div");
    list.className = "archiveMovePopupList";
    // "+ new folder"
    const newItem = document.createElement("div");
    newItem.className = "archiveMovePopupItem archiveMovePopupNewDir";
    newItem.textContent = t("lib_newDir");
    newItem.addEventListener("click", () => {
      const name = prompt(t("lib_newDirPrompt"));
      if (!name || !name.trim()) return;
      const trimmed = name.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
      if (!trimmed) return;
      popup.remove();
      doMove(trimmed);
    });
    list.appendChild(newItem);
    allDirs.forEach((dir) => {
      const item = document.createElement("div");
      item.className = "archiveMovePopupItem";
      item.textContent = dir === "" ? t("lib_rootDir") : dir;
      item.addEventListener("click", () => { popup.remove(); doMove(dir); });
      list.appendChild(item);
    });
    popup.appendChild(list);
    const rect = moveBtn.getBoundingClientRect();
    popup.style.position = "fixed";
    popup.style.left = `${rect.left}px`;
    popup.style.bottom = `${window.innerHeight - rect.top + 4}px`;
    popup.style.zIndex = "1000";
    document.body.appendChild(popup);
    setTimeout(() => {
      const close = (e) => { if (!popup.contains(e.target) && e.target !== moveBtn) { popup.remove(); document.removeEventListener("mousedown", close); } };
      document.addEventListener("mousedown", close);
    }, 0);
  });

  // ---- figure lightbox (double-click a figure image to zoom) ----
  previewContent.addEventListener("dblclick", (e) => {
    const img = e.target.closest(".generatedImage");
    if (!img || !state.openLightbox) return;
    e.stopPropagation();
    const all = Array.from(previewContent.querySelectorAll(".generatedImage"));
    state.openLightbox(img.src, all.map((i) => i.src), all.map((i) => i.dataset.filename || ""));
  });

  // ---- draggable divider between list and preview (same as archive panel) ----
  const divider = document.querySelector("#libraryDivider");
  const bodyEl = divider.parentElement;   // .archiveBody (grid)
  let dragging = false;
  divider.addEventListener("mousedown", (e) => {
    e.preventDefault();
    dragging = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  });
  document.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const rect = bodyEl.getBoundingClientRect();
    const clamped = Math.max(200, Math.min(rect.width - 200, e.clientX - rect.left));
    bodyEl.style.gridTemplateColumns = `${clamped}px 6px minmax(0, 1fr)`;
  });
  document.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  });
}
