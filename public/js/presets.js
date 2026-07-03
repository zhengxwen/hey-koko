// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

// Custom personality presets — a named, reusable library the user builds up.
// A preset is a single language-agnostic block of text: { id, name, text }.
// Built-in presets (sweet/genki/mature/…) still resolve per UI language via
// getPersonalityPreset(); custom presets are used verbatim, regardless of the
// UI language, because the user authored the exact wording themselves.
//
// tab.personality holds the selected dropdown value: a built-in key, a custom
// preset id ("cp_…"), or "temp" (an unsaved ad-hoc custom). tab.persona always
// holds the resolved text. The list lives in state.customPresets and is persisted
// inside SETTINGS_KEY by settings.js.
import { dom, state } from './state.js';
import { PERSONALITY_PRESETS, getPersonalityPreset } from './constants.js';
import { saveCurrentSettings, syncPersonaEditable } from './settings.js';
import { t, getUILanguage } from './i18n.js';

// Built-ins grouped for the dropdown: female / male / profession-flavored.
const BUILTIN_GROUPS = [
  { labelKey: "preset_groupFemale", keys: ["sweet", "genki", "mature"] },
  { labelKey: "preset_groupMale", keys: ["warm", "sunny", "steady"] },
  { labelKey: "preset_groupPro", keys: ["counselor", "scholar", "editor"] },
];
const BUILTINS = BUILTIN_GROUPS.flatMap((g) => g.keys);

// The AI's display name (header, dblclick-editable) — substituted into the
// built-in persona texts in place of the default "Bella".
export const currentAiName = () => dom.aiName?.textContent?.trim() || "Bella";

export const isCustomPresetId = (v) => typeof v === "string" && v.startsWith("cp_");
export const getCustomPreset = (id) => (state.customPresets || []).find((p) => p.id === id) || null;
const genPresetId = () => `cp_${Date.now().toString(36)}${Math.random().toString(16).slice(2, 6)}`;

// Rebuild the personality dropdown from the built-ins + the user's saved presets +
// the "new custom" sentinel. Labels come from t() so it's correct in any language.
// The current selection is preserved when the option still exists.
export function renderPersonalityOptions() {
  const sel = dom.personalitySelect;
  const prev = sel.value;
  sel.textContent = "";

  for (const g of BUILTIN_GROUPS) {
    const grp = document.createElement("optgroup");
    grp.label = t(g.labelKey);
    for (const key of g.keys) {
      const o = document.createElement("option");
      o.value = key;
      o.textContent = t(`personality_${key}`);
      grp.appendChild(o);
    }
    sel.appendChild(grp);
  }

  const presets = state.customPresets || [];
  if (presets.length) {
    const gCustom = document.createElement("optgroup");
    gCustom.label = t("preset_groupCustom");
    for (const p of presets) {
      const o = document.createElement("option");
      o.value = p.id;
      o.textContent = `⭐ ${p.name}`;
      gCustom.appendChild(o);
    }
    sel.appendChild(gCustom);
  }

  const oNew = document.createElement("option");
  oNew.value = "temp";
  oNew.textContent = t("preset_newCustom");
  sel.appendChild(oNew);

  if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
}

// Save the current persona textarea as a brand-new named preset and select it.
export function saveCurrentPersonaAsPreset() {
  const name = (prompt(t("preset_promptName"), "") || "").trim();
  if (!name) return;
  const p = { id: genPresetId(), name, text: dom.persona.value };
  state.customPresets = [...(state.customPresets || []), p];
  renderPersonalityOptions();
  dom.personalitySelect.value = p.id;
  syncPersonaEditable();
  saveCurrentSettings();   // persists customPresets + sets tab.personality=p.id / tab.persona=text
}

// Rename the currently-selected custom preset.
export function renameCurrentPreset() {
  const p = getCustomPreset(dom.personalitySelect.value);
  if (!p) { alert(t("preset_selectFirst")); return; }
  const name = (prompt(t("preset_promptRename"), p.name) || "").trim();
  if (!name || name === p.name) return;
  p.name = name;
  renderPersonalityOptions();
  dom.personalitySelect.value = p.id;
  saveCurrentSettings();
}

// Delete the currently-selected custom preset and fall back to the Sweet built-in.
export function deleteCurrentPreset() {
  const p = getCustomPreset(dom.personalitySelect.value);
  if (!p) { alert(t("preset_selectFirst")); return; }
  if (!confirm(t("preset_confirmDelete", { name: p.name }))) return;
  state.customPresets = (state.customPresets || []).filter((x) => x.id !== p.id);
  renderPersonalityOptions();
  dom.personalitySelect.value = "sweet";
  dom.persona.value = getPersonalityPreset("sweet", getUILanguage(), currentAiName()) || PERSONALITY_PRESETS.sweet;
  syncPersonaEditable();
  saveCurrentSettings();
}

// While the persona textarea is edited with a custom preset selected, keep the
// named preset's stored text in sync (so the edit is remembered library-wide,
// not just on the active tab).
export function writeBackPersonaToPreset() {
  const p = getCustomPreset(dom.personalitySelect.value);
  if (p) p.text = dom.persona.value;
}

// Map an exported `personality` value back to a usable {personality, persona} pair.
// Exports write a built-in key (sweet/…) or a custom preset's NAME (see exportJson).
// A name that matches one of the user's local presets re-binds to that preset (id +
// text); an unknown name becomes a blank editable custom slot; a missing value keeps
// the caller's default.
export function resolveImportedPersonality(value) {
  if (!value) return { personality: null, persona: null };
  if (BUILTINS.includes(value)) return { personality: value, persona: getPersonalityPreset(value, getUILanguage(), currentAiName()) };
  const p = (state.customPresets || []).find((x) => x.name === value);
  if (p) return { personality: p.id, persona: p.text };
  return { personality: "temp", persona: "" };   // unknown custom name, no exported text
}
