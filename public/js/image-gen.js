// Image generation and /imagine command parsing
import { dom, state } from './state.js';
import { ASPECT_ALIASES } from './constants.js';
import { t, getPromptLanguage } from './i18n.js';
import { makePreview, escapeHtml } from './utils.js';
import { setAvatarState } from './avatar.js';
import { saveChat } from './settings.js';
import { getTab, getActiveTab } from './tabs.js';
import { markdownToHtml } from './markdown.js';

// setGenerating and renderChat will be injected from main
let _setGenerating = null;
let _renderChat = null;
export function setDeps({ setGenerating, renderChat }) {
  _setGenerating = setGenerating;
  _renderChat = renderChat;
}

// Read the ComfyUI advanced-params modal into an options overlay. Only fields
// the user explicitly set are included — empty fields fall back to the server's
// per-model defaults.
function comfyOverrides() {
  const ov = {};
  const num = (v) => (v !== "" && v != null && !isNaN(Number(v)) ? Number(v) : undefined);
  if (dom.comfyParamSampler?.value) ov.sampler = dom.comfyParamSampler.value;
  if (dom.comfyParamScheduler?.value) ov.scheduler = dom.comfyParamScheduler.value;
  const steps = num(dom.comfyParamSteps?.value);
  if (steps !== undefined) ov.steps = steps;
  const cfg = num(dom.comfyParamCfg?.value);
  if (cfg !== undefined) ov.cfg = cfg;
  const guidance = num(dom.comfyParamGuidance?.value);
  if (guidance !== undefined) ov.guidance = guidance;
  const imageCfg = num(dom.comfyParamImageCfg?.value);
  if (imageCfg !== undefined) ov.imageCfg = imageCfg;
  const denoise = num(dom.comfyParamDenoise?.value);
  if (denoise !== undefined) ov.denoise = denoise;
  const length = num(dom.comfyParamLength?.value);
  if (length !== undefined) ov.length = length;
  const fps = num(dom.comfyParamFps?.value);
  if (fps !== undefined) ov.fps = fps;
  return ov;
}

export function parseNoteCommand(input) {
  const match = input.match(/^\/note\s+(.+)$/s);
  if (!match) return null;
  if (!match[1].trim()) {
    return { error: "缺少内容。用法：/note <内容>" };
  }
  return { content: match[1].trim() };
}

export function parseImagineCommands(input) {
  if (!input.match(/^\/imagine(\s|$)/)) return null;

  const lines = input.split(/\n/);
  const commands = [];
  let current = "";

  for (const line of lines) {
    if (line.match(/^\/imagine(\s|$)/)) {
      if (current) commands.push(current);
      current = line;
    } else {
      current += "\n" + line;
    }
  }
  if (current) commands.push(current);

  return commands.map((cmd) => parseImagineCommand(cmd));
}

function parseImagineCommand(input) {
  const match = input.match(/^\/imagine\s+(.+)$/s);
  if (!match) return null;

  if (!match[1].trim()) {
    return { error: "缺少提示词。用法：/imagine <提示词>" };
  }

  let rest = match[1].trim();
  const result = { prompt: "", count: 1, options: {}, negativePrompt: "", enhance: false };

  const batchMatch = rest.match(/^(\d+)x\s+(.+)$/s);
  if (batchMatch) {
    const n = parseInt(batchMatch[1], 10);
    if (n < 1 || n > 8) {
      return { error: `批量数量 ${n} 超出范围。支持 1~8，如：4x 一只猫` };
    }
    result.count = n;
    rest = batchMatch[2];
  }

  const noMatch = rest.match(/--no\s+(.+)$/s);
  if (noMatch) {
    result.negativePrompt = noMatch[1].trim();
    rest = rest.slice(0, noMatch.index).trim();
  }

  while (rest.startsWith("--")) {
    if (/^--enhance\b/.test(rest)) {
      result.enhance = true;
      rest = rest.replace(/^--enhance\s*/, "").trim();
    } else if (/^--size\s/.test(rest)) {
      const sizeFlag = rest.match(/^--size\s+(\S+)/);
      if (!sizeFlag) return { error: "--size 需要参数。格式：--size 1024x1024" };
      const sizeVal = sizeFlag[1];
      const sizeParsed = sizeVal.match(/^(\d+)x(\d+)$/);
      if (!sizeParsed) {
        return { error: `--size 格式错误："${sizeVal}"。正确格式：--size 1024x1024` };
      }
      const w = parseInt(sizeParsed[1], 10);
      const h = parseInt(sizeParsed[2], 10);
      if (w < 256 || w > 2048 || h < 256 || h > 2048) {
        return { error: `--size 尺寸超出范围：${w}x${h}。宽高需在 256~2048 之间` };
      }
      result.options.width = w;
      result.options.height = h;
      result.sizeExplicit = true;
      rest = rest.replace(/^--size\s+\S+\s*/, "").trim();
    } else if (/^--(square|portrait|landscape|wide|tall)\b/.test(rest)) {
      const aliasMatch = rest.match(/^(--(?:square|portrait|landscape|wide|tall))\b/);
      const alias = aliasMatch[1];
      const size = ASPECT_ALIASES[alias];
      const [w, h] = size.split("x").map(Number);
      result.options.width = w;
      result.options.height = h;
      result.sizeExplicit = true;
      rest = rest.replace(new RegExp("^" + alias + "\\s*"), "").trim();
    } else if (/^--steps\s/.test(rest)) {
      const stepsFlag = rest.match(/^--steps\s+(\S+)/);
      if (!stepsFlag) return { error: "--steps 需要参数。格式：--steps 30" };
      const val = stepsFlag[1];
      const n = parseInt(val, 10);
      if (isNaN(n) || n < 1 || n > 100) {
        return { error: `--steps 值无效："${val}"。需为 1~100 的整数` };
      }
      result.options.steps = n;
      rest = rest.replace(/^--steps\s+\S+\s*/, "").trim();
    } else if (/^--seed\s/.test(rest)) {
      const seedFlag = rest.match(/^--seed\s+(\S+)/);
      if (!seedFlag) return { error: "--seed 需要参数。格式：--seed 42" };
      const val = seedFlag[1];
      const n = parseInt(val, 10);
      if (isNaN(n) || n < 0 || n > 2147483647) {
        return { error: `--seed 值无效："${val}"。需为 0~2147483647 的整数` };
      }
      result.options.seed = n;
      rest = rest.replace(/^--seed\s+\S+\s*/, "").trim();
    } else if (/^--quality\s/.test(rest)) {
      const qualityFlag = rest.match(/^--quality\s+(\S+)/);
      if (!qualityFlag) return { error: "--quality 需要参数。支持：high, medium, low" };
      const val = qualityFlag[1];
      if (!["high", "medium", "low"].includes(val)) {
        return { error: `--quality 值无效："${val}"。支持：high, medium, low` };
      }
      result.options.quality = val;
      rest = rest.replace(/^--quality\s+\S+\s*/, "").trim();
    } else {
      const unknownMatch = rest.match(/^--([\w-]+)/);
      return { error: `未知参数 "--${unknownMatch[1]}"。支持的参数：--size, --square, --portrait, --landscape, --wide, --tall, --steps, --seed, --quality, --enhance, --no` };
    }
  }

  if (!result.options.width) {
    const defaultSize = dom.defaultImageSize.value || "1024x1024";
    const [w, h] = defaultSize.split("x").map(Number);
    result.options.width = w;
    result.options.height = h;
  }

  result.prompt = rest.trim();

  if (!result.prompt) {
    return { error: "缺少提示词。请在参数后面添加图片描述，如：/imagine --landscape 一片星空" };
  }

  return result;
}

// Subscribe to ComfyUI's WebSocket (keyed by clientId) for live sampling
// progress and preview frames. comfyHost is "host:port" (no protocol). Returns
// an unsubscribe function. Best-effort — any failure just yields no updates.
//   - text "progress" messages → onProgress(value, max) (KSampler step counter)
//   - binary messages → a preview frame: 8-byte header (uint32 event=1, uint32
//     format 1=JPEG/2=PNG) then the image bytes → onPreview(objectUrl)
function subscribeComfyProgress(comfyHost, clientId, { onProgress, onPreview }) {
  if (!comfyHost) return () => {};
  let ws;
  try {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${proto}//${comfyHost}/ws?clientId=${encodeURIComponent(clientId)}`);
    ws.binaryType = "arraybuffer";
  } catch {
    return () => {};
  }
  ws.onmessage = (ev) => {
    if (typeof ev.data === "string") {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === "progress" && msg.data) onProgress?.(msg.data.value, msg.data.max);
      } catch { /* ignore non-JSON */ }
      return;
    }
    try {
      const view = new DataView(ev.data);
      if (view.getUint32(0) === 1) { // PREVIEW_IMAGE event
        const mime = view.getUint32(4) === 2 ? "image/png" : "image/jpeg";
        onPreview?.(URL.createObjectURL(new Blob([ev.data.slice(8)], { type: mime })));
      }
    } catch { /* malformed binary frame */ }
  };
  ws.onerror = () => {};
  return () => { try { ws.close(); } catch { /* already closed */ } };
}

// Read the streamed NDJSON response from /api/generate-image (Ollama path).
// Lines are {type:"progress",completed,total} during sampling, then a single
// {type:"done",images,model} (or {type:"error",error}). Drives onProgress and
// returns {images, model}.
async function readOllamaImageStream(r, onProgress) {
  const result = { images: [], model: undefined };
  if (!r.body) return result;
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const handleLine = (line) => {
    line = line.trim();
    if (!line) return;
    let c;
    try { c = JSON.parse(line); } catch { return; }
    if (c.type === "progress") onProgress?.(c.completed, c.total);
    else if (c.type === "done") { result.images = c.images || []; result.model = c.model; }
    else if (c.type === "error") throw new Error(c.error || "image generation failed");
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      handleLine(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  }
  if (buf.trim()) handleLine(buf); // final line may lack a trailing newline
  return result;
}

// ComfyUI video generation (WAN ti2v): text→video, or image→video when a
// reference image is attached. Single output, rendered as a <video>.
export async function generateVideo(parsed, model, tabId = state.activeTabId, insertIndex = -1, initImages = null) {
  const tab = getTab(tabId);
  if (!tab) return;
  const genStart = Date.now();
  const refImages = Array.isArray(initImages) && initImages.length ? initImages : null;

  // /imagine flags (steps/seed, and size only if explicit) win; the ⚙ modal
  // fills the rest (length/fps/cfg/sampler/scheduler). Drop the auto-filled
  // 1024² default so the video model uses its own resolution preset.
  const reqOptions = { ...parsed.options };
  if (!parsed.sizeExplicit) {
    delete reqOptions.width;
    delete reqOptions.height;
  }
  const ov = comfyOverrides();
  for (const k of Object.keys(ov)) {
    if (reqOptions[k] === undefined) reqOptions[k] = ov[k];
  }

  const abortController = new AbortController();
  state.imageGenAbortController = abortController;
  if (_setGenerating) _setGenerating(true);
  setAvatarState("thinking");

  const vidModel = (model || "").replace(/\.(safetensors|ckpt|gguf|pth)$/i, "");
  const vidImgs = refImages && refImages.length > 1 ? ` · ${t("msg_inputImages", { n: refImages.length })}` : "";
  const dots = `<span class="thinking-dots"><span>.</span><span>.</span><span>.</span><span>.</span><span>.</span><span>.</span></span>`;
  let pending = null;
  if (state.activeTabId === tabId) {
    pending = document.createElement("div");
    pending.className = "message assistant thinking imageGen";
    const body = document.createElement("div");
    body.className = "markdownBody";
    // When --enhance is set, show the enhancement step first, then flip to the
    // generating status once the (slow) prompt rewrite returns.
    const firstStatus = parsed.enhance ? t("msg_enhancing") : t("msg_generatingVideo");
    body.innerHTML = `<span class="thinking-text">${firstStatus}${vidModel ? ` · ${vidModel}` : ""}${vidImgs}${dots}</span>`;
    pending.appendChild(body);
    const refNode = insertIndex >= 0 ? dom.messagesEl.children[insertIndex] : null;
    if (refNode) dom.messagesEl.insertBefore(pending, refNode);
    else dom.messagesEl.appendChild(pending);
    dom.messagesEl.scrollTop = dom.messagesEl.scrollHeight;
  }

  // Enhance the prompt for the video model (motion / camera oriented) when asked.
  let videoPrompt = parsed.prompt;
  let promptWasEnhanced = false;
  if (parsed.enhance) {
    try {
      const enhanceRes = await fetch("/api/enhance-prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: abortController.signal,
        body: JSON.stringify({ model: dom.modelSelect.value, prompt: parsed.prompt, language: getPromptLanguage(), video: true }),
      });
      const enhanceData = await enhanceRes.json();
      if (enhanceRes.ok && enhanceData.enhanced) {
        videoPrompt = enhanceData.enhanced;
        promptWasEnhanced = videoPrompt !== parsed.prompt;
      }
    } catch (e) {
      if (e.name === "AbortError") {
        if (pending) pending.remove();
        setAvatarState("idle");
        if (_setGenerating) _setGenerating(false);
        state.imageGenAbortController = null;
        return;
      }
      // non-fatal: fall back to the original prompt
    }
    // Flip the status bubble to the generating state and surface the improved
    // prompt above it, so the user sees it BEFORE the (slow) video render.
    const body = pending && pending.querySelector(".markdownBody");
    if (body) {
      const preview = promptWasEnhanced
        ? `<div class="enhancedPromptPreview"><div class="enhancedLabel">${t("msg_enhancedPrompt")}</div><blockquote>${escapeHtml(videoPrompt)}</blockquote></div>`
        : "";
      body.innerHTML = `${preview}<span class="thinking-text">${t("msg_generatingVideo")}${vidModel ? ` · ${vidModel}` : ""}${vidImgs}${dots}</span>`;
    }
  }

  // Live progress bar + preview frames via ComfyUI's WebSocket. The browser owns
  // the clientId and hands it to the server so both subscribe to the same stream.
  const clientId = crypto.randomUUID ? crypto.randomUUID() : `hk-${Date.now()}-${Math.random()}`;
  const comfyHost = (dom.comfyUrlDisplay?.textContent || "").trim();
  let progressFill = null, previewImg = null, lastPreviewUrl = null;
  if (pending) {
    const prog = document.createElement("div");
    prog.className = "comfyProgress";
    prog.innerHTML = `<div class="comfyProgressBar"><div class="comfyProgressFill"></div></div><img class="comfyPreview" hidden alt="预览">`;
    pending.appendChild(prog);
    progressFill = prog.querySelector(".comfyProgressFill");
    previewImg = prog.querySelector(".comfyPreview");
  }
  const unsubscribe = subscribeComfyProgress(comfyHost, clientId, {
    onProgress: (value, max) => {
      if (progressFill && max) progressFill.style.width = `${Math.min(100, Math.round((value / max) * 100))}%`;
    },
    onPreview: (url) => {
      if (!previewImg) { URL.revokeObjectURL(url); return; }
      if (lastPreviewUrl) URL.revokeObjectURL(lastPreviewUrl);
      lastPreviewUrl = url;
      previewImg.src = url;
      previewImg.hidden = false;
    },
  });

  try {
    const resp = await fetch("/api/generate-comfy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: abortController.signal,
      body: JSON.stringify({
        model,
        prompt: videoPrompt,
        options: reqOptions,
        images: refImages || undefined,
        timeout: 600, // video is slow
        clientId,
      }),
    });
    const data = await resp.json();
    if (pending) pending.remove();
    if (!resp.ok || !data.videos || !data.videos.length) {
      const errMsg = { role: "assistant", content: `视频生成失败：${data.error || "未返回视频"}`, timestamp: Date.now() };
      if (insertIndex >= 0 && insertIndex <= tab.messages.length) tab.messages.splice(insertIndex, 0, errMsg);
      else tab.messages.push(errMsg);
      saveChat();
      if (state.activeTabId === tabId && _renderChat) _renderChat();
      setAvatarState("idle");
      return;
    }
    const videoContent = promptWasEnhanced
      ? `**${t("msg_enhancedPrompt")}**\n> ${videoPrompt}\n\n🎬 视频已生成`
      : `🎬 视频已生成`;
    const replyMsg = {
      role: "assistant",
      content: videoContent,
      generatedVideos: data.videos,
      videoMime: data.videoMime || "video/mp4",
      imagePrompt: videoPrompt,
      timestamp: Date.now(),
      genMs: Date.now() - genStart,
    };
    if (insertIndex >= 0 && insertIndex <= tab.messages.length) tab.messages.splice(insertIndex, 0, replyMsg);
    else tab.messages.push(replyMsg);
    saveChat();
    if (state.activeTabId === tabId && _renderChat) _renderChat();
    setAvatarState("happy");
    setTimeout(() => setAvatarState("idle"), 2000);
  } catch (error) {
    if (pending) pending.remove();
    if (error.name !== "AbortError") {
      const errMsg = { role: "assistant", content: `视频生成出错：${error.message}`, timestamp: Date.now() };
      tab.messages.push(errMsg);
      saveChat();
      if (state.activeTabId === tabId && _renderChat) _renderChat();
    }
    setAvatarState("idle");
  } finally {
    unsubscribe();
    if (lastPreviewUrl) URL.revokeObjectURL(lastPreviewUrl);
    if (_setGenerating) _setGenerating(false);
    state.imageGenAbortController = null;
  }
}

export async function generateImage(parsedInput, tabId = state.activeTabId, insertIndex = -1, initImages = null) {
  const parsedList = Array.isArray(parsedInput) ? parsedInput : [parsedInput];
  const tab = getTab(tabId);
  if (!tab) return;
  const genStart = Date.now();

  // Image-to-image: raw base64 reference image(s) condition the generation.
  const refImages = Array.isArray(initImages) && initImages.length ? initImages : null;

  // An empty Ollama image model means "generate via ComfyUI". Fall back to the
  // selected ComfyUI checkpoint in that case.
  const imageModel = dom.imageModelSelect.value;
  const comfyModel = dom.comfyModelSelect ? dom.comfyModelSelect.value : "";

  // A selected ComfyUI VIDEO model routes to the dedicated video path.
  if (!imageModel && comfyModel && state.comfyVideoModels && state.comfyVideoModels.has(comfyModel)) {
    return generateVideo(parsedList[0], comfyModel, tabId, insertIndex, refImages);
  }

  const useComfy = !imageModel && !!comfyModel;
  const activeModel = imageModel || comfyModel;
  if (!activeModel) {
    const errMsg = { role: "assistant", content: t("msg_noImageModel"), timestamp: Date.now() };
    if (insertIndex >= 0 && insertIndex <= tab.messages.length) {
      tab.messages.splice(insertIndex, 0, errMsg);
    } else {
      tab.messages.push(errMsg);
    }
    saveChat();
    if (state.activeTabId === tabId && _renderChat) _renderChat();
    return;
  }

  const totalCount = parsedList.reduce((sum, p) => sum + p.count, 0);
  const anyEnhance = parsedList.some((p) => p.enhance);

  // Status bubble. When --enhance is used we show it up-front (with an
  // "enhancing prompt" status) so the user sees activity during the slow
  // enhancement step, then flip it to the "generating" status below.
  const thinkingDots = `<span class="thinking-dots"><span>.</span><span>.</span><span>.</span><span>.</span><span>.</span><span>.</span></span>`;
  let pending = null;
  function createPending(text) {
    if (state.activeTabId !== tabId) return;
    pending = document.createElement("div");
    pending.className = "message assistant thinking imageGen";
    const body = document.createElement("div");
    body.className = "markdownBody";
    body.innerHTML = `<span class="thinking-text">${text}${thinkingDots}</span>`;
    pending.appendChild(body);
    const refNode = insertIndex >= 0 ? dom.messagesEl.children[insertIndex] : null;
    if (refNode) {
      dom.messagesEl.insertBefore(pending, refNode);
    } else {
      dom.messagesEl.appendChild(pending);
    }
    dom.messagesEl.scrollTop = dom.messagesEl.scrollHeight;
  }
  function setPendingText(text) {
    const span = pending && pending.querySelector(".thinking-text");
    if (span) span.innerHTML = `${text}${thinkingDots}`;
  }
  // Show the improved prompt(s) inside the pending bubble, above the status
  // line, so the user sees them BEFORE generation finishes.
  function showEnhancedPreview(promptTexts) {
    const body = pending && pending.querySelector(".markdownBody");
    if (!body || !promptTexts.length) return;
    let pre = body.querySelector(".enhancedPromptPreview");
    if (!pre) {
      pre = document.createElement("div");
      pre.className = "enhancedPromptPreview";
      body.insertBefore(pre, body.firstChild);
    }
    pre.innerHTML = `<div class="enhancedLabel">${t("msg_enhancedPrompt")}</div>` +
      promptTexts.map((p) => `<blockquote>${escapeHtml(p)}</blockquote>`).join("");
  }

  // Set up cancellation before enhancement so the stop button can interrupt the
  // (potentially slow) prompt-enhancement step, not just image generation.
  const abortController = new AbortController();
  state.imageGenAbortController = abortController;
  if (_setGenerating) _setGenerating(true);

  if (anyEnhance) {
    setAvatarState("thinking");
    createPending(t("msg_enhancing"));
  }

  // Enhance prompts if requested
  const prompts = [];
  try {
    for (const parsed of parsedList) {
      let prompt = parsed.prompt;
      if (parsed.enhance) {
        setAvatarState("thinking");
        try {
          const enhanceRes = await fetch("/api/enhance-prompt", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: abortController.signal,
            body: JSON.stringify({ model: dom.modelSelect.value, prompt, language: getPromptLanguage(), edit: !!refImages }),
          });
          const enhanceData = await enhanceRes.json();
          if (enhanceRes.ok && enhanceData.enhanced) {
            prompt = enhanceData.enhanced;
          }
        } catch (e) {
          if (e.name === "AbortError") throw e; // user stopped → cancel the whole run
          // other enhancement failures are non-fatal: fall back to the original prompt
        }
      }
      prompts.push(prompt);
    }
  } catch (e) {
    // Enhancement cancelled by the user — clean up the status bubble and bail.
    if (pending) pending.remove();
    setAvatarState("idle");
    if (_setGenerating) _setGenerating(false);
    state.imageGenAbortController = null;
    return;
  }

  // Surface the improved prompt(s) in the pending bubble before generation runs.
  const enhancedShown = parsedList
    .map((p, i) => (p.enhance && prompts[i] !== p.prompt) ? prompts[i] : null)
    .filter(Boolean);
  if (enhancedShown.length) showEnhancedPreview(enhancedShown);

  setAvatarState("thinking");

  // Status suffix: which model is generating, and (for multi-image edits) how
  // many reference images are actually being sent.
  const refCount = refImages ? refImages.length : 0;
  const shortModel = (activeModel || "").replace(/\.(safetensors|ckpt|gguf|pth)$/i, "");
  const statusSuffix = (shortModel ? ` · ${shortModel}` : "") + (refCount > 1 ? ` · ${t("msg_inputImages", { n: refCount })}` : "");
  const genText = (done) => (totalCount > 1 ? t("msg_generatingCount", { done, total: totalCount }) : t("msg_generating")) + statusSuffix;

  if (pending) {
    setPendingText(genText("0"));
  } else {
    createPending(genText("0"));
  }

  // Live progress bar (+ preview frame for ComfyUI). ComfyUI streams over its
  // WebSocket (keyed by clientId); Ollama streams NDJSON progress on the same HTTP
  // response (read below). One bar is shared across a batch.
  let comfyClientId = null, imgUnsub = () => {}, imgLastPreviewUrl = null, progressFill = null;
  const setProgress = (value, max) => {
    if (progressFill && max) progressFill.style.width = `${Math.min(100, Math.round((value / max) * 100))}%`;
  };
  if (pending) {
    const prog = document.createElement("div");
    prog.className = "comfyProgress";
    prog.innerHTML = `<div class="comfyProgressBar"><div class="comfyProgressFill"></div></div><img class="comfyPreview" hidden alt="预览">`;
    pending.appendChild(prog);
    progressFill = prog.querySelector(".comfyProgressFill");
    const previewImg = prog.querySelector(".comfyPreview");
    if (useComfy) {
      comfyClientId = crypto.randomUUID ? crypto.randomUUID() : `hk-${Date.now()}-${Math.random()}`;
      const comfyHost = (dom.comfyUrlDisplay?.textContent || "").trim();
      imgUnsub = subscribeComfyProgress(comfyHost, comfyClientId, {
        onProgress: setProgress,
        onPreview: (url) => {
          if (imgLastPreviewUrl) URL.revokeObjectURL(imgLastPreviewUrl);
          imgLastPreviewUrl = url;
          previewImg.src = url;
          previewImg.hidden = false;
        },
      });
    }
  }

  try {
    const generatedImages = [];
    let errorCount = 0;

    let pendingGrid = null;
    if (pending) {
      pendingGrid = document.createElement("div");
      pendingGrid.className = "imageGrid";
      pending.appendChild(pendingGrid);
    }

    const promises = [];
    for (let ci = 0; ci < parsedList.length; ci++) {
      const parsed = parsedList[ci];
      const prompt = prompts[ci];
      for (let i = 0; i < parsed.count; i++) {
        const reqOptions = { ...parsed.options };
        if (reqOptions.seed === undefined && parsed.count > 1) {
          reqOptions.seed = Math.floor(Math.random() * 2147483647);
        }
        // For img2img, preserve the input image's dimensions unless the user
        // explicitly asked for a size — drop the auto-filled default size.
        if (refImages && !parsed.sizeExplicit) {
          delete reqOptions.width;
          delete reqOptions.height;
        }
        // ComfyUI advanced params (sampler/scheduler/cfg/guidance/steps/denoise).
        // Inline /imagine flags (e.g. --steps) win; the modal fills the rest.
        if (useComfy) {
          const ov = comfyOverrides();
          for (const k of Object.keys(ov)) {
            if (reqOptions[k] === undefined) reqOptions[k] = ov[k];
          }
        }

        // Image editing (img2img) is markedly slower than text2img — give it
        // generous headroom over the user's configured txt2img timeout.
        const baseTimeout = parseInt(dom.imageTimeoutInput.value, 10) || 120;
        const reqTimeout = refImages ? Math.max(baseTimeout, 300) : baseTimeout;

        promises.push(
          fetch(useComfy ? "/api/generate-comfy" : "/api/generate-image", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: abortController.signal,
            body: JSON.stringify({
              model: activeModel,
              prompt,
              negative_prompt: parsed.negativePrompt || undefined,
              options: reqOptions,
              images: refImages || undefined,
              timeout: reqTimeout,
              clientId: comfyClientId || undefined,
            }),
          })
            .then(async (r) => {
              let data;
              if (!r.ok) {
                try { data = await r.json(); } catch { data = {}; }
              } else if (useComfy) {
                data = await r.json();
              } else {
                // Ollama streams NDJSON; drive the shared bar and collect the image.
                data = await readOllamaImageStream(r, setProgress);
              }
              if (r.ok) {
                const imgs = (data.images || []).filter((s) => s && s.length > 100);
                generatedImages.push(...imgs);
                if (pendingGrid) {
                  for (const imgData of imgs) {
                    const img = document.createElement("img");
                    img.className = "generatedImage";
                    if (imgData.startsWith("data:")) {
                      img.src = imgData;
                    } else {
                      const mime = imgData.startsWith("/9j/") ? "image/jpeg" : "image/png";
                      img.src = `data:${mime};base64,${imgData}`;
                    }
                    img.alt = "AI 生成的图片";
                    pendingGrid.appendChild(img);
                    dom.messagesEl.scrollTop = dom.messagesEl.scrollHeight;
                  }
                }
              } else {
                errorCount++;
                console.warn("[image-gen] error:", data.error);
              }
              if (pending && totalCount > 1) {
                const body = pending.querySelector(".markdownBody");
                if (body) body.innerHTML = `<span class="thinking-text">${genText(generatedImages.length + errorCount)}<span class="thinking-dots"><span>.</span><span>.</span><span>.</span><span>.</span><span>.</span><span>.</span></span></span>`;
              }
            })
            .catch((err) => {
              if (err.name !== "AbortError") errorCount++;
              else throw err;
            })
        );
      }
    }

    await Promise.all(promises);

    let content = "";
    // Ollama image editing only works reliably on flux2 models; warn otherwise.
    // ComfyUI uses VAE-encode img2img, which works with any checkpoint.
    if (refImages && !useComfy && !/flux2/i.test(imageModel)) {
      content += t("msg_imgEditModelWarn", { model: imageModel }) + "\n\n";
    }
    const enhancedPrompts = parsedList
      .map((p, i) => (p.enhance && prompts[i] !== p.prompt) ? prompts[i] : null)
      .filter(Boolean);
    if (enhancedPrompts.length > 0) {
      content += `**${t("msg_enhancedPrompt")}**\n${enhancedPrompts.map((p) => `> ${p}`).join("\n")}\n\n`;
    }
    if (errorCount > 0 && generatedImages.length > 0) {
      content += `⚠️ ${errorCount} 张图片生成失败\n\n`;
    } else if (errorCount > 0 && generatedImages.length === 0) {
      content = "图片生成失败，请检查模型是否正确安装并支持图像生成。";
    }

    const generatedThumbnails = await Promise.all(
      generatedImages.map((img) => {
        if (img.startsWith("data:")) return makePreview(img);
        const mime = img.startsWith("/9j/") ? "image/jpeg" : "image/png";
        const src = `data:${mime};base64,${img}`;
        return makePreview(src);
      })
    );

    const replyMsg = {
      role: "assistant",
      content: content || `🎨 图片已生成${totalCount > 1 ? ` (${generatedImages.length}/${totalCount})` : ""}`,
      generatedImages: generatedImages,
      generatedThumbnails: generatedThumbnails,
      imagePrompt: parsedList.map((p) => p.prompt).join("; "),
      imageOptions: parsedList[0].options,
      timestamp: Date.now(),
      genMs: Date.now() - genStart,
    };

    if (insertIndex >= 0 && insertIndex <= tab.messages.length) {
      tab.messages.splice(insertIndex, 0, replyMsg);
    } else {
      tab.messages.push(replyMsg);
    }
    saveChat();
    if (state.activeTabId === tabId && _renderChat) _renderChat();
    setAvatarState("happy");
    setTimeout(() => setAvatarState("idle"), 2000);
  } catch (error) {
    if (error.name === "AbortError") {
      if (pending) pending.remove();
    } else if (generatedImages.length > 0) {
      // Preserve already-generated images even when an error occurs
      if (pending) pending.remove();
      let content = `⚠️ 图片生成出错：${error.message}\n\n`;
      const enhancedPrompts = parsedList
        .map((p, i) => (p.enhance && prompts[i] !== p.prompt) ? prompts[i] : null)
        .filter(Boolean);
      if (enhancedPrompts.length > 0) {
        content = `**${t("msg_enhancedPrompt")}**\n${enhancedPrompts.map((p) => `> ${p}`).join("\n")}\n\n` + content;
      }
      const generatedThumbnails = await Promise.all(
        generatedImages.map((img) => {
          if (img.startsWith("data:")) return makePreview(img);
          const mime = img.startsWith("/9j/") ? "image/jpeg" : "image/png";
          return makePreview(`data:${mime};base64,${img}`);
        })
      );
      const replyMsg = {
        role: "assistant",
        content,
        generatedImages,
        generatedThumbnails,
        imagePrompt: parsedList.map((p) => p.prompt).join("; "),
        imageOptions: parsedList[0].options,
        timestamp: Date.now(),
        genMs: Date.now() - genStart,
      };
      if (insertIndex >= 0 && insertIndex <= tab.messages.length) {
        tab.messages.splice(insertIndex, 0, replyMsg);
      } else {
        tab.messages.push(replyMsg);
      }
      saveChat();
      if (state.activeTabId === tabId && _renderChat) _renderChat();
    } else {
      if (pending) {
        pending.className = "message system";
        pending.textContent = `图片生成出错：${error.message}`;
      }
    }
    setAvatarState("idle");
  } finally {
    imgUnsub();
    if (imgLastPreviewUrl) URL.revokeObjectURL(imgLastPreviewUrl);
    if (_setGenerating) _setGenerating(false);
    state.imageGenAbortController = null;
  }
}
