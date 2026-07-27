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
const { buildArchiveIndex, semanticSearchArchives } = require("./server/embed");
const { listSystemVoices, speakAudio } = require("./server/speech");
const { listTtsVoices, synthesize } = require("./server/tts");
const { archiveConversation, listArchives, loadArchives, deleteArchives, listArchiveDirs, moveArchives } = require("./server/archive");
const { importLibrary, listLibrary, searchLibrary, getLibraryDoc, saveLibraryDoc, deleteLibraryDocs, retrieveLibrary, reparseLibrary, listLibraryDirs, moveLibraryDocs, rescanLibrary, rateLibraryDoc, editLibraryTag, distillLibraryDoc, relatedLibraryDocs, entityLookupLibrary, entityFacetsLibrary, aliasesLibrary, aliasEditLibrary, entityNeighborhoodLibrary, timelineLibrary, expandByRelationsLibrary, relationsForQueryLibrary, citationGraphLibrary, docCitationsLibrary } = require("./server/library");
const { zoteroCollectionsHandler, zoteroItemsHandler, zoteroSyncAnnotationsHandler, zoteroSyncPlanHandler, zoteroPatchMetaHandler } = require("./server/zotero");
const { serveStarmap } = require("./server/star-map");
const { getCapabilities, parseFile, parseHtml } = require("./server/parse-file");
const bgQueue = require("./server/jobs");   // Option B: server-side background job queue
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

  // Full online catalog from the configured cloud providers (ignores the curated
  // `models[]` allowlist) — backs the "browse all models" picker dialog.
  if (req.method === "GET" && req.url === "/api/cloud-models/all") {
    openai.listAllModels()
      .then((models) => sendJson(res, 200, { models }))
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
  feeds.startPolling();   // news-feeds.md: begin the subscription poll timer
});