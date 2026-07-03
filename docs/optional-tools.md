# Optional Tools

Hey-Koko works with just Ollama. Each helper below unlocks an extra capability when installed; without it, that feature is simply hidden or falls back to a lighter path.

See also: [Local text-to-speech](tts.md) · [ComfyUI](comfyui.md) · [Cloud models](cloud-models.md)

## Pandoc

Better DOCX/PPTX parsing.

```bash
brew install pandoc               # macOS
sudo apt install -y pandoc        # Linux (Debian/Ubuntu)
winget install JohnMacFarlane.Pandoc   # Windows
```

## MinerU

High-quality PDF parsing.

```bash
pip install uv
uv pip install -U "mineru[all]"          # macOS / Linux
uv pip install --system -U "mineru[all]" # Windows (or drop --system inside a venv)
```

Requirements: Python 3.10–3.13, ≥16GB RAM. Supports CPU-only, CUDA (NVIDIA), and Apple Silicon acceleration.

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

## yt-dlp & ffmpeg

YouTube support.

```bash
brew install yt-dlp ffmpeg        # macOS
sudo apt install -y ffmpeg        # Linux (Debian/Ubuntu) — ffmpeg
pipx install yt-dlp               # Linux — yt-dlp (apt's version is often stale; pipx keeps it isolated & on PATH)
winget install yt-dlp.yt-dlp      # Windows (bundles ffmpeg; or: winget install Gyan.FFmpeg)
```

Enables `/url https://youtube.com/watch?v=xxx` to extract subtitles and summarize video content.

**If YouTube blocks requests** ("Sign in to confirm you're not a bot" / 429 — common during batch imports): export your youtube.com cookies in Netscape `cookies.txt` format (browser extension; ideally from a private window with a throwaway account, then close that window) and save them as `~/.hey-koko/youtube-cookies.txt`. Every yt-dlp call picks the file up automatically — no restart needed; delete it to stop. Keep it writable (yt-dlp saves rotated cookies back).

## whisper.cpp

Speech-to-text for videos without subtitles.

**macOS:**

```bash
brew install whisper-cpp
```

**Linux** — no distro package; build from source into `~/whisper.cpp` (auto-detected there):

```bash
git clone https://github.com/ggml-org/whisper.cpp ~/whisper.cpp
cmake -B ~/whisper.cpp/build -S ~/whisper.cpp
cmake --build ~/whisper.cpp/build -j --config Release
```

This produces `~/whisper.cpp/build/bin/whisper-cli`, which the server finds automatically — no PATH changes needed. (Alternatively put `whisper-cli` on PATH yourself, e.g. under `/usr/local/bin`.)

**Windows** — there's no winget package, so use the prebuilt binary:

1. Download `whisper-bin-x64.zip` from the [whisper.cpp releases](https://github.com/ggml-org/whisper.cpp/releases) and extract it, e.g. to `%LOCALAPPDATA%\whisper-cpp`.
2. Add the extracted `Release\` folder (it holds `whisper-cli.exe` + its DLLs) to your user PATH, then open a new terminal:

   ```powershell
   [Environment]::SetEnvironmentVariable("Path", [Environment]::GetEnvironmentVariable("Path","User") + ";$env:LOCALAPPDATA\whisper-cpp\Release", "User")
   ```

Download a model (recommended: `medium`, 1.5 GiB). This `curl` line works in both macOS and Windows PowerShell (Windows 10 1803+/11 ship `curl.exe`); on Windows it lands in `%USERPROFILE%\.local\share\whisper-cpp\`:

```bash
curl -L -o ~/.local/share/whisper-cpp/ggml-medium.bin \
  --create-dirs \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin
```

When a YouTube video has no subtitles, `/url` falls back to downloading the audio and transcribing it with whisper.cpp (this is one of the slower jobs that the [background queue](../README.md#background-jobs) keeps off the main thread).

## OpenCC

Simplified/Traditional Chinese normalization — optional.

Chinese YouTube subtitles come in either Simplified or Traditional (and whisper can output a mix). A cleaned-up transcript is normalized to the variant your **prompt language** asks for — Simplified for `zh`, Traditional for `zh-Hant` — as a final deterministic pass. This works **out of the box with no install**, using built-in character tables (bundled from OpenCC's dictionaries): Traditional→Simplified is near-lossless.

Installing OpenCC upgrades this automatically to **phrase-accurate** conversion, which matters for Simplified→Traditional (it disambiguates one-to-many characters like 面/麵, 发/髮, 里/裡 that a character-level table can't):

```bash
brew install opencc                # macOS
sudo apt install -y opencc         # Linux (Debian/Ubuntu)
winget install BYVoid.OpenCC       # Windows (official package; adds opencc to PATH)
```

(Windows alternative: download a prebuilt `OpenCC-*-windows-x64-portable.zip` from the [OpenCC releases](https://github.com/BYVoid/OpenCC/releases) and add the folder containing `opencc.exe` to your user PATH, then open a new terminal.)

The server auto-detects `opencc` on startup and uses it when present; otherwise it silently falls back to the built-in tables. No configuration needed.
