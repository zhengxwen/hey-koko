// Image generation and /imagine command parsing
import { dom, state } from './state.js';
import { ASPECT_ALIASES } from './constants.js';
import { t, getPromptLanguage } from './i18n.js';
import { makePreview, normalizeGridHeight } from './utils.js';
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
      rest = rest.replace(/^--size\s+\S+\s*/, "").trim();
    } else if (/^--(square|portrait|landscape|wide|tall)\b/.test(rest)) {
      const aliasMatch = rest.match(/^(--(?:square|portrait|landscape|wide|tall))\b/);
      const alias = aliasMatch[1];
      const size = ASPECT_ALIASES[alias];
      const [w, h] = size.split("x").map(Number);
      result.options.width = w;
      result.options.height = h;
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

export async function generateImage(parsedInput, tabId = state.activeTabId, insertIndex = -1) {
  const parsedList = Array.isArray(parsedInput) ? parsedInput : [parsedInput];
  const tab = getTab(tabId);
  if (!tab) return;

  const imageModel = dom.imageModelSelect.value;
  if (!imageModel) {
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

  // Enhance prompts if requested
  const prompts = [];
  for (const parsed of parsedList) {
    let prompt = parsed.prompt;
    if (parsed.enhance) {
      setAvatarState("thinking");
      try {
        const enhanceRes = await fetch("/api/enhance-prompt", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: dom.modelSelect.value, prompt, language: getPromptLanguage() }),
        });
        const enhanceData = await enhanceRes.json();
        if (enhanceRes.ok && enhanceData.enhanced) {
          prompt = enhanceData.enhanced;
        }
      } catch {}
    }
    prompts.push(prompt);
  }

  const totalCount = parsedList.reduce((sum, p) => sum + p.count, 0);
  const abortController = new AbortController();
  state.imageGenAbortController = abortController;
  if (_setGenerating) _setGenerating(true);
  setAvatarState("thinking");

  let pending = null;
  if (state.activeTabId === tabId) {
    pending = document.createElement("div");
    pending.className = "message assistant thinking imageGen";
    const body = document.createElement("div");
    body.className = "markdownBody";
    body.innerHTML = `<span class="thinking-text">${totalCount > 1 ? t("msg_generatingCount", { done: "0", total: totalCount }) : t("msg_generating")}<span class="thinking-dots"><span>.</span><span>.</span><span>.</span><span>.</span><span>.</span><span>.</span></span></span>`;
    pending.appendChild(body);
    const refNode = insertIndex >= 0 ? dom.messagesEl.children[insertIndex] : null;
    if (refNode) {
      dom.messagesEl.insertBefore(pending, refNode);
    } else {
      dom.messagesEl.appendChild(pending);
    }
    dom.messagesEl.scrollTop = dom.messagesEl.scrollHeight;
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

        promises.push(
          fetch("/api/generate-image", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: abortController.signal,
            body: JSON.stringify({
              model: imageModel,
              prompt,
              negative_prompt: parsed.negativePrompt || undefined,
              options: reqOptions,
              timeout: parseInt(dom.imageTimeoutInput.value, 10) || 120,
            }),
          })
            .then(async (r) => {
              const data = await r.json();
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
                if (body) body.innerHTML = `<span class="thinking-text">${t("msg_generatingCount", { done: generatedImages.length + errorCount, total: totalCount })}<span class="thinking-dots"><span>.</span><span>.</span><span>.</span><span>.</span><span>.</span><span>.</span></span></span>`;
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

    if (pendingGrid) normalizeGridHeight(pendingGrid);

    let content = "";
    const enhancedPrompts = parsedList
      .map((p, i) => (p.enhance && prompts[i] !== p.prompt) ? prompts[i] : null)
      .filter(Boolean);
    if (enhancedPrompts.length > 0) {
      content += `**增强后的提示词：**\n${enhancedPrompts.map((p) => `> ${p}`).join("\n")}\n\n`;
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
        content = `**增强后的提示词：**\n${enhancedPrompts.map((p) => `> ${p}`).join("\n")}\n\n` + content;
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
    if (_setGenerating) _setGenerating(false);
    state.imageGenAbortController = null;
  }
}
