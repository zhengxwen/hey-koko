// Layout-box editor — the ⚙ "🔲 Draw layout boxes" modal for FLUX 3 Klein. Drag a
// rectangle where something should go and say what it is; box N becomes <obj_N> in BFL's
// layout table. Drawn over the first attached picture for an edit, or over a blank canvas
// of the output's shape for text→image. Result = [{x0,y0,x1,y1,desc}] in 0-1 canvas
// fractions (left-top origin) — the same shape `--box` parses to, so the server sees one
// contract either way (options.boxes).
import { dom, state } from './state.js';
import { t } from './i18n.js';

const MAX_BOXES = 20;        // mirrors parseBoxSpec / the server's FLUX3_MAX_BOXES
const MIN_SIDE = 8;          // px — a click or a jitter is not a box
const COLORS = ["#ff4d4f", "#40a9ff", "#73d13d", "#ffc53d", "#b37feb", "#ff85c0", "#5cdbd3", "#ff9c6e"];

let els = null, onDone = null, bound = false;
let boxes = [];              // [{x0,y0,x1,y1,desc}] in canvas pixels
let cur = null;              // rectangle being dragged
let baseImg = null;
let W = 0, H = 0;

function d() {
  if (els) return els;
  els = {
    modal: dom.boxModal, close: dom.boxModalClose, canvas: dom.boxCanvas, list: dom.boxList,
    undo: dom.boxUndo, clear: dom.boxClear, cancel: dom.boxCancel, save: dom.boxSave,
  };
  return els;
}

function ptOf(e) {
  const r = d().canvas.getBoundingClientRect();
  return { x: Math.min(W, Math.max(0, (e.clientX - r.left) * (W / r.width))), y: Math.min(H, Math.max(0, (e.clientY - r.top) * (H / r.height))) };
}
const norm = (b) => ({ x0: Math.min(b.x0, b.x1), y0: Math.min(b.y0, b.y1), x1: Math.max(b.x0, b.x1), y1: Math.max(b.y0, b.y1), desc: b.desc || "" });

function render() {
  const c = d().canvas, ctx = c.getContext("2d");
  ctx.clearRect(0, 0, W, H);
  if (baseImg) ctx.drawImage(baseImg, 0, 0, W, H);
  else {
    // A blank canvas with a faint 10% grid, so a box's size reads as a share of the frame.
    ctx.fillStyle = "#fafafa"; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = "#e6e6e6"; ctx.lineWidth = 1;
    for (let k = 1; k < 10; k++) {
      ctx.beginPath(); ctx.moveTo((W * k) / 10, 0); ctx.lineTo((W * k) / 10, H); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, (H * k) / 10); ctx.lineTo(W, (H * k) / 10); ctx.stroke();
    }
  }
  const all = cur ? [...boxes, norm(cur)] : boxes;
  all.forEach((b, i) => {
    const col = COLORS[i % COLORS.length];
    ctx.lineWidth = 3; ctx.strokeStyle = col;
    ctx.strokeRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
    ctx.lineWidth = 1; ctx.strokeStyle = "#fff";
    ctx.strokeRect(b.x0 + 2.5, b.y0 + 2.5, Math.max(0, b.x1 - b.x0 - 5), Math.max(0, b.y1 - b.y0 - 5));
    // id tag in the top-left corner, as BFL's own demo draws it
    const tag = `obj_${i + 1}`;
    ctx.font = "bold 12px sans-serif";
    const tw = ctx.measureText(tag).width;
    ctx.fillStyle = col; ctx.fillRect(b.x0, b.y0, tw + 10, 18);
    ctx.fillStyle = "#fff"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
    ctx.fillText(tag, b.x0 + 5, b.y0 + 9);
  });
  const n = boxes.length;
  d().save.textContent = n ? t("comfy_box_applyN", { n }) : t("comfy_box_apply");
  d().undo.disabled = !n; d().clear.disabled = !n;
}

// The description list. Rebuilt only when the NUMBER of boxes changes, so typing in a
// field never loses focus to a re-render.
let listCount = -1;
function renderList(force = false) {
  const list = d().list;
  if (!force && listCount === boxes.length) return;
  listCount = boxes.length;
  list.innerHTML = "";
  if (!boxes.length) {
    const empty = document.createElement("p");
    empty.className = "hint boxEmpty";
    empty.textContent = t("comfy_box_empty");
    list.appendChild(empty);
  }
  boxes.forEach((b, i) => {
    const row = document.createElement("div");
    row.className = "boxRow";
    const tag = document.createElement("span");
    tag.className = "boxTag";
    tag.style.background = COLORS[i % COLORS.length];
    tag.textContent = `<obj_${i + 1}>`;
    tag.title = t("comfy_box_tagTitle");
    const input = document.createElement("input");
    input.type = "text";
    input.className = "boxDesc";
    input.value = b.desc || "";
    input.placeholder = t("comfy_box_descPlaceholder");
    input.addEventListener("input", () => { b.desc = input.value; });
    const del = document.createElement("button");
    del.type = "button"; del.className = "secondary boxDel"; del.textContent = "✕";
    del.title = t("comfy_box_delete");
    del.addEventListener("click", () => { boxes.splice(i, 1); render(); renderList(true); });
    row.append(tag, input, del);
    list.appendChild(row);
  });
}

function down(e) {
  if (e.button !== 0 || boxes.length >= MAX_BOXES) return;
  e.preventDefault();
  d().canvas.setPointerCapture(e.pointerId);
  const p = ptOf(e);
  cur = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
  render();
}
function move(e) {
  if (!cur) return;
  const p = ptOf(e);
  cur.x1 = p.x; cur.y1 = p.y;
  render();
}
function up(e) {
  if (!cur) return;
  try { d().canvas.releasePointerCapture(e.pointerId); } catch {}
  const b = norm(cur);
  cur = null;
  if (b.x1 - b.x0 >= MIN_SIDE && b.y1 - b.y0 >= MIN_SIDE) {
    boxes.push(b);
    render(); renderList();
    // Straight to its description — a box without one leaves the choice to the upsampler.
    const inputs = d().list.querySelectorAll(".boxDesc");
    inputs[inputs.length - 1]?.focus();
  } else render();
}

function finish(result) {
  const cb = onDone; onDone = null;
  d().modal.hidden = true;
  document.removeEventListener("keydown", onKey);
  if (cb) cb(result);
}
function onKey(e) {
  if (e.key === "Escape") { e.preventDefault(); finish(null); return; }
  // ⌘/Ctrl+Z undoes the last BOX — but not while a description field has focus, where it
  // belongs to the text.
  if ((e.key === "z" || e.key === "Z") && (e.metaKey || e.ctrlKey) && !(e.target && e.target.classList && e.target.classList.contains("boxDesc"))) {
    e.preventDefault(); boxes.pop(); render(); renderList(true);
  }
}

function bindOnce() {
  if (bound) return;
  bound = true;
  const x = d();
  x.canvas.addEventListener("pointerdown", down);
  x.canvas.addEventListener("pointermove", move);
  x.canvas.addEventListener("pointerup", up);
  x.canvas.addEventListener("pointercancel", up);
  x.undo.addEventListener("click", () => { boxes.pop(); render(); renderList(true); });
  x.clear.addEventListener("click", () => { boxes = []; cur = null; render(); renderList(true); });
  x.cancel.addEventListener("click", () => finish(null));
  x.close.addEventListener("click", () => finish(null));
  x.modal.addEventListener("click", (e) => { if (e.target === x.modal) finish(null); });
  x.save.addEventListener("click", () => finish(boxes.map((b) => ({
    x0: +(b.x0 / W).toFixed(4), y0: +(b.y0 / H).toFixed(4),
    x1: +(b.x1 / W).toFixed(4), y1: +(b.y1 / H).toFixed(4),
    desc: String(b.desc || "").trim(),
  }))));
}

// src: data URL of the first attached picture, or null → a blank canvas shaped like the
// output (`aspect` = { w, h }). existing: previously staged normalized boxes to edit.
// Resolves with the new normalized boxes ([] = cleared), or null when cancelled.
export function openBoxModal(src, existing = null, aspect = { w: 1, h: 1 }) {
  return new Promise((resolve) => {
    bindOnce();
    onDone = resolve;
    const start = (natW, natH) => {
      const x = d();
      x.modal.hidden = false;
      const maxW = (x.canvas.parentElement && x.canvas.parentElement.clientWidth - 16) || Math.round(window.innerWidth * 0.6);
      const maxH = Math.round(window.innerHeight * 0.5);
      const fit = Math.min(maxW / natW, maxH / natH, 4) || 1;
      W = Math.max(64, Math.round(natW * fit)); H = Math.max(64, Math.round(natH * fit));
      x.canvas.width = W; x.canvas.height = H;
      x.canvas.style.width = `${W}px`; x.canvas.style.height = `${H}px`;
      boxes = Array.isArray(existing)
        ? existing.map((b) => ({ x0: b.x0 * W, y0: b.y0 * H, x1: b.x1 * W, y1: b.y1 * H, desc: b.desc || "" }))
        : [];
      cur = null;
      document.addEventListener("keydown", onKey);
      render(); renderList(true);
    };
    const blank = () => { baseImg = null; start(Math.max(1, aspect.w || 1) * 512, Math.max(1, aspect.h || 1) * 512); };
    if (src) {
      const img = new Image();
      img.onload = () => { baseImg = img; start(img.naturalWidth || img.width, img.naturalHeight || img.height); };
      img.onerror = blank;
      img.src = src;
    } else blank();
  });
}

// The ⚙ button's label: how many boxes are staged for the next run.
export function refreshBoxLabel() {
  if (!dom.comfyBoxLabel) return;
  const n = Array.isArray(state.pendingBoxes) ? state.pendingBoxes.length : 0;
  dom.comfyBoxLabel.textContent = n ? t("comfy_box_set", { n }) : t("comfy_box");
}
