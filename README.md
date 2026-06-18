# Hey-Koko

A lightweight, privacy-first AI companion that runs entirely on your machine. Powered by [Ollama](https://ollama.com), no cloud required.

Hey-Koko gives you a personal AI chat experience without sending a single byte to the cloud. It connects to your local Ollama instance, supports file uploads (PDF, Word, PowerPoint, images), web page summarization, YouTube transcription, image generation, and text-to-speech — all through a clean browser UI with zero build steps. Customize your companion's name, personality, and voice to make it truly yours.


## Demo

<img src="docs/demo1.jpg" width="50%"><img src="docs/demo2.jpg" width="50%"><img src="docs/demo3.jpg" width="50%">


## Features

- **Local & Private** — All conversations stay on your device. No data leaves your machine.
- **Customizable Personality** — Adjust the system prompt to make your companion warm, witty, calm, or analytical.
- **File Understanding** — Upload PDFs, DOCX, PPTX, EML, images, and plain text directly into the chat.
- **Image Generation** — Generate images with local Ollama image models, or connect a local [ComfyUI](https://github.com/comfyanonymous/ComfyUI) server for advanced text-to-image, instruction-based editing, multi-image composition, and **video generation** (see [ComfyUI Backend](#comfyui-backend-advanced-image--video)).
- **Web & YouTube** — Fetch and summarize web pages or YouTube videos with `/url`.
- **Speech** — Text-to-speech output using macOS system voices.
- **Rich Markdown** — LaTeX math (KaTeX), Mermaid diagrams, and syntax-highlighted code blocks.
- **Conversation Archive** — Save and revisit past conversations.
- **Multi-model** — Switch between any Ollama model on the fly.


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
   ollama pull x/flux2-klein:9b    # image generation model
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

### Stop the app

```bash
./kill-app.sh
```

Force-kills any running `hey-koko` app instances and `node server.js` processes, then verifies port `1314` is free. Use it when a previous instance is stuck or the port is still in use before launching again.


## ComfyUI Backend (Advanced Image & Video)

In addition to Ollama image models, Hey-Koko can drive a local [ComfyUI](https://github.com/comfyanonymous/ComfyUI) server for high-end text-to-image, instruction-based image editing, multi-image composition, and video generation — all from the same `/imagine` command. ComfyUI builds the workflow graphs automatically; you only pick a model.

### Setup

1. Install and launch ComfyUI, then download the model files you want into its `models/` folders (`checkpoints/`, `diffusion_models/`, `text_encoders/`, `vae/`, `loras/`).
2. In Hey-Koko's **Settings → Model** tab, leave the **Ollama image model** dropdown empty (`Leave empty (use ComfyUI)`).
3. Set the ComfyUI address: click the ✎ next to the ComfyUI URL to enter `host:port` manually, or use the **scan** button to auto-discover ComfyUI on your local network (probes `:8188`). Default is `127.0.0.1:8188`.
4. Pick a model from the ComfyUI dropdown — it is grouped into **text-to-image**, **instruction edit** (needs a reference image), and **video**.

Hey-Koko reads the model list live from ComfyUI's `/object_info` and auto-selects the required companion files (text encoders, VAEs), so it tells you exactly which file is missing if one isn't installed.

### Capabilities

| Mode | How to use | Models (auto-detected by filename) |
|------|-----------|-----------------------------------|
| **Text-to-image** | `/imagine <prompt>` | Flux, SDXL / Pony / Illustrious, SD3, HiDream-I1, Z-Image-Turbo |
| **Image-to-image** | Attach an image + `/imagine <prompt>` | Any checkpoint (VAE-encode + partial denoise) |
| **Instruction edit** | Attach an image + `/imagine <edit instruction>` | FLUX.1 Kontext, Qwen-Image-Edit, InstructPix2Pix, OmniGen2, HiDream-E1.1 |
| **Multi-image composition** | Attach 2–3 images + `/imagine <how to combine>` | Qwen-Image-Edit-2509 Plus |
| **Text-to-video** | `/imagine <prompt>` | WAN 2.2 (5B / 14B), Hunyuan Video, LTX-2.3 |
| **Image-to-video** | Attach an image + `/imagine <prompt>` | WAN 2.2 (5B ti2v / 14B i2v), LTX-2.3 |

Each model family is configured with sane sampling defaults out of the box (Flux guidance distillation, InstructPix2Pix dual-CFG, WAN's standard negative prompt, the LTX audio+video pipeline, etc.).

- **WAN 2.2 14B** is a two-expert (high-noise + low-noise) model — Hey-Koko chains both experts automatically and collapses the pair into a single dropdown entry. If the **LightX2V 4-step LoRAs** are installed it auto-switches to the fast 4-step / cfg-1 path (~6–10× faster).
- **LTX-2.3** generates synchronized **audio**, muxed into the output MP4.

### `/imagine` Flags

| Flag | Effect |
|------|--------|
| `--size WxH` | Explicit output size (e.g. `--size 832x480`); otherwise the model's preset is used. For image-to-video the aspect ratio is matched to the input image. |
| `--square` / `--portrait` / `--landscape` / `--wide` / `--tall` | Aspect-ratio presets |
| `--steps N` | Sampling steps |
| `--seed N` | Fixed seed (reproducible) |
| `--enhance` | Rewrite the prompt with an LLM first — image-oriented for images, motion/camera-oriented for video. The improved prompt is shown before generation. |
| `--no <text>` | Negative prompt |
| `4x <prompt>` | Batch (generate N images) |

Sampler, scheduler, CFG, guidance, image-CFG, denoise, video length, and FPS can be overridden in the **⚙ Advanced generation params** popup (next to the ComfyUI model dropdown). `/imagine` flags take precedence over the popup, which takes precedence over the per-model defaults.

### Live Progress & Preview

While ComfyUI generates, Hey-Koko shows a **progress bar** and, when ComfyUI is launched with a preview method (`--preview-method auto`), **live preview frames** decoded during sampling. Progress streams over ComfyUI's WebSocket; Ollama image generation also shows a progress bar (step count) via its NDJSON stream.

Generated videos are not auto-played (click to play, with audio) and each has a **download** button.

### Configuration

Set a non-default ComfyUI address with the `COMFY_URL` environment variable (see [Environment Variables](#environment-variables)).


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


## Optional Enhancements

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
- **Frontend**: Vanilla HTML/CSS/JS (no build step)
- **AI Engine**: Ollama (local LLM inference); optional ComfyUI (local image/video generation)
- **CDN Libraries**: KaTeX, Mermaid, highlight.js, pdf.js, mammoth.js, JSZip

