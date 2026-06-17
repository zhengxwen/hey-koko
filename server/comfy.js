const crypto = require("crypto");
const config = require("./config");
const { sendJson, readBody } = require("./utils");

// List available checkpoints by reading ComfyUI's node schema. The checkpoint
// names live in CheckpointLoaderSimple's first required input enum.
async function proxyComfyModels(res) {
  try {
    const response = await fetch(`${config.comfyUrl}/object_info/CheckpointLoaderSimple`);
    if (!response.ok) {
      sendJson(res, 200, { models: [] });
      return;
    }
    const data = await response.json();
    const enum0 = data?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0];
    const models = Array.isArray(enum0) ? enum0 : [];
    sendJson(res, 200, { models });
  } catch {
    sendJson(res, 200, { models: [] });
  }
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

    const clientId = crypto.randomUUID();
    const timeoutMs = Math.min(600, Math.max(60, reqTimeout || 120)) * 1000;
    const deadline = Date.now() + timeoutMs;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      let workflow;
      if (isImg2Img) {
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
      console.log(`${ts} [comfy-gen] model=${model}, mode=${isImg2Img ? `img2img(denoise=${denoise})` : `txt2img ${width}x${height}`}, sampler=${cfg.sampler}/${cfg.scheduler}, cfg=${cfg.cfg}${cfg.guidance != null ? `, guidance=${cfg.guidance}` : ""}, steps=${cfg.steps}, images=${outImages.length}`);

      sendJson(res, 200, { images: outImages, model });
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    if (error.name === "AbortError") {
      sendJson(res, 504, { error: "ComfyUI 图片生成超时，请重试或减少步数。" });
    } else {
      sendJson(res, 500, {
        error: "ComfyUI 图片生成失败，请确认 ComfyUI 正在运行且已加载所选模型。",
        detail: error.message,
      });
    }
  }
}

module.exports = { proxyComfyModels, generateComfyImage };
