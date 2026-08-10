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
let codec = 'h264';
let crf = 18;
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

export async function openVideoEditor(ids) {
  const list = [];
  for (const id of ids || []) {
    const entry = await fetchEntry(id);
    if (!entry || entry.kind !== 'video') continue;   // silently skip non-videos in a mixed selection
    const dur = entry.length && entry.fps ? entry.length / entry.fps : 0;
    list.push({ id, entry, url: fileUrl(id), dur, in: 0, out: dur, frames: null });
  }
  if (!list.length) { alert(t('vedit_noClips')); return; }
  clips = list;
  active = 0;
  playAll = false;
  const overlay = el('veditOverlay');
  const title = el('veditTitle');
  if (title) title.textContent = `✂️ ${t('vedit_title')}`;
  overlay?.classList.add('isOpen');
  renderLane();
  renderTrim();
  renderExportBar();
  loadActive(false);
}

export function closeVideoEditor() {
  const v = el('veditPreview');
  try { v.pause(); } catch { /* not playing */ }
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

function onTimeUpdate() {
  const v = el('veditPreview');
  const c = clips[active];
  if (!v || !c || v.paused) return;
  if (v.currentTime >= c.out - 0.03) {
    if (playAll && active < clips.length - 1) {
      active++;
      highlightLane();
      renderTrim();
      loadActive(true);
    } else {
      v.pause();
      playAll = false;
    }
  }
}

// ---------------------------------------------------------------------------
// Clip lane: ordered cards, drag to reorder, click to select, ✕ to remove.
// ---------------------------------------------------------------------------

let dragFrom = null;

function renderLane() {
  const lane = el('veditLane');
  if (!lane) return;
  lane.innerHTML = '';
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
      active = i;
      highlightLane();
      renderTrim();
      loadActive(false);
    });

    const img = document.createElement('img');
    img.src = galleryThumbUrl(c.id);
    img.alt = c.entry.displayName || c.id.split('/').pop();
    img.draggable = false;
    const label = document.createElement('span');
    label.className = 'veditClipLabel';
    label.textContent = `${i + 1} · ${fmtSec(clipLen(c))}`;
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'veditClipRemove';
    rm.textContent = '✕';
    rm.title = t('vedit_removeClip');
    rm.addEventListener('click', (ev) => {
      ev.stopPropagation();
      clips.splice(i, 1);
      if (!clips.length) { closeVideoEditor(); return; }
      if (active >= clips.length) active = clips.length - 1;
      renderLane();
      renderTrim();
      renderExportBar();
      loadActive(false);
    });
    card.append(img, label, rm);
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
    if (card) card.textContent = `${active + 1} · ${fmtSec(clipLen(c))}`;
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
  const playBtn = btn(t('vedit_playAll'), '', () => {
    playAll = true;
    active = 0;
    highlightLane();
    renderTrim();
    loadActive(true);
  });
  controls.append(lbl('vedit_in'), inField, setIn, lbl('vedit_out'), outField, setOut, playBtn);

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

function renderExportBar() {
  const bar = el('veditExportBar');
  if (!bar) return;
  bar.innerHTML = '';

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

  const codecSel = sel([['h264', 'H.264'], ['h265', 'H.265']], codec, (v) => { codec = v; });
  const crfField = document.createElement('input');
  crfField.type = 'range';
  crfField.min = '14'; crfField.max = '32'; crfField.step = '1';
  crfField.value = String(crf);
  crfField.title = t('vedit_quality');
  crfField.addEventListener('input', () => { crf = Number(crfField.value); crfLabel.textContent = `CRF ${crf}`; });
  const crfLabel = document.createElement('span');
  crfLabel.className = 'hint';
  crfLabel.textContent = `CRF ${crf}`;

  estimateEl = document.createElement('span');
  estimateEl.className = 'veditEstimate hint';

  const hint = document.createElement('span');
  hint.className = 'hint veditFadeHint';
  hint.textContent = t('vedit_fadeHint');

  const exportBtn = document.createElement('button');
  exportBtn.type = 'button';
  exportBtn.textContent = t('vedit_export');
  exportBtn.className = 'veditExportBtn';
  exportBtn.addEventListener('click', doExport);

  bar.append(lbl('vedit_audio'), audioSel, trackSel,
             lbl('vedit_transition'), transSel, fadeField,
             codecSel, crfField, crfLabel, estimateEl, exportBtn, hint);
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
  el('veditOverlay')?.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') { closeVideoEditor(); ev.stopPropagation(); }
  });
}
