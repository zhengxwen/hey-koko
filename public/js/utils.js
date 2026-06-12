// Pure utility functions

export function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function formatTimestamp(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(reader.result));
    reader.addEventListener("error", () => reject(reader.error));
    reader.readAsDataURL(file);
  });
}

export function makePreview(dataUrl) {
  return new Promise((resolve) => {
    const image = new Image();
    image.addEventListener("load", () => {
      const canvas = document.createElement("canvas");
      const maxSize = 360;
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

const MAX_IMG_HEIGHT = 260;
const IMG_BOX_WIDTH = 240;

export function normalizeGridHeight(grid) {
  const imgs = Array.from(grid.querySelectorAll(".generatedImage"));
  if (imgs.length === 0) return;

  let loaded = 0;
  const apply = () => {
    let maxH = 0;
    for (const img of imgs) {
      if (!img.naturalWidth || !img.naturalHeight) continue;
      const scale = Math.min(1, IMG_BOX_WIDTH / img.naturalWidth);
      const h = img.naturalHeight * scale;
      if (h > maxH) maxH = h;
    }
    if (maxH === 0) return;
    const finalH = Math.min(Math.ceil(maxH), MAX_IMG_HEIGHT);
    for (const img of imgs) {
      img.style.height = finalH + "px";
    }
  };

  const checkAll = () => {
    loaded++;
    if (loaded >= imgs.length) apply();
  };

  for (const img of imgs) {
    if (img.complete && img.naturalWidth) {
      checkAll();
    } else {
      img.addEventListener("load", checkAll, { once: true });
      img.addEventListener("error", checkAll, { once: true });
    }
  }
}
