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
// extractArticle = trafilatura (site-agnostic, for FULL pages via pagedfeed/sitemap).
// extractArticleWithImages = layout-preserving built-in (for CLEAN wp-json content.rendered
// fragments — keeps images in position + captions, which trafilatura drops from a fragment).
const { extractArticle, extractArticleWithImages, trafilaturaAvailable } = require("./url-fetch");

const NEWS_DIR = library.NEWS_DIR || "news";
const NEWS_IMAGE_CAP = 8;   // max images downloaded per article (bandwidth/size guard)
const UA = "Mozilla/5.0 (compatible; hey-koko-feeds/1.0)";
// Some hosts (Akamai/Cloudflare-fronted — e.g. blogs.microsoft.com) 403 the honest bot UA on their
// feed/API/article endpoints but serve normally to a real browser UA. A per-site handler opts in
// with `browserUA:true`; uaFor() then returns this for that host across EVERY fetch path (poll RSS,
// feed discovery, backfill, article page) — no per-call threading. siteHandler/siteHostKey are
// hoisted function declarations, resolved at call time (runtime), so referencing them here is safe.
const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
function uaFor(url) { try { const h = siteHandler(siteHostKey(url)); return h && h.browserUA ? BROWSER_UA : UA; } catch { return UA; } }
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
      const res = await fetch(url, { headers: { "User-Agent": uaFor(url), ...headers }, redirect: "follow", signal: ctrl.signal });
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
  const card = library.blankCard(ctx.language);   // news «蒸馏卡» starts BLANK (no excerpt dump); 补卡 fills it later
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
  // A host-pinned page handler (e.g. Microsoft) wins. It takes the BODY from the RSS content:encoded
  // (it.contentHtml — trafilatura would drop its wp-caption images from a full page) and the HERO/meta
  // from the fetched page. Backfill is large (MS ≈ 2160 posts) → fetch the page POLITELY (per-host gap +
  // 429/503/403 backoff + browser UA), not via the raw fetchPageHtml the poll path uses, so a 2000+ run
  // won't trip Akamai. Errors (trafilatura / image-compress) propagate — backfill's catch stops the run.
  const ph = siteHandler(siteHostKey(it.url));
  if (ph && ph.extractPage) {
    let html = null;
    try { const r = await politeFetch(it.url, { timeoutMs: 25000, signal: ctx.signal, minGapMs: 1500 }); if (r.ok && /html/i.test(r.headers.get("content-type") || "")) html = await r.text(); }
    catch (e) { if (e && e.name === "AbortError") throw e; }   // page fetch failed → handler still uses content:encoded (no hero)
    const e = await ph.extractPage(html, it.url, { ...ctx, contentHtml: it.contentHtml });
    if (e && e.text && e.text.trim()) return { text: e.text.trim(), images: e.images, meta: e.meta };
  }
  if (it.contentHtml && it.contentHtml.length > 200) {
    const r = await extractArticle(it.contentHtml, it.url, NEWS_IMAGE_CAP, ctx.signal);
    if (r.text && r.text.trim()) return { text: r.text.trim(), images: r.images, meta: r.meta };
  }
  const r = await politeFetch(it.url, { timeoutMs: 20000, signal: ctx.signal, minGapMs: 2000 });
  if (!r.ok) return { text: "", images: [] };
  if (!/html|text|json/i.test(r.headers.get("content-type") || "")) return { text: "", images: [] };
  const out = await extractArticle(await r.text(), it.url, NEWS_IMAGE_CAP, ctx.signal);
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

// Fetch the FULL wp-json post for a URL (by slug), with everything the WordPress handler needs.
// Returns the post object, or null for non-WordPress sites / not-found / error. This lets the POLL
// path use the same rich, trafilatura-FREE WordPress handler that backfill uses.
async function fetchWpPost(url, signal) {
  try {
    const u = new URL(url);
    const slug = u.pathname.replace(/\/+$/, "").split("/").filter(Boolean).pop();
    if (!slug) return null;
    const api = `${u.origin}/wp-json/wp/v2/posts?slug=${encodeURIComponent(slug)}&_embed=author,wp:term,wp:featuredmedia&_fields=link,title,excerpt,date_gmt,content,_links,_embedded,yoast_head_json.og_description`;
    const r = await politeFetch(api, { timeoutMs: 15000, signal });
    if (!r.ok || !/json/i.test(r.headers.get("content-type") || "")) return null;
    const arr = await r.json();
    if (!Array.isArray(arr) || !arr.length) return null;
    const norm = (s) => String(s || "").replace(/\/+$/, "");
    return arr.find((p) => norm(p.link) === norm(url)) || arr[0];
  } catch { return null; }
}

// Fetch an article's full HTML page (for the trafilatura fallback + any extractPage handler).
async function fetchPageHtml(url, signal) {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": uaFor(url) }, redirect: "follow",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(25000)]) : AbortSignal.timeout(25000),
    });
    if (!res.ok || !/html/i.test(res.headers.get("content-type") || "")) return null;
    return await res.text();
  } catch { return null; }
}

// ---- Per-site article handlers -----------------------------------------------------------------
// Rich article extraction is inherently PER-SITE: company blogs differ enough that one generic
// extractor loses images / layout / metadata (historically almost every blog needed its own
// custom handling). This registry makes that explicit and extensible. Resolution order for a
// given article:
//   1) a bespoke handler pinned to the host in SITE_HANDLERS (add one per company as needed);
//   2) else, if the site exposes wp-json → the WORDPRESS handler (extractWordPressPost);
//   3) else → the site-agnostic trafilatura FULL-PAGE path (extractArticle).
// The WordPress handler was tuned & verified on **NVIDIA blogs**; it also works for WordPress
// sites in general (Meta Engineering, etc.) — but treat that as "probably", not "guaranteed":
// a site that extracts poorly should get its own entry here rather than bending the WP handler.
// Host key for handler matching — bare hostname, www stripped (distinct from hostOf's host:port,
// which the rate-limiter uses). Kept separate so a duplicate function declaration can't silently
// override the rate-limiter's hostOf.
function siteHostKey(u) { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } }

// WordPress (wp-json) article handler — tuned & verified on NVIDIA blogs.
//   • body: content.rendered via the LAYOUT-PRESERVING built-in (images stay in position + their
//     <figcaption>; trafilatura drops both from a bare fragment);
//   • hero: featured_media source_url from the embed → prepended as image_1 (not in content.rendered,
//     and /media is often 401 — the embed inlines it);
//   • lead dek: yoast_head_json.og_description (the curated summary, absent from the body);
//   • author + category/tag names: from _embed (content.rendered carries none).
// Returns { text, images, meta, title, publishedAt, publishedTime } or null if the body is empty.
async function extractWordPressPost(post, url, ctx) {
  const fm = (post._embedded && post._embedded["wp:featuredmedia"]) || [];
  const heroUrl = (fm[0] && fm[0].source_url) || "";
  const frag = stripCdata(post.content && post.content.rendered || "");
  const heroHtml = /^https?:\/\//i.test(heroUrl) ? `<figure><img src="${heroUrl.replace(/"/g, "%22")}"/></figure>` : "";
  const { text: body, images } = await extractArticleWithImages(heroHtml + frag, url, NEWS_IMAGE_CAP, ctx.signal);
  if (!body || !body.trim()) return null;
  const dek = String((post.yoast_head_json && post.yoast_head_json.og_description) || "").replace(/\s+/g, " ").trim();
  const emb = post._embedded || {};
  const wpAuthor = (emb.author && emb.author[0] && emb.author[0].name) || "";
  const wpTerms = [].concat(...(emb["wp:term"] || [])).filter((t) => t && (t.taxonomy === "category" || t.taxonomy === "post_tag")).map((t) => t.name).filter(Boolean);
  const dt = toDateTime(post.date_gmt ? post.date_gmt + "Z" : "");
  return {
    text: (dek ? `*${dek}*\n\n` : "") + body.trim(),
    images,
    meta: { author: wpAuthor, tags: wpTerms, categories: [] },
    title: decodeEntities(stripCdata(post.title && post.title.rendered || "")).trim(),
    publishedAt: dt.date, publishedTime: dt.time,
  };
}

// Microsoft official blog (blogs.microsoft.com) — WordPress, but its wp-json REST API is
// deliberately restricted (401 rest_forbidden) AND the site is Akamai-fronted (the bot UA gets a
// 403), so neither the wp-json handler nor the honest UA work. Extraction mirrors the NVIDIA wp-json
// handler, sourced differently: BODY from the RSS content:encoded (the clean WP post body — it keeps
// the wp-caption/lazy body images that trafilatura DROPS from a full page) via the layout-preserving
// built-in; HERO from the page og:image; dek/author/date/tags from the page meta + rel="tag" links.
// See extractMicrosoftPage. Needs the browser UA (browserUA) + trafilatura for the bare-URL fallback.
// The article's featured/hero image (og:image). For a text-only post this is Microsoft's default
// "Official Microsoft Blog" header banner — still the image the article actually shows, so import it
// (the user wants it) rather than treating it as a placeholder to skip.
function msOgImage(html) {
  const m = String(html).match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
        || String(html).match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
  return m ? decodeEntities(m[1]).trim() : "";
}
function msTagNames(html) {
  const names = [...String(html).matchAll(/rel=["']tag["'][^>]*>([^<]+)</gi)].map((m) => decodeEntities(m[1]).trim()).filter(Boolean);
  return [...new Set(names)].slice(0, 12);
}
// One <meta property|name="prop" content="…"> value (both attribute orders), entity-decoded.
function metaContent(html, prop) {
  const p = prop.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = String(html).match(new RegExp(`<meta[^>]+(?:property|name)=["']${p}["'][^>]+content=["']([^"']*)["']`, "i"))
        || String(html).match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${p}["']`, "i"));
  return m ? decodeEntities(m[1]).trim() : "";
}
async function extractMicrosoftPage(html, url, ctx) {
  html = html || "";
  const cap = ctx && ctx.images === false ? 0 : NEWS_IMAGE_CAP;
  const hero = msOgImage(html);
  const heroHtml = /^https?:\/\//i.test(hero) ? `<figure><img src="${hero.replace(/"/g, "%22")}"/></figure>` : "";
  // content:encoded (ctx.contentHtml) = the clean WP post body; it KEEPS the wp-caption/lazy body
  // images that trafilatura DROPS from a full page → run the LAYOUT-PRESERVING built-in (images in
  // position + captions) + og:image hero as image_1 (mirrors the NVIDIA wp-json handler). Bare URL
  // with no content:encoded → fall back to full-page trafilatura (may drop wp-caption images).
  const frag = ctx && ctx.contentHtml ? stripCdata(String(ctx.contentHtml)) : "";
  let body, images, tMeta = {};
  if (frag && frag.length > 200) {
    const r = await extractArticleWithImages(heroHtml + frag, url, cap, ctx && ctx.signal);
    body = r.text; images = r.images;
  } else if (html) {
    const r = await extractArticle(html, url, cap, ctx && ctx.signal, hero);
    body = r.text; images = r.images; tMeta = r.meta || {};
  } else return null;
  if (!body || !body.trim()) return null;
  const dek = (metaContent(html, "og:description") || tMeta.description || "").replace(/\s+/g, " ").trim();
  const text = (dek && !body.trimStart().startsWith(dek.slice(0, 40)) ? `*${dek}*\n\n` : "") + body.trim();
  const dt = toDateTime(metaContent(html, "article:published_time") || tMeta.date || "");
  const title = (metaContent(html, "og:title") || tMeta.title || "").replace(/\s*[|–-]\s*The Official Microsoft Blog\s*$/i, "").trim();
  return {
    text, images,
    meta: { author: (metaContent(html, "author") || tMeta.author || "").trim(), tags: msTagNames(html), categories: [] },
    title, publishedAt: dt.date, publishedTime: dt.time,
  };
}

// Bespoke per-company handlers, keyed by host (exact or registrable domain). To pin/override a
// company: add `{ extractPost(post,url,ctx){…} }` (wp-json sites → gets the raw post) or
// `{ extractPage(html,url,ctx){…} }` (full-HTML sites → gets the fetched page). A pinned handler
// wins over the wp-json/trafilatura defaults for that host.
const SITE_HANDLERS = {
  // NVIDIA blogs — the WordPress handler was built and verified HERE, so NVIDIA is pinned
  // explicitly (its tuning is a named, first-class handler in code, not an implicit default).
  // Other WordPress sites ride the SAME handler as a best-effort default via the wp-json channel
  // (see backfillWpjson's fallback); add them here once individually verified. (To make the rich
  // handler NVIDIA-ONLY, change that fallback from `extractWordPressPost` to the trafilatura path.)
  "blogs.nvidia.com": { name: "nvidia", extractPost: extractWordPressPost },
  // Microsoft official blog — WordPress but wp-json is locked (401 rest_forbidden) and the site is
  // Akamai-fronted (bot UA → 403). Can't use the wp-json handler; instead a browser-UA full-page
  // fetch (browserUA) + trafilatura extractor (needsTrafilatura), hero from og:image.
  "blogs.microsoft.com": { name: "microsoft", extractPage: extractMicrosoftPage, browserUA: true, needsTrafilatura: true },
};
function siteHandler(host) {
  const h = String(host || "").replace(/^www\./, "");
  return SITE_HANDLERS[h] || SITE_HANDLERS[h.split(".").slice(-2).join(".")] || null;
}

// Unified single-article extraction (used by the POLL path — jobs.js feeditem — so a WordPress
// site uses its rich, trafilatura-FREE handler exactly like backfill does, instead of the old
// full-page trafilatura route). Resolution: host-pinned handler → generic WordPress (wp-json) →
// trafilatura full page. Returns { text, images, meta:{author,tags,categories}, title,
// publishedAt, publishedTime, usedTrafilatura } or null. Throws TrafilaturaUnavailable only when
// it actually falls to the trafilatura branch and the sidecar is missing.
async function extractArticleForUrl(url, ctx = {}) {
  const max = ctx.images === false ? 0 : NEWS_IMAGE_CAP;
  const custom = siteHandler(siteHostKey(url));
  // 1) host-pinned handler — wp-json (extractPost) or full-HTML (extractPage).
  if (custom && custom.extractPost) {
    const post = await fetchWpPost(url, ctx.signal);
    if (post) { const e = await custom.extractPost(post, url, ctx); if (e && e.text && e.text.trim()) return { ...e, usedTrafilatura: false }; }
  }
  if (custom && custom.extractPage) {
    // ctx.contentHtml (the RSS content:encoded, plumbed from the feeditem job) is the body source;
    // the page supplies the hero + meta. Call the handler even if the page fetch failed (html null) —
    // it still extracts the body from content:encoded.
    const html = await fetchPageHtml(url, ctx.signal);
    const e = await custom.extractPage(html, url, ctx);
    if (e && e.text && e.text.trim()) return { ...e, usedTrafilatura: !!custom.needsTrafilatura };
  }
  // 2) generic WordPress via wp-json → the built-in layout-preserving handler (no trafilatura).
  const post = await fetchWpPost(url, ctx.signal);
  if (post) { const e = await extractWordPressPost(post, url, ctx); if (e && e.text && e.text.trim()) return { ...e, usedTrafilatura: false }; }
  // 3) site-agnostic trafilatura full page (+ og:description dek + merged categories/tags).
  const html = await fetchPageHtml(url, ctx.signal);
  if (!html) return null;
  const out = await extractArticle(html, url, max, ctx.signal);
  if (!out || !out.text || !out.text.trim()) return null;
  const m = out.meta || {};
  const dek = String(m.description || "").replace(/\s+/g, " ").trim();
  const body = (dek && !out.text.trimStart().startsWith(dek.slice(0, 40)) ? `*${dek}*\n\n` : "") + out.text;
  const tags = [...new Set([...(m.categories || []), ...(m.tags || [])].map((s) => String(s).trim()).filter(Boolean))];
  return {
    text: body, images: out.images,
    meta: { author: (m.author || "").trim(), tags, categories: [] },
    title: m.title || "", publishedAt: String(m.date || "").slice(0, 10), publishedTime: "",
    usedTrafilatura: true,
  };
}

// Does this feed's extraction fall to the trafilatura path? NO for a host-pinned handler or a
// WordPress site (they use the built-in). Uses the cached backfill channel when known; otherwise
// probes wp-json once (cheap). Drives the per-feed availability guards + the UI banner, so the
// news feature is only "blocked without trafilatura" for feeds that genuinely need it.
async function feedNeedsTrafilatura(feed, signal) {
  const custom = siteHandler(siteHostKey(feed.siteUrl || feed.feedUrl));
  // A dedicated handler declares its own need: NVIDIA (wp-json, built-in) → false; Microsoft
  // (full-page trafilatura) → true. So the guards/banner correctly require trafilatura for it.
  if (custom && (custom.extractPost || custom.extractPage)) return !!custom.needsTrafilatura;
  if (feed.backfill && feed.backfill.method === "wpjson") return false;      // known WordPress
  if (feed.backfill && (feed.backfill.method === "pagedfeed" || feed.backfill.method === "sitemap")) return true;
  try {                                                                      // unprobed → cheap wp-json check
    const origin = new URL(feed.siteUrl || feed.feedUrl).origin;
    const r = await politeFetch(origin + "/wp-json/wp/v2/posts?per_page=1", { timeoutMs: 10000, signal, retries: 0 });
    if (r.ok && /json/i.test(r.headers.get("content-type") || "")) return false;   // WordPress
  } catch { /* fall through */ }
  return true;
}

// Cheap, NETWORK-FREE variant for the list endpoint (rendered often): only the cached channel +
// dedicated flag; an unprobed non-dedicated feed is assumed to (maybe) need trafilatura.
function feedNeedsTrafilaturaCached(feed) {
  const custom = siteHandler(siteHostKey(feed.siteUrl || feed.feedUrl));
  if (custom && (custom.extractPost || custom.extractPage)) return !!custom.needsTrafilatura;
  return !(feed.backfill && feed.backfill.method === "wpjson");
}

// ---- backfill engine (one job per feed; imports directly, no sub-jobs) ------
async function backfillWpjson(feed, ctx) {
  const base = new URL(feed.siteUrl || feed.feedUrl).origin + "/wp-json/wp/v2/posts";
  let page = Math.max(1, feed.backfill.cursor || 1), total = feed.backfill.total || 0, totalPages = feed.backfill.totalPages || 0;
  let imported = 0, skipped = 0;
  while (true) {
    if (ctx.signal && ctx.signal.aborted) throw abortErr();
    // _embed pulls the author name + category/tag terms + FEATURED IMAGE into _embedded. The
    // featured image (the article's main/hero image) is NOT in content.rendered and its /media
    // endpoint is often auth-gated (401) — but _embed=wp:featuredmedia returns its source_url
    // inline. _links MUST be in _fields or WordPress can't resolve the embeds (they come back empty).
    // yoast_head_json.og_description = the curated one-line SUMMARY (SEO/social meta) — NOT in
    // content.rendered; used as the article's lead "dek". Nested _fields keeps the payload tiny.
    const u = `${base}?per_page=100&page=${page}&_embed=author,wp:term,wp:featuredmedia&_fields=link,title,excerpt,date_gmt,content,_links,_embedded,yoast_head_json.og_description`;
    const r = await politeFetch(u, { timeoutMs: 40000, signal: ctx.signal });
    if (r.status === 400) break;   // WordPress 400s past the last page
    if (!r.ok) throw new Error(`wp-json HTTP ${r.status}`);
    // Read the count headers on the FIRST page seen this run — persisted so a resumed
    // backfill (which already knows `total`) still has `totalPages` to bound the loop.
    if (!totalPages) { total = total || Number(r.headers.get("x-wp-total")) || 0; totalPages = Number(r.headers.get("x-wp-totalpages")) || 0; patchBackfill(feed.id, { total, totalPages }); }
    let posts; try { posts = await r.json(); } catch { break; }
    if (!Array.isArray(posts) || !posts.length) break;
    for (let j = 0; j < posts.length; j++) {
      const post = posts[j];
      if (ctx.signal && ctx.signal.aborted) throw abortErr();   // respond to a mid-page cancel
      // Report the TRUE absolute article position — (page-1)*100 + index — for EVERY post,
      // including ones skipped as already-seen. Otherwise a resumed backfill (which re-scans the
      // partly-done page, silently skipping seen items) appears frozen at the page's baseline
      // (e.g. "201") because only newly-imported items bumped the counter. Throttle the
      // seen-skip updates (every 10th) so a fully-seen page doesn't spam the SSE stream.
      const pos = (page - 1) * 100 + j + 1;
      const url = post.link;
      if (!url || isSeen(feed.id, url)) { if (ctx.onProgress && j % 10 === 0) ctx.onProgress(pos, total || undefined); continue; }
      // Only mark an article "seen" when we actually finished with it (imported, or legitimately
      // empty). A THROWN extraction error must NOT burn it: leaving it un-seen lets the next run
      // retry, instead of silently skipping it forever (this is how a systemic failure — e.g.
      // trafilatura absent — could leave a cursor at 201 with nothing actually imported).
      let handled = false;
      try {
        // Dispatch to the per-site handler: a host-pinned one if present, else the shared WordPress
        // handler (extractWordPressPost — tuned on NVIDIA). Both keep images in position + captions,
        // hero as image_1, og:description as the lead dek, and author/tags from _embed.
        const custom = siteHandler(siteHostKey(url));
        const extracted = custom && custom.extractPost
          ? await custom.extractPost(post, url, ctx)
          : await extractWordPressPost(post, url, ctx);
        if (!extracted || !extracted.text || !extracted.text.trim()) { skipped++; handled = true; markSeen(feed.id, [url]); if (ctx.onProgress) ctx.onProgress(pos, total || undefined); continue; }
        await importItem(feed, { url, ...extracted }, ctx);
        imported++; handled = true;
      } catch (e) {
        if (e && e.name === "AbortError") throw e;                 // user interrupt → stop
        if (e && e.name === "TrafilaturaUnavailable") throw e;     // sidecar gone → stop, don't burn the rest
        if (e && e.name === "ImageBackendMissing") throw e;        // no image compressor → stop the whole run
        skipped++;                                                 // transient error (incl. per-image compress fail) → leave un-seen, retry
      }
      if (handled) markSeen(feed.id, [url]);
      if (ctx.onProgress) ctx.onProgress(pos, total || undefined);
    }
    page++; patchBackfill(feed.id, { cursor: page });
    if (totalPages && page > totalPages) break;
  }
  return { imported, skipped };
}
async function backfillPagedFeed(feed, ctx) {
  let page = Math.max(1, feed.backfill.cursor || 1), imported = 0, skipped = 0;
  // Progress-bar total: a paged feed can't count itself, but the site's sitemap can — reuse the
  // estimate's stored total, else compute it once here, so the bar shows i/N (not a bare count / "queued").
  let total = feed.backfill.total || 0;
  if (!total) { try { total = (await countSitemapPosts(feed, ctx.signal)).total || 0; if (total) patchBackfill(feed.id, { total }); } catch {} }
  let pageSize = 0;   // captured from the first page → absolute article position = (page-1)*pageSize + i + 1
  // URLs fetched THIS run. Used to detect a feed that CLAMPS (repeats a page once you page past its
  // end) — the true "no more pages" signal for feeds that don't 404/empty at the end. We must NOT
  // stop just because a page's items are all already-SEEN: the poll (and the boot catch-up poll)
  // imports the LATEST page and marks it seen, so page 1 is essentially always fully-seen — the old
  // `fresh===0 break` therefore stopped the backfill on page 1 and it never reached the history.
  const runUrls = new Set();
  while (true) {
    if (ctx.signal && ctx.signal.aborted) throw abortErr();
    const base = feed.feedUrl;
    const u = page === 1 ? base : base + (base.includes("?") ? "&" : "?") + "paged=" + page;
    const r = await politeFetch(u, { timeoutMs: 20000, signal: ctx.signal });
    if (!r.ok) break;
    const { items } = parseFeed(await r.text());
    if (!items.length) break;   // past the last page (feeds that 404/empty at the end)
    if (!pageSize) pageSize = items.length || 10;
    let pageHasNewUrl = false;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const pos = (page - 1) * pageSize + i + 1;   // absolute position in the archive → drives the bar (like wpjson)
      if (!it.url) continue;
      if (!runUrls.has(it.url)) { runUrls.add(it.url); pageHasNewUrl = true; }
      if (isSeen(feed.id, it.url)) { if (ctx.onProgress) ctx.onProgress(pos, total || undefined); continue; }   // already imported → skip import but still advance the bar
      let handled = false;
      try { const { text, images, meta } = await resolveItem(it, ctx); if (text) { await importItem(feed, { ...it, text, images, meta }, ctx); imported++; } else skipped++; handled = true; }
      catch (e) { if (e && (e.name === "AbortError" || e.name === "TrafilaturaUnavailable" || e.name === "ImageBackendMissing")) throw e; skipped++; }   // transient error → leave un-seen for retry
      if (handled) markSeen(feed.id, [it.url]);
      if (ctx.onProgress) ctx.onProgress(pos, total || undefined);
    }
    // Stop only when a page repeats ONLY earlier pages' URLs (feed clamped past its end). A page whose
    // items are already-seen but NEW to this run (the poll-imported latest page) is NOT the end.
    if (!pageHasNewUrl) break;
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
// Count posts via the site's sitemap for the backfill ESTIMATE — a Yoast/WP sitemap lists every
// post URL compactly, so we can size the backfill WITHOUT walking it article-by-article (which is
// as costly as the backfill itself). Returns { total, approx } — approx:true when there were more
// post sub-sitemaps than the CAP we sampled. Used for the pagedfeed/sitemap channels so their
// confirm dialog can still show ~N (wp-json already has an exact X-WP-Total). A pagedfeed that is
// truncated may import fewer than this, so it reads as an upper-bound "约 N".
async function countSitemapPosts(feed, signal) {
  const origin = new URL(feed.siteUrl || feed.feedUrl).origin;
  const root = feed.sitemapUrl || await findSitemap(origin);
  if (!root) return { total: 0, approx: false };
  const notPost = (u) => /\/(category|tag|author|page|feed)\//i.test(u);
  // Sitemaps are static XML (not the bot-protected article pages) → a short gap keeps the estimate snappy.
  let t; try { const r = await politeFetch(root, { timeoutMs: 15000, signal, retries: 1, minGapMs: 250 }); if (!r.ok) return { total: 0, approx: false }; t = await r.text(); } catch { return { total: 0, approx: false }; }
  if (!/<sitemapindex[\s>]/i.test(t)) return { total: parseSitemapUrls(t).filter((u) => !notPost(u.loc)).length, approx: false };
  const { locs } = parseSitemap(t);
  const postSm = locs.filter((l) => /post|blog|article|news/i.test(l));
  const subs = postSm.length ? postSm : locs;
  const CAP = 20; let total = 0;
  for (const sm of subs.slice(0, CAP)) {
    if (signal && signal.aborted) break;
    try { const r = await politeFetch(sm, { timeoutMs: 15000, signal, retries: 1, minGapMs: 250 }); if (r.ok) total += parseSitemapUrls(await r.text()).filter((u) => !notPost(u.loc)).length; } catch {}
  }
  return { total, approx: subs.length > CAP };
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
    let handled = false;
    try {
      const r = await politeFetch(url, { timeoutMs: 20000, signal: ctx.signal, minGapMs: 2000 });
      if (!r.ok) { skipped++; handled = true; markSeen(feed.id, [url]); if (ctx.onProgress) ctx.onProgress(i + 1, urls.length); continue; }
      const html = await r.text();
      const { text, images, meta } = await extractArticle(html, url, NEWS_IMAGE_CAP, ctx.signal);
      if (!text || !text.trim()) { skipped++; handled = true; markSeen(feed.id, [url]); if (ctx.onProgress) ctx.onProgress(i + 1, urls.length); continue; }
      // Prefer trafilatura's cleaned title (og/h1) over the raw <title> (often "Post | Site").
      const title = (meta && meta.title) || decodeEntities((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "").trim();
      // sitemaps carry no publish time → pull it from the page's og/article meta if present.
      const pm = html.match(/property=["']article:published_time["'][^>]*content=["']([^"']+)["']|<time[^>]+datetime=["']([^"']+)["']/i);
      const dt = toDateTime(pm ? (pm[1] || pm[2]) : "");
      await importItem(feed, { url, title, text: text.trim(), images, meta, publishedAt: dt.date, publishedTime: dt.time }, ctx);
      imported++; handled = true;
    } catch (e) { if (e && (e.name === "AbortError" || e.name === "TrafilaturaUnavailable" || e.name === "ImageBackendMissing")) throw e; skipped++; }   // transient error → leave un-seen for retry
    if (handled) markSeen(feed.id, [url]);
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
    // pausedByInterrupt marks an AUTO pause (vs. a manual 暂停) so 🔄 refresh AND the next server
    // startup can lift it, while leaving deliberately-paused feeds alone.
    if (e && e.name === "AbortError") patchFeed(feedId, { enabled: false, pausedByInterrupt: true, lastError: INTERRUPT_NOTE });
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
  // Only sites with a dedicated extractPage handler (e.g. Microsoft) consume content:encoded as the
  // BODY source; carry it in the payload for them (capped) so the poll path gets the same wp-caption
  // body images as backfill. Other feeds (wp-json / trafilatura) don't use it → keep their payload lean.
  const ph = siteHandler(siteHostKey(it.url));
  const contentHtml = (ph && ph.extractPage && it.contentHtml) ? String(it.contentHtml).slice(0, 300000) : undefined;
  return loopbackPost("/api/jobs", {
    kind: "libimport", label: "feeditem", conversationId: "__feeds__",
    payload: { type: "feeditem", url: it.url, docId: newsDocId(feed, it.publishedAt, it.publishedTime), title: it.title, publishedAt: it.publishedAt, excerpt: it.excerpt, contentHtml, folder: feed.folder, distill: false, embedModel: ctx.embedModel || "", language: ctx.language || "" },
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
  // Per-feed trafilatura gate: WordPress/dedicated feeds (e.g. NVIDIA) extract WITHOUT trafilatura,
  // so poll them regardless. Only feeds that would fall to the trafilatura full-page path are
  // skipped when the sidecar is missing (their feeditem jobs would otherwise all fail).
  const avail = await trafilaturaAvailable();
  const feeds = loadFeeds().feeds.filter((f) => f.enabled);
  let total = 0, skipped = 0;
  for (const f of feeds) {
    try {
      if (!avail && (await feedNeedsTrafilatura(f, ctx.signal))) { skipped++; continue; }
      total += (await pollFeed(f, ctx)).new || 0;
    } catch (e) { console.warn("[feeds] poll", f.id, e.message); }
  }
  return { polled: feeds.length - skipped, new: total, skippedNoExtractor: skipped };
}

// Note left on a feed that was auto-paused because its backfill job was interrupted.
const INTERRUPT_NOTE = "已中断，已暂停该源导入（启用后可继续回填）";

// A restart KILLS any running backfill, and that abort re-flags the feed as "interrupted,
// paused" — so a paused/⚠️ state would reappear on every boot even though nothing is running.
// Clear it at startup: an interrupt-pause is a within-session "stop now", not a persistent
// setting (a deliberate 暂停 sets enabled:false WITHOUT the flag/note, so it survives). Matches
// both the flag (new) and the legacy note string (feeds paused before the flag existed).
function clearInterruptPauses() {
  const cfg = loadFeeds();
  let changed = 0;
  for (const f of cfg.feeds) {
    if (f.pausedByInterrupt || (typeof f.lastError === "string" && f.lastError.indexOf("已中断") === 0)) {
      f.enabled = true; f.lastError = ""; delete f.pausedByInterrupt; changed++;
    }
  }
  if (changed) { saveFeeds(true); console.log(`[feeds] cleared ${changed} interrupt-paused feed(s) on startup`); }
}

let _pollTimer = null, _booted = false;
function startPolling() {
  // Runs once at server startup (startPolling is also re-invoked on poll-interval changes,
  // where we must NOT wipe a user's mid-session interrupt-pause).
  if (!_booted) { _booted = true; try { clearInterruptPauses(); } catch (e) { console.warn("[feeds] clearInterruptPauses:", e.message); } }
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
    const extractorAvailable = await trafilaturaAvailable();
    // Per feed: dedicated = host has a bespoke SITE_HANDLERS entry (✅ in the UI). needsTrafilatura =
    // this feed falls to the trafilatura path (non-WordPress). The banner shows only when trafilatura
    // is missing AND at least one enabled feed actually needs it — dedicated/WordPress feeds don't.
    const feeds = cfg.feeds.map((f) => {
      const h = siteHandler(siteHostKey(f.siteUrl || f.feedUrl));
      return { ...f, _urls: undefined, articles: sumFolder(counts, f.folder), dedicated: !!h, handlerName: h ? (h.name || "custom") : "", needsTrafilatura: feedNeedsTrafilaturaCached(f) };
    });
    const needExtractor = feeds.some((f) => f.enabled && f.needsTrafilatura);
    sendJson(res, 200, { ok: true, pollIntervalH: cfg.pollIntervalH, extractorAvailable, needExtractor, feeds });
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
      if (b.enabled === true) { f.lastError = ""; delete f.pausedByInterrupt; }   // re-enabling clears the "interrupted, paused" note
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
    const ctx = { embedModel: b.embedModel, language: b.language };
    if (b.id) {
      const f = getFeed(b.id); if (!f) throw new Error("feed not found");
      // Only block when this feed actually needs trafilatura (non-WordPress) and it's missing.
      if (!(await trafilaturaAvailable()) && (await feedNeedsTrafilatura(f))) return sendJson(res, 200, { ok: false, error: EXTRACTOR_MISSING, code: "extractor-unavailable" });
      sendJson(res, 200, { ok: true, ...(await pollFeed(f, ctx)) });
    } else sendJson(res, 200, { ok: true, ...(await pollAll(ctx)) });   // pollAll skips per-feed internally
  } catch (e) { sendJson(res, 200, { ok: false, error: e.message }); }
}
// POST /api/feeds/backfill-estimate { id } → { ok, method, total, known } so the UI can
// warn "will import ~N articles — confirm?" before starting. wp-json gives an exact count
// in ONE request (X-WP-Total); sitemap/paged-feed can't be counted cheaply → known:false.
async function feedsBackfillEstimateHandler(req, res) {
  let b = {}; try { b = await readBody(req); } catch {}
  try {
    const f = getFeed(b.id); if (!f) throw new Error("feed not found");
    let method = f.backfill && f.backfill.method;
    if (!method) { const p = await probeBackfill(f); method = p.method; patchBackfill(f.id, { method, total: p.total || 0 }); if (p.sitemap) patchFeed(f.id, { sitemapUrl: p.sitemap }); }
    // Guard AFTER the probe: now feedNeedsTrafilatura knows the channel (wpjson → no trafilatura).
    if (!(await trafilaturaAvailable()) && (await feedNeedsTrafilatura(f))) return sendJson(res, 200, { ok: false, error: EXTRACTOR_MISSING, code: "extractor-unavailable" });
    let total = 0, known = false, approx = false;
    if (method === "wpjson") {
      const origin = new URL(f.siteUrl || f.feedUrl).origin;
      try { const r = await politeFetch(origin + "/wp-json/wp/v2/posts?per_page=1", { timeoutMs: 12000, retries: 1 }); total = Number(r.headers.get("x-wp-total")) || 0; known = total > 0; } catch {}
    } else {
      // pagedfeed/sitemap can't be counted by walking the feed (as costly as the backfill), but the
      // site's sitemap lists every post URL compactly → count those. Gives ~N even for pagedfeed.
      try { const c = await countSitemapPosts(f); total = c.total; approx = c.approx; known = total > 0; } catch {}
    }
    if (known) patchBackfill(f.id, { total });
    sendJson(res, 200, { ok: true, method: method || "", total, known, approx });
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
      // A feed auto-paused by a prior interrupt is lifted here (refresh = "reset & recheck"):
      // re-enable it and clear the stale "已中断…" note. A MANUAL 暂停 (no pausedByInterrupt flag)
      // is left untouched.
      if (f.pausedByInterrupt || (typeof f.lastError === "string" && f.lastError.indexOf("已中断") === 0)) { f.enabled = true; f.lastError = ""; delete f.pausedByInterrupt; }
      const bf = f.backfill || {};
      // if everything under this feed is gone, let a backfill restart from scratch
      if (st[f.id].size === 0 && bf.doneAt) patchBackfill(f.id, { cursor: 0, total: 0, totalPages: 0, doneAt: 0 });
      // a PARTLY-DONE backfill (interrupted) resumes from its page cursor, so its progress bar
      // reappears mid-way (e.g. "201"). Refresh rewinds the cursor to 0 so the next 回填 re-scans
      // from the top — already-imported articles are skipped via the (disk-rebuilt) seen-set, so
      // this re-checks for gaps without re-importing. (cursor 0 works for all channels.)
      else if (!bf.doneAt && (bf.cursor || 0) > 0) patchBackfill(f.id, { cursor: 0 });
    }
    saveStateNow(); saveFeeds(true);   // persist seen-set AND the re-enable/cursor changes above
    const counts = folderCountMap();
    sendJson(res, 200, { ok: true, removed, pollIntervalH: cfg.pollIntervalH, feeds: cfg.feeds.map((f) => ({ ...f, _urls: undefined, articles: sumFolder(counts, f.folder) })) });
  } catch (e) { sendJson(res, 500, { ok: false, error: e.message }); }
}
async function feedsBackfillHandler(req, res) {
  let b = {}; try { b = await readBody(req); } catch {}
  try {
    const f = getFeed(b.id); if (!f) throw new Error("feed not found");
    if (!(await trafilaturaAvailable()) && (await feedNeedsTrafilatura(f))) return sendJson(res, 200, { ok: false, error: EXTRACTOR_MISSING, code: "extractor-unavailable" });
    const r = await loopbackPost("/api/jobs", { kind: "libimport", label: "backfill", conversationId: "__feeds__", payload: { type: "backfill", feedId: f.id, embedModel: b.embedModel || "", language: b.language || "" } });
    let j = {}; try { j = JSON.parse(r.text); } catch {}
    sendJson(res, 200, { ok: true, jobId: j.jobId, feed: f.name });
  } catch (e) { sendJson(res, 200, { ok: false, error: e.message }); }
}

module.exports = {
  startPolling, runBackfill, fetchWpTaxonomy, extractArticleForUrl, feedNeedsTrafilatura,
  feedsListHandler, feedsAddHandler, feedsEditHandler, feedsDeleteHandler, feedsPollNowHandler, feedsBackfillHandler, feedsBackfillEstimateHandler, feedsRefreshHandler,
  // exported for testing
  parseFeed, parseSitemap, parseSitemapUrls, decodeEntities, toDate, toDateTime, sanitizeNewsFolder, slugify,
  _internal: { loadFeeds, loadState, isSeen, markSeen, getFeed, probeBackfill, discoverFeedUrl, pollFeed, pollAll, addFeedInternal, folderCountMap, sumFolder, feedNeedsTrafilaturaCached, siteHostKey, siteHandler, uaFor, msOgImage, msTagNames, extractMicrosoftPage, resolveItem, countSitemapPosts },
};
