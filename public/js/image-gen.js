// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

// Image generation and /imagine command parsing
import { dom, state } from './state.js';
import { SIZE_PRESETS } from './constants.js';
import { t, getPromptLanguage } from './i18n.js';
import { makePreview, escapeHtml } from './utils.js';
import { setAvatarState, showExpression } from './avatar.js';
import { saveChat } from './settings.js';
import { getTab } from './tabs.js';
import { foregroundSink } from './gen-sink.js';
import { comfyFetch } from './server-queue.js';   // Option B: run ComfyUI gen on the server queue

// Drop a model file's extension for display (e.g. "RealESRGAN_x4plus.pth" → "RealESRGAN_x4plus").
const stripModelExt = (n) => (n || "").replace(/\.(safetensors|ckpt|gguf|pth|sft|bin)$/i, "");

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

// Note: sleep prevention is owned by the SERVER (server/jobs.js holds a
// `caffeinate` while the job queue is non-empty) — it doesn't depend on the
// browser being open/visible, so there is no client-side Screen Wake Lock here.

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
  const precision = dom.comfyParamPrecision?.value || "";
  if (precision) ov.precision = precision; // ⚙ quantisation tier preference (empty = auto)
  const length = num(dom.comfyParamLength?.value);
  if (length !== undefined) ov.length = length;
  const fps = num(dom.comfyParamFps?.value);
  if (fps !== undefined) ov.fps = fps;
  const timeoutMin = num(dom.comfyParamTimeout?.value);
  if (timeoutMin !== undefined) ov.timeoutMin = timeoutMin; // ⚙ video render deadline (min); empty/0 → unlimited
  // 3D mesh knobs (each read by exactly one chain; harmless elsewhere).
  // meshDetail is shared: Hunyuan3D's octree_resolution and SplatToMesh's density
  // grid are the same idea, so one knob drives whichever mesher is running.
  const meshDetail = num(dom.comfyParamMeshDetail?.value);
  if (meshDetail !== undefined) ov.meshDetail = meshDetail;
  if (dom.comfyParamSplatMesh?.checked) ov.splatMesh = true;        // TripoSplat: coloured mesh instead of .spz
  const meshGaussians = num(dom.comfyParamMeshGaussians?.value);
  if (meshGaussians !== undefined) ov.meshGaussians = meshGaussians; // TripoSplat num_gaussians
  const mogeDetail = num(dom.comfyParamMogeDetail?.value);
  if (mogeDetail !== undefined) ov.mogeDetail = mogeDetail;         // MoGe resolution_level 0-9
  const targetFps = num(dom.comfyParamTargetFps?.value);
  if (targetFps !== undefined) ov.targetFps = targetFps; // frame interpolation: interpolate up to this fps
  if (dom.comfyParamInterpMethod?.value) ov.interpMethod = dom.comfyParamInterpMethod.value; // rife | film
  const upDenoise = num(dom.comfyParamUpscaleDenoise?.value);
  if (upDenoise !== undefined && upDenoise > 0) ov.upscaleDenoise = Math.min(1, upDenoise / 100); // upscale denoise % → 0–1
  if (dom.comfyParamUpscaleModel?.value) ov.upscaleModel = dom.comfyParamUpscaleModel.value; // manual upscale model (empty = auto)
  if (dom.comfyParamTorchCompile?.checked) ov.torchCompile = true; // Wan Animate: TorchCompileModel
  if (dom.comfyParamVideoCodec?.value) ov.videoCodec = dom.comfyParamVideoCodec.value; // video: h264 (default) | h265, via VHS_VideoCombine
  const videoCrf = num(dom.comfyParamVideoCrf?.value);
  if (videoCrf !== undefined) ov.videoCrf = videoCrf; // CRF for the selected codec (empty = codec default)
  // Bernini sampling recipe (one dropdown → the server's two mode flags).
  const berniniMode = dom.comfyParamBerniniMode?.value || "";
  if (berniniMode === "quality") ov.berniniQuality = true;   // 40-step / cfg 5, no LoRA
  else if (berniniMode === "lightx2v") ov.berniniLightx2v = true; // LightX2V 4-step recipe
  // Which Bernini video-edit task line to use. Several tasks share v2v's wiring, so an
  // explicit pick is the ONLY way to reach them; empty = infer from the attachments.
  const berniniTask = dom.comfyParamBerniniTask?.value || "";
  if (berniniTask) ov.berniniTask = berniniTask;
  const refMaxSize = num(dom.comfyParamRefMaxSize?.value);
  if (refMaxSize !== undefined) ov.refMaxSize = refMaxSize; // Bernini: reference long-edge cap
  // LTX LoRA. Sent even when the picker is showing a baked-in choice — the server
  // re-applies the same suppression rule, so the two can't disagree.
  if (dom.comfyParamLtxLora?.value) ov.ltxLora = dom.comfyParamLtxLora.value;
  const ltxLoraStrength = num(dom.comfyParamLtxLoraStrength?.value);
  if (ltxLoraStrength !== undefined) ov.ltxLoraStrength = ltxLoraStrength;
  if (dom.comfyParamPhantomTurbo?.checked) ov.phantomTurbo = true; // Phantom: step-distill LoRA (dual-CFG collapses)
  const phantomImgCfg = num(dom.comfyParamPhantomImgCfg?.value);
  if (phantomImgCfg !== undefined) ov.phantomImgCfg = phantomImgCfg; // Phantom: image-guidance scale (g_img)
  const relight = num(dom.comfyParamRelight?.value);
  if (relight !== undefined) ov.relightStrength = relight; // Wan Animate: relight LoRA strength
  if (state.animateMaskPoint) ov.maskPoint = state.animateMaskPoint; // Wan Animate Replace: which person to swap
  // SCAIL-2. The subject fields are free text (SAM3 is open-vocabulary), so they go
  // over trimmed but otherwise untouched — the server clamps/normalises the rest.
  const scailSubject = (dom.comfyParamScailSubject?.value || "").trim();
  if (scailSubject) ov.scailSubject = scailSubject;               // SAM3 text for the source video (empty = "human")
  const scailRefSubject = (dom.comfyParamScailRefSubject?.value || "").trim();
  if (scailRefSubject) ov.scailRefSubject = scailRefSubject;      // SAM3 text for the reference (empty = same as above)
  const scailThreshold = num(dom.comfyParamScailThreshold?.value);
  if (scailThreshold !== undefined) ov.scailThreshold = scailThreshold;   // SAM3 detection confidence
  const scailMaxObjects = num(dom.comfyParamScailMaxObjects?.value);
  if (scailMaxObjects !== undefined) ov.scailMaxObjects = scailMaxObjects; // SAM3 max tracked subjects (0 = node cap 64)
  const scailIndices = (dom.comfyParamScailIndices?.value || "").trim();
  if (scailIndices) ov.scailIndices = scailIndices;               // which tracked subjects, e.g. "0,2" (empty = all)
  if (dom.comfyParamScailSortBy?.value) ov.scailSortBy = dom.comfyParamScailSortBy.value; // identity ordering
  const poseStrength = num(dom.comfyParamPoseStrength?.value);
  if (poseStrength !== undefined) ov.poseStrength = poseStrength;
  const poseStart = num(dom.comfyParamPoseStart?.value);
  if (poseStart !== undefined) ov.poseStart = poseStart;
  const poseEnd = num(dom.comfyParamPoseEnd?.value);
  if (poseEnd !== undefined) ov.poseEnd = poseEnd;
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

// The persistent POSITIVE add-on from the ⚙ ComfyUI params modal — APPENDED to every image AND
// video prompt (the symmetric counterpart of comfyNegative: a fixed style / quality booster that's
// always added, e.g. "cinematic, high detail"). Content first, add-on after; silent (not shown in
// the bubble). Empty → the prompt is returned unchanged. An empty prompt (attachment-driven gen)
// becomes just the add-on.
function comfyPositive(promptText) {
  const add = dom.comfyParamPositive?.value?.trim();
  if (!add) return promptText;
  const base = (promptText || "").trim();
  return base ? `${base}, ${add}` : add;
}

// Whether the currently-selected ComfyUI model can use an inpaint mask. True for
// any image model that takes a source image (plain checkpoints + all instruction
// editors + boogu img2img); false for the Ollama path, video models, and the
// txt2img-only models that have no source latent to mask (HiDream-I1 / Z-Image).
// Shared by the compose-area staged thumbnail and the sent-bubble mask button so
// both surfaces agree on when the 🖌 control appears.
export function comfyModelSupportsMask() {
  const comfyModel = dom.comfyModelSelect?.value;
  if (!comfyModel) return false;
  if (dom.imageModelSelect?.value) return false; // Ollama image model wins → no mask
  if (state.comfyVideoModels && state.comfyVideoModels.has(comfyModel)) return false;
  if (/hidream.?i1|z.?image/i.test(comfyModel)) return false; // txt2img-only
  if (/hidream.?o1/i.test(comfyModel)) return false; // O1 edits via reference conditioning on an empty latent — no source latent to mask
  if (comfyModel === "image-upscale") return false; // pure upscale — nothing to mask
  return true;
}

export function parseNoteCommand(input) {
  const match = input.match(/^\/note\s+(.+)$/s);
  if (!match) return null;
  if (!match[1].trim()) {
    return { error: t("img_noteMissingContent") };
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
      return { error: t("img_batchOutOfRange", { n }) };
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
      if (!sizeFlag) return { error: t("img_sizeNeedsArg") };
      const sizeVal = sizeFlag[1];
      let w, h;
      const preset = SIZE_PRESETS[sizeVal.toLowerCase()];
      if (preset) {
        [w, h] = preset.split("x").map(Number);
      } else {
        const sizeParsed = sizeVal.match(/^(\d+)x(\d+)$/i);
        if (!sizeParsed) {
          return { error: t("img_sizeFormatError", { val: sizeVal, presets: Object.keys(SIZE_PRESETS).join(", ") }) };
        }
        w = parseInt(sizeParsed[1], 10);
        h = parseInt(sizeParsed[2], 10);
        if (w < 256 || w > 4096 || h < 256 || h > 4096) {
          return { error: t("img_sizeOutOfRange", { w, h }) };
        }
      }
      result.options.width = w;
      result.options.height = h;
      result.sizeExplicit = true;
      rest = rest.replace(/^--size\s+\S+\s*/, "").trim();
    } else if (/^--steps\s/.test(rest)) {
      const stepsFlag = rest.match(/^--steps\s+(\S+)/);
      if (!stepsFlag) return { error: t("img_stepsNeedsArg") };
      const val = stepsFlag[1];
      const n = parseInt(val, 10);
      if (isNaN(n) || n < 1 || n > 100) {
        return { error: t("img_stepsInvalid", { val }) };
      }
      result.options.steps = n;
      rest = rest.replace(/^--steps\s+\S+\s*/, "").trim();
    } else if (/^--seed\s/.test(rest)) {
      const seedFlag = rest.match(/^--seed\s+(\S+)/);
      if (!seedFlag) return { error: t("img_seedNeedsArg") };
      const val = seedFlag[1];
      const n = parseInt(val, 10);
      if (isNaN(n) || n < 0 || n > 2147483647) {
        return { error: t("img_seedInvalid", { val }) };
      }
      result.options.seed = n;
      rest = rest.replace(/^--seed\s+\S+\s*/, "").trim();
    } else if (/^--quality\s/.test(rest)) {
      const qualityFlag = rest.match(/^--quality\s+(\S+)/);
      if (!qualityFlag) return { error: t("img_qualityNeedsArg") };
      const val = qualityFlag[1];
      if (!["high", "medium", "low"].includes(val)) {
        return { error: t("img_qualityInvalid", { val }) };
      }
      result.options.quality = val;
      rest = rest.replace(/^--quality\s+\S+\s*/, "").trim();
    } else if (/^--voice\s/.test(rest)) {
      // TTS voice for "photo speaks" (InfiniteTalk): a Kokoro voice id, e.g.
      // zf_xiaoxiao / zm_yunxi / af_heart. Validated server-side; other models ignore it.
      const voiceFlag = rest.match(/^--voice\s+(\S+)/);
      if (!voiceFlag) return { error: t("img_voiceNeedsArg") };
      result.options.ttsVoice = voiceFlag[1];
      rest = rest.replace(/^--voice\s+\S+\s*/, "").trim();
    } else {
      const unknownMatch = rest.match(/^--([\w-]+)/);
      return { error: t("img_unknownArg", { arg: unknownMatch[1], presets: Object.keys(SIZE_PRESETS).join("/") }) };
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

// ---- /analyze keyframe selection (scene detection + near-duplicate dedup) ----
// Even sampling misses fast cuts and wastes frames on static stretches. Instead:
// probe the video densely on tiny thumbnails, score how much the picture changes
// between consecutive probes, pick the biggest change points as keyframes (with a
// minimum separation), fill any leftover budget at the middle of the largest
// uncovered gaps (density floor), then drop near-duplicates against a sliding
// window of already-kept frames. Falls back to extractVideoFrames on any failure.
const PROBE_SIDE = 64;        // longest side of probe thumbnails — 64 keeps a changed slide bullet visible; diff cost is negligible vs the seeks
const PROBE_MAX = 120;        // probe budget (each probe = one seek + decode)
const SCENE_MIN_DIFF = 0.10;  // probe diff (0..1) at/above this = scene-change candidate
const DEDUP_DIFF = 0.03;      // picked-frame diff below this vs a recent kept frame = near-duplicate
const DEDUP_WINDOW = 4;       // how many recent kept frames each pick is compared against
const THUMB_SIDE = 320;       // display thumbnails (chat "thinking" block), NOT sent to the model

// Mean |RGB delta| between two equal-size RGBA buffers, normalized to 0..1.
// Mismatched sizes (video dimension change mid-stream) count as a full change.
function probeDiff(a, b) {
  if (!a || !b || a.length !== b.length) return 1;
  let sum = 0;
  for (let i = 0; i < a.length; i += 4) {
    sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
  }
  return sum / ((a.length / 4) * 3 * 255);
}

// Scene-aware sibling of extractVideoFrames: picks UP TO `count` keyframes at scene
// changes (a long static clip legitimately yields fewer). Resolves
// { frames: [{url, t, scene}], dropped } — `scene` marks a frame picked at a change
// point (vs density-floor fill), `dropped` counts deduped near-duplicates.
export function extractKeyFrames(src, count = 8, quality = 0.72, maxSide = 1280) {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    video.muted = true;
    video.preload = "auto";
    const probeCanvas = document.createElement("canvas");
    const canvas = document.createElement("canvas");
    let phase = "probe";
    let times = [];       // seek plan for the current phase
    let idx = 0;
    const probes = [];    // {t, data} tiny thumbnails, chronological
    let picked = [];      // {t, scene} selected keyframe times
    let dropped = 0;
    const frames = [];    // final {url, t, scene}
    let done = false;
    // Per-seek watchdog (not a global cap — a long probe pass is legitimate).
    let timer = setTimeout(finish, 15000);
    const bump = () => { clearTimeout(timer); timer = setTimeout(finish, 15000); };
    function finish() {
      if (done) return;
      done = true;
      clearTimeout(timer);
      video.removeAttribute("src");
      try { video.load(); } catch {}
      if (frames.length) resolve({ frames, dropped });
      else extractVideoFrames(src, count, quality, maxSide)   // probing failed → even sampling
        .then((fs) => resolve({ frames: fs.map((f) => ({ ...f, scene: false })), dropped: 0 }));
    }
    const seekNext = () => {
      try { video.currentTime = times[idx]; }
      catch { onSeeked(); }
    };
    const grabProbe = () => {
      const w = video.videoWidth, h = video.videoHeight;
      if (w && h) {
        try {
          const scale = PROBE_SIDE / Math.max(w, h);
          probeCanvas.width = Math.max(1, Math.round(w * scale));
          probeCanvas.height = Math.max(1, Math.round(h * scale));
          const c = probeCanvas.getContext("2d", { willReadFrequently: true });
          c.drawImage(video, 0, 0, probeCanvas.width, probeCanvas.height);
          probes.push({ t: video.currentTime, data: c.getImageData(0, 0, probeCanvas.width, probeCanvas.height).data });
        } catch { /* tainted/undecodable frame — skip */ }
      }
      idx++;
      bump();
      if (idx >= times.length) return selectKeyframes();
      seekNext();
    };
    const grabFinal = () => {
      const w = video.videoWidth, h = video.videoHeight;
      if (w && h) {
        try {
          const scale = Math.min(1, maxSide / Math.max(w, h));
          canvas.width = Math.max(1, Math.round(w * scale));
          canvas.height = Math.max(1, Math.round(h * scale));
          canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
          // Small display thumb for the chat's folded thinking block (probeCanvas is
          // free after the probe phase) — downscaled from the big canvas, cheap.
          const tScale = Math.min(1, THUMB_SIDE / Math.max(canvas.width, canvas.height));
          probeCanvas.width = Math.max(1, Math.round(canvas.width * tScale));
          probeCanvas.height = Math.max(1, Math.round(canvas.height * tScale));
          probeCanvas.getContext("2d").drawImage(canvas, 0, 0, probeCanvas.width, probeCanvas.height);
          frames.push({ url: canvas.toDataURL("image/jpeg", quality), thumb: probeCanvas.toDataURL("image/jpeg", 0.6), t: video.currentTime, scene: picked[idx] ? picked[idx].scene : false });
        } catch { /* skip */ }
      }
      idx++;
      bump();
      if (idx >= times.length) return finish();
      seekNext();
    };
    const onSeeked = () => (phase === "probe" ? grabProbe() : grabFinal());
    function selectKeyframes() {
      if (probes.length < 2) return finish();   // not enough signal → fallback path
      const dur = (video.duration && isFinite(video.duration)) ? video.duration : probes[probes.length - 1].t + 1;
      // Change score per probe = diff vs its predecessor ("how much changed HERE").
      const scored = probes.map((p, i) => ({ t: p.t, data: p.data, i, score: i ? probeDiff(probes[i - 1].data, p.data) : 0 }));
      const minSep = Math.max(0.5, dur / (count * 2));
      // 1. Scene-change picks: biggest changes first, keeping a minimum separation.
      const picks = [];
      const cands = scored.filter((p) => p.score >= SCENE_MIN_DIFF).sort((x, y) => y.score - x.score);
      for (const c of cands) {
        if (picks.length >= count) break;
        if (picks.some((p) => Math.abs(p.t - c.t) < minSep)) continue;
        picks.push({ ...c, scene: true });
      }
      // 2. Density floor: fill the remaining budget at the middle of the largest
      //    uncovered gap. Stop when no gap is meaningfully large — a static clip
      //    yields FEWER than `count` frames by design.
      while (picks.length < count) {
        const bounds = [0, ...picks.map((p) => p.t).sort((a, b) => a - b), dur];
        let gi = 0, glen = -1;
        for (let i = 0; i + 1 < bounds.length; i++) {
          if (bounds[i + 1] - bounds[i] > glen) { glen = bounds[i + 1] - bounds[i]; gi = i; }
        }
        if (glen < minSep * 2) break;
        const mid = bounds[gi] + glen / 2;
        let best = null;
        for (const p of scored) {
          if (picks.some((k) => k.i === p.i)) continue;
          if (!best || Math.abs(p.t - mid) < Math.abs(best.t - mid)) best = p;
        }
        if (!best) break;
        picks.push({ ...best, scene: false });
      }
      picks.sort((a, b) => a.t - b.t);
      // 3. Near-duplicate dedup on the probe thumbnails: drop a pick that barely
      //    differs from any of the last DEDUP_WINDOW kept frames (catches A-B-A
      //    cutting patterns, not just adjacent repeats).
      const kept = [];
      for (const p of picks) {
        if (kept.slice(-DEDUP_WINDOW).some((k) => probeDiff(k.data, p.data) < DEDUP_DIFF)) { dropped++; continue; }
        kept.push(p);
      }
      if (!kept.length && picks.length) kept.push(picks[0]);
      picked = kept.map((p) => ({ t: p.t, scene: p.scene }));
      probes.length = 0;   // free the pixel buffers
      phase = "final";
      times = picked.map((p) => p.t);
      idx = 0;
      if (!times.length) return finish();
      seekNext();
    }
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("loadeddata", () => {
      const dur = video.duration;
      if (!dur || !isFinite(dur)) return finish();   // unknown duration → fallback
      // ~1 probe/second, at least 4× the frame budget, capped at PROBE_MAX seeks.
      const probeCount = Math.min(PROBE_MAX, Math.max(count * 4, Math.ceil(dur)));
      times = Array.from({ length: probeCount }, (_, i) => (dur * (i + 0.5)) / probeCount);
      seekNext();
    }, { once: true });
    video.addEventListener("error", finish, { once: true });
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
// Upload the speech audio (InfiniteTalk dubbing) the same way — raw binary via the
// server proxy; returns the ComfyUI filename + probed duration (drives the length
// estimate on the done-line).
async function uploadComfySourceAudio(audio, signal, comfyHost) {
  const mime = audio.mime || "audio/wav";
  const blob = await (await fetch(`data:${mime};base64,${audio.base64}`)).blob();
  const headers = { "Content-Type": mime };
  if (comfyHost) headers["X-Comfy-Url"] = comfyHost;
  const r = await fetch("/api/comfy-upload-audio", { method: "POST", headers, body: blob, signal });
  if (!r.ok) throw new Error(`speech audio upload failed (${r.status})`);
  const d = await r.json();
  return { name: d.name, duration: d.duration || 0 };
}

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
        // Standard ComfyUI payload: [4B event][4B format] + image bytes. But
        // WanVideoWrapper's animated previewer (InfiniteTalk etc.) sends a VHS-style
        // payload with 4B frame index + 16B node id prepended before the JPEG —
        // slicing at 8 there yields a broken blob (no preview shows). Don't trust the
        // fixed offset: scan the first bytes for the JPEG/PNG magic and cut THERE.
        const u8 = new Uint8Array(ev.data);
        let off = 8;
        if (!((u8[8] === 0xFF && u8[9] === 0xD8) || (u8[8] === 0x89 && u8[9] === 0x50))) {
          for (let i = 9; i < Math.min(u8.length - 1, 96); i++) {
            if ((u8[i] === 0xFF && u8[i + 1] === 0xD8) || (u8[i] === 0x89 && u8[i + 1] === 0x50)) { off = i; break; }
          }
          if (off === 8) return; // no image magic found — not a renderable preview frame
        }
        const mime = u8[off] === 0x89 ? "image/png" : "image/jpeg";
        onPreview?.(URL.createObjectURL(new Blob([ev.data.slice(off)], { type: mime })));
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
  // Compile-off caps from real 5090 measurements: 720p 161f is well-tested. 1080p
  // (~2.25× the pixels of 720p) is set to 81f ≈ half the 720p cap — a conservative
  // scaling that sits under the 65f→22.9GB measured point's headroom.
  const tiers = torchCompile
    ? [[520000, 121], [1000000, 65], [2100000, 33]]    // compile on — conservative (extra VRAM)
    : [[520000, 241], [1000000, 161], [2100000, 81]];  // compile off
  for (const [lim, cap] of tiers) if (pixelBudget <= lim) return cap;
  return torchCompile ? 17 : 33;           // beyond 1080p
}

// SCAIL-2's "animate" MODE sentinel (scail2_animate) also matches /animate/, while its
// other entry is the raw filename and matches neither — so a bare /animate/ test both
// misfires and splits SCAIL-2's two entries. Route by these instead.
const isScail2Model = (m) => /scail/i.test(m || "");
const isWanAnimateModel = (m) => /animate/i.test(m || "") && !isScail2Model(m);
// Wan Animate takes exactly ONE reference (the character) and ignores any extras.
// SCAIL-2 does NOT: its reference is a batch — image 1 is the character and the rest are
// additional VIEWS of that same character (back, close-up), which is how it renders
// surfaces the primary view cannot imply. Several CHARACTERS is a different thing again:
// they go inside ONE image, where SAM3 finds them as separate identities.
const usesOneRefImage = (m) => isWanAnimateModel(m);
// Whether the model chains segments out of a source video — a separate question from how
// many reference images it reads, and the two answers stopped agreeing once SCAIL-2
// learned to take extra views.
const isPoseTransfer = (m) => isWanAnimateModel(m) || isScail2Model(m);
// Frames per chained pass. SCAIL-2's is a FIXED 81 (mirrors SCAIL2_FRAMES in
// server/comfy.js) — its cost doesn't scale with resolution the way Animate's does.
const SCAIL2_SEG_FRAMES = 81;
const SEG_OVERLAP = 5; // same in both pipelines
const segmentCapFor = (m, pixelBudget, torchCompile) =>
  isScail2Model(m) ? SCAIL2_SEG_FRAMES : animateSegmentCap(pixelBudget, torchCompile);

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
  setAvatarState("thinking");

  const vidModel = (model || "").replace(/\.(safetensors|ckpt|gguf|pth)$/i, "");
  // Name what the extra images actually did. Wan Animate ignores them — say so, or the
  // user assumes they landed. SCAIL-2 uses them as additional views of the character, so
  // it gets its own wording rather than the generic "N images" count.
  const vidImgs = refImages && refImages.length > 1
    ? (usesOneRefImage(model)
        ? ` · ${t("msg_animateFirstImageOnly", { n: refImages.length })}`
        : isScail2Model(model)
          ? ` · ${t("msg_scailViews", { n: refImages.length - 1 })}`
          : ` · ${t("msg_inputImages", { n: refImages.length })}`)
    : "";
  const vidSuffix = `${vidModel ? ` · ${vidModel}` : ""}${vidImgs}`;
  // Enhancement already ran at enqueue time (the bg placeholder showed "enhancing prompt"),
  // so by here we go straight to the generating status.
  sink.start("video", `${t("msg_generatingVideo")}${vidSuffix}`);
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

  // Speech audio (InfiniteTalk dubbing) rides on the source clip. Models flagged
  // needsAudio require it — fail fast with a clear message instead of uploading a
  // clip only for the server to reject the job.
  const speechAudio = sourceVideo?.speechAudio || null;
  if (state.comfyAudioInModels && state.comfyAudioInModels.has(model) && !(speechAudio && speechAudio.base64)) {
    sink.fail(t("msg_needSpeechAudio"));
    setAvatarState("idle");
    return;
  }
  let sourceAudioName = null;
  let sourceAudioDuration = 0;
  if (speechAudio?.base64) {
    try {
      const upA = await uploadComfySourceAudio(speechAudio, abortController.signal, comfyHost);
      sourceAudioName = upA.name;
      sourceAudioDuration = upA.duration || speechAudio.duration || 0;
    } catch (e) {
      if (e.name === "AbortError") {
        sink.clearBubble(); setAvatarState("idle");
        sink.done(); sink.cleanup();
        return;
      }
      /* non-fatal: fall back to sending the base64 inline below */
      sourceAudioDuration = speechAudio.duration || 0;
    }
  }

  // Prompt enhancement is done at ENQUEUE time (client-side, foreground — see
  // enqueueImagineGen). parsed.enhancedPrompt holds the rewrite (raw parsed.prompt kept
  // for the record); send the enhanced text when present.
  const videoPrompt = parsed.enhancedPrompt || parsed.prompt;
  const promptWasEnhanced = !!parsed.enhancedPrompt;

  // Estimated chunk count for a chained Wan Animate / SCAIL-2 (each chunk = one
  // sampler pass). Drives both the scaled timeout (below) and the overall progress /
  // ETA. The server decides the real count; ±1 here is fine for an estimate.
  const animBudgetEta = (reqOptions.width && reqOptions.height) ? reqOptions.width * reqOptions.height : 640 * 640;
  // Frames that actually get chained into segments — the ⚙ length rule DIFFERS per
  // pipeline (mirrors the server): it bounds Wan Animate to ONE pass, but for SCAIL-2
  // it only CAPS how much source is used, and SCAIL-2 still chains to reach it (its
  // 81/pass is a model constraint, not a VRAM tier). 0 = not a chained run.
  const chainFrames = (isPoseTransfer(model) && sourceVideoFrames > 0)
    ? (reqOptions.length
        ? (isScail2Model(model) ? Math.min(reqOptions.length, sourceVideoFrames) : 0)
        : sourceVideoFrames)
    : 0;
  // Segment 0 covers a FULL cap-sized pass; only later ones trim the overlap, so the
  // count is 1 + ceil((frames − cap) / (cap − overlap)) — true of both pipelines. The
  // old `ceil(frames / (cap − overlap))` over-counted by one whenever the source fit
  // in a single pass (81 frames at an 81 cap read as 2 → the badge showed "1/2").
  const estPasses = (() => {
    if (chainFrames <= 0) return 1;
    const cap = Math.max(1, segmentCapFor(model, animBudgetEta, !!reqOptions.torchCompile));
    if (chainFrames <= cap) return 1;
    return 1 + Math.ceil((chainFrames - cap) / Math.max(1, cap - SEG_OVERLAP));
  })();

  // Live progress bar + preview frames via ComfyUI's WebSocket. The browser owns
  // the clientId and hands it to the server so both subscribe to the same stream.
  // Both feed the pending bubble through state so they survive a tab switch.
  // For a background job, reuse its STABLE clientId so a post-reload reconnect
  // re-subscribes to the SAME running prompt's progress (else it resets to 0%).
  const clientId = (sink.server && sink.server.comfyClientId)
    || (crypto.randomUUID ? crypto.randomUUID() : `hk-${Date.now()}-${Math.random()}`);
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
    // and those would otherwise inflate the total to a bogus "segment 3/3" / "3/2".
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
  const videoSeeds = []; // per-video seed (aligned with allVideos) → reproduce any one
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
    // Meta after the W×H: duration (frames ÷ fps) then the fps itself — each shown only when known.
    const metaParts = [];
    if (lastData.length && lastData.fps) {
      const r = Math.round((lastData.length / lastData.fps) * 10) / 10;
      metaParts.push(`${Number.isInteger(r) ? r : r.toFixed(1)}s`);
    }
    if (lastData.fps) {
      const f = lastData.fps;
      metaParts.push(`${Number.isInteger(f) ? f : Math.round(f * 100) / 100}fps`);
    }
    const dur = metaParts.length ? `, ${metaParts.join(", ")}` : "";
    const sizeLine = t("msg_videoDone", { w: lastData.width || "?", h: lastData.height || "?", dur }, plang);
    // The tier that actually loaded rides alongside the model name — a model can ship
    // several quantisations and they differ in both speed and fidelity, so which one
    // ran is part of reading the result. Absent for models whose filename carries no
    // precision token.
    let doneLine = (count > 1 ? `${sizeLine} ×${allVideos.length}${allVideos.length < count ? `/${count}` : ""}` : sizeLine)
      + (vidModel ? ` · ${vidModel}` : "")
      + (lastData.precisionUsed ? ` · ${lastData.precisionUsed}` : "");
    // Seed(s) used → lets the user reproduce via --seed. Single video shows one;
    // a batch lists each video's seed in display order so any one can be reproduced.
    if (count === 1 && typeof lastData.seed === "number") {
      doneLine += `\n${t("msg_seedUsed", { seed: lastData.seed }, plang)}`;
    } else if (count > 1 && videoSeeds.some((s) => s !== null)) {
      const list = videoSeeds.map((s, i) => `#${i + 1} ${s !== null ? s : "?"}`).join(" · ");
      doneLine += `\n${t("msg_seedsBatch", { list }, plang)}`;
    }
    // The tier itself is already on the line above; this only explains WHY it isn't the
    // one that was asked for — the model has no build at that tier, or a two-expert pair
    // ran half-and-half because only one twin ships it. Silence = request honoured.
    if (lastData.precisionNote) {
      const key = lastData.precisionNote.includes("+") ? "msg_precisionMixed" : "msg_precisionFallback";
      doneLine += `\n${t(key, {}, plang)}`;
    }
    // Framerate boost (frame interpolation): either it ran (note the new fps + multiplier) or it
    // was skipped because the source was already at/above the requested target fps.
    if (lastData.interpolated >= 2 && lastData.fps) {
      doneLine += `\n${t("msg_interpDone", { fps: lastData.fps, mult: lastData.interpolated, method: (lastData.interpMethod || "rife").toUpperCase() }, plang)}`;
    } else if (lastData.interpWarning) {
      doneLine += `\n${t("msg_interpSkipped", { base: lastData.interpWarning.baseFps, target: lastData.interpWarning.targetFps }, plang)}`;
    }
    // HD (upscale) — name the model + denoise algorithm actually used (video-enhance).
    if (lastData.upscaleModel) {
      doneLine += `\n${t("msg_upscaleUsed", { model: stripModelExt(lastData.upscaleModel) }, plang)}`;
    }
    if (lastData.upscaleDenoise > 0) {
      doneLine += `\n${t("msg_denoiseUsed", { pct: Math.round(lastData.upscaleDenoise * 100) }, plang)}`;
    }
    // LTX LoRA actually mounted. Stated because the picker can hold a choice the
    // server declines to apply (Sulphur's LoRA on the Sulphur checkpoint, which
    // already contains it) — this line is what distinguishes applied from ignored.
    // Phantom turbo. Reported because the request can be declined (1.3B, or no LoRA
    // installed) — and because the run it produces is a materially different one.
    if (lastData.phantomTurbo && lastData.phantomTurbo.lora) {
      doneLine += `\n${t("msg_phantomTurbo", {}, plang)}`;
    }
    // Video codec — stated for every video (the codec affects where the file plays).
    // A h265 request that fell back to h264 (VHS not installed) says so.
    if (lastData.videoCodec === "h265") {
      doneLine += `\n${t("msg_videoH265", {}, plang)}`;
    } else if (lastData.videoCodec === "h264" && lastData.videoCodecNote === "vhs-missing") {
      doneLine += `\n${t("msg_videoH265Fallback", {}, plang)}`;
    }
    if (lastData.ltxLora && lastData.ltxLora.name) {
      doneLine += `\n${t("msg_ltxLoraUsed", { lora: stripModelExt(lastData.ltxLora.name), strength: lastData.ltxLora.strength }, plang)}`;
    }
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
    // Source clip longer than what one pass covers → was truncated. Bernini states it
    // in frames only: its output keeps the SOURCE's fps, which the server leaves unset
    // here, so a seconds figure would silently be computed off the wrong rate.
    if (lastData.truncatedFrom && lastData.length) {
      if (lastData.truncatedNoChain) {
        capNote += t("msg_videoTruncatedNoChain", {
          full: lastData.truncatedFrom, used: lastData.length,
        }, plang) + "\n\n";
      } else {
        const fps = lastData.fps || 16;
        capNote += t("msg_videoTruncated", {
          full: lastData.truncatedFrom, used: lastData.length,
          fullS: (lastData.truncatedFrom / fps).toFixed(1), usedS: (lastData.length / fps).toFixed(1),
        }, plang) + "\n\n";
      }
    }
    // First finished video replaces the placeholder with this result bubble, so the
    // "generating video (N/M)" placeholder (label + bar) is gone — while more are still
    // rendering, append a live "still generating…" line so the user knows it isn't done yet.
    // Drops off automatically on the final render (allVideos.length === count).
    const stillGen = allVideos.length < count
      ? `\n\n${t("msg_batchStillGenerating", { done: allVideos.length, total: count }, plang)}`
      : "";
    const videoContent = (promptWasEnhanced
      ? `**${t("msg_enhancedPrompt")}**\n> ${videoPrompt}\n\n${capNote}${doneLine}`
      : `${capNote}${doneLine}`) + stillGen;
    if (!replyMsg) {
      replyMsg = {
        role: "assistant",
        content: videoContent,
        generatedVideos: allVideos,
        videoMimes: allVideos.map(() => vmime),
        generatedVideoThumbnails: allThumbs,
        imagePrompt: videoPrompt,
        timestamp: Date.now(),
        genMs: Date.now() - genStart,
      };
      sink.place(replyMsg);
    } else {
      replyMsg.content = videoContent;
      replyMsg.videoMimes = allVideos.map(() => vmime);
      replyMsg.genMs = Date.now() - genStart;
      sink.commit();
    }
  };

  // Surface a fatal "nothing generated" error in the bubble and bail.
  const failFatal = (errText) => {
    sink.clearBubble();
    const failMsg = t("img_videoGenFailed", { err: errText || t("img_noVideoReturned") });
    sink.fail(failMsg);
    sink.place({ role: "assistant", content: failMsg, timestamp: Date.now() });
    setAvatarState("idle");
  };

  // Render deadline = the ⚙ "Video timeout (min)" field. EMPTY → default 4 h cap; explicit 0 →
  // UNLIMITED (videoTimeout 0 → the server runs with NO deadline; a long Wan Animate waits it out
  // on the stable box, only a Stop / cancel ends it); a positive value → that many minutes, sent
  // verbatim (no upper cap). estPasses / animBudgetEta above still drive the progress bar + badge.
  const tMin = reqOptions.timeoutMin;
  const videoTimeout = (tMin === undefined) ? 14400 : (tMin > 0 ? Math.round(tMin * 60) : 0); // sec; empty→4h, 0→∞

  // One /api/generate-comfy request. `extra` carries per-segment offset/length for
  // a chunked Wan Animate render; ignored otherwise.
  const requestVideo = (perOptions, extra, isFirstSubRun) => {
    const vbody = {
      model,
      prompt: comfyPositive(videoPrompt),
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
      // InfiniteTalk dubbing speech track — prefer the pre-uploaded filename (tiny);
      // inline base64 only if that upload failed. Ignored by other video models.
      sourceAudioName: sourceAudioName || undefined,
      sourceAudio: (speechAudio && !sourceAudioName) ? speechAudio.base64 : undefined,
      sourceAudioMime: speechAudio?.mime || undefined,
      sourceAudioDuration: sourceAudioDuration || undefined,
      // "Photo speaks": the RAW prompt is the text to READ — sent apart from `prompt`
      // so ⚙ prompt-decoration / --enhance can't leak into the synthesized speech.
      speechText: model === "infinitetalk_speak" ? ((parsed.prompt || "").trim() || undefined) : undefined,
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
    // Only the FIRST sub-run of an "Nx" batch carries the bgJob → it owns the placeholder's
    // serverJobId (status flip + the lane submit-gate). Later sub-runs pass bgJob:null so each
    // POSTs a FRESH server job and gets a DISTINCT clip — otherwise they'd reuse sub-run 0's
    // serverJobId, skip the POST, and re-resolve the SAME video N times.
    return sink.server
      ? comfyFetch(vbody, { bgJob: isFirstSubRun ? sink.server.bgJob : null, kind: "video", comfyUrl: comfyHost, conversationId: sink.server.conversationId, msgId: sink.server.msgId, label: sink.server.label, clientId, signal: abortController.signal })
      : fetch("/api/generate-comfy", { method: "POST", headers: { "Content-Type": "application/json" }, signal: abortController.signal, body: JSON.stringify(vbody) });
  };

  // Wan Animate / SCAIL-2: more chained frames than fit in one pass → generated as
  // segments and merged. Animate's cap shrinks at higher output resolutions (VRAM
  // headroom); SCAIL-2's is fixed. Budget = the selected ⚙/--size area, or the
  // 640×640 default (mirrors the server's sizing). Only used to pick the "seamless
  // long video" label — the SERVER does the actual chunking in-graph.
  const animBudget = (reqOptions.width && reqOptions.height) ? reqOptions.width * reqOptions.height : 640 * 640;
  const willChunk = !!sourceVideoName && chainFrames > segmentCapFor(model, animBudget, !!reqOptions.torchCompile);
  // Total output duration of the long video (chained frames ÷ fps), e.g. 5.4.
  const fullSec = (willChunk && sourceVideoFps > 0) ? Math.round(chainFrames / sourceVideoFps * 10) / 10 : 0;

  try {
    for (let i = 0; i < count; i++) {
      if (abortController.signal.aborted) break;
      // Reset the bar BETWEEN renders only (i>0). On the first render there's no bar yet, and
      // crucially this runs BEFORE comfyFetch assigns serverJobId — so an i=0 reset would slip
      // past markRunning's `if (job.serverJobId) return` gate and falsely flip a still-queued
      // server job to "running 0%". The server's SSE is what flips it to running.
      if (i > 0) sink.progress(0, 1);
      // Vary the seed per video so the N outputs differ (only when the user
      // pinned a --seed; otherwise the server randomizes each call already).
      const perOptions = { ...reqOptions };
      if (perOptions.seed !== undefined) perOptions.seed = reqOptions.seed + i;

      // A long Wan Animate source is chunked SEAMLESSLY by the server in ONE ComfyUI
      // graph (chained continue_motion) → a single request returns one merged clip.
      if (willChunk) sink.label(`${t("msg_generatingVideoSeamless", { n: estPasses, sec: fullSec || "?" })}${vidSuffix}`);
      else if (count > 1) sink.label(`${t("msg_generatingVideo")}${vidSuffix} (${i + 1}/${count})`);
      const resp = await requestVideo(perOptions, undefined, i === 0);
      let data = await resp.json();
      // Nothing to do (e.g. frame-interp off + HD off) → a plain notice in the bubble, NOT a
      // "generation failed" error: the server did no ComfyUI work on purpose.
      if (data.noop) {
        sink.clearBubble();
        sink.place({ role: "assistant", content: data.message || t("img_nothingToDo"), timestamp: Date.now() });
        setAvatarState("idle");
        return;
      }
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
      for (let k = 0; k < data.videos.length; k++) videoSeeds.push(typeof data.seed === "number" ? data.seed : null);
      allThumbs.push(...newThumbs);
      renderReply(); // show this completed video immediately
    }
    sink.clearBubble();
    showExpression("happy");
  } catch (error) {
    sink.clearBubble();
    // Videos finished before a stop/error are already shown via renderReply().
    if (error.name !== "AbortError" && !allVideos.length) {
      const errMsg = t("img_videoGenError", { err: error.message });
      sink.fail(errMsg);
      sink.place({ role: "assistant", content: errMsg, timestamp: Date.now() });
    }
    setAvatarState("idle");
  } finally {
    clearTimeout(_progStall);
    sink.clearBubble();
    sink.done();
    unsubscribe();
    sink.cleanup();
  }
}

// 3D mesh generation (Hunyuan3D / TripoSplat / MoGe) — a slimmed generateVideo:
// no source-video/audio legs, no prompt enhancement (these graphs have no text
// conditioning), result is a .glb/.spz file (+ TripoSplat's turntable preview mp4).
export async function generateMesh(parsed, model, tabId = state.activeTabId, insertIndex = -1, initImages = null, sink = null, comfyUrl = null) {
  const tab = getTab(tabId);
  if (!tab) return;
  const comfyHost = ((comfyUrl || dom.comfyUrlDisplay?.textContent || "").replace(/\s*\(.*\)\s*$/, "").trim()).replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  const genStart = Date.now();
  const refImages = Array.isArray(initImages) && initImages.length ? initImages : null;
  if (!sink) sink = foregroundSink({ tabId, insertIndex, setGenerating: _setGenerating, renderChat: _renderChat, saveChat, getTab });

  const abortController = { signal: sink.signal };
  sink.lock(true);
  setAvatarState("thinking");
  const meshModelLabel = (model || "").replace(/\.(safetensors|ckpt|gguf|pth)$/i, "");
  sink.start("mesh", `${t("msg_generatingMesh")}${meshModelLabel ? ` · ${meshModelLabel}` : ""}`);
  await new Promise((r) => setTimeout(r, 0)); // let the bubble paint first

  // Every mesh chain is image-conditioned — fail fast rather than round-trip a 400.
  if (!refImages) {
    sink.clearBubble();
    sink.fail(t("msg_meshNeedsImage"));
    sink.place({ role: "assistant", content: t("msg_meshNeedsImage"), timestamp: Date.now() });
    setAvatarState("idle");
    sink.done(); sink.cleanup();
    return;
  }

  // ⚙ overrides fill whatever /imagine flags didn't set. Width/height are dropped —
  // the mesh graphs have no pixel-size input (Hunyuan's resolution is a latent knob).
  const reqOptions = { ...parsed.options };
  delete reqOptions.width;
  delete reqOptions.height;
  const ov = comfyOverrides();
  for (const k of Object.keys(ov)) {
    if (reqOptions[k] === undefined) reqOptions[k] = ov[k];
  }
  // Mesh rides the video timeout policy server-side; empty ⚙ field → 1 h default
  // (Hunyuan3D's octree decode can run minutes; MoGe finishes in seconds anyway).
  const tMin = reqOptions.timeoutMin;
  const meshTimeout = (tMin === undefined) ? 3600 : (tMin > 0 ? Math.round(tMin * 60) : 0);

  // Live progress via ComfyUI's WebSocket (Hunyuan's KSampler reports steps; the
  // decode phases report nothing → keep the pulse fallback).
  const clientId = (sink.server && sink.server.comfyClientId)
    || (crypto.randomUUID ? crypto.randomUUID() : `hk-${Date.now()}-${Math.random()}`);
  let _progStall = null;
  sink.indeterminate(true);
  const unsubscribe = subscribeComfyProgress(comfyHost, clientId, {
    onProgress: (value, max) => {
      if (!max) return;
      sink.indeterminate(false);
      sink.progress(value, max);
      clearTimeout(_progStall);
      _progStall = setTimeout(() => sink.indeterminate(true), 2500);
    },
    onPreview: (url) => sink.preview(url),
  });
  abortController.signal.addEventListener("abort", () => interruptComfy(comfyHost), { once: true });

  const count = Math.min(Math.max(parsed.count || 1, 1), 8);
  const allMeshes = [], allMeshMimes = [], allMeshNames = [];
  const allVideos = [], allThumbs = []; // TripoSplat turntable previews
  const meshSeeds = [];
  let lastData = null;
  let replyMsg = null;

  const renderReply = () => {
    if (!allMeshes.length) return;
    const plang = getPromptLanguage();
    const totalBytes = allMeshes.reduce((s, b) => s + Math.floor(b.length * 0.75), 0);
    const sizeStr = totalBytes > 1024 * 1024 ? `${(totalBytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(totalBytes / 1024)} KB`;
    let doneLine = t("msg_meshDone", { size: sizeStr }, plang)
      + (count > 1 ? ` ×${allMeshes.length}${allMeshes.length < count ? `/${count}` : ""}` : "")
      + (meshModelLabel ? ` · ${meshModelLabel}` : "")
      + (lastData.precisionUsed ? ` · ${lastData.precisionUsed}` : "");
    if (count === 1 && typeof lastData.seed === "number") {
      doneLine += `\n${t("msg_seedUsed", { seed: lastData.seed }, plang)}`;
    } else if (count > 1 && meshSeeds.some((s) => s !== null)) {
      const list = meshSeeds.map((s, i) => `#${i + 1} ${s !== null ? s : "?"}`).join(" · ");
      doneLine += `\n${t("msg_seedsBatch", { list }, plang)}`;
    }
    const stillGen = allMeshes.length < count
      ? `\n\n${t("msg_batchStillGenerating", { done: allMeshes.length, total: count }, plang)}`
      : "";
    const content = doneLine + stillGen;
    if (!replyMsg) {
      replyMsg = {
        role: "assistant",
        content,
        generatedMeshes: allMeshes,
        meshMimes: allMeshMimes,
        meshNames: allMeshNames,
        imagePrompt: parsed.prompt || "",
        timestamp: Date.now(),
        genMs: Date.now() - genStart,
      };
      if (allVideos.length) {
        replyMsg.generatedVideos = allVideos;
        replyMsg.videoMimes = allVideos.map(() => (lastData.videoMime || "video/mp4"));
        replyMsg.generatedVideoThumbnails = allThumbs;
      }
      sink.place(replyMsg);
    } else {
      replyMsg.content = content;
      if (allVideos.length) replyMsg.videoMimes = allVideos.map(() => (lastData.videoMime || "video/mp4"));
      replyMsg.genMs = Date.now() - genStart;
      sink.commit();
    }
  };

  const failFatal = (errText) => {
    sink.clearBubble();
    const failMsg = t("img_meshGenFailed", { err: errText || t("img_noMeshReturned") });
    sink.fail(failMsg);
    sink.place({ role: "assistant", content: failMsg, timestamp: Date.now() });
    setAvatarState("idle");
  };

  const requestMesh = (perOptions, isFirstSubRun) => {
    const mbody = {
      model,
      prompt: (parsed.prompt || "").trim(), // decorative — the mesh graphs read no text
      options: perOptions,
      images: refImages,
      timeout: meshTimeout,
      clientId,
      comfyUrl: comfyHost || undefined,
    };
    return sink.server
      ? comfyFetch(mbody, { bgJob: isFirstSubRun ? sink.server.bgJob : null, kind: "mesh", comfyUrl: comfyHost, conversationId: sink.server.conversationId, msgId: sink.server.msgId, label: sink.server.label, clientId, signal: abortController.signal })
      : fetch("/api/generate-comfy", { method: "POST", headers: { "Content-Type": "application/json" }, signal: abortController.signal, body: JSON.stringify(mbody) });
  };

  try {
    for (let i = 0; i < count; i++) {
      if (abortController.signal.aborted) break;
      if (i > 0) sink.progress(0, 1);
      const perOptions = { ...reqOptions };
      if (perOptions.seed !== undefined) perOptions.seed = reqOptions.seed + i;
      if (count > 1) sink.label(`${t("msg_generatingMesh")}${meshModelLabel ? ` · ${meshModelLabel}` : ""} (${i + 1}/${count})`);
      const resp = await requestMesh(perOptions, i === 0);
      const data = await resp.json();
      if (!resp.ok || !data.meshes || !data.meshes.length) {
        if (!allMeshes.length) { failFatal(data.error || data.detail); return; }
        break;
      }
      lastData = data;
      allMeshes.push(...data.meshes);
      allMeshMimes.push(...(data.meshMimes || data.meshes.map(() => "model/gltf-binary")));
      allMeshNames.push(...(data.meshNames || data.meshes.map(() => "")));
      for (let k = 0; k < data.meshes.length; k++) meshSeeds.push(typeof data.seed === "number" ? data.seed : null);
      if (Array.isArray(data.videos) && data.videos.length) {
        const vmime = data.videoMime || "video/mp4";
        const newThumbs = await Promise.all(data.videos.map((v) => videoThumbnail(`data:${vmime};base64,${v}`)));
        allVideos.push(...data.videos);
        allThumbs.push(...newThumbs);
      }
      renderReply();
    }
    sink.clearBubble();
    showExpression("happy");
  } catch (error) {
    sink.clearBubble();
    if (error.name !== "AbortError" && !allMeshes.length) {
      const errMsg = t("img_meshGenError", { err: error.message });
      sink.fail(errMsg);
      sink.place({ role: "assistant", content: errMsg, timestamp: Date.now() });
    }
    setAvatarState("idle");
  } finally {
    clearTimeout(_progStall);
    sink.clearBubble();
    sink.done();
    unsubscribe();
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
  // video path. SCAIL-2 is excluded: it has no still path (the driving video IS the
  // input), so it must stay on the video path and report the missing-video error.
  const isAnimateStill = isWanAnimateModel(comfyModel) && !initVideo && Array.isArray(refImages) && refImages.length >= 2;

  // A selected ComfyUI 3D model routes to the mesh path (checked before the video
  // path — mesh models are in neither set, but the order documents the intent).
  if (!imageModel && comfyModel && state.comfyMeshModels && state.comfyMeshModels.has(comfyModel)) {
    return generateMesh(parsedList[0], comfyModel, tabId, insertIndex, refImages, sink, ovComfyUrl);
  }

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
    sink.fail(t("msg_noImageModel"));
    sink.place({ role: "assistant", content: t("msg_noImageModel"), timestamp: Date.now() });
    sink.cleanup();
    return;
  }

  const totalCount = parsedList.reduce((sum, p) => sum + p.count, 0);

  // The sink owns the real AbortController; this shim keeps existing .signal refs working.
  const abortController = { signal: sink.signal };
  sink.lock(true);

  // Prompt enhancement is done at ENQUEUE time (client-side, foreground — see
  // enqueueImagineGen). parsed.enhancedPrompt holds the rewrite (raw parsed.prompt is
  // kept untouched for the record / resend); send the enhanced text when present.
  const prompts = parsedList.map((p) => p.enhancedPrompt || p.prompt);

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
    // Reuse a background job's stable clientId so a post-reload reconnect resumes
    // live progress on the SAME running prompt (else the bar snaps to 0%).
    comfyClientId = (sink.server && sink.server.comfyClientId)
      || (crypto.randomUUID ? crypto.randomUUID() : `hk-${Date.now()}-${Math.random()}`);
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

  // Declared OUTSIDE the try so the catch block can read them (partial-success +
  // later error → the catch still shows the images/prompts produced so far).
  const generatedImages = [];
  let errorCount = 0;
  let lastError = "";
  let noopMessage = null; // server did nothing on purpose (e.g. upscale=Off) → plain notice, not an error
  let upscaleModelUsed = null, upscaleDenoiseUsed = 0; // HD upscale algorithm used → shown in the done line
  let precisionUsedTier = null; // precision tier actually loaded → always named in the done line
  let precisionNoteUsed = null; // ⚙ precision fallback/mix, when the request could not be honoured
  // Seed actually used (random unless --seed was pinned) → surfaced on the done line
  // so a single result can be reproduced. Only meaningful for a single output.
  let usedSeed = null;
  // Per-image seeds for a batch (aligned with generatedImages → grid order), so any
  // one image can be reproduced via --seed.
  const seeds = [];
  // Enhanced prompt(s) to show in the done message (set at enqueue time, client-side).
  const enhancedPromptsShown = [...new Set(parsedList.map((p) => p.enhancedPrompt).filter(Boolean))];

  try {
    const promises = [];
    for (let ci = 0; ci < parsedList.length; ci++) {
      const parsed = parsedList[ci];
      const prompt = prompts[ci];
      for (let i = 0; i < parsed.count; i++) {
        const reqOptions = { ...parsed.options };
        // Image upscale always outputs the model's native ~4×. Drop the default image
        // size (parseImagineCommand fills width/height from the "default size" setting) so it
        // doesn't downscale the result — only an explicit --size still resizes.
        if (comfyModel === "image-upscale" && !parsed.sizeExplicit) {
          delete reqOptions.width;
          delete reqOptions.height;
        }
        if (parsed.count > 1) {
          // Batch: every image needs a DISTINCT seed, else the grid is N identical
          // copies. No --seed → a fresh random per image. Pinned --seed N → N, N+1,
          // N+2… (predictable & each reproducible). Per-image seeds are shown below.
          reqOptions.seed = (reqOptions.seed === undefined)
            ? Math.floor(Math.random() * 2147483647)
            : reqOptions.seed + i;
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
        const baseTimeout = parseInt(dom.requestTimeoutInput.value, 10) || 120;
        const reqTimeout = refImages ? Math.max(baseTimeout, 300) : baseTimeout;

        const reqBody = {
          model: activeModel,
          prompt: comfyPositive(prompt),
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
              if (r.ok && data.noop) {
                // Nothing to do (e.g. image upscale with upscale-model=Off) — surface the
                // server's notice as a plain message, not a "generation failed".
                noopMessage = data.message || t("img_nothingToDo");
              } else if (r.ok) {
                const imgs = (data.images || []).filter((s) => s && s.length > 100);
                if (data.upscaleModel) { upscaleModelUsed = data.upscaleModel; upscaleDenoiseUsed = data.upscaleDenoise || 0; }
                if (data.precisionUsed) precisionUsedTier = data.precisionUsed;
                if (data.precisionNote) precisionNoteUsed = data.precisionNote;
                if (totalCount === 1 && imgs.length && typeof data.seed === "number") usedSeed = data.seed;
                generatedImages.push(...imgs);
                for (let k = 0; k < imgs.length; k++) seeds.push(typeof data.seed === "number" ? data.seed : null);
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
    if (enhancedPromptsShown.length > 0) {
      content += `**${t("msg_enhancedPrompt")}**\n${enhancedPromptsShown.map((p) => `> ${p}`).join("\n")}\n\n`;
    }
    if (errorCount > 0 && generatedImages.length > 0) {
      content += `⚠️ ${t("img_imagesFailedCount", { n: errorCount })}\n\n`;
    } else if (errorCount > 0 && generatedImages.length === 0) {
      content = lastError
        ? t("img_imageGenFailed", { err: lastError })
        : t("img_imageGenFailedCheckModel");
      sink.fail(content);   // total failure — keep the job listed with the reason
    } else if (noopMessage && generatedImages.length === 0) {
      content = noopMessage; // server intentionally did nothing → plain notice
    }

    const toSrc = (img) => (img.startsWith("data:") ? img : `data:${img.startsWith("/9j/") ? "image/jpeg" : "image/png"};base64,${img}`);
    const generatedThumbnails = await Promise.all(generatedImages.map((img) => makePreview(toSrc(img), 480)));

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
      // Append the model used (selected name, extension stripped) + the precision tier
      // that actually loaded. See the video done-line for why the tier is always named.
      if (shortModel) doneLine += ` · ${shortModel}`;
      if (precisionUsedTier) doneLine += ` · ${precisionUsedTier}`;
      // Seed used (single output only) → lets the user reproduce via --seed.
      if (usedSeed !== null) doneLine += `\n${t("msg_seedUsed", { seed: usedSeed }, plang)}`;
      // Batch: list each image's seed (grid order) so any one can be reproduced.
      else if (totalCount > 1 && seeds.some((s) => s !== null)) {
        const list = seeds.map((s, i) => `#${i + 1} ${s !== null ? s : "?"}`).join(" · ");
        doneLine += `\n${t("msg_seedsBatch", { list }, plang)}`;
      }
      // ⚙ precision: the tier is on the line above; this explains why it isn't the one asked for.
      if (precisionNoteUsed) {
        const key = precisionNoteUsed.includes("+") ? "msg_precisionMixed" : "msg_precisionFallback";
        doneLine += `\n${t(key, {}, plang)}`;
      }
      // HD upscale (image-upscale) — name the model + denoise algorithm actually used.
      if (upscaleModelUsed) doneLine += `\n${t("msg_upscaleUsed", { model: stripModelExt(upscaleModelUsed) }, plang)}`;
      if (upscaleDenoiseUsed > 0) doneLine += `\n${t("msg_denoiseUsed", { pct: Math.round(upscaleDenoiseUsed * 100) }, plang)}`;
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
    showExpression("happy");
  } catch (error) {
    sink.clearBubble();
    if (error.name === "AbortError") {
      // clearBubble already removed the bubble (live or restored).
    } else if (generatedImages.length > 0) {
      // Preserve already-generated images even when an error occurs
      let content = `⚠️ ${t("img_imageGenError", { err: error.message })}\n\n`;
      if (enhancedPromptsShown.length > 0) {
        content = `**${t("msg_enhancedPrompt")}**\n${enhancedPromptsShown.map((p) => `> ${p}`).join("\n")}\n\n` + content;
      }
      const generatedThumbnails = await Promise.all(
        generatedImages.map((img) => {
          if (img.startsWith("data:")) return makePreview(img, 480);
          const mime = img.startsWith("/9j/") ? "image/jpeg" : "image/png";
          return makePreview(`data:${mime};base64,${img}`, 480);
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
      const imgErrMsg = t("img_imageGenError", { err: error.message });
      sink.fail(imgErrMsg);
      sink.place({ role: "assistant", content: imgErrMsg, timestamp: Date.now() });
    }
    setAvatarState("idle");
  } finally {
    sink.clearBubble();
    sink.done();
    imgUnsub();
    sink.cleanup();
  }
}