const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile, spawn } = require("child_process");
const { sendJson, readBody } = require("./utils");
const config = require("./config");

async function fetchUrlContent(req, res) {
  try {
    const body = await readBody(req);
    const { url, language } = body;
    if (!url) { sendJson(res, 400, { error: "url is required" }); return; }

    let parsed;
    try { parsed = new URL(url); } catch { sendJson(res, 400, { error: "Invalid URL" }); return; }
    if (!["http:", "https:"].includes(parsed.protocol)) { sendJson(res, 400, { error: "Only http/https supported" }); return; }

    // Check if YouTube
    const ytMatch = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([\w-]{11})/);
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
    const articleHtml = extractMainContentHtml(html);
    const markdown = await htmlToMarkdown(rewriteArticleImages(articleHtml, url));
    const cleaned = cleanupMarkdown(markdown);

    // Download article images separately; keep only a lightweight placeholder in the text.
    const imgUrls = [...cleaned.matchAll(/!\[[^\]]*\]\(([^)\s]+)[^)]*\)/g)].map((m) => m[1]);
    const images = await downloadImages(imgUrls, url, 8);
    let text = cleaned.replace(/!\[([^\]]*)\]\([^)]*\)/g, (_, alt) => {
      const a = (alt || "").trim();
      if (UI_ICON_ALT_RE.test(a)) return ""; // drop UI-icon images entirely
      return a && a.length <= 60 ? `［图片：${a}］` : "［图片］";
    });
    text = removeRelatedCardBlocks(removeRelatedWidgets(cutTrailingSections(text)))
      // collapse runs of adjacent image placeholders (e.g. photo galleries) into one
      .replace(/(［图片[^］]*］)(\s*\n\s*［图片[^］]*］)+/g, "$1")
      .replace(/\n{3,}/g, "\n\n");

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
  md = md.replace(/(?<!!)\[\]\([^)]*\)/g, "");
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
  const ytdlpResult = await fetchTranscriptViaYtdlp(videoId);
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

    const captionTracks = playerData?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!captionTracks || captionTracks.length === 0) {
      return { title, channel, duration, viewCount, uploadDate, description, text: "[该视频无原始字幕]" };
    }

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
      if (segments.length > 0) return { title, channel, duration, viewCount, uploadDate, description, text: segments.join(" ") };
    }

    // Caption fetch failed
    const langInfo = captionTracks.map(t => t.languageCode).join(", ");
    return { title, channel, duration, viewCount, uploadDate, description, text: `[字幕获取失败，可用语言: ${langInfo}]` };
  } catch (e) {
    console.error("[yt-transcript] error:", e.message);
    return null;
  }
}

function fetchTranscriptViaYtdlp(videoId) {
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  return new Promise((resolve) => {
    // Check if yt-dlp is available
    execFile("which", ["yt-dlp"], (err) => {
      if (err) { resolve(null); return; }

      // Step 1: list available subtitles to pick the best language
      execFile("yt-dlp", ["--list-subs", "--skip-download", url],
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

          // Pick best language
          const preferred = ["zh-Hans", "zh-Hant", "zh", "en", "ja"];
          let selectedLang = null;

          for (const pref of preferred) {
            if (realLangs.includes(pref)) { selectedLang = pref; break; }
          }
          if (!selectedLang) {
            for (const pref of preferred) {
              if (autoLangs.includes(pref)) { selectedLang = pref; break; }
            }
          }
          if (!selectedLang) selectedLang = realLangs[0] || autoLangs[0];

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
              const seen = new Set();
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
                if (clean && !seen.has(clean)) {
                  seen.add(clean);
                  segments.push({ time: currentTime, text: clean });
                }
              }

              cleanupDir(tmpDir);

              if (segments.length === 0) { resolve(null); return; }

              const plainText = segments.map(s => s.text).join("\n");

              // Get video metadata
              execFile("yt-dlp", [
                "--print", "%(title)s",
                "--print", "%(channel)s",
                "--print", "%(duration_string)s",
                "--print", "%(view_count)s",
                "--print", "%(upload_date)s",
                "--print", "%(description).500s",
                "--skip-download", url,
              ], { timeout: 15000 }, (e, metaOut) => {
                  const metaLines = (metaOut || "").split("\n");
                  const title = metaLines[0]?.trim() || "";
                  const channel = metaLines[1]?.trim() || "";
                  const duration = metaLines[2]?.trim() || "";
                  const viewCount = metaLines[3]?.trim() || "";
                  const uploadDate = metaLines[4]?.trim() || "";
                  const description = metaLines.slice(5).join("\n").trim() || "";
                  resolve({ title, channel, duration, viewCount, uploadDate, description, text: plainText });
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

// Transcribe YouTube audio via whisper.cpp
async function transcribeYouTubeAudio(req, res) {
  let body;
  try { body = await readBody(req); } catch { sendJson(res, 400, { error: "invalid body" }); return; }
  const { videoId } = body;
  if (!videoId || !/^[\w-]{11}$/.test(videoId)) {
    sendJson(res, 400, { error: "invalid videoId" });
    return;
  }

  // Check dependencies
  const whisperCmd = await findCommand("whisper-cli");
  if (!whisperCmd) {
    sendJson(res, 200, { error: "whisper-cli 未安装。请运行: brew install whisper-cpp" });
    return;
  }
  const ytdlpCmd = await findCommand("yt-dlp");
  if (!ytdlpCmd) {
    sendJson(res, 200, { error: "yt-dlp 未安装。请运行: brew install yt-dlp" });
    return;
  }
  const ffmpegCmd = await findCommand("ffmpeg");
  if (!ffmpegCmd) {
    sendJson(res, 200, { error: "ffmpeg 未安装。请运行: brew install ffmpeg" });
    return;
  }
  const modelPath = findWhisperModel();
  if (!modelPath) {
    sendJson(res, 200, { error: "未找到 whisper 模型文件。请下载: curl -L -o ~/.local/share/whisper-cpp/ggml-medium.bin --create-dirs https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin" });
    return;
  }

  // Setup streaming response
  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-store",
  });

  const tmpDir = path.join(os.tmpdir(), `yt-whisper-${videoId}-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const audioRaw = path.join(tmpDir, "audio");
  const audioWav = path.join(tmpDir, "converted.wav");

  let aborted = false;
  const childProcesses = [];

  req.on("close", () => {
    aborted = true;
    for (const cp of childProcesses) {
      try { cp.kill("SIGTERM"); } catch {}
    }
    cleanupDir(tmpDir);
  });

  function send(obj) {
    if (!aborted) {
      try { res.write(JSON.stringify(obj) + "\n"); } catch {}
    }
  }

  try {
    // Step 1: Download audio
    send({ status: "downloading", message: "正在下载音频..." });
    await new Promise((resolve, reject) => {
      if (aborted) return reject(new Error("aborted"));
      const proc = spawn(ytdlpCmd, [
        "-x", "--audio-quality", "worst",
        "-o", audioRaw + ".%(ext)s",
        "--no-playlist",
        `https://www.youtube.com/watch?v=${videoId}`,
      ], { timeout: 300000 });
      childProcesses.push(proc);
      let stderr = "";
      proc.stderr.on("data", (d) => { stderr += d.toString(); });
      proc.on("close", (code) => {
        if (aborted) return reject(new Error("aborted"));
        if (code !== 0) return reject(new Error(`yt-dlp 失败 (code ${code}): ${stderr.slice(-200)}`));
        resolve();
      });
      proc.on("error", reject);
    });
    if (aborted) return;

    // Find the downloaded file (yt-dlp may produce .opus, .m4a, .webm, .wav etc.)
    const files = fs.readdirSync(tmpDir).filter(f => f.startsWith("audio") && f !== "converted.wav");
    if (files.length === 0) {
      send({ status: "error", message: "音频下载失败：未找到下载文件" });
      res.end();
      cleanupDir(tmpDir);
      return;
    }
    const downloadedFile = path.join(tmpDir, files[0]);
    const fileSizeMB = (fs.statSync(downloadedFile).size / 1024 / 1024).toFixed(1);
    send({ status: "downloaded", message: `音频下载完成（${fileSizeMB} MB）` });

    // Step 2: Convert to 16kHz mono WAV
    send({ status: "converting", message: "正在转换音频格式..." });
    await new Promise((resolve, reject) => {
      if (aborted) return reject(new Error("aborted"));
      const proc = spawn(ffmpegCmd, [
        "-i", downloadedFile,
        "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le",
        "-y", audioWav,
      ]);
      childProcesses.push(proc);
      proc.on("close", (code) => {
        if (aborted) return reject(new Error("aborted"));
        if (code !== 0) return reject(new Error(`ffmpeg 转换失败 (code ${code})`));
        resolve();
      });
      proc.on("error", reject);
    });
    if (aborted) return;

    // Step 3: Transcribe with whisper-cli (with timestamps for natural segmentation)
    send({ status: "transcribing", message: "正在语音识别...", progress: "0%" });
    const transcriptText = await new Promise((resolve, reject) => {
      if (aborted) return reject(new Error("aborted"));
      const proc = spawn(whisperCmd, [
        "-m", modelPath,
        "-f", audioWav,
        "-l", "auto",
        "--print-progress",
      ]);
      childProcesses.push(proc);
      let stdout = "";
      let lastProgress = "";
      proc.stdout.on("data", (d) => { stdout += d.toString(); });
      proc.stderr.on("data", (d) => {
        const str = d.toString();
        // Parse progress from stderr: "whisper_full_with_state: progress = XX%"
        const match = str.match(/progress\s*=\s*(\d+)%/);
        if (match && match[1] !== lastProgress) {
          lastProgress = match[1];
          send({ status: "transcribing", message: `正在语音识别... ${match[1]}%`, progress: `${match[1]}%` });
        }
      });
      proc.on("close", (code) => {
        if (aborted) return reject(new Error("aborted"));
        if (code !== 0) return reject(new Error(`whisper-cli 转录失败 (code ${code})`));
        // Parse timestamped output: "[HH:MM:SS.mmm --> HH:MM:SS.mmm]  text"
        const lines = stdout.split("\n");
        const segments = [];
        for (const line of lines) {
          const m = line.match(/^\[[\d:.]+\s*-->\s*[\d:.]+\]\s*(.+)/);
          if (m && m[1].trim()) {
            segments.push(m[1].trim());
          }
        }
        resolve(segments.length > 0 ? segments.join("\n") : stdout.trim());
      });
      proc.on("error", reject);
    });
    if (aborted) return;

    // Done
    send({ status: "done", text: transcriptText });
    res.end();
    cleanupDir(tmpDir);
  } catch (e) {
    if (!aborted) {
      send({ status: "error", message: e.message || "转录失败" });
      res.end();
    }
    cleanupDir(tmpDir);
  }
}

function findCommand(cmd) {
  return new Promise((resolve) => {
    execFile("which", [cmd], (err, stdout) => {
      if (err || !stdout.trim()) resolve(null);
      else resolve(stdout.trim());
    });
  });
}

module.exports = { fetchUrlContent, transcribeYouTubeAudio };
