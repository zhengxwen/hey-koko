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

// Baidu Unlimited-OCR runs in its OWN venv (Python 3.12 / torch cu130 / CUDA 13 —
// incompatible with the 3.11 heykoko/tts venv, so never shared). UNLIMITED_OCR_PYTHON
// overrides; else auto-detect ~/venv/unlimited-ocr. Returns "" when absent so the PDF
// OCR engine reports unavailable (option hidden) rather than falling back to a python
// that can't import torch.
function resolveOcrPython() {
  if (process.env.UNLIMITED_OCR_PYTHON) return process.env.UNLIMITED_OCR_PYTHON;
  const win = process.platform === "win32";
  const sub = win ? ["Scripts", "python.exe"] : ["bin", "python"];
  const guess = path.join(os.homedir(), "venv", "unlimited-ocr", ...sub);
  try { if (fs.existsSync(guess)) return guess; } catch { /* ignore */ }
  return "";
}

// Python for slide page-rendering (P3 visual layer): needs pypdfium2 + Pillow, which
// MinerU's own venv already ships (it renders PDFs to raster). SLIDES_PYTHON overrides;
// else derive from the `mineru` launcher's shebang (its venv python); else the OCR venv;
// else "" (PDF page-render unavailable → slides keep text + crop figures only).
function resolveSlidesPython() {
  if (process.env.SLIDES_PYTHON) return process.env.SLIDES_PYTHON;
  // The `mineru` console-script's first line is `#!/path/to/venv/bin/python3`.
  for (const dir of ["/opt/homebrew/bin", "/usr/local/bin", path.join(os.homedir(), "local", "bin"), path.join(os.homedir(), "venv", "mineru", "bin")]) {
    try {
      const exe = path.join(dir, "mineru");
      if (!fs.existsSync(exe)) continue;
      const first = fs.readFileSync(exe, "utf8").split(/\r?\n/)[0] || "";
      if (first.startsWith("#!")) { const py = first.slice(2).trim().split(/\s+/)[0]; if (py && fs.existsSync(py)) return py; }
    } catch { /* keep looking */ }
  }
  try {
    const which = execFileSync(process.platform === "win32" ? "where" : "which", ["mineru"], { encoding: "utf8" }).trim().split(/\r?\n/)[0];
    if (which) { const first = fs.readFileSync(which, "utf8").split(/\r?\n/)[0] || ""; if (first.startsWith("#!")) { const py = first.slice(2).trim().split(/\s+/)[0]; if (py && fs.existsSync(py)) return py; } }
  } catch { /* ignore */ }
  return process.env.UNLIMITED_OCR_PYTHON ? resolveOcrPython() : "";
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
  // News-feed article extraction (server/extract-article.py) runs `trafilatura` — a
  // site-agnostic main-content + metadata extractor that drops nav/related/boilerplate
  // and returns author/date/categories/tags/hero-image. TRAFILATURA_PYTHON overrides;
  // else it shares the heykoko venv (just `pip install trafilatura` there). Availability
  // is probed at runtime (import trafilatura) — when absent, news import reports the
  // feature unavailable rather than falling back to the weaker built-in HTML heuristics.
  newsPython: resolveVenvPython("TRAFILATURA_PYTHON"),
  // Local PDF OCR engine (baidu/Unlimited-OCR) interpreter; "" when not installed.
  ocrPython: resolveOcrPython(),
  // MinerU backend passed as `-b`. Default "pipeline" (ONNX/torch, dependency-light,
  // works without vLLM). MinerU's own default (hybrid-engine/VLM) needs vLLM, which
  // JIT-compiles CUDA and requires python3-dev headers + a supported GPU — set
  // MINERU_BACKEND=hybrid-engine (etc.) to opt into it. "" → let MinerU pick.
  mineruBackend: process.env.MINERU_BACKEND || "pipeline",
  // P3 slides visual layer — render each slide page to a whole-page JPEG (q80) stored on
  // the page block, so /ask can feed a vision model the actual page (charts/layout), not
  // just the terse text. Always attempted for slide imports; it's best-effort, so it just
  // no-ops when no backend is present. slidesPython renders PDFs (pypdfium2); pptx goes
  // via LibreOffice → PDF → pypdfium2, then officecli, then PowerPoint AppleScript; docx
  // pages are officecli-only (OFFICECLI_BIN overrides its discovery — server/officecli.js).
  // slidesRenderScale bumps resolution for small text (higher = clearer + bigger file);
  // slidesRenderMaxPages caps cost.
  slidesPython: resolveSlidesPython(),
  slidesRenderScale: Number(process.env.HEYKOKO_SLIDES_RENDER_SCALE || 2.0),
  slidesRenderMaxPages: Number(process.env.HEYKOKO_SLIDES_RENDER_MAXPAGES || 80),
  WHISPER_MODEL_SEARCH_PATHS: [
    path.join(os.homedir(), ".local", "share", "whisper-cpp"),
    path.join(os.homedir(), "whisper.cpp", "models"),
    "/opt/homebrew/share/whisper-cpp/models",
    "/usr/local/share/whisper-cpp/models",
  ],
  // Zotero desktop LOCAL API bridge (read-only paper import — server/zotero.js).
  // Optional: ~/.hey-koko/zotero.json { "apiBase": "http://127.0.0.1:23119" } overrides
  // the default, e.g. an SSH tunnel when Zotero runs on another machine. Absent file →
  // localhost default (the common same-machine case). ZOTERO_API_BASE env wins over both.
  ZOTERO: (() => {
    let file = {};
    try { file = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "zotero.json"), "utf8")) || {}; } catch { /* optional */ }
    const apiBase = process.env.ZOTERO_API_BASE || file.apiBase || "http://127.0.0.1:23119";
    return { apiBase: String(apiBase).replace(/\/+$/, "") };
  })(),
  // Co-browsing CDP bridge (server/cdp.js): the user's dedicated Chrome instance
  // launched with --remote-debugging-port. Optional ~/.hey-koko/browser.json
  // { "cdpBase": "http://127.0.0.1:9222" } overrides the default (e.g. Chrome on
  // another machine via SSH tunnel); BROWSER_CDP_URL env wins over both.
  BROWSER_CDP: (() => {
    let file = {};
    try { file = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "browser.json"), "utf8")) || {}; } catch { /* optional */ }
    const cdpBase = process.env.BROWSER_CDP_URL || file.cdpBase || "http://127.0.0.1:9222";
    return { cdpBase: String(cdpBase).replace(/\/+$/, "") };
  })(),
  MIME_TYPES: {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".woff2": "font/woff2",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".glb": "model/gltf-binary",
  },
};

module.exports = config;