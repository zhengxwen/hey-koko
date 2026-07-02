// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

const { execFile, spawn } = require("child_process");
const fs = require("fs");
const { sendJson, readBody, cleanSpeechText } = require("./utils");
const { synthToWav } = require("./tts");

let sayProcess = null;   // active macOS `say` child
let playProcess = null;  // active afplay child (for neural-engine playback)
let sayStopped = false;

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

function killProcs() {
  if (sayProcess) { try { sayProcess.kill(); } catch { /* gone */ } sayProcess = null; }
  if (playProcess) { try { playProcess.kill(); } catch { /* gone */ } playProcess = null; }
}

// Play an audio file on the server's speakers. Used for neural engines,
// mirroring how `say` plays directly — keeps the reader server-side. Per platform:
//   macOS   → afplay
//   Windows → PowerShell's built-in Media.SoundPlayer (plays 16-bit PCM WAV
//             synchronously; no extra dependency — the neural engines emit WAV)
//   Linux   → ffplay if present (error handler resolves silently otherwise)
// Kept as a child process so killProcs() (stop button) can interrupt playback.
function playFile(p) {
  return new Promise((resolve) => {
    if (process.platform === "win32") {
      playProcess = spawn("powershell", [
        "-NoProfile", "-NonInteractive", "-Command",
        `(New-Object Media.SoundPlayer '${p.replace(/'/g, "''")}').PlaySync()`,
      ]);
    } else if (process.platform === "darwin") {
      playProcess = spawn("afplay", [p]);
    } else {
      playProcess = spawn("ffplay", ["-nodisp", "-autoexit", "-loglevel", "quiet", p]);
    }
    playProcess.on("close", () => { playProcess = null; resolve(); });
    playProcess.on("error", () => { playProcess = null; resolve(); });
  });
}

// POST /api/speak — read a message aloud on the server, sentence by sentence,
// streaming NDJSON {index,speaking|done} so the client can highlight along.
// Routes by the selected voice's engine prefix: "say:"/none → macOS say (plays
// directly); "kokoro:" → synthesize each sentence then afplay it.
async function speak(req, res) {
  try {
    const body = await readBody(req);
    const { sentences, voice, rate } = body;
    if (!sentences || !sentences.length) {
      sendJson(res, 400, { error: "sentences is required" });
      return;
    }
    killProcs();

    const sep = (voice || "").indexOf(":");
    const engine = sep > 0 ? voice.slice(0, sep) : "say";
    const voiceId = sep > 0 ? voice.slice(sep + 1) : (voice || "");

    res.writeHead(200, {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
    });

    sayStopped = false;
    req.on("close", () => { sayStopped = true; killProcs(); });

    for (let i = 0; i < sentences.length; i++) {
      if (sayStopped) break;
      const clean = cleanSpeechText(sentences[i]);
      if (!clean) {
        res.write(JSON.stringify({ index: i, done: true }) + "\n");
        continue;
      }

      res.write(JSON.stringify({ index: i, speaking: true }) + "\n");

      if (engine === "say") {
        await new Promise((resolve) => {
          const args = [];
          if (voiceId) args.push("-v", voiceId);
          if (rate) args.push("-r", String(Math.round(Number(rate) * 175)));
          sayProcess = spawn("say", args);
          sayProcess.stdin.write(clean);
          sayProcess.stdin.end();
          sayProcess.on("close", () => { sayProcess = null; resolve(); });
          sayProcess.on("error", () => { sayProcess = null; resolve(); });
        });
      } else {
        // Neural engine: synthesize this sentence to a wav, then play it.
        try {
          const wav = await synthToWav({ engine, voice: voiceId, text: clean, speed: Number(rate) || 1 });
          if (!sayStopped) await playFile(wav);
          fs.unlink(wav, () => {});
        } catch {
          // Engine unavailable / failed — skip this sentence (keeps highlighting going).
        }
      }

      if (sayStopped) break;
      res.write(JSON.stringify({ index: i, done: true }) + "\n");
    }

    res.write(JSON.stringify({ finished: true }) + "\n");
    res.end();
  } catch (e) {
    if (!res.headersSent) sendJson(res, 500, { error: e.message });
    else res.end();
  }
}

function stopSay(res) {
  sayStopped = true;
  killProcs();
  sendJson(res, 200, { ok: true });
}

module.exports = { listSystemVoices, speak, stopSay };