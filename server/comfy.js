const crypto = require("crypto");
const config = require("./config");
const { sendJson, readBody } = require("./utils");

// Read a model-name enum out of a ComfyUI node's input schema (e.g. the list of
// checkpoints, diffusion models, text encoders or VAEs the server has on disk).
async function comfyEnum(node, input) {
  try {
    const r = await fetch(`${config.comfyUrl}/object_info/${node}`);
    if (!r.ok) return [];
    const data = await r.json();
    const spec = data?.[node]?.input?.required?.[input] || data?.[node]?.input?.optional?.[input];
    return Array.isArray(spec) && Array.isArray(spec[0]) ? spec[0] : [];
  } catch {
    return [];
  }
}

// Instruction-edit models live in diffusion_models/ (loaded via UNETLoader, not
// CheckpointLoaderSimple) and each needs its own workflow + companion files.
function editTypeOf(model) {
  if (!model) return null;
  if (/kontext/i.test(model)) return "kontext";
  if (/qwen.*edit|qwen[-_]?image[-_]?edit/i.test(model)) return "qwen";
  if (/omnigen/i.test(model)) return "omnigen";
  if (/pix2pix|instruct.?pix|ip2p/i.test(model)) return "ip2p";
  if (/hidream.?e1/i.test(model)) return "hidream-e1";
  return null;
}

// Edit models that load as a full checkpoint (CLIP+VAE bundled) rather than a
// bare diffusion model needing separate text-encoder/VAE companions.
function editIsCheckpoint(editType) {
  return editType === "ip2p";
}

// Video models (text→video / image→video). Detected by filename.
function videoTypeOf(model) {
  if (!model) return null;
  if (/wan/i.test(model)) return "wan";
  if (/ltx/i.test(model)) return "ltx";
  if (/hunyuan.?video/i.test(model)) return "hunyuan";
  return null;
}

// List both classic checkpoints (txt2img / classic img2img) and the
// instruction-edit models found in diffusion_models/.
async function proxyComfyModels(res) {
  try {
    const [ckpts, unets] = await Promise.all([
      comfyEnum("CheckpointLoaderSimple", "ckpt_name"),
      comfyEnum("UNETLoader", "unet_name"),
    ]);
    // Edit/video models can be either diffusion models (UNETLoader) or full
    // checkpoints (instruct-pix2pix, ltx). Plain checkpoints stay in `models`.
    const all = [...ckpts, ...unets];
    const editModels = all.filter((n) => editTypeOf(n)).map((n) => ({ name: n, type: editTypeOf(n) }));
    // WAN 2.2 14B ships as a high+low expert PAIR used together in one render —
    // show only the high_noise twin (what we send; the server derives the low one)
    // and label it without the "_high_noise" noise. Everything else is 1:1.
    const videoModels = all
      .filter((n) => videoTypeOf(n) && !(/14b/i.test(n) && /low_noise/i.test(n)))
      .map((n) => {
        const m = { name: n, type: videoTypeOf(n) };
        if (/14b/i.test(n) && /high_noise/i.test(n)) {
          m.label = n.replace(/_?high_noise/i, "").replace(/\.(safetensors|ckpt|gguf|pth)$/i, "");
        }
        return m;
      });
    // txt2img list: plain checkpoints (excluding edit/video/HiDream) + HiDream-I1
    // (a diffusion model loaded specially with QuadrupleCLIPLoader). HiDream E1/O1
    // are not wired yet, so they're left out to avoid broken options.
    const plainCkpts = ckpts.filter((n) => !editTypeOf(n) && !videoTypeOf(n) && !/hidream/i.test(n));
    const hidreamImage = all.filter((n) => /hidream.?i1/i.test(n));
    // Z-Image-Turbo lives in diffusion_models/ (UNETLoader) — add it to txt2img.
    const zimage = all.filter((n) => /z.?image/i.test(n));
    sendJson(res, 200, { models: [...plainCkpts, ...hidreamImage, ...zimage], editModels, videoModels });
  } catch {
    sendJson(res, 200, { models: [], editModels: [], videoModels: [] });
  }
}

// Pick the companion files (text encoders + VAE) an edit model needs from what
// ComfyUI actually has on disk. Throws a user-actionable error naming any
// missing file so the UI can tell the user what to download.
async function editCompanions(editType) {
  const [clips, vaes] = await Promise.all([
    comfyEnum("CLIPLoader", "clip_name"),
    comfyEnum("VAELoader", "vae_name"),
  ]);
  const find = (list, re) => list.find((x) => re.test(x));
  const aeVae = () => find(vaes, /^ae\b|ae\.safetensors/i) || find(vaes, /flux/i);

  if (editType === "kontext") {
    const t5 = find(clips, /t5xxl/i);
    const clipL = find(clips, /clip_l/i);
    const vae = aeVae();
    const missing = [];
    if (!t5) missing.push("t5xxl_fp16.safetensors 或 t5xxl_fp8_e4m3fn.safetensors → ComfyUI/models/text_encoders/");
    if (!clipL) missing.push("clip_l.safetensors → text_encoders/");
    if (!vae) missing.push("ae.safetensors → vae/");
    if (missing.length) throw new Error("缺少 Kontext 所需文件：\n- " + missing.join("\n- "));
    return { t5, clipL, vae };
  }
  if (editType === "qwen") {
    // Qwen-Image-Edit wants the 7B Qwen2.5-VL encoder (prefer it if present).
    const clip = clips.find((x) => /qwen.*vl/i.test(x) && /7b/i.test(x)) || find(clips, /qwen.*vl/i);
    const vae = find(vaes, /qwen.*image.*vae|qwen[-_]?image|qwen.*vae/i);
    const missing = [];
    if (!clip) missing.push("qwen_2.5_vl_7b_fp8_scaled.safetensors → text_encoders/");
    if (!vae) missing.push("qwen_image_vae.safetensors → vae/");
    if (missing.length) throw new Error("缺少 Qwen-Image-Edit 所需文件：\n- " + missing.join("\n- "));
    return { clip, vae };
  }
  if (editType === "omnigen") {
    // OmniGen2 wants the smaller (3B) Qwen2.5-VL encoder — AVOID the 7B one.
    const clip = clips.find((x) => /qwen.*vl/i.test(x) && !/7b/i.test(x)) || find(clips, /omnigen|qwen.*vl/i);
    const vae = aeVae();
    const missing = [];
    if (!clip) missing.push("OmniGen2 文本编码器（qwen_2.5_vl）→ text_encoders/");
    if (!vae) missing.push("ae.safetensors → vae/");
    if (missing.length) throw new Error("缺少 OmniGen2 所需文件：\n- " + missing.join("\n- "));
    return { clip, vae };
  }
  return {};
}

// Optimized sampling defaults per model family. Detection is by checkpoint
// filename. Each preset is what produces good results for that family out of
// the box; the client can override any field via the advanced-params modal.
//   - Flux: guidance-distilled — real CFG (7) blurs it, so cfg=1 + a
//     FluxGuidance node, "simple" scheduler, and a 16-channel SD3 latent.
//   - SD3: low CFG, sgm_uniform scheduler, SD3 latent.
//   - SDXL / Pony / Illustrious / NoobAI: dpmpp_2m + karras, cfg ~7, more steps.
//   - SD1.5 / unknown: dpmpp_2m + karras, cfg 7.
function familyPreset(model) {
  // Instruction-edit models (checked before the generic /flux/ branch, since
  // "flux1-dev-kontext" contains "flux" but needs Kontext settings).
  if (/kontext/i.test(model)) {
    return { sampler: "euler", scheduler: "simple", cfg: 1, guidance: 2.5, steps: 20, sd3Latent: false };
  }
  if (/qwen.*edit|qwen[-_]?image[-_]?edit/i.test(model)) {
    return { sampler: "euler", scheduler: "simple", cfg: 2.5, guidance: null, steps: 20, sd3Latent: false };
  }
  if (/omnigen/i.test(model)) {
    return { sampler: "euler", scheduler: "normal", cfg: 4, guidance: null, steps: 20, sd3Latent: false };
  }
  if (/pix2pix|instruct.?pix|ip2p/i.test(model)) {
    // InstructPix2Pix needs DUAL guidance: cfg = text guidance (how much to
    // follow the instruction), imageCfg = image guidance (how faithful to the
    // input — higher preserves more). More steps helps on real photos.
    return { sampler: "euler", scheduler: "normal", cfg: 7.5, imageCfg: 1.5, guidance: null, steps: 30, sd3Latent: false };
  }
  if (/hidream/i.test(model)) {
    return { sampler: "euler", scheduler: "normal", cfg: 5, guidance: null, steps: 30, sd3Latent: true };
  }
  if (/z.?image/i.test(model)) {
    // Z-Image-Turbo: distilled few-step model — cfg=1 with the negative zeroed,
    // ~8 steps, res_multistep/simple (per the official ComfyUI template).
    return { sampler: "res_multistep", scheduler: "simple", cfg: 1, guidance: null, steps: 8, sd3Latent: true };
  }
  if (/flux/i.test(model)) {
    return { sampler: "euler", scheduler: "simple", cfg: 1, guidance: 3.5, steps: 20, sd3Latent: true };
  }
  if (/sd3|stable[-_ ]?diffusion[-_ ]?3/i.test(model)) {
    return { sampler: "euler", scheduler: "sgm_uniform", cfg: 4.5, guidance: null, steps: 28, sd3Latent: true };
  }
  if (/sd[-_ ]?xl|sdxl|\bxl\b|pony|illustrious|noob/i.test(model)) {
    return { sampler: "dpmpp_2m", scheduler: "karras", cfg: 7, guidance: null, steps: 30, sd3Latent: false };
  }
  return { sampler: "dpmpp_2m", scheduler: "karras", cfg: 7, guidance: null, steps: 25, sd3Latent: false };
}

// Resolve the final sampling settings: family preset, with any client override
// (from the advanced-params modal) taking precedence. Guidance only applies to
// the Flux family (it drives a FluxGuidance node); other families ignore it.
function resolveConfig(model, opts) {
  const p = familyPreset(model);
  const isFlux = p.guidance != null;
  return {
    sampler: opts.sampler || p.sampler,
    scheduler: opts.scheduler || p.scheduler,
    cfg: opts.cfg != null ? opts.cfg : p.cfg,
    steps: opts.steps || p.steps,
    guidance: isFlux ? (opts.guidance != null ? opts.guidance : p.guidance) : null,
    imageCfg: opts.imageCfg != null ? opts.imageCfg : p.imageCfg,
    sd3Latent: p.sd3Latent,
  };
}

// Shared tail of every graph: checkpoint, prompts, decode, save. When `guidance`
// is set (Flux), the positive conditioning is routed through a FluxGuidance node.
function commonNodes({ model, prompt, negative, guidance }) {
  const nodes = {
    "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: model } },
    "6": { class_type: "CLIPTextEncode", inputs: { text: prompt, clip: ["4", 1] } },
    "7": { class_type: "CLIPTextEncode", inputs: { text: negative, clip: ["4", 1] } },
    "8": { class_type: "VAEDecode", inputs: { samples: ["3", 0], vae: ["4", 2] } },
    "9": { class_type: "SaveImage", inputs: { filename_prefix: "heykoko", images: ["8", 0] } },
  };
  if (guidance != null) {
    nodes["12"] = { class_type: "FluxGuidance", inputs: { conditioning: ["6", 0], guidance } };
  }
  return nodes;
}

function ksampler({ seed, steps, cfg, sampler, scheduler, denoise, latentRef, guidance }) {
  return {
    class_type: "KSampler",
    inputs: {
      seed,
      steps,
      cfg,
      sampler_name: sampler,
      scheduler,
      denoise,
      model: ["4", 0],
      positive: guidance != null ? ["12", 0] : ["6", 0],
      negative: ["7", 0],
      latent_image: latentRef,
    },
  };
}

// HiDream-I1 (txt2img). Loads via UNETLoader + QuadrupleCLIPLoader (4 encoders:
// clip_l + clip_g + t5xxl + llama) + flux ae VAE; CLIPTextEncodeHiDream takes the
// prompt in all four encoder slots. ModelSamplingSD3 shift ~3.
async function hidreamCompanions() {
  const [clips, vaes] = await Promise.all([
    comfyEnum("CLIPLoader", "clip_name"),
    comfyEnum("VAELoader", "vae_name"),
  ]);
  const find = (list, re) => list.find((x) => re.test(x));
  const clipL = find(clips, /clip_l_hidream/i) || find(clips, /clip_l/i);
  const clipG = find(clips, /clip_g_hidream/i) || find(clips, /clip_g/i);
  const t5 = find(clips, /t5xxl/i);
  const llama = find(clips, /llama.?3.*instruct|llama_3/i);
  const vae = find(vaes, /^ae\b|ae\.safetensors/i) || find(vaes, /flux/i);
  const missing = [];
  if (!clipL) missing.push("clip_l_hidream.safetensors → text_encoders/");
  if (!clipG) missing.push("clip_g_hidream.safetensors → text_encoders/");
  if (!t5) missing.push("t5xxl_fp8_e4m3fn.safetensors → text_encoders/");
  if (!llama) missing.push("llama_3.1_8b_instruct_fp8_scaled.safetensors → text_encoders/");
  if (!vae) missing.push("ae.safetensors → vae/");
  if (missing.length) throw new Error("缺少 HiDream 所需文件：\n- " + missing.join("\n- "));
  return { clipL, clipG, t5, llama, vae };
}

function buildHiDreamImage({ model, prompt, negative, width, height, seed, cfg, comp }) {
  const enc = (text) => ({ class_type: "CLIPTextEncodeHiDream", inputs: { clip: ["2", 0], clip_l: text, clip_g: text, t5xxl: text, llama: text } });
  return {
    "1": { class_type: "UNETLoader", inputs: { unet_name: model, weight_dtype: "default" } },
    "2": { class_type: "QuadrupleCLIPLoader", inputs: { clip_name1: comp.clipL, clip_name2: comp.clipG, clip_name3: comp.t5, clip_name4: comp.llama } },
    "3": { class_type: "VAELoader", inputs: { vae_name: comp.vae } },
    "4": enc(prompt),
    "5": enc(negative || ""),
    "6": { class_type: "EmptySD3LatentImage", inputs: { width, height, batch_size: 1 } },
    "7": { class_type: "ModelSamplingSD3", inputs: { model: ["1", 0], shift: 3.0 } },
    "8": { class_type: "KSampler", inputs: { seed, steps: cfg.steps, cfg: cfg.cfg, sampler_name: cfg.sampler, scheduler: cfg.scheduler, denoise: 1, model: ["7", 0], positive: ["4", 0], negative: ["5", 0], latent_image: ["6", 0] } },
    "9": { class_type: "VAEDecode", inputs: { samples: ["8", 0], vae: ["3", 0] } },
    "10": { class_type: "SaveImage", inputs: { filename_prefix: "heykoko", images: ["9", 0] } },
  };
}

// Z-Image-Turbo companions: the Qwen3-4B text encoder (loaded via CLIPLoader
// with type "lumina2") + the flux "ae" VAE.
async function zimageCompanions() {
  const [clips, vaes] = await Promise.all([
    comfyEnum("CLIPLoader", "clip_name"),
    comfyEnum("VAELoader", "vae_name"),
  ]);
  const find = (list, re) => list.find((x) => re.test(x));
  const clip = find(clips, /qwen_?3/i);
  const vae = find(vaes, /^ae\b|ae\.safetensors/i) || find(vaes, /flux/i);
  const missing = [];
  if (!clip) missing.push("qwen_3_4b.safetensors → text_encoders/");
  if (!vae) missing.push("ae.safetensors → vae/");
  if (missing.length) throw new Error("缺少 Z-Image 所需文件：\n- " + missing.join("\n- "));
  return { clip, vae };
}

// Z-Image-Turbo (txt2img). Distilled few-step model: UNETLoader + CLIPLoader
// (qwen_3_4b, type "lumina2") + flux ae VAE. The negative is a ConditioningZeroOut
// of the positive (cfg=1, so no real negative), the latent is 16-channel SD3, and
// ModelSamplingAuraFlow applies shift 3 — matching the official ComfyUI template.
function buildZImage({ model, prompt, width, height, seed, cfg, comp }) {
  return {
    "1": { class_type: "UNETLoader", inputs: { unet_name: model, weight_dtype: "default" } },
    "2": { class_type: "CLIPLoader", inputs: { clip_name: comp.clip, type: "lumina2", device: "default" } },
    "3": { class_type: "VAELoader", inputs: { vae_name: comp.vae } },
    "4": { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: prompt } },
    "5": { class_type: "ConditioningZeroOut", inputs: { conditioning: ["4", 0] } },
    "6": { class_type: "EmptySD3LatentImage", inputs: { width, height, batch_size: 1 } },
    "7": { class_type: "ModelSamplingAuraFlow", inputs: { model: ["1", 0], shift: 3.0 } },
    "8": { class_type: "KSampler", inputs: { seed, steps: cfg.steps, cfg: cfg.cfg, sampler_name: cfg.sampler, scheduler: cfg.scheduler, denoise: 1, model: ["7", 0], positive: ["4", 0], negative: ["5", 0], latent_image: ["6", 0] } },
    "9": { class_type: "VAEDecode", inputs: { samples: ["8", 0], vae: ["3", 0] } },
    "10": { class_type: "SaveImage", inputs: { filename_prefix: "heykoko", images: ["9", 0] } },
  };
}

// HiDream-E1.1 instruction editing. Same loaders as I1, but the source image is
// VAE-encoded as the latent and partially denoised (~0.85) so the subject is
// preserved while the instruction is applied. E1 expects the prompt phrased as
// "Editing Instruction: …" — we prepend that if the user didn't.
function buildHiDreamEdit({ model, prompt, negative, imageName, seed, cfg, comp, denoise, width, height }) {
  const instr = /^\s*editing instruction:/i.test(prompt) ? prompt : `Editing Instruction: ${prompt}`;
  const enc = (text) => ({ class_type: "CLIPTextEncodeHiDream", inputs: { clip: ["2", 0], clip_l: text, clip_g: text, t5xxl: text, llama: text } });
  // A target size resizes the source before VAEEncode so the output matches it.
  const px = (width && height) ? ["16", 0] : ["14", 0];
  const wf = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: model, weight_dtype: "default" } },
    "2": { class_type: "QuadrupleCLIPLoader", inputs: { clip_name1: comp.clipL, clip_name2: comp.clipG, clip_name3: comp.t5, clip_name4: comp.llama } },
    "3": { class_type: "VAELoader", inputs: { vae_name: comp.vae } },
    "14": { class_type: "LoadImage", inputs: { image: imageName } },
    "15": { class_type: "VAEEncode", inputs: { pixels: px, vae: ["3", 0] } },
    "4": enc(instr),
    "5": enc(negative || ""),
    "7": { class_type: "ModelSamplingSD3", inputs: { model: ["1", 0], shift: 3.0 } },
    "8": { class_type: "KSampler", inputs: { seed, steps: cfg.steps, cfg: cfg.cfg, sampler_name: cfg.sampler, scheduler: cfg.scheduler, denoise: denoise != null ? denoise : 0.85, model: ["7", 0], positive: ["4", 0], negative: ["5", 0], latent_image: ["15", 0] } },
    "9": { class_type: "VAEDecode", inputs: { samples: ["8", 0], vae: ["3", 0] } },
    "10": { class_type: "SaveImage", inputs: { filename_prefix: "heykoko", images: ["9", 0] } },
  };
  if (width && height) wf["16"] = scaleNode(["14", 0], width, height);
  return wf;
}

// txt2img: an empty latent of the requested size feeds the sampler.
function buildTxt2Img({ model, prompt, negative, width, height, seed, cfg }) {
  return {
    ...commonNodes({ model, prompt, negative, guidance: cfg.guidance }),
    "3": ksampler({ seed, steps: cfg.steps, cfg: cfg.cfg, sampler: cfg.sampler, scheduler: cfg.scheduler, denoise: 1, latentRef: ["5", 0], guidance: cfg.guidance }),
    "5": {
      class_type: cfg.sd3Latent ? "EmptySD3LatentImage" : "EmptyLatentImage",
      inputs: { width, height, batch_size: 1 },
    },
  };
}

// img2img: the uploaded image is VAE-encoded into a latent, then partially
// denoised (denoise < 1) so the prompt edits it instead of replacing it. The
// output size is inherited from the input image.
function buildImg2Img({ model, prompt, negative, seed, denoise, imageName, cfg, width, height }) {
  const px = (width && height) ? ["12", 0] : ["11", 0];
  const wf = {
    ...commonNodes({ model, prompt, negative, guidance: cfg.guidance }),
    "3": ksampler({ seed, steps: cfg.steps, cfg: cfg.cfg, sampler: cfg.sampler, scheduler: cfg.scheduler, denoise, latentRef: ["10", 0], guidance: cfg.guidance }),
    "10": { class_type: "VAEEncode", inputs: { pixels: px, vae: ["4", 2] } },
    "11": { class_type: "LoadImage", inputs: { image: imageName } },
  };
  if (width && height) wf["12"] = scaleNode(["11", 0], width, height);
  return wf;
}

// ── Instruction-edit workflows ──────────────────────────────────────────────
// These take a natural-language instruction + a reference image and edit it,
// preserving identity/composition far better than classic denoise img2img.

// FLUX.1 Kontext — official ComfyUI graph: the input image is scaled to a
// Kontext-friendly size, VAE-encoded, and injected into the positive
// conditioning via ReferenceLatent. cfg=1 + FluxGuidance, like base Flux.
function buildKontext({ model, prompt, imageName, seed, cfg, comp, width, height }) {
  return {
    "1": { class_type: "UNETLoader", inputs: { unet_name: model, weight_dtype: "default" } },
    "2": { class_type: "DualCLIPLoader", inputs: { clip_name1: comp.t5, clip_name2: comp.clipL, type: "flux" } },
    "3": { class_type: "VAELoader", inputs: { vae_name: comp.vae } },
    "4": { class_type: "LoadImage", inputs: { image: imageName } },
    // A target size overrides Kontext's auto-resolution scaler so the output
    // matches the requested size; otherwise use the Kontext-friendly scaler.
    "5": (width && height) ? scaleNode(["4", 0], width, height) : { class_type: "FluxKontextImageScale", inputs: { image: ["4", 0] } },
    "6": { class_type: "VAEEncode", inputs: { pixels: ["5", 0], vae: ["3", 0] } },
    "7": { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: prompt } },
    "8": { class_type: "FluxGuidance", inputs: { conditioning: ["7", 0], guidance: cfg.guidance != null ? cfg.guidance : 2.5 } },
    "9": { class_type: "ReferenceLatent", inputs: { conditioning: ["8", 0], latent: ["6", 0] } },
    "10": { class_type: "ConditioningZeroOut", inputs: { conditioning: ["7", 0] } },
    "11": { class_type: "KSampler", inputs: { seed, steps: cfg.steps, cfg: cfg.cfg, sampler_name: cfg.sampler, scheduler: cfg.scheduler, denoise: 1, model: ["1", 0], positive: ["9", 0], negative: ["10", 0], latent_image: ["6", 0] } },
    "12": { class_type: "VAEDecode", inputs: { samples: ["11", 0], vae: ["3", 0] } },
    "13": { class_type: "SaveImage", inputs: { filename_prefix: "heykoko", images: ["12", 0] } },
  };
}

// Qwen-Image-Edit — TextEncodeQwenImageEdit folds the reference image + prompt
// into the conditioning (multimodal Qwen2.5-VL encoder). Negative is the same
// node with an empty prompt.
function buildQwenEdit({ model, prompt, imageName, seed, cfg, comp, width, height }) {
  // A target size resizes the canvas (VAEEncode) only; conditioning still sees
  // the original image so the edit semantics are unchanged.
  const px = (width && height) ? ["11", 0] : ["4", 0];
  const wf = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: model, weight_dtype: "default" } },
    "2": { class_type: "CLIPLoader", inputs: { clip_name: comp.clip, type: "qwen_image" } },
    "3": { class_type: "VAELoader", inputs: { vae_name: comp.vae } },
    "4": { class_type: "LoadImage", inputs: { image: imageName } },
    "5": { class_type: "TextEncodeQwenImageEdit", inputs: { clip: ["2", 0], prompt, vae: ["3", 0], image: ["4", 0] } },
    "6": { class_type: "TextEncodeQwenImageEdit", inputs: { clip: ["2", 0], prompt: "", vae: ["3", 0], image: ["4", 0] } },
    "7": { class_type: "VAEEncode", inputs: { pixels: px, vae: ["3", 0] } },
    "8": { class_type: "KSampler", inputs: { seed, steps: cfg.steps, cfg: cfg.cfg, sampler_name: cfg.sampler, scheduler: cfg.scheduler, denoise: 1, model: ["1", 0], positive: ["5", 0], negative: ["6", 0], latent_image: ["7", 0] } },
    "9": { class_type: "VAEDecode", inputs: { samples: ["8", 0], vae: ["3", 0] } },
    "10": { class_type: "SaveImage", inputs: { filename_prefix: "heykoko", images: ["9", 0] } },
  };
  if (width && height) wf["11"] = scaleNode(["4", 0], width, height);
  return wf;
}

// Qwen-Image-Edit-2509 "Plus" — MULTI-image composition (up to 3 reference
// images). TextEncodeQwenImageEditPlus folds prompt + image1/2/3 into the
// conditioning; the canvas is a FRESH EmptySD3LatentImage (NOT a VAEEncode of
// one image — that would bias to it and drop the others). Width/height set the
// output size of the composite.
function buildQwenEditPlus({ model, prompt, imageNames, seed, cfg, comp, width, height }) {
  const loads = {};
  imageNames.slice(0, 3).forEach((nm, i) => {
    loads[String(11 + i)] = { class_type: "LoadImage", inputs: { image: nm } };
  });
  const encInputs = (text) => {
    const inputs = { clip: ["2", 0], prompt: text, vae: ["3", 0] };
    imageNames.slice(0, 3).forEach((nm, i) => { inputs["image" + (i + 1)] = [String(11 + i), 0]; });
    return { class_type: "TextEncodeQwenImageEditPlus", inputs };
  };
  return {
    "1": { class_type: "UNETLoader", inputs: { unet_name: model, weight_dtype: "default" } },
    "2": { class_type: "CLIPLoader", inputs: { clip_name: comp.clip, type: "qwen_image" } },
    "3": { class_type: "VAELoader", inputs: { vae_name: comp.vae } },
    ...loads,
    "4": encInputs(prompt),
    "5": encInputs(""),
    "6": { class_type: "EmptySD3LatentImage", inputs: { width: width || 1024, height: height || 1024, batch_size: 1 } },
    "8": { class_type: "KSampler", inputs: { seed, steps: cfg.steps, cfg: cfg.cfg, sampler_name: cfg.sampler, scheduler: cfg.scheduler, denoise: 1, model: ["1", 0], positive: ["4", 0], negative: ["5", 0], latent_image: ["6", 0] } },
    "9": { class_type: "VAEDecode", inputs: { samples: ["8", 0], vae: ["3", 0] } },
    "10": { class_type: "SaveImage", inputs: { filename_prefix: "heykoko", images: ["9", 0] } },
  };
}

// OmniGen2 — works on stock ComfyUI after all: the model + its "omnigen2" CLIP
// type are in core. The earlier num_tokens crash was caused by routing the
// conditioning through ReferenceLatent; the plain omnigen2 CLIP encode sets
// num_tokens itself. Used as an instruction editor here: VAEEncode(source) →
// latent at denoise ~0.8 + the instruction (preserves the subject, applies the
// edit). (It can also do txt2img, but we surface it in the edit group.)
function buildOmniGen2Edit({ model, prompt, negative, imageName, seed, cfg, comp, denoise, width, height }) {
  const px = (width && height) ? ["16", 0] : ["14", 0];
  const wf = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: model, weight_dtype: "default" } },
    "2": { class_type: "CLIPLoader", inputs: { clip_name: comp.clip, type: "omnigen2" } },
    "3": { class_type: "VAELoader", inputs: { vae_name: comp.vae } },
    "14": { class_type: "LoadImage", inputs: { image: imageName } },
    "15": { class_type: "VAEEncode", inputs: { pixels: px, vae: ["3", 0] } },
    "4": { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: prompt } },
    "5": { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: negative || "" } },
    "8": { class_type: "KSampler", inputs: { seed, steps: cfg.steps, cfg: cfg.cfg, sampler_name: cfg.sampler, scheduler: cfg.scheduler, denoise: denoise != null ? denoise : 0.8, model: ["1", 0], positive: ["4", 0], negative: ["5", 0], latent_image: ["15", 0] } },
    "9": { class_type: "VAEDecode", inputs: { samples: ["8", 0], vae: ["3", 0] } },
    "10": { class_type: "SaveImage", inputs: { filename_prefix: "heykoko", images: ["9", 0] } },
  };
  if (width && height) wf["16"] = scaleNode(["14", 0], width, height);
  return wf;
}

// InstructPix2Pix — a full SD1.5 checkpoint that needs ip2p's THREE-way
// classifier-free guidance via DualCFGGuider:
//   cond1 = text+image, cond2 = image-only, negative = true uncond (empty text,
//   no image). cfg_conds is text guidance; cfg_cond2_negative is image guidance
//   (raise it to preserve the input more). A plain single-cfg KSampler over-
//   edits and ignores the source image — this is the correct ip2p sampler.
function buildInstructPix2Pix({ model, prompt, negative, imageName, seed, cfg, width, height }) {
  const imageCfg = cfg.imageCfg != null ? cfg.imageCfg : 1.5;
  const px = (width && height) ? ["13", 0] : ["4", 0];
  const wf = {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: model } },
    "2": { class_type: "CLIPTextEncode", inputs: { clip: ["1", 1], text: prompt } },
    "3": { class_type: "CLIPTextEncode", inputs: { clip: ["1", 1], text: negative } },
    "4": { class_type: "LoadImage", inputs: { image: imageName } },
    "5": { class_type: "InstructPixToPixConditioning", inputs: { positive: ["2", 0], negative: ["3", 0], vae: ["1", 2], pixels: px } },
    "6": { class_type: "DualCFGGuider", inputs: { model: ["1", 0], cond1: ["5", 0], cond2: ["5", 1], negative: ["3", 0], cfg_conds: cfg.cfg, cfg_cond2_negative: imageCfg, style: "regular" } },
    "7": { class_type: "RandomNoise", inputs: { noise_seed: seed } },
    "8": { class_type: "KSamplerSelect", inputs: { sampler_name: cfg.sampler } },
    "9": { class_type: "BasicScheduler", inputs: { model: ["1", 0], scheduler: cfg.scheduler, steps: cfg.steps, denoise: 1 } },
    "10": { class_type: "SamplerCustomAdvanced", inputs: { noise: ["7", 0], guider: ["6", 0], sampler: ["8", 0], sigmas: ["9", 0], latent_image: ["5", 2] } },
    "11": { class_type: "VAEDecode", inputs: { samples: ["10", 0], vae: ["1", 2] } },
    "12": { class_type: "SaveImage", inputs: { filename_prefix: "heykoko", images: ["11", 0] } },
  };
  if (width && height) wf["13"] = scaleNode(["4", 0], width, height);
  return wf;
}

function buildEditWorkflow(editType, args) {
  if (editType === "kontext") return buildKontext(args);
  if (editType === "qwen") return buildQwenEdit(args);
  if (editType === "ip2p") return buildInstructPix2Pix(args);
  if (editType === "hidream-e1") return buildHiDreamEdit(args);
  if (editType === "omnigen") return buildOmniGen2Edit(args);
  return null;
}

// ── Video workflows ─────────────────────────────────────────────────────────

async function videoCompanions(videoType, model) {
  const [clips, vaes] = await Promise.all([
    comfyEnum("CLIPLoader", "clip_name"),
    comfyEnum("VAELoader", "vae_name"),
  ]);
  const find = (list, re) => list.find((x) => re.test(x));
  if (videoType === "wan") {
    const clip = find(clips, /umt5/i);
    // The 14B experts use the WAN 2.1 VAE; the 5B ti2v uses its own WAN 2.2 VAE.
    // They are NOT interchangeable (wrong VAE → wrong colors / garbage).
    const is14B = /14b/i.test(model || "");
    const vae = is14B
      ? (find(vaes, /wan.?2[._]1.*vae/i) || find(vaes, /wan.*vae/i))
      : (find(vaes, /wan2[._]2.*vae/i) || find(vaes, /wan.*vae/i));
    const missing = [];
    if (!clip) missing.push("umt5_xxl_fp8_e4m3fn_scaled.safetensors → text_encoders/");
    if (!vae) missing.push((is14B ? "wan_2.1_vae.safetensors" : "wan2.2_vae.safetensors") + " → vae/");
    if (missing.length) throw new Error("缺少 WAN 视频所需文件：\n- " + missing.join("\n- "));
    // Optional LightX2V 4-step speed LoRAs (one per expert, matched to t2v/i2v).
    // Present → buildWan14B mounts them and we switch to the 4-step/cfg-1 preset.
    let loraHigh, loraLow;
    if (is14B) {
      const kind = /i2v/i.test(model) ? "i2v" : "t2v";
      const loras = await comfyEnum("LoraLoaderModelOnly", "lora_name");
      loraHigh = find(loras, new RegExp(`wan.?2[._]2_${kind}_lightx2v.*high_noise`, "i"));
      loraLow = find(loras, new RegExp(`wan.?2[._]2_${kind}_lightx2v.*low_noise`, "i"));
      if (!loraHigh || !loraLow) { loraHigh = undefined; loraLow = undefined; } // need the pair
    }
    return { clip, vae, loraHigh, loraLow };
  }
  if (videoType === "hunyuan") {
    const clipL = find(clips, /clip_l/i);
    const llava = find(clips, /llava.*llama|llava_llama3/i);
    const vae = find(vaes, /hunyuan.*video.*vae|hunyuan_video_vae/i);
    const missing = [];
    if (!clipL) missing.push("clip_l.safetensors → text_encoders/");
    if (!llava) missing.push("llava_llama3_fp8_scaled.safetensors → text_encoders/");
    if (!vae) missing.push("hunyuan_video_vae_bf16.safetensors → vae/");
    if (missing.length) throw new Error("缺少 Hunyuan 视频所需文件：\n- " + missing.join("\n- "));
    return { clipL, llava, vae };
  }
  if (videoType === "ltx") {
    // LTX-2 uses a Gemma text encoder (loaded via LTXAVTextEncoderLoader with the
    // model's own ckpt); VAE comes from the checkpoint, so no separate VAE needed.
    // Must be the 12B Gemma-3 — the smaller gemma4_e4b (Gemma 3n) is a different
    // model and produces broken output, and it sorts first so a bare /gemma/ grabs
    // the wrong one.
    const encoder = find(clips, /gemma.*12b/i) || find(clips, /gemma_?3/i) || find(clips, /gemma/i) || find(clips, /t5xxl/i);
    if (!encoder) throw new Error("缺少 LTX-2 文本编码器：\n- gemma_3_12B_it…safetensors（或 t5xxl）→ text_encoders/");
    return { encoder };
  }
  throw new Error("该视频模型暂未接入（目前支持 WAN 2.2、Hunyuan、LTX-2）。");
}

// Per-model video defaults (resolution / length / fps / sampling), overridable.
// dimMult = resolution must be a multiple of this; lenMult = frame count must be
// lenMult·n + 1.
function videoPreset(videoType, model, turbo) {
  if (videoType === "wan") {
    if (/14b/i.test(model || "")) {
      // WAN 2.2 14B MoE (high+low experts). WITH the LightX2V 4-step speed LoRAs
      // (turbo) it runs cfg 1 / 4 steps (~6-10× faster); without them, the full
      // schedule cfg 3.5 / 20 steps. euler/simple, shift 5, native 16fps either way.
      const fast = turbo
        ? { cfg: 1, steps: 4 }
        : { cfg: 3.5, steps: 20 };
      return { sampler: "euler", scheduler: "simple", ...fast, shift: 5.0, width: 832, height: 480, length: 81, fps: 16, dimMult: 16, lenMult: 4 };
    }
    return { sampler: "uni_pc", scheduler: "simple", cfg: 5, steps: 20, shift: 8.0, width: 704, height: 480, length: 49, fps: 24, dimMult: 16, lenMult: 4 };
  }
  if (videoType === "hunyuan") {
    return { sampler: "euler", scheduler: "simple", cfg: 6, steps: 20, shift: 7.0, width: 720, height: 480, length: 49, fps: 24, dimMult: 16, lenMult: 4 };
  }
  if (videoType === "ltx") {
    // LTX uses its own LTXVScheduler (scheduler/shift here are unused); dims must
    // be /32, frames 8n+1. cfg is low (~3). The 22b model is undersampled at 20
    // steps (motion ghosting / trailing edges) — 30 is the quality sweet spot.
    return { sampler: "euler", scheduler: "simple", cfg: 3, steps: 30, shift: 0, width: 768, height: 512, length: 97, fps: 24, dimMult: 32, lenMult: 8 };
  }
  return null;
}

function resolveVideoConfig(videoType, opts, model, turbo) {
  const p = videoPreset(videoType, model, turbo);
  if (!p) return null;
  const snap = (v, m) => Math.max(m, Math.round(v / m) * m);
  const L = opts.length || p.length;
  // i2v: when the caller gives the input image's aspect ratio (and no explicit
  // size), render at that aspect — keeping the preset's pixel budget — so the
  // conditioning frame isn't stretched. Stretching a mismatched still is the
  // main cause of ghosted / doubled edges in image-to-video.
  let baseW = opts.width || p.width;
  let baseH = opts.height || p.height;
  if (!opts.width && !opts.height && opts.aspect > 0) {
    const area = p.width * p.height;
    baseW = Math.sqrt(area * opts.aspect);
    baseH = Math.sqrt(area / opts.aspect);
  }
  return {
    sampler: opts.sampler || p.sampler,
    scheduler: opts.scheduler || p.scheduler,
    cfg: opts.cfg != null ? opts.cfg : p.cfg,
    steps: opts.steps || p.steps,
    shift: opts.shift != null ? opts.shift : p.shift,
    width: snap(baseW, p.dimMult),
    height: snap(baseH, p.dimMult),
    // Frame count must be lenMult·n + 1 — snap to the nearest valid value.
    length: Math.max(p.lenMult + 1, Math.round((L - 1) / p.lenMult) * p.lenMult + 1),
    fps: opts.fps || p.fps,
  };
}

// WAN's standard negative prompt. WAN is tuned to be sampled WITH this — without
// it you get the artifacts it suppresses (oversaturated / weird / grayish color,
// overexposure, static frames). Used whenever the user didn't supply their own.
const WAN_DEFAULT_NEGATIVE =
  "色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走";

// WAN 2.2 14B is a two-expert MoE: the high-noise expert denoises the early
// (high-noise) half of the schedule, then the low-noise expert finishes — chained
// via two KSamplerAdvanced nodes (the first returns leftover noise, the second
// adds none and picks up where it left off). The two checkpoints are a pair; we
// derive the low-noise twin from the selected high-noise name. t2v uses an empty
// latent; i2v uses WanImageToVideo (which also rewrites the conditioning).
function buildWan14B({ model, prompt, negative, comp, imageName, seed, v }) {
  const neg = negative && negative.trim() ? negative : WAN_DEFAULT_NEGATIVE;
  const highModel = model.replace(/low_noise/i, "high_noise");
  const lowModel = model.replace(/high_noise/i, "low_noise");
  const i2v = !!imageName;
  const boundary = Math.max(1, Math.floor(v.steps / 2)); // expert switch at ~50%
  // LightX2V 4-step speed LoRAs (when installed): one per expert, between the
  // UNETLoader and ModelSamplingSD3. Each expert's sampler then feeds from its
  // LoRA output. The preset already dropped to 4 steps / cfg 1 to match.
  const turbo = !!(comp.loraHigh && comp.loraLow);
  const highSrc = turbo ? "16" : "1";
  const lowSrc = turbo ? "17" : "11";
  const wf = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: highModel, weight_dtype: "default" } },
    "2": { class_type: "ModelSamplingSD3", inputs: { model: [highSrc, 0], shift: v.shift } },
    "11": { class_type: "UNETLoader", inputs: { unet_name: lowModel, weight_dtype: "default" } },
    "12": { class_type: "ModelSamplingSD3", inputs: { model: [lowSrc, 0], shift: v.shift } },
    "3": { class_type: "CLIPLoader", inputs: { clip_name: comp.clip, type: "wan" } },
    "4": { class_type: "VAELoader", inputs: { vae_name: comp.vae } },
    "5": { class_type: "CLIPTextEncode", inputs: { clip: ["3", 0], text: prompt } },
    "6": { class_type: "CLIPTextEncode", inputs: { clip: ["3", 0], text: neg } },
  };
  if (turbo) {
    wf["16"] = { class_type: "LoraLoaderModelOnly", inputs: { model: ["1", 0], lora_name: comp.loraHigh, strength_model: 1.0 } };
    wf["17"] = { class_type: "LoraLoaderModelOnly", inputs: { model: ["11", 0], lora_name: comp.loraLow, strength_model: 1.0 } };
  }
  let posRef, negRef, latentRef;
  if (i2v) {
    wf["13"] = { class_type: "LoadImage", inputs: { image: imageName } };
    wf["7"] = { class_type: "WanImageToVideo", inputs: { positive: ["5", 0], negative: ["6", 0], vae: ["4", 0], width: v.width, height: v.height, length: v.length, batch_size: 1, start_image: ["13", 0] } };
    posRef = ["7", 0]; negRef = ["7", 1]; latentRef = ["7", 2];
  } else {
    wf["7"] = { class_type: "EmptyHunyuanLatentVideo", inputs: { width: v.width, height: v.height, length: v.length, batch_size: 1 } };
    posRef = ["5", 0]; negRef = ["6", 0]; latentRef = ["7", 0];
  }
  wf["8"] = { class_type: "KSamplerAdvanced", inputs: { model: ["2", 0], add_noise: "enable", noise_seed: seed, steps: v.steps, cfg: v.cfg, sampler_name: v.sampler, scheduler: v.scheduler, positive: posRef, negative: negRef, latent_image: latentRef, start_at_step: 0, end_at_step: boundary, return_with_leftover_noise: "enable" } };
  wf["9"] = { class_type: "KSamplerAdvanced", inputs: { model: ["12", 0], add_noise: "disable", noise_seed: seed, steps: v.steps, cfg: v.cfg, sampler_name: v.sampler, scheduler: v.scheduler, positive: posRef, negative: negRef, latent_image: ["8", 0], start_at_step: boundary, end_at_step: v.steps, return_with_leftover_noise: "disable" } };
  wf["10"] = { class_type: "VAEDecode", inputs: { samples: ["9", 0], vae: ["4", 0] } };
  wf["14"] = { class_type: "CreateVideo", inputs: { images: ["10", 0], fps: v.fps } };
  wf["15"] = { class_type: "SaveVideo", inputs: { video: ["14", 0], filename_prefix: "heykoko_vid", format: "mp4", codec: "h264" } };
  return wf;
}

// WAN 2.2 ti2v 5B: one model does text→video AND image→video (pass start_image
// for i2v). Wan22ImageToVideoLatent builds the latent; ModelSamplingSD3 applies
// WAN's shift; frames are muxed to mp4 via CreateVideo→SaveVideo. The 14B variant
// is a different (two-expert) pipeline, dispatched separately.
function buildWanVideo(args) {
  if (/14b/i.test(args.model || "")) return buildWan14B(args);
  const { model, prompt, negative, comp, imageName, seed, v } = args;
  const neg = negative && negative.trim() ? negative : WAN_DEFAULT_NEGATIVE;
  const latentInputs = { vae: ["4", 0], width: v.width, height: v.height, length: v.length, batch_size: 1 };
  if (imageName) latentInputs.start_image = ["12", 0];
  const wf = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: model, weight_dtype: "default" } },
    "2": { class_type: "ModelSamplingSD3", inputs: { model: ["1", 0], shift: v.shift } },
    "3": { class_type: "CLIPLoader", inputs: { clip_name: comp.clip, type: "wan" } },
    "4": { class_type: "VAELoader", inputs: { vae_name: comp.vae } },
    "5": { class_type: "CLIPTextEncode", inputs: { clip: ["3", 0], text: prompt } },
    "6": { class_type: "CLIPTextEncode", inputs: { clip: ["3", 0], text: neg } },
    "7": { class_type: "Wan22ImageToVideoLatent", inputs: latentInputs },
    "8": { class_type: "KSampler", inputs: { seed, steps: v.steps, cfg: v.cfg, sampler_name: v.sampler, scheduler: v.scheduler, denoise: 1, model: ["2", 0], positive: ["5", 0], negative: ["6", 0], latent_image: ["7", 0] } },
    "9": { class_type: "VAEDecode", inputs: { samples: ["8", 0], vae: ["4", 0] } },
    "10": { class_type: "CreateVideo", inputs: { images: ["9", 0], fps: v.fps } },
    "11": { class_type: "SaveVideo", inputs: { video: ["10", 0], filename_prefix: "heykoko_vid", format: "mp4", codec: "h264" } },
  };
  if (imageName) wf["12"] = { class_type: "LoadImage", inputs: { image: imageName } };
  return wf;
}

// Hunyuan Video (t2v_720p): UNET + DualCLIPLoader(clip_l + llava_llama3,
// type hunyuan_video) + Hunyuan VAE. Text→video only (this checkpoint has no
// i2v). ModelSamplingSD3 shift, plain KSampler.
function buildHunyuanVideo({ model, prompt, negative, comp, seed, v }) {
  return {
    "1": { class_type: "UNETLoader", inputs: { unet_name: model, weight_dtype: "default" } },
    "2": { class_type: "DualCLIPLoader", inputs: { clip_name1: comp.clipL, clip_name2: comp.llava, type: "hunyuan_video" } },
    "3": { class_type: "VAELoader", inputs: { vae_name: comp.vae } },
    "4": { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: prompt } },
    "5": { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: negative } },
    "6": { class_type: "EmptyHunyuanLatentVideo", inputs: { width: v.width, height: v.height, length: v.length, batch_size: 1 } },
    "7": { class_type: "ModelSamplingSD3", inputs: { model: ["1", 0], shift: v.shift } },
    "8": { class_type: "KSampler", inputs: { seed, steps: v.steps, cfg: v.cfg, sampler_name: v.sampler, scheduler: v.scheduler, denoise: 1, model: ["7", 0], positive: ["4", 0], negative: ["5", 0], latent_image: ["6", 0] } },
    "9": { class_type: "VAEDecode", inputs: { samples: ["8", 0], vae: ["3", 0] } },
    "10": { class_type: "CreateVideo", inputs: { images: ["9", 0], fps: v.fps } },
    "11": { class_type: "SaveVideo", inputs: { video: ["10", 0], filename_prefix: "heykoko_vid", format: "mp4", codec: "h264" } },
  };
}

// LTX-2 (ltx-2.3-22b) — an AUDIO+VIDEO model. Checkpoint provides MODEL + video
// VAE + audio VAE; LTXAVTextEncoderLoader loads the Gemma text encoder with the
// right projection (plain CLIPLoader gives a dim mismatch). The pipeline builds a
// combined AV latent (video latent + empty audio latent → LTXVConcatAVLatent),
// samples it, splits it back (LTXVSeparateAVLatent), decodes video + audio
// separately, then CreateVideo muxes the audio into the mp4. t2v uses
// EmptyLTXVLatentVideo; i2v uses LTXVImgToVideo (also yields conditioning).
function buildLtxVideo({ model, prompt, negative, comp, imageName, seed, v }) {
  const neg = negative && negative.trim() ? negative : "worst quality, inconsistent motion, blurry, jittery, distorted";
  const i2v = !!imageName;
  const vidIdx = i2v ? 2 : 0; // video latent output index of node 7
  const wf = {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: model } },
    "2": { class_type: "LTXAVTextEncoderLoader", inputs: { text_encoder: comp.encoder, ckpt_name: model, device: "default" } },
    "3": { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: prompt } },
    "4": { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: neg } },
    "20": { class_type: "LTXVAudioVAELoader", inputs: { ckpt_name: model } },
    "21": { class_type: "LTXVEmptyLatentAudio", inputs: { frames_number: v.length, frame_rate: v.fps, batch_size: 1, audio_vae: ["20", 0] } },
    "22": { class_type: "LTXVConcatAVLatent", inputs: { video_latent: ["7", vidIdx], audio_latent: ["21", 0] } },
    "6": { class_type: "ModelSamplingLTXV", inputs: { model: ["1", 0], max_shift: 2.05, base_shift: 0.95, latent: ["22", 0] } },
    "8": { class_type: "LTXVScheduler", inputs: { steps: v.steps, max_shift: 2.05, base_shift: 0.95, stretch: true, terminal: 0.1, latent: ["22", 0] } },
    "9": { class_type: "KSamplerSelect", inputs: { sampler_name: v.sampler } },
    "10": { class_type: "SamplerCustom", inputs: { model: ["6", 0], add_noise: true, noise_seed: seed, cfg: v.cfg, positive: ["5", 0], negative: ["5", 1], sampler: ["9", 0], sigmas: ["8", 0], latent_image: ["22", 0] } },
    "23": { class_type: "LTXVSeparateAVLatent", inputs: { av_latent: ["10", 0] } },
    "11": { class_type: "VAEDecode", inputs: { samples: ["23", 0], vae: ["1", 2] } },
    "24": { class_type: "LTXVAudioVAEDecode", inputs: { samples: ["23", 1], audio_vae: ["20", 0] } },
    "12": { class_type: "CreateVideo", inputs: { images: ["11", 0], fps: v.fps, audio: ["24", 0] } },
    "13": { class_type: "SaveVideo", inputs: { video: ["12", 0], filename_prefix: "heykoko_vid", format: "mp4", codec: "h264" } },
  };
  if (i2v) {
    wf["14"] = { class_type: "LoadImage", inputs: { image: imageName } };
    wf["7"] = { class_type: "LTXVImgToVideo", inputs: { positive: ["3", 0], negative: ["4", 0], vae: ["1", 2], image: ["14", 0], width: v.width, height: v.height, length: v.length, batch_size: 1, strength: 1.0 } };
    wf["5"] = { class_type: "LTXVConditioning", inputs: { positive: ["7", 0], negative: ["7", 1], frame_rate: v.fps } };
  } else {
    wf["7"] = { class_type: "EmptyLTXVLatentVideo", inputs: { width: v.width, height: v.height, length: v.length, batch_size: 1 } };
    wf["5"] = { class_type: "LTXVConditioning", inputs: { positive: ["3", 0], negative: ["4", 0], frame_rate: v.fps } };
  }
  return wf;
}

function buildVideoWorkflow(videoType, args) {
  if (videoType === "wan") return buildWanVideo(args);
  if (videoType === "hunyuan") return buildHunyuanVideo(args);
  if (videoType === "ltx") return buildLtxVideo(args);
  return null;
}

// Parse intrinsic pixel dimensions from a base64 PNG/JPEG without an image lib.
// Used to match a video's aspect ratio to the i2v conditioning image.
function imageDims(b64) {
  try {
    const clean = typeof b64 === "string" && b64.startsWith("data:") ? b64.split(",")[1] : b64;
    const buf = Buffer.from(clean, "base64");
    // PNG: 8-byte signature, then IHDR with width@16, height@20 (big-endian).
    if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    // JPEG: scan segment markers for a Start-Of-Frame (SOFn) that carries dims.
    if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      let o = 2;
      while (o + 9 < buf.length) {
        if (buf[o] !== 0xff) { o++; continue; }
        const m = buf[o + 1];
        // SOF0–SOF15 hold the frame size; skip DHT(C4)/DAC(C8)/DNL(CC) & non-SOF.
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
          return { height: buf.readUInt16BE(o + 5), width: buf.readUInt16BE(o + 7) };
        }
        o += 2 + buf.readUInt16BE(o + 2); // jump past this segment
      }
    }
  } catch { /* unparseable → caller falls back to the preset size */ }
  return null;
}

// Target output size for image-to-image / image-to-video, keeping the INPUT
// image's aspect ratio. With an explicit size in opts the output is scaled to
// that size's PIXEL BUDGET (not its exact dims) so the ratio is preserved;
// without one ("auto") it follows the input's own size. The longer side is
// always capped at maxSide. Returns null when the input dims can't be read.
function editTargetSize(images, opts, maxSide = 2048) {
  const d = imageDims(Array.isArray(images) ? images[0] : images);
  if (!d || !d.width || !d.height) return null;
  const aspect = d.width / d.height;
  const area = (opts && opts.width && opts.height) ? opts.width * opts.height : d.width * d.height;
  let w = Math.sqrt(area * aspect);
  let h = Math.sqrt(area / aspect);
  const longer = Math.max(w, h);
  if (longer > maxSide) { const s = maxSide / longer; w *= s; h *= s; }
  return { width: w, height: h };
}

// Snap a dimension to a multiple of m (default 8 — the SD VAE stride).
function snapDim(v, m = 8) { return Math.max(m, Math.round(v / m) * m); }

// An ImageScale node resizing srcRef ([nodeId, outIdx]) to width×height.
// crop "disabled" + a ratio-preserving target means no distortion.
function scaleNode(srcRef, width, height) {
  return { class_type: "ImageScale", inputs: { image: srcRef, upscale_method: "lanczos", width, height, crop: "disabled" } };
}

// Upload a base64 image to ComfyUI's input folder so a LoadImage node can use
// it. Returns the name (prefixed with subfolder when ComfyUI nests it).
async function uploadImage(b64, signal) {
  const clean = typeof b64 === "string" && b64.startsWith("data:") ? b64.split(",")[1] : b64;
  const buf = Buffer.from(clean, "base64");
  const form = new FormData();
  form.append("image", new Blob([buf], { type: "image/png" }), "heykoko_input.png");
  form.append("overwrite", "true");
  const r = await fetch(`${config.comfyUrl}/upload/image`, { method: "POST", body: form, signal });
  if (!r.ok) throw new Error(`image upload failed (${r.status})`);
  const data = await r.json();
  return data.subfolder ? `${data.subfolder}/${data.name}` : data.name;
}

// Poll /history until the queued prompt reports outputs (or we time out / abort).
async function waitForOutputs(promptId, signal, deadline) {
  while (Date.now() < deadline) {
    if (signal.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
    try {
      const r = await fetch(`${config.comfyUrl}/history/${promptId}`, { signal });
      if (r.ok) {
        const hist = await r.json();
        const entry = hist[promptId];
        if (entry && entry.outputs) return entry.outputs;
      }
    } catch (e) {
      if (e.name === "AbortError") throw e;
    }
    await new Promise((res) => setTimeout(res, 800));
  }
  throw Object.assign(new Error("timeout"), { name: "AbortError" });
}

async function generateComfyImage(req, res) {
  try {
    const body = await readBody(req);
    const { model, prompt, negative_prompt, options, images, timeout: reqTimeout, clientId: bodyClientId } = body;

    if (!model || !prompt) {
      sendJson(res, 400, { error: "model and prompt are required" });
      return;
    }

    const opts = options || {};
    const width = opts.width || 1024;
    const height = opts.height || 1024;
    const seed = opts.seed !== undefined ? opts.seed : Math.floor(Math.random() * 2147483647);
    const isImg2Img = Array.isArray(images) && images.length > 0;
    const isMultiImage = Array.isArray(images) && images.length >= 2;
    // Output size for img2img edits, keeping the input's aspect ratio. Only
    // OVERRIDE the builder's natural sizing when we must: a size is specified
    // (default size or --size), or the input exceeds the 2048 cap. In plain
    // "auto" with a within-cap input we leave width/height undefined so edit
    // models keep their native input-inherited sizing (e.g. Kontext's own
    // resolution scaler). When set: specified → the chosen size's pixel budget,
    // over-cap → the input downscaled to fit 2048. Both preserve aspect ratio.
    let ew, eh;
    if (isImg2Img) {
      const hasSpecified = !!(opts.width && opts.height);
      const d = imageDims(images[0]);
      const overCap = d && Math.max(d.width, d.height) > 2048;
      if (hasSpecified || overCap) {
        const ts = editTargetSize(images, opts);
        if (ts) { ew = snapDim(ts.width); eh = snapDim(ts.height); }
      }
    }
    // denoise controls how much the input image is changed (1 = ignore it).
    const denoise = opts.denoise !== undefined ? opts.denoise : 0.75;
    // Per-model defaults merged with any user overrides from the params modal.
    const cfg = resolveConfig(model, opts);
    const editType = editTypeOf(model);
    const videoType = videoTypeOf(model);

    // Instruction-edit models require a reference image to edit.
    if (editType && !isImg2Img) {
      sendJson(res, 400, { error: "该模型用于指令式改图，请先附带一张参考图片再用 /imagine <编辑指令>。" });
      return;
    }

    // The browser can supply its own clientId so it can subscribe to ComfyUI's
    // WebSocket for live progress / preview frames using the same id.
    const clientId = (typeof bodyClientId === "string" && bodyClientId) || crypto.randomUUID();
    const timeoutMs = Math.min(600, Math.max(60, reqTimeout || 120)) * 1000;
    const deadline = Date.now() + timeoutMs;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    // If the client disconnects (user hit Stop), abort our poll/fetches. The
    // browser separately POSTs /interrupt to stop ComfyUI's GPU work.
    res.on("close", () => { if (!res.writableFinished) controller.abort(); });

    try {
      let workflow;
      let videoDims = null; // actual resolved output size (for the client's caption)
      if (videoType) {
        // Video. WAN 5B ti2v + 14B i2v do image→video; WAN 14B t2v / Hunyuan are
        // text→video only. The dedicated WAN 2.2 14B i2v model needs a ref image.
        if (videoType === "wan" && /14b/i.test(model) && /i2v/i.test(model) && !isImg2Img) {
          sendJson(res, 400, { error: "该模型用于图生视频，请先附带一张参考图片再用 /imagine <描述>。" });
          return;
        }
        const comp = await videoCompanions(videoType, model);
        // WAN 14B with the LightX2V LoRAs installed → 4-step/cfg-1 turbo preset.
        const turbo = !!(comp.loraHigh && comp.loraLow);
        // For i2v, match the output to the input's aspect ratio so the
        // conditioning frame isn't stretched (avoids ghosted/doubled edges).
        // A specified size sets the pixel BUDGET (kept at the input ratio);
        // "auto" keeps the input ratio at the model's own preset budget so video
        // stays within the model's practical resolution. resolveVideoConfig snaps
        // to the model's dimMult. t2v keeps the preset (no size unless --size).
        const vOpts = { ...opts };
        if (isImg2Img) {
          const dims = imageDims(images[0]);
          if (dims && dims.width && dims.height) {
            if (opts.width && opts.height) {
              const ts = editTargetSize(images, opts);
              if (ts) { vOpts.width = ts.width; vOpts.height = ts.height; }
            } else {
              vOpts.aspect = dims.width / dims.height;
            }
          }
        }
        const v = resolveVideoConfig(videoType, vOpts, model, turbo);
        videoDims = { width: v.width, height: v.height };
        // A WAN 14B t2v checkpoint can't consume a start image — ignore any attach.
        const wantImage = isImg2Img && !(videoType === "wan" && /14b/i.test(model) && /t2v/i.test(model));
        const imageName = wantImage ? await uploadImage(images[0], controller.signal) : null;
        workflow = buildVideoWorkflow(videoType, { model, prompt, negative: negative_prompt || "", comp, imageName, seed, v });
      } else if (editType) {
        // Instruction-edit. Checkpoint-based models (ip2p) bundle CLIP+VAE;
        // HiDream-E1 needs the 4 HiDream encoders; the rest (Kontext/Qwen) pick
        // their own companion files. HiDream-E1 is img2img-style (denoise ~0.85).
        let comp, editDenoise;
        if (editType === "hidream-e1") {
          comp = await hidreamCompanions();
          editDenoise = opts.denoise !== undefined ? opts.denoise : 0.85;
        } else if (editType === "omnigen") {
          comp = await editCompanions("omnigen");
          editDenoise = opts.denoise !== undefined ? opts.denoise : 0.8;
        } else {
          comp = editIsCheckpoint(editType) ? {} : await editCompanions(editType);
        }
        if (editType === "qwen" && isMultiImage) {
          // Qwen-Image-Edit-2509 Plus: compose from 2–3 reference images.
          const imageNames = [];
          for (const im of images.slice(0, 3)) imageNames.push(await uploadImage(im, controller.signal));
          workflow = buildQwenEditPlus({ model, prompt, imageNames, seed, cfg, comp, width: ew, height: eh });
        } else {
          const imageName = await uploadImage(images[0], controller.signal);
          workflow = buildEditWorkflow(editType, { model, prompt, negative: negative_prompt || "", imageName, seed, cfg, comp, denoise: editDenoise, width: ew, height: eh });
        }
      } else if (/hidream.?i1/i.test(model)) {
        // HiDream-I1 txt2img (UNET + QuadrupleCLIPLoader); ignores any attached image.
        const comp = await hidreamCompanions();
        workflow = buildHiDreamImage({ model, prompt, negative: negative_prompt || "", width, height, seed, cfg, comp });
      } else if (/z.?image/i.test(model)) {
        // Z-Image-Turbo txt2img (UNET + CLIPLoader lumina2 + ae VAE).
        const comp = await zimageCompanions();
        workflow = buildZImage({ model, prompt, width, height, seed, cfg, comp });
      } else if (isImg2Img) {
        const imageName = await uploadImage(images[0], controller.signal);
        workflow = buildImg2Img({
          model,
          prompt,
          negative: negative_prompt || "",
          seed,
          denoise,
          imageName,
          cfg,
          width: ew,
          height: eh,
        });
      } else {
        workflow = buildTxt2Img({
          model,
          prompt,
          negative: negative_prompt || "",
          width,
          height,
          seed,
          cfg,
        });
      }

      // Queue the prompt.
      const queueResp = await fetch(`${config.comfyUrl}/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: workflow, client_id: clientId }),
        signal: controller.signal,
      });

      if (!queueResp.ok) {
        const text = await queueResp.text();
        sendJson(res, queueResp.status, { error: text || queueResp.statusText });
        return;
      }

      const queued = await queueResp.json();
      if (queued.node_errors && Object.keys(queued.node_errors).length) {
        sendJson(res, 400, { error: "ComfyUI workflow error", detail: queued.node_errors });
        return;
      }
      const promptId = queued.prompt_id;
      if (!promptId) {
        sendJson(res, 502, { error: "ComfyUI did not return a prompt_id" });
        return;
      }

      // Wait for completion, then collect outputs. Video files (.mp4/.webm)
      // come back in the same `images` array (with an `animated` flag) — split
      // them out so the client can render <video> vs <img>.
      const outputs = await waitForOutputs(promptId, controller.signal, deadline);
      const outImages = [];
      const outVideos = [];
      let videoMime = "video/mp4";
      for (const nodeId of Object.keys(outputs)) {
        for (const img of outputs[nodeId].images || []) {
          if (img.type === "temp") continue; // skip previews, keep final outputs
          const params = new URLSearchParams({
            filename: img.filename,
            subfolder: img.subfolder || "",
            type: img.type || "output",
          });
          const viewResp = await fetch(`${config.comfyUrl}/view?${params}`, { signal: controller.signal });
          if (!viewResp.ok) continue;
          const buf = Buffer.from(await viewResp.arrayBuffer());
          if (/\.(mp4|webm|mov)$/i.test(img.filename)) {
            videoMime = /\.webm$/i.test(img.filename) ? "video/webm" : "video/mp4";
            outVideos.push(buf.toString("base64"));
          } else {
            outImages.push(buf.toString("base64"));
          }
        }
      }

      const now = new Date();
      const ts = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;
      if (videoType) {
        console.log(`${ts} [comfy-gen] model=${model}, mode=video:${videoType}${isImg2Img ? "(i2v)" : "(t2v)"}, ${videoDims ? videoDims.width + "x" + videoDims.height : "?"}, videos=${outVideos.length}`);
        sendJson(res, 200, { videos: outVideos, videoMime, model, width: videoDims?.width, height: videoDims?.height });
      } else {
        const mode = editType ? `edit:${editType}` : isImg2Img ? `img2img(denoise=${denoise})` : `txt2img ${width}x${height}`;
        console.log(`${ts} [comfy-gen] model=${model}, mode=${mode}, sampler=${cfg.sampler}/${cfg.scheduler}, cfg=${cfg.cfg}${cfg.guidance != null ? `, guidance=${cfg.guidance}` : ""}, steps=${cfg.steps}, images=${outImages.length}`);
        sendJson(res, 200, { images: outImages, model });
      }
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    if (error.name === "AbortError") {
      sendJson(res, 504, { error: "ComfyUI 图片生成超时，请重试或减少步数。" });
    } else if (typeof error.message === "string" && (error.message.startsWith("缺少") || error.message.includes("暂未接入"))) {
      // Missing companion files, or an unsupported model — surface the message.
      sendJson(res, 400, { error: error.message });
    } else {
      sendJson(res, 500, {
        error: "ComfyUI 图片生成失败，请确认 ComfyUI 正在运行且已加载所选模型。",
        detail: error.message,
      });
    }
  }
}

module.exports = { proxyComfyModels, generateComfyImage };
