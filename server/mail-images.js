// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

// Shared email-image policy for BOTH mail paths — /tool @outlook (server/office.js,
// live message via AppleScript) and a dropped .eml (server/parse-file.js, Pandoc'd
// MIME body). They used to carry separate copies that had silently drifted apart
// (3 KB vs 8 KB tracker floor, capped vs uncapped, shrink vs no shrink), so the same
// newsletter kept a different set of images depending on how it arrived. One module
// = one answer to "which images are worth keeping, what are they called".

const { optimizeImage } = require("./url-fetch");

// Below this a remote image is a tracking pixel or a signature logo, not content.
const IMG_MIN_BYTES = 8 * 1024;
// Hard ceiling per image; anything larger is a download, not an inline illustration.
const IMG_MAX_BYTES = 5 * 1024 * 1024;
const IMG_FETCH_TIMEOUT = 8000;

// Image MIME types worth extracting from an email (attachments or remote links).
const IMG_MIME_RE = /^image\/(png|jpe?g|gif|heic|webp)$/i;
const IMG_EXT_SET = new Set(["png", "jpg", "jpeg", "gif", "heic", "webp"]);

// MIME → extension, for uniform image naming.
function mimeToExt(mime) {
  if (/jpeg|jpg/i.test(mime)) return "jpg";
  if (/png/i.test(mime)) return "png";
  if (/gif/i.test(mime)) return "gif";
  if (/webp/i.test(mime)) return "webp";
  if (/heic/i.test(mime)) return "heic";
  return "jpg";
}

// The one naming convention for mail images: image_01.png, image_02.jpg, …
// Both paths depend on this matching the markdown refs they emit, so it lives here.
function imageName(index1, mime) {
  return `image_${String(index1).padStart(2, "0")}.${mimeToExt(mime)}`;
}

// The one marker form: a markdown image ref whose "filename" is resolved against the
// bubble's own images (chat.js buildBubbleImageResolver) and rendered INLINE, right
// where the image sat in the mail. Plain-text markers would render as literal text
// and lose that, so never hand-roll this elsewhere.
function imageMarker(index1, mime) {
  return `![\u{1F4F7} ${index1}](${imageName(index1, mime)})`;
}

// Fetch one remote image, applying the shared trash filters (non-image, SVG, tracker,
// oversized) and shrinking it. Returns null on any failure so one bad link never
// blocks the rest.
async function fetchRemoteImage(url) {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; LocalAIChat/1.0)",
        "Accept": "image/avif,image/webp,image/*,*/*;q=0.8",
      },
      signal: AbortSignal.timeout(IMG_FETCH_TIMEOUT),
      redirect: "follow",
    });
    if (!res.ok) return null;
    const mime = (res.headers.get("content-type") || "").split(";")[0].trim();
    if (!mime.startsWith("image/") || mime === "image/svg+xml") return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < IMG_MIN_BYTES || buf.length > IMG_MAX_BYTES) return null;
    // Shrink oversized captures; keep the original when no image backend is present.
    try {
      const o = await optimizeImage(buf, mime);
      return { base64: o.buf.toString("base64"), mime: o.ct };
    } catch {
      return { base64: buf.toString("base64"), mime };
    }
  } catch {
    return null;
  }
}

// Download a list of URLs, preserving order and dropping the ones that fail the
// filters. Returns [{ url, base64, mime }] for the survivors only.
async function fetchRemoteImages(urls) {
  const unique = [...new Set(urls || [])].filter((u) => /^https?:\/\//i.test(u));
  if (!unique.length) return [];
  const fetched = await Promise.all(unique.map(fetchRemoteImage));
  const out = [];
  for (let i = 0; i < unique.length; i++) {
    if (fetched[i]) out.push({ url: unique[i], ...fetched[i] });
  }
  return out;
}

module.exports = {
  IMG_MIN_BYTES, IMG_MAX_BYTES, IMG_MIME_RE, IMG_EXT_SET,
  mimeToExt, imageName, imageMarker, fetchRemoteImage, fetchRemoteImages,
};
