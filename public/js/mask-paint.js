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

const MAX_SIDE = 1280; // cap the mask resolution (perf); the server resizes it to the latent anyway
const ZOOM_MIN = 1, ZOOM_MAX = 8, ZOOM_STEP = 1.25;
const BRUSH_MIN = 5, BRUSH_MAX = 300;

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
    brush: document.querySelector("#maskBrushSize"),
    brushVal: document.querySelector("#maskBrushVal"),
    erase: document.querySelector("#maskEraseBtn"),
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
  moveCursor(e);
  if (!painting) return;
  e.preventDefault();
  strokeTo(ptOf(e));
}
function up() {
  painting = false;
  lastPt = null;
}

// Position + size the follow-the-mouse brush ring (so the user sees the real
// on-screen brush diameter). Coordinates are relative to the (zoomed) stage.
function moveCursor(e) {
  const d = dom();
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
}

function onKey(e) {
  if (e.key === "Escape") { closeModal(); finish(null); }
}

function finish(result) {
  const cb = onDone;
  onDone = null;
  if (cb) cb(result);
}

// Export the painted mask as a black/white PNG (white = repaint). Returns null if
// nothing was painted (caller treats that as "no mask").
function exportMask() {
  if (!dirty) return null;
  const out = document.createElement("canvas");
  out.width = maskCanvas.width;
  out.height = maskCanvas.height;
  const octx = out.getContext("2d");
  octx.fillStyle = "#000000";
  octx.fillRect(0, 0, out.width, out.height);
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
  d.erase.addEventListener("click", () => setErase(!erasing));
  d.clear.addEventListener("click", clearAll);
  d.zoomIn.addEventListener("click", () => setZoom(zoom * ZOOM_STEP));
  d.zoomOut.addEventListener("click", () => setZoom(zoom / ZOOM_STEP));
  d.scroll.addEventListener("wheel", onWheel, { passive: false });
  d.close.addEventListener("click", () => { closeModal(); finish(null); });
  d.cancel.addEventListener("click", () => { closeModal(); finish(null); });
  d.save.addEventListener("click", () => {
    const mask = exportMask();
    closeModal();
    finish(mask);
  });
  // Click on the backdrop (outside the dialog) cancels.
  d.modal.addEventListener("mousedown", (e) => {
    if (e.target === d.modal) { closeModal(); finish(null); }
  });
}

// Open the painter for a staged image. `src` is a displayable image source
// (data URL). `existingMask` (data URL or null) pre-loads a prior mask so it can
// be edited. Resolves via the returned promise with the mask data URL, or null if
// cancelled / cleared.
export function openMaskModal(src, existingMask = null) {
  return new Promise((resolve) => {
    const d = dom();
    bindOnce();
    onDone = resolve;
    setErase(false);
    dirty = false;
    zoom = 1;
    d.cursor.hidden = true;

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

      // Pre-load an existing mask so edits build on it. The saved mask is OPAQUE
      // black+white (white = region); convert it to white-on-transparent (alpha =
      // red channel) so both buffers — and the tint — behave like freshly painted
      // strokes (an opaque image would tint the whole canvas).
      if (existingMask) {
        const m = new Image();
        m.onload = () => {
          const tmp = document.createElement("canvas");
          tmp.width = w; tmp.height = h;
          const tctx = tmp.getContext("2d");
          tctx.drawImage(m, 0, 0, w, h);
          const id = tctx.getImageData(0, 0, w, h);
          const data = id.data;
          for (let p = 0; p < data.length; p += 4) {
            const r = data[p];           // brightness of the saved mask
            data[p] = 255; data[p + 1] = 255; data[p + 2] = 255;
            data[p + 3] = r;             // alpha follows the white region
          }
          maskCtx.putImageData(id, 0, 0);
          // Mirror into the visible canvas, then recolor to the translucent tint.
          dispCtx.drawImage(maskCanvas, 0, 0);
          dispCtx.globalCompositeOperation = "source-in";
          dispCtx.fillStyle = "rgba(255,70,90,0.55)";
          dispCtx.fillRect(0, 0, w, h);
          dispCtx.globalCompositeOperation = "source-over";
          dirty = true;
        };
        m.src = existingMask;
      }
      document.addEventListener("keydown", onKey);
    };
    img.src = src;
  });
}