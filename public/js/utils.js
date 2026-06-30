// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

// Pure utility functions

// Short unique id for messages / background jobs. crypto.randomUUID where
// available, else a timestamp+random fallback (older WebKit in the wrapper).
export function genId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
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