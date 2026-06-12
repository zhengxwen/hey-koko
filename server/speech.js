const { execFile, spawn } = require("child_process");
const { sendJson, readBody } = require("./utils");

let sayProcess = null;
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

async function speakWithSay(req, res) {
  try {
    const body = await readBody(req);
    const { sentences, voice, rate } = body;
    if (!sentences || !sentences.length) {
      sendJson(res, 400, { error: "sentences is required" });
      return;
    }
    // Stop any ongoing speech
    if (sayProcess) {
      sayProcess.kill();
      sayProcess = null;
    }

    // 去除 Emoji
    const emojiRegex = /[\u{1F600}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}\u{1F1E0}-\u{1F1FF}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F7E0}-\u{1F7FF}\u{231A}-\u{231B}\u{23E9}-\u{23F3}\u{23F8}-\u{23FA}\u{25AA}-\u{25AB}\u{25B6}\u{25C0}\u{25FB}-\u{25FE}\u{2934}-\u{2935}\u{2B05}-\u{2B07}\u{2B1B}-\u{2B1C}\u{2B50}\u{2B55}\u{3030}\u{303D}\u{3297}\u{3299}]/gu;

    res.writeHead(200, {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
    });

    sayStopped = false;
    req.on("close", () => { sayStopped = true; });

    for (let i = 0; i < sentences.length; i++) {
      if (sayStopped) break;
      const cleanSentence = sentences[i]
        .replace(emojiRegex, "")
        .replace(/([。？！；：.!?;:])\1+/g, "$1")
        .trim();
      if (!cleanSentence) {
        res.write(JSON.stringify({ index: i, done: true }) + "\n");
        continue;
      }

      res.write(JSON.stringify({ index: i, speaking: true }) + "\n");

      await new Promise((resolve) => {
        const args = [];
        if (voice) args.push("-v", voice);
        if (rate) args.push("-r", String(Math.round(Number(rate) * 175)));
        sayProcess = spawn("say", args);
        sayProcess.stdin.write(cleanSentence);
        sayProcess.stdin.end();
        sayProcess.on("close", () => { sayProcess = null; resolve(); });
        sayProcess.on("error", () => { sayProcess = null; resolve(); });
      });

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
  if (sayProcess) {
    sayProcess.kill();
    sayProcess = null;
  }
  sendJson(res, 200, { ok: true });
}

module.exports = { listSystemVoices, speakWithSay, stopSay };
