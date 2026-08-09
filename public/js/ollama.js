// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

// Ollama URL management and model loading
import { dom, state } from './state.js';
import { SETTINGS_KEY } from './constants.js';
import { t } from './i18n.js';
import { saveCurrentSettings } from './settings.js';
import { getBgWorkers, setBgWorkerStatus, MULTI_WORKERS_ENABLED } from './bg-jobs.js';
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

// Re-label the dynamically-added browse option after a language switch (the
// option is created in JS, so applyI18n's static-DOM pass never touches it —
// same reason relocalizeComfyModels exists). Network-free; leaves the <select>
// value untouched. Also fixes the embed dropdown's browse-less placeholder.
export function relocalizeBrowseOption() {
  const opt = dom.modelSelect?.querySelector(`option[value="${BROWSE_MODELS_VALUE}"]`);
  if (opt) opt.textContent = "🔍 " + t("model_browseAll");
}

export async function loadModels({ force = false } = {}) {
  const response = await fetch("/api/models");
  const data = await response.json();
  // The "browse all models" entry is cloud-only — show it just when a cloud
  // backend is actually configured (any Claude/OpenAI-compatible key), so pure-
  // local users never see a dead entry. Server-computed, not inferred from the list.
  const cloudConfigured = data.cloudConfigured === true;
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
    if (cloudConfigured) appendBrowseOption();   // offer the picker only when a cloud key exists
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
  if (cloudConfigured) appendBrowseOption();   // last entry — opens the full-catalog picker (cloud-only)

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
  "api.anthropic.com": "Claude",
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
  return PROVIDER_LABELS[host] || host
    || (m.provider === "openrouter" ? "OpenRouter" : m.provider === "claude" ? "Claude" : "OpenAI");
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
  // With the multi-worker feature off, ignore any saved workers and always target the
  // single ComfyUI address from settings (plain single-endpoint use).
  const workers = MULTI_WORKERS_ENABLED ? getBgWorkers().filter((w) => w.enabled) : [];
  const targets = workers.length
    ? workers.map((w) => w.url)
    : [urlFromDisplay(dom.comfyUrlDisplay)].filter(Boolean);
  if (!targets.length) { loadComfyModels(); return; }
  // uMesh belongs here for the same reason as the rest: leave a list out of the union and
  // its whole group silently vanishes from the dropdown on the multi-worker path while the
  // single-endpoint path still shows it.
  const uModels = new Map(), uEdit = new Map(), uVideo = new Map(), uMesh = new Map(), uUpscale = new Map(), uPano = new Map(), uPanoLora = new Map(), uLtxLora = new Map(), uH3Clip = new Map();
  // Union of the collapsed-group representatives across lanes — without carrying this
  // through, a multi-precision image model would keep its token in the label on the
  // multi-endpoint path while the single-endpoint path hides it.
  const uCollapsed = new Set();
  // Union of per-model display metadata (market name + capability dots) — same
  // reason as uCollapsed: without it the multi-endpoint path loses the clean
  // labels and dots the single-endpoint path shows.
  const uMeta = {};
  // A job may be scheduled onto ANY enabled lane, so the per-pass frame cap must be safe
  // on the SMALLEST box (sizing for a 128GB Spark then landing on a 32GB card → OOM).
  // Take the MIN VRAM across the online lanes; a lane that doesn't report it is ignored.
  const vrams = [];
  const devices = []; // per-lane GPU info for the picker header
  await Promise.all(targets.map(async (url) => {
    try {
      const d = await (await fetch(`/api/comfy-models?comfyUrl=${encodeURIComponent(url)}`)).json();
      const models = d.models || [], editModels = d.editModels || [], videoModels = d.videoModels || [], meshModels = d.meshModels || [];
      for (const n of (d.upscaleModels || [])) if (!uUpscale.has(n)) uUpscale.set(n, n);
      for (const n of (d.panoBases || [])) if (!uPano.has(n)) uPano.set(n, n);
      for (const n of (d.panoLoras || [])) if (!uPanoLora.has(n)) uPanoLora.set(n, n);
      for (const n of (d.ltxLoras || [])) if (!uLtxLora.has(n)) uLtxLora.set(n, n);
      for (const n of (d.h3TextEncoders || [])) if (!uH3Clip.has(n)) uH3Clip.set(n, n);
      const sets = {
        image: new Set(models),
        edit: new Set(editModels.map((m) => m.name)),
        video: new Set(videoModels.map((m) => m.name)),
        videoIn: new Set(videoModels.filter((m) => m.needsVideo).map((m) => m.name)),
        multiImage: new Set(editModels.filter((m) => m.type === "qwen").map((m) => m.name)),
        // Needed by workerHasModel: without it a mesh job matches NO lane and falls back
        // to "any online one", which may well be a box without the 3D weights.
        mesh: new Set(meshModels.map((m) => m.name)),
      };
      const online = (models.length + editModels.length + videoModels.length + meshModels.length) > 0;
      setBgWorkerStatus(url, { online, models: sets, hostname: d.hostname || "" });
      for (const n of (d.imageCollapsed || [])) uCollapsed.add(n);
      if (online && typeof d.vramGib === "number" && d.vramGib > 0) vrams.push(d.vramGib);
      if (online && (d.gpuName || d.vramGib)) devices.push({ gpuName: d.gpuName || null, vramGib: (typeof d.vramGib === "number" && d.vramGib > 0) ? d.vramGib : null, hostname: d.hostname || "" });
      // Label/caps are identical across lanes, so first-wins is fine for them — but the
      // installed QUANTISATIONS are per-box (a 32GB card gets int8, a 128GB box also
      // carries bf16). First-wins there let one lane decide what the ⚙ precision menu
      // offers for a model the other lane ships more builds of, so `prec` is UNIONED.
      for (const [k, v] of Object.entries(d.modelMeta || {})) {
        if (!uMeta[k]) { uMeta[k] = { ...v }; continue; }
        if (v.prec) uMeta[k].prec = [...new Set([...(uMeta[k].prec || []), ...v.prec])];
        if (v.precFiles) uMeta[k].precFiles = { ...v.precFiles, ...(uMeta[k].precFiles || {}) };
      }
      for (const n of models) if (!uModels.has(n)) uModels.set(n, n);
      for (const m of editModels) if (!uEdit.has(m.name)) uEdit.set(m.name, m);
      for (const m of videoModels) if (!uVideo.has(m.name)) uVideo.set(m.name, m);
      for (const m of meshModels) if (!uMesh.has(m.name)) uMesh.set(m.name, m);
    } catch { setBgWorkerStatus(url, { online: false }); }
  }));
  applyComfyModels({ models: [...uModels.values()], imageCollapsed: [...uCollapsed], editModels: [...uEdit.values()], videoModels: [...uVideo.values()], meshModels: [...uMesh.values()], modelMeta: uMeta, upscaleModels: [...uUpscale.values()], panoBases: [...uPano.values()], panoLoras: [...uPanoLora.values()], ltxLoras: [...uLtxLora.values()], h3TextEncoders: [...uH3Clip.values()], vramGib: vrams.length ? Math.min(...vrams) : null, devices });
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
    const meshModels = data.meshModels || [];         // image→3D model (.glb/.spz output)
    // Target box VRAM → Wan Animate per-pass frame cap (see animateSegmentCap). Undefined
    // on the multi-worker path unless the union computed a MIN; treat that as unknown.
    state.comfyVramGib = (typeof data.vramGib === "number" && data.vramGib > 0) ? data.vramGib : null;
    // Detected GPU(s) for the picker's header badge. Multi-worker path passes an explicit
    // `devices` array; the single-endpoint path synthesizes one from gpuName/vramGib.
    state.comfyDevices = Array.isArray(data.devices)
      ? data.devices.filter((d) => d && (d.gpuName || d.vramGib))
      : ((data.gpuName || data.vramGib) ? [{ gpuName: data.gpuName || null, vramGib: (typeof data.vramGib === "number" && data.vramGib > 0) ? data.vramGib : null, hostname: data.hostname || "" }] : []);
    state.comfyVideoModels = new Set(videoModels.map((m) => m.name));
    // 3D mesh models route to generateMesh and get a mesh bubble instead of pixels.
    state.comfyMeshModels = new Set(meshModels.map((m) => m.name));
    // Texturing needs an add-on on the ComfyUI machine; where it is missing the
    // server just makes a white mesh, so the ⚙ box stays hidden rather than lying.
    state.comfyMeshPaintModels = new Set(meshModels.filter((m) => m.paint).map((m) => m.name));
    // Video models whose ⚙ sampler / scheduler / steps / cfg actually reach the graph.
    // The server decides this (it knows which builders read a preset); the rest hardcode
    // a schedule, so showing the fields for them would promise something that never happens.
    state.comfySamplerTunable = new Set(videoModels.filter((m) => m.samplerTunable).map((m) => m.name));
    // cfg is tracked separately: MiniMax H3 reads sampler/scheduler/steps but guides with
    // a BasicGuider, so it has no guidance scale to receive.
    state.comfyCfgTunable = new Set(videoModels.filter((m) => m.cfgTunable).map((m) => m.name));
    // Models whose output rate is their own (MiniMax H3 is 24 fps by construction) — the
    // field would only re-time finished frames, and on H3 desync its generated audio.
    state.comfyFpsTunable = new Set(videoModels.filter((m) => m.fpsTunable).map((m) => m.name));
    // Per-model frame grid {min,max,step,fps,auto} for the ⚙ length field — see lenInfo
    // in server/comfy.js. Absent for source-sized models (they follow the input clip).
    state.comfyLenInfo = new Map(videoModels.filter((m) => m.lenInfo).map((m) => [m.name, m.lenInfo]));
    // Models with no negative branch in their graph (MiniMax H3): the ⚙ negative box and
    // /imagine's `--no …` are discarded, so showing the box would invite the user to type
    // a constraint that never arrives.
    state.comfyNegativeTunable = new Set(videoModels.filter((m) => m.negativeTunable).map((m) => m.name));
    // Models whose output can carry a soundtrack, so the ⚙ "silent video" box has
    // something to drop: the ones that GENERATE audio (the 🔊 cap) plus the source-video
    // ones, which carry the input clip's audio through. Anything else would be a no-op.
    state.comfyAudioModels = new Set(videoModels
      .filter((m) => m.needsVideo || ((data.modelMeta?.[m.name]?.caps) || []).includes("audio"))
      .map((m) => m.name));
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
    // Reference-driven models (r2v + subject→image): every staged image gets its own 🖌
    // button, and a mask there is a SUBJECT CUTOUT (keep what is inside), not an inpaint
    // region. Server-decided (refMaskModel) so a new model can't fall out of step.
    state.comfyRefMaskModels = new Set([...videoModels, ...editModels].filter((m) => m.refMask).map((m) => m.name));
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
    // ⚙ "de-artifact model": the 1x RESTORATION models, which live in the same ComfyUI
    // folder but are a different kind of thing (they resize nothing) — the server splits
    // the two lists so neither picker can offer the other's models.
    if (dom.comfyParamRestoreModel) {
      const res = data.restoreModels || [];
      const savedRes = (saved.comfyParams && saved.comfyParams.restoreModel) || "";
      dom.comfyParamRestoreModel.options[0].textContent = t("comfy_restoreModel_auto");
      dom.comfyParamRestoreModel.options[1].textContent = t("comfy_restoreModel_blur");
      for (const o of [...dom.comfyParamRestoreModel.options].slice(2)) o.remove();  // keep Auto + Blur
      for (const n of res) {
        const o = document.createElement("option");
        o.value = n; o.textContent = n.replace(/\.(safetensors|ckpt|gguf|pth|sft|bin)$/i, "");
        dom.comfyParamRestoreModel.appendChild(o);
      }
      dom.comfyParamRestoreModel.value = (savedRes === "off" || res.includes(savedRes)) ? savedRes : "";
    }
    if (dom.comfyParamUpscaleTarget) {
      const labels = ["comfy_upscaleTarget_auto", "comfy_upscaleTarget_1080", "comfy_upscaleTarget_1440", "comfy_upscaleTarget_4k"];
      [...dom.comfyParamUpscaleTarget.options].forEach((o, i) => { if (labels[i]) o.textContent = t(labels[i]); });
    }
    if (dom.comfyParamSharpen) {
      const labels = ["comfy_sharpen_off", "comfy_sharpen_light", "comfy_sharpen_medium", "comfy_sharpen_strong"];
      [...dom.comfyParamSharpen.options].forEach((o, i) => { if (labels[i]) o.textContent = t(labels[i]); });
    }
    // ⚙ "H3 text encoder": Auto + every Qwen3-VL build installed. Listed by FILENAME
    // rather than by tier — the tier is in the name, and the file is what the user
    // downloaded and can delete, so naming it keeps the menu honest about what is on the
    // box. Server order is already best-tier-first. A saved pick that is gone falls back
    // to Auto rather than requesting a file that would 404 at load time.
    if (dom.comfyParamH3Clip) {
      const encs = data.h3TextEncoders || [];
      const savedEnc = (saved.comfyParams && saved.comfyParams.h3TextEncoder) || "";
      dom.comfyParamH3Clip.innerHTML = "";
      const autoE = document.createElement("option");
      autoE.value = ""; autoE.textContent = t("comfy_h3Clip_auto");
      dom.comfyParamH3Clip.appendChild(autoE);
      for (const n of encs) {
        const o = document.createElement("option");
        o.value = n; o.textContent = n.replace(/\.(safetensors|ckpt|gguf|pth|sft|bin)$/i, "");
        dom.comfyParamH3Clip.appendChild(o);
      }
      dom.comfyParamH3Clip.value = encs.includes(savedEnc) ? savedEnc : "";
      state.comfyH3Encoders = encs.length;
    }
    // ⚙ "panorama base model": Auto + every checkpoint that can drive the recipe.
    // A saved pick that is no longer installed falls back to Auto rather than
    // silently generating with something the user did not choose.
    if (dom.comfyParamPanoModel) {
      const bases = data.panoBases || [];
      const savedPano = (saved.comfyParams && saved.comfyParams.panoModel) || "";
      dom.comfyParamPanoModel.innerHTML = "";
      const autoP = document.createElement("option");
      autoP.value = ""; autoP.textContent = t("comfy_panoModel_auto");
      dom.comfyParamPanoModel.appendChild(autoP);
      for (const n of bases) {
        const o = document.createElement("option");
        o.value = n; o.textContent = n.replace(/\.(safetensors|ckpt|gguf|pth|sft|bin)$/i, "");
        dom.comfyParamPanoModel.appendChild(o);
      }
      dom.comfyParamPanoModel.value = bases.includes(savedPano) ? savedPano : "";
    }
    // ⚙ "panorama LoRA": None + every LoRA that fits an image checkpoint. The row
    // hides itself when this list is empty (updateComfyParamVisibility), so a user
    // with none installed never sees a slot they cannot fill.
    if (dom.comfyParamPanoLora) {
      const pLoras = data.panoLoras || [];
      const savedPanoLora = (saved.comfyParams && saved.comfyParams.panoLora) || "";
      dom.comfyParamPanoLora.innerHTML = "";
      const autoP = document.createElement("option");
      autoP.value = ""; autoP.textContent = t("comfy_panoLora_auto");
      dom.comfyParamPanoLora.appendChild(autoP);
      const noneP = document.createElement("option");
      noneP.value = "off"; noneP.textContent = t("comfy_panoLora_none");
      dom.comfyParamPanoLora.appendChild(noneP);
      for (const n of pLoras) {
        const o = document.createElement("option");
        o.value = n; o.textContent = n.replace(/\.(safetensors|ckpt|gguf|pth|sft|bin)$/i, "");
        dom.comfyParamPanoLora.appendChild(o);
      }
      dom.comfyParamPanoLora.value = (savedPanoLora === "off" || pLoras.includes(savedPanoLora)) ? savedPanoLora : "";
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
    const allNames = [...models, ...editModels.map((m) => m.name), ...videoModels.map((m) => m.name), ...meshModels.map((m) => m.name)];
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
      // tier → filename for the same group, so a label can name the file a run WILL load
      // instead of the group's arbitrary representative (see resolvedModelName).
      state.comfyModelPrecFiles = {};
      for (const [k, v] of Object.entries(meta)) {
        if (v && v.prec) state.comfyModelPrec[k] = v.prec;
        if (v && v.precFiles) state.comfyModelPrecFiles[k] = v.precFiles;
      }
      // The coloured circles are input→output MODES and read as a set. "audio" is a
      // different axis — an extra property of the output, not another mode — so it gets
      // a pictograph rather than one more colour in the row.
      const CAP_DOT = { image: "🔵", edit: "🟠", t2v: "🟢", i2v: "🟡", v2v: "🟣", tool: "⚪", audio: "🔊", mesh: "🟤" };
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
        // Sort key for the alphabetical pass below: the DISPLAY name only. textContent
        // can't serve — its "⚠️ " prefix would bunch every unverified model together and
        // its capability dots would break ties by colour rather than by name.
        option.dataset.sortKey = base;
        if (!ready) { option.style.color = "#9a9aa2"; option.dataset.unverified = "1"; }
        // Native <select> popups on macOS are drawn by the OS and generally ignore an
        // option's title, so this is a bonus for the platforms that do honour it — the
        // hint line under the dropdown is what actually guarantees the text is readable.
        option.title = comfyModelHint(name);
        parent.appendChild(option);
        // `id` is the model's canonical identity (server/model-names.js) — stable across
        // installed quantisations, unlike `name` (the group's representative filename).
        // It is what `-m/--model` matches and what its popup completes to.
        // `caps` rides along raw (not just as the display dots) so callers can tell a
        // model-free TOOL from a real checkpoint — that is how an empty ComfyUI scan is
        // recognised: the tools are offered unconditionally, the checkpoints are not.
        if (bucket) bucket.push({ name, id: (meta[name] && meta[name].id) || null, label: base, ready, caps: (meta[name] && meta[name].caps) || [], dots: capDots(name).trim(), hint: option.title });
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
      if (meshModels.length) {
        const group = document.createElement("optgroup");
        group.dataset.i18n = "comfy_3d_group";
        group.label = t("comfy_3d_group");
        const bucket = [];
        for (const m of meshModels) addOption(group, m.name, m.label, bucket);
        dom.comfyModelSelect.appendChild(group);
        groups.push({ key: "comfy_3d_group", items: bucket });
      }
      // Alphabetical WITHIN each group (the groups themselves keep their fixed order:
      // image → edit → video → video-in → 3D). Sorting here rather than on the server is
      // deliberate — the string being sorted has to be the string on screen, and only the
      // frontend knows it: the localized label for the model-free tools, and whichever of
      // market-name / sentinel-label / stripped-filename won in addOption. Doing it in one
      // place also keeps the native <select> and the 🎛 picker in the same order; they read
      // from the same rows, so they must not be sorted independently.
      // numeric so "Wan 2.2" precedes "Wan 10"; sensitivity "base" so case and accents
      // don't split otherwise-adjacent names.
      const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
      const byName = (a, b) => collator.compare(a, b);
      for (const g of dom.comfyModelSelect.querySelectorAll("optgroup")) {
        [...g.children]
          .sort((a, b) => byName(a.dataset.sortKey || a.textContent, b.dataset.sortKey || b.textContent))
          .forEach((o) => g.appendChild(o)); // appendChild MOVES an existing child
      }
      for (const g of groups) g.items.sort((a, b) => byName(a.label, b.label));
      // Fall back to whatever now sorts first, not to the first name the server sent.
      const firstOption = dom.comfyModelSelect.querySelector("optgroup > option");
      dom.comfyModelSelect.value = allNames.includes(current) ? current : (firstOption ? firstOption.value : allNames[0]);
      // Readiness by model name — updateComfyMultiHint reads this to warn when the
      // selected model is unverified / not fully wired.
      state.comfyModelReady = readyMap;
      // The 4-column picker renders from this; the <select> stays authoritative.
      state.comfyModelGroups = groups.filter((g) => g.items.length);
      // Flat lookup for "/imagine -m <id>": canonical id → the dropdown VALUE to send.
      // Derived from the very rows the picker shows, so the flag can never offer a model
      // the picker doesn't have (or resolve to a stale name). Rows with no id are skipped
      // — an unnamed model can still be picked from the dropdown, just not by flag.
      state.comfyModelIndex = state.comfyModelGroups.flatMap((g) =>
        g.items.filter((it) => it.id).map((it) => ({
          id: it.id, value: it.name, label: it.label, group: g.key, ready: it.ready,
          caps: it.caps, dots: it.dots,
          tiers: state.comfyModelPrec[it.name] || [],
        })));
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

// ── "/imagine -m <model>" resolution ─────────────────────────────────────────
// Turns what the user typed into the dropdown VALUE to send. Resolution happens in the
// browser (not the server) because that is where the merged multi-worker model list
// lives and where the background job snapshots its modelOverride — and because a typo
// should be an error BEFORE a job is queued, not after it reaches the GPU.

// Split "id@tier" into its parts. The tier rides OUTSIDE the name on purpose: precision
// is a property of the build, not of the model, so it never became part of the id.
export function splitModelToken(token) {
  const s = String(token || "").trim().toLowerCase();
  const at = s.lastIndexOf("@");
  if (at <= 0) return { id: s, tier: "" };
  return { id: s.slice(0, at), tier: s.slice(at + 1) };
}

// Candidate rows for a partial id — exact first, then prefix, then substring on either
// the id or the display label. Used by both the resolver and the popup, so what the
// popup offers and what the flag accepts can never disagree.
export function matchModels(partial) {
  const idx = state.comfyModelIndex || [];
  const p = String(partial || "").trim().toLowerCase();
  if (!p) return idx.slice();
  const exact = idx.filter((m) => m.id === p);
  if (exact.length) return exact;
  const pre = idx.filter((m) => m.id.startsWith(p));
  const sub = idx.filter((m) => !m.id.startsWith(p) && (m.id.includes(p) || m.label.toLowerCase().includes(p)));
  return [...pre, ...sub];
}

// image-upscale / video-enhance and friends need no diffusion weights, so the server
// offers them even when the checkpoint scan came back empty. A catalogue made up of
// NOTHING but those means no model files were seen — nearly always a ComfyUI that isn't
// reachable (or points at the wrong box), not a user typo. Callers use this to say so
// instead of suggesting "did you mean image-upscale?" for a video model.
// A row with no caps at all (older server, no modelMeta) counts as real: an unknown
// model must never be mistaken for evidence of an empty scan.
export function comfyCatalogueToolsOnly() {
  const idx = state.comfyModelIndex || [];
  if (!idx.length) return false;   // that is "noModels", a different error
  return idx.every((m) => Array.isArray(m.caps) && m.caps.length > 0 && m.caps.every((c) => c === "tool"));
}

// Resolve a "-m" token to { value, tier } or an { error, candidates } explaining why not.
// An ambiguous prefix is NEVER silently narrowed to one model — picking for the user is
// how you render the wrong thing for twenty GPU-minutes.
export function resolveModelToken(token) {
  const { id, tier } = splitModelToken(token);
  if (!id) return { error: "empty" };
  const idx = state.comfyModelIndex || [];
  if (!idx.length) return { error: "noModels" };
  const hits = matchModels(id);
  if (!hits.length) {
    // Nearest few by shared prefix length, so the error can suggest instead of just refusing.
    const near = idx
      .map((m) => ({ m, n: [...m.id].findIndex((c, i) => c !== id[i]) }))
      .sort((a, b) => (b.n < 0 ? 99 : b.n) - (a.n < 0 ? 99 : a.n))
      .slice(0, 4).map((x) => x.m.id);
    return { error: "unknown", id, candidates: near, toolsOnly: comfyCatalogueToolsOnly() };
  }
  if (hits.length > 1 && !hits.some((m) => m.id === id)) {
    return { error: "ambiguous", id, candidates: hits.slice(0, 6).map((m) => m.id) };
  }
  const hit = hits.find((m) => m.id === id) || hits[0];
  if (tier) {
    // Only offer a tier the model actually ships: silently ignoring an impossible one
    // would run at a precision the user did not ask for and never say so.
    if (!hit.tiers.includes(tier)) return { error: "tier", id: hit.id, tier, candidates: hit.tiers };
    return { value: hit.value, id: hit.id, tier };
  }
  return { value: hit.value, id: hit.id, tier: "" };
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
// A selection that becomes invalid falls back to the "" (auto / none) option — unless
// `resetOnBlock` is false, for the cases where "blocked" is only a best GUESS and the
// server holds the authoritative answer. Blanking a guess is not the safe direction: ""
// is not "leave it alone", it is a different, ACTIVE choice (auto), and the user is
// never told it happened.
function annotateOptions(sel, isBlocked, reasonKey, resetOnBlock = true) {
  if (!sel) return;
  let reset = false;
  for (const o of sel.options) {
    if (!o.dataset.baseLabel) o.dataset.baseLabel = o.textContent;
    const blocked = !!o.value && isBlocked(o.value);   // the "" option is never blocked
    o.disabled = blocked;
    o.textContent = blocked ? `${o.dataset.baseLabel} — ${t(reasonKey)}` : o.dataset.baseLabel;
    if (blocked && sel.value === o.value) reset = true;
  }
  if (reset && resetOnBlock) sel.value = "";
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
// NEVER resets the selection: this list is a HINT, not the truth. It can be stale (a
// weight downloaded since the last refresh) or partial (multi-lane — the tiers come from
// whichever lane answered, and the job may run on another one that ships more). The
// server re-reads the real file list per job, honours the tier when it is there, and says
// "⚠️ 该模型没有装所选精度" when it isn't — so an over-eager grey-out costs nothing here,
// while blanking the field silently swapped an explicit tier for auto, and auto's
// PREC_AUTO_ORDER starts at fp8 (picking bf16 then quietly produced an fp8 render).
function syncPrecisionOptions(model) {
  const tiers = state.comfyModelPrec && state.comfyModelPrec[model];
  if (!tiers) { annotateOptions(dom.comfyParamPrecision, () => false, "comfy_precision_absent", false); return; }
  annotateOptions(dom.comfyParamPrecision, (v) => !tiers.includes(v), "comfy_precision_absent", false);
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
  // MSR runs its own FIXED distilled recipe (30 fps, 121 frames, an 8-step ManualSigmas
  // table at cfg 1). Unlike the cascade / WAN turbo paths, steps/cfg here never flip with an
  // unseen turbo flag — so surface the real numbers ("Auto (8)" / "Auto (1)") instead of a
  // bare "Auto". (The ⚙ steps/cfg fields are display-only for MSR — the sigma table is fixed —
  // but the value is worth showing.)
  if (m === "ltx-msr") return { fps: 30, length: 121, steps: 8, cfg: 1 };
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
  // 3D chains — hunyuan_3d BEFORE the generic /hunyuan/ (HunyuanVideo) test.
  if (/hunyuan[._-]?3d/.test(n)) return t("oll_hint_hunyuan3d");
  if (n === "triposplat") return t("oll_hint_triposplat");
  if (n === "moge-mesh") return t("oll_hint_mogeMesh");
  if (n === "moge-panorama") return t("oll_hint_mogePano");
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
  // MiniMax H3 — ref2va first, both filenames contain "minimax_h3".
  if (/minimax.?h3/.test(n)) return /ref2va/.test(n) ? t("oll_hint_minimaxH3Ref") : t("oll_hint_minimaxH3");
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
        <div class="comfyPickGpu"></div>
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
  // Detected GPU badge — "🖥 NVIDIA GeForce RTX 5090 · 31.8 GB" per online endpoint. The
  // VRAM shown is what drives the Wan Animate segment cap (see animateSegmentCap).
  const gpuEl = overlay.querySelector(".comfyPickGpu");
  const devs = (state.comfyDevices || []).filter((d) => d && (d.gpuName || d.vramGib));
  if (devs.length) {
    gpuEl.textContent = "";
    devs.forEach((d, i) => {
      const chip = document.createElement("span");
      chip.className = "comfyPickGpuChip";
      const vram = (typeof d.vramGib === "number" && d.vramGib > 0)
        ? ` · ${d.vramGib.toFixed(d.vramGib < 100 ? 1 : 0)} GB` : "";
      chip.textContent = `🖥 ${d.gpuName || t("comfy_gpu_unknown")}${vram}`;
      if (d.hostname) chip.title = d.hostname;
      gpuEl.appendChild(chip);
      if (i < devs.length - 1) gpuEl.appendChild(document.createTextNode("  "));
    });
  } else {
    gpuEl.style.display = "none"; // nothing detected (offline / no CUDA) → don't show an empty row
  }
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
  // The model's real frame grid, straight from the server's preset (no second table to
  // drift). Drives the field's min/max/step AND its tooltip, so the range the user is
  // offered is the range the generator will actually honour — MiniMax H3's 124-362 was
  // being clamped server-side while the field still advertised the generic 5-241/4n+1.
  const lenInfo = (v && state.comfyLenInfo && state.comfyLenInfo.get(v)) || null;
  if (dom.comfyParamLength) {
    const el = dom.comfyParamLength;
    el.placeholder = lengthFollowsSource ? t("comfy_length_source") : `Auto (${lenInfo ? lenInfo.auto : auto ? auto.length : 49})`;
    el.min = lenInfo ? lenInfo.min : 5;
    el.step = lenInfo ? lenInfo.step : 4;
    // No declared ceiling → keep the generic cap rather than removing the guard.
    el.max = lenInfo && lenInfo.max ? lenInfo.max : 241;
    // Frames are only meaningful next to the rate they play at, which is why the seconds
    // are spelled out: "124-362" means nothing until you know it is 5.2-15.1 s at 24 fps.
    const secs = (n) => (n / (lenInfo ? lenInfo.fps : 24)).toFixed(1);
    const tip = !lenInfo ? t("tip_videoLength")
      : lenInfo.max
        ? t("tip_videoLengthRange", { min: lenInfo.min, max: lenInfo.max, smin: secs(lenInfo.min), smax: secs(lenInfo.max), fps: lenInfo.fps, step: lenInfo.step })
        : t("tip_videoLengthGrid", { min: lenInfo.min, fps: lenInfo.fps, step: lenInfo.step });
    el.title = tip;
    if (dom.comfyParamLengthLabel) dom.comfyParamLengthLabel.title = tip;
  }
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

// A wide SCAIL-2 window is a per-GPU gamble, not a flat setting: chained segments live in
// ONE graph and each segment's output stays resident to condition the next, so the budget
// shrinks as the chain advances. On a 32GB card 2x at 736x1280 renders segment 1 and then
// dies in segment 2 with comfy_aimdo's `Fault failed: 2`. Warn instead of clamping — the
// user picked this deliberately, and whether it fits depends on clip length and resolution
// too, neither of which this knob knows. 40GB is the tier above the 5090's 32GB, so it is
// the point where the measured failure stops being the expected outcome.
export function updateScailWindowWarning() {
  const el = dom.comfyParamScailWindowWarn;
  if (!el) return;
  const mult = Number(dom.comfyParamScailWindow?.value || 1);
  const gib = state.comfyVramGib;
  const risky = mult > 1 && typeof gib === "number" && gib > 0 && gib < 40;
  el.textContent = risky ? t("warn_scailWindowVram", { gb: gib.toFixed(0) }) : "";
  el.hidden = !risky;
}

// ── ⚙ Video length: frames, or a duration ─────────────────────────────────────
// The field's unit is FRAMES, because that is what every generator actually takes and
// what its grid is expressed in. But nobody thinks in frames — they think "about ten
// seconds" — and the conversion needs the model's own fps and frame grid to come out
// right, which is exactly what the user doesn't have to hand. So the field also accepts
// a duration ("10s", "1.5s", "90 sec") and converts it here, in place, so the frame
// count it resolved to is visible BEFORE the render rather than inferred from the result.

// The frame grid + rate to convert against. min/step/max are read back off the input,
// where updateComfyMultiHint has already written the selected model's real preset
// values — so there is no second table here to drift out of step with the server's.
function lengthGrid() {
  const el = dom.comfyParamLength;
  const v = dom.comfyModelSelect?.value || "";
  const info = (v && state.comfyLenInfo && state.comfyLenInfo.get(v)) || null;
  // A ⚙ fps override changes what a second IS, but only on models whose rate the field
  // can actually reach — elsewhere the model's own rate is the only true one.
  const tunable = !!(state.comfyFpsTunable && state.comfyFpsTunable.has(v));
  const ovFps = tunable ? Number(dom.comfyParamFps?.value) : NaN;
  const min = Number(el?.min) || 5;
  return {
    min,
    step: Number(el?.step) || 4,
    max: Number(el?.max) || 0,
    // Grid origin, from the server's own preset. Absent (a model with no preset) → the
    // generic grid starts at min, which for those is 5 with step 4 = the 4n+1 rule.
    off: info && info.off != null ? info.off : min,
    fps: (isFinite(ovFps) && ovFps > 0) ? ovFps : (info ? info.fps : 24),
  };
}

// Nearest valid frame count for this model — a direct port of the server's snapLength,
// in the same order (clamp into the trained range, snap onto step·n + off, then push
// back inside if the snap left it), so the number shown here is the number rendered.
function snapFrames(n, g) {
  const hi = g.max || Infinity;
  let out = Math.round((Math.min(hi, Math.max(g.min, n)) - g.off) / g.step) * g.step + g.off;
  if (out < g.min) out += g.step;
  if (out > hi) out -= g.step;
  return out;
}

// Read the field as either a frame count or a duration. Accepts "10s", "10 s", "10sec",
// "10 seconds", the Chinese second-suffixes listed in the pattern below, and a bare
// number (frames). Returns null for anything unparseable — including the empty field,
// which means "Auto" and must be left exactly as it is.
function parseLength(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  const m = /^(\d+(?:\.\d+)?)\s*(s|sec|secs|second|seconds|秒|秒钟|秒鐘)$/i.exec(s);
  if (m) return { seconds: parseFloat(m[1]) };
  const n = /^(\d+(?:\.\d+)?)$/.exec(s);
  return n ? { frames: parseFloat(n[1]) } : null;
}

// Resolve whatever is typed to a snapped frame count and write it back. Runs on commit
// (blur / Enter), never mid-keystroke — rewriting "1" to "5" while someone is still
// typing "10s" would make the field impossible to use.
export function normalizeLengthField() {
  const el = dom.comfyParamLength;
  if (!el) return;
  const parsed = parseLength(el.value);
  if (!parsed) { if (el.value.trim()) el.value = ""; updateLengthHint(); return; }
  const g = lengthGrid();
  const frames = parsed.seconds != null ? parsed.seconds * g.fps : parsed.frames;
  el.value = String(snapFrames(frames, g));
  updateLengthHint();
}

// One grid step up or down — a text field has no spinner, so ↑/↓ are re-implemented on
// the model's REAL grid rather than the fixed 1 a number field would have used. From an
// empty field it starts at that model's own Auto length, so the first press lands
// somewhere sensible instead of at the bottom of the range.
export function stepLengthField(dir) {
  const el = dom.comfyParamLength;
  if (!el) return;
  const g = lengthGrid();
  const cur = parseLength(el.value);
  const info = state.comfyLenInfo?.get(dom.comfyModelSelect?.value || "");
  const from = cur
    ? (cur.seconds != null ? cur.seconds * g.fps : cur.frames)
    : (info ? info.auto : g.min);
  el.value = String(snapFrames(snapFrames(from, g) + (dir > 0 ? g.step : -g.step), g));
  updateLengthHint();
}

// Say what the current frame count is in seconds — the same arithmetic in reverse, so
// a converted duration can be checked against what was asked for, and a hand-typed
// frame count stops being an opaque number.
export function updateLengthHint() {
  const el = dom.comfyParamLengthHint;
  if (!el) return;
  const parsed = parseLength(dom.comfyParamLength?.value);
  const g = lengthGrid();
  if (!parsed) { el.hidden = true; el.textContent = ""; return; }   // empty = Auto; the field's own label carries the hiding
  const frames = parsed.seconds != null ? snapFrames(parsed.seconds * g.fps, g) : parsed.frames;
  el.textContent = t("comfy_lengthHint", { sec: (frames / g.fps).toFixed(1), frames: snapFrames(frames, g), fps: g.fps });
  el.hidden = false;
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
  // 3D mesh models: image-conditioned only (no text encoder in any of these graphs),
  // so the prompt add-ons / guidance / denoise knobs would all silently do nothing.
  // Hunyuan3D is the one with a real KSampler, so it alone keeps the sampler row.
  const mesh = !!(state.comfyMeshModels && state.comfyMeshModels.has(m));
  // Hunyuan3D and TripoSplat run real KSamplers; MoGe has none (pure estimation).
  const meshSampler = mesh && (/hunyuan[._-]?3d/i.test(m) || m === "triposplat");
  // Hide a field by its <label> (or, for the frame-interpolation pair, the shared .comfyParamRow; the
  // pick-person button has no label, so fall back to the element itself).
  const setVis = (el, on, sel) => { if (!el) return; const box = sel ? el.closest(sel) : (el.closest("label") || el); if (box) box.hidden = !on; };
  // Wan Dancer (music → dance) — its own genre/amplitude/duration/quality knobs; the
  // generic frame-length and fps fields are hidden for it (duration is picked in
  // SECONDS below, and the recipe's output rate is fixed at 30 fps).
  const dancer = /dancer/i.test(m);
  for (const el of [dom.comfyParamDanceStyle, dom.comfyParamDanceAmplitude, dom.comfyParamDanceDuration]) setVis(el, dancer);
  setVis(dom.comfyParamDanceQuality, dancer, ".comfyParamCheck");
  // Video timing — gen length is diffusion-only (an upscale / VFI keeps the source's own length).
  setVis(dom.comfyParamLength, video && diffusion && !dancer);
  // A model absent from comfyFpsTunable has a fixed rate (older server sends no such
  // flag, so an EMPTY set must not hide the field for everyone — hence the size check).
  const fpsTunable = !state.comfyFpsTunable?.size || state.comfyFpsTunable.has(m);
  setVis(dom.comfyParamFps, video && !dancer && fpsTunable);
  // Timeout: mesh renders ride the video timeout policy (Hunyuan3D can take minutes).
  setVis(dom.comfyParamTimeout, video || mesh);
  // 3D knobs. meshDetail drives BOTH meshers — Hunyuan3D's voxel octree and
  // SplatToMesh's density grid — and TripoSplat always meshes now, so this is
  // simply "the two mesh models".
  setVis(dom.comfyParamMeshDetail, mesh && (/hunyuan[._-]?3d/i.test(m) || m === "triposplat"));
  // Latent token budget is Hunyuan3D's alone (TripoSplat's decoder has no equivalent).
  setVis(dom.comfyParamShapeTokens, mesh && /hunyuan[._-]?3d/i.test(m));
  const paintable = !!(state.comfyMeshPaintModels && state.comfyMeshPaintModels.has(m));
  setVis(dom.comfyParamPaintMesh, paintable, ".comfyParamCheck");
  // Quality only means something while texturing is actually on.
  setVis(dom.comfyParamPaintQuality, paintable && !!dom.comfyParamPaintMesh?.checked);
  setVis(dom.comfyParamKeepBackground, mesh && /hunyuan[._-]?3d/i.test(m), ".comfyParamCheck");
  setVis(dom.comfyParamMeshGaussians, m === "triposplat");
  setVis(dom.comfyParamMogeDetail, m === "moge-mesh" || m === "moge-panorama");
  setVis(dom.comfyParamMogeFov, m === "moge-mesh");
  setVis(dom.comfyParamPanoRefine, m === "moge-panorama");
  setVis(dom.comfyParamPanoModel, m === "panorama_360_text");
  // The photo-side settings only mean anything once a photo is attached, but the
  // modal is opened before that as often as after, so they stay with the recipe.
  for (const el of [dom.comfyParamPanoProj, dom.comfyParamPanoFov, dom.comfyParamPanoOutpaint]) {
    setVis(el, m === "panorama_360_text");
  }
  // The LoRA slot is only worth showing when there is something to put in it.
  const hasPanoLora = !!(dom.comfyParamPanoLora && dom.comfyParamPanoLora.options.length > 1);
  setVis(dom.comfyParamPanoLora, m === "panorama_360_text" && hasPanoLora);
  setVis(dom.comfyParamPanoLoraStrength, m === "panorama_360_text" && hasPanoLora);
  setVis(dom.comfyParamMogeSubject, m === "moge-mesh", ".comfyParamCheck");
  // Video codec + its CRF: every video model (the tail rewrite is builder-agnostic).
  for (const el of [dom.comfyParamVideoCodec, dom.comfyParamVideoCrf]) setVis(el, video);
  if (video) syncVideoCrfPlaceholder();
  setVis(dom.comfyParamTargetFps, video, ".comfyParamRow");          // frame-interpolation + interpolation-engine row
  // torch.compile: Wan Animate (both modes) AND SCAIL-2 — both chain segments, which is
  // what makes the one-time compile pay off. Relight strength stays Wan-Animate-only
  // (SCAIL-2 has no relight LoRA).
  setVis(dom.comfyParamTorchCompile, animate || scail2);
  setVis(dom.comfyParamRelight, animate);
  // Replace only: which person in the source to swap out.
  setVis(dom.comfyMaskPointBtn, animateReplace);
  // Bernini only — turbo is otherwise forced on by the mere presence of the distill
  // LoRA, and ref_max_size is the only knob on how much reference detail survives.
  for (const el of [dom.comfyParamBerniniMode, dom.comfyParamRefMaxSize]) setVis(el, /bernini/i.test(m));
  // Edit-task lines are VIDEO tasks — hide them for the bernini image entries.
  setVis(dom.comfyParamBerniniTask, /bernini/i.test(m) && !/bernini_(image_edit|subject_image|text_image)/i.test(m));
  // EasyCache is only WIRED into the MiniMax H3 builder — showing it elsewhere would be
  // a control that reaches no graph. Gated by name, like the H3 reference-detail knob.
  setVis(dom.comfyParamEasyCache, /minimax.?h3/i.test(m), ".comfyParamCheck");
  // "Silent video" — only where there is a track to drop (generated or carried through).
  setVis(dom.comfyParamNoAudio, !!(state.comfyAudioModels && state.comfyAudioModels.has(m)), ".comfyParamCheck");
  // MiniMax H3: reference sizing exists only on the reference→video weights (ref2va).
  // The t2v/i2v file (fl2va) has no reference pipeline, so the knob would be inert there.
  setVis(dom.comfyParamH3RefSize, /minimax.?h3.*ref2va/i.test(m));
  // The H3 text-encoder picker applies to BOTH weights (they share the encoder). Hidden
  // when only one build is installed — a menu whose sole entry equals Auto is noise.
  setVis(dom.comfyParamH3Clip, /minimax.?h3/i.test(m) && (state.comfyH3Encoders || 0) > 1);
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
                    dom.comfyParamScailSortBy, dom.comfyParamScailRecipe, dom.comfyParamScailWindow, dom.comfyParamPoseStrength, dom.comfyParamPoseStart,
                    dom.comfyParamPoseEnd]) setVis(el, scail2);
  // Same family, but a checkbox — it needs the .comfyParamCheck box, not its <label>.
  // 长片内存策略:SCAIL-2 与 Wan Animate 共用(两者都有输出侧累积的问题)。
  setVis(dom.comfyParamScailMemory, scail2 || animate);
  updateScailWindowWarning();
  updateLengthHint();   // the grid + fps it reports are per-model
  // Upscale-model pipelines only (image-upscale / video-enhance) — the upscale-denoise % + the upscale-model picker.
  for (const el of [dom.comfyParamUpscaleDenoise, dom.comfyParamUpscaleModel, dom.comfyParamRestoreModel]) setVis(el, upscale);
  // The output target is a VIDEO-upscale control: the image path takes its size from --size.
  setVis(dom.comfyParamUpscaleTarget, /video-enhance/i.test(m));
  // Sharpening is wired into the video-enhance builder only (the image upscale tail has
  // no equivalent node), so it stays with that entry.
  setVis(dom.comfyParamSharpen, /video-enhance/i.test(m));
  // Image-edit / txt2img only.
  setVis(dom.comfyParamImageCfg, diffusion && !video && !mesh);
  // Quantisation preference — diffusion models only (the upscale pipelines load an
  // upscale model, which has no precision variants; the mesh chains ship one file each).
  setVis(dom.comfyParamPrecision, diffusion && !mesh);
  if (diffusion && !mesh) syncPrecisionOptions(m);
  // Prompt add-ons — every diffusion model reads them (an upscale pipeline takes no
  // prompt, and the mesh chains have no text conditioning at all).
  setVis(dom.comfyParamPositive, diffusion && !mesh);
  // Empty set = a server too old to send the flag; don't hide the box for every video
  // model then (same guard as cfg / fps above).
  const negTunable = !video || !state.comfyNegativeTunable?.size || state.comfyNegativeTunable.has(m);
  setVis(dom.comfyParamNegative, diffusion && !mesh && negTunable);
  // Guidance + img2img denoise are IMAGE-only: no video builder accepts either
  // (resolveVideoConfig doesn't even carry them).
  for (const el of [dom.comfyParamGuidance, dom.comfyParamDenoise]) setVis(el, diffusion && !video && !mesh);
  // Sampler / scheduler / steps / cfg: honoured by every image model, but only by the
  // preset-driven video models. SCAIL-2 / Wan Animate / bernini hardcode a schedule
  // bound to their distill LoRA and ignore these — so hide rather than lie. Of the
  // mesh chains only Hunyuan3D runs a real KSampler.
  const samplerTunable = !video || !!(state.comfySamplerTunable && state.comfySamplerTunable.has(m));
  const shows = (diffusion && samplerTunable && !mesh) || meshSampler;
  for (const el of [dom.comfyParamSampler, dom.comfyParamScheduler, dom.comfyParamSteps]) setVis(el, shows);
  // cfg additionally requires the model to actually have a guidance scale (see above).
  // Empty set = a server too old to send the flag; don't hide cfg for every video model
  // then (that happens whenever the page is hard-refreshed before the server restarts).
  const cfgTunable = !video || !state.comfyCfgTunable?.size || state.comfyCfgTunable.has(m);
  setVis(dom.comfyParamCfg, shows && cfgTunable);
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
    dom.comfyParamMeshDetail,
    dom.comfyParamShapeTokens,
    dom.comfyParamMeshGaussians,
    dom.comfyParamMogeDetail,
    dom.comfyParamMogeFov,
    dom.comfyParamPanoModel,
    dom.comfyParamPanoFov,
    dom.comfyParamPanoOutpaint,
    dom.comfyParamPanoLoraStrength,
    dom.comfyParamPanoRefine,
    dom.comfyParamTargetFps,
    dom.comfyParamUpscaleDenoise,
    dom.comfyParamUpscaleTarget,
    dom.comfyParamRestoreModel,
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
    dom.comfyParamScailRecipe,
    dom.comfyParamScailWindow,
    dom.comfyParamScailMemory,
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
    // Escape closes without blurring the focused field, so a typed duration would never
    // reach its change handler and "10s" would read back as no value at all.
    normalizeLengthField();
    saveCurrentSettings();
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
  // The window-size caution depends on the chosen multiplier, so it has to re-evaluate on
  // change — open() alone would only catch it when the panel is reopened.
  dom.comfyParamScailWindow?.addEventListener("change", updateScailWindowWarning);
  // Length: resolve on COMMIT only (blur / Enter), so a half-typed "10s" is never
  // rewritten out from under the cursor; the hint tracks every keystroke. The re-save
  // is not redundant — the generic `fields` loop above is registered first, so it
  // persists the raw text; this overwrites it with the resolved frame count.
  dom.comfyParamLength?.addEventListener("change", () => { normalizeLengthField(); saveCurrentSettings(); });
  dom.comfyParamLength?.addEventListener("input", updateLengthHint);
  dom.comfyParamLength?.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    stepLengthField(e.key === "ArrowUp" ? 1 : -1);
    saveCurrentSettings();
  });
  // A ⚙ fps override redefines the second, so the same frame count means a new duration.
  dom.comfyParamFps?.addEventListener("change", updateLengthHint);
  // Checkboxes carry .checked, not .value, so they're outside `fields`. The splat-mesh
  // one also gates the mesh-detail row, so it re-runs visibility on toggle.
  dom.comfyParamKeepBackground?.addEventListener("change", () => saveCurrentSettings());
  dom.comfyParamMogeSubject?.addEventListener("change", () => saveCurrentSettings());
  dom.comfyParamPanoRefine?.addEventListener("change", () => saveCurrentSettings());
  dom.comfyParamPanoModel?.addEventListener("change", () => saveCurrentSettings());
  dom.comfyParamPanoProj?.addEventListener("change", () => saveCurrentSettings());
  dom.comfyParamPanoLora?.addEventListener("change", () => saveCurrentSettings());
  // Texturing toggle gates the quality row, so it re-runs visibility too.
  dom.comfyParamPaintMesh?.addEventListener("change", () => { saveCurrentSettings(); updateComfyParamVisibility(); });
  // Ultra makes a ~17 MB GLB (measured) that then rides base64 through the response
  // and the conversation store — worth a heads-up before the first slow run, not a
  // surprise afterwards.
  dom.comfyParamPaintQuality?.addEventListener("change", () => {
    if (dom.comfyParamPaintQuality.value === "ultra" && !confirm(t("comfy_paintQuality_confirmUltra"))) {
      dom.comfyParamPaintQuality.value = "fine";
    }
    saveCurrentSettings();
  });
  dom.comfyParamBerniniMode?.addEventListener("change", () => saveCurrentSettings());
  dom.comfyParamBerniniTask?.addEventListener("change", () => saveCurrentSettings());
  for (const el of [dom.comfyParamDanceStyle, dom.comfyParamDanceAmplitude, dom.comfyParamDanceDuration, dom.comfyParamDanceQuality]) el?.addEventListener("change", () => saveCurrentSettings());
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
    if (dom.comfyParamDanceStyle) dom.comfyParamDanceStyle.value = "";
    if (dom.comfyParamDanceAmplitude) dom.comfyParamDanceAmplitude.value = "";
    if (dom.comfyParamDanceDuration) dom.comfyParamDanceDuration.value = "";
    if (dom.comfyParamDanceQuality) dom.comfyParamDanceQuality.checked = false;
    if (dom.comfyParamInterpMethod) dom.comfyParamInterpMethod.value = "rife";
    if (dom.comfyParamVideoCodec) dom.comfyParamVideoCodec.value = "h264"; // default codec, not empty
    if (dom.comfyParamPaintQuality) dom.comfyParamPaintQuality.value = "standard";
    if (dom.comfyParamPaintMesh) dom.comfyParamPaintMesh.checked = true;   // texturing defaults ON
    updateComfyParamVisibility();
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