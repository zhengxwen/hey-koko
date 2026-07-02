// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

const { execFile, spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { sendJson, readBody, cleanSpeechText } = require("./utils");
const { synthToWav } = require("./tts");

let nextSpeakId = 1; // temp-file uniqueness across concurrent (prefetched) requests

function listSystemVoices(res) {
  execFile("say", ["-v", "?"], { encoding: "utf-8" }, (err, stdout) => {
    if (err) {
      sendJson(res, 200, { voices: [] });
      return;
    }
    const voices = stdout.trim().split("\n").map((line) => {
      const match = line.match(/^(.+?)\s{2,}(\S+)/);
      if (!match) return null;
      return { name: match[1].trim(), lang: match[2].trim() };
    }).filter(Boolean);
    sendJson(res, 200, { voices });
  });
}

// Synthesize via macOS `say` to a temp WAV (LEI16 — browsers can't play the
// default AIFF). The child is killed if the client disconnects mid-synthesis.
function sayToWavFile(voice, text, rate, req) {
  return new Promise((resolve, reject) => {
    const out = path.join(os.tmpdir(), `hk_speak_${process.pid}_${nextSpeakId++}.wav`);
    const args = ["--data-format=LEI16@22050", "-o", out];
    if (voice) args.push("-v", voice);
    if (rate) args.push("-r", String(Math.round(Number(rate) * 175)));
    const proc = spawn("say", args);
    const onClose = () => { try { proc.kill(); } catch { /* gone */ } };
    req.on("close", onClose);
    proc.on("error", (e) => { req.off("close", onClose); reject(e); });
    proc.stdin.write(text);
    proc.stdin.end();
    proc.on("close", (code) => {
      req.off("close", onClose);
      if (code === 0) resolve(out);
      else { fs.unlink(out, () => {}); reject(new Error(`say exited ${code}`)); }
    });
  });
}

// POST /api/speak-audio { text, voice, rate } → one sentence's audio as a raw
// WAV response (204 if nothing speakable). The reader plays IN THE BROWSER:
// the client fetches sentences through here in a prefetch pipeline (synthesize
// i+1 while i plays), so the server never touches its own speakers — works
// when frontend and backend run on different machines. Routes by the voice's
// engine prefix: "say:"/none → macOS say, otherwise the neural daemon (kokoro).
async function speakAudio(req, res) {
  try {
    const body = await readBody(req);
    const text = cleanSpeechText(body.text || "");
    if (!text) {
      res.writeHead(204);
      res.end();
      return;
    }
    const voiceVal = body.voice || "";
    const rate = Number(body.rate) || 1;
    const sep = voiceVal.indexOf(":");
    const engine = sep > 0 ? voiceVal.slice(0, sep) : "say";
    const voiceId = sep > 0 ? voiceVal.slice(sep + 1) : voiceVal;

    const wav = engine === "say"
      ? await sayToWavFile(voiceId, text, rate, req)
      : await synthToWav({ engine, voice: voiceId, text, speed: rate });
    const buf = fs.readFileSync(wav);
    fs.unlink(wav, () => {});
    res.writeHead(200, {
      "Content-Type": "audio/wav",
      "Content-Length": buf.length,
      "Cache-Control": "no-store",
    });
    res.end(buf);
  } catch (e) {
    if (!res.headersSent) sendJson(res, 500, { error: e.message });
    else res.end();
  }
}

module.exports = { listSystemVoices, speakAudio };
