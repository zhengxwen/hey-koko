const { sendJson, readBody } = require("./utils");

const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7",
};

// Strip tags + decode the handful of entities DDG emits, collapse whitespace.
function inlineText(html) {
  return String(html)
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isCaptcha(html) {
  return /bots use DuckDuckGo|complete the following challenge|anomaly[- ]?modal/i.test(html);
}

// --- Method 1: vqd token -> links.duckduckgo.com/d.js (returns JSON results) ---

async function getVqd(query) {
  const res = await fetch(`https://duckduckgo.com/?q=${encodeURIComponent(query)}&ia=web`, {
    headers: BROWSER_HEADERS,
    signal: AbortSignal.timeout(12000),
  });
  const txt = await res.text();
  for (const re of [/vqd=["']([\d-]+)["']/, /vqd=([\d-]+)&/, /vqd=([\d-]+)/]) {
    const m = txt.match(re);
    if (m) return m[1];
  }
  return null;
}

// Extract the array passed to DDG.pageLayout.load('d', [...]) via bracket matching.
function extractLoadArray(txt) {
  let start = txt.indexOf("DDG.pageLayout.load('d',");
  if (start === -1) start = txt.indexOf("load('d',");
  if (start === -1) return null;
  const open = txt.indexOf("[", start);
  if (open === -1) return null;
  let depth = 0, end = -1, inStr = false, esc = false;
  for (let i = open; i < txt.length; i++) {
    const c = txt[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "[") depth++;
    else if (c === "]") { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (end === -1) return null;
  try { return JSON.parse(txt.slice(open, end)); } catch { return null; }
}

async function searchViaDjs(query, vqd, limit) {
  const params = new URLSearchParams({
    q: query, kl: "wt-wt", l: "wt-wt", p: "", s: "0", df: "", vqd, ex: "-2", sp: "0",
  });
  const res = await fetch(`https://links.duckduckgo.com/d.js?${params.toString()}`, {
    headers: { ...BROWSER_HEADERS, Referer: "https://duckduckgo.com/" },
    signal: AbortSignal.timeout(12000),
  });
  const txt = await res.text();
  const arr = extractLoadArray(txt);
  if (!arr) return null;
  const results = [];
  for (const item of arr) {
    if (!item || !item.u || !item.t) continue; // skip pagination / ad / empty entries
    results.push({ title: inlineText(item.t), url: item.u, snippet: inlineText(item.a || "").slice(0, 300) });
    if (results.length >= limit) break;
  }
  return results;
}

// --- Method 2 (fallback): scrape html.duckduckgo.com ---

function realUrl(href) {
  const m = href.match(/[?&]uddg=([^&]+)/);
  if (m) { try { return decodeURIComponent(m[1]); } catch { return null; } }
  if (href.startsWith("//")) return "https:" + href;
  if (href.startsWith("http")) return href;
  return null;
}

function parseHtmlResults(html, limit) {
  const results = [];
  const linkRe = /<a[^>]+class="[^"]*result(?:__a|-link)[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe = /class="[^"]*result(?:__snippet|-snippet)[^"]*"[^>]*>([\s\S]*?)<\/(?:a|td)>/g;
  const snippets = [];
  let sm;
  while ((sm = snippetRe.exec(html)) !== null) snippets.push(inlineText(sm[1]));
  let m, i = 0;
  while ((m = linkRe.exec(html)) !== null && results.length < limit) {
    const url = realUrl(m[1]);
    const title = inlineText(m[2]);
    if (!url || !title) { i++; continue; }
    if (/duckduckgo\.com\/(y\.js|l\/)/.test(url)) { i++; continue; }
    results.push({ title, url, snippet: (snippets[i] || "").slice(0, 300) });
    i++;
  }
  return results;
}

async function searchViaHtml(query, limit) {
  const res = await fetch("https://html.duckduckgo.com/html/", {
    method: "POST",
    headers: { ...BROWSER_HEADERS, "Content-Type": "application/x-www-form-urlencoded" },
    body: `q=${encodeURIComponent(query)}&kl=wt-wt`,
    signal: AbortSignal.timeout(12000),
    redirect: "follow",
  });
  const html = await res.text();
  const results = parseHtmlResults(html, limit);
  return { results, captcha: results.length === 0 && isCaptcha(html) };
}

async function searchWeb(req, res) {
  let body;
  try { body = await readBody(req); } catch { sendJson(res, 400, { error: "invalid body" }); return; }
  const query = (body.query || "").trim();
  if (!query) { sendJson(res, 400, { error: "query is required" }); return; }
  const LIMIT = 6;

  try {
    // Method 1: vqd + d.js JSON (retry once — DDG occasionally throttles a request)
    let results = [];
    for (let attempt = 0; attempt < 2 && !results.length; attempt++) {
      try {
        if (attempt > 0) await new Promise((r) => setTimeout(r, 600));
        const vqd = await getVqd(query);
        if (vqd) {
          const r = await searchViaDjs(query, vqd, LIMIT);
          if (r && r.length) results = r;
        }
      } catch { /* fall through to html */ }
    }

    // Method 2: html scrape fallback
    if (!results.length) {
      const html = await searchViaHtml(query, LIMIT);
      if (html.results.length) results = html.results;
      else if (html.captcha) { sendJson(res, 200, { results: [], error: "captcha" }); return; }
    }

    sendJson(res, 200, { query, results });
  } catch (error) {
    if (error.name === "AbortError" || error.name === "TimeoutError") sendJson(res, 200, { results: [], error: "搜索超时" });
    else sendJson(res, 500, { error: "搜索失败", detail: error.message });
  }
}

module.exports = { searchWeb };
