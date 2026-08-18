# Optional Tools

Hey-Koko works with just Ollama. Each helper below unlocks an extra capability when installed; without it, that feature is simply hidden or falls back to a lighter path.

See also: [Local text-to-speech](local-python.md) · [ComfyUI](comfyui.md) · [Cloud models](cloud-models.md)

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

**Backend.** Hey-Koko runs MinerU's `pipeline` backend (`mineru -b pipeline`), which is dependency-light and works everywhere. MinerU 3.x's own default (`hybrid-engine` / VLM) is higher-accuracy but runs a **vLLM** engine that JIT-compiles CUDA at startup — it needs the Python dev headers (e.g. `sudo apt install python3.12-dev`) and a supported GPU, and fails with `fatal error: Python.h: No such file or directory` when they're missing. To opt into it once that's set up, start Hey-Koko with `MINERU_BACKEND=hybrid-engine` (set `MINERU_BACKEND=""` to let MinerU choose).

## Unlimited-OCR

Local GPU PDF parsing with [baidu/Unlimited-OCR](https://github.com/baidu/Unlimited-OCR) (a DeepSeek-OCR-derived model). An alternative to MinerU — fully local, no vLLM — that's strong on scanned/image PDFs. **Requires an NVIDIA GPU** (CUDA); no Apple-Silicon/CPU path.

Install into its own venv (its Python 3.12 / torch / CUDA stack is separate from MinerU's):

```bash
python3.12 -m venv ~/venv/unlimited-ocr
~/venv/unlimited-ocr/bin/pip install torch torchvision --index-url https://download.pytorch.org/whl/cu130
~/venv/unlimited-ocr/bin/pip install transformers pillow einops addict easydict pymupdf psutil
```

Use the CUDA index (`cu130`, `cu124`, …) that matches your driver; on first parse the `baidu/Unlimited-OCR` weights (~6 GB) download from Hugging Face. Point Hey-Koko at the venv:

```bash
export UNLIMITED_OCR_PYTHON=~/venv/unlimited-ocr/bin/python
```

Hey-Koko auto-detects `~/venv/unlimited-ocr` even without the env var. Once detected, pick **Unlimited-OCR** from the **PDF import** dropdown at the bottom of settings (MinerU is the default; other options are Unlimited-OCR and Fast/text-only). Any engine falls back to the built-in text extractor if it isn't available or fails.

## LibreOffice

Whole-slide **page images** for slide decks imported into the knowledge library. Each slide of a `.pptx` (or slide-style PDF) is rendered to a full-page JPEG stored on that page, so `/ask` can hand a vision model the actual page — charts, diagrams, layout, SmartArt — not just its terse bullet text. Rendering runs automatically for slide imports when a backend is present (no flag to enable); it just adds the page rasters to the document (~200–350 KB per page).

```bash
brew install --cask libreoffice          # macOS
sudo apt install -y libreoffice          # Linux (Debian/Ubuntu)
winget install TheDocumentFoundation.LibreOffice   # Windows
```

**How it works & requirements.** `.pptx` decks are converted to PDF headlessly (`soffice --convert-to pdf`), then each page is rasterized with `pypdfium2` — which ships in [MinerU](#mineru)'s virtual environment, so **MinerU must also be installed** (Hey-Koko auto-derives its Python from the `mineru` launcher; override with `SLIDES_PYTHON=/path/to/python`). Slide-style **PDFs render without LibreOffice** — they go straight through `pypdfium2`. If neither LibreOffice nor MinerU is present, [officecli](#officecli) renders the deck instead (a much smaller install, slightly rougher layout); with none of them, decks still import with their text and figure crops and only the whole-page images are skipped.

Optional tuning: `HEYKOKO_SLIDES_RENDER_SCALE` (default `2.0` — raise for sharper small text at the cost of file size) and `HEYKOKO_SLIDES_RENDER_MAXPAGES` (default `80`).

> **macOS note.** Hey-Koko also has a PowerPoint fallback (driven via AppleScript), but recent PowerPoint builds silently drop the export under the app sandbox, so it usually produces nothing. LibreOffice is the reliable path — install it rather than relying on PowerPoint.

**Why LibreOffice is still preferred over [officecli](#officecli)** (measured on one real 4-slide deck, Apple silicon): LibreOffice reproduces PowerPoint's own layout — autofit titles stay on one line, nested bullets keep their indent levels — and converts a whole deck in a single ~3.7 s call. officecli re-implements layout in its own HTML engine: good enough to feed a vision model, but it drops autofit and list indentation, and costs ~2.6 s **per page**, so a 60-slide deck is minutes rather than seconds. Install LibreOffice when you render decks often; install officecli when 800 MB is too much to pay.

## officecli

Office documents **without Microsoft Office or LibreOffice** — a single ~19 MB binary ([iOfficeAI/OfficeCLI](https://github.com/iOfficeAI/OfficeCLI), Apache-2.0). Hey-Koko uses it for three things:

- **Word page images** — `.docx` pages rendered to whole-page PNGs. There is no other backend for this; without officecli, Word documents have no visual layer at all.
- **Deck page images without the 800 MB download** — the `.pptx` fallback when [LibreOffice](#libreoffice) is not installed.
- **`/doc`** — generating and editing `.docx` / `.xlsx` / `.pptx` from the chat. Generation is the common case: paste or produce a summary, then `/doc new pptx make slides from that` — the guide teaches one operation per slide, using the template's own layouts and placeholders rather than hand-placed text boxes, so the deck comes out looking like a deck. Editing covers text, tables, pictures, charts, comments, and Word headers/footers. `/doc` opens a document (attached, or by path), posts its structure and an authoring guide into the conversation, and from then on plain instructions produce `officecli` blocks you apply with ▶ (the fence is tagged for the tool whose batch schema the JSON is). It always works on a **copy** in `~/.hey-koko/office/`, so the file you pointed at is never modified — and a document open in Word can't clobber the edit.

```bash
brew install officecli                                  # macOS
curl -fsSL https://raw.githubusercontent.com/iOfficeAI/OfficeCLI/main/install.sh | bash   # macOS/Linux
scoop install officecli                                 # Windows
```

Auto-detected on `PATH` and in the usual install locations; override with `OFFICECLI_BIN=/path/to/officecli`. Absent, every officecli-backed feature simply reports itself unavailable — nothing else changes.

**Generated documents** land in `~/.hey-koko/office/`. The HTTP surface is `/api/officecli/status`, `/read`, `/preview`, `/build`, `/merge`, `/open`, `/edit`, `/file/<id>` and `/guide`; `build` takes an officecli batch script, `merge` fills `{{placeholder}}` keys in a template you supply, and `open`/`edit` are what `/doc` drives.

> **Writes are verified, not trusted.** officecli can report `success: true` for a command that changed nothing (its CSV `import` does exactly this — "Imported 3 rows x 3 cols" onto a workbook that ends up with zero cells). Hey-Koko re-reads every document it writes and fails the request with `write_unverified` if it came out empty, deleting the file rather than leaving an empty artifact behind.

> **This is not `/tool @word`.** The `@word` / `@excel` / `@ppt` tools read the **live** state of the running app — the open, possibly unsaved document. officecli only sees files on disk. Keep in mind that if a document is open in Word while officecli edits the same file, Word will overwrite those edits the next time you save.

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

**Members-only videos** are detected when a channel/playlist is expanded (via the channel's auto-generated members playlist) and flagged 🔒 in the import picker, unchecked by default — importing them needs the cookies file above, exported from an account that is a member of that channel.

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
