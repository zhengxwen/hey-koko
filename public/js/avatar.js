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

// Slot 1 holds the avatar already in use, so clicking it cannot mean "select" —
// which frees it to open the flyout. That is the only way to reach the other
// four without a mouse: touch has no hover, and hover was the sole entry point.
// <button> rather than <div> so the slots are tabbable and Enter/Space work.
function makeAvatarThumb(id, { isActive = false, opensFlyout = false } = {}) {
  const item = document.createElement("button");
  item.type = "button";
  item.className = "avatar-picker-item" + (isActive ? " is-active" : "");
  item.dataset.style = id;
  if (opensFlyout) {
    item.dataset.opensFlyout = "1";
    item.setAttribute("aria-expanded", String(isFlyoutOpen()));
  }
  item.title = opensFlyout ? t("avatar_more") : t(`avatar_${id}`);
  item.setAttribute("aria-label", item.title);
  item.appendChild(parseSvgContent(AVATAR_STYLES[id].svg));
  item.addEventListener("click", (e) => {
    // Move focus only for keyboard activation: detail 0 means Enter/Space rather
    // than a pointer, and :focus-visible is the browser's own read on whether
    // this interaction is keyboard-driven.
    const byKeyboard = e.detail === 0 || item.matches(":focus-visible");
    if (opensFlyout) {
      showFlyout({ focusFirst: byKeyboard });
      return;
    }
    applyAvatarStyle(id);
    // The pick re-renders picker and flyout, destroying the button that was just
    // activated; without this, keyboard focus would drop back to <body>.
    if (byKeyboard) flyoutTrigger()?.focus();
  });
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
  if (isFlyoutOpen()) showFlyout();
}

function renderAvatarPicker() {
  const cur = currentAvatarId();
  const prev = prevAvatarId();
  dom.avatarPicker.innerHTML = "";
  dom.avatarPicker.appendChild(makeAvatarThumb(cur, { isActive: true, opensFlyout: true }));
  if (prev) dom.avatarPicker.appendChild(makeAvatarThumb(prev));
}

// ---- flyout: the avatars NOT in the two slots -------------------------------
// Reached by hover (mouse), by clicking slot 1 (touch), or by Enter on it
// (keyboard).
// Fixed-position and mounted on <body> on purpose: the side panel is
// `overflow: hidden` (its scrolling lives inside each tab), and only ~19px of it
// sits right of the picker — an absolutely-positioned flyout would be clipped.
let flyoutEl = null;
let flyoutTimer = null;

// Hover is a mouse-only affordance. A tap makes Chrome replay a compatibility
// mouse burst — including a mouseleave right after the tap, which would shut the
// flyout the tap just opened. Pointer events carry the real input type, so the
// touch replay never reaches the hover path.
function isMouse(e) {
  return e.pointerType === "mouse";
}

function ensureFlyout() {
  if (flyoutEl) return flyoutEl;
  flyoutEl = document.createElement("div");
  flyoutEl.className = "avatarFlyout";
  flyoutEl.hidden = true;
  flyoutEl.addEventListener("pointerenter", (e) => { if (isMouse(e)) clearTimeout(flyoutTimer); });
  flyoutEl.addEventListener("pointerleave", (e) => { if (isMouse(e)) scheduleHideFlyout(); });
  document.body.appendChild(flyoutEl);
  return flyoutEl;
}

function isFlyoutOpen() {
  return !!flyoutEl && !flyoutEl.hidden;
}

function flyoutTrigger() {
  return dom.avatarPicker.querySelector("[data-opens-flyout]");
}

// Opens; never toggles shut, so the trigger cannot fight the hover path for
// devices that report both. Closing is pointerleave (mouse), Escape, or a
// pointer landing outside.
function showFlyout({ focusFirst = false } = {}) {
  clearTimeout(flyoutTimer);
  const cur = currentAvatarId();
  const prev = prevAvatarId();
  const others = Object.keys(AVATAR_STYLES).filter((id) => id !== cur && id !== prev);
  if (!others.length) return;
  const fly = ensureFlyout();
  fly.innerHTML = "";
  for (const id of others) fly.appendChild(makeAvatarThumb(id));
  fly.hidden = false;
  // Anchor to the right of the two slots, vertically centred; clamp to viewport.
  const r = dom.avatarPicker.getBoundingClientRect();
  fly.style.left = `${r.right + 8}px`;
  fly.style.top = `${r.top + r.height / 2}px`;
  const fr = fly.getBoundingClientRect();
  if (fr.right > window.innerWidth - 8) {
    fly.style.left = `${Math.max(8, window.innerWidth - 8 - fr.width)}px`;
  }
  flyoutTrigger()?.setAttribute("aria-expanded", "true");
  document.addEventListener("keydown", onFlyoutKeydown, true);
  document.addEventListener("pointerdown", onPointerDownOutside, true);
  if (focusFirst) fly.firstChild?.focus();
}

function hideFlyout({ restoreFocus = false } = {}) {
  clearTimeout(flyoutTimer);
  if (flyoutEl) flyoutEl.hidden = true;
  document.removeEventListener("keydown", onFlyoutKeydown, true);
  document.removeEventListener("pointerdown", onPointerDownOutside, true);
  const trigger = flyoutTrigger();
  if (!trigger) return;
  trigger.setAttribute("aria-expanded", "false");
  if (restoreFocus) trigger.focus();
}

function onFlyoutKeydown(e) {
  if (e.key === "Escape") hideFlyout({ restoreFocus: true });
}

function onPointerDownOutside(e) {
  // The picker is not "outside": its trigger reopens, and slot 2 still selects.
  if (flyoutEl?.contains(e.target) || dom.avatarPicker.contains(e.target)) return;
  hideFlyout();
}

function scheduleHideFlyout() {
  clearTimeout(flyoutTimer);
  // Grace period so the cursor can cross the gap into the flyout. Keyboard focus
  // inside the flyout outranks the mouse having wandered off.
  flyoutTimer = setTimeout(() => {
    if (flyoutEl?.contains(document.activeElement)) return;
    hideFlyout();
  }, 180);
}

// True when the currently-selected model runs in the cloud rather than on this
// machine — Claude, OpenAI, DeepSeek, OpenRouter, xAI, Qwen alike; the badge is a
// local-vs-cloud cue and does not distinguish providers. The dropdown tags cloud
// options with data-cloud="1" (see ollama.js loadModels). Single source of truth
// for the avatar badge AND the send-status pill.
export function isCloudModel() {
  return dom.modelSelect?.selectedOptions?.[0]?.dataset.cloud === "1";
}

// The OTHER question, and the one every user-facing cue wants: does this model live
// somewhere else? A self-hosted llama.cpp/vLLM on your own machine or LAN answers an
// OpenAI-shaped API — so it travels the cloud CODE PATH (isCloudModel above, which
// picks the transport) while nothing it is told ever leaves the house. Badges, pills
// and anything else that tells the user "this is going out" must ask THIS one.
export function isOffPremisesModel() {
  const opt = dom.modelSelect?.selectedOptions?.[0];
  return opt?.dataset.cloud === "1" && opt.dataset.lan !== "1";
}

// Show/hide the persistent ☁️ avatar badge based on the selected model, naming the
// specific model in both the tooltip and the accessible label — a sighted user
// gets the emoji, everyone else needs the label to reach the same cue. Call on
// model change and after the model list (re)loads.
export function updateCloudBadge() {
  if (!dom.avatarCloudBadge) return;
  const cloud = isOffPremisesModel();
  dom.avatarCloudBadge.hidden = !cloud;
  if (!cloud) return;
  const label = t("cloud_badge_tooltip", { model: dom.modelSelect.value });
  dom.avatarCloudBadge.title = label;
  dom.avatarCloudBadge.setAttribute("aria-label", label);
}

// Clicking the face steps through the states and holds there. An expression only
// lasts 2.5s and lands while you are reading the reply, not watching the panel —
// so without this there is no way to see what Bella actually did, or to preview a
// style you are about to pick. Real activity overrides it: the next request sets
// thinking like always.
const EXPRESSION_CYCLE = ["idle", "thinking", "talking", "happy", "shy"];

function cycleExpression() {
  const i = EXPRESSION_CYCLE.indexOf(state.avatarState);
  setAvatarState(EXPRESSION_CYCLE[(i + 1) % EXPRESSION_CYCLE.length]);
}

// The button needs a name anyway, so spend it on the thing that is otherwise
// impossible to know: which expression is on screen right now.
function updateFaceLabel() {
  if (!dom.avatarFace) return;
  const label = `${t(`avatar_state_${state.avatarState}`)} · ${t("avatar_cycleHint")}`;
  dom.avatarFace.title = label;
  dom.avatarFace.setAttribute("aria-label", label);
}

// Avatar state machine
export function setAvatarState(newState) {
  state.avatarState = newState;
  // A pending expression revert belongs to the state we are leaving. Letting it
  // survive means a reply that ended happy drops the face back to idle 2.5s
  // later — stomping a "thinking" that a new request has since set.
  if (state.expressionTimer) {
    clearTimeout(state.expressionTimer);
    state.expressionTimer = null;
  }
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
  updateFaceLabel();
}

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

function doBlink() {
  if (state.avatarState !== "idle") return;
  dom.avatarContainer.classList.add("avatar-blink");
  setTimeout(() => dom.avatarContainer.classList.remove("avatar-blink"), 150);
}

// Blinking is movement with no information in it, so reduced motion skips it
// outright. A hidden tab pauses it too: the CSS loops idle themselves when the
// page is not rendered, but this timer would keep firing into a tab nobody sees.
function startBlinkLoop() {
  stopBlinkLoop();
  if (reduceMotion.matches || document.hidden) return;
  function scheduleBlink() {
    const delay = 2000 + Math.random() * 3000;
    state.blinkTimer = setTimeout(() => {
      doBlink();
      scheduleBlink();
    }, delay);
  }
  scheduleBlink();
}

// Both conditions can flip while the app is open — the OS setting mid-session, or
// the tab going to the background. Re-evaluate rather than latch at startup.
function refreshBlinkLoop() {
  if (state.avatarState !== "idle") return;
  if (reduceMotion.matches || document.hidden) stopBlinkLoop();
  else startBlinkLoop();
}

function stopBlinkLoop() {
  if (state.blinkTimer) {
    clearTimeout(state.blinkTimer);
    state.blinkTimer = null;
  }
}

// Bella's face is driven by what she just said, so these read the reply text.
//
// Every language is tested at once rather than switching on the UI locale: the
// reply's language follows the persona and the user's own wording, not the
// interface setting, and a Chinese cue cannot appear in an English sentence
// anyway — so the union costs nothing and removes a whole class of "wrong list
// selected" bugs. Emoji come first because they are the only language-neutral
// layer: they carry Japanese, Korean, Spanish and the rest for free.
//
// A variation selector does not need matching — "❤️" is U+2764 U+FE0F, and the
// class matches the U+2764, so both the bare and the emoji-presentation form hit.
const HAPPY_EMOJI = /[😊😄😃😁😆🙂🥰😍🤗🥳☺❤♡💕💖✨🎉]/u;
const SHY_EMOJI = /[😳🥺🙈😅]/u;

// Stage directions: how an English or Japanese persona shows affect where a
// Chinese one would use a word.
const HAPPY_ACTION = /\*(?:giggl|laugh|grin|smil|beam|hug)\w*\*/i;
const SHY_ACTION = /\*(?:blush|shy|hide|fidget|look away)\w*\*/i;

// Marked affect only, in simplified and traditional alike. English politeness —
// "great", "happy to help", "I'd love to" — is deliberately absent: it is
// unmarked filler that would fire on nearly every reply and leave Bella grinning
// permanently. English leans on the emoji and actions above instead.
const HAPPY_WORDS = /哈哈|嘻嘻|开心|開心|喜欢|喜歡|太好了|好棒|可爱|可愛|爱你|愛你|～|\bhaha|\bhehe|\blol\b|\byay\b/i;
const SHY_WORDS = /害羞|不好意思|人家|脸红|臉紅|羞羞/;

export function detectExpression(text) {
  if (!text) return null;
  if (HAPPY_EMOJI.test(text) || HAPPY_ACTION.test(text) || HAPPY_WORDS.test(text)) return "happy";
  if (SHY_EMOJI.test(text) || SHY_ACTION.test(text) || SHY_WORDS.test(text)) return "shy";
  return null;
}

// Clear the face once a request finishes — unless an expression is on screen, in
// which case showExpression already armed the revert and owns the face until it
// fires. Callers that reset unconditionally wipe the expression in the same tick
// it was set, so it never paints at all; use this instead of setAvatarState in
// any end-of-request cleanup that can run right after a reply lands.
export function resetAvatarIdle() {
  if (state.expressionTimer) return;
  setAvatarState("idle");
}

export function showExpression(expression) {
  if (!expression) {
    setAvatarState("idle");
    return;
  }
  setAvatarState(expression);   // clears any previous revert timer
  state.expressionTimer = setTimeout(() => setAvatarState("idle"), 2500);
}

// Re-localize the avatar picker tooltips after a UI-language switch, in place so
// the active-selection state is preserved.
export function relocalizeAvatarPicker() {
  document.querySelectorAll(".avatar-picker-item").forEach((el) => {
    el.title = el.dataset.opensFlyout ? t("avatar_more") : t(`avatar_${el.dataset.style}`);
    el.setAttribute("aria-label", el.title);
  });
  updateFaceLabel();   // names the current expression, so it is language-bound too
}

export function initAvatar() {
  applyAvatarStyle(currentAvatarId());   // also renders the two picker slots
  // Hover stays the desktop path; the trigger's click covers touch and keyboard.
  dom.avatarPicker.addEventListener("pointerenter", (e) => { if (isMouse(e)) showFlyout(); });
  dom.avatarPicker.addEventListener("pointerleave", (e) => { if (isMouse(e)) scheduleHideFlyout(); });
  // The flyout is viewport-anchored, so a scroll/resize would strand it.
  window.addEventListener("resize", () => hideFlyout());
  reduceMotion.addEventListener("change", refreshBlinkLoop);
  document.addEventListener("visibilitychange", refreshBlinkLoop);
  dom.avatarFace?.addEventListener("click", cycleExpression);
  updateFaceLabel();
  startBlinkLoop();
}