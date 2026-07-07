// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

// P3 slides visual layer: render each slide page to a whole-page JPEG so /ask can feed a
// vision model the real page (charts, layout, SmartArt), not just the terse text. Two
// backends, both best-effort (a failure returns [] → the deck keeps its text + crop
// figures): PDFs via pypdfium2 (server/render_slides.py, run with config.slidesPython —
// MinerU's venv); pptx via PowerPoint driven by AppleScript (macOS). Opt-in behind
// config.slidesRender. See docs/plans/slides-library.md P3.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile, spawn } = require("child_process");
const config = require("./config");

const renderScript = path.join(__dirname, "render_slides.py");
const POWERPOINT_APP = "/Applications/Microsoft PowerPoint.app";

let hasPdfRender = false;
let hasPptxRender = false;
let detectDone = false;

(async function detect() {
  // PDF: the configured python must import pypdfium2 + PIL (both in MinerU's venv).
  if (config.slidesPython && fs.existsSync(renderScript)) {
    try {
      await new Promise((resolve, reject) => {
        const proc = spawn(config.slidesPython, ["-c", "import pypdfium2, PIL"], { stdio: "ignore" });
        const timer = setTimeout(() => { proc.kill(); reject(new Error("timeout")); }, 15000);
        proc.on("close", (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`exit ${code}`)); });
        proc.on("error", reject);
      });
      hasPdfRender = true;
      console.log(`[render-slides] PDF page-render available (python ${config.slidesPython})`);
    } catch (err) {
      console.log(`[render-slides] PDF page-render unavailable (${err && err.message}); pypdfium2/PIL not importable`);
    }
  }
  // pptx: PowerPoint app present (macOS only; AppleScript-driven).
  hasPptxRender = process.platform === "darwin" && fs.existsSync(POWERPOINT_APP);
  if (hasPptxRender) console.log(`[render-slides] pptx page-render available (Microsoft PowerPoint)`);
  detectDone = true;
})();

// Is page-rendering possible for this file type right now? (config.slidesRender gates
// whether the caller even asks.)
function canRender(ext) {
  const e = String(ext || "").toLowerCase();
  if (e === ".pdf") return hasPdfRender;
  if (e === ".pptx") return hasPptxRender;
  return false;
}

const IMG_EXTS = new Set([".jpg", ".jpeg", ".png"]);
// Read every image the backend wrote, in page order (numeric suffix), as base64.
function collectPageImages(dir, maxPages) {
  const found = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (IMG_EXTS.has(path.extname(entry.name).toLowerCase())) found.push(full);
    }
  };
  walk(dir);
  // Sort by the trailing number in the filename (page_1 / Slide2 / …), then name.
  const numOf = (p) => { const m = path.basename(p).match(/(\d+)(?=\.[a-z]+$)/i); return m ? parseInt(m[1], 10) : 1e9; };
  found.sort((a, b) => (numOf(a) - numOf(b)) || a.localeCompare(b));
  const out = [];
  found.slice(0, maxPages).forEach((f, i) => {
    try {
      const data = fs.readFileSync(f);
      const ext = path.extname(f).toLowerCase();
      out.push({ page: i + 1, base64: data.toString("base64"), mime: ext === ".png" ? "image/png" : "image/jpeg" });
    } catch { /* skip unreadable */ }
  });
  return out;
}

// Render a PDF buffer → [{page, base64, mime}] via pypdfium2. [] on any failure.
function renderPdfPages(buf, { scale, quality, maxPages, timeoutMs = 300000 } = {}) {
  return new Promise((resolve) => {
    if (!hasPdfRender) return resolve([]);
    let tmp;
    try { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slides-render-")); } catch { return resolve([]); }
    const inPath = path.join(tmp, "in.pdf");
    const outDir = path.join(tmp, "out");
    const cleanup = () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} };
    try { fs.writeFileSync(inPath, buf); fs.mkdirSync(outDir); } catch { cleanup(); return resolve([]); }
    execFile(config.slidesPython, [
      renderScript, "-p", inPath, "-o", outDir,
      "--scale", String(scale || config.slidesRenderScale),
      "--quality", "80",
      "--maxpages", String(maxPages || config.slidesRenderMaxPages),
    ], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err) => {
      let images = [];
      if (!err) { try { images = collectPageImages(outDir, maxPages || config.slidesRenderMaxPages); } catch { images = []; } }
      else console.log(`[render-slides] pdf render failed: ${err.message}`);
      cleanup();
      resolve(images);
    });
  });
}

// Render a pptx buffer → [{page, base64, mime}] by driving PowerPoint (AppleScript
// "save as JPG" exports one image per slide into a folder). [] on any failure — the
// first run also triggers a one-time macOS Automation permission prompt.
function renderPptxPages(buf, { maxPages, timeoutMs = 300000 } = {}) {
  return new Promise((resolve) => {
    if (!hasPptxRender) return resolve([]);
    let tmp;
    try { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slides-render-")); } catch { return resolve([]); }
    const inPath = path.join(tmp, "in.pptx");
    const outDir = path.join(tmp, "out");
    const cleanup = () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} };
    try { fs.writeFileSync(inPath, buf); fs.mkdirSync(outDir); } catch { cleanup(); return resolve([]); }
    // Export every slide as JPG into outDir, then quit the doc without saving. PowerPoint
    // versions differ on output naming/subfoldering — collectPageImages walks recursively
    // and orders by the trailing slide number, so we don't depend on the exact layout.
    const script = [
      'on run argv',
      '  set inPath to item 1 of argv',
      '  set outPath to item 2 of argv',
      '  tell application "Microsoft PowerPoint"',
      '    set pres to open inPath',
      '    save pres in outPath as save as JPG file format',
      '    close pres saving no',
      '  end tell',
      'end run',
    ].join("\n");
    execFile("osascript", ["-e", script, inPath, outDir], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err) => {
      let images = [];
      if (!err) { try { images = collectPageImages(outDir, maxPages || config.slidesRenderMaxPages); } catch { images = []; } }
      else console.log(`[render-slides] pptx render failed: ${err.message}`);
      cleanup();
      resolve(images);
    });
  });
}

// Dispatch by extension. Returns [] (never throws) when rendering is off, unavailable,
// or fails — the caller treats page images as a best-effort enrichment.
async function renderPages(buf, ext, opts = {}) {
  if (!config.slidesRender || !buf || !buf.length) return [];
  const e = String(ext || "").toLowerCase();
  if (e === ".pdf") return renderPdfPages(buf, opts);
  if (e === ".pptx") return renderPptxPages(buf, opts);
  return [];
}

module.exports = { renderPages, canRender, renderPdfPages, renderPptxPages };
