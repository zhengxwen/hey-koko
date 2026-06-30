// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const config = require("./config");
const { sendJson, readBody } = require("./utils");

const HAS_ZSTD = typeof zlib.zstdCompressSync === "function";

function ensureArchivesDir() {
  if (!fs.existsSync(config.ARCHIVES_DIR)) {
    fs.mkdirSync(config.ARCHIVES_DIR, { recursive: true });
  }
}

async function archiveConversation(req, res) {
  try {
    const body = await readBody(req);
    if (!body.messages || !body.messages.length) {
      sendJson(res, 400, { error: "对话为空，无法存档" });
      return;
    }

    ensureArchivesDir();

    // 按目标文件的扩展名选择压缩方式（覆盖旧存档时沿用其后缀，避免 .gz 里写 zstd）。
    const writeArchive = (filePath) => {
      const buf = Buffer.from(JSON.stringify(body, null, 2), "utf-8");
      let compressed;
      if (filePath.endsWith(".zst")) compressed = zlib.zstdCompressSync(buf);
      else if (filePath.endsWith(".gz")) compressed = zlib.gzipSync(buf);
      else compressed = buf;
      fs.writeFileSync(filePath, compressed);
    };

    // 方案3：取档时标签页记下了来源存档文件名（sourceArchive）。再次归档时，
    // 若来源文件仍在，就更新原存档而非新建一份，避免反复归档/取档堆积重复副本。
    // sourceArchive 是内部字段，不写进存档内容本身。
    const sourceArchive = body.sourceArchive;
    delete body.sourceArchive;
    if (sourceArchive) {
      const normalized = path.normalize(sourceArchive).replace(/\\/g, "/");
      if (!normalized.startsWith("/") && !normalized.startsWith("..")) {
        const srcPath = path.join(config.ARCHIVES_DIR, normalized);
        if (srcPath.startsWith(config.ARCHIVES_DIR) && fs.existsSync(srcPath)) {
          writeArchive(srcPath);
          sendJson(res, 200, { ok: true, filename: normalized, updated: true });
          return;
        }
      }
      // 来源文件已被删除或路径非法 → 落到下面的新建逻辑。
    }

    // Find the first user message timestamp for filename
    const firstUserMsg = body.messages.find(m => m.role === "user");
    let timestamp;
    if (firstUserMsg && firstUserMsg.timestamp) {
      const ts = typeof firstUserMsg.timestamp === "string"
        ? new Date(firstUserMsg.timestamp.replace(" ", "T"))
        : new Date(firstUserMsg.timestamp);
      const pad = (n) => String(n).padStart(2, "0");
      timestamp = `${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}_${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}`;
    } else {
      const now = new Date();
      const pad = (n) => String(n).padStart(2, "0");
      timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    }

    const ext = HAS_ZSTD ? ".json.zst" : ".json.gz";
    const filename = `nt_${timestamp}${ext}`;
    const filePath = path.join(config.ARCHIVES_DIR, filename);

    // Avoid overwriting: append a suffix if file exists
    let finalPath = filePath;
    let finalName = filename;
    if (fs.existsSync(filePath)) {
      const suffix = `_${Date.now().toString(36)}`;
      finalName = `nt_${timestamp}${suffix}${ext}`;
      finalPath = path.join(config.ARCHIVES_DIR, finalName);
    }

    writeArchive(finalPath);
    sendJson(res, 200, { ok: true, filename: finalName });
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
}

function readArchiveFile(filePath) {
  const raw = fs.readFileSync(filePath);
  if (filePath.endsWith(".zst")) {
    return zlib.zstdDecompressSync(raw).toString("utf-8");
  }
  if (filePath.endsWith(".gz")) {
    return zlib.gunzipSync(raw).toString("utf-8");
  }
  return raw.toString("utf-8");
}

// Recursively list archive filenames (skips dotfiles like the embeddings index).
function scanArchiveFilenames() {
  ensureArchivesDir();
  function scanDir(dir, prefix) {
    const results = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (entry.isDirectory()) {
        results.push(...scanDir(path.join(dir, entry.name), prefix ? `${prefix}/${entry.name}` : entry.name));
      } else if (entry.name.endsWith(".json") || entry.name.endsWith(".json.gz") || entry.name.endsWith(".json.zst")) {
        results.push(prefix ? `${prefix}/${entry.name}` : entry.name);
      }
    }
    return results;
  }
  return scanDir(config.ARCHIVES_DIR, "").sort();
}

function listArchives(res) {
  try {
    const files = scanArchiveFilenames();

    const archives = files.map(filename => {
      try {
        const content = readArchiveFile(path.join(config.ARCHIVES_DIR, filename));
        const data = JSON.parse(content);
        const firstUserMsg = (data.messages || []).find(m => m.role === "user");
        const firstTimestamp = firstUserMsg ? firstUserMsg.timestamp : null;
        const preview = (data.messages || []).slice(0, 4).map(m => {
          const text = (m.content || "").slice(0, 80);
          return { role: m.role, content: text };
        });
        return {
          filename,
          title: data.title || "未命名对话",
          tags: data.tags || [],
          personality: data.personality || "",
          messageCount: (data.messages || []).length,
          firstTimestamp,
          preview,
        };
      } catch {
        return { filename, title: filename, tags: [], messageCount: 0, firstTimestamp: null, preview: [] };
      }
    });

    sendJson(res, 200, { archives });
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
}

async function loadArchives(req, res) {
  try {
    const body = await readBody(req);
    const filenames = body.filenames || [];
    const results = [];

    for (const filename of filenames) {
      // Security: prevent path traversal
      const normalized = path.normalize(filename).replace(/\\/g, "/");
      if (normalized.startsWith("/") || normalized.startsWith("..")) {
        results.push({ filename, error: "Invalid path" });
        continue;
      }
      const filePath = path.join(config.ARCHIVES_DIR, normalized);
      if (!filePath.startsWith(config.ARCHIVES_DIR)) {
        results.push({ filename, error: "Invalid path" });
        continue;
      }
      try {
        const content = readArchiveFile(filePath);
        results.push({ filename: normalized, data: JSON.parse(content) });
      } catch {
        results.push({ filename: normalized, error: "文件不存在或无法读取" });
      }
    }

    sendJson(res, 200, { results });
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
}

async function deleteArchives(req, res) {
  try {
    const body = await readBody(req);
    const filenames = body.filenames || [];
    const deleted = [];
    const errors = [];

    for (const filename of filenames) {
      const normalized = path.normalize(filename).replace(/\\/g, "/");
      if (normalized.startsWith("/") || normalized.startsWith("..")) {
        errors.push({ filename, error: "Invalid path" });
        continue;
      }
      const filePath = path.join(config.ARCHIVES_DIR, normalized);
      if (!filePath.startsWith(config.ARCHIVES_DIR)) {
        errors.push({ filename, error: "Invalid path" });
        continue;
      }
      try {
        fs.unlinkSync(filePath);
        deleted.push(normalized);
      } catch {
        errors.push({ filename: normalized, error: "删除失败" });
      }
    }

    sendJson(res, 200, { deleted, errors });
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
}

function listArchiveDirs(res) {
  try {
    ensureArchivesDir();
    const dirs = [""];  // root directory represented as ""
    function scanSubdirs(dir, prefix) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
          dirs.push(rel);
          scanSubdirs(path.join(dir, entry.name), rel);
        }
      }
    }
    scanSubdirs(config.ARCHIVES_DIR, "");
    sendJson(res, 200, { dirs: dirs.sort() });
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
}

async function moveArchives(req, res) {
  try {
    const body = await readBody(req);
    const filenames = body.filenames || [];
    const targetDir = body.targetDir || "";
    
    // Validate target directory
    const normalizedTarget = path.normalize(targetDir).replace(/\\/g, "/");
    if (normalizedTarget.startsWith("/") || normalizedTarget.startsWith("..")) {
      sendJson(res, 400, { error: "Invalid target directory" });
      return;
    }
    const targetPath = targetDir ? path.join(config.ARCHIVES_DIR, normalizedTarget) : config.ARCHIVES_DIR;
    if (!targetPath.startsWith(config.ARCHIVES_DIR)) {
      sendJson(res, 400, { error: "Invalid target directory" });
      return;
    }

    // Ensure target directory exists
    if (!fs.existsSync(targetPath)) {
      fs.mkdirSync(targetPath, { recursive: true });
    }

    const moved = [];
    const errors = [];

    for (const filename of filenames) {
      const normalized = path.normalize(filename).replace(/\\/g, "/");
      if (normalized.startsWith("/") || normalized.startsWith("..")) {
        errors.push({ filename, error: "Invalid path" });
        continue;
      }
      const srcPath = path.join(config.ARCHIVES_DIR, normalized);
      if (!srcPath.startsWith(config.ARCHIVES_DIR) || !fs.existsSync(srcPath)) {
        errors.push({ filename: normalized, error: "文件不存在" });
        continue;
      }

      const baseName = path.basename(normalized);
      let destPath = path.join(targetPath, baseName);
      let finalName = baseName;

      // Auto-rename if destination exists
      if (fs.existsSync(destPath) && destPath !== srcPath) {
        const ext = baseName.includes(".json.zst") ? ".json.zst" : baseName.includes(".json.gz") ? ".json.gz" : ".json";
        const nameWithoutExt = baseName.slice(0, baseName.length - ext.length);
        let counter = 1;
        while (fs.existsSync(destPath)) {
          finalName = `${nameWithoutExt}_${counter}${ext}`;
          destPath = path.join(targetPath, finalName);
          counter++;
        }
      }

      // Skip if source and dest are the same
      if (destPath === srcPath) {
        continue;
      }

      try {
        fs.renameSync(srcPath, destPath);
        const newRelPath = targetDir ? `${normalizedTarget}/${finalName}` : finalName;
        moved.push({ from: normalized, to: newRelPath });
      } catch {
        errors.push({ filename: normalized, error: "移动失败" });
      }
    }

    sendJson(res, 200, { moved, errors });
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
}

module.exports = { archiveConversation, listArchives, loadArchives, deleteArchives, listArchiveDirs, moveArchives, readArchiveFile, scanArchiveFilenames };