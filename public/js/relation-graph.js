// Per-doc relation graph — renders a distill card's «§ 关系» section as a small
// node-link SVG diagram (entities = nodes, relations = directed labelled edges).
// Zero-dependency: a tiny Fruchterman-Reingold force layout + hand-built SVG. The card
// text stays authoritative; this just visualizes the relations already parsed from it.
import { t } from "./i18n.js";

const SVGNS = "http://www.w3.org/2000/svg";
const KIND_ICON = { paper: "📄", slides: "📊", blog: "🌐", video: "📺", doc: "📝", chat: "💬", other: "📎" };
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

// Radial layout for the entity NEIGHBORHOOD (one/few centers + many neighbors). A force field
// turns that star into an unreadable hairball, so instead: center(s) in the middle, neighbors
// evenly spaced on a ring. Labels sit OUTSIDE their node, anchored away from the hub (right
// half → start, left half → end) so they radiate outward and never cross the center. Ring
// radius is set so consecutive nodes are at least one line-height apart (no vertical overlap).
function radialLayout(names, rels, centerSet, spread = 1) {
  const fs = 15, charW = 15, nTr = 22;
  const labelW = (nm) => charW * Math.min(nm.length, nTr);
  const centers = names.filter((n) => centerSet.has(n));
  const leaves = names.filter((n) => !centerSet.has(n));
  const N = Math.max(1, leaves.length);
  const lineH = fs + 9;
  const R = Math.max(200, (N * lineH) / (2 * Math.PI)) * spread;   // ring radius × zoom (spacing only)
  const maxLabel = Math.max(60, ...names.map(labelW));
  const margin = maxLabel + 34;
  const cx = R + margin, cy = R + margin;
  const pos = new Map();
  if (centers.length <= 1) { pos.set(centers[0] || leaves[0], { x: cx, y: cy }); }
  else centers.forEach((nm, i) => {          // multiple seeds → small inner cluster
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / centers.length, r = Math.min(80, 30 + centers.length * 12);
    pos.set(nm, { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
  });
  leaves.forEach((nm, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / N;
    pos.set(nm, { x: cx + Math.cos(a) * R, y: cy + Math.sin(a) * R });
  });
  return { pos, W: Math.round(cx * 2), H: Math.round(cy * 2), cx, cy };
}

// Distinct, white-background-legible hues — one per center (seed) in a multi-entity view.
const CENTER_PALETTE = ["#0d9488", "#e07b00", "#7c3aed", "#c026a3", "#2563eb", "#dc2626"];
// centers → Map(name → color), assigned in center order (stable, so legend matches the graph).
function centerColorMap(centers) {
  const m = new Map();
  centers.forEach((c, i) => m.set(c, CENTER_PALETTE[i % CENTER_PALETTE.length]));
  return m;
}
// For each non-center node, WHICH centers it links to (via any edge). size 1 = exclusive to one
// center, size >=2 = shared (the intersection — the whole point of selecting several entities).
function membershipOf(names, rels, centers) {
  const cset = new Set(centers), memb = new Map();
  for (const nm of names) if (!cset.has(nm)) memb.set(nm, new Set());
  for (const r of rels) {
    if (cset.has(r.head) && memb.has(r.tail)) memb.get(r.tail).add(r.head);
    if (cset.has(r.tail) && memb.has(r.head)) memb.get(r.head).add(r.tail);
  }
  return memb;
}
// Largest number of centers any single neighbor links to (>=2 means there's an intersection).
function membershipMax(rels, centers) {
  const names = [...new Set(rels.flatMap((r) => [r.head, r.tail]))];
  let mx = 0;
  for (const s of membershipOf(names, rels, centers).values()) mx = Math.max(mx, s.size);
  return mx;
}
// Multi-center radial: each center owns an angular SECTOR (its exclusive neighbors fan out inside
// it, and the center dot is nudged toward that sector so its edges don't cross the whole graph);
// SHARED neighbors sit on an inner ring in the middle. Returns positions + the shared set.
function multiRadialLayout(names, rels, centers, memb, spread = 1) {
  const fs = 15, charW = 15, nTr = 22, lineH = fs + 9;
  const labelW = (nm) => charW * Math.min(nm.length, nTr);
  const N = centers.length;
  const exclusive = new Map(centers.map((c) => [c, []]));
  const shared = [];
  for (const [leaf, set] of memb) {
    if (set.size >= 2) shared.push(leaf);
    else if (set.size === 1) exclusive.get([...set][0]).push(leaf);
    else exclusive.get(centers[0]).push(leaf);   // orphan (only leaf-leaf links) → first sector
  }
  const gap = 0.16;                              // radians of blank between adjacent sectors
  const sectorW = (2 * Math.PI) / N - gap;
  let outerR = 210;
  for (const c of centers) { const k = exclusive.get(c).length; if (k > 1) outerR = Math.max(outerR, (k * lineH) / sectorW); }
  const innerR = Math.max(120, outerR * 0.42) * spread;   // shared ring × zoom (spacing only)
  const centersR = Math.min(Math.max(120, outerR * 0.42) * 0.55, 100) * spread;
  outerR *= spread;
  const maxLabel = Math.max(60, ...names.map(labelW));
  const margin = maxLabel + 34, cx = outerR + margin, cy = outerR + margin;
  const pos = new Map();
  centers.forEach((c, ci) => {
    const theta = -Math.PI / 2 + (ci * 2 * Math.PI) / N;
    pos.set(c, { x: cx + Math.cos(theta) * centersR, y: cy + Math.sin(theta) * centersR });
    const list = exclusive.get(c), k = list.length;
    list.forEach((leaf, i) => {
      const a = k === 1 ? theta : theta - sectorW / 2 + (i / (k - 1)) * sectorW;
      pos.set(leaf, { x: cx + Math.cos(a) * outerR, y: cy + Math.sin(a) * outerR });
    });
  });
  shared.forEach((leaf, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / Math.max(1, shared.length);
    pos.set(leaf, { x: cx + Math.cos(a) * innerR, y: cy + Math.sin(a) * innerR });
  });
  return { pos, W: Math.round(cx * 2), H: Math.round(cy * 2), cx, cy, shared: new Set(shared) };
}

const el = (tag, attrs, text) => {
  const e = document.createElementNS(SVGNS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (text != null) e.textContent = text;
  return e;
};
const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
let svgSeq = 0;   // per-svg id prefix so multiple graphs' arrow markers never collide

// Build the SVG for a set of relations. `full` = full-screen mode: bigger layout, longer
// labels, and a wider stroke class so text stays readable when the graph fills the screen.
function buildGraphSvg(rels, { full = false, center = "", onNodeClick = null, radial = false, filter = null, spread = 1, docTitle = null, draggable = false } = {}) {
  const centerSet = center instanceof Set ? center : new Set(center ? [center] : []);
  const names = [...new Set(rels.flatMap((r) => [r.head, r.tail]))];
  // Multi-center (>=2 seeds): sectors + per-center colors + a shared inner ring, so you can tell
  // whose neighbor is whose and see the intersection. One center → the plain radial hub.
  const centersArr = names.filter((n) => centerSet.has(n));
  const colored = radial && centersArr.length >= 1;   // colour by center — even a single one (green)
  const sectors = radial && centersArr.length >= 2;    // sector layout only when there are several
  const colorOfCenter = colored ? centerColorMap(centersArr) : null;
  const memb = colored ? membershipOf(names, rels, centersArr) : null;
  const lay = sectors ? multiRadialLayout(names, rels, centersArr, memb, spread)
    : radial ? radialLayout(names, rels, centerSet, spread) : packedLayout(names, rels, { full });
  const { pos, W, H } = lay;
  const cx = lay.cx;   // radial: hub x — labels flip side across it
  const sharedSet = (sectors && lay.shared) || new Set();
  // A node's color: center → its own hue; a leaf exclusive to one center → that hue; shared/other → none.
  const nodeColor = (nm) => {
    if (!colored) return null;
    if (colorOfCenter.has(nm)) return colorOfCenter.get(nm);
    const s = memb.get(nm);
    return s && s.size === 1 ? colorOfCenter.get([...s][0]) : null;
  };
  // An edge takes the colour of whichever endpoint is a center (leaf-leaf edges stay neutral).
  const edgeColor = (r) => {
    if (!colored) return null;
    if (colorOfCenter.has(r.head)) return colorOfCenter.get(r.head);
    if (colorOfCenter.has(r.tail)) return colorOfCenter.get(r.tail);
    return null;
  };
  // Legend toggles: hide whole categories. A node is hidden if it's a hidden center, a hidden
  // shared node, or a leaf whose every owning center is hidden. An edge hides with its type
  // toggle or with either endpoint. Filter is {rel,cooc,shared,hiddenCenters:Set}.
  const f = filter || {};
  const hiddenCenters = f.hiddenCenters || new Set();
  const nodeVisible = (nm) => {
    if (centerSet.has(nm)) return !hiddenCenters.has(nm);
    if (sharedSet.has(nm)) return f.shared !== false;
    const s = memb && memb.get(nm);
    if (s && s.size) { for (const c of s) if (!hiddenCenters.has(c)) return true; return false; }
    return true;
  };
  const edgeVisible = (r) => {
    if (r.cooc && f.cooc === false) return false;
    if (!r.cooc && f.rel === false) return false;
    return nodeVisible(r.head) && nodeVisible(r.tail);
  };
  const P = (nm) => pos.get(nm);
  const nTrunc = radial ? 22 : full ? 28 : 11, eTrunc = full ? 30 : 18;
  const svgAttrs = { viewBox: `0 0 ${W} ${H}`, class: "relGraphSvg" + (full ? " relGraphSvgFull" : "") + (radial ? " relGraphSvgRadial" : ""), preserveAspectRatio: "xMidYMid meet" };
  // Give the SVG an explicit natural pixel size so it stops enlarging past a comfortable
  // point (with only width:100% the whole viewBox — text included — scales up to fill a wide
  // pane). CSS max-width caps it for genuinely big graphs; small graphs render at 1:1 and
  // center. Full-screen gets a slightly bigger 1.3×; radial is already large → 1×.
  const scale = radial ? 1 : full ? 1.3 : 1.15;
  svgAttrs.width = Math.round(W * scale);
  svgAttrs.height = Math.round(H * scale);
  const svg = el("svg", svgAttrs);
  const defs = el("defs"); svg.appendChild(defs);
  // Per-colour arrow markers. An SVG marker can't reliably inherit its line's stroke
  // (context-stroke isn't supported in every browser — it renders black where it isn't),
  // so mint ONE marker per distinct edge colour and point each edge at the matching one.
  // Marker ids are prefixed per-svg so multiple graphs on the page never collide.
  const gid = "rg" + (++svgSeq);
  // Default (uncoloured) edge colour — matches the CSS (.relEdge → var(--muted)) so a
  // default arrow matches its darkened edge. Coloured edges pass their own ec below.
  const defaultArrowColor = (getComputedStyle(document.documentElement).getPropertyValue("--muted") || "#8a8f98").trim();
  const arrowMarkers = new Map();   // colour string → marker id
  function markerFor(color) {
    if (arrowMarkers.has(color)) return arrowMarkers.get(color);
    const mid = `${gid}a${arrowMarkers.size}`;
    const mk = el("marker", { id: mid, viewBox: "0 0 10 10", refX: "9", refY: "5", markerWidth: "4", markerHeight: "4", orient: "auto-start-reverse" });
    mk.appendChild(el("path", { d: "M0,0 L10,5 L0,10 z", class: "relArrowHead", fill: color }));
    defs.appendChild(mk); arrowMarkers.set(color, mid);
    return mid;
  }
  const NR = full ? 6 : 5;   // node radius
  // Geometry shared by the initial render AND node dragging: edge endpoints trimmed to the
  // node radius (extra room on the arrow side), so a dragged node's edges re-trim identically.
  const edgeGeom = (r) => {
    const a = P(r.head), b = P(r.tail);
    const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1;
    const ux = dx / d, uy = dy / d;
    return { x1: a.x + ux * (NR + 1), y1: a.y + uy * (NR + 1), x2: b.x - ux * (NR + 6), y2: b.y - uy * (NR + 6), ux, uy };
  };
  // Label placement, reused on drag. Radial leaves anchor away from the hub; others sit above.
  const placeNodeLabel = (nm, label, isCenter) => {
    const q = P(nm);
    if (radial && !isCenter) {
      const right = q.x >= cx;
      label.setAttribute("x", right ? q.x + NR + 6 : q.x - NR - 6);
      label.setAttribute("y", q.y + 5);
      label.setAttribute("text-anchor", right ? "start" : "end");
    } else {
      label.setAttribute("x", q.x);
      label.setAttribute("y", q.y - (isCenter ? NR + 3 : NR) - 5);
      label.setAttribute("text-anchor", "middle");
    }
  };
  const nodeEls = new Map();   // name → {circle, hit, label, isCenter} (for drag repositioning)
  const edgeEls = [];          // {r, line, hit, labelEl, yearEl}
  let suppressClick = false;   // a drag ends with a stray click — swallow it (don't recenter)
  for (const r of rels) {   // edges first (under nodes)
    if (!edgeVisible(r)) continue;   // legend toggle hid this edge's category
    const { x1, y1, x2, y2, ux, uy } = edgeGeom(r);
    const yr = r.time ? String(r.time).slice(0, 4) : "";   // timeline layer: year on timed relations
    const label = r.qual ? `${r.rel} (${r.qual})` : (r.time ? `${r.rel} (${r.time})` : r.rel);
    // co-occurrence edges are undirected (no arrow, dashed) — "share a document", not a relation
    let tip = r.cooc ? `${r.head} ⟷ ${r.tail}${label ? ` · ${label}` : ""}` : `${r.head} —${label}→ ${r.tail}`;
    if (docTitle && r.docIds && r.docIds.length) {   // which document(s) this edge comes from
      const titles = r.docIds.map((id) => docTitle.get(id)).filter(Boolean);
      if (titles.length) tip += `\n${t("relGraphFrom")}: ${titles.slice(0, 4).join(" · ")}${r.docIds.length > 4 ? " …" : ""}`;
    }
    // wider transparent hit-line so the edge is easy to hover, both carrying the tooltip
    const ec = edgeColor(r);   // per-center colour (null = default grey edge)
    const lineAttrs = { x1, y1, x2, y2, class: "relEdge" + (r.cooc ? " relEdgeCooc" : "") + (ec ? "" : " relEdgeDim") };
    if (!r.cooc) lineAttrs["marker-end"] = `url(#${markerFor(ec || defaultArrowColor)})`;   // arrow matches the edge colour
    const line = el("line", lineAttrs);
    if (ec) line.style.stroke = ec;   // inline style (beats the CSS stroke) — colour by center
    line.appendChild(el("title", {}, tip));
    svg.appendChild(line);
    const hit = el("line", { x1, y1, x2, y2, class: "relEdgeHit" });
    hit.appendChild(el("title", {}, tip));
    svg.appendChild(hit);
    // Radial (neighborhood): NO edge labels — a hub has dozens of edges and their labels pile
    // into an unreadable mush at the center. The relation is in the hover tooltip instead.
    let labelEl = null, yearEl = null;
    if (!radial) {
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
      const tx = el("text", { x: mx, y: my - 2, class: "relEdgeLabel", "text-anchor": "middle" }, trunc(label, eTrunc));
      tx.setAttribute("paint-order", "stroke");   // halo for legibility over edges
      tx.appendChild(el("title", {}, tip));   // tooltip on the relation text (esp. when truncated)
      svg.appendChild(tx);
      labelEl = tx;
    } else if (yr && f.years !== false) {
      // Radial: full relation labels would mush, but a bare 4-digit YEAR is short + sparse. Place
      // it at the edge MIDPOINT, nudged PERPENDICULAR to the line so it sits beside the spoke —
      // clear of the arrowhead (at the leaf end) and off the line itself.
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2, px = -uy, py = ux;
      const yx = mx + px * 9, yy = my + py * 9;
      const yt = el("text", { x: yx, y: yy, class: "relEdgeYear", "text-anchor": "middle", "dominant-baseline": "middle" }, yr);
      yt.setAttribute("paint-order", "stroke");
      if (ec) yt.style.fill = ec;
      yt.appendChild(el("title", {}, tip));
      svg.appendChild(yt);
      yearEl = yt;
    }
    edgeEls.push({ r, line, hit, labelEl, yearEl });
  }
  for (const nm of names) {   // nodes
    if (!nodeVisible(nm)) continue;   // legend toggle hid this node's category
    const q = P(nm);
    const isCenter = centerSet.has(nm);   // neighborhood view: highlight the focus entity/entities
    const isShared = sharedSet.has(nm);   // multi-center: belongs to >=2 centers (the intersection)
    const clk = onNodeClick ? " relNodeClickable" : "";
    const circle = el("circle", { cx: q.x, cy: q.y, r: isCenter ? NR + 3 : isShared ? NR + 2 : NR, class: "relNode" + (isCenter ? " relNodeCenter" : "") + (isShared ? " relNodeShared" : "") + clk });
    const col = nodeColor(nm);   // multi-center: tint the node by its owning center (inline style beats CSS)
    if (col && !isShared) { circle.style.fill = col; if (isCenter) circle.style.stroke = col; }
    // Radial: label sits to the SIDE (out from the hub) and is anchored away from center, so
    // labels radiate outward without crossing the hub. Non-radial: label sits above the node.
    const label = el("text", { class: "relNodeLabel" + (isCenter ? " relNodeLabelCenter" : "") + clk }, trunc(nm, nTrunc));
    placeNodeLabel(nm, label, isCenter);
    label.setAttribute("paint-order", "stroke");
    if (col && isCenter) label.style.fill = col;   // center label in its own hue (inline beats CSS)
    const tipText = nm
      + (onNodeClick ? `\n${t("relGraphRecenter")}` : "")
      + (draggable ? `\n${t("relGraphDragHint")}` : "");
    circle.appendChild(el("title", {}, tipText));
    label.appendChild(el("title", {}, tipText));
    let hit = null;
    if (onNodeClick || draggable) {
      // generous invisible hit-target so small nodes are easy to click / grab
      hit = el("circle", { cx: q.x, cy: q.y, r: NR + 10, class: "relNodeHit" });
      hit.appendChild(el("title", {}, tipText));
      svg.appendChild(hit);
    }
    if (onNodeClick) {
      const go = (e) => { e.stopPropagation(); if (!suppressClick) onNodeClick(nm); };
      hit.addEventListener("click", go); circle.addEventListener("click", go); label.addEventListener("click", go);
    }
    svg.appendChild(circle);
    svg.appendChild(label);
    nodeEls.set(nm, { circle, hit, label, isCenter });
  }
  // Interactive mode (full-screen modal): drag a node to reposition it — the node, its label,
  // its hit-target, and every connected edge (line + relation/year label) follow live, so the
  // user can manually pull apart labels the automatic layout left overlapping.
  if (draggable) {
    const svgPoint = (e) => {   // client px → viewBox coords (independent of CSS scaling)
      const pt = svg.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY;
      const m = svg.getScreenCTM();
      return m ? pt.matrixTransform(m.inverse()) : pt;
    };
    const moveNode = (nm) => {
      const n = nodeEls.get(nm); if (!n) return;
      const q = P(nm);
      n.circle.setAttribute("cx", q.x); n.circle.setAttribute("cy", q.y);
      if (n.hit) { n.hit.setAttribute("cx", q.x); n.hit.setAttribute("cy", q.y); }
      placeNodeLabel(nm, n.label, n.isCenter);
      for (const em of edgeEls) {
        if (em.r.head !== nm && em.r.tail !== nm) continue;
        const g = edgeGeom(em.r);
        for (const ln of [em.line, em.hit]) {
          ln.setAttribute("x1", g.x1); ln.setAttribute("y1", g.y1);
          ln.setAttribute("x2", g.x2); ln.setAttribute("y2", g.y2);
        }
        const mx = (g.x1 + g.x2) / 2, my = (g.y1 + g.y2) / 2;
        if (em.labelEl) { em.labelEl.setAttribute("x", mx); em.labelEl.setAttribute("y", my - 2); }
        if (em.yearEl) { em.yearEl.setAttribute("x", mx - g.uy * 9); em.yearEl.setAttribute("y", my + g.ux * 9); }
      }
    };
    let drag = null;   // {name, offX, offY, sx, sy, moved}
    for (const [nm, n] of nodeEls) {
      const down = (e) => {
        if (e.button !== 0) return;
        const p = svgPoint(e), q = P(nm);
        drag = { name: nm, offX: q.x - p.x, offY: q.y - p.y, sx: e.clientX, sy: e.clientY, moved: false };
        e.preventDefault();
        try { e.target.setPointerCapture(e.pointerId); } catch { /* older engines */ }
      };
      for (const eln of [n.circle, n.label, n.hit]) if (eln) eln.addEventListener("pointerdown", down);
    }
    svg.addEventListener("pointermove", (e) => {
      if (!drag) return;
      if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 3) return;   // a click, not a drag
      drag.moved = true;
      svg.classList.add("isNodeDrag");
      const p = svgPoint(e);
      pos.set(drag.name, {
        x: Math.max(4, Math.min(W - 4, p.x + drag.offX)),
        y: Math.max(4, Math.min(H - 4, p.y + drag.offY)),
      });
      moveNode(drag.name);
    });
    const up = () => {
      if (!drag) return;
      if (drag.moved) { suppressClick = true; setTimeout(() => { suppressClick = false; }, 0); }   // eat the trailing click
      drag = null;
      svg.classList.remove("isNodeDrag");
    };
    svg.addEventListener("pointerup", up);
    svg.addEventListener("pointercancel", up);
  }
  return svg;
}

// Full-screen modal: the graph fills the width at a readable size (so it's genuinely
// enlarged, not shrunk to fit) and the box scrolls if it's taller than the viewport. A
// semi-transparent ⌄ hint appears whenever more graph is hidden below the fold, and hides
// once you reach the bottom. Backdrop click / × / Esc close it.
function openGraphModal(rels, { title = "", center = "", onNodeClick = null, radial = false, onBack = null, onForward = null, onOpenDoc = null, onTimeline = null } = {}) {
  const overlay = document.createElement("div"); overlay.className = "relGraphModal";
  const inner = document.createElement("div"); inner.className = "relGraphModalInner";
  const close = document.createElement("button"); close.type = "button"; close.className = "relGraphModalClose";
  close.setAttribute("aria-label", "×"); close.textContent = "×";
  const titleEl = (title || onNodeClick) ? document.createElement("div") : null;
  if (titleEl) { titleEl.className = "relGraphModalTitle"; titleEl.textContent = title; }
  // Top-left control bar: back/forward history (‹ ›) + zoom (+ − ⌂). Zoom controls exist for
  // any radial neighborhood; the history arrows only when recenter navigation is wired up.
  let navEl = null, backBtn = null, fwdBtn = null;
  const mkBtn = (txt, title) => { const b = document.createElement("button"); b.type = "button"; b.className = "relGraphNavBtn"; b.textContent = txt; b.title = title; return b; };
  if (radial || onBack || onForward) {
    navEl = document.createElement("div"); navEl.className = "relGraphNav";
    if (onBack || onForward) {
      backBtn = mkBtn("‹", t("relGraphBack")); backBtn.disabled = true;
      fwdBtn = mkBtn("›", t("relGraphForward")); fwdBtn.disabled = true;
      backBtn.addEventListener("click", () => onBack && onBack());
      fwdBtn.addEventListener("click", () => onForward && onForward());
      navEl.append(backBtn, fwdBtn);
    }
    if (radial) {
      const zin = mkBtn("+", t("relGraphZoomIn")), zout = mkBtn("−", t("relGraphZoomOut")), zres = mkBtn("⌂", t("relGraphZoomReset"));
      zin.addEventListener("click", () => { spread = Math.min(4, spread * 1.2); draw(true); });
      zout.addEventListener("click", () => { spread = Math.max(0.4, spread * 0.83); draw(true); });
      zres.addEventListener("click", () => { spread = 1; draw(true); });
      navEl.append(zin, zout, zres);
    }
    if (onTimeline) {   // jump to a timeline scoped to the entities currently in view (B → C)
      const tl = mkBtn("⏱", t("relGraphTimeline")); tl.classList.add("relGraphNavTimeline");
      tl.addEventListener("click", () => onTimeline());
      navEl.append(tl);
    }
  }
  const scroll = document.createElement("div"); scroll.className = "relGraphModalScroll" + (radial ? " isRadial" : "");
  const legend = radial ? document.createElement("div") : null;
  if (legend) { legend.className = "relGraphLegend"; legend.title = t("relGraphLegendHint"); }
  // Source-documents panel (bottom-left): which docs this neighborhood is drawn from; click to open.
  const docsEl = (radial && onOpenDoc) ? document.createElement("div") : null;
  if (docsEl) docsEl.className = "relGraphDocs";
  // Floating ⌄ "more below" hint — only for the non-radial per-doc modal; the radial neighborhood
  // has real scrollbars (+ drag-pan), so the hint is redundant there.
  const hint = radial ? null : document.createElement("div");
  if (hint) { hint.className = "relGraphScrollHint"; hint.textContent = "⌄"; hint.hidden = true; hint.title = t("relGraphMore"); }
  const updateHint = () => { if (hint) hint.hidden = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 8; };

  // Per-modal state that survives recenters/zooms.
  const filter = { rel: true, cooc: true, shared: true, years: true, hiddenCenters: new Set() };
  let spread = 1;
  let curRels = rels, curCenter = center, curOnClick = onNodeClick, curDocTitle = null;

  const centerScroll = () => { if (!radial) return; scroll.scrollLeft = Math.max(0, (scroll.scrollWidth - scroll.clientWidth) / 2); scroll.scrollTop = Math.max(0, (scroll.scrollHeight - scroll.clientHeight) / 2); };
  const csetOf = () => (curCenter instanceof Set ? curCenter : new Set(curCenter ? [curCenter] : []));

  // Legend rows are TOGGLES: click one to hide/show that category. Rebuilt each draw so the
  // dim (off) state and the per-center colour chips stay in sync with the current graph.
  const renderLegend = () => {
    if (!legend) return;
    legend.innerHTML = "";
    const lineSwatch = (dashed) => {
      const s = el("svg", { viewBox: "0 0 26 8", class: "relGraphLegendSwatch" });
      const mk = el("marker", { id: "relArrowLegend", viewBox: "0 0 10 10", refX: "9", refY: "5", markerWidth: "4", markerHeight: "4", orient: "auto-start-reverse" });
      const legLineColor = (getComputedStyle(document.documentElement).getPropertyValue("--muted") || "#8a8f98").trim();
      mk.appendChild(el("path", { d: "M0,0 L10,5 L0,10 z", class: "relArrowHead", fill: legLineColor }));
      const defs = el("defs"); defs.appendChild(mk); s.appendChild(defs);
      const ln = el("line", { x1: 1, y1: 4, x2: dashed ? 25 : 19, y2: 4, class: "relEdge" + (dashed ? " relEdgeCooc" : "") });
      if (!dashed) ln.setAttribute("marker-end", "url(#relArrowLegend)");
      s.appendChild(ln); return s;
    };
    const dotSwatch = (color, ring) => {
      const s = el("svg", { viewBox: "0 0 14 14", class: "relGraphLegendSwatch" });
      const cir = el("circle", { cx: 7, cy: 7, r: 5, class: "relNode" + (ring ? " relNodeShared" : "") });
      if (color) cir.style.fill = color;
      s.appendChild(cir); return s;
    };
    const yearSwatch = () => { const s = el("svg", { viewBox: "0 0 26 10", class: "relGraphLegendSwatch" }); s.appendChild(el("text", { x: 13, y: 8, class: "relEdgeYear", "text-anchor": "middle" }, "1905")); return s; };
    const row = (swatch, label, off, toggle) => {
      const r = document.createElement("div"); r.className = "relGraphLegendRow" + (off ? " isOff" : "");
      r.append(swatch, Object.assign(document.createElement("span"), { textContent: label }));
      r.addEventListener("click", () => { toggle(); draw(false); });
      return r;
    };
    legend.append(
      row(lineSwatch(false), t("relGraphLegendRel"), !filter.rel, () => { filter.rel = !filter.rel; }),
      row(lineSwatch(true), t("relGraphLegendCooc"), !filter.cooc, () => { filter.cooc = !filter.cooc; }),
    );
    if (curRels.some((r) => r.time)) legend.append(row(yearSwatch(), t("relGraphLegendYears"), !filter.years, () => { filter.years = !filter.years; }));
    const centersArr = [...new Set(curRels.flatMap((r) => [r.head, r.tail]))].filter((n) => csetOf().has(n));
    if (centersArr.length >= 2) {
      const cc = centerColorMap(centersArr);
      for (const c of centersArr) legend.append(row(dotSwatch(cc.get(c), false), c, filter.hiddenCenters.has(c), () => { filter.hiddenCenters.has(c) ? filter.hiddenCenters.delete(c) : filter.hiddenCenters.add(c); }));
      if (membershipMax(curRels, centersArr) >= 2) legend.append(row(dotSwatch(null, true), t("relGraphLegendShared"), !filter.shared, () => { filter.shared = !filter.shared; }));
    }
  };
  const renderDocs = (docs) => {
    if (!docsEl) return;
    docsEl.innerHTML = "";
    if (!docs || !docs.length) { docsEl.hidden = true; return; }
    docsEl.hidden = false; docsEl.classList.remove("isCollapsed");
    const h = document.createElement("div"); h.className = "relGraphDocsHead";
    h.appendChild(Object.assign(document.createElement("span"), { textContent: t("relGraphDocs", { n: docs.length }) }));
    const toggle = document.createElement("button"); toggle.type = "button"; toggle.className = "relGraphDocsToggle"; toggle.textContent = "×"; toggle.title = t("relGraphDocsCollapse");
    toggle.addEventListener("click", () => { const c = docsEl.classList.toggle("isCollapsed"); toggle.textContent = c ? "▼" : "×"; toggle.title = c ? t("relGraphDocsExpand") : t("relGraphDocsCollapse"); });
    h.appendChild(toggle);
    docsEl.appendChild(h);
    const list = document.createElement("div"); list.className = "relGraphDocsList";
    for (const d of docs) {
      const b = document.createElement("button"); b.type = "button"; b.className = "relGraphDocRow"; b.title = t("relGraphOpenDoc");
      b.textContent = `${KIND_ICON[d.docKind] || "📄"} ${d.title}`;
      b.addEventListener("click", () => { onOpenDoc(d.docId); shut(); });
      list.appendChild(b);
    }
    docsEl.appendChild(list);
  };
  // recenter=true keeps the hub centered (initial / recenter / zoom); a legend toggle passes
  // false so it doesn't yank the view back while you're panning.
  const draw = (recenter = false) => {
    scroll.innerHTML = "";
    scroll.appendChild(buildGraphSvg(curRels, { full: true, radial, spread, filter, docTitle: curDocTitle, center: curCenter, onNodeClick: curOnClick, draggable: true }));
    renderLegend();
    requestAnimationFrame(() => { updateHint(); if (recenter) centerScroll(); });
  };
  // Recenter / initial: reset zoom + filters (new center set), then draw + center.
  const render = (rels2, opts = {}) => {
    curRels = rels2;
    if (opts.center !== undefined) curCenter = opts.center;
    if (opts.onNodeClick !== undefined) curOnClick = opts.onNodeClick;
    if (opts.docTitle !== undefined) curDocTitle = opts.docTitle;
    if (titleEl && opts.title != null) titleEl.textContent = opts.title;
    if (opts.docs !== undefined) renderDocs(opts.docs);
    spread = 1; filter.rel = filter.cooc = filter.shared = filter.years = true; filter.hiddenCenters.clear();
    draw(true);
  };
  render(rels, { title, center, onNodeClick, docTitle: null, docs: null });
  // Scroll wheel = ZOOM by changing entity SPACING (font stays constant); re-layout, re-center.
  if (radial) scroll.addEventListener("wheel", (e) => {
    e.preventDefault();
    spread = Math.min(4, Math.max(0.4, spread * (e.deltaY < 0 ? 1.12 : 0.89)));
    draw(true);
  }, { passive: false });
  // Drag the empty background to pan (grab cursor). Node hits keep their own click/drag.
  let panning = false, panSX = 0, panSY = 0, panSL = 0, panST = 0;
  const onPanDown = (e) => {
    if (!radial || e.button !== 0) return;
    const cl = e.target.classList;
    if (cl && (cl.contains("relNodeHit") || cl.contains("relNodeClickable") || cl.contains("relNode") || cl.contains("relNodeLabel"))) return;   // node drag, not pan
    panning = true; panSX = e.clientX; panSY = e.clientY; panSL = scroll.scrollLeft; panST = scroll.scrollTop;
    scroll.classList.add("isPanning");
  };
  const onPanMove = (e) => { if (!panning) return; scroll.scrollLeft = panSL - (e.clientX - panSX); scroll.scrollTop = panST - (e.clientY - panSY); };
  const onPanUp = () => { if (panning) { panning = false; scroll.classList.remove("isPanning"); } };
  if (radial) { scroll.addEventListener("mousedown", onPanDown); window.addEventListener("mousemove", onPanMove); window.addEventListener("mouseup", onPanUp); }
  if (hint) hint.addEventListener("click", () => scroll.scrollBy({ top: Math.round(scroll.clientHeight * 0.8), behavior: "smooth" }));
  scroll.addEventListener("scroll", updateHint);
  const shut = () => { overlay.remove(); document.removeEventListener("keydown", onKey); window.removeEventListener("resize", updateHint); window.removeEventListener("mousemove", onPanMove); window.removeEventListener("mouseup", onPanUp); };
  const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); shut(); } };
  close.addEventListener("click", shut);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) shut(); });
  document.addEventListener("keydown", onKey);
  window.addEventListener("resize", updateHint);
  inner.append(close, ...(navEl ? [navEl] : []), ...(titleEl ? [titleEl] : []), ...(legend ? [legend] : []), ...(docsEl ? [docsEl] : []), scroll, ...(hint ? [hint] : []));
  overlay.appendChild(inner);
  document.body.appendChild(overlay);
  requestAnimationFrame(updateHint);
  const setNav = (canBack, canFwd) => { if (backBtn) backBtn.disabled = !canBack; if (fwdBtn) fwdBtn.disabled = !canFwd; };
  return { render, shut, setNav };
}

// Public entry for the cross-doc entity neighborhood (star map). `data` = the neighborhood
// payload ({edges,center,centers}); `title(data)` builds the header; `fetchNeighborhood(names)`
// (optional) lets the modal RECENTER on a clicked node by fetching that node's neighborhood.
// Reuses the exact per-doc graph renderer + modal chrome.
export function openEntityGraphModal({ data, title = () => "", fetchNeighborhood = null, onOpenDoc = null, onTimeline = null } = {}) {
  const toRels = (d) => (d.edges || []).map((e) => ({
    head: e.head, tail: e.tail, qual: e.qual || "", cooc: !!e.cooc, count: e.count, docIds: e.docIds || [], time: e.time || "",
    rel: e.cooc ? (t("relGraphCooc") + (e.count > 1 ? ` ·${e.count}` : "")) : (e.label || e.rel || ""),
  })).filter((r) => r.head && r.tail && r.head !== r.tail);
  const centersOf = (d) => new Set((d.centers || (d.center ? [d.center] : [])).map((c) => c.name));
  const seedsOf = (d) => (d.centers || (d.center ? [d.center] : [])).map((c) => c.name);
  const docTitleOf = (d) => new Map((d.docs || []).map((x) => [x.docId, x.title]));
  const first = toRels(data);
  if (!first.length) return false;
  let ctrl;
  // Recenter history: each entry is the seed set that produced that view; ‹ / › walk it.
  const hist = [seedsOf(data)]; let hi = 0;
  const apply = (d) => {
    ctrl.render(toRels(d), { title: title(d), center: centersOf(d), onNodeClick, docTitle: docTitleOf(d), docs: d.docs || [] });
    ctrl.setNav(hi > 0, hi < hist.length - 1);
  };
  const load = async (seeds, push) => {
    let d; try { d = await fetchNeighborhood(seeds); } catch { return; }
    if (!d || !toRels(d).length) return;
    if (push) { hist.length = hi + 1; hist.push(seeds); hi = hist.length - 1; }
    apply(d);
  };
  const onNodeClick = fetchNeighborhood ? (name) => load([name], true) : null;
  ctrl = openGraphModal(first, {
    title: title(data), center: centersOf(data), onNodeClick, radial: true, onOpenDoc,
    onBack: fetchNeighborhood ? () => { if (hi > 0) { hi--; load(hist[hi], false); } } : null,
    onForward: fetchNeighborhood ? () => { if (hi < hist.length - 1) { hi++; load(hist[hi], false); } } : null,
    onTimeline: onTimeline ? () => onTimeline((hist[hi] || []).slice()) : null,
  });
  ctrl.render(first, { title: title(data), center: centersOf(data), onNodeClick, docTitle: docTitleOf(data), docs: data.docs || [] });
  ctrl.setNav(false, false);
  return true;
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
