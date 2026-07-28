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
  const uModels = new Map(), uEdit = new Map(), uVideo = new Map(), uUpscale = new Map(), uLtxLora = new Map();
  // Union of the collapsed-group representatives across lanes — without carrying this
  // through, a multi-precision image model would keep its token in the label on the
  // multi-endpoint path while the single-endpoint path hides it.
  const uCollapsed = new Set();
  // Union of per-model display metadata (market name + capability dots) — same
  // reason as uCollapsed: without it the multi-endpoint path loses the clean
  // labels and dots the single-endpoint path shows.
  const uMeta = {};
  await Promise.all(targets.map(async (url) => {
    try {
      const d = await (await fetch(`/api/comfy-models?comfyUrl=${encodeURIComponent(url)}`)).json();
      const models = d.models || [], editModels = d.editModels || [], videoModels = d.videoModels || [];
      for (const n of (d.upscaleModels || [])) if (!uUpscale.has(n)) uUpscale.set(n, n);
      for (const n of (d.ltxLoras || [])) if (!uLtxLora.has(n)) uLtxLora.set(n, n);
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
      for (const [k, v] of Object.entries(d.modelMeta || {})) if (!uMeta[k]) uMeta[k] = v;
      for (const n of models) if (!uModels.has(n)) uModels.set(n, n);
      for (const m of editModels) if (!uEdit.has(m.name)) uEdit.set(m.name, m);
      for (const m of videoModels) if (!uVideo.has(m.name)) uVideo.set(m.name, m);
    } catch { setBgWorkerStatus(url, { online: false }); }
  }));
  applyComfyModels({ models: [...uModels.values()], imageCollapsed: [...uCollapsed], editModels: [...uEdit.values()], videoModels: [...uVideo.values()], modelMeta: uMeta, upscaleModels: [...uUpscale.values()], ltxLoras: [...uLtxLora.values()] });
}

// Populate state.comfy* model Sets + the model dropdown from a {models,editModels,
// videoModels} dataset (a single endpoint or the union across worker lanes).
// Last dataset applied to the dropdown, kept so a UI-language switch can rebuild
// the options (optgroup labels + the i18n image-upscale label + capability dots)
// with the new language — network-free. See relocalizeComfyModels.
let _lastComfyData = null;

// Repopulate the ComfyUI model dropdown from the cached dataset so its localized
// bits (optgroup labels, the "image-upscale" label) follow a UI-language switch.
// No-op until the first real population. Called from the language-change handler.
export function relocalizeComfyModels() {
  if (_lastComfyData) applyComfyModels(_lastComfyData);
}

function applyComfyModels(data) {
  if (!dom.comfyModelSelect) return;
  _lastComfyData = data;
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
    // Of the video-in models, the ones that ALSO need a speech audio file (InfiniteTalk dubbing).
    state.comfyAudioInModels = new Set(videoModels.filter((m) => m.needsAudio).map((m) => m.name));
    // …of which some (bernini) also run WITHOUT a source video (image→video), where
    // fps/length are the request's own again rather than the source's.
    state.comfyVideoOptionalModels = new Set(videoModels.filter((m) => m.videoOptional).map((m) => m.name));
    // Qwen-Image-Edit accepts 2-3 reference images (multi-image composition).
    // Multi-reference compose: Qwen-Image-Edit-2509, and Bernini subject→image
    // (r2i is inherently multi-ref — "image0 wearing image1 in image2's scene").
    state.comfyMultiImageModels = new Set(editModels.filter((m) => m.type === "qwen" || m.type === "bernini-r2i").map((m) => m.name));
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
    // ⚙ "LTX LoRA": None + every LTX-family LoRA installed. The per-option baked-in
    // check (Sulphur's LoRA vs the Sulphur checkpoint) is re-run on every model change
    // by updateComfyParamVisibility, so it isn't applied here.
    if (dom.comfyParamLtxLora) {
      state.comfyLtxLoras = data.ltxLoras || [];
      const savedLora = (saved.comfyParams && saved.comfyParams.ltxLora) || "";
      dom.comfyParamLtxLora.innerHTML = "";
      const noneOpt = document.createElement("option");
      noneOpt.value = ""; noneOpt.textContent = t("comfy_ltxLora_none");
      dom.comfyParamLtxLora.appendChild(noneOpt);
      for (const n of state.comfyLtxLoras) {
        const o = document.createElement("option");
        const base = n.replace(/\.(safetensors|ckpt|gguf|pth|sft|bin)$/i, "");
        const hint = ltxLoraHint(n);
        o.value = n; o.textContent = hint ? `${base} — ${hint}` : base;
        dom.comfyParamLtxLora.appendChild(o);
      }
      dom.comfyParamLtxLora.value = state.comfyLtxLoras.includes(savedLora) ? savedLora : "";
    }
    const allNames = [...models, ...editModels.map((m) => m.name), ...videoModels.map((m) => m.name)];
    dom.comfyModelSelect.innerHTML = "";
    // Capability-dot legend under the dropdown — only meaningful once there are models.

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
      // Per-model metadata from the server: a clean market name + capability tags.
      // The tags render as coloured dots after the label (the ONLY way to get colour
      // into a native <select> — the OS draws options as plain text, so CSS/HTML can't
      // reach them; an emoji is just a character and renders). CAP_LEGEND (i18n) below
      // explains them. Absent meta (older server) → fall back to the label/stripExt.
      const meta = data.modelMeta || {};
      // Per-model list of quantisation tiers actually installed — the ⚙ precision menu
      // greys out the rest. Kept on state because the menu is rebuilt on model change,
      // long after this function has returned.
      state.comfyModelPrec = {};
      for (const [k, v] of Object.entries(meta)) if (v && v.prec) state.comfyModelPrec[k] = v.prec;
      // The coloured circles are input→output MODES and read as a set. "audio" is a
      // different axis — an extra property of the output, not another mode — so it gets
      // a pictograph rather than one more colour in the row.
      const CAP_DOT = { image: "🔵", edit: "🟠", t2v: "🟢", i2v: "🟡", v2v: "🟣", tool: "⚪", audio: "🔊" };
      const capDots = (name) => {
        const caps = (meta[name] && meta[name].caps) || [];
        const dots = caps.map((c) => CAP_DOT[c] || "").join("");
        return dots ? "  " + dots : "";
      };
      // Readiness map (verified + fully wired) for the warning shown on selection. A
      // model absent from modelMeta is assumed ready (older server / no metadata).
      const readyMap = {};
      const isReady = (name) => !meta[name] || meta[name].ready !== false;
      // The picker needs the same rows the <select> gets, so collect them as they're
      // built rather than re-deriving (and risking a second, drifting source of truth).
      const groups = [];
      const addOption = (parent, name, label, bucket) => {
        const option = document.createElement("option");
        option.value = name;
        // Market name wins; then an explicit label (video/edit sentinels); then a
        // precision-free filename. Capability dots are appended to whichever we land on.
        const base = (meta[name] && meta[name].label) || label || stripExt(name);
        const ready = isReady(name);
        readyMap[name] = ready;
        // Not-ready (unverified / not-yet-wired) models: a ⚠️ text marker — the ONLY
        // cross-platform signal, since macOS draws options itself and ignores an
        // option's colour (same constraint as the capability dots). Still selectable
        // (a warning fires on pick) so it can be tested and then promoted. The colour
        // is a best-effort bonus for platforms that DO honour it.
        option.textContent = (ready ? "" : "⚠️ ") + base + capDots(name);
        if (!ready) { option.style.color = "#9a9aa2"; option.dataset.unverified = "1"; }
        // Native <select> popups on macOS are drawn by the OS and generally ignore an
        // option's title, so this is a bonus for the platforms that do honour it — the
        // hint line under the dropdown is what actually guarantees the text is readable.
        option.title = comfyModelHint(name);
        parent.appendChild(option);
        if (bucket) bucket.push({ name, label: base, ready, dots: capDots(name).trim(), hint: option.title });
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
        const bucket = [];
        for (const name of models) {
          const label = name === "image-upscale" ? t("comfy_imageUpscale_label")
            : collapsed.has(name) ? stripPrecision(stripExt(name))
            : undefined;
          addOption(group, name, label, bucket);
        }
        dom.comfyModelSelect.appendChild(group);
        groups.push({ key: "comfy_image_group", items: bucket });
      }
      if (editModels.length) {
        const group = document.createElement("optgroup");
        group.dataset.i18n = "comfy_edit_group";
        group.label = t("comfy_edit_group");
        const bucket = [];
        for (const m of editModels) addOption(group, m.name, undefined, bucket);
        dom.comfyModelSelect.appendChild(group);
        groups.push({ key: "comfy_edit_group", items: bucket });
      }
      // Split video models: text/image→video generators vs. ones that need a
      // SOURCE VIDEO input (video-edit / pose transfer).
      const videoGen = videoModels.filter((m) => !m.needsVideo);
      const videoIn = videoModels.filter((m) => m.needsVideo);
      if (videoGen.length) {
        const group = document.createElement("optgroup");
        group.dataset.i18n = "comfy_video_group";
        group.label = t("comfy_video_group");
        const bucket = [];
        for (const m of videoGen) addOption(group, m.name, m.label, bucket);
        dom.comfyModelSelect.appendChild(group);
        groups.push({ key: "comfy_video_group", items: bucket });
      }
      if (videoIn.length) {
        const group = document.createElement("optgroup");
        group.dataset.i18n = "comfy_video_input_group";
        group.label = t("comfy_video_input_group");
        const bucket = [];
        for (const m of videoIn) addOption(group, m.name, m.label, bucket);
        dom.comfyModelSelect.appendChild(group);
        groups.push({ key: "comfy_video_input_group", items: bucket });
      }
      dom.comfyModelSelect.value = allNames.includes(current) ? current : allNames[0];
      // Readiness by model name — updateComfyMultiHint reads this to warn when the
      // selected model is unverified / not fully wired.
      state.comfyModelReady = readyMap;
      // The 4-column picker renders from this; the <select> stays authoritative.
      state.comfyModelGroups = groups.filter((g) => g.items.length);
    }
  } catch {
    /* leave placeholder */
  } finally {
    // In `finally` on purpose: the picker button must also reflect the "no models" /
    // error placeholder, not just a successful rebuild.
    syncComfyModelPickLabel();
    updateImageGenOptions();
    updateComfyMultiHint();
  }
}

// Mirrors LTX_MODEL_RE in server/comfy.js — "sulphur" is an LTX-family checkpoint whose
// filename says nothing about LTX. Display-side only (auto-defaults / hint / component
// summary), so a drift here costs a wrong hint, never a wrong workflow.
const LTX_RE = /ltx|sulphur/;

// Mirrors LORA_BAKED_IN in server/comfy.js: finetunes shipped BOTH as a checkpoint
// and as a LoRA of the same training, which must not be stacked on their own base.
// The server enforces this regardless; here it only greys the option and says why.
const LORA_BAKED_IN_RE = [/sulphur/i];

// Short "what is this and what strength" hint appended to each LoRA option. It goes
// in the VISIBLE label rather than an <option title> because option tooltips are
// unreliable across browsers — and the choice has to be makeable inside the picker.
// Only families we have real evidence for get a hint; anything else stays bare
// rather than inventing guidance for a LoRA we know nothing about.
function ltxLoraHint(name) {
  if (/sulphur/i.test(name)) return t("comfy_ltxLora_hint_sulphur");
  if (/distill/i.test(name)) return t("comfy_ltxLora_hint_distill");
  return "";
}

// Disable the options a <select> can't honour for the current model, keeping them
// VISIBLE with the reason appended — removing them reads as "this app doesn't support
// it" and invites hunting for a file that is already installed. The original label is
// stashed on first call so repeated calls restore it instead of stacking annotations.
// A selection that becomes invalid falls back to the "" (auto / none) option.
function annotateOptions(sel, isBlocked, reasonKey) {
  if (!sel) return;
  let reset = false;
  for (const o of sel.options) {
    if (!o.dataset.baseLabel) o.dataset.baseLabel = o.textContent;
    const blocked = !!o.value && isBlocked(o.value);   // the "" option is never blocked
    o.disabled = blocked;
    o.textContent = blocked ? `${o.dataset.baseLabel} — ${t(reasonKey)}` : o.dataset.baseLabel;
    if (blocked && sel.value === o.value) reset = true;
  }
  if (reset) sel.value = "";
}

// LoRAs already baked into the selected checkpoint (Sulphur ships as both).
function syncLtxLoraOptions(model) {
  annotateOptions(dom.comfyParamLtxLora,
    (v) => LORA_BAKED_IN_RE.some((re) => re.test(model) && re.test(v)),
    "comfy_ltxLora_bakedIn");
}

// Quantisation tiers the selected model doesn't ship in. `prec` absent = the server
// couldn't tell (no precision token on any file in the group) — restrict nothing
// rather than grey out everything on a model we know nothing about.
function syncPrecisionOptions(model) {
  const tiers = state.comfyModelPrec && state.comfyModelPrec[model];
  if (!tiers) { annotateOptions(dom.comfyParamPrecision, () => false, "comfy_precision_absent"); return; }
  annotateOptions(dom.comfyParamPrecision, (v) => !tiers.includes(v), "comfy_precision_absent");
}

// The "auto" fps/length the server picks per video model (mirrors videoPreset in
// server/comfy.js). Lets the ⚙ placeholders show the REAL default for the chosen
// model — WAN 14B is 16fps/81f, NOT the generic 24/49.
function videoAutoDefaults(modelName) {
  const m = (modelName || "").toLowerCase();
  // steps/cfg are included only where they DON'T depend on turbo (installed speed
  // LoRAs, which the frontend can't see): the placeholder shows "Auto (N)" when set,
  // else plain "Auto". Mirrors videoPreset in server/comfy.js. WAN 14B is left without
  // steps/cfg on purpose — its schedule flips between turbo (4/cfg1) and full (20/3.5).
  // LTX: steps/cfg are omitted for the same reason as WAN 14B — they flip with the
  // two-stage cascade (fixed sigma tables at cfg 1) vs the single-stage fallback
  // (30 steps / cfg 3), and the frontend can't see whether the distilled LoRA and
  // upscaler are installed. fps DOES differ per finetune: ltx-2.3's templates run
  // 25, Sulphur's run 24.
  // MSR runs its own distilled recipe: 50 fps, 121 frames, and a fixed 8-step schedule
  // (so steps/cfg stay bare "Auto" like the other distilled paths).
  if (m === "ltx-msr") return { fps: 30, length: 121 };
  if (LTX_RE.test(m)) return { fps: /sulphur/.test(m) ? 24 : 25, length: 97 };
  if (/hunyuan/.test(m)) return { fps: 24, length: 49, steps: 20, cfg: 6 };
  // Phantom: fixed 50-step / cfg 7.5 (uni_pc) — no distill LoRA, so it never varies.
  if (/phantom/.test(m)) return { fps: 24, length: 81, steps: 50, cfg: 7.5 };
  // Bernini matches none of the rules below (its name carries no "wan"), so without
  // this it fell through to null and the ⚙ showed the generic Auto (24) / Auto (49)
  // rather than the 16 / 81 the server actually uses. (Its steps field is hidden —
  // bernini isn't samplerTunable — so no steps/cfg needed here.)
  if (/bernini/.test(m)) return { fps: 16, length: 81 };
  if (/wan/.test(m)) return /14b/.test(m) ? { fps: 16, length: 81 } : { fps: 24, length: 49, steps: 20, cfg: 5 };
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
  if (n === "infinitetalk") return t("oll_hint_infinitetalk");
  if (n === "infinitetalk_speak") return t("oll_hint_infinitetalkSpeak");
  if (/scail/.test(n)) return /animate/.test(n) ? t("oll_hint_scail2Animate") : t("oll_hint_scail2Replace");
  if (/animate/.test(n)) return /replace/.test(n) ? t("oll_hint_animateReplace") : t("oll_hint_animateMove");
  // Bernini image tasks BEFORE the generic bernini branch — their sentinels all
  // contain "bernini" and would otherwise get the video-edit hint.
  if (/bernini_image_edit/.test(n)) return t("oll_hint_berniniImgEdit");
  if (/bernini_subject_image/.test(n)) return t("oll_hint_berniniSubjectImg");
  if (/bernini_text_image/.test(n)) return t("oll_hint_berniniT2i");
  if (/bernini/.test(n)) return /insert/.test(n) ? t("oll_hint_berniniInsert") : t("oll_hint_bernini");
  // Video, generates from text/image.
  if (/phantom/.test(n)) return t("oll_hint_phantom");
  if (/vace/.test(n)) return t("oll_hint_vace");
  if (/wan/.test(n)) return /14b/.test(n) || n === "wan2.2_14b" ? t("oll_hint_wan14b") : t("oll_hint_wan5b");
  if (/hunyuan/.test(n)) return t("oll_hint_hunyuan");
  // MSR + Union Control before the generic LTX test — both are distinct LTX modes.
  if (n === "ltx-msr") return t("oll_hint_ltxMsr");
  if (n === "ltx-union") return t("oll_hint_ltxUnion");
  if (LTX_RE.test(n)) return t("oll_hint_ltx");
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

// Mirror the <select>'s current choice onto the picker button. The option's own text
// already carries the ⚠️ marker and capability dots, so reuse it verbatim rather than
// rebuilding the label (one formatting rule, not two).
export function syncComfyModelPickLabel() {
  if (!dom.comfyModelPickLabel || !dom.comfyModelSelect) return;
  const sel = dom.comfyModelSelect.selectedOptions && dom.comfyModelSelect.selectedOptions[0];
  dom.comfyModelPickLabel.textContent = sel ? sel.textContent : t("comfy_model_none");
  if (dom.comfyModelPickBtn) dom.comfyModelPickBtn.title = comfyModelHint(dom.comfyModelSelect.value);
}

// 4-column ComfyUI model picker — one column per model TYPE (image / edit / video /
// video-editing), which is what the flat dropdown had grown too long to convey. Picking
// writes back into the hidden <select> and fires `change`, so every existing reader
// (saved settings, multi-hint, ⚙ visibility, placeholders…) keeps working untouched.
// Classify a video model NAME to an image→video family, for the 🟡 comparison table.
// Classify a video model NAME to a family, for the legend comparison tables. Mirrors the
// capsFor / videoTypeOf grouping in server/comfy.js. Order matters: scail before animate
// (the "scail2_animate" sentinel contains "animate"), and union / msr before the generic
// /ltx/. One classifier serves all three tables (i2v / t2v / v2v); each table's own row
// set decides which of these families it actually lists.
function videoFamilyOf(name) {
  const n = (name || "").toLowerCase();
  if (/infinitetalk/.test(n)) return "infinitetalk";
  if (/scail/.test(n)) return "scail";
  if (/animate/.test(n)) return "animate";
  if (/phantom/.test(n)) return "phantom";
  if (/bernini/.test(n)) return "bernini";
  if (/union/.test(n)) return "ltxunion";            // before the generic /ltx/
  if (/msr/.test(n)) return "ltxmsr";                // before the generic /ltx/
  if (/ltx|sulphur/.test(n)) return "ltx";
  if (/hunyuan/.test(n)) return "hunyuan";
  if (/fun.?vace/.test(n)) return "funvace";
  if (/14b/.test(n) || n === "wan2.2_14b") return "wan14b";
  if (/ti2v.*5b/.test(n) || (/wan/.test(n) && /5b/.test(n))) return "wan5b";
  return null;
}

// Classify a txt2img / img2img (🔵) model NAME to a family. `edit` must be excluded
// (those are 🟠), but HiDream-O1 legitimately carries both — here it's the t2i side.
function imageFamilyOf(name) {
  const n = (name || "").toLowerCase();
  if (/bernini/.test(n)) return "berniniT2i";
  if (/hidream.?o1/.test(n)) return "hidreamo1";
  if (/hidream.?i1/.test(n)) return "hidreami1";
  if (/z.?image/.test(n)) return "zimage";
  if (/boogu/.test(n)) return /turbo/.test(n) ? "booguturbo" : "boogubase";
  if (/qwen/.test(n)) return "qwenimage";
  if (/flux/.test(n)) return "flux";
  if (/pony/.test(n)) return "pony";
  return null;
}

// Classify an instruction-edit (🟠) model NAME to a family. Order matters: the *-edit
// variants must beat the base model's token (qwen-edit vs qwen-image, boogu-edit vs boogu).
function editFamilyOf(name) {
  const n = (name || "").toLowerCase();
  if (/kontext/.test(n)) return "kontext";
  if (/qwen.*edit/.test(n)) return "qwenedit";
  if (/boogu.*edit/.test(n)) return "booguedit";
  if (/omnigen/.test(n)) return "omnigen";
  if (/hidream.?e1/.test(n)) return "hidreame1";
  if (/pix2pix|ip2p|instruct/.test(n)) return "ip2p";
  if (/bernini/.test(n)) return "berniniEdit";
  return null;
}

// The families present in the current picker for a given capability dot, using the
// supplied classifier. Only READY, installed models count — an unverified/not-wired one
// (fun_vace, the regressed HiDream-O1, …) is left out so the comparison only lists
// options that actually work.
function familiesPresent(dot, classify) {
  const fams = new Set();
  for (const g of state.comfyModelGroups || []) {
    for (const it of g.items || []) {
      if (!it.ready || !it.dots || !it.dots.includes(dot)) continue;
      const f = classify(it.name);
      if (f) fams.add(f);
    }
  }
  return fams;
}

// Build one capability's comparison as a real <table> (rows = installed models with that
// dot, columns = the traits that decide the choice). Rows are sorted by model name
// (first letter), so the order doesn't depend on the i18n row order. Null if none.
function buildCompareTable(dot, classify, colsKey, rowsKey) {
  const present = familiesPresent(dot, classify);
  if (!present.size) return null;
  const cols = t(colsKey).split("‖");
  const rows = t(rowsKey).split("\n")
    .map((l) => l.split("‖"))
    .filter((p) => present.has(p[0]))
    .sort((a, b) => a[1].localeCompare(b[1])); // p[1] = display name → alphabetical
  if (!rows.length) return null;
  const table = document.createElement("table");
  table.className = "comfyCapTable";
  const htr = table.createTHead().insertRow();
  for (const c of cols) { const th = document.createElement("th"); th.textContent = c; htr.appendChild(th); }
  const tb = table.createTBody();
  for (const p of rows) {
    const tr = tb.insertRow();
    // p = [familyKey, DisplayName, ...cells]; skip the family key.
    for (let ci = 0; ci < cols.length; ci++) { tr.insertCell().textContent = p[ci + 1] || ""; }
  }
  return table;
}

// Attach a hover comparison card to a legend segment. The card is a fixed-position
// element on <body> (so it escapes the modal's overflow), shown on enter, removed on
// leave; openComfyModelPicker's close() also sweeps any stray card.
function attachCompareTooltip(span, dot, classify, titleKey, colsKey, rowsKey) {
  const table = buildCompareTable(dot, classify, colsKey, rowsKey);
  if (!table) return; // no such models installed → leave the legend item plain
  span.classList.add("hasCapTip");
  let tip = null;
  const show = () => {
    if (tip) return;
    tip = document.createElement("div");
    tip.className = "comfyCapTooltip";
    const title = document.createElement("div");
    title.className = "comfyCapTipTitle";
    title.textContent = t(titleKey);
    tip.append(title, table);
    document.body.appendChild(tip);
    // Prefer above the legend (which sits at the modal's bottom); flip below if cramped.
    const r = span.getBoundingClientRect();
    const tr = tip.getBoundingClientRect();
    const left = Math.min(Math.max(8, r.left), window.innerWidth - tr.width - 8);
    let top = r.top - tr.height - 8;
    if (top < 8) top = Math.min(r.bottom + 8, window.innerHeight - tr.height - 8);
    tip.style.left = `${Math.max(8, left)}px`;
    tip.style.top = `${Math.max(8, top)}px`;
  };
  const hide = () => { if (tip) { tip.remove(); tip = null; } };
  span.addEventListener("mouseenter", show);
  span.addEventListener("mouseleave", hide);
}

export function openComfyModelPicker() {
  const groups = state.comfyModelGroups || [];
  if (!groups.length) return;
  const current = dom.comfyModelSelect ? dom.comfyModelSelect.value : "";

  const overlay = document.createElement("div");
  overlay.className = "zoteroImportOverlay";   // reuse the modal chrome
  overlay.innerHTML = `
    <div class="zoteroImportDialog comfyPickDialog" role="dialog" aria-modal="true" aria-label="${t("cmp_title")}">
      <div class="zoteroImportHead">
        <span class="zoteroImportTitle">🎛 ${t("cmp_title")}</span>
        <button type="button" class="zoteroImportClose" title="${t("mb_close")}">✕</button>
      </div>
      <div class="modelBrowserBar">
        <input type="text" class="modelBrowserSearch comfyPickSearch" placeholder="${t("cmp_search")}" />
        <span class="modelBrowserCount comfyPickCount"></span>
      </div>
      <div class="zoteroImportBody comfyPickBody"><div class="comfyPickCols"></div></div>
      <div class="comfyPickLegend"></div>
    </div>`;
  document.body.appendChild(overlay);

  const close = () => {
    document.removeEventListener("keydown", onEsc);
    document.querySelectorAll(".comfyCapTooltip").forEach((el) => el.remove()); // any open hover card
    overlay.remove();
  };
  const onEsc = (e) => { if (e.key === "Escape") close(); };
  overlay.querySelector(".zoteroImportClose").addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  document.addEventListener("keydown", onEsc);
  // Legend: split the "·"-joined caps into individual spans so the image→video (🟡)
  // one can carry a rich hover comparison of the i2v models actually installed.
  const legendEl = overlay.querySelector(".comfyPickLegend");
  legendEl.textContent = "";
  const legendSegs = t("comfy_caps_legend").split(" · ");
  legendSegs.forEach((seg, i) => {
    const span = document.createElement("span");
    span.className = "comfyCapLegendItem";
    span.textContent = seg;
    if (seg.includes("🔵")) attachCompareTooltip(span, "🔵", imageFamilyOf, "comfy_img_cmpTitle", "comfy_img_cmpCols", "comfy_img_cmpRows");
    else if (seg.includes("🟠")) attachCompareTooltip(span, "🟠", editFamilyOf, "comfy_edit_cmpTitle", "comfy_edit_cmpCols", "comfy_edit_cmpRows");
    else if (seg.includes("🟡")) attachCompareTooltip(span, "🟡", videoFamilyOf, "comfy_i2v_cmpTitle", "comfy_i2v_cmpCols", "comfy_i2v_cmpRows");
    else if (seg.includes("🟢")) attachCompareTooltip(span, "🟢", videoFamilyOf, "comfy_t2v_cmpTitle", "comfy_t2v_cmpCols", "comfy_t2v_cmpRows");
    else if (seg.includes("🟣")) attachCompareTooltip(span, "🟣", videoFamilyOf, "comfy_v2v_cmpTitle", "comfy_v2v_cmpCols", "comfy_v2v_cmpRows");
    legendEl.appendChild(span);
    if (i < legendSegs.length - 1) legendEl.appendChild(document.createTextNode(" · "));
  });

  const colsEl = overlay.querySelector(".comfyPickCols");
  const countEl = overlay.querySelector(".comfyPickCount");
  const searchEl = overlay.querySelector(".comfyPickSearch");

  const pick = (name) => {
    if (!dom.comfyModelSelect) return;
    dom.comfyModelSelect.value = name;
    // The <select> is authoritative; everything downstream listens for its change.
    dom.comfyModelSelect.dispatchEvent(new Event("change", { bubbles: true }));
    syncComfyModelPickLabel();
    close();
  };

  const render = () => {
    const q = searchEl.value.trim().toLowerCase();
    colsEl.textContent = "";
    let shown = 0, total = 0;
    for (const g of groups) {
      const items = g.items.filter((it) => {
        total++;
        return !q || it.label.toLowerCase().includes(q) || it.name.toLowerCase().includes(q);
      });
      shown += items.length;
      const col = document.createElement("div");
      col.className = "comfyPickCol";
      const head = document.createElement("div");
      head.className = "comfyPickColHead";
      head.textContent = t(g.key);
      col.appendChild(head);
      if (!items.length) {
        const none = document.createElement("div");
        none.className = "comfyPickNone";
        none.textContent = q ? t("cmp_noMatch") : "—";
        col.appendChild(none);
      }
      for (const it of items) {
        // DOM APIs, not innerHTML: these labels come from model FILENAMES on disk.
        const row = document.createElement("button");
        row.type = "button";
        row.className = "comfyPickRow" + (it.name === current ? " isCurrent" : "") + (it.ready ? "" : " isUnverified");
        row.title = it.hint || "";
        const nameEl = document.createElement("span");
        nameEl.className = "comfyPickName";
        nameEl.textContent = (it.ready ? "" : "⚠️ ") + it.label;
        row.appendChild(nameEl);
        if (it.dots) {
          const dotsEl = document.createElement("span");
          dotsEl.className = "comfyPickDots";
          dotsEl.textContent = it.dots;
          row.appendChild(dotsEl);
        }
        row.addEventListener("click", () => pick(it.name));
        col.appendChild(row);
      }
      colsEl.appendChild(col);
    }
    countEl.textContent = t("mb_count", { shown, total });
  };
  render();
  searchEl.addEventListener("input", render);
  searchEl.focus();
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
  if (/phantom/.test(n)) return "Phantom (subject→video) · UNETLoader · CLIP umt5(wan) · VAE wan_2.1 · ModelSamplingSD3 · WanPhantomSubjectToVideo (reference subjects, no driving video) · DualCFGGuider(regular: g_text + g_img) · SamplerCustomAdvanced (uni_pc)";
  if (/bernini/.test(n)) return "WAN2.2 MoE · UNETLoader ×2 · CLIP umt5(wan) · VAE wan_2.1 · BerniniConditioning · SamplerCustom ×2 · v2v: LoadVideo→GetVideoComponents (keeps source fps + audio) · attach a video to edit it (v2v), + images as reference views (rv2v), or images alone → image-to-video · turbo: LightX2V distill LoRA";
  if (/wan/.test(n)) return /14b/.test(n) || n === "wan2.2_14b"
    ? "WAN2.2 14B MoE · UNETLoader ×2 · CLIP umt5 · VAE wan_2.1 · WanImageToVideo · KSamplerAdvanced ×2 · turbo: LightX2V 4-step LoRA"
    : "WAN2.2 5B · UNETLoader · CLIP umt5 · VAE wan_2.2 · WanImageToVideo · KSampler";
  if (/hunyuan/.test(n)) return "HunyuanVideo · UNETLoader · CLIP clip_l + llava · VAE hunyuan · KSampler";
  if (n === "ltx-msr") return "LTX-2.3 MSR · UNETLoader(distilled) + ckpt VAE · LTXICLoRALoader · LiconMSR · LTXAddVideoICLoRAGuide · PromptRelayEncode · LTX2_NAG (+audio)";
  if (n === "ltx-union") return "LTX-2.3 Union Control · CheckpointLoader(distilled) · LoraLoaderModelOnly(union-control IC-LoRA) → GetICLoRAParameters · LoadVideo→GetVideoComponents→MoGe depth · LTXVImgToVideoInplace(ref frame) · LTXVAddGuide(depth + iclora_parameters) · KSampler 8-step (+audio)";
  if (LTX_RE.test(n)) return "LTX-2 · CheckpointLoader · LTXAVTextEncoder(gemma) · LTXVConditioning · KSampler (+audio)";
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
  // "auto" length = the FULL source clip for source-driven models: Wan Animate (segmented +
  // merged past the single-pass cap) and LTX Union Control (single-pass, capped ≤241). Other
  // models use a fixed preset length.
  const lengthFollowsSource = !!(v && (/animate/i.test(v) || v === "ltx-union"));
  if (dom.comfyParamLength) dom.comfyParamLength.placeholder = lengthFollowsSource ? t("comfy_length_source") : `Auto (${auto ? auto.length : 49})`;
  // Steps / CFG show the model's real auto value when it's fixed (Phantom 50, LTX 30,
  // …). WAN 14B's flips with turbo, which the frontend can't detect — it keeps a bare
  // "Auto" rather than commit to a number that may be wrong.
  if (dom.comfyParamSteps) dom.comfyParamSteps.placeholder = auto && auto.steps != null ? `Auto (${auto.steps})` : "Auto";
  if (dom.comfyParamCfg) dom.comfyParamCfg.placeholder = auto && auto.cfg != null ? `Auto (${auto.cfg})` : "Auto";
  // "What is this model for" — under the dropdown, and on the closed select's own
  // tooltip. Re-applied to every option here too (rather than only at build time) so a
  // language switch relocalizes them without rebuilding the list.
  const hint = comfyModelHint(v);
  if (dom.comfyModelHint) {
    dom.comfyModelHint.textContent = hint;
    dom.comfyModelHint.hidden = !hint;
  }
  // Unverified / not-fully-wired model selected → prominent warning (the option's
  // ⚠️ marker is easy to miss once the dropdown is closed).
  if (dom.comfyModelWarn) {
    const unverified = !!(v && state.comfyModelReady && state.comfyModelReady[v] === false);
    dom.comfyModelWarn.textContent = unverified ? t("comfy_model_unverified") : "";
    dom.comfyModelWarn.hidden = !unverified;
  }
  if (dom.comfyModelSelect) {
    dom.comfyModelSelect.title = hint;
    for (const o of dom.comfyModelSelect.options) if (o.value) o.title = comfyModelHint(o.value);
  }
  // Keep the picker button showing whatever the <select> currently holds. Called from
  // here so a LANGUAGE SWITCH (which routes through this function) refreshes it too.
  syncComfyModelPickLabel();
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
// Per-codec default CRF — mirrors VIDEO_CRF_DEFAULT in server/comfy.js so the ⚙ CRF
// placeholder shows the value the server will actually use when the field is left empty.
const VIDEO_CRF_DEFAULT = { h264: 23, h265: 28 };

// Whether THIS browser can play H.265/HEVC in an mp4. Runtime capability, not platform:
// Safari yes; Chrome/Edge yes where the OS/GPU has a hardware HEVC decoder (common on
// recent machines, Mac or Windows); Firefox no. Used to warn before choosing H.265 and
// to decide whether a rendered H.265 clip needs the "download to view" fallback.
export function canPlayHevc() {
  const v = document.createElement("video");
  return !!(v.canPlayType('video/mp4; codecs="hvc1"') || v.canPlayType('video/mp4; codecs="hev1"'));
}

// Show the selected codec's default CRF in the field's placeholder (23 h264 / 28 h265),
// so an empty field visibly means "that codec's default", not "0".
function syncVideoCrfPlaceholder() {
  if (!dom.comfyParamVideoCrf) return;
  const codec = dom.comfyParamVideoCodec?.value === "h265" ? "h265" : "h264";
  dom.comfyParamVideoCrf.placeholder = `default ${VIDEO_CRF_DEFAULT[codec]} (${codec === "h265" ? "H.265" : "H.264"})`;
}

export function updateComfyParamVisibility() {
  const m = dom.comfyModelSelect?.value || "";
  if (!m) return;
  const upscale = /upscale|video-enhance/i.test(m);   // image-upscale / video-enhance → an upscale-model pipeline (no sampler/prompt)
  const video = !!(state.comfyVideoModels && state.comfyVideoModels.has(m)) || /video-enhance/i.test(m);
  // Wan Animate only — NOT SCAIL-2, whose "animate" mode sentinel also matches
  // /animate/ but shares none of these knobs (no torch.compile toggle, no relight
  // LoRA, and SAM3 picks the subject by text rather than a clicked point).
  const animate = /animate/i.test(m) && !/scail/i.test(m);
  // The 🎯 pick-person point ONLY reaches the graph in Replace mode (buildWanAnimate wires
  // maskPoint inside `if (replace)`); Move has no person to select, so the button is dead
  // there. Gate it on Replace alone so it doesn't imply an effect it can't have.
  const animateReplace = animate && /replace/i.test(m);
  const scail2 = /scail/i.test(m);                     // both SCAIL-2 entries — the real filename and the "animate" sentinel
  const diffusion = !upscale;                          // samples + takes a prompt (everything except the upscale pipelines)
  // Hide a field by its <label> (or, for the frame-interpolation pair, the shared .comfyParamRow; the
  // pick-person button has no label, so fall back to the element itself).
  const setVis = (el, on, sel) => { if (!el) return; const box = sel ? el.closest(sel) : (el.closest("label") || el); if (box) box.hidden = !on; };
  // Video timing — gen length is diffusion-only (an upscale / VFI keeps the source's own length).
  setVis(dom.comfyParamLength, video && diffusion);
  for (const el of [dom.comfyParamFps, dom.comfyParamTimeout]) setVis(el, video);
  // Video codec + its CRF: every video model (the tail rewrite is builder-agnostic).
  for (const el of [dom.comfyParamVideoCodec, dom.comfyParamVideoCrf]) setVis(el, video);
  if (video) syncVideoCrfPlaceholder();
  setVis(dom.comfyParamTargetFps, video, ".comfyParamRow");          // frame-interpolation + interpolation-engine row
  // Wan Animate (both modes): torch.compile speed + relight strength.
  for (const el of [dom.comfyParamTorchCompile, dom.comfyParamRelight]) setVis(el, animate);
  // Replace only: which person in the source to swap out.
  setVis(dom.comfyMaskPointBtn, animateReplace);
  // Bernini only — turbo is otherwise forced on by the mere presence of the distill
  // LoRA, and ref_max_size is the only knob on how much reference detail survives.
  for (const el of [dom.comfyParamBerniniMode, dom.comfyParamRefMaxSize]) setVis(el, /bernini/i.test(m));
  // Edit-task lines are VIDEO tasks — hide them for the bernini image entries.
  setVis(dom.comfyParamBerniniTask, /bernini/i.test(m) && !/bernini_(image_edit|subject_image|text_image)/i.test(m));
  // LTX family only (incl. Sulphur) — the optional LoRA slot. It is the one builder
  // with a user-pickable LoRA; every other model mounts its LoRAs automatically.
  // Union Control is excluded: it mounts its union IC-LoRA automatically, no user slot.
  const ltx = video && LTX_RE.test(m.toLowerCase()) && m.toLowerCase() !== "ltx-union";
  for (const el of [dom.comfyParamLtxLora, dom.comfyParamLtxLoraStrength]) setVis(el, ltx);
  if (ltx) syncLtxLoraOptions(m);
  // Phantom only — the image-guidance scale (its second, subject-fidelity CFG), and the
  // step-distill turbo switch. The
  // switch is 14B-only: no 1.3B step-distill LoRA is published, so on 1.3B it would be
  // a control that does nothing.
  setVis(dom.comfyParamPhantomImgCfg, /phantom/i.test(m));
  setVis(dom.comfyParamPhantomTurbo, /phantom/i.test(m) && /14b/i.test(m));
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
  if (diffusion) syncPrecisionOptions(m);
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
    dom.comfyParamPhantomImgCfg,
    dom.comfyParamVideoCrf,
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
  dom.comfyParamBerniniMode?.addEventListener("change", () => saveCurrentSettings());
  dom.comfyParamBerniniTask?.addEventListener("change", () => saveCurrentSettings());
  // Interpolation engine is a <select> (not in `fields`) — default is "rife", so reset
  // restores that rather than an empty value.
  dom.comfyParamInterpMethod?.addEventListener("change", () => saveCurrentSettings());
  // Video codec: keep the CRF placeholder showing the selected codec's default, and warn
  // once when H.265 is picked in a browser that can't play it back.
  dom.comfyParamVideoCodec?.addEventListener("change", () => {
    if (dom.comfyParamVideoCodec.value === "h265" && !canPlayHevc() && !confirm(t("comfy_videoCodec_confirmHevc"))) {
      dom.comfyParamVideoCodec.value = "h264"; // declined → back to the universal codec
    }
    syncVideoCrfPlaceholder();
    saveCurrentSettings();
  });

  dom.comfyParamsReset?.addEventListener("click", () => {
    for (const el of fields) if (el) el.value = "";
    if (dom.comfyParamTorchCompile) dom.comfyParamTorchCompile.checked = false;
    if (dom.comfyParamBerniniMode) dom.comfyParamBerniniMode.value = "";
    if (dom.comfyParamBerniniTask) dom.comfyParamBerniniTask.value = "";
    if (dom.comfyParamInterpMethod) dom.comfyParamInterpMethod.value = "rife";
    if (dom.comfyParamVideoCodec) dom.comfyParamVideoCodec.value = "h264"; // default codec, not empty
    syncVideoCrfPlaceholder();
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