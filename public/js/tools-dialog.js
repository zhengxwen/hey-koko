// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

// Tools dialog: per-tool on/off for the agentic chat loop, opened from the settings
// panel's "Choose tools…" button. Per-tool state is state.disabledTools (tools.js).
// The master switch stays in the panel only — the button is disabled while it's off,
// so the dialog never needs its own. Every click saves at once — no OK/Cancel step.
import { dom } from './state.js';
import { t } from './i18n.js';
import { escapeHtml } from './utils.js';
import { saveCurrentSettings } from './settings.js';
import { TOOL_SCHEMAS, TOOL_GROUPS, isToolEnabled, setToolEnabled } from './tools.js';

const CHROME_TOOLS = ["list_chrome_tabs", "read_chrome_page"];
const ALL_TOOLS = TOOL_SCHEMAS.map((s) => s.function.name);

const enabledCount = () => ALL_TOOLS.filter(isToolEnabled).length;

// Settings-panel button: label carries the enabled count ("Choose tools… (7/9)"), and
// it's only clickable while the master tool-use checkbox is on. Not in i18n BINDINGS
// (it has a variable), so main.js calls this on language change and master toggles.
export function refreshToolsConfigBtn() {
  if (!dom.toolsConfigBtn) return;
  dom.toolsConfigBtn.textContent = t("btn_toolsConfig", { on: enabledCount(), total: ALL_TOOLS.length });
  dom.toolsConfigBtn.disabled = !dom.toolsToggle?.checked;
}

export function openToolsDialog() {
  if (document.querySelector(".toolsDlgOverlay")) return;
  const overlay = document.createElement("div");
  overlay.className = "zoteroImportOverlay toolsDlgOverlay";   // reuse the modal chrome
  const row = (name) => `
    <label class="checkboxLabel isMultiline toolsDlgRow">
      <input type="checkbox" data-tool="${name}" ${isToolEnabled(name) ? "checked" : ""}>
      <span class="toolsDlgRowText">
        <span class="toolsDlgRowName">${escapeHtml(t("tool_" + name))}<code>${name}</code></span>
        <span class="toolsDlgRowDesc">${escapeHtml(t("toolDesc_" + name))}</span>
      </span>
    </label>`;
  const groups = TOOL_GROUPS.map((g) => `
    <section class="toolsDlgGroup">
      <div class="toolsDlgGroupHead">
        <span>${escapeHtml(t("toolsGroup_" + g.key))}</span>
        ${g.key === "web" ? `<button type="button" class="secondary toolsDlgMini" id="toolsDlgChrome">${escapeHtml(t("btn_browserLaunch"))}</button>` : ""}
      </div>
      ${g.tools.map(row).join("")}
    </section>`).join("");
  overlay.innerHTML = `
    <div class="zoteroImportDialog toolsDlg" role="dialog" aria-modal="true" aria-labelledby="toolsDlgTitle">
      <div class="zoteroImportHead">
        <span class="zoteroImportTitle" id="toolsDlgTitle">🧰 ${escapeHtml(t("toolsDlg_title"))}</span>
        <button type="button" class="zoteroImportClose" title="${escapeHtml(t("toolsDlg_close"))}">✕</button>
      </div>
      <div class="toolsDlgBody">${groups}</div>
      <div class="zoteroImportFoot">
        <span class="zoteroImportStatus" id="toolsDlgCount"></span>
        <span class="toolsDlgFootBtns">
          <button type="button" class="secondary toolsDlgMini" data-bulk="on">${escapeHtml(t("toolsDlg_all"))}</button>
          <button type="button" class="secondary toolsDlgMini" data-bulk="off">${escapeHtml(t("toolsDlg_none"))}</button>
        </span>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const chromeBtn = overlay.querySelector("#toolsDlgChrome");
  const boxes = [...overlay.querySelectorAll("input[data-tool]")];

  // Reflect current state: count, Chrome launcher (only useful while a co-browsing
  // tool is on), and the settings-panel button label.
  let launching = false;
  const sync = () => {
    overlay.querySelector("#toolsDlgCount").textContent = t("toolsDlg_count", { on: enabledCount(), total: ALL_TOOLS.length });
    if (chromeBtn && !launching) chromeBtn.disabled = !CHROME_TOOLS.some(isToolEnabled);
    refreshToolsConfigBtn();
  };

  for (const cb of boxes) {
    cb.addEventListener("change", () => { setToolEnabled(cb.dataset.tool, cb.checked); saveCurrentSettings(); sync(); });
  }
  for (const btn of overlay.querySelectorAll("[data-bulk]")) {
    btn.addEventListener("click", () => {
      const on = btn.dataset.bulk === "on";
      for (const cb of boxes) { cb.checked = on; setToolEnabled(cb.dataset.tool, on); }
      saveCurrentSettings();
      sync();
    });
  }

  // Launch the co-browsing Chrome on the server machine; flash the outcome on the
  // button itself, then restore.
  chromeBtn?.addEventListener("click", async () => {
    launching = true;
    chromeBtn.disabled = true;
    let msg = "btn_browserLaunchFailed";
    try {
      const res = await fetch("/api/browser/launch", { method: "POST" });
      const data = await res.json();
      if (!data.error) msg = data.already ? "btn_browserLaunchAlready" : "btn_browserLaunched";
    } catch { /* keep failure message */ }
    chromeBtn.textContent = t(msg);
    setTimeout(() => {
      launching = false;
      chromeBtn.textContent = t("btn_browserLaunch");
      sync();
    }, 2500);
  });

  const close = () => { overlay.remove(); document.removeEventListener("keydown", onKey); dom.toolsConfigBtn?.focus(); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  overlay.querySelector(".zoteroImportClose").addEventListener("click", close);
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });

  sync();
  overlay.querySelector(".zoteroImportClose").focus();
}
