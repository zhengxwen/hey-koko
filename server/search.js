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

// --- Exa: the hosted MCP endpoint (keyless free tier, rate-limited) ---
// The same endpoint opencode's built-in websearch tool calls. A stateless JSON-RPC
// tools/call works without an MCP initialize handshake; the reply is one SSE
// "message" event (or plain JSON). Results come back as one text blob of
// "Title:/URL:/Published:/Author:/Highlights:" records separated by "---".

const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
const DF_WORDS = { d: "the past 24 hours", w: "the past week", m: "the past month", y: "the past year" };

function parseExaText(text, limit) {
  const results = [];
  for (const chunk of String(text).split(/^Title: /m).slice(1)) {
    const url = (chunk.match(/^URL: (\S+)/m) || [])[1];
    if (!url || !/^https?:\/\//.test(url)) continue;
    let title = chunk.split("\n")[0].trim();
    if (!title || title === "N/A") { try { title = new URL(url).hostname; } catch { title = url; } }
    const pub = (chunk.match(/^Published: (\S+)/m) || [])[1];
    const published = pub && pub !== "N/A" ? pub.slice(0, 10) : "";
    const hl = chunk.split(/^Highlights:\s*$/m)[1] || "";
    const highlights = hl.replace(/\n-{3,}\s*$/, "").replace(/^#+\s*/gm, "").replace(/\s+/g, " ").trim();
    results.push({ title, url, snippet: highlights.slice(0, 300), highlights: highlights.slice(0, 1500), ...(published ? { published } : {}) });
    if (results.length >= limit) break;
  }
  return results;
}

async function searchExa(query, limit, df) {
  const args = { query, numResults: limit };
  // No date filter in this tool; state the window as the ranking objective instead.
  if (df) args.objective = `Prefer pages published within ${DF_WORDS[df]}; exclude older pages.`;
  const res = await fetch(EXA_MCP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "web_search_exa", arguments: args } }),
    signal: AbortSignal.timeout(15000),
  });
  const raw = await res.text();
  if (res.status === 429) return { blocked: true };
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const lines = raw.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim());
  let msg;
  try { msg = JSON.parse(lines.length ? lines[lines.length - 1] : raw); } catch { throw new Error("unreadable reply"); }
  const errText = msg.error ? String(msg.error.message || msg.error.code)
    : msg.result && msg.result.isError ? (msg.result.content || []).map((c) => c.text || "").join(" ") : "";
  if (errText) {
    if (/rate.?limit|too many|quota|credits?/i.test(errText)) return { blocked: true };
    throw new Error(errText.slice(0, 200));
  }
  const text = ((msg.result && msg.result.content) || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  return { results: parseExaText(text, limit) };
}

// Bing's HTML page was tried as a keyless fallback and rejected (2026-11): to a non-JS
// client it ranks on only the first word or two of the query ("what's new in python
// 3.14" -> WhatsApp), so it hands the model confidently wrong sources.
const EXA = { name: "exa", run: searchExa };
const DDG = { name: "duckduckgo", run: searchDdg };
const DDG_HTML = { name: "duckduckgo-html", run: searchDdgHtml };

// mode "ddg" (the default — also for callers that send nothing) never contacts Exa:
// its privacy policy says it logs the IP and trains on query text, so it is an opt-in
// (LLM ⚙ → Web search service → Auto). In "auto": Exa first (most reliable, best
// relevance); with a time filter, DuckDuckGo first — it has a real date filter, while
// Exa only gets the window as a ranking hint.
function enginesFor(df, mode) {
  if (mode !== "auto") return [DDG, DDG_HTML];
  return df ? [DDG, DDG_HTML, EXA] : [EXA, DDG, DDG_HTML];
}

// Walk the engines in order until one returns results. Engines in their block cooldown
// are skipped — unless every engine is cooling down, then all are tried anyway.
// Returns { results, engine } or { results: [], error, detail? }.
async function runSearch(query, limit, df, mode = "ddg") {
  const now = Date.now();
  const engines = enginesFor(df, mode);
  let order = engines.filter((e) => (blockedUntil.get(e.name) || 0) <= now);
  if (!order.length) order = engines;
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
    r.content = (await fetchPageText(r.url, 3500)) || r.highlights || "";
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
    const out = await runSearch(query, LIMIT, df, body.engine === "auto" ? "auto" : "ddg");
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
