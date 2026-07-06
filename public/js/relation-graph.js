// Per-doc relation graph — renders a distill card's «§ 关系» section as a small
// node-link SVG diagram (entities = nodes, relations = directed labelled edges).
// Zero-dependency: a tiny Fruchterman-Reingold force layout + hand-built SVG. The card
// text stays authoritative; this just visualizes the relations already parsed from it.
import { t } from "./i18n.js";

const SVGNS = "http://www.w3.org/2000/svg";
const REL_HEAD_RE = /^\*\*\s*§?\s*(?:关系|關係|Relations)\s*\*\*/i;
const ANY_HEAD_RE = /^\*\*[^*]+\*\*/;

// `- `head` —rel(time · place)→ `tail`` → {head, rel, tail, qual}. Mirrors the server's
// parseRelationLine (names in backticks; qualifier in the trailing parens).
function parseRelationLine(line) {
  const s = line.replace(/^[-*]\s*/, "").trim();
  const ticks = [...s.matchAll(/`([^`]+)`/g)];
  if (ticks.length < 2) return null;
  const head = ticks[0][1].trim(), tail = ticks[ticks.length - 1][1].trim();
  let mid = s.slice(ticks[0].index + ticks[0][0].length, ticks[ticks.length - 1].index);
  mid = mid.replace(/^\s*[—–-]\s*/, "").replace(/\s*[→>]+\s*$/, "").trim();
  let qual = "";
  const qM = mid.match(/[（(]([^）)]+)[）)]\s*$/);
  if (qM) { qual = qM[1].trim(); mid = mid.slice(0, qM.index).trim(); }
  const rel = mid.trim();
  if (!head || !rel || !tail || head === tail) return null;   // skip self-loops
  return { head, rel, tail, qual };
}

export function parseCardRelations(card) {
  const lines = String(card || "").split("\n");
  const rels = [];
  for (let i = 0; i < lines.length; i++) {
    if (!REL_HEAD_RE.test(lines[i].trim())) continue;
    for (let j = i + 1; j < lines.length; j++) {
      const t2 = lines[j].trim();
      if (!t2 || ANY_HEAD_RE.test(t2)) break;   // blank or next section ends the list
      if (/^[-*]\s/.test(t2)) { const r = parseRelationLine(t2); if (r) rels.push(r); }
      else break;
    }
    break;
  }
  return rels;
}

// Fruchterman-Reingold with a weak gravity toward centre. The ideal edge length k is set
// LARGE (labels are ~80px wide, far wider than a node dot, so connected nodes must sit far
// apart or their labels collide) and gravity keeps the fragmented components (this graph is
// usually several short chains, not one blob) from drifting into the corners.
function layout(names, edges, W, H) {
  const n = names.length;
  const k = Math.sqrt((W * H) / n) * 0.82;   // ideal edge length (enough for label room, but compact)
  const idx = new Map(names.map((nm, i) => [nm, i]));
  const cx = W / 2, cy = H / 2;
  const p = names.map((_, i) => ({
    x: cx + Math.cos((2 * Math.PI * i) / n) * Math.min(W, H) * 0.3,
    y: cy + Math.sin((2 * Math.PI * i) / n) * Math.min(W, H) * 0.3,
  }));
  let temp = Math.min(W, H) * 0.22;
  for (let it = 0; it < 300; it++) {
    const disp = p.map(() => ({ x: 0, y: 0 }));
    for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) {
      let dx = p[a].x - p[b].x, dy = p[a].y - p[b].y; const d = Math.hypot(dx, dy) || 0.01;
      const f = (k * k) / d; const ux = dx / d * f, uy = dy / d * f;
      disp[a].x += ux; disp[a].y += uy; disp[b].x -= ux; disp[b].y -= uy;
    }
    for (const e of edges) {
      const a = idx.get(e.head), b = idx.get(e.tail); if (a == null || b == null || a === b) continue;
      let dx = p[a].x - p[b].x, dy = p[a].y - p[b].y; const d = Math.hypot(dx, dy) || 0.01;
      const f = (d * d) / k; const ux = dx / d * f, uy = dy / d * f;
      disp[a].x -= ux; disp[a].y -= uy; disp[b].x += ux; disp[b].y += uy;
    }
    for (let a = 0; a < n; a++) {
      disp[a].x += (cx - p[a].x) * 0.03; disp[a].y += (cy - p[a].y) * 0.03;   // gravity
      const d = Math.hypot(disp[a].x, disp[a].y) || 0.01;
      p[a].x += (disp[a].x / d) * Math.min(d, temp);
      p[a].y += (disp[a].y / d) * Math.min(d, temp);
      const mgX = Math.min(46, W * 0.16), mgY = Math.min(26, H * 0.14);   // edge margin ∝ box
      p[a].x = Math.max(mgX, Math.min(W - mgX, p[a].x));
      p[a].y = Math.max(mgY, Math.min(H - mgY, p[a].y));
    }
    temp *= 0.97;
  }
  return { p, idx };
}

// Connected components (undirected) via union-find — relation graphs are usually several
// disjoint chains, so laying each out on its own box and tiling them beats one big sparse
// force field (which leaves a hollow middle and crams small chains into the corners).
function componentsOf(names, edges) {
  const idx = new Map(names.map((n, i) => [n, i]));
  const parent = names.map((_, i) => i);
  const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  for (const e of edges) { const a = idx.get(e.head), b = idx.get(e.tail); if (a != null && b != null) parent[find(a)] = find(b); }
  const g = new Map();
  names.forEach((nm, i) => { const r = find(i); (g.get(r) || g.set(r, []).get(r)).push(nm); });
  return [...g.values()].sort((a, b) => b.length - a.length);
}
// Lay out each component locally, then pack the component boxes left-to-right (wrapping at
// MAXW). Returns merged absolute positions + the total canvas size.
function packedLayout(names, edges, { full = false } = {}) {
  const comps = componentsOf(names, edges);
  const pos = new Map();
  const mul = full ? 1.45 : 1;   // full-screen: a bit more intra-chain room for the bigger labels
  const GAP = full ? 18 : 12, MAXW = full ? 920 : 540;   // components packed close (compact overall)
  // approx rendered label width (px): CJK glyphs are ~font-size wide, so this over-estimates
  // Latin (fine — better too much room than a clipped label). Truncation caps the length.
  const charW = full ? 15 : 10.5, nTr = full ? 28 : 11;
  const fs = full ? 15 : 11, NR = full ? 6 : 5;
  const labelW = (nm) => charW * Math.min(nm.length, nTr);
  let x = 0, y = 0, rowH = 0, totalW = 0;
  for (const comp of comps) {
    const c = comp.length;
    let raw;   // local {x,y} per node before the fit-to-labels shift
    if (c === 2) {
      // Two-node chains get a deterministic HORIZONTAL layout whose gap is derived from the
      // two labels, so long names never collide — the force field can't guarantee that.
      const [a, b] = comp;
      const sep = labelW(a) / 2 + (full ? 30 : 18) + labelW(b) / 2;
      raw = new Map([[a, { x: 0, y: 0 }], [b, { x: sep, y: 0 }]]);
    } else {
      const bw0 = Math.round(Math.max(132, Math.min(340, Math.sqrt(c) * 104)) * mul);
      const bh0 = Math.round(Math.max(92, Math.min(250, Math.sqrt(c) * 74)) * mul);
      const cedges = edges.filter((e) => comp.includes(e.head) && comp.includes(e.tail));
      const { p, idx } = layout(comp, cedges, bw0, bh0);
      raw = new Map(comp.map((nm) => [nm, { x: p[idx.get(nm)].x, y: p[idx.get(nm)].y }]));
    }
    // Fit the box to the ACTUAL label extents (label spans nodeX ± labelW/2, and sits above
    // the node) then shift to a small padding — so NO label is ever clipped at an edge.
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const nm of comp) {
      const q = raw.get(nm), w = labelW(nm);
      minX = Math.min(minX, q.x - w / 2); maxX = Math.max(maxX, q.x + w / 2);
      minY = Math.min(minY, q.y - NR - 5 - fs); maxY = Math.max(maxY, q.y + NR);
    }
    const PAD = 9, offX = PAD - minX, offY = PAD - minY;
    const bw = Math.round(maxX - minX + PAD * 2), bh = Math.round(maxY - minY + PAD * 2);
    if (x > 0 && x + bw > MAXW) { x = 0; y += rowH + GAP; rowH = 0; }   // wrap row
    comp.forEach((nm) => { const q = raw.get(nm); pos.set(nm, { x: q.x + offX + x, y: q.y + offY + y }); });
    x += bw + GAP; rowH = Math.max(rowH, bh); totalW = Math.max(totalW, x - GAP);
  }
  return { pos, W: Math.max(300, totalW), H: y + rowH };
}

const el = (tag, attrs, text) => {
  const e = document.createElementNS(SVGNS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (text != null) e.textContent = text;
  return e;
};
const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

// Build the SVG for a set of relations. `full` = full-screen mode: bigger layout, longer
// labels, and a wider stroke class so text stays readable when the graph fills the screen.
function buildGraphSvg(rels, { full = false } = {}) {
  const names = [...new Set(rels.flatMap((r) => [r.head, r.tail]))];
  const { pos, W, H } = packedLayout(names, rels, { full });
  const P = (nm) => pos.get(nm);
  const nTrunc = full ? 28 : 11, eTrunc = full ? 30 : 18;
  const svgAttrs = { viewBox: `0 0 ${W} ${H}`, class: "relGraphSvg" + (full ? " relGraphSvgFull" : ""), preserveAspectRatio: "xMidYMid meet" };
  // Give the SVG an explicit natural pixel size so it stops enlarging past a comfortable
  // point (with only width:100% the whole viewBox — text included — scales up to fill a wide
  // pane). CSS max-width caps it for genuinely big graphs; small graphs render at 1:1 and
  // center. Full-screen gets a slightly bigger 1.3× so it fills more of the modal.
  const scale = full ? 1.3 : 1.15;
  svgAttrs.width = Math.round(W * scale);
  svgAttrs.height = Math.round(H * scale);
  const svg = el("svg", svgAttrs);
  const defs = el("defs");
  const marker = el("marker", { id: "relArrow", viewBox: "0 0 10 10", refX: "9", refY: "5", markerWidth: "7", markerHeight: "7", orient: "auto-start-reverse" });
  marker.appendChild(el("path", { d: "M0,0 L10,5 L0,10 z", class: "relArrowHead" }));
  defs.appendChild(marker); svg.appendChild(defs);
  const NR = full ? 6 : 5;   // node radius
  for (const r of rels) {   // edges first (under nodes)
    const a = P(r.head), b = P(r.tail);
    const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1;
    const ux = dx / d, uy = dy / d;
    const x1 = a.x + ux * (NR + 1), y1 = a.y + uy * (NR + 1);
    const x2 = b.x - ux * (NR + 6), y2 = b.y - uy * (NR + 6);
    const label = r.qual ? `${r.rel} (${r.qual})` : r.rel;
    const tip = `${r.head} —${label}→ ${r.tail}`;   // full triple, for the hover tooltip
    // wider transparent hit-line so the edge is easy to hover, both carrying the tooltip
    const line = el("line", { x1, y1, x2, y2, class: "relEdge", "marker-end": "url(#relArrow)" });
    line.appendChild(el("title", {}, tip));
    svg.appendChild(line);
    const hit = el("line", { x1, y1, x2, y2, class: "relEdgeHit" });
    hit.appendChild(el("title", {}, tip));
    svg.appendChild(hit);
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    const tx = el("text", { x: mx, y: my - 2, class: "relEdgeLabel", "text-anchor": "middle" }, trunc(label, eTrunc));
    tx.setAttribute("paint-order", "stroke");   // halo for legibility over edges
    tx.appendChild(el("title", {}, tip));   // tooltip on the relation text (esp. when truncated)
    svg.appendChild(tx);
  }
  for (const nm of names) {   // nodes
    const q = P(nm);
    svg.appendChild(el("circle", { cx: q.x, cy: q.y, r: NR, class: "relNode" }));
    const label = el("text", { x: q.x, y: q.y - NR - 5, class: "relNodeLabel", "text-anchor": "middle" }, trunc(nm, nTrunc));
    label.setAttribute("paint-order", "stroke");
    label.appendChild(el("title", {}, nm));
    svg.appendChild(label);
  }
  return svg;
}

// Full-screen modal: the graph fills the width at a readable size (so it's genuinely
// enlarged, not shrunk to fit) and the box scrolls if it's taller than the viewport. A
// semi-transparent ⌄ hint appears whenever more graph is hidden below the fold, and hides
// once you reach the bottom. Backdrop click / × / Esc close it.
function openGraphModal(rels) {
  const overlay = document.createElement("div"); overlay.className = "relGraphModal";
  const inner = document.createElement("div"); inner.className = "relGraphModalInner";
  const close = document.createElement("button"); close.type = "button"; close.className = "relGraphModalClose";
  close.setAttribute("aria-label", "×"); close.textContent = "×";
  const scroll = document.createElement("div"); scroll.className = "relGraphModalScroll";
  scroll.appendChild(buildGraphSvg(rels, { full: true }));
  const hint = document.createElement("div"); hint.className = "relGraphScrollHint"; hint.textContent = "⌄"; hint.hidden = true;
  hint.title = t("relGraphMore");
  const updateHint = () => { hint.hidden = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 8; };
  hint.addEventListener("click", () => scroll.scrollBy({ top: Math.round(scroll.clientHeight * 0.8), behavior: "smooth" }));
  scroll.addEventListener("scroll", updateHint);
  const shut = () => { overlay.remove(); document.removeEventListener("keydown", onKey); window.removeEventListener("resize", updateHint); };
  const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); shut(); } };
  close.addEventListener("click", shut);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) shut(); });
  document.addEventListener("keydown", onKey);
  window.addEventListener("resize", updateHint);
  inner.append(close, scroll, hint);
  overlay.appendChild(inner);
  document.body.appendChild(overlay);
  requestAnimationFrame(updateHint);   // after layout settles, decide if the hint is needed
}

// The card's relation graph as a collapsible <details>. `open` = initial state. Double-click
// the graph to blow it up to a full-screen modal (the inline version is small by design).
export function renderRelationGraph(cardContent, { open = true } = {}) {
  const rels = parseCardRelations(cardContent);
  if (!rels.length) return null;
  const box = document.createElement("details");
  box.className = "relGraph";
  if (open) box.open = true;
  const sum = document.createElement("summary");
  sum.className = "relGraphSummary";
  sum.textContent = `🕸 ${t("relGraphTitle")} (${rels.length}) · ${t("relGraphZoomHint")}`;
  box.appendChild(sum);
  const stage = document.createElement("div");
  stage.className = "relGraphStage";
  stage.appendChild(buildGraphSvg(rels, { full: false }));
  stage.addEventListener("dblclick", (e) => { e.preventDefault(); openGraphModal(rels); });
  box.appendChild(stage);
  return box;
}
