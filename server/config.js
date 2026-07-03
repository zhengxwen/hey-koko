// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

const path = require("path");
const os = require("os");
const fs = require("fs");
const { execFileSync } = require("child_process");

// Windows: the shell / Explorer / IDE that launched us may hold a STALE PATH
// snapshot — tools installed AFTER that parent process started (yt-dlp, whisper-cli,
// ffmpeg, …) aren't on its inherited PATH, so `where` and spawn miss them and the
// app reports them "not installed" even though they're present. Refresh
// process.env.PATH from the registry (Machine + User, %VAR% already expanded) once at
// startup — exactly the PATH a freshly-opened shell would see. Runs on require, before
// any module spawns a tool. Best-effort: on any failure we keep the inherited PATH.
if (process.platform === "win32") {
  try {
    // Full path to powershell.exe — a very stale PATH might not even include the
    // PowerShell dir, and we must not depend on PATH to repair PATH.
    const ps = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const reg = execFileSync(ps, ["-NoProfile", "-NonInteractive", "-Command",
      "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')"],
      { encoding: "utf-8", timeout: 10000 }).trim();
    const cur = process.env.PATH || "";
    const have = new Set(cur.split(";").map((s) => s.trim().toLowerCase()).filter(Boolean));
    const extra = reg.split(";").map((s) => s.trim()).filter((p) => p && !have.has(p.toLowerCase()));
    if (extra.length) process.env.PATH = cur + (cur.endsWith(";") || !cur ? "" : ";") + extra.join(";");
    // Always log (even +0) so the startup console states unambiguously whether the
    // refresh ran and what it contributed — silence here has proven hard to debug.
    console.log(`[config] PATH refresh: +${extra.length} dirs from registry`);
  } catch (e) { console.warn(`[config] PATH refresh failed (${e.message}) — keeping inherited PATH`); }
}

// Local ML python. Kokoro TTS and the UMAP star-map projection share ONE venv.
// Explicit env (TTS_PYTHON / UMAP_PYTHON) wins; else auto-detect ~/venv/heykoko
// (the shared name) then ~/venv/tts (legacy); else fall back to "python3" on PATH.
function resolveVenvPython(envVar) {
  if (process.env[envVar]) return process.env[envVar];
  // venv interpreter layout differs by platform: Scripts\python.exe on Windows,
  // bin/python elsewhere. Fall back to the platform's default python launcher.
  const win = process.platform === "win32";
  const sub = win ? ["Scripts", "python.exe"] : ["bin", "python"];
  for (const name of ["heykoko", "tts"]) {
    const guess = path.join(os.homedir(), "venv", name, ...sub);
    try { if (fs.existsSync(guess)) return guess; } catch { /* ignore */ }
  }
  return win ? "python" : "python3";
}

// App data home: everything the server persists (chat archives, knowledge library,
// background-job queue) plus the cloud-backend config files (claude.json/openai.json)
// lives under this one directory. HEYKOKO_DIR overrides it — point a throwaway/test
// server at a temp dir for complete isolation from the real data.
const DATA_DIR = process.env.HEYKOKO_DIR || path.join(os.homedir(), ".hey-koko");

const config = {
  DATA_DIR,
  PORT: Number(process.env.HEYKOKO_PORT || 1314),
  URL_CONTENT_MAX_CHARS: Number(process.env.URL_CONTENT_MAX_CHARS || 40000),
  ollamaUrl: process.env.OLLAMA_URL || "http://127.0.0.1:11434",
  // Context window for internal Ollama LLM tasks (subtitle formatting, distill, rerank):
  // Ollama's default num_ctx is tiny (2-4k) and SILENTLY truncates the prompt. 24576
  // covers a 6k-CJK-char subtitle chunk plus its equal-length rewrite, and the 16k-char
  // distill sample. One shared value so back-to-back format→distill in a libimport job
  // doesn't reload the model with a different context size.
  llmTaskCtx: Number(process.env.LLM_TASK_CTX || 24576),
  imageOllamaUrl: process.env.IMAGE_OLLAMA_URL || (process.env.OLLAMA_URL || "http://127.0.0.1:11434"),
  comfyUrl: process.env.COMFYUI_URL || "http://127.0.0.1:8188",
  PUBLIC_DIR: path.join(__dirname, "..", "public"),
  ARCHIVES_DIR: path.join(DATA_DIR, "chat"),
  // Option B: server-side background job queue store. Isolated via HEYKOKO_DIR so a
  // throwaway server never loads (and starts running!) the real server's persisted queue.
  JOBS_DIR: path.join(DATA_DIR, "jobs"),
  whisperModel: process.env.WHISPER_MODEL || "",
  // Local text-to-speech (/voice) + UMAP star-map projection share ~/venv/heykoko
  // (python 3.11 with kokoro + umap-learn). TTS_PYTHON / UMAP_PYTHON override the
  // path; the system python may be too new for those ML wheels. Engines that fail
  // to import are reported unavailable rather than breaking the daemon.
  ttsPython: resolveVenvPython("TTS_PYTHON"),
  umapPython: resolveVenvPython("UMAP_PYTHON"),
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