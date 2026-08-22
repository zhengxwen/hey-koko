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
  imagine.js -m minimax-music3 -s 120 "Global Metadata: lo-fi hip-hop, 78 BPM…" \\
             --lyrics @song.txt                a song (flac); --lyrics is optional
  imagine.js --add clip.mp4 photo.jpg          file existing media, no generation
  imagine.js --list-models [filter]
  imagine.js --help <flag>                     legal values for one flag
                                               (camera, size, sharpen, quality,
                                                precision, upscale, restore, voice)
  imagine.js --scan                            find ComfyUI machines on the network

Model
  -m, --model <id[@tier]>  canonical model id, e.g. minimax-h3-r2v, minimax-h3-r2v@int8
                           (prefix/substring accepted; ambiguity is refused, never guessed)
      --precision <tier>   same as @tier (fp8 / int8 / bf16 / nvfp4 / …)

Inputs
  -i, --image <path>       reference/first-frame image; repeat for more (r2v takes up to 9)
      --mask <path>        region to repaint: white = change, black = keep (required by
                           qwen-image:inpaint, an optional hint for the edit models)
      --camera <pose>      3D-camera route only: where to put the camera, as comma-separated
                           words in any order, e.g. "back-left,low,wide". Omitted axes keep
                           their default (front / eye / medium) — see --help camera
      --video <path>       source or reference video
      --audio <path>       source or reference audio

Music (-m minimax-music3)
      --lyrics <text|@file>  song words. Section tags drive the STRUCTURE: [Intro] [Verse]
                           [Chorus] [Bridge] [Instrumental] [Solo] [Outro]. Leave it out
                           (or use tags with no words) for an instrumental — and say so in
                           the caption too, e.g. "the piece is entirely instrumental, no
                           vocals, no wordless humming".
                           The PROMPT is the caption: write it as Global Metadata /
                           Vocal Details / Arrangement. --second is a CEILING; the model
                           ends the song where it wants to (max 360).

Generation
  -s, --second <n>         clip duration in seconds (server snaps to the model's frame grid;
                           on a music model it is the maximum song length)
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
      --fps <n>            exact output frame rate, e.g. 30 (interpolates, then re-times;
                           on a generator it sets the mux rate instead)
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
      --progress           progress as plain lines on stderr (works in a pipe / log, and
                           alongside --json): "[progress] <model> 45% (9/20) 37s"
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
      --comfy-url <url>    target a specific ComfyUI worker (--scan lists them)
      --scan               sweep the network for ComfyUI (port 8188), reporting each
                           machine's GPU; run it from the server's network position
      --timeout <min>      render deadline; 0 = unlimited (default 240)

Exit: 0 all good, 1 usage/setup error, 2 one or more renders failed.`;

function parseArgv(argv) {
  const o = { images: [], mask: "", camera: "", helpFor: "", addFiles: [], opts: {}, options: {} };
  const need = (i, flag) => {
    if (i + 1 >= argv.length) { throw new Error(`${flag} needs a value`); }
    return argv[i + 1];
  };
  const words = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "-h": case "--help": {
        o.help = true;
        // Optional topic: `--help camera` lists that flag's legal values. Only consumed
        // when the next word is not another flag, so a bare `--help` still works and
        // `--help --json` keeps meaning "usage, as JSON".
        const nxt = argv[i + 1];
        if (nxt && !/^-/.test(nxt)) { o.helpFor = nxt.toLowerCase(); i++; }
        else if (nxt && /^--[a-z-]+$/.test(nxt) && HELP_TOPICS.includes(nxt.slice(2))) { o.helpFor = nxt.slice(2); i++; }
        break;
      }
      case "--list-models": o.listModels = true; break;
      case "--scan": o.scan = true; break;
      case "-m": case "--model": o.model = need(i, a).toLowerCase(); i++; break;
      case "--precision": o.precision = need(i, a); i++; break;
      case "-i": case "--image": o.images.push(need(i, a)); i++; break;
      // The white area of this picture is the region to repaint — what the mask
      // brush paints in the browser. Only the inpainting route requires one; the
      // instruction-edit models take it as an optional "change only here" hint.
      case "--mask": o.mask = need(i, a); i++; break;
      // Camera pose for the 3D-camera route. One flag rather than three because the
      // three vocabularies are disjoint, so the tokens can arrive in any order and any
      // of them may be left out: "--camera back-left,low" keeps the default distance.
      case "--camera": o.camera = need(i, a); i++; break;
      case "--video": o.video = need(i, a); i++; break;
      case "--audio": o.audio = need(i, a); i++; break;
      case "-s": case "--second": o.seconds = parseFloat(String(need(i, a)).replace(/s$/i, "")); i++; break;
      case "--length": o.length = parseInt(need(i, a), 10); i++; break;
      case "--size": o.size = need(i, a); i++; break;
      case "--seed": o.seed = parseInt(need(i, a), 10); i++; break;
      case "--steps": o.steps = parseInt(need(i, a), 10); i++; break;
      case "--no": o.negative = need(i, a); i++; break;
      // Song lyrics (MiniMax Music 3). A shell is a bad place to type verses, so
      // "@path" reads them from a file — which is how anyone with more than a chorus
      // will actually pass them.
      case "--lyrics": {
        const v = need(i, a); i++;
        o.options.lyrics = v.startsWith("@") ? fs.readFileSync(path.resolve(v.slice(1)), "utf8") : v;
        break;
      }
      case "-n": case "--count": o.count = parseInt(need(i, a), 10); i++; break;
      case "-e": case "--enhance": o.enhance = true; break;
      case "--enhance-model": o.enhanceModel = need(i, a); i++; break;
      // The upscale/sharpen tools' knobs. They are ordinary ⚙ options underneath, but
      // reaching them through --opt means knowing the key names, and these two models
      // are useless without them.
      case "--fps": o.fps = parseFloat(need(i, a)); i++; break;
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
      case "--progress": o.progress = true; break;
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
  // Audio-only generators (MiniMax Music 3): a prompt goes in, a song file comes out.
  for (const m of d.audioModels || []) add(m.name, "music", m);
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

// The enhance tool's sentinel name (server: VIDEO_ENHANCE) — --fps routes on it.
const VIDEO_ENHANCE = "video-enhance";

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
  if (a.mask) t.mask = a.mask;
  if (a.camera) t.camera = a.camera;
  if (a.video) t.video = a.video;
  if (a.audio) t.audio = a.audio;
  if (a.seconds > 0) t.seconds = a.seconds;
  if (a.length > 0) t.length = a.length;
  if (a.size) t.size = a.size;
  if (Number.isFinite(a.seed)) t.seed = a.seed;
  if (a.steps > 0) t.steps = a.steps;
  if (a.fps > 0) t.fps = a.fps;
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

// `plain` = one self-contained line per update instead of a \r-redrawn bar, so progress
// survives a pipe or a log file. That is what --progress asks for; the bar itself needs
// a real terminal, since in a log it would become one unreadable line per sampler step.
function attachProgress(comfyUrl, clientId, label, { plain = false } = {}) {
  if (!comfyUrl || typeof WebSocket === "undefined") return () => {};
  if (!plain && !process.stderr.isTTY) return () => {};
  const host = String(comfyUrl).replace(/^https?:\/\//, "").replace(/\/$/, "");
  let ws = null, closed = false, retry = null, last = "";
  let lastPct = -1, lastAt = 0;
  const started = Date.now();
  const draw = (value, max) => {
    const pct = max ? Math.round((value / max) * 100) : 0;
    const secs = Math.round((Date.now() - started) / 1000);
    if (plain) {
      // Throttled: a 1000-step render must not write 1000 lines. Every 5% or 5 s,
      // and always the last step — a consumer polling this should see it finish.
      const now = Date.now();
      if (pct !== 100 && pct - lastPct < 5 && now - lastAt < 5000) return;
      lastPct = pct; lastAt = now;
      process.stderr.write(`[progress] ${label} ${pct}% (${value}/${max}) ${secs}s\n`);
      return;
    }
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
  if (data.audios) return /mpeg|mp3/i.test(data.audioMime || "") ? "mp3" : "flac";
  if (data.videos) return /webm/i.test(data.videoMime || "") ? "webm" : "mp4";
  if (data.meshes) return (data.meshNames && /\.spz$/i.test(data.meshNames[0])) ? "spz" : "glb";
  return "png";
}

// Resolve a "--camera back-left,low,wide" spec against the vocabulary the SERVER
// publishes, so the words live in exactly one place and a new pose reaches the CLI
// without editing it. The three lists are disjoint, so a token identifies its own axis:
// order is free and any axis may be omitted (it keeps its default). Unknown tokens are
// an ERROR, not a shrug — the server silently renders a front view for anything it does
// not recognise, so a typo would otherwise cost a GPU minute and look like the model
// ignoring the request.
function resolveCamera(spec, vocab) {
  if (!vocab) throw new Error("--camera needs a server that publishes the camera vocabulary (restart the hey-koko server)");
  const axes = [["camAzimuth", "azimuth"], ["camElevation", "elevation"], ["camDistance", "distance"]];
  const out = {};
  for (const [key, axis] of axes) out[key] = vocab.defaults?.[axis] || (vocab[axis] || [])[0];
  for (const tok of String(spec).split(/[,\/\s]+/).filter(Boolean)) {
    const t = tok.toLowerCase();
    const hit = axes.find(([, axis]) => (vocab[axis] || []).includes(t));
    if (!hit) {
      const all = axes.map(([, axis]) => `${axis}: ${(vocab[axis] || []).join(" ")}`).join("\n  ");
      throw new Error(`--camera: unknown position "${tok}"\n  ${all}\n  (--help camera lists these)`);
    }
    out[hit[0]] = t;
  }
  return out;
}

// `--help <flag>` topics: every flag whose values are a closed set worth listing.
// Kept next to the printer so adding a topic is one edit, not two.
const HELP_TOPICS = ["camera", "size", "sharpen", "quality", "precision", "upscale", "restore", "voice"];

function printHelpTopic(topic, cat, files, out) {
  const line = (label, vals, note) => out(`  ${label.padEnd(10)} ${vals.join("  ")}${note ? `\n  ${" ".repeat(10)} ${note}` : ""}\n`);
  switch (topic) {
    case "camera": {
      const v = cat.cameraVocab;
      if (!v) { out("this server does not publish a camera vocabulary (restart it)\n"); return 1; }
      out("--camera <a,b,c>  poses for -m qwen-image-edit:angles (any order; omit an axis to keep its default)\n\n");
      for (const axis of ["azimuth", "elevation", "distance"]) {
        line(axis, v[axis].map((x) => (x === v.defaults?.[axis] ? `${x} (default)` : x)));
      }
      out(`\n  ${v.azimuth.length} x ${v.elevation.length} x ${v.distance.length} = ${v.azimuth.length * v.elevation.length * v.distance.length} poses\n`);
      return 0;
    }
    case "size":
      out("--size <token>    frame size\n\n");
      line("presets", Object.keys(SIZE_PRESETS));
      line("literal", ["WxH"], "e.g. 1280x720");
      return 0;
    case "sharpen":
      out("--sharpen <level> post-resize unsharp mask (video-enhance / image-upscale)\n\n");
      line("levels", ["off (default)", "light", "medium", "strong"], "works with --upscale off: filter only, no resize");
      return 0;
    case "quality":
      out("--quality <level> sampling effort — trades steps for time\n\n");
      line("levels", ["high", "medium", "low"]);
      return 0;
    case "precision": {
      const tiers = [...new Set(cat.rows.flatMap((m) => m.tiers || []))].sort();
      out("--precision <tier>  weight precision; a model only accepts tiers it has installed\n\n");
      line("installed", tiers.length ? tiers : ["(none reported)"], "per-model tiers are shown by --list-models");
      return 0;
    }
    case "upscale":
    case "restore": {
      const group = topic === "upscale" ? "upscaler" : "restore";
      const names = files.filter((f) => f.group === group).map((f) => f.file);
      out(`--${topic} <model>   ${topic === "upscale" ? "upscale" : "1x de-artifact"} weights installed on this ComfyUI\n\n`);
      line("special", ["auto (default)", "off"]);
      for (const n of names) out(`             ${n}\n`);
      if (!names.length) out("             (none installed)\n");
      return 0;
    }
    case "voice": {
      out("--voice <id>      TTS voice for \"photo speaks\" / read-aloud\n\n");
      const vs = cat.voices || [];
      if (!vs.length) { out("  (this server reported no voices)\n"); return 0; }
      for (const v of vs) out(`  ${(v.id || v.name || v)}${v.label ? `  ${v.label}` : ""}\n`);
      return 0;
    }
    default:
      out(`no help topic "${topic}"\n\ntopics: ${HELP_TOPICS.join(", ")}\n`);
      return 1;
  }
}

async function runTask(task, cli, ctx) {
  const model = resolveModel(ctx.rows, task.model);
  const options = taskToOptions(task);
  if (task.precision && !options.precision) options.precision = task.precision;
  if (model.tier) options.precision = model.tier;

  const isVideo = model.group === "video" || model.group === "video-in";
  // Audio-only: no attachment reaches this graph, and the prompt is not decorative —
  // it IS the music description the model conditions on.
  const isMusic = model.group === "music";
  const images = (task.images || []).map(readB64);
  const mask = task.mask ? readB64(task.mask) : "";
  if (task.camera) {
    if (model.id !== "qwen-image-edit:angles") {
      throw new Error(`--camera only applies to the 3D-camera route (-m qwen-image-edit:angles), not ${model.id}`);
    }
    Object.assign(options, resolveCamera(task.camera, ctx.cameraVocab));
  }

  if (isMusic) {
    if (!task.prompt) {
      throw new Error(`${model.id} needs a caption: describe the music — style, tempo, mood, `
        + "vocals, arrangement. Add the words with --lyrics <text|@file>.");
    }
    if (images.length || task.video || task.audio) {
      throw new Error(`${model.id} takes no attachments — it generates from the caption and lyrics alone`);
    }
  }

  // The r2v family accepts images, a clip and audio interchangeably as references —
  // catch "nothing attached" here rather than after the request has travelled.
  if (model.spec.needsImages && !images.length && !task.video && !task.audio) {
    throw new Error(`${model.id} needs at least one reference (-i image / --video / --audio)`);
  }
  if (model.spec.needsVideo && !model.spec.videoOptional && !task.video) {
    throw new Error(`${model.id} needs a source video (--video <file>)`);
  }
  // Inpainting is defined by its mask: white = repaint, black = keep.
  if (model.spec.needsMask && !mask) {
    throw new Error(`${model.id} needs a mask (--mask <file>): white where the picture should be repainted, black everywhere else`);
  }
  if (mask && !images.length) {
    throw new Error("--mask marks a region OF an image — attach the picture too (-i <file>)");
  }
  if (!task.prompt && !images.length && !task.video) {
    throw new Error("nothing to work from: give a prompt, an image, or a video");
  }

  let prompt = task.prompt || "";
  // --enhance rewrites a prompt for a picture. A structured music caption (Global
  // Metadata / Vocal Details / Arrangement) is a different document, and there is no
  // music-aware rewriter behind /api/enhance-prompt — running it would quietly turn
  // the caption into an image prompt. Skip it and say so, rather than damage the input.
  if (task.enhance && prompt && isMusic) {
    if (!cli.quiet && !cli.json) process.stderr.write("ℹ --enhance skipped: no music-aware prompt rewriter\n");
  } else if (task.enhance && prompt) {
    const llm = cli.enhanceModel || ctx.chatModel;
    if (!llm) throw new Error("--enhance needs a chat model (--enhance-model <name>)");
    const r = await postJson("/api/enhance-prompt",
      { model: llm, prompt, video: isVideo, edit: model.group === "edit" }, cli.server);
    if (r.json && r.json.enhanced) prompt = r.json.enhanced.trim();
  }

  // Big media goes up as a raw body (its own request), not as base64 inside the JSON:
  // the server's own request-receive deadline applies to that JSON, and a long clip
  // would be megabytes of it.
  let sourceVideoName, sourceVideoFrames, sourceVideoFps, sourceVideoWidth, sourceVideoHeight,
    sourceAudioName, sourceAudioDuration;
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
    // The browser sends the source dimensions; without them the server cannot size the
    // upscale chunk plan and video-enhance feeds the WHOLE clip to the upscaler in one
    // batch (a 30s 720p clip = a >100GB CPU allocation). Probe locally like it does.
    const probe = require("node:child_process").spawnSync("ffprobe",
      ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height",
       "-of", "csv=p=0", path.resolve(task.video)], { encoding: "utf8" });
    const dims = /(\d+),(\d+)/.exec((probe.stdout || "").trim());
    if (dims) { sourceVideoWidth = Number(dims[1]); sourceVideoHeight = Number(dims[2]); }
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

  // --fps means "the rate the result plays at", which two different mechanisms deliver:
  // on the enhance tool it is frame INTERPOLATION (new frames invented, duration kept);
  // on a generator it is the rate the model muxes at. Models with a fixed rate (MiniMax
  // H3 at 24) ignore it server-side — the length is defined at that rate.
  let fpsPlan = null;
  if (task.fps > 0) {
    if (model.value === VIDEO_ENHANCE) {
      fpsPlan = planFps(Number(sourceVideoFps) || 0, task.fps);
      if (fpsPlan) options.targetFps = fpsPlan.interFps;
      else if (!cli.quiet && !cli.json) {
        process.stderr.write(`ℹ --fps ${task.fps} skipped: the source is already ${sourceVideoFps || "?"} fps\n`);
      }
    } else {
      options.fps = task.fps;
    }
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
      mask: mask || undefined,
      sourceVideoName, sourceVideoFrames, sourceVideoFps, sourceVideoWidth, sourceVideoHeight,
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
      const shown = { ...body, images: images.length ? [`<${images.length} image(s)>`] : undefined, mask: mask ? "<mask>" : undefined };
      // Indented for a human, but ONE LINE under --json: a caller parsing the stream
      // line by line must not have to special-case this mode.
      process.stdout.write((cli.json ? JSON.stringify(shown) : JSON.stringify(shown, null, 2)) + "\n");
      results.push({ ok: true, dryRun: true, model: model.id, file: null });
      continue;
    }

    const label = count > 1 ? `${model.id} (${i + 1}/${count})` : model.id;
    if (!cli.quiet && !cli.json) process.stderr.write(`▶ ${label}${prompt ? `  "${prompt.slice(0, 60)}${prompt.length > 60 ? "…" : ""}"` : ""}\n`);
    const started = Date.now();
    let r, data;
    for (let attempt = 0; ; attempt++) {
      // --progress asks for it explicitly (pipes, logs, --json runs); otherwise the bar
      // appears in an interactive terminal. --quiet always wins.
      const stop = cli.quiet ? () => {}
        : cli.progress ? attachProgress(ctx.comfyUrl, clientId, label, { plain: true })
        : cli.json ? () => {}
        : attachProgress(ctx.comfyUrl, clientId, label);
      try { r = await postJson("/api/generate-comfy", body, cli.server); }
      finally { stop(); }
      data = r.json;
      if (!data) throw new Error(`server returned non-JSON (${r.status}): ${r.text.slice(0, 300)}`);
      if (data.noop || (r.status === 200 && (data.videos || data.images || data.meshes || data.audios))) break;
      const msg = data.error || data.detail || `generation failed (${r.status})`;
      // VRAM exhaustion often outlives the failed job (back-to-back renders leave the
      // card fragmented), so ONE automatic ComfyUI /free + retry heals it — and costs
      // the healthy path nothing. "Fault failed: 2" is DynamicVRAM's weight pager
      // giving up: an OOM whose message never says "memory".
      const comfy = cli.comfyUrl || ctx.comfyUrl;
      if (attempt === 0 && comfy && /out of vram|not enough memory|fault failed: 2|allocat.* on device/i.test(msg)) {
        if (!cli.quiet && !cli.json) process.stderr.write(`⚠ OOM — freeing ComfyUI VRAM (${comfy}/free), retrying once\n`);
        try {
          await fetch(`${comfy}/free`, { method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ unload_models: true, free_memory: true }) });
        } catch { /* worker unreachable — let the retry surface the real error */ }
        await new Promise((res) => setTimeout(res, 5000));
        continue;
      }
      throw new Error(msg);
    }
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
    const arr = data.videos || data.images || data.meshes || data.audios;
    const ext = extFor(data);
    const elapsed = Math.round((Date.now() - started) / 1000);
    for (let k = 0; k < arr.length; k++) {
      const meta = { seed: data.seed, modelId: model.id, ext };
      const file = outPath(task, cli, meta, results.length, count * arr.length);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const bytes = Buffer.from(arr[k], "base64");
      fs.writeFileSync(file, bytes);
      // Interpolation landed on a multiple of the source rate; bring it to the exact
      // rate that was asked for. Best-effort: without ffmpeg the clip is still perfectly
      // good, it just plays at the multiple, and the record says so.
      let finalFps = data.fps;
      let fpsNote = null;
      if (fpsPlan && data.videos) {
        if (fpsPlan.exact) finalFps = fpsPlan.target;
        else {
          try {
            resampleFile(file, fpsPlan.target);
            finalFps = fpsPlan.target;
            if (!fpsPlan.clean) fpsNote = "nearest-frame";   // cadence isn't perfectly even
          } catch {
            fpsNote = "no-ffmpeg";
            if (!cli.quiet && !cli.json) {
              process.stderr.write(`⚠ kept ${data.fps} fps — ffmpeg is needed to re-time to ${fpsPlan.target}\n`);
            }
          }
        }
      }
      const dims = (data.width ? { width: data.width, height: data.height } : null)
        || (data.images ? sniffDims(bytes) : null) || {};
      const rec = {
        ok: true, file, model: model.id, modelFile: data.model, seed: data.seed,
        width: dims.width, height: dims.height, fps: finalFps, frames: data.length,
        precision: data.precisionUsed, mediaId: (data.mediaIds || [])[k] || null,
        prompt,
        // Duration is invariant under re-timing, so it is computed from the frames and
        // the rate the MODEL produced, not from the rate the file ended up at.
        seconds: data.seconds !== undefined ? data.seconds
          : (data.length && data.fps) ? Math.round((data.length / data.fps) * 10) / 10 : undefined,
        ...(fpsNote ? { fpsNote } : {}),
        elapsedSec: elapsed,
      };
      results.push(rec);
      if (cli.json) process.stdout.write(JSON.stringify(rec) + "\n");
      else if (!cli.quiet) {
        const size = rec.width ? `${rec.width}×${rec.height}` : data.audios ? "" : "?";
        const dur = rec.seconds ? `${size ? ", " : ""}${rec.seconds}s` : "";
        process.stderr.write(`✓ ${file}  (${size}${dur}, seed ${data.seed}, ${elapsed}s)\n`);
      }
    }
    if (data.partial && data.partial.total && !cli.quiet) {
      process.stderr.write(`⚠ partial render: ${data.partial.done}/${data.partial.total} segments\n`);
    }
  }
  return results;
}

// ── --scan: find ComfyUI instances on the LAN ────────────────────────────────

// The server already knows how to sweep every /24 it sits on for port 8188 (it is what
// the app's settings panel uses); this streams that SSE and prints hits as they land.
// NOTE the scan runs from the SERVER's network position, not this machine's.
function scanComfy(server, onFound) {
  const base = new URL(server || SERVER);
  const lib = base.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request({
      method: "GET", hostname: base.hostname,
      port: base.port || (base.protocol === "https:" ? 443 : 80),
      path: "/api/scan-comfy-stream",
      headers: { Accept: "text/event-stream" },
    }, (res) => {
      let buf = "";
      const found = [];
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        buf += chunk;
        // SSE frames are separated by a blank line; each carries one "data:" payload.
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, i); buf = buf.slice(i + 2);
          const line = frame.split("\n").find((l) => l.startsWith("data:"));
          if (!line) continue;
          let msg = null;
          try { msg = JSON.parse(line.slice(5).trim()); } catch { continue; }
          if (msg.type === "found" && msg.url) { found.push(msg.url); onFound(msg.url); }
        }
      });
      res.on("end", () => resolve(found));
    });
    req.setTimeout(0);   // a full /24 sweep takes a while
    req.on("error", reject);
    req.end();
  });
}

// Ask a ComfyUI directly what GPU it has, so a scan result can be told apart from its
// neighbours. Probed from THIS machine, which may not be where the server is — a box the
// server can reach but we cannot simply reports no GPU rather than failing the scan.
function probeComfyGpu(url) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const u = new URL(url);
      const req = (u.protocol === "https:" ? https : http).request({
        method: "GET", hostname: u.hostname, port: u.port || 8188, path: "/system_stats",
      }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            const cuda = (data.devices || []).filter((d) => d.type === "cuda" && d.vram_total > 0);
            if (!cuda.length) return finish(null);
            const dev = cuda.reduce((a, b) => (b.vram_total > a.vram_total ? b : a));
            finish({
              // "cuda:0 NVIDIA GeForce RTX 5090 : cudaMallocAsync" → "NVIDIA GeForce RTX 5090"
              gpu: String(dev.name || "").replace(/^cuda:\d+\s*/i, "").replace(/\s*:\s*\w+Async\s*$/i, "").trim() || null,
              vramGib: Math.round((dev.vram_total / (1024 ** 3)) * 10) / 10,
            });
          } catch { finish(null); }
        });
      });
      req.setTimeout(4000, () => { req.destroy(); finish(null); });
      req.on("error", () => finish(null));
      req.end();
    } catch { finish(null); }
  });
}

// ── --fps: an exact output frame rate ────────────────────────────────────────

// ComfyUI's frame interpolation multiplies the frame count by an INTEGER, so a 24 fps
// clip can only become 48, 72, … — asking it for 30 gets you 48. To deliver the rate that
// was actually requested, interpolate to a multiple and resample down to the target.
//
// The multiple is chosen so the target divides it exactly when that is affordable
// (24→120→30 keeps every 4th interpolated frame: evenly spaced, no judder). The cap is 5
// rather than a smaller number precisely BECAUSE 24→30 needs ×5: it is the commonest
// conversion there is, and at ×4 it fell back to 48→30 nearest-frame judder. Past the cap
// (25→30 would want ×6) we take the cheap multiple and let ffmpeg pick nearest frames.
const FPS_MULT_CAP = 5;
function planFps(srcFps, target) {
  if (!(srcFps > 0) || !(target > 0) || target <= srcFps) return null;  // nothing to do
  let mult = 0;
  for (let m = Math.ceil(target / srcFps); m <= FPS_MULT_CAP; m++) {
    if ((m * srcFps) % target === 0) { mult = m; break; }
  }
  mult = mult || Math.ceil(target / srcFps);
  const interFps = mult * srcFps;
  return { mult, interFps, target, exact: interFps === target, clean: interFps % target === 0 };
}

// Re-time a finished clip to an exact rate, in place. Duration and audio are preserved
// (ffmpeg's fps filter drops/repeats frames rather than changing playback speed).
function resampleFile(file, fps) {
  const { execFileSync } = require("node:child_process");
  const tmp = `${file}.retime.mp4`;
  execFileSync("ffmpeg", ["-y", "-v", "error", "-i", file, "-vf", `fps=${fps}`,
    // crf 16: this is a second encode of an already-encoded clip, so keep it near-visually-lossless.
    "-c:v", "libx264", "-crf", "16", "-pix_fmt", "yuv420p", "-c:a", "copy", tmp],
    { stdio: ["ignore", "ignore", "pipe"] });
  fs.renameSync(tmp, file);
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

  // A bare --help (or nothing to do) prints the usage. `--help <topic>` needs the
  // catalogue first — half the topics list what is installed on THIS ComfyUI — so it
  // deliberately falls through to the fetch below.
  if (!cli.helpFor && (cli.help || (!cli.listModels && !cli.scan && !cli.add && !cli.batch && !cli.cmd && !cli.prompt && !cli.images.length && !cli.video))) {
    process.stdout.write(`${USAGE}\n`);
    return cli.help ? 0 : 1;
  }

  // Discovery: which machines on this network are running ComfyUI. Needs no model list
  // (that is per-endpoint, and the point here is to find out what the endpoints ARE).
  if (cli.scan) {
    const seen = [];
    if (!cli.json && !cli.quiet) process.stderr.write(`scanning for ComfyUI (port 8188) from ${cli.server || SERVER}…\n`);
    const report = async (url) => {
      const info = await probeComfyGpu(url);
      const rec = { kind: "comfy", url, ...(info || {}) };
      seen.push(rec);
      if (cli.json) process.stdout.write(JSON.stringify(rec) + "\n");
      else process.stdout.write(`  ${url.padEnd(28)}${info ? `${info.gpu}, ${info.vramGib} GiB` : ""}\n`);
    };
    const pending = [];
    await scanComfy(cli.server, (url) => pending.push(report(url)));
    await Promise.all(pending);
    if (!seen.length) {
      process.stderr.write("no ComfyUI found on this network\n");
      return 1;
    }
    if (!cli.json && !cli.quiet) process.stderr.write(`\nuse one with:  --comfy-url <url>\n`);
    return 0;
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

  if (cli.helpFor) {
    if (cli.json && cli.helpFor === "camera") {
      process.stdout.write(JSON.stringify(cat.raw.cameraVocab || null) + "\n");
      return 0;
    }
    const topic = cli.helpFor.replace(/^--/, "");
    // Voices are not part of the model catalogue, so fetch them only when asked.
    const voices = topic === "voice"
      ? ((await getJson("/api/voices", cli.server).catch(() => null))?.voices || [])
      : [];
    return printHelpTopic(topic, { ...cat.raw, rows: cat.rows, voices }, cat.files,
      (x) => process.stdout.write(x));
  }
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
    for (const g of ["image", "edit", "video", "video-in", "3d", "music"]) {
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
  const ctx = { rows: cat.rows, cameraVocab: cat.raw.cameraVocab || null, comfyUrl: cat.raw.comfyUrl || (await getJson("/api/ollama-url", cli.server).catch(() => null))?.comfyUrl, chatModel };

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
