// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

// Text highlighting for message bubbles (colors + underline + strikethrough).
//
// Highlights are DISPLAY-ONLY decorations, never touching the stored markdown
// `content` — so they don't leak into copy / translate / speech / model context,
// and they survive the read-aloud feature's innerHTML save-restore untouched
// (they're already in the render the snapshot captures).
//
// Persistence uses CONTENT ANCHORING rather than raw offsets: each highlight
// stores the highlighted substring (`quote`) plus a little preceding context
// (`prefix`). On every render we re-flatten the body's visible text and re-find
// the quote (prefix disambiguates repeats). Editing the markdown that doesn't
// touch a highlighted phrase → it re-anchors and survives; editing that removes
// the phrase → that one highlight is silently dropped, others stay.

const STYLES = new Set(["yellow", "green", "blue", "pink", "purple", "underline", "strike"]);

// Elements whose text is NOT highlightable (mirrors the speech walker's skips):
// code blocks and rendered math/diagrams — highlighting inside them would corrupt
// syntax highlighting / KaTeX and isn't meaningful.
function isSkipped(el) {
  const tag = el.tagName;
  if (tag === "PRE" || tag === "SVG") return true;
  // hlNoteMark = our own injected 💬 marker, not real message text.
  return el.classList.contains("katex") || el.classList.contains("mermaid") ||
         el.classList.contains("hlNoteMark");
}

// Flatten a rendered body into { flat, nodes }: `flat` is the concatenation of
// every highlightable text node's content (document order); `nodes[i]` = { node,
// start } records where each text node begins in `flat`. This is the single shared
// coordinate system both capture (selection → offsets) and apply (offsets → DOM
// wrapping) speak in.
function flattenBody(root) {
  const nodes = [];
  let flat = "";
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        nodes.push({ node: child, start: flat.length });
        flat += child.textContent;
      } else if (child.nodeType === Node.ELEMENT_NODE && !isSkipped(child)) {
        walk(child);
      }
    }
  };
  walk(root);
  return { flat, nodes };
}

// First flat index at or after DOM node `x` (x itself, a descendant, or any node
// that follows x in document order). Used to map an element-boundary selection
// point to a flat offset.
function firstFlatAtOrAfter(nodes, flatLen, x) {
  for (const n of nodes) {
    const pos = x.compareDocumentPosition(n.node);
    if (n.node === x ||
        (pos & Node.DOCUMENT_POSITION_CONTAINED_BY) ||
        (pos & Node.DOCUMENT_POSITION_FOLLOWING)) {
      return n.start;
    }
  }
  return flatLen;
}

// End flat index of the last text node inside `x` or preceding it — the flat
// position of a boundary sitting at the END of element `x`.
function lastFlatWithinOrBefore(nodes, x) {
  let val = 0;
  for (const n of nodes) {
    const pos = x.compareDocumentPosition(n.node);
    if (n.node === x ||
        (pos & Node.DOCUMENT_POSITION_CONTAINED_BY) ||
        (pos & Node.DOCUMENT_POSITION_PRECEDING)) {
      val = n.start + n.node.textContent.length;
    }
  }
  return val;
}

// Map a DOM selection boundary (container, offset) to a flat offset.
function pointToFlat(nodes, flatLen, container, offset) {
  if (container.nodeType === Node.TEXT_NODE) {
    const e = nodes.find((n) => n.node === container);
    if (e) return e.start + Math.min(offset, container.textContent.length);
    return firstFlatAtOrAfter(nodes, flatLen, container); // selection dipped into skipped text
  }
  const kids = container.childNodes;
  if (offset < kids.length) return firstFlatAtOrAfter(nodes, flatLen, kids[offset]);
  return lastFlatWithinOrBefore(nodes, container);
}

// Flat [a, b) range of the current selection within `bodyEl`, or null.
function selectionFlatRange(bodyEl, range) {
  const { flat, nodes } = flattenBody(bodyEl);
  const flatLen = flat.length;
  const s = pointToFlat(nodes, flatLen, range.startContainer, range.startOffset);
  const e = pointToFlat(nodes, flatLen, range.endContainer, range.endOffset);
  const a = Math.min(s, e), b = Math.max(s, e);
  return b > a ? { flat, a, b } : null;
}

// Build a persistable anchor { quote, prefix } from a live selection.
export function captureAnchor(bodyEl, range) {
  const r = selectionFlatRange(bodyEl, range);
  if (!r) return null;
  const quote = r.flat.slice(r.a, r.b);
  if (!quote.trim()) return null;
  return { quote, prefix: r.flat.slice(Math.max(0, r.a - 32), r.a) };
}

// Re-find a stored anchor in freshly-flattened text. Among all occurrences of
// `quote`, pick the one whose preceding text best matches `prefix` (longest
// common suffix) — so repeated phrases land on the originally-highlighted one.
function resolveAnchor(flat, hl) {
  const quote = hl.quote;
  if (!quote) return null;
  const prefix = hl.prefix || "";
  let idx = -1, best = -1, from = 0;
  for (;;) {
    const i = flat.indexOf(quote, from);
    if (i < 0) break;
    const p = flat.slice(Math.max(0, i - prefix.length), i);
    let score = 0;
    const lim = Math.min(p.length, prefix.length);
    while (score < lim && p[p.length - 1 - score] === prefix[prefix.length - 1 - score]) score++;
    if (score > best) { best = score; idx = i; }
    from = i + 1;
  }
  return idx < 0 ? null : { start: idx, end: idx + quote.length };
}

// Wrap the flat range [start, end) — splitting text nodes as needed — in
// <span class="hlmark hl-STYLE" data-hl-idx=IDX>. Applied one highlight at a
// time over a fresh flatten, so overlapping highlights simply NEST: each new
// wrap descends into the text nodes the previous ones produced. Underline/strike
// combine cleanly with a color; color-over-color shows the newer (inner) color in
// the overlap. A highlight carrying a note gets a trailing 💬 marker on its last
// wrapped span (the click target for viewing/editing the note).
function wrapRange(nodes, start, end, style, idx, note) {
  const hasNote = !!note;
  const ops = [];
  for (const n of nodes) {
    const nStart = n.start, nEnd = n.start + n.node.textContent.length;
    const s = Math.max(start, nStart), e = Math.min(end, nEnd);
    if (s < e) ops.push({ node: n.node, from: s - nStart, to: e - nStart });
  }
  ops.forEach((op, oi) => {
    const text = op.node.textContent;
    const frag = document.createDocumentFragment();
    if (op.from > 0) frag.appendChild(document.createTextNode(text.slice(0, op.from)));
    const span = document.createElement("span");
    span.className = "hlmark hl-" + style + (hasNote ? " has-note" : "");
    span.dataset.hlIdx = String(idx);
    span.textContent = text.slice(op.from, op.to);
    frag.appendChild(span);
    if (hasNote && oi === ops.length - 1) {
      const mark = document.createElement("sup");
      mark.className = "hlNoteMark";
      mark.dataset.hlIdx = String(idx);
      mark.textContent = "💬";
      mark.title = note;   // hover shows the comment text
      frag.appendChild(mark);
    }
    if (op.to < text.length) frag.appendChild(document.createTextNode(text.slice(op.to)));
    op.node.parentNode.replaceChild(frag, op.node);
  });
}

// Re-apply every stored highlight to a freshly-rendered body. Unresolvable
// anchors (their phrase was edited away) are skipped. `data-hl-idx` on each wrap
// span points back to the highlight's index in `highlights`.
export function applyHighlights(bodyEl, highlights) {
  if (!Array.isArray(highlights) || !highlights.length) return;
  highlights.forEach((hl, idx) => {
    if (!STYLES.has(hl.style)) return;
    const { flat, nodes } = flattenBody(bodyEl);
    const r = resolveAnchor(flat, hl);
    if (r && r.end > r.start) wrapRange(nodes, r.start, r.end, hl.style, idx, hl.note);
  });
}

// ── Host registry ─────────────────────────────────────────────────────────
// A "host" owns some highlightable bodies and knows how to read/persist/re-render
// their highlights. Chat registers one (message bubbles); the knowledge library
// registers another (doc blocks). The selection toolbar resolves a body to its
// host so the same UI drives both. A host is:
//   { resolve(bodyEl) -> ctx|null,   // does this host own bodyEl? → an id object
//     list(ctx) -> array,            // the block/message's highlights array (created if missing)
//     commit(ctx) -> void,           // persist + re-render after the array was mutated
//     scope(ctx) -> Element|null }    // container to query the rendered .hlmark spans in
const hlHosts = [];
export function registerHighlightHost(host) { hlHosts.push(host); }
export function resolveHighlightHost(bodyEl) {
  if (!bodyEl) return null;
  for (const host of hlHosts) {
    const ctx = host.resolve(bodyEl);
    if (ctx) return { host, ctx };
  }
  return null;
}

// Indices of `highlights` whose resolved range overlaps the current selection —
// used by the eraser to clear only what the user dragged over.
export function highlightsInSelection(bodyEl, range, highlights) {
  if (!Array.isArray(highlights) || !highlights.length) return [];
  const r = selectionFlatRange(bodyEl, range);
  if (!r) return [];
  const out = [];
  highlights.forEach((hl, i) => {
    const hr = resolveAnchor(r.flat, hl);
    if (hr && hr.start < r.b && r.a < hr.end) out.push(i);
  });
  return out;
}
