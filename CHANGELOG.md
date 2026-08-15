# Changelog

## Unreleased

### Added
- Offline UI libraries: the six third-party frontend libraries (KaTeX, Mermaid, highlight.js, pdf.js, mammoth.js, JSZip) are now pinned to exact versions with sha256 checksums in `server/vendor-manifest.json`. `start.sh`/`start.bat`/`build-app.sh` download them once (~7 MB) into `public/vendor/` via `scripts/fetch-vendor.js`, after which the app runs fully offline; if not downloaded (`HEYKOKO_NO_VENDOR=1` or no network at install time), the server transparently proxies them from the pinned CDN URLs with checksum verification. No third-party code is committed to the repository.
- Selectable local PDF import engine (settings → **PDF import**): MinerU (default), Baidu [Unlimited-OCR](docs/optional-tools.md#unlimited-ocr) (local GPU, strong on scans), or fast built-in text extraction. See [Optional Tools](docs/optional-tools.md).
- `MINERU_BACKEND` env var to choose MinerU's backend (defaults to the dependency-light `pipeline`).

## v0.1.0 (2026-06-11)

### Added
- Full trilingual UI support (English, 简体中文, 繁體中文)
- Language selectors for UI language and prompt language
- Prompt language controls greeting messages and system prompts independently
- UI language change automatically syncs prompt language selection
- Trilingual personality presets
- Trilingual image generation and URL fetch prompts on the server
- Greeting message now follows prompt language instead of UI language
- Settings panel restructured into three tabs: Basic, Model, Extra Options
