// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

// Naming + marker convention for email images. TWIN of server/mail-images.js — the
// server can't be imported here (CommonJS, and there is no build step), so the two
// files must be changed together. The server owns the download policy; this side owns
// the client MIME parse (parseEml) and the display plumbing, but BOTH emit the same
// filenames and markers, because they meet in the same bubble: a rendered ref only
// resolves to an inline image when its name matches one in generatedImageNames.

// MIME → extension, for uniform image naming.
export function mimeToExt(mime) {
  if (/jpeg|jpg/i.test(mime)) return "jpg";
  if (/png/i.test(mime)) return "png";
  if (/gif/i.test(mime)) return "gif";
  if (/webp/i.test(mime)) return "webp";
  if (/heic/i.test(mime)) return "heic";
  return "jpg";
}

// The one naming convention for mail images: image_01.png, image_02.jpg, …
export function imageName(index1, mime) {
  return `image_${String(index1).padStart(2, "0")}.${mimeToExt(mime)}`;
}

// The one marker form: a markdown image ref whose "filename" is resolved against the
// bubble's own images (chat.js buildBubbleImageResolver) and rendered INLINE, right
// where the image sat in the mail. A plain-text marker would render as literal text
// and lose that, so never hand-roll this elsewhere.
export function imageMarker(index1, mime) {
  return `![\u{1F4F7} ${index1}](${imageName(index1, mime)})`;
}

// True for the alt text this module generates ("📷 3") — lets a rewrite pass tell an
// already-placed inline ref from one it still has to renumber.
export function isImageMarkerAlt(alt) {
  return /^\u{1F4F7}\s*\d+$/u.test(String(alt || "").trim());
}
