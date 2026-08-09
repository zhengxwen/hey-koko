// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

// Pure utility functions
import { t } from './i18n.js';

// Short unique id for messages / background jobs. crypto.randomUUID where
// available, else a timestamp+random fallback (older WebKit in the wrapper).
export function genId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

// ---- gallery media references ---------------------------------------------
// A media slot on a message (generatedVideos[i], generatedImages[i], …) holds EITHER
// raw base64 — how everything used to be stored, and how old conversations, old
// archives and imported JSON still look — OR a same-origin gallery URL once the file
// itself lives in ~/.hey-koko/gallery (server/gallery.js). Keeping both in the same
// slot is what let the switch happen without touching the persistence allowlist, the
// field migrations, the per-index delete splices or the empty-bubble sweeper.
// Every renderer goes through mediaSrc(); anything that needs the actual bytes back
// (outgoing requests, exports) goes through mediaBase64().
//
// THE RULE: a slot carries bytes only while the file is not in the gallery. Once it is
// on disk the slot becomes a reference and the bytes are dropped, so a picture is stored
// once — in ~/.hey-koko/gallery — instead of twice (there AND base64-inflated inside
// IndexedDB). Anything that files media is therefore expected to swap the slot, not to
// stamp an id beside it.
//
// Two prefixes, because a slot can point at the artifact or at its 360px thumbnail
// (displayImages / generatedThumbnails, which used to be inline data: URLs). Both are
// references — isMediaRef and galleryIdOf accept either, so a thumbnail slot inlines on
// export and resolves on demand exactly like a full-size one.
export const GALLERY_PREFIX = "/api/gallery/file/";
export const GALLERY_THUMB_PREFIX = "/api/gallery/thumb/";

export function isMediaRef(v) {
  return typeof v === "string" && (v.startsWith(GALLERY_PREFIX) || v.startsWith(GALLERY_THUMB_PREFIX));
}

// Per-segment encoding: ids carry a "2026-08/" prefix that must stay a real path
// separator, while the filename may hold CJK or spaces.
function refUrl(prefix, id) {
  return prefix + String(id).split("/").map(encodeURIComponent).join("/");
}

export function galleryUrl(id) { return refUrl(GALLERY_PREFIX, id); }
export function galleryThumbUrl(id) { return refUrl(GALLERY_THUMB_PREFIX, id); }

export function galleryIdOf(v) {
  if (!isMediaRef(v)) return null;
  const prefix = v.startsWith(GALLERY_PREFIX) ? GALLERY_PREFIX : GALLERY_THUMB_PREFIX;
  return decodeURIComponent(v.slice(prefix.length));
}

// File media into the gallery and return the id it was given. Everything the app
// generates is already filed server-side; a photo or clip the user brings in is media
// too, and it used to exist nowhere but inside the conversation.
//
// The bytes go up raw (not base64-in-JSON) and the server dedups on content hash, so the
// same picture attached repeatedly costs one file — which is also what makes the id a
// stable identity for it. Best-effort by design: this must never be able to stop an
// attachment from being staged, so every failure comes back as null and the caller keeps
// the bytes inline.
export async function fileIntoGallery(b64, mime, name) {
  try {
    if (!b64) return null;
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const r = await fetch("/api/gallery/upload", {
      method: "POST",
      headers: { "Content-Type": mime || "application/octet-stream",
                 "X-Gallery-Name": encodeURIComponent(name || "") },
      body: bin,
    });
    const j = await r.json().catch(() => null);
    if (j && j.id && !j.deduped) {
      window.dispatchEvent(new CustomEvent("hk-media-added", { detail: { ids: [j.id] } }));
    }
    return (j && j.id) || null;
  } catch (e) {
    console.warn("[gallery] could not file the attachment:", e.message);
    return null;
  }
}

// Staged images carry only their base64, and it may have been converted since the file
// was picked (JPEG re-encode, EXIF bake-in) — so trust the bytes over the caller's
// label, or the gallery ends up with .jpg files that are really PNGs.
export function sniffImageMime(b64, fallback) {
  if (b64.startsWith("/9j/")) return "image/jpeg";
  if (b64.startsWith("iVBOR")) return "image/png";
  if (b64.startsWith("UklGR")) return "image/webp";
  if (b64.startsWith("R0lGOD")) return "image/gif";
  return fallback;
}

// Hand the server a thumbnail the browser already made. /api/gallery/thumb generates its
// own with ffmpeg, and falls back to serving the full-size image when there is none —
// correct, but it means a bubble showing a "thumbnail" would pull the whole picture.
// Posting the preview we were going to throw away costs one request and makes the
// fallback unnecessary. Fire-and-forget: a failure only means the fallback stays.
export function cacheGalleryThumb(id, dataUrl) {
  if (!id || typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) return;
  try {
    fetch("/api/gallery/thumb", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, jpeg: dataUrl }),
    }).catch(() => {});
  } catch { /* no network, no thumbnail — the fallback covers it */ }
}

// → something an <img>/<video>/<a download> can use directly. Without an explicit
// mime the container is sniffed from the first base64 characters, as the callers this
// replaces all did by hand.
export function mediaSrc(v, mime) {
  if (typeof v !== "string" || !v) return "";
  // NB: the test is the explicit gallery prefix, never a bare leading "/" — a JPEG's
  // base64 starts with "/9j/" and would be mistaken for a URL.
  if (isMediaRef(v) || v.startsWith("data:") || v.startsWith("blob:") || v.startsWith("http")) return v;
  const m = mime || (v.startsWith("/9j/") ? "image/jpeg"
    : v.startsWith("R0lGOD") ? "image/gif"
    : v.startsWith("UklGR") ? "image/webp" : "image/png");
  return `data:${m};base64,${v}`;
}

// → raw base64 (no data: prefix), fetching from the gallery when the slot is a
// reference. Used by the paths that must ship bytes: re-using a clip as the source of
// a new render, /analyze, and self-contained exports.
export async function mediaBase64(v) {
  if (typeof v !== "string" || !v) return v;
  if (v.startsWith("data:")) return v.slice(v.indexOf(",") + 1);
  // Same trap as mediaSrc: "/9j/…" is a JPEG, not a path.
  if (!isMediaRef(v) && !v.startsWith("blob:") && !v.startsWith("http")) return v;
  const res = await fetch(v);
  if (!res.ok) throw new Error(`media fetch failed (${res.status})`);
  const blob = await res.blob();
  return await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).slice(String(fr.result).indexOf(",") + 1));
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

// POST JSON and parse the response as JSON, via text so a NON-JSON body gives a clear
// error instead of the browser's cryptic "did not match the expected pattern". The
// usual cause: a newly-added route whose server wasn't restarted → serveStatic returns
// a 404 "Not found" (plain text).
export async function postJson(url, body, signal = null) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
    signal,
  });
  const text = await res.text();
  try { return text ? JSON.parse(text) : {}; }
  catch {
    throw new Error(res.ok ? t("util_nonJsonResponse") : t("util_requestFailedRestart", { status: res.status }));
  }
}

// Build a chat message, guaranteeing a stable `id`. Use at message-construction
// sites that the background-jobs queue needs to locate later (placeholders +
// their results). Spreads the caller's fields over the generated id so an
// explicit id wins.
export function newMsg(obj) {
  return { id: genId(), ...obj };
}

export function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// Strip markdown emphasis (**bold**, *italic*, __x__) from a plain-text LABEL such as a section
// heading. A `## **X**` heading (source HTML wrapped the <h2> text in <strong>) keeps literal **
// markers in its section field; those render verbatim where the label is shown as plain text.
// New imports are cleaned server-side (splitIntoBlocks); this also cleans already-imported docs.
export function stripHeadingEmphasis(s) {
  return String(s == null ? "" : s)
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/\*([^*\n]+?)\*/g, "$1")
    .replace(/^[\s*_]+|[\s*_]+$/g, "")
    .trim();
}

export function formatTimestamp(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// Download/caption filename for a piece of media: the owning message's timestamp +
// kind (+ index when the message holds several), e.g. "20260620-130910-image.png".
// A given `name` (e.g. an uploaded file's own name) wins, kept with its extension.
export function timestampStamp(ts) {
  const d = ts ? new Date(ts) : new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function mediaFilename(name, ts, kind, ext, idx, count) {
  if (name) return /\.[a-z0-9]+$/i.test(name) ? name : `${name}.${ext}`;
  const suffix = count > 1 ? `-${idx + 1}` : "";
  return `${timestampStamp(ts)}-${kind}${suffix}.${ext}`;
}

export function formatDuration(ms) {
  if (!ms || ms < 0) return "";
  if (ms < 1000) return `${ms}ms`;
  const secs = ms / 1000;
  if (secs < 60) return `${secs.toFixed(1)}s`;
  const m = Math.floor(secs / 60);
  const s = Math.round(secs % 60);
  return `${m}m ${s}s`;
}

export function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(reader.result));
    reader.addEventListener("error", () => reject(reader.error));
    reader.readAsDataURL(file);
  });
}

// Downscale an image to a JPEG thumbnail capped at `maxSize` px on its long edge.
// Uploaded-image previews (displayImages) use the 360 default; grid thumbnails for
// generated/fetched images (generatedThumbnails) pass 480 so they stay crisp at the
// ~240px display slot on retina (@2x) displays.
export function makePreview(dataUrl, maxSize = 360) {
  return new Promise((resolve) => {
    const image = new Image();
    image.addEventListener("load", () => {
      const canvas = document.createElement("canvas");
      const scale = Math.min(1, maxSize / Math.max(image.width, image.height));
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      const context = canvas.getContext("2d");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", 0.82));
    });
    image.addEventListener("error", () => resolve(dataUrl));
    image.src = dataUrl;
  });
}

export function convertToJpeg(dataUrl) {
  return new Promise((resolve) => {
    const image = new Image();
    image.addEventListener("load", () => {
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0);
      resolve(canvas.toDataURL("image/jpeg", 0.92));
    });
    image.addEventListener("error", () => resolve(dataUrl));
    image.src = dataUrl;
  });
}

// Read the EXIF Orientation tag (1–8) from a JPEG data URL, or 1 if absent/other
// format. Phone photos are stored in a fixed sensor orientation + this tag; a
// browser <img> honours it on display, but the RAW pixels (and their width/height)
// are un-rotated — so a portrait photo uploads as landscape bytes and the server,
// which reads pixel dimensions, sizes the output landscape. We parse the tag to
// decide whether to bake the rotation into the pixels before upload.
function jpegOrientation(dataUrl) {
  const comma = dataUrl.indexOf(",");
  const bin = atob(dataUrl.slice(comma + 1));
  const len = bin.length;
  if (len < 4) return 1;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
  const view = new DataView(bytes.buffer);
  if (view.getUint16(0) !== 0xffd8) return 1; // not a JPEG (SOI)
  let offset = 2;
  while (offset + 4 <= len) {
    const marker = view.getUint16(offset);
    offset += 2;
    if ((marker & 0xff00) !== 0xff00) break; // out of the marker stream
    if (marker === 0xffe1) {                  // APP1 — the EXIF segment
      if (offset + 8 > len || view.getUint32(offset + 2) !== 0x45786966) return 1; // "Exif"
      const tiff = offset + 8;                // TIFF header start (after len[2] + "Exif\0\0"[6])
      const little = view.getUint16(tiff) === 0x4949; // "II" = little-endian
      const g16 = (o) => view.getUint16(o, little);
      const g32 = (o) => view.getUint32(o, little);
      const ifd0 = tiff + g32(tiff + 4);
      if (ifd0 + 2 > len) return 1;
      const count = g16(ifd0);
      for (let i = 0; i < count; i++) {
        const entry = ifd0 + 2 + i * 12;
        if (entry + 10 > len) break;
        if (g16(entry) === 0x0112) return g16(entry + 8) || 1; // Orientation tag
      }
      return 1;
    }
    offset += view.getUint16(offset); // skip this segment by its length
  }
  return 1;
}

// If a JPEG carries a non-upright EXIF Orientation, bake that rotation into the
// pixels and strip the tag, so the uploaded bytes match what the user sees (and
// the server sizes the edit at the right aspect). Upright/other formats pass
// through untouched — no needless recompression. Best-effort: any failure returns
// the original. `createImageBitmap(..., {imageOrientation:'from-image'})` applies
// the EXIF rotation deterministically across browsers.
export async function normalizeOrientation(dataUrl, fileType) {
  if (!/^image\/jpeg$/i.test(fileType || "")) return dataUrl;
  let orient = 1;
  try { orient = jpegOrientation(dataUrl); } catch { return dataUrl; }
  if (orient <= 1) return dataUrl; // already upright → keep the original bytes
  try {
    const blob = await (await fetch(dataUrl)).blob();
    const bmp = await createImageBitmap(blob, { imageOrientation: "from-image" });
    const canvas = document.createElement("canvas");
    canvas.width = bmp.width;   // already the rotated (upright) dimensions
    canvas.height = bmp.height;
    canvas.getContext("2d").drawImage(bmp, 0, 0);
    bmp.close?.();
    return canvas.toDataURL("image/jpeg", 0.92);
  } catch {
    return dataUrl;
  }
}