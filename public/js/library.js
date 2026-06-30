// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

// Knowledge Library (RAG) frontend: import docs (local files / URL / text) by
// reusing the existing parse + fetch pipelines, browse each doc as an editable
// bubble stream, semantic-search, and ask the whole library (panel box + the
// chat-side /ask command). Retrieval is server-side; generation reuses /api/chat.

import { dom, state } from './state.js';
import { escapeHtml } from './utils.js';
import { markdownToHtml, renderMermaidDiagrams, highlightCodeBlocks } from './markdown.js';
import { saveTabs } from './settings.js';
import { t } from './i18n.js';

const KIND_ICON = { paper: "📄", slides: "📊", blog: "🌐", doc: "📝", other: "📎" };
const genId = () => `${Date.now()}-${Math.random().toString(16).slice(2)}`;
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

async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  return res.json();
}

// Shared by the panel ask-box and the chat /ask command: retrieve → generate.
// Streams the answer token-by-token through onToken(accumulatedText) if given;
// resolves to the final { answer, hits }. /api/chat returns ndjson (one JSON
// per line, {message:{content},done}) — same format chat.js consumes.
async function runLibraryQuery(query, { docId = null, onToken = null } = {}) {
  const { hits, images } = await postJson("/api/library/retrieve", {
    query, model: embedModel(), docId, topK: 8, attachImages: true, maxImages: 3,
  });
  if (!hits || !hits.length) return { answer: t("lib_noResults"), hits: [] };

  const context = hits.map((h, i) => `[${i + 1}] (${h.title}${h.section ? " · " + h.section : ""}):\n${h.content}`).join("\n\n");
  // System prompt stays Chinese (it's an instruction to the LLM, not a visible UI string).
  const sys = `你是知识库助手。请仅依据下列资料片段回答问题，并用 [n] 标注引用来源；若资料中找不到依据，请直接说明未找到。\n\n资料片段：\n${context}`;
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
  });
  if (!res.ok || !res.body) return { answer: t("lib_noAnswer"), hits };

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
  return { answer: answer || t("lib_noAnswer"), hits };
}

function sourcesMarkdown(hits) {
  if (!hits || !hits.length) return "";
  return `\n\n---\n**${t("lib_sources")}**\n` + hits.map((h, i) =>
    `${i + 1}. ${kindIcon(h.docKind)} ${h.title}${h.section ? " · " + h.section : ""}`).join("\n");
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
export function parseAskCommand(content) {
  if (!/^\/ask(\s|$)/.test(content || "")) return null;
  return content.replace(/^\/ask\s*/, "").trim();
}

export async function handleAskCommand(query, tab) {
  const rerender = async () => { saveTabs(); const { renderChat } = await import('./chat.js'); renderChat(); };
  const now = Date.now();
  tab.messages.push({ id: genId(), role: "user", content: `/ask ${query}`, timestamp: now });
  const amsg = { id: genId(), role: "assistant", content: t("lib_searching"), timestamp: now + 1 };
  tab.messages.push(amsg);
  await rerender();
  try {
    let last = 0;
    const { answer, hits } = await runLibraryQuery(query, {
      onToken: (acc) => {
        amsg.content = acc;
        const now2 = Date.now();
        if (now2 - last > 120) { last = now2; rerender(); }   // throttle full re-render
      },
    });
    amsg.content = answer + sourcesMarkdown(hits);
  } catch (e) {
    amsg.content = t("lib_askFailed") + e.message;
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
  const importBtn = document.querySelector("#libraryImportBtn");
  const importMenu = document.querySelector("#libraryImportMenu");
  const importFilesItem = document.querySelector("#libraryImportFiles");
  const importTextItem = document.querySelector("#libraryImportText");
  const importUrlItem = document.querySelector("#libraryImportUrl");
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

  const setStatus = (s) => { statusEl.textContent = s || ""; };

  // ---- open / close ----
  openBtn.addEventListener("click", () => {
    overlay.classList.add("isOpen");
    preview.classList.remove("isOpen");   // reset right pane to empty state
    previewEmpty.style.display = "";
    askScoped.checked = false;
    askScoped.disabled = true;
    refreshList();
  });
  closeBtn.addEventListener("click", () => overlay.classList.remove("isOpen"));

  // ---- import menu ----
  importBtn.addEventListener("click", (e) => { e.stopPropagation(); importMenu.hidden = !importMenu.hidden; });
  document.addEventListener("click", (e) => { if (!importMenu.contains(e.target) && e.target !== importBtn) importMenu.hidden = true; });
  importFilesItem.addEventListener("click", () => { importMenu.hidden = true; fileInput.click(); });
  importTextItem.addEventListener("click", () => { importMenu.hidden = true; textInput.click(); });
  importUrlItem.addEventListener("click", () => { importMenu.hidden = true; importUrl(); });
  fileInput.addEventListener("change", () => { importFiles([...fileInput.files]); fileInput.value = ""; });
  textInput.addEventListener("change", () => { importFiles([...textInput.files]); textInput.value = ""; });

  function docKindForExt(ext) {
    if (ext === ".pptx") return "slides";
    if (ext === ".pdf") return "paper";
    return "doc";
  }

  async function importFiles(files) {
    if (!files.length) return;
    let done = 0;
    for (const file of files) {
      const ext = "." + file.name.split(".").pop().toLowerCase();
      done++;
      setStatus(t("lib_parsing", { name: file.name, done, total: files.length }));
      try {
        let parsed;
        if (ext === ".txt" || ext === ".md" || ext === ".markdown") {
          parsed = { text: await file.text(), images: [] };
        } else {
          if (!_parseDocumentHeadless) { alert(t("lib_parserNotReady")); return; }
          const b64 = await fileToB64(file);
          parsed = await _parseDocumentHeadless(b64, file.name, ext, "", (p) => setStatus(p));
        }
        if (!parsed || !(parsed.text || "").trim()) { setStatus(t("lib_parseEmpty", { name: file.name })); continue; }
        const r = await postJson("/api/library/import", {
          source: `file:${file.name}`,
          docKind: docKindForExt(ext),
          title: file.name.replace(/\.[^.]+$/, ""),
          text: parsed.text, images: parsed.images || [], model: embedModel(),
        });
        if (r.error) setStatus(t("lib_importFailed", { name: file.name, error: r.error }));
        else if (r.docId) { setStatus(t("lib_enriching", { name: file.name })); await enrichDoc(r.docId); }
      } catch (e) { setStatus(t("lib_importFailed", { name: file.name, error: e.message })); }
    }
    setStatus(t("lib_imported", { n: files.length }));
    await refreshList();
  }

  async function importUrl() {
    const url = prompt(t("lib_urlPrompt"));
    if (!url || !url.trim()) return;
    setStatus(t("lib_fetching"));
    try {
      const data = await postJson("/api/fetch-url", { url: url.trim() });
      if (data.type === "error" || data.type === "unsupported" || !data.content) {
        alert(t("lib_fetchFailed", { error: data.content || "?" })); setStatus(""); return;
      }
      const r = await postJson("/api/library/import", {
        source: `url:${url.trim()}`, docKind: "blog",
        title: data.title || url.trim(),
        text: data.content, images: [], model: embedModel(),
      });
      if (r.error) { setStatus(t("lib_importFailed", { name: url.trim(), error: r.error })); return; }
      if (r.docId) { setStatus(t("lib_enriching", { name: data.title || url.trim() })); await enrichDoc(r.docId); }
      setStatus(t("lib_importedUrl"));
      await refreshList();
    } catch (e) { setStatus(t("lib_fetchFailed", { error: e.message })); }
  }

  // ---- list ----
  async function refreshList() {
    try { const d = await postJson("/api/library/list", {}); docs = d.docs || []; }
    catch { docs = []; }
    renderTagBar();
    renderList();
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
    for (const d of list) {
      const card = document.createElement("div");
      card.className = "archiveCard" + (selected.has(d.docId) ? " isSelected" : "");
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
        deleteBtn.disabled = selected.size === 0;
      });
      card.addEventListener("click", (e) => { if (e.target !== cb) openDoc(d.docId); });
      listEl.appendChild(card);
    }
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
    previewContent.appendChild(bar);
    // Render as one continuous markdown article (NOT chat bubbles): a section
    // heading appears once when it changes; each block stays individually
    // double-click-editable and scroll-targetable for source citations.
    let lastSection = null;
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
      div.className = "libDocBlock";
      div.id = `lib-block-${b.id}`;
      if (b.kind === "figure" && b.image) {
        div.innerHTML =
          `<img class="generatedImage" src="data:${b.imageMime || "image/png"};base64,${b.image}" alt="figure" />` +
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
    previewTitle.textContent = scopedId && currentDoc ? `🔎 ${currentDoc.title}` : t("lib_askResult");
    previewEmpty.style.display = "none";
    preview.classList.add("isOpen");
    previewContent.innerHTML =
      `<div class="archivePreviewMsg user"><div class="plainBody">${escapeHtml(query)}</div></div>` +
      `<div class="archivePreviewMsg assistant"><div class="markdownBody libraryAnswerBody">${t("lib_searchingDots")}</div></div>`;
    try {
      const { answer, hits } = await runLibraryQuery(query, {
        docId: scopedId,
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
    await postJson("/api/library/delete", { docIds: [...selected] });
    selected.clear();
    deleteBtn.disabled = true;
    setStatus("");
    await refreshList();
  });

  // ---- figure lightbox (double-click a figure image to zoom) ----
  previewContent.addEventListener("dblclick", (e) => {
    const img = e.target.closest(".generatedImage");
    if (!img || !state.openLightbox) return;
    e.stopPropagation();
    const all = previewContent.querySelectorAll(".generatedImage");
    state.openLightbox(img.src, Array.from(all).map((i) => i.src));
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
