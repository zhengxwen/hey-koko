// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

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
const { proxyComfyModels, generateComfyImage, uploadComfyVideo } = require("./server/comfy");
const { fetchUrlContent, transcribeYouTubeAudio, youtubeJob, expandYoutubeUrls } = require("./server/url-fetch");
const { searchWeb } = require("./server/search");
const { buildArchiveIndex, semanticSearchArchives } = require("./server/embed");
const { listSystemVoices, speak, stopSay } = require("./server/speech");
const { listTtsVoices, synthesize } = require("./server/tts");
const { archiveConversation, listArchives, loadArchives, deleteArchives, listArchiveDirs, moveArchives } = require("./server/archive");
const { importLibrary, listLibrary, searchLibrary, getLibraryDoc, saveLibraryDoc, deleteLibraryDocs, retrieveLibrary, reparseLibrary, listLibraryDirs, moveLibraryDocs, distillLibraryDoc, relatedLibraryDocs } = require("./server/library");
const { getCapabilities, parseFile, parseHtml } = require("./server/parse-file");
const bgQueue = require("./server/jobs");   // Option B: server-side background job queue

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

  // ---- Option B: server-side background job queue ----
  if (req.method === "POST" && req.url === "/api/jobs") { bgQueue.submitJob(req, res); return; }
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

  if (req.method === "POST" && req.url === "/api/speak") {
    speak(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/stop-speak") {
    stopSay(res);
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

  if (req.method === "POST" && req.url === "/api/library/distill") {
    distillLibraryDoc(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/library/related") {
    relatedLibraryDocs(req, res);
    return;
  }

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
});