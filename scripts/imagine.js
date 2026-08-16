#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng
"use strict";
// Terminal /imagine — a standalone CLI over the running hey-koko server, so other
// programs can drive batch generation without a browser.
//
// It speaks the same contract the browser does: resolve "-m <canonical-id>" against
// /api/comfy-models, POST /api/generate-comfy, write what comes back. Every recipe
// decision (companions, sizing, frame-grid snapping, precision swap, gallery filing)
// stays server-side, exactly as it is for the UI — this file adds no model knowledge.
//
// Requires: the hey-koko server running (npm start) and ComfyUI reachable from it.
//
//   node scripts/imagine.js -m minimax-h3-r2v -i ref.png -s 6 "a cat conducts an orchestra"
//   node scripts/imagine.js --batch shots.jsonl -O out/
//
// Zero dependencies (repo rule): node:http + node:fs only.

const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const https = require("node:https");

// ── server plumbing ──────────────────────────────────────────────────────────

const SERVER = process.env.HEYKOKO_URL
  || `http://127.0.0.1:${process.env.HEYKOKO_PORT || 1314}`;

// One request. node:http rather than fetch on purpose: undici caps headers/body at
// 300 s by default, and a video render legitimately holds the response open for far
// longer than that — the browser has no such cap, and neither may we.
function request(method, urlPath, { body, headers, server } = {}) {
  const base = new URL(server || SERVER);
  const lib = base.protocol === "https:" ? https : http;
  const opts = {
    method,
    hostname: base.hostname,
    port: base.port || (base.protocol === "https:" ? 443 : 80),
    path: urlPath,
    headers: { ...(headers || {}) },
  };
  if (body != null) opts.headers["Content-Length"] = Buffer.byteLength(body);
  return new Promise((resolve, reject) => {
    const req = lib.request(opts, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.setTimeout(0);             // a render may run for hours; no client-side deadline
    req.on("error", reject);
    if (body != null) req.write(body);
    req.end();
  });
}

const getJson = (p, server) => request("GET", p, { server }).then((r) => r.json);
const postJson = (p, obj, server) =>
  request("POST", p, { body: JSON.stringify(obj), headers: { "Content-Type": "application/json" }, server });

// ── /imagine flag parsing (mirrors public/js/image-gen.js parseImagineCommand) ─

const SIZE_PRESETS = {
  "480p": "854x480", "480p-portrait": "480x854",
  "720p": "1280x720", "720p-portrait": "720x1280",
  "1080p": "1920x1080", "1080p-portrait": "1080x1920",
  "ultrawide-small": "896x384", ultrawide: "1792x768",
  "2k": "2560x1440", "2k-portrait": "1440x2560",
  "4k": "3840x2160", "4k-portrait": "2160x3840",
};

function parseSize(val) {
  const preset = SIZE_PRESETS[String(val).toLowerCase()];
  const spec = preset || val;
  const m = String(spec).match(/^(\d+)x(\d+)$/i);
  if (!m) throw new Error(`unknown size "${val}" (presets: ${Object.keys(SIZE_PRESETS).join(", ")}, or WxH)`);
  const w = +m[1], h = +m[2];
  if (w < 256 || w > 4096 || h < 256 || h > 4096) throw new Error(`size ${w}x${h} out of range (256-4096)`);
  return { width: w, height: h };
}

// Parse a literal "/imagine …" line into a task. Kept in step with the browser's
// parser so a command copied out of the chat means the same thing here.
function parseImagineLine(line) {
  let rest = String(line).replace(/^\/imagine\b\s*/, "").trim();
  const task = { prompt: "", count: 1, options: {}, negative: "", enhance: false };

  const batch = rest.match(/^(\d+)x\s+([\s\S]+)$/);
  if (batch) {
    const n = parseInt(batch[1], 10);
    if (n < 1 || n > 8) throw new Error(`batch count ${n} out of range (1-8)`);
    task.count = n;
    rest = batch[2];
  }
  // --no eats to end of input, so it is peeled off before the flag loop (same as the UI).
  const no = rest.match(/--no\s+([\s\S]+)$/);
  if (no) { task.negative = no[1].trim(); rest = rest.slice(0, no.index).trim(); }

  while (rest.startsWith("--") || /^-e\b/.test(rest) || /^-[ms]\s/.test(rest)) {
    const take = (re, what) => {
      const m = rest.match(re);
      if (!m) throw new Error(`${what} needs a value`);
      rest = rest.slice(m[0].length).trim();
      return m[1];
    };
    if (/^(--enhance|-e)\b/.test(rest)) {
      task.enhance = true;
      rest = rest.replace(/^(--enhance|-e)\s*/, "").trim();
    } else if (/^--size\s/.test(rest)) {
      Object.assign(task.options, parseSize(take(/^--size\s+(\S+)\s*/, "--size")));
    } else if (/^--steps\s/.test(rest)) {
      const n = parseInt(take(/^--steps\s+(\S+)\s*/, "--steps"), 10);
      if (isNaN(n) || n < 1 || n > 100) throw new Error("--steps must be 1-100");
      task.options.steps = n;
    } else if (/^(?:-m|--model)\s/.test(rest)) {
      task.model = take(/^(?:-m|--model)\s+(\S+)\s*/, "--model").toLowerCase();
    } else if (/^(?:-s|--second)\s/.test(rest)) {
      const n = parseFloat(take(/^(?:-s|--second)\s+(\S+)\s*/, "--second").replace(/s$/i, ""));
      if (isNaN(n) || n <= 0 || n > 600) throw new Error("--second must be 0-600");
      task.options.lengthSec = n;
    } else if (/^--seed\s/.test(rest)) {
      const n = parseInt(take(/^--seed\s+(\S+)\s*/, "--seed"), 10);
      if (isNaN(n) || n < 0 || n > 2147483647) throw new Error("--seed out of range");
      task.options.seed = n;
    } else if (/^--quality\s/.test(rest)) {
      task.options.quality = take(/^--quality\s+(\S+)\s*/, "--quality");
    } else if (/^--voice\s/.test(rest)) {
      task.options.ttsVoice = take(/^--voice\s+(\S+)\s*/, "--voice");
    } else {
      throw new Error(`unknown flag ${rest.match(/^(\S+)/)[1]}`);
    }
  }
  task.prompt = rest.trim();
  return task;
}

// ── CLI argument parsing ─────────────────────────────────────────────────────

const USAGE = `Terminal /imagine — batch media generation against a running hey-koko server.

Usage
  imagine.js [options] <prompt words...>
  imagine.js --cmd "/imagine -m minimax-h3-r2v -s 6 a cat dances"
  imagine.js --batch shots.jsonl [options]
  imagine.js --add clip.mp4 photo.jpg          file existing media, no generation
  imagine.js --list-models [filter]

Model
  -m, --model <id[@tier]>  canonical model id, e.g. minimax-h3-r2v, minimax-h3-r2v@int8
                           (prefix/substring accepted; ambiguity is refused, never guessed)
      --precision <tier>   same as @tier (fp8 / int8 / bf16 / nvfp4 / …)

Inputs
  -i, --image <path>       reference/first-frame image; repeat for more (r2v takes up to 9)
      --video <path>       source or reference video
      --audio <path>       source or reference audio

Generation
  -s, --second <n>         clip duration in seconds (server snaps to the model's frame grid)
      --length <n>         frame count instead of --second
      --size <WxH|preset>  ${Object.keys(SIZE_PRESETS).join(" / ")}
      --seed <n>           fixed seed (a batch uses seed, seed+1, …)
      --steps <n>
      --no <text>          negative prompt (ignored by models without a negative branch)
  -n, --count <n>          render N variations of this prompt (1-8)
  -e, --enhance            rewrite the prompt with an LLM first (--enhance-model to pick it)

Upscale / sharpen tools (-m video-enhance --video clip.mp4, or -m image-upscale -i pic.png)
      --upscale <m>        upscale model: auto (default) | off | a filename from --list-models
      --upscale-to <px>    target LONG side (1920 / 2560 / 3840); default is 2x, capped at 2160
      --sharpen <level>    off | light | medium | strong  (works with --upscale off: filter only)
      --upscale-denoise <n>  0-1 (or a percentage) — clean up before upscaling
      --restore <m>        denoise/restore model: auto | off | a filename
      --opt k=v            any ⚙ option verbatim, repeatable. e.g. --opt noAudio=true
                           --opt videoCodec=h265 --opt easyCache=true --opt h3RefSize=512

Output
  -o, --out <path>         write here (single result); {i}/{seed}/{model} are substituted
  -O, --out-dir <dir>      directory for generated names (default: .)
  -g, --gallery            also file the result in ~/.hey-koko/gallery (off by default)
      --json               machine-readable: one JSON object per line on stdout (results,
                           --add records, --list-models rows); logs stay on stderr
  -q, --quiet              no progress output
      --dry-run            print the request that would be sent, generate nothing

Import
      --add <file...>      put existing media in the gallery AS-IS — no model, no render,
                           no re-encode. Images/video/audio/glb; duplicates are detected.

Batch
      --batch <file|->     one task per line: an "/imagine …" line, or a JSON object
                           {model,prompt,images:[],video,audio,seconds,length,size,seed,
                            steps,negative,count,out,precision,options:{}}
                           CLI options above act as defaults for every line.
      --continue-on-error  keep going after a failed task (default: stop)

Server
      --server <url>       hey-koko base URL (default $HEYKOKO_URL or 127.0.0.1:$HEYKOKO_PORT)
      --comfy-url <url>    target a specific ComfyUI worker
      --timeout <min>      render deadline; 0 = unlimited (default 240)

Exit: 0 all good, 1 usage/setup error, 2 one or more renders failed.`;

function parseArgv(argv) {
  const o = { images: [], addFiles: [], opts: {}, options: {} };
  const need = (i, flag) => {
    if (i + 1 >= argv.length) { throw new Error(`${flag} needs a value`); }
    return argv[i + 1];
  };
  const words = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "-h": case "--help": o.help = true; break;
      case "--list-models": o.listModels = true; break;
      case "-m": case "--model": o.model = need(i, a).toLowerCase(); i++; break;
      case "--precision": o.precision = need(i, a); i++; break;
      case "-i": case "--image": o.images.push(need(i, a)); i++; break;
      case "--video": o.video = need(i, a); i++; break;
      case "--audio": o.audio = need(i, a); i++; break;
      case "-s": case "--second": o.seconds = parseFloat(String(need(i, a)).replace(/s$/i, "")); i++; break;
      case "--length": o.length = parseInt(need(i, a), 10); i++; break;
      case "--size": o.size = need(i, a); i++; break;
      case "--seed": o.seed = parseInt(need(i, a), 10); i++; break;
      case "--steps": o.steps = parseInt(need(i, a), 10); i++; break;
      case "--no": o.negative = need(i, a); i++; break;
      case "-n": case "--count": o.count = parseInt(need(i, a), 10); i++; break;
      case "-e": case "--enhance": o.enhance = true; break;
      case "--enhance-model": o.enhanceModel = need(i, a); i++; break;
      // The upscale/sharpen tools' knobs. They are ordinary ⚙ options underneath, but
      // reaching them through --opt means knowing the key names, and these two models
      // are useless without them.
      case "--upscale": o.options.upscaleModel = need(i, a); i++; break;
      case "--upscale-to": o.options.upscaleTarget = parseInt(need(i, a), 10); i++; break;
      case "--sharpen": o.options.sharpen = need(i, a); i++; break;
      case "--upscale-denoise": o.options.upscaleDenoise = parseFloat(need(i, a)); i++; break;
      case "--restore": o.options.restoreModel = need(i, a); i++; break;
      case "--opt": {
        const kv = need(i, a); i++;
        const eq = kv.indexOf("=");
        if (eq < 0) throw new Error(`--opt needs key=value, got "${kv}"`);
        const k = kv.slice(0, eq), raw = kv.slice(eq + 1);
        let v = raw;
        try { v = JSON.parse(raw); } catch { /* plain string */ }
        o.options[k] = v;
        break;
      }
      case "-o": case "--out": o.out = need(i, a); i++; break;
      case "-O": case "--out-dir": o.outDir = need(i, a); i++; break;
      case "-g": case "--gallery": o.gallery = true; break;
      // Import mode. The flag's own value plus every remaining bare word are treated as
      // paths, so "--add *.mp4" works after the shell has expanded the glob.
      case "--add": o.add = true; o.addFiles.push(need(i, a)); i++; break;
      case "--json": o.json = true; break;
      case "-q": case "--quiet": o.quiet = true; break;
      case "--dry-run": o.dryRun = true; break;
      case "--cmd": o.cmd = need(i, a); i++; break;
      case "--batch": o.batch = need(i, a); i++; break;
      case "--continue-on-error": o.keepGoing = true; break;
      case "--server": o.server = need(i, a); i++; break;
      case "--comfy-url": o.comfyUrl = need(i, a); i++; break;
      case "--timeout": o.timeoutMin = parseFloat(need(i, a)); i++; break;
      default:
        if (a.startsWith("-") && a.length > 1 && !/^-\d/.test(a)) throw new Error(`unknown option ${a}`);
        words.push(a);
    }
  }
  if (o.add) o.addFiles.push(...words);   // in import mode a bare word is a path, not prompt text
  else o.prompt = words.join(" ").trim();
  o.prompt = o.prompt || "";
  return o;
}

// ── model catalogue + "-m" resolution (mirrors ollama.js resolveModelToken) ───

async function loadCatalogue(server, comfyUrl) {
  const q = comfyUrl ? `?comfyUrl=${encodeURIComponent(comfyUrl)}` : "";
  const d = await getJson(`/api/comfy-models${q}`, server);
  if (!d) throw new Error(`cannot reach the hey-koko server at ${server || SERVER} — is it running (npm start)?`);
  const rows = [];
  const add = (name, group, spec) => {
    const meta = (d.modelMeta || {})[name];
    if (!meta || !meta.id) return;      // unnamed entries are pickable in the UI only
    rows.push({
      id: meta.id, value: name, label: meta.label || name, group,
      caps: meta.caps || [], tiers: meta.prec || [], ready: meta.ready !== false, spec: spec || {},
    });
  };
  for (const n of d.models || []) add(n, "image");
  for (const m of d.editModels || []) add(m.name, "edit", m);
  for (const m of d.videoModels || []) add(m.name, m.needsVideo ? "video-in" : "video", m);
  for (const m of d.meshModels || []) add(m.name, "3d", m);
  // The upscale / restore weights are not models you generate with — they are the
  // choices for --upscale / --restore on the two enhance tools. Listed all the same:
  // without them those flags can only be filled by guessing a filename.
  const files = [
    ...(d.upscaleModels || []).map((f) => ({ group: "upscaler", file: f })),
    ...(d.restoreModels || []).map((f) => ({ group: "restore", file: f })),
  ];
  return { rows, files, raw: d };
}

function splitToken(token) {
  const s = String(token || "").trim().toLowerCase();
  const at = s.lastIndexOf("@");
  return at <= 0 ? { id: s, tier: "" } : { id: s.slice(0, at), tier: s.slice(at + 1) };
}

function matchModels(rows, partial) {
  const p = String(partial || "").trim().toLowerCase();
  if (!p) return rows.slice();
  const exact = rows.filter((m) => m.id === p);
  if (exact.length) return exact;
  const pre = rows.filter((m) => m.id.startsWith(p));
  const sub = rows.filter((m) => !m.id.startsWith(p) && (m.id.includes(p) || m.label.toLowerCase().includes(p)));
  return [...pre, ...sub];
}

// image-upscale / video-enhance need no diffusion weights, so the server offers them
// even when the checkpoint scan came back empty. A catalogue made of NOTHING but those
// means no model files were seen — nearly always an unreachable ComfyUI, not a typo.
function catalogueToolsOnly(rows) {
  return rows.length > 0 && rows.every((m) => m.caps.length > 0 && m.caps.every((c) => c === "tool"));
}

// An ambiguous prefix is never narrowed silently — picking for the caller is how a
// batch renders the wrong model for an hour.
function resolveModel(rows, token) {
  const { id, tier } = splitToken(token);
  if (!id) throw new Error("no model given (-m / --model)");
  if (!rows.length) throw new Error("the server returned no models — is ComfyUI reachable from it?");
  const hits = matchModels(rows, id);
  if (!hits.length) {
    // Suggesting "did you mean image-upscale?" for a video model would send the caller
    // hunting for a typo that isn't there — name the real cause instead.
    if (catalogueToolsOnly(rows)) {
      throw new Error(`no models are installed as far as the server can see — only the model-free tools `
        + `(${rows.map((m) => m.id).join(", ")}) came back. Is ComfyUI running and reachable from the hey-koko server?`);
    }
    const near = rows.map((m) => m.id).filter((x) => x[0] === id[0]).slice(0, 6);
    throw new Error(`unknown model "${id}"${near.length ? ` — closest: ${near.join(", ")}` : ""}\n`
      + "run with --list-models to see them all");
  }
  if (hits.length > 1 && !hits.some((m) => m.id === id)) {
    throw new Error(`"${id}" is ambiguous: ${hits.slice(0, 8).map((m) => m.id).join(", ")}`);
  }
  const hit = hits.find((m) => m.id === id) || hits[0];
  if (tier && hit.tiers.length && !hit.tiers.includes(tier)) {
    throw new Error(`${hit.id} has no ${tier} build installed (has: ${hit.tiers.join(", ")})`);
  }
  return { ...hit, tier };
}

// ── task assembly ────────────────────────────────────────────────────────────

const IMAGE_EXT = { png: "png", jpg: "jpg", jpeg: "jpg", webp: "webp" };

// Extension → mime for --add. The gallery routes on the top-level type (image / video /
// audio / mesh), so only the family has to be right.
const ADD_MIME = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp",
  gif: "image/gif", bmp: "image/bmp", tif: "image/tiff", tiff: "image/tiff", heic: "image/heic",
  mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm", mkv: "video/x-matroska", avi: "video/x-msvideo",
  wav: "audio/wav", mp3: "audio/mpeg", m4a: "audio/mp4", flac: "audio/flac", ogg: "audio/ogg",
  glb: "model/gltf-binary", gltf: "model/gltf-binary", spz: "application/octet-stream",
};

function readB64(p) {
  const abs = path.resolve(p);
  if (!fs.existsSync(abs)) throw new Error(`no such file: ${p}`);
  return fs.readFileSync(abs).toString("base64");
}

function mimeOf(p, kind) {
  const ext = path.extname(p).slice(1).toLowerCase();
  if (kind === "video") return ext === "webm" ? "video/webm" : ext === "mov" ? "video/quicktime" : "video/mp4";
  if (kind === "audio") return ext === "mp3" ? "audio/mpeg" : ext === "m4a" ? "audio/mp4" : ext === "flac" ? "audio/flac" : "audio/wav";
  return `image/${IMAGE_EXT[ext] || "png"}`;
}

// CLI flags → a task object, so the argv path and the batch-JSON path converge on
// one shape before anything is validated.
function taskFromArgs(a) {
  const t = { options: { ...(a.options || {}) } };
  if (a.model) t.model = a.model;
  if (a.prompt) t.prompt = a.prompt;
  if (a.negative) t.negative = a.negative;
  if (a.images.length) t.images = a.images.slice();
  if (a.video) t.video = a.video;
  if (a.audio) t.audio = a.audio;
  if (a.seconds > 0) t.seconds = a.seconds;
  if (a.length > 0) t.length = a.length;
  if (a.size) t.size = a.size;
  if (Number.isFinite(a.seed)) t.seed = a.seed;
  if (a.steps > 0) t.steps = a.steps;
  if (a.count > 0) t.count = a.count;
  if (a.precision) t.precision = a.precision;
  if (a.enhance) t.enhance = true;
  if (a.out) t.out = a.out;
  return t;
}

// A batch line's own values win over the CLI defaults; `options` merges key by key.
function mergeTask(base, over) {
  return { ...base, ...over, options: { ...(base.options || {}), ...(over.options || {}) } };
}

function taskToOptions(task) {
  const o = { ...(task.options || {}) };
  if (task.size) Object.assign(o, parseSize(task.size));
  if (task.seconds > 0) o.lengthSec = task.seconds;
  if (task.length > 0) o.length = task.length;
  if (Number.isFinite(task.seed)) o.seed = task.seed;
  if (task.steps > 0) o.steps = task.steps;
  if (task.precision) o.precision = task.precision;
  return o;
}

// ── progress (ComfyUI's own websocket, same clientId the render is queued with) ─

function attachProgress(comfyUrl, clientId, label) {
  // Only on a real terminal: the bar redraws with \r, which in a log file or a pipe
  // becomes one unreadable line per sampler step.
  if (!comfyUrl || typeof WebSocket === "undefined" || !process.stderr.isTTY) return () => {};
  const host = String(comfyUrl).replace(/^https?:\/\//, "").replace(/\/$/, "");
  let ws = null, closed = false, retry = null, last = "";
  const started = Date.now();
  const draw = (value, max) => {
    const pct = max ? Math.round((value / max) * 100) : 0;
    const secs = Math.round((Date.now() - started) / 1000);
    const line = `  ${label} ${String(pct).padStart(3)}%  ${value}/${max}  ${secs}s`;
    if (line === last) return;
    last = line;
    process.stderr.write(`\r${line.padEnd(72)}`);
  };
  const connect = () => {
    if (closed) return;
    try { ws = new WebSocket(`ws://${host}/ws?clientId=${encodeURIComponent(clientId)}`); }
    catch { return; }
    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;      // preview frames: nothing to show in a terminal
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === "progress" && msg.data) draw(msg.data.value, msg.data.max);
      } catch { /* non-JSON */ }
    };
    ws.onerror = () => {};
    // A long render can outlive a dropped socket; ComfyUI keeps broadcasting to the
    // same clientId, so reconnecting resumes the numbers.
    ws.onclose = () => { if (!closed && !retry) retry = setTimeout(() => { retry = null; connect(); }, 2000); };
  };
  connect();
  return () => {
    closed = true;
    if (retry) clearTimeout(retry);
    try { ws && ws.close(); } catch { /* already gone */ }
    if (last) process.stderr.write(`\r${" ".repeat(74)}\r`);
  };
}

// ── running one task ─────────────────────────────────────────────────────────

// LOCAL time, not UTC: the gallery names its files in local time, and the same render
// showing two different clocks in two places is a small but real way to lose a file.
function localStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function outPath(task, cli, meta, index, total) {
  const stamp = localStamp();
  const subst = (s) => s
    .replace(/\{i\}/g, String(index + 1))
    .replace(/\{seed\}/g, String(meta.seed != null ? meta.seed : ""))
    .replace(/\{model\}/g, meta.modelId)
    .replace(/\{stamp\}/g, stamp);
  if (task.out) {
    // One explicit path for several outputs would overwrite itself — number them.
    const p = subst(task.out);
    if (total <= 1 || /\{i\}|\{seed\}/.test(task.out)) return path.resolve(p);
    const ext = path.extname(p);
    return path.resolve(`${p.slice(0, p.length - ext.length)}_${index + 1}${ext}`);
  }
  const dir = path.resolve(cli.outDir || ".");
  const suffix = total > 1 ? `_${index + 1}` : "";
  return path.join(dir, `${stamp}_${meta.modelId}_${meta.seed != null ? meta.seed : "x"}${suffix}.${meta.ext}`);
}

// Pixel size of a PNG/JPEG we just wrote. The video branch reports width/height in its
// response; the image branch does not always, and a result record with no size in it is
// the one field a calling program most often wants back.
function sniffDims(buf) {
  try {
    if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      let o = 2;
      while (o + 9 < buf.length) {
        if (buf[o] !== 0xff) { o++; continue; }
        const m = buf[o + 1];
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
          return { height: buf.readUInt16BE(o + 5), width: buf.readUInt16BE(o + 7) };
        }
        o += 2 + buf.readUInt16BE(o + 2);
      }
    }
  } catch { /* unreadable — the record just carries no size */ }
  return null;
}

function extFor(data) {
  if (data.videos) return /webm/i.test(data.videoMime || "") ? "webm" : "mp4";
  if (data.meshes) return (data.meshNames && /\.spz$/i.test(data.meshNames[0])) ? "spz" : "glb";
  return "png";
}

async function runTask(task, cli, ctx) {
  const model = resolveModel(ctx.rows, task.model);
  const options = taskToOptions(task);
  if (task.precision && !options.precision) options.precision = task.precision;
  if (model.tier) options.precision = model.tier;

  const isVideo = model.group === "video" || model.group === "video-in";
  const images = (task.images || []).map(readB64);

  // The r2v family accepts images, a clip and audio interchangeably as references —
  // catch "nothing attached" here rather than after the request has travelled.
  if (model.spec.needsImages && !images.length && !task.video && !task.audio) {
    throw new Error(`${model.id} needs at least one reference (-i image / --video / --audio)`);
  }
  if (model.spec.needsVideo && !model.spec.videoOptional && !task.video) {
    throw new Error(`${model.id} needs a source video (--video <file>)`);
  }
  if (!task.prompt && !images.length && !task.video) {
    throw new Error("nothing to work from: give a prompt, an image, or a video");
  }

  let prompt = task.prompt || "";
  if (task.enhance && prompt) {
    const llm = cli.enhanceModel || ctx.chatModel;
    if (!llm) throw new Error("--enhance needs a chat model (--enhance-model <name>)");
    const r = await postJson("/api/enhance-prompt",
      { model: llm, prompt, video: isVideo, edit: model.group === "edit" }, cli.server);
    if (r.json && r.json.enhanced) prompt = r.json.enhanced.trim();
  }

  // Big media goes up as a raw body (its own request), not as base64 inside the JSON:
  // the server's own request-receive deadline applies to that JSON, and a long clip
  // would be megabytes of it.
  let sourceVideoName, sourceVideoFrames, sourceVideoFps, sourceAudioName, sourceAudioDuration;
  if (task.video) {
    const buf = fs.readFileSync(path.resolve(task.video));
    const r = await request("POST", "/api/comfy-upload-video", {
      body: buf, server: cli.server,
      headers: { "Content-Type": mimeOf(task.video, "video"), ...(cli.comfyUrl ? { "x-comfy-url": cli.comfyUrl } : {}) },
    });
    if (!r.json || !r.json.name) throw new Error(`video upload failed: ${(r.json && r.json.error) || r.text.slice(0, 200)}`);
    sourceVideoName = r.json.name;
    sourceVideoFrames = r.json.frames;
    sourceVideoFps = r.json.fps;
  }
  if (task.audio) {
    const buf = fs.readFileSync(path.resolve(task.audio));
    const r = await request("POST", "/api/comfy-upload-audio", {
      body: buf, server: cli.server,
      headers: { "Content-Type": mimeOf(task.audio, "audio"), ...(cli.comfyUrl ? { "x-comfy-url": cli.comfyUrl } : {}) },
    });
    if (!r.json || !r.json.name) throw new Error(`audio upload failed: ${(r.json && r.json.error) || r.text.slice(0, 200)}`);
    sourceAudioName = r.json.name;
    sourceAudioDuration = r.json.duration;
  }

  // Empty → the UI's 4 h default; explicit 0 → unlimited (no server deadline).
  const timeout = cli.timeoutMin === undefined ? 14400
    : (cli.timeoutMin > 0 ? Math.round(cli.timeoutMin * 60) : 0);
  const count = Math.min(Math.max(task.count || 1, 1), 8);

  const results = [];
  for (let i = 0; i < count; i++) {
    const perOptions = { ...options };
    // Pinned seed + a batch: vary it, or the N renders are the same clip N times.
    if (perOptions.seed !== undefined) perOptions.seed = perOptions.seed + i;
    const clientId = `koko-cli-${process.pid}-${Date.now()}-${i}`;
    const body = {
      model: model.value,
      prompt,
      negative_prompt: task.negative || "",
      options: perOptions,
      images: images.length ? images : undefined,
      sourceVideoName, sourceVideoFrames, sourceVideoFps,
      sourceAudioName, sourceAudioDuration,
      timeout,
      clientId,
      comfyUrl: cli.comfyUrl || undefined,
      // The CLI does NOT file into the gallery unless asked: reaching for it usually
      // means iterating on a prompt, and a dozen throwaway drafts should not end up in
      // the library. `-g` opts back in, matching what the browser always does.
      noGallery: cli.gallery ? undefined : true,
    };

    if (cli.dryRun) {
      const shown = { ...body, images: images.length ? [`<${images.length} image(s)>`] : undefined };
      // Indented for a human, but ONE LINE under --json: a caller parsing the stream
      // line by line must not have to special-case this mode.
      process.stdout.write((cli.json ? JSON.stringify(shown) : JSON.stringify(shown, null, 2)) + "\n");
      results.push({ ok: true, dryRun: true, model: model.id, file: null });
      continue;
    }

    const label = count > 1 ? `${model.id} (${i + 1}/${count})` : model.id;
    if (!cli.quiet && !cli.json) process.stderr.write(`▶ ${label}${prompt ? `  "${prompt.slice(0, 60)}${prompt.length > 60 ? "…" : ""}"` : ""}\n`);
    const stop = (cli.quiet || cli.json) ? () => {} : attachProgress(ctx.comfyUrl, clientId, label);
    const started = Date.now();
    let r;
    try { r = await postJson("/api/generate-comfy", body, cli.server); }
    finally { stop(); }
    const data = r.json;
    if (!data) throw new Error(`server returned non-JSON (${r.status}): ${r.text.slice(0, 300)}`);
    // The server did no ComfyUI work ON PURPOSE (an enhance run that would neither
    // upscale nor sharpen). Not a failure — but a caller must hear about it, or it
    // waits for a file that is never coming.
    if (data.noop) {
      const rec = { ok: true, noop: true, model: model.id, message: data.message, file: null };
      results.push(rec);
      if (cli.json) process.stdout.write(JSON.stringify(rec) + "\n");
      else if (!cli.quiet) process.stderr.write(`ℹ ${data.message || "nothing to do"}\n`);
      continue;
    }
    if (r.status !== 200 || !(data.videos || data.images || data.meshes)) {
      throw new Error(data.error || data.detail || `generation failed (${r.status})`);
    }

    const arr = data.videos || data.images || data.meshes;
    const ext = extFor(data);
    const elapsed = Math.round((Date.now() - started) / 1000);
    for (let k = 0; k < arr.length; k++) {
      const meta = { seed: data.seed, modelId: model.id, ext };
      const file = outPath(task, cli, meta, results.length, count * arr.length);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const bytes = Buffer.from(arr[k], "base64");
      fs.writeFileSync(file, bytes);
      const dims = (data.width ? { width: data.width, height: data.height } : null)
        || (data.images ? sniffDims(bytes) : null) || {};
      const rec = {
        ok: true, file, model: model.id, modelFile: data.model, seed: data.seed,
        width: dims.width, height: dims.height, fps: data.fps, frames: data.length,
        precision: data.precisionUsed, mediaId: (data.mediaIds || [])[k] || null,
        prompt, seconds: (data.length && data.fps) ? Math.round((data.length / data.fps) * 10) / 10 : undefined,
        elapsedSec: elapsed,
      };
      results.push(rec);
      if (cli.json) process.stdout.write(JSON.stringify(rec) + "\n");
      else if (!cli.quiet) {
        const size = rec.width ? `${rec.width}×${rec.height}` : "?";
        const dur = rec.seconds ? `, ${rec.seconds}s` : "";
        process.stderr.write(`✓ ${file}  (${size}${dur}, seed ${data.seed}, ${elapsed}s)\n`);
      }
    }
    if (data.partial && data.partial.total && !cli.quiet) {
      process.stderr.write(`⚠ partial render: ${data.partial.done}/${data.partial.total} segments\n`);
    }
  }
  return results;
}

// ── --add: file the media as-is, no generation ───────────────────────────────

// Pixel size for the ledger. The browser's uploader measures it because it has already
// decoded the picture; here PNG/JPEG headers are read directly and video is left to
// ffprobe when that happens to be installed. Absent size is fine — the entry still files.
function probeDims(file, buf) {
  const d = sniffDims(buf);
  if (d) return d;
  if (!/^video\//.test(ADD_MIME[path.extname(file).slice(1).toLowerCase()] || "")) return null;
  try {
    const { execFileSync } = require("node:child_process");
    const out = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", path.resolve(file)],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const m = out.match(/(\d+)x(\d+)/);
    return m ? { width: +m[1], height: +m[2] } : null;
  } catch { return null; }   // no ffprobe, or it couldn't read the file
}

// Put existing files in the gallery untouched — no model, no render, no re-encode.
// Same endpoint (and same dedup) the browser uses when media is dragged into a chat.
async function addToGallery(files, cli) {
  let failed = 0;
  for (const file of files) {
    const abs = path.resolve(file);
    try {
      if (!fs.existsSync(abs)) throw new Error("no such file");
      const ext = path.extname(abs).slice(1).toLowerCase();
      const mime = ADD_MIME[ext];
      if (!mime) throw new Error(`unsupported file type ".${ext}"`);
      const buf = fs.readFileSync(abs);
      const dims = probeDims(abs, buf) || {};
      const r = await request("POST", "/api/gallery/upload", {
        body: buf, server: cli.server,
        headers: {
          "Content-Type": mime,
          "X-Gallery-Name": encodeURIComponent(path.basename(abs)),
          ...(dims.width ? { "X-Gallery-Width": String(dims.width), "X-Gallery-Height": String(dims.height) } : {}),
        },
      });
      if (!r.json || !r.json.id) throw new Error((r.json && r.json.error) || `upload failed (${r.status})`);
      const rec = { ok: true, file: abs, mediaId: r.json.id, kind: r.json.kind,
        deduped: !!r.json.deduped, width: dims.width, height: dims.height };
      if (cli.json) process.stdout.write(JSON.stringify(rec) + "\n");
      else if (!cli.quiet) {
        process.stderr.write(`${rec.deduped ? "=" : "✓"} ${path.basename(abs)} → ${rec.mediaId}${rec.deduped ? "  (already there)" : ""}\n`);
      }
    } catch (e) {
      failed++;
      if (cli.json) process.stdout.write(JSON.stringify({ ok: false, file: abs, error: e.message }) + "\n");
      else process.stderr.write(`✗ ${file}: ${e.message}\n`);
      if (!cli.keepGoing) return 2;
    }
  }
  return failed ? 2 : 0;
}

// ── batch input ──────────────────────────────────────────────────────────────

function readBatch(spec) {
  const text = spec === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(path.resolve(spec), "utf8");
  const tasks = [];
  text.split(/\r?\n/).forEach((raw, n) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    try {
      if (line.startsWith("{")) {
        const j = JSON.parse(line);
        tasks.push({ ...j, _line: n + 1 });
      } else {
        const t = parseImagineLine(line);
        tasks.push({
          model: t.model, prompt: t.prompt, negative: t.negative, count: t.count,
          enhance: t.enhance, options: t.options, _line: n + 1,
        });
      }
    } catch (e) {
      throw new Error(`batch line ${n + 1}: ${e.message}`);
    }
  });
  return tasks;
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  let cli;
  try { cli = parseArgv(process.argv.slice(2)); }
  catch (e) { process.stderr.write(`${e.message}\n\n${USAGE}\n`); return 1; }

  if (cli.help || (!cli.listModels && !cli.add && !cli.batch && !cli.cmd && !cli.prompt && !cli.images.length && !cli.video)) {
    process.stdout.write(`${USAGE}\n`);
    return cli.help ? 0 : 1;
  }

  // Import mode generates nothing, so it needs neither a model list nor ComfyUI —
  // a box with the GPU switched off can still file its media.
  if (cli.add) {
    if (!cli.addFiles.length) { process.stderr.write("--add needs at least one file\n"); return 1; }
    return await addToGallery(cli.addFiles, cli);
  }

  let cat;
  try { cat = await loadCatalogue(cli.server, cli.comfyUrl); }
  catch (e) { process.stderr.write(`${e.message}\n`); return 1; }

  if (cli.listModels) {
    const filter = cli.prompt.toLowerCase();
    const rows = cat.rows.filter((m) => !filter || m.id.includes(filter) || m.label.toLowerCase().includes(filter));
    // One JSON object per line here too, so a program can pick a model with the same
    // line-by-line reader it uses for results.
    if (cli.json) {
      for (const m of rows) {
        process.stdout.write(JSON.stringify({
          id: m.id, label: m.label, group: m.group, caps: m.caps, tiers: m.tiers, ready: m.ready,
          needsImages: !!m.spec.needsImages, needsVideo: !!m.spec.needsVideo,
          videoOptional: !!m.spec.videoOptional,
        }) + "\n");
      }
      // Upscale / restore weights ride the same stream, distinguished by carrying
      // `file` instead of `id` — they are values for --upscale / --restore, not models.
      for (const f of cat.files) {
        if (filter && !f.file.toLowerCase().includes(filter)) continue;
        process.stdout.write(JSON.stringify(f) + "\n");
      }
      return 0;
    }
    const w = Math.max(4, ...rows.map((m) => m.id.length));
    for (const g of ["image", "edit", "video", "video-in", "3d"]) {
      const inGroup = rows.filter((m) => m.group === g);
      if (!inGroup.length) continue;
      process.stdout.write(`\n${g}\n`);
      for (const m of inGroup.sort((a, b) => a.id.localeCompare(b.id))) {
        const tiers = m.tiers.length ? `  [${m.tiers.join("/")}]` : "";
        const caps = m.caps.length ? `  ${m.caps.join(",")}` : "";
        process.stdout.write(`  ${m.id.padEnd(w)}  ${m.label}${caps}${tiers}${m.ready ? "" : "  ⚠ unverified"}\n`);
      }
    }
    for (const g of ["upscaler", "restore"]) {
      const files = cat.files.filter((f) => f.group === g && (!filter || f.file.toLowerCase().includes(filter)));
      if (!files.length) continue;
      process.stdout.write(`\n${g}  (values for ${g === "upscaler" ? "--upscale" : "--restore"}; "auto" and "off" also accepted)\n`);
      for (const f of files.sort((a, b) => a.file.localeCompare(b.file))) process.stdout.write(`  ${f.file}\n`);
    }
    process.stdout.write("\n");
    return 0;
  }

  // The enhance path needs a chat model; only fetch the list when it might be used.
  let chatModel = null;
  if (cli.enhance && !cli.enhanceModel) {
    const m = await getJson("/api/models", cli.server).catch(() => null);
    chatModel = m && m.models && m.models[0] && m.models[0].name;
  }
  const ctx = { rows: cat.rows, comfyUrl: cat.raw.comfyUrl || (await getJson("/api/ollama-url", cli.server).catch(() => null))?.comfyUrl, chatModel };

  const defaults = taskFromArgs(cli);
  let tasks;
  try {
    if (cli.batch) tasks = readBatch(cli.batch).map((t) => mergeTask(defaults, t));
    else if (cli.cmd) {
      const p = parseImagineLine(cli.cmd);
      tasks = [mergeTask(defaults, {
        model: p.model, prompt: p.prompt, negative: p.negative, count: p.count,
        enhance: p.enhance, options: p.options,
      })];
    } else tasks = [defaults];
  } catch (e) { process.stderr.write(`${e.message}\n`); return 1; }

  if (!tasks.length) { process.stderr.write("nothing to do — the batch had no tasks\n"); return 1; }

  let failed = 0;
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    const where = t._line ? `line ${t._line}` : `task ${i + 1}`;
    try {
      if (tasks.length > 1 && !cli.quiet && !cli.json) {
        process.stderr.write(`\n── ${where} of ${tasks.length} ──\n`);
      }
      await runTask(t, cli, ctx);
    } catch (e) {
      failed++;
      const rec = { ok: false, task: where, error: e.message, prompt: t.prompt, model: t.model };
      if (cli.json) process.stdout.write(JSON.stringify(rec) + "\n");
      else process.stderr.write(`✗ ${where}: ${e.message}\n`);
      if (!cli.keepGoing) return 2;
    }
  }
  return failed ? 2 : 0;
}

main().then((code) => process.exit(code)).catch((e) => {
  process.stderr.write(`${(e && e.stack) || e}\n`);
  process.exit(1);
});
