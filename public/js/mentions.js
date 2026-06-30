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

export function showMentionPopup(filter) {
  const f = (filter || "").toLowerCase();
  const matches = _docs
    .filter((d) => !f || (d.docId || "").toLowerCase().includes(f) || (d.title || "").toLowerCase().includes(f))
    .slice(0, 8);
  if (!matches.length) { hideMentionPopup(); return; }
  dom.mentionPopup.innerHTML = "";
  state.mentionActiveIndex = 0;
  matches.forEach((d, i) => {
    const item = document.createElement("div");
    item.className = "commandItem" + (i === 0 ? " isActive" : "");
    item.dataset.index = i;
    item.dataset.docId = d.docId;
    item.innerHTML =
      `<span class="commandItem-name">${kindIcon(d.docKind)} ${escapeHtml(d.title || d.docId)}</span>` +
      `<span class="commandItem-desc">@${escapeHtml(d.docId)}</span>`;
    item.addEventListener("click", () => { state.mentionActiveIndex = i; selectActiveMention(); });
    item.addEventListener("mouseenter", () => setMentionActive(i));
    dom.mentionPopup.appendChild(item);
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

// Replace the "@partial" at the cursor with "@<docId> " and keep typing.
export function selectActiveMention() {
  const items = dom.mentionPopup.querySelectorAll(".commandItem");
  const active = items[state.mentionActiveIndex || 0];
  const input = dom.messageInput;
  const ctx = mentionContext(input);
  if (!active || !ctx) { hideMentionPopup(); return; }
  const docId = active.dataset.docId;
  const val = input.value;
  const cursor = input.selectionStart;
  input.value = val.slice(0, ctx.start) + `@${docId} ` + val.slice(cursor);
  const pos = ctx.start + docId.length + 2;   // just past "@docId "
  input.setSelectionRange(pos, pos);
  hideMentionPopup();
  input.focus();
}

export function isMentionPopupOpen() {
  return dom.mentionPopup && !dom.mentionPopup.hidden;
}
