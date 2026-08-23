// Motion-track editor — the ⚙ "✏️ Draw motion tracks" modal for LTX-2.5 Motion Track.
// Draw strokes over the staged still (or a blank 16:9 canvas for text→video); each
// stroke becomes one trajectory, in stroke order = time order. Result = normalized
// polylines [[{x,y},…],…] (0-1, top-left origin) — the same shape `--track` parses
// to, so the server sees one contract either way (options.tracks).
import { dom, state } from './state.js';
import { t } from './i18n.js';

const MIN_STEP = 6;          // px between recorded points (screen space)
const MAX_TRACKS = 16;       // mirrors parseTrackFlag / the server's LTX25_TRACK_MAX
const COLORS = ["#ff4d4f", "#40a9ff", "#73d13d", "#ffc53d", "#b37feb", "#ff85c0", "#5cdbd3", "#ff9c6e"];

let els = null, onDone = null, bound = false;
let tracks = [];             // committed strokes, canvas-pixel coords
let cur = null;              // stroke in progress
let baseImg = null;          // HTMLImageElement or null (blank canvas)
let W = 0, H = 0;            // canvas size (= display size; 1:1 with pointer coords)

function d() {
  if (els) return els;
  els = {
    modal: dom.trackModal, close: dom.trackModalClose, canvas: dom.trackCanvas,
    undo: dom.trackUndo, clear: dom.trackClear, cancel: dom.trackCancel, save: dom.trackSave,
  };
  return els;
}

function ptOf(e) {
  const r = d().canvas.getBoundingClientRect();
  return { x: Math.min(W, Math.max(0, (e.clientX - r.left) * (W / r.width))), y: Math.min(H, Math.max(0, (e.clientY - r.top) * (H / r.height))) };
}

function render() {
  const c = d().canvas, ctx = c.getContext("2d");
  ctx.clearRect(0, 0, W, H);
  if (baseImg) ctx.drawImage(baseImg, 0, 0, W, H);
  else { ctx.fillStyle = "#202020"; ctx.fillRect(0, 0, W, H); }
  const all = cur && cur.length ? [...tracks, cur] : tracks;
  all.forEach((trk, i) => {
    const col = COLORS[i % COLORS.length];
    ctx.lineWidth = 3; ctx.lineJoin = "round"; ctx.lineCap = "round"; ctx.strokeStyle = col;
    ctx.beginPath(); trk.forEach((p, k) => (k ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.stroke();
    // start dot + index
    const s = trk[0];
    ctx.fillStyle = col; ctx.beginPath(); ctx.arc(s.x, s.y, 7, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#fff"; ctx.font = "bold 11px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(String(i + 1), s.x, s.y);
    // arrowhead at the end
    if (trk.length >= 2) {
      const a = trk[trk.length - 2], b = trk[trk.length - 1];
      const ang = Math.atan2(b.y - a.y, b.x - a.x), L = 12;
      ctx.fillStyle = col; ctx.beginPath();
      ctx.moveTo(b.x, b.y);
      ctx.lineTo(b.x - L * Math.cos(ang - 0.5), b.y - L * Math.sin(ang - 0.5));
      ctx.lineTo(b.x - L * Math.cos(ang + 0.5), b.y - L * Math.sin(ang + 0.5));
      ctx.closePath(); ctx.fill();
    }
  });
  const n = tracks.length;
  d().save.textContent = n ? t("comfy_track_applyN", { n }) : t("comfy_track_apply");
  d().undo.disabled = !n; d().clear.disabled = !n;
}

function down(e) {
  if (e.button !== 0 || tracks.length >= MAX_TRACKS) return;
  e.preventDefault();
  d().canvas.setPointerCapture(e.pointerId);
  cur = [ptOf(e)];
  render();
}
function move(e) {
  if (!cur) return;
  const p = ptOf(e), last = cur[cur.length - 1];
  if (Math.hypot(p.x - last.x, p.y - last.y) >= MIN_STEP) { cur.push(p); render(); }
}
function up(e) {
  if (!cur) return;
  try { d().canvas.releasePointerCapture(e.pointerId); } catch {}
  if (cur.length >= 2) tracks.push(cur);
  cur = null;
  render();
}

function finish(result) {
  const cb = onDone; onDone = null;
  d().modal.hidden = true;
  document.removeEventListener("keydown", onKey);
  if (cb) cb(result);
}
function onKey(e) {
  if (e.key === "Escape") { e.preventDefault(); finish(null); }
  else if ((e.key === "z" || e.key === "Z") && (e.metaKey || e.ctrlKey)) { e.preventDefault(); tracks.pop(); render(); }
}

function bindOnce() {
  if (bound) return;
  bound = true;
  const x = d();
  x.canvas.addEventListener("pointerdown", down);
  x.canvas.addEventListener("pointermove", move);
  x.canvas.addEventListener("pointerup", up);
  x.canvas.addEventListener("pointercancel", up);
  x.undo.addEventListener("click", () => { tracks.pop(); render(); });
  x.clear.addEventListener("click", () => { tracks = []; cur = null; render(); });
  x.cancel.addEventListener("click", () => finish(null));
  x.close.addEventListener("click", () => finish(null));
  x.modal.addEventListener("click", (e) => { if (e.target === x.modal) finish(null); });
  x.save.addEventListener("click", () => finish(tracks.map((trk) => trk.map((p) => ({ x: +(p.x / (W - 1)).toFixed(4), y: +(p.y / (H - 1)).toFixed(4) })))));
}

// src: data URL of the staged still / clip frame, or null → blank 16:9 canvas.
// existing: previously committed normalized tracks to edit. Resolves with the new
// normalized tracks ([] = cleared), or null when cancelled (keep the old ones).
export function openTrackModal(src, existing = null) {
  return new Promise((resolve) => {
    bindOnce();
    onDone = resolve;
    const start = (natW, natH) => {
      const x = d();
      x.modal.hidden = false;
      const maxW = (x.canvas.parentElement && x.canvas.parentElement.clientWidth) || Math.round(window.innerWidth * 0.6);
      const maxH = Math.round(window.innerHeight * 0.6);
      const fit = Math.min(maxW / natW, maxH / natH, 1) || 1;
      W = Math.max(64, Math.round(natW * fit)); H = Math.max(64, Math.round(natH * fit));
      x.canvas.width = W; x.canvas.height = H;
      x.canvas.style.width = `${W}px`; x.canvas.style.height = `${H}px`;
      tracks = Array.isArray(existing) ? existing.map((trk) => trk.map((p) => ({ x: p.x * (W - 1), y: p.y * (H - 1) }))) : [];
      cur = null;
      document.addEventListener("keydown", onKey);
      render();
    };
    if (src) {
      const img = new Image();
      img.onload = () => { baseImg = img; start(img.naturalWidth || img.width, img.naturalHeight || img.height); };
      img.onerror = () => { baseImg = null; start(960, 540); };
      img.src = src;
    } else { baseImg = null; start(960, 540); }
  });
}

// The ⚙ button's label: how many trajectories are staged for the next run.
export function refreshTrackLabel() {
  if (!dom.comfyTrackLabel) return;
  const n = Array.isArray(state.pendingTracks) ? state.pendingTracks.length : 0;
  dom.comfyTrackLabel.textContent = n ? t("comfy_track_set", { n }) : t("comfy_track");
}
