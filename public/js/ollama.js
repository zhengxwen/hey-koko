// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

// Ollama URL management and model loading
import { dom, state } from './state.js';
import { SETTINGS_KEY } from './constants.js';
import { t } from './i18n.js';
import { saveCurrentSettings } from './settings.js';
import { getBgWorkers, setBgWorkerStatus } from './bg-jobs.js';
import { updateCloudBadge } from './avatar.js';
import { refreshModelMaxContext } from './context-meter.js';

// "http://127.0.0.1:11434" + "localhost" -> "127.0.0.1:11434 (localhost)".
// The hostname (reverse-DNS, from the server) is only appended when present.
function formatUrl(url, hostname) {
  const display = (url || "").replace(/^https?:\/\//, "");
  return hostname ? `${display} (${hostname})` : display;
}

// Pull the bare address back out of a urlDisplay element, dropping any
// " (hostname)" suffix that formatUrl appended, for use as an actual URL.
export function urlFromDisplay(el) {
  return (el?.textContent || "").replace(/\s*\(.*\)\s*$/, "").trim();
}

// Last server-side endpoint URLs this page has seen — lets the return-to-
// foreground refresh detect changes made from ANOTHER page/machine (the
// config is server-global but each page's dropdowns are load-time snapshots).
let knownUrls = null;

function updateUrlDisplay(data) {
  const { url, imageUrl, comfyUrl, hostname, imageHostname, comfyHostname } = data;
  knownUrls = { url, imageUrl: imageUrl || url, comfyUrl };
  dom.llmUrlDisplay.textContent = formatUrl(url, hostname);
  dom.imageUrlDisplay.textContent = formatUrl(imageUrl || url, imageHostname || (imageUrl ? "" : hostname));
  if (dom.comfyUrlDisplay) {
    dom.comfyUrlDisplay.textContent = formatUrl(comfyUrl || "http://127.0.0.1:8188", comfyHostname);
  }
}

function editOllamaUrl(type) {
  const displayEl =
    type === "comfy" ? dom.comfyUrlDisplay : type === "image" ? dom.imageUrlDisplay : dom.llmUrlDisplay;
  // Strip any " (hostname)" suffix so the prompt offers just the editable address.
  const currentUrl = displayEl.textContent.replace(/\s*\(.*\)\s*$/, "");
  const labels = { comfy: "ComfyUI", image: t("label_imageModel"), llm: "LLM" };
  const defaultHint = type === "comfy" ? "127.0.0.1:8188" : "127.0.0.1:11434";
  const newUrl = prompt(t("oll_editUrlPrompt", { label: labels[type] || "LLM", hint: defaultHint }), currentUrl);
  if (newUrl === null) return;
  fetch("/api/set-ollama-url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type, url: newUrl })
  }).then(r => r.json()).then(data => {
    displayEl.textContent = formatUrl(data.url, data.hostname);
    if (knownUrls) knownUrls[type === "comfy" ? "comfyUrl" : type === "image" ? "imageUrl" : "url"] = data.url;
    if (type === "comfy") {
      loadComfyModels().catch(() => {});
    } else if (type === "image") {
      loadImageModels().catch(() => {});
    } else {
      reloadLlmModelLists();
    }
  }).catch(() => {});
}

// Everything fed by the LLM endpoint: chat models (forced — a dead endpoint
// must be visible), embedding models, and the context meter for the new pick.
function reloadLlmModelLists() {
  loadModels({ force: true })
    .then(() => refreshModelMaxContext(dom.modelSelect.value))
    .catch(() => {});
  loadEmbedModels().catch(() => {});
}

// Embedding and image models live in their own dropdowns — keep them out of the LLM list.
const NON_LLM_RE = /embed|z-image|flux/i;

// force: rebuild the dropdown even when no models come back (URL just changed —
// a dead endpoint must show as "none detected", not silently keep the old
// machine's list). The default keeps the lenient page-load behavior (Ollama
// may simply not be up yet).
// ---- "browse all models" picker -------------------------------------------
// The provider config's `models[]` curates the dropdown; these are the user's
// ad-hoc picks from the browse dialog, remembered in the browser only. The server
// still routes them (a slashed provider/model id resolves to OpenRouter), so no
// config file is ever rewritten.
export const BROWSE_MODELS_VALUE = "__browseAll__";
const EXTRA_MODELS_KEY = "hk_extra_models";

function loadExtraModels() {
  try { const a = JSON.parse(localStorage.getItem(EXTRA_MODELS_KEY) || "[]"); return Array.isArray(a) ? a : []; }
  catch { return []; }
}
function saveExtraModel(name) {
  const list = loadExtraModels();
  if (!list.includes(name)) { list.push(name); localStorage.setItem(EXTRA_MODELS_KEY, JSON.stringify(list)); }
}
// Last entry of the model dropdown: an ACTION, not a model (main.js reverts the
// selection and opens the dialog when it's chosen).
function appendBrowseOption() {
  const opt = document.createElement("option");
  opt.value = BROWSE_MODELS_VALUE;
  opt.textContent = "🔍 " + t("model_browseAll");
  dom.modelSelect.appendChild(opt);
}

export async function loadModels({ force = false } = {}) {
  const response = await fetch("/api/models");
  const data = await response.json();
  // Keep the objects (not just names) so we can badge cloud vs local models.
  const entries = (data.models || [])
    .filter((m) => m.name && !NON_LLM_RE.test(m.name));
  // Merge the user's ad-hoc picks (absent from the provider allowlist).
  const known = new Set(entries.map((m) => m.name));
  for (const name of loadExtraModels()) if (!known.has(name)) entries.push({ name, model: name, cloud: true });

  if (entries.length === 0) {
    if (!force) return;
    dom.modelSelect.innerHTML = "";
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = t("model_none");
    opt.disabled = true;
    opt.selected = true;
    dom.modelSelect.appendChild(opt);
    appendBrowseOption();   // still offer the picker (cloud may be configured but uncurated)
    updateCloudBadge();
    return;
  }

  const names = entries.map((m) => m.name);
  const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
  const current = saved.model || dom.modelSelect.value;
  dom.modelSelect.innerHTML = "";
  for (const m of entries) {
    const option = document.createElement("option");
    option.value = m.name;  // raw name — this is what /api/chat receives
    // Symbol prefix only in the label: ☁️ cloud (Claude) vs 💻 local (Ollama).
    option.textContent = (m.cloud ? "☁️ " : "💻 ") + m.name;
    if (m.cloud) option.dataset.cloud = "1";  // lets the send-status pill badge cloud requests
    dom.modelSelect.appendChild(option);
  }
  appendBrowseOption();   // last entry — opens the full-catalog picker

  if (current && names.includes(current)) {
    dom.modelSelect.value = current;
  } else {
    const preferred = names.find((n) => /gemma|qwen/i.test(n));
    dom.modelSelect.value = preferred || names[0];
  }

  updateCloudBadge();  // reflect whether the (re)selected model is cloud
}

// Friendly source label per endpoint host. `provider:"openai"` only means "came from
// openai.json", which may be any OpenAI-compatible endpoint — so label by HOST and fall
// back to the bare host for anything unrecognized (a relay, a local server…).
const PROVIDER_LABELS = {
  "openrouter.ai": "OpenRouter",
  "api.openai.com": "OpenAI",
  "api.deepseek.com": "DeepSeek",
  "api.x.ai": "xAI",
  "dashscope.aliyuncs.com": "Qwen",
  "dashscope-intl.aliyuncs.com": "Qwen",
  "api.moonshot.cn": "Kimi",
  "api.groq.com": "Groq",
  "api.mistral.ai": "Mistral",
};
function providerLabel(m) {
  const host = String(m.host || "").replace(/^www\./, "");
  return PROVIDER_LABELS[host] || host || (m.provider === "openrouter" ? "OpenRouter" : "OpenAI");
}

// Full-catalog model picker. Lists every online chat model from the configured
// cloud providers (ignores the curated allowlist), searchable; picking one adds it
// to the dropdown (remembered in localStorage) and selects it.
export async function openModelBrowser() {
  const overlay = document.createElement("div");
  overlay.className = "zoteroImportOverlay";   // reuse the modal chrome
  overlay.innerHTML = `
    <div class="zoteroImportDialog modelBrowserDialog" role="dialog" aria-modal="true">
      <div class="zoteroImportHead">
        <span class="zoteroImportTitle">🔍 ${t("mb_title")}</span>
        <button type="button" class="zoteroImportClose" title="${t("mb_close")}">✕</button>
      </div>
      <div class="modelBrowserBar">
        <input type="text" id="mbSearch" class="modelBrowserSearch" placeholder="${t("mb_search")}" />
        <span class="modelBrowserCount" id="mbCount"></span>
      </div>
      <div class="zoteroImportBody modelBrowserBody"><div class="modelBrowserList" id="mbList"></div></div>
    </div>`;
  document.body.appendChild(overlay);

  const close = () => { document.removeEventListener("keydown", onEsc); overlay.remove(); };
  const onEsc = (e) => { if (e.key === "Escape") close(); };
  overlay.querySelector(".zoteroImportClose").addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  document.addEventListener("keydown", onEsc);

  const listEl = overlay.querySelector("#mbList");
  const countEl = overlay.querySelector("#mbCount");
  const searchEl = overlay.querySelector("#mbSearch");
  listEl.textContent = t("mb_loading");

  let all = [];
  try {
    const r = await fetch("/api/cloud-models/all");
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    all = d.models || [];
  } catch (e) {
    listEl.textContent = t("mb_failed", { error: (e && e.message) || "?" });
    return;
  }
  if (!all.length) { listEl.textContent = t("mb_empty"); return; }

  const render = () => {
    const q = searchEl.value.trim().toLowerCase();
    const shown = q
      ? all.filter((m) => m.id.toLowerCase().includes(q) || (m.name || "").toLowerCase().includes(q)
                       || providerLabel(m).toLowerCase().includes(q))   // searchable by source too
      : all;
    listEl.textContent = "";
    countEl.textContent = t("mb_count", { shown: shown.length, total: all.length });
    if (!shown.length) { listEl.textContent = t("mb_none"); return; }
    for (const m of shown) {
      // Built with DOM APIs, not innerHTML: ids/descriptions come from an external
      // API, so they go through textContent and can never inject markup.
      const row = document.createElement("div");
      row.className = "modelBrowserRow";
      const main = document.createElement("div");
      main.className = "modelBrowserMain";
      // id line: [source chip] provider/model-id
      const id = document.createElement("div");
      id.className = "modelBrowserId";
      const chip = document.createElement("span");
      chip.className = "modelBrowserSrc";
      chip.textContent = providerLabel(m);
      id.appendChild(chip);
      id.appendChild(document.createTextNode(m.id));
      const meta = document.createElement("div");
      meta.className = "modelBrowserMeta";
      const bits = [];
      if (m.contextLength) bits.push(t("mb_ctx", { n: Math.round(m.contextLength / 1000) }));
      if (m.pricing) {
        const pIn = parseFloat(m.pricing.prompt) || 0;
        const pOut = parseFloat(m.pricing.completion) || 0;
        if (!pIn && !pOut) bits.push(t("mb_free"));
        else {
          if (pIn) bits.push(t("mb_priceIn", { p: (pIn * 1e6).toFixed(2) }));   // per-token → per-million
          if (pOut) bits.push(t("mb_priceOut", { p: (pOut * 1e6).toFixed(2) }));
        }
      }
      meta.textContent = bits.join(" · ");
      main.appendChild(id);
      main.appendChild(meta);
      const use = document.createElement("button");
      use.type = "button";
      use.className = "zoteroImportGo modelBrowserUse";
      use.textContent = t("mb_use");
      use.addEventListener("click", async () => {
        saveExtraModel(m.id);
        await loadModels({ force: true });
        dom.modelSelect.value = m.id;
        dom.modelSelect.dispatchEvent(new Event("change"));   // context meter + settings save
        close();
      });
      row.appendChild(main);
      row.appendChild(use);
      listEl.appendChild(row);
    }
  };
  searchEl.addEventListener("input", render);
  render();
  searchEl.focus();
}

// Show the image generation options (size/timeout) whenever EITHER an Ollama
// image model or a ComfyUI model is available to generate with.
export function updateImageGenOptions() {
  const hasModel = !!(dom.imageModelSelect.value || (dom.comfyModelSelect && dom.comfyModelSelect.value));
  dom.imageGenOptions.style.display = hasModel ? "" : "none";
}

export async function loadImageModels() {
  try {
    const response = await fetch("/api/image-models");
    const data = await response.json();
    const models = data.models || [];
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    // Distinguish "deliberately saved empty" (use ComfyUI) from "never saved"
    // (fresh install → auto-select an Ollama image model if one exists).
    const hasSaved = Object.prototype.hasOwnProperty.call(saved, "imageModel");
    const current = hasSaved ? saved.imageModel : dom.imageModelSelect.value;
    dom.imageModelSelect.innerHTML = "";

    // An empty selection is always available — it means "generate via ComfyUI
    // instead of an Ollama image model".
    const emptyOpt = document.createElement("option");
    emptyOpt.value = "";
    emptyOpt.textContent = models.length === 0 ? t("image_model_none") : t("image_model_empty");
    dom.imageModelSelect.appendChild(emptyOpt);

    for (const name of models) {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      dom.imageModelSelect.appendChild(option);
    }

    if (hasSaved && (current === "" || models.includes(current))) {
      dom.imageModelSelect.value = current;
    } else if (models.length) {
      const preferred = models.find((m) => /z-image|flux2/i.test(m));
      dom.imageModelSelect.value = preferred || models[0];
    }
  } catch {
    /* leave placeholder */
  } finally {
    updateImageGenOptions();
  }
}

// Scan the default ComfyUI endpoint and populate the dropdown (single-endpoint path).
export async function loadComfyModels() {
  if (!dom.comfyModelSelect) return;
  let data = { models: [], editModels: [], videoModels: [] };
  try { data = await (await fetch("/api/comfy-models")).json(); } catch { /* leave placeholder */ }
  applyComfyModels(data);
}

// Scan EVERY enabled ComfyUI worker (parallel lanes): record each endpoint's online
// status + per-endpoint model sets (for the scheduler), and populate the dropdown with
// the UNION of models across all machines. Falls back to the single default if no
// workers are configured.
export async function refreshBgWorkers() {
  if (!dom.comfyModelSelect) return;
  const workers = getBgWorkers().filter((w) => w.enabled);
  const targets = workers.length
    ? workers.map((w) => w.url)
    : [urlFromDisplay(dom.comfyUrlDisplay)].filter(Boolean);
  if (!targets.length) { loadComfyModels(); return; }
  const uModels = new Map(), uEdit = new Map(), uVideo = new Map(), uUpscale = new Map();
  // Union of the collapsed-group representatives across lanes — without carrying this
  // through, a multi-precision image model would keep its token in the label on the
  // multi-endpoint path while the single-endpoint path hides it.
  const uCollapsed = new Set();
  await Promise.all(targets.map(async (url) => {
    try {
      const d = await (await fetch(`/api/comfy-models?comfyUrl=${encodeURIComponent(url)}`)).json();
      const models = d.models || [], editModels = d.editModels || [], videoModels = d.videoModels || [];
      for (const n of (d.upscaleModels || [])) if (!uUpscale.has(n)) uUpscale.set(n, n);
      const sets = {
        image: new Set(models),
        edit: new Set(editModels.map((m) => m.name)),
        video: new Set(videoModels.map((m) => m.name)),
        videoIn: new Set(videoModels.filter((m) => m.needsVideo).map((m) => m.name)),
        multiImage: new Set(editModels.filter((m) => m.type === "qwen").map((m) => m.name)),
      };
      const online = (models.length + editModels.length + videoModels.length) > 0;
      setBgWorkerStatus(url, { online, models: sets, hostname: d.hostname || "" });
      for (const n of (d.imageCollapsed || [])) uCollapsed.add(n);
      for (const n of models) if (!uModels.has(n)) uModels.set(n, n);
      for (const m of editModels) if (!uEdit.has(m.name)) uEdit.set(m.name, m);
      for (const m of videoModels) if (!uVideo.has(m.name)) uVideo.set(m.name, m);
    } catch { setBgWorkerStatus(url, { online: false }); }
  }));
  applyComfyModels({ models: [...uModels.values()], imageCollapsed: [...uCollapsed], editModels: [...uEdit.values()], videoModels: [...uVideo.values()], upscaleModels: [...uUpscale.values()] });
}

// Populate state.comfy* model Sets + the model dropdown from a {models,editModels,
// videoModels} dataset (a single endpoint or the union across worker lanes).
function applyComfyModels(data) {
  if (!dom.comfyModelSelect) return;
  try {
    const models = data.models || [];                 // checkpoints (txt2img / img2img)
    const editModels = data.editModels || [];         // instruction-edit models (need a ref image)
    const videoModels = data.videoModels || [];       // text→video / image→video
    state.comfyVideoModels = new Set(videoModels.map((m) => m.name));
    // Video models whose ⚙ sampler / scheduler / steps / cfg actually reach the graph.
    // The server decides this (it knows which builders read a preset); the rest hardcode
    // a schedule, so showing the fields for them would promise something that never happens.
    state.comfySamplerTunable = new Set(videoModels.filter((m) => m.samplerTunable).map((m) => m.name));
    // Source-video models (bernini / animate): output fps follows the source video.
    state.comfyVideoInModels = new Set(videoModels.filter((m) => m.needsVideo).map((m) => m.name));
    // …of which some (bernini) also run WITHOUT a source video (image→video), where
    // fps/length are the request's own again rather than the source's.
    state.comfyVideoOptionalModels = new Set(videoModels.filter((m) => m.videoOptional).map((m) => m.name));
    // Qwen-Image-Edit accepts 2-3 reference images (multi-image composition).
    state.comfyMultiImageModels = new Set(editModels.filter((m) => m.type === "qwen").map((m) => m.name));
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    const current = saved.comfyModel || dom.comfyModelSelect.value;
    // ⚙ "upscale model" manual picker: Auto + each model installed in upscale_models/.
    // Restore the saved choice if it's still present (else fall back to Auto).
    if (dom.comfyParamUpscaleModel) {
      const ups = data.upscaleModels || [];
      const savedUp = (saved.comfyParams && saved.comfyParams.upscaleModel) || "";
      dom.comfyParamUpscaleModel.innerHTML = "";
      const autoOpt = document.createElement("option");
      autoOpt.value = ""; autoOpt.textContent = t("comfy_upscaleModel_auto");
      dom.comfyParamUpscaleModel.appendChild(autoOpt);
      const offOpt = document.createElement("option");
      offOpt.value = "off"; offOpt.textContent = t("comfy_upscaleModel_off");
      dom.comfyParamUpscaleModel.appendChild(offOpt);
      for (const n of ups) {
        const o = document.createElement("option");
        o.value = n; o.textContent = n.replace(/\.(safetensors|ckpt|gguf|pth|sft|bin)$/i, "");
        dom.comfyParamUpscaleModel.appendChild(o);
      }
      dom.comfyParamUpscaleModel.value = (savedUp === "off" || ups.includes(savedUp)) ? savedUp : "";
    }
    const allNames = [...models, ...editModels.map((m) => m.name), ...videoModels.map((m) => m.name)];
    dom.comfyModelSelect.innerHTML = "";

    if (allNames.length === 0) {
      const option = document.createElement("option");
      option.value = "";
      option.dataset.i18n = "comfy_model_none";
      option.textContent = t("comfy_model_none");
      dom.comfyModelSelect.appendChild(option);
    } else {
      // Display without the file extension; the value keeps the full filename
      // (the server matches models by filename). An explicit label wins as-is.
      const stripExt = (n) => n.replace(/\.(safetensors|ckpt|gguf|pth|sft|bin)$/i, "");
      // Mirrors PRECISION_TOKENS in server/comfy.js. Display only — never applied to a
      // value, so a drift here costs a cosmetic token in a label, not a broken model name.
      const stripPrecision = (n) => n
        .replace(/(?:^|[_-])(?:fp8_e4m3fn_scaled|fp8_e4m3fn_fast|fp8_e4m3fn|fp8_e5m2|fp8_scaled|fp8|mxfp8|nvfp4_mxpf8_mix|nvfp4|int8_convrot|int8|fp16|bf16)(?=[_.-]|$)/ig, "")
        .replace(/[_-]{2,}/g, "_").replace(/^[_-]+|[_-]+$/g, "");
      const addOption = (parent, name, label) => {
        const option = document.createElement("option");
        option.value = name;
        option.textContent = label || stripExt(name);
        // Native <select> popups on macOS are drawn by the OS and generally ignore an
        // option's title, so this is a bonus for the platforms that do honour it — the
        // hint line under the dropdown is what actually guarantees the text is readable.
        option.title = comfyModelHint(name);
        parent.appendChild(option);
      };
      if (models.length) {
        const group = document.createElement("optgroup");
        group.dataset.i18n = "comfy_image_group";
        group.label = t("comfy_image_group");
        // An image entry standing for several quantisations keeps a real filename as its
        // VALUE (a saved choice must keep resolving, and the server re-applies the ⚙ tier
        // to whatever name it gets) — but showing "…_bf16" on an entry that may well load
        // nvfp4 would be a lie, so the token comes out of the label only.
        const collapsed = new Set(data.imageCollapsed || []);
        for (const name of models) {
          const label = name === "image-upscale" ? t("comfy_imageUpscale_label")
            : collapsed.has(name) ? stripPrecision(stripExt(name))
            : undefined;
          addOption(group, name, label);
        }
        dom.comfyModelSelect.appendChild(group);
      }
      if (editModels.length) {
        const group = document.createElement("optgroup");
        group.dataset.i18n = "comfy_edit_group";
        group.label = t("comfy_edit_group");
        for (const m of editModels) addOption(group, m.name);
        dom.comfyModelSelect.appendChild(group);
      }
      // Split video models: text/image→video generators vs. ones that need a
      // SOURCE VIDEO input (video-edit / pose transfer).
      const videoGen = videoModels.filter((m) => !m.needsVideo);
      const videoIn = videoModels.filter((m) => m.needsVideo);
      if (videoGen.length) {
        const group = document.createElement("optgroup");
        group.dataset.i18n = "comfy_video_group";
        group.label = t("comfy_video_group");
        for (const m of videoGen) addOption(group, m.name, m.label);
        dom.comfyModelSelect.appendChild(group);
      }
      if (videoIn.length) {
        const group = document.createElement("optgroup");
        group.dataset.i18n = "comfy_video_input_group";
        group.label = t("comfy_video_input_group");
        for (const m of videoIn) addOption(group, m.name, m.label);
        dom.comfyModelSelect.appendChild(group);
      }
      dom.comfyModelSelect.value = allNames.includes(current) ? current : allNames[0];
    }
  } catch {
    /* leave placeholder */
  } finally {
    updateImageGenOptions();
    updateComfyMultiHint();
  }
}

// The "auto" fps/length the server picks per video model (mirrors videoPreset in
// server/comfy.js). Lets the ⚙ placeholders show the REAL default for the chosen
// model — WAN 14B is 16fps/81f, NOT the generic 24/49.
function videoAutoDefaults(modelName) {
  const m = (modelName || "").toLowerCase();
  if (/ltx/.test(m)) return { fps: 24, length: 97 };
  if (/hunyuan/.test(m)) return { fps: 24, length: 49 };
  // Bernini matches none of the rules below (its name carries no "wan"), so without
  // this it fell through to null and the ⚙ showed the generic Auto (24) / Auto (49)
  // rather than the 16 / 81 the server actually uses.
  if (/bernini/.test(m)) return { fps: 16, length: 81 };
  if (/wan/.test(m)) return /14b/.test(m) ? { fps: 16, length: 81 } : { fps: 24, length: 49 };
  return null;
}

// What a model is FOR, in one line — "what it does + when to pick it". Unlike
// comfyModelComponents (which describes the wiring), this is the chooser's text: it
// goes under the dropdown and on each option's tooltip. Keyed off the same filename
// ladder, so a model that gains a description here needs no other change.
//
// Order matters exactly as it does below: the sentinels overlap ("scail2_animate"
// contains "animate", "bernini_insert" contains "bernini"), so the MOST specific
// name has to be tested first.
function comfyModelHint(name) {
  const n = (name || "").toLowerCase();
  if (!n) return "";
  // Pipelines that aren't really "models" (sentinels for a whole workflow).
  if (/image-upscale/.test(n)) return t("oll_hint_imageUpscale");
  if (/video-enhance/.test(n)) return t("oll_hint_videoEnhance");
  // Video, needs a source clip. scail BEFORE animate — see above.
  if (/scail/.test(n)) return /animate/.test(n) ? t("oll_hint_scail2Animate") : t("oll_hint_scail2Replace");
  if (/animate/.test(n)) return /replace/.test(n) ? t("oll_hint_animateReplace") : t("oll_hint_animateMove");
  if (/bernini/.test(n)) return /insert/.test(n) ? t("oll_hint_berniniInsert") : t("oll_hint_bernini");
  // Video, generates from text/image.
  if (/phantom/.test(n)) return t("oll_hint_phantom");
  if (/vace/.test(n)) return t("oll_hint_vace");
  if (/wan/.test(n)) return /14b/.test(n) || n === "wan2.2_14b" ? t("oll_hint_wan14b") : t("oll_hint_wan5b");
  if (/hunyuan/.test(n)) return t("oll_hint_hunyuan");
  if (/ltx/.test(n)) return t("oll_hint_ltx");
  // Image edit (needs a reference image + an instruction).
  if (/kontext/.test(n)) return t("oll_hint_kontext");
  if (/boogu.*edit/.test(n)) return t("oll_hint_booguEdit");
  if (/qwen.*edit/.test(n)) return t("oll_hint_qwenEdit");
  if (/omnigen/.test(n)) return t("oll_hint_omnigen");
  if (/pix2pix|ip2p|instruct/.test(n)) return t("oll_hint_pix2pix");
  if (/hidream.?e1/.test(n)) return t("oll_hint_hidreamE1");
  // Image generation.
  if (/hidream.?o1/.test(n)) return t("oll_hint_hidreamO1");
  if (/hidream.?i1/.test(n)) return t("oll_hint_hidreamI1");
  if (/z.?image/.test(n)) return t("oll_hint_zImage");
  if (/boogu/.test(n)) return /turbo/.test(n) ? t("oll_hint_booguTurbo") : t("oll_hint_booguBase");
  if (/qwen.?image/.test(n)) return t("oll_hint_qwenImage");
  if (/flux/.test(n)) return t("oll_hint_flux");
  if (/pony|xl\b|sdxl/.test(n)) return t("oll_hint_sdxl");
  return t("oll_hint_generic");
}

// The key ComfyUI workflow components hey-koko wires for a model — inferred from
// its filename (mirrors the build functions in server/comfy.js). Shown in the ⚙
// panel so the user can see the pipeline a model actually runs.
function comfyModelComponents(name) {
  const n = (name || "").toLowerCase();
  // Video
  if (/image-upscale/.test(n)) return t("oll_comp_imageUpscale");
  if (/video-enhance/.test(n)) return t("oll_comp_videoEnhance");
  // scail BEFORE animate: the "scail-2 (animate)" sentinel is literally
  // "scail2_animate", so a bare /animate/ test claimed it ran Wan Animate's pipeline.
  if (/scail/.test(n)) return "SCAIL-2 (character animation) · UNETLoader + lightx2v + DPO LoRA · SAM3 open-vocabulary subject tracking (no DWPose) · WanSCAILToVideo · reference_image batch + mask, paired by batch index";
  if (/animate/.test(n)) return "Wan Animate (pose transfer) · UNETLoader + lightx2v + relight LoRA · ModelSamplingSD3 · LoadVideo→DWPose(pose+face) · WanAnimateToVideo · segment length adapts to resolution (≤640: 241f · 720p: 161f · 1080p: 65f) — a longer source is generated in chunks with continue_motion for seamless joins, then merged";
  if (/bernini/.test(n)) return "WAN2.2 MoE · UNETLoader ×2 · CLIP umt5(wan) · VAE wan_2.1 · BerniniConditioning · SamplerCustom ×2 · v2v: LoadVideo→GetVideoComponents (keeps source fps + audio) · attach a video to edit it (v2v), + images as reference views (rv2v), or images alone → image-to-video · turbo: LightX2V distill LoRA";
  if (/wan/.test(n)) return /14b/.test(n) || n === "wan2.2_14b"
    ? "WAN2.2 14B MoE · UNETLoader ×2 · CLIP umt5 · VAE wan_2.1 · WanImageToVideo · KSamplerAdvanced ×2 · turbo: LightX2V 4-step LoRA"
    : "WAN2.2 5B · UNETLoader · CLIP umt5 · VAE wan_2.2 · WanImageToVideo · KSampler";
  if (/hunyuan/.test(n)) return "HunyuanVideo · UNETLoader · CLIP clip_l + llava · VAE hunyuan · KSampler";
  if (/ltx/.test(n)) return "LTX-2 · CheckpointLoader · LTXAVTextEncoder(gemma) · LTXVConditioning · KSampler (+audio)";
  // Edit
  if (/kontext/.test(n)) return "FLUX Kontext · UNETLoader · DualCLIP(t5+clip_l) · VAE ae · ReferenceLatent · FluxGuidance · KSampler";
  if (/boogu.*edit/.test(n)) return "boogu edit · UNETLoader · CLIP qwen3vl(boogu) · VAE flux1 · TextEncodeBooguEdit · ModelSamplingAuraFlow · KSampler";
  if (/qwen.*edit/.test(n)) return "Qwen-Image-Edit · UNETLoader · CLIP qwen2.5-vl(qwen_image) · VAE qwen_image · TextEncodeQwenImageEdit · KSampler";
  if (/omnigen/.test(n)) return "OmniGen2 · UNETLoader · CLIP qwen2.5-vl(omnigen2) · VAE ae · KSampler";
  if (/pix2pix|ip2p|instruct/.test(n)) return "InstructPix2Pix · CheckpointLoader · InstructPixToPixConditioning · DualCFGGuider · SamplerCustomAdvanced";
  if (/hidream.?e1/.test(n)) return "HiDream-E1 · UNETLoader · QuadrupleCLIPLoader · VAE ae · ModelSamplingSD3 · VAEEncode · KSampler";
  // txt2img
  if (/hidream.?i1/.test(n)) return "HiDream-I1 · UNETLoader · QuadrupleCLIPLoader · VAE ae · ModelSamplingSD3 · KSampler";
  if (/z.?image/.test(n)) return "Z-Image-Turbo · UNETLoader · CLIP qwen_3_4b(lumina2) · VAE ae · ModelSamplingAuraFlow · KSampler (8-step)";
  if (/boogu/.test(n)) return "boogu · UNETLoader · CLIP qwen3vl(boogu) · VAE flux1 · ModelSamplingAuraFlow · KSampler";
  if (!n) return "";
  return "Checkpoint · CheckpointLoaderSimple · CLIPTextEncode · KSampler" + (/flux/.test(n) ? " · FluxGuidance" : "");
}

// Show the "supports multi-image" hint when a multi-reference edit model
// (Qwen-Image-Edit) is selected, update the ⚙ fps/length placeholders to the
// selected video model's real "auto" values, and show its key pipeline components.
export function updateComfyMultiHint() {
  const v = dom.comfyModelSelect?.value;
  if (dom.comfyMultiHint) {
    const isMulti = !!(v && state.comfyMultiImageModels && state.comfyMultiImageModels.has(v));
    dom.comfyMultiHint.hidden = !isMulti;
  }
  const auto = (v && state.comfyVideoModels && state.comfyVideoModels.has(v)) ? videoAutoDefaults(v) : null;
  // Source-video models (bernini / animate): "auto" fps mirrors the source video,
  // not a fixed preset — make that explicit in the placeholder.
  const followsSource = !!(v && state.comfyVideoInModels && state.comfyVideoInModels.has(v));
  // …but bernini also runs source-less (i2v), where its own fps applies — promising
  // "same as source" there names a source that doesn't exist.
  const sourceOptional = !!(v && state.comfyVideoOptionalModels && state.comfyVideoOptionalModels.has(v));
  if (dom.comfyParamFps) {
    dom.comfyParamFps.placeholder = sourceOptional
      ? t("comfy_fps_source_opt", { fps: auto ? auto.fps : 16 })
      : (followsSource ? t("comfy_fps_source") : `Auto (${auto ? auto.fps : 24})`);
  }
  // Wan Animate "auto" length = the FULL source clip (generated in segments + merged
  // when it exceeds the single-pass cap); other models use a fixed preset length.
  const lengthFollowsSource = !!(v && /animate/i.test(v));
  if (dom.comfyParamLength) dom.comfyParamLength.placeholder = lengthFollowsSource ? t("comfy_length_source") : `Auto (${auto ? auto.length : 49})`;
  // "What is this model for" — under the dropdown, and on the closed select's own
  // tooltip. Re-applied to every option here too (rather than only at build time) so a
  // language switch relocalizes them without rebuilding the list.
  const hint = comfyModelHint(v);
  if (dom.comfyModelHint) {
    dom.comfyModelHint.textContent = hint;
    dom.comfyModelHint.hidden = !hint;
  }
  if (dom.comfyModelSelect) {
    dom.comfyModelSelect.title = hint;
    for (const o of dom.comfyModelSelect.options) if (o.value) o.title = comfyModelHint(o.value);
  }
  if (dom.comfyModelInfo) {
    const comps = comfyModelComponents(v);
    dom.comfyModelInfo.textContent = comps;
    dom.comfyModelInfo.hidden = !comps;
  }
  updateComfyParamVisibility();
}

// Show only the ⚙ params that apply to the selected ComfyUI model: hide the video-only block
// (length / fps / timeout / frame interpolation) for image models, the Wan-Animate-only knobs (torch.compile /
// relight / pick-person) for non-animate, the upscale knob for non-upscale, and Image-CFG for
// non-image. A pure upscale model shows only its own knob (no sampler / steps / prompt). No comfy
// model selected (Ollama image path) → leave the modal untouched.
export function updateComfyParamVisibility() {
  const m = dom.comfyModelSelect?.value || "";
  if (!m) return;
  const upscale = /upscale|video-enhance/i.test(m);   // image-upscale / video-enhance → an upscale-model pipeline (no sampler/prompt)
  const video = !!(state.comfyVideoModels && state.comfyVideoModels.has(m)) || /video-enhance/i.test(m);
  // Wan Animate only — NOT SCAIL-2, whose "animate" mode sentinel also matches
  // /animate/ but shares none of these knobs (no torch.compile toggle, no relight
  // LoRA, and SAM3 picks the subject by text rather than a clicked point).
  const animate = /animate/i.test(m) && !/scail/i.test(m);
  const scail2 = /scail/i.test(m);                     // both SCAIL-2 entries — the real filename and the "animate" sentinel
  const diffusion = !upscale;                          // samples + takes a prompt (everything except the upscale pipelines)
  // Hide a field by its <label> (or, for the frame-interpolation pair, the shared .comfyParamRow; the
  // pick-person button has no label, so fall back to the element itself).
  const setVis = (el, on, sel) => { if (!el) return; const box = sel ? el.closest(sel) : (el.closest("label") || el); if (box) box.hidden = !on; };
  // Video timing — gen length is diffusion-only (an upscale / VFI keeps the source's own length).
  setVis(dom.comfyParamLength, video && diffusion);
  for (const el of [dom.comfyParamFps, dom.comfyParamTimeout]) setVis(el, video);
  setVis(dom.comfyParamTargetFps, video, ".comfyParamRow");          // frame-interpolation + interpolation-engine row
  // Wan Animate only.
  for (const el of [dom.comfyParamTorchCompile, dom.comfyParamRelight, dom.comfyMaskPointBtn]) setVis(el, animate);
  // Bernini only — turbo is otherwise forced on by the mere presence of the distill
  // LoRA, and ref_max_size is the only knob on how much reference detail survives.
  for (const el of [dom.comfyParamBerniniQuality, dom.comfyParamRefMaxSize]) setVis(el, /bernini/i.test(m));
  // SCAIL-2 only — SAM3 open-vocabulary subject + identity ordering + the pose schedule.
  // These are Animate's counterparts to relight/🎯: same intent, different mechanism.
  for (const el of [dom.comfyParamScailSubject, dom.comfyParamScailRefSubject, dom.comfyParamScailThreshold,
                    dom.comfyParamScailMaxObjects, dom.comfyParamScailIndices,
                    dom.comfyParamScailSortBy, dom.comfyParamPoseStrength, dom.comfyParamPoseStart,
                    dom.comfyParamPoseEnd]) setVis(el, scail2);
  // Upscale-model pipelines only (image-upscale / video-enhance) — the upscale-denoise % + the upscale-model picker.
  for (const el of [dom.comfyParamUpscaleDenoise, dom.comfyParamUpscaleModel]) setVis(el, upscale);
  // Image-edit / txt2img only.
  setVis(dom.comfyParamImageCfg, diffusion && !video);
  // Quantisation preference — diffusion models only (the upscale pipelines load an
  // upscale model, which has no precision variants).
  setVis(dom.comfyParamPrecision, diffusion);
  // Prompt add-ons — every diffusion model reads them (an upscale pipeline takes no prompt).
  for (const el of [dom.comfyParamPositive, dom.comfyParamNegative]) setVis(el, diffusion);
  // Guidance + img2img denoise are IMAGE-only: no video builder accepts either
  // (resolveVideoConfig doesn't even carry them).
  for (const el of [dom.comfyParamGuidance, dom.comfyParamDenoise]) setVis(el, diffusion && !video);
  // Sampler / scheduler / steps / cfg: honoured by every image model, but only by the
  // preset-driven video models. SCAIL-2 / Wan Animate / bernini hardcode a schedule
  // bound to their distill LoRA and ignore these — so hide rather than lie.
  const samplerTunable = !video || !!(state.comfySamplerTunable && state.comfySamplerTunable.has(m));
  for (const el of [dom.comfyParamSampler, dom.comfyParamScheduler, dom.comfyParamSteps, dom.comfyParamCfg]) setVis(el, diffusion && samplerTunable);
}

export async function loadEmbedModels() {
  if (!dom.embedModelSelect) return;
  try {
    const response = await fetch("/api/models");
    const data = await response.json();
    // Only models with "embed" in the name are valid embedding models. Keep the
    // objects (not just names) so we can badge cloud vs local — same ☁️/💻 scheme
    // as the chat picker. The .cloud flag comes from /api/models (injectModels).
    const entries = (data.models || []).filter((m) => m.name && /embed/i.test(m.name));
    const names = entries.map((m) => m.name);
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    const current = saved.embedModel || dom.embedModelSelect.value;
    dom.embedModelSelect.innerHTML = "";

    if (entries.length === 0) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = t("oll_embedModelNone");
      dom.embedModelSelect.appendChild(opt);
      return;
    }
    for (const m of entries) {
      const opt = document.createElement("option");
      opt.value = m.name;  // raw name — sent to the embed endpoints unchanged
      opt.textContent = (m.cloud ? "☁️ " : "💻 ") + m.name;  // ☁️ cloud vs 💻 local Ollama
      if (m.cloud) opt.dataset.cloud = "1";
      dom.embedModelSelect.appendChild(opt);
    }
    if (current && names.includes(current)) {
      dom.embedModelSelect.value = current;
    } else {
      const preferred = names.find((m) => /qwen3-embedding:8b/i.test(m)) || names.find((m) => /qwen3-embedding/i.test(m));
      dom.embedModelSelect.value = preferred || names[0];
    }
  } catch {
    /* leave placeholder */
  }
}

// Modal-driven network scan: results stream in one by one via SSE; choosing one
// (or pressing ESC) closes the connection and abandons any still-running scan.
function initScanModal() {
  const modal = document.querySelector("#scanModal");
  const list = document.querySelector("#scanModalList");
  const empty = document.querySelector("#scanModalEmpty");
  const status = document.querySelector("#scanModalStatus");
  const title = document.querySelector("#scanModalTitle");
  const closeBtn = document.querySelector("#scanModalClose");

  let source = null;          // active EventSource
  let found = new Set();      // de-dupe discovered URLs
  let onSelectFn = null;      // callback for the current scan's selection

  function stopScan() {
    if (source) { source.close(); source = null; }
  }

  function closeModal() {
    stopScan();
    modal.hidden = true;
    document.removeEventListener("keydown", onKeydown);
  }

  function onKeydown(e) {
    if (e.key === "Escape") { e.preventDefault(); closeModal(); }
  }

  function selectUrl(url) {
    stopScan(); // selection made → abandon the rest of the scan
    if (onSelectFn) onSelectFn(url);
    closeModal();
  }

  function addResult(url) {
    if (found.has(url)) return;
    found.add(url);
    empty.hidden = true;
    const item = document.createElement("button");
    item.type = "button";
    item.className = "scanResult";
    item.textContent = url.replace(/^https?:\/\//, "");
    item.addEventListener("click", () => selectUrl(url));
    list.appendChild(item);
  }

  // `streamUrl` is the SSE endpoint to scan; `titleText` labels the modal;
  // `onSelect(url)` runs when the user picks a result.
  function startScan({ streamUrl, titleText, onSelect }) {
    onSelectFn = onSelect;
    found = new Set();
    list.innerHTML = "";
    empty.hidden = true;
    if (title && titleText) title.textContent = titleText;
    status.textContent = t("scan_scanning");
    modal.hidden = false;
    document.addEventListener("keydown", onKeydown);

    source = new EventSource(streamUrl);
    source.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === "found") {
        addResult(msg.url);
      } else if (msg.type === "done") {
        stopScan();
        status.textContent = "";
        if (found.size === 0) empty.hidden = false;
      }
    };
    source.onerror = () => {
      // Stream ended or failed; settle the UI.
      stopScan();
      status.textContent = "";
      if (found.size === 0) empty.hidden = false;
    };
  }

  closeBtn.addEventListener("click", closeModal);
  modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });

  return { startScan };
}

// Advanced ComfyUI generation parameters (sampler/scheduler/cfg/guidance/steps/
// denoise). Each field is optional — empty means "use the per-model default".
function initComfyParamsModal() {
  const modal = dom.comfyParamsModal;
  if (!modal) return;
  const fields = [
    dom.comfyParamPositive,
    dom.comfyParamNegative,
    dom.comfyParamSampler,
    dom.comfyParamScheduler,
    dom.comfyParamSteps,
    dom.comfyParamCfg,
    dom.comfyParamGuidance,
    dom.comfyParamImageCfg,
    dom.comfyParamDenoise,
    dom.comfyParamPrecision,
    dom.comfyParamLength,
    dom.comfyParamFps,
    dom.comfyParamTimeout,
    dom.comfyParamTargetFps,
    dom.comfyParamUpscaleDenoise,
    dom.comfyParamUpscaleModel,
    dom.comfyParamRelight,
    dom.comfyParamRefMaxSize,
    dom.comfyParamScailSubject,
    dom.comfyParamScailRefSubject,
    dom.comfyParamScailThreshold,
    dom.comfyParamScailMaxObjects,
    dom.comfyParamScailIndices,
    dom.comfyParamScailSortBy,
    dom.comfyParamPoseStrength,
    dom.comfyParamPoseStart,
    dom.comfyParamPoseEnd,
  ];

  // Reflect the current Wan Animate Replace target point on the picker button.
  function syncMaskPointLabel() {
    if (!dom.comfyMaskPointLabel) return;
    const p = state.animateMaskPoint;
    dom.comfyMaskPointLabel.textContent = p
      ? t("comfy_maskPoint_set", { x: Math.round(p.x * 100), y: Math.round(p.y * 100) })
      : t("comfy_maskPoint");
  }
  function open() {
    modal.hidden = false;
    syncMaskPointLabel();
    updateComfyParamVisibility();   // show only the params the selected model actually uses
    document.addEventListener("keydown", onKeydown);
  }
  function close() {
    modal.hidden = true;
    document.removeEventListener("keydown", onKeydown);
  }
  function onKeydown(e) {
    if (e.key === "Escape") { e.preventDefault(); close(); }
  }

  // Closes via the ✕ button or Escape — but NOT backdrop-click, so the user can
  // freely click outside the dialog (e.g. to read the chat) without losing it.
  dom.comfyParamsBtn?.addEventListener("click", open);
  dom.comfyParamsClose?.addEventListener("click", close);

  // Persist on every change so the values survive reloads. The torch.compile toggle
  // is a checkbox (.checked, not .value) so it's handled separately from `fields`.
  for (const el of fields) {
    el?.addEventListener("change", () => saveCurrentSettings());
  }
  dom.comfyParamTorchCompile?.addEventListener("change", () => saveCurrentSettings());
  dom.comfyParamBerniniQuality?.addEventListener("change", () => saveCurrentSettings());
  // Interpolation engine is a <select> (not in `fields`) — default is "rife", so reset
  // restores that rather than an empty value.
  dom.comfyParamInterpMethod?.addEventListener("change", () => saveCurrentSettings());

  dom.comfyParamsReset?.addEventListener("click", () => {
    for (const el of fields) if (el) el.value = "";
    if (dom.comfyParamTorchCompile) dom.comfyParamTorchCompile.checked = false;
    if (dom.comfyParamBerniniQuality) dom.comfyParamBerniniQuality.checked = false;
    if (dom.comfyParamInterpMethod) dom.comfyParamInterpMethod.value = "rife";
    state.animateMaskPoint = null; // back to auto-centre target
    syncMaskPointLabel();
    saveCurrentSettings();
  });
}

// Return-to-foreground sync: the endpoint URLs live in the server process and
// can be changed from another page/machine at any time — re-fetch them when
// this page comes back to the foreground and reload only the lists whose
// endpoint actually changed (no-op churn on ordinary tab switches).
let urlSyncInflight = null; // focus + visibilitychange fire together — run once

function refreshIfUrlsChanged() {
  if (urlSyncInflight) return urlSyncInflight;
  urlSyncInflight = (async () => {
    let d;
    try {
      d = await fetch("/api/ollama-url").then((r) => r.json());
    } catch {
      return; // server unreachable — nothing to sync
    }
    const prev = knownUrls;
    updateUrlDisplay(d); // also re-records knownUrls
    if (!prev) return;   // initial load hadn't landed yet; init's loaders cover it
    if (prev.url !== d.url) reloadLlmModelLists();
    if ((prev.imageUrl || "") !== (d.imageUrl || d.url)) loadImageModels().catch(() => {});
    if (prev.comfyUrl !== d.comfyUrl) loadComfyModels().catch(() => {});
  })().finally(() => { urlSyncInflight = null; });
  return urlSyncInflight;
}

export function initOllama() {
  fetch("/api/ollama-url").then(r => r.json()).then(d => updateUrlDisplay(d)).catch(() => {});

  initComfyParamsModal();

  // Catches both a hidden tab being revealed and an always-visible window
  // (second monitor / another machine) being clicked back into.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshIfUrlsChanged();
  });
  window.addEventListener("focus", () => refreshIfUrlsChanged());

  document.querySelector("#editLlmUrl").addEventListener("click", (e) => { e.preventDefault(); editOllamaUrl("llm"); });
  document.querySelector("#editImageUrl").addEventListener("click", (e) => { e.preventDefault(); editOllamaUrl("image"); });
  document.querySelector("#editComfyUrl").addEventListener("click", (e) => { e.preventDefault(); editOllamaUrl("comfy"); });

  const { startScan } = initScanModal();

  document.querySelector("#scanOllama").addEventListener("click", () => startScan({
    streamUrl: "/api/scan-ollama-stream",
    titleText: t("scan_title"),
    onSelect: (url) => {
      fetch("/api/set-ollama-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "llm", url })
      }).then(r => r.json()).then(data => {
        dom.llmUrlDisplay.textContent = formatUrl(data.url, data.hostname);
        if (knownUrls) knownUrls.url = data.url;
        reloadLlmModelLists();
        loadImageModels().catch(() => {});
      }).catch(() => {});
    },
  }));

  document.querySelector("#scanComfy").addEventListener("click", () => startScan({
    streamUrl: "/api/scan-comfy-stream",
    titleText: t("scan_comfy_title"),
    onSelect: (url) => {
      fetch("/api/set-ollama-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "comfy", url })
      }).then(r => r.json()).then(data => {
        if (dom.comfyUrlDisplay) dom.comfyUrlDisplay.textContent = formatUrl(data.url, data.hostname);
        if (knownUrls) knownUrls.comfyUrl = data.url;
        loadComfyModels().catch(() => {});
      }).catch(() => {});
    },
  }));
}