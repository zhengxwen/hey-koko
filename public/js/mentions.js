// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

// "@mention" autocomplete for the /ask command: typing "@" inside "/ask …" pops a
// list of library docs to scope the query to (→ "/ask @docId1 @docId2 question").
// Modeled on the slash-command popup (commands.js); reuses its .commandPopup styles.
import { dom, state } from './state.js';
import { escapeHtml } from './utils.js';

const KIND_ICON = { paper: "📄", slides: "📊", blog: "🌐", doc: "📝", other: "📎" };
const kindIcon = (k) => KIND_ICON[k] || "📎";

let _docs = [];   // cached library index entries {docId,title,docKind,…}

// Feed the cache directly (e.g. from the library panel's own list fetch, no extra round-trip).
export function setMentionDocs(docs) { if (Array.isArray(docs)) _docs = docs; }

// Human-readable full name for a docId: the source filename (file:/url: stripped),
// else the title, else the docId itself. Used to label the /ask "searching…" bubble.
export function mentionDocName(docId) {
  const d = _docs.find((x) => x.docId === docId);
  if (!d) return docId;
  return (d.source || "").replace(/^(file|url):/, "") || d.title || docId;
}

// Refresh the doc list (cheap local POST). Called on init and after library changes.
export async function loadMentionDocs() {
  try {
    const r = await fetch("/api/library/list", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    const j = await r.json();
    if (Array.isArray(j.docs)) _docs = j.docs;
  } catch { /* keep the previous list */ }
}

// If the cursor sits inside an "@partial" token within an "/ask …" line, return
// { partial, start } (start = index of the '@'); otherwise null.
export function mentionContext(input) {
  if (!input) return null;
  const val = input.value;
  if (!/^\/ask(\s|$)/.test(val) || val.includes("\n")) return null;
  const cursor = input.selectionStart;
  const before = val.slice(0, cursor);
  const m = before.match(/(?:^|\s)@(\S*)$/);   // '@' preceded by start/space, no space to cursor
  if (!m) return null;
  return { partial: m[1], start: cursor - m[1].length - 1 };
}

function setMentionActive(index) {
  const items = dom.mentionPopup.querySelectorAll(".commandItem");
  items.forEach((el, i) => el.classList.toggle("isActive", i === index));
  state.mentionActiveIndex = index;
}

// Distinct sub-folders (with every ancestor) any doc lives in — for "@folder/" scope.
function mentionFolders() {
  const set = new Set();
  for (const d of _docs) {
    const f = d.folder || "";
    if (!f) continue;
    const parts = f.split("/");
    for (let i = 1; i <= parts.length; i++) set.add(parts.slice(0, i).join("/"));
  }
  return [...set].sort();
}
function folderDocCount(folder) {
  return _docs.filter((d) => { const df = d.folder || ""; return df === folder || df.startsWith(folder + "/"); }).length;
}

export function showMentionPopup(filter) {
  const f = (filter || "").toLowerCase();
  // Folders (📁, insert "@folder/") first, then docs (📄, insert "@docId").
  const folders = mentionFolders()
    .filter((fl) => !f || fl.toLowerCase().includes(f))
    .slice(0, 6)
    .map((fl) => ({ token: fl + "/", icon: "📁", name: fl + "/", desc: `📄 ${folderDocCount(fl)}` }));
  const docs = _docs
    .filter((d) => !f || (d.docId || "").toLowerCase().includes(f) || (d.title || "").toLowerCase().includes(f))
    .slice(0, 8)
    .map((d) => ({ token: d.docId, icon: kindIcon(d.docKind), name: d.title || d.docId, desc: `@${d.docId}` }));
  const items = [...folders, ...docs];
  if (!items.length) { hideMentionPopup(); return; }
  dom.mentionPopup.innerHTML = "";
  state.mentionActiveIndex = 0;
  items.forEach((it, i) => {
    const el = document.createElement("div");
    el.className = "commandItem" + (i === 0 ? " isActive" : "");
    el.dataset.index = i;
    el.dataset.token = it.token;
    el.innerHTML =
      `<span class="commandItem-name">${it.icon} ${escapeHtml(it.name)}</span>` +
      `<span class="commandItem-desc">${escapeHtml(it.desc)}</span>`;
    el.addEventListener("click", () => { state.mentionActiveIndex = i; selectActiveMention(); });
    el.addEventListener("mouseenter", () => setMentionActive(i));
    dom.mentionPopup.appendChild(el);
  });
  dom.mentionPopup.hidden = false;
}

export function hideMentionPopup() {
  dom.mentionPopup.hidden = true;
  dom.mentionPopup.innerHTML = "";
}

export function moveMentionSelection(dir) {
  const items = dom.mentionPopup.querySelectorAll(".commandItem");
  if (!items.length) return;
  let next = (state.mentionActiveIndex || 0) + dir;
  if (next < 0) next = items.length - 1;
  if (next >= items.length) next = 0;
  setMentionActive(next);
}

// Replace the "@partial" at the cursor with "@<token> " (token = docId or "folder/").
export function selectActiveMention() {
  const items = dom.mentionPopup.querySelectorAll(".commandItem");
  const active = items[state.mentionActiveIndex || 0];
  const input = dom.messageInput;
  const ctx = mentionContext(input);
  if (!active || !ctx) { hideMentionPopup(); return; }
  const token = active.dataset.token;
  const val = input.value;
  const cursor = input.selectionStart;
  input.value = val.slice(0, ctx.start) + `@${token} ` + val.slice(cursor);
  const pos = ctx.start + token.length + 2;   // just past "@token "
  input.setSelectionRange(pos, pos);
  hideMentionPopup();
  input.focus();
}

export function isMentionPopupOpen() {
  return dom.mentionPopup && !dom.mentionPopup.hidden;
}
