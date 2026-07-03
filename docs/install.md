# Installation Guide

The macOS quick start lives in the [README](../README.md#quick-start). This page covers **Linux**, **Windows**, the native **macOS app bundle**, and the full **environment variable** reference.

## Linux

1. Install [Node.js](https://nodejs.org) ≥18 (if not already installed). Ubuntu/Debian ship a recent-enough version via apt:

   ```bash
   sudo apt update && sudo apt install -y nodejs npm
   ```

   No `sudo`, or want a newer Node? Use [nvm](https://github.com/nvm-sh/nvm) instead:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
   # open a new shell, then:
   nvm install --lts
   ```

2. Install and launch [Ollama](https://ollama.com):

   ```bash
   curl -fsSL https://ollama.com/install.sh | sh
   ```

   Ollama runs as a background service and serves on `127.0.0.1:11434` automatically.

3. Pull a model:

   ```bash
   ollama pull gemma4:12b-it-qat   # chat model
   ollama pull x/flux2-klein:9b    # image generation model (optional)
   ```

4. Start the server:

   ```bash
   node server.js
   ```

   Or run `./start.sh`, which also opens the browser automatically (when a graphical session exists).

5. Open your browser at:

   ```
   http://127.0.0.1:1314
   ```

Everything beyond a chat model is optional — image generation, file parsers, YouTube, and text-to-speech each light up as you install their helper (see [Optional Enhancements](../README.md#optional-enhancements); each one lists a Linux command alongside macOS/Windows).

## Windows

Windows uses [winget](https://learn.microsoft.com/windows/package-manager/winget/) in place of Homebrew. PowerShell examples below; run them in a normal (non-admin) PowerShell.

1. Install [Node.js](https://nodejs.org) LTS (if not already installed):

   ```powershell
   winget install OpenJS.NodeJS.LTS
   ```

2. Install and launch [Ollama](https://ollama.com):

   ```powershell
   winget install Ollama.Ollama
   ```

   Ollama then runs in the background and serves on `127.0.0.1:11434` automatically.

3. Pull a model:

   ```powershell
   ollama pull gemma4:12b-it-qat   # chat model
   ollama pull x/flux2-klein:9b    # image generation model (optional)
   ```

4. Start the server (open a **new** terminal after installing tools so the updated PATH is picked up):

   ```powershell
   node server.js
   ```

   Or double-click `start.bat`.

5. Open your browser at `http://127.0.0.1:1314`.

> **What's macOS-only on Windows:** the native [macOS app bundle](#macos-app-bundle) (Swift/WebKit wrapper) and the built-in **macOS `say` system voices** (the `say:` entries in the voice dropdown — Windows only offers the Kokoro voices). Both **reading replies aloud** (the 朗读 button / auto-speak) and the **`/voice` command** work on Windows using the [Kokoro](tts.md) voices: reading-aloud plays through the server's speakers (via PowerShell's built-in player), and `/voice` plays a clip in the browser. See [Optional Enhancements](../README.md#optional-enhancements) for the Windows setup of each helper.

Everything beyond a chat model is optional — image generation, file parsers, YouTube, and text-to-speech each light up as you install their helper (see [Optional Enhancements](../README.md#optional-enhancements)).

## macOS App Bundle

On macOS you can package Hey-Koko into a native `.app` (a Swift/WebKit wrapper that launches the Node server and opens the UI in its own window) instead of running it from the terminal.

### Build the app

```bash
./build-app.sh
```

This produces `hey-koko.app` in the project root. The script:

- Renders `app-icon.svg` into an `.icns` icon (uses `rsvg-convert` if installed, otherwise falls back to `qlmanage`; install with `brew install librsvg` for the best result).
- Copies `server.js`, `server/`, and `public/` into the bundle.
- Compiles `AppMain.swift` (requires the Xcode command-line tools: `xcode-select --install`).
- Writes `Info.plist`.

Once built you can:

- Double-click `hey-koko.app` to launch.
- Drag it to `/Applications` to install, or to the Dock for quick access.

To pass a non-default `COMFYUI_URL` (or other env var) to the Finder-launched app, set it once with `launchctl setenv COMFYUI_URL http://host:8188` and relaunch.

### Stop the app

```bash
./kill-app.sh
```

Force-kills any running `hey-koko` app instances and `node server.js` processes, then verifies port `1314` is free. Use it when a previous instance is stuck or the port is still in use before launching again.

## Environment Variables

```bash
# macOS / Linux
OLLAMA_URL=http://127.0.0.1:11434 PORT=1314 node server.js
```

```powershell
# Windows PowerShell
$env:OLLAMA_URL = "http://127.0.0.1:11434"; $env:PORT = "1314"; node server.js
```

| Variable | Default | Description |
|----------|---------|-------------|
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Ollama API endpoint |
| `IMAGE_OLLAMA_URL` | `OLLAMA_URL` | Separate Ollama endpoint for image analysis (vision models), if different from the chat one |
| `COMFYUI_URL` | `http://127.0.0.1:8188` | ComfyUI API endpoint (also editable in the UI) |
| `PORT` | `1314` | Server port |
| `LLM_TASK_CTX` | `24576` | Ollama context window (`num_ctx`) for internal LLM tasks (subtitle formatting, library distill/rerank). Ollama's small default would silently truncate long prompts |
| `URL_CONTENT_MAX_CHARS` | `40000` | Max characters kept from a fetched webpage (`/url`); `0` = unlimited. YouTube transcripts are never truncated |
| `WHISPER_MODEL` | auto-detect | Path to whisper.cpp model file |
| `TTS_PYTHON` | auto-detect | Python with kokoro for `/voice` (default: `~/venv/tts` venv if present, else `python3`/`python`) |
| `ANTHROPIC_BASE_URL` | `https://api.anthropic.com` | Claude API origin (overrides `claude.json`) |
| `ANTHROPIC_API_KEY` | — | Claude API key (overrides `claude.json`; enables cloud models) |
| `OPENAI_BASE_URL` | `https://api.openai.com` | OpenAI API origin (overrides `openai.json`) |
| `OPENAI_API_KEY` | — | OpenAI API key (overrides `openai.json`; enables cloud models) |
| `HEYKOKO_DIR` | `~/.hey-koko` | App data home: chat archives, knowledge library, background-job queue, `claude.json`/`openai.json` all live under it. Mainly for tests: point a throwaway server at a temp dir so it never touches your real data (or loads — and starts running — your real server's persisted job queue) |
