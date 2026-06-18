// Local text-to-speech for the /voice command. Drives a persistent Python
// daemon (server/tts_engine.py) that wraps the Kokoro and CosyVoice engines —
// persistent so the (slow-to-load) models stay warm between requests. The
// daemon writes each clip to a temp wav; we base64 it for the browser, which
// renders an <audio> + download button (mirrors the image/video generation flow).
const { spawn, execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const config = require("./config");
const { sendJson, readBody, cleanSpeechText } = require("./utils");

// Resolve ffmpeg once (used to transcode the engine's wav → AAC). null if absent.
let ffmpegPath; // undefined = not probed yet, null = absent, string = path
function findFfmpeg() {
  if (ffmpegPath !== undefined) return Promise.resolve(ffmpegPath);
  return new Promise((resolve) => {
    execFile("which", ["ffmpeg"], (err, stdout) => {
      ffmpegPath = err || !stdout.trim() ? null : stdout.trim();
      resolve(ffmpegPath);
    });
  });
}

// Transcode an audio file (wav/aiff) to AAC (ADTS .aac). Resolves the output
// path, or null if ffmpeg is unavailable / fails (caller falls back to source).
function transcodeToAac(inPath) {
  return new Promise(async (resolve) => {
    const ff = await findFfmpeg();
    if (!ff) { resolve(null); return; }
    const aacPath = inPath.replace(/\.[^.]+$/, "") + ".aac";
    const proc = spawn(ff, ["-i", inPath, "-c:a", "aac", "-b:a", "128k", "-f", "adts", "-y", aacPath]);
    proc.on("error", () => resolve(null));
    proc.on("close", (code) => resolve(code === 0 ? aacPath : null));
  });
}

// Synthesize via macOS `say` to a temp AIFF file (used by /voice when a "say:"
// voice is selected). Resolves the aiff path (caller deletes it).
function sayToAiff(voice, text, rate) {
  return new Promise((resolve, reject) => {
    const out = path.join(os.tmpdir(), `hk_say_${process.pid}_${nextId++}.aiff`);
    const args = [];
    if (voice) args.push("-v", voice);
    if (rate) args.push("-r", String(Math.round(Number(rate) * 175)));
    args.push("-o", out);
    const proc = spawn("say", args);
    proc.on("error", reject);
    proc.stdin.write(text);
    proc.stdin.end();
    proc.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`say exited ${code}`))));
  });
}

// Synthesize one chunk on a neural engine (kokoro/cosyvoice) to a wav file.
// Exported for the reader (server/speech.js) to play per-sentence. Caller deletes.
async function synthToWav({ engine, voice, text, speed }) {
  const engines = await ensureDaemon();
  if (!engines.has(engine)) throw new Error(`TTS engine "${engine}" unavailable`);
  const reply = await request({ engine, voice, text: cleanSpeechText(text), speed: speed || 1 }, 180000);
  return reply.wav_path;
}

// Fixed preset voices (no cloning). value = "<engine>:<voiceId>"; the engine
// prefix tells the daemon which synthesizer to use. Labels are shown in the
// settings dropdown and the /voice autocomplete is engine-agnostic.
const VOICE_CATALOG = [
  // Kokoro (light & fast) — Mandarin presets
  { value: "kokoro:zf_xiaoxiao", engine: "kokoro", label: "小晓 · 女声 (Kokoro)", gender: "female" },
  { value: "kokoro:zf_xiaoyi", engine: "kokoro", label: "小艺 · 女声 (Kokoro)", gender: "female" },
  { value: "kokoro:zf_xiaobei", engine: "kokoro", label: "小贝 · 女声 (Kokoro)", gender: "female" },
  { value: "kokoro:zf_xiaoni", engine: "kokoro", label: "小妮 · 女声 (Kokoro)", gender: "female" },
  { value: "kokoro:zm_yunxi", engine: "kokoro", label: "云希 · 男声 (Kokoro)", gender: "male" },
  { value: "kokoro:zm_yunjian", engine: "kokoro", label: "云健 · 男声 (Kokoro)", gender: "male" },
  { value: "kokoro:zm_yunyang", engine: "kokoro", label: "云扬 · 男声 (Kokoro)", gender: "male" },
  { value: "kokoro:zm_yunxia", engine: "kokoro", label: "云夏 · 男声 (Kokoro)", gender: "male" },
  // CosyVoice (higher Chinese quality) — built-in SFT speakers
  { value: "cosyvoice:中文女", engine: "cosyvoice", label: "中文女 (CosyVoice)", gender: "female" },
  { value: "cosyvoice:中文男", engine: "cosyvoice", label: "中文男 (CosyVoice)", gender: "male" },
  { value: "cosyvoice:粤语女", engine: "cosyvoice", label: "粤语女 (CosyVoice)", gender: "female" },
];

let daemon = null;           // the spawned python process, or null
let starting = null;         // Promise resolving to the set of available engines
let availableEngines = new Set();
let nextId = 1;
const pending = new Map();    // id → { resolve, reject, timer }
let stdoutBuf = "";

function killDaemon() {
  if (daemon) { try { daemon.kill(); } catch { /* already dead */ } }
  daemon = null;
  starting = null;
  availableEngines = new Set();
  for (const { reject, timer } of pending.values()) {
    clearTimeout(timer);
    reject(new Error("tts daemon stopped"));
  }
  pending.clear();
}

function handleLine(line) {
  line = line.trim();
  if (!line) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.ready) { availableEngines = new Set(msg.engines || []); return; }
  const id = msg.id;
  if (id == null || !pending.has(id)) return;
  const { resolve, reject, timer } = pending.get(id);
  clearTimeout(timer);
  pending.delete(id);
  if (msg.ok) resolve(msg);
  else reject(new Error(msg.error || "tts failed"));
}

// Spawn (once) the python daemon and wait for its {ready} line listing the
// engines that imported successfully. Resolves to that Set.
function ensureDaemon() {
  if (starting) return starting;
  starting = new Promise((resolve) => {
    const script = path.join(__dirname, "tts_engine.py");
    let proc;
    try {
      proc = spawn(config.ttsPython, [script], {
        env: { ...process.env, PYTHONUNBUFFERED: "1" },
      });
    } catch (e) {
      console.warn(`[tts] failed to spawn ${config.ttsPython}: ${e.message}`);
      resolve(new Set());
      return;
    }
    daemon = proc;
    let settled = false;
    const ready = () => { if (!settled) { settled = true; resolve(availableEngines); } };

    proc.stdout.setEncoding("utf-8");
    proc.stdout.on("data", (chunk) => {
      stdoutBuf += chunk;
      let nl;
      while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
        const line = stdoutBuf.slice(0, nl);
        stdoutBuf = stdoutBuf.slice(nl + 1);
        handleLine(line);
        if (line.includes('"ready"')) ready();
      }
    });
    proc.stderr.on("data", (d) => {
      const s = d.toString().trim();
      if (s) console.log(`[tts_engine] ${s}`);
    });
    proc.on("error", (e) => {
      console.warn(`[tts] daemon error: ${e.message}`);
      killDaemon();
      ready();
    });
    proc.on("close", (code) => {
      console.log(`[tts] daemon exited (code ${code})`);
      const wasStarting = !settled;
      killDaemon();
      if (wasStarting) ready();
    });
    // Don't hang forever if the model import wedges — give it generous headroom.
    setTimeout(ready, 60000);
  });
  return starting;
}

// Send one synthesis request to the daemon and await its reply.
function request(payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (!daemon || !daemon.stdin.writable) {
      reject(new Error("tts daemon not running"));
      return;
    }
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("tts request timed out"));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    daemon.stdin.write(JSON.stringify({ id, ...payload }) + "\n");
  });
}

// GET /api/tts-voices → preset voices for engines that are actually available.
async function listTtsVoices(res) {
  const engines = await ensureDaemon();
  const voices = VOICE_CATALOG.filter((v) => engines.has(v.engine));
  sendJson(res, 200, {
    voices,
    available: voices.length > 0,
    engines: [...engines],
  });
}

// POST /api/tts { text, voice, rate } → { audio: base64, mime }. Output is AAC
// (ffmpeg) regardless of engine; falls back to the raw wav/aiff if ffmpeg is
// missing. Routes by the voice's engine prefix: "say:" → macOS say, otherwise
// the neural daemon (kokoro/cosyvoice).
async function synthesize(req, res) {
  let srcPath, aacPath;
  try {
    const body = await readBody(req);
    const text = cleanSpeechText(body.text || "");
    const voiceVal = body.voice || "";
    const rate = Number(body.rate) || 1;
    if (!text) { sendJson(res, 400, { error: "text is required" }); return; }

    const known = VOICE_CATALOG.find((v) => v.value === voiceVal);
    const sep = voiceVal.indexOf(":");
    const engine = known ? known.engine : (sep > 0 ? voiceVal.slice(0, sep) : "say");
    const voice = known ? voiceVal.slice(voiceVal.indexOf(":") + 1)
                        : (sep > 0 ? voiceVal.slice(sep + 1) : voiceVal);

    let fallbackMime = "audio/wav";
    if (engine === "say") {
      srcPath = await sayToAiff(voice, text, rate);
      fallbackMime = "audio/aiff";
    } else {
      const engines = await ensureDaemon();
      if (!engines.has(engine)) {
        sendJson(res, 503, { error: `TTS engine "${engine}" is not available. See README for setup.` });
        return;
      }
      const reply = await request(
        { engine, voice, text, speed: rate },
        Math.max(30000, Number(body.timeout) * 1000 || 0) || 180000
      );
      srcPath = reply.wav_path;
    }

    // Prefer AAC (≈5× smaller than wav/aiff — matters because the clip is
    // base64'd into the persisted chat). Fall back to the source if ffmpeg fails.
    aacPath = await transcodeToAac(srcPath);
    const b64 = fs.readFileSync(aacPath || srcPath).toString("base64");
    sendJson(res, 200, { audio: b64, mime: aacPath ? "audio/aac" : fallbackMime });
  } catch (e) {
    if (!res.headersSent) sendJson(res, 500, { error: e.message });
  } finally {
    if (srcPath) fs.unlink(srcPath, () => {});
    if (aacPath) fs.unlink(aacPath, () => {});
  }
}

module.exports = { listTtsVoices, synthesize, synthToWav };
