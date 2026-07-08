// server/feeds.js — 新闻订阅库 (news-feeds.md)
// A tier-2 "news" knowledge library: company/official blog feeds are polled on a timer and
// their history is backfilled in bulk, all landing under the top-level `news/<slug>/` tree
// which retrieve/star-map default-EXCLUDE (library.inNewsDir). Zero-dependency: RSS/Atom/
// sitemap are hand-parsed (no XML lib), scheduling is a plain setInterval (no cron/launchd).
//
// Three moving parts:
//   • state:  feeds.json (subscriptions + backfill cursor) + feeds-state.json (seen-URL sets)
//   • poll:   setInterval → for each feed, diff feed items vs seen-set → enqueue `feeditem`
//             libimport jobs (server bg-queue, lib lane) → import under news/<slug>/
//   • backfill: one `backfill` libimport job per feed → runBackfill() loops the whole history
//             via a probed channel (wp-json → paged feed → sitemap) and imports DIRECTLY
//             (no per-article sub-jobs — thousands would swamp the queue/drawer).
const http = require("http");
const fs = require("fs");
const path = require("path");
const config = require("./config");
const { sendJson, readBody } = require("./utils");
const library = require("./library");
const { extractArticle, trafilaturaAvailable } = require("./url-fetch");

const NEWS_DIR = library.NEWS_DIR || "news";
const NEWS_IMAGE_CAP = 8;   // max images downloaded per article (bandwidth/size guard)
const UA = "Mozilla/5.0 (compatible; hey-koko-feeds/1.0)";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function abortErr() { const e = new Error("Aborted"); e.name = "AbortError"; return e; }

// ---- state files ------------------------------------------------------------
function feedsPath() { return path.join(config.DATA_DIR, "feeds.json"); }
function statePath() { return path.join(config.DATA_DIR, "feeds-state.json"); }
function writeAtomic(p, data) { const tmp = `${p}.tmp${process.pid}`; fs.writeFileSync(tmp, data); fs.renameSync(tmp, p); }

let _feeds = null, _feedsTimer = null;
function loadFeeds() {
  if (_feeds) return _feeds;
  try { _feeds = JSON.parse(fs.readFileSync(feedsPath(), "utf8")) || {}; } catch { _feeds = {}; }
  if (!Array.isArray(_feeds.feeds)) _feeds.feeds = [];
  if (!_feeds.pollIntervalH) _feeds.pollIntervalH = 24;
  return _feeds;
}
function writeFeedsNow() { try { fs.mkdirSync(config.DATA_DIR, { recursive: true }); writeAtomic(feedsPath(), JSON.stringify(_feeds, null, 2)); } catch (e) { console.warn("[feeds] save failed:", e.message); } }
// immediate=true for user CRUD (must persist before the response); throttled for the
// per-page cursor churn of a running backfill (25 pages / thousands of items).
function saveFeeds(immediate = false) {
  if (immediate) { if (_feedsTimer) { clearTimeout(_feedsTimer); _feedsTimer = null; } return writeFeedsNow(); }
  if (_feedsTimer) return;
  _feedsTimer = setTimeout(() => { _feedsTimer = null; writeFeedsNow(); }, 1000);
  if (_feedsTimer.unref) _feedsTimer.unref();
}

// seen-URL sets: kept as Map<feedId,Set<url>> in memory, JSON arrays on disk. A running
// backfill marks thousands of URLs → the disk write is DEBOUNCED (flushState on completion/
// abort keeps it durable; a crash loses ≤2s of marks, harmless since re-import is idempotent).
let _state = null, _stateTimer = null, _stateDirty = false;
function loadState() {
  if (_state) return _state;
  let raw = {}; try { raw = JSON.parse(fs.readFileSync(statePath(), "utf8")) || {}; } catch {}
  _state = {}; for (const k of Object.keys(raw)) _state[k] = new Set(raw[k] || []);
  return _state;
}
function saveStateNow() {
  const raw = {}; for (const k of Object.keys(loadState())) raw[k] = [..._state[k]];
  try { fs.mkdirSync(config.DATA_DIR, { recursive: true }); writeAtomic(statePath(), JSON.stringify(raw)); } catch (e) { console.warn("[feeds] state save:", e.message); }
}
function scheduleSaveState() { _stateDirty = true; if (_stateTimer) return; _stateTimer = setTimeout(() => { _stateTimer = null; if (_stateDirty) { _stateDirty = false; saveStateNow(); } }, 2000); if (_stateTimer.unref) _stateTimer.unref(); }
function flushState() { if (_stateTimer) { clearTimeout(_stateTimer); _stateTimer = null; } if (_stateDirty || _state) { _stateDirty = false; saveStateNow(); } }
function isSeen(feedId, url) { const st = loadState(); return !!(st[feedId] && st[feedId].has(url)); }
function markSeen(feedId, urls) { const st = loadState(); if (!st[feedId]) st[feedId] = new Set(); for (const u of urls) st[feedId].add(u); scheduleSaveState(); }

function getFeed(id) { return loadFeeds().feeds.find((f) => f.id === id) || null; }
function patchFeed(id, patch) { const f = getFeed(id); if (f) { Object.assign(f, patch); saveFeeds(true); } }
function patchBackfill(id, patch) { const f = getFeed(id); if (f) { f.backfill = { ...(f.backfill || {}), ...patch }; saveFeeds(); } }

// ---- polite, rate-limited, retrying fetch -----------------------------------
// Per-host serialization + a min gap between requests (be a good citizen; avoid tripping
// Cloudflare/rate limits during a 25-page backfill). 429/503/403 → exponential backoff.
const hostGate = new Map();   // host -> tail Promise of the serialized chain
const hostLast = new Map();   // host -> last request timestamp
function hostOf(u) { try { return new URL(u).host; } catch { return String(u); } }
function withHostGate(host, fn) {
  const prev = hostGate.get(host) || Promise.resolve();
  const next = prev.then(fn, fn);
  hostGate.set(host, next.catch(() => {}));
  return next;
}
async function fetchRetry(url, { retries = 3, timeoutMs = 20000, headers = {}, signal = null } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal && signal.aborted) throw abortErr();
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), timeoutMs);
    const onAbort = () => ctrl.abort();
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA, ...headers }, redirect: "follow", signal: ctrl.signal });
      if ((res.status === 429 || res.status === 503 || res.status === 403) && attempt < retries) { await sleep(1000 * Math.pow(2, attempt)); continue; }
      return res;
    } catch (e) {
      if (signal && signal.aborted) throw e;
      lastErr = e;
      if (attempt < retries) { await sleep(1000 * Math.pow(2, attempt)); continue; }
      throw e;
    } finally { clearTimeout(to); if (signal) signal.removeEventListener("abort", onAbort); }
  }
  throw lastErr;
}
async function politeFetch(url, opts = {}) {
  const host = hostOf(url);
  const minGap = opts.minGapMs || 1000;
  return withHostGate(host, async () => {
    const wait = minGap - (Date.now() - (hostLast.get(host) || 0));
    if (wait > 0) await sleep(wait);
    try { return await fetchRetry(url, opts); }
    finally { hostLast.set(host, Date.now()); }
  });
}

// ---- XML parsing (hand-written, zero-dep) -----------------------------------
function stripCdata(s) { return String(s || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1"); }
function decodeEntities(s) {
  return stripCdata(s)
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;|&#0*39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return _; } })
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(parseInt(d, 10)); } catch { return _; } })
    .replace(/&amp;/g, "&");   // last, so &amp;lt; doesn't double-decode
}
function firstTag(block, name) {
  const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "i");
  const m = block.match(re); return m ? m[1] : null;
}
function atomLink(block) {
  const attrs = [...block.matchAll(/<link\b([^>]*?)\/?>/gi)].map((m) => ({
    href: (m[1].match(/href=["']([^"']*)["']/i) || [])[1],
    rel: (m[1].match(/rel=["']([^"']*)["']/i) || [])[1],
    type: (m[1].match(/type=["']([^"']*)["']/i) || [])[1],
  }));
  const alt = attrs.find((a) => a.href && (!a.rel || a.rel === "alternate") && (!a.type || /html/i.test(a.type)));
  return ((alt || attrs.find((a) => a.href)) || {}).href || "";
}
function toDate(s) { if (!s) return ""; const d = new Date(s); return isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10); }
// { date:"YYYY-MM-DD", time:"HH-MM-SS" } in UTC. time is "" when the source string carried
// NO clock component (a date-only feed) so we don't stamp a spurious 00-00-00. Both RSS and
// wp-json resolve to the same UTC instant → the poll and backfill paths agree on the docId.
function toDateTime(s) {
  if (!s) return { date: "", time: "" };
  const d = new Date(s); if (isNaN(d.getTime())) return { date: "", time: "" };
  const iso = d.toISOString();
  return { date: iso.slice(0, 10), time: /\d{1,2}:\d{2}/.test(String(s)) ? iso.slice(11, 19).replace(/:/g, "-") : "" };
}
// RSS <item> / Atom <entry> → normalized items. Detects Atom by <feed>+<entry>.
function parseFeed(xml) {
  xml = String(xml || "");
  const isAtom = /<feed[\s>]/i.test(xml) && /<entry[\s>]/i.test(xml);
  const items = [];
  const rx = isAtom ? /<entry[\s>][\s\S]*?<\/entry>/gi : /<item[\s>][\s\S]*?<\/item>/gi;
  for (const m of xml.matchAll(rx)) {
    const b = m[0];
    let url, published, excerpt, contentHtml;
    if (isAtom) {
      url = decodeEntities(atomLink(b)).trim();
      published = (firstTag(b, "published") || firstTag(b, "updated") || "").trim();
      excerpt = firstTag(b, "summary") || "";
      contentHtml = stripCdata(firstTag(b, "content") || "");
    } else {
      url = decodeEntities((firstTag(b, "link") || "").trim() || (firstTag(b, "guid") || "")).trim();
      published = (firstTag(b, "pubDate") || firstTag(b, "dc:date") || "").trim();
      excerpt = firstTag(b, "description") || "";
      contentHtml = stripCdata(firstTag(b, "content:encoded") || "");
    }
    const title = decodeEntities(firstTag(b, "title") || "").trim();
    const dt = toDateTime(published);
    if (url) items.push({ url, title, publishedAt: dt.date, publishedTime: dt.time, excerpt: decodeEntities(excerpt).trim(), contentHtml });
  }
  // channel/feed title = the first <title> BEFORE any item/entry
  const head = xml.replace(/<(item|entry)[\s>][\s\S]*$/i, "");
  return { items, title: decodeEntities(firstTag(head, "title") || "").trim() };
}
function parseSitemap(xml) {
  return { isIndex: /<sitemapindex[\s>]/i.test(String(xml)), locs: [...String(xml).matchAll(/<loc>\s*([\s\S]*?)\s*<\/loc>/gi)].map((m) => decodeEntities(m[1]).trim()) };
}
function parseSitemapUrls(xml) {
  const out = [];
  for (const m of String(xml).matchAll(/<url[\s>][\s\S]*?<\/url>/gi)) {
    const loc = decodeEntities((firstTag(m[0], "loc") || "").trim());
    if (loc) out.push({ loc, lastmod: (firstTag(m[0], "lastmod") || "").trim() });
  }
  return out;
}

// ---- feed discovery + backfill-channel probe --------------------------------
function absolutize(href, base) { try { return new URL(href, base).href; } catch { return href; } }
async function discoverFeedUrl(siteUrl) {
  try {
    const r = await politeFetch(siteUrl, { timeoutMs: 15000 });
    if (r.ok) {
      const html = await r.text();
      for (const l of html.matchAll(/<link\b[^>]*>/gi)) {
        const tag = l[0];
        if (/rel=["']?alternate/i.test(tag) && /type=["']?application\/(rss|atom)\+xml/i.test(tag)) {
          const href = (tag.match(/href=["']([^"']+)["']/i) || [])[1];
          if (href) return absolutize(href, siteUrl);
        }
      }
    }
  } catch {}
  const origin = new URL(siteUrl).origin;
  for (const p of ["/feed/", "/feed", "/rss", "/rss.xml", "/atom.xml", "/index.xml", "/feed.xml"]) {
    try { const r = await politeFetch(origin + p, { timeoutMs: 12000, retries: 1 }); if (r.ok) { const t = await r.text(); if (/<rss|<feed[\s>]/i.test(t)) return origin + p; } } catch {}
  }
  return "";
}
async function findSitemap(origin) {
  for (const p of ["/sitemap.xml", "/sitemap_index.xml", "/wp-sitemap.xml"]) {
    try { const r = await politeFetch(origin + p, { timeoutMs: 12000, retries: 1 }); if (r.ok) { const t = await r.text(); if (/<(urlset|sitemapindex)[\s>]/i.test(t)) return origin + p; } } catch {}
  }
  try { const r = await politeFetch(origin + "/robots.txt", { timeoutMs: 10000, retries: 1 }); if (r.ok) { const m = (await r.text()).match(/Sitemap:\s*(\S+)/i); if (m) return m[1].trim(); } } catch {}
  return "";
}
async function probeBackfill(feed) {
  const origin = new URL(feed.siteUrl || feed.feedUrl).origin;
  try {
    const r = await politeFetch(origin + "/wp-json/wp/v2/posts?per_page=1", { timeoutMs: 12000, retries: 1 });
    if (r.ok && /json/i.test(r.headers.get("content-type") || "")) {
      const j = await r.json();
      if (Array.isArray(j)) return { method: "wpjson", total: Number(r.headers.get("x-wp-total")) || 0 };
    }
  } catch {}
  try {
    const base = feed.feedUrl; const u = base + (base.includes("?") ? "&" : "?") + "paged=2";
    const r = await politeFetch(u, { timeoutMs: 12000, retries: 1 });
    if (r.ok) { const { items } = parseFeed(await r.text()); if (items.length) return { method: "pagedfeed", total: 0 }; }
  } catch {}
  const sm = await findSitemap(origin);
  if (sm) return { method: "sitemap", total: 0, sitemap: sm };
  return { method: "", total: 0 };
}

// ---- folder / id helpers ----------------------------------------------------
function slugify(s) { return String(s || "").toLowerCase().replace(/^https?:\/\//, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "feed"; }
function uniqueId(base) { const feeds = loadFeeds().feeds; let id = base, n = 2; while (feeds.some((f) => f.id === id)) id = `${base}-${n++}`; return id; }
// Every feed folder lives UNDER news/ (D1). A bare "nvidia" → "news/nvidia".
function sanitizeNewsFolder(folder) {
  // segment-wise: drop leading dots (traversal/hidden), blanks → collapses `../../etc` to `etc`
  const parts = String(folder || "").replace(/\\/g, "/").split("/").map((s) => s.replace(/^\.+/, "").trim()).filter(Boolean);
  if (parts[0] !== NEWS_DIR) parts.unshift(NEWS_DIR);
  const f = parts.join("/");
  return (f && f !== NEWS_DIR) ? f : `${NEWS_DIR}/feed`;
}
// index → folder→count in one pass (folder isn't stored on the index; locOf resolves it).
function folderCountMap() {
  const m = new Map();
  for (const id of library.libraryDocIdSet()) { const f = library.locOf(id); m.set(f, (m.get(f) || 0) + 1); }
  return m;
}
function sumFolder(map, folder) { let n = 0; for (const [f, c] of map) if (f === folder || f.startsWith(folder + "/")) n += c; return n; }

async function addFeedInternal({ siteUrl, feedUrl, name, folder } = {}) {
  siteUrl = String(siteUrl || "").trim(); feedUrl = String(feedUrl || "").trim();
  if (!siteUrl && !feedUrl) throw new Error("需要站点或订阅源 URL");
  if (siteUrl && !/^https?:\/\//i.test(siteUrl)) siteUrl = "https://" + siteUrl;
  if (feedUrl && !/^https?:\/\//i.test(feedUrl)) feedUrl = "https://" + feedUrl;
  if (!feedUrl) { feedUrl = await discoverFeedUrl(siteUrl); if (!feedUrl) throw new Error("未能自动发现订阅源，请手动填写 feed URL"); }
  if (!siteUrl) siteUrl = new URL(feedUrl).origin;
  let feedTitle = "";
  try { const r = await politeFetch(feedUrl, { timeoutMs: 15000, retries: 1 }); if (r.ok) feedTitle = parseFeed(await r.text()).title; } catch {}
  const label = String(name || "").trim() || feedTitle || new URL(siteUrl).hostname;
  const base = slugify(name || feedTitle || new URL(siteUrl).hostname);
  const id = uniqueId(base);
  const feed = {
    id, name: label, siteUrl, feedUrl,
    folder: sanitizeNewsFolder(folder || `${NEWS_DIR}/${base}`),
    enabled: true, addedAt: Date.now(), lastPollAt: 0, lastError: "",
    backfill: { method: "", cursor: 0, total: 0, doneAt: 0 },
  };
  loadFeeds().feeds.push(feed); saveFeeds(true);
  try { const p = await probeBackfill(feed); feed.backfill.method = p.method; feed.backfill.total = p.total || 0; if (p.sitemap) feed.sitemapUrl = p.sitemap; saveFeeds(true); } catch {}
  return feed;
}

// docId BASE = "<company>_<date>" — plus "_<HH-MM-SS>" when the feed gave a publish TIME
// (e.g. nvidia_2026-07-07_14-30-00) — instead of the default host+path. NO title (they run
// long). The timestamp usually makes each id unique; if it still collides (date-only feed,
// or identical timestamps) importDocInternal(dedupeUrl) bumps _1/_2/… for a DIFFERENT
// article, while the SAME URL reuses its existing id (poll re-runs / backfill overwrite).
function newsDocId(feed, date, time) {
  const company = String(feed.folder || feed.id || "").split("/").filter(Boolean).pop() || feed.id || "news";
  return [company, date || "", time || ""].filter(Boolean).join("_");
}

// Merge trafilatura's author/categories/tags (news-feeds.md: extracted per article) into the
// fields importDocInternal stores: author→authors, categories+tags→tags (deduped, capped).
function metaFields(meta) {
  const m = meta || {};
  const tags = [...new Set([...(m.categories || []), ...(m.tags || [])].map((s) => String(s).trim()).filter(Boolean))].slice(0, 12);
  return { authors: (m.author || "").trim(), tags };
}
// ---- import one item (shared by backfill; poll goes via the feeditem job) ----
function importItem(feed, { url, title, publishedAt, publishedTime, excerpt, text, images, meta }, ctx) {
  const card = library.excerptCard(excerpt, ctx.language);
  // Feed-provided date wins for the docId; fall back to trafilatura's parsed date so an
  // undated feed still yields "<company>_<YYYY-MM-DD>" instead of a bare "<company>".
  const pub = publishedAt || String((meta && meta.date) || "").slice(0, 10);
  return library.importDocInternal({
    source: `url:${url}`, docId: newsDocId(feed, pub, publishedTime), dedupeUrl: true,
    docKind: "blog", folder: feed.folder,
    title: title || (meta && meta.title) || url, publishedAt: pub,
    ...metaFields(meta),
    text, images: images || [], model: ctx.embedModel || "",
    extraBlocks: card ? [card] : undefined,
  });
}
// Full article text + downloaded images + metadata from a feed item: prefer inline
// content:encoded/content (full HTML), else fetch the page. Returns { text:"", images:[] }
// when nothing usable. Throws TrafilaturaUnavailable up the stack when the sidecar is absent.
async function resolveItem(it, ctx) {
  if (it.contentHtml && it.contentHtml.length > 200) {
    const r = await extractArticle(it.contentHtml, it.url, NEWS_IMAGE_CAP);
    if (r.text && r.text.trim()) return { text: r.text.trim(), images: r.images, meta: r.meta };
  }
  const r = await politeFetch(it.url, { timeoutMs: 20000, signal: ctx.signal, minGapMs: 2000 });
  if (!r.ok) return { text: "", images: [] };
  if (!/html|text|json/i.test(r.headers.get("content-type") || "")) return { text: "", images: [] };
  const out = await extractArticle(await r.text(), it.url, NEWS_IMAGE_CAP);
  return { text: (out.text || "").trim(), images: out.images, meta: out.meta };
}

// Enrich a SINGLE polled article with its WordPress taxonomy. trafilatura reads author/tags
// from the page's HTML meta, but many WP themes (e.g. NVIDIA's) don't emit article:tag there —
// the tags only live in wp-json. Look the post up by slug (?slug=…&_embed) and return the
// authoritative author + category/tag names, or null for non-WP sites / any failure (the caller
// then just keeps trafilatura's own metadata). Mirrors the _embed handling in backfillWpjson.
async function fetchWpTaxonomy(url, signal) {
  try {
    const u = new URL(url);
    const slug = u.pathname.replace(/\/+$/, "").split("/").filter(Boolean).pop();
    if (!slug) return null;
    // _links MUST be in _fields or WordPress returns an empty _embedded (verified).
    const api = `${u.origin}/wp-json/wp/v2/posts?slug=${encodeURIComponent(slug)}&_embed=author,wp:term&_fields=link,_links,_embedded`;
    const r = await politeFetch(api, { timeoutMs: 12000, signal });
    if (!r.ok || !/json/i.test(r.headers.get("content-type") || "")) return null;
    const arr = await r.json();
    if (!Array.isArray(arr) || !arr.length) return null;
    const norm = (s) => String(s || "").replace(/\/+$/, "");
    const post = arr.find((p) => norm(p.link) === norm(url)) || arr[0];
    const emb = post._embedded || {};
    const author = (emb.author && emb.author[0] && emb.author[0].name) || "";
    const terms = [].concat(...(emb["wp:term"] || [])).filter((t) => t && (t.taxonomy === "category" || t.taxonomy === "post_tag")).map((t) => t.name).filter(Boolean);
    return { author, terms };
  } catch { return null; }
}

// ---- backfill engine (one job per feed; imports directly, no sub-jobs) ------
async function backfillWpjson(feed, ctx) {
  const base = new URL(feed.siteUrl || feed.feedUrl).origin + "/wp-json/wp/v2/posts";
  let page = Math.max(1, feed.backfill.cursor || 1), total = feed.backfill.total || 0, totalPages = feed.backfill.totalPages || 0;
  let imported = 0, skipped = 0;
  while (true) {
    if (ctx.signal && ctx.signal.aborted) throw abortErr();
    // _embed pulls the author display-name + category/tag term names into _embedded so we can
    // store them (the numeric author/term IDs in the bare post are useless without a lookup).
    // _links MUST be in _fields or WordPress can't resolve the embeds (they come back empty).
    const u = `${base}?per_page=100&page=${page}&_embed=author,wp:term&_fields=link,title,excerpt,date_gmt,content,_links,_embedded`;
    const r = await politeFetch(u, { timeoutMs: 40000, signal: ctx.signal });
    if (r.status === 400) break;   // WordPress 400s past the last page
    if (!r.ok) throw new Error(`wp-json HTTP ${r.status}`);
    // Read the count headers on the FIRST page seen this run — persisted so a resumed
    // backfill (which already knows `total`) still has `totalPages` to bound the loop.
    if (!totalPages) { total = total || Number(r.headers.get("x-wp-total")) || 0; totalPages = Number(r.headers.get("x-wp-totalpages")) || 0; patchBackfill(feed.id, { total, totalPages }); }
    let posts; try { posts = await r.json(); } catch { break; }
    if (!Array.isArray(posts) || !posts.length) break;
    for (const post of posts) {
      if (ctx.signal && ctx.signal.aborted) throw abortErr();   // respond to a mid-page cancel
      const url = post.link; if (!url || isSeen(feed.id, url)) continue;
      try {
        const { text, images, meta } = await extractArticle(stripCdata(post.content && post.content.rendered || ""), url, NEWS_IMAGE_CAP);
        if (!text || !text.trim()) { skipped++; markSeen(feed.id, [url]); continue; }
        const dt = toDateTime(post.date_gmt ? post.date_gmt + "Z" : "");
        // wp-json _embedded carries the authoritative author + term names → prefer them over
        // trafilatura's (a bare content.rendered fragment rarely has author/category in-body).
        const emb = post._embedded || {};
        const wpAuthor = (emb.author && emb.author[0] && emb.author[0].name) || "";
        // Keep only real category/tag taxonomies — WordPress also embeds an "author" term
        // (the author's archive slug) which is just noise as a tag.
        const wpTerms = [].concat(...(emb["wp:term"] || [])).filter((t) => t && (t.taxonomy === "category" || t.taxonomy === "post_tag")).map((t) => t.name).filter(Boolean);
        const mergedMeta = { ...meta, author: wpAuthor || (meta && meta.author) || "", tags: [...new Set([...(meta && meta.tags || []), ...wpTerms])], categories: [] };
        await importItem(feed, {
          url, text: text.trim(), images, meta: mergedMeta,
          title: decodeEntities(stripCdata(post.title && post.title.rendered || "")).trim(),
          excerpt: post.excerpt && post.excerpt.rendered || "",
          publishedAt: dt.date, publishedTime: dt.time,
        }, ctx);
        imported++;
      } catch (e) { if (e && e.name === "AbortError") throw e; skipped++; }
      markSeen(feed.id, [url]);
      if (ctx.onProgress) ctx.onProgress((page - 1) * 100 + imported + skipped, total || undefined);
    }
    page++; patchBackfill(feed.id, { cursor: page });
    if (totalPages && page > totalPages) break;
  }
  return { imported, skipped };
}
async function backfillPagedFeed(feed, ctx) {
  let page = Math.max(1, feed.backfill.cursor || 1), imported = 0, skipped = 0;
  while (true) {
    if (ctx.signal && ctx.signal.aborted) throw abortErr();
    const base = feed.feedUrl;
    const u = page === 1 ? base : base + (base.includes("?") ? "&" : "?") + "paged=" + page;
    const r = await politeFetch(u, { timeoutMs: 20000, signal: ctx.signal });
    if (!r.ok) break;
    const { items } = parseFeed(await r.text());
    if (!items.length) break;
    let fresh = 0;
    for (const it of items) {
      if (!it.url || isSeen(feed.id, it.url)) continue;
      fresh++;
      try { const { text, images, meta } = await resolveItem(it, ctx); if (text) { await importItem(feed, { ...it, text, images, meta }, ctx); imported++; } else skipped++; }
      catch (e) { if (e && e.name === "AbortError") throw e; skipped++; }
      markSeen(feed.id, [it.url]);
      if (ctx.onProgress) ctx.onProgress(imported + skipped, undefined);
    }
    if (fresh === 0) break;   // a whole page already seen → caught up
    page++; patchBackfill(feed.id, { cursor: page });
  }
  return { imported, skipped };
}
async function collectSitemapUrls(feed, ctx) {
  const origin = new URL(feed.siteUrl || feed.feedUrl).origin;
  const root = feed.sitemapUrl || await findSitemap(origin);
  if (!root) return [];
  const seen = new Set(), urls = [], queue = [root]; let fetches = 0;
  while (queue.length && fetches < 60) {
    if (ctx.signal && ctx.signal.aborted) throw abortErr();
    const sm = queue.shift(); if (seen.has(sm)) continue; seen.add(sm); fetches++;
    let t; try { const r = await politeFetch(sm, { timeoutMs: 20000, signal: ctx.signal }); if (!r.ok) continue; t = await r.text(); } catch { continue; }
    if (/<sitemapindex[\s>]/i.test(t)) {
      const { locs } = parseSitemap(t);
      const posts = locs.filter((l) => /post|blog|article|news/i.test(l));
      for (const l of (posts.length ? posts : locs)) queue.push(l);
    } else { for (const u of parseSitemapUrls(t)) urls.push(u.loc); }
  }
  return [...new Set(urls)].filter((u) => !/\/(category|tag|author|page|feed)\//i.test(u));
}
async function backfillSitemap(feed, ctx) {
  if (!feed._urls) feed._urls = await collectSitemapUrls(feed, ctx);
  const urls = feed._urls;
  patchBackfill(feed.id, { total: urls.length });
  let imported = 0, skipped = 0;
  for (let i = feed.backfill.cursor || 0; i < urls.length; i++) {
    if (ctx.signal && ctx.signal.aborted) throw abortErr();
    if (i % 20 === 0) patchBackfill(feed.id, { cursor: i });
    const url = urls[i]; if (isSeen(feed.id, url)) continue;
    try {
      const r = await politeFetch(url, { timeoutMs: 20000, signal: ctx.signal, minGapMs: 2000 });
      if (!r.ok) { skipped++; markSeen(feed.id, [url]); continue; }
      const html = await r.text();
      const { text, images, meta } = await extractArticle(html, url, NEWS_IMAGE_CAP);
      if (!text || !text.trim()) { skipped++; markSeen(feed.id, [url]); continue; }
      // Prefer trafilatura's cleaned title (og/h1) over the raw <title> (often "Post | Site").
      const title = (meta && meta.title) || decodeEntities((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "").trim();
      // sitemaps carry no publish time → pull it from the page's og/article meta if present.
      const pm = html.match(/property=["']article:published_time["'][^>]*content=["']([^"']+)["']|<time[^>]+datetime=["']([^"']+)["']/i);
      const dt = toDateTime(pm ? (pm[1] || pm[2]) : "");
      await importItem(feed, { url, title, text: text.trim(), images, meta, publishedAt: dt.date, publishedTime: dt.time }, ctx);
      imported++;
    } catch (e) { if (e && e.name === "AbortError") throw e; skipped++; }
    markSeen(feed.id, [url]);
    if (ctx.onProgress) ctx.onProgress(i + 1, urls.length);
  }
  patchBackfill(feed.id, { cursor: urls.length });
  return { imported, skipped };
}
// Entry point for the `backfill` libimport job. Probes the channel on first run, resumes
// from backfill.cursor, and always flushes state/cursor (even on abort) via finally.
async function runBackfill(feedId, ctx = {}) {
  const feed = getFeed(feedId);
  if (!feed) throw new Error("feed not found: " + feedId);
  let method = feed.backfill && feed.backfill.method;
  if (!method) { const p = await probeBackfill(feed); method = p.method; patchBackfill(feedId, { method, total: p.total || 0 }); if (p.sitemap) patchFeed(feedId, { sitemapUrl: p.sitemap }); }
  if (!method) { patchFeed(feedId, { lastError: "无可用回填通道（无 wp-json / 分页 feed / sitemap）" }); return { feedId, method: "", imported: 0, skipped: 0, done: false, error: "no-channel" }; }
  const fresh = getFeed(feedId);   // re-read after the probe patch
  try {
    let r;
    if (method === "wpjson") r = await backfillWpjson(fresh, ctx);
    else if (method === "pagedfeed") r = await backfillPagedFeed(fresh, ctx);
    else if (method === "sitemap") r = await backfillSitemap(fresh, ctx);
    else throw new Error("unknown backfill method: " + method);
    patchBackfill(feedId, { doneAt: Date.now() });
    patchFeed(feedId, { lastError: "" });
    return { feedId, method, imported: r.imported, skipped: r.skipped, done: true };
  } catch (e) {
    // User interrupted the backfill task → STOP importing this source: disable the feed so
    // the poll timer skips it and no backfill auto-resumes (cursor is kept, so re-enabling +
    // 回填历史 continues where it left off). A real error just records lastError.
    if (e && e.name === "AbortError") patchFeed(feedId, { enabled: false, lastError: "已中断，已暂停该源导入（启用后可继续回填）" });
    else patchFeed(feedId, { lastError: String(e.message || e) });
    throw e;
  } finally { flushState(); saveFeeds(true); }
}

// ---- polling ----------------------------------------------------------------
function loopbackPost(pathname, bodyObj) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(bodyObj));
    const req = http.request({ host: "127.0.0.1", port: config.PORT, path: pathname, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": payload.length } },
      (res) => { let d = ""; res.setEncoding("utf8"); res.on("data", (c) => d += c); res.on("end", () => resolve({ status: res.statusCode, text: d })); });
    req.on("error", reject); req.end(payload);
  });
}
function enqueueFeedItem(feed, it, ctx) {
  return loopbackPost("/api/jobs", {
    kind: "libimport", label: "feeditem", conversationId: "__feeds__",
    payload: { type: "feeditem", url: it.url, docId: newsDocId(feed, it.publishedAt, it.publishedTime), title: it.title, publishedAt: it.publishedAt, excerpt: it.excerpt, folder: feed.folder, distill: false, embedModel: ctx.embedModel || "", language: ctx.language || "" },
  });
}
async function pollFeed(feed, ctx = {}) {
  if (!feed.enabled) return { new: 0, skipped: "disabled" };
  let text;
  try { const r = await politeFetch(feed.feedUrl, { timeoutMs: 20000 }); if (!r.ok) throw new Error("HTTP " + r.status); text = await r.text(); }
  catch (e) { patchFeed(feed.id, { lastError: String(e.message || e), lastPollAt: Date.now() }); return { new: 0, error: String(e.message || e) }; }
  const { items } = parseFeed(text);
  let count = 0;
  for (const it of items) {
    if (!it.url || isSeen(feed.id, it.url)) continue;
    markSeen(feed.id, [it.url]);   // mark on ENQUEUE: a failed import is retried via the drawer ↻, not re-enqueued next poll
    count++;
    try { await enqueueFeedItem(feed, it, ctx); } catch (e) { console.warn("[feeds] enqueue", feed.id, e.message); }
  }
  patchFeed(feed.id, { lastPollAt: Date.now(), lastError: "" });
  flushState();
  return { new: count };
}
async function pollAll(ctx = {}) {
  // Extraction requires the trafilatura sidecar (no JS fallback). Skip the whole poll rather
  // than enqueue feeditem jobs that would all fail — the manager UI surfaces the reason.
  if (!(await trafilaturaAvailable())) return { polled: 0, new: 0, error: "trafilatura-unavailable" };
  const feeds = loadFeeds().feeds.filter((f) => f.enabled);
  let total = 0;
  for (const f of feeds) { try { total += (await pollFeed(f, ctx)).new || 0; } catch (e) { console.warn("[feeds] poll", f.id, e.message); } }
  return { polled: feeds.length, new: total };
}

let _pollTimer = null;
function startPolling() {
  const ms = Math.max(1, Number(loadFeeds().pollIntervalH) || 24) * 3600 * 1000;
  if (_pollTimer) clearInterval(_pollTimer);
  _pollTimer = setInterval(() => { pollAll().catch((e) => console.warn("[feeds] pollAll:", e.message)); }, ms);
  if (_pollTimer.unref) _pollTimer.unref();
  // Boot catch-up: poll feeds overdue by a full interval, a little after startup.
  const t = setTimeout(() => {
    const now = Date.now();
    if (loadFeeds().feeds.some((f) => f.enabled && now - (f.lastPollAt || 0) > ms)) pollAll().catch(() => {});
  }, 30000);
  if (t.unref) t.unref();
}

// ---- HTTP handlers ----------------------------------------------------------
async function feedsListHandler(_req, res) {
  try {
    const cfg = loadFeeds(); const counts = folderCountMap();
    const extractorAvailable = await trafilaturaAvailable();   // UI shows a banner + disables poll/backfill when false
    sendJson(res, 200, { ok: true, pollIntervalH: cfg.pollIntervalH, extractorAvailable, feeds: cfg.feeds.map((f) => ({ ...f, _urls: undefined, articles: sumFolder(counts, f.folder) })) });
  } catch (e) { sendJson(res, 500, { ok: false, error: e.message }); }
}
// Shared "sidecar missing" error text (returned by poll-now / backfill when trafilatura is
// absent). Kept short + actionable: name the package and the venv to install it into.
const EXTRACTOR_MISSING = "新闻抽取功能不可用：未检测到 trafilatura。请在 hey-koko 的 Python 环境中安装：pip install trafilatura（或设置 TRAFILATURA_PYTHON 指向已安装它的解释器），然后重启服务。";
async function feedsAddHandler(req, res) {
  let b = {}; try { b = await readBody(req); } catch {}
  try { sendJson(res, 200, { ok: true, feed: await addFeedInternal(b) }); } catch (e) { sendJson(res, 200, { ok: false, error: e.message }); }
}
async function feedsEditHandler(req, res) {
  let b = {}; try { b = await readBody(req); } catch {}
  try {
    if (b.pollIntervalH != null) { loadFeeds().pollIntervalH = Math.max(1, Number(b.pollIntervalH) || 24); saveFeeds(true); startPolling(); }
    if (b.id) {
      const f = getFeed(b.id); if (!f) throw new Error("feed not found");
      for (const k of ["name", "siteUrl", "feedUrl", "enabled"]) if (b[k] != null) f[k] = b[k];
      if (b.folder != null) f.folder = sanitizeNewsFolder(b.folder);
      if (b.enabled === true) f.lastError = "";   // re-enabling clears the "interrupted, paused" note
      saveFeeds(true);
    }
    sendJson(res, 200, { ok: true, feed: b.id ? getFeed(b.id) : null, pollIntervalH: loadFeeds().pollIntervalH });
  } catch (e) { sendJson(res, 200, { ok: false, error: e.message }); }
}
async function feedsDeleteHandler(req, res) {
  let b = {}; try { b = await readBody(req); } catch {}
  try {
    const cfg = loadFeeds(); const i = cfg.feeds.findIndex((f) => f.id === b.id);
    if (i < 0) throw new Error("feed not found");
    cfg.feeds.splice(i, 1); saveFeeds(true);           // D2: removes the SUBSCRIPTION only, never its docs
    if (loadState()[b.id]) { delete _state[b.id]; saveStateNow(); }
    sendJson(res, 200, { ok: true });
  } catch (e) { sendJson(res, 200, { ok: false, error: e.message }); }
}
async function feedsPollNowHandler(req, res) {
  let b = {}; try { b = await readBody(req); } catch {}
  try {
    if (!(await trafilaturaAvailable())) return sendJson(res, 200, { ok: false, error: EXTRACTOR_MISSING, code: "extractor-unavailable" });
    const ctx = { embedModel: b.embedModel, language: b.language };
    if (b.id) { const f = getFeed(b.id); if (!f) throw new Error("feed not found"); sendJson(res, 200, { ok: true, ...(await pollFeed(f, ctx)) }); }
    else sendJson(res, 200, { ok: true, ...(await pollAll(ctx)) });
  } catch (e) { sendJson(res, 200, { ok: false, error: e.message }); }
}
// POST /api/feeds/backfill-estimate { id } → { ok, method, total, known } so the UI can
// warn "will import ~N articles — confirm?" before starting. wp-json gives an exact count
// in ONE request (X-WP-Total); sitemap/paged-feed can't be counted cheaply → known:false.
async function feedsBackfillEstimateHandler(req, res) {
  let b = {}; try { b = await readBody(req); } catch {}
  try {
    if (!(await trafilaturaAvailable())) return sendJson(res, 200, { ok: false, error: EXTRACTOR_MISSING, code: "extractor-unavailable" });
    const f = getFeed(b.id); if (!f) throw new Error("feed not found");
    let method = f.backfill && f.backfill.method;
    if (!method) { const p = await probeBackfill(f); method = p.method; patchBackfill(f.id, { method, total: p.total || 0 }); if (p.sitemap) patchFeed(f.id, { sitemapUrl: p.sitemap }); }
    let total = 0, known = false;
    if (method === "wpjson") {
      const origin = new URL(f.siteUrl || f.feedUrl).origin;
      try { const r = await politeFetch(origin + "/wp-json/wp/v2/posts?per_page=1", { timeoutMs: 12000, retries: 1 }); total = Number(r.headers.get("x-wp-total")) || 0; known = total > 0; } catch {}
      if (known) patchBackfill(f.id, { total });
    }
    // sitemap/pagedfeed: walking them just to count is as costly as the backfill itself →
    // leave known:false; the UI confirms without a number.
    sendJson(res, 200, { ok: true, method: method || "", total, known });
  } catch (e) { sendJson(res, 200, { ok: false, error: e.message }); }
}
// POST /api/feeds/refresh → reconcile the whole news library with the ACTUAL directory:
// (1) prune index entries whose doc file was hand-deleted; (2) rebuild every feed's seen-set
// from the docs that REMAIN on disk (so a deleted article's URL is no longer "seen" and a
// re-poll/回填 re-imports it). Returns the fresh, disk-accurate feed list. See news-feeds.md.
async function feedsRefreshHandler(_req, res) {
  try {
    const removed = library.pruneIndexGhosts();     // index → match disk (drop deleted docs)
    const cfg = loadFeeds();
    const st = loadState();
    for (const f of cfg.feeds) {
      st[f.id] = library.sourcesUnderFolder(f.folder);   // seen = what's actually still imported
      // if everything under this feed is gone, let a backfill restart from scratch
      if (st[f.id].size === 0 && f.backfill && f.backfill.doneAt) patchBackfill(f.id, { cursor: 0, total: 0, totalPages: 0, doneAt: 0 });
    }
    saveStateNow();
    const counts = folderCountMap();
    sendJson(res, 200, { ok: true, removed, pollIntervalH: cfg.pollIntervalH, feeds: cfg.feeds.map((f) => ({ ...f, _urls: undefined, articles: sumFolder(counts, f.folder) })) });
  } catch (e) { sendJson(res, 500, { ok: false, error: e.message }); }
}
async function feedsBackfillHandler(req, res) {
  let b = {}; try { b = await readBody(req); } catch {}
  try {
    if (!(await trafilaturaAvailable())) return sendJson(res, 200, { ok: false, error: EXTRACTOR_MISSING, code: "extractor-unavailable" });
    const f = getFeed(b.id); if (!f) throw new Error("feed not found");
    const r = await loopbackPost("/api/jobs", { kind: "libimport", label: "backfill", conversationId: "__feeds__", payload: { type: "backfill", feedId: f.id, embedModel: b.embedModel || "", language: b.language || "" } });
    let j = {}; try { j = JSON.parse(r.text); } catch {}
    sendJson(res, 200, { ok: true, jobId: j.jobId, feed: f.name });
  } catch (e) { sendJson(res, 200, { ok: false, error: e.message }); }
}

module.exports = {
  startPolling, runBackfill, fetchWpTaxonomy,
  feedsListHandler, feedsAddHandler, feedsEditHandler, feedsDeleteHandler, feedsPollNowHandler, feedsBackfillHandler, feedsBackfillEstimateHandler, feedsRefreshHandler,
  // exported for testing
  parseFeed, parseSitemap, parseSitemapUrls, decodeEntities, toDate, toDateTime, sanitizeNewsFolder, slugify,
  _internal: { loadFeeds, loadState, isSeen, markSeen, getFeed, probeBackfill, discoverFeedUrl, pollFeed, pollAll, addFeedInternal, folderCountMap, sumFolder },
};
