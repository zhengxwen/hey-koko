# Changelog

## Unreleased

### Added
- Selectable local PDF import engine (settings → **PDF import**): MinerU (default), Baidu [Unlimited-OCR](docs/optional-tools.md#unlimited-ocr) (local GPU, strong on scans), or fast built-in text extraction. See [Optional Tools](docs/optional-tools.md).
- `MINERU_BACKEND` env var to choose MinerU's backend (defaults to the dependency-light `pipeline`).

## v0.9.0 (2026-06-11)

### Added
- Full trilingual UI support (English, 简体中文, 繁體中文)
- Language selectors for UI language and prompt language
- Prompt language controls greeting messages and system prompts independently
- UI language change automatically syncs prompt language selection
- Trilingual personality presets
- Trilingual image generation and URL fetch prompts on the server
- Greeting message now follows prompt language instead of UI language
- Settings panel restructured into three tabs: Basic, Model, Extra Options
