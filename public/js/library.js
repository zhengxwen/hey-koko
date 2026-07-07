// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

// Knowledge Library (RAG) frontend: import docs (local files / URL / text /
// YouTube) as SERVER-side background jobs (kind "libimport" — the whole
// fetch/whisper/parse → embed → distill-card pipeline runs in server/jobs.js, so a
// queued batch finishes even with the browser closed), browse each doc as an
// editable bubble stream, semantic-search, and ask the whole library (panel box +
// the chat-side /ask command). Retrieval is server-side; generation reuses /api/chat.

import { dom, state } from './state.js';
import { escapeHtml, postJson } from './utils.js';
import { markdownToHtml, renderMermaidDiagrams, highlightCodeBlocks } from './markdown.js';
import { renderRelationGraph, openEntityGraphModal } from './relation-graph.js';
import { applyHighlights, registerHighlightHost } from './highlight.js';
import { saveTabs } from './settings.js';
import { createTab, switchTab } from './tabs.js';
import { t, getPromptLanguage } from './i18n.js';
import { setMentionDocs } from './mentions.js';
import { enqueueBgJob, openBgDrawer, closeBgDrawer } from './bg-jobs.js';
import { initListKeyNav } from './list-keynav.js';
import { libImportFetch } from './server-queue.js';
import { runLibraryQuery, setAskDeps } from './ask.js';

const KIND_ICON = { paper: "📄", slides: "📊", blog: "🌐", video: "📺", doc: "📝", chat: "💬", other: "📎" };
// The relation graph's open/collapsed state persists across articles: once the user opens it,
// switching to another doc keeps it open (and vice-versa). Module-scoped so it survives re-renders.
let relGraphOpenPref = false;
const genId = () => `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const isYoutubeUrl = (u) => /youtube\.com|youtu\.be/.test(u || "");
// Set by initLibrary so the background import jobs can refresh the list / task count.
let _refreshLibraryList = null;
let _updateTaskCount = null;
let _openLibrary = null;
let _openDoc = null;

// Called by bg-jobs (via setBgDeps onJobsChanged) whenever the job list/status changes,
// so the library header shows how many imports are still queued/running.
export function notifyLibraryJobsChanged() { if (_updateTaskCount) _updateTaskCount(); }
// Open the library panel — used by bg-jobs to return here when a library import task
// (which has no chat bubble) is clicked in the task drawer.
export function openLibraryPanel() { if (_openLibrary) _openLibrary(); }
// Open the library panel WITH a document shown — used by the star map's inspector
// ("open document" on a star) to jump straight into reading.
export function openLibraryDoc(docId) { if (_openLibrary) _openLibrary(); if (_openDoc) _openDoc(docId); }
const embedModel = () => (dom.embedModelSelect?.value || "").trim() || "qwen3-embedding:8b";
const kindIcon = (k) => KIND_ICON[k] || "📎";
// The transcript-section names the server importer writes (DISTILL_I18N transcriptHeading,
// server/library.js) — a video doc's section with one of these names is ASR-transcribed
// AND LLM-reformatted text, not a verbatim record; displays add a ✏️ badge to say so.
const TRANSCRIPT_SECTIONS = new Set(["«字幕整理»", "«Transcript»"]);
export const isTranscriptSection = (s) => TRANSCRIPT_SECTIONS.has(String(s || "").trim());
// Small badge element marking a SPECIAL generated section (display-only — never stored
// in the doc). Hover shows the native title; CLICK pops the explanation immediately as
// a small tooltip bubble (also the only way to see it on touch devices, with no hover).
function sectionMark(icon, hint, action = null) {
  const mark = document.createElement("span");
  mark.className = "libTranscriptMark";
  mark.textContent = icon;
  mark.title = hint;
  mark.addEventListener("click", (e) => { e.stopPropagation(); e.preventDefault(); toggleTranscriptTip(mark, hint, action); });
  mark.addEventListener("mousedown", (e) => e.stopPropagation());   // don't arm the chat bubble's drag
  mark.addEventListener("dblclick", (e) => e.stopPropagation());    // don't trigger section rename
  return mark;
}
// ✏️ = AI-reformatted ASR transcript (not verbatim speech). onRegen (optional) adds a
// "regenerate the distill card" button to the click-popup — the library preview passes
// it (the transcript is the card's source material, so this is where you notice the
// card needs a redo); the chat-bubble copy stays explanation-only.
export function transcriptMark(onRegen) {
  // Explicit "…distill card" label here — a bare "regenerate" next to the transcript
  // hint would read as regenerating the TRANSCRIPT.
  return sectionMark("✏️", t("lib_transcriptEditedHint"), onRegen ? { label: t("lib_regenCardFull"), run: onRegen } : null);
}
// 📇 = the distillation card (AI-generated summary/key points, not original content).
// onRegen (optional) adds a "regenerate" button to the click-popup — the library preview
// passes it (re-distill with the CURRENT chat model); the chat-bubble copy is a snapshot
// of the doc, so its popup stays explanation-only.
export function cardMark(onRegen) {
  return sectionMark("📇", t("lib_distillCardHint"), onRegen ? { label: t("lib_regenCard"), run: onRegen } : null);
}
// One tip at a time; closed by a second click on its badge, any outside click,
// Escape, or a 4s auto-hide.
let _tipEl = null, _tipAnchor = null, _tipTimer = 0;
function hideTranscriptTip() {
  if (_tipEl) _tipEl.remove();
  _tipEl = null; _tipAnchor = null;
  if (_tipTimer) { clearTimeout(_tipTimer); _tipTimer = 0; }
}
function toggleTranscriptTip(anchor, text, action = null) {
  if (_tipAnchor === anchor) { hideTranscriptTip(); return; }
  hideTranscriptTip();
  const tip = document.createElement("div");
  tip.className = "libTranscriptTip";
  tip.textContent = text || t("lib_transcriptEditedHint");
  if (action) {
    // Clicks inside the tip must not reach the document's outside-click closer.
    tip.addEventListener("click", (e) => e.stopPropagation());
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "libTipBtn";
    btn.textContent = action.label;
    btn.addEventListener("click", (e) => { e.stopPropagation(); hideTranscriptTip(); action.run(); });
    tip.appendChild(btn);
  }
  document.body.appendChild(tip);
  const r = anchor.getBoundingClientRect();
  tip.style.left = Math.max(8, Math.min(r.left, window.innerWidth - tip.offsetWidth - 8)) + "px";
  tip.style.top = (r.bottom + 6) + "px";
  _tipEl = tip; _tipAnchor = anchor;
  // With a button the user needs time to decide — hold the tip open longer.
  _tipTimer = setTimeout(hideTranscriptTip, action ? 8000 : 4000);
}
document.addEventListener("click", () => hideTranscriptTip());   // badge clicks stopPropagation → only outside clicks land here
document.addEventListener("keydown", (e) => { if (e.key === "Escape") hideTranscriptTip(); });
// Papers can have dozens of authors — show at most the first 3 in the list view.
function shortAuthors(authors) {
  if (!authors) return "";
  const list = authors.split(/[,，;；]/).map((s) => s.trim()).filter(Boolean);
  return list.length <= 3 ? list.join(", ") : list.slice(0, 3).join(", ") + " " + t("lib_etAl");
}

function fileToB64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(",")[1] || "");
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

// Upload an import file as RAW BINARY into the server's job spool → { spoolName }.
// Base64 inside the JSON job body freezes the main thread on big PDFs (JSON.stringify
// of a ~70MB string — the same trap source-video upload hit); the payload then carries
// just the tiny spoolName. Throws on failure — the caller falls back to inline base64.
async function uploadImportFile(file) {
  const r = await fetch("/api/jobs/upload", {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: file,
  });
  const d = await r.json();
  if (!r.ok || !d.spoolName) throw new Error(d.error || "upload failed");
  return d.spoolName;
}

// Run ANY library import (file/text/url/youtube — plus 'distill' card backfill) by
// submitting it to the SERVER queue (kind "libimport", server/jobs.js): the whole
// fetch/whisper/parse → chunk+embed → distill-card pipeline runs server-side, so a
// queued batch drains even after every page is closed. This generator (fired up front
// by pumpQueue, like image/video jobs) just submits, awaits the SSE result, and
// refreshes the panel; on reload it reconnects to the same job by serverJobId. Stage
// progress (fetching/parsing/importing/distilling + whisper stages) arrives via the
// jobs SSE → bgProgressLabel, not through this sink.
export async function runLibraryImport(payload, sink) {
  const r = await libImportFetch(payload, {
    bgJob: sink.server.bgJob, conversationId: sink.server.conversationId,
    msgId: sink.server.msgId, label: sink.server.label, signal: sink.signal,
  });
  const data = await r.json();
  if (!r.ok || !data || data.error) throw new Error((data && data.error) || t("lib_fetchFailed", { error: "?" }));
  if (_refreshLibraryList) { try { await _refreshLibraryList(); } catch { /* panel maybe closed */ } }
}

// Snapshot the per-import settings at ENQUEUE time (payload rides to the server):
// embedModel = vector space; chatModel + language = distill card; distill = the toggle.
function importJobCommon() {
  return {
    embedModel: embedModel(),
    chatModel: dom.modelSelect.value,
    language: getPromptLanguage(),
    distill: dom.libraryDistillToggle ? !!dom.libraryDistillToggle.checked : true,
    // distill LLM budget = the chat "timeout (s)" slider, snapshotted at enqueue
    llmTimeoutS: parseInt(dom.requestTimeoutInput.value, 10) || 300,
  };
}

// Turn each library block into its OWN assistant chat bubble: text → content,
// figure → caption in content + image in generatedImages. Block metadata rides
// along (isLibraryBlock/libraryKind/librarySection) so the tab can be written
// back to the library later. Reuses normal-tab edit/delete/reorder as-is.
function docToBlockMessages(doc) {
  return (doc.blocks || []).map((b) => {
    const msg = { id: genId(), role: b.role || "assistant", content: b.content || "", timestamp: Date.now() };
    if (b.highlights && b.highlights.length) msg.highlights = b.highlights;   // carry highlights into chat
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
      if (m.highlights && m.highlights.length) b.highlights = m.highlights;   // carry highlights back to library
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
    // save rewrites the doc WHOLESALE — carry the rest of the metadata through, or a
    // tab write-back silently strips it (undefined fields drop out of the JSON)
    doi: meta.doi || "", publishedAt: meta.publishedAt || "",
    citation: meta.citation, keywords: meta.keywords,
    importedAt: meta.importedAt, rating: meta.rating,
    blocks,
  };
  return postJson("/api/library/save", { doc, model: embedModel() });
}

// Deterministic pastel color per tag name (no per-tag state needed). The server's
// distill step uses the same formula, so tags color identically wherever assigned.
function tagColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return `hsl(${h}, 55%, 82%)`;
}

export function initLibrary() {
  const overlay = document.querySelector("#libraryOverlay");
  const openBtn = document.querySelector("#libraryBtn");
  const closeBtn = document.querySelector("#libraryCloseBtn");
  const listEl = document.querySelector("#libraryList");
  initListKeyNav(listEl);   // ↑↓ move, ←→ fold/unfold folders, Enter opens
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
  const refreshBtn = document.querySelector("#libraryRefreshBtn");
  const sortBtn = document.querySelector("#librarySortBtn");
  const loadingEl = document.querySelector("#libraryLoading");
  const importMenu = document.querySelector("#libraryImportMenu");
  const taskCountEl = document.querySelector("#libraryTaskCount");
  const importPaperItem = document.querySelector("#libraryImportPaper");
  const importFilesItem = document.querySelector("#libraryImportFiles");
  const importTextItem = document.querySelector("#libraryImportText");
  const importUrlItem = document.querySelector("#libraryImportUrl");
  const importZoteroItem = document.querySelector("#libraryImportZotero");
  const syncZoteroAnnotsItem = document.querySelector("#librarySyncZoteroAnnots");
  const zoteroIncrSyncItem = document.querySelector("#libraryZoteroIncrSync");
  const zoteroFullSyncItem = document.querySelector("#libraryZoteroFullSync");
  const buildCitationsItem = document.querySelector("#libraryBuildCitations");
  const opsParent = document.querySelector("#libraryOpsParent");
  const opsSubmenu = document.querySelector("#libraryOpsSubmenu");
  const citationGraphBtn = document.querySelector("#libraryCitationGraphBtn");
  const paperInput = document.querySelector("#libraryPaperInput");
  const fileInput = document.querySelector("#libraryFileInput");
  const textInput = document.querySelector("#libraryTextInput");
  const askInput = document.querySelector("#libraryAskInput");
  const askSend = document.querySelector("#libraryAskSend");
  const askScoped = document.querySelector("#libraryAskScoped");
  // "This doc only" and the folder scope are mutually exclusive — checking the former
  // makes the folder dropdown moot, so hide it while it's on (display, not [hidden], to
  // dodge the global-CSS override and drop it out of the flex row cleanly).
  askScoped.addEventListener("change", () => { askFolderSel.style.display = askScoped.checked ? "none" : ""; });
  const urlModal = document.querySelector("#libraryUrlModal");
  const urlTextarea = document.querySelector("#libraryUrlTextarea");
  const urlHint = document.querySelector("#libraryUrlHint");
  const urlClose = document.querySelector("#libraryUrlClose");
  const urlCancel = document.querySelector("#libraryUrlCancel");
  const urlConfirm = document.querySelector("#libraryUrlConfirm");
  const ytModal = document.querySelector("#libraryYtModal");
  const ytHint = document.querySelector("#libraryYtHint");
  const ytList = document.querySelector("#libraryYtList");
  const ytErrors = document.querySelector("#libraryYtErrors");
  const ytCount = document.querySelector("#libraryYtCount");
  const ytSelectAll = document.querySelector("#libraryYtSelectAll");
  const ytMemberLabel = document.querySelector("#libraryYtMemberLabel");
  const ytMemberToggle = document.querySelector("#libraryYtMember");
  const ytReverse = document.querySelector("#libraryYtReverse");
  const ytClose = document.querySelector("#libraryYtClose");
  const ytCancel = document.querySelector("#libraryYtCancel");
  const ytConfirm = document.querySelector("#libraryYtConfirm");
  const ytAutoFolder = document.querySelector("#libraryYtAutoFolder");
  const ytFilter = document.querySelector("#libraryYtFilter");

  let docs = [];
  let selected = new Set();
  let scores = null;          // Map<docId, score> when a semantic search is active
  let activeTagFilter = null;
  let currentDoc = null;

  // Highlight host: knowledge-library doc blocks own their highlights on
  // block.highlights. Lets the shared selection toolbar / notes work in the doc
  // preview, persisting to the library (renderBlocks re-applies them).
  registerHighlightHost({
    resolve(bodyEl) {
      const block = bodyEl.closest(".libDocBlock");
      if (!block || !currentDoc || !previewContent.contains(block)) return null;
      return { blockId: block.id.replace(/^lib-block-/, "") };
    },
    list(ctx) {
      const b = currentDoc?.blocks?.find((x) => x.id === ctx.blockId);
      return b ? (b.highlights = b.highlights || []) : null;
    },
    commit(ctx) {
      const b = currentDoc?.blocks?.find((x) => x.id === ctx.blockId);
      if (b && b.highlights && !b.highlights.length) delete b.highlights;
      const st = previewContent.scrollTop;   // renderBlocks rebuilds innerHTML → keep the reader's place
      renderBlocks(currentDoc);
      previewContent.scrollTop = st;
      // Highlights don't change block content → no re-embed; just persist the doc.
      postJson("/api/library/save", { doc: currentDoc, model: embedModel() }).catch(() => {});
    },
    scope(ctx) { return document.getElementById(`lib-block-${ctx.blockId}`); },
  });

  const expandedDirs = new Set();   // folder paths the user expanded — survives re-renders
                                    // (the list refreshes on every panel open)
  let sortMode = "";          // "" = import order · "new"/"old" = by date (publishedAt,
                              // i.e. YouTube upload date, else importedAt) · "rate" =
                              // manual ★ rating high→low; session-scoped
  let ratingFilter = "";      // "" all · "3"/"4"/"5" = ★N and up · "unrated"
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
    askFolderSel.style.display = "";   // no doc open → folder scope is shown again
  };

  // ---- open / close ----
  function open() {
    // The two full-area panels are mutually exclusive: the archive overlay sits EARLIER
    // in the DOM at the same z-index, so left open it would hide under us and clicking
    // its button later would look dead. Opening one always closes the other — and must
    // also undo the browser's side effect: openArchiveBrowser disables #archiveChat and
    // only its OWN close button re-enables it, so closing it from here without this
    // would leave the Archive button disabled forever.
    document.querySelector("#archiveOverlay")?.classList.remove("isOpen");
    const archiveBtn = document.querySelector("#archiveChat");
    if (archiveBtn) archiveBtn.disabled = false;
    overlay.classList.add("isOpen");
    if (!currentDoc) clearPreview();   // keep the doc being read across close/reopen
    refreshList().then(() => {
      // The shown doc may have been deleted while the panel was closed.
      if (currentDoc && !docs.some((d) => d.docId === currentDoc.docId)) clearPreview();
    });
    // Safari/WKWebView Tab skips tabindex'd divs by default — hand the list focus
    // directly so arrow-key navigation works the moment the panel opens.
    listEl.focus({ preventScroll: true });
  }
  _openLibrary = open;
  _openDoc = openDoc;
  // Hand the panel's open-doc / open-panel to ask.js (the /ask source links jump
  // here). The ⚙ ask-params modal + #libsrc click delegation live in ask.js's initAsk.
  setAskDeps({ openLibrary: open, openDoc });

  // Panel BUTTON also notifies the star map (else the panel opens beneath it and the
  // click looks dead). "libraryOpened" lets a panel-dismissed star map RESUME here —
  // that's the archive ↔ star-map toggle. The star map's own source-toggle syncing
  // calls open() directly, NOT this handler, so it neither closes nor reopens the map.
  openBtn.addEventListener("click", () => {
    document.dispatchEvent(new CustomEvent("heykoko:closeStarMap"));
    open();
    document.dispatchEvent(new CustomEvent("heykoko:libraryOpened"));
  });
  closeBtn.addEventListener("click", () => overlay.classList.remove("isOpen"));

  // ---- refresh (rescan disk) ----
  // Reconcile the library with manual file operations under LIBRARY_DIR: docs the user
  // dropped in / moved between folders / deleted in Finder. The server re-reads every doc
  // Sort cycles import order → date new→old → date old→new → rating high→low.
  // dataset.mode lets the language switcher (applyI18n) re-label the button without
  // knowing library state.
  sortBtn.title = t("lib_sortHint");
  sortBtn.textContent = t("lib_sortDefault");
  sortBtn.addEventListener("click", () => {
    sortMode = sortMode === "" ? "importRev" : sortMode === "importRev" ? "new" : sortMode === "new" ? "old" : sortMode === "old" ? "rate" : "";
    sortBtn.dataset.mode = sortMode;
    sortBtn.textContent = t(sortMode === "importRev" ? "lib_sortImportRev" : sortMode === "new" ? "lib_sortNewOld" : sortMode === "old" ? "lib_sortOldNew" : sortMode === "rate" ? "lib_sortRate" : "lib_sortDefault");
    renderList();
  });

  // ★ filter: minimum rating (or unrated-only, for finding docs still to grade).
  const ratingFilterSel = document.querySelector("#libraryRatingFilter");
  ratingFilterSel.addEventListener("change", () => { ratingFilter = ratingFilterSel.value; renderList(); });

  // (slow on a big library) → show the tab-loading three-dots overlay while it runs.
  refreshBtn.title = t("lib_refresh");
  refreshBtn.addEventListener("click", async () => {
    if (refreshBtn.disabled) return;
    refreshBtn.disabled = true;
    if (loadingEl) loadingEl.hidden = false;
    try {
      // Streams ndjson progress: start → progress per doc → done. Passes the current
      // embed model so rescan can (re)embed docs missing a .vec OR built with a different
      // model; if that model is down it skips embedding and only syncs the file list.
      const res = await fetch("/api/library/rescan", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: embedModel() }),
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "", result = null, modelDown = false;
      const handle = (line) => {
        if (!line.trim()) return;
        let m; try { m = JSON.parse(line); } catch { return; }
        if (m.status === "model-unavailable") { modelDown = true; setStatus(t("lib_rescanModelDown")); }
        else if (m.status === "start" || m.status === "progress") {
          if (!modelDown) setStatus(t("lib_rescanProgress", { done: m.done || 0, total: m.total }));
        } else if (m.status === "done") result = m;
        else if (m.status === "error") throw new Error(m.message);
      };
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n"); buffer = lines.pop() || "";
        for (const l of lines) handle(l);
      }
      if (buffer.trim()) handle(buffer);
      await refreshList();
      // The open doc may have been deleted/replaced on disk — reset the preview if gone.
      if (currentDoc && !docs.some((d) => d.docId === currentDoc.docId)) clearPreview();
      const r = result || { total: docs.length, added: 0, removed: 0 };
      let msg = t("lib_rescanDone", { total: r.total, added: r.added, removed: r.removed });
      if (r.embedded) msg += t("lib_rescanEmbedded", { n: r.embedded });
      if (r.reembedded) msg += t("lib_rescanReembedded", { n: r.reembedded });
      if (r.skipped) msg += t("lib_rescanSkipped", { n: r.skipped });
      if (r.embedFailed) msg += t("lib_rescanEmbedFailed", { n: r.embedFailed });
      setStatus(msg);
    } catch (e) {
      setStatus(t("lib_rescanFailed", { error: (e && e.message) || "?" }));
    } finally {
      if (loadingEl) loadingEl.hidden = true;
      refreshBtn.disabled = false;
    }
  });

  // ---- import menu ---- (the "🔧 Operations" flyout collapses whenever the menu closes)
  const closeImportMenu = () => { importMenu.hidden = true; if (opsSubmenu) opsSubmenu.hidden = true; };
  importBtn.addEventListener("click", (e) => { e.stopPropagation(); importMenu.hidden = !importMenu.hidden; if (opsSubmenu) opsSubmenu.hidden = true; });
  document.addEventListener("click", (e) => { if (!importMenu.contains(e.target) && e.target !== importBtn) closeImportMenu(); });
  if (opsParent) opsParent.addEventListener("click", (e) => { e.stopPropagation(); opsSubmenu.hidden = !opsSubmenu.hidden; });
  importPaperItem.addEventListener("click", () => { closeImportMenu(); paperInput.click(); });
  importFilesItem.addEventListener("click", () => { closeImportMenu(); fileInput.click(); });
  importTextItem.addEventListener("click", () => { closeImportMenu(); textInput.click(); });
  importUrlItem.addEventListener("click", () => { closeImportMenu(); importUrl(); });
  if (importZoteroItem) importZoteroItem.addEventListener("click", () => { closeImportMenu(); openZoteroImport(); });
  if (syncZoteroAnnotsItem) syncZoteroAnnotsItem.addEventListener("click", () => { closeImportMenu(); syncZoteroAnnotations(); });
  if (zoteroIncrSyncItem) zoteroIncrSyncItem.addEventListener("click", () => { closeImportMenu(); zoteroSync("incremental"); });
  if (zoteroFullSyncItem) zoteroFullSyncItem.addEventListener("click", () => { closeImportMenu(); zoteroSync("full"); });
  if (buildCitationsItem) buildCitationsItem.addEventListener("click", () => {
    closeImportMenu();
    // One bg job scans every DOI'd doc's Crossref references → in-library cites (survives
    // browser close, shows in the task drawer). No per-doc payload = all docs.
    enqueueBgJob({
      tabId: state.activeTabId, kind: "libimport", label: "🔗 " + t("lib_citationGraph"),
      payload: { type: "citations" }, noPlaceholder: true,
    });
    setStatus(t("lib_citationsQueued"));
  });
  if (citationGraphBtn) citationGraphBtn.addEventListener("click", () => openCitationGraph());
  // Backfill distillation cards for docs that predate the feature (index lacks hasCard):
  // one server-side distill job per doc — same queue as imports, browser-closable.
  const backfillItem = document.querySelector("#libraryBackfillCards");
  if (backfillItem) backfillItem.addEventListener("click", () => {
    closeImportMenu();
    const missing = docs.filter((d) => !d.hasCard);
    if (!missing.length) { setStatus(t("lib_backfillNone")); return; }
    if (!confirm(t("lib_backfillConfirm", { n: missing.length }))) return;
    for (const d of missing) {
      enqueueBgJob({
        tabId: state.activeTabId, kind: "libimport", label: "📇 " + (d.title || d.docId),
        payload: { type: "distill", docId: d.docId, chatModel: dom.modelSelect.value, language: getPromptLanguage(), llmTimeoutS: parseInt(dom.requestTimeoutInput.value, 10) || 300 },
        noPlaceholder: true,
      });
    }
    setStatus(t("lib_importQueued"));
  });
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
        payload = { type: "text", name: file.name, title: file.name.replace(/\.[^.]+$/, ""), text: await file.text(), folder, docKind: dk, ...importJobCommon() };
      } else {
        // Raw-binary upload into the server spool first (keeps big PDFs out of the JSON
        // job body); inline base64 only as the fallback if the upload fails.
        let spoolName = null;
        try { spoolName = await uploadImportFile(file); } catch { /* fall back to base64 */ }
        payload = spoolName
          ? { type: "file", name: file.name, ext, spoolName, folder, docKind: dk, ...importJobCommon() }
          : { type: "file", name: file.name, ext, fileB64: await fileToB64(file), folder, docKind: dk, ...importJobCommon() };
      }
      enqueueBgJob({ tabId: state.activeTabId, kind: "libimport", label: file.name, payload, noPlaceholder: true });
    }
    setStatus(t("lib_importQueued"));
  }

  // Enqueue one import job per URL. Webpage OR YouTube → a background job
  // (fetch/parse/whisper/format + import + enrich run headless, shown in the task list).
  // YouTube gets the full /url pipeline (cover + whisper + subtitle formatting); other
  // URLs just fetch the page text. Each item is a URL string, or {url, folder} to file
  // the import into a specific sub-folder (used by the per-channel auto-foldering below).
  function enqueueUrlImports(items) {
    for (const it of items) {
      const u = typeof it === "string" ? it : it.url;
      const folder = typeof it === "string" ? undefined : it.folder;
      enqueueBgJob({
        tabId: state.activeTabId, kind: "libimport",
        label: isYoutubeUrl(u) ? t("bg_fetchingContent") : u,
        payload: { type: isYoutubeUrl(u) ? "youtube" : "url", url: u, folder, ...importJobCommon() },
        noPlaceholder: true,
      });
    }
    setStatus(t("lib_importQueued"));
  }

  // ---- Zotero import dialog -----------------------------------------------
  // Read-only pull from the Zotero desktop LOCAL API (proxied via /api/zotero/*): pick a
  // collection → pick papers → one libimport job each (type:"zotero"). Self-contained
  // overlay (built on demand, like the move-folder popup) with a local i18n map so it
  // doesn't touch the big i18n catalog. See docs/plans/zotero-paper-library.md.
  const ZOT_I18N = {
    zh: { title: "从 Zotero 导入", all: "整个文库", loading: "正在连接 Zotero…", empty: "这个分类里没有论文",
      unreachable: "无法连接 Zotero 本地 API。请确认：① Zotero 正在运行（版本 8 或更高）；② 设置 → 高级 → 勾选“允许本机其它应用与 Zotero 通信”。",
      imported: "已导入", reimport: "重新导入", selectHint: "勾选要导入的论文", importBtn: "导入选中",
      queued: "篇已加入导入队列", close: "关闭", retry: "重试", noneSel: "先勾选至少一篇论文", pickColl: "← 选择一个分类",
      syncing: "正在同步 Zotero 批注…", syncDone: (n, c) => `批注同步完成：检查 ${n} 篇，更新 ${c} 篇`, syncNoDocs: "库中还没有 Zotero 导入的论文",
      planning: "正在比对 Zotero…", upToDate: "已与 Zotero 一致，无需同步", incrDone: (i, u) => `增量同步：新增 ${i} 篇，更新 ${u} 篇`,
      fullTitle: "⚠️ Zotero 完全同步（镜像）", fullIntro: "将使 zotero/ 目录与 Zotero 当前状态完全一致（只影响 Zotero 导入的文档）：",
      cImport: "新增导入", cUpdate: "更新元数据", cMove: "移动目录", cDelete: "删除（Zotero 中已移除）", delListLabel: "将删除以下文档：",
      fullConfirm: "执行完全同步", fullCancel: "取消", fullDone: (i, u, m, d) => `完全同步完成：新增 ${i}、更新 ${u}、移动 ${m}、删除 ${d}` },
    "zh-Hant": { title: "從 Zotero 匯入", all: "整個文庫", loading: "正在連接 Zotero…", empty: "這個分類裡沒有論文",
      unreachable: "無法連接 Zotero 本地 API。請確認：① Zotero 正在執行（版本 8 或更高）；② 設定 → 進階 → 勾選「允許本機其它應用與 Zotero 通訊」。",
      imported: "已匯入", reimport: "重新匯入", selectHint: "勾選要匯入的論文", importBtn: "匯入選中",
      queued: "篇已加入匯入佇列", close: "關閉", retry: "重試", noneSel: "先勾選至少一篇論文", pickColl: "← 選擇一個分類",
      syncing: "正在同步 Zotero 批註…", syncDone: (n, c) => `批註同步完成：檢查 ${n} 篇，更新 ${c} 篇`, syncNoDocs: "庫中還沒有 Zotero 匯入的論文",
      planning: "正在比對 Zotero…", upToDate: "已與 Zotero 一致，無需同步", incrDone: (i, u) => `增量同步：新增 ${i} 篇，更新 ${u} 篇`,
      fullTitle: "⚠️ Zotero 完全同步（鏡像）", fullIntro: "將使 zotero/ 目錄與 Zotero 目前狀態完全一致（只影響 Zotero 匯入的文件）：",
      cImport: "新增匯入", cUpdate: "更新中繼資料", cMove: "移動目錄", cDelete: "刪除（Zotero 中已移除）", delListLabel: "將刪除以下文件：",
      fullConfirm: "執行完全同步", fullCancel: "取消", fullDone: (i, u, m, d) => `完全同步完成：新增 ${i}、更新 ${u}、移動 ${m}、刪除 ${d}` },
    en: { title: "Import from Zotero", all: "Entire library", loading: "Connecting to Zotero…", empty: "No papers in this collection",
      unreachable: "Can't reach the Zotero local API. Check that: (1) Zotero is running (v8+); (2) Settings → Advanced → “Allow other applications on this computer to communicate with Zotero” is enabled.",
      imported: "imported", reimport: "re-import", selectHint: "Check the papers to import", importBtn: "Import selected",
      queued: " queued for import", close: "Close", retry: "Retry", noneSel: "Select at least one paper first", pickColl: "← Pick a collection",
      syncing: "Syncing Zotero annotations…", syncDone: (n, c) => `Annotation sync done: ${n} checked, ${c} updated`, syncNoDocs: "No Zotero-imported papers in the library yet",
      planning: "Comparing with Zotero…", upToDate: "Already in sync with Zotero", incrDone: (i, u) => `Incremental sync: ${i} imported, ${u} updated`,
      fullTitle: "⚠️ Zotero full sync (mirror)", fullIntro: "This makes the zotero/ folder exactly match Zotero's current state (only affects Zotero-imported docs):",
      cImport: "import", cUpdate: "update metadata", cMove: "move folder", cDelete: "delete (removed from Zotero)", delListLabel: "These documents will be deleted:",
      fullConfirm: "Run full sync", fullCancel: "Cancel", fullDone: (i, u, m, d) => `Full sync done: ${i} imported, ${u} updated, ${m} moved, ${d} deleted` },
  };
  const zotL = () => ZOT_I18N[getPromptLanguage()] || ZOT_I18N.zh;

  function openZoteroImport() {
    const L = zotL();
    const overlay = document.createElement("div");
    overlay.className = "zoteroImportOverlay";
    overlay.innerHTML = `
      <div class="zoteroImportDialog" role="dialog" aria-modal="true">
        <div class="zoteroImportHead">
          <span class="zoteroImportTitle">📚 ${escapeHtml(L.title)}</span>
          <button type="button" class="zoteroImportClose" title="${escapeHtml(L.close)}">✕</button>
        </div>
        <div class="zoteroImportBody">
          <div class="zoteroImportCols" id="zotColList"></div>
          <div class="zoteroImportItems" id="zotItemList"></div>
        </div>
        <div class="zoteroImportFoot">
          <span class="zoteroImportStatus" id="zotStatus"></span>
          <button type="button" class="zoteroImportGo" id="zotImportGo" disabled>${escapeHtml(L.importBtn)}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const colList = overlay.querySelector("#zotColList");
    const itemList = overlay.querySelector("#zotItemList");
    const statusEl2 = overlay.querySelector("#zotStatus");
    const goBtn = overlay.querySelector("#zotImportGo");

    const close = () => { overlay.remove(); document.removeEventListener("keydown", onKey); };
    const onKey = (e) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    overlay.querySelector(".zoteroImportClose").addEventListener("click", close);
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });   // backdrop

    let curCollection = null, curCollectionName = "";   // null = whole library
    const selected = new Map();   // itemKey → {itemKey, title, collectionName}

    const refreshGo = () => {
      goBtn.disabled = selected.size === 0;
      goBtn.textContent = selected.size ? `${L.importBtn} (${selected.size})` : L.importBtn;
    };

    async function loadCollections() {
      colList.innerHTML = `<div class="zoteroImportMsg">${escapeHtml(L.loading)}</div>`;
      let data;
      try { data = await postJson("/api/zotero/collections", {}); }
      catch { data = { ok: false }; }
      if (!data.ok) {
        colList.innerHTML = "";
        itemList.innerHTML = `<div class="zoteroImportMsg zoteroImportErr">${escapeHtml(L.unreachable)}<br><br><button type="button" class="zoteroImportRetry">${escapeHtml(L.retry)}</button></div>`;
        itemList.querySelector(".zoteroImportRetry").addEventListener("click", loadCollections);
        return;
      }
      const rows = [{ key: null, name: L.all, numItems: 0 }, ...data.collections];
      colList.innerHTML = "";
      for (const c of rows) {
        const el = document.createElement("button");
        el.type = "button";
        el.className = "zoteroCollRow";
        el.textContent = c.key === null ? c.name : `${c.name}${c.numItems ? ` (${c.numItems})` : ""}`;
        el.addEventListener("click", () => {
          [...colList.children].forEach((n) => n.classList.remove("isActive"));
          el.classList.add("isActive");
          curCollection = c.key; curCollectionName = c.key === null ? "" : c.name;
          loadItems();
        });
        colList.appendChild(el);
      }
      itemList.innerHTML = `<div class="zoteroImportMsg">${escapeHtml(L.pickColl)}</div>`;
    }

    async function loadItems() {
      itemList.innerHTML = `<div class="zoteroImportMsg">${escapeHtml(L.loading)}</div>`;
      let data;
      try { data = await postJson("/api/zotero/items", { collection: curCollection }); }
      catch { data = { ok: false }; }
      if (!data.ok) { itemList.innerHTML = `<div class="zoteroImportMsg zoteroImportErr">${escapeHtml(data.error || L.unreachable)}</div>`; return; }
      if (!data.items.length) { itemList.innerHTML = `<div class="zoteroImportMsg">${escapeHtml(L.empty)}</div>`; return; }
      itemList.innerHTML = `<div class="zoteroImportHint">${escapeHtml(L.selectHint)}</div>`;
      for (const it of data.items) {
        const row = document.createElement("label");
        row.className = "zoteroItemRow checkboxLabel";
        const meta = [it.authors, it.year, it.venue].filter(Boolean).join(" · ");
        const badge = it.imported ? `<span class="zoteroImportedBadge">${escapeHtml(L.imported)}</span>` : "";
        row.innerHTML = `<input type="checkbox" ${selected.has(it.key) ? "checked" : ""}/>
          <span class="zoteroItemMain"><span class="zoteroItemTitle">${escapeHtml(it.title || it.key)}</span>${badge}
          <span class="zoteroItemMeta">${escapeHtml(meta)}</span></span>`;
        const cb = row.querySelector("input");
        cb.addEventListener("change", () => {
          if (cb.checked) selected.set(it.key, { itemKey: it.key, title: it.title || it.key, collectionName: curCollectionName });
          else selected.delete(it.key);
          refreshGo();
        });
        itemList.appendChild(row);
      }
    }

    goBtn.addEventListener("click", () => {
      if (!selected.size) { statusEl2.textContent = L.noneSel; return; }
      let n = 0;
      for (const s of selected.values()) {
        enqueueBgJob({
          tabId: state.activeTabId, kind: "libimport", label: "📚 " + s.title,
          payload: { type: "zotero", itemKey: s.itemKey, collectionName: s.collectionName, ...importJobCommon() },
          noPlaceholder: true,
        });
        n++;
      }
      setStatus(t("lib_importQueued"));
      statusEl2.textContent = `${n} ${L.queued}`;
      close();
    });

    refreshGo();
    loadCollections();
  }

  // "🔄 Sync Zotero annotations": re-pull highlights for every Zotero-imported doc and
  // rebuild the «Zotero 批注» block where it changed (server no-ops unchanged ones).
  async function syncZoteroAnnotations() {
    const L = zotL();
    setStatus(L.syncing);
    let data;
    try { data = await postJson("/api/zotero/sync-annotations", { language: getPromptLanguage() }); }
    catch { data = { ok: false }; }
    if (!data.ok) { setStatus(data.reason === "unreachable" ? L.unreachable : (data.error || L.unreachable)); return; }
    if (!data.synced) { setStatus(L.syncNoDocs); return; }
    setStatus(L.syncDone(data.synced, data.changed));
    if (data.changed) { try { await refreshList(); } catch { /* panel closed */ } }
  }

  // Apply a sync plan: new items → bg import jobs; updates → metadata patch (server, no
  // re-import); moves → /api/library/move (grouped by target); deletes → /api/library/delete.
  async function applyZoteroPlan(plan) {
    let imported = 0, updated = 0, moved = 0, deleted = 0;
    for (const it of plan.toImport || []) {
      enqueueBgJob({
        tabId: state.activeTabId, kind: "libimport", label: "📚 " + (it.title || it.itemKey),
        payload: { type: "zotero", itemKey: it.itemKey, collectionName: it.collectionName || "", ...importJobCommon() },
        noPlaceholder: true,
      });
      imported++;
    }
    if ((plan.toUpdate || []).length) {
      const r = await postJson("/api/zotero/patch-meta", { items: plan.toUpdate.map(u => ({ docId: u.docId, itemKey: u.itemKey })) });
      updated = (r.patched || []).length;
    }
    const byDir = {};
    for (const m of plan.toMove || []) { (byDir[m.targetDir] = byDir[m.targetDir] || []).push(m.docId); }
    for (const dir of Object.keys(byDir)) { await postJson("/api/library/move", { docIds: byDir[dir], targetDir: dir }); moved += byDir[dir].length; }
    if ((plan.toDelete || []).length) {
      const r = await postJson("/api/library/delete", { docIds: plan.toDelete.map(d => d.docId) });
      deleted = (r.deleted || []).length;
    }
    return { imported, updated, moved, deleted };
  }

  // "⟳ Incremental sync" (additive, no confirm) / "⚠️ Full sync" (mirror, confirm first).
  async function zoteroSync(mode) {
    const L = zotL();
    setStatus(L.planning);
    let plan;
    try { plan = await postJson("/api/zotero/sync-plan", { mode }); }
    catch { plan = { ok: false }; }
    if (!plan.ok) { setStatus(plan.reason === "unreachable" ? L.unreachable : (plan.error || L.unreachable)); return; }
    const n = (plan.toImport || []).length + (plan.toUpdate || []).length + (plan.toDelete || []).length + (plan.toMove || []).length;
    if (!n) { setStatus(L.upToDate); return; }

    if (mode === "incremental") {
      const r = await applyZoteroPlan(plan);
      setStatus(L.incrDone(r.imported, r.updated));
      if (r.updated) { try { await refreshList(); } catch { /* closed */ } }
      return;
    }
    // full sync → confirm dialog (destructive: moves + deletes)
    openFullSyncConfirm(plan, async () => {
      setStatus(L.planning);
      const r = await applyZoteroPlan(plan);
      setStatus(L.fullDone(r.imported, r.updated, r.moved, r.deleted));
      try { await refreshList(); } catch { /* closed */ }
    });
  }

  // Confirmation overlay for full sync — counts + an expandable red delete list.
  function openFullSyncConfirm(plan, onConfirm) {
    const L = zotL();
    const nI = (plan.toImport || []).length, nU = (plan.toUpdate || []).length, nM = (plan.toMove || []).length, nD = (plan.toDelete || []).length;
    const overlay = document.createElement("div");
    overlay.className = "zoteroImportOverlay";
    const delRows = (plan.toDelete || []).map(d => `<li>${escapeHtml(d.title || d.docId)}</li>`).join("");
    overlay.innerHTML = `
      <div class="zoteroSyncDialog" role="dialog" aria-modal="true">
        <div class="zoteroImportHead"><span class="zoteroImportTitle">${escapeHtml(L.fullTitle)}</span>
          <button type="button" class="zoteroImportClose" title="${escapeHtml(L.fullCancel)}">✕</button></div>
        <div class="zoteroSyncBody">
          <p class="zoteroSyncIntro">${escapeHtml(L.fullIntro)}</p>
          <ul class="zoteroSyncCounts">
            <li>📥 ${escapeHtml(L.cImport)}: <b>${nI}</b></li>
            <li>✏️ ${escapeHtml(L.cUpdate)}: <b>${nU}</b></li>
            <li>📂 ${escapeHtml(L.cMove)}: <b>${nM}</b></li>
            <li class="${nD ? "zoteroSyncDanger" : ""}">🗑 ${escapeHtml(L.cDelete)}: <b>${nD}</b></li>
          </ul>
          ${nD ? `<details class="zoteroSyncDelList"><summary>${escapeHtml(L.delListLabel)}</summary><ul>${delRows}</ul></details>` : ""}
        </div>
        <div class="zoteroImportFoot">
          <button type="button" class="zoteroSyncCancel">${escapeHtml(L.fullCancel)}</button>
          <button type="button" class="zoteroImportGo ${nD ? "zoteroSyncGoDanger" : ""}">${escapeHtml(L.fullConfirm)}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const close = () => { overlay.remove(); document.removeEventListener("keydown", onKey); };
    const onKey = (e) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    overlay.querySelector(".zoteroImportClose").addEventListener("click", close);
    overlay.querySelector(".zoteroSyncCancel").addEventListener("click", close);
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
    overlay.querySelector(".zoteroImportGo").addEventListener("click", () => { close(); onConfirm(); });
  }

  // Resolve the target sub-folder for a video's channel when "auto-file by channel" is on.
  // Match by the channel's @handle slug against EXISTING folder leaf names (case-insensitive);
  // "first match" = the first such folder, preferring one already under youtube/. No existing
  // folder → default to youtube/<slug> (created on import). No slug (channel unknown) → "" so
  // it auto-classifies to the youtube root as before.
  function channelFolderFor(slug) {
    const s = String(slug || "").toLowerCase();
    if (!s) return "";
    const leaf = (d) => d.split("/").pop().toLowerCase();
    const matches = allDirs.filter((d) => d && leaf(d) === s);
    return matches.find((d) => d === "youtube/" + s || d.startsWith("youtube/")) || matches[0] || ("youtube/" + s);
  }

  // ---- URL-import input history (localStorage) ----------------------------
  // Recent lines the user typed into the URL modal, most recent first. Whole LINES
  // are kept — a line may carry free-text notes around the URL ("[说明] https://… [说明]"),
  // and those notes are the reason the history is useful.
  const URL_HISTORY_KEY = "heykoko-liburl-history";
  const URL_HISTORY_MAX = 20;
  const loadUrlHistory = () => {
    try { const a = JSON.parse(localStorage.getItem(URL_HISTORY_KEY) || "[]"); return Array.isArray(a) ? a : []; }
    catch { return []; }
  };
  const saveUrlHistory = (lines) => localStorage.setItem(URL_HISTORY_KEY, JSON.stringify(lines.slice(0, URL_HISTORY_MAX)));
  function addToUrlHistory(lines) {
    const hist = loadUrlHistory().filter((h) => !lines.includes(h));   // dedupe, refresh position
    saveUrlHistory([...lines, ...hist]);
  }
  const urlHistoryBox = document.querySelector("#libraryUrlHistory");
  const urlHistoryList = document.querySelector("#libraryUrlHistoryList");
  document.querySelector("#libraryUrlHistoryClear").addEventListener("click", () => {
    localStorage.removeItem(URL_HISTORY_KEY);
    renderUrlHistory();
  });
  function renderUrlHistory() {
    const hist = loadUrlHistory();
    urlHistoryBox.hidden = !hist.length;
    urlHistoryList.innerHTML = "";
    for (const line of hist) {
      const row = document.createElement("div");
      row.className = "libraryUrlHistoryItem";
      const text = document.createElement("span");
      text.className = "libraryUrlHistoryText";
      text.textContent = line;
      text.title = t("lib_urlHistoryHint");
      text.addEventListener("click", () => {   // click → append the line to the textarea
        const v = urlTextarea.value;
        urlTextarea.value = v && !v.endsWith("\n") ? `${v}\n${line}` : v + line;
        urlTextarea.focus();
      });
      const del = document.createElement("button");
      del.type = "button";
      del.className = "libraryUrlHistoryDel";
      del.textContent = "×";
      del.title = t("lib_urlHistoryDelete");
      del.addEventListener("click", (e) => {   // remove just this entry
        e.stopPropagation();
        saveUrlHistory(loadUrlHistory().filter((h) => h !== line));
        renderUrlHistory();
      });
      row.append(text, del);
      urlHistoryList.appendChild(row);
    }
  }

  // Extract the URLs from one line, tolerating free-text notes around them
  // ("[说明1] https://… [说明2]") and trailing punctuation stuck to a URL.
  const urlsInLine = (line) =>
    (line.match(/https?:\/\/\S+/g) || []).map((u) => u.replace(/[)\]}>.,;，。；、"'）】》]+$/, ""));

  // Multi-line URL import: a textarea modal so the user can type/paste one URL per line.
  function importUrl() {
    urlHint.textContent = t("lib_urlPrompt");
    urlTextarea.value = "";
    renderUrlHistory();
    urlModal.hidden = false;
    urlTextarea.focus();
  }
  function closeUrlModal() { urlModal.hidden = true; urlTextarea.value = ""; }
  function confirmUrlModal() {
    // One URL per line; notes around the URL are allowed (and remembered in history).
    const lines = urlTextarea.value.split(/\n/).map((s) => s.trim()).filter(Boolean);
    const urls = lines.flatMap(urlsInLine);
    addToUrlHistory(lines.filter((l) => urlsInLine(l).length));   // only lines that had a URL
    closeUrlModal();
    if (!urls.length) return;
    // Plain web pages import straight away; YouTube URLs (incl. channels/playlists) go
    // through a second modal that expands them into individual videos to pick from.
    const yt = urls.filter(isYoutubeUrl);
    const plain = urls.filter((u) => !isYoutubeUrl(u));
    if (plain.length) enqueueUrlImports(plain);
    if (yt.length) openYoutubeSelection(yt);
  }
  urlClose.addEventListener("click", closeUrlModal);
  urlCancel.addEventListener("click", closeUrlModal);
  urlConfirm.addEventListener("click", confirmUrlModal);
  // Deliberately NO backdrop-click-to-close: the "import URL" modal dismisses ONLY via the
  // ✕ button, the 取消 button, or Esc — so a stray click on the dimmed area never discards a
  // half-typed list of URLs. Esc is handled at the document level so it works regardless of
  // which control (or none) holds focus, not just while the textarea is focused.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !urlModal.hidden) { e.preventDefault(); closeUrlModal(); }
  });
  urlTextarea.addEventListener("keydown", (e) => {
    // Enter inserts a newline (multi-line input); Cmd/Ctrl+Enter submits.
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); confirmUrlModal(); }
  });

  // ---- YouTube video selection (expand channels/playlists → pick videos) ----
  // Extract the 11-char video id from any YouTube URL shape (watch / youtu.be / shorts / embed).
  function youtubeIdOf(u) {
    try {
      const url = new URL(u);
      const host = url.hostname.replace(/^www\./, "").toLowerCase();
      if (host === "youtu.be") { const id = url.pathname.slice(1).split("/")[0]; return /^[\w-]{11}$/.test(id) ? id : null; }
      const v = url.searchParams.get("v");
      if (v && /^[\w-]{11}$/.test(v)) return v;
      const m = url.pathname.match(/\/(?:shorts|embed|live)\/([\w-]{11})/);
      return m ? m[1] : null;
    } catch { return null; }
  }
  // Video ids already in the library (from each doc's `url:` source) → "already imported".
  function importedYoutubeIds() {
    const set = new Set();
    for (const d of docs) {
      const s = d.source || "";
      if (!s.startsWith("url:")) continue;
      const id = youtubeIdOf(s.slice(4));
      if (id) set.add(id);
    }
    return set;
  }

  let ytRows = [];   // [{id, url, title, date, imported}] currently shown in the selection modal
  let ytDrag = null; // index of the row being dragged (via its ⠿ handle), or null
  let ytFilterQ = ""; // active filter — hides non-matching rows (view only, checks survive)
  const ytMatch = (r) => !ytFilterQ
    || String(r.title || "").toLowerCase().includes(ytFilterQ)
    || String(r.url || "").toLowerCase().includes(ytFilterQ)
    || String(r.date || "").includes(ytFilterQ);
  if (ytFilter) ytFilter.addEventListener("input", () => { ytFilterQ = ytFilter.value.trim().toLowerCase(); renderYtList(); });

  function closeYtModal() { ytModal.hidden = true; ytList.innerHTML = ""; ytRows = []; ytDrag = null; ytFilterQ = ""; if (ytFilter) ytFilter.value = ""; }

  async function openYoutubeSelection(ytUrls) {
    ytRows = [];
    ytFilterQ = "";
    if (ytFilter) { ytFilter.value = ""; ytFilter.placeholder = t("lib_ytFilterPh"); }
    ytErrors.hidden = true; ytErrors.textContent = "";
    ytSelectAll.checked = false; ytSelectAll.disabled = true;
    ytReverse.disabled = true;
    ytCount.textContent = "";
    ytList.innerHTML = `<div class="libraryYtLoading">${t("lib_ytResolving")}</div>`;
    ytModal.hidden = false;
    let data;
    try {
      data = await postJson("/api/youtube-expand", { urls: ytUrls, language: getPromptLanguage() });
    } catch (e) {
      ytList.innerHTML = `<div class="libraryYtLoading">${escapeHtml(t("lib_ytExpandFailed", { error: e.message }))}</div>`;
      return;
    }
    const videos = data.videos || [];
    const errs = data.errors || [];
    if (errs.length) {
      ytErrors.hidden = false;
      ytErrors.textContent = t("lib_ytSomeErrors", { list: errs.map((e) => (e.url || "?") + "：" + e.error).join("；") });
    }
    if (!videos.length) {
      ytList.innerHTML = `<div class="libraryYtLoading">${escapeHtml(t("lib_ytNone"))}</div>`;
      return;
    }
    const imported = importedYoutubeIds();
    // `checked` is the source of truth (survives reverse/re-render); channel videos arrive
    // newest-first, so list order = publish order (newest → oldest) until the user reverses.
    // Members-only videos default to UNCHECKED — without member-account cookies they
    // would just queue up and fail; ticking one manually is still allowed.
    ytRows = videos.map((v) => ({ ...v, imported: imported.has(v.id), checked: !imported.has(v.id) && !v.memberOnly }));
    // Not-yet-imported first (checked by default); already-imported after (unchecked).
    ytRows.sort((a, b) => (a.imported === b.imported ? 0 : a.imported ? 1 : -1));
    // The 🔒 batch toggle only appears when the list actually has members-only rows.
    if (ytMemberLabel) ytMemberLabel.hidden = !ytRows.some((r) => r.memberOnly);
    renderYtList();
  }

  function renderYtList() {
    ytList.innerHTML = "";
    ytDrag = null;
    let shown = 0;
    ytRows.forEach((r, i) => {
      if (!ytMatch(r)) return;   // filtered out — state (incl. checks) survives
      shown++;
      // Canonical checkbox row (with a leading ⠿ drag handle → 3-col grid via
      // .libraryYtRow override); .isMultiline top-aligns the box and styles the
      // .checkboxRowSub date/url line.
      const row = document.createElement("label");
      row.className = "checkboxLabel isMultiline libraryYtRow" + (r.imported ? " isImported" : "");
      // Rows can be reordered by dragging the handle — list order = import order.
      // Same pattern as the bg-jobs drawer: drag is armed only by mousedown on the
      // handle, so clicking the row body just toggles the checkbox.
      const clearCue = () => row.classList.remove("ytDragOverTop", "ytDragOverBottom");
      const isAfter = (e) => { const b = row.getBoundingClientRect(); return e.clientY > b.top + b.height / 2; };
      row.draggable = false;
      row.addEventListener("dragstart", (e) => {
        ytDrag = i;
        if (e.dataTransfer) { e.dataTransfer.effectAllowed = "move"; try { e.dataTransfer.setData("text/plain", r.id); } catch {} }
      });
      row.addEventListener("dragover", (e) => {
        if (ytDrag === null || ytDrag === i) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
        const after = isAfter(e);
        row.classList.toggle("ytDragOverBottom", after);
        row.classList.toggle("ytDragOverTop", !after);
      });
      row.addEventListener("dragleave", clearCue);
      row.addEventListener("drop", (e) => {
        e.preventDefault();
        clearCue();
        const src = ytDrag;
        ytDrag = null;
        if (src === null || src === i) return;
        const [moved] = ytRows.splice(src, 1);
        // Removing an earlier row shifts this row's index down by one.
        const at = (src < i ? i - 1 : i) + (isAfter(e) ? 1 : 0);
        ytRows.splice(at, 0, moved);
        renderYtList();
      });
      row.addEventListener("dragend", () => { clearCue(); row.draggable = false; ytDrag = null; });
      row.addEventListener("mouseup", () => { row.draggable = false; });
      const handle = document.createElement("span");
      handle.className = "libraryYtHandle";
      handle.textContent = "⠿";
      handle.title = t("bg_reorder");
      // Reordering across a FILTERED view would splice against invisible neighbours —
      // hide the handle while a filter is active (order still edits fine unfiltered).
      if (ytFilterQ) handle.style.visibility = "hidden";
      handle.addEventListener("mousedown", () => { if (!ytFilterQ) row.draggable = true; });
      // A plain click on the handle would otherwise activate the label → toggle the box.
      handle.addEventListener("click", (e) => e.preventDefault());
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = r.checked;
      cb.dataset.i = String(i);
      cb.addEventListener("change", () => { r.checked = cb.checked; updateYtCount(); });
      const meta = document.createElement("div");
      meta.className = "libraryYtMeta";
      const title = document.createElement("div");
      title.className = "libraryYtTitle";
      title.textContent = (r.memberOnly ? "🔒 " : "") + (r.title || r.id);
      if (r.memberOnly) title.title = t("lib_ytMemberOnly");
      const sub = document.createElement("div");
      sub.className = "checkboxRowSub";
      // "~" marks an approximate (month-precise) date from a channel feed; playlist/
      // single-video dates are exact and shown bare. Tooltip explains the "~".
      const dateStr = r.date ? (r.approxDate ? "~" : "") + r.date : "";
      if (r.approxDate && r.date) sub.title = t("lib_ytApproxDate");
      sub.textContent = (dateStr ? dateStr + "　·　" : "") + r.url
        + (r.imported ? "　·　" + t("lib_ytImported") : "")
        + (r.memberOnly ? "　·　" + t("lib_ytMemberOnly") : "");
      meta.append(title, sub);
      row.append(handle, cb, meta);
      ytList.appendChild(row);
    });
    if (!shown && ytRows.length) ytList.innerHTML = `<div class="libraryYtLoading">${escapeHtml(t("lib_ytFilterNone"))}</div>`;
    ytSelectAll.disabled = false;
    ytReverse.disabled = false;
    updateYtCount();
  }

  function updateYtCount() {
    const vis = ytFilterQ ? ytRows.filter(ytMatch) : ytRows;
    // A filter now gates the import too, so "selected" counts only rows that will actually
    // import (checked AND visible) — same visible-scoping as select-all. No filter → all rows.
    const n = vis.filter((r) => r.checked).length;
    ytCount.textContent = t("lib_ytSelectedCount", { n, total: ytRows.length })
      + (ytFilterQ ? t("lib_ytFilterMatch", { m: vis.length }) : "");
    // With a filter active, the select-all box mirrors the VISIBLE rows only.
    ytSelectAll.checked = vis.length > 0 && vis.every((r) => r.checked);
    // Keep the 🔒 toggle in sync with the rows it governs (per-row ticks, select-all…).
    if (ytMemberToggle) {
      const mem = ytRows.filter((r) => r.memberOnly);
      ytMemberToggle.checked = mem.length > 0 && mem.every((r) => r.checked);
    }
  }

  // Select-all follows the filter: with one active it (un)ticks only the visible rows
  // ("filter 教程 → select all" selects just the tutorials).
  ytSelectAll.addEventListener("change", () => {
    ytRows.forEach((r) => { if (ytMatch(r)) r.checked = ytSelectAll.checked; });
    renderYtList();
  });
  // Batch tick/untick ONLY the members-only rows (e.g. after dropping member-account
  // cookies in, one click queues them all; or clear them out before a bulk import).
  if (ytMemberLabel) ytMemberLabel.title = t("lib_ytMemberToggleHint");
  if (ytMemberToggle) ytMemberToggle.addEventListener("change", () => {
    ytRows.forEach((r) => { if (r.memberOnly) r.checked = ytMemberToggle.checked; });
    renderYtList();
  });
  // Reverse only the CHECKED videos' order (flips their import sequence, e.g. oldest-first)
  // and push every UNCHECKED video to the bottom — the ordering only matters for what's
  // actually being imported, so unchecked rows get out of the way.
  ytReverse.addEventListener("click", () => {
    const checked = ytRows.filter((r) => r.checked).reverse();
    const unchecked = ytRows.filter((r) => !r.checked);
    ytRows = checked.concat(unchecked);
    renderYtList();
  });
  async function confirmYtModal() {
    const auto = ytAutoFolder && ytAutoFolder.checked;
    // The active "filter videos" query gates the import too: only checked rows that ALSO
    // match the current filter get queued (a checked-but-filtered-out row is skipped).
    // ytMatch is true when no filter is set, so this is a no-op without a filter.
    const picked = ytRows.filter((r) => r.checked && ytMatch(r))
      .map((r) => auto ? { url: r.url, folder: channelFolderFor(r.channelSlug) } : r.url);
    if (!picked.length) { closeYtModal(); return; }
    // Queuing many videos (a whole channel) means N× enqueue → a brief main-thread freeze.
    // Show the three-dots wait overlay (compositor-animated, keeps bouncing through the
    // freeze) and let it PAINT before the blocking enqueue loop; then close the modal.
    const overlay = document.querySelector("#libraryYtLoading");
    if (overlay) overlay.hidden = false;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    try {
      enqueueUrlImports(picked);
    } finally {
      if (overlay) overlay.hidden = true;
      closeYtModal();
    }
  }
  ytClose.addEventListener("click", closeYtModal);
  ytCancel.addEventListener("click", closeYtModal);
  ytConfirm.addEventListener("click", confirmYtModal);
  ytModal.addEventListener("click", (e) => { if (e.target === ytModal) closeYtModal(); });

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
  // Clicking the badge slides the background-task drawer over the library panel — the
  // library stays open underneath (drawer z-index sits above the overlay's) so the
  // user can flip between the two without reopening anything.
  if (taskCountEl) {
    taskCountEl.title = t("lib_taskCountHint");
    taskCountEl.addEventListener("click", () => openBgDrawer());
  }
  // Clicking anywhere on the library panel retracts the drawer (the drawer is a
  // SIBLING element, so its own clicks never bubble through here). Library-only by
  // design: in the chat view people keep the drawer open to watch generation progress
  // while typing. The ⏳ badge is excluded — its click just OPENED the drawer and
  // would otherwise close it again on the same bubble.
  overlay.addEventListener("click", (e) => {
    if (state.bgDrawerOpen && !(taskCountEl && taskCountEl.contains(e.target))) closeBgDrawer();
  });

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

  // Tag bar: most-used tags first; collapsed to the top TAGBAR_LIMIT with a "+N ▾"
  // expander — a thousand-doc library has hundreds of unique tags, and an uncapped
  // wrap would swallow half the panel. The active filter chip is never hidden.
  const TAGBAR_LIMIT = 24;
  let tagBarExpanded = false;
  function renderTagBar() {
    const counts = new Map();   // name -> { color, n: docs carrying it }
    docs.forEach((d) => (d.tags || []).forEach((tg) => {
      if (!tg || !tg.name) return;
      const e = counts.get(tg.name);
      if (e) e.n++; else counts.set(tg.name, { color: tg.color || "#e0e0e0", n: 1 });
    }));
    const entries = [...counts.entries()].sort((a, b) => (b[1].n - a[1].n) || a[0].localeCompare(b[0]));
    tagBar.innerHTML = "";
    let shown = entries;
    if (!tagBarExpanded && entries.length > TAGBAR_LIMIT) {
      shown = entries.slice(0, TAGBAR_LIMIT);
      if (activeTagFilter && counts.has(activeTagFilter) && !shown.some(([n]) => n === activeTagFilter)) {
        shown.push([activeTagFilter, counts.get(activeTagFilter)]);
      }
    }
    for (const [name, e] of shown) {
      const chip = document.createElement("span");
      chip.className = "archiveTagChip" + (activeTagFilter === name ? " isActive" : "");
      chip.textContent = name;
      chip.title = `${name} · ${e.n}`;
      chip.style.background = e.color;
      chip.addEventListener("click", () => {
        activeTagFilter = activeTagFilter === name ? null : name;
        renderTagBar();
        renderList();
      });
      tagBar.appendChild(chip);
    }
    if (entries.length > TAGBAR_LIMIT) {
      const more = document.createElement("span");
      more.className = "archiveTagChip libraryTagMore";
      more.textContent = tagBarExpanded ? t("lib_tagsCollapse") : `+${entries.length - shown.length} ▾`;
      more.addEventListener("click", () => { tagBarExpanded = !tagBarExpanded; renderTagBar(); });
      tagBar.appendChild(more);
    }
    // Library-wide tag maintenance (rename / delete a tag everywhere) — shown only
    // when there's at least one tag to manage.
    if (entries.length) {
      const manage = document.createElement("span");
      manage.className = "archiveTagChip libraryTagManage";
      manage.textContent = t("lib_tagManage");
      manage.addEventListener("click", openTagManager);
      tagBar.appendChild(manage);
    }
  }

  // Tag manager modal: lists every tag with its doc count and rename/delete actions.
  // Each op hits /api/library/tag-edit (whole-library, metadata-only) then refreshes.
  function openTagManager() {
    const counts = new Map();
    docs.forEach((d) => (d.tags || []).forEach((tg) => {
      if (tg && tg.name) counts.set(tg.name, (counts.get(tg.name) || 0) + 1);
    }));
    const back = document.createElement("div");
    back.className = "scanModalBackdrop libraryTagManagerBackdrop";
    const modal = document.createElement("div");
    modal.className = "scanModal libraryTagManager";
    const close = () => back.remove();

    const header = document.createElement("div");
    header.className = "scanModalHeader";
    const h = document.createElement("h3");
    h.className = "scanModalTitle";
    h.textContent = t("lib_tagManageTitle");
    const x = document.createElement("button");
    x.type = "button"; x.className = "scanModalClose"; x.textContent = "✕";
    x.addEventListener("click", close);
    header.append(h, x);

    const body = document.createElement("div");
    body.className = "comfyParamsBody";
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = t("lib_tagManageHint");
    body.appendChild(hint);

    const list = document.createElement("div");
    list.className = "libraryTagManagerList";
    body.appendChild(list);

    const paint = () => {
      list.innerHTML = "";
      const entries = [...counts.entries()].sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]));
      if (!entries.length) {
        const empty = document.createElement("div");
        empty.className = "archiveEmpty";
        empty.textContent = t("lib_tagNone");
        list.appendChild(empty);
        return;
      }
      for (const [name, n] of entries) {
        const row = document.createElement("div");
        row.className = "libraryTagManagerRow";
        const chip = document.createElement("span");
        chip.className = "archiveTagChip";
        chip.textContent = name;
        chip.style.background = tagColorOf(name);
        const cnt = document.createElement("span");
        cnt.className = "libraryTagManagerCount";
        cnt.textContent = t("lib_tagCount", { n });
        const spacer = document.createElement("span");
        spacer.className = "libraryTagManagerSpacer";
        const renameBtn = document.createElement("button");
        renameBtn.type = "button"; renameBtn.className = "secondary"; renameBtn.textContent = t("lib_tagRename");
        // Inline rename editor (not window.prompt, which the browser can suppress). If the
        // typed name is an EXISTING tag, saving merges the two — the Save button first
        // swaps to "Merge into «X»?" so the merge is an explicit, confirmed choice.
        renameBtn.addEventListener("click", () => {
          const input = document.createElement("input");
          input.type = "text"; input.className = "libraryTagRenameInput"; input.value = name;
          const saveBtn = document.createElement("button");
          saveBtn.type = "button"; saveBtn.className = "secondary"; saveBtn.textContent = t("lib_tagRenameSave");
          const cancelBtn = document.createElement("button");
          cancelBtn.type = "button"; cancelBtn.className = "secondary"; cancelBtn.textContent = t("lib_tagDeleteCancel");
          cancelBtn.addEventListener("click", paint);
          let armedMerge = false;
          const disarm = () => {
            if (!armedMerge) return;
            armedMerge = false;
            saveBtn.textContent = t("lib_tagRenameSave");
            saveBtn.classList.remove("libraryTagDeleteConfirm");
          };
          const doSave = () => {
            const nn = input.value.trim();
            if (!nn || nn === name) { paint(); return; }
            if (counts.has(nn) && !armedMerge) {   // collides with an existing tag → confirm the merge
              armedMerge = true;
              saveBtn.textContent = t("lib_tagMergeConfirm", { name: nn });
              saveBtn.classList.add("libraryTagDeleteConfirm");
              return;
            }
            runTagOp("rename", name, n, nn);
          };
          saveBtn.addEventListener("click", doSave);
          input.addEventListener("input", disarm);   // editing the name cancels a pending merge confirm
          input.addEventListener("keydown", (e) => {
            if (e.key === "Enter") { e.preventDefault(); doSave(); }
            else if (e.key === "Escape") paint();
          });
          chip.remove(); cnt.remove(); spacer.remove(); renameBtn.remove(); delBtn.remove();
          row.append(input, saveBtn, cancelBtn);
          input.focus(); input.select();
        });
        const delBtn = document.createElement("button");
        delBtn.type = "button"; delBtn.className = "secondary"; delBtn.textContent = t("lib_tagDelete");
        // Two-step INLINE confirm (not window.confirm, which the browser can suppress
        // after the first dialog): the Delete button swaps to "Confirm delete? / Cancel"
        // and only the second click actually deletes.
        delBtn.addEventListener("click", () => {
          const confirmBtn = document.createElement("button");
          confirmBtn.type = "button"; confirmBtn.className = "secondary libraryTagDeleteConfirm";
          confirmBtn.textContent = t("lib_tagDeleteConfirmBtn", { n });
          confirmBtn.addEventListener("click", () => runTagOp("delete", name, n));
          const cancelBtn = document.createElement("button");
          cancelBtn.type = "button"; cancelBtn.className = "secondary"; cancelBtn.textContent = t("lib_tagDeleteCancel");
          cancelBtn.addEventListener("click", paint);   // redraw the row back to normal
          renameBtn.remove(); delBtn.remove();
          row.append(confirmBtn, cancelBtn);
        });
        row.append(chip, cnt, spacer, renameBtn, delBtn);
        list.appendChild(row);
      }
    };

    // rename passes its new name from the inline editor; delete already went through the
    // inline two-step confirm. Both collision (merge) and delete are user-confirmed by here.
    const runTagOp = async (op, name, n, newName = "") => {
      newName = String(newName || "").trim();
      if (op === "rename" && (!newName || newName === name)) return;
      setStatus(t("lib_saving"));
      try {
        const r = await postJson("/api/library/tag-edit", { op, name, newName });
        if (r && r.error) throw new Error(r.error);
        setStatus(t("lib_tagEditDone", { n: r.changed || 0 }));
        await refreshList();   // pulls fresh docs → tag bar + list reflect the change
        // Recompute counts for the still-open modal from the refreshed docs.
        counts.clear();
        docs.forEach((d) => (d.tags || []).forEach((tg) => {
          if (tg && tg.name) counts.set(tg.name, (counts.get(tg.name) || 0) + 1);
        }));
        // A filter pinned to a now-renamed/deleted tag no longer matches anything.
        if (activeTagFilter && !counts.has(activeTagFilter)) { activeTagFilter = null; renderList(); }
        paint();
      } catch (e) { setStatus(t("lib_tagEditFailed", { error: e.message })); }
    };

    paint();
    modal.append(header, body);
    back.appendChild(modal);
    back.addEventListener("click", (e) => { if (e.target === back) close(); });
    document.body.appendChild(back);
  }

  // The tag bar's per-tag color (from whichever doc carries it); falls back to grey.
  function tagColorOf(name) {
    for (const d of docs) for (const tg of (d.tags || [])) if (tg && tg.name === name) return tg.color || "#e0e0e0";
    return "#e0e0e0";
  }

  // One doc card (depth indents it under its folder in the tree view).
  function createCard(d, depth) {
    const card = document.createElement("div");
    card.className = "archiveCard" + (selected.has(d.docId) ? " isSelected" : "");
    if (depth) card.style.paddingLeft = (depth * 16 + 8) + "px";
    const sc = scores && scores.has(d.docId) ? `<span class="archiveCardScore">${Math.round(scores.get(d.docId) * 100)}%</span>` : "";
    const tagsHtml = (d.tags || []).map((tg) => `<span class="archiveCardTag" style="background:${tg.color || "#e0e0e0"}">${escapeHtml(tg.name)}</span>`).join("");
    // 📇 = this doc has a distillation card (kind:"card" block leads its blocks).
    // Date: publishedAt (YouTube upload date) beats the coarser year when present.
    // ★N = the manual rating (set from the preview pane's star widget).
    const venueShort = d.venue ? (d.venue.length > 30 ? d.venue.slice(0, 30) + "…" : d.venue) : "";
    const meta = [d.hasCard ? "📇 " + d.docKind : d.docKind, d.rating ? "★" + d.rating : "", shortAuthors(d.authors), venueShort ? "📗 " + venueShort : "", d.publishedAt || d.year].filter(Boolean).join(" · ");
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
    if (ratingFilter === "unrated") list = list.filter((d) => !d.rating);
    else if (ratingFilter) list = list.filter((d) => (d.rating || 0) >= Number(ratingFilter));
    if (scores) {
      list = list.filter((d) => scores.has(d.docId)).sort((a, b) => scores.get(b.docId) - scores.get(a.docId));
    } else if (sortMode === "rate") {
      // Rating high→low; unrated sink to the end, ties keep import order (stable sort).
      list.sort((a, b) => (b.rating || 0) - (a.rating || 0));
    } else if (sortMode === "new" || sortMode === "old") {
      // Date sort applies inside each folder too (the tree below groups a pre-sorted
      // list, so node.files inherit this order). Undated docs always sink to the end.
      const dateOf = (d) => (d.publishedAt ? Date.parse(d.publishedAt) : d.importedAt) || 0;
      list.sort((a, b) => {
        const da = dateOf(a), db = dateOf(b);
        if (!da || !db) return (da ? -1 : 0) + (db ? 1 : 0);
        return sortMode === "new" ? db - da : da - db;
      });
    } else if (sortMode === "") {
      // 导入序 = newest imported first. docs arrive oldest-first (index appends), so
      // reverse puts the most recently imported at the top. The folder tree inherits it.
      list.reverse();
    }
    // sortMode === "importRev" (导入反序) → keep the natural oldest-first order (no-op).
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
    // Doc count shown next to the folder name — the whole subtree, not just direct children.
    const countDocs = (n) => n.files.length + Object.values(n.dirs).reduce((s, c) => s + countDocs(c), 0);
    const renderNode = (node, container, depth, parentPath) => {
      Object.keys(node.dirs).sort().forEach((name) => {
        const path = parentPath ? parentPath + "/" + name : name;
        const expanded = expandedDirs.has(path);
        const dirEl = document.createElement("div");
        dirEl.className = "archiveTreeDir" + (expanded ? "" : " isCollapsed");
        const header = document.createElement("div");
        header.className = "archiveTreeDirHeader";
        header.style.paddingLeft = (depth * 16 + 8) + "px";
        header.innerHTML = `<span class="archiveTreeDirArrow">${expanded ? "▼" : "▶"}</span><span class="archiveTreeDirIcon">📁</span><span class="archiveTreeDirName">${escapeHtml(name)} <span class="archiveTreeDirCount">(${countDocs(node.dirs[name])})</span></span>`;
        const content = document.createElement("div");
        content.className = "archiveTreeDirContent";
        header.addEventListener("click", () => {
          const collapsed = dirEl.classList.toggle("isCollapsed");
          header.querySelector(".archiveTreeDirArrow").textContent = collapsed ? "▶" : "▼";
          if (collapsed) expandedDirs.delete(path); else expandedDirs.add(path);
        });
        dirEl.append(header, content);
        container.appendChild(dirEl);
        renderNode(node.dirs[name], content, depth + 1, path);
      });
      node.files.forEach((d) => container.appendChild(createCard(d, depth)));
    };
    renderNode(root, listEl, 0, "");
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
  // ★ rating widget appended to the preview title. Half-star capable: each star is a
  // muted base ★ with a gold overlay clipped to 0/50/100% width; clicking a star's LEFT
  // half sets n−0.5, the right half sets n, and clicking the current value clears.
  // Persists via /api/library/rate; the list card's "★N" meta updates immediately.
  function renderPreviewStars(doc) {
    const wrap = document.createElement("span");
    wrap.className = "libDocStars";
    wrap.title = t("lib_rateHint");
    const paint = () => {
      [...wrap.children].forEach((s, idx) => {
        const frac = Math.max(0, Math.min(1, (doc.rating || 0) - idx));
        s.querySelector(".libDocStarFill").style.width = (frac * 100) + "%";
      });
    };
    for (let i = 1; i <= 5; i++) {
      const s = document.createElement("span");
      s.className = "libDocStar";
      s.textContent = "★";
      const fill = document.createElement("span");
      fill.className = "libDocStarFill";
      fill.textContent = "★";
      s.appendChild(fill);
      s.addEventListener("click", async (e) => {
        const val = e.offsetX < s.offsetWidth / 2 ? i - 0.5 : i;
        const next = (doc.rating || 0) === val ? 0 : val;
        try {
          const r = await postJson("/api/library/rate", { docId: doc.docId, rating: next });
          if (r && r.error) throw new Error(r.error);
          doc.rating = next || undefined;
          const entry = docs.find((d) => d.docId === doc.docId);
          if (entry) entry.rating = doc.rating;
          paint();
          renderList();
        } catch (e2) { setStatus(t("lib_rateFailed", { error: e2.message })); }
      });
      wrap.appendChild(s);
    }
    paint();
    previewTitle.appendChild(wrap);
  }

  async function openDoc(docId) {
    try {
      const { doc, error } = await postJson("/api/library/get", { docId });
      if (error || !doc) { alert(error || t("lib_loadFailed")); return; }
      currentDoc = doc;
      previewTitle.textContent = `${kindIcon(doc.docKind)} ${doc.title}`;
      renderPreviewStars(doc);
      previewEmpty.style.display = "none";
      preview.classList.add("isOpen");
      askScoped.disabled = false;   // enable "this doc only" scoping
      askScoped.checked = true;     // …and default to it (folder scope hidden below)
      askFolderSel.style.display = "none";
      renderBlocks(doc);
      renderRelated(docId);   // async — fills in below the toolbar when ready
      renderCitations(docId); // async — in-library cites / cited-by (P4), papers only
    } catch (e) { alert(t("lib_loadFailed") + " " + e.message); }
  }

  // "📎 Cites / 📑 Cited by" chips: in-library citation links (P4). Mirrors renderRelated.
  // Best-effort decoration — a doc with no computed citations just shows nothing.
  async function renderCitations(docId) {
    try {
      const { cites, citedBy } = await postJson("/api/library/doc-citations", { docId });
      if ((!cites || !cites.length) && (!citedBy || !citedBy.length)) return;
      if (!currentDoc || currentDoc.docId !== docId) return;
      const mkRow = (icon, labelKey, list) => {
        if (!list || !list.length) return null;
        const row = document.createElement("div");
        row.className = "libRelatedRow";
        const label = document.createElement("span");
        label.className = "libRelatedLabel";
        label.textContent = `${icon} ${t(labelKey)} (${list.length})`;
        row.appendChild(label);
        for (const c of list) {
          const chip = document.createElement("button");
          chip.type = "button";
          chip.className = "libRelatedChip";
          chip.textContent = `📄 ${c.title}${c.year ? ` ${c.year}` : ""}`;
          chip.title = c.title;
          chip.addEventListener("click", () => openDoc(c.docId));
          row.appendChild(chip);
        }
        return row;
      };
      const rows = [mkRow("📎", "lib_cites", cites), mkRow("📑", "lib_citedBy", citedBy)].filter(Boolean);
      let anchor = previewContent.querySelector(".libRelatedRow");   // after related chips if present
      anchor = anchor || previewContent.querySelector(".libraryDocToolbar");
      for (const row of rows) {
        if (anchor && anchor.nextSibling) previewContent.insertBefore(row, anchor.nextSibling);
        else previewContent.appendChild(row);
        anchor = row;
      }
    } catch (e) { console.warn("[library] citation chips failed:", e); }
  }

  // 🔗 Citation graph: the whole library's in-library citation network, drawn with the
  // shared entity-graph modal. Nodes = papers (name = title), directed edges = "cites".
  // fetchNeighborhood filters the full graph client-side so clicking a paper recenters on
  // its citation neighborhood (no extra endpoint). Run "Build citation graph" first.
  async function openCitationGraph() {
    setStatus(t("lib_planning") || "");
    let g;
    try { g = await postJson("/api/library/citation-graph", {}); }
    catch { setStatus(t("lib_citationGraphEmpty")); return; }
    setStatus("");
    if (!g || !g.ok || !g.edges || !g.edges.length) { setStatus(t("lib_citationGraphEmpty")); return; }
    const titleOf = new Map(g.nodes.map((n) => [n.docId, n.title]));
    const docIdOf = new Map(g.nodes.map((n) => [n.title, n.docId]));
    // → the modal's {nodes, edges, docs} shape (head/tail are node NAMES = titles).
    const toData = (nodes, edges) => ({
      nodes: nodes.map((n) => ({ key: n.title, name: n.title, type: "work", count: n.year || "" })),
      edges: edges.map((e) => ({ head: titleOf.get(e.from) || e.from, tail: titleOf.get(e.to) || e.to, label: t("lib_cites"), count: 1, docIds: [e.from] })),
      docs: nodes.map((n) => ({ docId: n.docId, title: n.title, docKind: n.docKind || "paper" })),
    });
    const full = toData(g.nodes, g.edges);
    openEntityGraphModal({
      data: full,
      title: () => `🔗 ${t("lib_citationGraph")} (${g.nodes.length})`,
      onOpenDoc: (docId) => { open(); openDoc(docId); },   // modal closes itself after this
      // recenter on a clicked paper: its cites + citedBy neighborhood, filtered client-side
      fetchNeighborhood: async (seeds) => {
        const seedIds = new Set(seeds.map((s) => docIdOf.get(s)).filter(Boolean));
        const keep = new Set(seedIds);
        for (const e of g.edges) { if (seedIds.has(e.from)) keep.add(e.to); if (seedIds.has(e.to)) keep.add(e.from); }
        const nodes = g.nodes.filter((n) => keep.has(n.docId));
        const edges = g.edges.filter((e) => keep.has(e.from) && keep.has(e.to));
        return { ...toData(nodes, edges), centers: seeds.map((s) => ({ name: s })) };
      },
    });
  }

  // "🔗 Related" chips under the doc toolbar: top-5 similar docs by centroid cosine,
  // computed on demand server-side. Click a chip → open that doc. Best-effort: any
  // error (or an empty library) just leaves the row out.
  async function renderRelated(docId) {
    try {
      const { related } = await postJson("/api/library/related", { docId });
      if (!related || !related.length) return;
      if (!currentDoc || currentDoc.docId !== docId) return;   // user already moved on
      const row = document.createElement("div");
      row.className = "libRelatedRow";
      const label = document.createElement("span");
      label.className = "libRelatedLabel";
      label.textContent = "🔗 " + t("lib_relatedDocs");
      row.appendChild(label);
      for (const r of related) {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "libRelatedChip";
        // score = embedding centroid cosine (may be absent for shared-entity-only hits);
        // sharedCount/sharedEntities = explainable "why related" from the structure layer.
        const scoreTxt = typeof r.score === "number" ? ` ${Math.round(r.score * 100)}%` : "";
        const sharedTxt = r.sharedCount ? ` 🔗${r.sharedCount}` : "";
        chip.textContent = `${kindIcon(r.docKind)} ${r.title}${scoreTxt}${sharedTxt}`;
        chip.title = r.sharedEntities && r.sharedEntities.length
          ? `${r.title}\n${r.sharedCount} ${t("lib_sharedEntities")}: ${r.sharedEntities.join("、")}`
          : r.title;
        chip.addEventListener("click", () => openDoc(r.docId));
        row.appendChild(chip);
      }
      // insert right after the per-doc toolbar (previewContent's first child)
      const bar = previewContent.querySelector(".libraryDocToolbar");
      if (bar && bar.nextSibling) previewContent.insertBefore(row, bar.nextSibling);
      else previewContent.appendChild(row);
    } catch (e) { console.warn("[library] related chips failed:", e); /* decoration — never block the doc view */ }
  }

  // Regenerate JUST the distillation card (metadata untouched) with the currently
  // selected chat model — the 📇 popup's "重新生成" button, for when a stronger model
  // is hooked up later. Server-side distill replaces the old card in place.
  let _cardRegenBusy = false;
  async function regenerateCard(doc) {
    if (_cardRegenBusy) return;
    _cardRegenBusy = true;
    setStatus(t("lib_regeneratingCard", { name: doc.title }));
    try {
      const r = await postJson("/api/library/distill", { docId: doc.docId, metadata: false, model: dom.modelSelect.value, language: getPromptLanguage(), timeoutS: parseInt(dom.requestTimeoutInput.value, 10) || 300 });
      if (r && r.error) throw new Error(r.error);
      setStatus("");
      await refreshList();
      openDoc(doc.docId);
    } catch (e) {
      setStatus(t("lib_distillFailed", { error: e.message }));
    } finally {
      _cardRegenBusy = false;
    }
  }

  function renderBlocks(doc) {
    previewContent.innerHTML = "";
    // One muted info row between the title and the toolbar: content date (publishedAt,
    // else year), import time, and the doc's on-disk file name (docId).
    const info = document.createElement("div");
    info.className = "libraryDocInfoLine";
    const fmtTs = (ms) => {
      const d = new Date(ms), p = (x) => String(x).padStart(2, "0");
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    };
    const parts = [];
    if (doc.publishedAt || doc.year) parts.push(`${t("lib_docPublished")} ${doc.publishedAt || doc.year}`);
    if (doc.importedAt) parts.push(`${t("lib_docImported")} ${fmtTs(doc.importedAt)}`);
    parts.push(`📄 ${doc.docId}`);
    info.textContent = parts.join("　·　");
    // Both fact rows share ONE wrapper: previewContent is a flex column with a gap, so
    // as siblings the rows would inherit that gap — wrapped, they stack tight.
    const facts = document.createElement("div");
    facts.className = "libraryDocFacts";
    facts.appendChild(info);
    // Second row: the doc's metadata — kind, authors/channel, tags, and the source
    // (clickable when it's a URL). Year is omitted here: row one already carries it.
    const metaLine = document.createElement("div");
    metaLine.className = "libraryDocInfoLine";
    const mp = [`${kindIcon(doc.docKind)} ${doc.docKind || "doc"}`];
    if (doc.authors) mp.push(doc.authors);
    if (doc.tags && doc.tags.length) mp.push("🏷 " + doc.tags.map((tg) => tg && tg.name).filter(Boolean).join("、"));
    metaLine.textContent = mp.join("　·　");
    const src = String(doc.source || "");
    if (src.startsWith("url:")) {
      const a = document.createElement("a");
      a.href = src.slice(4); a.target = "_blank"; a.rel = "noopener";
      a.className = "libraryDocSrcLink";
      a.textContent = "🔗 " + src.slice(4);
      metaLine.append("　·　", a);
    } else if (src.startsWith("file:")) {
      metaLine.append(`　·　📎 ${src.slice(5)}`);
    }
    // Zotero-imported doc → deep link back to the PDF in Zotero (opens at the attachment).
    // hey-koko has no PDF reader by design; reading/highlighting happens in Zotero.
    if (doc.zotero && doc.zotero.attachmentKey) {
      const z = document.createElement("a");
      z.href = `zotero://open-pdf/library/items/${doc.zotero.attachmentKey}`;
      z.className = "libraryDocSrcLink";
      z.textContent = "📚 " + (getPromptLanguage() === "en" ? "Open in Zotero" : "在 Zotero 中打开");
      metaLine.append("　·　", z);
    }
    facts.appendChild(metaLine);
    previewContent.appendChild(facts);
    // Per-doc toolbar: regenerate metadata + distillation card (server-side distill —
    // useful for docs imported before the card feature, or after heavy edits).
    const bar = document.createElement("div");
    bar.className = "libraryDocToolbar";
    const reBtn = document.createElement("button");
    reBtn.type = "button";
    reBtn.className = "secondary";
    reBtn.textContent = t("lib_reextract");
    reBtn.addEventListener("click", async () => {
      reBtn.disabled = true;
      setStatus(t("lib_enriching", { name: doc.title }));
      try {
        const r = await postJson("/api/library/distill", { docId: doc.docId, model: dom.modelSelect.value, language: getPromptLanguage(), timeoutS: parseInt(dom.requestTimeoutInput.value, 10) || 300 });
        if (r.error) { setStatus(t("lib_distillFailed", { error: r.error })); reBtn.disabled = false; return; }
      } catch (e) { setStatus(t("lib_distillFailed", { error: e.message })); reBtn.disabled = false; return; }
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
        // a video's transcript section is AI-reformatted speech, not verbatim → ✏️ badge;
        // the distill card is AI-generated summary/key points, not original content → 📇 badge
        if (doc.docKind === "video" && isTranscriptSection(b.section)) h.appendChild(transcriptMark(() => regenerateCard(doc)));
        else if (b.kind === "card") h.appendChild(cardMark(() => regenerateCard(doc)));
        attachSectionEdit(h, doc, b.section);
        previewContent.appendChild(h);
        lastSection = b.section;
      }
      const div = document.createElement("div");
      div.className = "libDocBlock" + (b.role === "user" ? " libDocBlockUser" : "") + (b.kind === "card" ? " libDocCard" : "");
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
        // An empty block (e.g. a Zotero paper's «Abstract» placeholder when Zotero has no
        // abstract) would collapse to zero height — tag it so it stays visible + clickable
        // with a "double-click to edit" hint the user fills in.
        const emptyCls = (b.content && b.content.trim()) ? "" : " libDocBlockEmpty";
        div.innerHTML = `<div class="markdownBody${emptyCls}"${emptyCls ? ` data-empty-hint="${escapeHtml(t("lib_emptyBlockHint"))}"` : ""}>${markdownToHtml(b.content || "")}</div>`;
        if (b.highlights && b.highlights.length) {
          const bodyEl = div.querySelector(".markdownBody");
          if (bodyEl) applyHighlights(bodyEl, b.highlights);
        }
        // Distill card: visualize its «§ 关系» section as a node-link graph ABOVE the card text
        // (above «§ 摘要»). Open/collapse state persists across articles via relGraphOpenPref.
        if (b.kind === "card") { try { const g = renderRelationGraph(b.content || "", { open: relGraphOpenPref }); if (g) { g.addEventListener("toggle", () => { relGraphOpenPref = g.open; }); div.insertBefore(g, div.firstChild); } } catch (e) { console.warn("[relGraph]", e); } }
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
    const tab = createTab(`${kindIcon(doc.docKind)} ${doc.title}`, messages);
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
    const doiInp = mkRow(t("lib_metaDoi"), doc.doi);
    // Bibliographic citation (auto-filled from Crossref on import; all editable).
    const cit = doc.citation || {};
    const venueInp = mkRow(t("lib_metaVenue"), cit.venue);
    const volumeInp = mkRow(t("lib_metaVolume"), cit.volume);
    const issueInp = mkRow(t("lib_metaIssue"), cit.issue);
    const pagesInp = mkRow(t("lib_metaPages"), cit.pages);
    const typeInp = mkRow(t("lib_metaPubType"), cit.type);
    const urlInp = mkRow(t("lib_metaUrl"), cit.url);
    const keywordsInp = mkRow(t("lib_metaKeywords"), (doc.keywords || []).join(", "));
    // DOI + citation + keywords are PAPER-ONLY — a YouTube video / blog has no journal,
    // volume, pages, etc. Show this group only when the kind is "paper", toggling live as
    // the kind dropdown changes. Inline display:none (beats the global label{display:grid}
    // trap); hidden inputs keep their loaded values so switching kind never destroys data.
    const paperRows = [doiInp, venueInp, volumeInp, issueInp, pagesInp, typeInp, urlInp, keywordsInp]
      .map((inp) => inp.closest(".libMetaRow"));
    const togglePaperRows = () => { const show = kindSel.value === "paper"; paperRows.forEach((r) => { if (r) r.style.display = show ? "" : "none"; }); };
    kindSel.addEventListener("change", togglePaperRows);
    togglePaperRows();
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
    popup.style.maxHeight = "80vh";      // many rows now → let the popup scroll instead of overflowing
    popup.style.overflowY = "auto";
    document.body.appendChild(popup);
    titleInp.focus();

    saveBtn.addEventListener("click", async () => {
      doc.title = titleInp.value.trim() || doc.title;
      doc.docKind = kindSel.value;
      doc.authors = authorsInp.value.trim();
      doc.year = yearInp.value.trim();
      doc.doi = doiInp.value.trim();
      const citation = {
        venue: venueInp.value.trim(), volume: volumeInp.value.trim(), issue: issueInp.value.trim(),
        pages: pagesInp.value.trim(), type: typeInp.value.trim(), url: urlInp.value.trim(),
      };
      // keep the doc lean: drop the citation block entirely when every field is blank
      doc.citation = Object.values(citation).some(Boolean) ? citation : undefined;
      const kws = keywordsInp.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
      doc.keywords = kws.length ? kws : undefined;
      doc.tags = tagsInp.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean).map((name) => ({ name, color: tagColor(name) }));
      popup.remove();
      setStatus(t("lib_saving"));
      try {
        await postJson("/api/library/save", { doc, model: embedModel() });
        setStatus("");
        previewTitle.textContent = `${kindIcon(doc.docKind)} ${doc.title}`;
        renderPreviewStars(doc);
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
      // The panel box stays in snippet mode — it's a quick search with its own
      // clickable snippet sources, not the read-and-answer chat command.
      const { answer, hits } = await runLibraryQuery(query, {
        docId: scopedId, folder: scopedFolder, short: true,
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
