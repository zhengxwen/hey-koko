const http = require("http");
const config = require("./server/config");
const { sendJson, serveStatic, readBody } = require("./server/utils");
const { proxyOllamaChat, proxyOllamaTags, proxyOllamaShow } = require("./server/chat");
const { scanOllama } = require("./server/network");
const { proxyOllamaImageModels, generateImage, enhancePrompt, contentToImagePrompts } = require("./server/image");
const { fetchUrlContent, transcribeYouTubeAudio } = require("./server/url-fetch");
const { searchWeb } = require("./server/search");
const { buildArchiveIndex, semanticSearchArchives } = require("./server/embed");
const { listSystemVoices, speakWithSay, stopSay } = require("./server/speech");
const { archiveConversation, listArchives, loadArchives, deleteArchives, listArchiveDirs, moveArchives } = require("./server/archive");
const { getCapabilities, parseFile, parseHtml } = require("./server/parse-file");

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/chat") {
    proxyOllamaChat(req, res);
    return;
  }

  if (req.method === "GET" && req.url === "/api/models") {
    proxyOllamaTags(res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/model-info") {
    proxyOllamaShow(req, res);
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

  if (req.method === "POST" && req.url === "/api/enhance-prompt") {
    enhancePrompt(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/content-to-imagine") {
    contentToImagePrompts(req, res);
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

  if (req.method === "POST" && req.url === "/api/scan-ollama") {
    readBody(req).then(body => scanOllama(res, body)).catch(() => scanOllama(res, {}));
    return;
  }

  if (req.method === "GET" && req.url === "/api/ollama-url") {
    sendJson(res, 200, { url: config.ollamaUrl, imageUrl: config.imageOllamaUrl });
    return;
  }

  if (req.method === "POST" && req.url === "/api/set-ollama-url") {
    readBody(req).then(body => {
      const defaultUrl = "http://127.0.0.1:11434";
      let url = body.url && body.url.trim() ? body.url.trim() : "";
      if (!url) {
        url = defaultUrl;
      } else {
        if (!/^https?:\/\//i.test(url)) url = "http://" + url;
        try {
          const parsed = new URL(url);
          if (!parsed.port && parsed.protocol === "http:") parsed.port = "11434";
          url = parsed.href.replace(/\/+$/, "");
        } catch {
          // fallback: use as-is
        }
      }
      if (body.type === "image") {
        config.imageOllamaUrl = url;
        sendJson(res, 200, { url: config.imageOllamaUrl });
      } else {
        config.ollamaUrl = url;
        sendJson(res, 200, { url: config.ollamaUrl });
      }
    }).catch(() => sendJson(res, 400, { error: "invalid body" }));
    return;
  }

  if (req.method === "GET" && req.url === "/api/voices") {
    listSystemVoices(res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/speak") {
    speakWithSay(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/stop-speak") {
    stopSay(res);
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
