// Image lightbox
import { dom } from './state.js';
import { getActiveTab } from './tabs.js';

export function initLightbox() {
  const lightbox = document.createElement("div");
  lightbox.className = "imageLightbox";
  lightbox.innerHTML = `<button class="imageLightboxClose" aria-label="关闭">×</button><button class="imageLightboxNav imageLightboxPrev" aria-label="上一张">‹</button><button class="imageLightboxNav imageLightboxNext" aria-label="下一张">›</button><img />`;
  document.body.appendChild(lightbox);

  const lbImg = lightbox.querySelector("img");
  const lbClose = lightbox.querySelector(".imageLightboxClose");
  const lbPrev = lightbox.querySelector(".imageLightboxPrev");
  const lbNext = lightbox.querySelector(".imageLightboxNext");

  let scale = 1;
  let translateX = 0;
  let translateY = 0;
  let isDragging = false;
  let didDrag = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let translateStartX = 0;
  let translateStartY = 0;

  function updateTransform() {
    lbImg.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scale})`;
  }

  function resetView() {
    scale = 1;
    translateX = 0;
    translateY = 0;
    lightbox.classList.remove("isZoomed", "isDragging");
    lbImg.style.transform = "";
  }

  let currentImageIndex = -1;
  let externalSrcs = null;

  function getAllImageSrcs() {
    if (externalSrcs) return externalSrcs;
    const srcs = [];
    const imgs = dom.messagesEl.querySelectorAll(".messageImage, .generatedImage");
    for (const img of imgs) {
      if (img.classList.contains("generatedImage")) {
        srcs.push(img.dataset.fullSrc || img.src);
      } else if (img.classList.contains("messageImage")) {
        const msgIndex = img.dataset.msgIndex;
        if (msgIndex !== undefined) {
          const msg = getActiveTab().messages[Number(msgIndex)];
          const imgIndex = Number(img.dataset.imgIndex) || 0;
          if (msg && msg.images && msg.images[imgIndex]) {
            const full = msg.images[imgIndex];
            srcs.push(full.startsWith("data:") ? full : `data:image/jpeg;base64,${full}`);
          } else {
            srcs.push(img.src);
          }
        } else {
          srcs.push(img.src);
        }
      }
    }
    return srcs;
  }

  function openLightbox(src, srcs) {
    externalSrcs = srcs || null;
    lbImg.src = src;
    resetView();
    const allSrcs = getAllImageSrcs();
    currentImageIndex = allSrcs.indexOf(src);
    if (currentImageIndex === -1) {
      if (!externalSrcs) {
        const imgs = dom.messagesEl.querySelectorAll(".messageImage, .generatedImage");
        for (let i = 0; i < imgs.length; i++) {
          const imgSrc = imgs[i].dataset.fullSrc || imgs[i].src;
          if (imgSrc === src || imgs[i].src === src) {
            currentImageIndex = i;
            break;
          }
        }
      } else {
        currentImageIndex = 0;
      }
    }
    const showNav = allSrcs.length > 1;
    lbPrev.style.display = showNav ? "" : "none";
    lbNext.style.display = showNav ? "" : "none";
    lightbox.classList.add("isOpen");
  }

  function navigateImage(direction) {
    const allSrcs = getAllImageSrcs();
    if (allSrcs.length === 0) return;
    if (currentImageIndex === -1) currentImageIndex = 0;
    currentImageIndex = (currentImageIndex + direction + allSrcs.length) % allSrcs.length;
    lbImg.src = allSrcs[currentImageIndex];
    resetView();
  }

  function closeLightbox() {
    lightbox.classList.remove("isOpen");
    resetView();
    externalSrcs = null;
  }

  lbClose.addEventListener("click", (e) => { e.stopPropagation(); closeLightbox(); });
  lbPrev.addEventListener("click", (e) => { e.stopPropagation(); navigateImage(-1); });
  lbNext.addEventListener("click", (e) => { e.stopPropagation(); navigateImage(1); });

  lightbox.addEventListener("click", (e) => {
    if (didDrag) { didDrag = false; return; }
    if (e.target === lbImg) {
      if (scale <= 1) {
        const rect = lbImg.getBoundingClientRect();
        const displayedW = rect.width;
        const displayedH = rect.height;
        const vw = lightbox.clientWidth;
        const vh = lightbox.clientHeight;
        scale = Math.min(vw / displayedW, vh / displayedH);
        const natW = lbImg.naturalWidth;
        const natH = lbImg.naturalHeight;
        const maxScale = Math.max(natW / displayedW, natH / displayedH);
        scale = Math.min(scale, maxScale);
        if (scale <= 1) return;
        const clickRelX = (e.clientX - rect.left) / displayedW - 0.5;
        const clickRelY = (e.clientY - rect.top) / displayedH - 0.5;
        translateX = -clickRelX * displayedW * (scale - 1);
        translateY = -clickRelY * displayedH * (scale - 1);
        lightbox.classList.add("isZoomed");
        updateTransform();
      } else {
        resetView();
      }
    } else if (e.target === lightbox) {
      closeLightbox();
    }
  });

  lightbox.addEventListener("wheel", (e) => {
    if (!lightbox.classList.contains("isOpen")) return;
    e.preventDefault();
    const oldScale = scale;
    const zoomFactor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    const rect0 = lbImg.getBoundingClientRect();
    const fitScale0 = Math.min(rect0.width / lbImg.naturalWidth, rect0.height / lbImg.naturalHeight, 1) / scale;
    const maxScale = 1 / fitScale0;
    const newScale = Math.max(0.2, Math.min(maxScale, scale * zoomFactor));
    if (newScale >= maxScale && oldScale >= maxScale) return;
    if (newScale === oldScale) return;
    const rect = lbImg.getBoundingClientRect();
    const cx = e.clientX - rect.left - rect.width / 2;
    const cy = e.clientY - rect.top - rect.height / 2;
    translateX = translateX - cx * (newScale / oldScale - 1);
    translateY = translateY - cy * (newScale / oldScale - 1);
    scale = newScale;
    if (scale !== 1) {
      lightbox.classList.add("isZoomed");
    } else {
      lightbox.classList.remove("isZoomed");
      translateX = 0;
      translateY = 0;
    }
    updateTransform();
  }, { passive: false });

  lbImg.addEventListener("mousedown", (e) => {
    if (scale === 1) return;
    if (e.button !== 0) return;
    e.preventDefault();
    isDragging = false;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    translateStartX = translateX;
    translateStartY = translateY;
    lightbox.classList.add("isDragging");

    function onMouseMove(ev) {
      const dx = ev.clientX - dragStartX;
      const dy = ev.clientY - dragStartY;
      if (!isDragging && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) isDragging = true;
      translateX = translateStartX + dx;
      translateY = translateStartY + dy;
      updateTransform();
    }

    function onMouseUp() {
      lightbox.classList.remove("isDragging");
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      if (isDragging) didDrag = true;
      isDragging = false;
    }

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  });

  document.addEventListener("keydown", (e) => {
    if (!lightbox.classList.contains("isOpen")) return;
    if (e.key === "Escape") {
      closeLightbox();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      navigateImage(-1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      navigateImage(1);
    }
  });

  dom.messagesEl.addEventListener("dblclick", (e) => {
    const img = e.target.closest(".messageImage");
    if (!img) return;
    e.stopPropagation();
    let src = img.src;
    const msgIndex = img.dataset.msgIndex;
    if (msgIndex !== undefined) {
      const msg = getActiveTab().messages[Number(msgIndex)];
      const imgIndex = Number(img.dataset.imgIndex) || 0;
      if (msg && msg.images && msg.images[imgIndex]) {
        const full = msg.images[imgIndex];
        src = full.startsWith("data:") ? full : `data:image/jpeg;base64,${full}`;
      }
    }
    openLightbox(src);
  });

  dom.messagesEl.addEventListener("dblclick", (e) => {
    const img = e.target.closest(".generatedImage");
    if (!img) return;
    e.stopPropagation();
    openLightbox(img.dataset.fullSrc || img.src);
  });

  return { openLightbox, getAllImageSrcs };
}
