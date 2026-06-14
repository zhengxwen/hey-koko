// Ollama URL management and model loading
import { dom } from './state.js';
import { SETTINGS_KEY } from './constants.js';

function updateUrlDisplay(url, imageUrl) {
  const display = url.replace(/^https?:\/\//, "");
  dom.llmUrlDisplay.textContent = display;
  dom.imageUrlDisplay.textContent = (imageUrl || url).replace(/^https?:\/\//, "");
}

function editOllamaUrl(type) {
  const displayEl = type === "image" ? dom.imageUrlDisplay : dom.llmUrlDisplay;
  const currentUrl = displayEl.textContent;
  const newUrl = prompt(`编辑${type === "image" ? "图片模型" : "LLM"}服务地址（留空使用本机 127.0.0.1:11434）:`, currentUrl);
  if (newUrl === null) return;
  fetch("/api/set-ollama-url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type, url: newUrl })
  }).then(r => r.json()).then(data => {
    displayEl.textContent = data.url.replace(/^https?:\/\//, "");
    if (type === "image") {
      loadImageModels().catch(() => {});
    } else {
      loadModels().catch(() => {});
    }
  }).catch(() => {});
}

export async function loadModels() {
  const response = await fetch("/api/models");
  const data = await response.json();
  const models = (data.models || []).map((model) => model.name).filter(Boolean);

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

export async function loadImageModels() {
  try {
    const response = await fetch("/api/image-models");
    const data = await response.json();
    const models = data.models || [];
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    const current = saved.imageModel || dom.imageModelSelect.value;
    dom.imageModelSelect.innerHTML = "";

    if (models.length === 0) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "未检测到图片模型";
      dom.imageModelSelect.appendChild(option);
      dom.imageGenOptions.style.display = "none";
    } else {
      dom.imageGenOptions.style.display = "";
      for (const name of models) {
        const option = document.createElement("option");
        option.value = name;
        option.textContent = name;
        dom.imageModelSelect.appendChild(option);
      }
      if (current && models.includes(current)) {
        dom.imageModelSelect.value = current;
      } else {
        const preferred = models.find((m) => /z-image|flux2/i.test(m));
        dom.imageModelSelect.value = preferred || models[0];
      }
    }
  } catch {
    dom.imageGenOptions.style.display = "none";
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

export function initOllama() {
  fetch("/api/ollama-url").then(r => r.json()).then(d => updateUrlDisplay(d.url, d.imageUrl)).catch(() => {});

  document.querySelector("#editLlmUrl").addEventListener("click", (e) => { e.preventDefault(); editOllamaUrl("llm"); });
  document.querySelector("#editImageUrl").addEventListener("click", (e) => { e.preventDefault(); editOllamaUrl("image"); });

  document.querySelector("#scanOllama").addEventListener("click", async () => {
    const btn = document.querySelector("#scanOllama");
    btn.disabled = true;
    btn.textContent = "扫描中…";
    try {
      const includeLocal = document.querySelector("#includeLocal").checked;
      const res = await fetch("/api/scan-ollama", { method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({ includeLocal }) });
      const data = await res.json();
      if (data.found && data.found.length > 0) {
        btn.textContent = "✓ " + data.selected.replace("http://", "");
        dom.llmUrlDisplay.textContent = data.selected.replace(/^https?:\/\//, "");
        loadModels().catch(() => {});
        loadImageModels().catch(() => {});
        setTimeout(() => { btn.textContent = "扫描"; btn.disabled = false; }, 3000);
      } else {
        btn.textContent = "未找到";
        setTimeout(() => { btn.textContent = "扫描"; btn.disabled = false; }, 2000);
      }
    } catch {
      btn.textContent = "失败";
      setTimeout(() => { btn.textContent = "扫描"; btn.disabled = false; }, 2000);
    }
  });
}
