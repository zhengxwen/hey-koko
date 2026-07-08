// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

// Pure utility functions

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
    throw new Error(res.ok ? "服务端返回了非 JSON 响应" : `请求失败（${res.status}）——服务端可能需要重启`);
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