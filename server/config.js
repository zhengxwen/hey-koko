// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

const path = require("path");
const os = require("os");
const fs = require("fs");

// TTS python: explicit TTS_PYTHON wins; else auto-detect the conventional
// ~/venv/tts venv; else fall back to whatever "python3" is on PATH.
function resolveTtsPython() {
  if (process.env.TTS_PYTHON) return process.env.TTS_PYTHON;
  const guess = path.join(os.homedir(), "venv", "tts", "bin", "python");
  try { if (fs.existsSync(guess)) return guess; } catch { /* ignore */ }
  return "python3";
}

const config = {
  PORT: Number(process.env.PORT || 1314),
  URL_CONTENT_MAX_CHARS: Number(process.env.URL_CONTENT_MAX_CHARS || 40000),
  ollamaUrl: process.env.OLLAMA_URL || "http://127.0.0.1:11434",
  imageOllamaUrl: process.env.IMAGE_OLLAMA_URL || (process.env.OLLAMA_URL || "http://127.0.0.1:11434"),
  comfyUrl: process.env.COMFY_URL || "http://127.0.0.1:8188",
  PUBLIC_DIR: path.join(__dirname, "..", "public"),
  ARCHIVES_DIR: path.join(os.homedir(), "ai_archives"),
  whisperModel: process.env.WHISPER_MODEL || "",
  // Local text-to-speech (/voice command). TTS_PYTHON should point at a venv
  // python (3.10/3.11) with kokoro and/or cosyvoice installed — the system
  // python may be too new for those ML wheels. Engines that fail to import are
  // reported unavailable rather than breaking the daemon.
  ttsPython: resolveTtsPython(),
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