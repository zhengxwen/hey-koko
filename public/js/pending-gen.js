// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

// In-progress media generation (image / video / audio) bubble.
//
// The bubble's data lives in state.pendingGen so renderChat() can rebuild it
// faithfully after a tab switch. These helpers keep state and the live DOM in
// sync, mirroring how the text-streaming bubble re-queries the DOM on every
// update instead of holding a stale node reference. That's what lets a
// generation that started in tab A keep updating live when the user switches
// away and back — and always land in tab A regardless of what's on screen.
import { dom, state, scrollChatToEnd, scrollChatToEndIfPinned } from './state.js';

const DOTS = `<span class="thinking-dots"><span>.</span><span>.</span><span>.</span><span>.</span><span>.</span><span>.</span></span>`;

// The active pendingGen, but only if it belongs to the given tab (guards against
// a stale callback from a finished run clobbering a newer one).
function _pg(tabId) {
  return (state.pendingGen && state.pendingGen.tabId === tabId) ? state.pendingGen : null;
}

// The currently-mounted pending bubble. Present only while its tab is on screen;
// returns null when generating in the background, so DOM patches no-op safely.
function _bubble() {
  return dom.messagesEl.querySelector('.pendingGenBubble');
}

function _imgEl(src) {
  const img = document.createElement('img');
  img.className = 'generatedImage';
  img.src = src;
  img.alt = 'AI 生成的图片';
  return img;
}

function _ensureGrid(bubble) {
  let grid = bubble.querySelector('.imageGrid');
  if (!grid) {
    grid = document.createElement('div');
    grid.className = 'imageGrid';
    const prog = bubble.querySelector('.comfyProgress');
    if (prog) bubble.insertBefore(grid, prog); // keep grid above the progress bar
    else bubble.appendChild(grid);
  }
  return grid;
}

// Inner markup of a .comfyProgress block: a fill bar at the given percent and an
// optional preview frame. Single source of truth for both the live patch path
// (_ensureProgress) and the full rebuild (buildPendingGenBubble).
function _progressHtml(pct, preview, eta, seg) {
  return `<div class="comfyProgressRow">`
    + `<div class="comfyProgressBar"><div class="comfyProgressFill" style="width:${pct}%"></div></div>`
    + `<span class="comfySeg"${seg ? '' : ' hidden'}>${seg || ''}</span>`
    + `<span class="comfyEta"${eta ? '' : ' hidden'}>${eta || ''}</span>`
    + `</div>`
    + `<img class="comfyPreview"${preview ? ` src="${preview}"` : ' hidden'} alt="Preview">`;
}

function _ensureProgress(bubble) {
  let prog = bubble.querySelector('.comfyProgress');
  if (!prog) {
    prog = document.createElement('div');
    prog.className = 'comfyProgress';
    prog.innerHTML = _progressHtml(0, null, null, null);
    bubble.appendChild(prog);
  }
  return prog;
}

// Build the bubble DOM from a pendingGen descriptor — used both when generation
// starts on the active tab and when renderChat() restores it after a switch.
export function buildPendingGenBubble(pg) {
  const bubble = document.createElement('div');
  bubble.className = 'message assistant thinking imageGen pendingGenBubble';
  const body = document.createElement('div');
  body.className = 'markdownBody';
  let html = '';
  if (pg.enhanced) html += `<div class="enhancedPromptPreview">${pg.enhanced}</div>`;
  html += `<span class="thinking-text">${pg.label || ''}${DOTS}</span>`;
  body.innerHTML = html;
  bubble.appendChild(body);
  if (pg.images && pg.images.length) {
    const grid = document.createElement('div');
    grid.className = 'imageGrid';
    for (const src of pg.images) grid.appendChild(_imgEl(src));
    bubble.appendChild(grid);
  }
  if (pg.progress || pg.preview || pg.eta || pg.indeterminate || pg.seg) {
    const prog = document.createElement('div');
    prog.className = 'comfyProgress';
    const pct = (pg.progress && pg.progress.max) ? Math.min(100, Math.round(pg.progress.value / pg.progress.max * 100)) : 0;
    prog.innerHTML = _progressHtml(pct, pg.preview, pg.eta, pg.seg);
    if (pg.indeterminate) prog.querySelector('.comfyProgressBar')?.classList.add('indeterminate');
    bubble.appendChild(prog);
  }
  return bubble;
}

function _mount() {
  const existing = _bubble();
  if (existing) existing.remove();
  const pg = state.pendingGen;
  if (!pg) return;
  const bubble = buildPendingGenBubble(pg);
  const idx = pg.insertIndex;
  const refNode = (idx != null && idx >= 0) ? dom.messagesEl.children[idx] : null;
  if (refNode) dom.messagesEl.insertBefore(bubble, refNode);
  else dom.messagesEl.appendChild(bubble);
  scrollChatToEnd();
}

// Begin tracking a generation. label shows in the spinner; kind is informational.
export function pendingGenStart({ tabId, kind, label, insertIndex }) {
  state.pendingGen = {
    tabId,
    kind,
    label: label || '',
    insertIndex: (insertIndex != null) ? insertIndex : -1,
    enhanced: '',
    images: [],
    progress: null,
    preview: null,
    eta: '',
    seg: '',
    indeterminate: false,
  };
  if (state.activeTabId === tabId) _mount();
}

export function pendingGenSetLabel(tabId, label) {
  const pg = _pg(tabId);
  if (!pg) return;
  pg.label = label;
  const span = _bubble()?.querySelector('.thinking-text');
  if (span) span.innerHTML = `${label}${DOTS}`;
}

// innerHtml is the (caller-escaped) content of the enhanced-prompt preview block.
export function pendingGenSetEnhanced(tabId, innerHtml) {
  const pg = _pg(tabId);
  if (!pg) return;
  pg.enhanced = innerHtml;
  const bubble = _bubble();
  if (!bubble) return;
  const bodyEl = bubble.querySelector('.markdownBody');
  if (!bodyEl) return;
  let pre = bodyEl.querySelector('.enhancedPromptPreview');
  if (!pre) {
    pre = document.createElement('div');
    pre.className = 'enhancedPromptPreview';
    bodyEl.insertBefore(pre, bodyEl.firstChild);
  }
  pre.innerHTML = innerHtml;
}

export function pendingGenAddImage(tabId, src) {
  const pg = _pg(tabId);
  if (!pg) return;
  pg.images.push(src);
  const bubble = _bubble();
  if (!bubble) return;
  _ensureGrid(bubble).appendChild(_imgEl(src));
  scrollChatToEndIfPinned();
}

export function pendingGenSetProgress(tabId, value, max) {
  const pg = _pg(tabId);
  if (!pg || !max) return;
  pg.progress = { value, max };
  const bubble = _bubble();
  if (!bubble) return;
  const fill = _ensureProgress(bubble).querySelector('.comfyProgressFill');
  if (fill) fill.style.width = `${Math.min(100, Math.round(value / max * 100))}%`;
}

// Toggle an indeterminate (sliding) bar for phases ComfyUI reports NO progress for
// (DWPose preprocessing, VAE decode) so the bar doesn't look frozen.
export function pendingGenSetIndeterminate(tabId, on) {
  const pg = _pg(tabId);
  if (!pg) return;
  pg.indeterminate = !!on;
  const bubble = _bubble();
  if (!bubble) return;
  const bar = _ensureProgress(bubble).querySelector('.comfyProgressBar');
  if (bar) bar.classList.toggle('indeterminate', !!on);
}

// Which chunk is being processed (e.g. "第 2/4 段"), shown left of the ETA. Multi-segment only.
export function pendingGenSetSeg(tabId, text) {
  const pg = _pg(tabId);
  if (!pg) return;
  pg.seg = text || '';
  const bubble = _bubble();
  if (!bubble) return;
  const prog = _ensureProgress(bubble);
  let el = prog.querySelector('.comfySeg');
  if (!el) {
    el = document.createElement('span');
    el.className = 'comfySeg';
    const row = prog.querySelector('.comfyProgressRow') || prog;
    row.insertBefore(el, row.querySelector('.comfyEta')); // sit to the LEFT of the clock
  }
  el.textContent = text || '';
  el.hidden = !text;
}

// Estimated time remaining, shown next to the progress bar (e.g. "⏳ ~3:20").
export function pendingGenSetEta(tabId, text) {
  const pg = _pg(tabId);
  if (!pg) return;
  pg.eta = text || '';
  const bubble = _bubble();
  if (!bubble) return;
  const prog = _ensureProgress(bubble);
  let el = prog.querySelector('.comfyEta');
  if (!el) {
    el = document.createElement('span');
    el.className = 'comfyEta';
    (prog.querySelector('.comfyProgressRow') || prog).appendChild(el); // sit to the right of the bar
  }
  el.textContent = text || '';
  el.hidden = !text;
}

export function pendingGenSetPreview(tabId, src) {
  const pg = _pg(tabId);
  if (!pg) return;
  // Free the previous preview frame's object URL before replacing it.
  if (pg.preview && pg.preview !== src && pg.preview.startsWith('blob:')) URL.revokeObjectURL(pg.preview);
  pg.preview = src;
  const bubble = _bubble();
  if (!bubble) return;
  const img = _ensureProgress(bubble).querySelector('.comfyPreview');
  if (img) { img.src = src; img.hidden = false; }
}

// Stop tracking and remove the bubble. Safe to call from any tab / on completion,
// abort or error — renderChat() will not re-create it once state is cleared.
export function pendingGenClear(tabId) {
  const pg = _pg(tabId);
  if (!pg) return;
  if (pg.preview && pg.preview.startsWith('blob:')) URL.revokeObjectURL(pg.preview);
  state.pendingGen = null;
  const bubble = _bubble();
  if (bubble) bubble.remove();
}