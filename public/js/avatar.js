// Avatar styles, picker, and state machine
import { dom, state } from './state.js';
import { AVATAR_KEY, AVATAR_STYLES } from './constants.js';

function parseSvgContent(svgInner) {
  const wrapped = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120">${svgInner}</svg>`;
  const doc = new DOMParser().parseFromString(wrapped, "image/svg+xml");
  return doc.documentElement;
}

function applyAvatarStyle(styleId) {
  const style = AVATAR_STYLES[styleId];
  if (!style) return;
  const parsed = parseSvgContent(style.svg);
  dom.avatarSvg.innerHTML = "";
  while (parsed.firstChild) dom.avatarSvg.appendChild(parsed.firstChild);
  localStorage.setItem(AVATAR_KEY, styleId);
  document.querySelectorAll(".avatar-picker-item").forEach((el) => {
    el.classList.toggle("is-active", el.dataset.style === styleId);
  });
}

function renderAvatarPicker() {
  dom.avatarPicker.innerHTML = "";
  for (const [id, style] of Object.entries(AVATAR_STYLES)) {
    const item = document.createElement("div");
    item.className = "avatar-picker-item";
    item.dataset.style = id;
    item.title = style.name;
    const thumbSvg = parseSvgContent(style.svg);
    item.appendChild(thumbSvg);
    item.addEventListener("click", () => applyAvatarStyle(id));
    dom.avatarPicker.appendChild(item);
  }
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

export function initAvatar() {
  renderAvatarPicker();
  applyAvatarStyle(localStorage.getItem(AVATAR_KEY) || "dark-girl");
  startBlinkLoop();
}
