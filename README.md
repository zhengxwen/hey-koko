# Hey-Koko

A lightweight, privacy-first AI companion that runs entirely on your machine. Powered by [Ollama](https://ollama.com) — no cloud, no accounts, no telemetry.

Hey-Koko gives you a personal AI chat experience without sending a single byte to the cloud. It talks to your local Ollama instance and adds file understanding, vision analysis, web & YouTube reading, web search, image & video generation, local text-to-speech, long-term memory, proactive messages, and a background task queue — all through a clean browser UI (or a native macOS app) with **zero build steps**. Make it yours: name it, shape its personality, pick its voice.


## Demo

<img src="docs/demo1.jpg" width="50%"><img src="docs/demo2.jpg" width="50%"><img src="docs/demo3.jpg" width="50%">


## Features

- **Local & private** — conversations, memory, and archives stay on your device. Nothing leaves your machine.
- **Customizable companion** — set the name, personality (system prompt), and default voice.
- **Multi-tab chats** — run several independent conversations side by side, each with its own context.
- **File understanding** — drag in PDF, DOCX, PPTX, EML, images, or plain text; they're parsed and fed to the model.
- **Vision analysis** — `/analyze` an attached image or video (sampled into frames) with a local vision model.
- **Web & YouTube** — `/url` fetches and summarizes a web page, or transcribes and tidies up a YouTube video.
- **Web search** — `/search` queries DuckDuckGo, optionally reading the top results in depth.
- **Image & video generation** — `/imagine` with local Ollama image models; optionally connect [ComfyUI](#comfyui-advanced-image--video-generation) for advanced text-to-image, instruction editing, multi-image composition, and video.
- **Local text-to-speech** — `/voice` synthesizes a downloadable audio file (Kokoro / CosyVoice, or macOS system voices). Optional auto-speak reads replies aloud.
- **Long-term memory & proactive messages** — remembers facts about you, and can greet, nudge, or remind you on its own.
- **Agentic tools** — an optional tool-use loop (date/time, calculator, web search, recall memory, set reminders, remember facts).
- **Background task queue** — long-running jobs run detached so you can keep chatting; see [Background Jobs](#background-jobs).
- **Conversation archive** — save, revisit, and **semantically search** past conversations; export any chat to Markdown.
- **Rich markdown** — LaTeX math (KaTeX), Mermaid diagrams, syntax-highlighted code, and a live context/token usage meter.
- **Multi-model** — switch between any installed Ollama model on the fly.
- **Trilingual UI** — English, Simplified Chinese, Traditional Chinese.


## License

GPL-3.0


## Quick Start

1. Install [Homebrew](https://brew.sh) (if not already installed):

   ```bash
   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
   ```

2. Install [Node.js](https://nodejs.org) (if not already installed):

   ```bash
   brew install node
   ```

3. Install and launch [Ollama](https://ollama.com).
4. Pull a model:

   ```bash
   ollama pull gemma4:12b-it-qat   # chat model
   ollama pull x/flux2-klein:9b    # image generation model (optional)
   ```

5. Start the server:

   ```bash
   node server.js
   ```

   Or double-click `start.command` on macOS.

6. Open your browser at:

   ```
   http://127.0.0.1:1314
   ```

Everything beyond a chat model is optional — image generation, file parsers, YouTube, and text-to-speech each light up as you install their helper (see [Optional Enhancements](#optional-enhancements)).


## Commands

Type `/` in the chat box to open the command palette. The main commands:

| Command | What it does |
|---------|--------------|
| `/imagine <prompt>` | Generate an image (or a **video** when a ComfyUI video model is selected). Attach an image to edit/extend it. Flags: batch `4x`, `--enhance`/`-e`, `--size WxH` or `480p`/`720p`/`1080p` (`-portrait` for vertical), `--steps N`, `--seed N`, `--quality high/medium/low`, `--no <negative>`. |
| `/analyze [question]` | Analyze an attached image/video with the vision model. `-f N` sets how many video frames to sample (default 8). |
| `/url [prompt] <link>` | Parse & summarize a web page, or transcribe & tidy up a YouTube video. |
| `/search <query>` | DuckDuckGo search. `--deep[=N]`/`--read` to read pages, `--n N` result count, `--day`/`--week`/`--month`/`--year` recency. |
| `/voice <text>` | Text-to-speech → downloadable audio file. `--use`/`-u engine:voice` (e.g. `cosyvoice:中文男`), `--speed`/`-s 0.5–2`. |
| `/memory <fact>` | Remember a fact about you long-term. |
| `/note <text>` | Record a note (no AI reply). |
| `/remind <when> <text>` | Set a reminder, e.g. `/remind 30m drink water`. |
| `/title [name] [#tags]` | Rename the current tab and/or add tags. |
| `/retry [Nx]` | Re-answer your last message; add `Nx` to repeat N times. |
| `/compact` | Summarize and compress the conversation context. |
| `/clear` | Clear the current chat. |
| `/0 <msg>` · `/1 <msg>` | Reply with **no** prior context, or with **only** the previous message as context. |


## Background Jobs

Long-running work — image/video/audio generation, `/analyze`, document parsing + summarization, and `/url` (including slow YouTube transcription) — runs in a **serial background queue** instead of blocking the chat. When you send one, a placeholder appears at that spot in the conversation and the job is tracked in a right-side **drawer**:

- Keep chatting (or switch tabs) while it runs; the result drops back into its original spot when done.
- Each running job shows a **progress bar**, plus a live preview frame for ComfyUI image/video.
- **Cancel** or **retry** any job, and **reorder** not-yet-started jobs by dragging their ⠿ handle.
- Closing or reloading the app interrupts an in-flight job, but its inputs are saved so it can resume or be retried.


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

To pass a non-default `COMFY_URL` (or other env var) to the Finder-launched app, set it once with `launchctl setenv COMFY_URL http://host:8188` and relaunch.

### Stop the app

```bash
./kill-app.sh
```

Force-kills any running `hey-koko` app instances and `node server.js` processes, then verifies port `1314` is free. Use it when a previous instance is stuck or the port is still in use before launching again.


## Supported File Types

Drag & drop or click to upload files in the chat input:

| Type | Extensions | Parser |
|------|-----------|--------|
| Images | jpg, png, gif, webp, etc. | Sent directly to vision models |
| PDF | .pdf | MinerU (server) → pdf.js (client fallback) |
| Word | .docx | Pandoc (server) → mammoth.js (client fallback) |
| PowerPoint | .pptx | Pandoc (server) → JSZip (client fallback) |
| Email | .eml | Client-side MIME parsing (with image extraction) |
| Plain text | .txt, .md, .markdown | Direct read |

PDF/DOCX files are auto-summarized after parsing. Both parsing and summarization run in the [background queue](#background-jobs), so a large document never freezes the UI.


## Optional Enhancements

Hey-Koko works with just Ollama. Each helper below unlocks an extra capability when installed; without it, that feature is simply hidden or falls back to a lighter path.

### Pandoc (better DOCX/PPTX parsing)

```bash
brew install pandoc
```

### MinerU (high-quality PDF parsing)

```bash
pip install uv
uv pip install -U "mineru[all]"
```

Requirements: Python 3.10–3.13, ≥16GB RAM. Supports CPU-only and Apple Silicon acceleration.

On first run, MinerU downloads ~2GB of models. If behind a firewall:

```bash
export HF_ENDPOINT=https://hf-mirror.com

mineru -p test.pdf -o output
```

Once models are downloaded, you can enable offline mode to prevent future network requests:

```bash
export HF_HUB_OFFLINE=1
export TRANSFORMERS_OFFLINE=1
```

### yt-dlp & ffmpeg (YouTube support)

```bash
brew install yt-dlp ffmpeg
```

Enables `/url https://youtube.com/watch?v=xxx` to extract subtitles and summarize video content.

### whisper.cpp (speech-to-text for videos without subtitles)

```bash
brew install whisper-cpp
```

Download a model (recommended: `medium`, 1.5 GiB):

```bash
curl -L -o ~/.local/share/whisper-cpp/ggml-medium.bin \
  --create-dirs \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin
```

When a YouTube video has no subtitles, `/url` falls back to downloading the audio and transcribing it with whisper.cpp (this is one of the slower jobs that the [background queue](#background-jobs) keeps off the main thread).

### Local text-to-speech (`/voice` command)

The `/voice <text>` command synthesizes a **downloadable audio file** with a
local open-source engine. Two engines are supported, each exposing fixed preset
voices (male/female) selectable in the **Settings voice dropdown** or inline with
`--use`/`-u`:

| Engine | Strength | Preset voices |
|--------|----------|---------------|
| **Kokoro** | light & fast | Chinese `kokoro:zf_xiaoxiao` (女) / `kokoro:zm_yunxi` (男); English `kokoro:af_heart` (US ♀) / `kokoro:bm_george` (UK ♂) … |
| **CosyVoice** | higher Chinese quality | `cosyvoice:中文女`, `cosyvoice:中文男`, `cosyvoice:粤语女` |

These need PyTorch/MLX wheels that don't yet exist for the newest Python, so
install them in a **dedicated venv (Python 3.10–3.11)**. The easiest way is
[uv](https://github.com/astral-sh/uv) (`brew install uv`), which also downloads
the right Python for you:

```bash
# Kokoro (light & fast) — recommended
uv venv --python 3.11 ~/venv/tts
uv pip install --python ~/venv/tts/bin/python kokoro "misaki[zh]" numpy soundfile

# English voices (af_*/am_* US, bf_*/bm_* UK) also need the spaCy English model
# + espeak-ng (otherwise misaki tries to auto-download the model and fails):
uv pip install --python ~/venv/tts/bin/python \
  "https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl"
brew install espeak-ng
```

The server **auto-detects `~/venv/tts/bin/python`**, so you can just run
`node server.js` — no extra env var needed. (To use a different venv, point
`TTS_PYTHON` at its `bin/python`.) AAC encoding uses `ffmpeg` (`brew install
ffmpeg`); without it the audio falls back to wav.

<details>
<summary>CosyVoice (optional, higher Chinese quality — harder on macOS)</summary>

CosyVoice is not a pip package; clone the repo, install deps, and download the
SFT model. Its `pynini`/WeTextProcessing dependency has no macOS wheel — install
that one via conda-forge (`conda install -c conda-forge pynini`). Then add to the
**same venv** so both engines show up:

```bash
git clone --recursive https://github.com/FunAudioLLM/CosyVoice.git ~/CosyVoice
uv pip install --python ~/venv/tts/bin/python torch torchaudio modelscope \
  librosa onnxruntime hyperpyyaml conformer diffusers gdown inflect lightning
~/venv/tts/bin/python -c "from modelscope import snapshot_download; \
  snapshot_download('iic/CosyVoice-300M-SFT', \
  local_dir='$HOME/CosyVoice/pretrained_models/CosyVoice-300M-SFT')"
```

Launch with the repo + model on the path:

```bash
PYTHONPATH=$HOME/CosyVoice:$HOME/CosyVoice/third_party/Matcha-TTS \
COSYVOICE_MODEL_DIR=$HOME/CosyVoice/pretrained_models/CosyVoice-300M-SFT \
TTS_PYTHON=~/venv/tts/bin/python node server.js
```
</details>

Engines that fail to import are simply hidden from the voice dropdown (the macOS
`say` voices are always available). Usage: `/voice 你好世界`,
`/voice --use cosyvoice:中文男 --speed 1.1 早上好` (`-u`/`-s` short forms).

Examples:
- `/voice 今天天气不错` → uses the default voice from settings
- `/voice -u kokoro:zm_yunxi 大家好` → specific Kokoro male voice

### ComfyUI (advanced image & video generation)

Image generation works out of the box with local **Ollama image models** (e.g. `x/flux2-klein:9b`). For high-end text-to-image, instruction-based editing, multi-image composition, and **video**, you can optionally connect a local [ComfyUI](https://github.com/comfyanonymous/ComfyUI) server — all driven from the same `/imagine` command. ComfyUI builds the workflow graphs automatically; you only pick a model. **This is entirely optional**; without it, `/imagine` still generates images via Ollama.

**Setup**

1. Install and launch ComfyUI, then download the model files you want into its `models/` folders (`checkpoints/`, `diffusion_models/`, `text_encoders/`, `vae/`, `loras/`).
2. In Hey-Koko's **Settings → Model** tab, leave the **Ollama image model** dropdown empty (`Leave empty (use ComfyUI)`).
3. Set the ComfyUI address: click the ✎ next to the ComfyUI URL to enter `host:port` manually, or use the **scan** button to auto-discover ComfyUI on your local network (probes `:8188`). Default is `127.0.0.1:8188` (also configurable via the `COMFY_URL` environment variable).
4. Pick a model from the ComfyUI dropdown — it is grouped into **text-to-image**, **instruction edit** (needs a reference image), **video**, and **video editing** (needs a source video).

Hey-Koko reads the model list live from ComfyUI's `/object_info` and auto-selects the required companion files (text encoders, VAEs), so it tells you exactly which file is missing if one isn't installed.

**Capabilities**

| Mode | How to use | Models (auto-detected by filename) |
|------|-----------|-----------------------------------|
| **Text-to-image** | `/imagine <prompt>` | Flux, SDXL / Pony / Illustrious, SD3, HiDream-I1, Z-Image-Turbo |
| **Image-to-image** | Attach an image + `/imagine <prompt>` | Any checkpoint (VAE-encode + partial denoise) |
| **Instruction edit** | Attach an image + `/imagine <edit instruction>` | FLUX.1 Kontext, Qwen-Image-Edit, InstructPix2Pix, OmniGen2, HiDream-E1.1 |
| **Multi-image composition** | Attach 2–3 images + `/imagine <how to combine>` | Qwen-Image-Edit-2509 Plus |
| **Text-to-video** | `/imagine <prompt>` | WAN 2.2 (5B / 14B), Hunyuan Video, LTX-2.3 |
| **Image-to-video** | Attach an image + `/imagine <prompt>` | WAN 2.2 (5B ti2v / 14B i2v), LTX-2.3 |
| **Video editing** | Attach a source video + `/imagine <prompt>` | WAN 2.2 (Bernini v2v/rv2v), WAN 2.2 Animate (pose transfer) |

Each model family ships with sane sampling defaults (Flux guidance distillation, InstructPix2Pix dual-CFG, WAN's standard negative prompt, the LTX audio+video pipeline, etc.).

- **WAN 2.2 14B** is a two-expert (high-noise + low-noise) model — Hey-Koko chains both experts automatically and collapses the pair into a single dropdown entry. With the **LightX2V 4-step LoRAs** installed it auto-switches to the fast 4-step / cfg-1 path (~6–10× faster).
- **LTX-2.3** generates synchronized **audio**, muxed into the output MP4.

**`/imagine` flags** (the basic ones also work with Ollama image models):

| Flag | Effect |
|------|--------|
| `--size WxH` | Explicit output size (e.g. `--size 832x480`), or presets `480p`/`720p`/`1080p` (`-portrait` for vertical). For image-to-video the aspect ratio follows the input image. |
| `--steps N` | Sampling steps |
| `--seed N` | Fixed seed (reproducible) |
| `--enhance` / `-e` | Rewrite the prompt with an LLM first — image-oriented for images, motion/camera-oriented for video. The improved prompt is shown before generation. |
| `--no <text>` | Negative prompt |
| `4x <prompt>` | Batch (generate N images) |

Sampler, scheduler, CFG, guidance, image-CFG, denoise, video length, and FPS can be overridden in the **⚙ Advanced generation params** popup (next to the ComfyUI model dropdown). `/imagine` flags take precedence over the popup, which takes precedence over the per-model defaults.

While ComfyUI generates, Hey-Koko shows a progress bar and, when ComfyUI is launched with a preview method (`--preview-method auto`), live preview frames decoded during sampling — both in the chat and the [background jobs](#background-jobs) drawer. Generated videos are click-to-play (with audio) and each has a download button.


## Environment Variables

```bash
OLLAMA_URL=http://127.0.0.1:11434 PORT=1314 node server.js
```

| Variable | Default | Description |
|----------|---------|-------------|
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Ollama API endpoint |
| `COMFY_URL` | `http://127.0.0.1:8188` | ComfyUI API endpoint (also editable in the UI) |
| `PORT` | `1314` | Server port |
| `WHISPER_MODEL` | auto-detect | Path to whisper.cpp model file |
| `TTS_PYTHON` | `python3` | Python (venv) with kokoro/cosyvoice for `/voice` |
| `COSYVOICE_MODEL_DIR` | `pretrained_models/CosyVoice-300M-SFT` | CosyVoice SFT model path |


## Tech Stack

- **Backend**: Node.js (zero dependencies, pure `http` module)
- **Frontend**: Vanilla HTML/CSS/JS (no build step); IndexedDB for local persistence
- **AI Engine**: Ollama (local LLM inference); optional ComfyUI (local image/video generation)
- **CDN Libraries**: KaTeX, Mermaid, highlight.js, pdf.js, mammoth.js, JSZip
