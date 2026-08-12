// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

// The simple video editor's UI. AI video generation is a gacha — many takes, each with
// only a usable stretch — so this stitches the usable stretches: pick clips in the
// gallery (✂️), trim each with in/out handles over a filmstrip, reorder, choose audio /
// transition / codec, and export. The export itself is a background job (kind "vedit",
// bg-jobs.js → server/jobs.js → /api/video-edit): local ffmpeg, seconds not GPU-minutes,
// and it survives closing this overlay or the whole page.
//
// The preview player SIMULATES the cut: one <video> seeked inside the active clip's
// [in, out], jumping to the next clip when the out point passes. No browser-side
// encoding anywhere (the repo has no WebCodecs/MediaSource precedent, deliberately) —
// what ffmpeg renders is the truth, the preview is just a fast approximation. Seeking
// works because /api/gallery/file/ serves HTTP Range requests.

import { state } from './state.js';
import { t } from './i18n.js';
import { galleryThumbUrl } from './utils.js';
import { extractVideoFrames } from './image-gen.js';
import { enqueueBgJob, openBgDrawer } from './bg-jobs.js';

const el = (id) => document.querySelector(`#${id}`);
const fileUrl = (id) => `/api/gallery/file/${id.split('/').map(encodeURIComponent).join('/')}`;

// ---------------------------------------------------------------------------
// Editor state. `clips` is the timeline, in order.
// ---------------------------------------------------------------------------

let clips = [];        // [{ id, entry, url, dur, in, out, frames: null|[{url,t}] }]
let active = 0;        // index of the clip under the trim scrubber
let audioMode = 'keep';
let audioId = '';
let fade = 0;          // crossfade seconds; 0 = hard cut
let codec = 'h265';    // half the bytes for the same picture; falls back to h264 server-side
let crf = 18;
// Output geometry. 0 = follow the first clip, which is what the cut is normalized to
// otherwise. Kept across opens, like the codec and quality beside them.
let outW = 0, outH = 0, outFps = 0;
let playAll = false;   // preview chains through all clips vs. stops at the active one's out

const clipLen = (c) => Math.max(0, c.out - c.in);
const totalLen = () => {
  const sum = clips.reduce((n, c) => n + clipLen(c), 0);
  return fade && clips.length > 1 ? sum - fade * (clips.length - 1) : sum;
};
const fmtSec = (s) => `${s.toFixed(2)}s`;

// ---------------------------------------------------------------------------
// Opening: resolve gallery ids into editable clips.
// ---------------------------------------------------------------------------

// One entry, straight from the ledger. /probe doubles as the fetch-one endpoint — it
// is idempotent and also backfills fps/length for old clips, which the trim UI needs.
async function fetchEntry(id) {
  try {
    const r = await fetch('/api/gallery/probe', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }) }).then((x) => x.json());
    return (r && r.entry) || null;
  } catch { return null; }
}

// One gallery id → an editable clip, or null if it is not a video.
async function toClip(id) {
  const entry = await fetchEntry(id);
  if (!entry || entry.kind !== 'video') return null;   // silently skip non-videos in a mixed selection
  const dur = entry.length && entry.fps ? entry.length / entry.fps : 0;
  return { id, entry, url: fileUrl(id), dur, in: 0, out: dur, frames: null };
}

// Opens whether or not anything was selected. An editor that refuses to open until you
// have already picked your material is a door that only opens from the inside: the
// picker strip below is how clips get added, and it is only reachable in here.
export async function openVideoEditor(ids) {
  const list = [];
  for (const id of ids || []) {
    const c = await toClip(id);
    if (c) list.push(c);
  }
  clips = list;
  active = 0;
  playAll = false;
  const overlay = el('veditOverlay');
  const title = el('veditTitle');
  if (title) title.textContent = `✂️ ${t('vedit_title')}`;
  overlay?.classList.add('isOpen');
  setChainChrome(false);
  setOptsOpen(false);   // a popover opens closed, however you left it last time
  applyLaneWidth(savedLaneWidth());
  wireSplitter();
  renderLane();
  renderTrim();
  renderExportBar();
  renderPicker();
  if (clips.length) loadActive(false);
  else { const v = el('veditPreview'); if (v) v.removeAttribute('src'); }
}

// Append a clip from the picker and make it the one under the scrubber — appending
// something you then have to go and click would be half a feature.
async function addClip(id) {
  const c = await toClip(id);
  if (!c) return;
  clips.push(c);
  active = clips.length - 1;
  renderLane();
  renderTrim();
  renderExportBar();
  paintPickerUsed();
  loadActive(false);
}

// Every clip in the gallery, newest first. Clicking one appends it; ones already in the
// cut are marked rather than disabled, because using a clip twice is a real edit.
async function renderPicker() {
  const row = el('veditPicker');
  const label = el('veditPickerLabel');
  if (!row) return;
  if (label) label.textContent = t('vedit_pickHint');
  row.innerHTML = '';
  let items = [];
  try {
    const r = await fetch('/api/gallery/list?type=video&limit=60').then((x) => x.json());
    items = r.items || [];
  } catch { /* offline: an empty strip, and the message below explains it */ }
  if (!items.length) {
    const empty = document.createElement('p');
    empty.className = 'hint veditLaneEmpty';
    empty.textContent = t('vedit_noClips');
    row.appendChild(empty);
    return;
  }
  for (const e of items) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'veditPickFrame';
    btn.dataset.id = e.path;
    btn.title = e.displayName || e.path.split('/').pop();
    const img = document.createElement('img');
    // The filmstrip rendition: this row is 84px wide frames, same as the composer's.
    img.src = galleryThumbUrl(e.path, 'strip');
    img.alt = btn.title;
    img.loading = 'lazy';
    img.draggable = false;
    btn.appendChild(img);
    if (e.length && e.fps) {
      const len = document.createElement('span');
      len.className = 'veditPickLen';
      len.textContent = fmtSec(e.length / e.fps);
      btn.appendChild(len);
    }
    btn.addEventListener('click', () => addClip(e.path));
    row.appendChild(btn);
  }
  paintPickerUsed();
}

function paintPickerUsed() {
  const used = new Map();
  for (const c of clips) used.set(c.id, (used.get(c.id) || 0) + 1);
  for (const btn of document.querySelectorAll('.veditPickFrame')) {
    const n = used.get(btn.dataset.id) || 0;
    btn.classList.toggle('isUsed', n > 0);
    btn.querySelector('.veditPickUsed')?.remove();
    if (!n) continue;
    const tag = document.createElement('span');
    tag.className = 'veditPickUsed';
    tag.textContent = n > 1 ? `✓${n}` : '✓';
    btn.appendChild(tag);
  }
}

// ---------------------------------------------------------------------------
// The splitter between the clip list and the player.
// ---------------------------------------------------------------------------

const LANE_KEY = 'heykoko-vedit-lane-w';
const LANE_MIN = 150, LANE_MAX = 560;
const clampLane = (w) => Math.max(LANE_MIN, Math.min(LANE_MAX, Math.round(w)));

// The COLUMN is what the splitter sizes — the list and the Export row above it move
// together, or the row would stay behind and reach across the player.
const laneBox = () => el('veditLaneCol') || el('veditLane');

function applyLaneWidth(w) {
  const col = laneBox();
  if (col) col.style.width = `${clampLane(w)}px`;
}

function savedLaneWidth() {
  let v;
  try { v = Number(localStorage.getItem(LANE_KEY)); } catch { /* private mode */ }
  return Number.isFinite(v) && v >= LANE_MIN ? clampLane(v) : 240;
}

// Wired on first open. The overlay's markup is static — it is never re-rendered — so the
// flag is what stops a second open from stacking a second set of listeners.
function wireSplitter() {
  const bar = el('veditSplit');
  const lane = laneBox();
  if (!bar || !lane || bar.dataset.wired) return;
  bar.dataset.wired = '1';
  let startX = 0, startW = 0;
  bar.addEventListener('pointerdown', (ev) => {
    startX = ev.clientX;
    startW = lane.getBoundingClientRect().width;
    bar.classList.add('isDragging');
    // Capture, so a fast drag that outruns the 9px handle keeps resizing instead of
    // dropping the gesture on whatever is under the cursor.
    bar.setPointerCapture(ev.pointerId);
    ev.preventDefault();
  });
  bar.addEventListener('pointermove', (ev) => {
    if (!bar.classList.contains('isDragging')) return;
    applyLaneWidth(startW + (ev.clientX - startX));
  });
  const end = () => {
    if (!bar.classList.contains('isDragging')) return;
    bar.classList.remove('isDragging');
    try { localStorage.setItem(LANE_KEY, String(Math.round(lane.getBoundingClientRect().width))); } catch { /* private mode */ }
  };
  bar.addEventListener('pointerup', end);
  bar.addEventListener('pointercancel', end);
  // Keyboard: the handle is a separator, and a separator you cannot move without a mouse
  // is not one.
  bar.tabIndex = 0;
  bar.addEventListener('keydown', (ev) => {
    const step = ev.key === 'ArrowLeft' ? -16 : ev.key === 'ArrowRight' ? 16 : 0;
    if (!step) return;
    ev.preventDefault();
    applyLaneWidth(lane.getBoundingClientRect().width + step);
    try { localStorage.setItem(LANE_KEY, String(Math.round(lane.getBoundingClientRect().width))); } catch { /* private mode */ }
  });
}

export function closeVideoEditor() {
  const v = el('veditPreview');
  try { v.pause(); } catch { /* not playing */ }
  playAll = false;
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => { /* already out */ });
  setChainChrome(false);
  el('veditOverlay')?.classList.remove('isOpen');
}

// ---------------------------------------------------------------------------
// Preview player: one <video>, simulated multi-clip playback.
// ---------------------------------------------------------------------------

function loadActive(andPlay) {
  const v = el('veditPreview');
  const c = clips[active];
  if (!v || !c) return;
  const want = new URL(c.url, location.href).href;
  const seekIn = () => {
    // A clip whose ledger had no duration learns it from the element here.
    if (!c.dur && v.duration > 0) { c.dur = v.duration; c.out = c.out || v.duration; renderTrim(); renderLane(); }
    v.currentTime = c.in || 0;
    if (andPlay) v.play().catch(() => { /* autoplay policy */ });
  };
  if (v.src === want) { seekIn(); return; }
  v.src = want;
  v.addEventListener('loadedmetadata', seekIn, { once: true });
}

// Where this clip's turn ends: its out point, or the file's real end if that comes first.
// The out point is derived from the ledger's length/fps, which can be a hair longer than
// the container actually is — and a threshold past the end of the media is one the
// playhead never crosses.
function chainOutOf(v, c) {
  const dur = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : Infinity;
  return Math.min(c.out, dur);
}

// Chrome's native controls reset with the element on every `src` change, so each handover
// flashed the control bar AND its full-frame dark scrim back over the picture — with the
// pointer nowhere near the player. They fade again after ~1s of playback, which is most of
// a short clip. So the chain runs without them and the player takes a click to stop; the
// native scrubber was lying during a chain anyway (it reads the current FILE's time, not
// the cut's).
function setChainChrome(chaining) {
  const v = el('veditPreview');
  if (!v) return;
  v.controls = !chaining;
  v.classList.toggle('isChaining', chaining);
  v.title = chaining ? t('vedit_clickToStop') : '';
  // Taking the native controls away takes their fullscreen button with them, so ours
  // stands in for exactly as long as they are gone.
  paintFullscreenBtn();
}

// The stage goes fullscreen rather than the <video>: a fullscreened video element draws
// its own native controls over itself, which is the scrim we just got rid of.
function toggleFullscreen() {
  const stage = el('veditStage');
  if (!stage) return;
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => { /* already out */ });
  else stage.requestFullscreen?.().catch(() => { /* denied: nothing to undo */ });
}

function paintFullscreenBtn() {
  const fs = el('veditFsBtn');
  if (!fs) return;
  const on = !!document.fullscreenElement;
  // One glyph both ways: the pair of arrows-in/arrows-out symbols renders as tofu in
  // enough fonts that the label is doing the work anyway.
  fs.title = t(on ? 'vedit_exitFullscreen' : 'vedit_fullscreen');
  fs.setAttribute('aria-label', fs.title);
  if (on) fs.hidden = false;   // in fullscreen it is the only way back out
  else fs.hidden = !playAll;
}

function advanceChain() {
  const v = el('veditPreview');
  if (playAll && active < clips.length - 1) {
    active++;
    highlightLane();
    renderTrim();
    loadActive(true);
    return;
  }
  try { v?.pause(); } catch { /* already stopped */ }
  playAll = false;
  setChainChrome(false);
}

function onTimeUpdate() {
  const v = el('veditPreview');
  const c = clips[active];
  if (!v || !c || v.paused) return;
  if (v.currentTime >= chainOutOf(v, c) - 0.03) advanceChain();
}

// A clip that runs to its NATURAL end never delivers a timeupdate past the out point: the
// browser fires `ended` and flips `paused` first, so onTimeUpdate returns at its own
// guard and the chain stops dead. Trimmed clips hand over early and hid this — which is
// to say it broke on exactly the clips anyone starts with, and the test that "covered"
// chaining had trimmed both of them.
function onEnded() {
  if (!clips[active]) return;
  advanceChain();
}

// ---------------------------------------------------------------------------
// Clip lane: ordered cards, drag to reorder, click to select, ✕ to remove.
// ---------------------------------------------------------------------------

let dragFrom = null;

// Position in the cut, how much of the clip survives the trim, and — only once it IS
// trimmed — what it started as. One function because the scrubber repaints this same
// label live while a handle is dragged: two copies of the format drifted apart within
// the hour (the scrubber's kept overwriting the fuller one).
function clipLabelText(c, i) {
  const trimmed = clipLen(c);
  const full = c.dur || 0;
  return `${i + 1} · ${fmtSec(trimmed)}`
    + (full && Math.abs(full - trimmed) > 0.01 ? ` / ${fmtSec(full)}` : '');
}

const fmtSize = (b) => (!b ? '' : b >= 1073741824 ? `${(b / 1073741824).toFixed(1)} GB`
  : b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

// What the clip IS, as opposed to what the cut does with it: frame size, frame rate, file
// size. Mixed sizes or frame rates are the thing that makes a stitch look wrong (the
// export normalises everything to the first clip), so they belong where the clips are
// listed, not two clicks away in the gallery. Whatever the ledger does not know is simply
// left out rather than printed as a zero.
function clipSpecText(c) {
  const e = c.entry || {};
  const bits = [];
  if (e.width && e.height) bits.push(`${e.width}×${e.height}`);
  if (e.fps) bits.push(`${e.fps}fps`);
  const size = fmtSize(e.bytes);
  if (size) bits.push(size);
  return bits.join(' · ');
}

function renderLane() {
  const lane = el('veditLane');
  if (!lane) return;
  lane.innerHTML = '';
  if (!clips.length) {
    const empty = document.createElement('p');
    empty.className = 'veditLaneEmpty';
    empty.textContent = t('vedit_laneEmpty');
    lane.appendChild(empty);
    return;
  }
  clips.forEach((c, i) => {
    const card = document.createElement('div');
    card.className = 'veditClipCard' + (i === active ? ' isActive' : '');
    card.dataset.index = i;
    card.draggable = true;
    card.addEventListener('dragstart', (ev) => {
      dragFrom = i;
      if (ev.dataTransfer) { ev.dataTransfer.effectAllowed = 'move'; try { ev.dataTransfer.setData('text/plain', String(i)); } catch { /* ok */ } }
    });
    // Both dragenter AND dragover must preventDefault — the gallery's drop-zone
    // comment records how skipping one shipped broken while synthetic tests passed.
    card.addEventListener('dragenter', (ev) => { if (dragFrom != null) ev.preventDefault(); });
    card.addEventListener('dragover', (ev) => {
      if (dragFrom == null) return;
      ev.preventDefault();
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
    });
    card.addEventListener('drop', (ev) => {
      ev.preventDefault();
      if (dragFrom == null || dragFrom === i) { dragFrom = null; return; }
      const activeClip = clips[active];
      const [moved] = clips.splice(dragFrom, 1);
      clips.splice(i, 0, moved);
      active = clips.indexOf(activeClip);
      dragFrom = null;
      renderLane();
      renderTrim();
      renderExportBar();
    });
    card.addEventListener('click', () => {
      if (active === i) return;
      // Picking a clip by hand is taking the wheel: the chain stops and the controls come back.
      playAll = false;
      setChainChrome(false);
      active = i;
      highlightLane();
      renderTrim();
      loadActive(false);
    });

    const img = document.createElement('img');
    // The strip rendition: these rows are 64x44, exactly the size the gallery's list view
    // uses and the size that rendition was cut for.
    img.src = galleryThumbUrl(c.id, 'strip');
    img.alt = c.entry.displayName || c.id.split('/').pop();
    img.draggable = false;

    // Name over meta, like a row in the gallery's list view.
    const text = document.createElement('div');
    text.className = 'veditClipText';
    const name = document.createElement('span');
    name.className = 'veditClipName';
    name.textContent = c.entry.displayName || c.id.split('/').pop();
    name.title = c.id;
    const label = document.createElement('span');
    label.className = 'veditClipLabel';
    label.textContent = clipLabelText(c, i);
    text.append(name, label);
    const specs = clipSpecText(c);
    if (specs) {
      const spec = document.createElement('span');
      spec.className = 'veditClipSpec';
      spec.textContent = specs;
      text.appendChild(spec);
    }
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'veditClipRemove';
    rm.textContent = '✕';
    rm.title = t('vedit_removeClip');
    rm.addEventListener('click', (ev) => {
      ev.stopPropagation();
      clips.splice(i, 1);
      if (active >= clips.length) active = Math.max(0, clips.length - 1);
      renderLane();
      renderTrim();
      renderExportBar();
      paintPickerUsed();
      // Removing the last clip no longer closes the editor: it lands on the same empty
      // state ✂️ opens with, and the picker is right there to start again.
      if (clips.length) loadActive(false);
      else { const v = el('veditPreview'); try { v.pause(); } catch { /* not playing */ } v?.removeAttribute('src'); }
    });
    card.append(img, text, rm);
    lane.appendChild(card);
  });
}

function highlightLane() {
  document.querySelectorAll('.veditClipCard').forEach((n) => {
    n.classList.toggle('isActive', Number(n.dataset.index) === active);
  });
}

// ---------------------------------------------------------------------------
// Trim scrubber: filmstrip background + two draggable in/out handles.
// ---------------------------------------------------------------------------

function renderTrim() {
  const box = el('veditTrim');
  const c = clips[active];
  if (!box) return;
  box.innerHTML = '';
  if (!c) return;

  const strip = document.createElement('div');
  strip.className = 'veditStrip';

  // Filmstrip: ~10 evenly spaced frames, extracted once per clip and cached. Range
  // support on /api/gallery/file makes the seeks cheap.
  // Frames are flex children; the shades/handles/playhead are absolutely positioned
  // above them, so append order between the two groups does not matter.
  const paintFrames = (frames) => {
    if (clips[active] !== c) return;   // user moved on while we were extracting
    for (const f of frames) {
      const img = document.createElement('img');
      img.src = f.url;
      img.draggable = false;
      strip.appendChild(img);
    }
  };
  if (c.frames) paintFrames(c.frames);
  else extractVideoFrames(c.url, 10, 0.6, 320).then((frames) => { c.frames = frames || []; paintFrames(c.frames); });

  const shadeL = document.createElement('div');
  shadeL.className = 'veditShade';
  const shadeR = document.createElement('div');
  shadeR.className = 'veditShade';
  const handleIn = document.createElement('div');
  handleIn.className = 'veditHandle veditHandleIn';
  const handleOut = document.createElement('div');
  handleOut.className = 'veditHandle veditHandleOut';
  const playhead = document.createElement('div');
  playhead.className = 'veditPlayhead';
  strip.append(shadeL, shadeR, handleIn, handleOut, playhead);

  const inField = document.createElement('input');
  inField.type = 'text';
  inField.className = 'veditTimeField';
  const outField = document.createElement('input');
  outField.type = 'text';
  outField.className = 'veditTimeField';

  const paint = () => {
    const d = c.dur || 1;
    const l = Math.max(0, Math.min(100, (c.in / d) * 100));
    const r = Math.max(0, Math.min(100, (c.out / d) * 100));
    shadeL.style.cssText = `left:0;width:${l}%`;
    shadeR.style.cssText = `left:${r}%;width:${100 - r}%`;
    handleIn.style.left = `${l}%`;
    handleOut.style.left = `${r}%`;
    inField.value = c.in.toFixed(2);
    outField.value = c.out.toFixed(2);
    const card = document.querySelector(`.veditClipCard[data-index="${active}"] .veditClipLabel`);
    if (card) card.textContent = clipLabelText(c, active);
    updateEstimate();
  };

  const commit = (which, val) => {
    const d = c.dur || 0;
    let n = Number(val);
    if (!Number.isFinite(n)) { paint(); return; }
    n = Math.max(0, Math.min(d, n));
    // Keep at least a tenth of a second between the points — a zero-length clip is
    // never what was meant, and the server would reject it.
    if (which === 'in') c.in = Math.min(n, c.out - 0.1);
    else c.out = Math.max(n, c.in + 0.1);
    paint();
    const v = el('veditPreview');
    if (v && (v.currentTime < c.in || v.currentTime > c.out)) v.currentTime = which === 'in' ? c.in : Math.max(c.in, c.out - 0.5);
  };

  // Dragging a handle: pointer capture, linear x → seconds over the strip width.
  const wireHandle = (handle, which) => {
    handle.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      handle.setPointerCapture(ev.pointerId);
      const rect = strip.getBoundingClientRect();
      const move = (e) => {
        const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        commit(which, frac * (c.dur || 0));
      };
      const up = (e) => {
        handle.releasePointerCapture(ev.pointerId);
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        move(e);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });
  };
  wireHandle(handleIn, 'in');
  wireHandle(handleOut, 'out');

  // Clicking the strip (not a handle) seeks the preview; the playhead tracks it.
  strip.addEventListener('click', (ev) => {
    if (ev.target === handleIn || ev.target === handleOut) return;
    const rect = strip.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
    const v = el('veditPreview');
    if (v) v.currentTime = frac * (c.dur || 0);
  });
  const v0 = el('veditPreview');
  const trackPlayhead = () => {
    if (clips[active] !== c) return;
    const d = c.dur || 1;
    playhead.style.left = `${Math.max(0, Math.min(100, ((v0?.currentTime || 0) / d) * 100))}%`;
  };
  v0?.addEventListener('timeupdate', trackPlayhead);

  inField.addEventListener('change', () => commit('in', inField.value));
  outField.addEventListener('change', () => commit('out', outField.value));

  // Row of controls under the strip: in/out fields + set-from-playhead + play-all.
  const controls = document.createElement('div');
  controls.className = 'veditTrimControls';
  const lbl = (key) => { const s = document.createElement('span'); s.className = 'hint'; s.textContent = t(key); return s; };
  const btn = (text, title, fn) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'secondary'; b.textContent = text;
    if (title) b.title = title;
    b.addEventListener('click', fn);
    return b;
  };
  const setIn = btn('⇤', t('vedit_fromPlayhead'), () => { const v = el('veditPreview'); if (v) commit('in', v.currentTime); });
  const setOut = btn('⇥', t('vedit_fromPlayhead'), () => { const v = el('veditPreview'); if (v) commit('out', v.currentTime); });
  // Two buttons, because they answer two different questions: "is THIS trim right" and
  // "does the whole thing hang together". One toggle made you guess which mode you were
  // in, and the mode reset itself on every stop.
  const playOne = btn(t('vedit_playOne'), t('vedit_playOneHint'), () => {
    playAll = false;
    setChainChrome(false);
    const v = el('veditPreview');
    if (!v) return;
    // From the in point, not from wherever the playhead was left.
    v.currentTime = c.in;
    v.play().catch(() => { /* autoplay policy */ });
  });
  const playBtn = btn(t('vedit_playAll'), t('vedit_playAllHint'), () => {
    playAll = true;
    setChainChrome(true);
    active = 0;
    highlightLane();
    renderTrim();
    loadActive(true);
  });
  // With one clip the two buttons would do exactly the same thing, and a pair of buttons
  // that behave identically is what made the single toggle confusing in the first place.
  playBtn.disabled = clips.length < 2;
  controls.append(lbl('vedit_in'), inField, setIn, lbl('vedit_out'), outField, setOut, playOne, playBtn);

  box.append(strip, controls);
  paint();
}

// ---------------------------------------------------------------------------
// Export bar: audio / transition / codec / quality / estimate / go.
// ---------------------------------------------------------------------------

let estimateEl = null;

function updateEstimate() {
  if (!estimateEl) return;
  const bad = fade > 0 && clips.length > 1 && fade >= Math.min(...clips.map(clipLen)) / 2;
  estimateEl.textContent = t('vedit_est', { s: totalLen().toFixed(1) }) + (bad ? ` · ⚠️ ${t('vedit_fadeTooLong')}` : '');
  estimateEl.classList.toggle('isWarn', bad);
}

// Every export setting lives in a popover off the ⚙: they all have defaults worth keeping,
// and laid out in a row they wrapped and pushed Export around. Starts closed, like any
// popover — it is not state, it is a drawer.
const optsOpen = () => !el('veditExportBar')?.hidden;
function setOptsOpen(open) {
  const panel = el('veditExportBar');
  const btn = el('veditOptsBtn');
  if (panel) panel.hidden = !open;
  if (btn) {
    btn.classList.toggle('isOn', open);
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
}

function renderExportBar() {
  const bar = el('veditExportBar');
  const head = el('veditHeadCtl');
  if (!bar) return;
  const wasOpen = optsOpen();
  bar.innerHTML = '';
  if (head) head.innerHTML = '';

  const sel = (opts, value, onChange) => {
    const s = document.createElement('select');
    s.className = 'libraryRatingFilter';
    for (const [v, label] of opts) {
      const o = document.createElement('option');
      o.value = v; o.textContent = label;
      s.appendChild(o);
    }
    s.value = value;
    s.addEventListener('change', () => onChange(s.value));
    return s;
  };
  const lbl = (key) => { const s = document.createElement('span'); s.className = 'hint'; s.textContent = t(key); return s; };

  // Audio: keep / mute / an external track picked from the gallery.
  const trackSel = sel([['', '…']], '', (v) => { audioId = v; });
  trackSel.hidden = audioMode !== 'track';
  const fillTracks = async () => {
    try {
      const [au, vi] = await Promise.all([
        fetch('/api/gallery/list?type=audio&limit=100').then((r) => r.json()),
        fetch('/api/gallery/list?type=video&limit=100').then((r) => r.json()),
      ]);
      trackSel.innerHTML = '';
      // Audio entries first (TTS "朗读" output etc.), then videos whose soundtrack to lift.
      for (const e of [...(au.items || []), ...(vi.items || [])]) {
        const o = document.createElement('option');
        o.value = e.path;
        o.textContent = `${e.kind === 'audio' ? '🔊' : '🎬'} ${e.displayName || e.path.split('/').pop()}`;
        trackSel.appendChild(o);
      }
      if (!audioId && trackSel.options.length) audioId = trackSel.options[0].value;
      trackSel.value = audioId;
    } catch { /* offline — the select stays empty and the server will refuse */ }
  };
  const audioSel = sel([['keep', t('vedit_audioKeep')], ['mute', t('vedit_audioMute')], ['track', t('vedit_audioTrack')]],
    audioMode, (v) => {
      audioMode = v;
      trackSel.hidden = v !== 'track';
      if (v === 'track' && !trackSel.options.length) fillTracks();
    });
  if (audioMode === 'track') fillTracks();

  // Transition: hard cut / crossfade with a duration.
  const fadeField = document.createElement('input');
  fadeField.type = 'number';
  fadeField.className = 'veditFadeField';
  fadeField.min = '0.1'; fadeField.max = '2'; fadeField.step = '0.1';
  fadeField.value = String(fade || 0.5);
  fadeField.hidden = !fade;
  fadeField.addEventListener('change', () => {
    fade = Math.max(0.1, Math.min(2, Number(fadeField.value) || 0.5));
    fadeField.value = String(fade);
    updateEstimate();
  });
  const transSel = sel([['none', t('vedit_transNone')], ['crossfade', t('vedit_transFade')]],
    fade ? 'crossfade' : 'none', (v) => {
      fade = v === 'crossfade' ? Math.max(0.1, Number(fadeField.value) || 0.5) : 0;
      fadeField.hidden = !fade;
      updateEstimate();
    });

  // Output size and rate. Both empty = follow the first clip, and the placeholder says what
  // that is — the cut is normalized to ONE size and rate either way, so this is the knob
  // that decides which. Free text rather than a preset list: the sizes that matter here are
  // whatever the local models happen to render at, and a list would always be missing one.
  const src = clips[0];
  const srcSize = src && src.entry.width && src.entry.height ? `${src.entry.width}×${src.entry.height}` : '—';
  const srcFps = src && src.entry.fps ? String(Math.round(src.entry.fps * 100) / 100) : '—';
  const sizeField = document.createElement('input');
  sizeField.type = 'text';               // a number input silently swallows "1280x720"
  sizeField.className = 'veditSizeField';
  sizeField.id = 'veditSizeField';
  sizeField.placeholder = srcSize;
  sizeField.title = t('vedit_sizeHint', { s: srcSize });
  sizeField.setAttribute('list', 'veditSizeList');
  sizeField.value = outW && outH ? `${outW}×${outH}` : '';
  sizeField.addEventListener('change', () => {
    const m = sizeField.value.trim().match(/^(\d{2,5})\s*[x×*: ]\s*(\d{2,5})$/);
    if (!sizeField.value.trim()) { outW = outH = 0; }
    else if (m) { outW = Number(m[1]); outH = Number(m[2]); }
    // Anything else is a typo, not an instruction: fall back to the source rather than
    // rendering something nobody asked for.
    else { outW = outH = 0; }
    sizeField.value = outW && outH ? `${outW}×${outH}` : '';
  });
  const sizeList = document.createElement('datalist');
  sizeList.id = 'veditSizeList';
  for (const s of ['1920×1080', '1280×720', '1080×1920', '720×1280', '1024×1024', '3840×2160']) {
    const o = document.createElement('option');
    o.value = s;
    sizeList.appendChild(o);
  }
  // A short list beats a free number: these are the rates local models actually render at
  // (Wan 16, LTX/most 24) plus the broadcast ones. "" is follow-the-first-clip, and it
  // names the number so the default is never a mystery.
  const FPS_CHOICES = [8, 12, 15, 16, 24, 25, 30, 48, 50, 60];
  const fpsOpts = [['', t('vedit_fpsAuto', { s: srcFps })]];
  // A rate set earlier that is not on the list still has to be selectable, or reopening
  // the editor would silently reset it.
  for (const n of [...new Set([...FPS_CHOICES, ...(outFps ? [outFps] : [])])].sort((a, b) => a - b)) {
    fpsOpts.push([String(n), `${n} fps`]);
  }
  const fpsField = sel(fpsOpts, outFps ? String(outFps) : '', (v) => { outFps = Number(v) || 0; });
  fpsField.id = 'veditFpsField';
  fpsField.title = t('vedit_fpsHint', { s: srcFps });

  const codecSel = sel([['h265', 'H.265'], ['h264', 'H.264']], codec, (v) => { codec = v; paintQuality(); });
  const crfField = document.createElement('input');
  crfField.type = 'range';
  crfField.min = '14'; crfField.max = '32'; crfField.step = '1';
  crfField.value = String(crf);
  // H.265 goes through Apple's hardware encoder, which has no CRF knob — the slider then
  // only decides the quality of the H.264 fallback. Left usable (that fallback is real on
  // a machine without the hardware), but it should not pretend to be doing more.
  const paintQuality = () => { crfField.title = t(codec === 'h265' ? 'vedit_qualityH265' : 'vedit_quality'); };
  paintQuality();
  crfField.addEventListener('input', () => { crf = Number(crfField.value); crfLabel.textContent = `CRF ${crf}`; });
  const crfLabel = document.createElement('span');
  crfLabel.className = 'hint';
  crfLabel.textContent = `CRF ${crf}`;

  estimateEl = document.createElement('span');
  estimateEl.className = 'veditEstimate hint';

  const hint = document.createElement('span');
  hint.className = 'hint';
  hint.textContent = t('vedit_fadeHint');

  const exportBtn = document.createElement('button');
  exportBtn.type = 'button';
  exportBtn.textContent = t('vedit_export');
  exportBtn.className = 'veditExportBtn';
  // Nothing in the cut: the editor is open and usable, but there is nothing to render.
  exportBtn.disabled = !clips.length;
  exportBtn.addEventListener('click', doExport);

  const optsBtn = document.createElement('button');
  optsBtn.type = 'button';
  optsBtn.id = 'veditOptsBtn';
  optsBtn.className = 'secondary veditOptsBtn';
  optsBtn.textContent = '⚙';
  optsBtn.title = t('vedit_options');
  optsBtn.setAttribute('aria-controls', 'veditExportBar');
  optsBtn.addEventListener('click', (ev) => { ev.stopPropagation(); setOptsOpen(!optsOpen()); });

  head?.append(exportBtn, optsBtn, estimateEl);

  // One setting per row, label left, control right — a wrapping row of eight controls was
  // how Export ended up somewhere different every time the window changed width.
  const row = (key, ...controls) => {
    const name = lbl(key);
    name.className = 'hint veditOptsName';
    const cell = document.createElement('div');
    cell.className = 'veditOptsCell';
    cell.append(...controls);
    bar.append(name, cell);
  };
  row('vedit_size', sizeField, sizeList);
  row('vedit_fps', fpsField);
  row('vedit_audio', audioSel, trackSel);
  row('vedit_transition', transSel, fadeField);
  row('vedit_codec', codecSel);
  row('vedit_qualityLabel', crfField, crfLabel);
  hint.classList.add('veditOptsFull');
  bar.append(hint);
  // A rebuild is not a dismissal. Today every rebuild happens to follow a click outside
  // (which closes it anyway), but the popover should not depend on that coincidence.
  setOptsOpen(wasOpen);
  updateEstimate();
}

function doExport() {
  if (!clips.length) return;
  if (fade > 0 && clips.length > 1 && fade >= Math.min(...clips.map(clipLen)) / 2) {
    alert(t('vedit_fadeTooLong'));
    return;
  }
  if (audioMode === 'track' && !audioId) { alert(t('vedit_noClips')); return; }
  const payload = {
    clips: clips.map((c) => ({ id: c.id, inSec: Number(c.in.toFixed(3)), outSec: Number(c.out.toFixed(3)) })),
    codec, crf,
    width: outW || undefined, height: outH || undefined, fps: outFps || undefined,
    audio: audioMode,
    audioId: audioMode === 'track' ? audioId : undefined,
    transition: fade > 0 && clips.length > 1 ? { type: 'crossfade', durSec: fade } : { type: 'none' },
  };
  const job = enqueueBgJob({
    tabId: state.activeTabId,
    kind: 'vedit',
    noPlaceholder: true,
    label: `✂️ ${t('vedit_jobDetail', { n: clips.length })} → ${totalLen().toFixed(1)}s`,
    payload,
  });
  closeVideoEditor();
  if (job) openBgDrawer(job.id);
}

// ---------------------------------------------------------------------------

export function initVideoEditor() {
  el('veditCloseBtn')?.addEventListener('click', closeVideoEditor);
  el('veditPreview')?.addEventListener('timeupdate', onTimeUpdate);
  el('veditPreview')?.addEventListener('ended', onEnded);
  // With the native controls off for the chain the picture would otherwise be inert, so
  // the frame itself becomes the stop button.
  el('veditPreview')?.addEventListener('click', () => {
    const v = el('veditPreview');
    if (!v || v.controls) return;   // controls on: the browser handles the click
    try { v.pause(); } catch { /* already stopped */ }
    playAll = false;
    setChainChrome(false);
  });
  el('veditFsBtn')?.addEventListener('click', (ev) => { ev.stopPropagation(); toggleFullscreen(); });
  document.addEventListener('fullscreenchange', paintFullscreenBtn);
  // Click anywhere else to dismiss the settings popover — including on the clips and the
  // player, which is where you go next.
  document.addEventListener('click', (ev) => {
    if (!optsOpen()) return;
    if (el('veditHeadBar')?.contains(ev.target)) return;
    setOptsOpen(false);
  });
  el('veditOverlay')?.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    // Escape peels one layer at a time: the popover, then fullscreen, then the editor.
    if (optsOpen()) { setOptsOpen(false); ev.stopPropagation(); return; }
    // Escape in fullscreen means "come back out", not "throw away the cut I was building".
    // Chrome usually eats that keypress itself, but a stray one must not close the editor.
    if (document.fullscreenElement) { document.exitFullscreen?.().catch(() => {}); ev.stopPropagation(); return; }
    closeVideoEditor();
    ev.stopPropagation();
  });
}
