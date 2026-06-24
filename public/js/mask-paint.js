// Inpaint mask painter — overlays a brush canvas on a staged image so the user
// can paint the region they want the AI to repaint. On save it exports a
// black/white PNG (white = repaint region) sized to the source image; the server
// feeds it to a LoadImageMask + SetLatentNoiseMask so only that area changes.
//
// Two buffers share every stroke: the VISIBLE canvas paints a translucent tint so
// the user sees what's selected over the image, while an offscreen buffer paints
// solid white — that buffer is what we export (composited onto black).

const MAX_SIDE = 1280; // cap the mask resolution (perf); the server resizes it to the latent anyway

let els = null;
function dom() {
  if (els) return els;
  els = {
    modal: document.querySelector("#maskModal"),
    close: document.querySelector("#maskModalClose"),
    stage: document.querySelector("#maskStage"),
    baseImg: document.querySelector("#maskBaseImg"),
    canvas: document.querySelector("#maskCanvas"),
    brush: document.querySelector("#maskBrushSize"),
    erase: document.querySelector("#maskEraseBtn"),
    clear: document.querySelector("#maskClearBtn"),
    cancel: document.querySelector("#maskCancelBtn"),
    save: document.querySelector("#maskSaveBtn"),
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

// Map a pointer event to canvas-internal coordinates.
function ptOf(e) {
  const d = dom();
  const rect = d.canvas.getBoundingClientRect();
  const sx = d.canvas.width / rect.width;
  const sy = d.canvas.height / rect.height;
  const cx = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
  const cy = (e.touches ? e.touches[0].clientY : e.clientY) - rect.top;
  return { x: cx * sx, y: cy * sy, scale: sx };
}

function strokeTo(p) {
  const d = dom();
  const radius = (Number(d.brush.value) || 40) * p.scale / 2;
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
}
function move(e) {
  if (!painting) return;
  e.preventDefault();
  strokeTo(ptOf(e));
}
function up() {
  painting = false;
  lastPt = null;
}

function setErase(on) {
  erasing = on;
  const d = dom();
  d.erase.classList.toggle("isActive", on);
}

function clearAll() {
  const d = dom();
  dispCtx.clearRect(0, 0, d.canvas.width, d.canvas.height);
  maskCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
  dirty = false;
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
  window.addEventListener("mouseup", up);
  d.canvas.addEventListener("touchstart", down, { passive: false });
  d.canvas.addEventListener("touchmove", move, { passive: false });
  window.addEventListener("touchend", up);
  d.erase.addEventListener("click", () => setErase(!erasing));
  d.clear.addEventListener("click", clearAll);
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

    const img = new Image();
    img.onload = () => {
      // Internal resolution: natural size capped to MAX_SIDE (keeps aspect).
      let w = img.naturalWidth || img.width;
      let h = img.naturalHeight || img.height;
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
      d.modal.hidden = false;
      document.addEventListener("keydown", onKey);
    };
    img.src = src;
  });
}
