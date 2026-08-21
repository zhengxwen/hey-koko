// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

// Prefix every server log line with a local "YYYY-MM-DD HH:MM:SS [LEVEL] " tag so
// external-program invocations (sips/ffmpeg/whisper/…) and everything else are
// time-stamped and level-tagged. Patched here at the very top — before any require —
// because some modules log during load (tool detection). Preserves printf-style
// format strings by prepending to the first string arg rather than adding a separate one.
(function stampConsole() {
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = () => {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
           `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };
  const LEVELS = { log: "INFO", info: "INFO", debug: "DEBUG", warn: "WARN", error: "ERROR" };
  for (const [m, level] of Object.entries(LEVELS)) {
    const orig = console[m].bind(console);
    const prefix = `[${level}]`;
    console[m] = (...args) => {
      if (typeof args[0] === "string") orig(`${stamp()} ${prefix} ${args[0]}`, ...args.slice(1));
      else orig(`${stamp()} ${prefix}`, ...args);
    };
  }
})();

// Safety net: a non-fatal async error (e.g. an optional-tool probe rejecting on
// a minimal Finder-launch PATH) must never take down the server after it has
// bound the port — otherwise the native app just times out with "Unable to
// connect". Log loudly and keep serving.
process.on("unhandledRejection", (err) => {
  console.error("[hey-koko] Unhandled promise rejection (continuing):", err);
});
process.on("uncaughtException", (err) => {
  console.error("[hey-koko] Uncaught exception (continuing):", err);
});

const http = require("http");
const config = require("./server/config");
const { sendJson, serveStatic, readBody } = require("./server/utils");
const { proxyOllamaChat, proxyOllamaTags, proxyOllamaShow } = require("./server/chat");
const claude = require("./server/claude");
const openai = require("./server/openai");
const { scanOllamaStream, scanComfyStream, hostnameFor } = require("./server/network");
const { proxyOllamaImageModels, generateImage, enhancePrompt } = require("./server/image");
const { proxyComfyModels, generateComfyImage, uploadComfyVideo, uploadComfyAudio, comfyAutoMask } = require("./server/comfy");
const { fetchUrlContent, transcribeYouTubeAudio, youtubeJob, expandYoutubeUrls } = require("./server/url-fetch");
const { searchWeb } = require("./server/search");
const { browserTabs, browserRead, browserLaunch } = require("./server/cdp");   // co-browsing CDP bridge
const { officeRead } = require("./server/office");   // Word/PowerPoint/Outlook readers (/tool)
const officecli = require("./server/officecli");     // read/write/render .docx/.xlsx/.pptx without Office
const { buildArchiveIndex, semanticSearchArchives } = require("./server/embed");
const { listSystemVoices, speakAudio } = require("./server/speech");
const { listTtsVoices, synthesize } = require("./server/tts");
const { archiveConversation, listArchives, loadArchives, deleteArchives, listArchiveDirs, moveArchives } = require("./server/archive");
const { importLibrary, listLibrary, searchLibrary, getLibraryDoc, saveLibraryDoc, deleteLibraryDocs, retrieveLibrary, reparseLibrary, listLibraryDirs, moveLibraryDocs, rescanLibrary, rateLibraryDoc, editLibraryTag, distillLibraryDoc, relatedLibraryDocs, entityLookupLibrary, entityFacetsLibrary, aliasesLibrary, aliasEditLibrary, entityNeighborhoodLibrary, timelineLibrary, expandByRelationsLibrary, relationsForQueryLibrary, citationGraphLibrary, docCitationsLibrary } = require("./server/library");
const { zoteroCollectionsHandler, zoteroItemsHandler, zoteroSyncAnnotationsHandler, zoteroSyncPlanHandler, zoteroPatchMetaHandler } = require("./server/zotero");
const { serveStarmap } = require("./server/star-map");
const { getCapabilities, parseFile, parseHtml } = require("./server/parse-file");
const bgQueue = require("./server/jobs");   // Option B: server-side background job queue
const vendor = require("./server/vendor");  // pinned third-party UI libs: local-first, CDN fallback
const gallery = require("./server/gallery"); // on-disk home for generated/uploaded media
const { handleVideoEdit } = require("./server/video-edit"); // trim/concat gallery clips locally (ffmpeg)
const skills = require("./server/skills");   // model prompt-writing guides for /skill
const feeds = require("./server/feeds");    // news-feeds.md: news subscription library

console.log("[hey-koko] All modules loaded, starting server...");

const server = http.createServer((req, res) => {
  // Health check endpoint
  if (req.method === "GET" && req.url === "/health") {
    sendJson(res, 200, { status: "ok" });
    return;
  }

  if (req.method === "POST" && req.url === "/api/chat") {
    // Route by model name: a configured Claude model goes to the cloud proxy,
    // everything else stays on local Ollama. The model dropdown is the switch.
    readBody(req)
      .then((body) => {
        if (claude.isClaudeModel(body.model)) claude.proxyChat(res, body);
        else if (openai.isOpenAIModel(body.model)) openai.proxyChat(res, body);
        else proxyOllamaChat(req, res, body);
      })
      .catch(() => sendJson(res, 400, { error: "invalid body" }));
    return;
  }

  if (req.method === "GET" && req.url === "/api/models") {
    claude.listModels(res);
    return;
  }

  // Full catalog backing the "all models" picker: everything installed locally plus
  // every cloud provider's complete list (ignoring the curated `models[]` allowlist).
  // Ollama is queried live on each call, so pulling a new model and reopening the
  // picker is all it takes to see it — no restart.
  if (req.method === "GET" && req.url === "/api/models/all") {
    const localModels = async () => {
      try {
        const r = await fetch(`${config.ollamaUrl}/api/tags`);
        if (!r.ok) return [];
        const tags = (await r.json()).models || [];
        let host = "";
        try { host = new URL(config.ollamaUrl).host; } catch { host = config.ollamaUrl; }
        return tags.filter((m) => m.name).map((m) => ({
          id: m.name,
          provider: "ollama",
          local: true,
          host,
          name: m.name,
          // Ollama reports on-disk size, not a context length or price.
          sizeBytes: m.size || 0,
          contextLength: 0,
          pricing: null,
          description: "",
        }));
      } catch { return []; }
    };
    // Each source resolves to [] when unconfigured/unreachable, so one being down
    // never blanks the others.
    Promise.all([localModels(), claude.listAllModels(), openai.listAllModels()])
      .then(([l, c, o]) => sendJson(res, 200, { models: [...l, ...c, ...o] }))
      .catch((e) => sendJson(res, 500, { error: e.message, models: [] }));
    return;
  }

  if (req.method === "POST" && req.url === "/api/model-info") {
    readBody(req)
      .then((body) => {
        if (claude.isClaudeModel(body.model)) {
          sendJson(res, 200, { contextLength: claude.contextLengthFor(body.model) });
        } else if (openai.isOpenAIModel(body.model)) {
          sendJson(res, 200, { contextLength: openai.contextLengthFor(body.model) });
        } else {
          proxyOllamaShow(req, res, body);
        }
      })
      .catch(() => sendJson(res, 200, { contextLength: null }));
    return;
  }

  if (req.method === "GET" && req.url === "/api/image-models") {
    proxyOllamaImageModels(res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/generate-image") {
    generateImage(req, res);
    return;
  }

  if (req.method === "GET" && (req.url === "/api/comfy-models" || req.url.startsWith("/api/comfy-models?"))) {
    proxyComfyModels(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/generate-comfy") {
    generateComfyImage(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/comfy-upload-video") {
    uploadComfyVideo(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/comfy-upload-audio") {
    uploadComfyAudio(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/comfy-automask") {
    comfyAutoMask(req, res);
    return;
  }

  // ---- Option B: server-side background job queue ----
  if (req.method === "POST" && req.url === "/api/jobs") { bgQueue.submitJob(req, res); return; }
  if (req.method === "POST" && req.url === "/api/jobs/upload") { bgQueue.uploadSpool(req, res); return; }
  if (req.method === "GET" && req.url === "/api/jobs/events") { bgQueue.streamEvents(req, res); return; }
  if (req.method === "POST" && req.url === "/api/jobs/ack") { bgQueue.ackJobs(req, res); return; }
  if (req.method === "POST" && req.url === "/api/jobs/reorder") { bgQueue.reorderJobs(req, res); return; }
  if (req.method === "POST" && req.url === "/api/jobs/cancel-conversation") { bgQueue.cancelConversation(req, res); return; }
  if (req.method === "POST" && /^\/api\/jobs\/[^/]+\/cancel$/.test(req.url)) { bgQueue.cancelJob(req, res, req.url.split("/")[3]); return; }
  if (req.method === "POST" && /^\/api\/jobs\/[^/]+\/pause$/.test(req.url)) { bgQueue.pauseJob(req, res, req.url.split("/")[3]); return; }
  if (req.method === "POST" && /^\/api\/jobs\/[^/]+\/resume$/.test(req.url)) { bgQueue.resumeJob(req, res, req.url.split("/")[3]); return; }

  if (req.method === "POST" && req.url === "/api/enhance-prompt") {
    enhancePrompt(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/fetch-url") {
    fetchUrlContent(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/search") {
    searchWeb(req, res);
    return;
  }

  if (req.method === "GET" && req.url === "/api/browser/tabs") {
    browserTabs(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/browser/read") {
    browserRead(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/browser/launch") {
    browserLaunch(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/office/read") {
    officeRead(req, res);
    return;
  }

  // officecli bridge. /api/office/read (above) reads the LIVE app state via AppleScript;
  // these read, render and WRITE files on disk — different sources, deliberately separate.
  if (req.method === "GET" && req.url === "/api/officecli/status") {
    officecli.handleStatus(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/officecli/read") {
    officecli.handleRead(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/officecli/preview") {
    officecli.handlePreview(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/officecli/build") {
    officecli.handleBuild(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/officecli/merge") {
    officecli.handleMerge(req, res);
    return;
  }

  // /doc's own surface: open takes a WORKING COPY of the user's file (never edits the
  // original), edit applies one ```office block to it, file hands the result back.
  if (req.method === "POST" && req.url === "/api/officecli/open") {
    officecli.handleOpen(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/officecli/edit") {
    officecli.handleEdit(req, res);
    return;
  }

  if (req.method === "GET" && req.url.startsWith("/api/officecli/file/")) {
    officecli.handleFile(req, res);
    return;
  }

  if (req.method === "GET" && req.url.startsWith("/api/officecli/guide")) {
    officecli.handleGuide(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/youtube-transcribe") {
    transcribeYouTubeAudio(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/youtube-job") {
    youtubeJob(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/youtube-expand") {
    expandYoutubeUrls(req, res);
    return;
  }

  if (req.method === "GET" && req.url === "/api/scan-ollama-stream") {
    scanOllamaStream(req, res);
    return;
  }

  if (req.method === "GET" && req.url === "/api/scan-comfy-stream") {
    scanComfyStream(req, res);
    return;
  }

  if (req.method === "GET" && req.url === "/api/ollama-url") {
    Promise.all([
      hostnameFor(config.ollamaUrl),
      hostnameFor(config.imageOllamaUrl),
      hostnameFor(config.comfyUrl),
    ]).then(([hostname, imageHostname, comfyHostname]) => {
      sendJson(res, 200, {
        url: config.ollamaUrl, imageUrl: config.imageOllamaUrl, comfyUrl: config.comfyUrl,
        hostname, imageHostname, comfyHostname,
      });
    });
    return;
  }

  if (req.method === "POST" && req.url === "/api/set-ollama-url") {
    readBody(req).then(body => {
      const isComfy = body.type === "comfy";
      const defaultPort = isComfy ? "8188" : "11434";
      const defaultUrl = `http://127.0.0.1:${defaultPort}`;
      let url = body.url && body.url.trim() ? body.url.trim() : "";
      if (!url) {
        url = defaultUrl;
      } else {
        if (!/^https?:\/\//i.test(url)) url = "http://" + url;
        try {
          const parsed = new URL(url);
          if (!parsed.port && parsed.protocol === "http:") parsed.port = defaultPort;
          url = parsed.href.replace(/\/+$/, "");
        } catch {
          // fallback: use as-is
        }
      }
      if (body.type === "comfy") {
        config.comfyUrl = url;
      } else if (body.type === "image") {
        config.imageOllamaUrl = url;
      } else {
        config.ollamaUrl = url;
      }
      hostnameFor(url).then((hostname) => sendJson(res, 200, { url, hostname }));
    }).catch(() => sendJson(res, 400, { error: "invalid body" }));
    return;
  }

  if (req.method === "GET" && req.url === "/api/voices") {
    listSystemVoices(res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/speak-audio") {
    speakAudio(req, res);
    return;
  }

  if (req.method === "GET" && req.url === "/api/tts-voices") {
    listTtsVoices(res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/tts") {
    synthesize(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/archive") {
    archiveConversation(req, res);
    return;
  }

  if (req.method === "GET" && req.url === "/api/archives") {
    listArchives(res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/archives/index") {
    buildArchiveIndex(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/archives/search") {
    semanticSearchArchives(req, res);
    return;
  }

  if (req.method === "GET" && req.url === "/api/archives/dir") {
    sendJson(res, 200, { dir: config.ARCHIVES_DIR });
    return;
  }

  if (req.method === "POST" && req.url === "/api/archives/load") {
    loadArchives(req, res);
    return;
  }

  if (req.method === "DELETE" && req.url === "/api/archives") {
    deleteArchives(req, res);
    return;
  }

  if (req.method === "GET" && req.url === "/api/archives/dirs") {
    listArchiveDirs(res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/archives/move") {
    moveArchives(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/library/import") {
    importLibrary(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/library/list") {
    listLibrary(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/library/search") {
    searchLibrary(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/library/get") {
    getLibraryDoc(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/library/save") {
    saveLibraryDoc(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/library/delete") {
    deleteLibraryDocs(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/library/retrieve") {
    retrieveLibrary(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/library/reparse") {
    reparseLibrary(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/library/dirs") {
    listLibraryDirs(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/library/move") {
    moveLibraryDocs(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/library/rescan") {
    rescanLibrary(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/library/rate") {
    rateLibraryDoc(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/library/tag-edit") {
    editLibraryTag(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/library/distill") {
    distillLibraryDoc(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/library/starmap") {
    serveStarmap(req, res);
    return;
  }
  if (req.method === "POST" && req.url === "/api/library/related") {
    relatedLibraryDocs(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/library/entity-lookup") {
    entityLookupLibrary(req, res);
    return;
  }

  if ((req.method === "GET" || req.method === "POST") && req.url === "/api/library/entity-facets") {
    entityFacetsLibrary(req, res);
    return;
  }

  if ((req.method === "GET" || req.method === "POST") && req.url === "/api/library/aliases") {
    aliasesLibrary(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/library/alias-edit") {
    aliasEditLibrary(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/library/entity-neighborhood") {
    entityNeighborhoodLibrary(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/library/expand") {
    expandByRelationsLibrary(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/library/relations") {
    relationsForQueryLibrary(req, res);
    return;
  }

  if ((req.method === "GET" || req.method === "POST") && req.url === "/api/library/timeline") {
    timelineLibrary(req, res);
    return;
  }
  if (req.method === "POST" && req.url === "/api/library/citation-graph") {
    citationGraphLibrary(req, res);
    return;
  }
  if (req.method === "POST" && req.url === "/api/library/doc-citations") {
    docCitationsLibrary(req, res);
    return;
  }

  // Zotero import bridge (read-only local API proxy) — see server/zotero.js.
  if (req.method === "POST" && req.url === "/api/zotero/collections") {
    zoteroCollectionsHandler(req, res);
    return;
  }
  if (req.method === "POST" && req.url === "/api/zotero/items") {
    zoteroItemsHandler(req, res);
    return;
  }
  if (req.method === "POST" && req.url === "/api/zotero/sync-annotations") {
    zoteroSyncAnnotationsHandler(req, res);
    return;
  }
  if (req.method === "POST" && req.url === "/api/zotero/sync-plan") {
    zoteroSyncPlanHandler(req, res);
    return;
  }
  if (req.method === "POST" && req.url === "/api/zotero/patch-meta") {
    zoteroPatchMetaHandler(req, res);
    return;
  }

  // News subscription library (news-feeds.md) — feed CRUD + poll + backfill.
  if ((req.method === "GET" || req.method === "POST") && req.url === "/api/feeds/list") { feeds.feedsListHandler(req, res); return; }
  if (req.method === "POST" && req.url === "/api/feeds/add") { feeds.feedsAddHandler(req, res); return; }
  if (req.method === "POST" && req.url === "/api/feeds/edit") { feeds.feedsEditHandler(req, res); return; }
  if (req.method === "POST" && req.url === "/api/feeds/delete") { feeds.feedsDeleteHandler(req, res); return; }
  if (req.method === "POST" && req.url === "/api/feeds/poll-now") { feeds.feedsPollNowHandler(req, res); return; }
  if (req.method === "POST" && req.url === "/api/feeds/backfill") { feeds.feedsBackfillHandler(req, res); return; }
  if (req.method === "POST" && req.url === "/api/feeds/backfill-estimate") { feeds.feedsBackfillEstimateHandler(req, res); return; }
  if (req.method === "POST" && req.url === "/api/feeds/refresh") { feeds.feedsRefreshHandler(req, res); return; }

  if (req.method === "GET" && req.url === "/api/parse-file/capabilities") {
    getCapabilities(res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/parse-file") {
    parseFile(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/parse-html") {
    parseHtml(req, res);
    return;
  }

  // Gallery: on-disk home of every generated/uploaded artifact (server/gallery.js).
  if (req.method === "GET" && req.url.startsWith("/api/gallery/list")) { gallery.handleList(req, res); return; }
  if (req.method === "GET" && req.url.startsWith("/api/gallery/entry")) { gallery.handleEntry(req, res); return; }
  if (req.method === "GET" && req.url.startsWith("/api/gallery/file/")) { gallery.handleFile(req, res); return; }
  if (req.method === "GET" && req.url.startsWith("/api/gallery/thumb/")) { gallery.handleThumb(req, res); return; }
  if (req.method === "GET" && req.url.startsWith("/api/gallery/stats")) { gallery.handleStats(req, res); return; }
  if (req.method === "GET" && req.url.startsWith("/api/gallery/refs")) { gallery.handleRefs(req, res); return; }
  if (req.method === "POST" && req.url === "/api/gallery/thumb") { gallery.handlePutThumb(req, res); return; }
  if (req.method === "POST" && req.url === "/api/gallery/delete") { gallery.handleDelete(req, res); return; }
  if (req.method === "POST" && req.url === "/api/gallery/describe") { gallery.handleDescribe(req, res); return; }
  if (req.method === "POST" && req.url === "/api/gallery/rate") { gallery.handleRate(req, res); return; }
  if (req.method === "POST" && req.url === "/api/gallery/probe") { gallery.handleProbe(req, res); return; }
  if (req.method === "GET" && req.url === "/api/skills") { skills.handleList(req, res); return; }
  if (req.method === "POST" && req.url === "/api/skills/compose") { skills.handleCompose(req, res); return; }
  if (req.method === "POST" && req.url === "/api/gallery/compact") { gallery.handleCompact(req, res); return; }
  if (req.method === "POST" && req.url === "/api/gallery/import") { gallery.handleImport(req, res); return; }
  if (req.method === "POST" && req.url === "/api/gallery/upload") { gallery.handleUpload(req, res); return; }
  if (req.method === "POST" && req.url === "/api/gallery/reveal") { gallery.handleReveal(req, res); return; }
  if (req.method === "POST" && req.url === "/api/gallery/rename") { gallery.handleRename(req, res); return; }
  if (req.method === "POST" && req.url === "/api/gallery/hide") { gallery.handleHide(req, res); return; }
  if (req.method === "POST" && req.url === "/api/gallery/move") { gallery.handleMove(req, res); return; }
  if (req.method === "POST" && req.url === "/api/gallery/folder") { gallery.handleFolderCreate(req, res); return; }
  if (req.method === "POST" && req.url === "/api/gallery/folder-rename") { gallery.handleFolderRename(req, res); return; }
  if (req.method === "POST" && req.url === "/api/gallery/folder-delete") { gallery.handleFolderDelete(req, res); return; }

  // Simple video editor: trim + concat gallery clips with local ffmpeg (server/video-edit.js).
  if (req.method === "POST" && req.url === "/api/video-edit") { handleVideoEdit(req, res); return; }

  if (req.method === "GET" && req.url.startsWith("/vendor/")) {
    vendor.serveVendor(req, res);   // disk first, else checksum-verified CDN fallback
    return;
  }

  if (req.method === "GET") {
    serveStatic(req, res);
    return;
  }

  res.writeHead(405);
  res.end("Method not allowed");
});

server.listen(config.PORT, "127.0.0.1", () => {
  console.log(`Local AI companion: http://127.0.0.1:${config.PORT}`);
  console.log(`Ollama endpoint: ${config.ollamaUrl}`);
  const vs = vendor.vendorStatus();
  if (vs.present === vs.total) {
    console.log(`UI libraries: ${vs.present}/${vs.total} local (fully offline)`);
  } else {
    console.log(`UI libraries: ${vs.present}/${vs.total} local — missing files load from CDN; run "node scripts/fetch-vendor.js" for offline use`);
  }
  feeds.startPolling();   // news-feeds.md: begin the subscription poll timer
});