// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

// Inpaint mask painter — overlays a brush canvas on a staged image so the user
// can paint the region they want the AI to repaint. On save it exports a
// black/white PNG (white = repaint region) sized to the source image; the server
// feeds it to a LoadImageMask + SetLatentNoiseMask so only that area changes.
//
// Two buffers share every stroke: the VISIBLE canvas paints a translucent tint so
// the user sees what's selected over the image, while an offscreen buffer paints
// solid white — that buffer is what we export (composited onto black).
//
// Brush size is tracked in IMAGE (canvas-internal) pixels so a stroke covers the
// same region at any zoom; a follow-the-mouse cursor ring shows its real on-screen
// size. The image can be zoomed (buttons / ctrl+wheel); when it grows past the
// viewport the stage scroll container shows scrollbars.

import { t } from './i18n.js';

const MAX_SIDE = 1280; // cap the mask resolution (perf); the server resizes it to the latent anyway
const ZOOM_MIN = 1, ZOOM_MAX = 8, ZOOM_STEP = 1.25;
const BRUSH_MIN = 2, BRUSH_MAX = 300;

let els = null;
function dom() {
  if (els) return els;
  els = {
    modal: document.querySelector("#maskModal"),
    close: document.querySelector("#maskModalClose"),
    scroll: document.querySelector("#maskStageScroll"),
    stage: document.querySelector("#maskStage"),
    baseImg: document.querySelector("#maskBaseImg"),
    canvas: document.querySelector("#maskCanvas"),
    cursor: document.querySelector("#maskBrushCursor"),
    marquee: document.querySelector("#maskMarquee"),
    brush: document.querySelector("#maskBrushSize"),
    brushVal: document.querySelector("#maskBrushVal"),
    auto: document.querySelector("#maskAutoBtn"),
    autoText: document.querySelector("#maskAutoTextInput"),
    autoTextBtn: document.querySelector("#maskAutoTextBtn"),
    erase: document.querySelector("#maskEraseBtn"),
    expand: document.querySelector("#maskExpandBtn"),
    invert: document.querySelector("#maskInvertBtn"),
    clear: document.querySelector("#maskClearBtn"),
    cancel: document.querySelector("#maskCancelBtn"),
    save: document.querySelector("#maskSaveBtn"),
    zoomIn: document.querySelector("#maskZoomIn"),
    zoomOut: document.querySelector("#maskZoomOut"),
    zoomLabel: document.querySelector("#maskZoomLabel"),
  };
  return els;
}

// Module-level painting state (one painter at a time — the modal is singleton).
let dispCtx = null;   // visible canvas (translucent tint)
let maskCtx = null;   // offscreen canvas (solid white → export source)
let maskCanvas = null;
let painting = false;
let erasing = false;
let dirty = false;    // any stroke painted?
let lastPt = null;
let onDone = null;    // callback(maskBase64 | null)
let bound = false;    // event handlers attached once
let curSrc = null;    // the image being masked (data URL) — fed to auto-segment
let autoMode = false; // 🪄 "point to segment": the next canvas click picks a seed
let autoBusy = false; // a SAM2 request is in flight
let autoDragging = false;       // mouse down in 🪄 mode (may become a click or a box)
let dragStart = null, dragCur = null; // marquee corners (canvas-internal coords)
let dragAdd = false;            // Shift held → ADD to the mask instead of replacing it
let shiftHeld = false;          // live Shift state (drives the add-mode + cursor)
let baseW = 0, baseH = 0; // fit-to-container display size at zoom 1
let zoom = 1;
let cursorHideTimer = null;

// Map a pointer event to canvas-internal coordinates.
function ptOf(e) {
  const d = dom();
  const rect = d.canvas.getBoundingClientRect();
  const sx = d.canvas.width / rect.width;
  const sy = d.canvas.height / rect.height;
  const cx = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
  const cy = (e.touches ? e.touches[0].clientY : e.clientY) - rect.top;
  return { x: cx * sx, y: cy * sy };
}

function strokeTo(p) {
  const d = dom();
  const radius = (Number(d.brush.value) || 60) / 2; // image (internal) pixels
  for (const ctx of [dispCtx, maskCtx]) {
    ctx.globalCompositeOperation = erasing ? "destination-out" : "source-over";
    ctx.lineWidth = radius * 2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    if (lastPt) ctx.moveTo(lastPt.x, lastPt.y);
    else ctx.moveTo(p.x - 0.01, p.y - 0.01);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    // a dot so single taps register
    ctx.beginPath();
    ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
    ctx.fill();
  }
  lastPt = p;
  if (!erasing) dirty = true;
}

function down(e) {
  e.preventDefault();
  // 🪄 mode: mouse-down starts either a click (→ SAM2 point) or a drag (→ box
  // marquee). Shift = ADD to the existing mask. Decide on mouse-up by drag size.
  if (autoMode) {
    autoDragging = true;
    dragStart = dragCur = ptOf(e);
    dragAdd = e.shiftKey;
    return;
  }
  painting = true;
  lastPt = null;
  dispCtx.fillStyle = "rgba(255,70,90,0.55)";
  dispCtx.strokeStyle = "rgba(255,70,90,0.55)";
  maskCtx.fillStyle = "#ffffff";
  maskCtx.strokeStyle = "#ffffff";
  strokeTo(ptOf(e));
  moveCursor(e);
}
function move(e) {
  if (autoMode) {
    if (!autoDragging) return;
    e.preventDefault();
    dragCur = ptOf(e);
    updateMarquee();
    return;
  }
  moveCursor(e);
  if (!painting) return;
  e.preventDefault();
  strokeTo(ptOf(e));
}
function up() {
  if (autoMode && autoDragging) {
    autoDragging = false;
    hideMarquee();
    const d = dom();
    const dx = Math.abs(dragCur.x - dragStart.x), dy = Math.abs(dragCur.y - dragStart.y);
    if (dx < 6 && dy < 6) {  // a tap → SAM2 point segmentation
      runAutoSegment({ x: dragStart.x / d.canvas.width, y: dragStart.y / d.canvas.height }, dragAdd);
    } else {                 // a real drag → SAM2 detect the object inside the box
      runBoxSegment(dragStart, dragCur, dragAdd);
    }
    return;
  }
  painting = false;
  lastPt = null;
}

// Position + size the follow-the-mouse brush ring (so the user sees the real
// on-screen brush diameter). Coordinates are relative to the (zoomed) stage.
function moveCursor(e) {
  const d = dom();
  if (autoMode) { d.cursor.hidden = true; return; } // 🪄 mode uses a crosshair, no brush ring
  if (cursorHideTimer) { clearTimeout(cursorHideTimer); cursorHideTimer = null; }
  const stageRect = d.stage.getBoundingClientRect();
  const canRect = d.canvas.getBoundingClientRect();
  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  const clientY = e.touches ? e.touches[0].clientY : e.clientY;
  const diam = (Number(d.brush.value) || 60) * (canRect.width / d.canvas.width);
  d.cursor.style.width = diam + "px";
  d.cursor.style.height = diam + "px";
  d.cursor.style.left = (clientX - stageRect.left) + "px";
  d.cursor.style.top = (clientY - stageRect.top) + "px";
  d.cursor.classList.toggle("isErase", erasing);
  d.cursor.hidden = false;
}

// Flash the brush ring at the stage center (used when the slider changes and the
// mouse isn't over the canvas) so the user sees the new size immediately.
function previewCursorCenter() {
  const d = dom();
  const canRect = d.canvas.getBoundingClientRect();
  const stageRect = d.stage.getBoundingClientRect();
  if (!canRect.width) return;
  const scRect = d.scroll.getBoundingClientRect();
  const diam = (Number(d.brush.value) || 60) * (canRect.width / d.canvas.width);
  d.cursor.style.width = diam + "px";
  d.cursor.style.height = diam + "px";
  // Center of the visible viewport, clamped to the canvas, in viewport coords →
  // then converted to stage-relative (robust to the stage's auto margins).
  let cx = scRect.left + d.scroll.clientWidth / 2;
  let cy = scRect.top + d.scroll.clientHeight / 2;
  cx = Math.min(Math.max(cx, canRect.left), canRect.right);
  cy = Math.min(Math.max(cy, canRect.top), canRect.bottom);
  d.cursor.style.left = (cx - stageRect.left) + "px";
  d.cursor.style.top = (cy - stageRect.top) + "px";
  d.cursor.classList.toggle("isErase", erasing);
  d.cursor.hidden = false;
  if (cursorHideTimer) clearTimeout(cursorHideTimer);
  cursorHideTimer = setTimeout(() => { d.cursor.hidden = true; }, 700);
}

function hideCursor() {
  if (painting) return; // keep visible while a stroke is in progress
  dom().cursor.hidden = true;
}

function setErase(on) {
  erasing = on;
  dom().erase.classList.toggle("isActive", on);
}

// Brush size is shared by the slider and the editable number box. The SLIDER is
// the canonical value the painter reads (always clamped/valid); the number box is
// kept in sync. clampBrush bounds a raw value; syncBrush writes both inputs.
function clampBrush(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return null;
  return Math.min(BRUSH_MAX, Math.max(BRUSH_MIN, n));
}
function syncBrush(n) {
  const d = dom();
  d.brush.value = String(n);
  d.brushVal.value = String(n);
  previewCursorCenter();
}

function clearAll() {
  const d = dom();
  dispCtx.clearRect(0, 0, d.canvas.width, d.canvas.height);
  maskCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
  dirty = false;
}

// Apply the current zoom: size the stage to baseW/baseH × zoom. The canvas keeps
// its fixed internal resolution and stretches via CSS, so drawing math (which uses
// getBoundingClientRect) stays correct at any zoom. Scrollbars appear when the
// stage outgrows the scroll container.
function applyZoom() {
  const d = dom();
  d.stage.style.width = Math.round(baseW * zoom) + "px";
  d.stage.style.height = Math.round(baseH * zoom) + "px";
  d.zoomLabel.textContent = Math.round(zoom * 100) + "%";
}

function setZoom(next, anchor) {
  const d = dom();
  const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next));
  if (clamped === zoom) return;
  // Keep the point under the cursor (anchor) roughly stable while zooming.
  const prev = zoom;
  const sc = d.scroll;
  let ax = 0.5, ay = 0.5;
  if (anchor) {
    const r = sc.getBoundingClientRect();
    ax = (anchor.x - r.left + sc.scrollLeft) / (baseW * prev);
    ay = (anchor.y - r.top + sc.scrollTop) / (baseH * prev);
  } else {
    ax = (sc.scrollLeft + sc.clientWidth / 2) / (baseW * prev);
    ay = (sc.scrollTop + sc.clientHeight / 2) / (baseH * prev);
  }
  zoom = clamped;
  applyZoom();
  // Re-center the anchor point.
  const r = sc.getBoundingClientRect();
  if (anchor) {
    sc.scrollLeft = ax * baseW * zoom - (anchor.x - r.left);
    sc.scrollTop = ay * baseH * zoom - (anchor.y - r.top);
  } else {
    sc.scrollLeft = ax * baseW * zoom - sc.clientWidth / 2;
    sc.scrollTop = ay * baseH * zoom - sc.clientHeight / 2;
  }
}

function onWheel(e) {
  // Ctrl/Cmd + wheel zooms; plain wheel scrolls the container normally.
  if (!(e.ctrlKey || e.metaKey)) return;
  e.preventDefault();
  const factor = e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
  setZoom(zoom * factor, { x: e.clientX, y: e.clientY });
  moveCursor(e);
}

function closeModal() {
  const d = dom();
  d.modal.hidden = true;
  document.removeEventListener("keydown", onKey);
  document.removeEventListener("keyup", onKeyUp);
  shiftHeld = false;
}

function onKey(e) {
  if (e.key === "Escape") { closeModal(); finish(null); return; }
  // In 🪄 mode, holding Shift = "add to mask" — show the OS copy cursor (a + badge)
  // so the user sees they're adding, not replacing.
  if (e.key === "Shift" && !shiftHeld) { shiftHeld = true; updateAutoCursor(); }
}
function onKeyUp(e) {
  if (e.key === "Shift") { shiftHeld = false; updateAutoCursor(); }
}

// Cursor for 🪄 mode: "copy" (+ badge) while Shift is held = add; else crosshair.
function updateAutoCursor() {
  const d = dom();
  d.canvas.style.cursor = autoMode ? (shiftHeld ? "copy" : "crosshair") : "";
}

function finish(result) {
  const cb = onDone;
  onDone = null;
  if (cb) cb(result);
}

// Export the painted mask as a black/white PNG (white = repaint). Returns null if
// the mask is effectively EMPTY — checked by scanning the actual painted pixels,
// not the coarse `dirty` flag, so "cleared" is honoured however it happened:
// the Clear button, erasing every stroke away, or never painting. An all-black
// mask would otherwise be sent and the server would repaint nothing (wasteful).
function exportMask() {
  if (!maskCanvas) return null;
  const w = maskCanvas.width, h = maskCanvas.height;
  const data = maskCtx.getImageData(0, 0, w, h).data;
  let painted = false;
  for (let p = 3; p < data.length; p += 4) { if (data[p] > 10) { painted = true; break; } } // any non-transparent (white) pixel
  if (!painted) return null;
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const octx = out.getContext("2d");
  octx.fillStyle = "#000000";
  octx.fillRect(0, 0, w, h);
  octx.drawImage(maskCanvas, 0, 0); // white strokes over black
  return out.toDataURL("image/png");
}

function bindOnce() {
  if (bound) return;
  bound = true;
  const d = dom();
  d.canvas.addEventListener("mousedown", down);
  d.canvas.addEventListener("mousemove", move);
  d.canvas.addEventListener("mouseenter", moveCursor);
  d.canvas.addEventListener("mouseleave", hideCursor);
  window.addEventListener("mouseup", up);
  d.canvas.addEventListener("touchstart", down, { passive: false });
  d.canvas.addEventListener("touchmove", move, { passive: false });
  window.addEventListener("touchend", up);
  // Slider → mirror into the number box + preview.
  d.brush.addEventListener("input", () => { d.brushVal.value = d.brush.value; previewCursorCenter(); });
  // Number box: while typing, drive the slider from a clamped read but leave the
  // text alone; on commit (blur / Enter) normalize the text to the clamped value.
  d.brushVal.addEventListener("input", () => {
    const n = clampBrush(d.brushVal.value);
    if (n != null) { d.brush.value = String(n); previewCursorCenter(); }
  });
  d.brushVal.addEventListener("change", () => {
    syncBrush(clampBrush(d.brushVal.value) ?? clampBrush(d.brush.value) ?? 60);
  });
  d.auto.addEventListener("click", () => setAuto(!autoMode));
  d.autoTextBtn.addEventListener("click", runTextSegment);
  d.autoText.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); runTextSegment(); } });
  d.erase.addEventListener("click", () => setErase(!erasing));
  // Expand the mask edge outward by the current BRUSH SIZE (px) — the slider is the
  // expansion amount, so 2px = a fine nudge, big brush = a big grow. Repeated clicks
  // accumulate.
  d.expand.addEventListener("click", () => {
    if (!maskCanvas) return;
    dilateMask(Math.max(1, Math.round(Number(d.brush.value) || 60)));
  });
  d.invert.addEventListener("click", invertMask);
  d.clear.addEventListener("click", clearAll);
  d.zoomIn.addEventListener("click", () => setZoom(zoom * ZOOM_STEP));
  d.zoomOut.addEventListener("click", () => setZoom(zoom / ZOOM_STEP));
  d.scroll.addEventListener("wheel", onWheel, { passive: false });
  d.close.addEventListener("click", () => { closeModal(); finish(null); });
  d.cancel.addEventListener("click", () => { closeModal(); finish(null); });
  d.save.addEventListener("click", () => {
    // Explicit apply: a painted mask → its data URL; an empty canvas (never
    // painted, or cleared/erased away then applied) → "" so the caller DROPS the
    // mask. Distinct from cancel's null, which means "leave the mask untouched".
    const mask = exportMask();
    closeModal();
    finish(mask === null ? "" : mask);
  });
  // Click on the backdrop (outside the dialog) cancels.
  d.modal.addEventListener("mousedown", (e) => {
    if (e.target === d.modal) { closeModal(); finish(null); }
  });
}

// Open the painter for a staged image. `src` is a displayable image source
// (data URL). `existingMask` (data URL or null) pre-loads a prior mask so it can
// be edited. Resolves via the returned promise with:
//   • a mask data URL — applied with paint (use it),
//   • "" — applied with an empty canvas (the user CLEARED the mask → drop it),
//   • null — CANCELLED (X / Cancel / Esc / backdrop → leave the existing mask as-is).
// Callers MUST treat null as "no change", NOT as "clear", or a peek-and-close wipes
// the mask.
export function openMaskModal(src, existingMask = null) {
  return new Promise((resolve) => {
    const d = dom();
    bindOnce();
    onDone = resolve;
    setErase(false);
    dirty = false;
    zoom = 1;
    d.cursor.hidden = true;
    curSrc = src;                 // remember the image for 🪄 / 🔍 auto-segment
    autoBusy = false;
    autoDragging = false;
    hideMarquee();
    setAuto(false);               // reset point-to-segment mode
    d.auto.disabled = false;
    d.auto.textContent = t("mask_auto");
    d.autoTextBtn.disabled = false;
    d.autoTextBtn.textContent = t("mask_findBtn");

    const img = new Image();
    img.onload = () => {
      const natW = img.naturalWidth || img.width;
      const natH = img.naturalHeight || img.height;
      // Internal (mask) resolution: natural size capped to MAX_SIDE (keeps aspect).
      let w = natW, h = natH;
      const longest = Math.max(w, h);
      if (longest > MAX_SIDE) {
        const k = MAX_SIDE / longest;
        w = Math.round(w * k);
        h = Math.round(h * k);
      }
      d.canvas.width = w;
      d.canvas.height = h;
      maskCanvas = document.createElement("canvas");
      maskCanvas.width = w;
      maskCanvas.height = h;
      dispCtx = d.canvas.getContext("2d");
      maskCtx = maskCanvas.getContext("2d");
      clearAll();
      d.baseImg.src = src;

      // Fit-to-container display size at zoom 1 (so the whole image is visible).
      d.modal.hidden = false; // unhide first so clientWidth is measurable
      const maxW = d.scroll.clientWidth || Math.round(window.innerWidth * 0.6);
      const maxH = Math.round(window.innerHeight * 0.6);
      const fit = Math.min(maxW / natW, maxH / natH, 1) || 1;
      baseW = Math.max(1, Math.round(natW * fit));
      baseH = Math.max(1, Math.round(natH * fit));
      applyZoom();

      // Pre-load an existing mask so edits build on it.
      if (existingMask) loadMaskInto(existingMask);
      document.addEventListener("keydown", onKey);
      document.addEventListener("keyup", onKeyUp);
    };
    img.src = src;
  });
}

// Paint a black/white mask PNG (data URL) onto BOTH buffers — the offscreen
// white-on-transparent export buffer and the visible red-tint canvas. The
// saved/segmented mask is OPAQUE black+white (white = region); convert it to
// white-on-transparent (alpha = red channel) so it behaves like painted strokes.
// `add` = true UNIONS the region onto the existing mask (Shift+click); false
// REPLACES it. `clipBox` ({x,y,w,h} canvas coords) restricts the new region to a
// rectangle — used by box-select so SAM2's object is trimmed to the drawn box.
// Shared by the existing-mask pre-load and the 🪄 auto-segment result. Resolves
// with the painted-pixel count of the NEW (post-clip) region (0 = empty).
function loadMaskInto(maskUrl, add = false, clipBox = null) {
  return new Promise((resolve) => {
    if (!maskCanvas) { resolve(0); return; }
    const w = maskCanvas.width, h = maskCanvas.height;
    const m = new Image();
    m.onload = () => {
      const tmp = document.createElement("canvas");
      tmp.width = w; tmp.height = h;
      const tctx = tmp.getContext("2d");
      tctx.drawImage(m, 0, 0, w, h);
      const id = tctx.getImageData(0, 0, w, h);
      const data = id.data;
      for (let p = 0; p < data.length; p += 4) {
        const r = data[p];           // brightness of the mask
        data[p] = 255; data[p + 1] = 255; data[p + 2] = 255;
        data[p + 3] = r;             // alpha follows the white region
      }
      tctx.putImageData(id, 0, 0);   // tmp = white-on-transparent new region
      if (clipBox) {                 // keep only the part inside the drawn box
        tctx.globalCompositeOperation = "destination-in";
        tctx.fillStyle = "#fff";
        tctx.fillRect(clipBox.x, clipBox.y, clipBox.w, clipBox.h);
        tctx.globalCompositeOperation = "source-over";
      }
      // Count the (post-clip) selected pixels for the empty-mask guard.
      const after = tctx.getImageData(0, 0, w, h).data;
      let painted = 0;
      for (let p = 3; p < after.length; p += 4) if (after[p] > 20) painted++;
      if (!add) maskCtx.clearRect(0, 0, w, h);
      maskCtx.globalCompositeOperation = "source-over";
      maskCtx.drawImage(tmp, 0, 0);  // union onto existing (or onto a cleared buffer = replace)
      repaintTint();
      dirty = true;
      resolve(painted);
    };
    m.onerror = () => resolve(0);
    m.src = maskUrl;
  });
}

// Redraw the VISIBLE canvas from the offscreen mask buffer as the translucent red
// tint. Resets the composite op first (a prior erase leaves it "destination-out",
// which would wipe instead of draw). Shared by loadMaskInto + dilateMask.
function repaintTint() {
  const w = maskCanvas.width, h = maskCanvas.height;
  dispCtx.globalCompositeOperation = "source-over";
  dispCtx.clearRect(0, 0, w, h);
  dispCtx.drawImage(maskCanvas, 0, 0);
  dispCtx.globalCompositeOperation = "source-in";
  dispCtx.fillStyle = "rgba(255,70,90,0.55)";
  dispCtx.fillRect(0, 0, w, h);
  dispCtx.globalCompositeOperation = "source-over";
}

// Grow the mask outward by ~`radius` canvas px (a morphological dilation). Filter-
// FREE: stamps the mask at many offsets covering a disk of that radius and unions
// them (the center stamp keeps the interior; the ring stamps push the border out).
// Avoids ctx.filter=blur, which is a no-op in some WebViews. Both buffers update
// (offscreen export + visible tint). Returns the painted-pixel count (0 = empty
// mask, nothing to grow). Repeated clicks accumulate.
function dilateMask(radius) {
  if (!maskCanvas || radius <= 0) return 0;
  const w = maskCanvas.width, h = maskCanvas.height;
  const tmp = document.createElement("canvas");
  tmp.width = w; tmp.height = h;
  const tctx = tmp.getContext("2d");
  tctx.drawImage(maskCanvas, 0, 0);                 // center → keep the original region
  // More directions for a larger radius so the grown edge stays smooth (not scalloped).
  const dirs = Math.min(64, Math.max(20, Math.round(radius * 3)));
  for (let i = 0; i < dirs; i++) {                  // ring → extend the border outward
    const a = (i / dirs) * Math.PI * 2;
    tctx.drawImage(maskCanvas, Math.round(Math.cos(a) * radius), Math.round(Math.sin(a) * radius));
  }
  const id = tctx.getImageData(0, 0, w, h);
  const data = id.data;
  let painted = 0;
  for (let p = 0; p < data.length; p += 4) {
    const on = data[p + 3] > 40 ? 255 : 0;          // solidify the unioned (antialiased) alpha
    data[p] = 255; data[p + 1] = 255; data[p + 2] = 255; data[p + 3] = on;
    if (on) painted++;
  }
  if (!painted) return 0;                            // nothing painted → nothing to grow
  maskCtx.putImageData(id, 0, 0);
  repaintTint();
  dirty = true;
  return painted;
}

// Rubber-band selection box (a DOM overlay) shown while dragging in 🪄 mode.
// Positions in DISPLAY coords: canvas-internal × (rendered size / internal size).
function updateMarquee() {
  const d = dom();
  const rect = d.canvas.getBoundingClientRect();
  const sx = rect.width / d.canvas.width, sy = rect.height / d.canvas.height;
  const x = Math.min(dragStart.x, dragCur.x) * sx, y = Math.min(dragStart.y, dragCur.y) * sy;
  d.marquee.style.left = x + "px";
  d.marquee.style.top = y + "px";
  d.marquee.style.width = Math.abs(dragCur.x - dragStart.x) * sx + "px";
  d.marquee.style.height = Math.abs(dragCur.y - dragStart.y) * sy + "px";
  d.marquee.hidden = false;
}
function hideMarquee() { dom().marquee.hidden = true; }

// Fill a rectangle (canvas-internal coords) into the mask — ADD (union) or REPLACE.
function fillBoxIntoMask(a, b, add) {
  if (!maskCanvas) return;
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  const w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
  if (!add) maskCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
  maskCtx.globalCompositeOperation = "source-over";
  maskCtx.fillStyle = "#ffffff";
  maskCtx.fillRect(x, y, w, h);
  repaintTint();
  dirty = true;
}

// Invert the mask: selected ↔ unselected (flip alpha), so you can select the
// easy part then invert to mask everything else.
function invertMask() {
  if (!maskCanvas) return;
  const w = maskCanvas.width, h = maskCanvas.height;
  const id = maskCtx.getImageData(0, 0, w, h);
  const data = id.data;
  for (let p = 0; p < data.length; p += 4) {
    data[p] = 255; data[p + 1] = 255; data[p + 2] = 255;
    data[p + 3] = data[p + 3] > 128 ? 0 : 255;   // flip selected/unselected
  }
  maskCtx.putImageData(id, 0, 0);
  repaintTint();
  dirty = true;
}

// Re-render the source image through a canvas at its DISPLAYED (EXIF-oriented)
// size, returning the raw base64. This bakes the browser's orientation into the
// pixels and drops the EXIF tag, so the bytes we send match exactly what the user
// sees and clicked on. Falls back to the raw curSrc base64 if rendering fails.
function bakedDisplayB64() {
  return new Promise((resolve) => {
    if (!curSrc) { resolve(null); return; }
    const im = new Image();
    im.onload = () => {
      try {
        const c = document.createElement("canvas");
        c.width = im.naturalWidth || im.width;
        c.height = im.naturalHeight || im.height;
        c.getContext("2d").drawImage(im, 0, 0);
        resolve(c.toDataURL("image/jpeg", 0.92).split(",")[1]);
      } catch {
        resolve(curSrc.startsWith("data:") ? curSrc.split(",")[1] : null);
      }
    };
    im.onerror = () => resolve(curSrc.startsWith("data:") ? curSrc.split(",")[1] : null);
    im.src = curSrc;
  });
}

// Toggle 🪄 point-to-segment mode. In auto mode the canvas shows a crosshair and
// the next click seeds SAM2 instead of painting.
function setAuto(on) {
  autoMode = on && !autoBusy;
  const d = dom();
  d.auto.classList.toggle("isActive", autoMode);
  updateAutoCursor();
  d.cursor.hidden = autoMode || d.cursor.hidden;
}

// POST the source image (+ a point OR a text phrase) to the server's auto-mask
// endpoint and return the mask data URL. Sends the EXACT pixels the user sees
// (bakedDisplayB64 bakes EXIF orientation + strips the tag) so a click point lines
// up with what SAM2/SAM3 processes. Throws on any failure.
async function postAutomask(extra) {
  const b64 = await bakedDisplayB64();
  if (!b64) throw new Error(t("mask_noImage"));
  const comfyUrl = (document.querySelector("#comfyUrlDisplay")?.textContent || "").replace(/\s*\(.*\)\s*$/, "").trim();
  const resp = await fetch("/api/comfy-automask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image: b64, comfyUrl, ...extra }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.mask) throw new Error(data.error || t("mask_failed", { code: resp.status }));
  return data.mask;
}

// Disable/enable both auto-select controls while a request is in flight.
function setAutoBusy(on) {
  autoBusy = on;
  const d = dom();
  d.auto.disabled = on;
  d.autoTextBtn.disabled = on;
}

// 🪄 point mode: segment the object under the clicked seed point (SAM2). `add`
// (Shift) unions it onto the mask. Auto mode STAYS on so you can keep clicking
// (Shift-click several objects); toggle 🪄 off when done.
async function runAutoSegment(pt, add = false) {
  const d = dom();
  if (autoBusy) return;
  setAutoBusy(true);
  d.auto.textContent = t("mask_segmenting");
  d.canvas.style.cursor = "wait";
  try {
    const painted = await loadMaskInto(await postAutomask({ point: pt }), add);
    if (!painted) flashBtn(d.auto, t("mask_notFoundPoint"), t("mask_auto"));
  } catch (err) {
    flashBtn(d.auto, "✕ " + String(err.message || err).slice(0, 20), t("mask_auto"));
  } finally {
    setAutoBusy(false);
    d.auto.textContent = t("mask_auto");
    updateAutoCursor();
  }
}

// 🪄 box mode: SAM2 BOX-prompt — segments the main object INSIDE the drawn box (its
// true shape, which may slightly exceed the box; the box is a prompt, not a hard
// clip). Sends the box normalized (0–1); the server scales it to image pixels and
// builds the BBOX via HKBoxToBBox. If nothing is found (box over blank background),
// falls back to filling the plain rectangle so a drag always selects something.
async function runBoxSegment(a, b, add) {
  const d = dom();
  if (autoBusy) return;
  const cw = d.canvas.width, ch = d.canvas.height;
  const boxNorm = {
    x1: Math.min(a.x, b.x) / cw, y1: Math.min(a.y, b.y) / ch,
    x2: Math.max(a.x, b.x) / cw, y2: Math.max(a.y, b.y) / ch,
  };
  setAutoBusy(true);
  d.auto.textContent = t("mask_segmenting");
  d.canvas.style.cursor = "wait";
  try {
    const painted = await loadMaskInto(await postAutomask({ box: boxNorm }), add);
    if (!painted) fillBoxIntoMask(a, b, add);   // nothing detected in the box → plain rectangle
  } catch (err) {
    flashBtn(d.auto, "✕ " + String(err.message || err).slice(0, 20), t("mask_auto"));
  } finally {
    setAutoBusy(false);
    d.auto.textContent = t("mask_auto");
    updateAutoCursor();
  }
}

// 🔍 text mode: open-vocabulary segmentation by phrase (SAM3). Types a word like
// "bird" → the mask covers every matching object.
async function runTextSegment() {
  const d = dom();
  const text = (d.autoText.value || "").trim();
  if (!text) { d.autoText.focus(); return; }
  if (autoBusy) return;
  setAuto(false);
  setAutoBusy(true);
  const label = t("mask_findBtn");
  d.autoTextBtn.textContent = t("mask_finding");
  try {
    const painted = await loadMaskInto(await postAutomask({ text }));
    if (!painted) flashBtn(d.autoTextBtn, t("mask_notFoundText", { q: text.slice(0, 12) }), label);
    else d.autoTextBtn.textContent = label;
  } catch (err) {
    flashBtn(d.autoTextBtn, "✕ " + String(err.message || err).slice(0, 18), label);
  } finally {
    setAutoBusy(false);
  }
}

// Briefly show a status message on a button, then restore its label.
function flashBtn(btn, msg, label) {
  btn.textContent = msg;
  setTimeout(() => { btn.textContent = label; }, 2600);
}