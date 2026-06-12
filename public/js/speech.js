// Text-to-Speech functionality
import { dom, state } from './state.js';

function mathToSpeech(expr) {
  return expr
    .replace(/\\frac\{([^}]+)\}\{([^}]+)\}/g, "$1分之$2")
    .replace(/\\sqrt\{([^}]+)\}/g, "$1的平方根")
    .replace(/\\sum/g, "求和")
    .replace(/\\prod/g, "求积")
    .replace(/\\int/g, "积分")
    .replace(/\\rightarrow/g, "推出")
    .replace(/\\leftarrow/g, "左箭头")
    .replace(/\\Rightarrow/g, "推出")
    .replace(/\\Leftarrow/g, "左双箭头")
    .replace(/\\leftrightarrow/g, "等价于")
    .replace(/\\Leftrightarrow/g, "等价于")
    .replace(/\\to/g, "到")
    .replace(/\\infty/g, "无穷")
    .replace(/\\pi/g, "派")
    .replace(/\\alpha/g, "阿尔法")
    .replace(/\\beta/g, "贝塔")
    .replace(/\\gamma/g, "伽马")
    .replace(/\\delta/g, "德尔塔")
    .replace(/\\theta/g, "西塔")
    .replace(/\\lambda/g, "兰布达")
    .replace(/\\sigma/g, "西格玛")
    .replace(/\\omega/g, "欧米伽")
    .replace(/\\mu/g, "缪")
    .replace(/\\epsilon/g, "艾普西龙")
    .replace(/\\leq?/g, "小于等于")
    .replace(/\\geq?/g, "大于等于")
    .replace(/\\neq?/g, "不等于")
    .replace(/\\approx/g, "约等于")
    .replace(/\\times/g, "乘以")
    .replace(/\\div/g, "除以")
    .replace(/\\pm/g, "加减")
    .replace(/\\cdot/g, "点乘")
    .replace(/\\log/g, "log")
    .replace(/\\ln/g, "ln")
    .replace(/\\sin/g, "sin")
    .replace(/\\cos/g, "cos")
    .replace(/\\tan/g, "tan")
    .replace(/\^{?2}?/g, "的平方")
    .replace(/\^{?3}?/g, "的立方")
    .replace(/\^{?([^}]+)}?/g, "的$1次方")
    .replace(/_{?([^}]+)}?/g, "下标$1")
    .replace(/[\\{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function markdownToSpeechText(markdown) {
  return markdown
    .replace(/```[\s\S]*?```/g, "")
    .replace(/\$\$[\s\S]*?\$\$/g, (m) => mathToSpeech(m.slice(2, -2)))
    .replace(/\$([^$]+)\$/g, (_, expr) => mathToSpeech(expr))
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/<table[\s\S]*?<\/table>/gi, (m) => m.replace(/<[^>]+>/g, " "))
    .replace(/<[^>]+>/g, " ")
    .replace(/^[-*_]{3,}\s*$/gm, "")
    .replace(/^\|?(\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?$/gm, "")
    .replace(/^\|(.+)\|$/gm, (_, row) => row.split("|").map(c => c.trim()).filter(Boolean).join("\n") + "\n")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/[*_~]/g, "")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function getChineseVoice() {
  if (dom.voiceSelect.value) return dom.voiceSelect.value;
  const options = Array.from(dom.voiceSelect.querySelectorAll("option[value]:not([value=''])"));
  const lilian = options.find(opt => /lilian/i.test(opt.value) && /premium/i.test(opt.value));
  if (lilian) return lilian.value;
  const premium = options.find(opt => /premium/i.test(opt.value));
  if (premium) return premium.value;
  return options.length > 0 ? options[0].value : null;
}

export function stopSpeech() {
  state.speechAbortController?.abort();
  state.speechAbortController = null;
  fetch("/api/stop-speak", { method: "POST" }).catch(() => {});
  const bodyEl = document.querySelector(".markdownBody[data-original-html]");
  if (bodyEl) {
    bodyEl.innerHTML = bodyEl.dataset.originalHtml;
    delete bodyEl.dataset.originalHtml;
  }
  if (state.activeSpeechButton) {
    state.activeSpeechButton.textContent = "朗读";
    state.activeSpeechButton.classList.remove("isSpeaking");
    state.activeSpeechButton = null;
  }
}

export function splitSentences(text) {
  const punctuation = /[。？！；：!?;:]/;
  const parts = [];
  let current = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\n" || ch === "\t") {
      // Any \n (single or double) acts as sentence break
      if (current.trim()) parts.push(current.trim());
      current = "";
      // skip consecutive \n and \t
      while (i + 1 < text.length && (text[i + 1] === "\n" || text[i + 1] === "\t")) i++;
      continue;
    }
    current += ch;
    if (punctuation.test(ch)) {
      while (i + 1 < text.length && punctuation.test(text[i + 1])) {
        current += text[++i];
      }
      parts.push(current.trim());
      current = "";
    } else if (ch === "." && (i === text.length - 1 || /\s/.test(text[i + 1]))) {
      parts.push(current.trim());
      current = "";
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts.length > 0 ? parts : [text];
}

// Find sentence position in textContent using whitespace-flexible matching.
// Strips all whitespace from both sides to find the match, then maps back to real offsets.
function findSentenceOffset(fullText, sentence, fromOffset) {
  // Build stripped version of fullText from fromOffset, with index mapping
  const map = []; // map[i] = original index in fullText for stripped char i
  for (let i = fromOffset; i < fullText.length; i++) {
    if (!/\s/.test(fullText[i])) map.push(i);
  }
  const fullStripped = map.map(i => fullText[i]).join("");
  const targetStripped = sentence.replace(/\s+/g, "");
  if (!targetStripped) return null;

  const idx = fullStripped.indexOf(targetStripped);
  if (idx === -1) return null;
  return { start: map[idx], end: map[idx + targetStripped.length - 1] + 1 };
}

function highlightSentenceInDom(bodyEl, domSentences, index) {
  if (bodyEl.dataset.originalHtml) {
    bodyEl.innerHTML = bodyEl.dataset.originalHtml;
  }

  const fullText = bodyEl.textContent;
  let searchFrom = 0;
  for (let i = 0; i < index; i++) {
    const found = findSentenceOffset(fullText, domSentences[i], searchFrom);
    if (found) searchFrom = found.end;
  }
  const match = findSentenceOffset(fullText, domSentences[index], searchFrom);
  if (!match) return;
  const startOffset = match.start;
  const endOffset = match.end;

  const walker = document.createTreeWalker(bodyEl, NodeFilter.SHOW_TEXT);
  let charCount = 0;
  const nodesToWrap = [];

  while (walker.nextNode()) {
    const node = walker.currentNode;
    const nodeLen = node.textContent.length;
    const nodeStart = charCount;
    const nodeEnd = charCount + nodeLen;

    if (nodeEnd > startOffset && nodeStart < endOffset) {
      const wrapStart = Math.max(0, startOffset - nodeStart);
      const wrapEnd = Math.min(nodeLen, endOffset - nodeStart);
      nodesToWrap.push({ node, wrapStart, wrapEnd });
    }
    charCount += nodeLen;
    if (charCount >= endOffset) break;
  }

  for (const { node, wrapStart, wrapEnd } of nodesToWrap) {
    const text = node.textContent;
    const parent = node.parentNode;
    const frag = document.createDocumentFragment();

    if (wrapStart > 0) frag.appendChild(document.createTextNode(text.slice(0, wrapStart)));
    const mark = document.createElement("mark");
    mark.className = "speak-highlight";
    mark.textContent = text.slice(wrapStart, wrapEnd);
    frag.appendChild(mark);
    if (wrapEnd < text.length) frag.appendChild(document.createTextNode(text.slice(wrapEnd)));

    parent.replaceChild(frag, node);
  }

  const firstMark = bodyEl.querySelector(".speak-highlight");
  if (firstMark) firstMark.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

export async function speakMessage(content, button) {
  if (button === state.activeSpeechButton) {
    stopSpeech();
    return;
  }

  stopSpeech();
  const messageEl = button.closest(".message");
  const bodyEl = messageEl?.querySelector(".markdownBody");

  // Use DOM innerText as the single source of truth for both TTS and highlighting
  // innerText respects layout: \n\n between <p>, \n between <br>/<tr>, \t between <td>
  let speechSentences;
  if (bodyEl) {
    bodyEl.dataset.originalHtml = bodyEl.innerHTML;
    const domText = bodyEl.innerText.trim();
    speechSentences = splitSentences(domText);
  } else {
    const text = markdownToSpeechText(content);
    speechSentences = splitSentences(text);
  }
  if (!speechSentences.length) return;

  const domSentences = speechSentences;
  const voice = getChineseVoice();
  const rate = parseFloat(dom.speechRateInput.value) || 1;

  state.activeSpeechButton = button;
  state.activeSpeechButton.textContent = "停止";
  state.activeSpeechButton.classList.add("isSpeaking");

  state.speechAbortController = new AbortController();
  try {
    const response = await fetch("/api/speak", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sentences: speechSentences, voice, rate }),
      signal: state.speechAbortController.signal,
    });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (event.speaking !== undefined && bodyEl) {
          const highlightIdx = Math.min(event.index, domSentences.length - 1);
          highlightSentenceInDom(bodyEl, domSentences, highlightIdx);
        }
        if (event.finished) {
          if (bodyEl && bodyEl.dataset.originalHtml) {
            bodyEl.innerHTML = bodyEl.dataset.originalHtml;
            delete bodyEl.dataset.originalHtml;
          }
          stopSpeech();
        }
      }
    }
  } catch (e) {
    if (e.name !== "AbortError") {
      if (bodyEl && bodyEl.dataset.originalHtml) {
        bodyEl.innerHTML = bodyEl.dataset.originalHtml;
        delete bodyEl.dataset.originalHtml;
      }
      stopSpeech();
    }
  }
}

export function populateVoiceList() {
  fetch("/api/voices")
    .then(r => r.json())
    .then(data => {
      const voices = data.voices || [];
      dom.voiceSelect.length = 1;
      const zhVoices = voices.filter(v => /^zh/i.test(v.lang));
      zhVoices.forEach((voice) => {
        const opt = document.createElement("option");
        opt.value = voice.name;
        opt.textContent = `${voice.name} (${voice.lang})`;
        dom.voiceSelect.appendChild(opt);
      });
      const saved = JSON.parse(localStorage.getItem("local-ai-companion-settings") || "{}");
      if (saved.voiceName) dom.voiceSelect.value = saved.voiceName;
    })
    .catch(() => {});
}
