// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

// Deterministic Simplified<->Traditional Chinese conversion, used to normalize a
// YouTube transcript to the variant the user's PROMPT LANGUAGE asks for (zh = Simplified,
// zh-Hant/zh-TW = Traditional) — subtitles arrive in either variant (or a whisper mix),
// and asking the formatting LLM to convert is unreliable. This runs as a final,
// deterministic pass AFTER formatting.
//
// Two tiers, best available wins:
//   1. opencc CLI (if installed) → phrase-accurate, disambiguates one-to-many S->T
//      (面/麵, 发/髮, 里/裡…). Detected once at first use; `brew install opencc`.
//   2. Embedded character tables (chinese-convert-data.js, from OpenCC's dictionaries) →
//      zero-dependency fallback. Traditional->Simplified is near-lossless; Simplified->
//      Traditional is char-level best-effort (picks each char's default target).

const { spawn, execFile } = require("child_process");
const { T2S_PAIRS, S2T_PAIRS } = require("./chinese-convert-data");

// ---- embedded char maps (built lazily from the packed pair strings) ---------
let _t2s = null, _s2t = null;
function buildMap(pairs) {
  const m = new Map();
  for (const tok of pairs.split(" ")) { const cp = [...tok]; if (cp.length === 2) m.set(cp[0], cp[1]); }
  return m;
}
function charConvert(text, map) {
  // iterate by code point so surrogate-pair CJK-ext chars map correctly
  let out = "";
  for (const ch of String(text)) out += map.get(ch) || ch;
  return out;
}

// ---- opencc CLI detection (best-effort, cached) -----------------------------
let _openccPath = null;      // resolved path once detected, or "" if unavailable
let _detectPromise = null;
function findOpencc() {
  const candidates = ["/opt/homebrew/bin/opencc", "/usr/local/bin/opencc", "/usr/bin/opencc", "opencc"];
  return new Promise((resolve) => {
    let i = 0;
    const tryNext = () => {
      if (i >= candidates.length) return resolve("");
      const cmd = candidates[i++];
      execFile(cmd, ["--version"], { timeout: 5000 }, (err) => {
        // opencc --version prints to stderr and may exit non-zero on some builds; treat
        // "spawned at all" (no ENOENT) as available.
        if (err && (err.code === "ENOENT" || err.code === "EACCES")) return tryNext();
        resolve(cmd);
      });
    };
    tryNext();
  });
}
function ensureDetect() {
  if (_detectPromise) return _detectPromise;
  _detectPromise = findOpencc().then((p) => {
    _openccPath = p;
    // Startup visibility, same spirit as parse-file/url-fetch: the "not found" line
    // carries the install hint so the console answers "how do I upgrade S/T conversion?".
    const hint = process.platform === "darwin" ? "brew install opencc"
      : process.platform === "win32" ? "get opencc.exe from https://github.com/BYVoid/OpenCC/releases and add it to PATH"
      : "install the opencc package";
    console.log(p ? `[chinese-convert] opencc detected at ${p} (phrase-accurate S/T)` :
                    `[chinese-convert] opencc not found — using built-in character tables (S→T is char-level; for phrase-accurate conversion: ${hint})`);
    return p;
  });
  return _detectPromise;
}
// Kick off detection at load so the first conversion doesn't pay the probe latency.
ensureDetect();

function openccConvert(text, config) {
  return new Promise((resolve, reject) => {
    const proc = spawn(_openccPath, ["-c", config], { timeout: 30000 });
    let out = "", err = "";
    proc.stdout.on("data", (d) => { out += d.toString("utf-8"); });
    proc.stderr.on("data", (d) => { err += d.toString("utf-8"); });
    proc.on("error", reject);
    proc.on("close", (code) => { code === 0 ? resolve(out) : reject(new Error(err || `opencc exit ${code}`)); });
    proc.stdin.end(Buffer.from(String(text), "utf-8"));
  });
}

// Map the prompt language to a conversion direction. Returns null for languages that
// need no S/T normalization (English, unset, or an unrecognized code).
function directionFor(lang) {
  const l = String(lang || "").toLowerCase();
  if (l === "zh" || l === "zh-hans" || l === "zh-cn" || l === "zh-sg") return "toSimplified";
  if (l === "zh-hant" || l === "zh-tw" || l === "zh-hk" || l === "zh-mo") return "toTraditional";
  return null;
}

// Convert `text` to the Simplified/Traditional variant implied by the prompt `lang`.
// No-op (returns text unchanged) for non-Chinese/unset languages. opencc when present,
// else the embedded tables. Any opencc failure falls back to the tables — never throws.
async function convertChinese(text, lang) {
  const dir = directionFor(lang);
  if (!dir || !text) return text;
  await ensureDetect();
  if (_openccPath) {
    try { return await openccConvert(text, dir === "toSimplified" ? "t2s.json" : "s2t.json"); }
    catch { /* fall through to the built-in tables */ }
  }
  if (dir === "toSimplified") { _t2s = _t2s || buildMap(T2S_PAIRS); return charConvert(text, _t2s); }
  _s2t = _s2t || buildMap(S2T_PAIRS); return charConvert(text, _s2t);
}

// Synchronous character-table-only variant (no opencc), for callers that can't await.
function convertChineseSync(text, lang) {
  const dir = directionFor(lang);
  if (!dir || !text) return text;
  if (dir === "toSimplified") { _t2s = _t2s || buildMap(T2S_PAIRS); return charConvert(text, _t2s); }
  _s2t = _s2t || buildMap(S2T_PAIRS); return charConvert(text, _s2t);
}

module.exports = { convertChinese, convertChineseSync, directionFor };
