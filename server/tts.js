// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

// Local text-to-speech for the /voice command. Drives persistent Python
// daemons (server/tts_engine.py) wrapping the Kokoro and Qwen3-TTS engines —
// persistent so the (slow-to-load) models stay warm between requests. The
// daemon writes each clip to a temp wav; we base64 it for the browser, which
// renders an <audio> + download button (mirrors the image/video generation flow).
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const config = require("./config");
const { sendJson, readBody, cleanSpeechText } = require("./utils");
const { findTool } = require("./find-tool");
const gallery = require("./gallery");   // /voice clips are filed like any other artifact

// Transcode an audio file (wav) to AAC (ADTS .aac). Resolves the output
// path, or null if ffmpeg is unavailable / fails (caller falls back to source).
function transcodeToAac(inPath) {
  return new Promise((resolve) => {
    const ff = findTool("ffmpeg");
    if (!ff) { resolve(null); return; }
    const aacPath = inPath.replace(/\.[^.]+$/, "") + ".aac";
    const proc = spawn(ff, ["-i", inPath, "-c:a", "aac", "-b:a", "128k", "-f", "adts", "-y", aacPath]);
    proc.on("error", () => resolve(null));
    proc.on("close", (code) => resolve(code === 0 ? aacPath : null));
  });
}

// Synthesize via macOS `say` to a temp WAV. Shared by /voice (synthesize below) and the
// reader (server/speech.js). WAV, not say's default AIFF: browsers can't play AIFF, and
// that is exactly what /voice would hand them when ffmpeg is missing. LEI16@22050 is
// lossless here — every installed voice, Premium included, renders at 22050 Hz mono.
// `signal` aborts synthesis (the reader passes one tied to the client disconnecting).
// Resolves the wav path (caller deletes it).
function sayToWav({ voice, text, rate, signal } = {}) {
  return new Promise((resolve, reject) => {
    const out = path.join(os.tmpdir(), `hk_say_${process.pid}_${nextId++}.wav`);
    const args = ["--data-format=LEI16@22050", "-o", out];
    if (voice) args.push("-v", voice);
    if (rate) args.push("-r", String(Math.round(Number(rate) * 175)));
    const proc = spawn("say", args, signal ? { signal } : undefined);
    const fail = (e) => { fs.unlink(out, () => {}); reject(e); };
    proc.on("error", fail);
    proc.stdin.on("error", () => { /* say died before reading — reported via close/error */ });
    proc.stdin.write(text);
    proc.stdin.end();
    proc.on("close", (code) => (code === 0 ? resolve(out) : fail(new Error(`say exited ${code}`))));
  });
}

// Synthesize one chunk on a neural engine (kokoro / qwen3) to a wav file.
// Exported for the reader (server/speech.js) to play per-sentence. Caller deletes.
async function synthToWav({ engine, voice, text, speed }) {
  const reply = await requestEngine(engine, enginePayload(engine, voice, cleanSpeechText(text), speed));
  return reply.wav_path;
}

// Fixed preset voices (no cloning). value = "<engine>:<voiceId>"; the engine
// prefix tells the daemon which synthesizer to use. Labels are shown in the
// settings dropdown and the /voice autocomplete is engine-agnostic.
const VOICE_CATALOG = [
  // Kokoro (light & fast) — Mandarin presets (lang code 'z')
  { value: "kokoro:zf_xiaoxiao", engine: "kokoro", label: "Xiaoxiao · Female, Mandarin (Kokoro)", gender: "female" },
  { value: "kokoro:zf_xiaoyi", engine: "kokoro", label: "Xiaoyi · Female, Mandarin (Kokoro)", gender: "female" },
  { value: "kokoro:zf_xiaobei", engine: "kokoro", label: "Xiaobei · Female, Mandarin (Kokoro)", gender: "female" },
  { value: "kokoro:zf_xiaoni", engine: "kokoro", label: "Xiaoni · Female, Mandarin (Kokoro)", gender: "female" },
  { value: "kokoro:zm_yunxi", engine: "kokoro", label: "Yunxi · Male, Mandarin (Kokoro)", gender: "male" },
  { value: "kokoro:zm_yunjian", engine: "kokoro", label: "Yunjian · Male, Mandarin (Kokoro)", gender: "male" },
  { value: "kokoro:zm_yunyang", engine: "kokoro", label: "Yunyang · Male, Mandarin (Kokoro)", gender: "male" },
  { value: "kokoro:zm_yunxia", engine: "kokoro", label: "Yunxia · Male, Mandarin (Kokoro)", gender: "male" },
  // Kokoro English presets — American (lang 'a') + British (lang 'b')
  { value: "kokoro:af_heart", engine: "kokoro", label: "Heart · US Female (Kokoro)", gender: "female" },
  { value: "kokoro:af_bella", engine: "kokoro", label: "Bella · US Female (Kokoro)", gender: "female" },
  { value: "kokoro:am_michael", engine: "kokoro", label: "Michael · US Male (Kokoro)", gender: "male" },
  { value: "kokoro:am_fenrir", engine: "kokoro", label: "Fenrir · US Male (Kokoro)", gender: "male" },
  { value: "kokoro:bf_emma", engine: "kokoro", label: "Emma · UK Female (Kokoro)", gender: "female" },
  { value: "kokoro:bm_george", engine: "kokoro", label: "George · UK Male (Kokoro)", gender: "male" },
];

// ── Qwen3-TTS designed voices ──────────────────────────────────────────────
// A "voice" here is a PERSONA described in words — nobody's real voice, which is the
// point for AI-generated presenters. The daemon designs it once (VoiceDesign speaks
// QWEN3_REF_TEXT in that voice) and clones that reference for every line, so a persona
// sounds the same across clips. Built-ins below; <DATA_DIR>/tts-voices.json adds or
// overrides by id:
//   { "my_host": { "label": "My host · Female", "language": "Chinese", "gender": "female",
//                  "description": "A calm female host in her thirties, …" } }
// The reference clip is named after a hash of description + language + sentence, so
// editing a description re-designs the voice instead of reusing the old clip.
const QWEN3_PERSONAS = {
  anchor_f: { label: "Anchor · Female, Mandarin (Qwen3 designed)", language: "Chinese", gender: "female",
    description: "一位二十八岁左右的女性新闻主播，普通话标准，声音温和清晰、有亲和力，语速平稳，吐字干净。" },
  anchor_m: { label: "Anchor · Male, Mandarin (Qwen3 designed)", language: "Chinese", gender: "male",
    description: "一位三十五岁左右的男性主持人，普通话标准，声音沉稳、略带磁性，语速适中，吐字清晰。" },
  host_en_f: { label: "Host · US Female (Qwen3 designed)", language: "English", gender: "female",
    description: "A warm, clear female presenter in her late twenties with a neutral American accent, friendly and confident, speaking at a steady pace." },
  host_en_m: { label: "Host · US Male (Qwen3 designed)", language: "English", gender: "male",
    description: "A calm, articulate male narrator in his thirties with a neutral American accent and a warm, low voice, speaking at a measured pace." },
};
const QWEN3_REF_TEXT = {
  Chinese: "大家好，欢迎收看今天的节目。接下来，我会用几分钟的时间，把今天最值得关注的几件事情，跟大家仔细讲一讲。",
  English: "Hello everyone, and welcome. Over the next few minutes, I'll walk you through the stories that matter most today, one at a time.",
};
const QWEN3_VOICES_FILE = path.join(config.DATA_DIR, "tts-voices.json");
const QWEN3_REF_DIR = path.join(config.DATA_DIR, "tts-voices");

function qwen3Personas() {
  let user = {};
  try { user = JSON.parse(fs.readFileSync(QWEN3_VOICES_FILE, "utf-8")) || {}; } catch { /* none / unreadable → built-ins only */ }
  const out = { ...QWEN3_PERSONAS };
  for (const [id, p] of Object.entries(user)) {
    if (/^[\w-]+$/.test(id) && p && typeof p.description === "string" && p.description.trim()) out[id] = p;
  }
  return out;
}

// Preset + persona voices, re-read each call so an edited tts-voices.json shows up
// without a restart.
function voiceCatalog() {
  const personas = Object.entries(qwen3Personas()).map(([id, p]) => ({
    value: `qwen3:${id}`, engine: "qwen3", label: p.label || `${id} (Qwen3 designed)`, gender: p.gender || "",
  }));
  return [...VOICE_CATALOG, ...personas];
}

// The daemon request for one line. qwen3 carries the persona and where its designed
// reference clip lives (or is to be written).
function enginePayload(engine, voice, text, speed) {
  const payload = { engine, voice, text, speed: speed || 1 };
  if (engine === "qwen3") {
    const all = qwen3Personas();
    const p = all[voice];
    if (!p) throw new Error(`Unknown Qwen3 voice "${voice}". Known: ${Object.keys(all).join(", ")} (add more in ${QWEN3_VOICES_FILE})`);
    const language = p.language || "Auto";
    const refText = p.refText || QWEN3_REF_TEXT[language] || QWEN3_REF_TEXT.English;
    const hash = crypto.createHash("sha256").update(`${p.description}\n${language}\n${refText}`).digest("hex").slice(0, 10);
    payload.design = { instruct: p.description, language, ref_text: refText, ref_wav: path.join(QWEN3_REF_DIR, `${voice}-${hash}.wav`) };
  }
  return payload;
}

// ── Daemons ────────────────────────────────────────────────────────────────
// One copy of tts_engine.py per Python interpreter: the shared heykoko venv (Kokoro)
// and, when installed, the dedicated Qwen3-TTS venv (config.qwenTtsPython — it cannot
// share the first, see config.js). Each copy reports the engines that import in ITS
// interpreter; a request goes to whichever daemon has that engine. Persistent, so the
// slow-to-load models stay warm between requests.
let nextId = 1;
function makeDaemon(python, extraEnv = {}) {
  let proc = null;
  let starting = null;      // Promise<Set> of the engines this daemon reported
  let engines = new Set();
  const pending = new Map(); // id → { resolve, reject, timer }
  let stdoutBuf = "";

  function kill() {
    if (proc) { try { proc.kill(); } catch { /* already dead */ } }
    proc = null;
    starting = null;
    engines = new Set();
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
    if (msg.ready) { engines = new Set(msg.engines || []); return; }
    const id = msg.id;
    if (id == null || !pending.has(id)) return;
    const { resolve, reject, timer } = pending.get(id);
    clearTimeout(timer);
    pending.delete(id);
    if (msg.ok) resolve(msg);
    else reject(new Error(msg.error || "tts failed"));
  }

  // Spawn (once) and wait for the {ready} line listing the engines that imported.
  function ensure() {
    if (starting) return starting;
    starting = new Promise((resolve) => {
      const script = path.join(__dirname, "tts_engine.py");
      let p;
      try {
        p = spawn(python, [script], { env: { ...process.env, PYTHONUNBUFFERED: "1", ...extraEnv } });
      } catch (e) {
        console.warn(`[tts] failed to spawn ${python}: ${e.message}`);
        resolve(new Set());
        return;
      }
      proc = p;
      let settled = false;
      const ready = () => { if (!settled) { settled = true; resolve(engines); } };
      p.stdout.setEncoding("utf-8");
      p.stdout.on("data", (chunk) => {
        stdoutBuf += chunk;
        let nl;
        while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
          const line = stdoutBuf.slice(0, nl);
          stdoutBuf = stdoutBuf.slice(nl + 1);
          handleLine(line);
          if (line.includes('"ready"')) ready();
        }
      });
      p.stderr.on("data", (d) => {
        const s = d.toString().trim();
        if (s) console.log(`[tts_engine] ${s}`);
      });
      p.on("error", (e) => {
        console.warn(`[tts] daemon error (${python}): ${e.message}`);
        kill();
        ready();
      });
      p.on("close", (code) => {
        console.log(`[tts] daemon exited (code ${code}, ${python})`);
        const wasStarting = !settled;
        kill();
        if (wasStarting) ready();
      });
      // Don't hang forever if an import wedges — give it generous headroom.
      setTimeout(ready, 60000);
    });
    return starting;
  }

  function request(payload, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (!proc || !proc.stdin.writable) {
        reject(new Error("tts daemon not running"));
        return;
      }
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("tts request timed out"));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      proc.stdin.write(JSON.stringify({ id, ...payload }) + "\n");
    });
  }

  return { ensure, request };
}

const daemons = [makeDaemon(config.ttsPython)];
if (config.qwenTtsPython && config.qwenTtsPython !== config.ttsPython) {
  daemons.push(makeDaemon(config.qwenTtsPython, { QWEN3_TTS_DIR: config.qwenTtsModels }));
}

// Start every daemon; resolves to the union of their engines.
async function ensureDaemons() {
  const sets = await Promise.all(daemons.map((d) => d.ensure()));
  return new Set(sets.flatMap((s) => [...s]));
}

// Route a request to the daemon that has `engine`. qwen3 gets a long timeout: its first
// line loads two 1.7B models (and designs the persona) before it speaks.
async function requestEngine(engine, payload, timeoutMs) {
  const sets = await Promise.all(daemons.map((d) => d.ensure()));
  const i = sets.findIndex((s) => s.has(engine));
  if (i < 0) throw new Error(`TTS engine "${engine}" unavailable`);
  return daemons[i].request(payload, timeoutMs || (engine === "qwen3" ? 900000 : 180000));
}

// GET /api/tts-voices → preset voices for engines that are actually available.
async function listTtsVoices(res) {
  const engines = await ensureDaemons();
  const voices = voiceCatalog().filter((v) => engines.has(v.engine));
  sendJson(res, 200, {
    voices,
    available: voices.length > 0,
    engines: [...engines],
  });
}

// POST /api/tts { text, voice, rate } → { audio: base64, mime }. Output is AAC
// (ffmpeg) regardless of engine; falls back to the raw wav if ffmpeg is
// missing. Routes by the voice's engine prefix: "say:" → macOS say, otherwise
// the neural daemon (kokoro).
async function synthesize(req, res) {
  let srcPath, aacPath;
  try {
    const body = await readBody(req);
    const text = cleanSpeechText(body.text || "");
    const voiceVal = body.voice || "";
    const rate = Number(body.rate) || 1;
    if (!text) { sendJson(res, 400, { error: "text is required" }); return; }

    const known = voiceCatalog().find((v) => v.value === voiceVal);
    const sep = voiceVal.indexOf(":");
    const engine = known ? known.engine : (sep > 0 ? voiceVal.slice(0, sep) : "say");
    const voice = known ? voiceVal.slice(voiceVal.indexOf(":") + 1)
                        : (sep > 0 ? voiceVal.slice(sep + 1) : voiceVal);

    if (engine === "say") {
      srcPath = await sayToWav({ voice, text, rate });
    } else {
      const engines = await ensureDaemons();
      if (!engines.has(engine)) {
        sendJson(res, 503, { error: `TTS engine "${engine}" is not available. See README for setup.` });
        return;
      }
      const reply = await requestEngine(engine, enginePayload(engine, voice, text, rate),
        Number(body.timeout) > 0 ? Math.max(30000, Number(body.timeout) * 1000) : undefined);
      srcPath = reply.wav_path;
    }

    // Prefer AAC (≈5× smaller than wav/aiff — matters because the clip is
    // base64'd into the persisted chat). Fall back to the source if ffmpeg fails.
    aacPath = await transcodeToAac(srcPath);
    const b64 = fs.readFileSync(aacPath || srcPath).toString("base64");
    const mime = aacPath ? "audio/aac" : "audio/wav";
    // File it in the gallery like an image or a clip: it is a generated artifact, and
    // keeping it out of the chat store is the whole point. Best-effort as everywhere.
    let mediaIds;
    try {
      mediaIds = gallery.recordMany([{ kind: "audio", b64, mime, meta: {
        model: `${engine}:${voice}`, prompt: text,
        conversationId: body.conversationId, msgId: body.msgId,
      } }]);
    } catch (err) { console.error(`[gallery] tts tee failed: ${err.message}`); }
    sendJson(res, 200, { audio: b64, mediaIds, mime });
  } catch (e) {
    if (!res.headersSent) sendJson(res, 500, { error: e.message });
  } finally {
    if (srcPath) fs.unlink(srcPath, () => {});
    if (aacPath) fs.unlink(aacPath, () => {});
  }
}

module.exports = { listTtsVoices, synthesize, synthToWav, sayToWav };