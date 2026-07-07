// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

// P3 slides visual layer: render each slide page to a whole-page JPEG so /ask can feed a
// vision model the real page (charts, layout, SmartArt), not just the terse text. All
// backends are best-effort (a failure returns [] → the deck keeps its text + crop figures).
//   PDF  → pypdfium2 (server/render_slides.py, run with config.slidesPython — MinerU's venv).
//   pptx → LibreOffice `soffice --convert-to pdf` then the SAME pypdfium2 path (reliable,
//          reused). PowerPoint via AppleScript is a last-resort fallback: on recent macOS
//          builds its sandbox silently drops AppleScript `save`/export (verified: open+read
//          work, but JPG/PDF/copy saves all write nothing), so it usually yields nothing.
// Opt-in behind config.slidesRender. See docs/plans/slides-library.md P3.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile, spawn, execFileSync } = require("child_process");
const config = require("./config");

const renderScript = path.join(__dirname, "render_slides.py");
const POWERPOINT_APP = "/Applications/Microsoft PowerPoint.app";

function findSoffice() {
  const candidates = [
    "/Applications/LibreOffice.app/Contents/MacOS/soffice",
    "/opt/homebrew/bin/soffice", "/usr/local/bin/soffice", "/usr/bin/soffice",
    "/opt/libreoffice/program/soffice",
  ];
  for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch {} }
  try {
    const finder = process.platform === "win32" ? "where" : "which";
    const first = execFileSync(finder, ["soffice"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().split(/\r?\n/)[0];
    if (first) return first;
  } catch {}
  return "";
}

let hasPdfRender = false;
let hasPptxRender = false;
let sofficePath = "";
let hasPowerPoint = false;
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
  // pptx: LibreOffice (reliable, preferred) → PowerPoint (fallback). Both ultimately need
  // the PDF renderer (LibreOffice makes a PDF; PowerPoint would export images directly but
  // usually can't — see header). So pptx render also requires hasPdfRender for the LO path.
  sofficePath = findSoffice();
  hasPowerPoint = process.platform === "darwin" && fs.existsSync(POWERPOINT_APP);
  hasPptxRender = (!!sofficePath && hasPdfRender) || hasPowerPoint;
  if (sofficePath && hasPdfRender) console.log(`[render-slides] pptx page-render available (LibreOffice ${sofficePath} → PDF → pypdfium2)`);
  else if (hasPowerPoint) console.log(`[render-slides] pptx page-render: only PowerPoint found — its AppleScript export is unreliable on recent macOS; install LibreOffice for reliable pptx rendering`);
  else if (config.slidesRender) console.log(`[render-slides] pptx page-render unavailable (no LibreOffice; PowerPoint absent)`);
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

// Convert a pptx buffer to a PDF buffer via LibreOffice headless. Returns null on any
// failure. LibreOffice is NOT sandboxed, so it reads/writes our temp dir freely (unlike
// PowerPoint). --convert-to writes "<basename>.pdf" into --outdir.
function pptxToPdfViaLibreOffice(buf, timeoutMs) {
  return new Promise((resolve) => {
    if (!sofficePath) return resolve(null);
    let tmp;
    try { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pptx2pdf-")); } catch { return resolve(null); }
    const inPath = path.join(tmp, "in.pptx");
    const cleanup = () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} };
    try { fs.writeFileSync(inPath, buf); } catch { cleanup(); return resolve(null); }
    // A dedicated -env:UserInstallation keeps this run from colliding with a real
    // LibreOffice GUI profile (headless conversions can deadlock on a shared profile lock).
    const profile = "file://" + path.join(tmp, "loprofile");
    execFile(sofficePath, [
      "--headless", "--norestore", `-env:UserInstallation=${profile}`,
      "--convert-to", "pdf", "--outdir", tmp, inPath,
    ], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err) => {
      let pdf = null;
      if (!err) { try { pdf = fs.readFileSync(path.join(tmp, "in.pdf")); } catch { pdf = null; } }
      else console.log(`[render-slides] LibreOffice pptx→pdf failed: ${err.message}`);
      cleanup();
      resolve(pdf);
    });
  });
}

// Drive PowerPoint via AppleScript to export slides as JPGs (macOS fallback). On recent
// PowerPoint builds the sandbox silently drops the save (verified: nothing is written),
// so this usually returns [] — LibreOffice is the real backend. Kept as a best-effort
// last resort for setups where it does work. Uses the correct EPPSaveAsFileType enum.
function renderPptxViaPowerPoint(buf, { maxPages, timeoutMs = 300000 } = {}) {
  return new Promise((resolve) => {
    if (!hasPowerPoint) return resolve([]);
    let tmp;
    try { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slides-render-")); } catch { return resolve([]); }
    const inPath = path.join(tmp, "in.pptx");
    const outDir = path.join(tmp, "out");
    const cleanup = () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} };
    try { fs.writeFileSync(inPath, buf); fs.mkdirSync(outDir); } catch { cleanup(); return resolve([]); }
    const script = [
      'on run argv',
      '  tell application "Microsoft PowerPoint"',
      '    open (POSIX file (item 1 of argv))',
      '    save active presentation in (item 2 of argv) as save as JPG',
      '    close active presentation saving no',
      '  end tell',
      'end run',
    ].join("\n");
    execFile("osascript", ["-e", script, inPath, outDir], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err) => {
      let images = [];
      if (!err) { try { images = collectPageImages(outDir, maxPages || config.slidesRenderMaxPages); } catch { images = []; } }
      else console.log(`[render-slides] PowerPoint render failed: ${err.message}`);
      cleanup();
      resolve(images);
    });
  });
}

// Render a pptx buffer → [{page, base64, mime}]. Prefer LibreOffice→PDF→pypdfium2 (reliable);
// fall back to PowerPoint (usually a no-op on recent macOS). [] on any failure.
async function renderPptxPages(buf, opts = {}) {
  if (sofficePath && hasPdfRender) {
    const pdf = await pptxToPdfViaLibreOffice(buf, opts.timeoutMs || 300000);
    if (pdf && pdf.length) {
      const imgs = await renderPdfPages(pdf, opts);
      if (imgs.length) return imgs;
    }
  }
  return renderPptxViaPowerPoint(buf, opts);
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
