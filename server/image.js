// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

const config = require("./config");
const { sendJson, readBody } = require("./utils");
const claude = require("./claude");
const openai = require("./openai");

const IMAGE_MODEL_PATTERNS = [/flux/i, /z-image/i, /sdxl/i, /stable-diffusion/i, /imagen/i];

async function proxyOllamaImageModels(res) {
  try {
    const response = await fetch(`${config.imageOllamaUrl}/api/tags`);
    if (!response.ok) {
      sendJson(res, 200, { models: [] });
      return;
    }
    const data = await response.json();
    const imageModels = (data.models || [])
      .map((m) => m.name)
      .filter((name) => IMAGE_MODEL_PATTERNS.some((p) => p.test(name)));
    sendJson(res, 200, { models: imageModels });
  } catch {
    sendJson(res, 200, { models: [] });
  }
}

async function generateImage(req, res) {
  try {
    const body = await readBody(req);
    const { model, prompt, negative_prompt, options, images, timeout: reqTimeout } = body;

    if (!model || !prompt) {
      sendJson(res, 400, { error: "model and prompt are required" });
      return;
    }

    // Ollama image generation: width, height, steps are TOP-LEVEL params
    const ollamaBody = {
      model,
      prompt,
    };

    // Image-to-image: reference image(s) as base64 condition the generation
    // (instruction-style editing, e.g. flux2-klein). Strip any data: URL prefix.
    if (Array.isArray(images) && images.length) {
      ollamaBody.images = images.map((s) =>
        typeof s === "string" && s.startsWith("data:") ? s.split(",")[1] : s
      );
    }

    if (options) {
      if (options.width) ollamaBody.width = options.width;
      if (options.height) ollamaBody.height = options.height;
      if (options.steps) ollamaBody.steps = options.steps;
      if (options.seed !== undefined) {
        ollamaBody.options = { seed: options.seed };
      }
    }

    if (negative_prompt) {
      ollamaBody.negative_prompt = negative_prompt;
    }

    const timeoutMs = Math.min(600, Math.max(60, reqTimeout || 120)) * 1000;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    // If the client disconnects (user hit Stop), abort the fetch to Ollama so it
    // stops generating instead of running to completion in the background.
    res.on("close", () => { if (!res.writableFinished) controller.abort(); });

    // Image generation streams NDJSON: progress chunks ({completed,total}), then a
    // final chunk with the "image" field. We forward progress to the client as it
    // arrives (so the UI can show a bar) and end with a "done" line carrying the
    // image — instead of buffering the whole response and dropping the progress.
    const response = await fetch(`${config.imageOllamaUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ollamaBody),
      signal: controller.signal,
    });

    if (!response.ok) {
      clearTimeout(timeout);
      const text = await response.text();
      sendJson(res, response.status, { error: text || response.statusText });
      return;
    }

    res.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache" });

    let image = "";
    let outImages = [];
    let progressLines = 0;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const handleLine = (line) => {
      line = line.trim();
      if (!line) return;
      let chunk;
      try { chunk = JSON.parse(line); } catch { return; }
      if (chunk.image) image = chunk.image;
      if (chunk.images && chunk.images.length) outImages.push(...chunk.images);
      // Forward step progress (not the final done chunk).
      if (!chunk.done && chunk.total) {
        progressLines++;
        res.write(JSON.stringify({ type: "progress", completed: chunk.completed || 0, total: chunk.total }) + "\n");
      }
    };
    try {
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
    } finally {
      clearTimeout(timeout);
    }

    const resultImages = image ? [image] : outImages;
    res.write(JSON.stringify({ type: "done", images: resultImages, model }) + "\n");
    res.end();

    const now = new Date();
    const ts = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;
    console.log(`${ts} [image-gen] model=${model}, mode=${ollamaBody.images ? "img2img(" + ollamaBody.images.length + ")" : "txt2img"}, image=${image.length > 0 ? image.length + " chars" : "none"}, images=${outImages.length}, progress=${progressLines}`);
  } catch (error) {
    // If we already began streaming (headers sent), we can't send a JSON error —
    // close the stream with an error line the client can parse instead.
    if (res.headersSent) {
      try { res.write(JSON.stringify({ type: "error", error: error.message }) + "\n"); } catch {}
      try { res.end(); } catch {}
      return;
    }
    if (error.name === "AbortError") {
      sendJson(res, 504, { error: "Image generation timed out (120s). Please retry or use a simpler prompt." });
    } else {
      sendJson(res, 500, {
        error: "Image generation failed. Make sure the model is downloaded and supports image generation.",
        detail: error.message,
      });
    }
  }
}

const ENHANCE_PROMPTS = {
  en: "You are an expert image prompt engineer. Expand the user's short description into a detailed, vivid image generation prompt. Keep it under 200 words. Only output the enhanced prompt text, nothing else. Do not include any explanations or prefixes.",
  zh: "你是一个图片提示词专家。请将用户的简短描述扩展为详细、生动的图片生成提示词。保持在200字以内。只输出增强后的提示词，不要有其他解释或前缀。",
  "zh-Hant": "你是一個圖片提示詞專家。請將使用者的簡短描述擴展為詳細、生動的圖片生成提示詞。保持在200字以內。只輸出增強後的提示詞，不要有其他解釋或前綴。",
};

// Edit-mode enhancement: wrap the user's short request into a preservation-locked
// editing instruction so flux2 modifies the image instead of regenerating it.
const EDIT_ENHANCE_PROMPTS = {
  en: "You are an expert at writing instructions for an instruction-based image EDITING model (e.g. FLUX.2). The user gives a short request describing how to change an EXISTING image. Rewrite it into a single English editing instruction that: (1) begins by preserving the original — \"Keep the exact same art style, composition, framing, background, lighting and subject\"; (2) states ONLY the specific change the user asked for, as a small delta (e.g. \"only change ...\"); (3) ends with \"Do not change the art style or anything else.\". Do NOT describe a whole new scene and do NOT invent content the user did not ask for. Output ONLY the instruction text, nothing else.",
  zh: "你是为「指令式图片编辑模型」（如 FLUX.2）撰写编辑指令的专家。用户会给出一句简短描述，说明想如何修改一张【已有图片】。请把它改写成一条英文编辑指令，要求：(1) 开头先保留原图——\"Keep the exact same art style, composition, framing, background, lighting and subject\"；(2) 只陈述用户要求的那一处改动，作为小幅增量（如 \"only change ...\"）；(3) 结尾加上 \"Do not change the art style or anything else.\"。不要描述一个全新的场景，不要添加用户没要求的内容。只输出该编辑指令，不要有其他文字。",
  "zh-Hant": "你是為「指令式圖片編輯模型」（如 FLUX.2）撰寫編輯指令的專家。使用者會給出一句簡短描述，說明想如何修改一張【已有圖片】。請把它改寫成一條英文編輯指令，要求：(1) 開頭先保留原圖——\"Keep the exact same art style, composition, framing, background, lighting and subject\"；(2) 只陳述使用者要求的那一處改動，作為小幅增量（如 \"only change ...\"）；(3) 結尾加上 \"Do not change the art style or anything else.\"。不要描述一個全新的場景，不要添加使用者沒要求的內容。只輸出該編輯指令，不要有其他文字。",
};

// Video-mode enhancement: a video model needs MOTION described, not just a still
// scene. Expand into a cinematic shot — subject action, camera movement, and how
// things change over the clip — which is what WAN / Hunyuan / LTX are tuned for.
const VIDEO_ENHANCE_PROMPTS = {
  en: "You are an expert prompt engineer for text-to-VIDEO models (e.g. WAN, Hunyuan, LTX). Expand the user's short description into a single vivid English video prompt that describes MOTION over time: what the subject is doing, how it moves, camera movement (pan / dolly / zoom / static), and the overall mood and lighting. Describe a continuous shot, not a still image. Keep it under 150 words. Output ONLY the enhanced prompt text, nothing else — no explanations or prefixes.",
  zh: "你是「文生视频模型」（如 WAN、Hunyuan、LTX）的提示词专家。请把用户的简短描述扩展成一段生动的英文视频提示词，重点描述随时间发生的【运动】：主体在做什么、如何移动、镜头运动（平移/推拉/变焦/固定）、整体氛围与光线。要描述一个连续的镜头，而不是静止画面。控制在150字以内。只输出增强后的提示词，不要有其他解释或前缀。",
  "zh-Hant": "你是「文生視訊模型」（如 WAN、Hunyuan、LTX）的提示詞專家。請把使用者的簡短描述擴展成一段生動的英文視訊提示詞，重點描述隨時間發生的【運動】：主體在做什麼、如何移動、鏡頭運動（平移/推拉/變焦/固定）、整體氛圍與光線。要描述一個連續的鏡頭，而不是靜止畫面。控制在150字以內。只輸出增強後的提示詞，不要有其他解釋或前綴。",
};

function getPromptByLang(templates, lang) {
  return templates[lang] || templates.zh || templates.en;
}

// Core prompt-enhancement: rewrite `prompt` via the Ollama chat `model`, picking
// the template by target (video → motion, edit → preservation-locked delta, else
// generative still). Returns the enhanced text (falls back to the original if the
// model returns nothing); THROWS on a bad request / Ollama error. Reused by both the
// standalone /api/enhance-prompt endpoint AND server-side generation (so an enqueued
// job can be enhanced at RUN time, not in the browser — survives a frozen tab).
async function enhancePromptText({ model, prompt, language, edit, video }) {
  if (!model || !prompt) throw new Error("model and prompt are required");
  // Video wins over edit (i2v still needs motion described).
  const template = video ? VIDEO_ENHANCE_PROMPTS : edit ? EDIT_ENHANCE_PROMPTS : ENHANCE_PROMPTS;
  const systemPrompt = getPromptByLang(template, language || "en");

  // Cloud model: call Claude directly (this server-side path bypasses the
  // /api/chat router that would otherwise route by model name).
  if (claude.isClaudeModel(model)) {
    const text = await claude.complete(model, [
      { role: "system", content: systemPrompt },
      { role: "user", content: prompt },
    ]);
    return text.trim() || prompt;
  }
  if (openai.isOpenAIModel(model)) {
    const text = await openai.complete(model, [
      { role: "system", content: systemPrompt },
      { role: "user", content: prompt },
    ]);
    return text.trim() || prompt;
  }

  const response = await fetch(`${config.ollamaUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: prompt },
      ],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || response.statusText);
  }
  const data = await response.json();
  return data.message?.content?.trim() || prompt;
}

async function enhancePrompt(req, res) {
  try {
    const body = await readBody(req);
    const { model, prompt, language, edit, video } = body;
    if (!model || !prompt) {
      sendJson(res, 400, { error: "model and prompt are required" });
      return;
    }
    const enhanced = await enhancePromptText({ model, prompt, language, edit, video });
    sendJson(res, 200, { enhanced, original: prompt });
  } catch (error) {
    sendJson(res, 500, { error: "Prompt enhancement failed", detail: error.message });
  }
}

module.exports = { proxyOllamaImageModels, generateImage, enhancePrompt, enhancePromptText };