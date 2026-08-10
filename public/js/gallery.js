// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

// Client side of the gallery (server/gallery.js): the view over everything the
// machine has ever generated.
//
// Media generated or attached from now on is filed on disk and lives in a message as a
// /api/gallery/file/<id> reference (see utils.js) — one copy, in the gallery. Older
// conversations still carry their pixels inline. Archived ones are moved server-side by
// scripts/migrate-archives.js, where the files already are; the ones still open in a tab
// are reachable only from here, which is what ♻️ (reclaim) is for.

import { state } from './state.js';
import { t } from './i18n.js';
import { galleryIdOf, galleryThumbUrl, inlineMediaSlots, fileInlineMedia,
         estInlineBytes } from './utils.js';
import { switchTab } from './tabs.js';
import { saveTabs } from './settings.js';
import { openArchivedChat } from './archive.js';
import { openVideoEditor } from './video-edit.js';

// ---------------------------------------------------------------------------
// The gallery view: everything ever generated, read straight off disk.
// ---------------------------------------------------------------------------

let items = [];            // current page of ledger entries
let selected = null;       // the entry shown in the detail pane
let archiveRefs = {};      // id -> [{archive, title, msgId}] (server side of the graph)
let activeFolder = null;   // folder facet: null = everything, "root" = unfiled, else a fid
let folderList = [];       // [{fid, name, n}] from /api/gallery/stats
const selectedIds = new Set();   // checkbox multi-select, for bulk move (and 🎬 later)
let deps = { renderChat: () => {}, setInput: () => {}, attachMedia: () => {} };

// Drag payload for tiles → folder chips. A custom type, so the existing Files drop
// zone (wireDropZone guards on "Files") and the composer's text/uri-list path both
// stay out of each other's way.
const DRAG_IDS_TYPE = "application/x-hk-gallery-ids";

export function setGalleryDeps(d) { deps = { ...deps, ...d }; }

const el = (id) => document.querySelector(`#${id}`);
const fmtSize = (b) => (!b ? "0 KB" : b >= 1073741824 ? `${(b / 1073741824).toFixed(1)} GB`
  : b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

function fmtDate(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// Where a given artifact is used. The live tabs live in this browser, the archives
// live on the server — each side scans what it owns and the two are merged. No
// synchronisation protocol, because neither side has to know about the other's.
// Thumbnail slots are scanned too: a bubble's inline preview can be the only reference
// to a file (galleryIdOf reads either prefix), and deleting out from under it would
// leave a blank box with no warning.
const LIVE_REF_FIELDS = ["generatedImages", "generatedVideos", "generatedMeshes", "generatedAudio",
                         "contextImages", "displayImages",
                         "generatedThumbnails", "generatedVideoThumbnails"];

function liveRefs(id) {
  const hits = [];
  for (const tab of state.tabs || []) {
    for (const msg of tab.messages || []) {
      for (const f of LIVE_REF_FIELDS) {
        const v0 = msg[f];
        const arr = Array.isArray(v0) ? v0 : typeof v0 === "string" ? [v0] : null;
        if (!arr) continue;
        if (arr.some((v) => galleryIdOf(v) === id)) {
          hits.push({ tabId: tab.id, tabTitle: tab.title, msgId: msg.id, timestamp: msg.timestamp,
                      excerpt: (msg.content || "").replace(/\s+/g, " ").slice(0, 60) });
          break;
        }
      }
    }
  }
  return hits;
}

function refsFor(id) {
  return { live: liveRefs(id), archived: archiveRefs[id] || [] };
}

// Scroll a conversation bubble into view and flash it. renderChat stamps data-msg-id
// on every bubble, which is the anchor this relies on.
function jumpToMessage(tabId, msgId) {
  closeGallery();
  if (tabId && tabId !== state.activeTabId) switchTab(tabId);
  deps.renderChat();
  // Give the render a frame, then locate the bubble.
  setTimeout(() => {
    const node = document.querySelector(`[data-msg-id="${CSS.escape(String(msgId))}"]`);
    if (!node) return;
    node.scrollIntoView({ behavior: "smooth", block: "center" });
    node.classList.add("isJumpTarget");
    setTimeout(() => node.classList.remove("isJumpTarget"), 3400);
  }, 120);
}

// The archive half of the same move. An archive has no live bubble to scroll to —
// the message ids in it are runtime-only — so this lands on the conversation's
// read-only preview in the archive panel, which is as deep as the data allows.
function jumpToArchive(filename) {
  closeGallery();
  openArchivedChat(filename);
}

// ★N for a tile, or "" when the file has never been graded. Zero is a score like any
// other and prints as ★0 — the whole point of separating it from unrated is that you
// can SEE the difference at a glance.
const ratingLabel = (r) => (r == null ? "" : `★${r}`);

// Repaint a score wherever it is currently on screen — the grid tile, the filmstrip
// frame, or both — so everything agrees with the detail pane without re-fetching. The
// strip keeps its own cached page (`stripItems`), so that copy is updated too, or the
// next refreshStrip would paint the old score back.
function paintTileRating(id, rating) {
  const setBadge = (node) => {
    if (!node) return;
    node.textContent = ratingLabel(rating);
    node.hidden = rating == null;
  };

  const tile = document.querySelector(`.galleryTile[data-id="${CSS.escape(id)}"]`);
  if (tile) {
    setBadge(tile.querySelector(".galleryRateBadge"));
    const entry = items.find((e) => e.path === id);
    const meta = tile.querySelector(".galleryTileMeta");
    // Only when the entry is still on this page — rebuilding the line from a missing
    // entry would print "NaN" where the date should be.
    if (meta && entry) meta.textContent = metaLineFor({ ...entry, rating });
  }

  const cell = document.querySelector(`.galleryStripCell[data-id="${CSS.escape(id)}"]`);
  if (cell) setBadge(cell.querySelector(".galleryStripRate"));
  const stripEntry = stripItems.find((e) => e.path === id);
  if (stripEntry) { if (rating == null) delete stripEntry.rating; else stripEntry.rating = rating; }
}

// What the file IS, for a tile caption: pixel size, and for a clip its rate and running
// time. The byte size is already on that line, so it is not repeated here. Empty for an
// entry whose specs are still unknown — which is what backfillSpecs then goes and fixes.
function specsLabel(e) {
  const bits = [];
  if (e.width && e.height) bits.push(`${e.width}×${e.height}`);
  if (e.kind === "video") {
    if (e.fps) bits.push(`${e.fps}fps`);
    if (e.length) bits.push(e.fps ? `${(e.length / e.fps).toFixed(1)}s` : `${e.length}f`);
  }
  return bits.join(" · ");
}

function metaLineFor(entry) {
  // The canonical id, not the file that ran: it is short, lowercase, and the same string
  // across quantisations, so a list of tiles reads as a list of MODELS. The exact file
  // and its precision are still one click away in the detail pane.
  return [ratingLabel(entry.rating), fmtDate(entry.ts), specsLabel(entry), fmtSize(entry.bytes),
          entry.modelId || entry.model,
          entry.prompt || entry.desc || entry.originalName].filter(Boolean).join(" · ");
}

function tileFor(entry) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "galleryTile";
  btn.dataset.id = entry.path;

  // Drag a tile onto a folder chip to file it. When the dragged tile is part of the
  // current selection the whole selection rides along — that is what a selection is for.
  btn.draggable = true;
  btn.addEventListener("dragstart", (ev) => {
    try {
      const ids = selectedIds.has(entry.path) ? [...selectedIds] : [entry.path];
      ev.dataTransfer.setData(DRAG_IDS_TYPE, JSON.stringify(ids));
      // Keep the composer's drop path working too (main.js: text/uri-list → attach).
      const url = new URL(`/api/gallery/file/${entry.path.split("/").map(encodeURIComponent).join("/")}`, location.href).href;
      ev.dataTransfer.setData("text/uri-list", url);
      ev.dataTransfer.setData("text/plain", url);
      ev.dataTransfer.effectAllowed = "copyMove";
    } catch { /* browser said no */ }
  });

  const img = document.createElement("img");
  img.loading = "lazy";
  img.alt = entry.displayName || entry.prompt || entry.originalName || entry.kind;
  img.src = galleryThumbUrl(entry.path);
  // No thumbnail and none makeable (a 3D file, or no ffmpeg for a video): say so
  // rather than showing a broken image.
  img.onerror = () => {
    img.remove();
    const ph = document.createElement("div");
    ph.className = "galleryMissing";
    ph.textContent = entry.kind === "mesh" ? "3D" : entry.kind === "audio" ? "🔊"
      : entry.kind === "video" ? "▶" : t("gal_noPreview");
    btn.prepend(ph);
  };
  btn.appendChild(img);
  if (entry.kind !== "image") {
    const badge = document.createElement("span");
    badge.className = "galleryBadge";
    // Duration comes from the ledger (length/fps), never from probing the file.
    badge.textContent = entry.kind === "video"
      ? (entry.length && entry.fps ? `▶ ${(entry.length / entry.fps).toFixed(1)}s` : "▶")
      : entry.kind === "mesh" ? "3D" : entry.kind === "audio" ? "🔊" : entry.kind;
    btn.appendChild(badge);
  }
  // Built for every tile but only shown in list view (CSS). Switching views is then
  // one attribute on the grid — no re-render, no second tile builder.
  const text = document.createElement("span");
  text.className = "galleryTileText";
  // The display name when one is set, else the full ledger id, month folder and all —
  // the tooltip always keeps the on-disk path, since that is what the row is for.
  const name = document.createElement("span");
  name.className = "galleryTileName";
  name.textContent = entry.displayName || entry.path;
  name.title = entry.path;    // the row can be narrower than the path is long
  const meta = document.createElement("span");
  meta.className = "galleryTileMeta";
  meta.textContent = metaLineFor(entry);
  text.append(name, meta);
  btn.appendChild(text);

  // Multi-select checkbox (library.js's checkbox + Set pattern). A span, not an
  // <input>: the tile is a <button> and nested interactive elements are invalid. It
  // stops propagation so ticking never opens the detail pane.
  const check = document.createElement("span");
  check.className = "galleryTileCheck";
  check.setAttribute("role", "checkbox");
  check.setAttribute("aria-checked", selectedIds.has(entry.path) ? "true" : "false");
  check.textContent = selectedIds.has(entry.path) ? "✓" : "";
  if (selectedIds.has(entry.path)) btn.classList.add("isChecked");
  check.addEventListener("click", (ev) => {
    ev.stopPropagation();
    const on = !selectedIds.has(entry.path);
    if (on) selectedIds.add(entry.path); else selectedIds.delete(entry.path);
    check.textContent = on ? "✓" : "";
    check.setAttribute("aria-checked", on ? "true" : "false");
    btn.classList.toggle("isChecked", on);
    updateBulkBar();
  });
  btn.appendChild(check);

  // The score, shown on the picture itself in the grid views (the list row reads it off
  // the meta line above). Built unconditionally and hidden while unrated, so a click in
  // the detail pane can fill it in without rebuilding the tile.
  const rateBadge = document.createElement("span");
  rateBadge.className = "galleryRateBadge";
  rateBadge.textContent = ratingLabel(entry.rating);
  rateBadge.hidden = entry.rating == null;
  btn.appendChild(rateBadge);

  btn.addEventListener("click", () => selectItem(entry.path));
  return btn;
}

// Two tile sizes plus a list. Remembered across sessions — a view preference the
// user has to set again every time is not a preference.
const VIEW_KEY = "heykoko-gallery-view";
const VIEWS = ["md", "sm", "list"];

function applyView(v) {
  const view = VIEWS.includes(v) ? v : "md";
  const grid = el("galleryGrid");
  if (grid) grid.dataset.view = view;
  try { localStorage.setItem(VIEW_KEY, view); } catch { /* private mode */ }
  return view;
}

// Normalised here, not just in applyView: a stored view that no longer exists (the
// old "lg") must not be written into the dropdown, or it lands on a blank option.
function savedView() {
  let v;
  try { v = localStorage.getItem(VIEW_KEY); } catch { /* private mode */ }
  return VIEWS.includes(v) ? v : "md";
}

// ---------------------------------------------------------------------------
// Virtual folders. A chip is three things at once: a filter (click), a drop target
// (drag tiles onto it), and — when active — the place its ✎/🗑 live. Folders are
// ledger metadata; nothing on disk moves, so references never break.
// ---------------------------------------------------------------------------

async function moveIds(ids, fid) {
  if (!ids.length) return;
  try {
    const r = await fetch("/api/gallery/move", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids, folder: fid }),
    }).then((x) => x.json());
    if (!r || r.error) throw new Error((r && r.error) || "move failed");
  } catch (e) { console.warn("[gallery] move failed:", e.message); }
  selectedIds.clear();
  updateBulkBar();
  await refresh();
}

// Accept tile drags on a chip. Same hard-won rule as wireDropZone: preventDefault on
// BOTH dragenter and dragover, or a real OS drag never delivers the drop (and a
// synthetic test event does — see the comment there).
function wireChipDrop(chip, fid) {
  const wants = (ev) => ev.dataTransfer?.types.includes(DRAG_IDS_TYPE);
  chip.addEventListener("dragover", (ev) => {
    if (!wants(ev)) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = "move";
  });
  chip.addEventListener("dragenter", (ev) => {
    if (!wants(ev)) return;
    ev.preventDefault();
    chip.classList.add("isDropTarget");
  });
  chip.addEventListener("dragleave", () => chip.classList.remove("isDropTarget"));
  chip.addEventListener("drop", (ev) => {
    if (!wants(ev)) return;
    ev.preventDefault();
    ev.stopPropagation();   // keep it away from the overlay's file-drop zone
    chip.classList.remove("isDropTarget");
    let ids = [];
    try { ids = JSON.parse(ev.dataTransfer.getData(DRAG_IDS_TYPE)) || []; } catch { /* not ours */ }
    moveIds(ids, fid);
  });
}

// Rebuilt on every refresh — a handful of chips, and the active state lives here.
function renderFolderChips() {
  const row = el("galleryFolders");
  if (!row) return;
  row.innerHTML = "";

  const chip = (label, key, fid, title) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "galleryFolderChip";
    b.textContent = label;
    if (title) b.title = title;
    b.classList.toggle("isActive", activeFolder === key);
    b.addEventListener("click", () => {
      activeFolder = activeFolder === key ? null : key;
      refresh();
    });
    // "All" is not a place, so it takes no drops; root and real folders do.
    if (key !== null) wireChipDrop(b, fid);
    row.appendChild(b);
    return b;
  };

  chip(t("gal_folderAll"), null);
  chip(`📂 ${t("gal_folderRoot")}`, "root", null, t("gal_folderRootHint"));
  for (const f of folderList) {
    const b = chip(`📁 ${f.name} (${f.n})`, f.fid, f.fid);
    if (activeFolder !== f.fid) continue;
    // Rename / delete only on the active chip — the row stays calm otherwise.
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "galleryFolderChip galleryFolderTool";
    edit.textContent = "✎";
    edit.title = t("gal_folderRename");
    edit.addEventListener("click", async () => {
      const name = prompt(t("gal_folderNamePrompt"), f.name);
      if (name == null || !name.trim() || name.trim() === f.name) return;
      await fetch("/api/gallery/folder-rename", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fid: f.fid, name: name.trim() }) });
      refresh();
    });
    const del = document.createElement("button");
    del.type = "button";
    del.className = "galleryFolderChip galleryFolderTool";
    del.textContent = "🗑";
    del.title = t("gal_folderDelete");
    del.addEventListener("click", async () => {
      if (!confirm(t("gal_folderDeleteConfirm", { name: f.name }))) return;
      await fetch("/api/gallery/folder-delete", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fid: f.fid }) });
      activeFolder = null;
      refresh();
    });
    b.after(edit, del);
  }

  const add = document.createElement("button");
  add.type = "button";
  add.className = "galleryFolderChip galleryFolderAdd";
  add.textContent = "＋";
  add.title = t("gal_folderNew");
  add.addEventListener("click", async () => {
    const name = prompt(t("gal_folderNamePrompt"));
    if (name == null || !name.trim()) return;
    // Deliberately NOT auto-activated: a fresh folder is empty, and jumping into it
    // would blank the grid — hiding the very tiles the user wants to drag into it.
    await fetch("/api/gallery/folder", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim() }) }).catch(() => null);
    refresh();
  });
  row.appendChild(add);
}

// The bulk bar under the chips: visible only while something is ticked.
function updateBulkBar() {
  const bar = el("galleryBulkBar");
  if (!bar) return;
  bar.hidden = selectedIds.size === 0;
  if (bar.hidden) { bar.innerHTML = ""; return; }
  bar.innerHTML = "";

  const count = document.createElement("span");
  count.className = "hint";
  count.textContent = t("gal_selectedN", { n: selectedIds.size });

  const move = document.createElement("select");
  move.className = "libraryRatingFilter";
  const opt = (v, label) => {
    const o = document.createElement("option");
    o.value = v; o.textContent = label;
    move.appendChild(o);
  };
  opt("", t("gal_moveTo"));
  opt("root", `📂 ${t("gal_folderRoot")}`);
  for (const f of folderList) opt(f.fid, `📁 ${f.name}`);
  move.addEventListener("change", () => {
    if (!move.value) return;
    moveIds([...selectedIds], move.value === "root" ? null : move.value);
  });

  // ✂️ — send the selected videos to the editor (trim + stitch). Enabled only when
  // the selection actually contains a video; non-videos are skipped by the editor.
  const edit = document.createElement("button");
  edit.type = "button";
  edit.className = "secondary";
  edit.textContent = `✂️ ${t("vedit_open")}`;
  const vids = [...selectedIds].filter((id) => items.find((e) => e.path === id)?.kind !== "image");
  edit.disabled = !vids.length;
  edit.addEventListener("click", () => openVideoEditor([...selectedIds]));

  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "secondary";
  clear.textContent = t("gal_clearSel");
  clear.addEventListener("click", () => {
    selectedIds.clear();
    document.querySelectorAll(".galleryTile.isChecked").forEach((n) => {
      n.classList.remove("isChecked");
      const c = n.querySelector(".galleryTileCheck");
      if (c) { c.textContent = ""; c.setAttribute("aria-checked", "false"); }
    });
    updateBulkBar();
  });

  bar.append(count, move, edit, clear);
}

// ---------------------------------------------------------------------------
// The filmstrip: the last few artifacts, kept beside the conversation.
// ---------------------------------------------------------------------------

const STRIP_KEY = "heykoko-gallery-strip";
const STRIP_LIMIT = 40;
let stripItems = [];
let flashIds = new Set();     // ids to highlight on the next strip render

const stripOpen = () => { try { return localStorage.getItem(STRIP_KEY) !== "0"; } catch { return true; } };

function setStripOpen(open) {
  const strip = el("galleryStrip");
  if (strip) strip.classList.toggle("isCollapsed", !open);
  // The switch is outside the strip (in the composer), so it has to carry the state.
  el("galleryStripToggle")?.classList.toggle("isOn", !!open);
  el("galleryStripToggle")?.setAttribute("aria-pressed", open ? "true" : "false");
  try { localStorage.setItem(STRIP_KEY, open ? "1" : "0"); } catch { /* private mode */ }
  if (open) refreshStrip();
}

// Filmstrip tooltip. A hovering user is asking "what IS this frame" — the specs answer
// that in a glance, the prompt does not (and a full video prompt fills the screen, which
// is why it comes last and clipped). Format is the extension, not the MIME type: it is
// what the file is actually called. A clip's duration is derived (frames ÷ fps) because
// that is the number in the head, while frames+fps is what the ledger records.
const TOOLTIP_PROMPT_MAX = 140;

function specLine(e) {
  const bits = [];
  const ext = (e.path.split(".").pop() || "").toUpperCase();
  if (e.width && e.height) bits.push(`${e.width}×${e.height}`);
  if (ext) bits.push(ext);
  if (e.kind === "video") {
    if (e.fps) bits.push(`${e.fps}fps`);
    // length is frames; show seconds too, since that is how the clip is discussed.
    if (e.length) bits.push(e.fps ? `${e.length}f · ${(e.length / e.fps).toFixed(1)}s` : `${e.length}f`);
  }
  if (e.bytes) bits.push(fmtSize(e.bytes));
  return bits.join(" · ");
}

function tooltipFor(entry) {
  // Filename first: it is this frame's identity, and it is the SAME name the chat calls
  // the picture by (imageNames → the manifest the model reads), so a tooltip is how you
  // match "image 2" in a draft prompt to the thumbnail in front of you. The month folder
  // is dropped — it is the same for everything on screen. A display name leads when set,
  // with the real filename kept right behind it.
  const base = entry.path.split("/").pop();
  const lines = [entry.displayName ? `${entry.displayName} · ${base}` : base, specLine(entry)];
  const model = entry.modelId || entry.model;
  if (model) lines.push(model);
  // The upload's own filename is already inside the gallery name, so only a prompt or a
  // description earns the last line.
  const text = entry.prompt || entry.desc || "";
  if (text) {
    const clipped = text.length > TOOLTIP_PROMPT_MAX
      ? `${text.slice(0, TOOLTIP_PROMPT_MAX).trimEnd()}…` : text;
    lines.push(clipped);
  }
  return lines.filter(Boolean).join("\n") || entry.path;
}

// Exposed for the test suite: the formatter is pure, so it can be checked against
// synthetic ledger entries instead of starting a render to produce a real one.
export const __tooltipFor = tooltipFor;

function stripTile(entry) {
  const url = `/api/gallery/file/${entry.path.split("/").map(encodeURIComponent).join("/")}`;
  const cell = document.createElement("div");
  cell.className = "galleryStripCell";
  cell.dataset.id = entry.path;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "galleryStripThumb";
  btn.title = tooltipFor(entry);
  const img = document.createElement("img");
  img.loading = "lazy";
  // alt is read aloud and shown when the thumbnail fails — the subject, not the specs.
  img.alt = entry.displayName || entry.prompt || entry.originalName || entry.kind;
  img.src = galleryThumbUrl(entry.path);
  img.onerror = () => { img.remove(); btn.textContent = entry.kind === "video" ? "▶" : entry.kind === "audio" ? "🔊" : "3D"; };
  btn.appendChild(img);
  // Clicking a frame opens the gallery on it — the strip is a shortcut into the
  // full view, not a second half-featured one.
  btn.addEventListener("click", () => { openGallery().then(() => selectItem(entry.path)); });

  // The composer already accepts a dropped image URL (main.js: text/uri-list →
  // imageUrlToFile → selectFile), so dragging a frame there needs no new plumbing —
  // only the right payload.
  cell.draggable = true;
  cell.addEventListener("dragstart", (ev) => {
    try {
      ev.dataTransfer.setData("text/uri-list", new URL(url, location.href).href);
      ev.dataTransfer.setData("text/plain", new URL(url, location.href).href);
      ev.dataTransfer.effectAllowed = "copy";
    } catch { /* browser said no */ }
  });

  const add = document.createElement("button");
  add.type = "button";
  add.className = "galleryStripAdd";
  add.textContent = "＋";
  add.title = t("gal_useAsRef");
  add.addEventListener("click", (ev) => {
    ev.stopPropagation();
    deps.attachMedia(url, entry.path.split("/").pop());
    add.textContent = "✓";
    setTimeout(() => { add.textContent = "＋"; }, 1200);
  });

  cell.append(btn, add);
  if (entry.kind !== "image") {
    const badge = document.createElement("span");
    badge.className = "galleryBadge";
    badge.textContent = entry.kind === "video" ? "▶" : entry.kind === "audio" ? "🔊" : "3D";
    btn.appendChild(badge);
  }
  // The score, opposite corner from the kind badge. Inside the thumb, so it rides the
  // hover zoom with the picture instead of sitting still while the frame grows.
  // Built for every frame and hidden while unrated, so rating one from the detail pane
  // fills it in without rebuilding the strip.
  const rateBadge = document.createElement("span");
  rateBadge.className = "galleryStripRate";
  rateBadge.textContent = ratingLabel(entry.rating);
  rateBadge.hidden = entry.rating == null;
  btn.appendChild(rateBadge);
  if (flashIds.has(entry.path)) cell.classList.add("isNew");
  return cell;
}

async function refreshStrip() {
  const row = el("galleryStripRow");
  if (!row || !stripOpen()) return;
  try {
    const r = await fetch(`/api/gallery/list?limit=${STRIP_LIMIT}`).then((x) => x.json());
    stripItems = r.items || [];
  } catch { return; }
  row.innerHTML = "";
  for (const e of stripItems) row.appendChild(stripTile(e));
  if (flashIds.size) {
    const first = row.querySelector(".galleryStripCell.isNew");
    // Scroll the row itself, NOT element.scrollIntoView(): that walks up and scrolls
    // every scrollable ancestor, and .chatArea is overflow:hidden — it accepts a
    // programmatic scroll, shifts the whole panel sideways, and has no scrollbar to
    // put it back. Only a reload undoes it.
    if (first) row.scrollTo({ left: Math.max(0, first.offsetLeft - row.offsetLeft - 8), behavior: "smooth" });
    // The class stays on the element; clear the set so the next refresh is calm.
    setTimeout(() => {
      flashIds.clear();
      row.querySelectorAll(".isNew").forEach((n) => n.classList.remove("isNew"));
    }, 4000);
  }
}

// ---------------------------------------------------------------------------
// Dropping files in. Bytes go up raw (POST /api/gallery/upload) rather than as
// base64 in JSON: a dropped clip can be hundreds of megabytes.
// ---------------------------------------------------------------------------

const isMediaFile = (f) => /^(image|video|audio)\//i.test(f.type || "") || /\.(glb|gltf)$/i.test(f.name || "");

async function uploadFiles(files) {
  const all = [...files];
  if (!all.length) return;
  // Drop a folder's worth of stuff and some of it will not be media. Those are
  // counted and reported, not turned into a modal — a stray .txt is not an error
  // worth blocking the drop for.
  const list = all.filter(isMediaFile);
  let added = 0, deduped = 0;
  const failed = [];
  for (const f of list) {
    try {
      const r = await fetch("/api/gallery/upload", {
        method: "POST",
        headers: { "Content-Type": f.type || "application/octet-stream",
                   "X-Gallery-Name": encodeURIComponent(f.name || "") },
        body: f,
      });
      const j = await r.json().catch(() => null);
      if (r.ok && j && j.id) { if (j.deduped) deduped++; else { added++; flashIds.add(j.id); } }
      else failed.push(`${f.name}: ${(j && j.error) || r.status}`);
    } catch (e) { failed.push(`${f.name}: ${e.message}`); }
  }
  await refresh();
  await refreshStrip();
  const note = el("galleryStats");
  if (note) {
    const parts = [t("gal_dropAdded", { n: added })];
    if (deduped) parts.push(t("gal_dropDuplicate", { n: deduped }));
    const skipped = all.length - list.length;
    if (skipped) parts.push(t("gal_dropSkipped", { n: skipped }));
    if (failed.length) parts.push(t("gal_dropFailed", { n: failed.length }));
    const was = note.textContent;
    note.textContent = parts.join(" · ");
    setTimeout(() => { if (note.textContent === parts.join(" · ")) note.textContent = was; }, 5000);
  }
  if (failed.length) console.warn("[gallery] upload failed:\n" + failed.join("\n"));
}

// Both the gallery overlay and the filmstrip take drops. Wired with one function so
// the two cannot drift apart.
function wireDropZone(node) {
  if (!node) return;
  let depth = 0;   // dragenter/leave fire for every child; count instead of guessing
  node.addEventListener("dragover", (ev) => {
    if (!ev.dataTransfer?.types.includes("Files")) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = "copy";
  });
  node.addEventListener("dragenter", (ev) => {
    if (!ev.dataTransfer?.types.includes("Files")) return;
    // preventDefault here as well as on dragover: a dragenter that is not cancelled
    // leaves this element a non-target, and a real OS drag then never delivers a
    // dragover or drop at all. (A synthetic DragEvent does, which is exactly how
    // this shipped broken while its test passed.)
    ev.preventDefault();
    depth++;
    // Read at drag time so a language switch needs no re-wiring; CSS shows it
    // through content: attr(data-drophint).
    node.dataset.drophint = t("gal_dropHint");
    node.classList.add("isDropTarget");
  });
  node.addEventListener("dragleave", () => {
    if (--depth <= 0) { depth = 0; node.classList.remove("isDropTarget"); }
  });
  node.addEventListener("drop", (ev) => {
    if (!ev.dataTransfer?.types.includes("Files")) return;
    ev.preventDefault();
    depth = 0;
    node.classList.remove("isDropTarget");
    uploadFiles(ev.dataTransfer.files);
  });
}

// Something new landed in the gallery: a finished render (image-gen.js storedSlots)
// or a file the user attached (main.js fileIntoGallery).
function onMediaAdded(ids) {
  const list = (ids || []).filter(Boolean);
  if (!list.length) return;
  flashIds = new Set(list);
  refreshStrip();
}

// Say it on the button itself: swap the label, pulse, put it back. Re-entrant clicks
// are ignored so the original label cannot be lost.
function flashLabel(btn, text, ms = 1400) {
  if (!btn || btn.dataset.flashing) return;
  const original = btn.textContent;
  btn.dataset.flashing = "1";
  btn.textContent = text;
  btn.classList.add("isFlash");
  setTimeout(() => {
    btn.textContent = original;
    btn.classList.remove("isFlash");
    delete btn.dataset.flashing;
  }, ms);
}

// navigator.clipboard exists only in a secure context — over http on a LAN address
// (not localhost) it is undefined, which is exactly when a silent no-op is most
// confusing. Fall back to the old selection trick, and report honestly if both fail.
async function copyText(s) {
  try {
    await navigator.clipboard.writeText(s);
    return true;
  } catch { /* fall through */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = s;
    ta.style.cssText = "position:fixed;top:0;left:0;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch { return false; }
}

// ★ rating for the selected artifact. Half-star capable like the library's, but with one
// deliberate difference: THREE states, not two.
//
//   unrated  — never looked at. No field in the ledger.
//   0        — looked at, it is a reject. A real score, filterable, printed as ★0.
//   0.5–5    — a grade.
//
// The library uses 0 as its clear, which makes "bad" unsayable; a gallery is a pile of
// renders where "this one is a dud" is the single most common verdict, so it gets its
// own button. Clearing therefore needs its own affordance too — the ✕, plus the usual
// click-the-current-value shortcut, which always clears rather than dropping to zero (an
// ambiguous ★1 → 0 would make the two states impossible to tell apart by feel).
function rateWidget(e) {
  const row = document.createElement("div");
  row.className = "galleryRateRow";

  const zero = document.createElement("button");
  zero.type = "button";
  zero.className = "rateZeroBtn";
  zero.textContent = "0";
  zero.title = t("gal_rateZeroHint");

  // The same star strip the library's preview title uses (.libDocStarRow / .libDocStar):
  // one control, one set of rules, so a fix to either lands in both.
  const stars = document.createElement("span");
  stars.className = "libDocStarRow";
  stars.title = t("gal_rateHint");

  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "rateClearBtn";
  clear.textContent = "✕";
  clear.title = t("gal_rateClearHint");

  const label = document.createElement("span");
  label.className = "hint galleryRateLabel";

  const paint = () => {
    const r = e.rating;
    [...stars.children].forEach((s, idx) => {
      const frac = Math.max(0, Math.min(1, (r ?? 0) - idx));
      s.querySelector(".libDocStarFill").style.width = `${frac * 100}%`;
    });
    zero.classList.toggle("isOn", r === 0);
    clear.hidden = r == null;
    label.textContent = r == null ? t("gal_rateUnrated") : t("gal_rateValue", { n: r });
  };

  // `next` is a number to score, or null to un-score. Everything here is written with
  // == null / ?? rather than truthiness, because 0 is a value.
  const send = async (next) => {
    try {
      const r = await fetch("/api/gallery/rate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: e.path, rating: next }),
      }).then((x) => x.json());
      if (!r || r.error) throw new Error((r && r.error) || "rate failed");
      e.rating = r.rating ?? null;      // `e` is the live object inside `items`
      paint();
      paintTileRating(e.path, e.rating);
      // A rating filter is on and this file may no longer belong in the list — re-run it
      // rather than leaving a row that contradicts the filter above it.
      if (el("galleryRatingFilter")?.value) refresh();
    } catch {
      label.textContent = t("gal_rateFailed");
    }
  };

  zero.addEventListener("click", () => send(e.rating === 0 ? null : 0));
  clear.addEventListener("click", () => send(null));
  for (let i = 1; i <= 5; i++) {
    const s = document.createElement("span");
    s.className = "libDocStar";
    s.textContent = "★";
    const fill = document.createElement("span");
    fill.className = "libDocStarFill";
    fill.textContent = "★";
    s.appendChild(fill);
    s.addEventListener("click", (ev) => {
      const val = ev.offsetX < s.offsetWidth / 2 ? i - 0.5 : i;
      send(e.rating === val ? null : val);
    });
    stars.appendChild(s);
  }

  paint();
  row.append(zero, stars, clear, label);
  return row;
}

function renderDetail() {
  const pane = el("galleryDetail");
  if (!pane) return;
  if (!selected) { pane.hidden = true; pane.innerHTML = ""; return; }
  const e = selected;
  const url = `/api/gallery/file/${e.path.split("/").map(encodeURIComponent).join("/")}`;
  pane.hidden = false;
  pane.innerHTML = "";

  if (e.kind !== "mesh") {   // a .glb has nothing to show without the viewer
    const tag = e.kind === "video" ? "video" : e.kind === "audio" ? "audio" : "img";
    const media = document.createElement(tag);
    media.src = url;
    if (tag !== "img") { media.controls = true; media.preload = "metadata"; }
    // A video that has not been played shows a blank rectangle until its first frame
    // is decoded. The gallery already keeps a frame grab for the grid — use it here
    // too, so the pane looks like the thumbnail the user just clicked.
    if (tag === "video") {
      media.poster = galleryThumbUrl(e.path);
    }
    pane.appendChild(media);
  }

  pane.appendChild(rateWidget(e));

  // The display name: rename without touching the disk. Same commit discipline as the
  // description below — change saves, Escape restores, the label spells the rule out.
  const nameLabel = document.createElement("p");
  // Its own class (.galleryNameHead), not .galleryDescHead — the description's label
  // is targeted by that class elsewhere and this one must not shadow it.
  nameLabel.className = "hint galleryNameHead";
  nameLabel.textContent = t("gal_name");
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.className = "galleryRenameInput";
  nameInput.value = e.displayName || "";
  nameInput.placeholder = t("gal_namePlaceholder");
  nameInput.addEventListener("change", async () => {
    const text = nameInput.value.trim();
    if (text === (e.displayName || "")) return;
    try {
      const r = await fetch("/api/gallery/rename", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: e.path, name: text }) }).then((x) => x.json());
      if (r && r.ok) {
        if (r.displayName) e.displayName = r.displayName; else delete e.displayName;   // `e` is the live object in `items`
        nameLabel.textContent = `${t("gal_name")} · ${t("gal_descSaved")}`;
        setTimeout(() => { nameLabel.textContent = t("gal_name"); }, 1800);
        // Repaint the copies already on screen without a refetch.
        const tile = document.querySelector(`.galleryTile[data-id="${CSS.escape(e.path)}"]`);
        const nameEl = tile?.querySelector(".galleryTileName");
        if (nameEl) nameEl.textContent = e.displayName || e.path;
        const cell = document.querySelector(`.galleryStripCell[data-id="${CSS.escape(e.path)}"] .galleryStripThumb`);
        if (cell) cell.title = tooltipFor(e);
      }
    } catch { /* the box keeps the text; the next blur retries */ }
  });
  nameInput.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape") return;
    nameInput.value = e.displayName || "";
    nameInput.blur();
    ev.stopPropagation();
    ev.preventDefault();
  });
  nameInput.addEventListener("focus", () => { nameLabel.textContent = `${t("gal_name")} · ${t("gal_descHint")}`; });
  nameInput.addEventListener("blur", () => {
    if (nameLabel.textContent.includes(t("gal_descHint"))) nameLabel.textContent = t("gal_name");
  });
  pane.append(nameLabel, nameInput);

  // The prompt is provenance — what actually produced this file, and what "Run it
  // again" reloads — so it is shown as-is and not editable.
  if (e.prompt) {
    const p = document.createElement("p");
    p.className = "galleryDetailPrompt";
    p.textContent = e.prompt;
    pane.appendChild(p);
  }

  // The description is the editable half: whatever the user wants to be able to find
  // this by later. Search matches it alongside the prompt and the original filename.
  const descLabel = document.createElement("p");
  // Its own class, not .galleryRefsHead: same look, but the reference groups below
  // are counted by that selector.
  descLabel.className = "hint galleryDescHead";
  descLabel.textContent = t("gal_desc");
  const desc = document.createElement("textarea");
  desc.className = "galleryDesc";
  desc.rows = 2;
  desc.value = e.desc || "";
  desc.placeholder = t("gal_descPlaceholder");
  // Saved on blur rather than per keystroke: every save appends a ledger line, and
  // one line per character typed would be absurd. Escape throws the edit away
  // (same as the tab-title rename in main.js). While it has focus the label spells
  // both of those out — an invisible commit rule is a trap.
  desc.addEventListener("change", async () => {
    const text = desc.value.trim();
    if (text === (e.desc || "")) return;
    try {
      const r = await fetch("/api/gallery/describe", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: e.path, desc: text }) }).then((x) => x.json());
      if (r && r.ok) {
        e.desc = r.desc;                                  // `e` is the live object in `items`
        descLabel.textContent = `${t("gal_desc")} · ${t("gal_descSaved")}`;
        setTimeout(() => { descLabel.textContent = t("gal_desc"); }, 1800);
      }
    } catch { /* the box keeps the text; the next blur retries */ }
  });
  desc.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape") return;
    // Put the saved text back BEFORE blurring: restoring the value the field had at
    // focus is also what stops the browser from firing `change` on the way out.
    desc.value = e.desc || "";
    desc.blur();
    // Nothing else in the gallery listens for Escape, but the document does (it stops
    // speech) — this key press was about this box.
    ev.stopPropagation();
    ev.preventDefault();
  });
  desc.addEventListener("focus", () => {
    descLabel.textContent = `${t("gal_desc")} · ${t("gal_descHint")}`;
  });
  desc.addEventListener("blur", () => {
    // Leave a "saved" flash alone; only clear the hint we put up on focus.
    if (descLabel.textContent.includes(t("gal_descHint"))) descLabel.textContent = t("gal_desc");
  });
  pane.append(descLabel, desc);

  const dl = document.createElement("dl");
  const rows = [
    // Both, because they answer different questions: the id is what to type after -m,
    // the filename is what to reproduce with.
    [t("gal_fModel"), e.modelId || e.model],
    [t("gal_fModelFile"), e.modelId && e.model && e.model !== e.modelId ? e.model : ""],
    [t("gal_fSeed"), e.seed],
    [t("gal_fSize"), e.width && e.height ? `${e.width}×${e.height}` : ""],
    // Frames are what the ledger stores and what a render is configured in; seconds are
    // what the clip is actually discussed in. Show both rather than making anyone divide.
    [t("gal_fLength"), e.kind === "video" && e.length
      ? `${e.length}f${e.fps ? ` @${e.fps}fps · ${(e.length / e.fps).toFixed(1)}s` : ""}` : ""],
    [t("gal_fPrecision"), e.precisionUsed],
    [t("gal_fWhen"), fmtDate(e.ts)],
    [t("gal_fBytes"), fmtSize(e.bytes)],
    [t("gal_fFolder"), e.folder ? (folderList.find((f) => f.fid === e.folder)?.name || "") : ""],
    [t("gal_fFile"), e.path],
  ];
  for (const [k, v] of rows) {
    if (v === undefined || v === null || v === "") continue;
    const dt = document.createElement("dt"); dt.textContent = k;
    const dd = document.createElement("dd"); dd.textContent = String(v);
    dl.append(dt, dd);
  }
  pane.appendChild(dl);

  const actions = document.createElement("div");
  actions.className = "galleryActions";
  const act = (label, fn, title) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "secondary"; b.textContent = label;
    if (title) b.title = title;
    b.addEventListener("click", fn);
    actions.appendChild(b);
    return b;
  };
  // Send it back into the conversation as an attachment — the point of having the
  // gallery open next to the chat at all. Closes the overlay so the composer is there.
  if (e.kind !== "mesh") act(t("gal_useAsRef"), () => {
    deps.attachMedia(url, e.path.split("/").pop());
    closeGallery();
  }, t("gal_useAsRefHint"));
  // Copying puts nothing on screen, so the button has to say it happened — and say
  // it plainly when it did not.
  if (e.prompt) {
    const copyBtn = act(t("gal_copyPrompt"), async () => {
      flashLabel(copyBtn, (await copyText(e.prompt)) ? t("gal_copied") : t("gal_copyFailed"));
    });
  }
  // Re-run fills the composer and stops: a render costs real GPU minutes, so the
  // user presses Enter, not us.
  if (e.prompt) act(t("gal_rerun"), () => {
    const seedFlag = e.seed !== undefined && e.seed !== null ? ` --seed ${e.seed}` : "";
    deps.setInput(`/imagine ${e.prompt}${seedFlag}`);
    closeGallery();
  }, t("gal_rerunHint"));
  // ✂️ — trim/stitch this clip (and any others picked in the editor's lane later).
  if (e.kind === "video") act(`✂️ ${t("vedit_open")}`, () => openVideoEditor([e.path]), t("vedit_openHint"));
  act(t("gal_reveal"), async () => {
    await fetch("/api/gallery/reveal", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: e.path }) });
  });
  act(t("gal_delete"), () => deleteItem(e));
  // Last: it is an <a download>, not a button, and the odd one out belongs at the end.
  const dl2 = document.createElement("a");
  dl2.className = "secondary"; dl2.href = url; dl2.download = e.path.split("/").pop();
  dl2.textContent = t("gal_download");
  dl2.style.cssText = "font-size:12px;display:inline-flex;align-items:center;padding:4px 10px;text-decoration:none";
  actions.appendChild(dl2);
  pane.appendChild(actions);

  // Where it is used. Open conversations and archives are two different places, so
  // they are listed separately instead of being added up into a single meaningless
  // count. Both are clickable; they land in different places (a live bubble vs. the
  // archive panel's preview).
  const refs = refsFor(e.path);
  const group = (labelKey, list, render) => {
    const h = document.createElement("p");
    h.className = "hint galleryRefsHead";
    h.textContent = t(labelKey, { n: list.length });
    pane.appendChild(h);
    const ul = document.createElement("ul");
    ul.className = "galleryRefs";
    if (!list.length) {
      const li = document.createElement("li");
      li.className = "galleryRefStatic";
      li.textContent = t("gal_none");
      ul.appendChild(li);
    } else for (const r of list) ul.appendChild(render(r));
    pane.appendChild(ul);
  };

  group("gal_refsTabs", refs.live, (r) => {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = `💬 ${r.tabTitle || t("gal_untitledChat")}${r.excerpt ? ` · ${r.excerpt}` : ""}`;
    b.title = t("gal_jumpHint");
    b.addEventListener("click", () => jumpToMessage(r.tabId, r.msgId));
    li.appendChild(b);
    return li;
  });
  group("gal_refsArchives", refs.archived, (r) => {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = `🗄️ ${r.title || r.archive}`;
    b.title = t("gal_jumpArchiveHint", { file: r.archive });
    b.addEventListener("click", () => jumpToArchive(r.archive));
    li.appendChild(b);
    return li;
  });
  if (e.conversationId && !refs.live.length && !refs.archived.length) {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = t("gal_sourceGone");
    pane.appendChild(p);
  }
}

// Specs an entry should have but doesn't. Older items predate the ledger recording
// them — an upload from before the browser measured its pictures, a clip the history
// migration pulled out of an archive — and the ledger cannot invent them.
function specsMissing(e) {
  if (!e) return false;
  const want = e.kind === "video" ? ["width", "height", "fps", "length"] : ["width", "height"];
  return e.kind !== "mesh" && e.kind !== "audio" && want.some((k) => !e[k]);
}

// Ask the server to ffprobe an item whose specs are incomplete, then repaint. Opening
// an item is exactly the right moment: the user is looking at it, the file is local, and
// the answer is recorded so it only ever happens once per item. Asked at most once per
// session per item, so an item ffprobe genuinely cannot read (no ffprobe installed, an
// exotic container) doesn't re-ask on every click.
const probed = new Set();
async function backfillSpecs(entry) {
  if (!entry || probed.has(entry.path) || !specsMissing(entry)) return;
  probed.add(entry.path);
  try {
    const r = await fetch("/api/gallery/probe", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: entry.path }),
    });
    const j = await r.json();
    if (!j || !j.entry) return;
    // Update every copy AND everything already painted from it: the page list, its
    // tile caption, the filmstrip cache and its tooltip, and the open detail pane. Same
    // discipline the ★ rating needs — patch the caches or the next refresh paints the
    // old values back, repaint the DOM or the user has to reopen the gallery to see it.
    const merged = { ...entry, ...j.entry };
    const patch = (arr) => { const i = arr.findIndex((e) => e.path === entry.path); if (i >= 0) arr[i] = { ...arr[i], ...j.entry }; };
    patch(items);
    patch(stripItems);
    const tile = document.querySelector(`.galleryTile[data-id="${CSS.escape(entry.path)}"]`);
    const meta = tile && tile.querySelector(".galleryTileMeta");
    if (meta) meta.textContent = metaLineFor(items.find((e) => e.path === entry.path) || merged);
    const cell = document.querySelector(`.galleryStripCell[data-id="${CSS.escape(entry.path)}"] .galleryStripThumb`);
    if (cell) cell.title = tooltipFor(merged);
    if (selected && selected.path === entry.path) { selected = merged; renderDetail(); }
  } catch { /* offline or no ffprobe — the item simply keeps showing what it knows */ }
}

function selectItem(id) {
  selected = items.find((e) => e.path === id) || null;
  document.querySelectorAll(".galleryTile").forEach((n) => n.classList.toggle("isSelected", n.dataset.id === id));
  renderDetail();
  backfillSpecs(selected);
}

async function deleteItem(entry) {
  const refs = refsFor(entry.path);
  const n = refs.live.length + refs.archived.length;
  if (!confirm(n ? t("gal_confirmDeleteUsed", { n }) : t("gal_confirmDelete"))) return;
  await fetch("/api/gallery/delete", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: [entry.path] }) });
  selected = null;
  selectedIds.delete(entry.path);
  await refresh();
  await refreshStrip();
}

// ♻️ — media that is still stored INSIDE the open conversations. Each slot is filed into
// the gallery and replaced by a reference, so the picture ends up in one place rather
// than two: on disk, and base64-inflated a second time inside IndexedDB. Nothing is
// deleted and nothing leaves the machine — this only moves bytes out of the tab record.
//
// New attachments and renders already store references, and an import files its media on
// the way in. This is for conversations written before any of that, and for the
// occasional slot whose upload lost the race at send time. The sweep itself lives in
// utils.js (fileInlineMedia) because the import path runs the very same pass.
async function reclaim() {
  const msgs = (state.tabs || []).flatMap((tab) => tab.messages || []);
  const slots = inlineMediaSlots(msgs);
  if (!slots.length) { alert(t("gal_reclaimNone")); return; }
  const total = slots.reduce((n, s) => n + estInlineBytes(s.v), 0);
  if (!confirm(t("gal_reclaimConfirm", { n: slots.length, size: fmtSize(total) }))) return;

  const stats = el("galleryStats");
  const { filed, failed, freed } = await fileInlineMedia(msgs, (done, n) => {
    if (stats) stats.textContent = t("gal_reclaimProgress", { done, total: n });
  });
  saveTabs();
  deps.renderChat();
  await refresh();
  await refreshStrip();
  if (stats) {
    stats.textContent = t("gal_reclaimDone", { n: filed, size: fmtSize(freed) })
      + (failed ? ` · ${t("gal_reclaimFailed", { n: failed })}` : "");
  }
}

// 🧹 — the outlet for media kept when a conversation was deleted. Everything the
// reference graph cannot account for is offered up in one place.
async function tidy() {
  await loadArchiveRefs();
  const all = await fetch("/api/gallery/list?limit=500").then((r) => r.json());
  const orphans = (all.items || []).filter((e) => {
    const r = refsFor(e.path);
    return !r.live.length && !r.archived.length;
  });
  if (!orphans.length) { alert(t("gal_tidyNone")); return; }
  const bytes = orphans.reduce((n, e) => n + (e.bytes || 0), 0);
  if (!confirm(t("gal_tidyConfirm", { n: orphans.length, size: fmtSize(bytes) }))) return;
  await fetch("/api/gallery/delete", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: orphans.map((e) => e.path) }) });
  await fetch("/api/gallery/compact", { method: "POST" });
  selected = null;
  selectedIds.clear();
  await refresh();
  await refreshStrip();
}

async function loadArchiveRefs() {
  try {
    const r = await fetch("/api/gallery/refs").then((x) => x.json());
    archiveRefs = (r && r.archives) || {};
  } catch { archiveRefs = {}; }
}

async function refresh() {
  const q = el("gallerySearch")?.value.trim() || "";
  const type = el("galleryTypeFilter")?.value || "";
  const source = el("gallerySourceFilter")?.value || "";
  const model = el("galleryModelFilter")?.value || "";
  const rating = el("galleryRatingFilter")?.value || "";
  const params = new URLSearchParams({ limit: "200" });
  if (q) params.set("q", q);
  if (type) params.set("type", type);
  // Server-side for the same reason as the model facet: filtering before the page limit
  // is what makes "show me everything I rated ★4+" a real query rather than a narrowing
  // of whichever 200 came back.
  if (rating) params.set("rating", rating);
  // Server-side (unlike the source filter): the ledger is the only place that knows every
  // entry's model, and filtering before the page limit is what makes it a real filter
  // rather than a narrowing of whatever 200 happened to come back.
  if (model) params.set("model", model);
  if (activeFolder) params.set("folder", activeFolder);
  const [list, stats] = await Promise.all([
    fetch(`/api/gallery/list?${params}`).then((r) => r.json()).catch(() => ({ items: [] })),
    fetch("/api/gallery/stats").then((r) => r.json()).catch(() => null),
  ]);
  const all = list.items || [];
  // The source filter is applied here rather than server-side: half the reference
  // graph (the open conversations) only exists in this browser, so the server could
  // not answer it. Note it runs after the fetch limit, so it narrows a page rather
  // than paging through matches.
  items = !source ? all : all.filter((e) => {
    const r = refsFor(e.path);
    return source === "tabs" ? r.live.length > 0 : r.archived.length > 0;
  });

  folderList = (stats && Array.isArray(stats.folders)) ? stats.folders : folderList;
  // The active folder can vanish under us (deleted from another window): fall back
  // to "everything" rather than filtering by a fid that matches nothing forever.
  if (activeFolder && activeFolder !== "root" && !folderList.some((f) => f.fid === activeFolder)) activeFolder = null;
  renderFolderChips();
  updateBulkBar();

  const grid = el("galleryGrid");
  if (grid) {
    grid.innerHTML = "";
    if (!items.length) {
      const empty = document.createElement("p");
      empty.className = "hint";
      // "Nothing matches", "this folder is empty", and "nothing exists" are three
      // different things to be told.
      empty.textContent = all.length ? t("gal_noneMatch")
        : activeFolder ? t("gal_folderEmpty") : t("gal_empty");
      grid.appendChild(empty);
    }
    for (const e of items) grid.appendChild(tileFor(e));
  }

  // Refill the model facet from the ledger-wide counts. Rebuilt each refresh (a new
  // render adds models) but only when the option set actually changed, so the user's
  // current pick is not dropped mid-interaction.
  const modelSel = el("galleryModelFilter");
  if (modelSel && stats && Array.isArray(stats.models)) {
    const want = ["", ...stats.models.map((m) => m.id)].join("\u0000");
    if (modelSel.dataset.built !== want) {
      const keep = modelSel.value;
      modelSel.innerHTML = "";
      const any = document.createElement("option");
      any.value = ""; any.textContent = t("gal_allModels");
      modelSel.appendChild(any);
      for (const m of stats.models) {
        const o = document.createElement("option");
        o.value = m.id; o.textContent = `${m.id} (${m.n})`;
        modelSel.appendChild(o);
      }
      // A model can vanish from the list (its last file deleted) while it is the active
      // filter — falling back to "all" beats leaving a selection that matches nothing.
      modelSel.value = [...modelSel.options].some((o) => o.value === keep) ? keep : "";
      modelSel.dataset.built = want;
    }
  }

  const statsEl = el("galleryStats");
  if (statsEl && stats) {
    // The stats line describes the whole gallery; say so separately when the view
    // is showing a subset, otherwise the numbers look like they disagree with the grid.
    statsEl.textContent = t("gal_stats", {
      n: stats.count, size: fmtSize(stats.bytes),
      images: stats.images, videos: stats.videos,
      thumbs: fmtSize(stats.thumbBytes),
    }) + ((source || model || rating || activeFolder) ? ` · ${t("gal_shown", { n: items.length })}` : "");
  }

  if (selected && !items.some((e) => e.path === selected.path)) { selected = null; }
  renderDetail();
}

export async function openGallery() {
  const overlay = el("galleryOverlay");
  if (!overlay) return;
  overlay.classList.add("isOpen");
  await loadArchiveRefs();
  await refresh();
}

export function closeGallery() {
  el("galleryOverlay")?.classList.remove("isOpen");
  // Whatever happened in there — imports, deletes, a tidy — the strip is the view
  // that stays on screen, so it re-reads on the way out.
  refreshStrip();
}

export function initGallery() {
  el("galleryBtn")?.addEventListener("click", openGallery);
  // Click anywhere that is not a tile or the pane itself → close the preview.
  el("galleryOverlay")?.addEventListener("click", (ev) => {
    if (!selected) return;
    if (ev.target.closest(".galleryTile") || ev.target.closest("#galleryDetail")) return;
    selected = null;
    document.querySelectorAll(".galleryTile.isSelected").forEach((n) => n.classList.remove("isSelected"));
    renderDetail();
  });
  el("galleryCloseBtn")?.addEventListener("click", closeGallery);
  el("galleryReclaimBtn")?.addEventListener("click", reclaim);
  el("galleryTidyBtn")?.addEventListener("click", tidy);

  // Filmstrip
  setStripOpen(stripOpen());
  el("galleryStripToggle")?.addEventListener("click", () => setStripOpen(!stripOpen()));
  el("galleryStripOpen")?.addEventListener("click", openGallery);
  window.addEventListener("hk-media-added", (ev) => onMediaAdded(ev.detail && ev.detail.ids));
  wireDropZone(el("galleryOverlay"));
  wireDropZone(el("galleryStrip"));
  refreshStrip();
  el("galleryTypeFilter")?.addEventListener("change", refresh);
  el("galleryModelFilter")?.addEventListener("change", refresh);
  el("galleryRatingFilter")?.addEventListener("change", refresh);
  const viewSel = el("galleryViewFilter");
  if (viewSel) {
    viewSel.value = savedView();
    applyView(viewSel.value);
    viewSel.addEventListener("change", () => applyView(viewSel.value));
  }
  // Re-reads the archive half of the graph first: the answer depends on it, and the
  // server side is a cached index, so asking again is cheap.
  el("gallerySourceFilter")?.addEventListener("change", async () => { await loadArchiveRefs(); await refresh(); });
  let timer = null;
  el("gallerySearch")?.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(refresh, 250);
  });
}
