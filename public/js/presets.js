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
import { getPersonalityPreset, DEFAULT_AI_NAME } from './constants.js';
import { saveCurrentSettings, syncPersonaEditable } from './settings.js';
import { t, getUILanguage } from './i18n.js';
import { genId } from './utils.js';

// Built-ins grouped for the dropdown. Profession-flavored leads, and "creator" leads
// that group, because it is the factory default — a default sitting at the bottom of
// the list is a default nobody sees. The companion personas stay exactly as they were,
// one group down: the point was never to remove them, only to stop imposing one.
const BUILTIN_GROUPS = [
  { labelKey: "preset_groupPro", keys: ["creator", "counselor", "scholar", "editor"] },
  { labelKey: "preset_groupFemale", keys: ["sweet", "genki", "mature"] },
  { labelKey: "preset_groupMale", keys: ["warm", "sunny", "steady"] },
];
const BUILTINS = BUILTIN_GROUPS.flatMap((g) => g.keys);

// The factory personality. Exported because three other modules used to spell "sweet"
// inline — a new tab, a serialized tab and the delete-preset fallback all have to land
// on the same one, and they drifted apart the moment the default changed.
export const DEFAULT_PERSONALITY = "creator";

// The AI's display name (header, dblclick-editable) — substituted into the
// built-in persona texts in place of DEFAULT_AI_NAME.
export const currentAiName = () => dom.aiName?.textContent?.trim() || DEFAULT_AI_NAME;

export const isBuiltinKey = (v) => BUILTINS.includes(v);
export const isCustomPresetId = (v) => typeof v === "string" && v.startsWith("cp_");
export const getCustomPreset = (id) => (state.customPresets || []).find((p) => p.id === id) || null;
const genPresetId = () => `cp_${genId()}`;

// The one place a dropdown selection value becomes persona TEXT: a built-in key →
// the localized text with the AI name substituted; a custom preset id → the
// preset's stored text; "temp" or anything unknown (e.g. a dangling id) → "",
// i.e. an editable blank rather than a silently wrong built-in.
export function resolvePersonaText(sel, aiName = currentAiName()) {
  if (!sel || sel === "temp") return "";
  if (isCustomPresetId(sel)) return getCustomPreset(sel)?.text || "";
  return getPersonalityPreset(sel, getUILanguage(), aiName) || "";
}

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
  renderPersonaSummary();
}

// The one line the Basic tab shows for a setting that otherwise lives behind the ⚙.
// It reads the SELECTED OPTION's own label rather than re-deriving one, so a built-in,
// a custom preset and the unsaved-custom sentinel all name themselves the same way the
// dropdown does — including after a UI-language switch rebuilds the labels.
export function renderPersonaSummary() {
  if (!dom.personaSummary) return;
  const sel = dom.personalitySelect;
  const opt = sel?.selectedOptions?.[0];
  dom.personaSummary.textContent = opt ? `${t("persona_sep")}${opt.textContent}` : "";
  // The ⚙ names it too: the summary is easy to overlook, the button is what gets clicked.
  if (dom.personaBtn) dom.personaBtn.title = `${t("persona_settings")} — ${opt ? opt.textContent : ""}`;
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

// Delete the currently-selected custom preset and fall back to the factory default.
export function deleteCurrentPreset() {
  const p = getCustomPreset(dom.personalitySelect.value);
  if (!p) { alert(t("preset_selectFirst")); return; }
  if (!confirm(t("preset_confirmDelete", { name: p.name }))) return;
  state.customPresets = (state.customPresets || []).filter((x) => x.id !== p.id);
  // Other tabs may still reference the deleted id — remap them to the unsaved-
  // custom sentinel, keeping their persona text, so they don't dangle (a dangling
  // id blanks the select on tab switch and corrupts the tab on switch-away).
  for (const tab of state.tabs) {
    if (tab.personality === p.id) {
      tab.personality = "temp";
      if (!tab.persona) tab.persona = p.text;
    }
  }
  renderPersonalityOptions();
  dom.personalitySelect.value = DEFAULT_PERSONALITY;
  dom.persona.value = resolvePersonaText(DEFAULT_PERSONALITY);
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
// the caller's default. Persona text is hey-koko-local and never read from the file —
// even if one carries a `persona` field, it is ignored and resolved locally instead.
export function resolveImportedPersonality(value) {
  if (!value) return { personality: null, persona: null };
  if (isBuiltinKey(value)) return { personality: value, persona: resolvePersonaText(value) };
  const p = (state.customPresets || []).find((x) => x.name === value);
  if (p) return { personality: p.id, persona: p.text };
  return { personality: "temp", persona: "" };   // unknown custom name → blank editable slot
}
