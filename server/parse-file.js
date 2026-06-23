const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile, execSync, spawn } = require("child_process");
const { sendJson } = require("./utils");

// Detect tool availability (async, non-blocking)
let hasPandoc = false;
let hasMinerU = false;
let detectDone = false;
let pandocPath = "pandoc";
let mineruPath = "mineru";

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

  // Try with 'which' command
  try {
    const result = execSync(`which ${name}`, { encoding: "utf-8", stdio: "ignore" });
    return result.trim();
  } catch {}

  return name; // fallback to just the name
}

(async function detectTools() {
  try {
    pandocPath = findExecutable("pandoc");
    execSync(`${pandocPath} --version`, { stdio: "ignore", timeout: 5000 });
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
  detectDone = true;
})();

function getCapabilities(res) {
  sendJson(res, 200, { pandoc: hasPandoc, mineru: hasMinerU, ready: detectDone });
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
    const ext = path.extname(filename).toLowerCase();

    if (ext !== ".pdf" && ext !== ".docx" && ext !== ".pptx") {
      sendJson(res, 400, { error: "Server parsing only supports .pdf, .docx and .pptx" });
      return;
    }

    // Create temp directory
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "parse-file-"));
    const inputPath = path.join(tmpDir, filename);
    fs.writeFileSync(inputPath, data);

    if (ext === ".docx" || ext === ".pptx") {
      await parseDocx(inputPath, tmpDir, res);
    } else if (ext === ".pdf") {
      await parsePdf(inputPath, tmpDir, res);
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

function parsePdf(inputPath, tmpDir, res) {
  return new Promise((resolve) => {
    if (!hasMinerU) {
      sendJson(res, 501, { error: "mineru_unavailable", fallback: true });
      resolve();
      return;
    }

    const outputDir = path.join(tmpDir, "output");
    fs.mkdirSync(outputDir, { recursive: true });

    // Use spawn for streaming progress
    res.writeHead(200, {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
    });

    const proc = spawn(mineruPath, ["-p", inputPath, "-o", outputDir], {
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
    });

    let stderrBuf = "";
    const timeout = setTimeout(() => {
      proc.kill();
      res.write(JSON.stringify({ error: "MinerU timeout (5 min)" }) + "\n");
      res.end();
      resolve();
    }, 300000);

    // Only forward lines that look like progress (contain %, page, or progress bar chars)
    const isProgressLine = (line) => /\d+%|█|▓|░|page|pages|进度/i.test(line);

    proc.stdout.on("data", (chunk) => {
      const lines = chunk.toString().split(/\r?\n|\r/).filter(Boolean);
      for (const line of lines) {
        if (isProgressLine(line)) {
          res.write(JSON.stringify({ progress: line.trim() }) + "\n");
        }
      }
    });

    proc.stderr.on("data", (chunk) => {
      stderrBuf += chunk.toString();
      const lines = chunk.toString().split(/\r?\n|\r/).filter(Boolean);
      for (const line of lines) {
        if (isProgressLine(line)) {
          res.write(JSON.stringify({ progress: line.trim() }) + "\n");
        }
      }
    });

    proc.on("close", (code) => {
      clearTimeout(timeout);

      if (code !== 0) {
        res.write(JSON.stringify({ error: `MinerU exited with code ${code}: ${stderrBuf.slice(-500)}` }) + "\n");
        res.end();
        resolve();
        return;
      }

      // Find the generated .md file
      const mdFile = findFile(outputDir, ".md");
      if (!mdFile) {
        res.write(JSON.stringify({ error: "MinerU produced no markdown output" }) + "\n");
        res.end();
        resolve();
        return;
      }

      let markdown = fs.readFileSync(mdFile, "utf-8");
      const images = [];
      const seenHashes = new Map();
      let imageCounter = 0;

      // Find images directory (MinerU puts images in an "images" subfolder)
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

        // Remove image references not in the referenced set (unreferenced images)
        // They won't appear since we only replaced referenced ones
      }

      // Normalize image markdown to ![](image_XX.ext)
      markdown = markdown.replace(/!\[[^\]]*\]\(([^)]*image_\d+[^)]*)\)/g, (_, src) => {
        const match = src.match(/image_\d+\.[a-z]+/i);
        return match ? `![](${match[0]})` : `![](${src})`;
      });

      res.write(JSON.stringify({ text: markdown, images, tool: "mineru" }) + "\n");
      res.end();
      resolve();
    });
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
