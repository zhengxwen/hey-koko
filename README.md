# Hey-Koko

A lightweight, privacy-first AI companion that runs entirely on your machine. Powered by [Ollama](https://ollama.com), no cloud required.

Hey-Koko gives you a personal AI chat experience without sending a single byte to the cloud. It connects to your local Ollama instance, supports file uploads (PDF, Word, PowerPoint, images), web page summarization, YouTube transcription, image generation, and text-to-speech — all through a clean browser UI with zero build steps. Customize your companion's name, personality, and voice to make it truly yours.


## Features

- **Local & Private** — All conversations stay on your device. No data leaves your machine.
- **Customizable Personality** — Adjust the system prompt to make your companion warm, witty, calm, or analytical.
- **File Understanding** — Upload PDFs, DOCX, PPTX, EML, images, and plain text directly into the chat.
- **Image Generation** — Generate images using local Ollama image models.
- **Web & YouTube** — Fetch and summarize web pages or YouTube videos with `/url`.
- **Speech** — Text-to-speech output using macOS system voices.
- **Rich Markdown** — LaTeX math (KaTeX), Mermaid diagrams, and syntax-highlighted code blocks.
- **Conversation Archive** — Save and revisit past conversations.
- **Multi-model** — Switch between any Ollama model on the fly.


## Quick Start

1. Install and launch [Ollama](https://ollama.com).
2. Pull a model:

   ```bash
   ollama pull gemma4:12b-it-qat
   ```

3. Start the server:

   ```bash
   node server.js
   ```

   Or double-click `start.command` on macOS.

4. Open your browser at:

   ```
   http://127.0.0.1:1314
   ```


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


## Environment Variables

```bash
OLLAMA_URL=http://127.0.0.1:11434 PORT=1314 node server.js
```

| Variable | Default | Description |
|----------|---------|-------------|
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Ollama API endpoint |
| `PORT` | `1314` | Server port |
| `WHISPER_MODEL` | auto-detect | Path to whisper.cpp model file |


## Tech Stack

- **Backend**: Node.js (zero dependencies, pure `http` module)
- **Frontend**: Vanilla HTML/CSS/JS (no build step)
- **AI Engine**: Ollama (local LLM inference)
- **CDN Libraries**: KaTeX, Mermaid, highlight.js, pdf.js, mammoth.js, JSZip


## License

GPL-3.0
