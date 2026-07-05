# Plan: Baidu Unlimited-OCR as a PDF-import engine (local GPU)

> Status: **P1 + P2 + P3 IMPLEMENTED 2026-07-05** (server wrapper + engine routing, client
> engine picker, and docs). Syntax-checked + live e2e through `/api/parse-file` for both
> engines; not yet clicked in a real browser. P4 (persistent-server / warm-process) remains
> optional. Author: planning session 2026-07-05.
>
> ## What shipped in P3 (docs)
>
> - **`docs/optional-tools.md`** — new **Unlimited-OCR** section (own venv, cu-index torch,
>   `UNLIMITED_OCR_PYTHON`, NVIDIA-only, PDF-import dropdown); MinerU section gained a
>   **Backend** note (pipeline default vs vLLM/`hybrid-engine` needing `python3-dev`, the
>   `MINERU_BACKEND` env var).
> - **`README.md`** — File-understanding bullet now mentions the selectable local PDF
>   engines with links.
> - **`CHANGELOG.md`** — Unreleased entry for the PDF engine picker + `MINERU_BACKEND`.
>
> ## What shipped in P2 (client)
>
> - **`public/index.html`** — a "PDF import" `<select id="pdfEngineSelect">` at the **bottom**
>   of the settings panel: options **MinerU (default)** / Unlimited-OCR / Fast (text only)
>   (no "Auto" — MinerU is the default per user request). MinerU + Unlimited-OCR options and
>   the whole control are `hidden` until capabilities say they exist; an unavailable
>   selection falls back to the first available option.
> - **`public/js/state.js`** — dom refs for the select/label/options.
> - **`public/js/settings.js`** — persist/restore `pdfEngine` (default `"auto"`) in the
>   settings object.
> - **`public/js/main.js`** — `serverCapabilities` gains `unlimitedOcr`; `syncPdfEngineOptions()`
>   un-hides options per capability (and resets a stale pref to auto); `pickPdfEngine(pref,caps)`
>   + `currentPdfEngine()` resolve the choice (auto → mineru→unlimited→pdfjs); `tryServerParse`
>   sends `x-pdf-engine`; both `parseAndSendFile` and `parseDocumentHeadless` (background
>   `docfull` jobs) route PDFs through the picked engine, falling back to pdf.js.
> - **`public/js/i18n.js`** — `label_pdfEngine` + `pdfEngine_auto`/`pdfEngine_pdfjs` ×3 langs
>   (MinerU / Unlimited-OCR are brand names, left as-is).
> - **Verified:** served HTML carries the picker; capabilities un-hide both engines; the
>   engine→`x-pdf-engine`→server routing was proven end-to-end in P1 for `mineru` (default)
>   and `unlimited`. Not yet clicked in a real browser (no headless-browser stack shipped).
>
> ## What shipped in P1 (server)
>
> - **Install (done, on the DGX Spark):** `~/venv/unlimited-ocr` (torch 2.10 cu130), model
>   weights in the HF cache (~6.3 G), repo at `~/App/Unlimited-OCR`. See the
>   `unlimited-ocr-setup` memory. Smoke-tested: ~108 s model load, ~14 s/page.
> - **`server/unlimited_ocr.py`** (new) — MinerU-shaped CLI (`-p in.pdf -o outDir`):
>   PyMuPDF rasterize at 300 DPI (prints `rendering page i/N`), load model, `infer`
>   (1 page, gundam) or `infer_multi` (multi, base), heartbeat `parsing N page(s)… Ns`
>   while the single-pass generate runs (model's own token/TPS stdout muted). Post-
>   processes `result.md`: turns the model's `<PAGE>` markers into `---` rules. Leaves
>   `result.md` + `images/` — same shape MinerU produces.
> - **`server/config.js`** — `resolveOcrPython()` → `config.ocrPython` (env
>   `UNLIMITED_OCR_PYTHON` or `~/venv/unlimited-ocr`; `""` when absent). Also added
>   `config.mineruBackend` (`MINERU_BACKEND` env, default `"pipeline"`) — MinerU 3.x was
>   installed too (`~/venv/mineru`, symlinked to PATH); its default VLM/hybrid backend
>   needs vLLM+`python3.12-dev` which isn't present, so `parse-file.js` passes
>   `-b pipeline`. See the `mineru-setup` memory.
> - **`server/parse-file.js`** — `hasUnlimitedOcr` detection (cheap file check, no torch
>   import at startup); `getCapabilities` now reports `unlimitedOcr`. Refactored `parsePdf`
>   into a shared `runPdfTool({cmd,args,tool,label,outputDir,res,timeoutMs})` core +
>   extracted `collectMarkdownOutput(mdFile)`; added `parseUnlimitedOcr`. `parseFile` routes
>   `.pdf` by the `x-pdf-engine` header (`unlimited` → Unlimited-OCR, default → MinerU).
> - **Verified:** `GET /api/parse-file/capabilities` → `unlimitedOcr:true`; the client-side
>   selection UI (P2) is what remains to actually send `x-pdf-engine`.
>
> ---
>
> Original v2 plan below (design of record).
>
> ## ⚠️ v1 was wrong — corrected
>
> v1 of this plan assumed "baidu unlimited ocr" meant a **cloud API** (Baidu AI Cloud
> `general_basic`). **That was wrong.** The user pointed at the actual project:
> **https://github.com/baidu/Unlimited-OCR** — a **local, NVIDIA-GPU** open-source OCR
> model (an extension of DeepSeek-OCR), run entirely on-device. So:
>
> - **No cloud, no API key, no rate limit, no privacy trade-off.** Pages never leave the
>   machine — fully consistent with Hey-Koko's local-first ethos.
> - It is **a sibling of MinerU**, not a new category: both are "local model turns a PDF
>   into Markdown." The integration should mirror the existing MinerU path closely.
> - Everything in v1 about tokens / QPS / `~/.hey-koko/baidu-ocr.json` / ☁️ cloud badge /
>   client-side rasterization-to-cloud is **deleted**.
>
> The user (per session memory) runs Hey-Koko on a **DGX Spark** — an NVIDIA GPU box — so
> a local GPU OCR engine is viable here.

## 1. What Unlimited-OCR actually is

- **Repo/model:** `baidu/Unlimited-OCR` (Hugging Face Hub), Apache-ish open weights.
  "One-shot long-horizon document parsing," extends DeepSeek-OCR.
- **Runtime:** Python **3.12.3**, `torch==2.10.0`, `transformers==4.57.1`, `pymupdf==1.27.2.2`,
  torchvision/Pillow/einops/addict/easydict. **NVIDIA GPU, CUDA 12.9+.**
- **Three ways to run:**
  1. **Transformers (native PyTorch)** — load the model in-process, call `model.infer(...)`
     (single image) or `model.infer_multi(...)` (multi-page/PDF). PDF→images via PyMuPDF
     at 300 DPI (`pdf_to_images(pdf, dpi=300)`).
  2. **vLLM** — Docker image `vllm/vllm-openai:unlimited-ocr[-cu129]`, OpenAI-compatible
     server.
  3. **SGLang** — `python -m sglang.launch_server --model baidu/Unlimited-OCR
     --served-model-name Unlimited-OCR --port 10000 …`, persistent OpenAI-compatible
     server; `infer.py --pdf … --output_dir … --concurrency 8 --image_mode gundam` is the
     batch client that talks to it.
- **Prompts:** `'<image>document parsing.'` (single), `'<image>Multi page parsing.'` (multi).
- **Output:** parsed text/Markdown written to an output dir (`save_results=True`); modes
  `gundam` (tiled, higher quality) / `base`.

## 2. Current PDF flow (unchanged parts we build on)

`server/parse-file.js` → `parsePdf` is the template:
- spawn a local tool (`mineru -p input.pdf -o outputDir`),
- stream stdout/stderr progress lines to the client as **ndjson** (`{progress}`),
- **detached** process-group so a canceled/timed-out import kills the whole tree,
- on exit, `findFile(outputDir, ".md")`, read it, collect `images/`, dedup + rename to
  `image_NN.ext`, base64-inline, normalize `![](…)` refs, emit `{text, images, tool}`.

`public/js/main.js`:
- `serverCapabilities = { pandoc, mineru }` from `GET /api/parse-file/capabilities`.
- `parseAndSendFile` (foreground) and `parseDocumentHeadless` (background `docfull` jobs)
  share the same `canServer = ext===".pdf" && serverCapabilities.mineru` decision, then
  `tryServerParse` (streams ndjson) or the `extractPdfText` (pdf.js) fallback.

`server/config.js`: `resolveVenvPython(envVar)` already resolves a venv interpreter from
an env var or `~/venv/{heykoko,tts}`; `ttsPython`/`umapPython` use it. `server/` already
ships Python helper scripts (`tts_engine.py`, `umap_project.py`) spawned by Node.

## 3. Chosen design — a MinerU-shaped local wrapper (Recommended)

Add Unlimited-OCR as a **near drop-in sibling of MinerU**: a small Python wrapper we
ship, spawned per-PDF, that does PDF→images→`infer_multi`→Markdown+images into an output
dir. Hey-Koko then reuses MinerU's exact output-reading logic.

**Why this shape over the server/HTTP shapes:**
- Reuses the whole `parsePdf` spawn→stream→read-output machinery (minimal new code).
- Correct preprocessing (gundam tiling, 300 DPI, the right prompts) is handled by the
  model's own `infer_multi` — **zero re-implementation**, no fidelity risk.
- Simplest install: one dedicated venv + one wrapper script. **No persistent server to
  launch/babysit**, matching the "spawn a local tool per file" pattern already used for
  MinerU/pandoc.
- Fully local; the raw PDF path is passed straight in (`-p input.pdf`) — **no client-side
  rasterization needed**.

**Cost / the one real downside:** native Transformers reloads the model each spawn (tens
of seconds of GPU warm-up per import). Acceptable for occasional imports; §7 lists the
persistent-server upgrade for heavy use.

### 3a. `server/unlimited_ocr.py` (new wrapper script)

CLI mirroring MinerU: `python unlimited_ocr.py -p <input.pdf> -o <outputDir>
[--mode gundam|base] [--dpi 300] [--model baidu/Unlimited-OCR]`.

- Load tokenizer + model (`trust_remote_code=True`, `torch.bfloat16`, `.cuda().eval()`).
- `pdf_to_images(pdf, dpi)` (PyMuPDF) → per-page PNGs in a temp dir.
- `model.infer_multi(tokenizer, prompt='<image>Multi page parsing.', image_files=[…],
  output_path=outputDir, image_size=1024, max_length=32768, no_repeat_ngram_size=35,
  ngram_window=1024, save_results=True)`. (Single-page PDFs may use `infer` + `gundam` for
  higher quality — decide during impl by testing both.)
- **Print progress to stdout** in a MinerU-compatible shape so the existing
  `isProgressLine` filter forwards it: e.g. `page 3/12` / `NN%`. This is why the wrapper
  drives pages itself (loop + print) rather than a single opaque call where feasible.
- Write a `.md` (+ an `images/` subdir if the model emits figures) into `outputDir`, so
  Hey-Koko's existing collector finds it unchanged.
- Nonzero exit + stderr on failure (so the `code !== 0` branch reports it).

### 3b. `server/parse-file.js`

- **Detection** (mirror `detectTools`): resolve an **Unlimited-OCR venv python** via a new
  `config.ocrPython = resolveVenvPython("UNLIMITED_OCR_PYTHON")` (its own venv — the OCR
  stack is Python 3.12 / torch 2.10 / CUDA 12.9, incompatible with the 3.11 `~/venv/heykoko`
  TTS venv, so **do not share**). Capability is on when: the env/venv python resolves **and**
  a cheap probe passes. Probe options (pick the least slow): `python -c "import torch, transformers"`
  with a timeout, or trust an explicit `UNLIMITED_OCR_PYTHON` being set + wrapper present.
  Set `hasUnlimitedOcr` + report it in `getCapabilities` as `unlimitedOcr`.
- **`parseUnlimitedOcr(inputPath, outputDir, res, timeoutMs)`** — a thin variant of
  `parsePdf`: same ndjson headers, same detached spawn + `killTree` + `res.on("close")`
  cancel + timeout, spawning `config.ocrPython [wrapperPath, "-p", inputPath, "-o", outputDir]`.
  **Factor the shared post-processing** (find `.md`, collect/dedup/rename images, normalize
  refs, emit `{text, images, tool}`) out of `parsePdf` into `collectMarkdownOutput(outputDir, tool)`
  so both MinerU and Unlimited-OCR call it. Emits `tool:"unlimited-ocr"`.
- **`parseFile` routing:** for `.pdf`, choose MinerU vs Unlimited-OCR based on an engine
  hint from the client (a request header, e.g. `x-pdf-engine: mineru|unlimited`, alongside
  the existing `x-parse-timeout-s`). Default when absent = MinerU (today's behavior).

## 4. Client changes (`public/js/main.js` + settings)

- `serverCapabilities` gains `unlimitedOcr` (extend `fetchCapabilities`).
- **`pdfEngine` preference** — `auto | mineru | unlimited | pdfjs`, persisted in the
  settings object (`public/js/settings.js` `saveCurrentSettings`, next to `requestTimeout`),
  default `"auto"`. A small `<select>` in the settings panel near the request-timeout
  control; the `unlimited` option is disabled/hidden unless `serverCapabilities.unlimitedOcr`.
- **`pickPdfEngine(pref, caps)`** shared by `parseAndSendFile` **and**
  `parseDocumentHeadless` (so the background `docfull` queue inherits it with no bg-jobs.js
  change):
  ```
  auto      → mineru if caps.mineru; else unlimited if caps.unlimitedOcr; else pdfjs
  mineru    → mineru if caps.mineru; else pdfjs
  unlimited → unlimited if caps.unlimitedOcr; else pdfjs
  pdfjs     → pdfjs
  ```
- `tryServerParse` sends the chosen engine as the `x-pdf-engine` header. Both `mineru` and
  `unlimited` use the **same** `/api/parse-file` streaming path — only the header differs
  and the returned `tool` string distinguishes them in the UI. `extractPdfText` stays the
  pure-client fallback. (No new client route, no client rasterization.)

## 5. Docs

- **`docs/optional-tools.md`** — new section **"Unlimited-OCR (local GPU PDF parsing)"**
  paralleling the MinerU section: create a dedicated Python 3.12 venv, `pip install` the
  pinned deps (torch 2.10 / transformers 4.57 / pymupdf / …), first-run downloads the
  `baidu/Unlimited-OCR` weights from HF, point Hey-Koko at it with
  `UNLIMITED_OCR_PYTHON=/path/to/venv/bin/python`. State the **NVIDIA GPU + CUDA 12.9**
  requirement plainly, and note it's an alternative to MinerU (compare: both local
  Markdown; try both on your PDFs). Add a DGX Spark note (ARM64 + Blackwell — use the
  CUDA-13 wheels / `vllm/vllm-openai:unlimited-ocr` if the native install fights the
  platform).
- **README.md** — extend the "File understanding" bullet: selectable local PDF engines
  (MinerU / Unlimited-OCR / pdf.js).

## 6. i18n (`public/js/i18n.js`, ×3 en/zh/zh-Hant)

Engine `<select>` label + options, and any Unlimited-OCR-specific error/progress strings.
Follow the existing tri-lingual key pattern.

## 7. Alternatives considered / deferred

- **Persistent SGLang/vLLM server + HTTP client** (fastest; model stays warm; matches the
  Ollama/ComfyUI "talk to a local service" pattern; could reuse `server/openai.js` since
  the endpoint is OpenAI-compatible). Deferred because **Hey-Koko would then own the
  PDF→image tiling / gundam preprocessing** that `infer.py` does, risking output-quality
  drift, and it burdens the user with keeping a server up. **This is the natural upgrade
  path** if per-import model reload proves too slow: add `UNLIMITED_OCR_URL` (default
  `http://127.0.0.1:10000/v1`), detect via `/v1/models`, relay page images. Could coexist
  as a second engine value (`unlimited-server`).
- **Spawn the repo's own `infer.py`** (instead of our wrapper) — guarantees identical
  preprocessing but requires the user to clone the repo *and* run an SGLang server, i.e.
  the worst of both setups. Our wrapper (§3a) needs only a venv.
- **Keep the model warm across imports** (a long-lived wrapper subprocess Hey-Koko pipes
  PDFs to) — a middle ground that removes reload cost without a full server; a possible
  follow-up if §3's per-spawn cost bites.

## 8. Phasing & verification

- **P1 — wrapper + server:** `server/unlimited_ocr.py`; `config.ocrPython`; detection +
  `parseUnlimitedOcr` + `collectMarkdownOutput` refactor + `x-pdf-engine` routing in
  `parse-file.js`. `node -c` touched JS; `python -c "import ast"`/py-compile the wrapper.
- **P2 — client:** `unlimitedOcr` capability, `pdfEngine` preference + settings `<select>`,
  `pickPdfEngine`, `x-pdf-engine` header. Background `docfull` inherits via the shared core.
- **P3 — polish:** i18n ×3; docs (`optional-tools.md`, `README.md`).
- **P4 (optional):** persistent-server engine (`UNLIMITED_OCR_URL`) and/or warm-process
  mode per §7.
- **Live e2e (on the DGX Spark):** install the OCR venv; import a **scanned** PDF with
  `pdfEngine=unlimited` → assert page-by-page progress streams and non-empty Markdown
  returns; compare the same PDF via MinerU; with the venv **absent**, assert the option is
  hidden and `auto` behaves exactly as today; cancel mid-parse → assert the GPU process
  tree is killed (no orphaned torch worker).

## 9. Files touched (summary)

- **New:** `server/unlimited_ocr.py`, `docs/plans/baidu-ocr.md` (this file).
- **Edit:** `server/parse-file.js` (detect + `parseUnlimitedOcr` + `collectMarkdownOutput`
  refactor + engine routing), `server/config.js` (`ocrPython`), `public/js/main.js`
  (capability + `pickPdfEngine` + `x-pdf-engine` header), `public/js/settings.js`
  (`pdfEngine` persist), `public/index.html` (engine `<select>`), `public/js/i18n.js` (×3),
  `docs/optional-tools.md`, `README.md`.
- **Unchanged by design:** `public/js/bg-jobs.js` (inherits via the shared headless core).
