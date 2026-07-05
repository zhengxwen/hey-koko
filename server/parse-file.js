// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile, execFileSync, spawn } = require("child_process");
const { sendJson } = require("./utils");
const config = require("./config");

// Detect tool availability (async, non-blocking)
let hasPandoc = false;
let hasMinerU = false;
let hasUnlimitedOcr = false;
let detectDone = false;
let pandocPath = "pandoc";
let mineruPath = "mineru";
// Baidu Unlimited-OCR: a local GPU PDF→markdown engine, spawned like MinerU via a
// thin Python wrapper we ship. Available when its venv python (config.ocrPython) and
// the wrapper both exist — a cheap file check, no slow torch import at startup.
const unlimitedOcrScript = path.join(__dirname, "unlimited_ocr.py");

// Find executable in PATH or common locations
function findExecutable(name) {
  const commonPaths = [
    `/opt/homebrew/bin/${name}`,
    `/usr/local/bin/${name}`,
    `/usr/bin/${name}`,
    `/bin/${name}`,
  ];

  for (const fullPath of commonPaths) {
    try {
      fs.accessSync(fullPath, fs.constants.X_OK);
      return fullPath;
    } catch {}
  }

  // Try the platform's command locator: `where` on Windows, `which` elsewhere.
  try {
    const finder = process.platform === "win32" ? "where" : "which";
    const result = execFileSync(finder, [name], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const first = result.trim().split(/\r?\n/)[0].trim();
    if (first) return first;
  } catch {}

  return name; // fallback to just the name (resolved via PATH at spawn time)
}

(async function detectTools() {
  try {
    pandocPath = findExecutable("pandoc");
    execFileSync(pandocPath, ["--version"], { stdio: "ignore", timeout: 5000 });
    hasPandoc = true;
    console.log(`[parse-file] pandoc detected at ${pandocPath}`);
  } catch (err) {
    console.log(`[parse-file] pandoc not found (${err.message}), DOCX will use client-side fallback`);
  }

  // Check mineru asynchronously to avoid blocking server startup
  try {
    mineruPath = findExecutable("mineru");
    await new Promise((resolve, reject) => {
      const proc = spawn(mineruPath, ["--version"], { stdio: "ignore" });
      const timer = setTimeout(() => { proc.kill(); reject(new Error("timeout")); }, 15000);
      proc.on("close", (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`exit code ${code}`)); });
      proc.on("error", (err) => { clearTimeout(timer); reject(err || new Error("spawn failed")); });
    });
    hasMinerU = true;
    console.log(`[parse-file] MinerU detected at ${mineruPath}`);
  } catch (err) {
    console.log(`[parse-file] MinerU not found (${err && err.message ? err.message : err}), PDF will use client-side fallback`);
  }

  try {
    if (config.ocrPython && fs.existsSync(config.ocrPython) && fs.existsSync(unlimitedOcrScript)) {
      hasUnlimitedOcr = true;
      console.log(`[parse-file] Unlimited-OCR available (python ${config.ocrPython})`);
    } else {
      console.log(`[parse-file] Unlimited-OCR not configured (set UNLIMITED_OCR_PYTHON or install ~/venv/unlimited-ocr)`);
    }
  } catch { /* leave hasUnlimitedOcr false */ }

  detectDone = true;
})();

function getCapabilities(res) {
  sendJson(res, 200, { pandoc: hasPandoc, mineru: hasMinerU, unlimitedOcr: hasUnlimitedOcr, ready: detectDone });
}

// Parse multipart form data (simple single-file parser)
function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const contentType = req.headers["content-type"] || "";
    const boundaryMatch = contentType.match(/boundary=(.+)/);
    if (!boundaryMatch) return reject(new Error("No boundary in content-type"));

    const boundary = boundaryMatch[1];
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const buffer = Buffer.concat(chunks);
      const boundaryBuf = Buffer.from(`--${boundary}`);

      // Find first file part
      let start = buffer.indexOf(boundaryBuf) + boundaryBuf.length;
      let end = buffer.indexOf(boundaryBuf, start);
      if (end === -1) end = buffer.length;

      const part = buffer.slice(start, end);
      // Find headers end (double CRLF)
      const headerEnd = part.indexOf("\r\n\r\n");
      if (headerEnd === -1) return reject(new Error("Malformed multipart"));

      const headers = part.slice(0, headerEnd).toString();
      const fileData = part.slice(headerEnd + 4, part.length - 2); // trim trailing \r\n

      // Extract filename
      const filenameMatch = headers.match(/filename="([^"]+)"/);
      const filename = filenameMatch ? filenameMatch[1] : "upload";

      resolve({ filename, data: fileData });
    });
    req.on("error", reject);
  });
}

async function parseFile(req, res) {
  let tmpDir = null;
  try {
    const { filename, data } = await parseMultipart(req);
    // basename only — a crafted multipart filename ("../../x.pdf") must not escape tmpDir
    const safeName = path.basename(String(filename).replace(/\\/g, "/")) || "upload";
    const ext = path.extname(safeName).toLowerCase();

    if (ext !== ".pdf" && ext !== ".docx" && ext !== ".pptx") {
      sendJson(res, 400, { error: "Server parsing only supports .pdf, .docx and .pptx" });
      return;
    }

    // Create temp directory
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "parse-file-"));
    const inputPath = path.join(tmpDir, safeName);
    fs.writeFileSync(inputPath, data);

    if (ext === ".docx" || ext === ".pptx") {
      await parseDocx(inputPath, tmpDir, res);
    } else if (ext === ".pdf") {
      // The kill timer follows the caller's ⚙ timeout (x-parse-timeout-s, seconds),
      // floored at 5 min — the chat slider bottoms out at 60s, which would kill any
      // real PDF; long/OCR-heavy papers (and Unlimited-OCR's ~2 min model load) need
      // the headroom.
      const timeoutMs = Math.max(parseInt(req.headers["x-parse-timeout-s"], 10) || 0, 300) * 1000;
      // Engine chosen client-side (x-pdf-engine); default MinerU preserves prior behavior.
      const engine = String(req.headers["x-pdf-engine"] || "mineru").toLowerCase();
      if (engine === "unlimited") {
        await parseUnlimitedOcr(inputPath, tmpDir, res, timeoutMs);
      } else {
        await parsePdf(inputPath, tmpDir, res, timeoutMs);
      }
    }
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  } finally {
    // Cleanup temp dir
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  }
}

function parseDocx(inputPath, tmpDir, res) {
  return new Promise((resolve) => {
    if (!hasPandoc) {
      sendJson(res, 501, { error: "pandoc_unavailable", fallback: true });
      resolve();
      return;
    }

    const mediaDir = path.join(tmpDir, "media");
    execFile(pandocPath, [inputPath, "-t", "markdown", "--wrap=none", `--extract-media=${tmpDir}`], {
      maxBuffer: 50 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        sendJson(res, 500, { error: `pandoc error: ${stderr || error.message}` });
        resolve();
        return;
      }

      let markdown = stdout;
      const images = [];
      const seenHashes = new Map();
      let imageCounter = 0;

      // Find and replace image references with placeholders
      if (fs.existsSync(mediaDir)) {
        const imageFiles = collectImageFiles(mediaDir);
        for (const imgPath of imageFiles) {
          const imgData = fs.readFileSync(imgPath);
          const hashKey = imgData.length + ":" + imgData.slice(0, 64).toString("hex");

          let name;
          if (seenHashes.has(hashKey)) {
            name = seenHashes.get(hashKey);
          } else {
            imageCounter++;
            const imgExt = path.extname(imgPath).toLowerCase();
            name = `image_${String(imageCounter).padStart(2, "0")}${imgExt}`;
            seenHashes.set(hashKey, name);
            const mime = imgExt === ".png" ? "image/png" : imgExt === ".gif" ? "image/gif" : "image/jpeg";
            images.push({ name, base64: imgData.toString("base64"), mime });
          }

          // Replace the image path in markdown with new name
          const relativePath = path.relative(tmpDir, imgPath).replace(/\\/g, "/");
          markdown = markdown.split(relativePath).join(name);
        }
      }

      // Normalize image markdown to ![](image_XX.ext)
      markdown = markdown.replace(/!\[[^\]]*\]\(([^)]*image_\d+[^)]*)\)/g, (_, src) => {
        const match = src.match(/image_\d+\.[a-z]+/i);
        return match ? `![](${match[0]})` : `![](${src})`;
      });

      sendJson(res, 200, { text: markdown, images, tool: "pandoc" });
      resolve();
    });
  });
}

// PDF → Markdown via a local, GPU-backed model spawned as a subprocess. MinerU and
// Unlimited-OCR both fit this shape (spawn a tool, stream progress, read a result.md +
// images/ from an output dir), so they share this core; only the command and label
// differ. Streams ndjson progress and a final {text, images, tool}.
function runPdfTool({ cmd, args, tool, label, outputDir, res, timeoutMs }) {
  return new Promise((resolve) => {
    // Use spawn for streaming progress
    res.writeHead(200, {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
    });

    // detached → the tool becomes its own process-group leader, so a canceled import
    // can kill the whole tree (these fork torch/OCR workers a bare proc.kill would
    // orphan). On Windows there are no process groups, so fall back to a plain spawn.
    const proc = spawn(cmd, args, {
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
      detached: process.platform !== "win32",
    });

    let stderrBuf = "";
    let settled = false;
    const finish = () => { if (settled) return; settled = true; clearTimeout(timeout); resolve(); };
    // SIGKILL the whole group (negative pid); fall back to the bare process if the
    // group signal isn't available (Windows, or the leader already reaped).
    const killTree = () => {
      try {
        if (process.platform !== "win32" && proc.pid) process.kill(-proc.pid, "SIGKILL");
        else proc.kill("SIGKILL");
      } catch { try { proc.kill("SIGKILL"); } catch {} }
    };
    const timeout = setTimeout(() => {
      killTree();
      try { res.write(JSON.stringify({ error: `${label} timeout (${Math.round(timeoutMs / 60000)} min)` }) + "\n"); res.end(); } catch {}
      finish();
    }, timeoutMs);

    // The libimport job canceled → its loopback request drops and this response
    // socket closes while the tool is still churning. Kill the process tree so a
    // canceled import doesn't leave Python (+ torch/OCR workers) running to
    // completion in the background. Fires on normal end too — the settled guard
    // makes that a no-op.
    res.on("error", () => {});   // swallow EPIPE after the client hangs up
    res.on("close", () => { if (settled) return; killTree(); finish(); });

    // Only forward lines that look like progress (contain %, page, or progress bar chars)
    const isProgressLine = (line) => /\d+%|█|▓|░|page|pages|进度/i.test(line);

    proc.on("error", (err) => {
      try { res.write(JSON.stringify({ error: `${label} spawn failed: ${err.message}` }) + "\n"); res.end(); } catch {}
      finish();
    });

    proc.stdout.on("data", (chunk) => {
      if (settled) return;
      const lines = chunk.toString().split(/\r?\n|\r/).filter(Boolean);
      for (const line of lines) {
        if (isProgressLine(line)) {
          try { res.write(JSON.stringify({ progress: line.trim() }) + "\n"); } catch {}
        }
      }
    });

    proc.stderr.on("data", (chunk) => {
      stderrBuf += chunk.toString();
      if (settled) return;
      const lines = chunk.toString().split(/\r?\n|\r/).filter(Boolean);
      for (const line of lines) {
        if (isProgressLine(line)) {
          try { res.write(JSON.stringify({ progress: line.trim() }) + "\n"); } catch {}
        }
      }
    });

    proc.on("close", (code) => {
      if (settled) return;   // already timed out or canceled (killTree fired) → don't emit a result

      if (code !== 0) {
        res.write(JSON.stringify({ error: `${label} exited with code ${code}: ${stderrBuf.slice(-500)}` }) + "\n");
        res.end();
        finish();
        return;
      }

      const mdFile = findFile(outputDir, ".md");
      if (!mdFile) {
        res.write(JSON.stringify({ error: `${label} produced no markdown output` }) + "\n");
        res.end();
        finish();
        return;
      }

      const { text, images } = collectMarkdownOutput(mdFile);
      res.write(JSON.stringify({ text, images, tool }) + "\n");
      res.end();
      finish();
    });
  });
}

// Read a tool's result .md, inline the images it references (from a sibling images/
// subfolder) as deduped base64 attachments renamed image_NN.ext, and normalize the
// refs. Shared by every spawn-a-tool PDF engine. Returns { text, images }.
function collectMarkdownOutput(mdFile) {
  let markdown = fs.readFileSync(mdFile, "utf-8");
  const images = [];
  const seenHashes = new Map();
  let imageCounter = 0;

  // Images live in an "images" subfolder next to the .md (MinerU and Unlimited-OCR both).
  const imagesDir = path.join(path.dirname(mdFile), "images");
  if (fs.existsSync(imagesDir)) {
    // First pass: find all image filenames referenced in the markdown (in order of appearance)
    const imageFiles = collectImageFiles(imagesDir);
    const basenameToPath = new Map();
    for (const imgPath of imageFiles) {
      basenameToPath.set(path.basename(imgPath), imgPath);
    }

    // Extract image references from markdown in order of appearance
    const imgRefRegex = /!\[[^\]]*\]\(([^)]+)\)/g;
    let match;
    const referencedBasenames = [];
    while ((match = imgRefRegex.exec(markdown)) !== null) {
      const src = match[1];
      const basename = path.basename(src);
      if (basenameToPath.has(basename) && !referencedBasenames.includes(basename)) {
        referencedBasenames.push(basename);
      }
    }

    // Second pass: rename only referenced images in order of appearance, deduplicate
    for (const basename of referencedBasenames) {
      const imgPath = basenameToPath.get(basename);
      const imgData = fs.readFileSync(imgPath);
      const hashKey = imgData.length + ":" + imgData.slice(0, 64).toString("hex");

      let name;
      if (seenHashes.has(hashKey)) {
        name = seenHashes.get(hashKey);
      } else {
        imageCounter++;
        const imgExt = path.extname(imgPath).toLowerCase();
        name = `image_${String(imageCounter).padStart(2, "0")}${imgExt}`;
        seenHashes.set(hashKey, name);
        const mime = imgExt === ".png" ? "image/png" : imgExt === ".gif" ? "image/gif" : "image/jpeg";
        images.push({ name, base64: imgData.toString("base64"), mime });
      }

      // Replace the image basename in markdown with the new name
      markdown = markdown.split(basename).join(name);
    }
  }

  // Normalize image markdown to ![](image_XX.ext)
  markdown = markdown.replace(/!\[[^\]]*\]\(([^)]*image_\d+[^)]*)\)/g, (_, src) => {
    const m = src.match(/image_\d+\.[a-z]+/i);
    return m ? `![](${m[0]})` : `![](${src})`;
  });

  return { text: markdown, images };
}

function parsePdf(inputPath, tmpDir, res, timeoutMs = 300000) {
  return new Promise((resolve) => {
    if (!hasMinerU) {
      sendJson(res, 501, { error: "mineru_unavailable", fallback: true });
      resolve();
      return;
    }
    const outputDir = path.join(tmpDir, "output");
    fs.mkdirSync(outputDir, { recursive: true });
    const backendArgs = config.mineruBackend ? ["-b", config.mineruBackend] : [];
    runPdfTool({
      cmd: mineruPath, args: [...backendArgs, "-p", inputPath, "-o", outputDir],
      tool: "mineru", label: "MinerU", outputDir, res, timeoutMs,
    }).then(resolve);
  });
}

// Baidu Unlimited-OCR via the shipped Python wrapper (server/unlimited_ocr.py), which
// rasterizes the PDF and runs the local model, writing result.md + images/ into outputDir.
function parseUnlimitedOcr(inputPath, tmpDir, res, timeoutMs = 300000) {
  return new Promise((resolve) => {
    if (!hasUnlimitedOcr) {
      sendJson(res, 501, { error: "unlimited_ocr_unavailable", fallback: true });
      resolve();
      return;
    }
    const outputDir = path.join(tmpDir, "output");
    fs.mkdirSync(outputDir, { recursive: true });
    runPdfTool({
      cmd: config.ocrPython, args: [unlimitedOcrScript, "-p", inputPath, "-o", outputDir],
      tool: "unlimited-ocr", label: "Unlimited-OCR", outputDir, res, timeoutMs,
    }).then(resolve);
  });
}

// Recursively collect image files from a directory
function collectImageFiles(dir) {
  const results = [];
  const IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tiff"];
  function walk(d) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const fullPath = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (IMAGE_EXTS.includes(path.extname(entry.name).toLowerCase())) {
        results.push(fullPath);
      }
    }
  }
  walk(dir);
  return results.sort();
}

// Find a file with given extension recursively
function findFile(dir, ext) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findFile(fullPath, ext);
      if (found) return found;
    } else if (entry.name.endsWith(ext)) {
      return fullPath;
    }
  }
  return null;
}

// Pre-clean email HTML before Pandoc: drop hidden/tracking junk, unwrap
// SafeLinks, and flatten layout tables (email uses tables for layout, not data —
// left as-is Pandoc renders them as giant ASCII grid tables).
function preCleanEmailHtml(html) {
  let h = html
    // hidden preheader / hidden elements — remove BEFORE styles are stripped
    .replace(/<(div|span|p|td|table)\b[^>]*style="[^"]*(display\s*:\s*none|max-height\s*:\s*0|mso-hide\s*:\s*all|visibility\s*:\s*hidden)[^"]*"[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<!--\[if[\s\S]*?<!\[endif\]-->/gi, "")  // Outlook conditional comments
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, "")
    .replace(/<xml[^>]*>[\s\S]*?<\/xml>/gi, "")
    .replace(/<o:[^>]*>[\s\S]*?<\/o:[^>]+>/gi, "")
    .replace(/<o:[^>]*\/>/gi, "");

  // Unwrap Microsoft SafeLinks → real URL (originalsrc attribute, or ?url= param)
  h = h.replace(/<a\b([^>]*?)\soriginalsrc="([^"]+)"([^>]*)>/gi,
    (_, pre, real, post) => `<a ${(pre + post).replace(/\shref="[^"]*"/i, "")} href="${real}">`);
  h = h.replace(/href="https?:\/\/[^"]*safelinks\.protection\.outlook\.com\/[^"]*[?&]url=([^&"]+)[^"]*"/gi,
    (m, enc) => { try { return `href="${decodeURIComponent(enc)}"`; } catch { return m; } });

  // Drop tracking pixels / spacer images (width or height <= 2px)
  h = h.replace(/<img\b[^>]*>/gi, (tag) => {
    const w = (tag.match(/\bwidth\s*=\s*["']?(\d+)/i) || [])[1];
    const ht = (tag.match(/\bheight\s*=\s*["']?(\d+)/i) || [])[1];
    if ((w !== undefined && +w <= 2) || (ht !== undefined && +ht <= 2)) return "";
    return tag;
  });

  // Flatten layout tables so Pandoc doesn't produce ASCII grid tables
  h = h
    .replace(/<\/(td|th)>/gi, " ")
    .replace(/<\/tr>/gi, "<br>")   // keep each row on its own line after Markdown conversion
    .replace(/<\/(table|tbody|thead)>/gi, "\n\n")
    .replace(/<(table|tbody|thead|tr|td|th)\b[^>]*>/gi, "");

  // Strip presentational attributes (keep href/src/alt); drop wrapper tags
  h = h
    .replace(/\s+(class|style|lang|width|height|align|valign|bgcolor|color|border|cellpadding|cellspacing|dir|role|target|title|mso-[^=]*|xmlns[^=]*|data-[^=]*)="[^"]*"/gi, "")
    .replace(/<\/?span[^>]*>/gi, "")
    .replace(/<\/?div[^>]*>/gi, "\n")
    .replace(/<\/?font[^>]*>/gi, "");

  return h;
}

// Fetch one remote image, applying the same trash filters as the URL fetcher
// (skip non-images, SVG, tiny trackers, and oversized files). Returns null on
// any failure so a single bad link never blocks the rest.
async function fetchOneImage(url) {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; LocalAIChat/1.0)",
        "Accept": "image/avif,image/webp,image/*,*/*;q=0.8",
      },
      signal: AbortSignal.timeout(8000),
      redirect: "follow",
    });
    if (!res.ok) return null;
    const mime = (res.headers.get("content-type") || "").split(";")[0].trim();
    if (!mime.startsWith("image/") || mime === "image/svg+xml") return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 3000 || buf.length > 5 * 1024 * 1024) return null; // tracker / oversized
    return { base64: buf.toString("base64"), mime };
  } catch {
    return null;
  }
}

// Download every http(s) image referenced in the email's Markdown and return
// them as inline attachments ({name, base64, mime}). Remote ![](url) references
// are replaced with lightweight ［图片：alt］ placeholders so the rendered email
// never re-fetches remote (tracking) URLs and reads the same offline.
async function downloadEmailImages(markdown) {
  const IMG_RE = /!\[([^\]]*)\]\((https?:\/\/[^)\s]+?)(?:\s+"[^"]*")?\)/g;
  const urls = [...new Set([...markdown.matchAll(IMG_RE)].map((m) => m[2]))];
  if (urls.length === 0) return { markdown, images: [] };

  const MAX = 15;
  const targets = urls.slice(0, MAX);
  const fetched = await Promise.all(targets.map(fetchOneImage));

  const images = [];
  const nameByUrl = new Map();
  for (let i = 0; i < targets.length; i++) {
    const f = fetched[i];
    if (!f) continue;
    const ext = f.mime === "image/png" ? ".png" : f.mime === "image/gif" ? ".gif"
      : f.mime === "image/webp" ? ".webp" : ".jpg";
    const name = `image_${String(images.length + 1).padStart(2, "0")}${ext}`;
    images.push({ name, base64: f.base64, mime: f.mime });
    nameByUrl.set(targets[i], name);
  }

  // Rewrite each remote ![](url) to reference its downloaded filename. Images
  // that couldn't be fetched collapse to a lightweight placeholder so the
  // rendered email never re-requests a remote (tracking) URL.
  const md = markdown.replace(IMG_RE, (_whole, alt, url) => {
    const name = nameByUrl.get(url);
    return name ? `![${alt || ""}](${name})` : "［图片］";
  });
  return { markdown: md, images };
}

function parseHtml(req, res) {
  if (!hasPandoc) {
    sendJson(res, 501, { error: "pandoc_unavailable" });
    return;
  }

  let body = "";
  req.on("data", (chunk) => { body += chunk.toString(); });
  req.on("end", () => {
    try {
      const { html } = JSON.parse(body);
      if (!html) {
        sendJson(res, 400, { error: "No html provided" });
        return;
      }

      const cleaned = preCleanEmailHtml(html);

      execFile(pandocPath, ["-f", "html", "-t", "gfm-raw_html", "--wrap=none"], {
        maxBuffer: 10 * 1024 * 1024,
      }, (error, stdout, stderr) => {
        if (error) {
          sendJson(res, 500, { error: `pandoc error: ${stderr || error.message}` });
          return;
        }
        const markdown = stdout
          .replace(/[ \t]*\{[.#][^}\n]{0,80}\}/g, "")  // stray Pandoc attribute blocks
          .replace(/^\[TABLE\]$/gm, "")                  // placeholder for unrenderable tables
          .replace(/^[ \t]*\\[ \t]*$/gm, "")             // lone hard-break backslash lines
          .replace(/\\(\n\n)/g, "$1")                    // dangling hard break before a paragraph
          .replace(/\n{3,}/g, "\n\n")
          .replace(/\\\s*$/, "")                          // trailing hard break
          .trim();
        // Auto-download images linked in the email HTML so they display offline
        // and the browser never re-fetches remote/tracking URLs.
        downloadEmailImages(markdown)
          .then(({ markdown: md, images }) => sendJson(res, 200, { markdown: md, images }))
          .catch(() => sendJson(res, 200, { markdown, images: [] }));
      }).stdin.end(cleaned);
    } catch (e) {
      sendJson(res, 400, { error: e.message });
    }
  });
  req.on("error", (e) => sendJson(res, 500, { error: e.message }));
}

module.exports = { getCapabilities, parseFile, parseHtml };