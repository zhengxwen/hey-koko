// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

// 3D camera picker for the Qwen 2511 Multiple-Angles route.
//
// The LoRA answers to exactly 96 poses — 8 azimuths x 4 elevations x 3 distances —
// and to nothing in between, so this is a CHOOSER over a discrete grid rather than a
// free orbit control. A draggable sphere would promise a continuum the weights do not
// have: you would swing the camera smoothly and watch it snap to one of eight
// headings. The dial shows all eight up front instead, which is both honest and one
// click to any of them.
//
// Drawn as inline SVG with no library (the star-map / glb-viewer precedent). The
// element ids and the option keys are the contract with server/comfy.js — the keys
// travel as `camAzimuth` / `camElevation` / `camDistance` and the SERVER turns them
// into the `<sks> ...` phrase, so the trained vocabulary lives in exactly one place.

import { t } from "./i18n.js";

const NS = "http://www.w3.org/2000/svg";

// Azimuth ring, in the orientation upstream documents: front at the top, right at 3
// o'clock, back at the bottom. `deg` is the compass bearing used to place the dot.
const AZIMUTHS = [
  { key: "front", deg: 0 },
  { key: "front-right", deg: 45 },
  { key: "right", deg: 90 },
  { key: "back-right", deg: 135 },
  { key: "back", deg: 180 },
  { key: "back-left", deg: 225 },
  { key: "left", deg: 270 },
  { key: "front-left", deg: 315 },
];

// Elevations, drawn as a side view: the camera climbs an arc from below the subject
// to high above it. `deg` is the real camera elevation, `y`/`x` its place on the arc.
const ELEVATIONS = [
  { key: "high", deg: 60 },
  { key: "elevated", deg: 30 },
  { key: "eye", deg: 0 },
  { key: "low", deg: -30 },
];

const DISTANCES = ["close", "medium", "wide"];

const el = (name, attrs) => {
  const n = document.createElementNS(NS, name);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  return n;
};

// One clickable pose dot. The generous transparent hit circle underneath keeps the
// target finger-sized while the visible dot stays small.
function dot(cx, cy, key, onPick) {
  const g = el("g", { class: "camDot", "data-key": key, tabindex: "0", role: "button" });
  g.append(el("circle", { cx, cy, r: 11, class: "camHit" }));
  g.append(el("circle", { cx, cy, r: 5, class: "camDotMark" }));
  const fire = (e) => { e.preventDefault(); onPick(key); };
  g.addEventListener("click", fire);
  g.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") fire(e); });
  return g;
}

function buildAzimuth(svg, onPick) {
  svg.textContent = "";
  const cx = 60, cy = 60, r = 40;
  svg.append(el("circle", { cx, cy, r, class: "camRing" }));
  // The subject sits at the centre — the thing all 8 cameras are pointed at. It is NOT
  // symmetric, and that is the whole point of the dial: "front view" means the camera
  // stands where the subject is LOOKING. A bare square leaves front and back
  // indistinguishable, so draw the facing as a nose aimed at the 0° position (top).
  svg.append(el("rect", { x: cx - 7, y: cy - 7, width: 14, height: 14, rx: 3, class: "camSubject" }));
  const nose = el("path", { d: `M${cx - 5} ${cy - 7} L${cx + 5} ${cy - 7} L${cx} ${cy - 18} Z`, class: "camFacing" });
  nose.append(el("title", {}));
  nose.querySelector("title").textContent = t("cam_facing");
  svg.append(nose);
  for (const a of AZIMUTHS) {
    // Bearing 0 = straight up, then clockwise.
    const rad = (a.deg - 90) * Math.PI / 180;
    svg.append(dot(cx + r * Math.cos(rad), cy + r * Math.sin(rad), a.key, onPick));
  }
}

// Camera position for an elevation, as a side view: the subject stands at the right on
// a ground line and the camera swings up an arc to its LEFT. SVG y grows DOWNWARD, so
// the sine is SUBTRACTED — get that backwards and a higher camera draws lower, with the
// steep angles sliding clean off the 120-unit canvas.
function elevPoint(deg) {
  const ox = 92, oy = 78, r = 52;
  const rad = deg * Math.PI / 180;
  return { x: ox - r * Math.cos(rad), y: oy - r * Math.sin(rad) };
}

function buildElevation(svg, onPick) {
  svg.textContent = "";
  svg.append(el("line", { x1: 18, y1: 78, x2: 110, y2: 78, class: "camGround" }));
  svg.append(el("rect", { x: 86, y: 64, width: 16, height: 14, rx: 3, class: "camSubject" }));
  // Facing left, toward the camera arc — the same convention as the dial, so the two
  // little diagrams agree about which end of the subject is its front.
  const nose2 = el("path", { d: "M86 66 L86 76 L76 71 Z", class: "camFacing" });
  nose2.append(el("title", {}));
  nose2.querySelector("title").textContent = t("cam_facing");
  svg.append(nose2);
  const path = ELEVATIONS.map((e, i) => {
    const p = elevPoint(e.deg);
    return `${i ? "L" : "M"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
  }).join(" ");
  svg.append(el("path", { d: path, class: "camArc" }));
  for (const e of ELEVATIONS) {
    const p = elevPoint(e.deg);
    svg.append(dot(p.x, p.y, e.key, onPick));
  }
}

function buildDistance(box, onPick) {
  box.textContent = "";
  for (const d of DISTANCES) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "camDistBtn";
    b.dataset.key = d;
    b.addEventListener("click", () => onPick(d));
    box.append(b);
  }
}

let dom = null, state = null;

// Repaint every selection marker and the read-out. Called on open, on every pick and
// on a language switch, so the picker is never showing a stale label.
export function syncCamPicker() {
  if (!dom || !dom.comfyCamPicker) return;
  const az = state.camAzimuth || "front";
  const ev = state.camElevation || "eye";
  const di = state.camDistance || "medium";
  const mark = (svg, key) => {
    if (!svg) return;
    for (const g of svg.querySelectorAll(".camDot")) g.classList.toggle("isOn", g.dataset.key === key);
  };
  mark(dom.comfyCamAzimuth, az);
  mark(dom.comfyCamElevation, ev);
  for (const b of dom.comfyCamDistance?.querySelectorAll(".camDistBtn") || []) {
    b.classList.toggle("isOn", b.dataset.key === di);
    b.textContent = t(`cam_dist_${b.dataset.key}`);
  }
  // The pose keys carry hyphens ("front-right"); i18n keys cannot, so normalise.
  const k = (x) => String(x).replace(/-/g, "_");
  if (dom.comfyCamAzimuthCaption) dom.comfyCamAzimuthCaption.textContent = t(`cam_az_${k(az)}`);
  if (dom.comfyCamElevationCaption) dom.comfyCamElevationCaption.textContent = t(`cam_el_${k(ev)}`);
  // Show the phrase that will actually be sent. It is the recipe's own English
  // vocabulary, never translated — seeing it is how you learn what the dial does.
  if (dom.comfyCamPrompt) {
    const AZ = { front: "front view", "front-right": "front-right quarter view", right: "right side view",
      "back-right": "back-right quarter view", back: "back view", "back-left": "back-left quarter view",
      left: "left side view", "front-left": "front-left quarter view" };
    const EL = { low: "low-angle shot", eye: "eye-level shot", elevated: "elevated shot", high: "high-angle shot" };
    const DI = { close: "close-up", medium: "medium shot", wide: "wide shot" };
    dom.comfyCamPrompt.textContent = `<sks> ${AZ[az]} ${EL[ev]} ${DI[di]}`;
  }
}

export function initCamPicker(domRefs, appState, onChange) {
  dom = domRefs; state = appState;
  if (!dom.comfyCamPicker) return;
  const pick = (field) => (key) => { state[field] = key; syncCamPicker(); onChange && onChange(); };
  buildAzimuth(dom.comfyCamAzimuth, pick("camAzimuth"));
  buildElevation(dom.comfyCamElevation, pick("camElevation"));
  buildDistance(dom.comfyCamDistance, pick("camDistance"));
  syncCamPicker();
}
