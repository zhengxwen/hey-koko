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

import { handleAskCommand } from "./library.js";
import { getActiveTab } from "./tabs.js";
import { t } from "./i18n.js";

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
let hover = null, selected = null, raf = 0, twinkle = 0, DPR = 1;
let theme = {};
let drag = null;
let usingGL = false;
let G = null;          // WebGL state: { gl, pt, ln, bg, buf, n }
let labelEls = [];

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
function clusterHue(i, total) { return total <= HUES.length ? HUES[i % HUES.length] : Math.round((i * 360) / total); }
function clusterColor(i, total) { return `hsl(${clusterHue(i, total)} 68% ${theme.dark ? 63 : 46}%)`; }
function clusterRGB(i, total) { return hslToRgb(clusterHue(i, total), 0.68, theme.dark ? 0.63 : 0.46); }
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
  el.stage = el.canvas.parentElement;
  el.legend = document.querySelector("#starMapLegend");
  el.legendList = document.querySelector("#starMapLegendList");
  el.legendFoot = document.querySelector("#starMapLegendFoot");
  el.inspector = document.querySelector("#starMapInspector");
  el.tip = document.querySelector("#starMapTip");
  el.status = document.querySelector("#starMapStatus");
  el.labels = document.createElement("div"); el.labels.className = "starMapLabels";
  el.stage.insertBefore(el.labels, el.tip);

  try {
    const gl = el.canvas.getContext("webgl", { alpha: false, antialias: true, premultipliedAlpha: false });
    if (gl) { initGL(gl); usingGL = true; }
  } catch { /* fall through to 2D */ }
  if (!usingGL) el.ctx = el.canvas.getContext("2d");

  document.querySelector("#starMapCloseBtn").addEventListener("click", closeStarMap);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && el.overlay.classList.contains("isOpen")) closeStarMap(); });
  el.overlay.querySelectorAll("[data-source]").forEach((b) => b.addEventListener("click", () => setSourceTab(b.dataset.source)));
  window.addEventListener("resize", () => { if (el.overlay.classList.contains("isOpen")) resize(); });
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
}
function setSourceTab(s) {
  source = s;
  el.overlay.querySelectorAll("[data-source]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.source === s)));
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
    clearScreen(); clearLabels();
    showBuildPrompt(which, map.stale ? "stale" : "empty");
    return;
  }
  DATA = map;
  DATA.docs.forEach((d) => { d._r = 3 + Math.min(9, Math.sqrt(d.blocks || 8) * 1.1); });
  hidden.clear(); selected = null; hover = null; cam = { x: 0, y: 0, scale: 1 };
  closeInspector();
  setStatus("");
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
  setStatus(t("star_building"));
  try { await post("/api/jobs", { kind: "starmap", payload: { source: which }, label: "star map" }); }
  catch { setStatus(t("star_error")); return; }
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
const V_PT = `
  precision mediump float;
  attribute vec2 a_pos; attribute float a_size; attribute vec3 a_color; attribute float a_shown;
  uniform vec2 u_center; uniform vec2 u_scale; uniform vec2 u_offset; uniform float u_sizeFactor;
  varying vec3 v_color; varying float v_shown; varying float v_phase;
  void main(){
    v_color = a_color; v_shown = a_shown; v_phase = a_pos.x * 20.0 + a_pos.y * 15.0;
    gl_Position = vec4((a_pos - u_center) * u_scale + u_offset, 0.0, 1.0);
    gl_PointSize = a_shown > 0.5 ? a_size * u_sizeFactor : 0.0;
  }`;
const F_PT = `
  precision mediump float;
  varying vec3 v_color; varying float v_shown; varying float v_phase; uniform float u_time;
  void main(){
    if (v_shown < 0.5) discard;
    float d = length(gl_PointCoord - vec2(0.5)) * 2.0;
    float core = 1.0 - smoothstep(0.21, 0.30, d);
    float glow = (1.0 - smoothstep(0.0, 1.0, d)) * 0.45;
    float a = max(core, glow);
    if (a < 0.01) discard;
    a *= 0.82 + 0.18 * sin(u_time * 1.3 + v_phase);
    vec3 col = mix(v_color, vec3(1.0), core * 0.55);
    gl_FragColor = vec4(col, a);
  }`;
const V_LN = `
  precision mediump float;
  attribute vec2 a_pos; attribute vec3 a_color; attribute float a_shown;
  uniform vec2 u_center; uniform vec2 u_scale; uniform vec2 u_offset;
  varying vec3 v_color;
  void main(){ v_color = a_color; gl_Position = a_shown > 0.5 ? vec4((a_pos - u_center) * u_scale + u_offset, 0.0, 1.0) : vec4(2.0, 2.0, 0.0, 1.0); }`;
const F_LN = `precision mediump float; varying vec3 v_color; void main(){ gl_FragColor = vec4(v_color, 0.13); }`;
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
  G = { gl, pt: program(gl, V_PT, F_PT), ln: program(gl, V_LN, F_LN), bg: program(gl, V_BG, F_BG), buf: {}, n: 0, ln2: 0 };
  gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  for (const k of ["pos", "size", "color", "shown", "lpos", "lcolor", "lshown"]) G.buf[k] = gl.createBuffer();
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
  const lpos = new Float32Array(n * 4), lcolor = new Float32Array(n * 6), lshown = new Float32Array(n * 2);
  docs.forEach((d, i) => {
    pos[i * 2] = d.x; pos[i * 2 + 1] = d.y; size[i] = d._r; shown[i] = 1;
    const rgb = clusterRGB(d.cluster, K); color[i * 3] = rgb[0]; color[i * 3 + 1] = rgb[1]; color[i * 3 + 2] = rgb[2];
    const c = cen[d.cluster];
    lpos[i * 4] = d.x; lpos[i * 4 + 1] = d.y; lpos[i * 4 + 2] = c.x; lpos[i * 4 + 3] = c.y;
    lshown[i * 2] = 1; lshown[i * 2 + 1] = 1;
    for (let v = 0; v < 2; v++) { lcolor[i * 6 + v * 3] = rgb[0]; lcolor[i * 6 + v * 3 + 1] = rgb[1]; lcolor[i * 6 + v * 3 + 2] = rgb[2]; }
  });
  G.ln2 = n * 2;
  upload(gl, G.buf.pos, pos); upload(gl, G.buf.size, size); upload(gl, G.buf.color, color); upload(gl, G.buf.shown, shown);
  upload(gl, G.buf.lpos, lpos); upload(gl, G.buf.lcolor, lcolor); upload(gl, G.buf.lshown, lshown);
  G._shown = shown; G._lshown = lshown;
}
function rebuildColors() {
  if (!G || !DATA) return;
  const gl = G.gl, docs = DATA.docs, K = DATA.clusters.length;
  const color = new Float32Array(docs.length * 3), lcolor = new Float32Array(docs.length * 6);
  docs.forEach((d, i) => {
    const rgb = clusterRGB(d.cluster, K);
    color[i * 3] = rgb[0]; color[i * 3 + 1] = rgb[1]; color[i * 3 + 2] = rgb[2];
    for (let v = 0; v < 2; v++) { lcolor[i * 6 + v * 3] = rgb[0]; lcolor[i * 6 + v * 3 + 1] = rgb[1]; lcolor[i * 6 + v * 3 + 2] = rgb[2]; }
  });
  upload(gl, G.buf.color, color); upload(gl, G.buf.lcolor, lcolor);
  buildLabels(); // label colours too
}
function updateVisibilityGL() {
  if (!G || !DATA) return;
  const gl = G.gl;
  DATA.docs.forEach((d, i) => { const s = hidden.has(d.cluster) ? 0 : 1; G._shown[i] = s; G._lshown[i * 2] = s; G._lshown[i * 2 + 1] = s; });
  upload(gl, G.buf.shown, G._shown); upload(gl, G.buf.lshown, G._lshown);
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
  // constellation lines
  gl.useProgram(G.ln);
  setTr(gl, G.ln, tr);
  attrib(gl, G.ln, "a_pos", G.buf.lpos, 2); attrib(gl, G.ln, "a_color", G.buf.lcolor, 3); attrib(gl, G.ln, "a_shown", G.buf.lshown, 1);
  gl.drawArrays(gl.LINES, 0, G.ln2);
  // stars
  gl.useProgram(G.pt);
  setTr(gl, G.pt, tr);
  const zoom = Math.max(0.6, Math.min(cam.scale, 2.4));
  gl.uniform1f(gl.getUniformLocation(G.pt, "u_sizeFactor"), DPR * zoom * 3.4 * 2.0);
  gl.uniform1f(gl.getUniformLocation(G.pt, "u_time"), twinkle);
  attrib(gl, G.pt, "a_pos", G.buf.pos, 2); attrib(gl, G.pt, "a_size", G.buf.size, 1);
  attrib(gl, G.pt, "a_color", G.buf.color, 3); attrib(gl, G.pt, "a_shown", G.buf.shown, 1);
  gl.drawArrays(gl.POINTS, 0, G.n);
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
    s.dataset.cluster = c.id; el.labels.appendChild(s); labelEls[c.id] = s;
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
    const show = !hidden.has(c.id) && cam.scale < 3.5;
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
  const shown = (d) => !hidden.has(d.cluster);
  const cen = {};
  for (const d of DATA.docs) { const c = cen[d.cluster] || (cen[d.cluster] = { x: 0, y: 0, n: 0 }); const [x, y] = toScreen(d); c.x += x; c.y += y; c.n++; }
  for (const k in cen) { cen[k].x /= cen[k].n; cen[k].y /= cen[k].n; }
  ctx.lineWidth = 1;
  for (const d of DATA.docs) { if (!shown(d)) continue; const [x, y] = toScreen(d), c = cen[d.cluster]; ctx.strokeStyle = withAlpha(clusterColor(d.cluster, DATA.clusters.length), 0.1); ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(c.x, c.y); ctx.stroke(); }
  for (const d of DATA.docs) {
    if (!shown(d)) continue;
    const [x, y] = toScreen(d), r = d._r * Math.max(0.6, Math.min(cam.scale, 2.4)), col = clusterColor(d.cluster, DATA.clusters.length);
    const gg = ctx.createRadialGradient(x, y, 0, x, y, r * 3.2); gg.addColorStop(0, withAlpha(col, 0.5)); gg.addColorStop(1, withAlpha(col, 0)); ctx.fillStyle = gg; ctx.beginPath(); ctx.arc(x, y, r * 3.2, 0, 7); ctx.fill();
    ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,.55)"; ctx.beginPath(); ctx.arc(x - r * 0.3, y - r * 0.3, r * 0.35, 0, 7); ctx.fill();
    if (d === hover || d === selected) { ctx.strokeStyle = col; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(x, y, r + 5, 0, 7); ctx.stroke(); }
  }
}

// ---- loop ----------------------------------------------------------------
function loop() { twinkle += 0.02; if (usingGL) drawGL(); else draw2d(); positionLabels(); raf = requestAnimationFrame(loop); }

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
    const li = document.createElement("li"), col = clusterColor(c.id, DATA.clusters.length);
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
  if (usingGL) updateVisibilityGL();
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
