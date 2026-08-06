// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

// Image lightbox
import { dom, state, applyVideoAudio, trackVideoAudio } from './state.js';
import { getActiveTab } from './tabs.js';
import { t } from './i18n.js';

export function initLightbox() {
  const lightbox = document.createElement("div");
  lightbox.className = "imageLightbox";
  lightbox.innerHTML = `<div class="imageLightboxCaption"></div><button class="imageLightboxClose" aria-label="${t("lb_close")}">×</button><button class="imageLightboxNav imageLightboxPrev" aria-label="${t("lb_prevImage")}">‹</button><button class="imageLightboxNav imageLightboxNext" aria-label="${t("lb_nextImage")}">›</button><img />`;
  document.body.appendChild(lightbox);

  const lbImg = lightbox.querySelector("img");
  const lbCaption = lightbox.querySelector(".imageLightboxCaption");
  const lbClose = lightbox.querySelector(".imageLightboxClose");
  const lbPrev = lightbox.querySelector(".imageLightboxPrev");
  const lbNext = lightbox.querySelector(".imageLightboxNext");

  // The filename shown at the top. Chat media carries it in data-filename (the same
  // name the download button uses); archive/library pass real srcs, so fall back to
  // the URL basename. Data/blob URLs have no meaningful name → no caption.
  function basenameFromUrl(src) {
    if (!src || src.startsWith("data:") || src.startsWith("blob:")) return "";
    try { return decodeURIComponent(src.split(/[?#]/)[0].split("/").pop() || ""); } catch { return ""; }
  }
  function updateCaption() {
    let name = "", total = 0;
    if (externalSrcs) {
      total = externalSrcs.length;
      // Archive/library pass their own names aligned with the srcs — use those
      // directly (a document-wide src search can mis-hit the same image elsewhere).
      // Fall back to the URL basename when no name was supplied.
      name = (externalNames && externalNames[currentImageIndex])
        || basenameFromUrl(externalSrcs[currentImageIndex]);
    } else {
      const els = dom.messagesEl.querySelectorAll(".messageImage, .generatedImage");
      total = els.length;
      name = els[currentImageIndex]?.dataset.filename || "";
    }
    // The position always changes on navigation — useful on its own, and it makes a
    // colliding/identical filename obviously not "frozen".
    const pos = total > 1 ? `${currentImageIndex + 1}/${total}` : "";
    const label = [name, pos].filter(Boolean).join("　·　");
    lbCaption.textContent = label;
    lbCaption.style.display = label ? "" : "none";
  }

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
  let externalNames = null; // filenames aligned with externalSrcs (archive/library)

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
          if (msg && msg.contextImages && msg.contextImages[imgIndex]) {
            const full = msg.contextImages[imgIndex];
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

  function openLightbox(src, srcs, names) {
    externalSrcs = srcs || null;
    externalNames = names || null;
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
    updateCaption();
    lightbox.classList.add("isOpen");
  }

  function navigateImage(direction) {
    const allSrcs = getAllImageSrcs();
    if (allSrcs.length === 0) return;
    if (currentImageIndex === -1) currentImageIndex = 0;
    currentImageIndex = (currentImageIndex + direction + allSrcs.length) % allSrcs.length;
    lbImg.src = allSrcs[currentImageIndex];
    resetView();
    updateCaption();
  }

  function closeLightbox() {
    lightbox.classList.remove("isOpen");
    resetView();
    externalSrcs = null;
    externalNames = null;
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
      if (msg && msg.contextImages && msg.contextImages[imgIndex]) {
        const full = msg.contextImages[imgIndex];
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

  // Inline markdown ![](name) thumbnails (same-bubble image refs).
  dom.messagesEl.addEventListener("dblclick", (e) => {
    const img = e.target.closest(".mdBubbleThumb");
    if (!img) return;
    e.stopPropagation();
    openLightbox(img.dataset.fullSrc || img.src);
  });

  return { openLightbox, getAllImageSrcs };
}

// Full-window video viewer — a fixed overlay (like the image lightbox), NOT OS
// fullscreen. It exists to gain ‹ › prev/next across all the conversation's clips,
// which native video fullscreen lacks. Keeping it a windowed overlay means the inner
// <video>'s own native fullscreen + Picture-in-Picture buttons keep working (click
// native fullscreen → true OS fullscreen of the clip, exit → back to the overlay).
// Opened via the ⛶ button on each video wrapper (see renderMessage).
export function initVideoLightbox() {
  const overlay = document.createElement("div");
  overlay.className = "videoLightbox";
  overlay.innerHTML = `<div class="videoLightboxCaption"></div><button class="videoLightboxClose" aria-label="${t("lb_close")}">×</button><button class="videoLightboxNav videoLightboxPrev" aria-label="${t("lb_prevVideo")}">‹</button><button class="videoLightboxNav videoLightboxNext" aria-label="${t("lb_nextVideo")}">›</button>`;
  const video = document.createElement("video");
  video.className = "videoLightboxVideo";
  video.controls = true;
  video.loop = true;        // keep looping in the viewer, like the inline player
  video.playsInline = true;
  // The viewer is a full-window overlay (not OS fullscreen), so the inner video's
  // own native fullscreen + Picture-in-Picture buttons stay fully functional.
  overlay.appendChild(video);
  document.body.appendChild(overlay);

  const vCaption = overlay.querySelector(".videoLightboxCaption");
  const vClose = overlay.querySelector(".videoLightboxClose");
  const vPrev = overlay.querySelector(".videoLightboxPrev");
  const vNext = overlay.querySelector(".videoLightboxNext");

  let videos = [];       // the conversation's <video.generatedVideo> elements, in order
  let currentIndex = -1;
  // Mute/volume is the app-wide shared setting (state.js), not a viewer-local one, so
  // it carries between the inline players and this viewer in both directions.
  trackVideoAudio(video);

  function loadIndex(i, autoplay) {
    const srcVideo = videos[i];
    if (!srcVideo) return;
    currentIndex = i;
    // The source clip may still be lazy (off-screen) — force its blob src in.
    if (state.loadVideoNow) state.loadVideoNow(srcVideo);
    const name = srcVideo.dataset.filename || "";
    const pos = videos.length > 1 ? `${i + 1}/${videos.length}` : "";
    const label = [name, pos].filter(Boolean).join("　·　");
    vCaption.textContent = label;
    vCaption.style.display = label ? "" : "none";
    video.poster = srcVideo.poster || "";
    video.src = srcVideo.currentSrc || srcVideo.src || "";
    applyVideoAudio(video);
    if (autoplay) video.play().catch(() => {});
    const showNav = videos.length > 1;
    vPrev.style.display = showNav ? "" : "none";
    vNext.style.display = showNav ? "" : "none";
  }

  function navigate(dir) {
    if (videos.length === 0) return;
    loadIndex((currentIndex + dir + videos.length) % videos.length, true);
  }

  function openVideoLightbox(sourceVideo) {
    videos = Array.from(dom.messagesEl.querySelectorAll("video.generatedVideo"));
    const idx = videos.indexOf(sourceVideo);
    videos.forEach((v) => { if (!v.paused) v.pause(); }); // no double audio with the inline player
    video.controls = true;  // reset (a prior keyboard-nav may have hidden them)
    overlay.classList.add("isOpen");
    loadIndex(idx >= 0 ? idx : 0, true);
  }

  function closeVideoLightbox() {
    if (!overlay.classList.contains("isOpen")) return;
    overlay.classList.remove("isOpen");
    video.pause();
    video.removeAttribute("src");
    video.load();
  }

  vClose.addEventListener("click", (e) => { e.stopPropagation(); closeVideoLightbox(); });
  vPrev.addEventListener("click", (e) => { e.stopPropagation(); navigate(-1); });
  vNext.addEventListener("click", (e) => { e.stopPropagation(); navigate(1); });
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeVideoLightbox(); });

  // Keep keyboard focus on the nav buttons, never the <video>: a focused video flashes
  // its gray native-controls scrim on every arrow keypress. The user browses clips with
  // ← →, so the buttons are the right focus target. Clicking the video (e.g. to pause)
  // would otherwise focus it — bounce focus straight back to a button.
  video.addEventListener("focus", () => {
    if (overlay.classList.contains("isOpen") && videos.length > 1) vNext.focus();
  });

  // Keyboard nav hides the native controls (above); a mouse move restores them so the
  // play/seek/fullscreen/PiP bar is one mouse twitch away when the user wants it.
  overlay.addEventListener("mousemove", () => { if (!video.controls) video.controls = true; });

  document.addEventListener("keydown", (e) => {
    if (!overlay.classList.contains("isOpen")) return;
    if (e.key === "Escape") {
      // If the inner video is in its own native fullscreen, let Esc just exit that
      // (the browser handles it) and keep the viewer open.
      if (document.fullscreenElement) return;
      closeVideoLightbox();
    }
    // Focus the matching nav button so the keypress lands on it, not the video, then
    // drop the native controls outright — reloading the clip otherwise re-shows them
    // (with the gray scrim) for the ~3s auto-hide timeout. A mousemove brings them back.
    else if (e.key === "ArrowLeft") { e.preventDefault(); vPrev.focus(); navigate(-1); video.controls = false; }
    else if (e.key === "ArrowRight") { e.preventDefault(); vNext.focus(); navigate(1); video.controls = false; }
  });

  return { openVideoLightbox };
}