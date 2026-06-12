const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile, execSync, spawn } = require("child_process");
const { sendJson } = require("./utils");

// Detect tool availability (async, non-blocking)
let hasPandoc = false;
let hasMinerU = false;
let detectDone = false;

(async function detectTools() {
  try {
    execSync("pandoc --version", { stdio: "ignore", timeout: 5000 });
    hasPandoc = true;
    console.log("[parse-file] pandoc detected");
  } catch {
    console.log("[parse-file] pandoc not found, DOCX will use client-side fallback");
  }

  // Check mineru asynchronously to avoid blocking server startup
  try {
    await new Promise((resolve, reject) => {
      const proc = spawn("mineru", ["--version"], { stdio: "ignore" });
      const timer = setTimeout(() => { proc.kill(); reject(new Error("timeout")); }, 15000);
      proc.on("close", (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(); });
      proc.on("error", () => { clearTimeout(timer); reject(); });
    });
    hasMinerU = true;
    console.log("[parse-file] MinerU detected");
  } catch {
    console.log("[parse-file] MinerU not found, PDF will use client-side fallback");
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
    execFile("pandoc", [inputPath, "-t", "markdown", "--wrap=none", `--extract-media=${tmpDir}`], {
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

    const proc = spawn("mineru", ["-p", inputPath, "-o", outputDir], {
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

      // Pre-clean Outlook/Word HTML noise before Pandoc
      const cleaned = html
        .replace(/<!--\[if[\s\S]*?<!\[endif\]-->/gi, "")  // Conditional comments
        .replace(/<!--[\s\S]*?-->/g, "")                    // Regular comments
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")    // Style blocks
        .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, "")      // Head section
        .replace(/<xml[^>]*>[\s\S]*?<\/xml>/gi, "")        // XML blocks
        .replace(/<o:[^>]*>[\s\S]*?<\/o:[^>]+>/gi, "")     // Office namespace tags
        .replace(/<o:[^>]*\/>/gi, "")                       // Self-closing office tags
        .replace(/\s+(class|style|lang|mso-[^=]*|xmlns[^=]*)="[^"]*"/gi, "")  // Noisy attributes
        .replace(/<\/?span[^>]*>/gi, "")                    // Spans (no semantic value)
        .replace(/<\/?div[^>]*>/gi, "")                     // Divs (Pandoc handles p/table/a)
        .replace(/<\/?font[^>]*>/gi, "");                   // Font tags

      execFile("pandoc", ["-f", "html", "-t", "markdown-raw_html-native_divs-native_spans", "--wrap=none"], {
        maxBuffer: 10 * 1024 * 1024,
      }, (error, stdout, stderr) => {
        if (error) {
          sendJson(res, 500, { error: `pandoc error: ${stderr || error.message}` });
          return;
        }
        // Clean up excessive blank lines from removed elements
        let markdown = stdout.replace(/\n{3,}/g, "\n\n").trim();
        // Replace SafeLinks: [text](tracking-url){originalsrc="real-url" ...} → [text](real-url)
        markdown = markdown.replace(/\[([^\]]*)\]\([^)]*\)\{originalsrc="([^"]+)"[^}]*\}/g, "[$1]($2)");
        sendJson(res, 200, { markdown });
      }).stdin.end(cleaned);
    } catch (e) {
      sendJson(res, 400, { error: e.message });
    }
  });
  req.on("error", (e) => sendJson(res, 500, { error: e.message }));
}

module.exports = { getCapabilities, parseFile, parseHtml };
