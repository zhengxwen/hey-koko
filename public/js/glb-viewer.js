// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

// In-bubble GLB viewer — zero-dependency GLB parse + raw WebGL1 render, following
// the hand-rolled star-map.js precedent (own shaders, no three.js).
//
// Architecture: ONE shared hidden WebGL canvas for the whole app (browsers cap live
// GL contexts at ~8-16 and a chat can hold dozens of meshes). Every bubble's
// .meshCanvas is a plain 2D canvas showing a POSTER frame rendered once through the
// shared context; clicking a poster overlays the shared GL canvas on that wrapper
// and goes interactive (orbit / zoom). Leaving it (or activating another mesh)
// bakes the current view back into the poster and detaches. At rest the cost per
// mesh is one bitmap and zero GL contexts.
//
// Parsed scenes are cached (small LRU) so chat re-renders don't re-parse; GL
// buffers exist only while a scene is actually being drawn.

import { t } from "./i18n.js";

let _supported = null;
export function isSupported() {
  if (_supported !== null) return _supported;
  try {
    const c = document.createElement("canvas");
    _supported = !!(c.getContext("webgl") || c.getContext("experimental-webgl"));
  } catch { _supported = false; }
  return _supported;
}

// ---- tiny mat4 helpers (column-major, like WebGL wants) ---------------------
function m4identity() { return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; }
function m4mul(a, b) {
  const o = new Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  }
  return o;
}
function m4fromTRS(t, r, s) {
  // quaternion → rotation matrix, then scale columns, then translation.
  const [x, y, z, w] = r;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2, wx = w * x2, wy = w * y2, wz = w * z2;
  return [
    (1 - (yy + zz)) * s[0], (xy + wz) * s[0], (xz - wy) * s[0], 0,
    (xy - wz) * s[1], (1 - (xx + zz)) * s[1], (yz + wx) * s[1], 0,
    (xz + wy) * s[2], (yz - wx) * s[2], (1 - (xx + yy)) * s[2], 0,
    t[0], t[1], t[2], 1,
  ];
}
function m4perspective(fovY, aspect, near, far) {
  const f = 1 / Math.tan(fovY / 2), nf = 1 / (near - far);
  return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0];
}
function transformPoint(m, p) {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
}
// Rotate the direction part only (normals; assumes roughly uniform scale, which is
// what generator output has — a re-normalize in the shader absorbs the rest).
function transformDir(m, p) {
  return [m[0] * p[0] + m[4] * p[1] + m[8] * p[2], m[1] * p[0] + m[5] * p[1] + m[9] * p[2], m[2] * p[0] + m[6] * p[1] + m[10] * p[2]];
}

// ---- GLB parsing ------------------------------------------------------------
const CT_SIZE = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const TYPE_N = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

function readAccessor(gltf, bin, idx) {
  const acc = gltf.accessors[idx];
  const n = TYPE_N[acc.type];
  const count = acc.count;
  const out = new Float32Array(count * n);
  const bv = gltf.bufferViews[acc.bufferView];
  const compSize = CT_SIZE[acc.componentType];
  const stride = bv.byteStride || compSize * n;
  const base = (bv.byteOffset || 0) + (acc.byteOffset || 0);
  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  // Normalized integer attributes (COLOR_0 as u8/u16) → scale into [0,1].
  const norm = acc.normalized
    ? (acc.componentType === 5121 ? 1 / 255 : acc.componentType === 5123 ? 1 / 65535 : 1)
    : 1;
  for (let i = 0; i < count; i++) {
    const o = base + i * stride;
    for (let c = 0; c < n; c++) {
      const p = o + c * compSize;
      let v;
      switch (acc.componentType) {
        case 5120: v = dv.getInt8(p); break;
        case 5121: v = dv.getUint8(p); break;
        case 5122: v = dv.getInt16(p, true); break;
        case 5123: v = dv.getUint16(p, true); break;
        case 5125: v = dv.getUint32(p, true); break;
        default: v = dv.getFloat32(p, true);
      }
      out[i * n + c] = v * norm;
    }
  }
  return out;
}
function readIndices(gltf, bin, idx) {
  const acc = gltf.accessors[idx];
  const bv = gltf.bufferViews[acc.bufferView];
  const base = (bv.byteOffset || 0) + (acc.byteOffset || 0);
  if (acc.componentType === 5125) return new Uint32Array(bin.buffer, bin.byteOffset + base, acc.count).slice();
  if (acc.componentType === 5123) return new Uint16Array(bin.buffer, bin.byteOffset + base, acc.count).slice();
  return Uint8Array.from(new Uint8Array(bin.buffer, bin.byteOffset + base, acc.count));
}

function computeNormals(pos, indices) {
  const normals = new Float32Array(pos.length);
  const idx = indices || null;
  const triCount = (idx ? idx.length : pos.length / 3) / 3;
  for (let t = 0; t < triCount; t++) {
    const a = idx ? idx[t * 3] : t * 3, b = idx ? idx[t * 3 + 1] : t * 3 + 1, c = idx ? idx[t * 3 + 2] : t * 3 + 2;
    const ax = pos[a * 3], ay = pos[a * 3 + 1], az = pos[a * 3 + 2];
    const nx = (pos[b * 3 + 1] - ay) * (pos[c * 3 + 2] - az) - (pos[b * 3 + 2] - az) * (pos[c * 3 + 1] - ay);
    const ny = (pos[b * 3 + 2] - az) * (pos[c * 3] - ax) - (pos[b * 3] - ax) * (pos[c * 3 + 2] - az);
    const nz = (pos[b * 3] - ax) * (pos[c * 3 + 1] - ay) - (pos[b * 3 + 1] - ay) * (pos[c * 3] - ax);
    for (const v of [a, b, c]) { normals[v * 3] += nx; normals[v * 3 + 1] += ny; normals[v * 3 + 2] += nz; }
  }
  for (let i = 0; i < normals.length; i += 3) {
    const l = Math.hypot(normals[i], normals[i + 1], normals[i + 2]) || 1;
    normals[i] /= l; normals[i + 1] /= l; normals[i + 2] /= l;
  }
  return normals;
}

// Decode an embedded texture image (bufferView slice) → ImageBitmap/HTMLImage.
async function decodeImage(gltf, bin, texIndex) {
  try {
    const tex = gltf.textures[texIndex];
    const img = gltf.images[tex.source];
    if (img.bufferView === undefined) return null; // external URI — not in a GLB from ComfyUI
    const bv = gltf.bufferViews[img.bufferView];
    const bytes = new Uint8Array(bin.buffer, bin.byteOffset + (bv.byteOffset || 0), bv.byteLength);
    const blob = new Blob([bytes], { type: img.mimeType || "image/png" });
    if (typeof createImageBitmap === "function") return await createImageBitmap(blob);
    // Safari fallback: HTMLImage via a blob URL, revoked after decode.
    return await new Promise((resolve) => {
      const url = URL.createObjectURL(blob);
      const el = new Image();
      el.onload = () => { URL.revokeObjectURL(url); resolve(el); };
      el.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
      el.src = url;
    });
  } catch { return null; }
}

// Close the wrap seam of an equirectangular grid mesh.
//
// MoGe lays a panorama out as a cols×rows grid spanning u 0→1 and stops there: the
// last column and the first are the SAME longitude, yet no triangle joins them, so
// the "sphere" is a sheet rolled into a tube with a slit up the side. Measured on a
// real reconstruction: 444×222 vertices, zero triangles spanning the seam, the two
// columns 0.41° apart — which at a 40° field of view is a ~9px bright line running
// pole to pole, exactly where the source image's left and right edges meet.
//
// Fixing it means bridging the two columns. Their UVs can't be interpolated across
// (u would run 1→0 and smear the whole image into the sliver), so the first column
// is DUPLICATED with u moved to the wrap end — where equirect says it already
// belongs, the left and right edges being one and the same meridian.
function stitchEquirectSeam(prim) {
  const { pos, uv, indices } = prim;
  if (!uv || !indices) return prim;
  const n = pos.length / 3;
  const first = [], last = [];
  for (let i = 0; i < n; i++) {
    const u = uv[i * 2];
    if (u <= 1e-6) first.push(i);
    else if (u >= 1 - 1e-6) last.push(i);
  }
  // Both edges must exist as equal-length columns, or this isn't the grid we think.
  if (first.length < 3 || first.length !== last.length) return prim;
  const byV = (a, b) => uv[a * 2 + 1] - uv[b * 2 + 1];
  first.sort(byV); last.sort(byV);

  const add = first.length;                 // duplicated vertices, appended at the end
  const grow = (arr, comp) => {
    if (!arr) return null;
    const out = new Float32Array(arr.length + add * comp);
    out.set(arr);
    for (let k = 0; k < add; k++) {
      const src = first[k] * comp;
      for (let c = 0; c < comp; c++) out[arr.length + k * comp + c] = arr[src + c];
    }
    return out;
  };
  const nPos = grow(pos, 3), nNrm = grow(prim.nrm, 3), nUv = grow(uv, 2), nCol = grow(prim.col, 3);
  for (let k = 0; k < add; k++) nUv[uv.length + k * 2] = 1;   // the copy lives at the far edge

  // Two triangles per row gap, joining the last column to the duplicated first one.
  const extra = (add - 1) * 6;
  const Ctor = (n + add) > 65535 ? Uint32Array : indices.constructor;
  const nIdx = new Ctor(indices.length + extra);
  nIdx.set(indices);
  let w = indices.length;
  for (let k = 0; k < add - 1; k++) {
    const a = last[k], b = last[k + 1], c = n + k, d = n + k + 1;
    nIdx[w++] = a; nIdx[w++] = b; nIdx[w++] = c;
    nIdx[w++] = b; nIdx[w++] = d; nIdx[w++] = c;
  }
  return { ...prim, pos: nPos, nrm: nNrm, uv: nUv, col: nCol, indices: nIdx };
}

// The cone of directions a forward reconstruction actually covers, measured from
// the capture point. Used to open the camera pointed at the content and to stop it
// turning off the edge of the world — a perspective mesh is a window, not a sphere,
// and there is nothing behind you.
//
// The centre is the MEAN direction rather than the midpoint of min/max, because
// yaw is circular: taking extremes of atan2 straight would tear apart anything
// straddling ±π. Offsets are then measured relative to that centre and wrapped.
function forwardArc(prims) {
  let mx = 0, my = 0, mz = 0, n = 0;
  for (const p of prims) for (let i = 0; i < p.pos.length; i += 3) {
    const x = p.pos[i], y = p.pos[i + 1], z = p.pos[i + 2];
    const r = Math.hypot(x, y, z);
    if (r < 1e-6) continue;
    mx += x / r; my += y / r; mz += z / r; n++;
  }
  if (!n) return null;
  const ml = Math.hypot(mx, my, mz) || 1;
  mx /= ml; my /= ml; mz /= ml;
  const yaw0 = Math.atan2(mx, mz), pitch0 = Math.asin(Math.max(-1, Math.min(1, my)));
  let halfYaw = 0, halfPitch = 0;
  for (const p of prims) for (let i = 0; i < p.pos.length; i += 3) {
    const x = p.pos[i], y = p.pos[i + 1], z = p.pos[i + 2];
    const r = Math.hypot(x, y, z);
    if (r < 1e-6) continue;
    let a = Math.atan2(x, z) - yaw0;
    while (a > Math.PI) a -= 2 * Math.PI;
    while (a < -Math.PI) a += 2 * Math.PI;
    if (Math.abs(a) > halfYaw) halfYaw = Math.abs(a);
    const b = Math.abs(Math.asin(Math.max(-1, Math.min(1, y / r))) - pitch0);
    if (b > halfPitch) halfPitch = b;
  }
  // Never past the pole: the look-at frame degenerates when the view direction is
  // exactly vertical, and no single-camera capture reaches that far anyway.
  return { yaw: yaw0, pitch: pitch0, halfYaw: Math.min(halfYaw, 1.5), halfPitch: Math.min(halfPitch, 1.4) };
}

// Parse a GLB into flat, pre-transformed primitives + a bounding sphere.
// Returns null on anything unparseable (caller keeps the download-only card).
// `opts.view` is the chain's declaration of what this mesh IS: "panorama" (a full
// sphere around the capture point — additionally seals the equirect wrap seam, which
// is only meaningful and only safe there) or "forward" (a window in front of one).
export async function parseGLB(arrayBuffer, opts = {}) {
  try {
    const dv = new DataView(arrayBuffer);
    if (dv.getUint32(0, true) !== 0x46546c67) return null; // "glTF"
    const total = dv.getUint32(8, true);
    let off = 12, json = null, bin = null;
    while (off < total) {
      const len = dv.getUint32(off, true), type = dv.getUint32(off + 4, true);
      const chunk = new Uint8Array(arrayBuffer, off + 8, len);
      if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(chunk));
      else if (type === 0x004e4942) bin = chunk;
      off += 8 + len + (len % 4 ? 4 - (len % 4) : 0);
    }
    if (!json || !json.meshes) return null;
    const gltf = json;
    const prims = [];
    let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];

    // glTF nodes form a forest: every node has at most one parent, so visiting one
    // twice always means a malformed file (or a bad root list) and would draw the
    // same geometry twice at two transforms — a "ghost duplicate" of the model. The
    // guard also makes a cyclic file terminate instead of blowing the stack.
    const visited = new Set();
    const walk = (nodeIdx, parentM) => {
      const node = gltf.nodes && gltf.nodes[nodeIdx];
      if (!node || visited.has(nodeIdx)) return;
      visited.add(nodeIdx);
      const local = node.matrix
        ? node.matrix.slice()
        : m4fromTRS(node.translation || [0, 0, 0], node.rotation || [0, 0, 0, 1], node.scale || [1, 1, 1]);
      const m = m4mul(parentM, local);
      if (node.mesh !== undefined) {
        for (const prim of gltf.meshes[node.mesh].primitives) {
          if ((prim.mode ?? 4) !== 4) continue; // triangles only
          if (prim.attributes.POSITION === undefined) continue;
          const pos = readAccessor(gltf, bin, prim.attributes.POSITION);
          let indices = prim.indices !== undefined ? readIndices(gltf, bin, prim.indices) : null;
          let nrm = prim.attributes.NORMAL !== undefined ? readAccessor(gltf, bin, prim.attributes.NORMAL) : null;
          if (!nrm) nrm = computeNormals(pos, indices); // Hunyuan's surface-net mesh ships none
          // Bake the node transform on the CPU — one draw needs no per-node uniforms.
          for (let i = 0; i < pos.length; i += 3) {
            const p = transformPoint(m, [pos[i], pos[i + 1], pos[i + 2]]);
            pos[i] = p[0]; pos[i + 1] = p[1]; pos[i + 2] = p[2];
            const nn = transformDir(m, [nrm[i], nrm[i + 1], nrm[i + 2]]);
            nrm[i] = nn[0]; nrm[i + 1] = nn[1]; nrm[i + 2] = nn[2];
            for (let c = 0; c < 3; c++) { if (p[c] < min[c]) min[c] = p[c]; if (p[c] > max[c]) max[c] = p[c]; }
          }
          const uv = prim.attributes.TEXCOORD_0 !== undefined ? readAccessor(gltf, bin, prim.attributes.TEXCOORD_0) : null;
          let col = prim.attributes.COLOR_0 !== undefined ? readAccessor(gltf, bin, prim.attributes.COLOR_0) : null;
          // VEC4 vertex colors → drop alpha (the shader takes vec3).
          if (col && col.length / (pos.length / 3) === 4) {
            const c3 = new Float32Array(pos.length);
            for (let i = 0, n = pos.length / 3; i < n; i++) { c3[i * 3] = col[i * 4]; c3[i * 3 + 1] = col[i * 4 + 1]; c3[i * 3 + 2] = col[i * 4 + 2]; }
            col = c3;
          }
          const mat = prim.material !== undefined ? (gltf.materials[prim.material] || {}) : {};
          const pbr = mat.pbrMetallicRoughness || {};
          prims.push({
            pos, nrm, uv, col, indices,
            baseColor: (pbr.baseColorFactor || [1, 1, 1, 1]).slice(0, 3),
            texIndex: pbr.baseColorTexture ? pbr.baseColorTexture.index : null,
            texImage: null, // decoded below
            doubleSided: !!mat.doubleSided,
          });
        }
      }
      for (const c of node.children || []) walk(c, m);
    };
    // Roots: the declared scene when there is one, else every node that ISN'T some
    // other node's child. Taking "every node" as a root (the obvious fallback) walks
    // each child a second time with the identity transform — one model, drawn twice.
    const childOf = new Set();
    for (const n of gltf.nodes || []) for (const c of n.children || []) childOf.add(c);
    const scene = gltf.scenes ? gltf.scenes[gltf.scene || 0] : null;
    const all = (gltf.nodes || []).map((_, i) => i);
    let roots = (scene && scene.nodes) || all.filter((i) => !childOf.has(i));
    // Every node is someone's child → the graph is cyclic, so there is no root to
    // start from and the model would render EMPTY. Walk from all of them; the
    // visited guard still yields exactly one copy.
    if (!roots.length && all.length) roots = all;
    for (const r of roots) walk(r, m4identity());
    if (!prims.length) return null;

    // Seal the wrap seam before anything downstream measures or uploads the mesh.
    // The added vertices are copies of ones already inside the bounds, so neither
    // the bounding box nor the near-plane search below can shift.
    if (opts.view === "panorama") for (let i = 0; i < prims.length; i++) prims[i] = stitchEquirectSeam(prims[i]);

    for (const p of prims) if (p.texIndex !== null) p.texImage = await decodeImage(gltf, bin, p.texIndex);
    const center = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
    const radius = Math.max(Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2, 1e-6);
    // Where a panorama viewer has to stand. MoGe emits its meshes in CAMERA space:
    // every vertex is distance × direction measured from the capture point, which is
    // therefore the origin. The bounding-box centre is NOT that point — on a real
    // room it sits well above and to one side (measured: 0.69 up, 35% of the radius
    // off) — and orbiting the wrong centre tilts the whole world. Fall back to the
    // centre only if the origin somehow isn't enclosed, so a stray mesh can't put
    // the camera outside the geometry.
    // A panorama surrounds its capture point; a perspective reconstruction sits in
    // FRONT of one. Both are camera-space meshes with the camera at the origin, and
    // both want to be looked at from there rather than orbited — the difference is
    // only how far you may turn. Measured on a MoGe perspective mesh: z spans
    // −117…−4, so the origin is outside the box but at the apex of the frustum.
    const enclosesOrigin = min.every((v) => v < 0) && max.every((v) => v > 0);
    const panoOrigin = (enclosesOrigin || opts.view === "forward") ? [0, 0, 0] : center;
    // How near the near plane has to be to stand here. Deriving it from the bounding
    // radius (what the orbit camera does) is wrong for a panorama: the radius is set
    // by the FAR geometry — sky 34 units out — while the nearest thing is the floor
    // at your feet, 0.4 away. Measured on a real courtyard, radius·0.01 came to 0.507
    // and clipped the entire ground away: look down and the world went white.
    let closest = Infinity;
    for (const p of prims) {
      for (let i = 0; i < p.pos.length; i += 3) {
        const d = Math.hypot(p.pos[i] - panoOrigin[0], p.pos[i + 1] - panoOrigin[1], p.pos[i + 2] - panoOrigin[2]);
        if (d > 1e-6 && d < closest) closest = d;
      }
    }
    const panoNear = Math.max(Number.isFinite(closest) ? closest * 0.5 : radius * 0.01, radius * 1e-5);
    // Where a forward reconstruction actually HAS surface, so the camera can open
    // pointed at it and refuse to turn past its ragged edge into empty space. A
    // panorama needs none of this: every direction has geometry.
    const arc = opts.view === "forward" ? forwardArc(prims) : null;
    return { prims, center, radius, panoOrigin, panoNear, arc };
  } catch { return null; }
}

// ---- shared GL context ------------------------------------------------------
// glHost wraps the canvas + the HUD: a <canvas> can't own child elements, so the
// HOST is what goes fullscreen — otherwise the controls would be invisible there.
let glHost = null, hud = null;
let glCanvas = null, gl = null, prog = null, loc = null;
let glBuffers = [];   // live VBOs/textures for the CURRENTLY drawn scene
let glScene = null;   // which scene the buffers belong to

// "Plain model" view: drop every colour source and shade the raw geometry, which is
// what you want for judging the SHAPE — a texture hides surface faults, and on a
// generated mesh the shape is the part worth inspecting. A neutral off-white rather
// than pure white so the headlight shading stays readable at the highlights.
let plainMode = false;
const PLAIN_COLOR = new Float32Array([0.82, 0.82, 0.84]);

const VS = `
attribute vec3 aPos; attribute vec3 aNrm; attribute vec2 aUv; attribute vec3 aCol;
uniform mat4 uMVP;
varying vec3 vNrm; varying vec2 vUv; varying vec3 vCol;
void main() { gl_Position = uMVP * vec4(aPos, 1.0); vNrm = aNrm; vUv = aUv; vCol = aCol; }`;
const FS = `
precision mediump float;
varying vec3 vNrm; varying vec2 vUv; varying vec3 vCol;
uniform vec3 uBaseColor; uniform vec3 uLightDir; uniform float uHasTex; uniform sampler2D uTex;
uniform float uUnlit;
void main() {
  vec3 n = normalize(vNrm);
  // A panorama's texture IS a photograph — it already carries the scene's light.
  // Shading it again darkens whatever the reconstruction left at a grazing angle
  // (the ground plane running away from you), which reads as dirt on the floor.
  float diff = uUnlit > 0.5 ? 1.0 : 0.35 + 0.65 * abs(dot(n, normalize(uLightDir))); // headlight, double-sided
  vec3 base = uBaseColor * vCol;
  if (uHasTex > 0.5) base *= texture2D(uTex, vUv).rgb;
  gl_FragColor = vec4(base * diff, 1.0);
}`;

function initGL() {
  if (gl && prog) return true;
  if (!isSupported()) return false;
  if (!glCanvas) {
    glCanvas = document.createElement("canvas");
    glCanvas.className = "meshGlOverlay";
    // Re-init the program on context restore; loss just invalidates buffers.
    glCanvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); prog = null; glBuffers = []; glScene = null; });
    glCanvas.addEventListener("webglcontextrestored", () => { initGL(); });
    glHost = document.createElement("div");
    glHost.className = "meshGlHost";
    hud = document.createElement("div");
    hud.className = "meshHud";
    glHost.appendChild(glCanvas);
    glHost.appendChild(hud); // after the canvas → draws on top
  }
  gl = glCanvas.getContext("webgl", { antialias: true, preserveDrawingBuffer: true });
  if (!gl) { _supported = false; return false; }
  gl.getExtension("OES_element_index_uint");
  const sh = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { prog = null; return false; }
  loc = {
    aPos: gl.getAttribLocation(prog, "aPos"), aNrm: gl.getAttribLocation(prog, "aNrm"),
    aUv: gl.getAttribLocation(prog, "aUv"), aCol: gl.getAttribLocation(prog, "aCol"),
    uMVP: gl.getUniformLocation(prog, "uMVP"), uBaseColor: gl.getUniformLocation(prog, "uBaseColor"),
    uLightDir: gl.getUniformLocation(prog, "uLightDir"), uHasTex: gl.getUniformLocation(prog, "uHasTex"),
    uUnlit: gl.getUniformLocation(prog, "uUnlit"),
    uTex: gl.getUniformLocation(prog, "uTex"),
  };
  return true;
}

function freeBuffers() {
  for (const b of glBuffers) {
    if (b.vbo) gl.deleteBuffer(b.vbo); if (b.nbo) gl.deleteBuffer(b.nbo);
    if (b.ubo) gl.deleteBuffer(b.ubo); if (b.cbo) gl.deleteBuffer(b.cbo);
    if (b.ibo) gl.deleteBuffer(b.ibo); if (b.tex) gl.deleteTexture(b.tex);
  }
  glBuffers = []; glScene = null;
}

// Upload a scene's primitives into GL buffers (freeing the previous scene's).
function uploadScene(scene) {
  if (glScene === scene && glBuffers.length) return;
  freeBuffers();
  for (const p of scene.prims) {
    const b = { count: p.indices ? p.indices.length : p.pos.length / 3, indexed: !!p.indices, prim: p };
    const buf = (data, target = gl.ARRAY_BUFFER) => {
      const o = gl.createBuffer(); gl.bindBuffer(target, o); gl.bufferData(target, data, gl.STATIC_DRAW);
      return o;
    };
    b.vbo = buf(p.pos);
    b.nbo = buf(p.nrm);
    if (p.uv) b.ubo = buf(p.uv);
    if (p.col) b.cbo = buf(p.col);
    if (p.indices) {
      b.ibo = buf(p.indices, gl.ELEMENT_ARRAY_BUFFER);
      b.indexType = p.indices instanceof Uint32Array ? gl.UNSIGNED_INT : p.indices instanceof Uint16Array ? gl.UNSIGNED_SHORT : gl.UNSIGNED_BYTE;
    }
    if (p.texImage) {
      b.tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, b.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, p.texImage);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
    glBuffers.push(b);
  }
  glScene = scene;
}

// Render the scene at (yaw, pitch, dist·radius) into the shared canvas.
// `pano` swaps the orbit camera for a panorama one: the eye is pinned to the
// capture point and LOOKS OUTWARD, because a 360° mesh is a shell you stand inside
// — orbiting it from outside only ever shows you the half of the world that
// happens to face you, with the rest hidden behind its own back. In that mode
// distMul stops meaning distance (there is nowhere to move to) and becomes the
// field of view, which is what "zoom" means to a panorama.
function renderView(scene, w, h, yaw, pitch, distMul, firstPerson = false) {
  if (!initGL()) return false;
  glCanvas.width = w; glCanvas.height = h;
  uploadScene(scene);
  gl.viewport(0, 0, w, h);
  gl.clearColor(0, 0, 0, 0);
  gl.enable(gl.DEPTH_TEST);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.useProgram(prog);

  const R = scene.radius;
  const cp = Math.cos(pitch), sp = Math.sin(pitch), cy = Math.cos(yaw), sy = Math.sin(yaw);
  // The look direction is the same spherical vector in both modes; what differs is
  // whether the eye sits AT the pivot or that far away FROM it.
  const dir = [cp * sy, sp, cp * cy];
  let eye, c;
  if (firstPerson) {
    eye = scene.panoOrigin || scene.center;
    c = [eye[0] + dir[0], eye[1] + dir[1], eye[2] + dir[2]];
  } else {
    c = scene.center;
    const d = R * 2.4 * distMul;
    eye = [c[0] + d * dir[0], c[1] + d * dir[1], c[2] + d * dir[2]];
  }
  // lookAt(eye → center), up (0,1,0)
  let zx = eye[0] - c[0], zy = eye[1] - c[1], zz = eye[2] - c[2];
  let zl = Math.hypot(zx, zy, zz); zx /= zl; zy /= zl; zz /= zl;
  let xx = zz, xz = -zx; // up × z (up=(0,1,0)) → (z2, 0, -z0)
  const xl = Math.hypot(xx, 0, xz) || 1; xx /= xl; xz /= xl;
  const yx = zy * xz, yy = zz * xx - zx * xz, yz = -zy * xx;
  const view = [
    xx, yx, zx, 0,
    0, yy, zy, 0,
    xz, yz, zz, 0,
    -(xx * eye[0] + xz * eye[2]), -(yx * eye[0] + yy * eye[1] + yz * eye[2]), -(zx * eye[0] + zy * eye[1] + zz * eye[2]), 1,
  ];
  // 0.7 rad ≈ 40°, a normal lens. Panorama zoom rides the same distMul the wheel
  // already drives, clamped to a believable lens range instead of a distance range.
  const fov = firstPerson ? Math.min(1.9, Math.max(0.22, 0.7 * distMul)) : 0.7;
  const near = firstPerson ? (scene.panoNear || R * 0.01) : R * 0.01;
  const mvp = m4mul(m4perspective(fov, w / h, near, R * 40), view);
  gl.uniformMatrix4fv(loc.uMVP, false, new Float32Array(mvp));
  gl.uniform3fv(loc.uLightDir, [zx, zy, zz]); // headlight from the eye
  // Plain mode strips the photo away to leave bare geometry, and bare geometry needs
  // the headlight back or it is a flat silhouette.
  gl.uniform1f(loc.uUnlit, firstPerson && !plainMode ? 1 : 0);

  for (const b of glBuffers) {
    const p = b.prim;
    if (p.doubleSided) gl.disable(gl.CULL_FACE);
    else { gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK); }
    gl.bindBuffer(gl.ARRAY_BUFFER, b.vbo);
    gl.enableVertexAttribArray(loc.aPos);
    gl.vertexAttribPointer(loc.aPos, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, b.nbo);
    gl.enableVertexAttribArray(loc.aNrm);
    gl.vertexAttribPointer(loc.aNrm, 3, gl.FLOAT, false, 0, 0);
    if (b.ubo) {
      gl.bindBuffer(gl.ARRAY_BUFFER, b.ubo);
      gl.enableVertexAttribArray(loc.aUv);
      gl.vertexAttribPointer(loc.aUv, 2, gl.FLOAT, false, 0, 0);
    } else { gl.disableVertexAttribArray(loc.aUv); gl.vertexAttrib2f(loc.aUv, 0, 0); }
    if (b.cbo && !plainMode) {
      gl.bindBuffer(gl.ARRAY_BUFFER, b.cbo);
      gl.enableVertexAttribArray(loc.aCol);
      gl.vertexAttribPointer(loc.aCol, 3, gl.FLOAT, false, 0, 0);
    } else { gl.disableVertexAttribArray(loc.aCol); gl.vertexAttrib3f(loc.aCol, 1, 1, 1); }
    // Plain mode neutralises ALL three colour sources — texture, vertex colours and
    // the material's base factor — so what's left is the bare shaded geometry.
    gl.uniform3fv(loc.uBaseColor, plainMode ? PLAIN_COLOR : p.baseColor);
    gl.uniform1f(loc.uHasTex, b.tex && !plainMode ? 1 : 0);
    if (b.tex && !plainMode) { gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, b.tex); gl.uniform1i(loc.uTex, 0); }
    if (b.indexed) {
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, b.ibo);
      gl.drawElements(gl.TRIANGLES, b.count, b.indexType, 0);
    } else {
      gl.drawArrays(gl.TRIANGLES, 0, b.count);
    }
  }
  return true;
}

// ---- scene cache (parse once per mesh, survive chat re-renders) -------------
const sceneCache = new Map(); // key → { scene, poster } ; small LRU
const CACHE_MAX = 3;
function cacheGet(key) {
  const v = sceneCache.get(key);
  if (v) { sceneCache.delete(key); sceneCache.set(key, v); } // bump recency
  return v;
}
function cachePut(key, v) {
  sceneCache.set(key, v);
  while (sceneCache.size > CACHE_MAX) sceneCache.delete(sceneCache.keys().next().value);
}

function b64ToArrayBuffer(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

// ---- HUD --------------------------------------------------------------------
// Rebuilt per activation so each button closes over that session's handlers. In
// the bubble only the ⛶ button shows (the small box has no room for a toolbar);
// fullscreen adds the full toolbar + a shortcut legend.
const ZOOM_STEP = 1.25;
// Fullscreen backdrops, cycled by the ◐ button / B. Dark first (it flatters a lit
// model), then neutral mid-grey — the standard backdrop for judging colour, since
// it biases neither the light nor the dark end — then light and white for pale or
// white models, which vanish against #111. The choice sticks across sessions: a
// user who cycles to white wants white next time too.
// `light` drives .isLightBg, which darkens the HUD chrome: a 50%-black pill over
// white renders as mid-grey and its white glyphs go washy.
const BACKDROPS = [
  { css: "#111318", light: false },
  { css: "#808080", light: false },
  { css: "#e9e9ee", light: true },
  { css: "#ffffff", light: true },
];
const BG_KEY = "hk_glb_bg";
let bgIndex = (() => {
  // Guarded: merely TOUCHING localStorage throws where storage is blocked
  // (sandboxed iframe, privacy mode). Unguarded at module scope that would fail
  // the whole import and take the viewer down over a cosmetic preference.
  try {
    const n = Number(localStorage.getItem(BG_KEY));
    return Number.isInteger(n) && n >= 0 && n < BACKDROPS.length ? n : 0;
  } catch { return 0; }
})();
function buildHud(actions) {
  hud.textContent = "";
  const bar = document.createElement("div");
  bar.className = "meshHudBar";
  const mk = (label, title, fn, cls) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "meshHudBtn" + (cls ? " " + cls : "");
    b.textContent = label;
    b.title = title;
    // Keep the press off the canvas: no orbit-drag, no stray dblclick-fullscreen.
    b.addEventListener("pointerdown", (e) => e.stopPropagation());
    b.addEventListener("dblclick", (e) => e.stopPropagation());
    b.addEventListener("click", (e) => { e.stopPropagation(); fn(); });
    bar.appendChild(b);
    return b;
  };
  const btns = {
    reset: mk("⟲", `${t("mesh_btnReset")} (R)`, actions.reset, "isFsOnly"),
    zoomOut: mk("−", `${t("mesh_btnZoomOut")} (−)`, actions.zoomOut, "isFsOnly"),
    zoomIn: mk("+", `${t("mesh_btnZoomIn")} (+)`, actions.zoomIn, "isFsOnly"),
    // Two directions rather than one toggle: clicking the opposite arrow reverses
    // instead of stopping, and clicking the lit one stops.
    spinCcw: mk("↺", `${t("mesh_btnAutoRotateCcw")} (Shift+Space)`, () => actions.toggleSpin(-1), "isFsOnly"),
    spinCw: mk("↻", `${t("mesh_btnAutoRotate")} (Space)`, () => actions.toggleSpin(1), "isFsOnly"),
    bg: mk("◐", `${t("mesh_btnBackground")} (B)`, actions.cycleBg, "isFsOnly"),
    plain: mk("▩", `${t("mesh_btnPlain")} (T)`, actions.togglePlain, "isFsOnly"),
    fs: mk("⛶", `${t("mesh_btnFullscreen")} (F)`, actions.toggleFs),
  };
  // Nothing to strip on an untextured, uncoloured mesh (Hunyuan3D without the paint
  // pass, MoGe without texture) — a button that visibly does nothing is worse than
  // no button, so it only appears when the model actually carries colour.
  btns.plain.hidden = !actions.hasColor;
  btns.plain.classList.toggle("isOn", plainMode);
  hud.appendChild(bar);
  const hint = document.createElement("div");
  hint.className = "meshHudHint isFsOnly";
  hint.textContent = t(actions.firstPerson ? "mesh_shortcutsHintPano" : "mesh_shortcutsHint");
  hud.appendChild(hint);
  return btns;
}

// ---- public: attach a viewer to a bubble's 2D canvas ------------------------
let activeDetach = null; // deactivator for the one live interactive mesh

const DEFAULT_VIEW = { yaw: Math.PI / 5, pitch: Math.PI / 10, dist: 1 };
// A panorama opens level with the horizon — the 3/4-from-above angle that flatters
// an object is exactly the angle that shows a room's ceiling.
// yaw π, not 0: yaw 0 stares straight at the equirect's u=0/u=1 wrap seam, which
// lands as a hard vertical join down the middle of the opening view. Half a turn
// puts the seam behind you and the image's centre — where a photographer aims —
// in front.
const PANO_VIEW = { yaw: Math.PI, pitch: 0, dist: 1 };
// Distance has an 8× range because a model can be inspected from far away; a field
// of view does not, so panorama zoom gets its own, narrower clamp.
const clampDist = (v, firstPerson) => firstPerson ? Math.min(1.6, Math.max(0.25, v)) : Math.min(8, Math.max(0.2, v));

export function attachMesh(canvas, getBase64, opts = {}) {
  if (!isSupported()) return null;
  const mode = opts.view || "";
  // Both first-person modes stand at the capture point and look out; only how far
  // you may turn differs, so the renderer needs one flag and the input handlers
  // need the arc.
  const firstPerson = mode === "panorama" || mode === "forward";
  // A forward mesh opens pointed at its own content and zoomed to roughly frame it,
  // which the geometry knows and a constant cannot.
  const baseViewFor = (scene) => {
    if (mode !== "forward") return firstPerson ? PANO_VIEW : DEFAULT_VIEW;
    const a = scene && scene.arc;
    if (!a) return PANO_VIEW;
    return { yaw: a.yaw, pitch: a.pitch, dist: clampDist(2.3 * a.halfPitch / 0.7, true) };
  };
  const key = (opts.cacheKey || `${opts.name || ""}:${(getBase64() || "").length}`) + (mode ? ":" + mode : "");
  const ctx2d = canvas.getContext("2d");
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let destroyed = false;

  const sizeCanvas = () => {
    const w = canvas.clientWidth || 320, h = canvas.clientHeight || 260;
    if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
  };

  // True while the interactive GL overlay is mounted on this canvas. The overlay
  // clears to TRANSPARENT, so anything still painted on the poster underneath
  // composites through it — a stale default-angle bake plus the live view reads as
  // TWO copies of the model. The poster bitmap is therefore wiped while live (the
  // canvas element stays, so its CSS border/background still frame the box) and
  // repainted on detach.
  let live = false;

  const drawPoster = (entry) => {
    sizeCanvas();
    if (!entry.poster || entry.poster.width !== canvas.width) {
      const bv = baseViewFor(entry.scene);
      if (!renderView(entry.scene, canvas.width, canvas.height, bv.yaw, bv.pitch, bv.dist, firstPerson)) return;
      // Bake into a poster bitmap so later chat re-renders are a cheap drawImage.
      const p = document.createElement("canvas");
      p.width = canvas.width; p.height = canvas.height;
      p.getContext("2d").drawImage(glCanvas, 0, 0);
      entry.poster = p;
    }
    if (live) return; // the overlay owns the pixels right now
    ctx2d.clearRect(0, 0, canvas.width, canvas.height);
    ctx2d.drawImage(entry.poster, 0, 0, canvas.width, canvas.height);
  };

  const load = async () => {
    let entry = cacheGet(key);
    if (!entry) {
      const scene = await parseGLB(b64ToArrayBuffer(getBase64()), { view: mode });
      // Unparseable → hide the canvas and tell the caller, so it can put the file
      // card back. This is async and lazy (it happens on scroll-in), which is why
      // the caller can't just check a return value.
      if (!scene) { canvas.hidden = true; if (opts.onFallback) opts.onFallback(); return null; }
      entry = { scene, poster: null };
      cachePut(key, entry);
    }
    if (!destroyed) drawPoster(entry);
    return entry;
  };

  // Lazy: parse + poster only when the bubble scrolls near the viewport.
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) { io.disconnect(); load(); }
    }
  }, { rootMargin: "400px" });
  io.observe(canvas);

  // Click → go interactive: overlay the shared GL canvas and orbit with the pointer.
  const activate = async () => {
    const entry = await load();
    if (!entry || destroyed) return;
    if (activeDetach) activeDetach(); // one live mesh at a time
    const view = { ...baseViewFor(entry.scene) };
    sizeCanvas();
    // Host box matching the poster canvas (it sits on top of it).
    const overlayCss = () => `position:absolute;left:${canvas.offsetLeft}px;top:${canvas.offsetTop}px;width:${canvas.clientWidth}px;height:${canvas.clientHeight}px;border-radius:inherit;`;
    canvas.style.position = "relative";
    canvas.insertAdjacentElement("afterend", glHost);
    glHost.style.cssText = overlayCss();
    glHost.classList.remove("isFs");
    // Wipe the baked poster: it would otherwise show through the transparent
    // overlay as a second, stale copy of the model (see `live`).
    live = true;
    ctx2d.clearRect(0, 0, canvas.width, canvas.height);

    const isFs = () => (document.fullscreenElement || document.webkitFullscreenElement) === glHost;
    // Keep the view inside the cone the reconstruction actually covers. A forward
    // mesh is a window: turn past its edge and you are looking at nothing at all.
    // The limit shrinks as you zoom OUT, because a wider lens reaches the edge from
    // further in — hence the subtraction of half the field of view, converted to
    // horizontal through the aspect ratio (the projection takes a VERTICAL fov).
    const aim = () => {
      const a = mode === "forward" && entry.scene && entry.scene.arc;
      if (!a) return;
      const w = isFs() ? glHost.clientWidth : canvas.width;
      const h = isFs() ? glHost.clientHeight : canvas.height;
      const fovY = Math.min(1.9, Math.max(0.22, 0.7 * view.dist));
      const fovX = 2 * Math.atan(Math.tan(fovY / 2) * ((w || 1) / (h || 1)));
      const limY = Math.max(0, a.halfYaw - fovX / 2);
      const limP = Math.max(0, a.halfPitch - fovY / 2);
      view.yaw = Math.min(a.yaw + limY, Math.max(a.yaw - limY, view.yaw));
      view.pitch = Math.min(a.pitch + limP, Math.max(a.pitch - limP, view.pitch));
    };
    const render = () => {
      // Fullscreen renders at screen resolution; in-bubble at the poster's size.
      const w = isFs() ? Math.max(1, Math.round(glHost.clientWidth * dpr)) : canvas.width;
      const h = isFs() ? Math.max(1, Math.round(glHost.clientHeight * dpr)) : canvas.height;
      return renderView(entry.scene, w, h, view.yaw, view.pitch, view.dist, firstPerson);
    };

    // Auto-rotate (Space / ↻). Cancelled by a drag — grabbing the model to look at
    // something and having it keep spinning away is the classic annoyance.
    let spinRaf = 0;
    let spinDir = 0; // -1 ccw · 0 stopped · +1 cw
    let btns = null; // set once buildHud runs below; setSpin may fire before that
    const spin = () => { view.yaw += 0.006 * spinDir; aim(); render(); spinRaf = requestAnimationFrame(spin); };
    // dir: -1 / +1 to spin that way, 0 to stop. Asking for the direction already
    // running stops it, so each arrow button is its own on/off.
    const setSpin = (dir) => {
      spinDir = dir === spinDir ? 0 : dir;
      if (spinDir && !spinRaf) spinRaf = requestAnimationFrame(spin);
      else if (!spinDir && spinRaf) { cancelAnimationFrame(spinRaf); spinRaf = 0; }
      if (btns) {
        btns.spinCw.classList.toggle("isOn", spinDir > 0);
        btns.spinCcw.classList.toggle("isOn", spinDir < 0);
      }
    };
    const zoom = (f) => { view.dist = clampDist(view.dist * f, firstPerson); aim(); requestAnimationFrame(render); };
    const resetView = () => { Object.assign(view, baseViewFor(entry.scene)); setSpin(0); requestAnimationFrame(render); };
    const toggleFs = () => {
      if (isFs()) (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
      else (glHost.requestFullscreen || glHost.webkitRequestFullscreen)?.call(glHost);
    };
    // Backdrop only applies in fullscreen: in the bubble the box keeps the chat's
    // own styling, and the GL canvas clears transparent so the host shows through.
    const applyBg = () => {
      glHost.classList.toggle("isLightBg", isFs() && BACKDROPS[bgIndex].light);
      if (isFs()) glHost.style.background = BACKDROPS[bgIndex].css;
    };
    const cycleBg = () => {
      bgIndex = (bgIndex + 1) % BACKDROPS.length;
      try { localStorage.setItem(BG_KEY, String(bgIndex)); } catch { /* private mode / disabled */ }
      applyBg();
    };
    // Does this model carry any colour at all? Decided from the parsed scene, so a
    // white mesh never grows a toggle that would do nothing.
    const hasColor = (entry.scene.prims || []).some((p) => p.texImage || p.col);
    const togglePlain = () => {
      plainMode = !plainMode;
      if (btns) btns.plain.classList.toggle("isOn", plainMode);
      requestAnimationFrame(render);
    };
    btns = buildHud({ reset: resetView, zoomIn: () => zoom(1 / ZOOM_STEP), zoomOut: () => zoom(ZOOM_STEP), toggleSpin: setSpin, cycleBg, toggleFs, togglePlain, hasColor, firstPerson });
    render();

    const pointers = new Map(); // pinch-zoom support
    let lastPinch = 0;
    const onDown = (e) => {
      setSpin(0); // a grab takes over from the turntable
      pointers.set(e.pointerId, [e.clientX, e.clientY]);
      glCanvas.setPointerCapture(e.pointerId);
      glCanvas.style.cursor = "grabbing";
    };
    const onMove = (e) => {
      if (!pointers.has(e.pointerId)) return;
      const prev = pointers.get(e.pointerId);
      pointers.set(e.pointerId, [e.clientX, e.clientY]);
      if (pointers.size === 2) {
        const pts = [...pointers.values()];
        const pinch = Math.hypot(pts[0][0] - pts[1][0], pts[0][1] - pts[1][1]);
        if (lastPinch) { view.dist = clampDist(view.dist * lastPinch / pinch, firstPerson); aim(); }
        lastPinch = pinch;
      } else {
        // Inside a panorama the world is around you, so dragging right has to turn
        // you LEFT for the scene to follow your hand; orbiting an object outside you
        // is the mirror of that. Same gesture, opposite sign.
        view.yaw += (e.clientX - prev[0]) * (firstPerson ? 0.01 : -0.01);
        view.pitch = Math.min(1.5, Math.max(-1.5, view.pitch + (e.clientY - prev[1]) * 0.01));
        aim();
      }
      requestAnimationFrame(render);
    };
    const onUp = (e) => { pointers.delete(e.pointerId); lastPinch = 0; glCanvas.style.cursor = "grab"; };
    const onWheel = (e) => {
      e.preventDefault();
      view.dist = clampDist(view.dist * Math.exp(e.deltaY * 0.001), firstPerson);
      aim();
      requestAnimationFrame(render);
    };
    const onDbl = toggleFs; // double-click toggles fullscreen (orbit keeps working there)
    const onFsChange = () => {
      // Entering: fill the screen (the fixed box is a belt for browsers that keep
      // inline styles). Leaving: restore the in-bubble box. .isFs reveals the toolbar.
      glHost.classList.toggle("isFs", isFs());
      // cssText REPLACES the inline style, so the chosen backdrop has to be baked in
      // here — setting it separately would be wiped on the next fullscreen change.
      glHost.style.cssText = isFs()
        ? `position:fixed;inset:0;width:100vw;height:100vh;background:${BACKDROPS[bgIndex].css};`
        : overlayCss();
      applyBg();
      requestAnimationFrame(render);
    };
    const onResize = () => requestAnimationFrame(render); // fullscreen on a resized window
    // Keyboard. Escape in fullscreen is consumed by the browser to exit it, so it
    // only detaches from the in-bubble overlay.
    const onKey = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = (e.target && e.target.tagName) || "";
      if (tag === "INPUT" || tag === "TEXTAREA" || (e.target && e.target.isContentEditable)) return;
      switch (e.key) {
        case "Escape": if (!isFs()) detach(); return;
        case "r": case "R": case "0": resetView(); break;
        case "f": case "F": toggleFs(); break;
        case "b": case "B": cycleBg(); break;
        case "t": case "T": if (hasColor) togglePlain(); break;
        case " ": setSpin(e.shiftKey ? -1 : 1); break;
        case "+": case "=": zoom(1 / ZOOM_STEP); break;
        case "-": case "_": zoom(ZOOM_STEP); break;
        case "ArrowLeft": view.yaw += 0.12; requestAnimationFrame(render); break;
        case "ArrowRight": view.yaw -= 0.12; requestAnimationFrame(render); break;
        case "ArrowUp": view.pitch = Math.min(1.5, view.pitch + 0.12); requestAnimationFrame(render); break;
        case "ArrowDown": view.pitch = Math.max(-1.5, view.pitch - 0.12); requestAnimationFrame(render); break;
        default: return;
      }
      e.preventDefault(); // Space scrolls the page, arrows scroll the chat
    };
    glCanvas.addEventListener("pointerdown", onDown);
    glCanvas.addEventListener("pointermove", onMove);
    glCanvas.addEventListener("pointerup", onUp);
    glCanvas.addEventListener("pointercancel", onUp);
    glCanvas.addEventListener("wheel", onWheel, { passive: false });
    glCanvas.addEventListener("dblclick", onDbl);
    document.addEventListener("fullscreenchange", onFsChange);
    document.addEventListener("webkitfullscreenchange", onFsChange);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);

    const detach = () => {
      setSpin(0);
      if (isFs()) (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
      glCanvas.removeEventListener("pointerdown", onDown);
      glCanvas.removeEventListener("pointermove", onMove);
      glCanvas.removeEventListener("pointerup", onUp);
      glCanvas.removeEventListener("pointercancel", onUp);
      glCanvas.removeEventListener("wheel", onWheel);
      glCanvas.removeEventListener("dblclick", onDbl);
      document.removeEventListener("fullscreenchange", onFsChange);
      document.removeEventListener("webkitfullscreenchange", onFsChange);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
      live = false;
      // Bake the final view back into the poster so the card keeps the user's angle.
      if (renderView(entry.scene, canvas.width, canvas.height, view.yaw, view.pitch, view.dist, firstPerson)) {
        const p = document.createElement("canvas");
        p.width = canvas.width; p.height = canvas.height;
        p.getContext("2d").drawImage(glCanvas, 0, 0);
        entry.poster = p;
        ctx2d.clearRect(0, 0, canvas.width, canvas.height);
        ctx2d.drawImage(entry.poster, 0, 0);
      }
      glHost.remove();
      if (activeDetach === detach) activeDetach = null;
    };
    activeDetach = detach;
  };
  canvas.addEventListener("click", activate);

  return {
    refresh: load,
    destroy() {
      destroyed = true;
      io.disconnect();
      canvas.removeEventListener("click", activate);
      if (activeDetach) { activeDetach(); }
      sceneCache.delete(key);
    },
  };
}
