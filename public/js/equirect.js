// Reproject a photo onto the equirectangular sphere, leaving the part of the sphere
// it does not cover transparent.
//
// This is the front half of "image → 360° panorama": a normal photo is a flat
// (rectilinear) projection, a panorama is a spherical one, so the photo cannot just
// be pasted into the middle of a 2:1 canvas — the further from its centre, the more
// the two projections disagree (at the edge of a 90° photo the sample position is
// off by ~27% of the half-width). Pasted flat it looks bent when you stand inside
// the result, which is the one thing this whole feature exists to avoid.
//
// The output's ALPHA channel doubles as the outpainting mask. Verified against the
// live ComfyUI: /upload/image keeps the alpha channel, and LoadImage's second output
// is 1 − alpha — already the right polarity for "this is the part you must invent" —
// and it is a graded mask, not a thresholded one, so a feathered edge survives all
// the way to the sampler. That is why nothing here uploads a separate mask image.
//
// The part the photo does NOT cover is not left blank: it is pre-filled by smearing
// the photo's own border outwards (see `fill`). Measured on the live server, an empty
// hole makes the sampler ignore the photo completely — a plain checkpoint has no
// inpainting channels, so at full denoise the masked region starts from pure noise
// and the result is an unrelated scene with the photo stuck on top. Seeded with the
// smear and run at partial denoise instead, the sky, ground and palette continue.
//
// Everything below is pure array maths so it can be exercised from Node as well as
// the browser; the canvas glue lives in image-gen.js.

const D2R = Math.PI / 180;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// What kind of picture is this, and how much of a turn does it cover?
//
// A phone's "Panoramas" mode does NOT produce an equirectangular image — it sweeps a
// cylinder, so it is linear in longitude but still perspective vertically, and it can
// span far more than a lens ever could. Its aspect ratio gives it away, and since the
// sweep only ever widens the frame, the vertical field of view is still the camera's
// own (~63° for a phone held upright). That fixes the scale, and the width then says
// how far the sweep went.
// `force` overrides the guess at the projection while still deriving that
// projection's own default coverage, so choosing "sweep panorama" by hand does not
// leave a rectilinear 75° behind.
export function guessSource(srcW, srcH, force = "") {
  const aspect = srcW / Math.max(1, srcH);
  const kind = force || (aspect >= 1.95 && aspect <= 2.05 ? "equirect" : aspect >= 2.2 ? "cylindrical" : "rectilinear");
  if (kind === "equirect") return { projection: "equirect", fovDeg: 360 };
  if (kind === "cylindrical") {
    const focal = (srcH / 2) / Math.tan(63 * D2R / 2);   // px per radian, from the phone's own vertical cone
    return { projection: "cylindrical", fovDeg: Math.round(clamp((srcW / focal) / D2R, 60, 350)) };
  }
  return { projection: "rectilinear", fovDeg: 75 };      // a typical phone main camera
}

// How wide a seam-repair band can be inpainted without eating into the photo.
// The repair works by rolling the panorama half a turn so the wrap-around lands in
// the middle, then repainting a band there. The photo sits at the centre of the
// unrolled image, i.e. exactly half a turn from that band — so the band may grow
// until it reaches the photo's far edge, and no further.
export function seamBandFraction(fovDeg, wanted = 1 / 3) {
  const freeDeg = 180 - fovDeg / 2 - 10;                 // 10° of margin so they never touch
  if (freeDeg <= 5) return 0;                            // the photo goes all the way round: nothing to repair
  return Math.min(wanted, (2 * freeDeg) / 360);
}

// src: { width, height, data } with data as RGBA bytes (an ImageData, or the same
// shape built by hand). Returns the same shape at dstW × dstW/2.
export function projectToEquirect(src, opts = {}) {
  const sw = src.width, sh = src.height, sd = src.data;
  const dstW = Math.max(64, Math.round(opts.dstW || 1536) & ~1);
  const dstH = dstW >> 1;
  const out = new Uint8ClampedArray(dstW * dstH * 4);
  const projection = opts.projection || "rectilinear";
  // A rectilinear frame is a pinhole image: it has no focal length at 180°, and
  // approaches one asymptotically, so it is capped well short of that.
  const fov = clamp(opts.fovDeg || 75, 5, projection === "rectilinear" ? 170 : 355) * D2R;
  // 0 means a hard edge, not "as narrow as possible" — a caller asking for no
  // feather is usually measuring the boundary and must not be handed a soft one.
  const featherFrac = opts.featherFrac ?? 0.04;
  const featherPx = featherFrac > 0 ? Math.max(1, Math.round(Math.min(sw, sh) * featherFrac)) : 0;

  if (projection === "equirect") {
    // Already a panorama — resample it and mark the whole sphere as known, so the
    // recipe degenerates into "repair the seam of this equirect", which is a
    // sensible thing to ask for and does no harm.
    for (let y = 0; y < dstH; y++) {
      const sy = ((y + 0.5) / dstH) * sh - 0.5;
      for (let x = 0; x < dstW; x++) {
        sample(sd, sw, sh, ((x + 0.5) / dstW) * sw - 0.5, sy, out, (y * dstW + x) * 4);
        out[(y * dstW + x) * 4 + 3] = 255;
      }
    }
    return { width: dstW, height: dstH, data: out };
  }

  // Longitude runs the full turn across the canvas with the photo's centre at the
  // middle, which is also what puts the wrap-around at the far side of the sphere.
  const sinLon = new Float64Array(dstW), cosLon = new Float64Array(dstW);
  for (let x = 0; x < dstW; x++) {
    const lon = ((x + 0.5) / dstW - 0.5) * 2 * Math.PI;
    sinLon[x] = Math.sin(lon); cosLon[x] = Math.cos(lon);
  }
  const cyl = projection === "cylindrical";
  // Rectilinear: half the frame subtends half the cone at distance f.
  // Cylindrical: the sweep is linear in longitude, so f is simply px per radian.
  const f = cyl ? sw / fov : (sw / 2) / Math.tan(fov / 2);
  const halfFov = fov / 2;
  const halfFovV = Math.atan((sh / 2) / f);
  const fill = opts.fill !== false;
  // Clamping happens in ANGLE space, not pixel space: outside the cone a rectilinear
  // projection has no finite pixel to clamp (longitudes past 90° are behind the
  // camera), whereas clamping the direction first always lands on the photo's border.
  const lonLimit = Math.min(halfFov, Math.PI / 2 - 1e-3) * 0.999;
  const latLimit = halfFovV * 0.999;

  for (let y = 0; y < dstH; y++) {
    const lat = (0.5 - (y + 0.5) / dstH) * Math.PI;
    const cl = Math.cos(lat), sl = Math.sin(lat);
    const tanLat = cl > 1e-9 ? sl / cl : (sl > 0 ? Infinity : -Infinity);
    for (let x = 0; x < dstW; x++) {
      const lon = ((x + 0.5) / dstW - 0.5) * 2 * Math.PI;
      let px, py, inside = true;
      if (cyl) {
        if (Math.abs(lon) > halfFov) inside = false;
        px = sw / 2 + f * lon;
        py = sh / 2 - f * tanLat;
      } else {
        const z = cl * cosLon[x];
        if (z <= 1e-6) inside = false;
        else {
          px = sw / 2 + f * (cl * sinLon[x]) / z;
          py = sh / 2 - f * sl / z;
        }
      }
      if (inside && !(px >= 0 && py >= 0 && px <= sw - 1 && py <= sh - 1)) inside = false;
      const o = (y * dstW + x) * 4;
      if (inside) {
        sample(sd, sw, sh, px, py, out, o);
        // Fade out at the photo's border so the invented surroundings blend into it
        // instead of meeting it along a hard rectangle.
        const d = Math.min(px, sw - 1 - px, py, sh - 1 - py);
        out[o + 3] = d >= featherPx ? 255 : Math.round((255 * d) / featherPx);
        continue;
      }
      if (!fill) continue;
      const lc = clamp(lon, -lonLimit, lonLimit), tc = clamp(lat, -latLimit, latLimit);
      const zc = Math.cos(tc) * Math.cos(lc);
      const qx = cyl ? sw / 2 + f * lc : sw / 2 + f * (Math.cos(tc) * Math.sin(lc)) / zc;
      const qy = cyl ? sh / 2 - f * Math.tan(tc) : sh / 2 - f * Math.sin(tc) / zc;
      sample(sd, sw, sh, clamp(qx, 0, sw - 1), clamp(qy, 0, sh - 1), out, o);
      out[o + 3] = 0;                                     // colour, but still "invent me"
    }
  }
  return { width: dstW, height: dstH, data: out };
}

// Bilinear, writing RGB only — the caller owns alpha.
function sample(sd, sw, sh, px, py, out, o) {
  const x0 = Math.floor(px), y0 = Math.floor(py);
  const x1 = Math.min(sw - 1, x0 + 1), y1 = Math.min(sh - 1, y0 + 1);
  const fx = px - x0, fy = py - y0;
  const i00 = (y0 * sw + x0) * 4, i10 = (y0 * sw + x1) * 4;
  const i01 = (y1 * sw + x0) * 4, i11 = (y1 * sw + x1) * 4;
  const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
  for (let c = 0; c < 3; c++) {
    out[o + c] = sd[i00 + c] * w00 + sd[i10 + c] * w10 + sd[i01 + c] * w01 + sd[i11 + c] * w11;
  }
}

// Write RGBA bytes out as a PNG, without going through a canvas.
//
// A canvas cannot carry this image: measured in Chrome, putImageData → getImageData
// returns [0,0,0] wherever alpha is 0 and garbage at alpha 1, because the backing
// store is premultiplied. That would erase exactly the pre-fill the sampler needs.
// So the container is written here and only the compression is borrowed, from the
// platform's own CompressionStream — "deflate" is the zlib wrapper PNG asks for.
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t;
})();

function crc32(bytes) {
  let c = -1;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

export async function encodePngRGBA(width, height, data) {
  const stride = width * 4;
  const raw = new Uint8Array(height * (stride + 1));
  // Filter 1 (Sub) throughout: a panorama is photographic, so each pixel is close to
  // the one on its left, and this roughly halves the payload over no filtering for a
  // few operations per byte.
  for (let y = 0; y < height; y++) {
    const o = y * (stride + 1), s = y * stride;
    raw[o] = 1;
    for (let x = 0; x < 4; x++) raw[o + 1 + x] = data[s + x];
    for (let x = 4; x < stride; x++) raw[o + 1 + x] = (data[s + x] - data[s + x - 4]) & 0xff;
  }
  const cs = new CompressionStream("deflate");
  const writer = cs.writable.getWriter();
  writer.write(raw); writer.close();
  const idat = new Uint8Array(await new Response(cs.readable).arrayBuffer());

  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width); dv.setUint32(4, height);
  ihdr[8] = 8; ihdr[9] = 6;                                // 8-bit, truecolour + alpha
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr), pngChunk("IDAT", idat), pngChunk("IEND", new Uint8Array(0))];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const png = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { png.set(p, at); at += p.length; }
  return png;
}

// The inverse: pull a normal photo back out of an equirectangular panorama. Not used
// by the app — it is how the round trip gets checked against a real panorama, since
// a view taken out and put back must land where it started.
export function equirectToPerspective(pano, { width, height, fovDeg = 75, yawDeg = 0, pitchDeg = 0 }) {
  const pw = pano.width, ph = pano.height, pd = pano.data;
  const out = new Uint8ClampedArray(width * height * 4);
  const f = (width / 2) / Math.tan(clamp(fovDeg, 5, 170) * D2R / 2);
  const yaw = yawDeg * D2R, pitch = pitchDeg * D2R;
  const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const cx = i + 0.5 - width / 2, cyy = height / 2 - (j + 0.5);
      // Camera ray, then pitch about X and yaw about Y.
      let x = cx, y = cyy, z = f;
      const y2 = y * cp - z * sp, z2 = y * sp + z * cp;
      const x3 = x * cy + z2 * sy, z3 = -x * sy + z2 * cy;
      const r = Math.hypot(x3, y2, z3);
      const lon = Math.atan2(x3 / r, z3 / r), lat = Math.asin(clamp(y2 / r, -1, 1));
      const u = (lon / (2 * Math.PI) + 0.5) * pw - 0.5;
      const v = (0.5 - lat / Math.PI) * ph - 0.5;
      const o = (j * width + i) * 4;
      sample(pd, pw, ph, clamp(u, 0, pw - 1), clamp(v, 0, ph - 1), out, o);
      out[o + 3] = 255;
    }
  }
  return { width, height, data: out };
}
