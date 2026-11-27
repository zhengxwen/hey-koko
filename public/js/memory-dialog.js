// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

// Long-term memory dialog, opened from the "More options" tab's "Manage…" button.
// The panel only carries that button (its label shows the count); the list, the add
// row, inline editing and "Extract from chat" all live here. Every change saves at
// once — there is no OK/Cancel step, same as the tools dialog.
import { dom } from './state.js';
import { t, getPrompt } from './i18n.js';
import { escapeHtml } from './utils.js';
import { getActiveTab } from './tabs.js';
import { getLlmTimeout } from './context-meter.js';
import { getMemories, addMemory, updateMemory, removeMemory, setMemoryChangeHandler } from './memory.js';

let overlay = null;        // the open dialog's overlay, or null
let editingId = null;      // memory being edited inline — a re-render would destroy the editor
let renderPending = false; // a change arrived mid-edit; re-render once the edit ends
let selfChange = false;    // our own inline edit: patched in place instead of re-rendered
let extracting = false;    // module-level so a reopened dialog still shows "Extracting…"
let extractFlash = null;   // { key, vars } shown on the extract button for a moment
let extractFlashTimer = null;
let addFlashTimer = null;

// Enter while an IME is composing confirms the candidate — it must not submit.
const isImeEnter = (e) => e.isComposing || e.keyCode === 229;

// Panel button: "Manage… (3)". Not in i18n BINDINGS (it has a variable), so main.js
// calls this on language change; memory changes reach it through the change handler.
export function refreshMemoryManageBtn() {
  if (!dom.memoryManageBtn) return;
  dom.memoryManageBtn.textContent = t("memory_manageBtn", { count: getMemories().length });
}

/** Wire the panel button + the memory change handler. Call once, after loadMemories(). */
export function initMemoryUI() {
  // Fires on every add/edit/delete — this dialog, /memory, the remember tool, extraction.
  setMemoryChangeHandler(() => {
    refreshMemoryManageBtn();
    if (!overlay || selfChange) return;
    if (editingId) { renderPending = true; return; }
    renderList();
  });
  dom.memoryManageBtn?.addEventListener("click", openMemoryDialog);
  refreshMemoryManageBtn();
}

function syncCount() {
  const el = overlay?.querySelector(".memoryDlgCount");
  if (el) el.textContent = t("memory_count", { count: getMemories().length });
}

function syncExtractBtn() {
  const btn = overlay?.querySelector(".memoryDlgExtract");
  if (!btn) return;
  btn.disabled = extracting;
  btn.textContent = extracting ? t("memory_extracting")
    : extractFlash ? t(extractFlash.key, extractFlash.vars)
    : t("memory_extract");
}

function flashExtract(key, vars) {
  extractFlash = { key, vars };
  syncExtractBtn();
  clearTimeout(extractFlashTimer);
  extractFlashTimer = setTimeout(() => { extractFlash = null; syncExtractBtn(); }, 2500);
}

function renderList() {
  const list = overlay?.querySelector(".memoryDlgList");
  if (!list) return;
  const mems = getMemories();
  list.innerHTML = "";
  syncCount();
  if (!mems.length) {
    const empty = document.createElement("div");
    empty.className = "memoryEmpty";
    empty.textContent = t("memory_empty");
    list.appendChild(empty);
    return;
  }
  for (const m of mems) {
    const row = document.createElement("div");
    row.className = "memoryItem";

    const span = document.createElement("span");
    span.className = "memoryItemText";
    span.textContent = m.text;
    span.title = t("memory_editHint");
    span.tabIndex = 0;
    span.addEventListener("click", () => startEdit(span, m));
    span.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); startEdit(span, m); }
    });

    const del = document.createElement("button");
    del.type = "button";
    del.className = "memoryItemDelete";
    del.title = t("memory_deleteTitle");
    del.setAttribute("aria-label", t("memory_deleteTitle"));
    del.textContent = "×";
    del.addEventListener("click", () => removeMemory(m.id));

    row.append(span, del);
    list.appendChild(row);
  }
}

// Swap the row's text for an auto-growing textarea. Enter or blur saves, Escape
// cancels; clearing the text deletes the memory (updateMemory's own rule).
function startEdit(span, m) {
  if (editingId) return;
  editingId = m.id;
  const ta = document.createElement("textarea");
  ta.className = "memoryItemEdit";
  ta.rows = 1;
  ta.value = m.text;
  span.replaceWith(ta);
  const fit = () => { ta.style.height = "auto"; ta.style.height = ta.scrollHeight + "px"; };
  fit();
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);

  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    editingId = null;
    const next = ta.value.trim();
    const changed = save && next !== m.text;
    if (changed) {
      // Our own edit: patch the row in place rather than re-render, so a click that
      // caused this blur (another row's ×, say) still lands on a live element.
      selfChange = true;
      try { updateMemory(m.id, next); } finally { selfChange = false; }
    }
    const deleted = changed && !next;
    if (renderPending || deleted) {
      renderPending = false;
      renderList();
      return;
    }
    span.textContent = m.text;   // updateMemory mutates the entry in place
    if (ta.isConnected) {
      const hadFocus = document.activeElement === ta;
      ta.replaceWith(span);
      if (hadFocus) span.focus();
    }
  };

  ta.addEventListener("input", fit);
  ta.addEventListener("blur", () => finish(true));
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !isImeEnter(e)) { e.preventDefault(); finish(true); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(false); }
  });
}

export function openMemoryDialog() {
  if (overlay) return;
  overlay = document.createElement("div");
  overlay.className = "zoteroImportOverlay memoryDlgOverlay";   // reuse the modal chrome
  overlay.innerHTML = `
    <div class="zoteroImportDialog memoryDlg" role="dialog" aria-modal="true" aria-labelledby="memoryDlgTitle">
      <div class="zoteroImportHead">
        <span class="zoteroImportTitle" id="memoryDlgTitle">💭 ${escapeHtml(t("label_memory"))}</span>
        <button type="button" class="zoteroImportClose" title="${escapeHtml(t("toolsDlg_close"))}" aria-label="${escapeHtml(t("toolsDlg_close"))}">✕</button>
      </div>
      <div class="memoryDlgAdd">
        <input type="text" class="memoryDlgInput" placeholder="${escapeHtml(t("memory_placeholder"))}" autocomplete="off">
        <button type="button" class="memoryDlgAddBtn">${escapeHtml(t("memory_add"))}</button>
      </div>
      <p class="memoryDlgHint">${escapeHtml(t("memory_dlgHint"))}</p>
      <div class="memoryDlgBody"><div class="memoryDlgList"></div></div>
      <div class="zoteroImportFoot">
        <span class="zoteroImportStatus memoryDlgCount"></span>
        <button type="button" class="secondary toolsDlgMini memoryDlgExtract" title="${escapeHtml(t("memory_extractTitle"))}"></button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const input = overlay.querySelector(".memoryDlgInput");
  const addBtn = overlay.querySelector(".memoryDlgAddBtn");
  const body = overlay.querySelector(".memoryDlgBody");

  const addFromInput = () => {
    const text = input.value.trim();
    if (!text) return;
    if (addMemory(text)) {
      input.value = "";
      body.scrollTop = body.scrollHeight;   // the new entry is appended at the end
    } else {
      // Exact duplicate — keep the text so nothing looks silently swallowed.
      addBtn.textContent = t("memory_dupExact");
      clearTimeout(addFlashTimer);
      addFlashTimer = setTimeout(() => { addBtn.textContent = t("memory_add"); }, 2000);
    }
    input.focus();
  };
  addBtn.addEventListener("click", addFromInput);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !isImeEnter(e)) { e.preventDefault(); addFromInput(); }
  });
  overlay.querySelector(".memoryDlgExtract").addEventListener("click", extractFromChat);

  const close = () => {
    if (!overlay) return;
    // Closing mid-edit keeps the edit (a backdrop mousedown removes the editor before
    // its own blur would have fired).
    overlay.querySelector(".memoryItemEdit")?.blur();
    clearTimeout(addFlashTimer);
    overlay.remove();
    overlay = null;
    editingId = null;
    renderPending = false;
    document.removeEventListener("keydown", onKey);
    dom.memoryManageBtn?.focus();
  };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  overlay.querySelector(".zoteroImportClose").addEventListener("click", close);
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });

  renderList();
  syncExtractBtn();
  input.focus();
}

// Fuzzy similarity for catching near-duplicate memories (not just exact matches)
function memoryNormalize(s) {
  return s.replace(/[\s，。、,.;:!?！？「」“”"'()（）]/g, "").toLowerCase();
}
function memoryBigrams(s) {
  const g = new Set();
  if (s.length === 1) { g.add(s); return g; }
  for (let i = 0; i < s.length - 1; i++) g.add(s.slice(i, i + 2));
  return g;
}
function memoryIsSimilar(a, b) {
  const na = memoryNormalize(a), nb = memoryNormalize(b);
  if (!na || !nb) return false;
  if (na === nb || na.includes(nb) || nb.includes(na)) return true;
  const ga = memoryBigrams(na), gb = memoryBigrams(nb);
  let inter = 0;
  for (const x of ga) if (gb.has(x)) inter++;
  return inter / (ga.size + gb.size - inter) >= 0.5;
}

// Extract durable facts from the current tab's conversation into memory. Keeps running
// if the dialog is closed meanwhile; the results land through addMemory as usual.
async function extractFromChat() {
  if (extracting) return;
  const tab = getActiveTab();

  // Build a plain transcript of the real conversation (skip commands/previews/summaries)
  const transcript = (tab?.messages || [])
    .filter((m) => (m.role === "user" || m.role === "assistant")
      && !m.isFilePreview && !m.isCompactSummary
      && m.content && !/^\/(memory|compact|title|clear|note|url|imagine|[01])(\s|$)/.test(m.content))
    .slice(-40)
    .map((m) => `${m.role === "user" ? "User" : "AI"}: ${m.content.slice(0, 600)}`)
    .join("\n");

  if (!transcript.trim()) {
    flashExtract("memory_extractEmpty");
    return;
  }

  extracting = true;
  extractFlash = null;
  syncExtractBtn();

  const existing = getMemories().map((m) => `- ${m.text}`).join("\n");
  let resultKey = "memory_extractNone";
  let added = 0;
  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: dom.modelSelect.value,
        messages: [
          { role: "system", content: getPrompt("memoryExtract") },
          { role: "user", content: getPrompt("memoryExtractUser", existing, transcript) },
        ],
        options: { temperature: 0.3 },
        timeout: getLlmTimeout(),
      }),
    });
    if (!response.ok) throw new Error("request failed");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let full = "";
    const consume = (line) => {
      if (!line.trim()) return;
      try { full += JSON.parse(line).message?.content || ""; } catch {}
    };
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) consume(line);
    }
    buffer += decoder.decode();
    if (buffer.trim()) consume(buffer);

    // Strip any <think> reasoning, then parse one fact per line
    const cleaned = full.replace(/<think>[\s\S]*?<\/think>/gi, "");
    const facts = cleaned
      .split("\n")
      .map((l) => l.replace(/^[-*•\d.)\s]+/, "").trim())
      .filter((l) => l.length > 1 && l.length < 300);

    for (const f of facts) {
      const current = getMemories();
      if (current.some((m) => m.text === f)) continue; // exact dup — skip silently
      const similar = current.find((m) => memoryIsSimilar(m.text, f));
      if (similar && !confirm(t("memory_dupConfirm", { existing: similar.text, fact: f }))) continue;
      if (addMemory(f)) added++;
    }
    if (added > 0) resultKey = "memory_extractDone";
  } catch {
    /* keep "Nothing new" */
  } finally {
    extracting = false;
    flashExtract(resultKey, { count: added });
  }
}
