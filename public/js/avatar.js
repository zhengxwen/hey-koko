// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

// Avatar styles, picker, and state machine
import { dom, state } from './state.js';
import { AVATAR_KEY, AVATAR_STYLES } from './constants.js';
import { t } from './i18n.js';

function parseSvgContent(svgInner) {
  const wrapped = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120">${svgInner}</svg>`;
  const doc = new DOMParser().parseFromString(wrapped, "image/svg+xml");
  return doc.documentElement;
}

// The picker shows only two slots: the avatar in use + the previously-used one.
// The rest live in a hover flyout (see showFlyout).
const AVATAR_PREV_KEY = "local-ai-companion-avatar-prev";

function currentAvatarId() {
  const id = localStorage.getItem(AVATAR_KEY);
  return AVATAR_STYLES[id] ? id : "dark-girl";
}

// Previously-used avatar. Falls back to the first style that isn't the current
// one, so the second slot is never empty on a fresh profile.
function prevAvatarId() {
  const cur = currentAvatarId();
  const p = localStorage.getItem(AVATAR_PREV_KEY);
  if (AVATAR_STYLES[p] && p !== cur) return p;
  return Object.keys(AVATAR_STYLES).find((id) => id !== cur);
}

function makeAvatarThumb(id, isActive) {
  const item = document.createElement("div");
  item.className = "avatar-picker-item" + (isActive ? " is-active" : "");
  item.dataset.style = id;
  item.title = t(`avatar_${id}`);
  item.appendChild(parseSvgContent(AVATAR_STYLES[id].svg));
  item.addEventListener("click", () => applyAvatarStyle(id));
  return item;
}

function applyAvatarStyle(styleId) {
  const style = AVATAR_STYLES[styleId];
  if (!style) return;
  // Switching away demotes the outgoing avatar to the "last used" slot.
  const cur = localStorage.getItem(AVATAR_KEY);
  if (cur && cur !== styleId && AVATAR_STYLES[cur]) localStorage.setItem(AVATAR_PREV_KEY, cur);
  localStorage.setItem(AVATAR_KEY, styleId);
  const parsed = parseSvgContent(style.svg);
  dom.avatarSvg.innerHTML = "";
  while (parsed.firstChild) dom.avatarSvg.appendChild(parsed.firstChild);
  renderAvatarPicker();
  // Keep an open flyout usable after a pick (its contents just changed).
  if (flyoutEl && !flyoutEl.hidden) showFlyout();
}

function renderAvatarPicker() {
  const cur = currentAvatarId();
  const prev = prevAvatarId();
  dom.avatarPicker.innerHTML = "";
  dom.avatarPicker.appendChild(makeAvatarThumb(cur, true));
  if (prev) dom.avatarPicker.appendChild(makeAvatarThumb(prev, false));
}

// ---- hover flyout: the avatars NOT in the two slots -------------------------
// Fixed-position and mounted on <body> on purpose: the side panel is
// `overflow: hidden` (its scrolling lives inside each tab), and only ~19px of it
// sits right of the picker — an absolutely-positioned flyout would be clipped.
let flyoutEl = null;
let flyoutTimer = null;

function ensureFlyout() {
  if (flyoutEl) return flyoutEl;
  flyoutEl = document.createElement("div");
  flyoutEl.className = "avatarFlyout";
  flyoutEl.hidden = true;
  flyoutEl.addEventListener("mouseenter", () => clearTimeout(flyoutTimer));
  flyoutEl.addEventListener("mouseleave", scheduleHideFlyout);
  document.body.appendChild(flyoutEl);
  return flyoutEl;
}

function showFlyout() {
  clearTimeout(flyoutTimer);
  const cur = currentAvatarId();
  const prev = prevAvatarId();
  const others = Object.keys(AVATAR_STYLES).filter((id) => id !== cur && id !== prev);
  if (!others.length) return;
  const fly = ensureFlyout();
  fly.innerHTML = "";
  for (const id of others) fly.appendChild(makeAvatarThumb(id, false));
  fly.hidden = false;
  // Anchor to the right of the two slots, vertically centred; clamp to viewport.
  const r = dom.avatarPicker.getBoundingClientRect();
  fly.style.left = `${r.right + 8}px`;
  fly.style.top = `${r.top + r.height / 2}px`;
  const fr = fly.getBoundingClientRect();
  if (fr.right > window.innerWidth - 8) {
    fly.style.left = `${Math.max(8, window.innerWidth - 8 - fr.width)}px`;
  }
}

function scheduleHideFlyout() {
  clearTimeout(flyoutTimer);
  // Grace period so the cursor can cross the gap into the flyout.
  flyoutTimer = setTimeout(() => { if (flyoutEl) flyoutEl.hidden = true; }, 180);
}

// True when the currently-selected model is a cloud (Claude) model. The dropdown
// tags cloud options with data-cloud="1" (see ollama.js loadModels). Single source
// of truth for the avatar badge AND the send-status pill.
export function isCloudModel() {
  return dom.modelSelect?.selectedOptions?.[0]?.dataset.cloud === "1";
}

// Show/hide the persistent ☁️ avatar badge based on the selected model, and set
// its tooltip to the specific cloud model name. Call on model change and after
// the model list (re)loads.
export function updateCloudBadge() {
  if (!dom.avatarCloudBadge) return;
  const cloud = isCloudModel();
  dom.avatarCloudBadge.hidden = !cloud;
  if (cloud) dom.avatarCloudBadge.title = t("cloud_badge_tooltip", { model: dom.modelSelect.value });
}

// Avatar state machine
export function setAvatarState(newState) {
  state.avatarState = newState;
  dom.avatarContainer.className = "avatar-container";
  if (newState !== "idle") {
    dom.avatarContainer.classList.add(`is-${newState}`);
  }
  if (newState === "idle") {
    startBlinkLoop();
  } else {
    stopBlinkLoop();
    dom.avatarContainer.classList.remove("avatar-blink");
  }
}

function doBlink() {
  if (state.avatarState !== "idle") return;
  dom.avatarContainer.classList.add("avatar-blink");
  setTimeout(() => dom.avatarContainer.classList.remove("avatar-blink"), 150);
}

function startBlinkLoop() {
  stopBlinkLoop();
  function scheduleBlink() {
    const delay = 2000 + Math.random() * 3000;
    state.blinkTimer = setTimeout(() => {
      doBlink();
      scheduleBlink();
    }, delay);
  }
  scheduleBlink();
}

function stopBlinkLoop() {
  if (state.blinkTimer) {
    clearTimeout(state.blinkTimer);
    state.blinkTimer = null;
  }
}

export function detectExpression(text) {
  if (/哈哈|开心|喜欢|❤|嘻嘻|太好了|好棒|可爱|爱你|～|~|♡|😊|😄/.test(text)) return "happy";
  if (/害羞|不好意思|人家|脸红|羞羞/.test(text)) return "shy";
  return null;
}

export function showExpression(expression) {
  if (!expression) {
    setAvatarState("idle");
    return;
  }
  if (state.expressionTimer) clearTimeout(state.expressionTimer);
  setAvatarState(expression);
  state.expressionTimer = setTimeout(() => setAvatarState("idle"), 2500);
}

// Re-localize the avatar picker tooltips after a UI-language switch, in place so
// the active-selection state is preserved.
export function relocalizeAvatarPicker() {
  document.querySelectorAll(".avatar-picker-item").forEach((el) => {
    el.title = t(`avatar_${el.dataset.style}`);
  });
}

export function initAvatar() {
  applyAvatarStyle(currentAvatarId());   // also renders the two picker slots
  dom.avatarPicker.addEventListener("mouseenter", showFlyout);
  dom.avatarPicker.addEventListener("mouseleave", scheduleHideFlyout);
  // The flyout is viewport-anchored, so a scroll/resize would strand it.
  window.addEventListener("resize", () => { if (flyoutEl) flyoutEl.hidden = true; });
  startBlinkLoop();
}