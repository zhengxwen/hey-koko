// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng
//
// Knowledge star map — a zoomable constellation view of the library / chat-archive
// embeddings. This module is LAZY-LOADED (dynamic import on first open, gate 1) so a
// chat-only user never downloads or parses it. It reads the precomputed cache from
// POST /api/library/starmap; if the cache is stale it enqueues the background
// `starmap` job and polls (gate 2 — nothing is computed until a user opens the map).
// Colours are read from the app's CSS theme variables and follow theme switches.

import { handleAskCommand } from "./library.js";
import { getActiveTab } from "./tabs.js";
import { t } from "./i18n.js";

const post = (url, body) => fetch(url, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}),
}).then((r) => r.json());

let el = {};                 // cached DOM refs
let wired = false;
let DATA = null;
let source = "library";
let cam = { x: 0, y: 0, scale: 1 };
let fit = { cx: 0, cy: 0, s: 1 };
let hidden = new Set();
let hover = null, selected = null, raf = 0, twinkle = 0, DPR = 1;
let theme = {};
let drag = null;

// ---- theme ---------------------------------------------------------------
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
function clusterColor(i, total) {
  const hues = [45, 210, 160, 300, 20, 255, 110, 330, 185, 235, 75, 285];
  const h = total <= hues.length ? hues[i % hues.length] : Math.round((i * 360) / total);
  const L = theme.dark ? 63 : 46;
  return `hsl(${h} 68% ${L}%)`;
}
function withAlpha(hsl, a) { return hsl.replace("hsl(", "hsla(").replace(")", ` / ${a})`); }

// ---- open / close --------------------------------------------------------
export async function openStarMap() {
  ensureDom();
  readTheme();
  el.overlay.classList.add("isOpen");
  el.overlay.setAttribute("aria-hidden", "false");
  resize();
  await load(source);
}
function closeStarMap() {
  el.overlay.classList.remove("isOpen");
  el.overlay.setAttribute("aria-hidden", "true");
  cancelAnimationFrame(raf); raf = 0;
  hideTip();
}

function ensureDom() {
  if (wired) return;
  el.overlay = document.querySelector("#starMapOverlay");
  el.canvas = document.querySelector("#starMapCanvas");
  el.legend = document.querySelector("#starMapLegend");
  el.legendList = document.querySelector("#starMapLegendList");
  el.legendFoot = document.querySelector("#starMapLegendFoot");
  el.inspector = document.querySelector("#starMapInspector");
  el.tip = document.querySelector("#starMapTip");
  el.status = document.querySelector("#starMapStatus");
  el.ctx = el.canvas.getContext("2d");

  document.querySelector("#starMapCloseBtn").addEventListener("click", closeStarMap);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && el.overlay.classList.contains("isOpen")) closeStarMap(); });
  el.overlay.querySelectorAll("[data-source]").forEach((b) =>
    b.addEventListener("click", () => { setSourceTab(b.dataset.source); }));

  window.addEventListener("resize", () => { if (el.overlay.classList.contains("isOpen")) { resize(); } });
  new MutationObserver(() => { if (el.overlay.classList.contains("isOpen")) readTheme(); })
    .observe(document.documentElement, { attributes: true, attributeFilter: ["data-mode", "data-theme"] });

  wireCanvas();
  applyText();
  wired = true;
}

// Fill the static overlay chrome from i18n (JS-driven so we don't extend the app's
// applyUILanguage id-map). Re-runs each open, which is enough for mid-session switches.
function applyText() {
  const set = (sel, key, vars) => { const n = el.overlay.querySelector(sel); if (n) n.textContent = t(key, vars); };
  set("#starMapTitleText", "star_title");
  set('[data-source="library"]', "star_srcLib");
  set('[data-source="archive"]', "star_srcArc");
  set("#starMapLegendTitle", "star_legendTitle");
  set("#starMapHint", "star_hint");
}

function setSourceTab(s) {
  source = s;
  el.overlay.querySelectorAll("[data-source]").forEach((b) =>
    b.setAttribute("aria-pressed", String(b.dataset.source === s)));
  load(s);
}

// ---- data load / build ---------------------------------------------------
async function load(which) {
  source = which;
  setStatus(t("star_loading"));
  let map;
  try { map = await post("/api/library/starmap", { source: which }); }
  catch { setStatus(t("star_error")); return; }
  if (map.stale || !map.docs || !map.docs.length) {
    DATA = null; cancelAnimationFrame(raf); raf = 0;
    clearCanvas();
    showBuildPrompt(which, map.stale ? "stale" : "empty");
    return;
  }
  DATA = map;
  DATA.docs.forEach((d) => { d._r = 3 + Math.min(9, Math.sqrt(d.blocks || 8) * 1.1); });
  hidden.clear(); selected = null; hover = null; cam = { x: 0, y: 0, scale: 1 };
  closeInspector();
  setStatus("");
  computeFit();
  buildLegend();
  if (!raf) loop();
}

function showBuildPrompt(which, why) {
  const msg = why === "empty" && which === "archive" ? t("star_archiveEmpty") : t("star_needBuild");
  el.status.innerHTML = "";
  const box = document.createElement("div");
  box.className = "starMapPrompt";
  const p = document.createElement("p"); p.textContent = msg; box.appendChild(p);
  const btn = document.createElement("button");
  btn.className = "starMapBuildBtn"; btn.textContent = t("star_build");
  btn.addEventListener("click", () => triggerBuild(which));
  box.appendChild(btn);
  el.status.appendChild(box);
  el.status.hidden = false;
}

async function triggerBuild(which) {
  setStatus(t("star_building"));
  try {
    await post("/api/jobs", { kind: "starmap", payload: { source: which }, label: "star map" });
  } catch { setStatus(t("star_error")); return; }
  // poll the cache until the job lands
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (source !== which || !el.overlay.classList.contains("isOpen")) return;
    let map; try { map = await post("/api/library/starmap", { source: which }); } catch { continue; }
    if (!map.stale && map.docs) { load(which); return; }
  }
  setStatus(t("star_error"));
}

function setStatus(text) {
  if (!text) { el.status.hidden = true; el.status.textContent = ""; return; }
  el.status.hidden = false; el.status.textContent = text;
}

// ---- geometry ------------------------------------------------------------
function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  const w = el.canvas.clientWidth, h = el.canvas.clientHeight;
  el.canvas.width = w * DPR; el.canvas.height = h * DPR;
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

// ---- render --------------------------------------------------------------
function clearCanvas() {
  if (!el.ctx) return;
  el.ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  el.ctx.fillStyle = theme.paper;
  el.ctx.fillRect(0, 0, el.canvas.clientWidth, el.canvas.clientHeight);
}
function loop() { twinkle += 0.02; draw(); raf = requestAnimationFrame(loop); }
function draw() {
  if (!DATA) return;
  const ctx = el.ctx, w = el.canvas.clientWidth, h = el.canvas.clientHeight;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  const grad = ctx.createRadialGradient(w * 0.5, h * 0.45, 0, w * 0.5, h * 0.45, Math.max(w, h) * 0.75);
  grad.addColorStop(0, theme.panel); grad.addColorStop(1, theme.paper);
  ctx.fillStyle = grad; ctx.fillRect(0, 0, w, h);

  const shown = (d) => !hidden.has(d.cluster);
  // cluster centroids in screen space (for constellation lines + labels)
  const cent = {};
  for (const d of DATA.docs) { const c = cent[d.cluster] || (cent[d.cluster] = { x: 0, y: 0, n: 0 }); const [x, y] = toScreen(d); c.x += x; c.y += y; c.n++; }
  for (const k in cent) { cent[k].x /= cent[k].n; cent[k].y /= cent[k].n; }

  ctx.lineWidth = 1;
  for (const d of DATA.docs) {
    if (!shown(d)) continue;
    const [x, y] = toScreen(d), c = cent[d.cluster];
    ctx.strokeStyle = withAlpha(clusterColor(d.cluster, DATA.clusters.length), 0.1);
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(c.x, c.y); ctx.stroke();
  }
  for (const d of DATA.docs) {
    if (!shown(d)) continue;
    const [x, y] = toScreen(d), r = d._r * Math.max(0.6, Math.min(cam.scale, 2.4));
    const col = clusterColor(d.cluster, DATA.clusters.length);
    const tw = 1 + 0.16 * Math.sin(twinkle * 1.3 + d.x * 20 + d.y * 15);
    const gg = ctx.createRadialGradient(x, y, 0, x, y, r * 3.2 * tw);
    gg.addColorStop(0, withAlpha(col, 0.5)); gg.addColorStop(1, withAlpha(col, 0));
    ctx.fillStyle = gg; ctx.beginPath(); ctx.arc(x, y, r * 3.2 * tw, 0, 7); ctx.fill();
    ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,.55)"; ctx.beginPath(); ctx.arc(x - r * 0.3, y - r * 0.3, r * 0.35, 0, 7); ctx.fill();
    if (d === hover || d === selected) { ctx.strokeStyle = col; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(x, y, r + 5, 0, 7); ctx.stroke(); }
  }
  if (cam.scale < 3.5) {
    ctx.font = '600 12px -apple-system,"PingFang SC",sans-serif'; ctx.textAlign = "center";
    for (const c of DATA.clusters) {
      if (hidden.has(c.id) || !cent[c.id]) continue;
      ctx.fillStyle = withAlpha(clusterColor(c.id, DATA.clusters.length), 0.92);
      ctx.shadowColor = "rgba(0,0,0,.85)"; ctx.shadowBlur = 8;
      ctx.fillText(c.label, cent[c.id].x, cent[c.id].y - 14); ctx.shadowBlur = 0;
    }
  }
}

// ---- interaction ---------------------------------------------------------
function wireCanvas() {
  const cv = el.canvas;
  cv.addEventListener("mousedown", (e) => { drag = { x: e.clientX, y: e.clientY, cx: cam.x, cy: cam.y, moved: false }; });
  window.addEventListener("mouseup", () => { if (drag && !drag.moved) clickAt(drag.ex, drag.ey); drag = null; });
  window.addEventListener("mousemove", (e) => {
    if (!el.overlay.classList.contains("isOpen") || !DATA) return;
    if (drag) {
      cam.x = drag.cx + (e.clientX - drag.x); cam.y = drag.cy + (e.clientY - drag.y);
      if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > 4) drag.moved = true;
      drag.ex = e.clientX; drag.ey = e.clientY; cv.style.cursor = "grabbing"; return;
    }
    const d = pick(e.clientX, e.clientY);
    hover = d; cv.style.cursor = d ? "pointer" : "grab";
    if (d) {
      el.tip.hidden = false;
      const [tx, ty] = canvasXY(e.clientX, e.clientY);
      el.tip.style.left = (tx + 14) + "px"; el.tip.style.top = (ty + 14) + "px";
      el.tip.innerHTML = `<div class="starMapTipTitle"></div><div class="starMapTipMeta"></div>`;
      el.tip.querySelector(".starMapTipTitle").textContent = d.title;
      el.tip.querySelector(".starMapTipMeta").textContent = `${DATA.clusters[d.cluster] ? DATA.clusters[d.cluster].label : ""} · ${kindLabel(d.kind)}`;
    } else hideTip();
  });
  cv.addEventListener("wheel", (e) => {
    e.preventDefault();
    const f = Math.exp(-e.deltaY * 0.0012), w = cv.clientWidth, h = cv.clientHeight;
    const mx = e.clientX - cv.getBoundingClientRect().left - w / 2 - cam.x;
    const my = e.clientY - cv.getBoundingClientRect().top - h / 2 - cam.y;
    cam.x -= mx * (f - 1); cam.y -= my * (f - 1); cam.scale = Math.max(0.4, Math.min(cam.scale * f, 8));
  }, { passive: false });
}
function canvasXY(px, py) { const r = el.canvas.getBoundingClientRect(); return [px - r.left, py - r.top]; }
function pick(px, py) {
  if (!DATA) return null;
  const [cx, cy] = canvasXY(px, py);
  let best = null, bd = 18;
  for (const d of DATA.docs) { if (hidden.has(d.cluster)) continue; const [x, y] = toScreen(d); const dist = Math.hypot(x - cx, y - cy); if (dist < bd) { bd = dist; best = d; } }
  return best;
}
function clickAt(px, py) { const d = pick(px, py); if (d) openInspector(d); else closeInspector(); }
function hideTip() { if (el.tip) el.tip.hidden = true; }
const kindLabel = (k) => ({ video: "视频", url: "网页", paper: "论文", pdf: "PDF", doc: "文档", chat: "对话" }[k] || k);

// ---- legend --------------------------------------------------------------
function buildLegend() {
  el.legendList.innerHTML = "";
  DATA.clusters.forEach((c) => {
    const li = document.createElement("li");
    const col = clusterColor(c.id, DATA.clusters.length);
    li.innerHTML = `<span class="starMapDot"></span><span class="starMapNm"></span><span class="starMapCt"></span>`;
    li.querySelector(".starMapDot").style.cssText = `background:${col};color:${col}`;
    li.querySelector(".starMapNm").textContent = c.label;
    li.querySelector(".starMapCt").textContent = c.size;
    li.addEventListener("click", () => {
      if (hidden.size === DATA.clusters.length - 1 && !hidden.has(c.id)) hidden.clear();
      else hidden = new Set(DATA.clusters.map((x) => x.id).filter((id) => id !== c.id));
      syncLegend();
    });
    el.legendList.appendChild(li);
  });
  syncLegend();
  el.legendFoot.textContent = t("star_footN", { n: DATA.n, k: DATA.clusters.length });
}
function syncLegend() {
  [...el.legendList.children].forEach((li, i) => li.classList.toggle("isDim", hidden.has(DATA.clusters[i].id)));
}

// ---- inspector + ask -----------------------------------------------------
function openInspector(d) {
  selected = d;
  const cl = DATA.clusters[d.cluster];
  el.inspector.innerHTML = "";
  const kind = document.createElement("div"); kind.className = "starMapInspKind";
  kind.style.color = clusterColor(d.cluster, DATA.clusters.length);
  kind.textContent = `${cl ? cl.label : ""} · ${kindLabel(d.kind)}`;
  const title = document.createElement("div"); title.className = "starMapInspTitle"; title.textContent = d.title;
  el.inspector.append(kind, title);
  if (d.snippet) { const s = document.createElement("p"); s.className = "starMapInspSnippet"; s.textContent = d.snippet; el.inspector.appendChild(s); }
  if (source === "library") {
    const ask = document.createElement("button"); ask.className = "starMapAskBtn";
    ask.textContent = t("star_askCluster", { label: cl ? cl.label : "" });
    ask.addEventListener("click", () => askConstellation(d.cluster));
    el.inspector.appendChild(ask);
  }
  const close = document.createElement("button"); close.className = "starMapInspClose"; close.setAttribute("aria-label", "×"); close.textContent = "×";
  close.addEventListener("click", closeInspector); el.inspector.appendChild(close);
  el.inspector.classList.add("isOpen");
}
function closeInspector() { selected = null; if (el.inspector) el.inspector.classList.remove("isOpen"); }

async function askConstellation(clusterId) {
  const ids = DATA.docs.filter((d) => d.cluster === clusterId).map((d) => d.id);
  const tab = getActiveTab();
  if (!tab || !ids.length) return;
  const query = window.prompt(t("star_askPrompt", { label: DATA.clusters[clusterId].label }));
  if (!query) return;
  closeStarMap();
  handleAskCommand(query, tab, { docIds: ids });
}
