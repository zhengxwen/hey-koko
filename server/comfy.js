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
  return null;
}

// Edit models that load as a full checkpoint (CLIP+VAE bundled) rather than a
// bare diffusion model needing separate text-encoder/VAE companions.
function editIsCheckpoint(editType) {
  return editType === "ip2p";
}

// List both classic checkpoints (txt2img / classic img2img) and the
// instruction-edit models found in diffusion_models/.
async function proxyComfyModels(res) {
  try {
    const [ckpts, unets] = await Promise.all([
      comfyEnum("CheckpointLoaderSimple", "ckpt_name"),
      comfyEnum("UNETLoader", "unet_name"),
    ]);
    // Edit models can be either diffusion models (UNETLoader) or full
    // checkpoints (e.g. instruct-pix2pix). Plain checkpoints stay in `models`.
    const editFromCkpt = ckpts.filter((n) => editTypeOf(n));
    const plainCkpts = ckpts.filter((n) => !editTypeOf(n));
    const editFromUnet = unets.filter((n) => editTypeOf(n));
    const editModels = [...editFromCkpt, ...editFromUnet].map((n) => ({ name: n, type: editTypeOf(n) }));
    sendJson(res, 200, { models: plainCkpts, editModels });
  } catch {
    sendJson(res, 200, { models: [], editModels: [] });
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
    const clip = find(clips, /qwen.*vl|qwen_2\.5_vl/i);
    const vae = find(vaes, /qwen.*image.*vae|qwen[-_]?image|qwen.*vae/i);
    const missing = [];
    if (!clip) missing.push("qwen_2.5_vl_fp16.safetensors → text_encoders/");
    if (!vae) missing.push("qwen_image_vae.safetensors → vae/");
    if (missing.length) throw new Error("缺少 Qwen-Image-Edit 所需文件：\n- " + missing.join("\n- "));
    return { clip, vae };
  }
  if (editType === "omnigen") {
    const clip = find(clips, /omnigen|qwen.*vl|qwen_2\.5_vl/i);
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
    return { sampler: "euler", scheduler: "normal", cfg: 3, guidance: null, steps: 25, sd3Latent: false };
  }
  if (/pix2pix|instruct.?pix|ip2p/i.test(model)) {
    // InstructPix2Pix needs DUAL guidance: cfg = text guidance (how much to
    // follow the instruction), imageCfg = image guidance (how faithful to the
    // input — higher preserves more). More steps helps on real photos.
    return { sampler: "euler", scheduler: "normal", cfg: 7.5, imageCfg: 1.5, guidance: null, steps: 30, sd3Latent: false };
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
function buildImg2Img({ model, prompt, negative, seed, denoise, imageName, cfg }) {
  return {
    ...commonNodes({ model, prompt, negative, guidance: cfg.guidance }),
    "3": ksampler({ seed, steps: cfg.steps, cfg: cfg.cfg, sampler: cfg.sampler, scheduler: cfg.scheduler, denoise, latentRef: ["10", 0], guidance: cfg.guidance }),
    "10": { class_type: "VAEEncode", inputs: { pixels: ["11", 0], vae: ["4", 2] } },
    "11": { class_type: "LoadImage", inputs: { image: imageName } },
  };
}

// ── Instruction-edit workflows ──────────────────────────────────────────────
// These take a natural-language instruction + a reference image and edit it,
// preserving identity/composition far better than classic denoise img2img.

// FLUX.1 Kontext — official ComfyUI graph: the input image is scaled to a
// Kontext-friendly size, VAE-encoded, and injected into the positive
// conditioning via ReferenceLatent. cfg=1 + FluxGuidance, like base Flux.
function buildKontext({ model, prompt, imageName, seed, cfg, comp }) {
  return {
    "1": { class_type: "UNETLoader", inputs: { unet_name: model, weight_dtype: "default" } },
    "2": { class_type: "DualCLIPLoader", inputs: { clip_name1: comp.t5, clip_name2: comp.clipL, type: "flux" } },
    "3": { class_type: "VAELoader", inputs: { vae_name: comp.vae } },
    "4": { class_type: "LoadImage", inputs: { image: imageName } },
    "5": { class_type: "FluxKontextImageScale", inputs: { image: ["4", 0] } },
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
function buildQwenEdit({ model, prompt, imageName, seed, cfg, comp }) {
  return {
    "1": { class_type: "UNETLoader", inputs: { unet_name: model, weight_dtype: "default" } },
    "2": { class_type: "CLIPLoader", inputs: { clip_name: comp.clip, type: "qwen_image" } },
    "3": { class_type: "VAELoader", inputs: { vae_name: comp.vae } },
    "4": { class_type: "LoadImage", inputs: { image: imageName } },
    "5": { class_type: "TextEncodeQwenImageEdit", inputs: { clip: ["2", 0], prompt, vae: ["3", 0], image: ["4", 0] } },
    "6": { class_type: "TextEncodeQwenImageEdit", inputs: { clip: ["2", 0], prompt: "", vae: ["3", 0], image: ["4", 0] } },
    "7": { class_type: "VAEEncode", inputs: { pixels: ["4", 0], vae: ["3", 0] } },
    "8": { class_type: "KSampler", inputs: { seed, steps: cfg.steps, cfg: cfg.cfg, sampler_name: cfg.sampler, scheduler: cfg.scheduler, denoise: 1, model: ["1", 0], positive: ["5", 0], negative: ["6", 0], latent_image: ["7", 0] } },
    "9": { class_type: "VAEDecode", inputs: { samples: ["8", 0], vae: ["3", 0] } },
    "10": { class_type: "SaveImage", inputs: { filename_prefix: "heykoko", images: ["9", 0] } },
  };
}

// NOTE: OmniGen2 (omnigen2_fp16) needs the ComfyUI-OmniGen2 custom node pack —
// stock ComfyUI 0.25.0 has no node that supplies its `num_tokens` conditioning,
// so its transformer errors out. We surface a clear message instead (see
// generateComfyImage). Kontext / Qwen-Image-Edit cover the same use case.

// InstructPix2Pix — a full SD1.5 checkpoint that needs ip2p's THREE-way
// classifier-free guidance via DualCFGGuider:
//   cond1 = text+image, cond2 = image-only, negative = true uncond (empty text,
//   no image). cfg_conds is text guidance; cfg_cond2_negative is image guidance
//   (raise it to preserve the input more). A plain single-cfg KSampler over-
//   edits and ignores the source image — this is the correct ip2p sampler.
function buildInstructPix2Pix({ model, prompt, negative, imageName, seed, cfg }) {
  const imageCfg = cfg.imageCfg != null ? cfg.imageCfg : 1.5;
  return {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: model } },
    "2": { class_type: "CLIPTextEncode", inputs: { clip: ["1", 1], text: prompt } },
    "3": { class_type: "CLIPTextEncode", inputs: { clip: ["1", 1], text: negative } },
    "4": { class_type: "LoadImage", inputs: { image: imageName } },
    "5": { class_type: "InstructPixToPixConditioning", inputs: { positive: ["2", 0], negative: ["3", 0], vae: ["1", 2], pixels: ["4", 0] } },
    "6": { class_type: "DualCFGGuider", inputs: { model: ["1", 0], cond1: ["5", 0], cond2: ["5", 1], negative: ["3", 0], cfg_conds: cfg.cfg, cfg_cond2_negative: imageCfg, style: "regular" } },
    "7": { class_type: "RandomNoise", inputs: { noise_seed: seed } },
    "8": { class_type: "KSamplerSelect", inputs: { sampler_name: cfg.sampler } },
    "9": { class_type: "BasicScheduler", inputs: { model: ["1", 0], scheduler: cfg.scheduler, steps: cfg.steps, denoise: 1 } },
    "10": { class_type: "SamplerCustomAdvanced", inputs: { noise: ["7", 0], guider: ["6", 0], sampler: ["8", 0], sigmas: ["9", 0], latent_image: ["5", 2] } },
    "11": { class_type: "VAEDecode", inputs: { samples: ["10", 0], vae: ["1", 2] } },
    "12": { class_type: "SaveImage", inputs: { filename_prefix: "heykoko", images: ["11", 0] } },
  };
}

function buildEditWorkflow(editType, args) {
  if (editType === "kontext") return buildKontext(args);
  if (editType === "qwen") return buildQwenEdit(args);
  if (editType === "ip2p") return buildInstructPix2Pix(args);
  return null;
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
    const { model, prompt, negative_prompt, options, images, timeout: reqTimeout } = body;

    if (!model || !prompt) {
      sendJson(res, 400, { error: "model and prompt are required" });
      return;
    }

    const opts = options || {};
    const width = opts.width || 1024;
    const height = opts.height || 1024;
    const seed = opts.seed !== undefined ? opts.seed : Math.floor(Math.random() * 2147483647);
    const isImg2Img = Array.isArray(images) && images.length > 0;
    // denoise controls how much the input image is changed (1 = ignore it).
    const denoise = opts.denoise !== undefined ? opts.denoise : 0.75;
    // Per-model defaults merged with any user overrides from the params modal.
    const cfg = resolveConfig(model, opts);
    const editType = editTypeOf(model);

    // OmniGen2 needs custom nodes that aren't in stock ComfyUI — fail clearly.
    if (editType === "omnigen") {
      sendJson(res, 400, { error: "OmniGen2 需要安装 ComfyUI-OmniGen2 自定义节点才能运行（当前 ComfyUI 无对应节点）。建议改用 Kontext 或 Qwen-Image-Edit。" });
      return;
    }

    // Instruction-edit models require a reference image to edit.
    if (editType && !isImg2Img) {
      sendJson(res, 400, { error: "该模型用于指令式改图，请先附带一张参考图片再用 /imagine <编辑指令>。" });
      return;
    }

    const clientId = crypto.randomUUID();
    const timeoutMs = Math.min(600, Math.max(60, reqTimeout || 120)) * 1000;
    const deadline = Date.now() + timeoutMs;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      let workflow;
      if (editType) {
        // Instruction-edit. Checkpoint-based models (ip2p) bundle CLIP+VAE;
        // diffusion-model ones (Kontext/Qwen) need companion files picked here.
        const comp = editIsCheckpoint(editType) ? {} : await editCompanions(editType);
        const imageName = await uploadImage(images[0], controller.signal);
        workflow = buildEditWorkflow(editType, { model, prompt, negative: negative_prompt || "", imageName, seed, cfg, comp });
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

      // Wait for completion, then collect the SaveImage outputs.
      const outputs = await waitForOutputs(promptId, controller.signal, deadline);
      const outImages = [];
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
          outImages.push(buf.toString("base64"));
        }
      }

      const now = new Date();
      const ts = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;
      const mode = editType ? `edit:${editType}` : isImg2Img ? `img2img(denoise=${denoise})` : `txt2img ${width}x${height}`;
      console.log(`${ts} [comfy-gen] model=${model}, mode=${mode}, sampler=${cfg.sampler}/${cfg.scheduler}, cfg=${cfg.cfg}${cfg.guidance != null ? `, guidance=${cfg.guidance}` : ""}, steps=${cfg.steps}, images=${outImages.length}`);

      sendJson(res, 200, { images: outImages, model });
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    if (error.name === "AbortError") {
      sendJson(res, 504, { error: "ComfyUI 图片生成超时，请重试或减少步数。" });
    } else if (typeof error.message === "string" && error.message.startsWith("缺少")) {
      // Missing companion files (text encoder / VAE) — surface the actionable list.
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
