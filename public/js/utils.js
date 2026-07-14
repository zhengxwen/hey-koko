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