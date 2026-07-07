// server/zotero.js — READ-ONLY bridge to the Zotero desktop LOCAL API.
//
// Zotero 8+ ships a local HTTP API on 127.0.0.1:23119 mirroring the Web API v3, serving
// the user's own library offline with no auth and no rate limits. It must be enabled in
// Zotero → Settings → Advanced → "Allow other applications on this computer to
// communicate with Zotero". We only ever GET — Zotero stays the source of truth for
// files/metadata/highlights; hey-koko holds a derived index. See
// docs/plans/zotero-paper-library.md. Zero-dependency: plain fetch + regex, no client lib.
//
// Version floor: Zotero 8 (annotations returned over the API + /fulltext + since param are
// all 8.0 additions). Zotero 9 didn't touch the local API.

const config = require("./config");
const { sendJson, readBody } = require("./utils");

// Personal library is served under users/0 on the local API (no numeric user id needed).
const PREFIX = "/api/users/0";
function base() {
  const b = (config.ZOTERO && config.ZOTERO.apiBase) || "http://127.0.0.1:23119";
  return String(b).replace(/\/+$/, "");
}

// One GET against the local API. Returns { res, body } (body parsed as JSON unless
// json:false). Throws a tagged Error on non-2xx / unreachable so callers can distinguish
// "Zotero not running" (ECONNREFUSED) from "item has no full text" (404).
async function zget(pathAndQuery, { json = true, timeoutMs = 20000 } = {}) {
  const url = `${base()}${PREFIX}${pathAndQuery}`;
  let res;
  try {
    res = await fetch(url, {
      headers: { "Zotero-API-Version": "3", "Accept": json ? "application/json" : "*/*" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const err = new Error(`Zotero 本地 API 无法连接（${base()}）——请确认 Zotero 正在运行，且设置→高级里已勾选“允许其它应用通信”。`);
    err.code = "ZOTERO_UNREACHABLE";
    err.cause = e;
    throw err;
  }
  if (!res.ok) {
    const err = new Error(`zotero ${res.status} on ${pathAndQuery}`);
    err.status = res.status;
    throw err;
  }
  return { res, body: json ? await res.json() : await res.text() };
}

// Probe: is the local API reachable? Returns { ok, apiVersion } or { ok:false, reason }.
async function available() {
  try {
    const { res } = await zget("/collections?limit=1");
    return { ok: true, apiVersion: res.headers.get("Zotero-API-Version") || "" };
  } catch (e) {
    return { ok: false, reason: e.code === "ZOTERO_UNREACHABLE" ? "unreachable" : (e.message || "error") };
  }
}

// ---- metadata helpers ------------------------------------------------------

// Zotero `date` is free-form ("2008", "2008-01", "January 15, 2008", "2008-01-15").
// Pull a 4-digit year always; an ISO publishedAt only when Y-M-D is literally present.
function parseZoteroDate(date) {
  const s = String(date || "");
  const y = (s.match(/\b(1[5-9]\d{2}|20\d{2}|21\d{2})\b/) || [])[1] || "";
  const iso = (s.match(/\b(\d{4})-(\d{2})-(\d{2})\b/) || null);
  return { year: y, publishedAt: iso ? `${iso[1]}-${iso[2]}-${iso[3]}` : (y || "") };
}

function authorsOf(creators) {
  return (creators || [])
    .filter(c => !c.creatorType || /^(author|contributor|editor)$/i.test(c.creatorType))
    .map(c => (c.name || [c.firstName, c.lastName].filter(Boolean).join(" ")).trim())
    .filter(Boolean).join(", ");
}

// Item types we treat as papers/documents worth importing (skip attachments, notes,
// annotations, webpages, and reference-manager cruft). Kept permissive.
const DOC_ITEM_TYPES = new Set([
  "journalArticle", "conferencePaper", "preprint", "report", "thesis",
  "book", "bookSection", "manuscript", "document", "presentation",
]);

// Map a raw Zotero item.data → the flat metadata hey-koko import wants.
function itemMeta(data) {
  const d = data || {};
  const { year, publishedAt } = parseZoteroDate(d.date);
  const venue = d.publicationTitle || d.conferenceName || d.proceedingsTitle || d.bookTitle || d.publisher || "";
  return {
    key: d.key,
    itemType: d.itemType,
    title: (d.title || "").replace(/\s+/g, " ").trim(),
    authors: authorsOf(d.creators),
    year, publishedAt,
    doi: d.DOI || "",
    venue,
    abstract: d.abstractNote || "",
    tags: (d.tags || []).map(t => t.tag).filter(Boolean),
    collections: d.collections || [],
    url: d.url || (d.DOI ? `https://doi.org/${d.DOI}` : ""),
    itemVersion: d.version || 0,
  };
}

// ---- listing ---------------------------------------------------------------

// All collections, flattened, with item counts. Each: { key, name, parentCollection }.
async function listCollections() {
  const { body } = await zget("/collections");
  return (body || []).map(c => ({
    key: c.key,
    name: (c.data && c.data.name) || c.key,
    parentCollection: (c.data && c.data.parentCollection) || false,
    numItems: (c.meta && c.meta.numItems) || 0,
  })).sort((a, b) => a.name.localeCompare(b.name));
}

// Top-level document items in a collection (collectionKey null → whole library).
// `/top` excludes child attachments/notes so the picker shows real papers only.
async function listItems(collectionKey) {
  const p = collectionKey ? `/collections/${encodeURIComponent(collectionKey)}/items/top` : "/items/top";
  const { body } = await zget(p);
  return (body || [])
    .map(it => itemMeta(it.data))
    .filter(m => DOC_ITEM_TYPES.has(m.itemType));
}

async function getItem(itemKey) {
  const { body } = await zget(`/items/${encodeURIComponent(itemKey)}`);
  return itemMeta(body && body.data);
}

// Direct children of an item (of the top item: attachments/notes; of an attachment:
// annotations). Returns the raw child array.
async function getChildren(itemKey) {
  const { body } = await zget(`/items/${encodeURIComponent(itemKey)}/children`);
  return body || [];
}

// ---- attachment selection --------------------------------------------------

// pdf2zh / translation tools drop a second PDF next to the original; never import it.
const TRANSLATED_PDF_RE = /(-mono|-dual|-bilingual|\.zh\b|_zh\b|[_-]translated|双语|译文|翻译)/i;

// Choose the ORIGINAL PDF attachment among an item's children: application/pdf, not a
// translated sibling, earliest added (the one the user first saved). Returns the FULL
// child object (data + links) so attachmentFilePath can read links.enclosure; null if none.
function pickPdfAttachment(children) {
  const pdfs = (children || [])
    .filter(c => { const d = c.data || c; return d.itemType === "attachment" && /pdf/i.test(d.contentType || ""); });
  if (!pdfs.length) return null;
  const fn = c => { const d = c.data || c; return d.filename || d.title || ""; };
  const added = c => String((c.data || c).dateAdded || "");
  const originals = pdfs.filter(c => !TRANSLATED_PDF_RE.test(fn(c)));
  const pool = originals.length ? originals : pdfs;   // all look translated → keep them anyway
  pool.sort((a, b) => added(a).localeCompare(added(b)));
  return pool[0];
}

// The on-disk file path for an attachment (for MinerU deep re-parse). The local API
// returns a file:// enclosure href for stored files, or data.path for linked files.
function attachmentFilePath(attachmentData, rawChild) {
  const d = attachmentData || {};
  if (d.path && !/^attachments:/i.test(d.path)) {
    try { return d.path.startsWith("file://") ? decodeURIComponent(new URL(d.path).pathname) : d.path; } catch { return d.path; }
  }
  const href = rawChild && rawChild.links && rawChild.links.enclosure && rawChild.links.enclosure.href;
  if (href && href.startsWith("file://")) { try { return decodeURIComponent(new URL(href).pathname); } catch { return href.slice(7); } }
  return "";
}

// ---- full text + annotations ----------------------------------------------

// Zotero's own extracted plain text for an attachment. { content } (PDF: +indexedPages/
// totalPages; text: +indexedChars/totalChars). null when the item has no indexed text
// (404) so the caller can fall back.
async function getFulltext(attachmentKey) {
  try {
    const { body } = await zget(`/items/${encodeURIComponent(attachmentKey)}/fulltext`);
    const content = (body && typeof body.content === "string") ? body.content : "";
    return content ? { content, indexedPages: body.indexedPages, totalPages: body.totalPages } : null;
  } catch (e) {
    if (e.status === 404) return null;   // not indexed yet — caller falls back
    throw e;
  }
}

// Highlight/note annotations on a PDF attachment (Zotero 8+ returns these over the API).
// Normalized + sorted by Zotero's own sortIndex (reading order). Each:
// { type, text, comment, color, page }.
async function getAnnotations(attachmentKey) {
  const children = await getChildren(attachmentKey);
  return children
    .map(c => c.data || c)
    .filter(d => d.itemType === "annotation")
    .map(d => ({
      type: d.annotationType || "highlight",
      text: (d.annotationText || "").replace(/\s+/g, " ").trim(),
      comment: (d.annotationComment || "").trim(),
      color: d.annotationColor || "",
      page: d.annotationPageLabel || "",
      sortIndex: d.annotationSortIndex || "",
    }))
    .filter(a => a.text || a.comment)
    .sort((a, b) => String(a.sortIndex).localeCompare(String(b.sortIndex)));
}

// ---- HTTP handlers (proxied through our server — the browser can't reach the local
// API cross-origin, and this hides the base URL / tunnel from the client) --------------

// POST /api/zotero/collections → { ok, collections } or { ok:false, reason } when Zotero
// isn't reachable (so the picker can show "启动 Zotero 并开启本地 API" instead of an error).
async function zoteroCollectionsHandler(_req, res) {
  try {
    const collections = await listCollections();
    sendJson(res, 200, { ok: true, collections });
  } catch (e) {
    if (e.code === "ZOTERO_UNREACHABLE") { sendJson(res, 200, { ok: false, reason: "unreachable", error: e.message }); return; }
    sendJson(res, 500, { ok: false, error: e.message });
  }
}

// POST /api/zotero/items { collection?: key } → { ok, items } where each item carries an
// `imported` flag (its zotero_<key> doc already in the library) for the picker.
async function zoteroItemsHandler(req, res) {
  let body = {}; try { body = await readBody(req); } catch { /* empty = whole library */ }
  try {
    const [items, have] = await Promise.all([
      listItems(body.collection || null),
      Promise.resolve(library().libraryDocIdSet()),
    ]);
    const out = items.map(m => ({ ...m, imported: have.has(`zotero_${m.key}`) }));
    sendJson(res, 200, { ok: true, items: out });
  } catch (e) {
    if (e.code === "ZOTERO_UNREACHABLE") { sendJson(res, 200, { ok: false, reason: "unreachable", error: e.message }); return; }
    sendJson(res, 500, { ok: false, error: e.message });
  }
}

// POST /api/zotero/sync-annotations { docIds?, language? } → re-pull highlights for the
// given Zotero docs (or ALL of them) and rebuild each «Zotero 批注» block only when it
// changed. { ok, results:[{docId, changed, annotCount} | {docId, error}], synced, changed }.
async function zoteroSyncAnnotationsHandler(req, res) {
  let body = {}; try { body = await readBody(req); } catch { /* sync all */ }
  const lib = library();
  const want = Array.isArray(body.docIds) && body.docIds.length ? new Set(body.docIds) : null;
  const docs = lib.listZoteroDocs().filter(d => !want || want.has(d.docId));
  const results = [];
  for (const d of docs) {
    try {
      if (!d.attachmentKey) { results.push({ docId: d.docId, error: "no-attachment" }); continue; }
      const annots = await getAnnotations(d.attachmentKey);
      results.push(await lib.resyncZoteroAnnotations(d.docId, annots));
    } catch (e) {
      if (e.code === "ZOTERO_UNREACHABLE") { sendJson(res, 200, { ok: false, reason: "unreachable", error: e.message }); return; }
      results.push({ docId: d.docId, error: e.message });
    }
  }
  sendJson(res, 200, {
    ok: true, results,
    synced: results.length,
    changed: results.filter(r => r.changed).length,
  });
}

// POST /api/zotero/sync-plan { mode: "full"|"incremental" } → the diff between Zotero's
// current state and hey-koko's zotero docs: { ok, mode, toImport, toUpdate, toDelete,
// toMove }. Advisory — the frontend applies it (bg import jobs + move/delete + patch-meta).
async function zoteroSyncPlanHandler(req, res) {
  let body = {}; try { body = await readBody(req); } catch { /* default full */ }
  const mode = body.mode === "incremental" ? "incremental" : "full";
  const lib = library();
  try {
    const [cols, items] = await Promise.all([listCollections(), listItems(null)]);
    const collMap = {}; cols.forEach(c => { collMap[c.key] = c.name; });
    const plan = lib.diffZoteroSync(items, collMap, lib.listZoteroDocsDetailed(), mode);
    sendJson(res, 200, { ok: true, mode, ...plan });
  } catch (e) {
    if (e.code === "ZOTERO_UNREACHABLE") { sendJson(res, 200, { ok: false, reason: "unreachable", error: e.message }); return; }
    sendJson(res, 500, { ok: false, error: e.message });
  }
}

// POST /api/zotero/patch-meta { items: [{docId, itemKey}] } → refresh each doc's metadata
// in place from Zotero (no re-import, preserves body/edits/vectors). { ok, patched, errors }.
async function zoteroPatchMetaHandler(req, res) {
  let body = {}; try { body = await readBody(req); } catch { /* empty */ }
  const lib = library();
  const patched = [], errors = [];
  for (const it of body.items || []) {
    try {
      const meta = await getItem(it.itemKey);
      lib.patchZoteroDocMeta(it.docId, meta);
      patched.push(it.docId);
    } catch (e) {
      if (e.code === "ZOTERO_UNREACHABLE") { sendJson(res, 200, { ok: false, reason: "unreachable", error: e.message }); return; }
      errors.push({ docId: it.docId, error: e.message });
    }
  }
  sendJson(res, 200, { ok: true, patched, errors });
}

// Lazy require to avoid a load-time cycle (library.js ← jobs.js → zotero.js).
function library() { return require("./library"); }

module.exports = {
  available, listCollections, listItems, getItem, getChildren,
  pickPdfAttachment, attachmentFilePath, getFulltext, getAnnotations,
  zoteroCollectionsHandler, zoteroItemsHandler, zoteroSyncAnnotationsHandler,
  zoteroSyncPlanHandler, zoteroPatchMetaHandler,
  // exported for testing
  parseZoteroDate, authorsOf, itemMeta, TRANSLATED_PDF_RE, DOC_ITEM_TYPES,
};
