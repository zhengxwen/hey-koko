// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

// Image generation and /imagine command parsing
import { dom, state } from './state.js';
import { SIZE_PRESETS } from './constants.js';
import { t, getPromptLanguage } from './i18n.js';
import { makePreview, escapeHtml } from './utils.js';
import { setAvatarState } from './avatar.js';
import { saveChat } from './settings.js';
import { getTab, getActiveTab } from './tabs.js';
import { markdownToHtml } from './markdown.js';
import { foregroundSink } from './gen-sink.js';
import { comfyFetch } from './server-queue.js';   // Option B: run ComfyUI gen on the server queue

// Compact "time remaining" → "m:ss" or "h:mm:ss" (language-neutral).
function formatEta(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

// setGenerating and renderChat will be injected from main
let _setGenerating = null;
let _renderChat = null;
export function setDeps({ setGenerating, renderChat }) {
  _setGenerating = setGenerating;
  _renderChat = renderChat;
}

// Screen Wake Lock — keep the display awake during a long (minutes-to-30min) video
// render so the OS doesn't sleep and drop the connection mid-generation. The lock
// auto-releases when the tab is hidden, so re-acquire it when the tab returns AND a
// generation is still running (state.imageGenAbortController is the "busy" signal).
let _wakeLock = null, _wakeLockWanted = false;
async function acquireWakeLock() {
  _wakeLockWanted = true;
  try {
    if ("wakeLock" in navigator && !_wakeLock && document.visibilityState === "visible") {
      _wakeLock = await navigator.wakeLock.request("screen");
      _wakeLock.addEventListener("release", () => { _wakeLock = null; });
    }
  } catch { /* unsupported / denied — best-effort */ }
}
function releaseWakeLock() {
  _wakeLockWanted = false;
  try { _wakeLock && _wakeLock.release(); } catch { /* already gone */ }
  _wakeLock = null;
}
// The lock auto-releases when the tab hides — re-acquire on return if still wanted.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && _wakeLockWanted) acquireWakeLock();
});

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
  if (dom.comfyParamTorchCompile?.checked) ov.torchCompile = true; // Wan Animate: TorchCompileModel
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
  // Allow a bare "/imagine" (no prompt) — attachment-driven gen (video edit /
  // img2img). The caller requires an attachment when the prompt is empty.
  const match = input.match(/^\/imagine(?:\s+([\s\S]+))?$/);
  if (!match) return null;

  let rest = (match[1] || "").trim();
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
  // Empty prompt is allowed (no error) — gen is attachment-driven for video-edit
  // / img2img. sendMessage requires an attachment when the prompt is empty.
  result.emptyPrompt = !result.prompt;
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

// Decode a video's natural pixel size (data URL) in the browser. Resolves null on
// failure. Used to size Bernini video-edit output to the source's aspect ratio.
export function videoNaturalSize(src) {
  return new Promise((resolve) => {
    const v = document.createElement("video");
    v.preload = "metadata";
    v.muted = true;
    let done = false;
    const finish = (val) => { if (done) return; done = true; clearTimeout(timer); resolve(val); };
    v.addEventListener("loadedmetadata", () => finish(v.videoWidth && v.videoHeight ? { w: v.videoWidth, h: v.videoHeight } : null), { once: true });
    v.addEventListener("error", () => finish(null), { once: true });
    const timer = setTimeout(() => finish(null), 4000);
    v.src = src;
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

// Grab `count` frames evenly spaced across a video, returned as `{url, t}` objects
// (JPEG data URL + the frame's actual timestamp in seconds) in chronological order.
// Vision models can't read video directly, so /analyze feeds the frames as separate
// images (the model refers to them by frame number = their order); the timestamps are
// shown to the user as a frame→time map. Longest side capped at maxSide (high for 4K).
export function extractVideoFrames(src, count = 8, quality = 0.72, maxSide = 1280) {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    video.muted = true;
    video.preload = "auto";
    const frames = [];
    const canvas = document.createElement("canvas");
    let times = [];
    let idx = 0;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      video.removeAttribute("src");
      try { video.load(); } catch {}
      resolve(frames);
    };
    const grab = () => {
      const w = video.videoWidth, h = video.videoHeight;
      if (w && h) {
        try {
          const scale = Math.min(1, maxSide / Math.max(w, h));
          canvas.width = Math.max(1, Math.round(w * scale));
          canvas.height = Math.max(1, Math.round(h * scale));
          canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
          // Record the frame's ACTUAL time (the browser may snap a seek to a nearby keyframe).
          frames.push({ url: canvas.toDataURL("image/jpeg", quality), t: video.currentTime });
        } catch { /* tainted/oversized frame — skip it */ }
      }
      idx++;
      if (idx >= times.length) return finish();
      seekNext();
    };
    const seekNext = () => {
      try { video.currentTime = times[idx]; }
      catch { grab(); }
    };
    video.addEventListener("loadeddata", () => {
      const dur = video.duration;
      if (!dur || !isFinite(dur)) times = [0.1];
      // Sample the midpoint of each of `count` equal slices, skipping the lead-in/out.
      else times = Array.from({ length: count }, (_, i) => (dur * (i + 0.5)) / count);
      video.addEventListener("seeked", grab);
      seekNext();
    }, { once: true });
    video.addEventListener("error", finish, { once: true });
    const timer = setTimeout(finish, 20000); // safety cap if seeking stalls
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
// Upload a source video (Bernini/Animate) to ComfyUI via the server proxy as RAW
// binary, so the generation request body stays tiny (vs a 30MB+ base64 in JSON
// that freezes the tab). Returns the ComfyUI filename. The data-URL→Blob decode is
// browser-native, off the hot path.
async function uploadComfySourceVideo(video, signal, targetFps, comfyHost) {
  const mime = video.mime || "video/mp4";
  const blob = await (await fetch(`data:${mime};base64,${video.base64}`)).blob();
  const headers = { "Content-Type": mime };
  if (targetFps > 0) headers["X-Target-Fps"] = String(targetFps); // resample to a custom fps
  if (comfyHost) headers["X-Comfy-Url"] = comfyHost;              // target this job's ComfyUI worker
  const r = await fetch("/api/comfy-upload-video", { method: "POST", headers, body: blob, signal });
  if (!r.ok) throw new Error(`source video upload failed (${r.status})`);
  const d = await r.json();
  return { name: d.name, frames: d.frames || 0, fps: d.fps || 0 }; // post-(resample) frame count + fps
}

function subscribeComfyProgress(comfyHost, clientId, { onProgress, onPreview }) {
  if (!comfyHost) return () => {};
  // A long video render can outlast an idle/sleep that silently drops the socket,
  // freezing the progress bar (the render keeps going server-side). So AUTO-RECONNECT
  // with the SAME clientId until unsubscribe — ComfyUI keeps broadcasting to that id,
  // so progress/preview resume. Also reconnect eagerly when the tab returns to view.
  let ws = null, closed = false, retryTimer = null;
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${proto}//${comfyHost}/ws?clientId=${encodeURIComponent(clientId)}`;

  const onMessage = (ev) => {
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
  const scheduleReconnect = () => {
    if (closed || retryTimer) return;
    retryTimer = setTimeout(() => { retryTimer = null; connect(); }, 2000);
  };
  function connect() {
    if (closed) return;
    try {
      ws = new WebSocket(url);
      ws.binaryType = "arraybuffer";
    } catch { scheduleReconnect(); return; }
    ws.onmessage = onMessage;
    ws.onerror = () => {};                         // let onclose drive reconnection
    ws.onclose = () => { if (!closed) scheduleReconnect(); };
  }
  // When the tab is shown again, the dead socket may not have fired onclose yet —
  // nudge a reconnect if it's not OPEN.
  const onVis = () => {
    if (!closed && document.visibilityState === "visible" && (!ws || ws.readyState > 1)) {
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      connect();
    }
  };
  document.addEventListener("visibilitychange", onVis);
  connect();
  return () => {
    closed = true;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    document.removeEventListener("visibilitychange", onVis);
    try { ws && ws.close(); } catch { /* already closed */ }
  };
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
// Frames Wan Animate can generate in one pass, by OUTPUT pixel budget. 3D-attention
// VRAM/compute grows with (spatial tokens × frames), so a higher resolution needs a
// shorter segment to stay within a 32GB (RTX 5090) budget. Tuned so each tier fits
// comfortably; the chunks are merged so total length is unchanged. Mirrors
// animateSegmentCap in server/comfy.js.
function animateSegmentCap(pixelBudget, torchCompile = false) {
  // torch.compile (inductor) adds VRAM overhead (autotuning scratch + compiled
  // buffers) → at 720p+ on 32GB it can OOM. When it's on, use one tier shorter
  // segments to free headroom (more segments also amortizes the compile better).
  // 720p (1M) compile-off tuned from a real measurement: 121f used ~22.5/31.5GB on
  // the 5090, so 161f (~+33%) still leaves headroom under a ~28GB ceiling.
  const tiers = torchCompile
    ? [[520000, 121], [1000000, 65], [2100000, 33]]    // compile on — conservative (extra VRAM)
    : [[520000, 241], [1000000, 161], [2100000, 65]];  // compile off
  for (const [lim, cap] of tiers) if (pixelBudget <= lim) return cap;
  return torchCompile ? 17 : 33;           // beyond 1080p
}

export async function generateVideo(parsed, model, tabId = state.activeTabId, insertIndex = -1, initImages = null, sourceVideo = null, sink = null, comfyUrl = null) {
  const tab = getTab(tabId);
  if (!tab) return;
  // This job's ComfyUI worker (multi-machine parallel lanes) — falls back to the
  // single configured endpoint. Normalized to host:port for WS / interrupt / upload.
  const comfyHost = ((comfyUrl || dom.comfyUrlDisplay?.textContent || "").replace(/\s*\(.*\)\s*$/, "").trim()).replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  const genStart = Date.now();
  const refImages = Array.isArray(initImages) && initImages.length ? initImages : null;
  // Foreground unless the jobs runner handed in a background sink. The sink owns
  // the AbortController, the send-button lock, the progress bubble and where the
  // result message lands (live bubble vs. background placeholder).
  if (!sink) sink = foregroundSink({ tabId, insertIndex, setGenerating: _setGenerating, renderChat: _renderChat, saveChat, getTab });

  // For Bernini i2v the output aspect must follow the reference image. Decode its
  // natural size in the browser (works for any format) and send it, so the server
  // doesn't depend on parsing the base64 (a WebP etc. would fail → square crop).
  let refImageDims = null;
  if (refImages && refImages.length && !sourceVideo) {
    const b = refImages[0];
    const src = b.startsWith("data:") ? b : `data:image/${b.startsWith("/9j/") ? "jpeg" : b.startsWith("UklGR") ? "webp" : "png"};base64,${b}`;
    refImageDims = await imageNaturalSize(src);
  }

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

  const abortController = { signal: sink.signal }; // sink owns the real controller
  sink.lock(true);
  acquireWakeLock(); // keep the display awake for the (long) render
  setAvatarState("thinking");

  const vidModel = (model || "").replace(/\.(safetensors|ckpt|gguf|pth)$/i, "");
  const vidImgs = refImages && refImages.length > 1 ? ` · ${t("msg_inputImages", { n: refImages.length })}` : "";
  const vidSuffix = `${vidModel ? ` · ${vidModel}` : ""}${vidImgs}`;
  // When --enhance is set, show the enhancement step first, then flip to the
  // generating status once the (slow) prompt rewrite returns. The bubble lives in
  // state.pendingGen so it survives a tab switch (see pending-gen.js).
  const firstStatus = parsed.enhance ? t("msg_enhancing") : t("msg_generatingVideo");
  sink.start("video", `${firstStatus}${vidSuffix}`);
  // Let the browser PAINT the just-mounted bubble before the heavy synchronous
  // work would otherwise block the main thread → the bubble appears to never show.
  await new Promise((r) => setTimeout(r, 0));

  // Source video (Bernini v2v/rv2v, Wan Animate) → upload ONCE as raw binary so the
  // generation request body stays tiny. On failure, fall back to inline base64.
  let sourceVideoName = null;
  let sourceVideoFrames = 0;
  let sourceVideoFps = 0;
  if (sourceVideo?.base64) {
    sink.label(`${t("msg_generatingVideo")}${vidSuffix}`);
    try {
      // A custom ⚙ fps resamples the source so the output timing is correct;
      // "auto" (no fps) keeps the source's own fps.
      const up = await uploadComfySourceVideo(sourceVideo, abortController.signal, reqOptions.fps, comfyHost);
      sourceVideoName = up.name;
      sourceVideoFrames = up.frames;
      sourceVideoFps = up.fps;
    } catch (e) {
      if (e.name === "AbortError") {
        sink.clearBubble(); setAvatarState("idle");
        sink.done(); sink.cleanup();
        return;
      }
      /* non-fatal: fall back to sending the base64 inline below */
    }
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
        sink.clearBubble();
        setAvatarState("idle");
        sink.done(); sink.cleanup();
        return;
      }
      // non-fatal: fall back to the original prompt
    }
    // Flip the status bubble to the generating state and surface the improved
    // prompt above it, so the user sees it BEFORE the (slow) video render.
    if (promptWasEnhanced) {
      sink.enhanced(`<div class="enhancedLabel">${t("msg_enhancedPrompt")}</div><blockquote>${escapeHtml(videoPrompt)}</blockquote>`);
    }
    sink.label(`${t("msg_generatingVideo")}${vidSuffix}`);
  }

  // Estimated chunk count for a chained Wan Animate (each chunk = one KSampler pass).
  // Drives both the scaled timeout (below) and the overall progress / ETA. The server
  // decides the real count; ±1 here is fine for an estimate.
  const animBudgetEta = (reqOptions.width && reqOptions.height) ? reqOptions.width * reqOptions.height : 640 * 640;
  const estPasses = (/animate/i.test(model) && sourceVideoFrames > 0 && !reqOptions.length)
    ? Math.max(1, Math.ceil(sourceVideoFrames / Math.max(1, animateSegmentCap(animBudgetEta, !!reqOptions.torchCompile) - 5)))
    : 1;

  // Live progress bar + preview frames via ComfyUI's WebSocket. The browser owns
  // the clientId and hands it to the server so both subscribe to the same stream.
  // Both feed the pending bubble through state so they survive a tab switch.
  const clientId = crypto.randomUUID ? crypto.randomUUID() : `hk-${Date.now()}-${Math.random()}`;
  // Stop button → abort: also tell ComfyUI to interrupt the running render.
  abortController.signal.addEventListener("abort", () => interruptComfy(comfyHost), { once: true });
  // OVERALL progress + ETA. A chained render emits a fresh 0→max KSampler progress per
  // chunk; we detect each chunk boundary (value resets). The bar shows overall progress
  // across all `estPasses`. The ETA is paced by the MEASURED per-chunk WALL time (which
  // includes the no-progress VAE decode between chunks) × the remaining chunks — so it
  // factors the segment count and the real per-segment cost, not just sampling steps.
  // DWPose preprocessing + VAE decode report NO progress → INDETERMINATE (sliding) bar
  // by default and during any >2.5s stall.
  let _passesDone = 0, _prevVal = 0, _firstStepT = 0, _boundaryT = 0, _progStall = null;
  sink.indeterminate(true); // pulse until the first sampling step arrives
  const onVideoProgress = (value, max) => {
    if (!max) return;
    const now = Date.now();
    // Clock starts at the FIRST sampling step (the one-time DWPose before it reports no
    // progress and shouldn't count toward the per-chunk pace).
    if (!_firstStepT) { _firstStepT = now; _boundaryT = now; }
    if (value < _prevVal) { _passesDone++; _boundaryT = now; } // a chunk finished, next started
    _prevVal = value;

    // Bar denominator keeps growing with observed ramps so the bar never exceeds
    // 100%, but the user-facing segment badge uses the PLANNED content-segment
    // count (estPasses) as a fixed total and clamps the current number to it.
    const N = Math.max(estPasses, _passesDone + 1); // ≥ what we've seen — for the bar only
    sink.indeterminate(false);
    sink.progress(_passesDone * max + value, N * max); // overall, not per-chunk
    // Which chunk is rendering now — only for a genuinely chunked multi-segment
    // animate render (estPasses > 1). Use estPasses (not N) as the total: a single
    // segment can emit several sampler ramps that are NOT user-facing segments —
    // the rv2v "still" pose-adoption pass, or a model's two-expert high+low MoE —
    // and those would otherwise inflate the total to a bogus "第 3/3 段" / "3/2".
    if (estPasses > 1) {
      sink.seg(t("msg_chunkBadge", { seg: Math.min(_passesDone + 1, estPasses), total: estPasses }));
    }

    // ETA. Only show a number when it's RELIABLE: a measured per-chunk time (≥1 chunk
    // done) for multi-segment, or the step pace for a true single pass. Otherwise NA —
    // never a wild extrapolation from a partial first chunk.
    let etaText = "NA";
    if (_passesDone >= 1) {
      const avgChunkMs = (_boundaryT - _firstStepT) / _passesDone; // incl. VAE decode
      const remMs = Math.max(0, (N - _passesDone) * avgChunkMs - (now - _boundaryT));
      etaText = `~${formatEta(remMs / 1000)}`;
    } else if (N === 1 && value > 0) {
      etaText = `~${formatEta((now - _firstStepT) / 1000 * (max - value) / value)}`;
    } // else: multi-segment, first chunk not finished → NA
    sink.eta(`⏳ ${etaText}`);

    clearTimeout(_progStall);
    _progStall = setTimeout(() => sink.indeterminate(true), 2500);
  };
  const unsubscribe = subscribeComfyProgress(comfyHost, clientId, {
    onProgress: onVideoProgress,
    onPreview: (url) => sink.preview(url),
  });

  // "/imagine Nx …" makes N videos (1–8). They render sequentially on ComfyUI;
  // each finished video is shown in the bubble IMMEDIATELY (not held until the
  // whole batch ends), while the next one's live preview frames keep streaming in
  // the pending bubble. All videos collect into ONE message (rendered as a grid).
  const count = Math.min(Math.max(parsed.count || 1, 1), 8);
  const allVideos = [];
  const allThumbs = [];
  let lastData = null;
  let replyMsg = null; // the single message holding the videos finished so far

  // Create-or-update the reply message in place so each completed video appears
  // right away. generatedVideos/Thumbnails point at the growing arrays.
  const renderReply = () => {
    if (!allVideos.length) return;
    const plang = getPromptLanguage();
    const vmime = lastData.videoMime || "video/mp4";
    // "Video generated (W×H, Ns)", suffixed with ×N when a batch, then the model.
    // Duration = frame count / fps (both resolved server-side); omitted if unknown.
    let dur = "";
    if (lastData.length && lastData.fps) {
      const r = Math.round((lastData.length / lastData.fps) * 10) / 10;
      dur = `, ${Number.isInteger(r) ? r : r.toFixed(1)}s`;
    }
    const sizeLine = t("msg_videoDone", { w: lastData.width || "?", h: lastData.height || "?", dur }, plang);
    const doneLine = (count > 1 ? `${sizeLine} ×${allVideos.length}${allVideos.length < count ? `/${count}` : ""}` : sizeLine)
      + (vidModel ? ` · ${vidModel}` : "");
    // If more images were attached than the model can use, tell the user how many
    // were actually consumed (2 = first-last-frame, 1 = plain image-to-video).
    const nInput = refImages ? refImages.length : 0;
    const nUsed = lastData.imagesUsed != null ? lastData.imagesUsed : nInput;
    let capNote = "";
    if (nInput > nUsed && nUsed > 0) {
      const flf = nUsed === 2 ? t("msg_videoFlfSuffix", null, plang) : "";
      capNote = t("msg_videoImagesCapped", { used: nUsed, total: nInput, flf }, plang) + "\n\n";
    }
    // Stopped early: only the segments finished before Stop were merged.
    if (lastData.partial) {
      capNote += t("msg_videoPartial", { done: lastData.segments, total: lastData.plannedSegments }, plang) + "\n\n";
    } else if (lastData.segments > 1) {
      // Wan Animate long source: generated in N chunks and merged into one clip.
      capNote += t("msg_videoMerged", { n: lastData.segments }, plang) + "\n\n";
    }
    // Wan Animate: source clip longer than the single-pass cap → was truncated.
    if (lastData.truncatedFrom && lastData.length) {
      const fps = lastData.fps || 16;
      capNote += t("msg_videoTruncated", {
        full: lastData.truncatedFrom, used: lastData.length,
        fullS: (lastData.truncatedFrom / fps).toFixed(1), usedS: (lastData.length / fps).toFixed(1),
      }, plang) + "\n\n";
    }
    const videoContent = (promptWasEnhanced
      ? `**${t("msg_enhancedPrompt")}**\n> ${videoPrompt}\n\n${capNote}${doneLine}`
      : `${capNote}${doneLine}`);
    if (!replyMsg) {
      replyMsg = {
        role: "assistant",
        content: videoContent,
        generatedVideos: allVideos,
        videoMime: vmime,
        generatedVideoThumbnails: allThumbs,
        imagePrompt: videoPrompt,
        timestamp: Date.now(),
        genMs: Date.now() - genStart,
      };
      sink.place(replyMsg);
    } else {
      replyMsg.content = videoContent;
      replyMsg.videoMime = vmime;
      replyMsg.genMs = Date.now() - genStart;
      sink.commit();
    }
  };

  // Surface a fatal "nothing generated" error in the bubble and bail.
  const failFatal = (errText) => {
    sink.clearBubble();
    sink.place({ role: "assistant", content: `视频生成失败：${errText || "未返回视频"}`, timestamp: Date.now() });
    setAvatarState("idle");
  };

  // A chained Wan Animate runs ALL chunks in one ComfyUI pass, so the whole render
  // must fit one timeout — scale it with the estimated chunk count (≈15 min/chunk),
  // clamped 30 min … 2 h (server cap). Other videos use a flat 30 min.
  const videoTimeout = Math.min(7200, Math.max(1800, estPasses * 900));

  // One /api/generate-comfy request. `extra` carries per-segment offset/length for
  // a chunked Wan Animate render; ignored otherwise.
  const requestVideo = (perOptions, extra) => {
    const vbody = {
      model,
      prompt: videoPrompt,
      negative_prompt: comfyNegative(parsed.negativePrompt),
      options: perOptions,
      images: refImages || undefined,
      // Bernini/Animate source clip — prefer the pre-uploaded filename (tiny); only
      // fall back to inline base64 if that upload failed. Plus its size (for
      // source-aspect output sizing). Ignored by other video models.
      sourceVideoName: sourceVideoName || undefined,
      sourceVideo: sourceVideoName ? undefined : (sourceVideo?.base64 || undefined),
      sourceVideoMime: sourceVideo?.mime || undefined,
      sourceVideoWidth: sourceVideo?.width || undefined,
      sourceVideoHeight: sourceVideo?.height || undefined,
      sourceVideoFrames: sourceVideoFrames || undefined, // Wan Animate full-length
      sourceVideoFps: sourceVideoFps || undefined,       // output fps = source (or resampled) fps
      // Bernini i2v: reference image's natural size → source-aspect output.
      refImageWidth: refImageDims?.w || undefined,
      refImageHeight: refImageDims?.h || undefined,
      timeout: videoTimeout, // scaled with the estimated chunk count (chained animate runs all chunks in one pass)
      clientId,
      comfyUrl: comfyHost || undefined, // target this job's ComfyUI worker (parallel lanes)
      ...(extra || {}),
    };
    // Option B: a background video job runs on the SERVER queue (survives reload);
    // comfyFetch returns a Response-like {ok,json} so the handling below is unchanged.
    return sink.server
      ? comfyFetch(vbody, { bgJob: sink.server.bgJob, kind: "video", comfyUrl: comfyHost, conversationId: sink.server.conversationId, msgId: sink.server.msgId, label: sink.server.label, clientId, signal: abortController.signal })
      : fetch("/api/generate-comfy", { method: "POST", headers: { "Content-Type": "application/json" }, signal: abortController.signal, body: JSON.stringify(vbody) });
  };

  // Wan Animate: a source longer than the single-pass cap is generated in segments
  // and merged — unless the user pinned a ⚙ length (forces one bounded pass). The
  // cap shrinks at higher output resolutions (VRAM headroom). Budget = the selected
  // ⚙/--size area, or the 640×640 default (mirrors the server's sizing). Only used to
  // pick the "seamless long video" label — the SERVER does the actual chunking in-graph.
  const animBudget = (reqOptions.width && reqOptions.height) ? reqOptions.width * reqOptions.height : 640 * 640;
  const willChunk = /animate/i.test(model) && !!sourceVideoName && sourceVideoFrames > animateSegmentCap(animBudget, !!reqOptions.torchCompile) && !reqOptions.length;
  // Total output duration of the long video (full source: frames ÷ fps), e.g. 5.4.
  const fullSec = (willChunk && sourceVideoFps > 0) ? Math.round(sourceVideoFrames / sourceVideoFps * 10) / 10 : 0;

  try {
    for (let i = 0; i < count; i++) {
      if (abortController.signal.aborted) break;
      sink.progress(0, 1); // reset the bar for each render
      // Vary the seed per video so the N outputs differ (only when the user
      // pinned a --seed; otherwise the server randomizes each call already).
      const perOptions = { ...reqOptions };
      if (perOptions.seed !== undefined) perOptions.seed = reqOptions.seed + i;

      // A long Wan Animate source is chunked SEAMLESSLY by the server in ONE ComfyUI
      // graph (chained continue_motion) → a single request returns one merged clip.
      if (willChunk) sink.label(`${t("msg_generatingVideoSeamless", { n: estPasses, sec: fullSec || "?" })}${vidSuffix}`);
      else if (count > 1) sink.label(`${t("msg_generatingVideo")}${vidSuffix} (${i + 1}/${count})`);
      const resp = await requestVideo(perOptions);
      let data = await resp.json();
      if (!resp.ok || !data.videos || !data.videos.length) {
        // First render failed → surface the error. A later one failing → keep
        // the videos we have and stop.
        if (!allVideos.length) { failFatal(data.error || data.detail); return; }
        break;
      }
      lastData = data;
      const vmime = data.videoMime || "video/mp4";
      // Poster frame(s) for the just-finished video(s) — appended, not rebuilt.
      const newThumbs = await Promise.all(data.videos.map((v) =>
        videoThumbnail(v.startsWith("data:") ? v : `data:${vmime};base64,${v}`)));
      allVideos.push(...data.videos);
      allThumbs.push(...newThumbs);
      renderReply(); // show this completed video immediately
    }
    sink.clearBubble();
    setAvatarState("happy");
    setTimeout(() => setAvatarState("idle"), 2000);
  } catch (error) {
    sink.clearBubble();
    // Videos finished before a stop/error are already shown via renderReply().
    if (error.name !== "AbortError" && !allVideos.length) {
      sink.place({ role: "assistant", content: `视频生成出错：${error.message}`, timestamp: Date.now() });
    }
    setAvatarState("idle");
  } finally {
    clearTimeout(_progStall);
    sink.clearBubble();
    sink.done();
    unsubscribe();
    releaseWakeLock();
    sink.cleanup();
  }
}

export async function generateImage(parsedInput, tabId = state.activeTabId, insertIndex = -1, initImages = null, initVideo = null, maskB64 = null, sink = null, modelOverride = null) {
  const parsedList = Array.isArray(parsedInput) ? parsedInput : [parsedInput];
  const tab = getTab(tabId);
  if (!tab) return;
  const genStart = Date.now();

  // Image-to-image: raw base64 reference image(s) condition the generation.
  const refImages = Array.isArray(initImages) && initImages.length ? initImages : null;

  // An empty Ollama image model means "generate via ComfyUI". Fall back to the
  // selected ComfyUI checkpoint in that case. modelOverride pins the model chosen
  // at submit time for a queued background job (DOM may have changed since).
  const imageModel = modelOverride ? (modelOverride.imageModel || "") : dom.imageModelSelect.value;
  const comfyModel = modelOverride ? (modelOverride.comfyModel || "") : (dom.comfyModelSelect ? dom.comfyModelSelect.value : "");
  // This job's ComfyUI worker (multi-machine parallel lanes); modelOverride pins it at
  // submit. ovComfyUrl is the raw worker url; comfyHost is host:port for WS/interrupt.
  const ovComfyUrl = modelOverride ? (modelOverride.comfyUrl || "") : "";
  const comfyHost = ((ovComfyUrl || dom.comfyUrlDisplay?.textContent || "").replace(/\s*\(.*\)\s*$/, "").trim()).replace(/^https?:\/\//i, "").replace(/\/+$/, "");

  // Wan Animate SINGLE-FRAME (still pose transfer): animate model, NO source video, and
  // ≥2 images (1st = pose, 2nd = character) → an IMAGE result. Fall through to the image
  // path below (which sends the images and renders the returned still) instead of the
  // video path.
  const isAnimateStill = /animate/i.test(comfyModel || "") && !initVideo && Array.isArray(refImages) && refImages.length >= 2;

  // A selected ComfyUI VIDEO model routes to the dedicated video path. Pass the
  // sink + the worker url through so a background video job stays headless + on-target.
  if (!imageModel && comfyModel && state.comfyVideoModels && state.comfyVideoModels.has(comfyModel) && !isAnimateStill) {
    return generateVideo(parsedList[0], comfyModel, tabId, insertIndex, refImages, initVideo, sink, ovComfyUrl);
  }

  const useComfy = !imageModel && !!comfyModel;
  const activeModel = imageModel || comfyModel;

  // Build the sink now (foreground unless the jobs runner supplied a background
  // one). It owns the AbortController, the lock, the bubble and message placement.
  if (!sink) sink = foregroundSink({ tabId, insertIndex, setGenerating: _setGenerating, renderChat: _renderChat, saveChat, getTab });

  if (!activeModel) {
    sink.place({ role: "assistant", content: t("msg_noImageModel"), timestamp: Date.now() });
    sink.cleanup();
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
  // (potentially slow) prompt-enhancement step, not just image generation. The
  // sink owns the real AbortController; this shim keeps existing .signal refs working.
  const abortController = { signal: sink.signal };
  sink.lock(true);
  acquireWakeLock(); // keep the display awake for a long (batch / img2img) render

  if (anyEnhance) {
    setAvatarState("thinking");
    sink.start("image", t("msg_enhancing"));
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
    sink.clearBubble();
    releaseWakeLock();
    setAvatarState("idle");
    sink.done();
    sink.cleanup();
    return;
  }

  // Surface the improved prompt(s) in the pending bubble before generation runs.
  const enhancedShown = parsedList
    .map((p, i) => (p.enhance && prompts[i] !== p.prompt) ? prompts[i] : null)
    .filter(Boolean);
  if (enhancedShown.length) sink.enhanced(enhancedHtml(enhancedShown));

  setAvatarState("thinking");

  // Status suffix: which model is generating, and (for multi-image edits) how
  // many reference images are actually being sent.
  const refCount = refImages ? refImages.length : 0;
  const shortModel = (activeModel || "").replace(/\.(safetensors|ckpt|gguf|pth)$/i, "");
  const statusSuffix = (shortModel ? ` · ${shortModel}` : "") + (refCount > 1 ? ` · ${t("msg_inputImages", { n: refCount })}` : "");
  const genText = (done) => (totalCount > 1 ? t("msg_generatingCount", { done, total: totalCount }) : t("msg_generating")) + statusSuffix;

  // Start tracking now (or just relabel if the enhance step already started it).
  if (sink.started()) {
    sink.label(genText("0"));
  } else {
    sink.start("image", genText("0"));
  }

  // Live progress bar (+ preview frame for ComfyUI). ComfyUI streams over its
  // WebSocket (keyed by clientId); Ollama streams NDJSON progress on the same HTTP
  // response (read below). One bar is shared across a batch. Both feed the
  // pending bubble through state so updates survive a tab switch.
  let comfyClientId = null, imgUnsub = () => {};
  const setProgress = (value, max) => sink.progress(value, max);
  if (useComfy) {
    comfyClientId = crypto.randomUUID ? crypto.randomUUID() : `hk-${Date.now()}-${Math.random()}`;
    imgUnsub = subscribeComfyProgress(comfyHost, comfyClientId, {
      onProgress: setProgress,
      onPreview: (url) => sink.preview(url),
    });
  }
  // Stop button → abort: also tell ComfyUI to interrupt the running render
  // (aborting the fetch alone leaves the GPU working). Ollama is cancelled
  // server-side when the connection drops.
  if (useComfy) {
    abortController.signal.addEventListener("abort", () => interruptComfy(comfyHost), { once: true });
  }

  try {
    const generatedImages = [];
    let errorCount = 0;
    let lastError = "";

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

        const reqBody = {
          model: activeModel,
          prompt,
          negative_prompt: comfyNegative(parsed.negativePrompt),
          options: reqOptions,
          images: refImages || undefined,
          // Inpaint mask (white = repaint region) — only used by the ComfyUI
          // path; routes the gen to a masked edit / SetLatentNoiseMask inpaint.
          mask: (useComfy && maskB64) ? maskB64 : undefined,
          timeout: reqTimeout,
          clientId: comfyClientId || undefined,
          comfyUrl: (useComfy && comfyHost) ? comfyHost : undefined, // this job's ComfyUI worker
        };
        // Option B: a background ComfyUI job runs on the SERVER queue (survives reload);
        // foreground / Ollama-image keep the direct call. comfyFetch returns a Response-
        // like {ok,json} so the result handling below is unchanged.
        const execP = (useComfy && sink.server)
          ? comfyFetch(reqBody, { bgJob: totalCount === 1 ? sink.server.bgJob : null, kind: "image", comfyUrl: comfyHost, conversationId: sink.server.conversationId, msgId: sink.server.msgId, label: sink.server.label, clientId: comfyClientId, signal: abortController.signal })
          : fetch(useComfy ? "/api/generate-comfy" : "/api/generate-image", { method: "POST", headers: { "Content-Type": "application/json" }, signal: abortController.signal, body: JSON.stringify(reqBody) });
        promises.push(
          execP
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
                  sink.addImage(src);
                }
              } else {
                errorCount++;
                lastError = data.error || data.detail || "";
                console.warn("[image-gen] error:", data.error, data.detail || "");
              }
              if (totalCount > 1) {
                sink.label(genText(generatedImages.length + errorCount));
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
      content = lastError
        ? `图片生成失败：${lastError}`
        : "图片生成失败，请检查模型是否正确安装并支持图像生成。";
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
      // Append the model used (selected name, extension stripped).
      if (shortModel) doneLine += ` · ${shortModel}`;
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

    // Drop the restorable pending bubble just before render so the live preview
    // grid stays visible right up until the final message replaces it.
    sink.clearBubble();
    sink.place(replyMsg);
    setAvatarState("happy");
    setTimeout(() => setAvatarState("idle"), 2000);
  } catch (error) {
    sink.clearBubble();
    if (error.name === "AbortError") {
      // clearBubble already removed the bubble (live or restored).
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
      sink.place(replyMsg);
    } else {
      // Failed with no images — surface the error as a normal message.
      sink.place({ role: "assistant", content: `图片生成出错：${error.message}`, timestamp: Date.now() });
    }
    setAvatarState("idle");
  } finally {
    sink.clearBubble();
    sink.done();
    imgUnsub();
    releaseWakeLock();
    sink.cleanup();
  }
}