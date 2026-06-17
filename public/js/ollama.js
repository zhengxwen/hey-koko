// Ollama URL management and model loading
import { dom } from './state.js';
import { SETTINGS_KEY } from './constants.js';
import { t } from './i18n.js';
import { saveCurrentSettings } from './settings.js';

function updateUrlDisplay(url, imageUrl, comfyUrl) {
  const display = url.replace(/^https?:\/\//, "");
  dom.llmUrlDisplay.textContent = display;
  dom.imageUrlDisplay.textContent = (imageUrl || url).replace(/^https?:\/\//, "");
  if (dom.comfyUrlDisplay) {
    dom.comfyUrlDisplay.textContent = (comfyUrl || "http://127.0.0.1:8188").replace(/^https?:\/\//, "");
  }
}

function editOllamaUrl(type) {
  const displayEl =
    type === "comfy" ? dom.comfyUrlDisplay : type === "image" ? dom.imageUrlDisplay : dom.llmUrlDisplay;
  const currentUrl = displayEl.textContent;
  const labels = { comfy: "ComfyUI", image: "图片模型", llm: "LLM" };
  const defaultHint = type === "comfy" ? "127.0.0.1:8188" : "127.0.0.1:11434";
  const newUrl = prompt(`编辑${labels[type] || "LLM"}服务地址（留空使用本机 ${defaultHint}）:`, currentUrl);
  if (newUrl === null) return;
  fetch("/api/set-ollama-url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type, url: newUrl })
  }).then(r => r.json()).then(data => {
    displayEl.textContent = data.url.replace(/^https?:\/\//, "");
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

export async function loadComfyModels() {
  if (!dom.comfyModelSelect) return;
  try {
    const response = await fetch("/api/comfy-models");
    const data = await response.json();
    const models = data.models || [];
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    const current = saved.comfyModel || dom.comfyModelSelect.value;
    dom.comfyModelSelect.innerHTML = "";

    if (models.length === 0) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = t("comfy_model_none");
      dom.comfyModelSelect.appendChild(option);
    } else {
      for (const name of models) {
        const option = document.createElement("option");
        option.value = name;
        option.textContent = name;
        dom.comfyModelSelect.appendChild(option);
      }
      if (current && models.includes(current)) {
        dom.comfyModelSelect.value = current;
      } else {
        dom.comfyModelSelect.value = models[0];
      }
    }
  } catch {
    /* leave placeholder */
  } finally {
    updateImageGenOptions();
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
    dom.comfyParamSampler,
    dom.comfyParamScheduler,
    dom.comfyParamSteps,
    dom.comfyParamCfg,
    dom.comfyParamGuidance,
    dom.comfyParamDenoise,
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

  // Persist on every change so the values survive reloads.
  for (const el of fields) {
    el?.addEventListener("change", () => saveCurrentSettings());
  }

  dom.comfyParamsReset?.addEventListener("click", () => {
    for (const el of fields) if (el) el.value = "";
    saveCurrentSettings();
  });
}

export function initOllama() {
  fetch("/api/ollama-url").then(r => r.json()).then(d => updateUrlDisplay(d.url, d.imageUrl, d.comfyUrl)).catch(() => {});

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
        dom.llmUrlDisplay.textContent = data.url.replace(/^https?:\/\//, "");
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
        if (dom.comfyUrlDisplay) dom.comfyUrlDisplay.textContent = data.url.replace(/^https?:\/\//, "");
        loadComfyModels().catch(() => {});
      }).catch(() => {});
    },
  }));
}
