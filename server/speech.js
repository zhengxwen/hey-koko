// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

const { execFile } = require("child_process");
const fs = require("fs");
const { sendJson, readBody, cleanSpeechText } = require("./utils");
const { synthToWav, sayToWav } = require("./tts");

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

    let wav;
    if (engine === "say") {
      // The client gave up on this sentence (skipped/stopped) → stop synthesizing it.
      // Watch `res`, not `req`: once readBody has consumed the body, `req` is already
      // closed (Node ≥16 autoDestroy), so its "close" never fires on a later disconnect.
      const ac = new AbortController();
      const onClose = () => ac.abort();
      res.on("close", onClose);
      try { wav = await sayToWav({ voice: voiceId, text, rate, signal: ac.signal }); }
      finally { res.off("close", onClose); }
    } else {
      wav = await synthToWav({ engine, voice: voiceId, text, speed: rate });
    }
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
