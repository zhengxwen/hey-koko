// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

// In-page find bar — the Cmd+F that WKWebView doesn't provide.
//
// In a normal browser the built-in find bar is better than anything we could build,
// so this NEVER binds Cmd+F itself. The macOS app opens it explicitly: the Edit ▸
// Find… menu item calls window.__hkOpenFind() (see AppMain.swift). Browser users
// keep their own find bar untouched.
//
// Two engines, picked automatically:
//
//   RICH  — CSS Custom Highlight API (Safari 17.4+/Chrome 105+). Every match is
//           tinted, the active one more strongly, with an "n / total" counter. It
//           paints Ranges, so it never touches the DOM: no <mark> wrappers to insert
//           into bubbles whose markup is markdown/KaTeX/mermaid/hljs output, and
//           nothing to unwind afterwards. That matters here because bubble content is
//           persisted and sent to the model — corrupting it would be a real bug.
//
//   BASIC — window.find(), the same WebKit engine the native find bar uses. One match
//           at a time via the normal selection highlight, no count. Used verbatim on
//           anything too old for the above.
import { t } from './i18n.js';

const RICH = typeof CSS !== "undefined" && !!CSS.highlights && typeof Highlight === "function";
const HL_ALL = "hk-find";
const HL_CURRENT = "hk-find-current";

let bar = null, input = null, countEl = null;
let lastQuery = "";
let ranges = [];      // RICH only: every match, in document order
let current = -1;     // RICH only: index into `ranges`

function ensureBar() {
  if (bar) return bar;
  bar = document.createElement("div");
  bar.className = "findBar";
  bar.hidden = true;
  bar.innerHTML = `
    <input type="search" class="findBarInput" autocomplete="off" spellcheck="false" />
    <span class="findBarCount"></span>
    <button type="button" class="findBarBtn findBarPrev" aria-label="Previous">‹</button>
    <button type="button" class="findBarBtn findBarNext" aria-label="Next">›</button>
    <button type="button" class="findBarBtn findBarClose" aria-label="Close">✕</button>`;
  document.body.appendChild(bar);

  input = bar.querySelector(".findBarInput");
  countEl = bar.querySelector(".findBarCount");
  input.placeholder = t("find_placeholder");
  bar.querySelector(".findBarPrev").title = t("find_prev");
  bar.querySelector(".findBarNext").title = t("find_next");
  bar.querySelector(".findBarClose").title = t("find_close");

  // BOTH events, and always re-read .value rather than trusting which one fired:
  // the clear button built into <input type="search"> emits `search` WITHOUT an
  // `input` event, so listening to `input` alone left the highlights painted over a
  // query the user had already wiped.
  // Debounced: typing "tried" fires five input events, and each one would otherwise
  // walk the whole document. One search per burst keeps a fast typist from queueing
  // five full passes, the first of which (a single letter) is the most expensive.
  let typeTimer = null;
  const onQuery = () => {
    clearTimeout(typeTimer);
    typeTimer = setTimeout(() => search(input.value), 120);
  };
  input.addEventListener("input", onQuery);
  input.addEventListener("search", onQuery);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); step(!e.shiftKey); }
    else if (e.key === "Escape") { e.preventDefault(); closeFind(); }
  });
  bar.querySelector(".findBarPrev").addEventListener("click", () => step(false));
  bar.querySelector(".findBarNext").addEventListener("click", () => step(true));
  bar.querySelector(".findBarClose").addEventListener("click", closeFind);
  return bar;
}

// ── RICH engine ────────────────────────────────────────────────────────────

// Every text node the user can actually see. Rejecting a hidden element rejects its
// whole subtree, which is what keeps closed panel overlays (display:none, but still
// in the DOM) out of the results — the very thing that made Safari's own Find match
// invisible text.
function* visibleTextNodes() {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        if (node === bar) return NodeFilter.FILTER_REJECT;          // never match ourselves
        const tag = node.tagName;
        if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") return NodeFilter.FILTER_REJECT;
        const cs = getComputedStyle(node);
        if (cs.display === "none" || cs.visibility === "hidden") return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_SKIP;      // descend, but the element itself isn't a match
      }
      return node.nodeValue && node.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  let n;
  while ((n = walker.nextNode())) yield n;
}

function collectRanges(query) {
  const out = [];
  const needle = query.toLowerCase();
  for (const node of visibleTextNodes()) {
    const hay = node.nodeValue.toLowerCase();
    let from = 0, at;
    while ((at = hay.indexOf(needle, from)) !== -1) {
      const r = document.createRange();
      r.setStart(node, at);
      r.setEnd(node, at + needle.length);
      out.push(r);
      from = at + needle.length;
    }
  }
  return out;
}

// Collecting every match is cheap (a 1-letter query over a 240-bubble conversation
// finds ~4500 in ~12ms), but asking the compositor to paint thousands of highlight
// boxes is not. Paint a window around the current match instead: the count still
// reports the true total, and stepping re-centres the window, so the user can reach
// every match without ever handing the engine an unbounded number of boxes.
const MAX_PAINTED = 400;

function paint() {
  if (!RICH) return;
  CSS.highlights.delete(HL_ALL);
  CSS.highlights.delete(HL_CURRENT);
  if (!ranges.length) return;
  let shown = ranges;
  if (ranges.length > MAX_PAINTED) {
    const half = MAX_PAINTED >> 1;
    const from = Math.max(0, Math.min(current - half, ranges.length - MAX_PAINTED));
    shown = ranges.slice(from, from + MAX_PAINTED);
  }
  const others = shown.filter((r) => r !== ranges[current]);
  if (others.length) CSS.highlights.set(HL_ALL, new Highlight(...others));
  if (ranges[current]) CSS.highlights.set(HL_CURRENT, new Highlight(ranges[current]));
}

// Bring a Range into view inside whatever actually scrolls around it (the messages
// column, a panel body, or the window) without disturbing the selection.
function scrollRangeIntoView(range) {
  const rect = range.getBoundingClientRect();
  if (!rect.width && !rect.height) return;
  let el = range.startContainer;
  if (el.nodeType === Node.TEXT_NODE) el = el.parentElement;
  let scroller = el;
  while (scroller && scroller !== document.body) {
    const cs = getComputedStyle(scroller);
    if (/(auto|scroll)/.test(cs.overflowY) && scroller.scrollHeight > scroller.clientHeight) break;
    scroller = scroller.parentElement;
  }
  if (scroller && scroller !== document.body) {
    const box = scroller.getBoundingClientRect();
    if (rect.top < box.top || rect.bottom > box.bottom) {
      scroller.scrollTop += rect.top - box.top - (box.height - rect.height) / 2;
    }
  } else if (rect.top < 0 || rect.bottom > window.innerHeight) {
    window.scrollBy(0, rect.top - window.innerHeight / 2);
  }
}

// ── shared ─────────────────────────────────────────────────────────────────

function setNote(text, miss) {
  countEl.textContent = text;
  countEl.classList.toggle("isMiss", !!miss);
}

// A fresh search for `q`: RICH re-collects every match and jumps to the first;
// BASIC restarts window.find() from the top of the document.
function search(q) {
  lastQuery = q;
  if (!q) {
    ranges = []; current = -1;
    if (RICH) paint();
    setNote("", false);
    return;
  }
  if (RICH) {
    ranges = collectRanges(q);
    current = ranges.length ? 0 : -1;
    paint();
    if (current >= 0) scrollRangeIntoView(ranges[current]);
    setNote(ranges.length ? t("find_count", { i: current + 1, n: ranges.length }) : t("find_noMatch"),
            !ranges.length);
    return;
  }
  window.getSelection()?.removeAllRanges();   // so window.find restarts from the top
  basicFind(true);
}

// Move to the next/previous match.
function step(forward) {
  if (!lastQuery) return;
  if (RICH) {
    // The chat re-renders on every new message, which invalidates these Ranges. Testing
    // isConnected does NOT catch it: the DOM spec repairs live Ranges when nodes are
    // removed by moving their boundary points up to the (still-connected) parent, which
    // leaves them collapsed and painting nothing. So ask the only question that matters
    // — does this range still cover the query? — and re-collect when it doesn't.
    const stale = !ranges.length || ranges[0].toString().toLowerCase() !== lastQuery.toLowerCase();
    if (stale) { search(lastQuery); return; }
    current = (current + (forward ? 1 : -1) + ranges.length) % ranges.length;
    paint();
    scrollRangeIntoView(ranges[current]);
    setNote(t("find_count", { i: current + 1, n: ranges.length }), false);
    return;
  }
  basicFind(forward);
}

// BASIC engine. window.find() searches the WHOLE document — including this bar's own
// input, whose value IS the query, so left visible it matches itself on every
// keystroke and "not found" could never appear. There is no way to scope
// window.find(), so take the bar out of the render tree for the duration; the call is
// synchronous, so nothing is painted in between and it cannot flicker.
function basicFind(forward) {
  const prevDisplay = bar.style.display;
  bar.style.display = "none";
  let hit = false;
  try {
    // (query, caseSensitive, backwards, wrapAround, wholeWord, searchInFrames, showDialog)
    if (typeof window.find === "function") hit = window.find(lastQuery, false, !forward, true, false, true, false);
  } finally {
    bar.style.display = prevDisplay;
  }
  setNote(hit ? "" : t("find_noMatch"), !hit);
  input.focus();   // window.find() moves focus to the match; typing must keep filtering
}

export function openFind() {
  ensureBar();
  bar.hidden = false;
  const sel = String(window.getSelection() || "").trim();
  if (sel && sel.length <= 100) input.value = sel;
  else if (lastQuery) input.value = lastQuery;
  input.focus();
  input.select();
  if (input.value) search(input.value);   // re-run so highlights match what's shown
}

export function closeFind() {
  if (!bar) return;
  bar.hidden = true;
  setNote("", false);
  ranges = []; current = -1;
  if (RICH) paint();                                // clears both highlights
  else window.getSelection()?.removeAllRanges();    // drop the selection highlight
}

export function initFindBar() {
  // The app shell's Edit ▸ Find… menu item calls this through evaluateJavaScript.
  window.__hkOpenFind = openFind;
}
