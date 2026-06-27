// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

// Ollama URL management and model loading
import { dom, state } from './state.js';
import { SETTINGS_KEY } from './constants.js';
import { t } from './i18n.js';
import { saveCurrentSettings } from './settings.js';
import { getBgWorkers, setBgWorkerStatus } from './bg-jobs.js';

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

function updateUrlDisplay(data) {
  const { url, imageUrl, comfyUrl, hostname, imageHostname, comfyHostname } = data;
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
  const labels = { comfy: "ComfyUI", image: "图片模型", llm: "LLM" };
  const defaultHint = type === "comfy" ? "127.0.0.1:8188" : "127.0.0.1:11434";
  const newUrl = prompt(`编辑${labels[type] || "LLM"}服务地址（留空使用本机 ${defaultHint}）:`, currentUrl);
  if (newUrl === null) return;
  fetch("/api/set-ollama-url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type, url: newUrl })
  }).then(r => r.json()).then(data => {
    displayEl.textContent = formatUrl(data.url, data.hostname);
    if (type === "comfy") {
      loadComfyModels().catch(() => {});
    } else if (type === "image") {
      loadImageModels().catch(() => {});
    } else {
      loadModels().catch(() => {});
    }
  }).catch(() => {});
}

// Embedding and image models live in their own dropdowns — keep them out of the LLM list.
const NON_LLM_RE = /embed|z-image|flux/i;

export async function loadModels() {
  const response = await fetch("/api/models");
  const data = await response.json();
  const models = (data.models || [])
    .map((model) => model.name)
    .filter((name) => name && !NON_LLM_RE.test(name));

  if (models.length === 0) return;

  const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
  const current = saved.model || dom.modelSelect.value;
  dom.modelSelect.innerHTML = "";
  for (const name of models) {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = name;
    dom.modelSelect.appendChild(option);
  }

  if (current && models.includes(current)) {
    dom.modelSelect.value = current;
  } else {
    const preferred = models.find((m) => /gemma|qwen/i.test(m));
    dom.modelSelect.value = preferred || models[0];
  }
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
  const uModels = new Map(), uEdit = new Map(), uVideo = new Map();
  await Promise.all(targets.map(async (url) => {
    try {
      const d = await (await fetch(`/api/comfy-models?comfyUrl=${encodeURIComponent(url)}`)).json();
      const models = d.models || [], editModels = d.editModels || [], videoModels = d.videoModels || [];
      const sets = {
        image: new Set(models),
        edit: new Set(editModels.map((m) => m.name)),
        video: new Set(videoModels.map((m) => m.name)),
        videoIn: new Set(videoModels.filter((m) => m.needsVideo).map((m) => m.name)),
        multiImage: new Set(editModels.filter((m) => m.type === "qwen").map((m) => m.name)),
      };
      const online = (models.length + editModels.length + videoModels.length) > 0;
      setBgWorkerStatus(url, { online, models: sets, hostname: d.hostname || "" });
      for (const n of models) if (!uModels.has(n)) uModels.set(n, n);
      for (const m of editModels) if (!uEdit.has(m.name)) uEdit.set(m.name, m);
      for (const m of videoModels) if (!uVideo.has(m.name)) uVideo.set(m.name, m);
    } catch { setBgWorkerStatus(url, { online: false }); }
  }));
  applyComfyModels({ models: [...uModels.values()], editModels: [...uEdit.values()], videoModels: [...uVideo.values()] });
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
    // Source-video models (bernini / animate): output fps follows the source video.
    state.comfyVideoInModels = new Set(videoModels.filter((m) => m.needsVideo).map((m) => m.name));
    // Qwen-Image-Edit accepts 2-3 reference images (multi-image composition).
    state.comfyMultiImageModels = new Set(editModels.filter((m) => m.type === "qwen").map((m) => m.name));
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    const current = saved.comfyModel || dom.comfyModelSelect.value;
    const allNames = [...models, ...editModels.map((m) => m.name), ...videoModels.map((m) => m.name)];
    dom.comfyModelSelect.innerHTML = "";

    if (allNames.length === 0) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = t("comfy_model_none");
      dom.comfyModelSelect.appendChild(option);
    } else {
      // Display without the file extension; the value keeps the full filename
      // (the server matches models by filename). An explicit label wins as-is.
      const stripExt = (n) => n.replace(/\.(safetensors|ckpt|gguf|pth|sft|bin)$/i, "");
      const addOption = (parent, name, label) => {
        const option = document.createElement("option");
        option.value = name;
        option.textContent = label || stripExt(name);
        parent.appendChild(option);
      };
      if (models.length) {
        const group = document.createElement("optgroup");
        group.label = t("comfy_image_group");
        for (const name of models) addOption(group, name);
        dom.comfyModelSelect.appendChild(group);
      }
      if (editModels.length) {
        const group = document.createElement("optgroup");
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
        group.label = t("comfy_video_group");
        for (const m of videoGen) addOption(group, m.name, m.label);
        dom.comfyModelSelect.appendChild(group);
      }
      if (videoIn.length) {
        const group = document.createElement("optgroup");
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
  if (/wan/.test(m)) return /14b/.test(m) ? { fps: 16, length: 81 } : { fps: 24, length: 49 };
  return null;
}

// The key ComfyUI workflow components hey-koko wires for a model — inferred from
// its filename (mirrors the build functions in server/comfy.js). Shown in the ⚙
// panel so the user can see the pipeline a model actually runs.
function comfyModelComponents(name) {
  const n = (name || "").toLowerCase();
  // Video
  if (/animate/.test(n)) return "Wan Animate (pose transfer) · UNETLoader + lightx2v + relight LoRA · ModelSamplingSD3 · LoadVideo→DWPose(pose+face) · WanAnimateToVideo · segment length adapts to resolution (≤640: 241f · 720p: 161f · 1080p: 65f) — a longer source is generated in chunks with continue_motion for seamless joins, then merged";
  if (/bernini/.test(n)) return "WAN2.2 MoE · UNETLoader ×2 · CLIP umt5(wan) · VAE wan_2.1 · BerniniConditioning · SamplerCustom ×2 · v2v: LoadVideo→GetVideoComponents · turbo: LightX2V distill LoRA";
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
  if (dom.comfyParamFps) dom.comfyParamFps.placeholder = followsSource ? t("comfy_fps_source") : `Auto (${auto ? auto.fps : 24})`;
  // Wan Animate "auto" length = the FULL source clip (generated in segments + merged
  // when it exceeds the single-pass cap); other models use a fixed preset length.
  const lengthFollowsSource = !!(v && /animate/i.test(v));
  if (dom.comfyParamLength) dom.comfyParamLength.placeholder = lengthFollowsSource ? t("comfy_length_source") : `Auto (${auto ? auto.length : 49})`;
  if (dom.comfyModelInfo) {
    const comps = comfyModelComponents(v);
    dom.comfyModelInfo.textContent = comps;
    dom.comfyModelInfo.hidden = !comps;
  }
}

export async function loadEmbedModels() {
  if (!dom.embedModelSelect) return;
  try {
    const response = await fetch("/api/models");
    const data = await response.json();
    // Only models with "embed" in the name are valid embedding models.
    const models = (data.models || []).map((m) => m.name).filter((n) => n && /embed/i.test(n));
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    const current = saved.embedModel || dom.embedModelSelect.value;
    dom.embedModelSelect.innerHTML = "";

    if (models.length === 0) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "未检测到 embedding 模型";
      dom.embedModelSelect.appendChild(opt);
      return;
    }
    for (const name of models) {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      dom.embedModelSelect.appendChild(opt);
    }
    if (current && models.includes(current)) {
      dom.embedModelSelect.value = current;
    } else {
      const preferred = models.find((m) => /qwen3-embedding/i.test(m));
      dom.embedModelSelect.value = preferred || models[0];
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
    dom.comfyParamNegative,
    dom.comfyParamSampler,
    dom.comfyParamScheduler,
    dom.comfyParamSteps,
    dom.comfyParamCfg,
    dom.comfyParamGuidance,
    dom.comfyParamImageCfg,
    dom.comfyParamDenoise,
    dom.comfyParamLength,
    dom.comfyParamFps,
    dom.comfyParamRelight,
  ];

  function open() {
    modal.hidden = false;
    document.addEventListener("keydown", onKeydown);
  }
  function close() {
    modal.hidden = true;
    document.removeEventListener("keydown", onKeydown);
  }
  function onKeydown(e) {
    if (e.key === "Escape") { e.preventDefault(); close(); }
  }

  dom.comfyParamsBtn?.addEventListener("click", open);
  dom.comfyParamsClose?.addEventListener("click", close);
  modal.addEventListener("click", (e) => { if (e.target === modal) close(); });

  // Persist on every change so the values survive reloads. The torch.compile toggle
  // is a checkbox (.checked, not .value) so it's handled separately from `fields`.
  for (const el of fields) {
    el?.addEventListener("change", () => saveCurrentSettings());
  }
  dom.comfyParamTorchCompile?.addEventListener("change", () => saveCurrentSettings());

  dom.comfyParamsReset?.addEventListener("click", () => {
    for (const el of fields) if (el) el.value = "";
    if (dom.comfyParamTorchCompile) dom.comfyParamTorchCompile.checked = false;
    saveCurrentSettings();
  });
}

export function initOllama() {
  fetch("/api/ollama-url").then(r => r.json()).then(d => updateUrlDisplay(d)).catch(() => {});

  initComfyParamsModal();

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
        loadModels().catch(() => {});
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
        loadComfyModels().catch(() => {});
      }).catch(() => {});
    },
  }));
}