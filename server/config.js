const path = require("path");
const os = require("os");

const config = {
  PORT: Number(process.env.PORT || 1314),
  ollamaUrl: process.env.OLLAMA_URL || "http://127.0.0.1:11434",
  imageOllamaUrl: process.env.IMAGE_OLLAMA_URL || (process.env.OLLAMA_URL || "http://127.0.0.1:11434"),
  PUBLIC_DIR: path.join(__dirname, "..", "public"),
  ARCHIVES_DIR: path.join(os.homedir(), "ai_archives"),
  whisperModel: process.env.WHISPER_MODEL || "",
  WHISPER_MODEL_SEARCH_PATHS: [
    path.join(os.homedir(), ".local", "share", "whisper-cpp"),
    path.join(os.homedir(), "whisper.cpp", "models"),
    "/opt/homebrew/share/whisper-cpp/models",
    "/usr/local/share/whisper-cpp/models",
  ],
  MIME_TYPES: {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml",
  },
};

module.exports = config;
