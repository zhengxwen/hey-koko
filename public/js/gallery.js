// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

// Client side of the gallery (server/gallery.js): the view over everything the
// machine has ever generated.
//
// Media generated from now on is filed by the server and lives in a message as a
// /api/gallery/file/<id> reference (see utils.js). Conversations that predate that
// still carry their pixels inline; they are moved by archiving them and running
// scripts/migrate-archives.js, which works server-side where the files already are —
// there is deliberately no second, in-browser migration path.

import { state } from './state.js';
import { t } from './i18n.js';
import { galleryIdOf } from './utils.js';
import { switchTab } from './tabs.js';
import { openArchivedChat } from './archive.js';

// ---------------------------------------------------------------------------
// The gallery view: everything ever generated, read straight off disk.
// ---------------------------------------------------------------------------

let items = [];            // current page of ledger entries
let selected = null;       // the entry shown in the detail pane
let archiveRefs = {};      // id -> [{archive, title, msgId}] (server side of the graph)
let deps = { renderChat: () => {}, setInput: () => {}, attachMedia: () => {} };

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
function liveRefs(id) {
  const url = `/api/gallery/file/`;
  const hits = [];
  for (const tab of state.tabs || []) {
    for (const msg of tab.messages || []) {
      for (const f of ["generatedImages", "generatedVideos", "generatedMeshes", "generatedAudio",
                       "contextImages", "displayImages"]) {
        const v0 = msg[f];
        const arr = Array.isArray(v0) ? v0 : typeof v0 === "string" ? [v0] : null;
        if (!arr) continue;
        if (arr.some((v) => typeof v === "string" && v.startsWith(url) && galleryIdOf(v) === id)) {
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

function tileFor(entry) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "galleryTile";
  btn.dataset.id = entry.path;
  const img = document.createElement("img");
  img.loading = "lazy";
  img.alt = entry.prompt || entry.originalName || entry.kind;
  img.src = `/api/gallery/thumb/${entry.path.split("/").map(encodeURIComponent).join("/")}`;
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
  // The full ledger id, month folder and all — this is what the file is called on
  // disk, and the row is where you go to find that out.
  const name = document.createElement("span");
  name.className = "galleryTileName";
  name.textContent = entry.path;
  name.title = entry.path;    // the row can be narrower than the path is long
  const meta = document.createElement("span");
  meta.className = "galleryTileMeta";
  meta.textContent = [fmtDate(entry.ts), fmtSize(entry.bytes), entry.model,
                      entry.prompt || entry.desc || entry.originalName].filter(Boolean).join(" · ");
  text.append(name, meta);
  btn.appendChild(text);

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

function stripTile(entry) {
  const url = `/api/gallery/file/${entry.path.split("/").map(encodeURIComponent).join("/")}`;
  const cell = document.createElement("div");
  cell.className = "galleryStripCell";
  cell.dataset.id = entry.path;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "galleryStripThumb";
  btn.title = entry.prompt || entry.desc || entry.originalName || entry.path;
  const img = document.createElement("img");
  img.loading = "lazy";
  img.alt = btn.title;
  img.src = `/api/gallery/thumb/${entry.path.split("/").map(encodeURIComponent).join("/")}`;
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
    if (first) first.scrollIntoView({ behavior: "smooth", inline: "start", block: "nearest" });
    // The class stays on the element; clear the set so the next refresh is calm.
    setTimeout(() => {
      flashIds.clear();
      row.querySelectorAll(".isNew").forEach((n) => n.classList.remove("isNew"));
    }, 4000);
  }
}

// Called when a render finishes (image-gen.js emits it from storedSlots, the one
// place every generated artifact passes through).
function onMediaGenerated(ids) {
  const list = (ids || []).filter(Boolean);
  if (!list.length) return;
  flashIds = new Set(list);
  refreshStrip();
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
    pane.appendChild(media);
  }

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
    [t("gal_fModel"), e.model],
    [t("gal_fSeed"), e.seed],
    [t("gal_fSize"), e.width && e.height ? `${e.width}×${e.height}` : ""],
    [t("gal_fLength"), e.kind === "video" && e.length ? `${e.length}f${e.fps ? ` @${e.fps}fps` : ""}` : ""],
    [t("gal_fPrecision"), e.precisionUsed],
    [t("gal_fWhen"), fmtDate(e.ts)],
    [t("gal_fBytes"), fmtSize(e.bytes)],
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
  if (e.prompt) act(t("gal_copyPrompt"), () => navigator.clipboard?.writeText(e.prompt));
  // Re-run fills the composer and stops: a render costs real GPU minutes, so the
  // user presses Enter, not us.
  if (e.prompt) act(t("gal_rerun"), () => {
    const seedFlag = e.seed !== undefined && e.seed !== null ? ` --seed ${e.seed}` : "";
    deps.setInput(`/imagine ${e.prompt}${seedFlag}`);
    closeGallery();
  }, t("gal_rerunHint"));
  const dl2 = document.createElement("a");
  dl2.className = "secondary"; dl2.href = url; dl2.download = e.path.split("/").pop();
  dl2.textContent = t("gal_download");
  dl2.style.cssText = "font-size:12px;display:inline-flex;align-items:center;padding:4px 10px;text-decoration:none";
  actions.appendChild(dl2);
  act(t("gal_reveal"), async () => {
    await fetch("/api/gallery/reveal", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: e.path }) });
  });
  act(t("gal_delete"), () => deleteItem(e));
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

function selectItem(id) {
  selected = items.find((e) => e.path === id) || null;
  document.querySelectorAll(".galleryTile").forEach((n) => n.classList.toggle("isSelected", n.dataset.id === id));
  renderDetail();
}

async function deleteItem(entry) {
  const refs = refsFor(entry.path);
  const n = refs.live.length + refs.archived.length;
  if (!confirm(n ? t("gal_confirmDeleteUsed", { n }) : t("gal_confirmDelete"))) return;
  await fetch("/api/gallery/delete", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: [entry.path] }) });
  selected = null;
  await refresh();
  await refreshStrip();
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
  const params = new URLSearchParams({ limit: "200" });
  if (q) params.set("q", q);
  if (type) params.set("type", type);
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

  const grid = el("galleryGrid");
  if (grid) {
    grid.innerHTML = "";
    if (!items.length) {
      const empty = document.createElement("p");
      empty.className = "hint";
      // "Nothing matches" and "nothing exists" are different things to be told.
      empty.textContent = all.length ? t("gal_noneMatch") : t("gal_empty");
      grid.appendChild(empty);
    }
    for (const e of items) grid.appendChild(tileFor(e));
  }

  const statsEl = el("galleryStats");
  if (statsEl && stats) {
    // The stats line describes the whole gallery; say so separately when the view
    // is showing a subset, otherwise the numbers look like they disagree with the grid.
    statsEl.textContent = t("gal_stats", {
      n: stats.count, size: fmtSize(stats.bytes),
      images: stats.images, videos: stats.videos,
      thumbs: fmtSize(stats.thumbBytes),
    }) + (source ? ` · ${t("gal_shown", { n: items.length })}` : "");
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
  el("galleryTidyBtn")?.addEventListener("click", tidy);

  // Filmstrip
  setStripOpen(stripOpen());
  el("galleryStripToggle")?.addEventListener("click", () => setStripOpen(!stripOpen()));
  el("galleryStripOpen")?.addEventListener("click", openGallery);
  window.addEventListener("hk-media-generated", (ev) => onMediaGenerated(ev.detail && ev.detail.ids));
  refreshStrip();
  el("galleryTypeFilter")?.addEventListener("change", refresh);
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
