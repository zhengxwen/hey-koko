// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

const { sendJson, readBody } = require("./utils");
const { extractCleanContent } = require("./url-fetch");

const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7",
};

// Strip tags + decode named/numeric entities, collapse whitespace.
function inlineText(html) {
  return String(html)
    .replace(/<[^>]+>/g, "")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&(?:nbsp|ensp|emsp|thinsp);/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function safeCodePoint(n) {
  try { return String.fromCodePoint(n); } catch { return ""; }
}

function isCaptcha(html) {
  return /bots use DuckDuckGo|complete the following challenge|anomaly[- ]?modal/i.test(html);
}

// Each engine returns { results } on success (possibly empty = engine answered but
// found nothing) or { blocked: true } when it served a bot wall / rate limit instead.
// A blocked engine is skipped for BLOCK_COOLDOWN_MS so we stop hammering it (which only
// prolongs the block) and go straight to the next one.
const BLOCK_COOLDOWN_MS = 10 * 60 * 1000;
const blockedUntil = new Map();   // engine name -> timestamp

// --- DuckDuckGo: vqd token -> links.duckduckgo.com/d.js (returns JSON results) ---

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

async function searchViaDjs(query, vqd, limit, df) {
  const params = new URLSearchParams({
    q: query, kl: "wt-wt", l: "wt-wt", p: "", s: "0", df: df || "", vqd, ex: "-2", sp: "0",
  });
  const res = await fetch(`https://links.duckduckgo.com/d.js?${params.toString()}`, {
    headers: { ...BROWSER_HEADERS, Referer: "https://duckduckgo.com/" },
    signal: AbortSignal.timeout(12000),
  });
  const txt = await res.text();
  const arr = extractLoadArray(txt);
  // 202 / an obfuscated JS challenge instead of the results payload = bot wall.
  if (!arr) return (res.status === 202 || res.status === 429 || /\bjsa\s*=/.test(txt)) ? { blocked: true } : { results: [] };
  const results = [];
  for (const item of arr) {
    if (!item || !item.u || !item.t) continue; // skip pagination / ad / empty entries
    results.push({ title: inlineText(item.t), url: item.u, snippet: inlineText(item.a || "").slice(0, 300) });
    if (results.length >= limit) break;
  }
  return { results };
}

async function searchDdg(query, limit, df) {
  // Retry once on a plain empty answer (DDG occasionally drops one); never on a block.
  let gotVqd = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 600));
    const vqd = await getVqd(query);
    if (!vqd) continue;
    gotVqd = true;
    const r = await searchViaDjs(query, vqd, limit, df);
    if (r.blocked || r.results.length) return r;
  }
  if (!gotVqd) throw new Error("no vqd token on the results page");
  return { results: [] };
}

// --- DuckDuckGo html endpoint (fallback; usually walled whenever d.js is) ---

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

async function searchDdgHtml(query, limit, df) {
  const res = await fetch("https://html.duckduckgo.com/html/", {
    method: "POST",
    headers: { ...BROWSER_HEADERS, "Content-Type": "application/x-www-form-urlencoded" },
    body: `q=${encodeURIComponent(query)}&kl=wt-wt${df ? `&df=${df}` : ""}`,
    signal: AbortSignal.timeout(12000),
    redirect: "follow",
  });
  const html = await res.text();
  const results = parseHtmlResults(html, limit);
  if (!results.length && (isCaptcha(html) || res.status === 202)) return { blocked: true };
  return { results };
}

// Bing's HTML page was tried as a keyless fallback and rejected (2026-11): to a non-JS
// client it ranks on only the first word or two of the query ("what's new in python
// 3.14" -> WhatsApp), so it hands the model confidently wrong sources.
const ENGINES = [
  { name: "duckduckgo", run: searchDdg },
  { name: "duckduckgo-html", run: searchDdgHtml },
];

// Walk the engines in order until one returns results. Engines in their block cooldown
// are skipped — unless every engine is cooling down, then all are tried anyway.
// Returns { results, engine } or { results: [], error, detail? }.
async function runSearch(query, limit, df) {
  const now = Date.now();
  let order = ENGINES.filter((e) => (blockedUntil.get(e.name) || 0) <= now);
  if (!order.length) order = ENGINES;
  let blocked = 0, timedOut = 0, answeredEmpty = 0;
  const errors = [];
  for (const e of order) {
    try {
      const r = await e.run(query, limit, df);
      if (r.blocked) {
        blocked++;
        blockedUntil.set(e.name, Date.now() + BLOCK_COOLDOWN_MS);
        console.warn(`[search] ${e.name} is rate-limiting/challenging us; skipping it for ${BLOCK_COOLDOWN_MS / 60000} min`);
        continue;
      }
      blockedUntil.delete(e.name);
      if (r.results.length) return { results: r.results, engine: e.name };
      answeredEmpty++;
    } catch (err) {
      if (err.name === "AbortError" || err.name === "TimeoutError") timedOut++;
      errors.push(`${e.name}: ${err.message}`);
    }
  }
  if (answeredEmpty) return { results: [] };   // an engine really answered "nothing found"
  if (blocked) return { results: [], error: "captcha" };
  if (timedOut === order.length) return { results: [], error: "Search timed out" };
  return { results: [], error: "Search failed", detail: errors.join("; ") };
}

// --- Deep read: fetch a result page and extract its condensed main text ---
// Reuses the same readability-style pipeline as the /url command (main-content
// extraction + Markdown + in-article noise cleanup), text only (no image download).

async function fetchPageText(url, maxChars) {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": BROWSER_HEADERS["User-Agent"] },
      signal: AbortSignal.timeout(8000),
      redirect: "follow",
    });
    if (!res.ok) return "";
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("text/html") && !ct.includes("text/plain")) return "";
    const html = await res.text();
    const { text } = await extractCleanContent(html, url);
    return text.slice(0, maxChars);
  } catch { return ""; }
}

async function deepRead(results, count) {
  const targets = results.slice(0, Math.min(count, 3));
  await Promise.allSettled(targets.map(async (r) => {
    r.content = await fetchPageText(r.url, 3500);
  }));
}

async function searchWeb(req, res) {
  let body;
  try { body = await readBody(req); } catch { sendJson(res, 400, { error: "invalid body" }); return; }
  const query = (body.query || "").trim();
  if (!query) { sendJson(res, 400, { error: "query is required" }); return; }
  const LIMIT = Math.min(10, Math.max(1, parseInt(body.count, 10) || 6));
  const df = ["d", "w", "m", "y"].includes(body.timelimit) ? body.timelimit : "";

  try {
    const out = await runSearch(query, LIMIT, df);
    if (out.error) { sendJson(res, 200, out); return; }

    // Deep read: fetch the top pages' text so the model can answer from real content
    if (body.deep && out.results.length) {
      await deepRead(out.results, parseInt(body.deepCount, 10) || 3);
    }

    sendJson(res, 200, { query, ...out });
  } catch (error) {
    sendJson(res, 500, { error: "Search failed", detail: error.message });
  }
}

module.exports = { searchWeb, runSearch };
