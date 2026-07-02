// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

// Text-to-Speech functionality
import { dom, state } from './state.js';
import { t, getUILanguage } from './i18n.js';

// Localized display labels for the neural-engine preset voices (the dropdown's
// optgroup labels come from i18n keys; these are the per-voice option labels).
// Keyed by the engine-prefixed value sent by the server (see tts.js VOICE_CATALOG)
// — keep in sync when voices are added. Falls back to the server label if absent.
const VOICE_LABELS = {
  "kokoro:zf_xiaoxiao": { en: "Xiaoxiao · Female", zh: "小晓 · 女声", "zh-Hant": "小曉 · 女聲" },
  "kokoro:zf_xiaoyi":   { en: "Xiaoyi · Female",   zh: "小艺 · 女声", "zh-Hant": "小藝 · 女聲" },
  "kokoro:zf_xiaobei":  { en: "Xiaobei · Female",  zh: "小贝 · 女声", "zh-Hant": "小貝 · 女聲" },
  "kokoro:zf_xiaoni":   { en: "Xiaoni · Female",   zh: "小妮 · 女声", "zh-Hant": "小妮 · 女聲" },
  "kokoro:zm_yunxi":    { en: "Yunxi · Male",      zh: "云希 · 男声", "zh-Hant": "雲希 · 男聲" },
  "kokoro:zm_yunjian":  { en: "Yunjian · Male",    zh: "云健 · 男声", "zh-Hant": "雲健 · 男聲" },
  "kokoro:zm_yunyang":  { en: "Yunyang · Male",    zh: "云扬 · 男声", "zh-Hant": "雲揚 · 男聲" },
  "kokoro:zm_yunxia":   { en: "Yunxia · Male",     zh: "云夏 · 男声", "zh-Hant": "雲夏 · 男聲" },
  "kokoro:af_heart":    { en: "Heart · US Female",   zh: "Heart · 美式女声", "zh-Hant": "Heart · 美式女聲" },
  "kokoro:af_bella":    { en: "Bella · US Female",   zh: "Bella · 美式女声", "zh-Hant": "Bella · 美式女聲" },
  "kokoro:am_michael":  { en: "Michael · US Male",   zh: "Michael · 美式男声", "zh-Hant": "Michael · 美式男聲" },
  "kokoro:am_fenrir":   { en: "Fenrir · US Male",    zh: "Fenrir · 美式男声", "zh-Hant": "Fenrir · 美式男聲" },
  "kokoro:bf_emma":     { en: "Emma · UK Female",    zh: "Emma · 英式女声", "zh-Hant": "Emma · 英式女聲" },
  "kokoro:bm_george":   { en: "George · UK Male",    zh: "George · 英式男声", "zh-Hant": "George · 英式男聲" },
};

function voiceOptionLabel(v) {
  const m = VOICE_LABELS[v.value];
  if (!m) return v.label || v.value; // server fallback for unknown voices
  const lang = getUILanguage();
  return m[lang] || m.en || v.label || v.value;
}

// LaTeX command (\name) → spoken Chinese. Matched as whole words, so prefixes
// never collide (e.g. \left is not read as \le). Unlisted commands fall through
// to their bare name (\sin → "sin"). Empty string = drop wrapper, keep content.
const MATH_WORDS = {
  // relations
  le: "小于等于", leq: "小于等于", leqslant: "小于等于",
  ge: "大于等于", geq: "大于等于", geqslant: "大于等于",
  ne: "不等于", neq: "不等于", ll: "远小于", gg: "远大于",
  equiv: "恒等于", approx: "约等于", simeq: "约等于", cong: "全等于",
  sim: "相似于", propto: "正比于", doteq: "约等于",
  // binary operators
  times: "乘以", div: "除以", cdot: "乘以", ast: "乘以",
  pm: "正负", mp: "负正", oplus: "直和", otimes: "张量积", odot: "点积",
  cup: "并", cap: "交", setminus: "差", bmod: "模", mod: "模", pmod: "模",
  // sets & logic
  subset: "真包含于", supset: "真包含", subseteq: "包含于", supseteq: "包含",
  in: "属于", notin: "不属于", ni: "含有", emptyset: "空集", varnothing: "空集",
  forall: "任意", exists: "存在", nexists: "不存在",
  neg: "非", lnot: "非", land: "且", wedge: "且", lor: "或", vee: "或",
  // arrows
  to: "趋于", rightarrow: "趋于", longrightarrow: "趋于", mapsto: "映射到",
  Rightarrow: "推出", implies: "推出", iff: "当且仅当", Leftrightarrow: "当且仅当",
  leftrightarrow: "等价于", leftarrow: "左箭头", Leftarrow: "左双箭头",
  // big operators & calculus
  sum: "求和", prod: "求积", int: "积分", iint: "二重积分", iiint: "三重积分", oint: "环积分",
  lim: "极限", max: "最大值", min: "最小值", sup: "上确界", inf: "下确界", gcd: "最大公约数",
  partial: "偏", nabla: "梯度", infty: "无穷",
  // misc symbols
  angle: "角", perp: "垂直于", parallel: "平行于", triangle: "三角形", mid: "整除",
  cdots: "等等", ldots: "等等", dots: "等等", vdots: "等等", ddots: "等等",
  // greek (lower)
  alpha: "阿尔法", beta: "贝塔", gamma: "伽马", delta: "德尔塔",
  epsilon: "艾普西龙", varepsilon: "艾普西龙", zeta: "泽塔", eta: "伊塔",
  theta: "西塔", vartheta: "西塔", iota: "约塔", kappa: "卡帕", lambda: "兰布达",
  mu: "缪", nu: "纽", xi: "克西", pi: "派", varpi: "派", rho: "柔", varrho: "柔",
  sigma: "西格玛", varsigma: "西格玛", tau: "陶", upsilon: "宇普西龙",
  phi: "斐", varphi: "斐", chi: "凯", psi: "普西", omega: "欧米伽",
  // greek (upper)
  Gamma: "伽马", Delta: "德尔塔", Theta: "西塔", Lambda: "兰布达", Xi: "克西",
  Pi: "派", Sigma: "西格玛", Upsilon: "宇普西龙", Phi: "斐", Psi: "普西", Omega: "欧米伽",
  // wrappers / styling → drop, keep inner content
  left: "", right: "", big: "", Big: "", bigg: "", Bigg: "",
  bigl: "", bigr: "", Bigl: "", Bigr: "", displaystyle: "", textstyle: "",
  scriptstyle: "", limits: "", nolimits: "", mathbb: "", mathbf: "", mathrm: "",
  mathcal: "", mathfrak: "", mathsf: "", mathtt: "", mathnormal: "", boldsymbol: "",
  operatorname: "", text: "", textbf: "", textit: "", textrm: "", textsf: "",
  hat: "", widehat: "", bar: "", overline: "", underline: "", vec: "",
  tilde: "", widetilde: "", dot: "", ddot: "", quad: " ", qquad: " ",
};

function mathToSpeech(expr) {
  let s = String(expr);

  // Environments (matrices etc.): drop the \begin{..} / \end{..} markers
  s = s.replace(/\\(?:begin|end)\s*\{[^}]*\}/g, " ");

  // Structural: fractions (中文 “分母分之分子”), binomials, roots
  s = s.replace(/\\[dt]?frac\s*\{([^{}]+)\}\s*\{([^{}]+)\}/g, "$2分之$1");
  s = s.replace(/\\binom\s*\{([^{}]+)\}\s*\{([^{}]+)\}/g, "$1选$2");
  s = s.replace(/\\sqrt\s*\[([^\]]+)\]\s*\{([^{}]+)\}/g, "$2的$1次根");
  s = s.replace(/\\sqrt\s*\{([^{}]+)\}/g, "$1的平方根");

  // Degree: ^\circ / ^{\circ}
  s = s.replace(/\^\s*\{?\s*\\circ\s*\}?/g, "度");

  // Binary minus → 减 (between operands, spaces allowed); other minuses → 负
  // later (leading sign / exponent like e^{-x}).
  s = s.replace(/([A-Za-z0-9)\]}])\s*-\s*(?=[A-Za-z0-9(\\{])/g, "$1减");

  // Named commands (greek, relations, operators, wrappers …) as whole words
  s = s.replace(/\\([a-zA-Z]+)/g, (_, name) =>
    Object.prototype.hasOwnProperty.call(MATH_WORDS, name) ? MATH_WORDS[name] : name);

  // LaTeX spacing & line breaks
  s = s.replace(/\\[,;:!> ]/g, " ").replace(/\\\\/g, " ");

  // Superscripts → 的…次方 (square/cube get nicer names)
  s = s.replace(/\^\s*\{?\s*2\s*\}?/g, "的平方")
       .replace(/\^\s*\{?\s*3\s*\}?/g, "的立方")
       .replace(/\^\s*\{([^{}]+)\}/g, "的$1次方")
       .replace(/\^\s*([^\s{}^_])/g, "的$1次方");

  // Subscripts → 下标…
  s = s.replace(/_\s*\{([^{}]+)\}/g, "下标$1")
       .replace(/_\s*([^\s{}^_])/g, "下标$1");

  // Bare operator / relation characters
  s = s.replace(/=/g, "等于")
       .replace(/≠/g, "不等于").replace(/≤/g, "小于等于").replace(/≥/g, "大于等于")
       .replace(/</g, "小于").replace(/>/g, "大于")
       .replace(/\+/g, "加").replace(/-/g, "负")
       .replace(/\*/g, "乘以").replace(/\//g, "除以")
       .replace(/!/g, "的阶乘").replace(/'/g, "撇").replace(/&/g, " ");

  // Cleanup leftover TeX scaffolding
  return s.replace(/[\\{}]/g, "")
          .replace(/[()[\]|]/g, " ")
          .replace(/\s+的/g, "的")
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
  // Aborting cancels in-flight synthesis fetches AND pauses the playing
  // <audio> (playUrl listens on the same signal). No server call needed —
  // playback is browser-side.
  state.speechAbortController?.abort();
  state.speechAbortController = null;
  const bodyEl = document.querySelector(".markdownBody[data-original-html]");
  if (bodyEl) {
    bodyEl.innerHTML = bodyEl.dataset.originalHtml;
    delete bodyEl.dataset.originalHtml;
  }
  if (state.activeSpeechButton) {
    state.activeSpeechButton.textContent = t("btn_speak");
    state.activeSpeechButton.classList.remove("isSpeaking");
    state.activeSpeechButton = null;
  }
}

// While reading, ←/→ jump to the previous/next speakable message. Finds the
// nearest sibling .message that has a Speak button and clicks it (its handler
// reads that message); moves focus along so further arrow presses keep working.
// Returns true if it navigated. No-op (returns false) at the ends.
export function speakAdjacent(dir) {
  if (!state.activeSpeechButton) return false;
  const cur = state.activeSpeechButton.closest(".message");
  if (!cur) return false;
  let sib = dir < 0 ? cur.previousElementSibling : cur.nextElementSibling;
  while (sib) {
    if (sib.classList.contains("message")) {
      const btn = sib.querySelector(".speakMessage");
      if (btn) { btn.focus(); btn.click(); return true; }
    }
    sib = dir < 0 ? sib.previousElementSibling : sib.nextElementSibling;
  }
  return false;
}

// ── Natural sentence segmentation (zh + en) ───────────────────────────────
// Sentence enders that ALWAYS break. Deliberately excludes ：；:; — colons and
// semicolons are intra-sentence pauses; breaking them makes `say` reset prosody
// mid-thought, which sounds robotic. ASCII '.' and '…' are handled heuristically.
const HARD_TERM = /[。！？!?．]/;
const CLOSER = /[”’"')）】」』》〉\]]/;
// Honorific / title abbreviations that never end a sentence → never break after.
const NEVER_END_ABBR = new Set([
  "mr", "mrs", "ms", "dr", "prof", "st", "sr", "jr", "fig", "no", "eq", "vs",
  "rev", "gen", "col", "sen", "gov", "pres", "dept", "univ", "co", "inc", "ltd", "vol", "ch", "pp",
]);
// Abbreviations that may end a sentence → break only if a new sentence (uppercase
// / digit) follows, not a lowercase continuation ("etc. and" stays joined).
const MAYBE_END_ABBR = new Set(["etc", "al"]);

function firstNonSpace(text, from) {
  for (let i = from; i < text.length; i++) {
    if (!/\s/.test(text[i])) return text[i];
  }
  return undefined;
}

// Decide whether an ASCII '.' at index i ends a sentence (vs. decimal / abbr).
function isDotBoundary(text, i) {
  const prev = text[i - 1];
  const next = text[i + 1];
  if (prev && /\d/.test(prev) && next && /\d/.test(next)) return false; // 3.14
  // Initialism: single letter preceded by start/space/dot → U.S., e.g., Ph.D
  if (prev && /[A-Za-z]/.test(prev) && (i < 2 || /[\s.]/.test(text[i - 2]))) return false;
  const word = (/([A-Za-z]+)$/.exec(text.slice(Math.max(0, i - 8), i)) || [])[1];
  if (word) {
    const w = word.toLowerCase();
    if (NEVER_END_ABBR.has(w)) return false;
    const after = firstNonSpace(text, i + 1);
    if (MAYBE_END_ABBR.has(w) && after && /[a-z]/.test(after)) return false;
  }
  if (next === undefined) return true;
  if (!/\s/.test(next)) return false; // "end.Next" typo → keep joined
  const after = firstNonSpace(text, i + 1);
  return after === undefined || /[A-Z0-9"'(一-鿿]/.test(after);
}

function isEllipsisBoundary(text, i) {
  const next = text[i + 1];
  if (next === undefined) return true;
  if (!/\s/.test(next)) return false;
  const after = firstNonSpace(text, i + 1);
  return after === undefined || /[A-Z0-9"'(一-鿿]/.test(after);
}

// Split text into sentence ranges {start, end} (half-open, whitespace-trimmed).
// \n and \t are hard breaks — they mark block / <br> / table-cell boundaries.
export function sentenceRanges(text) {
  const ranges = [];
  let start = -1;
  const n = text.length;
  const flush = (end) => {
    if (start < 0) return;
    let s = start, e = end;
    while (s < e && /\s/.test(text[s])) s++;
    while (e > s && /\s/.test(text[e - 1])) e--;
    if (e > s) ranges.push({ start: s, end: e });
    start = -1;
  };
  let i = 0;
  while (i < n) {
    const ch = text[i];
    if (ch === "\n" || ch === "\t") {
      flush(i);
      i++;
      while (i < n && (text[i] === "\n" || text[i] === "\t")) i++;
      continue;
    }
    if (start < 0 && !/\s/.test(ch)) start = i;
    let isBoundary = false;
    if (HARD_TERM.test(ch)) isBoundary = true;
    else if (ch === ".") isBoundary = isDotBoundary(text, i);
    else if (ch === "…") isBoundary = isEllipsisBoundary(text, i);
    if (isBoundary) {
      let j = i + 1;
      // Absorb trailing terminal punctuation / closing quotes ("?!", "。」").
      while (j < n && (HARD_TERM.test(text[j]) || CLOSER.test(text[j]) || text[j] === "…")) j++;
      flush(j);
      i = j;
      continue;
    }
    i++;
  }
  flush(n);
  return ranges;
}

export function splitSentences(text) {
  const parts = sentenceRanges(text).map((r) => text.slice(r.start, r.end).trim()).filter(Boolean);
  return parts.length > 0 ? parts : [text];
}

// ── Rendered-DOM segmentation: wrap each sentence in <span class="tts-seg"> ──
const BLOCK_TTS = new Set([
  "P", "DIV", "LI", "UL", "OL", "BLOCKQUOTE", "TABLE", "THEAD", "TBODY", "TR", "TD", "TH",
  "H1", "H2", "H3", "H4", "H5", "H6", "HR", "PRE", "FIGURE", "SECTION", "ARTICLE",
]);

// Returns how an element is handled by the speech walker:
//  "math"    → spoken as a description of its LaTeX (data-tts-tex); the whole
//              formula is one highlight unit. Inline stays in-sentence; block is its own.
//  "break"   → not spoken, acts as a sentence boundary (code block, diagram)
//  "nobreak" → not spoken, does NOT split the surrounding sentence (stray inline math)
//  null      → spoken normally (incl. inline <code>, <strong>, <a> …)
function skipMode(el) {
  if (el.classList.contains("tts-math")) return "math";
  const tag = el.tagName;
  if (tag === "PRE" || tag === "SVG") return "break";
  if (el.classList.contains("katex-block") || el.classList.contains("mermaid")) return "break";
  if (el.classList.contains("katex")) return "nobreak";
  // Injected 💬 highlight-note marker: not part of the spoken message text.
  if (el.classList.contains("hlNoteMark")) return "nobreak";
  return null;
}

// Flatten a rendered markdown body into plain text + a position→textNode map,
// inserting \n at block / <br> boundaries (mirrors innerText layout) and
// skipping non-spoken content (code blocks, math, diagrams).
function buildFlatText(root) {
  let flat = "";
  const map = []; // map[pos] = { node, offset } — only for real text-node chars
  const mathAtoms = []; // { el, start, end } — formula speech text spans in flat
  const nl = () => { if (flat && !flat.endsWith("\n")) flat += "\n"; };
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        const text = child.textContent;
        for (let k = 0; k < text.length; k++) {
          map[flat.length] = { node: child, offset: k };
          flat += text[k];
        }
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const sk = skipMode(child);
        if (sk === "math") {
          const tex = child.dataset.ttsTex || "";
          const spoken = tex ? mathToSpeech(tex) : "";
          const block = child.tagName === "DIV";
          if (block) nl();
          if (spoken) {
            // No map entries: these chars are spoken but not backed by a text
            // node; the whole formula element is the highlight unit (segmentBody).
            mathAtoms.push({ el: child, start: flat.length, end: flat.length + spoken.length });
            flat += spoken;
          }
          if (block) nl();
          continue;
        }
        if (sk === "break") { nl(); continue; }
        if (sk === "nobreak") continue;
        if (child.tagName === "BR") { nl(); continue; }
        const isBlock = BLOCK_TTS.has(child.tagName);
        if (isBlock) nl();
        walk(child);
        if (isBlock) nl();
      }
    }
  };
  walk(root);
  return { flat, map, mathAtoms };
}

// Wrap each sentence of a rendered markdown body in <span class="tts-seg"
// data-seg="N">. A sentence spanning multiple text nodes yields several spans
// sharing the same data-seg. Returns segment texts in server-input order.
function segmentBody(bodyEl) {
  const { flat, map, mathAtoms } = buildFlatText(bodyEl);
  const ranges = sentenceRanges(flat);
  if (!ranges.length) return [];

  // Formula elements aren't text nodes — tag each whole formula with the seg
  // its spoken description falls into, so it highlights with its sentence.
  for (const atom of mathAtoms) {
    const seg = ranges.findIndex((r) => atom.start >= r.start && atom.start < r.end);
    if (seg >= 0) {
      atom.el.classList.add("tts-seg");
      atom.el.dataset.seg = String(seg);
    }
  }

  // Per text node, collect the (offset) sub-ranges to wrap, so each node is
  // replaced exactly once (replacing it would invalidate later node refs).
  const nodeOps = new Map();
  ranges.forEach((r, seg) => {
    let k = r.start;
    while (k < r.end) {
      const m = map[k];
      if (!m) { k++; continue; }
      const node = m.node;
      let end = k, lastOffset = m.offset;
      while (
        end + 1 < r.end && map[end + 1] &&
        map[end + 1].node === node && map[end + 1].offset === lastOffset + 1
      ) { end++; lastOffset++; }
      if (!nodeOps.has(node)) nodeOps.set(node, []);
      nodeOps.get(node).push({ start: m.offset, end: lastOffset + 1, seg });
      k = end + 1;
    }
  });

  for (const [node, ops] of nodeOps) {
    ops.sort((a, b) => a.start - b.start);
    const text = node.textContent;
    const frag = document.createDocumentFragment();
    let pos = 0;
    for (const op of ops) {
      if (op.start > pos) frag.appendChild(document.createTextNode(text.slice(pos, op.start)));
      const span = document.createElement("span");
      span.className = "tts-seg";
      span.dataset.seg = String(op.seg);
      span.textContent = text.slice(op.start, op.end);
      frag.appendChild(span);
      pos = op.end;
    }
    if (pos < text.length) frag.appendChild(document.createTextNode(text.slice(pos)));
    node.parentNode.replaceChild(frag, node);
  }

  return ranges.map((r) => flat.slice(r.start, r.end));
}

// Play one synthesized sentence (blob URL) to completion. Resolves on ended /
// error / abort — never rejects, so the reading loop always advances. The
// abort listener pauses playback, which is how stopSpeech interrupts audio.
function playUrl(url, signal) {
  return new Promise((resolve) => {
    const audio = new Audio(url);
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    const onAbort = () => {
      audio.pause();
      audio.src = "";
      done();
    };
    signal.addEventListener("abort", onAbort);
    audio.addEventListener("ended", done);
    audio.addEventListener("error", done);
    audio.play().catch(done);
  });
}

function highlightSegment(bodyEl, segIndex) {
  bodyEl.querySelectorAll(".tts-seg.tts-active").forEach((el) => el.classList.remove("tts-active"));
  const spans = bodyEl.querySelectorAll(`.tts-seg[data-seg="${segIndex}"]`);
  spans.forEach((el) => el.classList.add("tts-active"));
  if (spans.length) spans[0].scrollIntoView({ behavior: "smooth", block: "nearest" });
}

export async function speakMessage(content, button) {
  if (button === state.activeSpeechButton) {
    stopSpeech();
    return;
  }

  stopSpeech();
  const messageEl = button.closest(".message");
  let bodyEl = messageEl?.querySelector(":scope > .markdownBody");

  // Segment the rendered DOM into sentences and wrap each in a <span class="tts-seg">,
  // so highlighting is a class toggle on a stable anchor (no per-sentence re-render,
  // and code/math/diagrams are skipped instead of corrupting offsets).
  let sentences;
  if (bodyEl) {
    bodyEl.dataset.originalHtml = bodyEl.innerHTML;
    sentences = segmentBody(bodyEl);
    if (!sentences.length) {
      // Nothing wrappable (pure code / diagram): fall back without highlighting.
      delete bodyEl.dataset.originalHtml;
      sentences = splitSentences(bodyEl.innerText.trim());
      bodyEl = null;
    }
  } else {
    sentences = splitSentences(markdownToSpeechText(content));
  }
  if (!sentences.length) return;

  const voice = getChineseVoice();
  const rate = parseFloat(dom.speechRateInput.value) || 1;

  state.activeSpeechButton = button;
  state.activeSpeechButton.textContent = t("btn_stop");
  state.activeSpeechButton.classList.add("isSpeaking");

  state.speechAbortController = new AbortController();
  const signal = state.speechAbortController.signal;

  // Fetch one sentence's audio from the server. null on failure / nothing
  // speakable (204) — the loop skips that sentence but keeps highlighting.
  const fetchAudio = (text) =>
    fetch("/api/speak-audio", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, voice, rate }),
      signal,
    })
      .then((r) => (r.ok && r.status !== 204 ? r.blob() : null))
      .then((blob) => (blob && blob.size ? URL.createObjectURL(blob) : null))
      .catch(() => null);

  // Prefetch pipeline: while sentence i plays in the browser, sentence i+1 is
  // already synthesizing on the server — no per-sentence gap, and audio comes
  // to THIS machine (frontend and backend may be different hosts).
  let next = fetchAudio(sentences[0]);
  for (let i = 0; i < sentences.length; i++) {
    const url = await next;
    if (signal.aborted) {
      if (url) URL.revokeObjectURL(url);
      return;
    }
    next = i + 1 < sentences.length ? fetchAudio(sentences[i + 1]) : null;
    if (bodyEl) highlightSegment(bodyEl, i);
    if (url) {
      await playUrl(url, signal);
      URL.revokeObjectURL(url);
      if (signal.aborted) return;
    }
  }
  stopSpeech(); // natural finish: restores the un-segmented DOM + button label
}

// One unified voice selector drives BOTH reading (朗读 button) and /voice
// generation. Values are engine-prefixed: "say:<name>" (macOS system voice) or
// "kokoro:" (local neural, also downloadable). The chosen engine determines
// how the server synthesizes; playback always happens in the browser.
export function populateVoiceList() {
  Promise.all([
    fetch("/api/voices").then(r => r.json()).catch(() => ({ voices: [] })),
    fetch("/api/tts-voices").then(r => r.json()).catch(() => ({ voices: [] })),
  ]).then(([sysData, ttsData]) => {
    const prevValue = dom.voiceSelect.value; // preserve current pick on re-populate
    dom.voiceSelect.length = 0; // rebuild all options (no "auto" entry)

    const sysVoices = (sysData.voices || []).filter(v => /^zh/i.test(v.lang));
    if (sysVoices.length) {
      const grp = document.createElement("optgroup");
      grp.label = t("voice_group_system");
      for (const v of sysVoices) {
        const opt = document.createElement("option");
        opt.value = `say:${v.name}`;
        opt.textContent = `${v.name} (${v.lang})`;
        grp.appendChild(opt);
      }
      dom.voiceSelect.appendChild(grp);
    }

    // Neural voices, grouped by engine (kokoro), with localized labels.
    const ttsVoices = ttsData.voices || [];
    const byEngine = {};
    for (const v of ttsVoices) (byEngine[v.engine] = byEngine[v.engine] || []).push(v);
    for (const engine of Object.keys(byEngine)) {
      const grp = document.createElement("optgroup");
      grp.label = engine === "kokoro" ? t("voice_group_kokoro") : engine;
      for (const v of byEngine[engine]) {
        const opt = document.createElement("option");
        opt.value = v.value;
        opt.textContent = voiceOptionLabel(v);
        grp.appendChild(opt);
      }
      dom.voiceSelect.appendChild(grp);
    }

    // Restore the current pick (re-populate) or the saved one; migrate old bare
    // say names → "say:" prefix.
    const saved = JSON.parse(localStorage.getItem("local-ai-companion-settings") || "{}");
    let want = prevValue || saved.voiceName || "";
    if (want && !want.includes(":")) want = `say:${want}`;
    if (want && dom.voiceSelect.querySelector(`option[value="${CSS.escape(want)}"]`)) {
      dom.voiceSelect.value = want;
    }
  }).catch(() => {});
}