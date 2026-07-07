// Dedicated timeline view — every time-qualified relation across the library plotted on a
// horizontal year axis. Zero-dependency, hand-built SVG (same idiom as relation-graph.js).
// Events are lane-packed so labels don't collide; the axis carries decade ticks; +/− zoom the
// year scale (labels stay constant size, spacing changes); a filter box narrows by text; click
// an event to open its source document.
import { t } from "./i18n.js";

const SVGNS = "http://www.w3.org/2000/svg";
const KIND_ICON = { paper: "📄", slides: "📊", blog: "🌐", video: "📺", doc: "📝", chat: "💬", other: "📎" };
const el = (tag, attrs, text) => { const e = document.createElementNS(SVGNS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (text != null) e.textContent = text; return e; };
const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
// approx label px (CJK ~ font-size wide; over-estimates Latin, which is fine for packing)
const labelPx = (s, n) => 13 * Math.min(s.length, n);
// "nice" axis step so there are ~8-12 ticks across the span
const niceStep = (span) => [1, 2, 5, 10, 20, 25, 50, 100, 200].find((s) => span / s <= 12) || 500;

export function openTimeline(events, { onOpenDoc = null } = {}) {
  const evs = (events || [])
    .map((e) => ({ ...e, year: parseInt(String(e.time).slice(0, 4), 10) }))
    .filter((e) => Number.isFinite(e.year))
    .sort((a, b) => a.year - b.year || String(a.time).localeCompare(String(b.time)));
  if (!evs.length) return false;
  const minY = Math.min(...evs.map((e) => e.year)), maxY = Math.max(...evs.map((e) => e.year));
  let zoomFactor = 1;   // user zoom multiplier; the base px/year auto-fits the (filtered) range each draw
  let filterText = "";

  const overlay = document.createElement("div"); overlay.className = "timelineModal";
  const inner = document.createElement("div"); inner.className = "timelineInner";
  const close = document.createElement("button"); close.type = "button"; close.className = "timelineClose"; close.textContent = "×"; close.setAttribute("aria-label", "×");
  const head = document.createElement("div"); head.className = "timelineHead";
  const title = document.createElement("div"); title.className = "timelineTitle";
  const filter = document.createElement("input"); filter.type = "search"; filter.className = "timelineFilter"; filter.placeholder = t("timelineFilter");
  const zoomWrap = document.createElement("div"); zoomWrap.className = "timelineZoom";
  const zin = document.createElement("button"); zin.type = "button"; zin.className = "timelineZoomBtn"; zin.textContent = "+"; zin.title = t("relGraphZoomIn");
  const zout = document.createElement("button"); zout.type = "button"; zout.className = "timelineZoomBtn"; zout.textContent = "−"; zout.title = t("relGraphZoomOut");
  zoomWrap.append(zout, zin);
  head.append(title, filter, zoomWrap);
  const scroll = document.createElement("div"); scroll.className = "timelineScroll";

  const draw = () => {
    const shown = filterText ? evs.filter((e) => `${e.head} ${e.rel} ${e.tail}`.toLowerCase().includes(filterText)) : evs;
    const hasMatch = shown.length > 0;
    // the axis auto-scales to the range the matching events span; with no match it keeps the original full span
    const dMin = hasMatch ? Math.min(...shown.map((e) => e.year)) : minY;
    const dMax = hasMatch ? Math.max(...shown.map((e) => e.year)) : maxY;
    const dSpan = Math.max(1, dMax - dMin);
    title.textContent = t("timelineTitle", { n: shown.length, a: dMin, b: dMax });
    scroll.innerHTML = "";

    const NTR = 30, DOT = 4, laneH = 19, topPad = 12, marginL = 46, marginR = 24, BREAKPX = 46;
    // Compressed year axis: a long empty stretch (gap wider than ~1/12 of the span) is squished to a
    // fixed BREAKPX so a lone ancient event can't push everything else off-screen. Dense clusters keep a
    // linear scale; xOf() piecewise-maps years through anchors. No compression when nothing matches.
    const uy = hasMatch ? [...new Set(shown.map((e) => e.year))].sort((a, b) => a - b) : [dMin, dMax];
    const gapThreshold = hasMatch ? Math.max(20, Math.round(dSpan / 12)) : Infinity;
    let keptYears = 0, nBreaks = 0;
    for (let i = 1; i < uy.length; i++) { const g = uy[i] - uy[i - 1]; if (g > gapThreshold) nBreaks++; else keptYears += g; }
    const targetW = 1000 * zoomFactor;                       // width the kept (linear) years should fill
    let pxPerYear = keptYears > 0 ? (targetW - marginL - marginR - nBreaks * BREAKPX) / keptYears : 24 * zoomFactor;
    pxPerYear = Math.max(3, Math.min(60, pxPerYear));
    const anchors = [];
    { let ax = marginL;
      for (let i = 0; i < uy.length; i++) {
        const broken = i > 0 && uy[i] - uy[i - 1] > gapThreshold;
        if (i > 0) ax += broken ? BREAKPX : (uy[i] - uy[i - 1]) * pxPerYear;
        anchors.push({ year: uy[i], x: ax, brokenBefore: broken });
      } }
    const lastA = anchors[anchors.length - 1];
    const xOf = (y) => {
      if (y <= anchors[0].year) return anchors[0].x + (y - anchors[0].year) * pxPerYear;
      if (y >= lastA.year) return lastA.x + (y - lastA.year) * pxPerYear;
      for (let i = 1; i < anchors.length; i++) {
        if (y <= anchors[i].year) { const a0 = anchors[i - 1], a1 = anchors[i]; return a0.x + (y - a0.year) / (a1.year - a0.year) * (a1.x - a0.x); }
      }
      return lastA.x;
    };
    const inBroken = (y) => { for (let i = 1; i < anchors.length; i++) { if (y > anchors[i - 1].year && y < anchors[i].year) return anchors[i].brokenBefore; } return false; };
    const bodyOf = (e) => `${e.head} ${e.rel} ${e.tail}`;   // the triple after the year
    // lane-pack: each event goes in the lowest lane whose last label right-edge clears this x
    const laneRight = []; const placed = [];
    for (const e of shown) {
      const x = xOf(e.year), w = DOT + 8 + 34 + labelPx(bodyOf(e), NTR) + 14;   // +34 for the year prefix
      let lane = laneRight.findIndex((rx) => rx <= x);
      if (lane < 0) { lane = laneRight.length; laneRight.push(0); }
      laneRight[lane] = x + w; placed.push({ e, x, lane });
    }
    const nLanes = laneRight.length;
    const axisY = topPad + nLanes * laneH + 14;
    const W = Math.max(...laneRight, xOf(dMax), marginL + 300) + marginR;
    const H = axisY + 34;
    const svg = el("svg", { class: "timelineSvg", width: Math.round(W), height: Math.round(H), viewBox: `0 0 ${Math.round(W)} ${Math.round(H)}` });

    // axis + gridlines; ticks inside a compressed gap are skipped, each gap gets a break glyph
    const step = niceStep(dSpan);
    svg.appendChild(el("line", { x1: marginL - 10, y1: axisY, x2: W - 6, y2: axisY, class: "timelineAxis" }));
    const drawnYears = new Set();
    const addTick = (y) => {
      if (drawnYears.has(y)) return; drawnYears.add(y);
      const x = xOf(y);
      if (x < marginL - 12 || x > W) return;
      svg.appendChild(el("line", { x1: x, y1: topPad, x2: x, y2: axisY, class: "timelineGrid" }));
      svg.appendChild(el("text", { x, y: axisY + 16, class: "timelineTick", "text-anchor": "middle" }, String(y)));
    };
    addTick(anchors[0].year); addTick(lastA.year);           // always label the two ends
    const start = Math.floor(dMin / step) * step;
    for (let y = start; y <= dMax + step; y += step) { if (y < dMin - step || inBroken(y)) continue; addTick(y); }
    for (let i = 1; i < anchors.length; i++) {               // break glyphs + the years framing each gap
      if (!anchors[i].brokenBefore) continue;
      const a0 = anchors[i - 1], a1 = anchors[i], mx = (a0.x + a1.x) / 2;
      addTick(a0.year); addTick(a1.year);
      const bg = el("g", { class: "timelineBreak" });
      bg.appendChild(el("line", { x1: mx, y1: topPad, x2: mx, y2: axisY, class: "timelineBreakGap" }));
      for (const dx of [-3, 3]) bg.appendChild(el("line", { x1: mx + dx - 3, y1: axisY + 5, x2: mx + dx + 3, y2: axisY - 5, class: "timelineBreakSlash" }));
      bg.appendChild(el("text", { x: mx, y: topPad - 1, class: "timelineBreakLabel", "text-anchor": "middle" }, t("timelineGap", { n: a1.year - a0.year })));
      svg.appendChild(bg);
    }
    if (!hasMatch) {   // keep the original axis, just note that nothing matched the filter
      svg.appendChild(el("text", { x: marginL, y: topPad + 4, class: "timelineEmptyNote", "text-anchor": "start" }, t("timelineNoMatch")));
    }
    // events: connector down to axis, dot, label
    for (const { e, x, lane } of placed) {
      const y = topPad + lane * laneH + laneH / 2;
      svg.appendChild(el("line", { x1: x, y1: y, x2: x, y2: axisY, class: "timelineConnector" }));
      const g = el("g", { class: "timelineEvent" + (onOpenDoc ? " isClickable" : "") });
      const full = `${e.time}  ${e.head} —${e.rel}→ ${e.tail}${e.place ? ` @${e.place}` : ""}\n${KIND_ICON[e.docKind] || "📄"} ${e.title}`;
      g.appendChild(el("title", {}, full));
      g.appendChild(el("circle", { cx: x, cy: y, r: DOT, class: "timelineDot" }));
      const label = el("text", { x: x + DOT + 6, y: y + 4, class: "timelineLabel", "text-anchor": "start" });
      label.appendChild(el("tspan", { class: "timelineYear" }, `${e.time.slice(0, 4)} `));   // year prefix (muted)
      label.appendChild(el("tspan", {}, trunc(bodyOf(e), NTR)));
      g.appendChild(label);
      if (onOpenDoc) g.addEventListener("click", () => { onOpenDoc(e.docId); shut(); });
      svg.appendChild(g);
    }
    scroll.appendChild(svg);
  };

  filter.addEventListener("input", () => { filterText = filter.value.trim().toLowerCase(); draw(); });
  const zoom = (f) => { const ratio = (scroll.scrollLeft + scroll.clientWidth / 2) / Math.max(1, scroll.scrollWidth); zoomFactor = Math.max(0.25, Math.min(6, zoomFactor * f)); draw(); scroll.scrollLeft = ratio * scroll.scrollWidth - scroll.clientWidth / 2; };
  zin.addEventListener("click", () => zoom(1.3));
  zout.addEventListener("click", () => zoom(1 / 1.3));
  scroll.addEventListener("wheel", (e) => { if (!e.ctrlKey && !e.metaKey) return; e.preventDefault(); zoom(e.deltaY < 0 ? 1.12 : 0.89); }, { passive: false });

  const shut = () => { overlay.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); shut(); } };
  close.addEventListener("click", shut);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) shut(); });
  document.addEventListener("keydown", onKey);

  inner.append(close, head, scroll);
  overlay.appendChild(inner);
  document.body.appendChild(overlay);
  draw();
  filter.focus();
  return true;
}
