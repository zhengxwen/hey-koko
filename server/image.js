const config = require("./config");
const { sendJson, readBody } = require("./utils");

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

    // Image generation streams NDJSON with progress, then final chunk has "image" field
    const response = await fetch(`${config.imageOllamaUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ollamaBody),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const text = await response.text();
      sendJson(res, response.status, { error: text || response.statusText });
      return;
    }

    // Read the full streamed response (NDJSON lines)
    const rawText = await response.text();
    let image = "";
    let outImages = [];

    // Parse all NDJSON lines, look for "image" in the final done response
    const lines = rawText.split("\n").filter((l) => l.trim());
    for (const line of lines) {
      try {
        const chunk = JSON.parse(line);
        // The final response contains the image as base64
        if (chunk.image) {
          image = chunk.image;
        }
        // Also check for "images" array (fallback)
        if (chunk.images && chunk.images.length) {
          outImages.push(...chunk.images);
        }
      } catch {}
    }

    // Prefer singular "image" field, fall back to "images" array
    const resultImages = image ? [image] : outImages;

    const now = new Date();
    const ts = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;
    console.log(`${ts} [image-gen] model=${model}, mode=${ollamaBody.images ? "img2img(" + ollamaBody.images.length + ")" : "txt2img"}, image=${image.length > 0 ? image.length + " chars" : "none"}, images=${outImages.length}, lines=${lines.length}`);

    sendJson(res, 200, { images: resultImages, model });
  } catch (error) {
    if (error.name === "AbortError") {
      sendJson(res, 504, { error: "图片生成超时（120秒），请重试或使用更简单的提示词。" });
    } else {
      sendJson(res, 500, {
        error: "图片生成失败，请确认模型已下载且支持图像生成。",
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

const CONTENT_TO_IMAGINE_PROMPTS = {
  en: `You are an expert at converting text content into image generation prompts. Given the user's text, generate one or more vivid image prompts that would visually illustrate the key scenes or concepts. Output ONLY the prompts, one per line, each starting with "/imagine ". Each prompt should be a detailed visual description in English, under 100 words. Generate 1-3 prompts depending on the content richness. Do not include explanations, numbering, or any other text.`,
  zh: `你是将文本内容转换为图片生成提示词的专家。根据用户的文本，生成一个或多个能视觉化展示关键场景或概念的图片提示词。只输出提示词，每行一个，每个以 "/imagine " 开头。每个提示词应为详细的英文视觉描述，不超过100字。根据内容丰富程度生成1-3个提示词。不要包含解释、编号或其他文字。`,
  "zh-Hant": `你是將文本內容轉換為圖片生成提示詞的專家。根據使用者的文本，生成一個或多個能視覺化展示關鍵場景或概念的圖片提示詞。只輸出提示詞，每行一個，每個以 "/imagine " 開頭。每個提示詞應為詳細的英文視覺描述，不超過100字。根據內容豐富程度生成1-3個提示詞。不要包含解釋、編號或其他文字。`,
};

function getPromptByLang(templates, lang) {
  return templates[lang] || templates.zh || templates.en;
}

async function enhancePrompt(req, res) {
  try {
    const body = await readBody(req);
    const { model, prompt, language, edit } = body;

    if (!model || !prompt) {
      sendJson(res, 400, { error: "model and prompt are required" });
      return;
    }

    // Edit mode (img2img) uses a preservation-locked template instead of the
    // generative-expansion one, so the result modifies rather than replaces.
    const systemPrompt = getPromptByLang(edit ? EDIT_ENHANCE_PROMPTS : ENHANCE_PROMPTS, language || "en");

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
      sendJson(res, response.status, { error: text || response.statusText });
      return;
    }

    const data = await response.json();
    const enhanced = data.message?.content?.trim() || prompt;
    sendJson(res, 200, { enhanced, original: prompt });
  } catch (error) {
    sendJson(res, 500, { error: "提示词增强失败", detail: error.message });
  }
}

async function contentToImagePrompts(req, res) {
  try {
    const body = await readBody(req);
    const { model, content, language } = body;

    if (!model || !content) {
      sendJson(res, 400, { error: "model and content are required" });
      return;
    }

    const systemPrompt = getPromptByLang(CONTENT_TO_IMAGINE_PROMPTS, language || "en");

    const response = await fetch(`${config.ollamaUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        stream: false,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content },
        ],
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      sendJson(res, response.status, { error: text || response.statusText });
      return;
    }

    const data = await response.json();
    const raw = data.message?.content?.trim() || "";
    sendJson(res, 200, { prompts: raw });
  } catch (error) {
    sendJson(res, 500, { error: "生成图片提示词失败", detail: error.message });
  }
}

module.exports = { proxyOllamaImageModels, generateImage, enhancePrompt, contentToImagePrompts };
