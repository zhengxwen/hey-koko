// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng
//
// Knowledge star map — a zoomable constellation view of the library / chat-archive
// embeddings. LAZY-LOADED (dynamic import on first open, gate 1) so a chat-only user
// never downloads it. Reads the precomputed cache from POST /api/library/starmap; if
// stale, enqueues the background `starmap` job and polls (gate 2). Colours come from
// the app's CSS theme variables and follow theme switches.
//
// Rendering is WebGL: all stars in a single gl.POINTS draw call with a glow sprite in
// the fragment shader, constellation lines as gl.LINES, pan/zoom via a uniform (no
// per-frame buffer upload). Cluster labels are overlaid HTML (WebGL can't draw text).
// Falls back to Canvas2D where WebGL is unavailable.

import { handleAskCommand, openLibraryDoc, openLibraryPanel } from "./library.js";
import { openArchivedChat, openArchivePanel } from "./archive.js";
import { markdownToHtml } from "./markdown.js";
import { getActiveTab, createTab, switchTab } from "./tabs.js";
import { t } from "./i18n.js";
import { dom, state } from "./state.js";
import { saveTabs } from "./settings.js";
import { activeServerJob } from "./server-queue.js";

const post = (url, body) => fetch(url, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}),
}).then((r) => r.json());

let el = {};
let wired = false;
let DATA = null;
let source = "library";
let cam = { x: 0, y: 0, scale: 1 };
let fit = { cx: 0, cy: 0, s: 1 };
let hidden = new Set();
let legendCollapsed = (() => { try { return localStorage.getItem("heykoko-starmap-legend-collapsed") === "1"; } catch { return false; } })();
let hover = null, selected = null, raf = 0, twinkle = 0, DPR = 1;
let theme = {};
let drag = null;
let usingGL = false;
let G = null;          // WebGL state: { gl, pt, ln, bg, buf, n }
let labelEls = [];
let matched = null;    // Set<doc index> while a search query is active; null = no query
let anim = null;       // in-flight camera animation { from, to, t0, ms }
// Timeline scrubber: show only docs published on/before `timeCut`. null = show all.
let timeCut = null, timeMin = 0, timeMax = 0;
let playing = false, playT0 = 0;   // ▶ auto-advance state
// Display prefs (🎛 menu): glow halo, twinkle, ambient constellation spokes,
// always-on neighbour edges, colour-blind palette, cluster labels.
// Persisted per browser; twinkle defaults OFF when the OS asks for reduced motion.
const DISP_KEY = "heykoko-starmap-display";
// glow defaults OFF (user preference): crisp dots by default; the SELECTED star still
// gets its standing halo regardless of this toggle.
let disp = { glow: false, twinkle: true, spokes: true, edges: false, cb: false, labels: true };
function loadDisp() {
  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) disp.twinkle = false;
  try { Object.assign(disp, JSON.parse(localStorage.getItem(DISP_KEY) || "{}")); } catch { /* defaults */ }
}
function saveDisp() { try { localStorage.setItem(DISP_KEY, JSON.stringify(disp)); } catch { /* private mode */ } }

// ---- theme / colours -----------------------------------------------------
function readTheme() {
  const cs = getComputedStyle(document.documentElement);
  const g = (n, d) => (cs.getPropertyValue(n).trim() || d);
  theme = {
    paper: g("--paper", "#0b0e1a"), panel: g("--panel", "#141a2e"),
    ink: g("--ink", "#eceaf4"), muted: g("--muted", "#7d8299"),
    line: g("--line", "#242c46"), accent: g("--accent", "#e6b450"),
    dark: document.documentElement.getAttribute("data-mode") !== "light",
  };
}
const HUES = [45, 210, 160, 300, 20, 255, 110, 330, 185, 235, 75, 285];
// Okabe-Ito — the standard colour-blind-safe palette (deuteranopia/protanopia/tritanopia)
const OKABE = ["#e69f00", "#56b4e9", "#009e73", "#f0e442", "#0072b2", "#d55e00", "#cc79a7", "#999999"];
function clusterHue(i, total) { return total <= HUES.length ? HUES[i % HUES.length] : Math.round((i * 360) / total); }
function clusterColor(i, total) {
  if (disp.cb) return OKABE[i % OKABE.length];
  return `hsl(${clusterHue(i, total)} 68% ${theme.dark ? 63 : 46}%)`;
}
function clusterRGB(i, total) {
  if (disp.cb) return hexToRgb(OKABE[i % OKABE.length]);
  return hslToRgb(clusterHue(i, total), 0.68, theme.dark ? 0.63 : 0.46);
}
function withAlpha(hsl, a) { return hsl.replace("hsl(", "hsla(").replace(")", ` / ${a})`); }
function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
  let r, g, b;
  if (h < 60) [r, g, b] = [c, x, 0]; else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x]; else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c]; else [r, g, b] = [c, 0, x];
  return [r + m, g + m, b + m];
}
function hexToRgb(hex) {
  hex = (hex || "").trim();
  if (hex[0] === "#" && hex.length >= 7) { const n = parseInt(hex.slice(1), 16); return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]; }
  const m = hex.match(/(\d+\.?\d*)/g); return m ? [(+m[0]) / 255, (+m[1]) / 255, (+m[2]) / 255] : [0.04, 0.05, 0.1];
}

// ---- open / close --------------------------------------------------------
export async function openStarMap() {
  ensureDom();
  applyText();   // the UI language may have changed since the last open
  readTheme();
  el.overlay.classList.add("isOpen");
  el.overlay.setAttribute("aria-hidden", "false");
  resize();
  await load(source);
}
// Set ONLY by the panel-button dismissal path: reopen the map when the library
// panel next opens (the archive ↔ star-map toggle). Any direct close clears it.
let resumeOnLibrary = false;
function closeStarMap() {
  resumeOnLibrary = false;
  el.overlay.classList.remove("isOpen");
  el.overlay.setAttribute("aria-hidden", "true");
  cancelAnimationFrame(raf); raf = 0;
  anim = null;
  stopPlay();
  hideTip();
}

function ensureDom() {
  if (wired) return;
  el.overlay = document.querySelector("#starMapOverlay");
  el.canvas = document.querySelector("#starMapCanvas");
  el.stage = el.canvas.parentElement;
  el.legend = document.querySelector("#starMapLegend");
  el.legendList = document.querySelector("#starMapLegendList");
  el.legendFoot = document.querySelector("#starMapLegendFoot");
  el.inspector = document.querySelector("#starMapInspector");
  el.tip = document.querySelector("#starMapTip");
  el.status = document.querySelector("#starMapStatus");
  el.timeline = document.querySelector("#starMapTimeline");
  el.playBtn = document.querySelector("#starMapPlayBtn");
  el.timeRange = document.querySelector("#starMapTimeRange");
  el.timeLabel = document.querySelector("#starMapTimeLabel");
  el.hint = document.querySelector("#starMapHint");
  el.labels = document.createElement("div"); el.labels.className = "starMapLabels";
  el.stage.insertBefore(el.labels, el.tip);

  try {
    // preserveDrawingBuffer: the PNG export reads the canvas back after the frame
    const gl = el.canvas.getContext("webgl", { alpha: false, antialias: true, premultipliedAlpha: false, preserveDrawingBuffer: true });
    if (gl) { initGL(gl); usingGL = true; }
  } catch { /* fall through to 2D */ }
  if (!usingGL) el.ctx = el.canvas.getContext("2d");

  document.querySelector("#starMapCloseBtn").addEventListener("click", closeStarMap);
  // The left-panel 知识库/档案库 buttons fire these (custom events — those modules must
  // not import this lazily-loaded one). Dismissing the map via a PANEL button remembers
  // it, so the 知识库 button brings the STAR MAP back — the user toggles archive ↔ map.
  // An explicit close (←/Esc/launchpad jump) clears the memory: then 知识库 = the list.
  document.addEventListener("heykoko:closeStarMap", () => {
    // Keep an EXISTING memory when the map is already closed — the 知识库 button fires
    // close-then-libraryOpened back to back, and the close must not eat the resume flag
    // set by an earlier 档案库 dismissal.
    const remember = el.overlay.classList.contains("isOpen") || resumeOnLibrary;
    closeStarMap();               // (sets resumeOnLibrary = false)
    resumeOnLibrary = remember;
  });
  document.addEventListener("heykoko:libraryOpened", () => {
    if (resumeOnLibrary) { resumeOnLibrary = false; openStarMap(); }
  });
  // Staged Escape: clear the search first, then close the inspector, THEN exit —
  // so a stray Esc never throws the user out of the whole map.
  document.addEventListener("keydown", (e) => {
    if (!el.overlay.classList.contains("isOpen")) return;
    if (e.key === "Escape") {
      if (document.activeElement === el.search && el.search.value) { setSearch(""); return; }
      if (el.inspector.classList.contains("isOpen")) { closeInspector(); return; }
      closeStarMap();
      return;
    }
    // Keyboard roaming: arrows hop from the selected star to its neighbour in that
    // direction (nothing selected → pick the star nearest the viewport centre).
    // Never steal keys from the search box / ask input.
    const AK = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const v = AK[e.key];
    if (!v || !DATA) return;
    // Only fields INSIDE the map (search / ask input) keep their arrow keys. The chat
    // textarea beneath the overlay often still holds focus — irrelevant while roaming.
    const ae = document.activeElement;
    if (ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName) && el.overlay.contains(ae)) return;
    e.preventDefault();
    hopTowards(v);
  });
  el.overlay.querySelectorAll("[data-source]").forEach((b) => b.addEventListener("click", () => setSourceTab(b.dataset.source)));
  // "?" in the legend header toggles the how-to-read-this-map key (star size etc.).
  el.help = document.querySelector("#starMapHelp");
  document.querySelector("#starMapHelpBtn").addEventListener("click", () => { el.help.hidden = !el.help.hidden; });
  // The legend foot ("N docs · K constellations") folds the whole legend away.
  el.legendFoot.addEventListener("click", toggleLegendCollapse);
  // 🎛 display menu: glow / twinkle / constellation spokes, persisted per browser.
  loadDisp();
  el.dispMenu = document.querySelector("#starMapDispMenu");
  document.querySelector("#starMapDispBtn").addEventListener("click", () => { el.dispMenu.hidden = !el.dispMenu.hidden; });
  document.querySelector("#starMapExportBtn").addEventListener("click", exportPng);
  // Timeline scrubber: drag ghosts docs published after the thumb's year; ▶ animates
  // the cutoff forward so the map lights up in publication order.
  el.timeRange.addEventListener("input", () => { stopPlay(); setTimeCut(parseInt(el.timeRange.value, 10)); });
  el.playBtn.addEventListener("click", togglePlay);
  // Search: typing dims non-matching stars; Enter flies to the best match.
  el.search = document.querySelector("#starMapSearch");
  el.search.addEventListener("input", () => applySearch(el.search.value));
  el.search.addEventListener("keydown", (e) => { if (e.key === "Enter") jumpToMatch(); });
  document.querySelector("#starMapResetBtn").addEventListener("click", resetView);
  // Rebuild: the map is a cached snapshot — after adding/removing docs the user must
  // rebuild to refresh it (the cache doesn't auto-recompute). Always available.
  el.rebuildBtn = document.querySelector("#starMapRebuildBtn");
  el.rebuildBtn.addEventListener("click", () => triggerBuild(source));
  window.addEventListener("resize", () => { if (el.overlay.classList.contains("isOpen")) resize(); });
  // Live UI-language switch (the settings panel stays reachable next to the map):
  // re-localise the static chrome, and the legend/labels if a map is showing.
  dom.uiLanguageSelect?.addEventListener("change", () => {
    applyText();
    if (DATA && el.overlay.classList.contains("isOpen")) { buildLegend(); buildLabels(); }
  });
  new MutationObserver(() => {
    if (!el.overlay.classList.contains("isOpen")) return;
    readTheme(); if (usingGL && DATA) rebuildColors();
  }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-mode", "data-theme"] });

  wireCanvas();
  applyText();
  wired = true;
}

function applyText() {
  const set = (sel, key, vars) => { const n = el.overlay.querySelector(sel); if (n) n.textContent = t(key, vars); };
  set("#starMapTitleText", "star_title");
  set('[data-source="library"]', "star_srcLib");
  set('[data-source="archive"]', "star_srcArc");
  set("#starMapLegendTitle", "star_legendTitle");
  set("#starMapHint", "star_hint");
  if (el.rebuildBtn) { el.rebuildBtn.textContent = "🔄 " + t("star_rebuild"); el.rebuildBtn.title = t("star_rebuildHint"); }
  if (el.search) el.search.placeholder = t("star_search");
  const rst = el.overlay.querySelector("#starMapResetBtn"); if (rst) rst.title = t("star_reset");
  const hb = el.overlay.querySelector("#starMapHelpBtn");
  if (hb) { hb.title = t("star_help"); hb.setAttribute("aria-label", t("star_help")); }
  const helpUl = el.overlay.querySelector("#starMapHelp ul");
  if (helpUl) {
    helpUl.innerHTML = "";
    for (const k of ["star_helpStar", "star_helpSize", "star_helpPos", "star_helpColor", "star_helpFaint", "star_helpBright", "star_helpKeys"]) {
      const li = document.createElement("li"); li.textContent = t(k); helpUl.appendChild(li);
    }
  }
  const db = el.overlay.querySelector("#starMapDispBtn"); if (db) db.title = t("star_display");
  if (el.dispMenu) {
    el.dispMenu.innerHTML = "";
    for (const [key, tkey] of [["glow", "star_dispGlow"], ["twinkle", "star_dispTwinkle"], ["spokes", "star_dispSpokes"],
      ["edges", "star_dispEdges"], ["cb", "star_dispCb"], ["labels", "star_dispLabels"]]) {
      const lab = document.createElement("label"); lab.className = "checkboxLabel";
      lab.title = t(tkey + "Tip");
      const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = !!disp[key];
      cb.addEventListener("change", () => {
        disp[key] = cb.checked; saveDisp();
        // palette switch recolours everything derived from cluster colours
        if (key === "cb" && DATA) { if (usingGL) rebuildColors(); else buildLabels(); buildLegend(); }
      });
      const sp = document.createElement("span"); sp.textContent = t(tkey);
      lab.append(cb, sp); el.dispMenu.appendChild(lab);
    }
  }
  const xb = el.overlay.querySelector("#starMapExportBtn"); if (xb) xb.title = t("star_export");
  if (el.playBtn) el.playBtn.title = t("star_timePlay");
  if (el.timeLabel && DATA && !el.timeline.hidden) updateTimeLabel();
}
function setSourceTab(s) {
  source = s;
  el.overlay.querySelectorAll("[data-source]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.source === s)));
  // Keep the panel UNDER the map in sync with the source: leaving the map should land
  // in the matching view (library map ↔ library panel, archive map ↔ archive panel).
  if (s === "archive") {
    document.querySelector("#libraryOverlay")?.classList.remove("isOpen");
    openArchivePanel();
  } else {
    document.querySelector("#archiveOverlay")?.classList.remove("isOpen");
    openLibraryPanel();
  }
  load(s);
}

// ---- data load / build ---------------------------------------------------
async function load(which) {
  source = which;
  setStatus(t("star_loading"), true);
  let map;
  try { map = await post("/api/library/starmap", { source: which }); }
  catch { setStatus(t("star_error")); return; }
  // A rebuild (UMAP) may already be running in the background — started from the
  // Rebuild button, another page, or the task queue. Say so instead of silently
  // showing the old cache, and swap in the fresh map when the job lands.
  const building = !!activeServerJob("starmap", which);
  if (el.rebuildBtn) {
    el.rebuildBtn.disabled = building;
    el.rebuildBtn.classList.toggle("isOutdated", !building && !!map.outdated);
    el.rebuildBtn.title = map.outdated && !building
      ? t("star_outdated", { n: map.currentN != null ? map.currentN : "?" })
      : t("star_rebuildHint");
  }
  if (map.stale || !map.docs || !map.docs.length) {
    // No map for THIS source: clear EVERYTHING the previous source left on screen —
    // canvas, labels, legend, inspector, tooltip (a lingering library legend over an
    // empty archive map reads as "the switch didn't work").
    DATA = null; cancelAnimationFrame(raf); raf = 0;
    clearScreen(); clearLabels();
    closeInspector(); hideTip(); stopPlay();
    el.legend.style.display = "none";
    el.legendList.innerHTML = ""; el.legendFoot.textContent = "";
    el.timeline.hidden = true; timeCut = null;
    if (building) { setStatus(t("star_building"), true); pollBuild(which); }
    else showBuildPrompt(which, map.stale ? "stale" : "empty");
    return;
  }
  el.legend.style.display = "";
  DATA = map;
  // Undirected adjacency over the top-3 neighbour edges — keyboard navigation walks
  // this graph (both directions, so you can hop BACK along an incoming edge too).
  {
    const adj = map.docs.map(() => new Set());
    map.docs.forEach((d, i) => { for (const j of (d.nn || [])) if (map.docs[j]) { adj[i].add(j); adj[j].add(i); } });
    map._adj = adj.map((s) => [...s]);
  }
  // Star size = hub-ness, not length: count how many docs list this one among their
  // top-3 semantic neighbours (in-degree). Every doc casts exactly 3 votes, so the
  // average is 3 regardless of cluster size — big topics don't inflate. Votes from
  // ANOTHER constellation weigh double: cross-domain pull is the real hub signal.
  // (Blocks would just encode doc KIND — papers chunk long, videos short.)
  DATA.docs.forEach((d, i) => { d._i = i; d._hub = 0; });
  let anyNN = false;
  for (const d of DATA.docs) {
    for (const j of (d.nn || [])) {
      const nb = DATA.docs[j]; if (!nb) continue;
      anyNN = true;
      nb._hub += nb.cluster === d.cluster ? 1 : 2;
    }
  }
  DATA.docs.forEach((d) => {
    // Old caches have no nn — fall back to the legacy blocks sizing.
    d._r = anyNN ? 3 + Math.min(9, Math.sqrt(d._hub) * 2.2) : 3 + Math.min(9, Math.sqrt(d.blocks || 8) * 1.1);
  });
  DATA._hubbed = anyNN;
  hidden.clear(); selected = null; hover = null; cam = { x: 0, y: 0, scale: 1 };
  anim = null; matched = null; if (el.search) el.search.value = "";
  setupTimeline();
  closeInspector();
  // Rebuilding over an existing cache: keep the old map visible under the hint.
  if (building) { setStatus(t("star_building"), true); pollBuild(which); }
  else setStatus("");
  computeFit();
  if (usingGL) buildGLBuffers();
  buildLegend();
  buildLabels();
  if (!raf) loop();
}

function showBuildPrompt(which, why) {
  const msg = why === "empty" && which === "archive" ? t("star_archiveEmpty") : t("star_needBuild");
  el.status.innerHTML = "";
  const box = document.createElement("div"); box.className = "starMapPrompt";
  const p = document.createElement("p"); p.textContent = msg; box.appendChild(p);
  const btn = document.createElement("button"); btn.className = "starMapBuildBtn"; btn.textContent = t("star_build");
  btn.addEventListener("click", () => triggerBuild(which)); box.appendChild(btn);
  el.status.appendChild(box); el.status.hidden = false;
}
async function triggerBuild(which) {
  setStatus(t("star_building"), true);
  if (el.rebuildBtn) { el.rebuildBtn.disabled = true; el.rebuildBtn.classList.remove("isOutdated"); }
  // Already building (e.g. clicked from the stale prompt while a job runs) → just attach.
  if (!activeServerJob("starmap", which)) {
    try { await post("/api/jobs", { kind: "starmap", payload: { source: which }, label: "star map" }); }
    catch { setStatus(t("star_error")); if (el.rebuildBtn) el.rebuildBtn.disabled = false; return; }
  }
  pollBuild(which);
}

// Poll until the in-flight build lands (builtAt changes), then reload. One loop at a
// time (pollSeq); bails when the overlay closes or the user switches source.
let pollSeq = 0;
async function pollBuild(which) {
  const seq = ++pollSeq;
  let base = null;
  try { base = (await post("/api/library/starmap", { source: which })).builtAt || null; } catch { /* keep null */ }
  for (let i = 0; i < 600; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (seq !== pollSeq || source !== which || !el.overlay.classList.contains("isOpen")) return;
    let map; try { map = await post("/api/library/starmap", { source: which }); } catch { continue; }
    const landed = !map.stale && map.docs && map.docs.length && (map.builtAt || null) !== base;
    if (landed) { load(which); return; }
    // Job left the queue without producing a new cache → it failed.
    if (!activeServerJob("starmap", which)) {
      setStatus(t("star_error"));
      if (el.rebuildBtn) el.rebuildBtn.disabled = false;
      return;
    }
  }
  setStatus(t("star_error"));
}
// Boxed, opaque card — bare centred text would visually blend into the stars.
// busy=true adds a spinner: it's a WAITING state (building/loading/searching),
// not a terminal message (error / no results).
function setStatus(text, busy = false) {
  if (!text) { el.status.hidden = true; el.status.textContent = ""; return; }
  el.status.hidden = false;
  el.status.innerHTML = "";
  const box = document.createElement("div");
  box.className = "starMapStatusBox" + (busy ? " isBusy" : "");
  box.textContent = text;
  el.status.appendChild(box);
}

// ---- geometry ------------------------------------------------------------
function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  const w = el.canvas.clientWidth, h = el.canvas.clientHeight;
  el.canvas.width = Math.max(1, Math.round(w * DPR)); el.canvas.height = Math.max(1, Math.round(h * DPR));
  if (usingGL && G) G.gl.viewport(0, 0, el.canvas.width, el.canvas.height);
  computeFit();
}
function computeFit() {
  if (!DATA || !DATA.docs.length) return;
  const pad = 120, w = el.canvas.clientWidth, h = el.canvas.clientHeight;
  let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
  for (const d of DATA.docs) { minx = Math.min(minx, d.x); maxx = Math.max(maxx, d.x); miny = Math.min(miny, d.y); maxy = Math.max(maxy, d.y); }
  const spanx = (maxx - minx) || 1, spany = (maxy - miny) || 1;
  fit = { s: Math.min((w - pad * 2) / spanx, (h - pad * 2) / spany), cx: (minx + maxx) / 2, cy: (miny + maxy) / 2 };
}
function toScreen(d) {
  const w = el.canvas.clientWidth, h = el.canvas.clientHeight;
  return [(d.x - fit.cx) * fit.s * cam.scale + w / 2 + cam.x, (d.y - fit.cy) * fit.s * cam.scale + h / 2 + cam.y];
}
// data → clip-space transform shared by the GL programs
function transform() {
  const w = el.canvas.clientWidth, h = el.canvas.clientHeight, S = fit.s * cam.scale;
  return { center: [fit.cx, fit.cy], scale: [2 * S / w, -2 * S / h], offset: [2 * cam.x / w, -2 * cam.y / h] };
}

// ---- WebGL ---------------------------------------------------------------
// a_shown is a per-star ALPHA (not a boolean): 1 = normal, ~0.15 = dimmed by an
// active search, 0 = cluster hidden via the legend.
const V_PT = `
  precision mediump float;
  attribute vec2 a_pos; attribute float a_size; attribute vec3 a_color; attribute float a_shown;
  uniform vec2 u_center; uniform vec2 u_scale; uniform vec2 u_offset; uniform float u_sizeFactor;
  varying vec3 v_color; varying float v_shown; varying float v_phase; varying float v_size;
  void main(){
    v_color = a_color; v_shown = a_shown; v_phase = a_pos.x * 20.0 + a_pos.y * 15.0;
    gl_Position = vec4((a_pos - u_center) * u_scale + u_offset, 0.0, 1.0);
    float s = a_shown > 0.03 ? a_size * u_sizeFactor : 0.0;
    gl_PointSize = s; v_size = s;
  }`;
const F_PT = `
  precision mediump float;
  varying vec3 v_color; varying float v_shown; varying float v_phase; varying float v_size;
  uniform float u_time; uniform float u_glow; uniform float u_twinkle;
  uniform float u_rim; uniform vec3 u_rimColor; uniform float u_rimW; uniform float u_glowW;
  void main(){
    if (v_shown < 0.03) discard;
    float d = length(gl_PointCoord - vec2(0.5)) * 2.0;
    float core = 1.0 - smoothstep(0.21, 0.30, d);
    // Glow band in PIXELS (u_glowW ≈ the smallest star's halo), hugging the core edge —
    // same fixed-stroke treatment as the rim, so big stars don't get giant halos.
    float rpx0 = d * v_size * 0.5;
    float coreEdge = 0.30 * v_size * 0.5;
    float glow = (1.0 - smoothstep(coreEdge, coreEdge + u_glowW, rpx0)) * 0.45 * u_glow;
    // Dark rim hugging the core, for light backgrounds (u_rim=1). Band computed in
    // PIXELS (u_rimW, ~the smallest star's rim) so every star gets the SAME stroke
    // width — in sprite-normalised units big stars would get fat borders.
    float rpx = d * v_size * 0.5;
    float edge = 0.27 * v_size * 0.5;
    float ring = smoothstep(edge - 1.0, edge, rpx) * (1.0 - smoothstep(edge + u_rimW, edge + u_rimW + 1.0, rpx));
    float a = max(core, glow);
    a = max(a, ring * u_rim * 0.85);
    if (a < 0.01) discard;
    float tw = 0.82 + 0.18 * sin(u_time * 1.3 + v_phase);
    a *= mix(1.0, tw, u_twinkle);
    vec3 col = mix(v_color, vec3(1.0), core * 0.55);
    col = mix(col, u_rimColor, ring * u_rim);
    gl_FragColor = vec4(col, a * v_shown);
  }`;
// Thick lines for the neighbour edges: gl.LINES is clamped to 1 device px on ANGLE/
// Metal, so each edge is a quad (2 triangles) extruded along the screen-space normal.
// a_side ∈ {+1,-1}; a vertex whose a_other is the FIRST endpoint flips its normal, so
// the quad builder passes the pre-flipped side for the far endpoint.
const V_LW = `
  precision mediump float;
  attribute vec2 a_pos; attribute vec2 a_other; attribute float a_side;
  attribute vec3 a_color; attribute float a_shown;
  uniform vec2 u_center; uniform vec2 u_scale; uniform vec2 u_offset;
  uniform vec2 u_res; uniform float u_width;
  varying vec3 v_color; varying float v_alpha;
  void main(){
    v_color = a_color; v_alpha = a_shown;
    vec2 p = (a_pos - u_center) * u_scale + u_offset;
    vec2 q = (a_other - u_center) * u_scale + u_offset;
    vec2 dpx = (q - p) * u_res;
    float len = max(length(dpx), 1e-4);
    vec2 nrm = vec2(-dpx.y, dpx.x) / len;
    vec2 off = nrm * a_side * u_width * 2.0 / u_res;
    gl_Position = a_shown > 0.03 ? vec4(p + off, 0.0, 1.0) : vec4(2.0, 2.0, 0.0, 1.0);
  }`;
const F_LW = `precision mediump float; varying vec3 v_color; varying float v_alpha; uniform float u_alpha; void main(){ gl_FragColor = vec4(v_color, u_alpha * v_alpha); }`;
const V_BG = `attribute vec2 a_pos; void main(){ gl_Position = vec4(a_pos, 0.0, 1.0); }`;
const F_BG = `
  precision mediump float;
  uniform vec2 u_res; uniform vec3 u_ctr; uniform vec3 u_edge;
  void main(){ float d = distance(gl_FragCoord.xy / u_res, vec2(0.5, 0.45)) / 0.72; gl_FragColor = vec4(mix(u_ctr, u_edge, clamp(d, 0.0, 1.0)), 1.0); }`;

function compile(gl, type, src) {
  const sh = gl.createShader(type); gl.shaderSource(sh, src); gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error("shader: " + gl.getShaderInfoLog(sh));
  return sh;
}
function program(gl, vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs)); gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error("link: " + gl.getProgramInfoLog(p));
  return p;
}
function initGL(gl) {
  G = { gl, pt: program(gl, V_PT, F_PT), lw: program(gl, V_LW, F_LW), bg: program(gl, V_BG, F_BG), buf: {}, n: 0, ln2: 0 };
  gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  for (const k of ["pos", "size", "color", "shown", "lpos", "loth", "lside", "lcolor", "lshown",
    "epos", "eoth", "eside", "ecolor", "eshown",
    "hlpos", "hloth", "hlside", "hlcolor", "hlshown", "hppos", "hpsize", "hpcolor", "hpshown",
    "spos", "ssize", "scolor", "sshown"]) G.buf[k] = gl.createBuffer();
  G.hkey = -1; G.hln = 0; G.hpn = 0;   // hover/selection highlight state
  G.buf.quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, G.buf.quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW); // fullscreen triangle
}
function buildGLBuffers() {
  const gl = G.gl, docs = DATA.docs, n = docs.length, K = DATA.clusters.length;
  G.n = n;
  const pos = new Float32Array(n * 2), size = new Float32Array(n), color = new Float32Array(n * 3), shown = new Float32Array(n);
  // cluster centroids in data space (for constellation lines)
  const cen = {};
  for (const d of docs) { const c = cen[d.cluster] || (cen[d.cluster] = { x: 0, y: 0, n: 0 }); c.x += d.x; c.y += d.y; c.n++; }
  for (const k in cen) { cen[k].x /= cen[k].n; cen[k].y /= cen[k].n; }
  const lcolor = new Float32Array(n * 18), lshown = new Float32Array(n * 6);
  docs.forEach((d, i) => {
    const a = alphaOf(d, i);
    pos[i * 2] = d.x; pos[i * 2 + 1] = d.y; size[i] = d._r; shown[i] = a;
    const rgb = clusterRGB(d.cluster, K); color[i * 3] = rgb[0]; color[i * 3 + 1] = rgb[1]; color[i * 3 + 2] = rgb[2];
    for (let v = 0; v < 6; v++) {
      lshown[i * 6 + v] = a;
      lcolor[i * 18 + v * 3] = rgb[0]; lcolor[i * 18 + v * 3 + 1] = rgb[1]; lcolor[i * 18 + v * 3 + 2] = rgb[2];
    }
  });
  // spokes (star → its cluster centroid) as thick quads too — same lw program
  const lq = buildEdgeQuads(docs.map((d) => [d, cen[d.cluster]]));
  G.ln2 = n * 6;
  upload(gl, G.buf.pos, pos); upload(gl, G.buf.size, size); upload(gl, G.buf.color, color); upload(gl, G.buf.shown, shown);
  upload(gl, G.buf.lpos, lq.pos); upload(gl, G.buf.loth, lq.oth); upload(gl, G.buf.lside, lq.side);
  upload(gl, G.buf.lcolor, lcolor); upload(gl, G.buf.lshown, lshown);
  G._shown = shown; G._lshown = lshown;
  // the full semantic-neighbour edge set (~3n quads) for the always-on edges toggle
  G.edges = [];
  docs.forEach((d, i) => { for (const j of (d.nn || [])) if (docs[j]) G.edges.push([i, j]); });
  const eq = buildEdgeQuads(G.edges.map(([i, j]) => [docs[i], docs[j]]));
  upload(gl, G.buf.epos, eq.pos); upload(gl, G.buf.eoth, eq.oth); upload(gl, G.buf.eside, eq.side);
  G._eshown = new Float32Array(G.edges.length * 6);
  uploadEdgeColors();
  updateEdgeVisibility();
}
// 6 verts per edge quad: A(p1,+1) B(p1,-1) C(p2,+1eff) + B D(p2,-1eff) C. A vertex
// anchored at p2 computes its normal from (p1-p2) — flipped — so its side is negated
// to land on the same geometric side of the line.
function buildEdgeQuads(pairs) {
  const n = pairs.length;
  const pos = new Float32Array(n * 12), oth = new Float32Array(n * 12), side = new Float32Array(n * 6);
  pairs.forEach(([a, b], k) => {
    // vert order: (p1,+1) (p1,-1) (p2,-1) | (p1,-1) (p2,+1) (p2,-1)
    const verts = [[a, b, 1], [a, b, -1], [b, a, -1], [a, b, -1], [b, a, 1], [b, a, -1]];
    verts.forEach(([p, q, s], v) => {
      const o = k * 6 + v;
      pos[o * 2] = p.x; pos[o * 2 + 1] = p.y;
      oth[o * 2] = q.x; oth[o * 2 + 1] = q.y;
      side[o] = s;
    });
  });
  return { pos, oth, side };
}
// Edge colours follow the palette (and the accent for cross-cluster bridges) — rebuilt
// on theme switch and on the colour-blind toggle.
function uploadEdgeColors() {
  if (!G || !DATA || !G.edges) return;
  const docs = DATA.docs, K = DATA.clusters.length, acc = hexToRgb(theme.accent);
  const ecol = new Float32Array(G.edges.length * 18);   // 6 verts × rgb
  G.edges.forEach(([i, j], k) => {
    const rgb = docs[i].cluster === docs[j].cluster ? clusterRGB(docs[i].cluster, K) : acc;
    for (let v = 0; v < 6; v++) { ecol[k * 18 + v * 3] = rgb[0]; ecol[k * 18 + v * 3 + 1] = rgb[1]; ecol[k * 18 + v * 3 + 2] = rgb[2]; }
  });
  upload(G.gl, G.buf.ecolor, ecol);
}
function updateEdgeVisibility() {
  if (!G || !DATA || !G.edges) return;
  const docs = DATA.docs;
  G.edges.forEach(([i, j], k) => {
    const a = Math.min(alphaOf(docs[i], i), alphaOf(docs[j], j));
    for (let v = 0; v < 6; v++) G._eshown[k * 6 + v] = a;
  });
  upload(G.gl, G.buf.eshown, G._eshown);
}
function rebuildColors() {
  if (!G || !DATA) return;
  const gl = G.gl, docs = DATA.docs, K = DATA.clusters.length;
  const color = new Float32Array(docs.length * 3), lcolor = new Float32Array(docs.length * 18);
  docs.forEach((d, i) => {
    const rgb = clusterRGB(d.cluster, K);
    color[i * 3] = rgb[0]; color[i * 3 + 1] = rgb[1]; color[i * 3 + 2] = rgb[2];
    for (let v = 0; v < 6; v++) { lcolor[i * 18 + v * 3] = rgb[0]; lcolor[i * 18 + v * 3 + 1] = rgb[1]; lcolor[i * 18 + v * 3 + 2] = rgb[2]; }
  });
  upload(gl, G.buf.color, color); upload(gl, G.buf.lcolor, lcolor);
  uploadEdgeColors();
  G.hkey = -1;   // highlight colours are theme-derived — rebuild on next frame
  buildLabels(); // label colours too
}
// A star's effective alpha: legend-hidden clusters vanish; an active search dims
// non-matches; the timeline ghosts docs published AFTER the cutoff (undated docs are
// unaffected — they have no place on the timeline).
function alphaOf(d, i) {
  if (hidden.has(d.cluster)) return 0;
  let a = matched && !matched.has(i) ? 0.15 : 1;
  if (timeCut != null && d.year && d.year > timeCut) a = Math.min(a, 0.06);
  return a;
}
function updateVisibilityGL() {
  if (!G || !DATA) return;
  const gl = G.gl;
  DATA.docs.forEach((d, i) => { const s = alphaOf(d, i); G._shown[i] = s; for (let v = 0; v < 6; v++) G._lshown[i * 6 + v] = s; });
  upload(gl, G.buf.shown, G._shown); upload(gl, G.buf.lshown, G._lshown);
  updateEdgeVisibility();
}
function upload(gl, buf, data) { gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW); }
function attrib(gl, prog, name, buf, size) {
  const loc = gl.getAttribLocation(prog, name); if (loc < 0) return;
  gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
}

function drawGL() {
  const gl = G.gl, tr = transform();
  // background gradient
  gl.useProgram(G.bg);
  const ctr = theme.dark ? mix(hexToRgb(theme.panel), hexToRgb(theme.paper), 0.35) : hexToRgb(theme.panel);
  gl.uniform2f(gl.getUniformLocation(G.bg, "u_res"), el.canvas.width, el.canvas.height);
  gl.uniform3fv(gl.getUniformLocation(G.bg, "u_ctr"), ctr);
  gl.uniform3fv(gl.getUniformLocation(G.bg, "u_edge"), hexToRgb(theme.paper));
  attrib(gl, G.bg, "a_pos", G.buf.quad, 2);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  // all line passes share the thick-quad program (gl.LINES is 1px-capped on ANGLE)
  const setLw = (alpha, halfW) => {
    gl.useProgram(G.lw);
    setTr(gl, G.lw, tr);
    gl.uniform2f(gl.getUniformLocation(G.lw, "u_res"), el.canvas.width, el.canvas.height);
    gl.uniform1f(gl.getUniformLocation(G.lw, "u_width"), halfW * DPR);
    gl.uniform1f(gl.getUniformLocation(G.lw, "u_alpha"), alpha);
  };
  // constellation spokes (star → centroid; 🎛 toggle) — soft but clearly visible now
  if (disp.spokes) {
    setLw(0.2, 0.75);   // ~1.5px stroke
    attrib(gl, G.lw, "a_pos", G.buf.lpos, 2); attrib(gl, G.lw, "a_other", G.buf.loth, 2); attrib(gl, G.lw, "a_side", G.buf.lside, 1);
    attrib(gl, G.lw, "a_color", G.buf.lcolor, 3); attrib(gl, G.lw, "a_shown", G.buf.lshown, 1);
    gl.drawArrays(gl.TRIANGLES, 0, G.ln2);
  }
  // always-on semantic-neighbour mesh (🎛 toggle)
  if (disp.edges && G.edges && G.edges.length) {
    setLw(0.38, 0.9);   // ~1.8px stroke
    attrib(gl, G.lw, "a_pos", G.buf.epos, 2); attrib(gl, G.lw, "a_other", G.buf.eoth, 2); attrib(gl, G.lw, "a_side", G.buf.eside, 1);
    attrib(gl, G.lw, "a_color", G.buf.ecolor, 3); attrib(gl, G.lw, "a_shown", G.buf.eshown, 1);
    gl.drawArrays(gl.TRIANGLES, 0, G.edges.length * 6);
  }
  // semantic-neighbour edges of the hovered/selected star, drawn much brighter
  syncHighlight();
  if (G.hln) {
    setLw(0.7, 0.9);
    attrib(gl, G.lw, "a_pos", G.buf.hlpos, 2); attrib(gl, G.lw, "a_other", G.buf.hloth, 2); attrib(gl, G.lw, "a_side", G.buf.hlside, 1);
    attrib(gl, G.lw, "a_color", G.buf.hlcolor, 3); attrib(gl, G.lw, "a_shown", G.buf.hlshown, 1);
    gl.drawArrays(gl.TRIANGLES, 0, G.hln);
  }
  // stars
  gl.useProgram(G.pt);
  setTr(gl, G.pt, tr);
  const zoom = Math.max(0.6, Math.min(cam.scale, 2.4));
  const sf = DPR * zoom * 3.4 * 2.0;
  gl.uniform1f(gl.getUniformLocation(G.pt, "u_sizeFactor"), sf);
  gl.uniform1f(gl.getUniformLocation(G.pt, "u_time"), twinkle);
  gl.uniform1f(gl.getUniformLocation(G.pt, "u_glow"), disp.glow ? 1 : 0);
  gl.uniform1f(gl.getUniformLocation(G.pt, "u_twinkle"), disp.twinkle ? 1 : 0);
  // rim in BOTH themes: --ink is dark-on-light and light-on-dark, so the stroke is
  // black-ish in light mode and white-ish in dark mode.
  gl.uniform1f(gl.getUniformLocation(G.pt, "u_rim"), 1);
  gl.uniform3fv(gl.getUniformLocation(G.pt, "u_rimColor"), hexToRgb(theme.ink));
  // rim stroke width in device px = what the SMALLEST star (base radius 3) used to get
  gl.uniform1f(gl.getUniformLocation(G.pt, "u_rimW"), 0.195 * sf);
  // glow band width in device px = the smallest star's halo (0.7 × its sprite radius)
  gl.uniform1f(gl.getUniformLocation(G.pt, "u_glowW"), 1.05 * sf);
  attrib(gl, G.pt, "a_pos", G.buf.pos, 2); attrib(gl, G.pt, "a_size", G.buf.size, 1);
  attrib(gl, G.pt, "a_color", G.buf.color, 3); attrib(gl, G.pt, "a_shown", G.buf.shown, 1);
  gl.drawArrays(gl.POINTS, 0, G.n);
  // focus + neighbour stars redrawn boosted, on top
  if (G.hpn) {
    attrib(gl, G.pt, "a_pos", G.buf.hppos, 2); attrib(gl, G.pt, "a_size", G.buf.hpsize, 1);
    attrib(gl, G.pt, "a_color", G.buf.hpcolor, 3); attrib(gl, G.pt, "a_shown", G.buf.hpshown, 1);
    gl.drawArrays(gl.POINTS, 0, G.hpn);
  }
  // the SELECTED star gets a standing glow halo — even with the 🎛 glow toggle off,
  // and even while search-dimmed: that's what "selected" means on this map.
  if (selected) {
    gl.uniform1f(gl.getUniformLocation(G.pt, "u_glow"), 1.3);
    // wider halo = selection; ×2.0 exactly fits the ×2.0 sprite of the smallest star
    // (edge 0.3R + band ≤ R), so the halo never clips into the sprite's square bounds
    gl.uniform1f(gl.getUniformLocation(G.pt, "u_glowW"), 1.05 * sf * 2.0);
    upload(gl, G.buf.spos, new Float32Array([selected.x, selected.y]));
    upload(gl, G.buf.ssize, new Float32Array([selected._r * 2.0]));
    const srgb = clusterRGB(selected.cluster, DATA.clusters.length);
    upload(gl, G.buf.scolor, new Float32Array(srgb));
    upload(gl, G.buf.sshown, new Float32Array([1]));
    attrib(gl, G.pt, "a_pos", G.buf.spos, 2); attrib(gl, G.pt, "a_size", G.buf.ssize, 1);
    attrib(gl, G.pt, "a_color", G.buf.scolor, 3); attrib(gl, G.pt, "a_shown", G.buf.sshown, 1);
    gl.drawArrays(gl.POINTS, 0, 1);
  }
}
// Rebuild the tiny highlight buffers only when the focused star changes. Neighbour
// edges INSIDE a cluster take the neighbour's colour; edges that BRIDGE two clusters
// take the app accent — those are the cross-domain finds worth noticing.
function syncHighlight() {
  const f = hover || selected;
  const key = f && f.nn && f.nn.length ? f._i : -1;
  if (key === G.hkey) return;
  G.hkey = key;
  if (key < 0) { G.hln = 0; G.hpn = 0; return; }
  const gl = G.gl, K = DATA.clusters.length, acc = hexToRgb(theme.accent);
  const nbrs = (f.nn || []).map((j) => DATA.docs[j]).filter(Boolean);
  const lcol = [], ppos = [], psize = [], pcol = [];
  for (const nb of nbrs) {
    const rgb = nb.cluster === f.cluster ? clusterRGB(nb.cluster, K) : acc;
    for (let v = 0; v < 6; v++) lcol.push(rgb[0], rgb[1], rgb[2]);   // 6 quad verts
    ppos.push(nb.x, nb.y); psize.push(nb._r * 1.25); pcol.push(rgb[0], rgb[1], rgb[2]);
  }
  const frgb = clusterRGB(f.cluster, K);
  ppos.push(f.x, f.y); psize.push(f._r * 1.4); pcol.push(frgb[0], frgb[1], frgb[2]);
  const hq = buildEdgeQuads(nbrs.map((nb) => [f, nb]));
  G.hln = nbrs.length * 6; G.hpn = nbrs.length + 1;
  upload(gl, G.buf.hlpos, hq.pos); upload(gl, G.buf.hloth, hq.oth); upload(gl, G.buf.hlside, hq.side);
  upload(gl, G.buf.hlcolor, new Float32Array(lcol));
  upload(gl, G.buf.hlshown, new Float32Array(G.hln).fill(1));
  upload(gl, G.buf.hppos, new Float32Array(ppos)); upload(gl, G.buf.hpsize, new Float32Array(psize));
  upload(gl, G.buf.hpcolor, new Float32Array(pcol)); upload(gl, G.buf.hpshown, new Float32Array(G.hpn).fill(1));
}
function setTr(gl, prog, tr) {
  gl.uniform2fv(gl.getUniformLocation(prog, "u_center"), tr.center);
  gl.uniform2fv(gl.getUniformLocation(prog, "u_scale"), tr.scale);
  gl.uniform2fv(gl.getUniformLocation(prog, "u_offset"), tr.offset);
}
function mix(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }

// ---- cluster labels (overlaid HTML) --------------------------------------
function buildLabels() {
  clearLabels();
  DATA.clusters.forEach((c) => {
    const s = document.createElement("div"); s.className = "starMapLabel";
    s.textContent = c.label; s.style.color = clusterColor(c.id, DATA.clusters.length);
    s.dataset.cluster = c.id;
    s.title = t("star_focusCluster");
    // The label floats OVER the canvas near the cluster's densest spot, so it also
    // swallows clicks meant for stars beneath it. Behave like the tooltip: if a star
    // is under the cursor, open THAT; only a clear miss zooms to the cluster.
    s.addEventListener("click", (e) => {
      const d = pick(e.clientX, e.clientY);
      if (d) { openInspector(d); return; }
      flyToCluster(c.id);   // inspector (if open) stays — it closes only via ×/Esc
    });
    el.labels.appendChild(s); labelEls[c.id] = s;
  });
  positionLabels();
}
function clearLabels() { if (el.labels) el.labels.innerHTML = ""; labelEls = []; }
function positionLabels() {
  if (!DATA) return;
  const cen = {};
  for (const d of DATA.docs) { const c = cen[d.cluster] || (cen[d.cluster] = { x: 0, y: 0, n: 0 }); const [x, y] = toScreen(d); c.x += x; c.y += y; c.n++; }
  DATA.clusters.forEach((c) => {
    const div = labelEls[c.id], e = cen[c.id]; if (!div || !e) return;
    const show = disp.labels && !hidden.has(c.id) && cam.scale < 3.5;
    div.style.display = show ? "block" : "none";
    if (show) div.style.transform = `translate(-50%, -100%) translate(${(e.x / e.n)}px, ${(e.y / e.n) - 12}px)`;
  });
}

// ---- 2D fallback ---------------------------------------------------------
function clearScreen() {
  if (usingGL && G) { G.gl.clearColor(...hexToRgb(theme.paper), 1); G.gl.clear(G.gl.COLOR_BUFFER_BIT); return; }
  if (!el.ctx) return;
  el.ctx.setTransform(DPR, 0, 0, DPR, 0, 0); el.ctx.fillStyle = theme.paper; el.ctx.fillRect(0, 0, el.canvas.clientWidth, el.canvas.clientHeight);
}
function draw2d() {
  const ctx = el.ctx, w = el.canvas.clientWidth, h = el.canvas.clientHeight;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  const grad = ctx.createRadialGradient(w * 0.5, h * 0.45, 0, w * 0.5, h * 0.45, Math.max(w, h) * 0.75);
  grad.addColorStop(0, theme.panel); grad.addColorStop(1, theme.paper); ctx.fillStyle = grad; ctx.fillRect(0, 0, w, h);
  const cen = {};
  for (const d of DATA.docs) { const c = cen[d.cluster] || (cen[d.cluster] = { x: 0, y: 0, n: 0 }); const [x, y] = toScreen(d); c.x += x; c.y += y; c.n++; }
  for (const k in cen) { cen[k].x /= cen[k].n; cen[k].y /= cen[k].n; }
  ctx.lineWidth = 1.5;
  if (disp.spokes) DATA.docs.forEach((d, i) => {
    const a = alphaOf(d, i); if (a <= 0.03) return;
    const [x, y] = toScreen(d), c = cen[d.cluster];
    ctx.strokeStyle = withAlpha(clusterColor(d.cluster, DATA.clusters.length), 0.2 * a);
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(c.x, c.y); ctx.stroke();
  });
  ctx.lineWidth = 1;
  if (disp.edges) DATA.docs.forEach((d, i) => {
    for (const j of (d.nn || [])) {
      const nb = DATA.docs[j]; if (!nb) continue;
      const a = Math.min(alphaOf(d, i), alphaOf(nb, j)); if (a <= 0.03) continue;
      const [x, y] = toScreen(d), [nx, ny] = toScreen(nb);
      const col = nb.cluster === d.cluster ? clusterColor(d.cluster, DATA.clusters.length) : theme.accent;
      ctx.lineWidth = 1.8;
      ctx.strokeStyle = col;
      ctx.globalAlpha = 0.38 * a;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(nx, ny); ctx.stroke();
      ctx.globalAlpha = 1; ctx.lineWidth = 1;
    }
  });
  DATA.docs.forEach((d, i) => {
    const a = alphaOf(d, i); if (a <= 0.03) return;
    const [x, y] = toScreen(d), r = d._r * Math.max(0.6, Math.min(cam.scale, 2.4)), col = clusterColor(d.cluster, DATA.clusters.length);
    ctx.globalAlpha = a;
    if (disp.glow) {
      // fixed-width halo (the smallest star's), hugging each star's edge
      const gw = 6.6 * Math.max(0.6, Math.min(cam.scale, 2.4));
      const gg = ctx.createRadialGradient(x, y, r, x, y, r + gw); gg.addColorStop(0, withAlpha(col, 0.5)); gg.addColorStop(1, withAlpha(col, 0)); ctx.fillStyle = gg; ctx.beginPath(); ctx.arc(x, y, r + gw, 0, 7); ctx.fill();
    }
    ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
    ctx.strokeStyle = theme.ink; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(x, y, r + 0.5, 0, 7); ctx.stroke();
    ctx.fillStyle = "rgba(255,255,255,.55)"; ctx.beginPath(); ctx.arc(x - r * 0.3, y - r * 0.3, r * 0.35, 0, 7); ctx.fill();
    ctx.globalAlpha = 1;
    if (d === hover || d === selected) { ctx.strokeStyle = col; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(x, y, r + 5, 0, 7); ctx.stroke(); }
    if (d === selected) {   // standing glow on the selected star (even with glow off)
      const gw = 2 * 6.6 * Math.max(0.6, Math.min(cam.scale, 2.4));
      const sg = ctx.createRadialGradient(x, y, r, x, y, r + gw);
      sg.addColorStop(0, withAlpha(col, 0.55)); sg.addColorStop(1, withAlpha(col, 0));
      ctx.fillStyle = sg; ctx.beginPath(); ctx.arc(x, y, r + gw, 0, 7); ctx.fill();
    }
  });
  // semantic-neighbour edges of the focused star (cross-cluster edges in accent)
  const f = hover || selected;
  if (f && f.nn) {
    const [fx, fy] = toScreen(f);
    ctx.lineWidth = 2; ctx.globalAlpha = 0.7;
    for (const j of f.nn) {
      const nb = DATA.docs[j]; if (!nb) continue;
      const [nx, ny] = toScreen(nb);
      ctx.strokeStyle = nb.cluster === f.cluster ? clusterColor(nb.cluster, DATA.clusters.length) : theme.accent;
      ctx.beginPath(); ctx.moveTo(fx, fy); ctx.lineTo(nx, ny); ctx.stroke();
      ctx.beginPath(); ctx.arc(nx, ny, nb._r + 4, 0, 7); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
}

// ---- loop ----------------------------------------------------------------
function loop() { twinkle += 0.02; stepAnim(); stepPlay(); if (usingGL) drawGL(); else draw2d(); positionLabels(); raf = requestAnimationFrame(loop); }

// ---- camera --------------------------------------------------------------
// The camera animates in (data-space centre, log scale) so a combined pan+zoom
// flight follows a natural path instead of drifting sideways.
function camCenter(c) { const S = fit.s * c.scale; return [fit.cx - c.x / S, fit.cy - c.y / S]; }
function camFromCenter(ccx, ccy, scale) { const S = fit.s * scale; return { x: (fit.cx - ccx) * S, y: (fit.cy - ccy) * S, scale }; }
function flyCam(to, ms = 650) { anim = { from: { ...cam }, to, t0: performance.now(), ms }; }
function stepAnim() {
  if (!anim) return;
  const p = Math.min(1, (performance.now() - anim.t0) / anim.ms);
  const e = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;   // easeInOutCubic
  const [ax, ay] = camCenter(anim.from), [bx, by] = camCenter(anim.to);
  const scale = Math.exp(Math.log(anim.from.scale) * (1 - e) + Math.log(anim.to.scale) * e);
  Object.assign(cam, camFromCenter(ax + (bx - ax) * e, ay + (by - ay) * e, scale));
  if (p >= 1) anim = null;
}
function flyToDoc(d) {
  const scale = Math.min(8, Math.max(cam.scale, 2.2));
  flyCam(camFromCenter(d.x, d.y, scale));
}
function flyToCluster(id) {
  const members = DATA ? DATA.docs.filter((d) => d.cluster === id) : [];
  if (!members.length) return;
  let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
  for (const d of members) { minx = Math.min(minx, d.x); maxx = Math.max(maxx, d.x); miny = Math.min(miny, d.y); maxy = Math.max(maxy, d.y); }
  const pad = 140, w = el.canvas.clientWidth, h = el.canvas.clientHeight;
  const scale = Math.max(0.4, Math.min(8,
    Math.min((w - pad * 2) / (((maxx - minx) || 1) * fit.s), (h - pad * 2) / (((maxy - miny) || 1) * fit.s))));
  flyCam(camFromCenter((minx + maxx) / 2, (miny + maxy) / 2, scale));
}
function resetView() { flyCam({ x: 0, y: 0, scale: 1 }); }

// ---- timeline --------------------------------------------------------------
// Configure the scrubber from the docs' content years. Needs ≥2 distinct years to be
// meaningful; otherwise it's hidden and the time filter stays off (timeCut = null).
function setupTimeline() {
  stopPlay();
  const years = DATA.docs.map((d) => d.year).filter((y) => y);
  const uniq = new Set(years);
  if (uniq.size < 2) {
    timeCut = null; timeMin = timeMax = 0;
    el.timeline.hidden = true; el.hint.hidden = false;
    return;
  }
  timeMin = Math.min(...years); timeMax = Math.max(...years);
  timeCut = timeMax;   // start showing everything
  el.timeRange.min = String(timeMin);
  el.timeRange.max = String(timeMax);
  el.timeRange.value = String(timeMax);
  el.timeline.hidden = false;
  el.hint.hidden = true;   // timeline takes the bottom-centre slot
  updateTimeLabel();
}
function setTimeCut(y) {
  timeCut = y;
  if (el.timeRange.value !== String(y)) el.timeRange.value = String(y);
  updateTimeLabel();
  if (usingGL) { updateVisibilityGL(); updateEdgeVisibility(); }
}
function updateTimeLabel() {
  const shown = DATA ? DATA.docs.filter((d) => d.year && d.year <= timeCut).length : 0;
  const total = DATA ? DATA.docs.filter((d) => d.year).length : 0;
  el.timeLabel.textContent = timeCut >= timeMax
    ? t("star_timeAll", { year: timeMax, n: total })
    : t("star_timeUpto", { year: timeCut, n: shown });
}
function togglePlay() { playing ? stopPlay() : startPlay(); }
function startPlay() {
  if (timeCut >= timeMax) setTimeCut(timeMin);   // replay from the start
  playing = true; playT0 = performance.now();
  el.playBtn.textContent = "⏸"; el.playBtn.classList.add("isPlaying");
}
function stopPlay() {
  if (!playing) return;
  playing = false;
  if (el.playBtn) { el.playBtn.textContent = "▶"; el.playBtn.classList.remove("isPlaying"); }
}
// Advance the cutoff ~800ms per year while playing; called each frame from loop().
function stepPlay() {
  if (!playing) return;
  const perYear = 800;
  const pos = timeMin + (performance.now() - playT0) / perYear;
  if (pos >= timeMax) { setTimeCut(timeMax); stopPlay(); return; }
  const y = Math.floor(pos);
  if (y !== timeCut) setTimeCut(y);
}

// ---- keyboard roaming ------------------------------------------------------
// Hop along the semantic-neighbour graph in the pressed direction: among the selected
// star's (undirected) neighbours, fly to the one whose screen bearing best matches the
// arrow — must be at least loosely that way (cos > 0.2), else the key does nothing.
function hopTowards(v) {
  if (!selected) {
    const w = el.canvas.clientWidth, h = el.canvas.clientHeight;
    let best = null, bd = Infinity;
    DATA.docs.forEach((d, i) => {
      if (alphaOf(d, i) < 0.5) return;
      const [x, y] = toScreen(d);
      const dist = Math.hypot(x - w / 2, y - h / 2);
      if (dist < bd) { bd = dist; best = d; }
    });
    if (best) { flyToDoc(best); openInspector(best); }
    return;
  }
  const [sx, sy] = toScreen(selected);
  let best = null, bs = 0.2;
  for (const j of ((DATA._adj && DATA._adj[selected._i]) || [])) {
    const nb = DATA.docs[j];
    if (!nb || alphaOf(nb, j) < 0.5) continue;
    const [x, y] = toScreen(nb);
    const dx = x - sx, dy = y - sy, len = Math.hypot(dx, dy) || 1;
    const score = (dx * v[0] + dy * v[1]) / len;
    if (score > bs) { bs = score; best = nb; }
  }
  if (best) { flyToDoc(best); openInspector(best); }
}

// ---- search --------------------------------------------------------------
function setSearch(v) { if (el.search) el.search.value = v; applySearch(v); }
function applySearch(q) {
  q = (q || "").trim().toLowerCase();
  if (!DATA || !q) { matched = null; if (usingGL) updateVisibilityGL(); return; }
  matched = new Set();
  DATA.docs.forEach((d, i) => {
    const cl = DATA.clusters[d.cluster];
    if (String(d.title).toLowerCase().includes(q) || (cl && String(cl.label).toLowerCase().includes(q))) matched.add(i);
  });
  if (usingGL) updateVisibilityGL();
}
// Enter in the search box: literal hits → fly to the best one (earliest, then
// shortest title). ZERO literal hits → transparently fall back to SEMANTIC search
// (the /ask retrieval endpoints), light up the top hits and fly to the first.
let semSeq = 0;
function jumpToMatch() {
  if (!DATA) return;
  const q = el.search.value.trim();
  if (!q) return;
  if (matched && matched.size) {
    const lq = q.toLowerCase();
    let best = null, bs = Infinity;
    for (const i of matched) {
      const d = DATA.docs[i];
      if (hidden.has(d.cluster)) continue;
      const pos = String(d.title).toLowerCase().indexOf(lq);
      const s = (pos < 0 ? 999 : pos) * 1000 + String(d.title).length;
      if (s < bs) { bs = s; best = d; }
    }
    if (best) { flyToDoc(best); openInspector(best); }
    return;
  }
  semanticJump(q);
}
async function semanticJump(q) {
  const seq = ++semSeq, src = source;
  setStatus(t("star_semSearching"), true);
  let hits = [];
  try {
    const r = src === "archive"
      ? await post("/api/archives/search", { query: q })
      : await post("/api/library/search", { query: q });
    hits = (r && r.results) || [];
  } catch { /* treated as no hits */ }
  // stale? (newer search fired / source switched / query edited / map closed)
  if (seq !== semSeq || src !== source || !DATA || !el.overlay.classList.contains("isOpen")
    || el.search.value.trim() !== q) return;
  const byId = new Map(DATA.docs.map((d) => [d.id, d]));
  const found = [];
  for (const h of hits) {
    const d = byId.get(h.docId || h.file);
    if (d && !hidden.has(d.cluster) && !found.includes(d)) found.push(d);
    if (found.length >= 8) break;
  }
  if (!found.length) {
    setStatus(t("star_semNone"));
    setTimeout(() => { if (seq === semSeq && el.status.textContent === t("star_semNone")) setStatus(""); }, 1600);
    return;
  }
  setStatus("");
  matched = new Set(found.map((d) => d._i));   // dim everything but the semantic hits
  if (usingGL) updateVisibilityGL();
  flyToDoc(found[0]);
  openInspector(found[0]);
}

// ---- interaction ---------------------------------------------------------
function wireCanvas() {
  const cv = el.canvas;
  cv.addEventListener("mousedown", (e) => { anim = null; drag = { x: e.clientX, y: e.clientY, cx: cam.x, cy: cam.y, moved: false }; });
  // Double-click: on a star → fly in and inspect it; on empty sky → reset the view.
  cv.addEventListener("dblclick", (e) => {
    const d = pick(e.clientX, e.clientY);
    if (d) { flyToDoc(d); openInspector(d); } else resetView();
  });
  window.addEventListener("mouseup", (e) => { if (drag && !drag.moved) clickAt(e.clientX, e.clientY); drag = null; });
  window.addEventListener("mousemove", (e) => {
    if (!el.overlay.classList.contains("isOpen") || !DATA) return;
    if (drag) {
      cam.x = drag.cx + (e.clientX - drag.x); cam.y = drag.cy + (e.clientY - drag.y);
      if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > 4) drag.moved = true;
      drag.ex = e.clientX; drag.ey = e.clientY; cv.style.cursor = "grabbing"; return;
    }
    // Panels float over the canvas (inspector, legend, header…) — moving the mouse
    // across them must not pick the stars underneath. Only the bare canvas and the
    // cluster labels (which deliberately pick-through) drive hover.
    const tgt = e.target;
    if (tgt !== cv && !(tgt && tgt.classList && tgt.classList.contains("starMapLabel"))) {
      if (hover) { hover = null; hideTip(); }
      return;
    }
    const d = pick(e.clientX, e.clientY);
    hover = d; cv.style.cursor = d ? "pointer" : "grab";
    if (d) {
      el.tip.hidden = false;
      const [tx, ty] = canvasXY(e.clientX, e.clientY);
      el.tip.style.left = (tx + 14) + "px"; el.tip.style.top = (ty + 14) + "px";
      el.tip.innerHTML = `<div class="starMapTipTitle"></div><div class="starMapTipMeta"></div>`;
      el.tip.querySelector(".starMapTipTitle").textContent = d.title;
      el.tip.querySelector(".starMapTipMeta").textContent = [
        DATA.clusters[d.cluster] ? DATA.clusters[d.cluster].label : "",
        kindLabel(d.kind),
        d.blocks ? t("star_blocksN", { n: d.blocks }) : "",
        DATA._hubbed ? t("star_hubN", { n: d._hub }) : "",
      ].filter(Boolean).join(" · ");
    } else hideTip();
  });
  cv.addEventListener("wheel", (e) => {
    e.preventDefault();
    anim = null;
    const f = Math.exp(-e.deltaY * 0.0012), w = cv.clientWidth, h = cv.clientHeight, rect = cv.getBoundingClientRect();
    const mx = e.clientX - rect.left - w / 2 - cam.x, my = e.clientY - rect.top - h / 2 - cam.y;
    cam.x -= mx * (f - 1); cam.y -= my * (f - 1); cam.scale = Math.max(0.4, Math.min(cam.scale * f, 8));
  }, { passive: false });
}
function canvasXY(px, py) { const r = el.canvas.getBoundingClientRect(); return [px - r.left, py - r.top]; }
function pick(px, py) {
  if (!DATA) return null;
  const [cx, cy] = canvasXY(px, py);
  let best = null, bd = 18;
  for (const d of DATA.docs) {
    // Skip hidden AND search-dimmed stars: a 15%-alpha star is visually "empty sky",
    // and picking it made clicks there LOOK like the inspector refused to close.
    if (alphaOf(d, d._i) < 0.5) continue;
    const [x, y] = toScreen(d); const dist = Math.hypot(x - cx, y - cy);
    if (dist < bd) { bd = dist; best = d; }
  }
  return best;
}
// Clicking a star opens/switches the inspector; clicking empty sky does NOT close it
// (user's rule: the panel closes ONLY via its × button or Escape).
function clickAt(px, py) { const d = pick(px, py); if (d) openInspector(d); }
function hideTip() { if (el.tip) el.tip.hidden = true; }
const kindLabel = (k) => ({ video: "视频", url: "网页", paper: "论文", pdf: "PDF", doc: "文档", chat: "对话" }[k] || k);

// ---- PNG export ------------------------------------------------------------
// Composite the (GL or 2D) canvas plus the HTML cluster labels onto an offscreen
// canvas and download it. The GL context keeps preserveDrawingBuffer so the last
// frame is still readable here.
function exportPng() {
  if (!DATA) return;
  const w = el.canvas.width, h = el.canvas.height;
  const out = document.createElement("canvas"); out.width = w; out.height = h;
  const ctx = out.getContext("2d");
  ctx.fillStyle = theme.paper; ctx.fillRect(0, 0, w, h);
  ctx.drawImage(el.canvas, 0, 0, w, h);
  // labels: same math as positionLabels, in device pixels
  if (disp.labels) {
    const cen = {};
    for (const d of DATA.docs) { const c = cen[d.cluster] || (cen[d.cluster] = { x: 0, y: 0, n: 0 }); const [x, y] = toScreen(d); c.x += x; c.y += y; c.n++; }
    ctx.font = `600 ${14.5 * DPR}px system-ui, sans-serif`;
    ctx.textAlign = "center"; ctx.textBaseline = "bottom";
    DATA.clusters.forEach((c) => {
      const e = cen[c.id]; if (!e || hidden.has(c.id) || cam.scale >= 3.5) return;
      const x = (e.x / e.n) * DPR, y = ((e.y / e.n) - 12) * DPR;
      ctx.shadowColor = theme.paper; ctx.shadowBlur = 5 * DPR;
      ctx.fillStyle = clusterColor(c.id, DATA.clusters.length);
      ctx.fillText(c.label, x, y);
    });
    ctx.shadowBlur = 0;
  }
  const a = document.createElement("a");
  const ts = new Date(), p = (n) => String(n).padStart(2, "0");
  a.download = `starmap-${source}-${ts.getFullYear()}${p(ts.getMonth() + 1)}${p(ts.getDate())}-${p(ts.getHours())}${p(ts.getMinutes())}.png`;
  a.href = out.toDataURL("image/png");
  a.click();
}

// ---- legend --------------------------------------------------------------
function buildLegend() {
  el.legendList.innerHTML = "";
  DATA.clusters.forEach((c) => {
    const li = document.createElement("li"), col = clusterColor(c.id, DATA.clusters.length);
    li.innerHTML = `<span class="starMapDot"></span><span class="starMapNm"></span><span class="starMapCt"></span>`;
    li.querySelector(".starMapDot").style.cssText = `background:${col};color:${col}`;
    li.querySelector(".starMapNm").textContent = c.label;
    li.querySelector(".starMapCt").textContent = c.size;
    li.title = t("star_legendHint");
    // Single click toggles ONE cluster; double click isolates it (dbl again → all).
    // The 220ms timer keeps the first click of a double from also toggling.
    let tmr = 0;
    li.addEventListener("click", () => {
      clearTimeout(tmr);
      tmr = setTimeout(() => {
        if (hidden.has(c.id)) hidden.delete(c.id); else hidden.add(c.id);
        syncLegend();
      }, 220);
    });
    li.addEventListener("dblclick", () => {
      clearTimeout(tmr);
      if (hidden.size === DATA.clusters.length - 1 && !hidden.has(c.id)) hidden.clear();
      else hidden = new Set(DATA.clusters.map((x) => x.id).filter((id) => id !== c.id));
      syncLegend();
    });
    el.legendList.appendChild(li);
  });
  syncLegend();
  el.legendFoot.innerHTML = `<span class="starMapLegendFootTxt"></span><span class="starMapLegendChevron" aria-hidden="true">▴</span>`;
  el.legendFoot.querySelector(".starMapLegendFootTxt").textContent = t("star_footN", { n: DATA.n, k: DATA.clusters.length });
  applyLegendCollapse();
}
// The foot line doubles as a collapse handle: fold the whole legend down to just
// the "N docs · K constellations" summary (handy once K climbs toward its cap of 40).
function applyLegendCollapse() {
  el.legend.classList.toggle("isCollapsed", legendCollapsed);
  el.legendFoot.title = t(legendCollapsed ? "star_legendExpand" : "star_legendCollapse");
}
function toggleLegendCollapse() {
  legendCollapsed = !legendCollapsed;
  try { localStorage.setItem("heykoko-starmap-legend-collapsed", legendCollapsed ? "1" : "0"); } catch {}
  applyLegendCollapse();
}
function syncLegend() {
  [...el.legendList.children].forEach((li, i) => li.classList.toggle("isDim", hidden.has(DATA.clusters[i].id)));
  if (usingGL) updateVisibilityGL();
}

// ---- inspector: the star's launchpad --------------------------------------
// Not a dead-end info card: open the doc / archived chat, hop to semantic
// neighbours, and ask about this doc or its whole constellation inline.
function openInspector(d) {
  selected = d;
  const cl = DATA.clusters[d.cluster];
  el.inspector.innerHTML = "";
  const kind = document.createElement("div"); kind.className = "starMapInspKind";
  kind.style.color = clusterColor(d.cluster, DATA.clusters.length);
  kind.textContent = [cl ? cl.label : "", kindLabel(d.kind), d.blocks ? t("star_blocksN", { n: d.blocks }) : "",
    DATA._hubbed ? t("star_hubN", { n: d._hub }) : ""].filter(Boolean).join(" · ");
  const title = document.createElement("div"); title.className = "starMapInspTitle"; title.textContent = d.title;
  el.inspector.append(kind, title);
  if (d.snippet) { const s = document.createElement("p"); s.className = "starMapInspSnippet"; s.textContent = d.snippet; el.inspector.appendChild(s); }

  // Semantic neighbours (precomputed at build time) — chips hop star to star.
  // A cross-cluster neighbour gets the accent border: a cross-domain bridge.
  const nbrs = (d.nn || []).map((j) => DATA.docs[j]).filter(Boolean);
  if (nbrs.length) {
    const row = document.createElement("div"); row.className = "starMapRelRow";
    const lab = document.createElement("span"); lab.className = "starMapRelLabel"; lab.textContent = "🔗 " + t("star_related");
    row.appendChild(lab);
    for (const nb of nbrs) {
      const chip = document.createElement("button"); chip.type = "button"; chip.className = "starMapRelChip";
      if (nb.cluster !== d.cluster) chip.classList.add("isBridge");
      chip.textContent = nb.title.length > 30 ? nb.title.slice(0, 29) + "…" : nb.title;
      chip.title = nb.title;
      chip.addEventListener("click", () => { flyToDoc(nb); openInspector(nb); });
      row.appendChild(chip);
    }
    el.inspector.appendChild(row);
  }

  // Open the underlying thing: library doc view / archived-chat preview. For the
  // library it joins the action ROW below the ask input; for archives it stands alone.
  const openBtn = document.createElement("button"); openBtn.type = "button"; openBtn.className = "starMapAskBtn";
  if (source === "library") {
    openBtn.textContent = "📖 " + t("star_openDoc");
    openBtn.title = t("star_openDocTip");
    openBtn.addEventListener("click", () => { closeStarMap(); openLibraryDoc(d.id); });
  } else {
    openBtn.textContent = "💬 " + t("star_openChat");
    openBtn.title = t("star_openChatTip");
    openBtn.addEventListener("click", () => { closeStarMap(); openArchivedChat(d.id); });
    el.inspector.appendChild(openBtn);
  }

  // Inline ask (library only — /ask scopes to library docIds). The answer never uses
  // the chat tab's history (runLibraryQuery builds its prompt from the docs alone);
  // the tab is only WHERE the question/answer bubbles land — and by default that's a
  // fresh tab so the ask doesn't silently mix into an unrelated conversation.
  // Layout: ask input → one row [open doc | ask this | ask cluster] → new-tab
  // checkbox → the document preview.
  if (source === "library") {
    const form = document.createElement("div"); form.className = "starMapAskForm";
    const input = document.createElement("input"); input.type = "text"; input.className = "starMapAskInput";
    input.placeholder = t("star_askPh");
    const newTabCb = document.createElement("input"); newTabCb.type = "checkbox"; newTabCb.checked = true;
    // Second toggle: jump to the chat tab after asking (default), or stay on the map
    // and keep exploring while the answer streams into the tab in the background.
    const jumpCb = document.createElement("input"); jumpCb.type = "checkbox"; jumpCb.checked = true;
    const go = (ids, scopeTitle) => {
      const q = input.value.trim();
      if (!q || !ids.length) { input.focus(); return; }
      let tab;
      if (newTabCb.checked) {
        tab = createTab(`🌌 ${scopeTitle.length > 24 ? scopeTitle.slice(0, 23) + "…" : scopeTitle}`, []);
        state.tabs.unshift(tab);
        saveTabs();
        switchTab(tab.id);
      } else {
        tab = getActiveTab();
      }
      if (!tab) return;
      if (jumpCb.checked) closeStarMap();
      else input.value = "";   // staying here — clear for the next question
      handleAskCommand(q, tab, { docIds: ids });
    };
    const clusterDocs = DATA.docs.filter((x) => x.cluster === d.cluster);
    const b1 = document.createElement("button"); b1.type = "button"; b1.className = "starMapAskBtn";
    b1.textContent = "✨ " + t("star_askThis");
    b1.title = t("star_askThisTip");
    b1.addEventListener("click", () => go([d.id], d.title));
    const label = cl ? (cl.label.length > 14 ? cl.label.slice(0, 13) + "…" : cl.label) : "";
    const b2 = document.createElement("button"); b2.type = "button"; b2.className = "starMapAskBtn";
    b2.textContent = "✨ " + t("star_askCluster", { label });
    b2.title = t("star_askClusterTip", { n: clusterDocs.length, label: cl ? cl.label : "" });
    b2.addEventListener("click", () => go(clusterDocs.map((x) => x.id), cl ? cl.label : d.title));
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") go([d.id], d.title); });
    const scopes = document.createElement("div"); scopes.className = "starMapAskScopes";
    scopes.append(openBtn, b1, b2);
    const cbLabel = document.createElement("label"); cbLabel.className = "checkboxLabel starMapAskNewTab";
    const cbText = document.createElement("span"); cbText.textContent = t("star_askNewTab");
    cbLabel.append(newTabCb, cbText);
    const jumpLabel = document.createElement("label"); jumpLabel.className = "checkboxLabel starMapAskNewTab";
    jumpLabel.title = t("star_askJumpTip");
    const jumpText = document.createElement("span"); jumpText.textContent = t("star_askJump");
    jumpLabel.append(jumpCb, jumpText);
    const opts = document.createElement("div"); opts.className = "starMapAskOpts";
    opts.append(cbLabel, jumpLabel);
    // Document preview — the library-style READ-ONLY render (markdown + images),
    // filling the rest of the panel. Loaded async and dropped silently if the user
    // has already moved on to another star by the time it arrives.
    const prev = document.createElement("div"); prev.className = "starMapDocPreview";
    prev.textContent = t("star_loading");
    post("/api/library/get", { docId: d.id }).then(({ doc, error }) => {
      if (selected !== d) return;
      if (error || !doc) { prev.hidden = true; return; }
      prev.textContent = "";
      let lastSec = null, any = false;
      for (const b of (doc.blocks || [])) {
        if (b.section && b.section !== lastSec) {
          lastSec = b.section;
          const h = document.createElement("div"); h.className = "starMapPrevSection"; h.textContent = b.section;
          prev.appendChild(h);
        }
        if (b.content) {
          const body = document.createElement("div"); body.className = "markdownBody starMapPrevBody";
          body.innerHTML = markdownToHtml(b.content);
          prev.appendChild(body); any = true;
        }
        if (b.image) {
          const img = document.createElement("img"); img.className = "starMapPrevImg";
          img.src = String(b.image).startsWith("data:") ? b.image : `data:${b.imageMime || "image/png"};base64,${b.image}`;
          prev.appendChild(img); any = true;
        }
      }
      if (!any) prev.hidden = true;
    }).catch(() => { if (selected === d) prev.hidden = true; });
    form.append(input, scopes, opts, prev);
    el.inspector.appendChild(form);
  }

  const close = document.createElement("button"); close.className = "starMapInspClose"; close.setAttribute("aria-label", "×"); close.textContent = "×";
  close.addEventListener("click", closeInspector); el.inspector.appendChild(close);
  el.inspector.classList.add("isOpen");
}
function closeInspector() { selected = null; if (el.inspector) el.inspector.classList.remove("isOpen"); }
