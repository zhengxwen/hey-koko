// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile, spawn } = require("child_process");
const { sendJson, readBody, findCommand } = require("./utils");
const config = require("./config");
const claude = require("./claude");
const openai = require("./openai");

async function fetchUrlContent(req, res) {
  try {
    const body = await readBody(req);
    const { url, language } = body;
    if (!url) { sendJson(res, 400, { error: "url is required" }); return; }

    let parsed;
    try { parsed = new URL(url); } catch { sendJson(res, 400, { error: "Invalid URL" }); return; }
    if (!["http:", "https:"].includes(parsed.protocol)) { sendJson(res, 400, { error: "Only http/https supported" }); return; }

    // Check if YouTube
    const ytMatch = url.match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|live\/|embed\/)|youtu\.be\/)([\w-]{11})/);
    if (ytMatch) {
      const videoId = ytMatch[1];
      const transcript = await fetchYouTubeTranscript(videoId, language);
      if (transcript) {
        const thumbnail = await fetchYouTubeThumbnail(videoId);
        sendJson(res, 200, {
          type: "youtube", videoId, title: transcript.title,
          channel: transcript.channel || "",
          duration: transcript.duration || "",
          viewCount: transcript.viewCount || "",
          uploadDate: transcript.uploadDate || "",
          description: transcript.description || "",
          content: transcript.text,
          thumbnail: thumbnail || "",
        });
        return;
      }
      // Fallback to page fetch if transcript fails
    }

    // General URL fetch
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const response = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; LocalAIChat/1.0)" },
      signal: controller.signal,
      redirect: "follow",
    });
    clearTimeout(timeout);

    if (!response.ok) { sendJson(res, 200, { type: "error", content: `HTTP ${response.status}: ${response.statusText}` }); return; }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html") && !contentType.includes("text/plain") && !contentType.includes("application/json")) {
      sendJson(res, 200, { type: "unsupported", content: `不支持的内容类型: ${contentType}` });
      return;
    }

    const html = await response.text();
    const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]?.trim() || "";
    const { text, imageUrls } = await extractCleanContent(html, url);
    const images = await downloadImages(imageUrls, url, 8);
    const truncated = truncateContent(text, config.URL_CONTENT_MAX_CHARS);
    sendJson(res, 200, { type: "webpage", title, url, content: truncated, images });
  } catch (error) {
    if (error.name === "AbortError") {
      sendJson(res, 200, { type: "error", content: "请求超时" });
    } else {
      sendJson(res, 500, { error: "获取 URL 内容失败", detail: error.message });
    }
  }
}

// Cap content length, cutting at a clean boundary (paragraph > line > word)
// rather than mid-character. 0 / negative max means no limit.
function truncateContent(text, max) {
  if (!max || max <= 0 || text.length <= max) return text;
  let cut = text.slice(0, max);
  const para = cut.lastIndexOf("\n\n");
  if (para > max * 0.6) {
    cut = cut.slice(0, para);
  } else {
    const nl = cut.lastIndexOf("\n");
    if (nl > max * 0.8) cut = cut.slice(0, nl);
    else { const sp = cut.lastIndexOf(" "); if (sp > 0) cut = cut.slice(0, sp); }
  }
  return cut.trimEnd() + "\n\n…（内容较长，已截断）";
}

// ---- Main-content extraction (readability-style heuristic, zero-dependency) ----

// class/id tokens that signal junk (nav, ads, comments, related, ...) vs. real article body
const JUNK_RE = /(^|[-_ ])(nav|navbar|menu|sidebar|side-bar|footer|header|masthead|comment|share|social|related|recommend|promo|sponsor|ad|ads|advert|banner|cookie|consent|popup|modal|subscribe|newsletter|breadcrumb|pagination|paginate|widget|byline|author-box|tags?)([-_ s]|\d|$)/i;
const GOOD_RE = /(^|[-_ ])(article|articlebody|post|postbody|entry|content|story|storybody|main|body|text|prose|markdown|rich-text)([-_ ]|\d|$)/i;

// Extract a balanced element starting at the '<' of its opening tag.
// Returns { inner, outer, openTag } or null if unbalanced / self-closing.
function extractBalanced(html, tagName, openStart) {
  const openEnd = html.indexOf(">", openStart);
  if (openEnd === -1) return null;
  if (html[openEnd - 1] === "/") return null; // self-closing, no content
  const re = new RegExp(`<(/?)${tagName}\\b[^>]*?(/?)>`, "gi");
  re.lastIndex = openEnd + 1;
  let depth = 1, m;
  while ((m = re.exec(html)) !== null) {
    if (m[1] === "/") {
      if (--depth === 0) {
        return {
          openTag: html.slice(openStart, openEnd + 1),
          inner: html.slice(openEnd + 1, m.index),
          outer: html.slice(openStart, re.lastIndex),
        };
      }
    } else if (m[2] !== "/") {
      depth++;
    }
  }
  return null;
}

// Find balanced elements of a tag. openTagFilter (optional) skips expensive
// balanced extraction unless the opening tag passes a cheap test.
function findElements(html, tagName, openTagFilter) {
  const re = new RegExp(`<${tagName}\\b[^>]*>`, "gi");
  const out = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    if (openTagFilter && !openTagFilter(m[0])) continue;
    const el = extractBalanced(html, tagName, m.index);
    if (el) out.push(el);
  }
  return out;
}

function getAttr(openTag, name) {
  const m = openTag.match(new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, "i"));
  return m ? m[1] : "";
}

// Text vs. link-text metrics for a chunk of HTML.
function textMetrics(html) {
  const linkText = (html.match(/<a\b[^>]*>[\s\S]*?<\/a>/gi) || [])
    .join(" ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const allText = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const textLen = allText.length;
  return { textLen, linkDensity: textLen ? linkText.length / textLen : 1 };
}

// Pick the HTML subtree most likely to be the article body.
function extractMainContentHtml(html) {
  // 1. Strip structurally-junk elements outright.
  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
    .replace(/<svg[\s\S]*?<\/svg>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<header[\s\S]*?<\/header>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<aside[\s\S]*?<\/aside>/gi, "")
    .replace(/<form[\s\S]*?<\/form>/gi, "");

  // 2. Gather candidate containers and score them.
  const candidates = [];
  const addCandidate = (innerHtml, weight) => {
    const m = textMetrics(innerHtml);
    if (m.textLen >= 200 && m.linkDensity < 0.5) {
      candidates.push({ html: innerHtml, score: m.textLen * weight });
    }
  };
  for (const el of findElements(cleaned, "article")) addCandidate(el.inner, 1.5);
  for (const el of findElements(cleaned, "main")) addCandidate(el.inner, 1.3);
  const goodContainer = (openTag) => {
    const cls = getAttr(openTag, "class") + " " + getAttr(openTag, "id");
    return GOOD_RE.test(cls) && !JUNK_RE.test(cls);
  };
  for (const el of findElements(cleaned, "div", goodContainer)) addCandidate(el.inner, 1.2);
  for (const el of findElements(cleaned, "section", goodContainer)) addCandidate(el.inner, 1.2);

  candidates.sort((a, b) => b.score - a.score);
  if (candidates.length) return candidates[0].html;

  // 3. Fallback: gather all low-link-density paragraphs (readability's safety net).
  const paras = (cleaned.match(/<p\b[^>]*>[\s\S]*?<\/p>/gi) || [])
    .filter((p) => textMetrics(p).linkDensity < 0.5);
  if (paras.join("").replace(/<[^>]+>/g, "").trim().length >= 200) return paras.join("\n");

  // 4. Last resort: whole cleaned <body>.
  const body = cleaned.match(/<body\b[^>]*>([\s\S]*)<\/body>/i);
  return body ? body[1] : cleaned;
}

// Convert article HTML to clean Markdown. Uses pandoc when available
// (matches the project's existing optional-CLI pattern: yt-dlp/whisper/ffmpeg),
// otherwise falls back to a built-in lightweight converter.
async function htmlToMarkdown(html) {
  const pandoc = await findCommand("pandoc");
  if (pandoc) {
    const md = await new Promise((resolve) => {
      const proc = execFile(pandoc,
        ["-f", "html", "-t", "gfm-raw_html", "--wrap=none"],
        { maxBuffer: 20 * 1024 * 1024, timeout: 15000 },
        (err, stdout) => resolve(err || !stdout ? null : stdout.trim()));
      try { proc.stdin.write(html); proc.stdin.end(); } catch { resolve(null); }
    });
    if (md) return md.replace(/\n{3,}/g, "\n\n");
  }
  return htmlToMarkdownBuiltin(html);
}

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&#39;/g, "'").replace(/&quot;/g, '"');
}

function stripTags(html) {
  return decodeEntities(html.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

// Lightweight HTML→Markdown fallback (used when pandoc isn't installed).
function htmlToMarkdownBuiltin(html) {
  const md = html
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, "")
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n, t) => `\n\n${"#".repeat(+n)} ${stripTags(t)}\n\n`)
    .replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_, t) => `- ${stripTags(t)}\n`)
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, _g, t) => `**${stripTags(t)}**`)
    .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, _g, t) => `*${stripTags(t)}*`)
    .replace(/<a\b[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, t) => {
      const text = stripTags(t);
      return text ? `[${text}](${href})` : "";
    })
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|tr|blockquote|section|article)>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ");
  return decodeEntities(md)
    .replace(/[^\S\n]+/g, " ")
    .replace(/\n[^\S\n]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Full pipeline: raw HTML → clean Markdown article text (with lightweight image
// placeholders) + the list of real image URLs found. Shared by the /url endpoint
// (which downloads the images) and /search --deep (text only). See helpers below.
async function extractCleanContent(html, baseUrl) {
  const articleHtml = extractMainContentHtml(html);
  const markdown = await htmlToMarkdown(rewriteArticleImages(articleHtml, baseUrl));
  const cleaned = cleanupMarkdown(markdown);
  const imageUrls = [...cleaned.matchAll(/!\[[^\]]*\]\(([^)\s]+)[^)]*\)/g)].map((m) => m[1]);
  let text = cleaned.replace(/!\[([^\]]*)\]\([^)]*\)/g, (_, alt) => {
    const a = (alt || "").trim();
    if (UI_ICON_ALT_RE.test(a)) return ""; // drop UI-icon images entirely
    return a && a.length <= 60 ? `［图片：${a}］` : "［图片］";
  });
  text = removeRelatedCardBlocks(removeRelatedWidgets(cutTrailingSections(text)))
    // collapse runs of adjacent image placeholders (e.g. photo galleries) into one
    .replace(/(［图片[^］]*］)(\s*\n\s*［图片[^］]*］)+/g, "$1")
    .replace(/\n{3,}/g, "\n\n");
  return { text, imageUrls };
}

// ---- In-article noise cleanup + image handling ----

// Standalone UI/chrome lines that publishers inject inside the article body.
const SHARE_LINE_RE = /^(share|save|tweet|facebook|threads?|whatsapp|linkedin|reddit|pinterest|telegram|bluesky|mastodon|flipboard|email|messenger|copy( link)?|copied|link copied!?|link|x|twitter|mailto|follow(\s+us)?|advertisement|advertising|sponsored|sign in|sign up|log ?in|subscribe|newsletter|listen(\s*\(\d+\s*mins?\))?|click here to share( on social media)?|add\s+.{1,30}\s+on\s+google|print|comments?|read more|related|most read|popular|trending|watch live|menu|skip to (content|main content)|view image in fullscreen|enable javascript|loading…?|loading\.\.\.)[\s·!:]*$/i;
// Photo-credit fragments (short, agency name, not a real sentence).
const CREDIT_LINE_RE = /(getty images|gettyimages|\bgetty\b|reuters|\bafp\b|ap photo|associated press|bloomberg|\bepa(-efe)?\b|shutterstock|\bntb\b|\bzuma\b|anadolu( agency)?|\bpa media\b|\beyevine\b)/i;
// Lazy-load placeholders / tracking pixels we never want to download.
const PLACEHOLDER_IMG_RE = /(grey|gray)-placeholder|blank\.(gif|png|jpe?g)|spacer|1x1|\/transparent|placeholder\.|loading\.(gif|png|svg)|data:image\/(gif|svg)/i;

// Strip the residual in-article chrome (share buttons, ad labels, photo credits).
function cleanupMarkdown(md) {
  // Drop empty (icon-only) links first, keeping empty-alt images. Doing this
  // before the line filter exposes orphaned labels like "twitter [](…)" → "twitter".
  md = md.replace(/(?<!!)\[\]\([^)]*\)/g, "")
    // strip pandoc artifacts: attribute annotations ({.class}/{#id}) and the
    // literal [TABLE] placeholder pandoc emits for GFM-unrepresentable tables
    .replace(/[ \t]*\{[.#][^}\n]{0,80}\}/g, "");
  const out = [];
  for (const raw of md.split("\n")) {
    const line = raw.trim();
    // normalize list bullets, emphasis, and single-link wrappers before matching
    // (so "- **Flipboard**" and "[Tweet](url)" are recognized as chrome too)
    let bare = line.replace(/^[-*>]\s+/, "").replace(/^\*+\s*|\s*\*+$/g, "").replace(/^_+|_+$/g, "").trim();
    const linkOnly = bare.match(/^\[([^\]]*)\]\([^)]*\)$/);
    if (linkOnly) bare = linkOnly[1].trim();
    if (SHARE_LINE_RE.test(bare)) continue;
    // screen-reader list scaffolding around related-link widgets
    if (/^list of \d+ items?$/i.test(line) || /^end of list$/i.test(line)) continue;
    // reading-time metadata ("9 MIN READ")
    if (/^\d+\s*min read$/i.test(line)) continue;
    // pandoc's placeholder for tables it can't render as GFM
    if (/^\[TABLE\]$/.test(line)) continue;
    // image-gallery counters: "1 of 9", "3 of 9 |"
    if (/^\d+\s+of\s+\d+\s*\\?\|?$/i.test(line)) continue;
    // empty list bullets / icon-only share links: "-", "- [](#)", "[](url)"
    if (/^[-*]\s*$/.test(line)) continue;
    if (/^([-*]\s+)?\[\]\([^)]*\)$/.test(line)) continue;
    if (line && line.length < 60 && CREDIT_LINE_RE.test(line) && !/[.。!?！？]\s+\S/.test(line)) continue;
    out.push(raw);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// Trailing "recommended / related / more from" sections that publishers append
// after the article body. Cut everything from such a header onward (only in the
// latter part of the text, so an early in-body mention isn't mistaken for it).
const SECTION_CUT_RE = /^#{0,6}\s*(related stories|related articles|related|recommended( for you| stories)?|more from|more stories|read more|most popular|most read|trending now|trending|you might (also )?like|in case you missed it|sign up for|subscribe to)\s*:?\s*$/i;
function cutTrailingSections(text) {
  const lines = text.split("\n");
  const start = Math.floor(lines.length * 0.4);
  const isProse = (l) => {
    const t = l.trim();
    return t.length > 120 && !/^[-*>#]/.test(t) && !/^\[[^\]]*\]\([^)]*\)$/.test(t);
  };
  for (let i = start; i < lines.length; i++) {
    if (SECTION_CUT_RE.test(lines[i].trim())) {
      // only cut if little real prose follows (else it's a mid-article widget, not a trailing section)
      if (lines.slice(i + 1).filter(isProse).length <= 1) return lines.slice(0, i).join("\n").trim();
    }
  }
  return text;
}

// Remove related/recommended widgets: runs of link-only list items (and any
// rec/related heading right above them). Works anywhere in the body, so a
// mid-article widget is removed without dropping the text that follows it.
function removeRelatedWidgets(text) {
  const lines = text.split("\n");
  const drop = new Array(lines.length).fill(false);
  for (let i = 0; i < lines.length; i++) {
    if (!/^[-*]\s+/.test(lines[i].trim())) continue;
    let j = i;
    const items = [];
    while (j < lines.length) {
      const t = lines[j].trim();
      if (/^[-*]\s+/.test(t)) { items.push(t); j++; }
      else if (t === "") { j++; }
      else break;
    }
    const allLinks = items.length >= 2 && items.every((it) => {
      const item = it.replace(/^[-*]\s+/, "").replace(/^list \d+ of \d+/i, "").trim();
      return /^\[[^\]]*\]\([^)]*\)$/.test(item);
    });
    if (allLinks) {
      for (let k = i; k < j; k++) drop[k] = true;
      for (let p = i - 1; p >= 0; p--) { // also drop a preceding rec/related heading
        const pt = lines[p].trim();
        if (pt === "") { drop[p] = true; continue; }
        if (SECTION_CUT_RE.test(pt)) drop[p] = true;
        break;
      }
      i = j - 1;
    }
  }
  return lines.filter((_, i) => !drop[i]).join("\n");
}

// Remove related/recommended "card" blocks: a rec heading followed by a run of
// image / standalone-link lines (the cards), stopping at the first real prose
// line — so a mid-article rec box is removed without eating the continuation.
function removeRelatedCardBlocks(text) {
  const lines = text.split("\n");
  const drop = new Array(lines.length).fill(false);
  const isCardLine = (t) =>
    t === "" ||
    /^［图片[^］]*］$/.test(t) ||
    /^[-*]?\s*\[[^\]]*\]\([^)]*\)$/.test(t); // standalone or bulleted link
  for (let i = 0; i < lines.length; i++) {
    if (!SECTION_CUT_RE.test(lines[i].trim())) continue;
    let j = i + 1, sawCard = false;
    while (j < lines.length && isCardLine(lines[j].trim())) {
      if (lines[j].trim() !== "") sawCard = true;
      j++;
    }
    if (sawCard) for (let k = i; k < j; k++) drop[k] = true;
  }
  return lines.filter((_, i) => !drop[i]).join("\n");
}

// Image alt text that marks a UI icon rather than real content.
const UI_ICON_ALT_RE = /^(comments?|share|save|menu|search|logo|advertisement|play|video|image|icon|avatar|close|next|previous|prev)$/i;

function imgAttr(tag, name) {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "i"));
  return m ? m[1].trim() : "";
}

// Pick the highest-resolution candidate from a srcset ("url 320w, url 640w" / "url 1x, url 2x").
function pickFromSrcset(srcset) {
  let best = null, bestScore = -1;
  for (const part of srcset.split(",")) {
    const seg = part.trim().split(/\s+/);
    if (!seg[0]) continue;
    const score = parseFloat(seg[1]) || 1;
    if (score >= bestScore) { bestScore = score; best = seg[0]; }
  }
  return best;
}

// Resolve the real image URL from an <img> tag, preferring lazy-load attributes.
function resolveImgUrl(tag, baseUrl) {
  let src = imgAttr(tag, "data-src") || imgAttr(tag, "data-original") ||
            imgAttr(tag, "data-lazy-src") || imgAttr(tag, "data-hi-res-src") || "";
  if (!src) {
    const ss = imgAttr(tag, "data-srcset") || imgAttr(tag, "srcset");
    if (ss) src = pickFromSrcset(ss);
  }
  if (!src) src = imgAttr(tag, "src");
  if (!src) return null;
  try { src = new URL(src, baseUrl).href; } catch { return null; }
  if (src.startsWith("data:") || PLACEHOLDER_IMG_RE.test(src)) return null;
  return src;
}

// Rewrite <img> tags to their real URLs (and drop placeholders) before pandoc runs.
function rewriteArticleImages(html, baseUrl) {
  return html.replace(/<img\b[^>]*>/gi, (tag) => {
    const url = resolveImgUrl(tag, baseUrl);
    if (!url) return "";
    const alt = imgAttr(tag, "alt").replace(/"/g, "").slice(0, 120);
    return `<img src="${url}" alt="${alt}">`;
  });
}

// Download article images server-side and return them as data URIs (display-only;
// kept out of the text so they never enter the LLM context).
async function downloadImages(urls, referer, max) {
  const out = [];
  const seen = new Set();
  for (const u of urls) {
    if (out.length >= max) break;
    if (seen.has(u)) continue;
    seen.add(u);
    try {
      const res = await fetch(u, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; LocalAIChat/1.0)",
          "Referer": referer,
          "Accept": "image/avif,image/webp,image/*,*/*;q=0.8",
        },
        signal: AbortSignal.timeout(8000),
        redirect: "follow",
      });
      if (!res.ok) continue;
      const ct = (res.headers.get("content-type") || "").split(";")[0].trim();
      if (!ct.startsWith("image/") || ct === "image/svg+xml") continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 3000 || buf.length > 5 * 1024 * 1024) continue; // skip trackers / oversized
      out.push(`data:${ct};base64,${buf.toString("base64")}`);
    } catch { /* skip unreachable images */ }
  }
  return out;
}

async function fetchYouTubeThumbnail(videoId) {
  // Quality order: maxres (1920x1080) > sd (640x480) > hq (480x360)
  const urls = [
    `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
    `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
    `https://img.youtube.com/vi/${videoId}/sddefault.jpg`,
    `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      // YouTube returns a small grey placeholder (~1-2KB) if resolution unavailable
      if (buf.length < 5000) continue;
      return `data:image/jpeg;base64,${buf.toString("base64")}`;
    } catch { /* try next */ }
  }
  return null;
}

async function fetchYouTubeTranscript(videoId, language) {
  // Method 1: Try yt-dlp if available (most reliable)
  const ytdlpResult = await fetchTranscriptViaYtdlp(videoId, language);
  if (ytdlpResult) return ytdlpResult;

  // Method 2: Scrape from page HTML
  try {
    const consentCookie = "SOCS=CAISNQgDEitib3FfaWRlbnRpdHlmcm9udGVuZHVpc2VydmVyXzIwMjMxMjE5LjA5X3AxGgJlbiACGgYIgJnmqwY";
    const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7",
        "Cookie": consentCookie,
      },
    });
    const pageHtml = await pageRes.text();

    const title = (pageHtml.match(/<title>(.*?)<\/title>/) || [])[1]?.replace(" - YouTube", "").trim() || "";

    // Extract ytInitialPlayerResponse JSON using brace counting
    let playerData = null;
    const marker = "ytInitialPlayerResponse";
    const startIdx = pageHtml.indexOf(marker);
    if (startIdx === -1) return null;
    const jsonStart = pageHtml.indexOf("{", startIdx);
    if (jsonStart === -1) return null;

    let depth = 0;
    let jsonEnd = -1;
    for (let i = jsonStart; i < pageHtml.length && i < jsonStart + 500000; i++) {
      if (pageHtml[i] === "{") depth++;
      else if (pageHtml[i] === "}") {
        depth--;
        if (depth === 0) { jsonEnd = i + 1; break; }
      }
    }
    if (jsonEnd === -1) return null;

    try { playerData = JSON.parse(pageHtml.slice(jsonStart, jsonEnd)); } catch { return null; }

    // Extract metadata from videoDetails
    const vd = playerData?.videoDetails || {};
    const mf = playerData?.microformat?.playerMicroformatRenderer || {};
    const channel = vd.author || "";
    const viewCount = vd.viewCount || "";
    const lengthSeconds = parseInt(vd.lengthSeconds || "0", 10);
    const duration = lengthSeconds > 0
      ? `${Math.floor(lengthSeconds / 60)}:${String(lengthSeconds % 60).padStart(2, "0")}`
      : "";
    // Try microformat first, then meta tag from HTML
    let uploadDate = (mf.publishDate || mf.uploadDate || "").slice(0, 10).replace(/-/g, "");
    if (!uploadDate) {
      const metaDate = pageHtml.match(/<meta[^>]*itemprop="(?:datePublished|uploadDate)"[^>]*content="([^"]+)"/);
      if (metaDate) uploadDate = metaDate[1].slice(0, 10).replace(/-/g, "");
    }
    if (!uploadDate) {
      const metaDate2 = pageHtml.match(/"publishDate"\s*:\s*"(\d{4}-\d{2}-\d{2})"/);
      if (metaDate2) uploadDate = metaDate2[1].replace(/-/g, "");
    }
    const description = vd.shortDescription || "";
    const category = mf.category || "";
    const tags = Array.isArray(vd.keywords) ? vd.keywords : [];
    // The scrape path has no clean audio-language field. The single ASR (auto-generated)
    // track is always in the video's ORIGINAL spoken language, whereas manual tracks are
    // translations (any language) — so prefer the ASR track, else fall back to the first.
    let language = "";

    const captionTracks = playerData?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!captionTracks || captionTracks.length === 0) {
      return { title, channel, duration, viewCount, uploadDate, description, category, tags, language, text: "[该视频无原始字幕]" };
    }
    language = (captionTracks.find(t => t.kind === "asr") || captionTracks[0]).languageCode || "";

    // Select subtitle track based on prompt language preference
    const zhTrack = captionTracks.find(t => /zh/.test(t.languageCode));
    const enTrack = captionTracks.find(t => /en/.test(t.languageCode));
    let track;
    if (language === "zh" || language === "zh-Hant") {
      track = zhTrack || enTrack || captionTracks[0];
    } else if (language === "en") {
      track = enTrack || zhTrack || captionTracks[0];
    } else {
      track = enTrack || zhTrack || captionTracks[0];
    }

    let captionUrl = track.baseUrl;
    if (!captionUrl.startsWith("http")) captionUrl = "https://www.youtube.com" + captionUrl;

    // Fetch captions with cookies
    const setCookies = pageRes.headers.getSetCookie?.() || [];
    const cookieStr = [consentCookie, ...setCookies.map(c => c.split(";")[0])].join("; ");
    const captionRes = await fetch(captionUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Cookie": cookieStr,
        "Referer": `https://www.youtube.com/watch?v=${videoId}`,
      },
    });
    const captionXml = await captionRes.text();

    if (captionXml.length > 0) {
      const segments = [];
      const regex = /<text[^>]*start="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g;
      let match;
      while ((match = regex.exec(captionXml)) !== null) {
        const text = match[2]
          .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
          .replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/<[^>]+>/g, "")
          .replace(/\n/g, " ")
          .trim();
        if (text) segments.push(text);
      }
      // One cue per line — splitTranscript cuts at line boundaries, so a space-joined
      // single line would defeat chunking and feed the WHOLE transcript as one chunk.
      if (segments.length > 0) return { title, channel, duration, viewCount, uploadDate, description, category, tags, language, text: segments.join("\n") };
    }

    // Caption fetch failed
    const langInfo = captionTracks.map(t => t.languageCode).join(", ");
    return { title, channel, duration, viewCount, uploadDate, description, category, tags, language, text: `[字幕获取失败，可用语言: ${langInfo}]` };
  } catch (e) {
    console.error("[yt-transcript] error:", e.message);
    return null;
  }
}

function fetchTranscriptViaYtdlp(videoId, language) {
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  return new Promise((resolve) => {
    // Check if yt-dlp is available
    findCommand("yt-dlp").then((ytdlp) => {
      if (!ytdlp) { resolve(null); return; }

      // Step 1: list available subtitles to pick the best language. `--encoding UTF-8`
      // keeps yt-dlp's stdout UTF-8 on Windows (the frozen exe otherwise emits the ANSI
      // code page and mangles any non-ASCII).
      execFile("yt-dlp", ["--encoding", "UTF-8", "--list-subs", "--skip-download", url],
        { timeout: 30000 }, (err2, stdout) => {
          if (err2 || !stdout) { resolve(null); return; }

          // Parse output: separate "Available subtitles" from auto-generated translations
          const lines = stdout.split("\n");
          const availableIdx = lines.findIndex(l => /Available subtitles/.test(l));
          const subSection = availableIdx >= 0 ? lines.slice(availableIdx + 1) : lines;
          const langLines = subSection.filter(l => /^\s*[\w-]+\s+/.test(l) && /vtt|srt|srv3/.test(l));
          const realLangs = langLines.map(l => l.trim().split(/\s+/)[0]);

          const autoSection = availableIdx >= 0 ? lines.slice(0, availableIdx) : [];
          const autoLangLines = autoSection.filter(l => /^\s*[\w-]+\s+/.test(l) && /vtt|srt|srv3/.test(l));
          const autoLangs = autoLangLines.map(l => l.trim().split(/\s+/)[0]);

          if (realLangs.length === 0 && autoLangs.length === 0) { resolve(null); return; }

          // Pick best language — the video's ORIGINAL language first. yt-dlp marks the
          // speech-recognition source track "xx-orig"; every other auto caption is a
          // machine TRANSLATION of it (a hardcoded zh-first preference used to grab the
          // Chinese machine translation of English videos). The preference list is only
          // a fallback when no -orig marker exists.
          const preferred = ["zh-Hans", "zh-Hant", "zh", "en", "ja"];
          const origAuto = autoLangs.find(l => /-orig$/.test(l));
          const origLang = origAuto ? origAuto.replace(/-orig$/, "") : "";
          let selectedLang = null;

          // Manual subs beat auto captions; among them, the original language beats all.
          if (origLang && realLangs.includes(origLang)) selectedLang = origLang;
          if (!selectedLang) {
            for (const pref of preferred) {
              if (realLangs.includes(pref)) { selectedLang = pref; break; }
            }
          }
          if (!selectedLang && realLangs.length) selectedLang = realLangs[0];
          // Auto captions: the -orig track IS the recognized speech, take it verbatim.
          if (!selectedLang && origAuto) selectedLang = origAuto;
          if (!selectedLang) {
            for (const pref of preferred) {
              if (autoLangs.includes(pref)) { selectedLang = pref; break; }
            }
          }
          if (!selectedLang) selectedLang = autoLangs[0];

          // Step 2: download the selected subtitle
          const tmpDir = path.join(os.tmpdir(), `yt-${videoId}-${Date.now()}`);
          fs.mkdirSync(tmpDir, { recursive: true });

          execFile("yt-dlp", [
            "--write-subs", "--write-auto-sub",
            "--sub-lang", selectedLang,
            "--sub-format", "vtt",
            "--skip-download",
            "-o", path.join(tmpDir, "%(id)s"),
            url,
          ], { timeout: 60000 }, (err3) => {
            try {
              const files = fs.readdirSync(tmpDir).filter(f => f.endsWith(".vtt") || f.endsWith(".srv3") || f.endsWith(".srt"));
              if (files.length === 0) { cleanupDir(tmpDir); resolve(null); return; }

              const content = fs.readFileSync(path.join(tmpDir, files[0]), "utf-8");

              // Parse VTT: extract timestamped segments
              const segments = [];
              const vttLines = content.split("\n");
              let currentTime = "";
              for (let i = 0; i < vttLines.length; i++) {
                const trimmed = vttLines[i].trim();
                if (!trimmed || trimmed.startsWith("WEBVTT") || trimmed.startsWith("Kind:") ||
                    trimmed.startsWith("Language:") || trimmed.startsWith("NOTE") ||
                    /^\d+$/.test(trimmed)) continue;
                const tsMatch = trimmed.match(/^(\d{2}:\d{2}:\d{2})\.\d+ --> /);
                if (tsMatch) {
                  currentTime = tsMatch[1];
                  continue;
                }
                const clean = trimmed.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&")
                  .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
                  .replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim();
                // Rolling auto-captions repeat the previous cue's line — drop CONSECUTIVE
                // repeats only (a global set would also delete legitimate repeated lines
                // spoken minutes apart).
                if (clean && clean !== (segments.length ? segments[segments.length - 1].text : "")) {
                  segments.push({ time: currentTime, text: clean });
                }
              }

              cleanupDir(tmpDir);

              if (segments.length === 0) { resolve(null); return; }

              const plainText = segments.map(s => s.text).join("\n");

              // Get video metadata. `--encoding UTF-8` forces UTF-8 stdout (else the frozen
              // yt-dlp.exe on Windows drops every CJK char from the title/description);
              // `youtube:lang` picks the localized-title language so a zh video isn't served
              // its English title. %(...)j fields (categories/tags) print JSON arrays;
              // description stays LAST because its .500s value may contain newlines.
              const metaLang = ytdlpLangArg(language);
              const metaArgs = ["--encoding", "UTF-8"];
              if (metaLang) metaArgs.push("--extractor-args", `youtube:lang=${metaLang}`);
              metaArgs.push(
                "--print", "%(title)s",
                "--print", "%(channel)s",
                "--print", "%(duration_string)s",
                "--print", "%(view_count)s",
                "--print", "%(upload_date)s",
                "--print", "%(categories)j",
                "--print", "%(tags)j",
                "--print", "%(language)s",
                "--print", "%(description).500s",
                "--skip-download", url,
              );
              execFile("yt-dlp", metaArgs, { timeout: 15000 }, (e, metaOut) => {
                  const metaLines = (metaOut || "").split("\n");
                  const parseArr = (s) => { try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; } };
                  const title = metaLines[0]?.trim() || "";
                  const channel = metaLines[1]?.trim() || "";
                  const duration = metaLines[2]?.trim() || "";
                  const viewCount = metaLines[3]?.trim() || "";
                  const uploadDate = metaLines[4]?.trim() || "";
                  const category = parseArr(metaLines[5])[0] || "";
                  const tags = parseArr(metaLines[6]);
                  let language = (metaLines[7] || "").trim();
                  if (language === "NA") language = "";   // yt-dlp prints NA for a missing field
                  const description = metaLines.slice(8).join("\n").trim() || "";
                  resolve({ title, channel, duration, viewCount, uploadDate, description, category, tags, language, text: plainText });
                }
              );
            } catch (e) {
              cleanupDir(tmpDir);
              resolve(null);
            }
          });
        }
      );
    });
  });
}

function cleanupDir(dir) {
  try {
    const files = fs.readdirSync(dir);
    for (const f of files) fs.unlinkSync(path.join(dir, f));
    fs.rmdirSync(dir);
  } catch {}
}

function cleanupFile(filePath) {
  try { fs.unlinkSync(filePath); } catch {}
}

// Find whisper model file
function findWhisperModel() {
  if (config.whisperModel && fs.existsSync(config.whisperModel)) {
    return config.whisperModel;
  }
  const modelNames = ["ggml-medium.bin", "ggml-base.bin", "ggml-small.bin", "ggml-large-v3.bin", "ggml-tiny.bin"];
  for (const dir of config.WHISPER_MODEL_SEARCH_PATHS) {
    for (const name of modelNames) {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

// Locate whisper-cli: PATH first, then conventional install dirs. whisper-cli is the
// one tool installed by hand (no package manager on Windows — the README's manual
// unzip to %LOCALAPPDATA%\whisper-cpp), and hand-added PATH entries have proven
// unreliable across launch environments — so never depend on PATH alone for it.
async function findWhisperCli() {
  const onPath = await findCommand("whisper-cli");
  if (onPath) return onPath;
  const home = os.homedir();
  const guesses = process.platform === "win32"
    ? [
        // ~/.local/share/whisper-cpp mirrors the model search path — and unlike
        // %LOCALAPPDATA% it is never subject to MSIX filesystem virtualization,
        // so binaries placed there are visible to every launch context.
        path.join(home, ".local", "share", "whisper-cpp", "bin", "whisper-cli.exe"),
        path.join(process.env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "whisper-cpp", "Release", "whisper-cli.exe"),
        path.join(process.env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "whisper-cpp", "whisper-cli.exe"),
      ]
    : [
        "/opt/homebrew/bin/whisper-cli",
        "/usr/local/bin/whisper-cli",
        path.join(home, "whisper.cpp", "build", "bin", "whisper-cli"),
      ];
  for (const g of guesses) {
    try { if (fs.existsSync(g)) return g; } catch { /* keep looking */ }
  }
  return null;
}

// Transcribe YouTube audio via whisper.cpp
function abortError() { const e = new Error("aborted"); e.name = "AbortError"; return e; }

// Normalize a BCP-47-ish code ("zh-Hans", "en-US", "NA") to a whisper "-l" code ("zh",
// "en"). Empty when unusable ("NA"/"und"/garbage) — the caller then falls back to auto.
function whisperLangCode(raw) {
  const c = String(raw || "").trim().split("-")[0].toLowerCase();
  return /^[a-z]{2,3}$/.test(c) && c !== "und" && c !== "na" ? c : "";
}

// Verify the CLI tools + whisper model are present (throws a user-facing message if not).
async function ensureWhisperDeps() {
  const whisperCmd = await findWhisperCli();
  if (!whisperCmd) throw new Error("whisper-cli 未安装。请运行: brew install whisper-cpp");
  const ytdlpCmd = await findCommand("yt-dlp");
  if (!ytdlpCmd) throw new Error("yt-dlp 未安装。请运行: brew install yt-dlp");
  const ffmpegCmd = await findCommand("ffmpeg");
  if (!ffmpegCmd) throw new Error("ffmpeg 未安装。请运行: brew install ffmpeg");
  const modelPath = findWhisperModel();
  if (!modelPath) throw new Error("未找到 whisper 模型文件。请下载: curl -L -o ~/.local/share/whisper-cpp/ggml-medium.bin --create-dirs https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin");
  return { whisperCmd, ytdlpCmd, ffmpegCmd, modelPath };
}

// Callable core: download → convert → whisper-transcribe a YouTube video's audio,
// returns the transcript text. onProgress({status,message,progress}) reports the same
// phase objects the SSE handler used to write; signal aborts (kills child processes +
// cleans up). Shared by the /api/youtube-transcribe SSE shell and the youtube job.
// `language` is a hint for whisper (video metadata language, any BCP-47-ish code).
async function transcribeYouTubeAudioCore(videoId, { onProgress = () => {}, signal, language = "" } = {}) {
  const { whisperCmd, ytdlpCmd, ffmpegCmd, modelPath } = await ensureWhisperDeps();

  // Whisper's "-l auto" detects the language from the FIRST ~30s only — intro music,
  // silence or a foreign-language opening derails the whole transcription. Prefer the
  // caller's metadata language; else best-effort ask yt-dlp for the audio language.
  let lang = whisperLangCode(language);
  if (!lang) {
    lang = whisperLangCode(await new Promise((resolve) => {
      execFile(ytdlpCmd, ["--print", "%(language)s", "--skip-download", "--no-playlist",
        `https://www.youtube.com/watch?v=${videoId}`],
        { timeout: 15000 }, (e, out) => resolve(e ? "" : String(out || "").trim()));
    }));
  }

  const tmpDir = path.join(os.tmpdir(), `yt-whisper-${videoId}-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const audioRaw = path.join(tmpDir, "audio");
  const audioWav = path.join(tmpDir, "converted.wav");

  let aborted = false;
  const childProcesses = [];
  const onAbort = () => { aborted = true; for (const cp of childProcesses) { try { cp.kill("SIGTERM"); } catch {} } };
  if (signal) {
    if (signal.aborted) { cleanupDir(tmpDir); throw abortError(); }
    signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    // Step 1: Download audio
    onProgress({ status: "downloading", message: "正在下载音频..." });
    await new Promise((resolve, reject) => {
      if (aborted) return reject(abortError());
      const proc = spawn(ytdlpCmd, [
        "-x", "--audio-quality", "worst",
        "-o", audioRaw + ".%(ext)s",
        "--no-playlist",
        `https://www.youtube.com/watch?v=${videoId}`,
        // 30 min: 5 min used to kill legitimate audio downloads of long videos on slow
        // links. A truly hung download stays bounded; cancel (signal) kills it anytime.
      ], { timeout: 1800000 });
      childProcesses.push(proc);
      let stderr = "";
      proc.stderr.on("data", (d) => { stderr += d.toString(); });
      proc.on("close", (code) => {
        if (aborted) return reject(abortError());
        if (code !== 0) return reject(new Error(`yt-dlp 失败 (code ${code}): ${stderr.slice(-200)}`));
        resolve();
      });
      proc.on("error", reject);
    });
    if (aborted) throw abortError();

    // Find the downloaded file (yt-dlp may produce .opus, .m4a, .webm, .wav etc.)
    const files = fs.readdirSync(tmpDir).filter(f => f.startsWith("audio") && f !== "converted.wav");
    if (files.length === 0) throw new Error("音频下载失败：未找到下载文件");
    const downloadedFile = path.join(tmpDir, files[0]);
    const fileSizeMB = (fs.statSync(downloadedFile).size / 1024 / 1024).toFixed(1);
    onProgress({ status: "downloaded", message: `音频下载完成（${fileSizeMB} MB）` });

    // Step 2: Convert to 16kHz mono WAV
    onProgress({ status: "converting", message: "正在转换音频格式..." });
    await new Promise((resolve, reject) => {
      if (aborted) return reject(abortError());
      const proc = spawn(ffmpegCmd, [
        "-i", downloadedFile,
        "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le",
        "-y", audioWav,
      ]);
      childProcesses.push(proc);
      proc.on("close", (code) => {
        if (aborted) return reject(abortError());
        if (code !== 0) return reject(new Error(`ffmpeg 转换失败 (code ${code})`));
        resolve();
      });
      proc.on("error", reject);
    });
    if (aborted) throw abortError();

    // Step 3: Transcribe with whisper-cli (timestamps for natural segmentation)
    onProgress({ status: "transcribing", message: "正在语音识别...", progress: "0%" });
    const transcriptText = await new Promise((resolve, reject) => {
      if (aborted) return reject(abortError());
      const proc = spawn(whisperCmd, ["-m", modelPath, "-f", audioWav, "-l", lang || "auto", "--print-progress"]);
      childProcesses.push(proc);
      const outChunks = [];
      let lastProgress = "";
      proc.stdout.on("data", (d) => { outChunks.push(d); });
      proc.stderr.on("data", (d) => {
        // Parse progress from stderr: "whisper_full_with_state: progress = XX%"
        const match = d.toString().match(/progress\s*=\s*(\d+)%/);
        if (match && match[1] !== lastProgress) {
          lastProgress = match[1];
          onProgress({ status: "transcribing", message: `正在语音识别... ${match[1]}%`, progress: `${match[1]}%` });
        }
      });
      proc.on("close", (code) => {
        if (aborted) return reject(abortError());
        if (code !== 0) return reject(new Error(`whisper-cli 转录失败 (code ${code})`));
        // Decode the full stdout once (concat first): per-chunk toString() can split a
        // multi-byte UTF-8 char across chunk boundaries and corrupt CJK transcripts.
        const stdout = Buffer.concat(outChunks).toString("utf-8");
        // Parse timestamped output: "[HH:MM:SS.mmm --> HH:MM:SS.mmm]  text"
        const segments = [];
        for (const line of stdout.split("\n")) {
          const m = line.match(/^\[[\d:.]+\s*-->\s*[\d:.]+\]\s*(.+)/);
          if (m && m[1].trim()) segments.push(m[1].trim());
        }
        resolve(segments.length > 0 ? segments.join("\n") : stdout.trim());
      });
      proc.on("error", reject);
    });
    if (aborted) throw abortError();
    return transcriptText;
  } finally {
    if (signal) { try { signal.removeEventListener("abort", onAbort); } catch {} }
    cleanupDir(tmpDir);
  }
}

// SSE shell (/api/youtube-transcribe) — foreground /url whisper path. Thin wrapper over
// the core: forwards each phase object as an NDJSON line, then a final done/error line.
async function transcribeYouTubeAudio(req, res) {
  let body;
  try { body = await readBody(req); } catch { sendJson(res, 400, { error: "invalid body" }); return; }
  const { videoId } = body;
  if (!videoId || !/^[\w-]{11}$/.test(videoId)) { sendJson(res, 400, { error: "invalid videoId" }); return; }
  res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" });
  const ctrl = new AbortController();
  req.on("close", () => ctrl.abort());
  const send = (obj) => { try { res.write(JSON.stringify(obj) + "\n"); } catch {} };
  try {
    const text = await transcribeYouTubeAudioCore(videoId, { onProgress: send, signal: ctrl.signal });
    send({ status: "done", text });
  } catch (e) {
    if (!ctrl.signal.aborted) send({ status: "error", message: (e && e.message) || "转录失败" });
  } finally {
    try { res.end(); } catch {}
  }
}

// Split a raw transcript into <= limit-char chunks at line boundaries (mirrors the
// browser splitTranscript so server formatting matches the old in-page behavior).
const TRANSCRIPT_CHUNK_LIMIT = 6000;
// Safety net for a single line longer than the limit (e.g. captions that arrived as one
// long line): force-cut it at whitespace/punctuation so it can never become a mega-chunk.
function splitOverlongLine(line, limit) {
  const parts = [];
  while (line.length > limit) {
    let cut = -1;
    for (let j = limit; j > limit * 0.5; j--) {
      if (/[\s。.!?！？，,;；]/.test(line[j])) { cut = j + 1; break; }
    }
    if (cut <= 0) cut = limit;
    parts.push(line.slice(0, cut).trimEnd());
    line = line.slice(cut);
  }
  if (line) parts.push(line);
  return parts;
}
function splitTranscript(text, limit) {
  const chunks = [];
  let current = "";
  for (const line of text.split("\n").flatMap((l) => (l.length > limit ? splitOverlongLine(l, limit) : [l]))) {
    if (current.length + line.length + 1 > limit && current.length > 0) { chunks.push(current); current = line; }
    else current += (current ? "\n" : "") + line;
  }
  if (current) chunks.push(current);
  return chunks;
}

// Prompt/scaffold strings for the transcript formatter, keyed by the user's prompt
// language ("en" | "zh" | "zh-Hant", same codes as the distill table; fallback zh).
// Kept in sync with the browser twin in public/js/url-fetch.js (foreground /url path).
const FORMAT_I18N = {
  zh: {
    system: (title, channel) =>
      "你是字幕整理助手。将原始字幕片段整理为易读文本：添加标点符号、连成完整句子、适当分段；在话题明显切换处插入一行简短的 Markdown 小标题（如「## 小标题」，用字幕本身的语言书写），没有明显切换就不加。不要改变原意，不要添加或省略内容，不要翻译。直接输出整理后的文本，不要加任何前缀说明。"
      + (title ? `\n视频标题：《${title}》` : "") + (channel ? `\n频道：${channel}` : "")
      + (title || channel ? "\n字幕来自自动识别，专有名词可能听错——请结合标题/频道纠正明显的错别字。" : ""),
    first: (i, n, chunk) => `请整理以下字幕片段（第${i}/${n}段），添加标点并分段，不要省略内容：\n\n${chunk}`,
    cont: (i, n, tail, chunk) => `上一段整理结果的结尾（仅供衔接上下文，不要重复输出）：\n…${tail}\n\n请继续整理下一段字幕（第${i}/${n}段），与上文自然衔接，添加标点并分段，不要省略内容：\n\n${chunk}`,
    header: "**📝 整理好的字幕**",
  },
  "zh-Hant": {
    system: (title, channel) =>
      "你是字幕整理助手。將原始字幕片段整理為易讀文本：添加標點符號、連成完整句子、適當分段；在話題明顯切換處插入一行簡短的 Markdown 小標題（如「## 小標題」，用字幕本身的語言書寫），沒有明顯切換就不加。不要改變原意，不要添加或省略內容，不要翻譯。直接輸出整理後的文本，不要加任何前綴說明。"
      + (title ? `\n影片標題：《${title}》` : "") + (channel ? `\n頻道：${channel}` : "")
      + (title || channel ? "\n字幕來自自動識別，專有名詞可能聽錯——請結合標題/頻道糾正明顯的錯別字。" : ""),
    first: (i, n, chunk) => `請整理以下字幕片段（第${i}/${n}段），添加標點並分段，不要省略內容：\n\n${chunk}`,
    cont: (i, n, tail, chunk) => `上一段整理結果的結尾（僅供銜接上下文，不要重複輸出）：\n…${tail}\n\n請繼續整理下一段字幕（第${i}/${n}段），與上文自然銜接，添加標點並分段，不要省略內容：\n\n${chunk}`,
    header: "**📝 整理好的字幕**",
  },
  en: {
    system: (title, channel) =>
      "You are a subtitle cleanup assistant. Turn raw subtitle fragments into readable text: add punctuation, join fragments into complete sentences, and break the text into natural paragraphs. Where the topic clearly changes, insert one short Markdown subheading line (e.g. \"## Topic\", written in the transcript's own language); add none if there is no clear change. Do not change the meaning, do not add or omit content, and do not translate. Output only the cleaned text with no preamble."
      + (title ? `\nVideo title: "${title}"` : "") + (channel ? `\nChannel: ${channel}` : "")
      + (title || channel ? "\nThe transcript comes from automatic speech recognition and may mis-hear proper nouns — use the title/channel to fix obvious errors." : ""),
    first: (i, n, chunk) => `Please clean up the following subtitle fragment (part ${i}/${n}). Add punctuation and paragraphs; do not omit content:\n\n${chunk}`,
    cont: (i, n, tail, chunk) => `End of the previous cleaned part (context only — do not repeat it):\n…${tail}\n\nPlease continue with the next fragment (part ${i}/${n}), flowing naturally from the text above. Add punctuation and paragraphs; do not omit content:\n\n${chunk}`,
    header: "**📝 Formatted transcript**",
  },
};
const fmtL = (language) => FORMAT_I18N[language] || FORMAT_I18N.zh;

// Server-side transcript cleanup: feed the raw transcript to the chat model chunk-by-chunk
// and accumulate the readable result. The prompt (localized via `language`) asks for
// punctuation, paragraphs and topic subheadings; title/channel give the model context to
// fix mis-heard proper nouns. Each continuation carries the tail of the previous cleaned
// chunk so sentences broken at a chunk boundary knit back together.
// onProgress({stage:'formatting',progress:{value,max}}) per chunk; signal aborts the
// in-flight call. Throws on any chunk failure (caller surfaces it).
async function formatTranscriptServer(title, transcript, model, { channel = "", language = "", onProgress = () => {}, signal } = {}) {
  const L = fmtL(language);
  const chunks = splitTranscript(transcript, TRANSCRIPT_CHUNK_LIMIT);
  const total = chunks.length;
  const systemPrompt = L.system(title, channel);
  const nonWs = (s) => String(s).replace(/\s+/g, "").length;
  const callOnce = async (chunkPrompt) => {
    const messages = [{ role: "system", content: systemPrompt }, { role: "user", content: chunkPrompt }];
    // Cloud models: the /api/chat router doesn't sit in this server-side path, so call
    // them directly (non-streaming) instead of local Ollama.
    if (claude.isClaudeModel(model)) return claude.complete(model, messages, { signal });
    if (openai.isOpenAIModel(model)) return openai.complete(model, messages, { temperature: 0.3, signal });
    let chunkText = "";
    const resp = await fetch(`${config.ollamaUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages, options: { temperature: 0.3, num_ctx: config.llmTaskCtx } }),
      signal,
    });
    if (!resp.ok) { const t = await resp.text().catch(() => ""); throw new Error(`字幕整理失败 (${resp.status})${t ? ": " + t.slice(0, 200) : ""}`); }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let o; try { o = JSON.parse(line); } catch { continue; }
        if (o.error) throw new Error(o.error);
        if (o.message && o.message.content) chunkText += o.message.content;
      }
    }
    if (buffer.trim()) { try { const o = JSON.parse(buffer); if (o.message && o.message.content) chunkText += o.message.content; } catch {} }
    return chunkText;
  };
  let fullContent = "";
  for (let i = 0; i < total; i++) {
    // value = chunks ALREADY DONE (0 while working on the 1st) so the progress bar shows
    // real completion (0% on 1/2, 50% on 2/2) instead of jumping to 100% mid-work. The
    // drawer label adds +1 to show the chunk currently being processed (i/n).
    onProgress({ stage: "formatting", progress: { value: i, max: total } });
    const tail = fullContent.trimEnd().slice(-200);
    const chunkPrompt = i === 0 ? L.first(1, total, chunks[i]) : L.cont(i + 1, total, tail, chunks[i]);
    let chunkText = String(await callOnce(chunkPrompt) || "").trim();
    // Anti-summarize guard: cleaned text should be about as long as its raw input; a much
    // shorter result means the model condensed it — retry once and keep the longer answer.
    if (nonWs(chunkText) < nonWs(chunks[i]) * 0.6) {
      try {
        const retry = String(await callOnce(chunkPrompt) || "").trim();
        if (nonWs(retry) > nonWs(chunkText)) chunkText = retry;
      } catch (e) { if (e && e.name === "AbortError") throw e; /* else keep the first attempt */ }
    }
    fullContent += (fullContent ? "\n\n" : "") + chunkText;
  }
  return L.header + "\n\n" + fullContent.trim();
}

// Streaming NDJSON endpoint for the youtube background job (POST /api/youtube-job):
// fetch transcript (or whisper-transcribe) → server-side format → emit {type:'progress'}
// lines throughout + a final {type:'done',result} (or {type:'error'}). Stays HTTP 200 the
// whole time; errors travel as a line (the job runner inspects o.type, not the status).
async function youtubeJob(req, res) {
  let body;
  try { body = await readBody(req); } catch { body = {}; }
  const { url, language, model, prefetch } = body || {};
  res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" });
  const ctrl = new AbortController();
  req.on("close", () => ctrl.abort());
  const send = (obj) => { try { res.write(JSON.stringify(obj) + "\n"); } catch {} };
  // Normalize both progress sources to {type:'progress', stage, progress:{value,max}?}.
  const onProgress = (p) => {
    if (p.stage === "formatting") { send({ type: "progress", stage: "formatting", progress: p.progress }); return; }
    const stage = p.status === "downloaded" ? "downloading" : (p.status || "transcribing");
    let progress;
    if (typeof p.progress === "string") { const m = p.progress.match(/(\d+)/); if (m) progress = { value: Number(m[1]), max: 100 }; }
    send({ type: "progress", stage, progress });
  };
  try {
    const ytMatch = (url || "").match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|live\/|embed\/)|youtu\.be\/)([\w-]{11})/);
    const videoId = ytMatch && ytMatch[1];
    if (!videoId) { send({ type: "error", error: "无效的 YouTube 链接" }); res.end(); return; }
    // The client may have already fetched the metadata (+ subtitles) to render the
    // info card; if so it passes them in `prefetch` so we DON'T fetch twice. We
    // still whisper-transcribe here when no subtitle transcript was provided.
    let meta, thumbnail, rawTranscript, source;
    if (prefetch && (prefetch.title || prefetch.thumbnail || prefetch.rawTranscript)) {
      meta = {
        title: prefetch.title || "", channel: prefetch.channel || "", duration: prefetch.duration || "",
        viewCount: prefetch.viewCount || "", uploadDate: prefetch.uploadDate || "", description: prefetch.description || "",
        category: prefetch.category || "", tags: Array.isArray(prefetch.tags) ? prefetch.tags : [], language: prefetch.language || "",
      };
      thumbnail = prefetch.thumbnail || "";
      if (prefetch.rawTranscript) { rawTranscript = prefetch.rawTranscript; source = "subtitle"; }
    } else {
      meta = await fetchYouTubeTranscript(videoId, language);
      thumbnail = (await fetchYouTubeThumbnail(videoId)) || "";
      const hasReal = meta && meta.text && !meta.text.startsWith("[");
      if (hasReal) { rawTranscript = meta.text; source = "subtitle"; }
    }
    if (!rawTranscript) {
      rawTranscript = await transcribeYouTubeAudioCore(videoId, { onProgress, signal: ctrl.signal, language: (meta && meta.language) || "" });
      source = "whisper";
    }
    let formattedText = "", formatError = "";
    try {
      formattedText = await formatTranscriptServer((meta && meta.title) || "", rawTranscript, model,
        { channel: (meta && meta.channel) || "", language, onProgress, signal: ctrl.signal });
    } catch (e) {
      if (ctrl.signal.aborted) throw e;
      // Formatting failed AFTER a (possibly hour-long) transcription — don't discard the
      // transcript. Return "done" carrying rawTranscript + formatError and let the caller
      // decide: /url shows the raw subtitles, the library import fails loudly instead.
      formatError = (e && e.message) || "字幕整理失败";
    }
    send({ type: "done", result: {
      title: (meta && meta.title) || "", channel: (meta && meta.channel) || "",
      duration: (meta && meta.duration) || "", viewCount: (meta && meta.viewCount) || "",
      uploadDate: (meta && meta.uploadDate) || "", description: (meta && meta.description) || "",
      category: (meta && meta.category) || "", tags: (meta && meta.tags) || [], language: (meta && meta.language) || "",
      thumbnail, videoId, source, rawTranscript, formattedText,
      formatError: formatError || undefined,
    } });
    res.end();
  } catch (e) {
    if (!ctrl.signal.aborted) send({ type: "error", error: (e && e.message) || "youtube job failed" });
    try { res.end(); } catch {}
  }
}

// ---- YouTube channel/playlist expansion (for bulk library import) ------------
// Classify one YouTube URL and return the URL to hand to yt-dlp for a flat listing:
//   - single video (watch?v= / youtu.be/ / shorts/ / embed/) → canonical watch?v=ID,
//     listed as itself (one entry, no playlist expansion);
//   - playlist (list=) → the playlist page (all its videos);
//   - channel (/@handle, /channel/ID, /c/name, /user/name) → that channel's /videos tab.
// Returns null for anything that isn't a recognizable YouTube URL.
function ytFeedUrl(raw) {
  let url;
  try { url = new URL(/^https?:\/\//i.test(raw) ? raw : "https://" + raw); } catch { return null; }
  const host = url.hostname.replace(/^www\./, "").toLowerCase();
  const isYt = host === "youtube.com" || host === "m.youtube.com" || host === "youtu.be";
  if (!isYt) return null;

  // Single video forms → canonical watch?v=ID (drops every extra param, incl. &list=).
  let vid = null;
  if (host === "youtu.be") vid = url.pathname.slice(1).split("/")[0];
  else if (url.searchParams.get("v")) vid = url.searchParams.get("v");
  else { const m = url.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]{11})/); if (m) vid = m[1]; }
  if (vid && /^[\w-]{11}$/.test(vid)) return { kind: "video", feed: `https://www.youtube.com/watch?v=${vid}` };

  // Explicit playlist page or any URL carrying a playlist id.
  const list = url.searchParams.get("list");
  if (list) return { kind: "playlist", feed: `https://www.youtube.com/playlist?list=${list}` };

  // Channel forms → normalize to the "/videos" tab so flat-playlist enumerates uploads
  // (a bare channel root lists tab-playlists instead of videos).
  if (/^\/(@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)/.test(url.pathname)) {
    const base = url.pathname.replace(/\/(videos|shorts|streams|featured|playlists|community|about)\/?$/, "").replace(/\/$/, "");
    return { kind: "channel", feed: `https://www.youtube.com${base}/videos` };
  }
  return null;
}

// Map hey-koko's UI/prompt language code to a yt-dlp `youtube:lang` value, which
// selects WHICH localized title YouTube returns (a zh channel serves English
// titles to an en client and vice-versa). YouTube wants region codes here, not
// zh-Hans/zh-Hant. Empty → let yt-dlp use its default locale.
function ytdlpLangArg(language) {
  if (language === "zh" || language === "zh-Hans" || language === "zh-CN") return "zh-CN";
  if (language === "zh-Hant" || language === "zh-TW") return "zh-TW";
  if (language === "en") return "en";
  return "";
}

// Run `yt-dlp --flat-playlist` and return [{id, date, title}] for a feed URL. Fast: no
// per-video extraction. `youtubetab:approximate_date` fills upload_date on flat channel/
// playlist entries (derived from "3 weeks ago" — month-level precision, better than
// nothing); missing dates print as NA → "". `--encoding UTF-8` forces UTF-8 stdout: the
// frozen yt-dlp.exe on Windows otherwise emits titles in the ANSI code page and drops
// every CJK char (PYTHONIOENCODING is ignored). yt-dlp may exit non-zero on partial
// errors yet still print good entries, so we only reject when nothing usable came back.
//
// Dates vs localized titles CANNOT come from one call. approximate_date parses the
// ENGLISH "3 weeks ago" relative-time text, so the date call must FORCE youtube:lang=en:
// without an explicit lang YouTube serves relative times in a geo-guessed language and
// the dates come back NA nondeterministically (verified: playlist with no lang → NA, with
// youtube:lang=en → dates; a non-English lang also → NA). So the DATE call always uses
// youtube:lang=en. English/unset UI → that single call (English titles too). Other UI
// languages → a SECOND parallel call with youtube:lang=<lang> for localized titles,
// merged by id; that localized run is best-effort (failure → English titles).
async function ytFlatList(ytdlpCmd, feedUrl, lang) {
  const enArgs = ["--extractor-args", "youtube:lang=en"];   // forces parseable English dates
  if (!lang || lang === "en") return ytFlatListRaw(ytdlpCmd, feedUrl, enArgs);
  const [base, localized] = await Promise.all([
    ytFlatListRaw(ytdlpCmd, feedUrl, enArgs),
    ytFlatListRaw(ytdlpCmd, feedUrl, ["--extractor-args", `youtube:lang=${lang}`]).catch(() => []),
  ]);
  const titleOf = new Map(localized.map((e) => [e.id, e.title]));
  return base.map((e) => ({ ...e, title: titleOf.get(e.id) || e.title }));
}
function ytFlatListRaw(ytdlpCmd, feedUrl, extraArgs) {
  return new Promise((resolve, reject) => {
    const extractorArgs = ["--extractor-args", "youtubetab:approximate_date", ...extraArgs];
    const proc = spawn(ytdlpCmd, [
      "--flat-playlist", "--no-warnings", "--ignore-errors",
      "--encoding", "UTF-8",
      ...extractorArgs,
      "--print", "%(id)s\t%(upload_date)s\t%(title)s",
      feedUrl,
    ], { timeout: 120000 });
    // Collect stdout as raw Buffers and decode once at the end — decoding per-chunk
    // (out += d.toString()) can split a multi-byte UTF-8 char across chunk boundaries.
    const outBufs = [];
    let err = "";
    proc.stdout.on("data", (d) => { outBufs.push(d); });
    proc.stderr.on("data", (d) => { err += d.toString(); });
    proc.on("error", reject);
    proc.on("close", (code) => {
      const out = Buffer.concat(outBufs).toString("utf-8");
      const entries = out.split("\n").map((l) => l.replace(/\r$/, "")).filter(Boolean).map((line) => {
        const [id = "", rawDate = "", ...rest] = line.split("\t");
        const dm = rawDate.trim().match(/^(\d{4})(\d{2})(\d{2})$/);
        return {
          id: id.trim(),
          date: dm ? `${dm[1]}-${dm[2]}-${dm[3]}` : "",
          title: rest.join("\t").trim(),
        };
      }).filter((e) => /^[\w-]{11}$/.test(e.id));
      if (!entries.length && code !== 0) return reject(new Error((err.trim().split("\n").pop() || `yt-dlp code ${code}`).slice(-200)));
      resolve(entries);
    });
  });
}

// POST /api/youtube-expand  { urls:[...] }
//   → { videos:[{id, url(canonical watch?v=), title, date("YYYY-MM-DD" or ""), approxDate?}],
//       errors:[{url, error}] }   approxDate: true when the date is only month-precise
//       (channel feed); absent for exact playlist/single-video dates.
// Expands channels/playlists into their videos, canonicalizes single videos, and
// dedupes by video id across all inputs (order preserved).
async function expandYoutubeUrls(req, res) {
  try {
    const body = await readBody(req);
    const urls = Array.isArray(body.urls) ? body.urls : [];
    const lang = ytdlpLangArg(body.language);  // localized-title language (follows the UI)
    const ytdlpCmd = await findCommand("yt-dlp");
    if (!ytdlpCmd) { sendJson(res, 200, { videos: [], errors: [{ url: "", error: "yt-dlp 未安装。请运行: brew install yt-dlp" }] }); return; }

    const seen = new Set();
    const videos = [];
    const errors = [];
    for (const raw of urls) {
      const cls = ytFeedUrl(raw);
      if (!cls) { errors.push({ url: raw, error: "无法识别的 YouTube 链接" }); continue; }
      try {
        const entries = await ytFlatList(ytdlpCmd, cls.feed, lang);
        // A channel /videos feed's dates are approximate (approximate_date reverse-parses
        // "3 weeks ago" — month-level only); playlist/single-video dates are exact.
        const approxDate = cls.kind === "channel";
        for (const e of entries) {
          if (seen.has(e.id)) continue;
          seen.add(e.id);
          videos.push({ id: e.id, url: `https://www.youtube.com/watch?v=${e.id}`, title: e.title || e.id, date: e.date || "", approxDate: approxDate || undefined });
        }
      } catch (e) { errors.push({ url: raw, error: (e && e.message) || "expand failed" }); }
    }
    sendJson(res, 200, { videos, errors });
  } catch (e) { sendJson(res, 500, { error: (e && e.message) || "youtube-expand failed" }); }
}

// Startup visibility: log which optional YouTube/ASR tools are reachable (async,
// non-blocking — mirrors parse-file's pandoc/mineru lines). Runs after config's
// Windows PATH refresh, so a "not found" here means genuinely missing, and the
// server console answers "why does whisper say 未安装?" at a glance.
(async function detectYoutubeTools() {
  for (const cmd of ["yt-dlp", "ffmpeg"]) {
    const p = await findCommand(cmd);
    console.log(p ? `[url-fetch] ${cmd} detected at ${p}` : `[url-fetch] ${cmd} not found`);
  }
  // whisper-cli goes through the same PATH+conventional-dirs lookup the deps check
  // uses, so this line reflects what transcription will actually do.
  const w = await findWhisperCli();
  if (w) console.log(`[url-fetch] whisper-cli detected at ${w}`);
  else {
    console.log("[url-fetch] whisper-cli not found");
    // Deep diagnostic: WHY is the conventional location unreachable from this
    // process? ENOENT = invisible/absent in this view; EPERM/EACCES = blocked.
    if (process.platform === "win32") {
      const guess = path.join(process.env.LOCALAPPDATA || "(LOCALAPPDATA unset)", "whisper-cpp", "Release", "whisper-cli.exe");
      try { fs.statSync(guess); console.log(`[url-fetch]   probe ${guess} -> statSync OK (unexpected)`); }
      catch (e) { console.log(`[url-fetch]   probe ${guess} -> ${e.code}`); }
      console.log(`[url-fetch]   LOCALAPPDATA=${process.env.LOCALAPPDATA || "(unset)"} USERPROFILE=${process.env.USERPROFILE || "(unset)"}`);
    }
  }
  const model = findWhisperModel();
  console.log(model ? `[url-fetch] whisper model: ${model}` : "[url-fetch] whisper model not found");
})();

module.exports = { fetchUrlContent, transcribeYouTubeAudio, youtubeJob, formatTranscriptServer, extractCleanContent, expandYoutubeUrls };