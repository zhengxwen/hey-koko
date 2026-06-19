// Image generation and /imagine command parsing
import { dom, state } from './state.js';
import { SIZE_PRESETS } from './constants.js';
import { t, getPromptLanguage } from './i18n.js';
import { makePreview, escapeHtml } from './utils.js';
import { setAvatarState } from './avatar.js';
import { saveChat } from './settings.js';
import { getTab, getActiveTab } from './tabs.js';
import { markdownToHtml } from './markdown.js';
import {
  pendingGenStart, pendingGenSetLabel, pendingGenSetEnhanced,
  pendingGenAddImage, pendingGenSetProgress, pendingGenSetPreview, pendingGenClear,
} from './pending-gen.js';

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

// The persistent negative prompt from the ⚙ ComfyUI params modal. A per-command
// `--no ...` always wins; this is the default applied to image AND video gen when
// no `--no` is given. Empty → undefined so the server falls back to its own default.
function comfyNegative(parsedNegative) {
  if (parsedNegative && parsedNegative.trim()) return parsedNegative.trim();
  const v = dom.comfyParamNegative?.value?.trim();
  return v || undefined;
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

  while (rest.startsWith("--") || /^-e\b/.test(rest)) {
    if (/^(--enhance|-e)\b/.test(rest)) {
      result.enhance = true;
      rest = rest.replace(/^(--enhance|-e)\s*/, "").trim();
    } else if (/^--size\s/.test(rest)) {
      const sizeFlag = rest.match(/^--size\s+(\S+)/);
      if (!sizeFlag) return { error: "--size 需要参数。格式：--size 1024x1024 或预设值（如 1080p）" };
      const sizeVal = sizeFlag[1];
      let w, h;
      const preset = SIZE_PRESETS[sizeVal.toLowerCase()];
      if (preset) {
        [w, h] = preset.split("x").map(Number);
      } else {
        const sizeParsed = sizeVal.match(/^(\d+)x(\d+)$/i);
        if (!sizeParsed) {
          return { error: `--size 格式错误："${sizeVal}"。可用 1024x1024 这种宽x高，或预设值：${Object.keys(SIZE_PRESETS).join(", ")}` };
        }
        w = parseInt(sizeParsed[1], 10);
        h = parseInt(sizeParsed[2], 10);
        if (w < 256 || w > 2048 || h < 256 || h > 2048) {
          return { error: `--size 尺寸超出范围：${w}x${h}。宽高需在 256~2048 之间` };
        }
      }
      result.options.width = w;
      result.options.height = h;
      result.sizeExplicit = true;
      rest = rest.replace(/^--size\s+\S+\s*/, "").trim();
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
      return { error: `未知参数 "--${unknownMatch[1]}"。支持的参数：--size（含预设：${Object.keys(SIZE_PRESETS).join("/")}）, --steps, --seed, --quality, --enhance, --no` };
    }
  }

  if (!result.options.width) {
    const defaultSize = dom.defaultImageSize.value || "1024x1024";
    // "auto" leaves width/height unset so the model/server picks its own size.
    if (defaultSize !== "auto") {
      const [w, h] = defaultSize.split("x").map(Number);
      result.options.width = w;
      result.options.height = h;
    }
  }

  result.prompt = rest.trim();

  if (!result.prompt) {
    return { error: "缺少提示词。请在参数后面添加图片描述，如：/imagine --landscape 一片星空" };
  }

  return result;
}

// Decode a base64/data-URL image's natural pixel size in the browser. Resolves
// null on failure. Used to caption a generated image with its real dimensions.
function imageNaturalSize(src) {
  return new Promise((resolve) => {
    const im = new Image();
    im.onload = () => resolve({ w: im.naturalWidth, h: im.naturalHeight });
    im.onerror = () => resolve(null);
    im.src = src;
  });
}

// Capture a still frame from a video (data URL) as a JPEG data URL. Used as the
// poster for generated videos and as the lightweight stand-in for the video in
// exports/archives (the video itself is megabytes; the thumbnail is a few KB).
// Resolves to null on any failure so callers can fall back gracefully.
export function videoThumbnail(src, quality = 0.72) {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    video.muted = true;
    video.preload = "auto";
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      video.removeAttribute("src");
      try { video.load(); } catch {}
      resolve(val);
    };
    const grab = () => {
      const w = video.videoWidth, h = video.videoHeight;
      if (!w || !h) return finish(null);
      try {
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        canvas.getContext("2d").drawImage(video, 0, 0, w, h);
        finish(canvas.toDataURL("image/jpeg", quality));
      } catch { finish(null); }
    };
    video.addEventListener("seeked", grab, { once: true });
    video.addEventListener("loadeddata", () => {
      // Seek slightly past the start so we don't grab a black lead-in frame.
      try { video.currentTime = Math.min(0.1, (video.duration || 1) / 4 || 0.1); }
      catch { grab(); }
    }, { once: true });
    video.addEventListener("error", () => finish(null), { once: true });
    const timer = setTimeout(grab, 4000); // fallback if seeked never fires
    video.src = src;
  });
}

// Tell ComfyUI to actually STOP — aborting our fetch only stops us waiting; the
// queued workflow keeps running on the GPU. /interrupt kills the running prompt
// and clearing the queue drops anything still pending (e.g. a batch). comfyHost
// is "host:port" (no protocol). Best-effort.
function interruptComfy(comfyHost) {
  if (!comfyHost) return;
  const proto = location.protocol === "https:" ? "https:" : "http:";
  fetch(`${proto}//${comfyHost}/interrupt`, { method: "POST" }).catch(() => {});
  fetch(`${proto}//${comfyHost}/queue`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clear: true }),
  }).catch(() => {});
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

  // /imagine flags (steps/seed) win; the ⚙ modal fills the rest
  // (length/fps/cfg/sampler/scheduler). For text→video, drop any default image
  // size so the model uses its own resolution preset (unless --size was explicit).
  // For image→video the size IS sent: the server keeps the input's aspect ratio
  // and sizes to it (auto) or to the chosen size's pixel budget.
  const reqOptions = { ...parsed.options };
  if (!refImages && !parsed.sizeExplicit) {
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
  const vidSuffix = `${vidModel ? ` · ${vidModel}` : ""}${vidImgs}`;
  // When --enhance is set, show the enhancement step first, then flip to the
  // generating status once the (slow) prompt rewrite returns. The bubble lives in
  // state.pendingGen so it survives a tab switch (see pending-gen.js).
  const firstStatus = parsed.enhance ? t("msg_enhancing") : t("msg_generatingVideo");
  pendingGenStart({ tabId, kind: "video", label: `${firstStatus}${vidSuffix}`, insertIndex });

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
        pendingGenClear(tabId);
        setAvatarState("idle");
        if (_setGenerating) _setGenerating(false);
        state.imageGenAbortController = null;
        return;
      }
      // non-fatal: fall back to the original prompt
    }
    // Flip the status bubble to the generating state and surface the improved
    // prompt above it, so the user sees it BEFORE the (slow) video render.
    if (promptWasEnhanced) {
      pendingGenSetEnhanced(tabId, `<div class="enhancedLabel">${t("msg_enhancedPrompt")}</div><blockquote>${escapeHtml(videoPrompt)}</blockquote>`);
    }
    pendingGenSetLabel(tabId, `${t("msg_generatingVideo")}${vidSuffix}`);
  }

  // Live progress bar + preview frames via ComfyUI's WebSocket. The browser owns
  // the clientId and hands it to the server so both subscribe to the same stream.
  // Both feed the pending bubble through state so they survive a tab switch.
  const clientId = crypto.randomUUID ? crypto.randomUUID() : `hk-${Date.now()}-${Math.random()}`;
  const comfyHost = (dom.comfyUrlDisplay?.textContent || "").trim();
  // Stop button → abort: also tell ComfyUI to interrupt the running render.
  abortController.signal.addEventListener("abort", () => interruptComfy(comfyHost), { once: true });
  const unsubscribe = subscribeComfyProgress(comfyHost, clientId, {
    onProgress: (value, max) => pendingGenSetProgress(tabId, value, max),
    onPreview: (url) => pendingGenSetPreview(tabId, url),
  });

  try {
    const resp = await fetch("/api/generate-comfy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: abortController.signal,
      body: JSON.stringify({
        model,
        prompt: videoPrompt,
        negative_prompt: comfyNegative(parsed.negativePrompt),
        options: reqOptions,
        images: refImages || undefined,
        timeout: 600, // video is slow
        clientId,
      }),
    });
    const data = await resp.json();
    pendingGenClear(tabId);
    if (!resp.ok || !data.videos || !data.videos.length) {
      const errMsg = { role: "assistant", content: `视频生成失败：${data.error || "未返回视频"}`, timestamp: Date.now() };
      if (insertIndex >= 0 && insertIndex <= tab.messages.length) tab.messages.splice(insertIndex, 0, errMsg);
      else tab.messages.push(errMsg);
      saveChat();
      if (state.activeTabId === tabId && _renderChat) _renderChat();
      setAvatarState("idle");
      return;
    }
    // "Video generated (W×H)" in the prompt language, with the real output size.
    const plang = getPromptLanguage();
    const doneLine = t("msg_videoDone", { w: data.width || "?", h: data.height || "?" }, plang);
    // If more images were attached than the model can use, tell the user how many
    // were actually consumed (2 = first-last-frame, 1 = plain image-to-video).
    const nInput = refImages ? refImages.length : 0;
    const nUsed = data.imagesUsed != null ? data.imagesUsed : nInput;
    let capNote = "";
    if (nInput > nUsed && nUsed > 0) {
      const flf = nUsed === 2 ? t("msg_videoFlfSuffix", null, plang) : "";
      capNote = t("msg_videoImagesCapped", { used: nUsed, total: nInput, flf }, plang) + "\n\n";
    }
    const videoContent = (promptWasEnhanced
      ? `**${t("msg_enhancedPrompt")}**\n> ${videoPrompt}\n\n${capNote}${doneLine}`
      : `${capNote}${doneLine}`);
    const vmime = data.videoMime || "video/mp4";
    // Grab a poster frame per video — shown before playback and used in place of
    // the (heavy) video when the conversation is exported or archived.
    const videoThumbs = await Promise.all(data.videos.map((v) =>
      videoThumbnail(v.startsWith("data:") ? v : `data:${vmime};base64,${v}`)));
    const replyMsg = {
      role: "assistant",
      content: videoContent,
      generatedVideos: data.videos,
      videoMime: vmime,
      generatedVideoThumbnails: videoThumbs,
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
    pendingGenClear(tabId);
    if (error.name !== "AbortError") {
      const errMsg = { role: "assistant", content: `视频生成出错：${error.message}`, timestamp: Date.now() };
      tab.messages.push(errMsg);
      saveChat();
      if (state.activeTabId === tabId && _renderChat) _renderChat();
    }
    setAvatarState("idle");
  } finally {
    pendingGenClear(tabId);
    unsubscribe();
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
  // enhancement step, then flip it to the "generating" status below. The bubble
  // lives in state.pendingGen so it survives a tab switch (see pending-gen.js).
  // Build the enhanced-prompt preview block's inner HTML from a list of prompts.
  const enhancedHtml = (promptTexts) =>
    `<div class="enhancedLabel">${t("msg_enhancedPrompt")}</div>` +
    promptTexts.map((p) => `<blockquote>${escapeHtml(p)}</blockquote>`).join("");

  // Set up cancellation before enhancement so the stop button can interrupt the
  // (potentially slow) prompt-enhancement step, not just image generation.
  const abortController = new AbortController();
  state.imageGenAbortController = abortController;
  if (_setGenerating) _setGenerating(true);

  if (anyEnhance) {
    setAvatarState("thinking");
    pendingGenStart({ tabId, kind: "image", label: t("msg_enhancing"), insertIndex });
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
    pendingGenClear(tabId);
    setAvatarState("idle");
    if (_setGenerating) _setGenerating(false);
    state.imageGenAbortController = null;
    return;
  }

  // Surface the improved prompt(s) in the pending bubble before generation runs.
  const enhancedShown = parsedList
    .map((p, i) => (p.enhance && prompts[i] !== p.prompt) ? prompts[i] : null)
    .filter(Boolean);
  if (enhancedShown.length) pendingGenSetEnhanced(tabId, enhancedHtml(enhancedShown));

  setAvatarState("thinking");

  // Status suffix: which model is generating, and (for multi-image edits) how
  // many reference images are actually being sent.
  const refCount = refImages ? refImages.length : 0;
  const shortModel = (activeModel || "").replace(/\.(safetensors|ckpt|gguf|pth)$/i, "");
  const statusSuffix = (shortModel ? ` · ${shortModel}` : "") + (refCount > 1 ? ` · ${t("msg_inputImages", { n: refCount })}` : "");
  const genText = (done) => (totalCount > 1 ? t("msg_generatingCount", { done, total: totalCount }) : t("msg_generating")) + statusSuffix;

  // Start tracking now (or just relabel if the enhance step already started it).
  if (state.pendingGen && state.pendingGen.tabId === tabId) {
    pendingGenSetLabel(tabId, genText("0"));
  } else {
    pendingGenStart({ tabId, kind: "image", label: genText("0"), insertIndex });
  }

  // Live progress bar (+ preview frame for ComfyUI). ComfyUI streams over its
  // WebSocket (keyed by clientId); Ollama streams NDJSON progress on the same HTTP
  // response (read below). One bar is shared across a batch. Both feed the
  // pending bubble through state so updates survive a tab switch.
  let comfyClientId = null, imgUnsub = () => {};
  const setProgress = (value, max) => pendingGenSetProgress(tabId, value, max);
  if (useComfy) {
    comfyClientId = crypto.randomUUID ? crypto.randomUUID() : `hk-${Date.now()}-${Math.random()}`;
    const comfyHost = (dom.comfyUrlDisplay?.textContent || "").trim();
    imgUnsub = subscribeComfyProgress(comfyHost, comfyClientId, {
      onProgress: setProgress,
      onPreview: (url) => pendingGenSetPreview(tabId, url),
    });
  }
  // Stop button → abort: also tell ComfyUI to interrupt the running render
  // (aborting the fetch alone leaves the GPU working). Ollama is cancelled
  // server-side when the connection drops.
  if (useComfy) {
    const comfyHost = (dom.comfyUrlDisplay?.textContent || "").trim();
    abortController.signal.addEventListener("abort", () => interruptComfy(comfyHost), { once: true });
  }

  try {
    const generatedImages = [];
    let errorCount = 0;

    const promises = [];
    for (let ci = 0; ci < parsedList.length; ci++) {
      const parsed = parsedList[ci];
      const prompt = prompts[ci];
      for (let i = 0; i < parsed.count; i++) {
        const reqOptions = { ...parsed.options };
        if (reqOptions.seed === undefined && parsed.count > 1) {
          reqOptions.seed = Math.floor(Math.random() * 2147483647);
        }
        // For img2img the size is passed through: a specified size (default or
        // --size) makes the server render at that size's pixel budget keeping the
        // input's aspect ratio; "auto" (no width/height) follows the input image.
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
              negative_prompt: comfyNegative(parsed.negativePrompt),
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
                for (const imgData of imgs) {
                  const src = imgData.startsWith("data:")
                    ? imgData
                    : `data:${imgData.startsWith("/9j/") ? "image/jpeg" : "image/png"};base64,${imgData}`;
                  pendingGenAddImage(tabId, src);
                }
              } else {
                errorCount++;
                console.warn("[image-gen] error:", data.error);
              }
              if (totalCount > 1) {
                pendingGenSetLabel(tabId, genText(generatedImages.length + errorCount));
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

    const toSrc = (img) => (img.startsWith("data:") ? img : `data:${img.startsWith("/9j/") ? "image/jpeg" : "image/png"};base64,${img}`);
    const generatedThumbnails = await Promise.all(generatedImages.map((img) => makePreview(toSrc(img))));

    // "Image generated (W×H)" in the prompt language, with the real output size
    // (decoded from the first image — covers txt2img, img2img and Ollama alike).
    let doneLine = "";
    if (generatedImages.length > 0) {
      const size = await imageNaturalSize(toSrc(generatedImages[0]));
      const dims = { w: size?.w || "?", h: size?.h || "?" };
      const plang = getPromptLanguage();
      doneLine = totalCount > 1
        ? t("msg_imageDoneBatch", { done: generatedImages.length, total: totalCount, ...dims }, plang)
        : t("msg_imageDone", dims, plang);
    }

    const replyMsg = {
      role: "assistant",
      content: generatedImages.length > 0 ? content + doneLine : content,
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
    // Drop the restorable pending bubble just before render so the live preview
    // grid stays visible right up until the final message replaces it.
    pendingGenClear(tabId);
    saveChat();
    if (state.activeTabId === tabId && _renderChat) _renderChat();
    setAvatarState("happy");
    setTimeout(() => setAvatarState("idle"), 2000);
  } catch (error) {
    pendingGenClear(tabId);
    if (error.name === "AbortError") {
      // pendingGenClear already removed the bubble (live or restored).
    } else if (generatedImages.length > 0) {
      // Preserve already-generated images even when an error occurs
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
      // Failed with no images — surface the error as a normal message.
      const errMsg = { role: "assistant", content: `图片生成出错：${error.message}`, timestamp: Date.now() };
      if (insertIndex >= 0 && insertIndex <= tab.messages.length) tab.messages.splice(insertIndex, 0, errMsg);
      else tab.messages.push(errMsg);
      saveChat();
      if (state.activeTabId === tabId && _renderChat) _renderChat();
    }
    setAvatarState("idle");
  } finally {
    pendingGenClear(tabId);
    imgUnsub();
    if (_setGenerating) _setGenerating(false);
    state.imageGenAbortController = null;
  }
}
