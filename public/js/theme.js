// Theme system (dark/light mode, accent colors)
import { dom, state } from './state.js';
import { SETTINGS_KEY } from './constants.js';

const darkMediaQuery = window.matchMedia("(prefers-color-scheme: dark)");

function resolveMode(mode) {
  if (mode === "system") return darkMediaQuery.matches ? "dark" : "light";
  return mode;
}

function applyMode(mode) {
  state.currentThemeMode = mode;
  const resolved = resolveMode(mode);
  document.documentElement.setAttribute("data-mode", resolved);
  const hljsLight = document.querySelector("#hljsThemeLight");
  const hljsDark = document.querySelector("#hljsThemeDark");
  if (hljsLight && hljsDark) {
    hljsLight.disabled = resolved === "dark";
    hljsDark.disabled = resolved !== "dark";
  }
  if (typeof mermaid !== "undefined") {
    mermaid.initialize({ startOnLoad: false, theme: resolved === "dark" ? "dark" : "default", flowchart: { nodeSpacing: 20, rankSpacing: 30 } });
  }
  dom.modeToggle.querySelectorAll(".modeToggleBtn").forEach((btn) => {
    btn.classList.toggle("isActive", btn.dataset.mode === mode);
  });
}

function applyTheme(theme) {
  state.currentThemeAccent = theme;
  document.documentElement.setAttribute("data-theme", theme);
  dom.themeColorPicker.querySelectorAll(".themeColorDot").forEach((dot) => {
    dot.classList.toggle("isActive", dot.dataset.theme === theme);
  });
}

function triggerThemeTransition() {
  document.documentElement.classList.add("theme-transitioning");
  setTimeout(() => document.documentElement.classList.remove("theme-transitioning"), 400);
}

export function initTheme(saveSettingsFn) {
  // Load from localStorage
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    if (s.themeMode) state.currentThemeMode = s.themeMode;
    if (s.themeAccent) state.currentThemeAccent = s.themeAccent;
  } catch (e) {}
  applyMode(state.currentThemeMode);
  applyTheme(state.currentThemeAccent);

  // Mode toggle click
  dom.modeToggle.addEventListener("click", (e) => {
    const btn = e.target.closest(".modeToggleBtn");
    if (!btn) return;
    triggerThemeTransition();
    applyMode(btn.dataset.mode);
    saveSettingsFn();
  });

  // Theme color picker click
  dom.themeColorPicker.addEventListener("click", (e) => {
    const dot = e.target.closest(".themeColorDot");
    if (!dot) return;
    triggerThemeTransition();
    applyTheme(dot.dataset.theme);
    saveSettingsFn();
  });

  // System preference changes
  darkMediaQuery.addEventListener("change", () => {
    if (state.currentThemeMode === "system") {
      triggerThemeTransition();
      applyMode("system");
    }
  });
}
