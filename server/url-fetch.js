const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile, spawn } = require("child_process");
const { sendJson, readBody } = require("./utils");
const config = require("./config");

async function fetchUrlContent(req, res) {
  try {
    const body = await readBody(req);
    const { url, language } = body;
    if (!url) { sendJson(res, 400, { error: "url is required" }); return; }

    let parsed;
    try { parsed = new URL(url); } catch { sendJson(res, 400, { error: "Invalid URL" }); return; }
    if (!["http:", "https:"].includes(parsed.protocol)) { sendJson(res, 400, { error: "Only http/https supported" }); return; }

    // Check if YouTube
    const ytMatch = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([\w-]{11})/);
    if (ytMatch) {
      const videoId = ytMatch[1];
      const transcript = await fetchYouTubeTranscript(videoId, language);
      if (transcript) {
        const thumbnail = await fetchYouTubeThumbnail(videoId);
        sendJson(res, 200, {
          type: "youtube", videoId, title: transcript.title,
          channel: transcript.channel || "",
          duration: transcript.duration || "",
          viewCount: transcript.viewCount || "",
          uploadDate: transcript.uploadDate || "",
          description: transcript.description || "",
          content: transcript.text,
          thumbnail: thumbnail || "",
        });
        return;
      }
      // Fallback to page fetch if transcript fails
    }

    // General URL fetch
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const response = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; LocalAIChat/1.0)" },
      signal: controller.signal,
      redirect: "follow",
    });
    clearTimeout(timeout);

    if (!response.ok) { sendJson(res, 200, { type: "error", content: `HTTP ${response.status}: ${response.statusText}` }); return; }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html") && !contentType.includes("text/plain") && !contentType.includes("application/json")) {
      sendJson(res, 200, { type: "unsupported", content: `不支持的内容类型: ${contentType}` });
      return;
    }

    const html = await response.text();
    const text = extractTextFromHtml(html);
    const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]?.trim() || "";
    const truncated = text.slice(0, 8000);
    sendJson(res, 200, { type: "webpage", title, url, content: truncated });
  } catch (error) {
    if (error.name === "AbortError") {
      sendJson(res, 200, { type: "error", content: "请求超时" });
    } else {
      sendJson(res, 500, { error: "获取 URL 内容失败", detail: error.message });
    }
  }
}

function extractTextFromHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<header[\s\S]*?<\/header>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[^\S\n]+/g, " ")
    .replace(/\n[^\S\n]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function fetchYouTubeThumbnail(videoId) {
  // Quality order: maxres (1920x1080) > sd (640x480) > hq (480x360)
  const urls = [
    `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
    `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
    `https://img.youtube.com/vi/${videoId}/sddefault.jpg`,
    `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      // YouTube returns a small grey placeholder (~1-2KB) if resolution unavailable
      if (buf.length < 5000) continue;
      return `data:image/jpeg;base64,${buf.toString("base64")}`;
    } catch { /* try next */ }
  }
  return null;
}

async function fetchYouTubeTranscript(videoId, language) {
  // Method 1: Try yt-dlp if available (most reliable)
  const ytdlpResult = await fetchTranscriptViaYtdlp(videoId);
  if (ytdlpResult) return ytdlpResult;

  // Method 2: Scrape from page HTML
  try {
    const consentCookie = "SOCS=CAISNQgDEitib3FfaWRlbnRpdHlmcm9udGVuZHVpc2VydmVyXzIwMjMxMjE5LjA5X3AxGgJlbiACGgYIgJnmqwY";
    const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7",
        "Cookie": consentCookie,
      },
    });
    const pageHtml = await pageRes.text();

    const title = (pageHtml.match(/<title>(.*?)<\/title>/) || [])[1]?.replace(" - YouTube", "").trim() || "";

    // Extract ytInitialPlayerResponse JSON using brace counting
    let playerData = null;
    const marker = "ytInitialPlayerResponse";
    const startIdx = pageHtml.indexOf(marker);
    if (startIdx === -1) return null;
    const jsonStart = pageHtml.indexOf("{", startIdx);
    if (jsonStart === -1) return null;

    let depth = 0;
    let jsonEnd = -1;
    for (let i = jsonStart; i < pageHtml.length && i < jsonStart + 500000; i++) {
      if (pageHtml[i] === "{") depth++;
      else if (pageHtml[i] === "}") {
        depth--;
        if (depth === 0) { jsonEnd = i + 1; break; }
      }
    }
    if (jsonEnd === -1) return null;

    try { playerData = JSON.parse(pageHtml.slice(jsonStart, jsonEnd)); } catch { return null; }

    // Extract metadata from videoDetails
    const vd = playerData?.videoDetails || {};
    const mf = playerData?.microformat?.playerMicroformatRenderer || {};
    const channel = vd.author || "";
    const viewCount = vd.viewCount || "";
    const lengthSeconds = parseInt(vd.lengthSeconds || "0", 10);
    const duration = lengthSeconds > 0
      ? `${Math.floor(lengthSeconds / 60)}:${String(lengthSeconds % 60).padStart(2, "0")}`
      : "";
    // Try microformat first, then meta tag from HTML
    let uploadDate = (mf.publishDate || mf.uploadDate || "").slice(0, 10).replace(/-/g, "");
    if (!uploadDate) {
      const metaDate = pageHtml.match(/<meta[^>]*itemprop="(?:datePublished|uploadDate)"[^>]*content="([^"]+)"/);
      if (metaDate) uploadDate = metaDate[1].slice(0, 10).replace(/-/g, "");
    }
    if (!uploadDate) {
      const metaDate2 = pageHtml.match(/"publishDate"\s*:\s*"(\d{4}-\d{2}-\d{2})"/);
      if (metaDate2) uploadDate = metaDate2[1].replace(/-/g, "");
    }
    const description = vd.shortDescription || "";

    const captionTracks = playerData?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!captionTracks || captionTracks.length === 0) {
      return { title, channel, duration, viewCount, uploadDate, description, text: "[该视频无原始字幕]" };
    }

    // Select subtitle track based on prompt language preference
    const zhTrack = captionTracks.find(t => /zh/.test(t.languageCode));
    const enTrack = captionTracks.find(t => /en/.test(t.languageCode));
    let track;
    if (language === "zh" || language === "zh-Hant") {
      track = zhTrack || enTrack || captionTracks[0];
    } else if (language === "en") {
      track = enTrack || zhTrack || captionTracks[0];
    } else {
      track = enTrack || zhTrack || captionTracks[0];
    }

    let captionUrl = track.baseUrl;
    if (!captionUrl.startsWith("http")) captionUrl = "https://www.youtube.com" + captionUrl;

    // Fetch captions with cookies
    const setCookies = pageRes.headers.getSetCookie?.() || [];
    const cookieStr = [consentCookie, ...setCookies.map(c => c.split(";")[0])].join("; ");
    const captionRes = await fetch(captionUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Cookie": cookieStr,
        "Referer": `https://www.youtube.com/watch?v=${videoId}`,
      },
    });
    const captionXml = await captionRes.text();

    if (captionXml.length > 0) {
      const segments = [];
      const regex = /<text[^>]*start="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g;
      let match;
      while ((match = regex.exec(captionXml)) !== null) {
        const text = match[2]
          .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
          .replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/<[^>]+>/g, "")
          .replace(/\n/g, " ")
          .trim();
        if (text) segments.push(text);
      }
      if (segments.length > 0) return { title, channel, duration, viewCount, uploadDate, description, text: segments.join(" ") };
    }

    // Caption fetch failed
    const langInfo = captionTracks.map(t => t.languageCode).join(", ");
    return { title, channel, duration, viewCount, uploadDate, description, text: `[字幕获取失败，可用语言: ${langInfo}]` };
  } catch (e) {
    console.error("[yt-transcript] error:", e.message);
    return null;
  }
}

function fetchTranscriptViaYtdlp(videoId) {
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  return new Promise((resolve) => {
    // Check if yt-dlp is available
    execFile("which", ["yt-dlp"], (err) => {
      if (err) { resolve(null); return; }

      // Step 1: list available subtitles to pick the best language
      execFile("yt-dlp", ["--list-subs", "--skip-download", url],
        { timeout: 30000 }, (err2, stdout) => {
          if (err2 || !stdout) { resolve(null); return; }

          // Parse output: separate "Available subtitles" from auto-generated translations
          const lines = stdout.split("\n");
          const availableIdx = lines.findIndex(l => /Available subtitles/.test(l));
          const subSection = availableIdx >= 0 ? lines.slice(availableIdx + 1) : lines;
          const langLines = subSection.filter(l => /^\s*[\w-]+\s+/.test(l) && /vtt|srt|srv3/.test(l));
          const realLangs = langLines.map(l => l.trim().split(/\s+/)[0]);

          const autoSection = availableIdx >= 0 ? lines.slice(0, availableIdx) : [];
          const autoLangLines = autoSection.filter(l => /^\s*[\w-]+\s+/.test(l) && /vtt|srt|srv3/.test(l));
          const autoLangs = autoLangLines.map(l => l.trim().split(/\s+/)[0]);

          if (realLangs.length === 0 && autoLangs.length === 0) { resolve(null); return; }

          // Pick best language
          const preferred = ["zh-Hans", "zh-Hant", "zh", "en", "ja"];
          let selectedLang = null;

          for (const pref of preferred) {
            if (realLangs.includes(pref)) { selectedLang = pref; break; }
          }
          if (!selectedLang) {
            for (const pref of preferred) {
              if (autoLangs.includes(pref)) { selectedLang = pref; break; }
            }
          }
          if (!selectedLang) selectedLang = realLangs[0] || autoLangs[0];

          // Step 2: download the selected subtitle
          const tmpDir = path.join(os.tmpdir(), `yt-${videoId}-${Date.now()}`);
          fs.mkdirSync(tmpDir, { recursive: true });

          execFile("yt-dlp", [
            "--write-subs", "--write-auto-sub",
            "--sub-lang", selectedLang,
            "--sub-format", "vtt",
            "--skip-download",
            "-o", path.join(tmpDir, "%(id)s"),
            url,
          ], { timeout: 60000 }, (err3) => {
            try {
              const files = fs.readdirSync(tmpDir).filter(f => f.endsWith(".vtt") || f.endsWith(".srv3") || f.endsWith(".srt"));
              if (files.length === 0) { cleanupDir(tmpDir); resolve(null); return; }

              const content = fs.readFileSync(path.join(tmpDir, files[0]), "utf-8");

              // Parse VTT: extract timestamped segments
              const segments = [];
              const seen = new Set();
              const vttLines = content.split("\n");
              let currentTime = "";
              for (let i = 0; i < vttLines.length; i++) {
                const trimmed = vttLines[i].trim();
                if (!trimmed || trimmed.startsWith("WEBVTT") || trimmed.startsWith("Kind:") ||
                    trimmed.startsWith("Language:") || trimmed.startsWith("NOTE") ||
                    /^\d+$/.test(trimmed)) continue;
                const tsMatch = trimmed.match(/^(\d{2}:\d{2}:\d{2})\.\d+ --> /);
                if (tsMatch) {
                  currentTime = tsMatch[1];
                  continue;
                }
                const clean = trimmed.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&")
                  .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
                  .replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim();
                if (clean && !seen.has(clean)) {
                  seen.add(clean);
                  segments.push({ time: currentTime, text: clean });
                }
              }

              cleanupDir(tmpDir);

              if (segments.length === 0) { resolve(null); return; }

              const plainText = segments.map(s => s.text).join("\n");

              // Get video metadata
              execFile("yt-dlp", [
                "--print", "%(title)s",
                "--print", "%(channel)s",
                "--print", "%(duration_string)s",
                "--print", "%(view_count)s",
                "--print", "%(upload_date)s",
                "--print", "%(description).500s",
                "--skip-download", url,
              ], { timeout: 15000 }, (e, metaOut) => {
                  const metaLines = (metaOut || "").split("\n");
                  const title = metaLines[0]?.trim() || "";
                  const channel = metaLines[1]?.trim() || "";
                  const duration = metaLines[2]?.trim() || "";
                  const viewCount = metaLines[3]?.trim() || "";
                  const uploadDate = metaLines[4]?.trim() || "";
                  const description = metaLines.slice(5).join("\n").trim() || "";
                  resolve({ title, channel, duration, viewCount, uploadDate, description, text: plainText });
                }
              );
            } catch (e) {
              cleanupDir(tmpDir);
              resolve(null);
            }
          });
        }
      );
    });
  });
}

function cleanupDir(dir) {
  try {
    const files = fs.readdirSync(dir);
    for (const f of files) fs.unlinkSync(path.join(dir, f));
    fs.rmdirSync(dir);
  } catch {}
}

function cleanupFile(filePath) {
  try { fs.unlinkSync(filePath); } catch {}
}

// Find whisper model file
function findWhisperModel() {
  if (config.whisperModel && fs.existsSync(config.whisperModel)) {
    return config.whisperModel;
  }
  const modelNames = ["ggml-medium.bin", "ggml-base.bin", "ggml-small.bin", "ggml-large-v3.bin", "ggml-tiny.bin"];
  for (const dir of config.WHISPER_MODEL_SEARCH_PATHS) {
    for (const name of modelNames) {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

// Transcribe YouTube audio via whisper.cpp
async function transcribeYouTubeAudio(req, res) {
  let body;
  try { body = await readBody(req); } catch { sendJson(res, 400, { error: "invalid body" }); return; }
  const { videoId } = body;
  if (!videoId || !/^[\w-]{11}$/.test(videoId)) {
    sendJson(res, 400, { error: "invalid videoId" });
    return;
  }

  // Check dependencies
  const whisperCmd = await findCommand("whisper-cli");
  if (!whisperCmd) {
    sendJson(res, 200, { error: "whisper-cli 未安装。请运行: brew install whisper-cpp" });
    return;
  }
  const ytdlpCmd = await findCommand("yt-dlp");
  if (!ytdlpCmd) {
    sendJson(res, 200, { error: "yt-dlp 未安装。请运行: brew install yt-dlp" });
    return;
  }
  const ffmpegCmd = await findCommand("ffmpeg");
  if (!ffmpegCmd) {
    sendJson(res, 200, { error: "ffmpeg 未安装。请运行: brew install ffmpeg" });
    return;
  }
  const modelPath = findWhisperModel();
  if (!modelPath) {
    sendJson(res, 200, { error: "未找到 whisper 模型文件。请下载: curl -L -o ~/.local/share/whisper-cpp/ggml-medium.bin --create-dirs https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin" });
    return;
  }

  // Setup streaming response
  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-store",
  });

  const tmpDir = path.join(os.tmpdir(), `yt-whisper-${videoId}-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const audioRaw = path.join(tmpDir, "audio");
  const audioWav = path.join(tmpDir, "converted.wav");

  let aborted = false;
  const childProcesses = [];

  req.on("close", () => {
    aborted = true;
    for (const cp of childProcesses) {
      try { cp.kill("SIGTERM"); } catch {}
    }
    cleanupDir(tmpDir);
  });

  function send(obj) {
    if (!aborted) {
      try { res.write(JSON.stringify(obj) + "\n"); } catch {}
    }
  }

  try {
    // Step 1: Download audio
    send({ status: "downloading", message: "正在下载音频..." });
    await new Promise((resolve, reject) => {
      if (aborted) return reject(new Error("aborted"));
      const proc = spawn(ytdlpCmd, [
        "-x", "--audio-quality", "worst",
        "-o", audioRaw + ".%(ext)s",
        "--no-playlist",
        `https://www.youtube.com/watch?v=${videoId}`,
      ], { timeout: 300000 });
      childProcesses.push(proc);
      let stderr = "";
      proc.stderr.on("data", (d) => { stderr += d.toString(); });
      proc.on("close", (code) => {
        if (aborted) return reject(new Error("aborted"));
        if (code !== 0) return reject(new Error(`yt-dlp 失败 (code ${code}): ${stderr.slice(-200)}`));
        resolve();
      });
      proc.on("error", reject);
    });
    if (aborted) return;

    // Find the downloaded file (yt-dlp may produce .opus, .m4a, .webm, .wav etc.)
    const files = fs.readdirSync(tmpDir).filter(f => f.startsWith("audio") && f !== "converted.wav");
    if (files.length === 0) {
      send({ status: "error", message: "音频下载失败：未找到下载文件" });
      res.end();
      cleanupDir(tmpDir);
      return;
    }
    const downloadedFile = path.join(tmpDir, files[0]);
    const fileSizeMB = (fs.statSync(downloadedFile).size / 1024 / 1024).toFixed(1);
    send({ status: "downloaded", message: `音频下载完成（${fileSizeMB} MB）` });

    // Step 2: Convert to 16kHz mono WAV
    send({ status: "converting", message: "正在转换音频格式..." });
    await new Promise((resolve, reject) => {
      if (aborted) return reject(new Error("aborted"));
      const proc = spawn(ffmpegCmd, [
        "-i", downloadedFile,
        "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le",
        "-y", audioWav,
      ]);
      childProcesses.push(proc);
      proc.on("close", (code) => {
        if (aborted) return reject(new Error("aborted"));
        if (code !== 0) return reject(new Error(`ffmpeg 转换失败 (code ${code})`));
        resolve();
      });
      proc.on("error", reject);
    });
    if (aborted) return;

    // Step 3: Transcribe with whisper-cli (with timestamps for natural segmentation)
    send({ status: "transcribing", message: "正在语音识别...", progress: "0%" });
    const transcriptText = await new Promise((resolve, reject) => {
      if (aborted) return reject(new Error("aborted"));
      const proc = spawn(whisperCmd, [
        "-m", modelPath,
        "-f", audioWav,
        "-l", "auto",
        "--print-progress",
      ]);
      childProcesses.push(proc);
      let stdout = "";
      let lastProgress = "";
      proc.stdout.on("data", (d) => { stdout += d.toString(); });
      proc.stderr.on("data", (d) => {
        const str = d.toString();
        // Parse progress from stderr: "whisper_full_with_state: progress = XX%"
        const match = str.match(/progress\s*=\s*(\d+)%/);
        if (match && match[1] !== lastProgress) {
          lastProgress = match[1];
          send({ status: "transcribing", message: `正在语音识别... ${match[1]}%`, progress: `${match[1]}%` });
        }
      });
      proc.on("close", (code) => {
        if (aborted) return reject(new Error("aborted"));
        if (code !== 0) return reject(new Error(`whisper-cli 转录失败 (code ${code})`));
        // Parse timestamped output: "[HH:MM:SS.mmm --> HH:MM:SS.mmm]  text"
        const lines = stdout.split("\n");
        const segments = [];
        for (const line of lines) {
          const m = line.match(/^\[[\d:.]+\s*-->\s*[\d:.]+\]\s*(.+)/);
          if (m && m[1].trim()) {
            segments.push(m[1].trim());
          }
        }
        resolve(segments.length > 0 ? segments.join("\n") : stdout.trim());
      });
      proc.on("error", reject);
    });
    if (aborted) return;

    // Done
    send({ status: "done", text: transcriptText });
    res.end();
    cleanupDir(tmpDir);
  } catch (e) {
    if (!aborted) {
      send({ status: "error", message: e.message || "转录失败" });
      res.end();
    }
    cleanupDir(tmpDir);
  }
}

function findCommand(cmd) {
  return new Promise((resolve) => {
    execFile("which", [cmd], (err, stdout) => {
      if (err || !stdout.trim()) resolve(null);
      else resolve(stdout.trim());
    });
  });
}

module.exports = { fetchUrlContent, transcribeYouTubeAudio };
