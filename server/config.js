// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

const path = require("path");
const os = require("os");
const fs = require("fs");

// TTS python: explicit TTS_PYTHON wins; else auto-detect the conventional
// ~/venv/tts venv; else fall back to whatever "python3" is on PATH.
function resolveTtsPython() {
  if (process.env.TTS_PYTHON) return process.env.TTS_PYTHON;
  // venv interpreter layout differs by platform: Scripts\python.exe on Windows,
  // bin/python elsewhere. Fall back to the platform's default python launcher.
  const win = process.platform === "win32";
  const guess = win
    ? path.join(os.homedir(), "venv", "tts", "Scripts", "python.exe")
    : path.join(os.homedir(), "venv", "tts", "bin", "python");
  try { if (fs.existsSync(guess)) return guess; } catch { /* ignore */ }
  return win ? "python" : "python3";
}

// App data home: everything the server persists (chat archives, knowledge library,
// background-job queue) plus the cloud-backend config files (claude.json/openai.json)
// lives under this one directory. HEYKOKO_DIR overrides it — point a throwaway/test
// server at a temp dir for complete isolation from the real data.
const DATA_DIR = process.env.HEYKOKO_DIR || path.join(os.homedir(), ".hey-koko");

const config = {
  DATA_DIR,
  PORT: Number(process.env.PORT || 1314),
  URL_CONTENT_MAX_CHARS: Number(process.env.URL_CONTENT_MAX_CHARS || 40000),
  ollamaUrl: process.env.OLLAMA_URL || "http://127.0.0.1:11434",
  // Context window for internal Ollama LLM tasks (subtitle formatting, distill, rerank):
  // Ollama's default num_ctx is tiny (2-4k) and SILENTLY truncates the prompt. 24576
  // covers a 6k-CJK-char subtitle chunk plus its equal-length rewrite, and the 16k-char
  // distill sample. One shared value so back-to-back format→distill in a libimport job
  // doesn't reload the model with a different context size.
  llmTaskCtx: Number(process.env.LLM_TASK_CTX || 24576),
  imageOllamaUrl: process.env.IMAGE_OLLAMA_URL || (process.env.OLLAMA_URL || "http://127.0.0.1:11434"),
  comfyUrl: process.env.COMFY_URL || "http://127.0.0.1:8188",
  PUBLIC_DIR: path.join(__dirname, "..", "public"),
  ARCHIVES_DIR: path.join(DATA_DIR, "chat"),
  // Option B: server-side background job queue store. Isolated via HEYKOKO_DIR so a
  // throwaway server never loads (and starts running!) the real server's persisted queue.
  JOBS_DIR: path.join(DATA_DIR, "jobs"),
  whisperModel: process.env.WHISPER_MODEL || "",
  // Local text-to-speech (/voice command). TTS_PYTHON should point at a venv
  // python (3.10/3.11) with kokoro installed — the system python may be too
  // new for those ML wheels. Engines that fail to import are reported
  // unavailable rather than breaking the daemon.
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