// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

const crypto = require("crypto");
const { spawn } = require("child_process");
const os = require("os");
const path = require("path");
const fsp = require("fs/promises");
const { AsyncLocalStorage } = require("async_hooks");
const config = require("./config");
const { sendJson, readBody } = require("./utils");
const { hostnameFor } = require("./network");
const {
  PRECISION_RE_G, PREC_AUTO_ORDER,
  precisionOf, precisionBase, pickPrecision, bestTier,
  canonicalModelId, galleryModelId, labelForId,
} = require("./model-names");
const { synthToWav } = require("./tts"); // InfiniteTalk "photo speaks": prompt → local TTS → speech track
const gallery = require("./gallery"); // every finished artifact is teed to disk before it goes back

// Sniff the container from the first base64 characters — ComfyUI hands back raw
// base64 with no mime, and the gallery names files by extension.
function sniffImageMime(b64) {
  const s = String(b64 || "");
  if (s.startsWith("/9j/")) return "image/jpeg";
  if (s.startsWith("R0lGOD")) return "image/gif";
  if (s.startsWith("UklGR")) return "image/webp";
  return "image/png";
}

// Tee finished artifacts into the gallery ledger, returning their ids (aligned with
// the base64 array) for the response. A bookkeeping failure must never sink a render
// that already succeeded, so everything here is best-effort.
function toGallery(kind, arr, mime, meta) {
  if (!Array.isArray(arr) || !arr.length) return undefined;
  try {
    const ids = gallery.recordMany(arr.map((b64, i) => ({
      kind, b64, mime: mime || sniffImageMime(b64),
      meta: { ...meta, batchIndex: i },
    })));
    return ids.some(Boolean) ? ids : undefined;
  } catch (err) {
    console.error(`[gallery] tee failed: ${err.message}`);
    return undefined;
  }
}

// Per-request ComfyUI endpoint. Background jobs can target DIFFERENT machines in
// parallel, so the target URL must not be a shared mutable global (concurrent
// requests would clobber it). AsyncLocalStorage scopes it to each request's async
// call tree — parallel-safe — and falls back to the configured default when unset.
const comfyCtx = new AsyncLocalStorage();
function currentComfyUrl() { return comfyCtx.getStore()?.comfyUrl || config.comfyUrl; }
// Normalize a host[:port] or full URL to a fetchable origin (no trailing slash).
function normComfyUrl(u) {
  if (!u || typeof u !== "string") return null;
  let s = u.trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = "http://" + s;
  return s.replace(/\/+$/, "");
}

// Best-effort ffprobe of a video buffer → { frames, fps, width, height }. frames =
// r_frame_rate × duration; used to let Wan Animate generate the FULL clip at the SOURCE
// fps. width/height let the caption report the REAL output size (some paths can't compute
// it ahead of time). Key-based parse (order-independent). Zeroes if ffprobe absent/fails.
async function probeVideo(buf) {
  let tmp;
  try {
    tmp = path.join(os.tmpdir(), `hk_probe_${crypto.randomUUID()}.bin`);
    await fsp.writeFile(tmp, buf);
    const out = await new Promise((resolve) => {
      const p = spawn("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate,duration", "-of", "default=noprint_wrappers=1", tmp]);
      let s = ""; p.stdout.on("data", (d) => (s += d)); p.on("close", () => resolve(s)); p.on("error", () => resolve(""));
    });
    const kv = {};
    for (const line of out.trim().split("\n")) { const i = line.indexOf("="); if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1); }
    const [num, den] = (kv.r_frame_rate || "").split("/").map(Number);
    const fps = (num && den) ? num / den : (num || 0);
    const dur = parseFloat(kv.duration || "0");
    return { frames: (fps > 0 && dur > 0) ? Math.round(fps * dur) : 0, fps: fps || 0, width: parseInt(kv.width, 10) || 0, height: parseInt(kv.height, 10) || 0 };
  } catch { return { frames: 0, fps: 0, width: 0, height: 0 }; }
  finally { if (tmp) fsp.unlink(tmp).catch(() => {}); }
}

// Re-encode a video buffer to a target fps (ffmpeg -r). Used so a custom Animate
// output fps produces correct timing (the model emits one frame per source frame).
// Returns the new buffer, or null on failure (caller keeps the original).
async function resampleVideo(buf, targetFps, h265) {
  let inP, outP;
  try {
    const id = crypto.randomUUID();
    inP = path.join(os.tmpdir(), `hk_rs_in_${id}.mp4`);
    outP = path.join(os.tmpdir(), `hk_rs_out_${id}.mp4`);
    await fsp.writeFile(inP, buf);
    const ok = await new Promise((resolve) => {
      // Keep the audio (-c:a aac) — the merge step re-muxes the source soundtrack
      // onto the chunked output, so a resampled source must still carry its audio.
      // Preserve the container codec: when the output was h265 (⚙ H.265 on), re-encode
      // with Apple's hardware HEVC (hvc1-tagged) so this rare exact-fps pass doesn't
      // quietly convert it back to h264; otherwise libx264 as before.
      const vcodec = h265 ? ["-c:v", "hevc_videotoolbox", "-tag:v", "hvc1"] : ["-c:v", "libx264"];
      const p = spawn("ffmpeg", ["-y", "-i", inP, "-r", String(targetFps), ...vcodec, "-pix_fmt", "yuv420p", "-c:a", "aac", outP]);
      p.on("close", (code) => resolve(code === 0)); p.on("error", () => resolve(false));
    });
    if (!ok) return null;
    return await fsp.readFile(outP);
  } catch { return null; }
  finally { for (const f of [inP, outP]) if (f) fsp.unlink(f).catch(() => {}); }
}

// ffprobe the FIRST audio stream's codec name ("" if no audio / ffprobe missing).
async function audioCodecOf(buf) {
  let tmp;
  try {
    tmp = path.join(os.tmpdir(), `hk_ac_${crypto.randomUUID()}.bin`);
    await fsp.writeFile(tmp, buf);
    return await new Promise((resolve) => {
      let out = "";
      const p = spawn("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_name", "-of", "default=noprint_wrappers=1:nokey=1", tmp]);
      p.stdout.on("data", (d) => { out += d; });
      p.on("close", () => resolve(out.trim()));
      p.on("error", () => resolve(""));
    });
  } catch { return ""; }
  finally { if (tmp) fsp.unlink(tmp).catch(() => {}); }
}

// ComfyUI's video reader (GetVideoComponents/LoadVideo) chokes on some audio codecs —
// notably Opus ("avcodec_send_packet(): Invalid data … [opus] Error parsing the packet
// header") — which FAILS the whole Animate/Bernini run, since the source audio is muxed
// into the output. If the source's audio isn't a safe codec, re-mux to AAC (video copied
// → fast); fall back to a full transcode, then to stripping audio. Safe/aac/no-audio →
// returned unchanged (just one cheap ffprobe).
const SAFE_SOURCE_AUDIO = new Set(["", "aac", "mp3", "ac3"]);
async function makeSourceDecodable(buf) {
  let codec;
  try { codec = await audioCodecOf(buf); } catch { return buf; }
  if (SAFE_SOURCE_AUDIO.has(codec)) return buf;
  let inP, outP;
  try {
    const id = crypto.randomUUID();
    inP = path.join(os.tmpdir(), `hk_au_in_${id}.bin`);
    outP = path.join(os.tmpdir(), `hk_au_out_${id}.mp4`);
    await fsp.writeFile(inP, buf);
    const run = (args) => new Promise((resolve) => {
      const p = spawn("ffmpeg", ["-y", "-i", inP, ...args, outP]);
      p.on("close", (code) => resolve(code === 0)); p.on("error", () => resolve(false));
    });
    let ok = await run(["-c:v", "copy", "-c:a", "aac"]);                                  // fast: copy video, transcode audio
    if (!ok) ok = await run(["-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac"]);   // full transcode
    if (!ok) ok = await run(["-c:v", "copy", "-an"]);                                     // last resort: drop audio
    if (!ok) return buf;
    console.log(`[comfy] sanitized source audio (${codec} → aac/none) so ComfyUI can decode it`);
    return await fsp.readFile(outP);
  } catch { return buf; }
  finally { for (const f of [inP, outP]) if (f) fsp.unlink(f).catch(() => {}); }
}

// Is a command-line tool actually runnable here? Probed by RUNNING it rather than by
// looking for a path — a binary that exists but can't execute is the same as absent.
// The promise (not the boolean) is cached, so concurrent callers share one spawn and a
// tool is probed once per process.
const _toolCache = new Map(); // name → Promise<boolean>
function hasLocalTool(name) {
  if (!_toolCache.has(name)) {
    _toolCache.set(name, new Promise((resolve) => {
      const p = spawn(name, ["-version"]);
      p.on("close", (code) => resolve(code === 0));
      p.on("error", () => resolve(false)); // ENOENT — not installed / not on PATH
    }));
  }
  return _toolCache.get(name);
}

// Stitch SCAIL-2's per-segment clips back into one video and lay the source soundtrack
// over the result. See the buildScail2 header for WHY the graph now emits N silent clips
// instead of one finished video.
//
// The audio is NEVER cut to match a segment: it is one stream muxed once onto the
// concatenated picture, which is exactly what the old in-graph
// CreateVideo(audio:["15",1]) did. -shortest then trims it to the picture, which matters
// whenever the render covered less than the whole source (a ⚙ length, or a tail window
// too short to keep).
//
// STREAM COPY FIRST. Every segment comes out of the SAME CreateVideo + SaveVideo
// configuration, so their codec parameters should match and the concat DEMUXER can splice
// them without touching a pixel — the picture then carries exactly ONE generation of
// encoding, ComfyUI's, same as the legacy single-file path. Re-encoding would add a
// second. (An earlier version of this went straight to the concat FILTER, reasoning that
// the differing segment lengths made copy unsafe; that reasoning was wrong — the demuxer
// cares about codec parameters, not duration.)
//
// The parameters are CHECKED rather than assumed, and the check cannot be delegated to
// ffmpeg: MEASURED, the concat demuxer happily stream-copies two clips of DIFFERENT
// RESOLUTIONS without any error, producing a file whose picture size changes partway
// through — worse than a failure, because it looks like success. So every segment is
// probed and copy runs only if the whole set agrees; anything else re-encodes, which is
// also the path an ⚙ H.265 request must take anyway (the segments are H.264 — the
// per-segment files are throwaway intermediates the codec rewrite deliberately skips).
//
// `bufs` must be IN SEGMENT ORDER. `srcBuf` is the audio donor (may be silent or null).
// Returns { buf, codec } — codec being what the picture ACTUALLY is, since an H.265
// request falls back to H.264 rather than failing the render — or null if ffmpeg failed.
async function mergeScail2Segments(bufs, srcBuf, wantCodec, crf, signal) {
  const id = crypto.randomUUID();
  const segPaths = bufs.map((_, i) => path.join(os.tmpdir(), `hk_scail_${id}_${String(i).padStart(3, "0")}.mp4`));
  const srcPath = path.join(os.tmpdir(), `hk_scail_${id}_src.mp4`);
  const listPath = path.join(os.tmpdir(), `hk_scail_${id}_list.txt`);
  const outPath = path.join(os.tmpdir(), `hk_scail_${id}_out.mp4`);
  try {
    await Promise.all(bufs.map((b, i) => fsp.writeFile(segPaths[i], b)));
    let hasAudio = false;
    if (srcBuf && srcBuf.length) {
      hasAudio = !!(await audioCodecOf(srcBuf));
      if (hasAudio) await fsp.writeFile(srcPath, srcBuf);
    }
    const n = bufs.length;
    const ffmpeg = (args, tag) => new Promise((resolve) => {
      const p = spawn("ffmpeg", ["-y", ...args, outPath], signal ? { signal } : undefined);
      let err = "";
      p.stderr.on("data", (d) => { err += d; });
      p.on("close", (code) => {
        if (code !== 0) console.log(`[comfy] scail2 merge ${tag} failed: ${err.trim().split("\n").slice(-3).join(" | ")}`);
        resolve(code === 0);
      });
      p.on("error", () => resolve(false));
    });

    // 1) Stream copy, but only over a set that genuinely agrees — see the header: the
    //    demuxer will NOT refuse a mismatch. The list file's paths are ours (a UUID +
    //    index), so they cannot contain the quote that would need escaping here.
    const tryCopy = async () => {
      const sigs = await Promise.all(segPaths.map(videoParamsOf));
      if (!sigs[0] || !sigs.every((s) => s === sigs[0])) {
        console.log(`[comfy] scail2: segments differ (${[...new Set(sigs)].join(" vs ")}) — re-encoding instead of stream copy`);
        return false;
      }
      await fsp.writeFile(listPath, segPaths.map((p) => `file '${p}'`).join("\n") + "\n");
      const args = ["-f", "concat", "-safe", "0", "-i", listPath];
      if (hasAudio) args.push("-i", srcPath, "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-shortest");
      else args.push("-c", "copy");
      return ffmpeg(args, "stream-copy");
    };
    // 2) Re-encode via the concat filter. Every input is scaled to segment 0's size first:
    //    where the demuxer silently accepts a size change, the FILTER refuses outright
    //    ("Input link parameters do not match"), so without this the mismatch that made us
    //    skip the copy would take the fallback down with it and the render would be lost.
    //    A scale to the size the clip already is costs nothing.
    const size0 = await videoSizeOf(segPaths[0]);
    const tryReencode = (vcodec) => {
      const inputs = [];
      for (const p of segPaths) inputs.push("-i", p);
      if (hasAudio) inputs.push("-i", srcPath);
      const filter = size0
        ? bufs.map((_, i) => `[${i}:v]scale=${size0.w}:${size0.h},setsar=1[v${i}]`).join(";") + ";"
          + bufs.map((_, i) => `[v${i}]`).join("") + `concat=n=${n}:v=1:a=0[v]`
        : bufs.map((_, i) => `[${i}:v]`).join("") + `concat=n=${n}:v=1:a=0[v]`;
      const args = [...inputs, "-filter_complex", filter, "-map", "[v]"];
      if (hasAudio) args.push("-map", `${n}:a`, "-c:a", "aac", "-shortest");
      args.push(...vcodec, "-pix_fmt", "yuv420p");
      return ffmpeg(args, `re-encode ${vcodec[1]}`);
    };

    let ok = false, codec = "h264", how = "";
    // H.265 was asked for → the segments are H.264, so there is nothing copy can do.
    // hevc_videotoolbox (not libx265) to match resampleVideo — hardware HEVC on the Mac
    // this server runs on, and it tags hvc1 so the result actually plays in Safari. It
    // takes no CRF, so ⚙ "video quality" shapes the H.264 path only; libx265 would honour
    // it but software-encode every frame of a clip that is long by definition.
    if (wantCodec === "h265") {
      ok = await tryReencode(["-c:v", "hevc_videotoolbox", "-tag:v", "hvc1"]);
      if (ok) { codec = "h265"; how = "re-encoded"; }
    } else if (await tryCopy()) {
      ok = true; how = "stream-copied (no re-encode)";
      // Report what the picture IS rather than what we assume ComfyUI wrote.
      codec = /hevc|h265/i.test(await videoCodecOf(outPath)) ? "h265" : "h264";
    }
    if (!ok) {
      ok = await tryReencode(["-c:v", "libx264", "-crf", String(crf > 0 ? Math.min(51, crf) : VIDEO_CRF_DEFAULT.h264)]);
      how = "re-encoded";
    }
    if (!ok) return null;
    const buf = await fsp.readFile(outPath);
    console.log(`[comfy] scail2: merged ${n} segment${n > 1 ? "s" : ""} ${how} → ${(buf.length / 1048576).toFixed(1)} MB ${codec}${hasAudio ? " + source audio" : " (source had no audio)"}`);
    return { buf, codec };
  } catch (e) {
    console.log(`[comfy] scail2 merge error: ${(e && e.message) || e}`);
    return null;
  } finally {
    for (const f of [...segPaths, srcPath, listPath, outPath]) fsp.unlink(f).catch(() => {});
  }
}

// ffprobe the FIRST video stream's codec name ("" if absent / ffprobe missing).
async function videoCodecOf(file) {
  return new Promise((resolve) => {
    let out = "";
    const p = spawn("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name", "-of", "default=noprint_wrappers=1:nokey=1", file]);
    p.stdout.on("data", (d) => { out += d; });
    p.on("close", () => resolve(out.trim()));
    p.on("error", () => resolve(""));
  });
}

// First video stream's pixel size, or null when unreadable.
async function videoSizeOf(file) {
  return new Promise((resolve) => {
    let out = "";
    const p = spawn("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", file]);
    p.stdout.on("data", (d) => { out += d; });
    p.on("close", () => { const [w, h] = out.trim().split(",").map(Number); resolve(w > 0 && h > 0 ? { w, h } : null); });
    p.on("error", () => resolve(null));
  });
}

// Everything about a video stream that has to agree before clips can be spliced without
// re-encoding, as one comparable string ("" when unreadable, which reads as "don't copy").
// Deliberately includes width/height: the concat demuxer does NOT reject a size change.
async function videoParamsOf(file) {
  return new Promise((resolve) => {
    let out = "";
    const p = spawn("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,profile,level,width,height,pix_fmt,time_base", "-of", "csv=p=0", file]);
    p.stdout.on("data", (d) => { out += d; });
    p.on("close", () => resolve(out.trim()));
    p.on("error", () => resolve(""));
  });
}

// Fetch a file back out of ComfyUI's INPUT folder (`/view?type=input`). The SCAIL-2
// merge needs the source video's soundtrack, and the source reaches us as a bare
// filename far more often than as bytes — the browser uploads it straight to ComfyUI via
// /api/comfy-upload-video and passes only the name. Returns null when it can't be read.
async function fetchComfyInputFile(name, signal) {
  try {
    const slash = String(name || "").lastIndexOf("/");
    const params = new URLSearchParams({
      filename: slash >= 0 ? name.slice(slash + 1) : name,
      subfolder: slash >= 0 ? name.slice(0, slash) : "",
      type: "input",
    });
    const r = await fetch(`${currentComfyUrl()}/view?${params}`, { signal });
    if (!r.ok) return null;
    return Buffer.from(await r.arrayBuffer());
  } catch { return null; }
}

// One-pass window cap. 241 is the established quality/window ceiling for Wan Animate;
// video longer than this chains via continue_motion (seamless), so there is no reason
// to push a single window past it even when VRAM would allow it.
const ANIMATE_MAX_SINGLE_PASS = 241;
// Node ids for Animate chunk k. Stride 10 (a chunk spans base+0 … base+7). Which node
// wrote chunk k's file — the app fetches each clip from /history by NODE ID, never by
// filename, for the same reason SCAIL-2 does: stampOutputPrefix gives every SaveVideo the
// same prefix, and ComfyUI's counter order is MEASURED not to track chunk order.
const animateSegBase = (k) => 100 + k * 10;
const animateSaveNodeId = (k) => String(animateSegBase(k) + 7);
const ANIMATE_MIN_SINGLE_PASS = 17; // below ~overlap the chain loop can't trim; keep a floor

// Scale the reference (32GB / RTX 5090) frame caps by the TARGET box's VRAM. The key
// physics: 3D-attention peak VRAM ≈ (constant weight floor W) + k·frames — only the
// frame-variable part scales with the budget, so the usable frame count tracks
// (vram − W)/(REF − W), NOT vram/REF. W ≈ 16GiB (14B fp8 diffusion model + text encoder +
// VAE + LoRAs resident at the sampling peak). That distinction matters when going DOWN:
// a 24GB card has 75% the VRAM but only ~50% the frame budget, so a flat 0.75 would OOM.
// Going UP (Spark) a plain multiplier is safe (the window clamp catches the top anyway).
// null/unknown VRAM → 1 (leave the reference table untouched). Mirrors vramCapScale in
// public/js/image-gen.js.
function vramCapScale(vramGib) {
  if (!vramGib) return 1;
  if (vramGib >= 30 && vramGib < 40) return 1; // 32GB reference band (RTX 5090) — table as tuned, guaranteed zero regression
  const W = 16, REF = 32;
  const s = (vramGib - W) / (REF - W);
  if (vramGib < 30) return Math.max(0.2, s);   // below reference — floor-aware & aggressive (erring small only adds segments, never OOMs)
  return Math.min(3, Math.max(1, s));          // above reference — clamp the multiplier (the 241 window cap absorbs the rest)
}

// Frames Wan Animate can generate in one pass, by OUTPUT pixel budget (width×height).
// 3D-attention VRAM/compute grows with (spatial tokens × frames), so higher resolution
// needs a shorter segment. The reference tiers assume a 32GB budget; vramGib rescales
// them for the actual machine (a DGX Spark's 128GB lifts 1080p from 81→~241/pass, a 24GB
// card shrinks them to avoid OOM). Mirrors animateSegmentCap in public/js/image-gen.js
// (there for the progress estimate; this is authoritative — it sizes the real graph chunks).
function animateSegmentCap(pixelBudget, torchCompile = false, vramGib = null) {
  // torch.compile adds VRAM overhead → use one tier shorter segments when it's on
  // (mirrors public/js/image-gen.js).
  const tiers = torchCompile
    ? [[520000, 121], [1000000, 65], [2100000, 33]]
    : [[520000, 241], [1000000, 161], [2100000, 81]]; // 720p 161f (well-tested); 1080p 81f ≈ half of 720p's cap (1080p has ~2.25× the pixels) — conservative vs the 65f→22.9GB measurement
  let base = torchCompile ? 17 : 33;
  for (const [lim, cap] of tiers) if (pixelBudget <= lim) { base = cap; break; }
  const scaled = Math.round(base * vramCapScale(vramGib));
  return Math.max(ANIMATE_MIN_SINGLE_PASS, Math.min(ANIMATE_MAX_SINGLE_PASS, scaled));
}

// The target box's GPU, read from ComfyUI's /system_stats: usable VRAM in GiB
// (devices[].vram_total, in bytes) + a cleaned device name. Cached per endpoint URL —
// static for a machine, but an IP can be reassigned, so a 10-min TTL re-probes. Returns
// { gib:null, gpuName:null } when unreachable / no CUDA device → cap callers fall back to
// the 32GB reference table (no scaling) and the UI shows nothing.
const _vramCache = new Map(); // url → { gib, gpuName, ts }
async function comfyGpuInfo() {
  const url = currentComfyUrl();
  const hit = _vramCache.get(url);
  if (hit && Date.now() - hit.ts < 600000) return { gib: hit.gib, gpuName: hit.gpuName };
  let gib = null, gpuName = null;
  try {
    const r = await fetch(`${url}/system_stats`, { signal: AbortSignal.timeout(5000) });
    if (r.ok) {
      const data = await r.json();
      const cuda = (data.devices || []).filter((d) => d.type === "cuda" && d.vram_total > 0);
      if (cuda.length) {
        // Pick the biggest device (the one a job would run on). Clean the ComfyUI label
        // "cuda:0 NVIDIA GeForce RTX 5090 : cudaMallocAsync" → "NVIDIA GeForce RTX 5090".
        const dev = cuda.reduce((a, b) => (b.vram_total > a.vram_total ? b : a));
        gib = dev.vram_total / (1024 ** 3);
        gpuName = String(dev.name || "").replace(/^cuda:\d+\s*/i, "").replace(/\s*:\s*\w+Async\s*$/i, "").trim() || null;
      }
    }
  } catch { /* unreachable → nulls → no scaling, no UI badge */ }
  _vramCache.set(url, { gib, gpuName, ts: Date.now() });
  return { gib, gpuName };
}
// Back-compat shim for the animateSegmentCap call site (only needs the number).
async function comfyVramGib() { return (await comfyGpuInfo()).gib; }

// Read a model-name enum out of a ComfyUI node's input schema (e.g. the list of
// checkpoints, diffusion models, text encoders or VAEs the server has on disk).
async function comfyEnum(node, input) {
  try {
    const r = await fetch(`${currentComfyUrl()}/object_info/${node}`);
    if (!r.ok) return [];
    const data = await r.json();
    const spec = data?.[node]?.input?.required?.[input] || data?.[node]?.input?.optional?.[input];
    if (!Array.isArray(spec)) return [];
    // Old object_info shape: [[...options...], {...}]. Newer (ComfyUI V3) shape:
    // ["COMBO", { options: [...], multiselect, ... }]. Support both, else the list comes
    // back empty (e.g. UpscaleModelLoader, which uses the new shape → "upscale model" only showed Auto).
    if (Array.isArray(spec[0])) return spec[0];
    if (spec[1] && Array.isArray(spec[1].options)) return spec[1].options;
    return [];
  } catch {
    return [];
  }
}

// Quick reachability ping with its OWN short timeout (independent of the gen
// deadline). When ComfyUI is offline / the IP is wrong, every `comfyEnum` comes
// back empty and the companion resolvers then cry "missing model files" — which is
// misleading. Preflighting lets us say "can't reach ComfyUI" instead.
async function comfyReachable(timeoutMs = 5000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(`${currentComfyUrl()}/system_stats`, { signal: ac.signal });
    return r.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// Instruction-edit models live in diffusion_models/ (loaded via UNETLoader, not
// CheckpointLoaderSimple) and each needs its own workflow + companion files.
function editTypeOf(model) {
  if (!model) return null;
  // Bernini image sentinels route through the instruction-edit dispatch (they take
  // an attached image + an instruction). Checked first — no real filename can equal
  // a sentinel, so this can't shadow a model on disk.
  if (model === BERNINI_IMG_EDIT) return "bernini-i2i";
  if (model === BERNINI_IMG_SUBJECT) return "bernini-r2i";
  if (/kontext/i.test(model)) return "kontext";
  if (/qwen.*edit|qwen[-_]?image[-_]?edit/i.test(model)) return "qwen";
  if (/omnigen/i.test(model)) return "omnigen";
  if (/pix2pix|instruct.?pix|ip2p/i.test(model)) return "ip2p";
  if (/hidream.?e1/i.test(model)) return "hidream-e1";
  if (/boogu.*edit|boogu[-_]?image[-_]?edit/i.test(model)) return "boogu-edit";
  return null;
}

// Edit models that load as a full checkpoint (CLIP+VAE bundled) rather than a
// bare diffusion model needing separate text-encoder/VAE companions.
function editIsCheckpoint(editType) {
  return editType === "ip2p";
}

// Video models (text→video / image→video). Detected by filename.
// LTX-family checkpoints. "sulphur" carries no "ltx" in its filename but is the same
// architecture — VERIFIED by running it through buildLtxVideo unchanged (clean video +
// generated audio, same as ltx-2.3-22b). Without it the file falls through to
// plainCkpts and is offered as a txt2img checkpoint, which would run the generic SD
// path. One constant because the family is matched by NAME in four separate places.
const LTX_MODEL_RE = /ltx|sulphur/i;

// LTX files that are COMPONENTS of a graph, not selectable models. The distilled
// "transformer only" release carries no VAE or text encoder, so every builder here —
// which pulls the VAE out of CheckpointLoaderSimple — would fail on it, and it sorts
// into the video list with the same market name as the real checkpoint (two identical
// "LTX-2.3 22B" entries, one of them broken). It has real uses (the MSR distilled
// route, a future distilled cascade), but always alongside a full checkpoint that
// supplies the VAE — never on its own.
const LTX_COMPONENT_RE = /transformer[-_ ]?only/i;

// Finetunes distributed BOTH as a full checkpoint and as a standalone LoRA of the
// same training. Sulphur is one: sulphur_dev_*.safetensors already contains what
// sulphur_lora_rank_768.safetensors applies, and upstream says not to use both —
// stacking them applies the same finetune twice. So a LoRA is suppressed when the
// selected checkpoint is from the same family. The LoRA's real use is over a
// DIFFERENT base: plain ltx-2.3 + sulphur_lora_rank_768 at strength 1.0 is the
// unmerged route to the same finetune (its metadata — dim/alpha 768/768, module
// networks.lora_ltx2 — marks it as a style/content layer, NOT a step-distiller;
// don't set it to a distiller's 0.4–0.7).
const LORA_BAKED_IN = [/sulphur/i];
function loraBakedIn(model, lora) {
  return LORA_BAKED_IN.some((re) => re.test(model || "") && re.test(lora || ""));
}

// ── 3D mesh generation ───────────────────────────────────────────────────────
// Sentinel for the "TripoSplat" dropdown entry — image → Gaussian splat. Spans five
// weight files (UNET + dino_v3 CLIP-vision + two VAEs + optional birefnet), so the
// entry is synthetic and the pieces are resolved at generation time (meshCompanions).
const TRIPOSPLAT = "triposplat";
// Sentinel for the "MoGe" dropdown entry — photo → textured scene mesh (geometry
// ESTIMATION, not diffusion; no sampler). The checkpoint lives in ComfyUI's
// geometry_estimation/ folder, outside both loader enums we scan, so a sentinel is
// the only way to surface it; the real filename comes off LoadMoGeModel's enum.
const MOGE_MESH = "moge-mesh";
// Same weights, different inference node: 12 perspective crops of an equirectangular
// 360° photo, merged into one spherical mesh. Separate entry rather than an
// auto-detect on aspect ratio — a 2:1 crop of an ordinary photo is not a panorama,
// and guessing wrong wastes a minute of merging.
const MOGE_PANORAMA = "moge-panorama";

// Third classifier next to videoTypeOf/editTypeOf: models whose output is a 3D FILE
// (.glb/.spz), not pixels. Hunyuan3D is a real checkpoint file; the other two are
// sentinels. Anything matched here must be excluded from the plain-image ckpt list
// (see proxyComfyModels) or it would be offered as a broken txt2img entry.
// A model that sits in checkpoints/ but is never something to GENERATE with. SAM3 is
// a segmentation model SCAIL-2 loads for subject tracking — it matches none of the
// edit/video/mesh tests, so without this it falls through into the txt2img list as a
// pickable (and instantly broken) option.
const isCompanionModel = (n) => /sam[-_]?[23]|segment.?anything/i.test(n);

function meshTypeOf(model) {
  if (!model) return null;
  if (model === TRIPOSPLAT) return "triposplat";
  if (model === MOGE_MESH) return "moge";
  if (model === MOGE_PANORAMA) return "moge-pano";
  // hunyuan_3d_v2.1.safetensors — disjoint from videoTypeOf's /hunyuan.?video/.
  if (/hunyuan[._-]?3d/i.test(model)) return "hunyuan3d";
  return null;
}

function videoTypeOf(model) {
  if (!model) return null;
  // Video enhance (interpolate + upscale): a model-free post-process (frame interpolation +
  // AI upscale) on a source video. A fixed sentinel, not a checkpoint filename.
  if (/^video-enhance$/i.test(model)) return "enhance";
  // MiniMax H3 — omni-modal video (text/image/video/audio in, video WITH native stereo
  // audio out). Two weight files, not two modes of one file:
  //   minimax_h3_fl2va_…  → text→video and first/last-frame image→video
  //   minimax_h3_ref2va_… → reference-driven (identity / camera / voice from references)
  // Both are real filenames on disk, so neither needs a sentinel. Placed first because it
  // is disjoint from every ordering trap below — no minimax filename contains wan / ltx /
  // animate / scail / bernini / hunyuan, and none of theirs contains "minimax".
  if (/minimax.?h3/i.test(model)) return "minimax-h3";
  // Bernini (video-edit), Animate (pose-transfer) and SCAIL-2 (character animation)
  // are all WAN variants whose filenames contain "wan" — check them BEFORE the
  // generic /wan/ branch.
  // scail BEFORE animate: the "scail-2 (animate)" sentinel contains BOTH words, and
  // no real filename contains the other's keyword — so this order is unambiguous.
  // Bernini's IMAGE sentinels contain "bernini" but are not video — they must be
  // rejected before the generic /bernini/ test claims them (same ordering trap as
  // scail-before-animate below).
  if (BERNINI_IMAGE_SENTINELS.has(model)) return null;
  // InfiniteTalk: the sentinel gets its own type; the REAL files it consumes are
  // COMPONENTS that must not be claimed by the generic /wan/ test below —
  // the infiniteTalk model patches ship a copy in diffusion_models/ (the wrapper's
  // MultiTalkModelLoader scans there) and the Kijai Wan2.1-I2V-480p UNET is the
  // wrapper's base model, not a standalone hey-koko entry.
  if (/infinitetalk|multitalk/i.test(model)) return (model === INFINITETALK || model === INFINITETALK_SPEAK) ? "infinitetalk" : null;
  if (/wan2[._]1-i2v/i.test(model)) return null; // Kijai Wan2_1-I2V-14B-480p_…_KJ — wrapper component
  if (/bernini/i.test(model)) return "bernini";
  if (/scail/i.test(model)) return "scail2";
  if (/animate/i.test(model)) return "animate";
  // Phantom BEFORE the generic /wan/ branch: its name contains "wan", and it must NOT
  // fall into buildWan14B — Phantom is a SINGLE Wan-2.1 UNET, not a high/low MoE, so
  // the /14b/ MoE path would load one file as both experts and skip its subject nodes.
  if (/phantom/i.test(model)) return "phantom";
  // Wan-Dancer (music → dance) BEFORE the generic /wan/ branch: its filenames
  // ("wan2.2_dancer_14b_global/local_…") contain "wan", but it is a two-expert
  // audio-driven pair, not a plain t2v/i2v UNET — buildWan14B would mis-run it.
  if (/dancer/i.test(model)) return "dancer";
  if (/wan/i.test(model)) return "wan";
  // MSR is an IC-LoRA over the LTX stack, so it rides the "ltx" type; the sentinel name
  // is what tells the builder + preset to take the MSR branch. Checked before the
  // generic LTX test only for clarity — the sentinel carries no "ltx" in its name.
  if (model === LTX_MSR) return "ltx";
  // Union control also rides the LTX stack but needs a SOURCE VIDEO, so it gets its own
  // type to reach a dedicated dispatch branch (the generic "ltx" branch has no video-in).
  if (model === LTX_UNION) return "ltx-union";
  // Component-only LTX files are not selectable models — see LTX_COMPONENT_RE.
  if (LTX_MODEL_RE.test(model)) return LTX_COMPONENT_RE.test(model) ? null : "ltx";
  if (/hunyuan.?video/i.test(model)) return "hunyuan";
  return null;
}

// Model identity (canonical ids) + quantisation-variant recognition live in
// server/model-names.js — the gallery and the picker need the same answers.

// Every model file ComfyUI can load (both loaders) — the pool pickPrecision searches.
async function comfyModelFiles() {
  const [unets, ckpts] = await Promise.all([
    comfyEnum("UNETLoader", "unet_name").catch(() => []),
    comfyEnum("CheckpointLoaderSimple", "ckpt_name").catch(() => []),
  ]);
  return [...unets, ...ckpts];
}

// Apply the ⚙ precision preference to a selection. Returns the file(s) to load plus
// a note naming the tiers ACTUALLY used whenever they differ from the request, so a
// fallback is never silent.
//
// A two-expert MoE (bernini / WAN 2.2 14B) is resolved PER EXPERT: the twins are
// separate UNETLoaders, so a tier only one of them ships in runs mixed rather than
// failing, and the mix is surfaced on the done-line. Quantised twins tend to land
// one at a time, so a pair is half-converted for as long as that takes.
// Best file for one expert: the asked-for tier, else the PREC_AUTO_ORDER default for
// what that model ships. null = no such model.
function pickByBase(all, base, pref) {
  const group = (all || []).filter((n) => precisionBase(n) === base);
  if (!group.length) return null;
  return group.find((n) => precisionOf(n) === pref) || bestTier(group);
}

async function resolvePrecision(model, pref) {
  // `used` names the tier actually loaded and is always filled in, including under
  // "auto" — the done-line states it every time, so it cannot depend on a preference
  // having been expressed. `note` is the narrower "you did not get what you asked
  // for" signal and stays null when the request was honoured.
  const out = { model, experts: null, note: null, used: precisionOf(model) };
  if (!model || !pref || pref === "auto") return out;
  // Sentinels that name a PIPELINE rather than a weight file: an upscale chain loads an
  // ESRGAN net, a mesh chain ships one file, and none of them has a quantised sibling to
  // pick between. The ⚙ tier is hidden for these in the UI but still travels with the
  // request (it is a persistent setting, not a per-run one), and without this guard it
  // came back as "no build at the precision you selected" — a warning about a choice the
  // pipeline never had.
  if (PRECISION_FREE.has(model)) return out;
  const all = await comfyModelFiles();
  // A two-expert MoE is identified by its NAME. It must NOT be identified by "does the
  // same-precision twin exist", which looks equivalent but isn't: bernini's mxfp8 high
  // has no mxfp8 low, so that test reads an already-mxfp8 selection as a single model,
  // leaves experts unset, and lets the builder derive — and 404 on — low_noise_mxfp8.
  // Matching each twin by its precision-stripped BASE sidesteps that entirely.
  if (/high_noise|low_noise/i.test(model)) {
    const h = pickByBase(all, precisionBase(model.replace(/low_noise/i, "high_noise")), pref);
    const l = pickByBase(all, precisionBase(model.replace(/high_noise/i, "low_noise")), pref);
    if (h && l) {
      out.experts = { high: h, low: l };
      out.model = /low_noise/i.test(model) ? l : h;
      const th = precisionOf(h), tl = precisionOf(l);
      out.used = th === tl ? th : `${th} + ${tl}`;
      if (th !== tl) out.note = out.used;                 // mixed — one twin lacks the tier
      else if (th !== pref) out.note = th || "unknown";   // neither twin ships the tier
      return out;
    }
    // Only one half is on disk — not a usable pair; fall through and treat it as a
    // single model rather than inventing a twin.
  }
  out.model = pickPrecision(all, model, pref);
  const t = precisionOf(out.model);
  out.used = t;
  if (t !== pref) out.note = t || "unknown";            // no sibling at the asked tier
  return out;
}

// Sentinel for the merged WAN 2.2 14B dropdown entry — resolved at generation
// time to the real t2v or i2v high_noise checkpoint depending on whether the
// user attached a reference image.
const WAN14B_AUTO = "wan2.2_14B";

async function resolveWan14bAuto(isImg2Img) {
  const [ckpts, unets] = await Promise.all([
    comfyEnum("CheckpointLoaderSimple", "ckpt_name"),
    comfyEnum("UNETLoader", "unet_name"),
  ]);
  const all = [...ckpts, ...unets];
  const kind = isImg2Img ? "i2v" : "t2v";
  return all.find((n) => /14b/i.test(n) && new RegExp(kind, "i").test(n) && /high_noise/i.test(n)) || null;
}

// Sentinel for the merged Bernini dropdown entry — resolved at generation time to
// the real high_noise GGUF/safetensors (the low twin is derived from the name).
const BERNINI_AUTO = "bernini";

// Sentinel for the "bernini (insert)" entry — ads2v. Same model and same two experts
// as the plain entry; the only difference is WHERE the attached image is bound. Plain
// bernini binds it to reference_images (an in-context subject reference → rv2v), while
// insert binds it to reference_video (the thing to composite INTO the clip → ads2v).
// One image can't be both, so the mode has to be picked in the dropdown.
const BERNINI_INSERT = "bernini_insert";

// ── Bernini IMAGE side ───────────────────────────────────────────────────────
// Bernini-R is not video-only: the SAME BerniniConditioning graph produces a
// still when `length = 1` (verified from the official image-editing template —
// its subgraph exposes the real node input `source_video` (IMAGE) and ships
// length=1). Three image tasks, split into their own dropdown entries because
// they differ ONLY by which input the attached image is bound to:
//   • i2i — image → source_video  (edit this picture: relight, swap background…)
//   • r2i — image(s) → reference_images  (compose a NEW picture from subjects)
//   • t2i — nothing connected     (plain text→image)
// i2i and r2i take the same user input (images), so the mode can't be inferred.
const BERNINI_IMG_EDIT = "bernini_image_edit";
const BERNINI_IMG_SUBJECT = "bernini_subject_image";
const BERNINI_T2I = "bernini_text_image";
// Text → a wrapping equirectangular panorama. Not a model: a graph that generates
// with an ordinary checkpoint and then REPAIRS the wrap seam, which is the one
// thing a normal model gets wrong (measured: its left and right edges mismatch
// twice as much as two genuinely adjacent columns do).
// Where this app's files land inside ComfyUI/output/. Everything carries the
// `heykoko_` prefix so it clusters together in a directory listing shared with
// whatever else that machine renders, and each folder says what is in it — one
// `heykoko/` holding meshes and panoramas side by side told you nothing when you
// opened it. Flat outputs (images, video) already use the same prefix as a filename.
const OUT_3D = "heykoko_3d";      // .glb — Hunyuan3D, TripoSplat, MoGe
const OUT_PANO = "heykoko_pano";  // equirectangular 360° stills
const OUT_IMG = "heykoko_img";    // stills — generation, instruction edits, upscale
const OUT_VID = "heykoko_vid";    // video, every family
const OUT_TMP = "heykoko_tmp";    // working files that are not results (auto-mask previews)

// Rewrite every save node's filename_prefix to `<folder>/<model>`, just before the
// graph is queued.
//
// Left to the builders this drifted badly: thirteen image builders all wrote a flat
// `heykoko_*.png`, so a Flux render and a Qwen edit were indistinguishable in a folder
// of thousands; seven video builders shared `heykoko_vid` while eight others happened
// to carry their own name, with no rule behind which was which. Stamping here instead
// means a builder cannot get it wrong, and the name follows the MODEL, which is the
// thing you are actually looking for when you go digging.
//
// Runs last, after the VFI and codec tails have rewritten the graph — those copy the
// prefix they find onto the nodes they add, so stamping earlier would be undone.
// Hy3D21ExportMesh is skipped: it reports nothing to /history, so the server fetches
// it back by the exact per-run prefix it passed in, and renaming it would lose it.
const SAVE_NODES = new Set(["SaveImage", "SaveVideo", "SaveGLB", "SaveAudio", "VHS_VideoCombine"]);
function stampOutputPrefix(wf, folder, model) {
  // ComfyUI builds a real path out of this, so anything that could climb out of
  // output/ or confuse the counter suffix has to go.
  const stem = String(model || "out")
    .replace(/\.(safetensors|ckpt|gguf|pth|sft|bin)$/i, "")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[._]+/, "")
    .slice(0, 60) || "out";
  let n = 0;
  for (const node of Object.values(wf)) {
    if (!SAVE_NODES.has(node.class_type) || !node.inputs) continue;
    if (node.class_type === "Hy3D21ExportMesh") continue;
    if (!("filename_prefix" in node.inputs)) continue;
    node.inputs.filename_prefix = `${folder}/${stem}`;
    n++;
  }
  return n;
}

const PANO_T2I = "panorama_360_text";
// The image sentinels resolve to the same weights as the video ones.
const BERNINI_IMAGE_SENTINELS = new Set([BERNINI_IMG_EDIT, BERNINI_IMG_SUBJECT, BERNINI_T2I]);

async function resolveBerniniAuto() {
  const unets = await comfyEnum("UNETLoader", "unet_name");
  // Exclude the S2V (speech-to-video) weights: they share the bernini + high_noise
  // naming but are a DIFFERENT model type (WAN22_S2V) that the plain
  // BerniniConditioning graph cannot drive — picking one here would silently break
  // every working Bernini mode. See the Bernini-R S2V notes.
  return unets.find((n) => /bernini/i.test(n) && /high_noise/i.test(n) && !/_s2v\b|_s2v[._]/i.test(n)) || null;
}

// Sentinel for the "wan animate (replace)" dropdown entry. Replace mode reuses the
// SAME Animate UNET as Move — only the workflow differs (it adds a person mask +
// blacked-out background so the character is composited back into the source scene).
// Resolved at generation time to the real animate UNET filename.
const ANIMATE_REPLACE = "wan_animate_replace";

// Sentinel for the "scail-2 (animate)" dropdown entry. SCAIL-2 has the same two
// modes as Wan Animate but picks them with ONE node flag (replacement_mode), so
// both entries resolve to the SAME UNET — Replacement is the model's own default
// (and this dropdown's base entry), Animation is this sentinel.
const SCAIL2_ANIMATE = "scail2_animate";

async function resolveScail2Unet() {
  const unets = await comfyEnum("UNETLoader", "unet_name");
  return unets.find((n) => videoTypeOf(n) === "scail2") || null;
}

// Sentinel for LTX-2.3 MSR (Licon Multiple Subject Reference v2) — reference images of
// people / clothing / objects keep their identity across the generated clip. Not a
// checkpoint of its own: it is an IC-LoRA over the LTX-2.3 stack, so the entry only
// appears when every part is installed (see ltxMsrParts). Sibling in spirit to Phantom
// on the WAN side, but wired through LTX's IC-LoRA nodes.
const LTX_MSR = "ltx-msr";
// Subject slots on the LiconMSR node are literally named "1".."4"; a background image
// is separate and — despite object_info marking it optional — is REQUIRED at execute().
const LTX_MSR_MAX_SUBJECTS = 4;
// The reference stills are packed into a short "pseudo-video" whose frame count must
// stay BELOW the clip length, or LTXAddVideoICLoRAGuide fails with "Conditioning frames
// exceed the length of the latent sequence". 17 is the smallest the node offers and the
// value verified here — larger counts let the reference sequence bleed into the result
// (65 against a 121-frame clip produced a visible double exposure).
const LTX_MSR_REF_FRAMES = "17";

// Sentinel for LTX-2.3 IC-LoRA Union Control — a DRIVING VIDEO's depth structure
// (extracted by MoGe) plus a reference still drive a new clip: the output follows the
// source video's motion / camera / geometry while its appearance comes from the
// reference + prompt. NOT identity-preserving (unlike Animate / SCAIL-2) — this is
// structure/motion transfer. Like MSR it's an IC-LoRA over LTX-2.3, so the entry only
// appears when every piece is installed (see ltxUnionParts). Needs BOTH a source video
// and a reference image, so it lives in the "needs source video" UI group.
const LTX_UNION = "ltx-union";

// Sentinel for InfiniteTalk V2V (audio-driven video dubbing / lip re-sync) — a SOURCE
// VIDEO plus a SPEECH AUDIO file: the clip is regenerated following the source's motion,
// identity and scene while the mouth/face follow the new audio. Runs on Kijai's
// ComfyUI-WanVideoWrapper (the native WanInfiniteTalkToVideo node has NO source-video
// input — image+audio only), over the Wan2.1 I2V 480p model + the InfiniteTalk model
// patch + a wav2vec2 audio encoder. Recipe LIVE-VERIFIED on the box (92-frame dub,
// identity/motion/scene preserved): 4-step lightx2v distill, cfg 1, dpm++_sde, shift 11,
// start_step 2 + add_noise_to_samples — the "keep the source's structure, denoise only
// the tail steps" v2v trick. Long audio is windowed IN the sampler (81-frame windows,
// 9-frame motion overlap) — no client-side chunking.
const INFINITETALK = "infinitetalk";
// Sentinel for InfiniteTalk I2V ("photo speaks"): a PERSON PHOTO + speech → a talking
// video, lips synced. The speech comes from an attached audio file — or, with none
// attached, the /imagine PROMPT is the text to read: the server synthesizes it with the
// local TTS daemon (Kokoro, same engine as /voice) and feeds the wav in. Same wrapper
// stack as the V2V entry; graph differences: no source-video latents (nothing to
// preserve → full 6-step denoise from step 0), LoadImage instead of LoadVideo, 25 fps.
const INFINITETALK_SPEAK = "infinitetalk_speak";

// Everything MSR needs, or null when a piece is absent (the entry is then hidden rather than
// offered broken). Two routes, both end-to-end verified:
//   • CLEAN (preferred) — ONE full distilled-fp8 checkpoint provides the transformer AND its
//     own VAE / audio VAE / text projection. Verified 2026-07-20 to be sharpness- and
//     identity-equivalent to the mashup (same seed/refs → near-identical faces, no blur): the
//     distilled-fp8 transformer IS the one the 8-step sigma table was tuned for.
//   • MASHUP (fallback) — the transformer-only distilled UNET + a separate dev checkpoint for
//     VAE/audio/encoder, kept so MSR still runs if the full checkpoint isn't on disk.
// The IC-LoRA nodes ship with ComfyUI-LTXVideo, LiconMSR with ComfyUI-Licon-MSR,
// PromptRelayEncode with ComfyUI-PromptRelay.
async function ltxMsrParts(pref) {
  const [ckpts, unets, loras, clips, nodes] = await Promise.all([
    comfyEnum("CheckpointLoaderSimple", "ckpt_name").catch(() => []),
    comfyEnum("UNETLoader", "unet_name").catch(() => []),
    comfyEnum("LoraLoaderModelOnly", "lora_name").catch(() => []),
    comfyEnum("CLIPLoader", "clip_name").catch(() => []),
    comfyHasNodes(["LiconMSR", "LTXICLoRALoaderModelOnly", "LTXAddVideoICLoRAGuide", "PromptRelayEncode"]),
  ]);
  const find = (list, re) => (list || []).find((n) => re.test(n)) || null;
  // Prefer the V2 IC-LoRA explicitly. A bare first-match would pick V1 if both are on
  // disk ("…-MSR-V1" sorts before "…-V2"), silently downgrading. Fall back to any
  // Licon-MSR build so a machine with only V1 (or a renamed file) still works.
  const msrLora = find(loras, /licon.*msr.*v2|msr.*v2/i) || find(loras, /licon.*msr/i);
  const encoder = find(clips, /gemma.*12b/i) || find(clips, /gemma_?3/i);
  // Precision-by-TIER (not the generic pickPrecision base-swap): the mxfp8 files carry a
  // "_block32" suffix, so their precisionBase differs and the base-match would silently miss.
  const pickTier = (poolList) => (pref && pref !== "auto" && poolList.find((n) => precisionOf(n) === pref))
    || bestTier(poolList);
  // CLEAN path — the full distilled checkpoint (exclude the transformer-only component file).
  const fullDistilled = (ckpts || []).filter((n) => /ltx.*distill/i.test(n) && !/transformer[-_ ]?only/i.test(n));
  const fullCkpt = pickTier(fullDistilled);
  if (nodes && fullCkpt && msrLora && encoder) {
    return { clean: true, baseCkpt: fullCkpt, transformerTier: precisionOf(fullCkpt), msrLora, encoder };
  }
  // MASHUP fallback.
  const transformers = (unets || []).filter((n) => /ltx.*transformer[-_ ]?only/i.test(n));
  const distilled = transformers.filter((n) => /distill/i.test(n));
  const transformer = pickTier(distilled.length ? distilled : transformers);
  const parts = {
    baseCkpt: find(ckpts, /ltx.?2\.3.*dev/i) || find(ckpts, /ltx/i),
    transformer,
    transformerTier: transformer ? precisionOf(transformer) : null,
    msrLora, encoder,
  };
  const ok = nodes && parts.baseCkpt && parts.transformer && parts.msrLora && parts.encoder;
  return ok ? parts : null;
}

// Everything Union Control needs, or null when a piece is absent. Unlike MSR this uses
// the FULL distilled checkpoint (not the transformer-only file): its 8-step cfg-1 schedule
// needs the distilled weights, and its VAE + audio VAE + text projection come from the same
// checkpoint. MoGe turns the driving video into a depth sequence; the union-control IC-LoRA
// (loaded via a plain LoraLoaderModelOnly, its params read by GetICLoRAParameters) locks the
// generation to that structure. All nodes ship with ComfyUI-LTXVideo + the MoGe + video packs.
async function ltxUnionParts(pref) {
  const [ckpts, loras, clips, moge, nodes] = await Promise.all([
    comfyEnum("CheckpointLoaderSimple", "ckpt_name").catch(() => []),
    comfyEnum("LoraLoaderModelOnly", "lora_name").catch(() => []),
    comfyEnum("LTXAVTextEncoderLoader", "text_encoder").catch(() => []),
    comfyEnum("LoadMoGeModel", "model_name").catch(() => []),
    comfyHasNodes([
      "LoraLoaderModelOnly", "GetICLoRAParameters", "LTXVAddGuide", "LTXVImgToVideoInplace",
      "LoadMoGeModel", "MoGeInference", "MoGeRender", "GetVideoComponents", "Video Slice",
      "LTXAVTextEncoderLoader", "LTXVAudioVAELoader", "LTXVConcatAVLatent", "LTXVSeparateAVLatent",
      "LTXVCropGuides", "LTXVEmptyLatentAudio", "EmptyLTXVLatentVideo",
    ]),
  ]);
  const find = (list, re) => (list || []).find((n) => re.test(n)) || null;
  // The FULL distilled checkpoint (exclude the transformer-only component file, which has
  // no VAE). It can ship in several precisions (fp8 / mxfp8 / nvfp4); pick by ⚙ preference,
  // else the PREC_AUTO_ORDER default — precisionTierNote names whichever it lands on.
  const distilled = (ckpts || []).filter((n) => /ltx.*distill/i.test(n) && !/transformer[-_ ]?only/i.test(n));
  const ckpt = (pref && pref !== "auto" && distilled.find((n) => precisionOf(n) === pref))
    || bestTier(distilled);
  const parts = {
    ckpt,
    ckptTier: ckpt ? precisionOf(ckpt) : null,
    unionLora: find(loras, /union.?control/i),
    encoder: find(clips, /gemma.*12b/i) || find(clips, /gemma_?3/i),
    mogeModel: find(moge, /moge/i),
  };
  const ok = nodes && parts.ckpt && parts.unionLora && parts.encoder && parts.mogeModel;
  return ok ? parts : null;
}

// Everything InfiniteTalk V2V needs. Wrapper-based (WanVideoWrapper node family), so the
// loaders are the wrapper's own: WanVideoModelLoader scans diffusion_models/,
// MultiTalkModelLoader too (hence the patch copies there), Wav2VecModelLoader scans
// models/wav2vec2/. The text encoder is the NATIVE CLIPLoader + WanVideoTextEmbedBridge:
// the wrapper's own text encoders reject comfy's scaled-fp8 umt5 ("fp8 scaled is not
// supported"), while the native loader handles it — bridging CONDITIONING across is the
// verified path that avoids an 11GB duplicate umt5 download.
const INFINITETALK_NODES = [
  "WanVideoModelLoader", "MultiTalkModelLoader", "Wav2VecModelLoader", "MultiTalkWav2VecEmbeds",
  "WanVideoImageToVideoMultiTalk", "WanVideoSampler", "WanVideoDecode", "WanVideoEncode",
  "WanVideoVAELoader", "WanVideoBlockSwap", "WanVideoLoraSelect", "WanVideoClipVisionEncode",
  "WanVideoTextEmbedBridge", "ImageResizeKJv2", "GetImageRangeFromBatch", "GetImageSizeAndCount",
];
async function infinitetalkParts() {
  const [wrapModels, patches, wav2vec, clips, cvs, loras, nodes] = await Promise.all([
    comfyEnum("WanVideoModelLoader", "model").catch(() => []),
    comfyEnum("MultiTalkModelLoader", "model").catch(() => []),
    comfyEnum("Wav2VecModelLoader", "model").catch(() => []),
    comfyEnum("CLIPLoader", "clip_name").catch(() => []),
    comfyEnum("CLIPVisionLoader", "clip_name").catch(() => []),
    comfyEnum("LoraLoaderModelOnly", "lora_name").catch(() => []),
    comfyHasNodes(INFINITETALK_NODES),
  ]);
  const find = (list, re) => (list || []).find((n) => re.test(n)) || null;
  // The wrapper's VAE loader lists vae/ files under its own combo; probe it separately
  // (its input is model_name, unlike the native VAELoader's vae_name).
  const wrapVaes = await comfyEnum("WanVideoVAELoader", "model_name").catch(() => []);
  const parts = {
    // Wan2.1 I2V 480p base (the Kijai fp8-scaled repack is what was verified).
    model: find(wrapModels, /wan2[._]1-i2v.*480p/i) || find(wrapModels, /wan.?2[._]1.*i2v.*14b/i),
    // Prefer the single-speaker patch (single-person dubbing); fall back to multi.
    patch: find(patches, /infinitetalk.*single/i) || find(patches, /infinitetalk/i),
    wav2vec: (wav2vec || [])[0] || null,
    clip: find(clips, /umt5/i),
    vae: find(wrapVaes, /wan.?2[._]1.*vae/i) || find(wrapVaes, /wan.*vae/i),
    clipVision: find(cvs, /clip_vision_h|clip.?vision.*h\b/i) || find(cvs, /clip.?vision/i),
    // The 4-step cfg-1 schedule is bound to this distill LoRA — required, not optional.
    lora: find(loras, /lightx2v.*i2v.*14b.*distill|lightx2v_I2V_14B/i),
  };
  const ok = nodes && parts.model && parts.patch && parts.wav2vec && parts.clip && parts.vae && parts.clipVision && parts.lora;
  return ok ? parts : null;
}
// Gen-time variant: same lookups, but a missing piece THROWS with the shopping list.
async function infinitetalkCompanions() {
  const parts = await infinitetalkParts();
  if (parts) return parts;
  throw new Error("Missing pieces required by InfiniteTalk V2V:\n- ComfyUI-WanVideoWrapper custom node (git clone into custom_nodes/)\n- diffusion_models/Wan2_1-I2V-14B-480p_fp8_e4m3fn_scaled_KJ.safetensors\n- diffusion_models/wan2.1_infiniteTalk_single_fp16.safetensors (copy of the model_patches file)\n- models/wav2vec2/wav2vec2-chinese-base_fp16.safetensors\n- vae/Wan2_1_VAE_bf16.safetensors · text_encoders/umt5_xxl…scaled · clip_vision_h · loras/lightx2v_I2V_14B_480p…");
}

// Everything Wan-Dancer needs beyond the selected GLOBAL expert (the dropdown entry),
// or a THROW with the shopping list. All-native stack (the WanDancer* nodes ship with
// ComfyUI ≥ 0.29): the LOCAL expert twin, the lightx2v I2V distill LoRA (global turbo
// strength 3 / local 1.03 — from the official video_wan_dancer template), umt5, the
// Wan 2.1 VAE and clip_vision_h.
const WAN_DANCER_NODES = [
  "WanDancerVideo", "WanDancerEncodeAudio", "WanDancerPadKeyframesList",
  "TrimAudioDuration", "LatentCutToBatch", "SkipLayerGuidanceDiTSimple", "RebatchImages",
];
async function wanDancerCompanions(globalModel) {
  const [unets, loras, clips, cvs, vaes, nodes] = await Promise.all([
    comfyEnum("UNETLoader", "unet_name").catch(() => []),
    comfyEnum("LoraLoaderModelOnly", "lora_name").catch(() => []),
    comfyEnum("CLIPLoader", "clip_name").catch(() => []),
    comfyEnum("CLIPVisionLoader", "clip_name").catch(() => []),
    comfyEnum("VAELoader", "vae_name").catch(() => []),
    comfyHasNodes(WAN_DANCER_NODES),
  ]);
  const find = (list, re) => (list || []).find((n) => re.test(n)) || null;
  // The local twin is the global file with global→local swapped — exact-name first,
  // then any dancer+local file (renames / mixed precision still pair up).
  const twin = globalModel.replace(/global/i, "local");
  const parts = {
    global: globalModel,
    local: (unets || []).includes(twin) ? twin : find(unets, /dancer.*local|local.*dancer/i),
    lora: find(loras, /lightx2v.*i2v.*14b.*distill|lightx2v_I2V_14B/i),
    clip: find(clips, /umt5/i),
    clipVision: find(cvs, /clip_vision_h|clip.?vision.*h\b/i) || find(cvs, /clip.?vision/i),
    vae: find(vaes, /wan.?2[._]1.*vae/i) || find(vaes, /wan.*vae/i),
  };
  if (nodes && parts.local && parts.lora && parts.clip && parts.clipVision && parts.vae) return parts;
  throw new Error("Missing pieces required by Wan-Dancer:\n- ComfyUI ≥ 0.29 (native WanDancer* nodes)\n- diffusion_models/wan2.2_dancer_14b_global_fp8_scaled.safetensors + …_local_fp8_scaled.safetensors\n- loras/lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16.safetensors\n- text_encoders/umt5_xxl… · clip_vision/clip_vision_h · vae/Wan2_1_VAE…");
}

// Whether every named node class is registered on the target ComfyUI. Probed one by
// one (/object_info/<name> returns {} for an unknown class) rather than pulling the
// full node table, which is megabytes on a well-stocked install.
async function comfyHasNodes(names) {
  const base = currentComfyUrl();
  const found = await Promise.all(names.map(async (n) => {
    try {
      const r = await fetch(`${base}/object_info/${n}`);
      if (!r.ok) return false;
      const d = await r.json();
      return !!(d && d[n]);
    } catch { return false; }
  }));
  return found.every(Boolean);
}

// Sentinel for the "video enhance" (interpolate + upscale) dropdown entry — a source video is
// AI-upscaled and frame-interpolated to a target fps. Has no diffusion model, so it
// resolves to nothing on disk; the pipeline is built directly at generation time.
const VIDEO_ENHANCE = "video-enhance";

// Sentinel for the "image upscale" (image HD / upscale) dropdown entry — an attached
// image is run through the AI upscale model. Lives in the image `models` list; the
// dispatch matches it by exact name (no diffusion model, no companion files).
const IMAGE_UPSCALE = "image-upscale";

// Dropdown entries that are a pipeline, not a weight file — no quantisation to prefer.
// Read by resolvePrecision, which runs long after this module has finished loading.
const PRECISION_FREE = new Set([VIDEO_ENHANCE, IMAGE_UPSCALE, TRIPOSPLAT, MOGE_MESH, MOGE_PANORAMA]);

// ── Dropdown display metadata ────────────────────────────────────────────────
// The picker used to show raw filenames in scan order, so the same list mixed
// clean labels ("wan2.2_14B") with precision-suffixed ones ("…_fp8_e4m3fn") and
// the entries fell in whatever order the disk returned. Names now come from
// model-names.js (canonical id → label); what remains here is the stable
// within-group order and the capability tags the frontend draws as coloured dots.

// Capability tags shown as coloured dots after the model. Codes travel to the
// frontend (which owns the emoji + legend), so the palette lives in one place.
//   image → txt2img/img2img · edit → instruction edit · t2v/i2v → video gen
//   v2v   → needs a source video (video-edit / pose transfer) · tool → model-free
// `group` is "image" | "edit" | "video"; `entry` is the video-list object.
function capsFor(name, group, type, entry) {
  if (name === IMAGE_UPSCALE || name === VIDEO_ENHANCE) return ["tool"];
  if (group === "mesh") return ["mesh"];
  if (name === BERNINI_T2I) return ["image"];
  if (name === PANO_T2I) return ["image"];
  if (name === BERNINI_IMG_EDIT || name === BERNINI_IMG_SUBJECT) return ["edit"];
  if (group === "image") return /hidream.?o1/i.test(name) ? ["image", "edit"] : ["image"];
  if (group === "edit") return ["edit"];
  // video: a source-video model is v2v; bernini also accepts a plain image (i2v).
  if (name === LTX_UNION) return ["v2v", "audio"]; // depth-driven; LTX decodes a soundtrack
  if (name === INFINITETALK) return ["v2v", "audio"]; // audio-DRIVEN dubbing (lip re-sync to a speech file)
  if (name === INFINITETALK_SPEAK) return ["i2v", "audio"]; // photo + speech/TTS → talking video
  if (type === "dancer") return ["i2v", "audio"]; // reference photo + MUSIC → dance video synced to it
  // MiniMax H3 generates its soundtrack in the same forward pass as the picture (one
  // latent, two VAEs at decode) — the same "audio" claim LTX gets. ref2va takes images
  // AND a clip as references, so it carries both i2v and v2v (like BERNINI_AUTO, whose
  // source video is optional too). Checked BEFORE the generic needsVideo rule below,
  // which would otherwise flatten it to a bare ["v2v"] and drop the audio claim.
  if (type === "minimax-h3") return /ref2va/i.test(name) ? ["i2v", "v2v", "audio"] : ["t2v", "i2v", "audio"];
  if (entry && entry.needsVideo) return name === BERNINI_AUTO ? ["i2v", "v2v"] : ["v2v"];
  if (name === LTX_MSR) return ["i2v", "audio"];   // reference-image driven, generates a soundtrack
  switch (type) {
    case "phantom": return ["i2v"];
    case "hunyuan": return ["t2v"];
    // LTX is the only model that GENERATES a soundtrack (its own audio VAE decodes an
    // audio latent sampled alongside the video). bernini / animate / scail also ship
    // video with sound, but that is the SOURCE clip's audio carried through — not the
    // same claim, so they don't get this tag.
    case "ltx": return ["t2v", "i2v", "audio"];
    case "wan": return /fun.?vace/i.test(name) ? ["t2v", "v2v"] : ["t2v", "i2v"];
    default: return ["t2v"];
  }
}

// Stable within-group order (was disk-scan order). Lower rank sorts first;
// the sentinels are pinned relative to the base file they split from (animate
// move before replace, scail animate before replace).
function imageRank(n) {
  if (n === BERNINI_T2I) return 9; // after the dedicated txt2img models
  if (n === PANO_T2I) return 10; // last: a recipe, not a checkpoint
  if (/flux/i.test(n)) return 1;
  if (/pony/i.test(n)) return 2;
  if (/hidream.?i1/i.test(n)) return 3;
  if (/hidream.?o1/i.test(n)) return 4;
  if (/z.?image/i.test(n)) return 5;
  if (/boogu.*base/i.test(n)) return 6;
  if (/boogu.*turbo/i.test(n)) return 7;
  if (/qwen/i.test(n)) return 8;
  return 50;
}
function editRank(n) {
  // Bernini's image tasks group together at the end of the edit list.
  if (n === BERNINI_IMG_EDIT) return 7;
  if (n === BERNINI_IMG_SUBJECT) return 8;
  if (/kontext/i.test(n)) return 1;
  if (/qwen/i.test(n)) return 2;
  if (/hidream/i.test(n)) return 3;
  if (/omnigen/i.test(n)) return 4;
  if (/boogu/i.test(n)) return 5;
  if (/pix2pix|instruct.?pix/i.test(n)) return 6;
  return 50;
}
function videoRank(n) {
  if (n === WAN14B_AUTO) return 1;
  if (/ti2v.*5b/i.test(n)) return 2;
  if (/fun.?vace/i.test(n)) return 3;
  if (/phantom.*14b/i.test(n)) return 4;
  if (/phantom/i.test(n)) return 5;
  if (/hunyuan/i.test(n)) return 6;
  // MiniMax H3 sits with the general generators; ref2va right after its fl2va sibling.
  if (/minimax.?h3.*ref2va/i.test(n)) return 6.6;
  if (/minimax.?h3/i.test(n)) return 6.5;
  if (LTX_MODEL_RE.test(n)) return 7;
  // scail BEFORE animate: the "scail2_animate" sentinel contains "animate", so the
  // generic /animate/ test would otherwise claim it (same ordering trap as videoTypeOf).
  if (n === LTX_MSR) return 7.5;
  if (n === INFINITETALK_SPEAK) return 7.6; // photo→talking video, lives in the gen group
  if (/dancer/i.test(n)) return 7.7;        // photo+music→dance video, same neighbourhood
  if (n === SCAIL2_ANIMATE) return 10;
  if (/scail/i.test(n)) return 11;
  if (n === ANIMATE_REPLACE) return 9;
  if (/animate/i.test(n)) return 8;
  if (n === BERNINI_AUTO) return 12;
  if (n === BERNINI_INSERT) return 13;
  if (n === INFINITETALK) return 13.5;
  if (n === VIDEO_ENHANCE) return 14;
  return 50;
}
function meshRank(n) {
  if (meshTypeOf(n) === "hunyuan3d") return 1; // the "real" 3D generator first
  if (n === TRIPOSPLAT) return 2;
  if (n === MOGE_MESH) return 3;
  if (n === MOGE_PANORAMA) return 4;
  return 50;
}

// Whether a model's integration is READY — end-to-end verified on real hardware
// AND fully wired into a build graph. An allowlist: anything not matched here is
// treated as NOT ready (greyed + warned in the picker, but still selectable so it
// can be tested and then promoted). This is CURATED developer knowledge — the code
// can't tell a verified integration from a merely-wired one — so it's meant to be
// edited by hand as models get verified. Seeded from the project roadmap.
function isModelReady(name, group, type) {
  if (name === IMAGE_UPSCALE || name === VIDEO_ENHANCE) return true; // model-free tools
  // Sentinels carry a synthetic name (not a filename) — match them by exact id.
  if (name === WAN14B_AUTO) return true;    // Wan 2.2 14B t2v+i2v — verified
  if (name === BERNINI_AUTO) return true;   // Bernini v2v / rv2v — verified end-to-end
  if (name === SCAIL2_ANIMATE) return true; // SCAIL-2 animate — verified
  if (name === LTX_MSR) return true;        // MSR V2 — verified (sharp, identity preserved)
  if (name === LTX_UNION) return true;      // Union Control — verified end-to-end (depth transfer, sharp)
  if (name === ANIMATE_REPLACE) return true; // Replace verified end-to-end (scene kept, person swapped)
  if (name === INFINITETALK) return true;    // V2V dub recipe verified live (92-frame lip re-sync, trim tail exact)
  if (name === INFINITETALK_SPEAK) return true; // I2V talking-photo recipe verified live (see buildInfiniteTalk)
  if (name === BERNINI_INSERT) return false;  // ads2v — wired but never live-verified
  // Bernini image side (i2i / r2i / t2i) — all three VERIFIED end-to-end on the live
  // box: t2i 11s, i2i relight 7s (identity held: shape/colour/position untouched),
  // r2i 2-ref compose 7s turbo / 40s quality. fp8, 848×480.
  if (BERNINI_IMAGE_SENTINELS.has(name)) return true;
  // 3D chains — every recipe live-verified end-to-end (Jul 2026): MoGe textured GLB,
  // Hunyuan3D 165K-vert mesh (+ PBR texturing), TripoSplat coloured .glb in 12s, and
  // the panorama split→merge→sphere in 7s.
  if (name === TRIPOSPLAT || name === MOGE_MESH || name === MOGE_PANORAMA) return true;
  const b = precisionBase(name);
  // Before the READY list: /hunyuan/ there would wrongly claim the 3D checkpoint
  // for HunyuanVideo's entry — match it explicitly instead.
  if (/hunyuan[._-]?3d/i.test(b)) return true;
  // fun_vace is surfaced via the generic /wan/ branch but has NO VACE-specific
  // builder (buildWan14B would run it as a plain t2v, ignoring the control/ref
  // inputs) — treat as not-yet-wired until a real VACE graph exists.
  if (/fun.?vace/i.test(b)) return false;
  // HiDream-O1 REGRESSED on ComfyUI 0.27.0 — every run (t2i and reference-edit,
  // any resolution) dies in SamplerCustom with "The size of tensor a (32) must
  // match the size of tensor b (8) at non-singleton dimension 1". Upstream bug,
  // not a graph one: our build matches the official image_hidream_o1 template
  // link-for-link, and the crash is inside comfy/ldm/hidream_o1/attention.py's
  // two_pass_attention, which calls scaled_dot_product_attention WITHOUT the
  // GQA kwargs llama.py hands it (32 query heads vs 8 kv heads). 32/8 are model
  // head counts, so no graph-side parameter can work around it. Re-promote once
  // ComfyUI ships a fix — the builder itself needs no change.
  if (/hidream.?o1/i.test(b)) return false;
  // Wan-Dancer — verified end-to-end on the live box (Aug 2026): photo + music →
  // dance video, 480×832 budget, turbo, keyframe planning + per-segment refinement.
  if (/dancer/i.test(b)) return true;
  const READY = [
    /flux1?.?dev/, /flux.*kontext/, /pony/,          // classic txt2img + kontext edit
    /z.?image/, /boogu/, /hidream/, /qwen.?image/,   // image gen + edit families
    /omnigen/, /pix2pix|instruct.?pix/,              // instruction edit
    /animate/,                                        // animate MOVE (base unet)
    /scail/,                                          // scail replace (base unet)
    /ti2v.*5b/, /hunyuan/, /ltx/, /sulphur/, /phantom/, // video generators (sulphur = LTX family, verified)
    // MiniMax H3 — BOTH weight files verified end-to-end through buildMiniMaxH3 (Aug 2026):
    // fl2va (t2v / i2v / first-last-frame) and ref2va (reference-driven). The ref2va pass
    // also settles the autogrow question: a wrong slot key reaches execute() as a stray
    // kwarg and raises TypeError, so a run that COMPLETES is proof the references were
    // handed to the node — they cannot be silently dropped.
    /minimax.?h3/,
  ];
  return READY.some((re) => re.test(b));
}

// Does this model read its attached images as REFERENCES (identity / subject) rather
// than as frames of the clip itself? Only those get the per-image 🖌 cutout: a mask
// there means "the subject is inside this outline", and the browser bakes it in
// (everything outside → flat white, cropped to the outline) before upload, so the
// surrounding scene can neither leak into the identity nor waste reference pixels.
//
// Deliberately EXCLUDED, because their image becomes a real frame — cutting it out
// would put a white background in the video itself:
//   • plain i2v / FLF (wan, ltx keyframes, hunyuan, ltx-2.3 t2v)
//   • LTX Union Control  — the still IS frame 0 (LTXVImgToVideoInplace)
//   • InfiniteTalk "photo speaks" — the photo IS the shot, animated in place
// Bernini's merged entry is the one ambiguous case (an image alone = i2v start frame,
// an image WITH a source clip = a reference); the frontend resolves it by whether a
// clip is staged, so it is listed here and gated there.
function refMaskModel(name, type) {
  if (name === LTX_MSR) return true;              // subjects + background are all references
  if (type === "minimax-h3") return /ref2va/i.test(name); // only the r2v weight takes references
  return ["phantom", "animate", "scail2", "dancer", "bernini"].includes(type);
}

async function resolveAnimateUnet() {
  const unets = await comfyEnum("UNETLoader", "unet_name");
  return unets.find((n) => videoTypeOf(n) === "animate") || null;
}

// List both classic checkpoints (txt2img / classic img2img) and the
// instruction-edit models found in diffusion_models/.
async function proxyComfyModels(req, res) {
  try {
    // ?comfyUrl=host:port scans a SPECIFIC endpoint (per-worker model list); default global.
    const q = new URL(req.url, "http://x").searchParams.get("comfyUrl");
    const scanUrl = normComfyUrl(q) || config.comfyUrl;
    comfyCtx.enterWith({ comfyUrl: scanUrl });
    const [ckpts, unets, upscaleModels, allLoras, clips, hostname] = await Promise.all([
      comfyEnum("CheckpointLoaderSimple", "ckpt_name"),
      comfyEnum("UNETLoader", "unet_name"),
      comfyEnum("UpscaleModelLoader", "model_name").catch(() => []),
      comfyEnum("LoraLoaderModelOnly", "lora_name").catch(() => []),
      comfyEnum("CLIPLoader", "clip_name").catch(() => []),
      hostnameFor(scanUrl).catch(() => ""),
    ]);
    // H3's text encoders, offered as a ⚙ list. NOT collapsed into one entry the way the
    // diffusion models are: the three tiers differ by 15.7 / 27.1 / 51.5 GB on a box where
    // that budget competes with the DiT, so picking the encoder is a decision the user
    // makes independently of the ⚙ precision tier — mixing (bf16 DiT + nvfp4 encoder) is
    // a legitimate configuration, not a fallback. Sorted best-tier-first so the list reads
    // in the same order the "auto" rule would choose.
    const h3TextEncoders = clips.filter((n) => H3_CLIP_RE.test(n))
      .sort((a, b) => PREC_AUTO_ORDER.indexOf(precisionOf(a)) - PREC_AUTO_ORDER.indexOf(precisionOf(b)));
    // LTX is the only family with a user-pickable LoRA slot (⚙ "LTX LoRA"), so the
    // list is filtered to LTX-family files by the same name test the checkpoints use.
    // Other builders mount their LoRAs automatically and take no input here.
    //
    // EXCLUDE the LoRAs that don't belong in a plain LoraLoaderModelOnly slot:
    //   • IC-LoRAs — the MSR (licon/msr) and Union Control (ic-lora / union-control) weights
    //     REQUIRE the LTXICLoRALoaderModelOnly + GetICLoRAParameters / LTXVAddGuide mechanism;
    //     stacked via a plain loader here they'd error or produce garbage (and picking the MSR
    //     one would double-stack the already-applied MSR loader).
    //   • distilled cascade LoRAs — buildLtxCascade / MSR mount those themselves (comp.distillLora).
    // Only genuine style/content LoRAs (Sulphur) belong in this slot.
    const LTX_AUTO_LORA_RE = /licon|msr|distill|ic.?lora|union.?control/i;
    const ltxLoras = allLoras.filter((n) => LTX_MODEL_RE.test(n) && !LTX_AUTO_LORA_RE.test(n));
    // The panorama recipe's LoRA slot sits on an image checkpoint, so every video
    // family's LoRA has to be kept out of it: mounted on Flux they do not error,
    // they just apply almost no matching keys and quietly change nothing (or make a
    // mess). Everything installed here is a video LoRA except the panorama one, so
    // this is an exclusion rather than a match — a new image LoRA should show up
    // without anyone having to add a pattern for it.
    const VIDEO_LORA_RE = /ltx|sulphur|wan|bernini|animate|lightx2v|scail|phantom|hunyuan.?video|infinitetalk|dancer|vace/i;
    const panoLoras = allLoras.filter((n) => !VIDEO_LORA_RE.test(n));
    // Edit/video models can be either diffusion models (UNETLoader) or full
    // checkpoints (instruct-pix2pix, ltx). Plain checkpoints stay in `models`.
    const all = [...ckpts, ...unets];
    const editModels = all.filter((n) => editTypeOf(n)).map((n) => ({ name: n, type: editTypeOf(n) }));
    // WAN 2.2 14B ships as a high+low expert PAIR per task (t2v / i2v). We hide the
    // low twin (derived server-side), and — when BOTH the t2v and i2v 14B families
    // are present — merge them into ONE "auto" entry: /imagine picks t2v (no image)
    // or i2v/FLF (image attached) at generation time. Everything else is 1:1.
    const has14bT2v = all.some((n) => /14b/i.test(n) && /t2v/i.test(n) && /high_noise/i.test(n));
    const has14bI2v = all.some((n) => /14b/i.test(n) && /i2v/i.test(n) && /high_noise/i.test(n));
    const merge14b = has14bT2v && has14bI2v;
    const videoModels = [];
    let added14bAuto = false;
    let addedBernini = false;
    for (const n of all) {
      const vt = videoTypeOf(n);
      if (!vt) continue;
      // The FULL distilled LTX checkpoint (ltx-2.3-…-distilled-fp8) is a COMPONENT consumed by
      // MSR / Union Control (both resolve it by scanning disk directly), NOT a standalone t2v
      // generator: buildLtxVideo's plain path would either double-distill it (cascade mounts a
      // distill LoRA on an already-distilled base) or under-run it (single-stage 30-step). It
      // otherwise collides with dev-fp8 as a second identical "LTX-2.3 22B" entry. Hide it here
      // (keeping videoTypeOf="ltx" so it also stays OUT of the image/ckpt list). dev-fp8 remains
      // the standalone LTX generator.
      if (vt === "ltx" && /ltx.*distill/i.test(n) && !LTX_COMPONENT_RE.test(n)) continue;
      // MiniMax H3 — TWO weight files, two entries (no sentinel: both are real names
      // on disk). fl2va takes 0-2 optional keyframes (none → t2v, one → i2v, two → first
      // and last frame); ref2va REQUIRES at least one reference image and additionally
      // accepts a reference video and reference audio. dedupePrecision below collapses
      // each one's precision variants (pruned int8 / bf16) into a single entry.
      if (vt === "minimax-h3") {
        const isRef = /ref2va/i.test(n);
        // ref2va joins the SOURCE-VIDEO group: an attached clip is one of the references
        // it reads (motion / camera / editing rhythm). videoOptional because it is only
        // one of four kinds — images or audio alone are equally valid — so unlike the
        // real video-edit models it must not reject a request that brings no clip.
        videoModels.push({ name: n, type: vt,
          label: isRef ? "MiniMax H3 (r2v)" : "MiniMax H3 (t2v / i2v)",
          ...(isRef ? { needsImages: 1, needsVideo: true, videoOptional: true } : {}) });
        continue;
      }
      // Bernini = WAN 2.2 MoE video-edit. Collapse its high/low pair into ONE
      // "bernini" entry (v2v / rv2v auto-picked at generation time).
      // needsVideo: requires a SOURCE VIDEO input (video-edit / pose transfer) —
      // grouped separately from the text/image→video generators in the UI.
      if (vt === "bernini") {
        if (/low_noise/i.test(n)) continue; // hidden — derived from the high twin
        // videoOptional: a source video selects video-edit (v2v/rv2v), but an image
        // alone is also a valid input (i2v) — unlike animate / scail2, which reject
        // a request with no source clip.
        if (!addedBernini) {
          videoModels.push({ name: BERNINI_AUTO, type: "bernini", label: "bernini (i2v / video edit)", needsVideo: true, videoOptional: true, precFrom: n });
          // ads2v — needs BOTH a source clip and an image, so no videoOptional here.
          videoModels.push({ name: BERNINI_INSERT, type: "bernini", label: "bernini (insert image into video)", needsVideo: true, precFrom: n });
          addedBernini = true;
        }
        continue;
      }
      // Wan Animate (pose transfer) — one UNET, two modes:
      //  • move    → character does the source video's motion (clean background)
      //  • replace → character REPLACES the person in the source video (scene kept)
      // Both need a source video; replace is resolved back to this UNET at gen time.
      if (vt === "animate") {
        videoModels.push({ name: n, type: "animate", label: "wan animate (move)", needsVideo: true });
        videoModels.push({ name: ANIMATE_REPLACE, type: "animate", label: "wan animate (replace)", needsVideo: true, precFrom: n });
        continue;
      }
      // SCAIL-2 (character animation) — one UNET, two modes, same split as Animate:
      //  • replace → character REPLACES the tracked person in the source video
      //  • animate → character performs the source video's motion
      // Unlike Animate it feeds the driving video to the model DIRECTLY (no DWPose
      // stick-figure step), and it tracks the subject with SAM3 instead of SAM2.
      if (vt === "scail2") {
        videoModels.push({ name: SCAIL2_ANIMATE, type: "scail2", label: "scail-2 (animate)", needsVideo: true, precFrom: n });
        videoModels.push({ name: n, type: "scail2", label: "scail-2 (replace)", needsVideo: true });
        continue;
      }
      // Wan-Dancer (music → dance): a global/local two-expert pair, collapsed into ONE
      // entry on the global file (the local twin is derived server-side at gen time,
      // same policy as the Wan 2.2 high/low MoE). Needs a reference photo + a MUSIC
      // file (needsAudio — the frontend gates on it); no source video, so it joins
      // the text/image→video gen group.
      if (vt === "dancer") {
        if (/local/i.test(n)) continue; // hidden — derived from the global twin
        videoModels.push({ name: n, type: "dancer", label: "wan dancer (music → dance)", needsImages: 1, needsAudio: true });
        continue;
      }
      const is14b = /14b/i.test(n);
      if (is14b && /low_noise/i.test(n)) continue; // hidden — derived from the high twin
      if (merge14b && is14b && (/t2v/i.test(n) || /i2v/i.test(n))) {
        if (!added14bAuto) { videoModels.push({ name: WAN14B_AUTO, type: "wan", label: "wan2.2_14B", precFrom: n }); added14bAuto = true; }
        continue;
      }
      if (is14b && /high_noise/i.test(n)) {
        videoModels.push({ name: n, type: vt, label: n.replace(/_?high_noise/i, "").replace(/\.(safetensors|ckpt|gguf|pth)$/i, "") });
      } else {
        videoModels.push({ name: n, type: vt });
      }
    }
    // Video enhance (interpolate + upscale): always offered — it needs no diffusion model, just
    // an upscale model + the Frame-Interpolation nodes (both checked at gen time). The
    // source video is interpolated to the target fps (/imagine <fps>) AND AI-upscaled.
    videoModels.push({ name: VIDEO_ENHANCE, type: "enhance", label: "Video interpolate + upscale", needsVideo: true });
    // LTX MSR: only offered when every piece (weights AND the three node packs) is
    // installed — an entry that always errors is worse than no entry.
    if (await ltxMsrParts()) videoModels.push({ name: LTX_MSR, type: "ltx", label: "LTX-2.3 MSR", needsImages: 1 });
    // LTX Union Control: depth-driven structure/motion transfer. Needs a SOURCE VIDEO (the
    // motion) + a reference image (the appearance), so it joins the "needs source video"
    // group. Gated on every weight + node being present, same as MSR.
    if (await ltxUnionParts()) videoModels.push({ name: LTX_UNION, type: "ltx-union", label: "LTX-2.3 Union", needsVideo: true, needsImages: 1 });
    // InfiniteTalk V2V (audio-driven dubbing / lip re-sync): needs a SOURCE VIDEO plus a
    // SPEECH AUDIO file (needsAudio — the frontend gates on it). Wrapper-based; only
    // offered when the whole node+weight set is installed, same policy as MSR/Union.
    if (await infinitetalkParts()) {
      videoModels.push({ name: INFINITETALK, type: "infinitetalk", label: "InfiniteTalk (dub / lip-sync)", needsVideo: true, needsAudio: true });
      // "Photo speaks": person photo + audio (or the prompt read out by the local TTS)
      // → talking video. No source video, so it joins the text/image→video group.
      videoModels.push({ name: INFINITETALK_SPEAK, type: "infinitetalk", label: "InfiniteTalk (photo → talking video)", needsImages: 1 });
    }
    // 3D mesh models — a fourth group next to image/edit/video. Output is a FILE
    // (.glb/.spz), so these must never fall into the pixel pipelines. Each chain is
    // gated on its node set (comfyHasNodes, same policy as MSR/Union: an entry that
    // always errors is worse than no entry) plus at least one weight on disk.
    const meshModels = [];
    const hunyuan3dCkpt = ckpts.find((n) => meshTypeOf(n) === "hunyuan3d");
    if (hunyuan3dCkpt && await comfyHasNodes(["EmptyLatentHunyuan3Dv2", "Hunyuan3Dv2Conditioning", "VAEDecodeHunyuan3D", "VoxelToMesh", "SaveGLB"])) {
      // paint = the texturing wrapper is installed, so the ⚙ "texture the model"
      // box is worth showing. Without it the chain still runs, just white.
      meshModels.push({ name: hunyuan3dCkpt, type: "hunyuan3d", needsImages: 1, paint: await comfyHasNodes(PAINT_NODES) });
    }
    if (unets.some((n) => /triposplat/i.test(n)) && await comfyHasNodes(["TripoSplatPreprocessImage", "TripoSplatConditioning", "VAEDecodeTripoSplat", "SplatToMesh", "SaveGLB"])) {
      meshModels.push({ name: TRIPOSPLAT, type: "triposplat", needsImages: 1, precFrom: unets.find((n) => /triposplat/i.test(n)) });
    }
    // MoGe's weight sits in geometry_estimation/, visible only through its own loader enum.
    const mogeWeights = await comfyEnum("LoadMoGeModel", "model_name").catch(() => []);
    if (mogeWeights.length && await comfyHasNodes(["MoGeInference", "MoGePointMapToMesh", "SaveGLB"])) {
      meshModels.push({ name: MOGE_MESH, type: "moge", needsImages: 1 });
    }
    // Panorama shares MoGe's weights — only the inference node differs.
    if (mogeWeights.length && await comfyHasNodes(["MoGePanoramaInference", "MoGePointMapToMesh", "SaveGLB"])) {
      meshModels.push({ name: MOGE_PANORAMA, type: "moge-pano", needsImages: 1 });
    }
    // Bernini also renders STILLS (same weights + graph at length 1) — surface its
    // three image tasks once the weights are present. i2i/r2i take an attached image
    // so they belong in the instruction-edit group; t2i takes none, so it joins the
    // plain image list further down.
    if (addedBernini) {
      editModels.push({ name: BERNINI_IMG_EDIT, type: "bernini-i2i" });
      editModels.push({ name: BERNINI_IMG_SUBJECT, type: "bernini-r2i" });
    }
    // Whether the ⚙ sampler / scheduler / steps / cfg fields do anything for this model.
    // Only the preset-driven builders read them (resolveVideoConfig merges the ⚙ values
    // over the preset); scail2 / animate / bernini hardcode a schedule their distill LoRA
    // is bound to, and silently ignore the fields. Decided HERE rather than by a type list
    // on the frontend so adding a model can't leave the two out of step.
    // cfg is a SEPARATE flag because MiniMax H3 is the one model where the other three
    // fields are live but cfg is not: its graph guides with a BasicGuider (single
    // conditioning, no negative branch), so there is nowhere for a guidance scale to go.
    // Showing it would be a control that silently does nothing.
    // fps gets the same treatment for the same reason: on a model whose rate is its own
    // (preset.fpsFixed) the field would only re-time the finished frames — and on H3,
    // desync the generated soundtrack. Models with no preset at all keep their fps field:
    // those builders take the rate from the SOURCE clip, which the field can still override.
    for (const m of videoModels) {
      const preset = videoPreset(m.type, m.name, true);
      m.samplerTunable = !!preset;
      m.cfgTunable = m.samplerTunable && m.type !== "minimax-h3";
      m.fpsTunable = !(preset && preset.fpsFixed);
      // Whether a negative prompt reaches the graph at all. MiniMax H3 guides with a
      // BasicGuider — ONE conditioning branch — so there is nowhere to put it: both the
      // ⚙ field and /imagine's `--no …` are discarded. Everything the user wants
      // suppressed has to be said positively in the prompt instead, which is also where
      // the soundtrack is directed.
      m.negativeTunable = m.type !== "minimax-h3";
      // The frame grid the ⚙ length field should offer, derived from the SAME preset the
      // server snaps against (snapLength) so the field can't advertise a range the
      // generator would then move. `max: null` = no trained ceiling declared; the field
      // keeps its generic cap. Models with no preset (bernini / animate / scail2 /
      // enhance) size from the source clip and get nothing here.
      if (preset) {
        const off = preset.lenOffset != null ? preset.lenOffset : 1;
        m.lenInfo = {
          min: preset.lenMin != null ? preset.lenMin : preset.lenMult + off,
          max: preset.lenMax != null ? preset.lenMax : null,
          step: preset.lenMult,
          // The grid's ORIGIN (snapLength's lenMult·n + lenOffset), sent so the ⚙ field
          // can snap by the same formula instead of inferring it from `min`. Those agree
          // only while every declared lenMin happens to sit on the grid — true today, but
          // a preset that broke it would have the field show a number the server moves.
          off,
          fps: preset.fps,
          auto: preset.length,
        };
      }
      m.refMask = refMaskModel(m.name, m.type);
    }
    // The Bernini subject→image task reads its attachments as references too (the
    // same reference_images socket the r2v path uses, at length 1).
    for (const m of editModels) if (m.name === BERNINI_IMG_SUBJECT) m.refMask = true;
    // Checkpoints that are COMPANIONS to another model rather than something to
    // txt2img list: plain checkpoints (excluding edit/video/HiDream/companions) +
    // HiDream-I1 (a diffusion model loaded specially with QuadrupleCLIPLoader).
    const plainCkpts = ckpts.filter((n) => !editTypeOf(n) && !videoTypeOf(n) && !meshTypeOf(n) && !/hidream/i.test(n) && !isCompanionModel(n));
    const hidreamImage = all.filter((n) => /hidream.?i1/i.test(n));
    // HiDream-O1 (pixel-space UiT): a CheckpointLoaderSimple model that does BOTH
    // txt2img and reference editing — surfaced in the main image list (attach an
    // image to edit). Buildt by buildHiDreamO1, not the I1/E1 path.
    const hidreamO1 = all.filter((n) => /hidream.?o1/i.test(n));
    // Z-Image-Turbo lives in diffusion_models/ (UNETLoader) — add it to txt2img.
    const zimage = all.filter((n) => /z.?image/i.test(n));
    // boogu (base + turbo) — UNETLoader image model, AuraFlow/SD3-latent pipeline.
    // boogu_image_edit is an instruction-edit model → excluded here (it's picked
    // up by editTypeOf into editModels instead).
    const boogu = all.filter((n) => /boogu/i.test(n) && !editTypeOf(n));
    // Qwen-Image BASE (txt2img) — a UNETLoader model, so it needs listing here just like
    // z-image/boogu. `!editTypeOf` is what separates it from Qwen-Image-EDIT, which is a
    // different model that lands in editModels.
    const qwenImage = all.filter((n) => /qwen.?image/i.test(n) && !editTypeOf(n));
    // Bernini text→image (length 1, nothing connected). A sentinel, not a filename —
    // it must stay OUT of dedupePrecision (no precision siblings to collapse) and is
    // appended after it, next to the other image sentinel (IMAGE_UPSCALE).
    const berniniT2i = addedBernini ? [BERNINI_T2I] : [];
    // The panorama recipe needs a checkpoint that bundles CLIP+VAE (so one loader
    // serves both the generation and the seam repair) plus the roll/mask/inpaint
    // nodes. Flux is what this box has; the family preset already knows its
    // settings, so no new sampler knowledge is introduced here.
    // Any plain txt2img CHECKPOINT can drive it — the builder reads the family preset
    // for latent type and guidance, so this is not a Flux-only recipe. UNET-only
    // models (z-image, boogu, qwen) are excluded: the graph loads one checkpoint that
    // has to bring its own CLIP and VAE, for the generation AND the seam repair.
    // Checkpoints, plus the UNET families whose stack this recipe knows how to build
    // (z-image and boogu: UNETLoader + CLIPLoader + VAELoader + an AuraFlow shift).
    // Qwen-Image is deliberately left out — its graph has pieces this one does not
    // replicate, and offering it would produce a workflow that fails at run time.
    const panoBases = [
      ...ckpts.filter((n) => !editTypeOf(n) && !videoTypeOf(n) && !meshTypeOf(n)
        && !/hidream/i.test(n) && !isCompanionModel(n)),
      ...unets.filter((n) => (/z.?image/i.test(n) || /boogu/i.test(n)) && !editTypeOf(n)),
    ];
    const panoT2i = (panoBases.length && await comfyHasNodes(["ImageCrop", "ImageStitch", "SolidMask", "FeatherMask",
      "MaskComposite", "InpaintModelConditioning", "ImageCompositeMasked", "EmptySD3LatentImage"]))
      ? [PANO_T2I] : [];
    // Collapse quantisation variants: a model published as fp8 + mxfp8 + nvfp4 … is
    // ONE dropdown entry, and the ⚙ precision preference decides which sibling loads
    // (see resolvePrecision). Without this, five SCAIL-2 precisions would become ten
    // entries (×2 modes). The entry keeps a REAL filename as its value — the swap
    // happens at generation time — so a saved model choice keeps resolving.
    const dedupePrecision = (list, nameOf, relabel) => {
      const seen = new Map();
      for (const item of list) {
        const b = precisionBase(nameOf(item));
        if (!seen.has(b)) seen.set(b, []);
        seen.get(b).push(item);
      }
      const out = [];
      for (const [, group] of seen) {
        // Representative = the PREC_AUTO_ORDER default, which is also what "Auto" then
        // loads (resolvePrecision returns the entry unchanged when no tier is asked for).
        const rep = bestTier(group, nameOf);
        out.push(group.length > 1 && relabel ? relabel(rep, group) : rep);
      }
      return out;
    };
    // Strip the precision token from a collapsed entry's label — the value still names
    // one variant, but the ⚙ setting is what actually picks the tier, so showing
    // "…_fp8_scaled" on an entry that may load mxfp8 would be a lie.
    const baseLabel = (n) => n.replace(/\.(safetensors|ckpt|gguf|pth|sft|bin)$/i, "").replace(PRECISION_RE_G, "").replace(/[_-]{2,}/g, "_").replace(/^[_-]+|[_-]+$/g, "");
    // Strip the token from an EXISTING label too (the 14B entries pre-label themselves
    // with the filename); a label with no precision token passes through untouched.
    const relabel = (rep) => ({ ...rep, label: baseLabel(rep.label || rep.name) });
    const videoOut = dedupePrecision(videoModels, (m) => m.name, relabel);
    const editOut = dedupePrecision(editModels, (m) => m.name, relabel);
    const meshOut = dedupePrecision(meshModels, (m) => m.name, relabel);
    // Image upscale (image HD): always offered — needs only an upscale model (checked
    // at gen time) + an attached image. Sits in the image model list as a sentinel.
    //
    // `models` is a bare string list — its entries are BOTH the label and the value, so
    // unlike the video/edit lists it cannot be relabelled without changing what gets
    // sent back. A collapsed group therefore shows one variant's filename while the ⚙
    // tier decides what actually loads, which reads as a lie the moment an image model
    // ships more than one precision (z-image and boogu now do). The entry keeps naming a
    // REAL file — a saved choice must keep resolving, and generateComfyImage re-applies
    // the ⚙ preference to whatever name it receives — so the fix is to hide the token in
    // the frontend's OPTION TEXT, not to invent a fake value here.
    const imageOut = dedupePrecision([...plainCkpts, ...hidreamImage, ...hidreamO1, ...zimage, ...boogu, ...qwenImage], (n) => n, null);
    // The image entries that stand for a COLLAPSED group, so the frontend can drop the
    // precision token from their option text. It can't work this out for itself — it
    // only ever sees the surviving representative, never the siblings it stands for.
    const imageCollapsed = imageOut.filter((n) => all.filter((x) => precisionBase(x) === precisionBase(n)).length > 1);
    // Logical within-group order (was disk-scan order). NOTE: the frontend now re-sorts
    // every group ALPHABETICALLY by the name it displays (only it knows that string —
    // localized tool labels, market names, stripped filenames), so this no longer decides
    // what the user sees. It survives as a deterministic order for any other consumer of
    // this endpoint; the rank tables below are the record of the old curated order.
    // IMAGE_UPSCALE is appended after, so it stays last here.
    imageOut.sort((a, b) => imageRank(a) - imageRank(b));
    editOut.sort((a, b) => editRank(a.name) - editRank(b.name));
    videoOut.sort((a, b) => videoRank(a.name) - videoRank(b.name));
    meshOut.sort((a, b) => meshRank(a.name) - meshRank(b.name));
    // Per-model display metadata: a clean market name (precision stripped) and the
    // capability tags the frontend turns into coloured dots. Keyed by the value the
    // option carries, so lookup is O(1) regardless of which group it came from.
    const modelMeta = {};
    // Which quantisation tiers this model actually ships in on disk, so the ⚙ precision
    // menu can grey out the rest instead of offering a tier that silently falls back.
    // Derived from the model's precision GROUP (every file sharing a precisionBase) —
    // the same grouping that collapsed the variants into one dropdown entry.
    //
    // An EMPTY result means "no precision token anywhere in this group", i.e. we cannot
    // tell what it ships in — a single untagged file, say. That is reported as absent
    // (no `prec` key) and the frontend then restricts nothing: greying every option on
    // a model we know nothing about would be worse than the status quo.
    // Also returns tier → FILENAME, so the frontend can name the file a run will actually
    // load BEFORE the request goes out. The progress bubble is built pre-flight and used
    // to print the dropdown value, which is an arbitrary representative of the precision
    // group — on a 25-minute render that meant staring at "…_fp8_scaled" for the whole run
    // after picking bf16, with the truth only arriving on the done-line.
    const tiersFor = (name) => {
      // A two-expert MoE resolves PER EXPERT, so a tier only ONE twin ships in still
      // loads (mixed, and said so on the done-line). The offer is therefore the UNION
      // over both twins — reading only the high twin would grey out a tier that works.
      const self = precisionBase(name);
      const bases = [self];
      if (/high_noise/i.test(name)) bases.push(precisionBase(name.replace(/high_noise/ig, "low_noise")));
      const tiers = [];
      const files = {};
      for (const f of all) {
        const b = precisionBase(f);
        if (!bases.includes(b)) continue;
        const t = precisionOf(f);
        if (!t) continue;
        if (!tiers.includes(t)) tiers.push(t);
        // Names come from the entry's OWN base only. The union above also sweeps in the
        // other twin of a MoE pair, and printing the low_noise file for a high_noise
        // entry would be a new wrong answer in place of the old one.
        if (b === self && !files[t]) files[t] = f;
      }
      // Sorted so the frontend can read tiers[0] as "what auto picks" without carrying a
      // second copy of PREC_AUTO_ORDER that could drift from this one.
      tiers.sort((a, b) => PREC_AUTO_ORDER.indexOf(a) - PREC_AUTO_ORDER.indexOf(b));
      return { tiers, files };
    };
    const setMeta = (name, group, type, entry) => {
      // Sentinel entries (wan2.2_14B auto, bernini, animate replace, scail animate) carry
      // a synthetic name that matches no file, so tiers are read off the real checkpoint
      // they were derived from — otherwise the models with the most precision variants
      // would be exactly the ones the menu can't describe.
      const { tiers, files } = tiersFor((entry && entry.precFrom) || name);
      // `id` is this model's canonical, install-independent identity (model-names.js) —
      // what `-m` matches, what the gallery records, and what survives downloading another
      // quantisation (which moves `name`, the group's representative filename). The label
      // is derived FROM the id, so rewording one can never re-partition anything.
      const id = canonicalModelId(name);
      modelMeta[name] = { id, label: labelForId(id) || baseLabel(name), caps: capsFor(name, group, type, entry), ready: isModelReady(name, group, type) };
      if (tiers.length) { modelMeta[name].prec = tiers; modelMeta[name].precFiles = files; }
    };
    for (const n of imageOut) setMeta(n, "image", null, null);
    for (const n of berniniT2i) setMeta(n, "image", null, null);
    for (const n of panoT2i) setMeta(n, "image", null, null);
    // The upscale sentinel keeps its localized frontend label ("Image HD"), so send
    // no name here — only the ⚪ tool dot.
    // label stays null (the frontend supplies the localized one), but the id must not —
    // it is how `-m` and the gallery name this entry.
    modelMeta[IMAGE_UPSCALE] = { id: canonicalModelId(IMAGE_UPSCALE), label: null, caps: ["tool"], ready: true };
    for (const m of editOut) setMeta(m.name, "edit", m.type, m);
    for (const m of videoOut) setMeta(m.name, "video", m.type, m);
    for (const m of meshOut) setMeta(m.name, "mesh", m.type, m);
    // MSR's precision tiers come from whichever pool its ACTIVE path uses, read by TIER
    // directly — the mxfp8 file's "_block32" suffix breaks the precisionBase grouping
    // tiersFor relies on, so that path would wrongly report fp8-only after mxfp8 is added.
    // Clean path (preferred) selects from the full distilled checkpoints; only when none are
    // present does it fall back to the transformer-only pool. Mirrors ltxMsrParts' own pick.
    if (modelMeta[LTX_MSR]) {
      const full = all.filter((n) => /ltx.*distill/i.test(n) && !/transformer[-_ ]?only/i.test(n));
      const tfs = all.filter((n) => /ltx.*transformer[-_ ]?only/i.test(n));
      const pool = full.length ? full : tfs;
      const tiers = [...new Set(pool.map(precisionOf).filter(Boolean))];
      if (tiers.length) modelMeta[LTX_MSR].prec = tiers;
    }
    // Union Control's tiers come from the FULL distilled checkpoint pool (same reasoning:
    // the sentinel name carries no precision, and ltxUnionParts picks by TIER over that pool).
    if (modelMeta[LTX_UNION]) {
      const cks = all.filter((n) => /ltx.*distill/i.test(n) && !/transformer[-_ ]?only/i.test(n));
      const tiers = [...new Set(cks.map(precisionOf).filter(Boolean))];
      if (tiers.length) modelMeta[LTX_UNION].prec = tiers;
    }
    // GPU of THIS endpoint: VRAM (GiB) → the client mirrors animateSegmentCap with it so
    // the progress estimate matches the graph the server builds; gpuName → shown in the
    // model picker. Both null when unknown.
    const { gib: vramGib, gpuName } = await comfyGpuInfo();
    sendJson(res, 200, { models: [...imageOut, ...berniniT2i, ...panoT2i, IMAGE_UPSCALE], imageCollapsed, editModels: editOut, videoModels: videoOut, meshModels: meshOut, modelMeta, upscaleModels: upscaleModels.filter((n) => !isRestoreModel(n)), restoreModels: upscaleModels.filter(isRestoreModel), panoBases: panoT2i.length ? panoBases : [], panoLoras: panoT2i.length ? panoLoras : [], ltxLoras, h3TextEncoders, hostname, vramGib, gpuName });
  } catch {
    sendJson(res, 200, { models: [], editModels: [], videoModels: [], meshModels: [], upscaleModels: [], panoBases: [], panoLoras: [], ltxLoras: [], h3TextEncoders: [] });
  }
}

// Pick the companion files (text encoders + VAE) an edit model needs from what
// ComfyUI actually has on disk. Throws a user-actionable error naming any
// missing file so the UI can tell the user what to download.
async function editCompanions(editType) {
  const [clips, vaes] = await Promise.all([
    comfyEnum("CLIPLoader", "clip_name"),
    comfyEnum("VAELoader", "vae_name"),
  ]);
  const find = (list, re) => list.find((x) => re.test(x));
  const aeVae = () => find(vaes, /^ae\b|ae\.safetensors/i) || find(vaes, /flux/i);

  if (editType === "kontext") {
    const t5 = find(clips, /t5xxl/i);
    const clipL = find(clips, /clip_l/i);
    const vae = aeVae();
    const missing = [];
    if (!t5) missing.push("t5xxl_fp16.safetensors or t5xxl_fp8_e4m3fn.safetensors → ComfyUI/models/text_encoders/");
    if (!clipL) missing.push("clip_l.safetensors → text_encoders/");
    if (!vae) missing.push("ae.safetensors → vae/");
    if (missing.length) throw new Error("Missing files required by Kontext:\n- " + missing.join("\n- "));
    return { t5, clipL, vae };
  }
  if (editType === "qwen") {
    // Qwen-Image-Edit wants the 7B Qwen2.5-VL encoder (prefer it if present).
    const clip = clips.find((x) => /qwen.*vl/i.test(x) && /7b/i.test(x)) || find(clips, /qwen.*vl/i);
    const vae = find(vaes, /qwen.*image.*vae|qwen[-_]?image|qwen.*vae/i);
    const missing = [];
    if (!clip) missing.push("qwen_2.5_vl_7b_fp8_scaled.safetensors → text_encoders/");
    if (!vae) missing.push("qwen_image_vae.safetensors → vae/");
    if (missing.length) throw new Error("Missing files required by Qwen-Image-Edit:\n- " + missing.join("\n- "));
    return { clip, vae };
  }
  if (editType === "omnigen") {
    // OmniGen2 wants the smaller (3B) Qwen2.5-VL encoder — AVOID the 7B one.
    const clip = clips.find((x) => /qwen.*vl/i.test(x) && !/7b/i.test(x)) || find(clips, /omnigen|qwen.*vl/i);
    const vae = aeVae();
    const missing = [];
    if (!clip) missing.push("OmniGen2 text encoder (qwen_2.5_vl) → text_encoders/");
    if (!vae) missing.push("ae.safetensors → vae/");
    if (missing.length) throw new Error("Missing files required by OmniGen2:\n- " + missing.join("\n- "));
    return { clip, vae };
  }
  if (editType === "boogu-edit") {
    // Same companions as boogu txt2img: qwen3vl encoder (CLIPLoader type "boogu")
    // + the flux VAE.
    const clip = find(clips, /qwen3vl/i) || find(clips, /qwen.*vl.*8b/i);
    const vae = find(vaes, /flux1?_?vae/i) || find(vaes, /flux/i);
    const missing = [];
    if (!clip) missing.push("qwen3vl_8b_fp8_scaled.safetensors → text_encoders/");
    if (!vae) missing.push("flux1_vae_bf16.safetensors → vae/");
    if (missing.length) throw new Error("Missing files required by boogu edit:\n- " + missing.join("\n- "));
    return { clip, vae };
  }
  return {};
}

// Optimized sampling defaults per model family. Detection is by checkpoint
// filename. Each preset is what produces good results for that family out of
// the box; the client can override any field via the advanced-params modal.
//   - Flux: guidance-distilled — real CFG (7) blurs it, so cfg=1 + a
//     FluxGuidance node, "simple" scheduler, and a 16-channel SD3 latent.
//   - SD3: low CFG, sgm_uniform scheduler, SD3 latent.
//   - SDXL / Pony / Illustrious / NoobAI: dpmpp_2m + karras, cfg ~7, more steps.
//   - SD1.5 / unknown: dpmpp_2m + karras, cfg 7.
function familyPreset(model) {
  // The panorama recipe generates with Flux, so it wants Flux's settings — the
  // sentinel's own name matches none of the patterns below.
  if (model === PANO_T2I) {
    return { sampler: "euler", scheduler: "simple", cfg: 1, guidance: 3.5, steps: 20, sd3Latent: true };
  }
  // Instruction-edit models (checked before the generic /flux/ branch, since
  // "flux1-dev-kontext" contains "flux" but needs Kontext settings).
  if (/kontext/i.test(model)) {
    return { sampler: "euler", scheduler: "simple", cfg: 1, guidance: 2.5, steps: 20, sd3Latent: false };
  }
  if (/qwen.*edit|qwen[-_]?image[-_]?edit/i.test(model)) {
    return { sampler: "euler", scheduler: "simple", cfg: 2.5, guidance: null, steps: 20, sd3Latent: false };
  }
  if (/omnigen/i.test(model)) {
    return { sampler: "euler", scheduler: "normal", cfg: 4, guidance: null, steps: 20, sd3Latent: false };
  }
  if (/pix2pix|instruct.?pix|ip2p/i.test(model)) {
    // InstructPix2Pix needs DUAL guidance: cfg = text guidance (how much to
    // follow the instruction), imageCfg = image guidance (how faithful to the
    // input — higher preserves more). More steps helps on real photos.
    return { sampler: "euler", scheduler: "normal", cfg: 7.5, imageCfg: 1.5, guidance: null, steps: 30, sd3Latent: false };
  }
  if (/hidream.?o1/i.test(model)) {
    // HiDream-O1 (pixel-space UiT): SamplerCustom with dpmpp_2m_sde_gpu / normal /
    // 40 steps / cfg 5 (official template, Full checkpoint). Not an SD3 latent.
    return { sampler: "dpmpp_2m_sde_gpu", scheduler: "normal", cfg: 5, guidance: null, steps: 40, sd3Latent: false };
  }
  if (/hidream/i.test(model)) {
    return { sampler: "euler", scheduler: "normal", cfg: 5, guidance: null, steps: 30, sd3Latent: true };
  }
  if (/z.?image/i.test(model)) {
    // Z-Image-Turbo: distilled few-step model — cfg=1 with the negative zeroed,
    // ~8 steps, res_multistep/simple (per the official ComfyUI template).
    return { sampler: "res_multistep", scheduler: "simple", cfg: 1, guidance: null, steps: 8, sd3Latent: true };
  }
  if (/boogu.*edit|boogu[-_]?image[-_]?edit/i.test(model)) {
    // boogu instruction-edit (boogu_image_edit): res_multistep/simple, cfg 2.5,
    // 20 steps (exact from the user's boogu_image_edit_api.json export).
    return { sampler: "res_multistep", scheduler: "simple", cfg: 2.5, guidance: null, steps: 20, sd3Latent: false };
  }
  if (/boogu/i.test(model)) {
    // boogu: AuraFlow/SD3-latent image model (qwen3vl CLIP type "boogu" + flux VAE).
    // turbo = distilled: cfg=1 / 8 steps / res_multistep+simple (from the user's
    // exported API graph). base = non-distilled — real CFG + a proper negative and
    // more steps (best-guess until a base graph is provided).
    if (/turbo/i.test(model)) {
      return { sampler: "res_multistep", scheduler: "simple", cfg: 1, guidance: null, steps: 4, sd3Latent: true };
    }
    return { sampler: "res_multistep", scheduler: "simple", cfg: 4.5, guidance: null, steps: 28, sd3Latent: true };
  }
  // Qwen-Image txt2img (the BASE model — the edit variant is handled above). Exact from
  // the official "Qwen-Image: Text to Image" template's non-turbo branch. Without this it
  // would fall through to the SD1.5 default (dpmpp_2m/karras/cfg 7), which resolveConfig
  // then hands to buildQwenImage — overriding its own defaults and wrecking the output.
  // The turbo branch (8 steps / cfg 1) needs the Lightning LoRA, which buildQwenImage
  // switches to on its own when the LoRA is installed.
  if (/qwen.?image/i.test(model)) {
    return { sampler: "euler", scheduler: "simple", cfg: 4, guidance: null, steps: 20, sd3Latent: true };
  }
  if (/flux/i.test(model)) {
    return { sampler: "euler", scheduler: "simple", cfg: 1, guidance: 3.5, steps: 20, sd3Latent: true };
  }
  if (/sd3|stable[-_ ]?diffusion[-_ ]?3/i.test(model)) {
    return { sampler: "euler", scheduler: "sgm_uniform", cfg: 4.5, guidance: null, steps: 28, sd3Latent: true };
  }
  if (/sd[-_ ]?xl|sdxl|\bxl\b|pony|illustrious|noob/i.test(model)) {
    return { sampler: "dpmpp_2m", scheduler: "karras", cfg: 7, guidance: null, steps: 30, sd3Latent: false };
  }
  return { sampler: "dpmpp_2m", scheduler: "karras", cfg: 7, guidance: null, steps: 25, sd3Latent: false };
}

// Resolve the final sampling settings: family preset, with any client override
// (from the advanced-params modal) taking precedence. Guidance only applies to
// the Flux family (it drives a FluxGuidance node); other families ignore it.
function resolveConfig(model, opts) {
  const p = familyPreset(model);
  const isFlux = p.guidance != null;
  return {
    sampler: opts.sampler || p.sampler,
    scheduler: opts.scheduler || p.scheduler,
    cfg: opts.cfg != null ? opts.cfg : p.cfg,
    steps: opts.steps || p.steps,
    guidance: isFlux ? (opts.guidance != null ? opts.guidance : p.guidance) : null,
    imageCfg: opts.imageCfg != null ? opts.imageCfg : p.imageCfg,
    sd3Latent: p.sd3Latent,
  };
}

// Shared tail of every graph: checkpoint, prompts, decode, save. When `guidance`
// is set (Flux), the positive conditioning is routed through a FluxGuidance node.
function commonNodes({ model, prompt, negative, guidance }) {
  const nodes = {
    "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: model } },
    "6": { class_type: "CLIPTextEncode", inputs: { text: prompt, clip: ["4", 1] } },
    "7": { class_type: "CLIPTextEncode", inputs: { text: negative, clip: ["4", 1] } },
    "8": { class_type: "VAEDecode", inputs: { samples: ["3", 0], vae: ["4", 2] } },
    "9": { class_type: "SaveImage", inputs: { filename_prefix: "heykoko", images: ["8", 0] } },
  };
  if (guidance != null) {
    nodes["12"] = { class_type: "FluxGuidance", inputs: { conditioning: ["6", 0], guidance } };
  }
  return nodes;
}

function ksampler({ seed, steps, cfg, sampler, scheduler, denoise, latentRef, guidance }) {
  return {
    class_type: "KSampler",
    inputs: {
      seed,
      steps,
      cfg,
      sampler_name: sampler,
      scheduler,
      denoise,
      model: ["4", 0],
      positive: guidance != null ? ["12", 0] : ["6", 0],
      negative: ["7", 0],
      latent_image: latentRef,
    },
  };
}

// HiDream-I1 (txt2img). Loads via UNETLoader + QuadrupleCLIPLoader (4 encoders:
// clip_l + clip_g + t5xxl + llama) + flux ae VAE; CLIPTextEncodeHiDream takes the
// prompt in all four encoder slots. ModelSamplingSD3 shift ~3.
async function hidreamCompanions() {
  const [clips, vaes] = await Promise.all([
    comfyEnum("CLIPLoader", "clip_name"),
    comfyEnum("VAELoader", "vae_name"),
  ]);
  const find = (list, re) => list.find((x) => re.test(x));
  const clipL = find(clips, /clip_l_hidream/i) || find(clips, /clip_l/i);
  const clipG = find(clips, /clip_g_hidream/i) || find(clips, /clip_g/i);
  const t5 = find(clips, /t5xxl/i);
  const llama = find(clips, /llama.?3.*instruct|llama_3/i);
  const vae = find(vaes, /^ae\b|ae\.safetensors/i) || find(vaes, /flux/i);
  const missing = [];
  if (!clipL) missing.push("clip_l_hidream.safetensors → text_encoders/");
  if (!clipG) missing.push("clip_g_hidream.safetensors → text_encoders/");
  if (!t5) missing.push("t5xxl_fp8_e4m3fn.safetensors → text_encoders/");
  if (!llama) missing.push("llama_3.1_8b_instruct_fp8_scaled.safetensors → text_encoders/");
  if (!vae) missing.push("ae.safetensors → vae/");
  if (missing.length) throw new Error("Missing files required by HiDream:\n- " + missing.join("\n- "));
  return { clipL, clipG, t5, llama, vae };
}

function buildHiDreamImage({ model, prompt, negative, width, height, seed, cfg, comp }) {
  const enc = (text) => ({ class_type: "CLIPTextEncodeHiDream", inputs: { clip: ["2", 0], clip_l: text, clip_g: text, t5xxl: text, llama: text } });
  return {
    "1": { class_type: "UNETLoader", inputs: { unet_name: model, weight_dtype: "default" } },
    "2": { class_type: "QuadrupleCLIPLoader", inputs: { clip_name1: comp.clipL, clip_name2: comp.clipG, clip_name3: comp.t5, clip_name4: comp.llama } },
    "3": { class_type: "VAELoader", inputs: { vae_name: comp.vae } },
    "4": enc(prompt),
    "5": enc(negative || ""),
    "6": { class_type: "EmptySD3LatentImage", inputs: { width, height, batch_size: 1 } },
    "7": { class_type: "ModelSamplingSD3", inputs: { model: ["1", 0], shift: 3.0 } },
    "8": { class_type: "KSampler", inputs: { seed, steps: cfg.steps, cfg: cfg.cfg, sampler_name: cfg.sampler, scheduler: cfg.scheduler, denoise: 1, model: ["7", 0], positive: ["4", 0], negative: ["5", 0], latent_image: ["6", 0] } },
    "9": { class_type: "VAEDecode", inputs: { samples: ["8", 0], vae: ["3", 0] } },
    "10": { class_type: "SaveImage", inputs: { filename_prefix: "heykoko", images: ["9", 0] } },
  };
}

// Qwen-Image (txt2img) companions — the same encoder + VAE the EDIT variant uses, plus
// the OPTIONAL Lightning speed LoRA. Absent LoRA = the full 20-step / cfg-4 schedule
// (same "turbo iff the LoRA is installed" rule as bernini / WAN 14B).
async function qwenImageCompanions() {
  const [clips, vaes, loras] = await Promise.all([
    comfyEnum("CLIPLoader", "clip_name"),
    comfyEnum("VAELoader", "vae_name"),
    comfyEnum("LoraLoaderModelOnly", "lora_name").catch(() => []),
  ]);
  const find = (list, re) => list.find((x) => re.test(x));
  // The 7B Qwen2.5-VL encoder, preferred if present — matches editCompanions("qwen").
  const clip = clips.find((x) => /qwen.*vl/i.test(x) && /7b/i.test(x)) || find(clips, /qwen.*vl/i);
  const vae = find(vaes, /qwen.*image.*vae|qwen[-_]?image|qwen.*vae/i);
  const lora = find(loras, /qwen.?image.?lightning/i); // optional turbo
  const missing = [];
  if (!clip) missing.push("qwen_2.5_vl_7b_fp8_scaled.safetensors → text_encoders/");
  if (!vae) missing.push("qwen_image_vae.safetensors → vae/");
  if (missing.length) throw new Error("Missing files required by Qwen-Image:\n- " + missing.join("\n- "));
  return { clip, vae, lora };
}

// Qwen-Image (txt2img), flattened from the official "Qwen-Image: Text to Image" template
// (its chain lives in a subgraph, and its steps/cfg come from Switch nodes selecting
// between a turbo and a full branch). UNETLoader → optional Lightning LoRA →
// ModelSamplingAuraFlow(3.1) → KSampler, with CLIPLoader type "qwen_image" and the
// dedicated qwen_image_vae. turbo (LoRA present) = 8 steps / cfg 1; else 20 / cfg 4.
function buildQwenImage({ model, prompt, negative, width, height, seed, comp, cfg }) {
  const turbo = !!comp.lora;
  const steps = (cfg && cfg.steps) || (turbo ? 8 : 20);
  const guide = (cfg && cfg.cfg != null) ? cfg.cfg : (turbo ? 1 : 4);
  const wf = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: model, weight_dtype: "default" } },
    "2": { class_type: "CLIPLoader", inputs: { clip_name: comp.clip, type: "qwen_image", device: "default" } },
    "3": { class_type: "VAELoader", inputs: { vae_name: comp.vae } },
    "4": { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: prompt } },
    // Unlike Z-Image (cfg 1 → a zeroed-out negative), the full schedule runs cfg 4, so
    // the negative is a real prompt and an empty string is a legitimate one.
    "5": { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: negative || "" } },
    "6": { class_type: "EmptySD3LatentImage", inputs: { width, height, batch_size: 1 } },
    "9": { class_type: "VAEDecode", inputs: { samples: ["8", 0], vae: ["3", 0] } },
    "10": { class_type: "SaveImage", inputs: { filename_prefix: "heykoko", images: ["9", 0] } },
  };
  if (turbo) wf["11"] = { class_type: "LoraLoaderModelOnly", inputs: { model: ["1", 0], lora_name: comp.lora, strength_model: 1 } };
  wf["7"] = { class_type: "ModelSamplingAuraFlow", inputs: { model: [turbo ? "11" : "1", 0], shift: 3.1 } };
  wf["8"] = { class_type: "KSampler", inputs: { seed, steps, cfg: guide, sampler_name: (cfg && cfg.sampler) || "euler", scheduler: (cfg && cfg.scheduler) || "simple", denoise: 1, model: ["7", 0], positive: ["4", 0], negative: ["5", 0], latent_image: ["6", 0] } };
  return wf;
}

// Z-Image-Turbo companions: the Qwen3-4B text encoder (loaded via CLIPLoader
// with type "lumina2") + the flux "ae" VAE.
async function zimageCompanions() {
  const [clips, vaes] = await Promise.all([
    comfyEnum("CLIPLoader", "clip_name"),
    comfyEnum("VAELoader", "vae_name"),
  ]);
  const find = (list, re) => list.find((x) => re.test(x));
  // Qwen3-4B encoder — NOT the Qwen3-VL (vision) one. boogu's `qwen3vl_8b` also
  // matches /qwen_?3/ and sorts first, so exclude any "vl" variant explicitly.
  const clip = clips.find((x) => /qwen_?3/i.test(x) && !/vl/i.test(x));
  const vae = find(vaes, /^ae\b|ae\.safetensors/i) || find(vaes, /flux/i);
  const missing = [];
  if (!clip) missing.push("qwen_3_4b.safetensors → text_encoders/");
  if (!vae) missing.push("ae.safetensors → vae/");
  if (missing.length) throw new Error("Missing files required by Z-Image:\n- " + missing.join("\n- "));
  return { clip, vae };
}

// Z-Image-Turbo (txt2img). Distilled few-step model: UNETLoader + CLIPLoader
// (qwen_3_4b, type "lumina2") + flux ae VAE. The negative is a ConditioningZeroOut
// of the positive (cfg=1, so no real negative), the latent is 16-channel SD3, and
// ModelSamplingAuraFlow applies shift 3 — matching the official ComfyUI template.
function buildZImage({ model, prompt, width, height, seed, cfg, comp }) {
  return {
    "1": { class_type: "UNETLoader", inputs: { unet_name: model, weight_dtype: "default" } },
    "2": { class_type: "CLIPLoader", inputs: { clip_name: comp.clip, type: "lumina2", device: "default" } },
    "3": { class_type: "VAELoader", inputs: { vae_name: comp.vae } },
    "4": { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: prompt } },
    "5": { class_type: "ConditioningZeroOut", inputs: { conditioning: ["4", 0] } },
    "6": { class_type: "EmptySD3LatentImage", inputs: { width, height, batch_size: 1 } },
    "7": { class_type: "ModelSamplingAuraFlow", inputs: { model: ["1", 0], shift: 3.0 } },
    "8": { class_type: "KSampler", inputs: { seed, steps: cfg.steps, cfg: cfg.cfg, sampler_name: cfg.sampler, scheduler: cfg.scheduler, denoise: 1, model: ["7", 0], positive: ["4", 0], negative: ["5", 0], latent_image: ["6", 0] } },
    "9": { class_type: "VAEDecode", inputs: { samples: ["8", 0], vae: ["3", 0] } },
    "10": { class_type: "SaveImage", inputs: { filename_prefix: "heykoko", images: ["9", 0] } },
  };
}

// boogu needs its own text encoder (qwen3vl, loaded with CLIPLoader type "boogu")
// and the flux VAE (flux1_vae_bf16, NOT the bare ae). Throws naming any missing
// file so the UI can tell the user what to download.
async function boogiCompanions() {
  const [clips, vaes] = await Promise.all([
    comfyEnum("CLIPLoader", "clip_name"),
    comfyEnum("VAELoader", "vae_name"),
  ]);
  const find = (list, re) => list.find((x) => re.test(x));
  const clip = find(clips, /qwen3vl/i) || find(clips, /qwen.*vl.*8b/i);
  const vae = find(vaes, /flux1?_?vae/i) || find(vaes, /flux/i);
  const missing = [];
  if (!clip) missing.push("qwen3vl_8b_fp8_scaled.safetensors → text_encoders/");
  if (!vae) missing.push("flux1_vae_bf16.safetensors → vae/");
  if (missing.length) throw new Error("Missing files required by boogu:\n- " + missing.join("\n- "));
  return { clip, vae };
}

// boogu txt2img / img2img. AuraFlow/SD3-latent pipeline (mirrors the user's
// exported turbo API graph): UNETLoader + CLIPLoader(qwen3vl, type "boogu") +
// flux VAE + ModelSamplingAuraFlow(shift 3). Turbo is distilled (cfg≈1) so the
// negative is a ConditioningZeroOut of the positive; base uses a real negative.
// With an input image the canvas is a VAEEncode of it (img2img, denoise<1);
// otherwise a fresh EmptySD3LatentImage (txt2img).
function buildBoogu({ model, prompt, negative, width, height, seed, cfg, comp, turbo, imageName, maskName, denoise }) {
  const wf = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: model, weight_dtype: "default" } },
    "2": { class_type: "CLIPLoader", inputs: { clip_name: comp.clip, type: "boogu", device: "default" } },
    "3": { class_type: "VAELoader", inputs: { vae_name: comp.vae } },
    "4": { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: prompt } },
    "7": { class_type: "ModelSamplingAuraFlow", inputs: { model: ["1", 0], shift: 3.0 } },
    "9": { class_type: "VAEDecode", inputs: { samples: ["8", 0], vae: ["3", 0] } },
    "10": { class_type: "SaveImage", inputs: { filename_prefix: "heykoko", images: ["9", 0] } },
  };
  // Negative: distilled turbo (cfg≈1) zeroes it; base encodes a real one.
  wf["5"] = turbo
    ? { class_type: "ConditioningZeroOut", inputs: { conditioning: ["4", 0] } }
    : { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: negative || "" } };
  // Canvas: img2img encodes the input; txt2img starts from an empty SD3 latent.
  let dn = 1;
  if (imageName) {
    wf["11"] = { class_type: "LoadImage", inputs: { image: imageName } };
    wf["6"] = { class_type: "VAEEncode", inputs: { pixels: ["11", 0], vae: ["3", 0] } };
    dn = denoise != null ? denoise : 0.75;
  } else {
    wf["6"] = { class_type: "EmptySD3LatentImage", inputs: { width, height, batch_size: 1 } };
  }
  wf["8"] = { class_type: "KSampler", inputs: { seed, steps: cfg.steps, cfg: cfg.cfg, sampler_name: cfg.sampler, scheduler: cfg.scheduler, denoise: dn, model: ["7", 0], positive: ["4", 0], negative: ["5", 0], latent_image: ["6", 0] } };
  // Masked inpaint (img2img only): repaint just the painted region. Needs the
  // VAEEncode latent (node 6), which only exists when an input image was given.
  if (maskName && imageName) {
    wf["20"] = { class_type: "LoadImageMask", inputs: { image: maskName, channel: "red" } };
    wf["21"] = { class_type: "SetLatentNoiseMask", inputs: { samples: ["6", 0], mask: ["20", 0] } };
    wf["8"].inputs.latent_image = ["21", 0];
  }
  return wf;
}

// HiDream-E1.1 instruction editing. Same loaders as I1, but the source image is
// VAE-encoded as the latent and partially denoised (~0.85) so the subject is
// preserved while the instruction is applied. E1 expects the prompt phrased as
// "Editing Instruction: …" — we prepend that if the user didn't.
function buildHiDreamEdit({ model, prompt, negative, imageName, maskName, seed, cfg, comp, denoise, width, height }) {
  const instr = /^\s*editing instruction:/i.test(prompt) ? prompt : `Editing Instruction: ${prompt}`;
  const enc = (text) => ({ class_type: "CLIPTextEncodeHiDream", inputs: { clip: ["2", 0], clip_l: text, clip_g: text, t5xxl: text, llama: text } });
  // A target size resizes the source before VAEEncode so the output matches it.
  const px = (width && height) ? ["16", 0] : ["14", 0];
  const wf = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: model, weight_dtype: "default" } },
    "2": { class_type: "QuadrupleCLIPLoader", inputs: { clip_name1: comp.clipL, clip_name2: comp.clipG, clip_name3: comp.t5, clip_name4: comp.llama } },
    "3": { class_type: "VAELoader", inputs: { vae_name: comp.vae } },
    "14": { class_type: "LoadImage", inputs: { image: imageName } },
    "15": { class_type: "VAEEncode", inputs: { pixels: px, vae: ["3", 0] } },
    "4": enc(instr),
    "5": enc(negative || ""),
    "7": { class_type: "ModelSamplingSD3", inputs: { model: ["1", 0], shift: 3.0 } },
    "8": { class_type: "KSampler", inputs: { seed, steps: cfg.steps, cfg: cfg.cfg, sampler_name: cfg.sampler, scheduler: cfg.scheduler, denoise: denoise != null ? denoise : 0.85, model: ["7", 0], positive: ["4", 0], negative: ["5", 0], latent_image: ["15", 0] } },
    "9": { class_type: "VAEDecode", inputs: { samples: ["8", 0], vae: ["3", 0] } },
    "10": { class_type: "SaveImage", inputs: { filename_prefix: "heykoko", images: ["9", 0] } },
  };
  if (width && height) wf["16"] = scaleNode(["14", 0], width, height);
  // Masked edit: confine the instruction to the painted region (gate the latent).
  if (maskName) {
    wf["20"] = { class_type: "LoadImageMask", inputs: { image: maskName, channel: "red" } };
    wf["21"] = { class_type: "SetLatentNoiseMask", inputs: { samples: ["15", 0], mask: ["20", 0] } };
    wf["8"].inputs.latent_image = ["21", 0];
  }
  return wf;
}

// HiDream-O1-Image — a pixel-space Unified Transformer (UiT). Unlike I1/E1 it
// loads EVERYTHING from CheckpointLoaderSimple (the CLIP + VAE are bundled) and
// samples in pixel space via SamplerCustom, so the model is wrapped in
// ModelNoiseScale (noise_scale 8) + an optional HiDreamO1PatchSeamSmoothing pass
// (reduces tiled-patch seams on large images), and the canvas is the dedicated
// EmptyHiDreamO1LatentImage — NOT a VAEEncode. It does BOTH text→image and
// reference editing: attaching image(s) routes them through HiDreamO1ReferenceImages
// into the CONDITIONING (1 image = instruction edit, 2–10 = multi-reference); the
// latent stays empty either way. Mirrors the official ComfyUI O1 template
// (dpmpp_2m_sde_gpu / normal / 40 steps / cfg 5). Dims snap to /32 (latent step).
function buildHiDreamO1({ model, prompt, negative, imageNames, width, height, seed, cfg }) {
  const snap32 = (v, d) => { const n = Math.round((v || d) / 32) * 32; return Math.max(64, Math.min(4096, n)); };
  const W = snap32(width, 1024), H = snap32(height, 1024);
  const isEdit = Array.isArray(imageNames) && imageNames.length > 0;
  const wf = {
    "6": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: model } },
    "124": { class_type: "ModelNoiseScale", inputs: { model: ["6", 0], noise_scale: 8 } },
    "232": { class_type: "HiDreamO1PatchSeamSmoothing", inputs: { model: ["124", 0], start_percent: 0.8, end_percent: 1.0, pattern: "single_shift", passes: "ramp_2_4", blend: "median", strength: 1.0 } },
    "110": { class_type: "CLIPTextEncode", inputs: { clip: ["6", 1], text: prompt } },
    "188": { class_type: "CLIPTextEncode", inputs: { clip: ["6", 1], text: negative || "" } },
    "112": { class_type: "BasicScheduler", inputs: { model: ["124", 0], scheduler: cfg.scheduler, steps: cfg.steps, denoise: 1 } },
    "230": { class_type: "KSamplerSelect", inputs: { sampler_name: cfg.sampler } },
    "156": { class_type: "EmptyHiDreamO1LatentImage", inputs: { width: W, height: H, batch_size: 1 } },
    "108": { class_type: "SamplerCustom", inputs: { add_noise: true, noise_seed: seed, cfg: cfg.cfg, model: ["232", 0], positive: ["110", 0], negative: ["188", 0], sampler: ["230", 0], sigmas: ["112", 0], latent_image: ["156", 0] } },
    "105": { class_type: "VAEDecode", inputs: { samples: ["108", 0], vae: ["6", 2] } },
    "227": { class_type: "SaveImage", inputs: { filename_prefix: "heykoko", images: ["105", 0] } },
  };
  if (isEdit) {
    // Reference images feed the conditioning. This COMFY_AUTOGROW_V3 input uses
    // DOTTED socket keys "images.image_1".."images.image_10" (verified live on the
    // node — a plain list or bare image_N is rejected). The latent stays empty.
    const refInputs = { positive: ["110", 0], negative: ["188", 0] };
    imageNames.slice(0, 10).forEach((nm, i) => {
      const id = String(40 + i);
      wf[id] = { class_type: "LoadImage", inputs: { image: nm } };
      refInputs["images.image_" + (i + 1)] = [id, 0];
    });
    wf["104"] = { class_type: "HiDreamO1ReferenceImages", inputs: refInputs };
    wf["108"].inputs.positive = ["104", 0];
    wf["108"].inputs.negative = ["104", 1];
  }
  return wf;
}

// txt2img: an empty latent of the requested size feeds the sampler.
function buildTxt2Img({ model, prompt, negative, width, height, seed, cfg }) {
  return {
    ...commonNodes({ model, prompt, negative, guidance: cfg.guidance }),
    "3": ksampler({ seed, steps: cfg.steps, cfg: cfg.cfg, sampler: cfg.sampler, scheduler: cfg.scheduler, denoise: 1, latentRef: ["5", 0], guidance: cfg.guidance }),
    "5": {
      class_type: cfg.sd3Latent ? "EmptySD3LatentImage" : "EmptyLatentImage",
      inputs: { width, height, batch_size: 1 },
    },
  };
}

// img2img: the uploaded image is VAE-encoded into a latent, then partially
// denoised (denoise < 1) so the prompt edits it instead of replacing it. The
// output size is inherited from the input image.
function buildImg2Img({ model, prompt, negative, seed, denoise, imageName, cfg, width, height }) {
  const px = (width && height) ? ["12", 0] : ["11", 0];
  const wf = {
    ...commonNodes({ model, prompt, negative, guidance: cfg.guidance }),
    "3": ksampler({ seed, steps: cfg.steps, cfg: cfg.cfg, sampler: cfg.sampler, scheduler: cfg.scheduler, denoise, latentRef: ["10", 0], guidance: cfg.guidance }),
    "10": { class_type: "VAEEncode", inputs: { pixels: px, vae: ["4", 2] } },
    "11": { class_type: "LoadImage", inputs: { image: imageName } },
  };
  if (width && height) wf["12"] = scaleNode(["11", 0], width, height);
  return wf;
}

// Inpaint (local repaint) with a plain checkpoint: the user paints a mask and only
// that region is regenerated from the prompt — everything outside the mask is kept.
// The source is VAE-encoded, SetLatentNoiseMask confines denoising to the white
// area of the mask, and the KSampler runs at `denoise` (1.0 = fully repaint the
// region; lower keeps more of the original under it). The mask is a SEPARATE PNG
// (white = edit); ComfyUI resizes the noise mask to the latent automatically, so it
// only needs to share the source's aspect ratio — no manual alignment. The scale
// node uses id 13 (not 12) so it never collides with commonNodes' FluxGuidance.
function buildInpaint({ model, prompt, negative, imageName, maskName, seed, cfg, denoise, width, height }) {
  const px = (width && height) ? ["13", 0] : ["11", 0];
  const wf = {
    ...commonNodes({ model, prompt, negative, guidance: cfg.guidance }),
    "3": ksampler({ seed, steps: cfg.steps, cfg: cfg.cfg, sampler: cfg.sampler, scheduler: cfg.scheduler, denoise: denoise != null ? denoise : 1, latentRef: ["21", 0], guidance: cfg.guidance }),
    "10": { class_type: "VAEEncode", inputs: { pixels: px, vae: ["4", 2] } },
    "11": { class_type: "LoadImage", inputs: { image: imageName } },
    "20": { class_type: "LoadImageMask", inputs: { image: maskName, channel: "red" } },
    "21": { class_type: "SetLatentNoiseMask", inputs: { samples: ["10", 0], mask: ["20", 0] } },
  };
  if (width && height) wf["13"] = scaleNode(["11", 0], width, height);
  return wf;
}

// ── Instruction-edit workflows ──────────────────────────────────────────────
// These take a natural-language instruction + a reference image and edit it,
// preserving identity/composition far better than classic denoise img2img.

// FLUX.1 Kontext — official ComfyUI graph: the input image is scaled to a
// Kontext-friendly size, VAE-encoded, and injected into the positive
// conditioning via ReferenceLatent. cfg=1 + FluxGuidance, like base Flux.
function buildKontext({ model, prompt, imageName, maskName, seed, cfg, comp, width, height }) {
  const wf = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: model, weight_dtype: "default" } },
    "2": { class_type: "DualCLIPLoader", inputs: { clip_name1: comp.t5, clip_name2: comp.clipL, type: "flux" } },
    "3": { class_type: "VAELoader", inputs: { vae_name: comp.vae } },
    "4": { class_type: "LoadImage", inputs: { image: imageName } },
    // A target size overrides Kontext's auto-resolution scaler so the output
    // matches the requested size; otherwise use the Kontext-friendly scaler.
    "5": (width && height) ? scaleNode(["4", 0], width, height) : { class_type: "FluxKontextImageScale", inputs: { image: ["4", 0] } },
    "6": { class_type: "VAEEncode", inputs: { pixels: ["5", 0], vae: ["3", 0] } },
    "7": { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: prompt } },
    "8": { class_type: "FluxGuidance", inputs: { conditioning: ["7", 0], guidance: cfg.guidance != null ? cfg.guidance : 2.5 } },
    "9": { class_type: "ReferenceLatent", inputs: { conditioning: ["8", 0], latent: ["6", 0] } },
    "10": { class_type: "ConditioningZeroOut", inputs: { conditioning: ["7", 0] } },
    "11": { class_type: "KSampler", inputs: { seed, steps: cfg.steps, cfg: cfg.cfg, sampler_name: cfg.sampler, scheduler: cfg.scheduler, denoise: 1, model: ["1", 0], positive: ["9", 0], negative: ["10", 0], latent_image: ["6", 0] } },
    "12": { class_type: "VAEDecode", inputs: { samples: ["11", 0], vae: ["3", 0] } },
    "13": { class_type: "SaveImage", inputs: { filename_prefix: "heykoko", images: ["12", 0] } },
  };
  // Masked Kontext: confine the instruction edit to the painted region. The mask
  // gates the latent that the sampler denoises (SetLatentNoiseMask), so the
  // instruction only repaints inside the mask while the rest is reconstructed.
  if (maskName) {
    wf["20"] = { class_type: "LoadImageMask", inputs: { image: maskName, channel: "red" } };
    wf["21"] = { class_type: "SetLatentNoiseMask", inputs: { samples: ["6", 0], mask: ["20", 0] } };
    wf["11"].inputs.latent_image = ["21", 0];
  }
  return wf;
}

// Qwen-Image-Edit — TextEncodeQwenImageEdit folds the reference image + prompt
// into the conditioning (multimodal Qwen2.5-VL encoder). Negative is the same
// node with an empty prompt.
function buildQwenEdit({ model, prompt, imageName, maskName, seed, cfg, comp }) {
  // The reference image drives BOTH the conditioning and the latent — they must
  // match. Do NOT force an output size by VAE-encoding a resized copy: the
  // TextEncodeQwenImageEdit conditioning encodes the original, so a mismatched
  // latent size desyncs them and the model reconstructs the input INSTEAD of
  // applying the instruction (the edit appears ignored). Output size follows the
  // input, which is how Qwen-Image-Edit is meant to work.
  const wf = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: model, weight_dtype: "default" } },
    "2": { class_type: "CLIPLoader", inputs: { clip_name: comp.clip, type: "qwen_image" } },
    "3": { class_type: "VAELoader", inputs: { vae_name: comp.vae } },
    "4": { class_type: "LoadImage", inputs: { image: imageName } },
    "5": { class_type: "TextEncodeQwenImageEdit", inputs: { clip: ["2", 0], prompt, vae: ["3", 0], image: ["4", 0] } },
    "6": { class_type: "TextEncodeQwenImageEdit", inputs: { clip: ["2", 0], prompt: "", vae: ["3", 0], image: ["4", 0] } },
    "7": { class_type: "VAEEncode", inputs: { pixels: ["4", 0], vae: ["3", 0] } },
    "8": { class_type: "KSampler", inputs: { seed, steps: cfg.steps, cfg: cfg.cfg, sampler_name: cfg.sampler, scheduler: cfg.scheduler, denoise: 1, model: ["1", 0], positive: ["5", 0], negative: ["6", 0], latent_image: ["7", 0] } },
    "9": { class_type: "VAEDecode", inputs: { samples: ["8", 0], vae: ["3", 0] } },
    "10": { class_type: "SaveImage", inputs: { filename_prefix: "heykoko", images: ["9", 0] } },
  };
  // Masked Qwen-Image-Edit: gate the latent so the instruction only repaints the
  // painted region (the conditioning still sees the whole image for context), then
  // COMPOSITE the original image back OUTSIDE the mask so the background stays
  // pixel-for-pixel identical (SetLatentNoiseMask alone still VAE round-trips the
  // whole frame). Output = input size, so the decode (9) + original (4) align 1:1;
  // ImageCompositeMasked resizes the mask to match internally.
  if (maskName) {
    wf["20"] = { class_type: "LoadImageMask", inputs: { image: maskName, channel: "red" } };
    wf["21"] = { class_type: "SetLatentNoiseMask", inputs: { samples: ["7", 0], mask: ["20", 0] } };
    wf["8"].inputs.latent_image = ["21", 0];
    wf["22"] = { class_type: "ImageCompositeMasked", inputs: { destination: ["4", 0], source: ["9", 0], x: 0, y: 0, resize_source: false, mask: ["20", 0] } };
    wf["10"].inputs.images = ["22", 0];
  }
  return wf;
}

// Qwen-Image-Edit-2509 "Plus" — MULTI-image composition (up to 3 reference
// images). TextEncodeQwenImageEditPlus folds prompt + image1/2/3 into the
// conditioning; the canvas is a FRESH EmptySD3LatentImage (NOT a VAEEncode of
// one image — that would bias to it and drop the others). Width/height set the
// output size of the composite.
function buildQwenEditPlus({ model, prompt, imageNames, maskName, seed, cfg, comp, width, height }) {
  const loads = {};
  imageNames.slice(0, 3).forEach((nm, i) => {
    loads[String(11 + i)] = { class_type: "LoadImage", inputs: { image: nm } };
  });
  const encInputs = (text) => {
    const inputs = { clip: ["2", 0], prompt: text, vae: ["3", 0] };
    imageNames.slice(0, 3).forEach((nm, i) => { inputs["image" + (i + 1)] = [String(11 + i), 0]; });
    return { class_type: "TextEncodeQwenImageEditPlus", inputs };
  };
  const outW = width || 1024, outH = height || 1024;
  const wf = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: model, weight_dtype: "default" } },
    "2": { class_type: "CLIPLoader", inputs: { clip_name: comp.clip, type: "qwen_image" } },
    "3": { class_type: "VAELoader", inputs: { vae_name: comp.vae } },
    ...loads,
    "4": encInputs(prompt),
    "5": encInputs(""),
    "6": { class_type: "EmptySD3LatentImage", inputs: { width: outW, height: outH, batch_size: 1 } },
    "8": { class_type: "KSampler", inputs: { seed, steps: cfg.steps, cfg: cfg.cfg, sampler_name: cfg.sampler, scheduler: cfg.scheduler, denoise: 1, model: ["1", 0], positive: ["4", 0], negative: ["5", 0], latent_image: ["6", 0] } },
    "9": { class_type: "VAEDecode", inputs: { samples: ["8", 0], vae: ["3", 0] } },
    "10": { class_type: "SaveImage", inputs: { filename_prefix: "heykoko", images: ["9", 0] } },
  };
  // Background lock (person-swap): keep the ORIGINAL scene (first reference, node
  // 11) pixel-for-pixel OUTSIDE the painted mask; only the masked region — the
  // swapped-in person from the fresh compose (node 9) — is taken from the
  // generation. The scene is only scaled (lanczos) to the output size, NOT VAE
  // round-tripped, so mask-outside pixels are a clean resize of the source, not a
  // model reconstruction. Caller pins width/height to the scene's aspect so this
  // resize introduces no distortion. Mask white = person region → source shows
  // through (ImageCompositeMasked resizes the mask to the source internally).
  if (maskName) {
    wf["40"] = scaleNode(["11", 0], outW, outH);
    wf["41"] = { class_type: "LoadImageMask", inputs: { image: maskName, channel: "red" } };
    wf["42"] = { class_type: "ImageCompositeMasked", inputs: { destination: ["40", 0], source: ["9", 0], x: 0, y: 0, resize_source: false, mask: ["41", 0] } };
    wf["10"].inputs.images = ["42", 0];
  }
  return wf;
}

// OmniGen2 — works on stock ComfyUI after all: the model + its "omnigen2" CLIP
// type are in core. The earlier num_tokens crash was caused by routing the
// conditioning through ReferenceLatent; the plain omnigen2 CLIP encode sets
// num_tokens itself. Used as an instruction editor here: VAEEncode(source) →
// latent at denoise ~0.8 + the instruction (preserves the subject, applies the
// edit). (It can also do txt2img, but we surface it in the edit group.)
function buildOmniGen2Edit({ model, prompt, negative, imageName, maskName, seed, cfg, comp, denoise, width, height }) {
  const px = (width && height) ? ["16", 0] : ["14", 0];
  const wf = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: model, weight_dtype: "default" } },
    "2": { class_type: "CLIPLoader", inputs: { clip_name: comp.clip, type: "omnigen2" } },
    "3": { class_type: "VAELoader", inputs: { vae_name: comp.vae } },
    "14": { class_type: "LoadImage", inputs: { image: imageName } },
    "15": { class_type: "VAEEncode", inputs: { pixels: px, vae: ["3", 0] } },
    "4": { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: prompt } },
    "5": { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: negative || "" } },
    "8": { class_type: "KSampler", inputs: { seed, steps: cfg.steps, cfg: cfg.cfg, sampler_name: cfg.sampler, scheduler: cfg.scheduler, denoise: denoise != null ? denoise : 0.8, model: ["1", 0], positive: ["4", 0], negative: ["5", 0], latent_image: ["15", 0] } },
    "9": { class_type: "VAEDecode", inputs: { samples: ["8", 0], vae: ["3", 0] } },
    "10": { class_type: "SaveImage", inputs: { filename_prefix: "heykoko", images: ["9", 0] } },
  };
  if (width && height) wf["16"] = scaleNode(["14", 0], width, height);
  // Masked edit: confine the instruction to the painted region (gate the latent).
  if (maskName) {
    wf["20"] = { class_type: "LoadImageMask", inputs: { image: maskName, channel: "red" } };
    wf["21"] = { class_type: "SetLatentNoiseMask", inputs: { samples: ["15", 0], mask: ["20", 0] } };
    wf["8"].inputs.latent_image = ["21", 0];
  }
  return wf;
}

// InstructPix2Pix — a full SD1.5 checkpoint that needs ip2p's THREE-way
// classifier-free guidance via DualCFGGuider:
//   cond1 = text+image, cond2 = image-only, negative = true uncond (empty text,
//   no image). cfg_conds is text guidance; cfg_cond2_negative is image guidance
//   (raise it to preserve the input more). A plain single-cfg KSampler over-
//   edits and ignores the source image — this is the correct ip2p sampler.
function buildInstructPix2Pix({ model, prompt, negative, imageName, maskName, seed, cfg, width, height }) {
  const imageCfg = cfg.imageCfg != null ? cfg.imageCfg : 1.5;
  const px = (width && height) ? ["13", 0] : ["4", 0];
  const wf = {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: model } },
    "2": { class_type: "CLIPTextEncode", inputs: { clip: ["1", 1], text: prompt } },
    "3": { class_type: "CLIPTextEncode", inputs: { clip: ["1", 1], text: negative } },
    "4": { class_type: "LoadImage", inputs: { image: imageName } },
    "5": { class_type: "InstructPixToPixConditioning", inputs: { positive: ["2", 0], negative: ["3", 0], vae: ["1", 2], pixels: px } },
    "6": { class_type: "DualCFGGuider", inputs: { model: ["1", 0], cond1: ["5", 0], cond2: ["5", 1], negative: ["3", 0], cfg_conds: cfg.cfg, cfg_cond2_negative: imageCfg, style: "regular" } },
    "7": { class_type: "RandomNoise", inputs: { noise_seed: seed } },
    "8": { class_type: "KSamplerSelect", inputs: { sampler_name: cfg.sampler } },
    "9": { class_type: "BasicScheduler", inputs: { model: ["1", 0], scheduler: cfg.scheduler, steps: cfg.steps, denoise: 1 } },
    "10": { class_type: "SamplerCustomAdvanced", inputs: { noise: ["7", 0], guider: ["6", 0], sampler: ["8", 0], sigmas: ["9", 0], latent_image: ["5", 2] } },
    "11": { class_type: "VAEDecode", inputs: { samples: ["10", 0], vae: ["1", 2] } },
    "12": { class_type: "SaveImage", inputs: { filename_prefix: "heykoko", images: ["11", 0] } },
  };
  if (width && height) wf["13"] = scaleNode(["4", 0], width, height);
  // Masked edit: gate the ip2p latent (from InstructPixToPixConditioning, ["5",2])
  // so SamplerCustomAdvanced only repaints inside the painted region.
  if (maskName) {
    wf["20"] = { class_type: "LoadImageMask", inputs: { image: maskName, channel: "red" } };
    wf["21"] = { class_type: "SetLatentNoiseMask", inputs: { samples: ["5", 2], mask: ["20", 0] } };
    wf["10"].inputs.latent_image = ["21", 0];
  }
  return wf;
}

// boogu instruction editing (boogu_image_edit). Mirrors the user's exported edit
// graph: the prompt + reference image(s) go through the dedicated
// TextEncodeBooguEdit node (which embeds the reference into the conditioning), the
// negative is a ConditioningZeroOut, the canvas is a VAEEncode of the primary
// reference, and the KSampler runs at denoise 1 (the edit is driven by the
// conditioning, not a partial denoise). The node's reference input is a
// COMFY_AUTOGROW_V3 named `images`, addressed with DOTTED per-slot keys
// (`images.image_1` … `images.image_12`, the node's own template names) — same
// convention as HiDreamO1ReferenceImages. The bare LIST form (`images: [[id,0],…]`)
// is accepted by /prompt validation and reports no node_errors, but the references
// never reach the conditioning: a three-way live A/B (no images / list / dotted)
// showed the list output pixel-equivalent to passing no reference at all, while
// only the dotted form produced a real edit. Same AuraFlow shift-3 + flux-VAE stack.
function buildBooguEdit({ model, prompt, negative, imageName, imageNames, maskName, seed, cfg, comp }) {
  const refs = imageNames && imageNames.length ? imageNames : (imageName ? [imageName] : []);
  const wf = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: model, weight_dtype: "default" } },
    "2": { class_type: "CLIPLoader", inputs: { clip_name: comp.clip, type: "boogu", device: "default" } },
    "3": { class_type: "VAELoader", inputs: { vae_name: comp.vae } },
    "7": { class_type: "ModelSamplingAuraFlow", inputs: { model: ["1", 0], shift: 3.0 } },
    "9": { class_type: "VAEDecode", inputs: { samples: ["8", 0], vae: ["3", 0] } },
    "10": { class_type: "SaveImage", inputs: { filename_prefix: "heykoko", images: ["9", 0] } },
  };
  const encInputs = { prompt, negative_prompt: negative || "", clip: ["2", 0], vae: ["3", 0] };
  refs.slice(0, 12).forEach((name, i) => {
    const id = String(30 + i);
    wf[id] = { class_type: "LoadImage", inputs: { image: name } };
    encInputs["images.image_" + (i + 1)] = [id, 0];
  });
  wf["4"] = { class_type: "TextEncodeBooguEdit", inputs: encInputs };
  wf["5"] = { class_type: "ConditioningZeroOut", inputs: { conditioning: ["4", 0] } };
  // Reference latent = VAEEncode of the primary image (LoadImage node 30).
  wf["6"] = { class_type: "VAEEncode", inputs: { pixels: ["30", 0], vae: ["3", 0] } };
  wf["8"] = { class_type: "KSampler", inputs: { seed, steps: cfg.steps, cfg: cfg.cfg, sampler_name: cfg.sampler, scheduler: cfg.scheduler, denoise: 1, model: ["7", 0], positive: ["4", 0], negative: ["5", 0], latent_image: ["6", 0] } };
  if (maskName && refs.length >= 2) {
    // Multi-reference person-swap with a background lock: the output (node 9) is
    // decoded at the primary scene's own resolution (its VAEEncode drives the
    // latent), so it lines up 1:1 with the ORIGINAL primary image (node 30).
    // Composite the fresh generation back over the untouched source, keeping only
    // the masked region (the swapped person) — everything outside the mask stays
    // pixel-identical to the input scene. Mask white = person region.
    wf["41"] = { class_type: "LoadImageMask", inputs: { image: maskName, channel: "red" } };
    wf["42"] = { class_type: "ImageCompositeMasked", inputs: { destination: ["30", 0], source: ["9", 0], x: 0, y: 0, resize_source: false, mask: ["41", 0] } };
    wf["10"].inputs.images = ["42", 0];
  } else if (maskName) {
    // Single-image masked edit: confine the instruction to the painted region by
    // gating the latent (no separate scene to composite against).
    wf["20"] = { class_type: "LoadImageMask", inputs: { image: maskName, channel: "red" } };
    wf["21"] = { class_type: "SetLatentNoiseMask", inputs: { samples: ["6", 0], mask: ["20", 0] } };
    wf["8"].inputs.latent_image = ["21", 0];
  }
  return wf;
}

function buildEditWorkflow(editType, args) {
  if (editType === "kontext") return buildKontext(args);
  if (editType === "qwen") return buildQwenEdit(args);
  if (editType === "ip2p") return buildInstructPix2Pix(args);
  if (editType === "hidream-e1") return buildHiDreamEdit(args);
  if (editType === "omnigen") return buildOmniGen2Edit(args);
  if (editType === "boogu-edit") return buildBooguEdit(args);
  return null;
}

// ── Video workflows ─────────────────────────────────────────────────────────

async function videoCompanions(videoType, model, opts = {}) {
  const [clips, vaes] = await Promise.all([
    comfyEnum("CLIPLoader", "clip_name"),
    comfyEnum("VAELoader", "vae_name"),
  ]);
  const find = (list, re) => list.find((x) => re.test(x));
  if (videoType === "wan") {
    const clip = find(clips, /umt5/i);
    // The 14B experts use the WAN 2.1 VAE; the 5B ti2v uses its own WAN 2.2 VAE.
    // They are NOT interchangeable (wrong VAE → wrong colors / garbage).
    const is14B = /14b/i.test(model || "");
    const vae = is14B
      ? (find(vaes, /wan.?2[._]1.*vae/i) || find(vaes, /wan.*vae/i))
      : (find(vaes, /wan2[._]2.*vae/i) || find(vaes, /wan.*vae/i));
    const missing = [];
    if (!clip) missing.push("umt5_xxl_fp8_e4m3fn_scaled.safetensors → text_encoders/");
    if (!vae) missing.push((is14B ? "wan_2.1_vae.safetensors" : "wan2.2_vae.safetensors") + " → vae/");
    if (missing.length) throw new Error("Missing files required by WAN video:\n- " + missing.join("\n- "));
    // Optional LightX2V 4-step speed LoRAs (one per expert, matched to t2v/i2v).
    // Present → buildWan14B mounts them and we switch to the 4-step/cfg-1 preset.
    let loraHigh, loraLow;
    if (is14B) {
      const kind = /i2v/i.test(model) ? "i2v" : "t2v";
      const loras = await comfyEnum("LoraLoaderModelOnly", "lora_name");
      loraHigh = find(loras, new RegExp(`wan.?2[._]2_${kind}_lightx2v.*high_noise`, "i"));
      loraLow = find(loras, new RegExp(`wan.?2[._]2_${kind}_lightx2v.*low_noise`, "i"));
      if (!loraHigh || !loraLow) { loraHigh = undefined; loraLow = undefined; } // need the pair
    }
    return { clip, vae, loraHigh, loraLow };
  }
  if (videoType === "hunyuan") {
    const clipL = find(clips, /clip_l/i);
    const llava = find(clips, /llava.*llama|llava_llama3/i);
    const vae = find(vaes, /hunyuan.*video.*vae|hunyuan_video_vae/i);
    const missing = [];
    if (!clipL) missing.push("clip_l.safetensors → text_encoders/");
    if (!llava) missing.push("llava_llama3_fp8_scaled.safetensors → text_encoders/");
    if (!vae) missing.push("hunyuan_video_vae_bf16.safetensors → vae/");
    if (missing.length) throw new Error("Missing files required by Hunyuan video:\n- " + missing.join("\n- "));
    return { clipL, llava, vae };
  }
  if (videoType === "minimax-h3") {
    // Qwen3-VL-32B text encoder (CLIPLoader with type "minimax" — a new enum value in
    // ComfyUI 0.30) plus TWO VAEs. The audio VAE is not optional even for fl2va, which
    // has no audio input: H3 samples picture and sound into ONE latent, so the audio VAE
    // is what turns the audio half of that latent into a track at decode time.
    //
    // The text encoder ships in three tiers spanning 15.7-51.5 GB (nvfp4_awq / int8_convrot
    // / bf16) and it is the piece that reads the prompt, so which one loads is a real
    // quality-vs-memory choice rather than an implementation detail. ⚙ picks it by name;
    // "auto" goes through bestTier so a downloaded bf16 doesn't win just by sorting first
    // (plain enum order put "bf16" ahead of "int8_convrot", silently swapping a 27 GB
    // encoder for a 51.5 GB one the moment the file landed).
    const clipGroup = clips.filter((x) => H3_CLIP_RE.test(x));
    const wantClip = String(opts.h3TextEncoder || "").trim();
    const clip = (wantClip && clipGroup.find((x) => x === wantClip))
      || (opts.precision && opts.precision !== "auto" && clipGroup.find((x) => precisionOf(x) === opts.precision))
      || bestTier(clipGroup)
      || find(clips, /minimax/i);
    const vae = find(vaes, /minimax.*h3.*video.*vae/i) || find(vaes, /minimax.*video.*vae/i);
    const audioVae = find(vaes, /minimax.*h3.*audio.*vae/i) || find(vaes, /minimax.*audio.*vae/i);
    const missing = [];
    if (!clip) missing.push("qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors → text_encoders/");
    if (!vae) missing.push("minimax_h3_video_vae_fp16.safetensors → vae/");
    if (!audioVae) missing.push("minimax_h3_audio_vae_fp32.safetensors → vae/");
    if (missing.length) throw new Error("Missing files required by MiniMax H3:\n- " + missing.join("\n- "));
    return { clip, vae, audioVae };
  }
  if (model === LTX_MSR) {
    // The ⚙ precision preference selects the transformer tier (fp8_scaled default,
    // mxfp8_block32 / int8_convrot / bf16 if downloaded and chosen).
    const parts = await ltxMsrParts(opts.precision);
    if (!parts) throw new Error("LTX MSR is missing pieces. It needs: a distilled LTX-2.3 checkpoint — either the FULL distilled-fp8 (checkpoints/, clean path) or the transformer-only file + a dev checkpoint for VAE (fallback) — plus the Licon MSR V2 LoRA (loras/), a gemma_3_12B text encoder, and the ComfyUI-LTXVideo + ComfyUI-Licon-MSR + ComfyUI-PromptRelay node packs.");
    // Optional ⚙ LTX LoRA, stacked on the transformer BEFORE the MSR IC-LoRA (Sulphur
    // is the intended one — content/style on top of MSR's identity conditioning). This
    // is an UNVERIFIED combination: Sulphur was trained on plain LTX-2.3, not the MSR
    // path, so it may erode the multi-subject consistency that is MSR's whole point —
    // it's off by default and only applied when the user explicitly picks a LoRA. The
    // base is the distilled transformer (no "sulphur" in its name), so loraBakedIn
    // never suppresses the Sulphur LoRA here the way it would on a merged checkpoint.
    let msrLora = null, msrLoraStrength = 1;
    const wantLora = String(opts.ltxLora || "").trim();
    if (wantLora) {
      const loras = await comfyEnum("LoraLoaderModelOnly", "lora_name").catch(() => []);
      msrLora = loras.find((x) => x === wantLora) || null;
      const s = Number(opts.ltxLoraStrength);
      msrLoraStrength = isFinite(s) && s > 0 ? Math.min(3, s) : 1;
    }
    return { ...parts, msr: true, lora: msrLora, loraStrength: msrLoraStrength };
  }
  if (model === LTX_UNION) {
    // ⚙ precision selects the distilled-checkpoint tier (fp8 default; mxfp8 / nvfp4 if present).
    const parts = await ltxUnionParts(opts.precision);
    if (!parts) throw new Error("LTX union control is missing pieces. It needs: the FULL distilled LTX-2.3 checkpoint (checkpoints/), the union-control IC-LoRA (loras/), a gemma_3_12B text encoder, a MoGe depth model (models/geometry_estimation/), and the ComfyUI-LTXVideo + MoGe + video node packs.");
    return { ...parts, union: true };
  }
  if (videoType === "ltx") {
    // LTX-2 uses a Gemma text encoder (loaded via LTXAVTextEncoderLoader with the
    // model's own ckpt); VAE comes from the checkpoint, so no separate VAE needed.
    // Must be the 12B Gemma-3 — the smaller gemma4_e4b (Gemma 3n) is a different
    // model and produces broken output, and it sorts first so a bare /gemma/ grabs
    // the wrong one.
    const encoder = find(clips, /gemma.*12b/i) || find(clips, /gemma_?3/i) || find(clips, /gemma/i) || find(clips, /t5xxl/i);
    if (!encoder) throw new Error("Missing LTX-2 text encoder:\n- gemma_3_12B_it…safetensors (or t5xxl) → text_encoders/");
    // Optional LTX-family LoRA (⚙ "LTX LoRA"). Re-checked against the live enum so a
    // saved choice for a since-deleted file degrades to "no LoRA" instead of failing
    // the whole graph, and skipped outright when the checkpoint already bakes it in.
    let lora = null, loraStrength = 1;
    const want = String(opts.ltxLora || "").trim();
    const loras = await comfyEnum("LoraLoaderModelOnly", "lora_name").catch(() => []);
    if (want && !loraBakedIn(model, want)) {
      lora = loras.find((x) => x === want) || null;
      const s = Number(opts.ltxLoraStrength);
      loraStrength = isFinite(s) && s > 0 ? Math.min(3, s) : 1;
    }
    // Two-stage cascade parts (the official LTX-2.3 recipe): the distilled LoRA that
    // makes the short hand-tuned sigma schedules valid, and the spatial upscaler that
    // doubles the stage-1 latent before the refine pass. Both must be present or the
    // builder falls back to the single-stage LTXVScheduler path — running the 8-step
    // distilled schedule WITHOUT the LoRA produces noise, so this is a hard pairing.
    //
    // Sulphur gets its OWN recipe rather than ltx-2.3's. Its metadata marks it a
    // style/content finetune (title ltxxx_lora_v2, dim/alpha 768/768, module
    // networks.lora_ltx2), not a step-distiller, and it does not survive ltx-2.3's
    // fixed sigma table — verified live: Sulphur + that table blurs badly, whether it
    // arrives baked into the checkpoint (sulphur_dev_*) or stacked as a LoRA over a
    // plain ltx-2.3 base. Its own distilled workflow computes the base schedule with
    // LTXVScheduler at a much larger shift instead; LTX_RECIPES.sulphur carries that.
    const sulphurSelected = /sulphur/i.test(model || "") || /sulphur/i.test(lora || "");
    const recipe = sulphurSelected ? "sulphur" : "base";
    // Sulphur's workflow pins the "condsafe" re-ranked distiller specifically; the
    // ltx-2.3 templates use the 1.1 distilled LoRA. Fall back to any LTX distiller.
    const distillLora = sulphurSelected
      ? (find(loras, /ltx.*condsafe/i) || find(loras, /ltx.*distill/i))
      : (find(loras, /ltx.*distill.*1\.1/i) || find(loras, /ltx.*distill/i));
    const upscaleModels = await comfyEnum("LatentUpscaleModelLoader", "model_name").catch(() => []);
    const upscaler = find(upscaleModels, /ltx.*spatial.*upscal/i) || find(upscaleModels, /ltx.*upscal/i);
    return { encoder, lora, loraStrength, distillLora, upscaler, recipe };
  }
  throw new Error("This video model is not wired up yet (currently supported: WAN 2.2, Hunyuan, LTX-2).");
}

// Per-model video defaults (resolution / length / fps / sampling), overridable.
// dimMult = resolution must be a multiple of this; lenMult = frame count must be
// lenMult·n + 1.
function videoPreset(videoType, model, turbo) {
  if (videoType === "wan") {
    if (/14b/i.test(model || "")) {
      // WAN 2.2 14B MoE (high+low experts). WITH the LightX2V 4-step speed LoRAs
      // (turbo) it runs cfg 1 / 4 steps (~6-10× faster); without them, the full
      // schedule cfg 3.5 / 20 steps. euler/simple, shift 5, native 16fps either way.
      const fast = turbo
        ? { cfg: 1, steps: 4 }
        : { cfg: 3.5, steps: 20 };
      return { sampler: "euler", scheduler: "simple", ...fast, shift: 5.0, width: 832, height: 480, length: 81, fps: 16, dimMult: 16, lenMult: 4 };
    }
    return { sampler: "uni_pc", scheduler: "simple", cfg: 5, steps: 20, shift: 8.0, width: 704, height: 480, length: 49, fps: 24, dimMult: 16, lenMult: 4 };
  }
  if (videoType === "phantom") {
    // Upstream s2v defaults (phantom_wan generate.py): uni_pc, 50 steps, shift 5.0,
    // g_text 7.5 (this cfg = cfg_conds), g_img 5.0 (handled separately in buildPhantom).
    // 14B example runs 121 frames @ 24 fps; keep the 81/16 preset and let ⚙ raise it.
    //
    // turbo = the lightx2v step-distill LoRA is mounted. It was trained with CFG
    // distilled away, so cfg MUST drop to 1 (the caller drops g_img to 1 to match) and
    // the step count collapses to 8. Leaving cfg at 7.5 with the LoRA on produces
    // burnt, over-saturated output — the two settings are one package, not two knobs.
    if (turbo) return { sampler: "uni_pc", scheduler: "simple", cfg: 1, steps: 8, shift: 5.0, width: 832, height: 480, length: 81, fps: 24, dimMult: 16, lenMult: 4 };
    return { sampler: "uni_pc", scheduler: "simple", cfg: 7.5, steps: 50, shift: 5.0, width: 832, height: 480, length: 81, fps: 24, dimMult: 16, lenMult: 4 };
  }
  if (videoType === "hunyuan") {
    return { sampler: "euler", scheduler: "simple", cfg: 6, steps: 20, shift: 7.0, width: 720, height: 480, length: 49, fps: 24, dimMult: 16, lenMult: 4 };
  }
  if (videoType === "minimax-h3") {
    // Straight off the three official ComfyUI templates, which all ship the SAME
    // sampling: res_multistep + simple, 20 steps, and a BasicGuider — one conditioning
    // branch, no negative prompt and no CFG knob anywhere in the graph. `cfg` is carried
    // only so the shared config plumbing and the done-line have a value to show; nothing
    // reads it into the workflow. (20/simple is the template default and, like every
    // shipped default, is UNMEASURED — worth a step sweep once the size question settles.)
    //
    // 864×480 is the templates' own default (ResolutionSelector at 0.4 MP) and is the
    // size actually MEASURED to fit: 124 frames peaked at 34.10/34.19 GB VRAM on a 32GB
    // RTX 5090 (99.7%) with 64.5/68.2 GB system RAM, in 57 s. There is no headroom left
    // at that size on that box, so the default stays where it was verified and larger
    // sizes are an explicit ⚙ / --size opt-in.
    //
    // length: the node's own tooltip states a TRAINED range of ~124-362 frames at 24 fps
    // (≈5-15 s) on a 17k+5 grid. The shipped t2v/i2v templates default to 2 s → 56 frames,
    // which is BELOW that range — hence lenMin/lenMax. Note this also closes the usual
    // "shorten the clip to fit VRAM" escape hatch: 124 is the floor, so on a memory-bound
    // box resolution is the only dial left.
    // fpsFixed: 24 is the model's own rate, not a mux setting. `length` is defined AT
    // 24 fps (the node's tooltip says so) and fps reaches nothing but CreateVideo, so
    // changing it cannot make the model generate more frames — it only re-times the same
    // ones. Worse, it desyncs the sound: the audio VAE decodes a track whose length the
    // latent fixes (124 frames = 5.17 s), while the picture would become 124/fps seconds.
    // Frame interpolation is unaffected and stays available — applyVfi multiplies frames
    // and rate together, so the duration, and with it the audio, is preserved.
    return { sampler: "res_multistep", scheduler: "simple", cfg: 1, steps: 20, shift: 0,
      width: 864, height: 480, length: 124, fps: 24, fpsFixed: true,
      dimMult: 32, lenMult: 17, lenOffset: 5, lenMin: 124, lenMax: 362 };
  }
  if (model === LTX_MSR) {
    // MSR's own distilled route: single stage, no latent upscale, 8-step schedule at
    // cfg 1 with euler_ancestral. The recipe/model-card value is 50 fps, but fps is a
    // GENERATION parameter here (it feeds LTXVConditioning), and 30 was verified to look
    // identical while matching the user's 30-fps delivery target — so 30 is the default
    // and the ⚙ field raises it back to 50 when wanted. The clip must stay longer than
    // the packed reference sequence, which the builder enforces on top of this.
    return { sampler: "euler_ancestral", scheduler: "simple", cfg: 1, steps: 8, shift: 0, width: 1280, height: 704, length: 121, fps: 30, dimMult: 32, lenMult: 8 };
  }
  if (model === LTX_UNION) {
    // Union control: single-pass KSampler on the distilled checkpoint — 8 steps, cfg 1,
    // euler_ancestral + linear_quadratic (the template's schedule, verified end-to-end).
    // `length` bounds the driving-video slice (the graph derives the real frame count from
    // the depth sequence); 25 fps is the template rate. The KSampler scheduler string is
    // carried on the preset so the builder reads it back. dimMult is 64 (not LTX's usual
    // 32): the union IC-LoRA's reference_downscale_factor is 2, so the LATENT spatial dims
    // (width/32, height/32) must each be even → width & height divisible by 64, or
    // LTXVAddGuide fails ("Latent spatial size WxH must be divisible by 2").
    return { sampler: "euler_ancestral", scheduler: "linear_quadratic", cfg: 1, steps: 8, shift: 0, width: 1280, height: 704, length: 97, fps: 25, dimMult: 64, lenMult: 8 };
  }
  if (videoType === "ltx") {
    // `turbo` here = the two-stage cascade is available (distilled LoRA + spatial
    // upscaler both installed). Frames are 8n+1 either way.
    if (turbo) {
      // Official LTX-2.3 recipe: sample at HALF these dims, upscale the latent ×2,
      // then refine — so width/height are the FINAL frame size and must be /64 for
      // the halved stage-1 latent to stay /32. cfg 1 and the step counts are fixed
      // by the hand-tuned sigma tables in buildLtxVideo (8 + 3); `steps` is carried
      // only so the ⚙ field and the done-line have something coherent to show.
      // fps follows each finetune's own workflow: ltx-2.3's templates run 25, both
      // Sulphur workflows run 24. It reaches LTXVConditioning + the audio latent, so
      // it isn't only a mux setting — keep each family on the rate it was tuned at.
      const fps = /sulphur/i.test(model || "") ? 24 : 25;
      return { sampler: "euler", scheduler: "simple", cfg: 1, steps: 11, shift: 0, width: 1280, height: 704, length: 97, fps, dimMult: 64, lenMult: 8 };
    }
    // Fallback (no distilled LoRA / no upscaler): the older single-stage path with
    // LTXVScheduler. dims /32. The 22b model is undersampled at 20 steps (motion
    // ghosting / trailing edges) — 30 is the quality sweet spot, but slow.
    return { sampler: "euler", scheduler: "simple", cfg: 3, steps: 30, shift: 0, width: 768, height: 512, length: 97, fps: 24, dimMult: 32, lenMult: 8 };
  }
  return null;
}

// The frame rate a requested DURATION (-s / --second) should be measured against — the rate the
// builder about to run will really mux at, so "10s" comes back as 10 seconds of video.
// Preset models carry their own (fpsFixed ones ignore the ⚙ override, exactly as
// resolveVideoConfig does). The preset-less builders (bernini / animate / scail2 /
// infinitetalk / ltx-union) take their rate from the SOURCE clip; only "photo speaks"
// (InfiniteTalk with no source) has none, and its builders default to 25.
// turbo is passed as true to match the lenInfo the ⚙ length field was built from — it
// only moves LTX's rate, and by 1 fps.
function videoRateFor(videoType, model, opts, srcFps) {
  const p = videoPreset(videoType, model, true);
  if (p) return p.fpsFixed ? p.fps : (Number(opts.fps) || p.fps);
  const fallback = (videoType === "infinitetalk" || videoType === "ltx-union") ? 25 : 16;
  return Number(srcFps) || Number(opts.fps) || fallback;
}

// Snap a requested frame count onto the model's grid: lenMult·n + lenOffset. lenOffset
// defaults to 1 (every model here except MiniMax H3, whose grid is 17k+5). When a preset
// declares lenMin/lenMax — a TRAINED range the model shouldn't be pushed outside of —
// clamp first, then step back inside if snapping crossed an edge.
function snapLength(L, p) {
  const off = p.lenOffset != null ? p.lenOffset : 1;
  const lo = p.lenMin != null ? p.lenMin : p.lenMult + off;
  const hi = p.lenMax != null ? p.lenMax : Infinity;
  const snapped = Math.round((Math.min(hi, Math.max(lo, L)) - off) / p.lenMult) * p.lenMult + off;
  if (snapped < lo) return snapped + p.lenMult;
  if (snapped > hi) return snapped - p.lenMult;
  return snapped;
}

function resolveVideoConfig(videoType, opts, model, turbo) {
  const p = videoPreset(videoType, model, turbo);
  if (!p) return null;
  const snap = (v, m) => Math.max(m, Math.round(v / m) * m);
  const L = opts.length || p.length;
  // i2v: when the caller gives the input image's aspect ratio (and no explicit
  // size), render at that aspect — keeping the preset's pixel budget — so the
  // conditioning frame isn't stretched. Stretching a mismatched still is the
  // main cause of ghosted / doubled edges in image-to-video.
  let baseW = opts.width || p.width;
  let baseH = opts.height || p.height;
  if (!opts.width && !opts.height && opts.aspect > 0) {
    const area = p.width * p.height;
    baseW = Math.sqrt(area * opts.aspect);
    baseH = Math.sqrt(area / opts.aspect);
  }
  return {
    sampler: opts.sampler || p.sampler,
    scheduler: opts.scheduler || p.scheduler,
    cfg: opts.cfg != null ? opts.cfg : p.cfg,
    steps: opts.steps || p.steps,
    shift: opts.shift != null ? opts.shift : p.shift,
    width: snap(baseW, p.dimMult),
    height: snap(baseH, p.dimMult),
    // Frame count must sit on the model's grid — snap to the nearest valid value.
    length: snapLength(L, p),
    // fpsFixed models ignore a ⚙ value outright rather than trusting the field to be
    // hidden: a rate saved before the model was added, or carried on an older queued job,
    // would otherwise still reach the graph.
    fps: p.fpsFixed ? p.fps : (opts.fps || p.fps),
  };
}

// Frame interpolation (interpolate / smooth slow-mo). Splices a VFI node between the
// workflow's decoded frames and its CreateVideo, multiplying the frame count by
// `mult`. For SMOOTH SAME-SPEED playback the muxed fps is multiplied to match, so
// the duration is unchanged — the motion is just resampled to a higher frame rate.
// `method` picks the node: "rife" (RIFE VFI, default — fast) or "film" (FILM VFI,
// slower/smoother). Both are from ComfyUI-Frame-Interpolation. Works for every
// video builder (each has exactly one CreateVideo). The new fps is written as a
// NUMBER, which also replaces any source-fps node link (Bernini v2v / Wan Animate
// read fps from GetVideoComponents) — so `baseFps` MUST be that source fps for
// those models. Mutates `wf` in place; returns the new numeric fps (or `baseFps`
// unchanged when not applied).
// Per-codec default CRF (quality → size). Chosen so each codec's default is a sensible
// quality point for it: libx264 ~23, libx265 ~28 (HEVC's scale runs ~6 lower for the
// same look, and 28 is where it reliably beats h264 on size). A ⚙ value overrides.
const VIDEO_CRF_DEFAULT = { h264: 23, h265: 28 };

// Rewrite a video workflow's tail (CreateVideo → SaveVideo) to VideoHelperSuite's
// VHS_VideoCombine, used for BOTH codecs so h264 and h265 share ONE path and one CRF
// quality knob:
//   video/h264-mp4  (libx264)            — default, plays everywhere
//   video/h265-mp4  (libx265 + hvc1 tag) — smaller, Safari / recent-Mac playback only
// VHS_VideoCombine encodes straight from FRAMES, so it replaces BOTH tail nodes: it
// reads the inputs CreateVideo was fed — images, fps (as frame_rate), and the optional
// audio — and writes under SaveVideo's filename_prefix. LIVE-VERIFIED on the box: both
// formats accept crf + pix_fmt, outputs land under the `gifs` key, frame_rate takes a
// literal OR a FLOAT link (the edit builders' source fps), audio yields a single
// "<prefix>_NNNNN-audio.mp4".
//
// MUST run AFTER applyVfi (which rewrites CreateVideo.images → the VFI node and bumps
// its fps): reading CreateVideo's inputs here then picks up the interpolated frames and
// rate. No-op returning false when there is no CreateVideo, so it is safe on any
// workflow (image graphs, upscale-only) without a guard at the call site.
// Deliver a silent clip: unhook the audio from the muxer, then drop whatever only
// existed to produce it. Builder-agnostic, and deliberately done in the GRAPH rather
// than by asking the model — MiniMax H3 samples picture and sound into ONE latent, so it
// always generates a soundtrack and (having no negative branch) cannot be told not to.
// For source-video builders this drops the SOURCE clip's audio instead. It saves no real
// time: only the audio decode and the mux go away, never the sampling.
//
// The prune is deliberately narrow — it removes a node only when nothing references it
// any more AND its class is one of the audio-side producers. A general reachability GC
// would be wrong here: the segmented builders have several output nodes, and anything
// walking back from "the" output would delete the other segments.
const MUTE_PRUNABLE = new Set(["VAEDecodeAudio", "LTXVAudioVAEDecode", "LTXVAudioVAELoader", "VAELoader", "LoadAudio"]);
function applyMuteAudio(wf) {
  let muted = false;
  for (const id in wf) {
    if (wf[id].class_type === "CreateVideo" && wf[id].inputs && "audio" in wf[id].inputs) {
      delete wf[id].inputs.audio;
      muted = true;
    }
  }
  if (!muted) return false;
  // Two passes: the decode goes first, which is what leaves its VAE loader unreferenced.
  for (let pass = 0; pass < 2; pass++) {
    const referenced = new Set();
    for (const id in wf) {
      for (const val of Object.values(wf[id].inputs || {})) {
        if (Array.isArray(val) && typeof val[0] === "string") referenced.add(val[0]);
      }
    }
    for (const id in wf) {
      if (!referenced.has(id) && MUTE_PRUNABLE.has(wf[id].class_type)) delete wf[id];
    }
  }
  return true;
}

function applyVideoCodec(wf, codec, crf) {
  const c = codec === "h265" ? "h265" : "h264";
  let createId = null, saveId = null;
  for (const id in wf) {
    const ct = wf[id].class_type;
    if (ct === "CreateVideo") createId = id;
    else if (ct === "SaveVideo") saveId = id;
  }
  if (!createId) return false;
  const cv = wf[createId].inputs;
  const prefix = (saveId && wf[saveId].inputs.filename_prefix) || "heykoko_vid";
  const inputs = {
    images: cv.images,
    frame_rate: cv.fps,
    loop_count: 0,
    filename_prefix: prefix,
    format: `video/${c}-mp4`,
    pingpong: false,
    save_output: true,
    pix_fmt: "yuv420p",
    crf: crf > 0 ? Math.min(51, crf) : VIDEO_CRF_DEFAULT[c],
    save_metadata: false,
  };
  if (cv.audio != null) inputs.audio = cv.audio; // carry the soundtrack when the model has one
  delete wf[createId];
  if (saveId) delete wf[saveId];
  // "vhsout" — a string id that can't collide with the numeric ids builders use.
  wf["vhsout"] = { class_type: "VHS_VideoCombine", inputs };
  return true;
}

// One RIFE/FILM interpolation node. clear_cache_after_n_frames keeps VRAM bounded on long
// clips; multiplier inserts (m−1) frames between each pair → (N−1)·m + 1 frames out.
// Shared by applyVfi (post-hoc splice, every other builder) and buildVideoEnhance, which
// places its own so interpolation can sit BEFORE the chunk split.
function vfiNodeSpec(method, m, framesRef) {
  return /film/i.test(method || "")
    ? { class_type: "FILM VFI", inputs: { ckpt_name: "film_net_fp32.pt", frames: framesRef, clear_cache_after_n_frames: 10, multiplier: m } }
    : { class_type: "RIFE VFI", inputs: { ckpt_name: "rife47.pth", frames: framesRef, clear_cache_after_n_frames: 10, multiplier: m, fast_mode: true, ensemble: true, scale_factor: 1, dtype: "float32", torch_compile: false, batch_size: 1 } };
}

function applyVfi(wf, mult, baseFps, method) {
  const m = Math.round(Number(mult) || 0);
  if (!wf || m < 2) return baseFps;
  // EVERY CreateVideo, not just the first. Almost every builder ends in exactly one,
  // but SCAIL-2's incremental-save graph writes ONE PER SEGMENT (see buildScail2), and
  // interpolating only segment 0 would hand the merge step clips at two different frame
  // rates — the concat would then either fail or silently retime the rest of the clip.
  const cvIds = Object.keys(wf).filter((id) => wf[id].class_type === "CreateVideo");
  if (!cvIds.length) return baseFps;
  const newFps = Math.round((Number(baseFps) || 0) * m);
  cvIds.forEach((cvId, i) => {
    const cv = wf[cvId];
    const vid = i === 0 ? "vfi" : `vfi${i}`;
    wf[vid] = vfiNodeSpec(method, m, cv.inputs.images);
    cv.inputs.images = [vid, 0];
    if (newFps > 0) cv.inputs.fps = newFps;
  });
  return newFps > 0 ? newFps : baseFps;
}

// models/upscale_models/ holds two different KINDS of model and ComfyUI lists them
// together: real upscalers (2x / 4x / …) and 1x RESTORATION models (de-artifact,
// de-JPEG, de-H264) that resize nothing at all. Offering a 1x model as "the upscaler"
// yields a run that completes and changes the resolution not at all, so the scale is
// read off the filename here and the two kinds are routed to separate slots.
//
// Naming in this ecosystem is one of two shapes — leading "4x-UltraSharp" / "1xDeH264",
// or trailing "RealESRGAN_x2plus" — and an unrecognised name is treated as an upscaler,
// because wrongly hiding a working model is worse than listing an odd one.
function upscaleScaleOf(name) {
  const n = String(name || "");
  let m = /(?:^|[^a-z0-9])(\d)\s*x/i.exec(n);            // 4x-UltraSharp, 1xDeH264, 2xLiveAction
  if (m) return Number(m[1]);
  m = /x(\d)(?![0-9])/i.exec(n);                          // RealESRGAN_x2plus, …SwinIR-L_x4_GAN
  if (m) return Number(m[1]);
  return null;                                            // unknown → assume it upscales
}
const isRestoreModel = (n) => upscaleScaleOf(n) === 1;

// AI upscale model for the video-enhance (HD) pipeline. `wantScale` is the ratio the
// pipeline actually needs (output ÷ source); the auto-pick takes the SMALLEST installed
// model that reaches it, because overshooting is not free — measured on a 121-frame
// 1280x704 clip, x4plus cost 1236 ms/frame and 36.5 GiB of system RAM against x2plus's
// 321 ms and 7.2 GiB, for a result that is then downsampled back anyway.
async function upscaleCompanions(preferred, wantScale = 0) {
  const all = await comfyEnum("UpscaleModelLoader", "model_name");
  const models = all.filter((n) => !isRestoreModel(n));   // 1x restorers are not upscalers
  // A user-picked model (⚙ "upscale model") wins when it's actually installed; otherwise
  // fall through to the auto-pick. Match exact name first, then case-insensitively.
  if (preferred) {
    const exact = models.find((x) => x === preferred) || models.find((x) => x.toLowerCase() === String(preferred).toLowerCase());
    if (exact) return { model: exact, scale: upscaleScaleOf(exact) };
  }
  const find = (re, pool = models) => pool.find((x) => re.test(x));
  // Prefer models that REACH the needed ratio without overshooting: exact scale first,
  // then the smallest that still covers it. Falls through to the general ranking when
  // nothing declares a usable scale (or no ratio was asked for).
  let model = null;
  if (wantScale > 0) {
    const scaled = models.map((n) => ({ n, s: upscaleScaleOf(n) })).filter((x) => x.s > 1);
    const exact = scaled.filter((x) => x.s === Math.round(wantScale)).map((x) => x.n);
    const over = scaled.filter((x) => x.s > wantScale).sort((a, b) => a.s - b.s).map((x) => x.n);
    const pool = exact.length ? exact : over;
    // RealESRGAN is the steadier choice on video within whichever tier we land in.
    if (pool.length) model = find(/realesrgan(?!.*anime)/i, pool) || pool[0];
  }
  // RealESRGAN first — it cleans compression artifacts and is temporally steadier on
  // video; UltraSharp (sharper but amplifies noise frame-to-frame) is the next choice.
  model = model ||
    find(/realesrgan.*x4plus(?!.*anime)/i) ||
    find(/realesrgan(?!.*anime)/i) ||
    find(/4x.?ultrasharp/i) ||
    find(/4x.?foolhardy|remacri|nmkd/i) ||
    find(/realesrgan/i) ||
    find(/(^|[^0-9])4x/i) ||
    find(/x4|x2|2x/i) ||
    models[0];
  if (!model) throw new Error("Missing upscale model: put an upscale model (e.g. RealESRGAN_x4plus.safetensors or 4x-UltraSharp.pth) into ComfyUI/models/upscale_models/ and retry.");
  return { model, scale: upscaleScaleOf(model) };
}

// The 1x restoration model used to pre-clean frames before upscaling — a real
// de-artifact network in place of the blur-and-blend approximation. Returns null when
// none is installed, and the caller falls back to that blur rather than failing.
async function restoreCompanion(preferred) {
  const models = (await comfyEnum("UpscaleModelLoader", "model_name")).filter(isRestoreModel);
  if (!models.length) return null;
  if (preferred) {
    const exact = models.find((x) => x === preferred) || models.find((x) => x.toLowerCase() === String(preferred).toLowerCase());
    if (exact) return exact;
  }
  // Video codecs first (what a source clip actually suffers from), then the generic
  // de-JPEG / restore models, which are at least trained on compression too.
  return models.find((x) => /h ?26[45]|avc|hevc|mpeg/i.test(x))
      || models.find((x) => /dejpg|jpeg|compress/i.test(x))
      || models[0];
}

// Video enhance (interpolate + upscale). Source video → GetVideoComponents → AI-upscale every
// frame (UpscaleModelLoader + ImageUpscaleWithModel) → optionally downscale to a
// bounded HD target (outW/outH, already even; 0 = keep the model's native output) →
// CreateVideo, keeping the SOURCE audio + fps. Frame interpolation to the target fps
// is layered ON TOP by applyVfi (called from the dispatch) — it splices a RIFE/FILM
// node before CreateVideo and rewrites the (numeric) fps. Single pass over the whole
// clip (no diffusion); keep clips modest so the upscaled frame batch fits VRAM.
// How many frames may be upscaled in ONE ImageUpscaleWithModel call. The node moves the
// input batch to the GPU but assembles its OUTPUT on the CPU (tiled_scale's default
// output_device), so the wall this hits is SYSTEM RAM, not VRAM — measured on the 5090:
// a 121-frame 1280x704 clip cost 1.4-2.1 GiB of VRAM regardless of scale, while RAM went
// 7.2 GiB at 2x and 36.5 GiB at 4x. Left whole, a 30 s 30 fps 720p clip at 4x would want
// ~148 GiB before overhead, i.e. more than the machine has.
const UPSCALE_CHUNK_BUDGET = 6 * 2 ** 30;   // bytes of upscaled frames per chunk
const UPSCALE_RAM_FACTOR = 1.75;            // measured 36.5 GiB against a 20.9 GiB theoretical
const UPSCALE_MIN_CHUNK = 8;                // below this the per-chunk overhead dominates
// ImageFromBatch declares length as INT max 4096, and ComfyUI REJECTS the prompt outright
// for a larger value — so it bounds both the chunk size and the "take the rest" sweep.
// (Only the chunked path slices at all; a single tail feeds the batch straight through and
// is unaffected by this ceiling.)
const IMAGE_FROM_BATCH_MAX = 4096;

// null = the whole clip fits, keep the single-file path (short clips are the common case
// and the merge step is pure cost for them). Sizes are computed from the model's NATIVE
// output, which is the peak — any ImageScale back down happens after that batch exists.
function upscaleChunkPlan(frames, nativeW, nativeH) {
  if (!(frames > 0) || !(nativeW > 0) || !(nativeH > 0)) return null;
  const perFrame = nativeW * nativeH * 3 * 4 * UPSCALE_RAM_FACTOR;
  if (perFrame * frames <= UPSCALE_CHUNK_BUDGET) return null;
  // Clamp BEFORE deriving the count — a small frame size can make the memory budget alone
  // allow tens of thousands of frames per chunk, which the slice node cannot express.
  const size = Math.min(IMAGE_FROM_BATCH_MAX, Math.max(UPSCALE_MIN_CHUNK, Math.floor(UPSCALE_CHUNK_BUDGET / perFrame)));
  return { size, count: Math.ceil(frames / size), perFrame };
}

// Post-resize sharpening for the video-enhance pipeline. Named steps rather than a free
// number: the useful range of an unsharp mask is narrow, and past it video picks up halos
// that flicker frame to frame — worse than the softness it was meant to fix. Values are
// the `alpha` of core ComfyUI's ImageSharpen (a 3x3 unsharp mask at sigma 1.0), which is
// present on every install and takes plain scalars.
const SHARPEN_LEVELS = { light: 0.3, medium: 0.6, strong: 0.9 };
const sharpenAlphaOf = (level) => SHARPEN_LEVELS[String(level || "").toLowerCase()] || 0;

const enhanceSaveNodeId = (k) => `s${k}`;

// Video enhance (interpolate + upscale). Source video → GetVideoComponents → optional
// de-artifact pass → optional frame interpolation → AI-upscale every frame → optionally
// downscale to a bounded HD target (outW/outH, already even; 0 = keep the model's native
// output) → CreateVideo.
//
// `chunk` ({size, count}) splits the upscale into N independent tails, each writing its
// own file, so the full upscaled batch never exists at once. The dispatch then merges the
// parts with ffmpeg and muxes the source audio back (the same path SCAIL-2's incremental
// save uses), which is why chunked tails are written SILENT.
//
// Interpolation deliberately runs BEFORE the upscale, at source resolution. Two reasons:
// it is far cheaper there (a quarter of the pixels at 2x), and it must sit ahead of the
// chunk split — per-chunk interpolation would leave every chunk boundary without its
// in-between frames, a visible stutter once per chunk.
function buildVideoEnhance({ videoName, upscaleModel, outW, outH, denoise, restoreModel, sharpen, vfi, chunk }) {
  const wf = {
    "5": { class_type: "LoadVideo", inputs: { file: videoName } },
    "6": { class_type: "GetVideoComponents", inputs: { video: ["5", 0] } },
  };
  // Pre-clean the REAL frames, before anything invents new ones from them.
  let framesRef = denoiseBeforeUpscale(wf, ["6", 0], denoise, "20", "21", restoreModel);
  let fpsRef = ["6", 2];
  if (vfi && vfi.mult >= 2) {
    wf["7v"] = vfiNodeSpec(vfi.method, vfi.mult, framesRef);
    framesRef = ["7v", 0];
    fpsRef = vfi.fps;                       // a NUMBER once interpolated
  }
  if (upscaleModel) wf["7"] = { class_type: "UpscaleModelLoader", inputs: { model_name: upscaleModel } };

  // One tail: [slice] → upscale → [resize] → CreateVideo → SaveVideo.
  const tail = (k, sliceFrom, sliceLen) => {
    const p = `c${k}`;
    let ref = framesRef;
    if (sliceLen > 0) {
      wf[`${p}f`] = { class_type: "ImageFromBatch", inputs: { image: ref, batch_index: sliceFrom, length: sliceLen } };
      ref = [`${p}f`, 0];
    }
    if (upscaleModel) {
      wf[`${p}u`] = { class_type: "ImageUpscaleWithModel", inputs: { upscale_model: ["7", 0], image: ref } };
      ref = [`${p}u`, 0];
    }
    if (outW > 0 && outH > 0) {
      wf[`${p}s`] = { class_type: "ImageScale", inputs: { image: ref, upscale_method: "lanczos", width: outW, height: outH, crop: "disabled" } };
      ref = [`${p}s`, 0];
    }
    // AFTER the resize, never before: sharpening what is about to be resampled just
    // feeds the filter its own halos. Inside the tail, so a chunked run sharpens every
    // chunk rather than only the first.
    if (sharpen > 0) {
      wf[`${p}h`] = { class_type: "ImageSharpen", inputs: { image: ref, sharpen_radius: 1, sigma: 1.0, alpha: sharpen } };
      ref = [`${p}h`, 0];
    }
    // Chunked parts are silent: the merge takes the audio from the source clip, so audio
    // here would only be re-encoded per part and then thrown away.
    const cv = { images: ref, fps: fpsRef };
    if (!chunk) cv.audio = ["6", 1];
    wf[`${p}v`] = { class_type: "CreateVideo", inputs: cv };
    wf[enhanceSaveNodeId(k)] = { class_type: "SaveVideo", inputs: { video: [`${p}v`, 0], filename_prefix: "heykoko_enhance", format: "auto", codec: "auto" } };
  };

  if (!chunk) tail(0, 0, 0);
  else for (let k = 0; k < chunk.count; k++) {
    // The LAST chunk asks for everything that is left, up to the node's own ceiling
    // (ImageFromBatch clamps `length` down to the frames actually present). The plan is
    // sized from a probed frame count, and a count that came back short would otherwise
    // drop the tail of the clip silently — far worse than one oversized final chunk.
    tail(k, k * chunk.size, k === chunk.count - 1 ? IMAGE_FROM_BATCH_MAX : chunk.size);
  }
  return wf;
}

// Pre-upscale denoise (denoise / artifact reduction). Upscale models AMPLIFY whatever's in the input —
// including compression noise / grain / JPEG artifacts. Blending the input toward a
// mildly Gaussian-blurred copy (by `strength` 0–1) cleans that grain BEFORE the model
// sees it, so it isn't sharpened up. 0 → untouched (sharpest); 1 → full blur (cleanest
// but softest). Works with ANY upscale model (core nodes only). Adds ImageBlur+ImageBlend
// under blurId/blendId; returns the cleaned image ref to feed ImageUpscaleWithModel.
// `restoreModel` (a 1x de-artifact network, see restoreCompanion) replaces the blur with
// a model that actually removes compression artifacts instead of smearing them — the
// blend stays, so the ⚙ percentage keeps its meaning either way (0 = untouched,
// 100 = fully cleaned). Absent, it falls back to the blur rather than failing.
// COSTS A FULL EXTRA PASS over every frame: measured on 121 frames at 1280x704,
// 1xDeH264_realplksr ran 443 ms/frame against the 2x upscale's own 321 ms — i.e. more
// than doubling the job. Never enable it by default.
function denoiseBeforeUpscale(wf, srcRef, strength, blurId, blendId, restoreModel) {
  const s = Math.max(0, Math.min(1, Number(strength) || 0));
  if (s <= 0) return srcRef;
  if (restoreModel) {
    wf[blurId + "L"] = { class_type: "UpscaleModelLoader", inputs: { model_name: restoreModel } };
    wf[blurId] = { class_type: "ImageUpscaleWithModel", inputs: { upscale_model: [blurId + "L", 0], image: srcRef } };
  } else {
    wf[blurId] = { class_type: "ImageBlur", inputs: { image: srcRef, blur_radius: 2, sigma: 1.5 } };
  }
  wf[blendId] = { class_type: "ImageBlend", inputs: { image1: srcRef, image2: [blurId, 0], blend_factor: s, blend_mode: "normal" } };
  return [blendId, 0];
}

// Image upscale (image HD / upscale): attached image → AI upscale model → bigger, sharper
// image. `denoise` (0–1) pre-cleans the input (denoise). `outW/outH` (already even)
// optionally resize the upscaled result (e.g. --size); 0 = keep the model's native
// output (usually 4×). Output is a normal image.
function buildImageUpscale({ imageName, upscaleModel, outW, outH, denoise, restoreModel }) {
  const wf = { "1": { class_type: "LoadImage", inputs: { image: imageName } } };
  const clean = denoiseBeforeUpscale(wf, ["1", 0], denoise, "5", "6", restoreModel);
  // No upscale model (⚙ "upscale model" = Off) → passthrough (only denoise / an explicit
  // --size resize apply). Mostly a degenerate case for the image-upscale model.
  let ref = clean;
  if (upscaleModel) {
    wf["2"] = { class_type: "UpscaleModelLoader", inputs: { model_name: upscaleModel } };
    wf["3"] = { class_type: "ImageUpscaleWithModel", inputs: { upscale_model: ["2", 0], image: clean } };
    ref = ["3", 0];
  }
  if (outW > 0 && outH > 0) { wf["4"] = scaleNode(ref, outW, outH); ref = ["4", 0]; }
  wf["9"] = { class_type: "SaveImage", inputs: { images: ref, filename_prefix: "heykoko_upscale" } };
  return wf;
}

// WAN's standard negative prompt. WAN is tuned to be sampled WITH this — without
// it you get the artifacts it suppresses (oversaturated / weird / grayish color,
// overexposure, static frames). Used whenever the user didn't supply their own.
const WAN_DEFAULT_NEGATIVE =
  "色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走";

// LTX's own default negative. Note the cascade runs at cfg 1, where the negative
// branch carries no weight — it matters only on the single-stage fallback (cfg 3).
const LTX_DEFAULT_NEGATIVE = "worst quality, inconsistent motion, blurry, jittery, distorted";

// WAN 2.2 14B is a two-expert MoE: the high-noise expert denoises the early
// (high-noise) half of the schedule, then the low-noise expert finishes — chained
// via two KSamplerAdvanced nodes (the first returns leftover noise, the second
// adds none and picks up where it left off). The two checkpoints are a pair; we
// derive the low-noise twin from the selected high-noise name. t2v uses an empty
// latent; i2v uses WanImageToVideo; first-last-frame (start + end image, FLF2V)
// uses WanFirstLastFrameToVideo — all three just swap node 7 and its conditioning.
function buildWan14B({ model, prompt, negative, comp, imageName, endImageName, seed, v, experts }) {
  const neg = negative && negative.trim() ? negative : WAN_DEFAULT_NEGATIVE;
  // `experts` = the pair already resolved to the ⚙ precision tier (each twin
  // independently — see resolvePrecision). Absent → derive the twin by name, which
  // is right whenever both ship in the same precision.
  const highModel = (experts && experts.high) || model.replace(/low_noise/i, "high_noise");
  const lowModel = (experts && experts.low) || model.replace(/high_noise/i, "low_noise");
  const flf = !!endImageName;     // first-last-frame (start + end)
  const i2v = !!imageName && !flf; // plain image-to-video (start only)
  const boundary = Math.max(1, Math.floor(v.steps / 2)); // expert switch at ~50%
  // LightX2V 4-step speed LoRAs (when installed): one per expert, between the
  // UNETLoader and ModelSamplingSD3. Each expert's sampler then feeds from its
  // LoRA output. The preset already dropped to 4 steps / cfg 1 to match.
  const turbo = !!(comp.loraHigh && comp.loraLow);
  const highSrc = turbo ? "16" : "1";
  const lowSrc = turbo ? "17" : "11";
  const wf = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: highModel, weight_dtype: "default" } },
    "2": { class_type: "ModelSamplingSD3", inputs: { model: [highSrc, 0], shift: v.shift } },
    "11": { class_type: "UNETLoader", inputs: { unet_name: lowModel, weight_dtype: "default" } },
    "12": { class_type: "ModelSamplingSD3", inputs: { model: [lowSrc, 0], shift: v.shift } },
    "3": { class_type: "CLIPLoader", inputs: { clip_name: comp.clip, type: "wan" } },
    "4": { class_type: "VAELoader", inputs: { vae_name: comp.vae } },
    "5": { class_type: "CLIPTextEncode", inputs: { clip: ["3", 0], text: prompt } },
    "6": { class_type: "CLIPTextEncode", inputs: { clip: ["3", 0], text: neg } },
  };
  if (turbo) {
    wf["16"] = { class_type: "LoraLoaderModelOnly", inputs: { model: ["1", 0], lora_name: comp.loraHigh, strength_model: 1.0 } };
    wf["17"] = { class_type: "LoraLoaderModelOnly", inputs: { model: ["11", 0], lora_name: comp.loraLow, strength_model: 1.0 } };
  }
  let posRef, negRef, latentRef;
  if (flf) {
    wf["13"] = { class_type: "LoadImage", inputs: { image: imageName } };
    wf["18"] = { class_type: "LoadImage", inputs: { image: endImageName } };
    wf["7"] = { class_type: "WanFirstLastFrameToVideo", inputs: { positive: ["5", 0], negative: ["6", 0], vae: ["4", 0], width: v.width, height: v.height, length: v.length, batch_size: 1, start_image: ["13", 0], end_image: ["18", 0] } };
    posRef = ["7", 0]; negRef = ["7", 1]; latentRef = ["7", 2];
  } else if (i2v) {
    wf["13"] = { class_type: "LoadImage", inputs: { image: imageName } };
    wf["7"] = { class_type: "WanImageToVideo", inputs: { positive: ["5", 0], negative: ["6", 0], vae: ["4", 0], width: v.width, height: v.height, length: v.length, batch_size: 1, start_image: ["13", 0] } };
    posRef = ["7", 0]; negRef = ["7", 1]; latentRef = ["7", 2];
  } else {
    wf["7"] = { class_type: "EmptyHunyuanLatentVideo", inputs: { width: v.width, height: v.height, length: v.length, batch_size: 1 } };
    posRef = ["5", 0]; negRef = ["6", 0]; latentRef = ["7", 0];
  }
  wf["8"] = { class_type: "KSamplerAdvanced", inputs: { model: ["2", 0], add_noise: "enable", noise_seed: seed, steps: v.steps, cfg: v.cfg, sampler_name: v.sampler, scheduler: v.scheduler, positive: posRef, negative: negRef, latent_image: latentRef, start_at_step: 0, end_at_step: boundary, return_with_leftover_noise: "enable" } };
  wf["9"] = { class_type: "KSamplerAdvanced", inputs: { model: ["12", 0], add_noise: "disable", noise_seed: seed, steps: v.steps, cfg: v.cfg, sampler_name: v.sampler, scheduler: v.scheduler, positive: posRef, negative: negRef, latent_image: ["8", 0], start_at_step: boundary, end_at_step: v.steps, return_with_leftover_noise: "disable" } };
  wf["10"] = { class_type: "VAEDecode", inputs: { samples: ["9", 0], vae: ["4", 0] } };
  wf["14"] = { class_type: "CreateVideo", inputs: { images: ["10", 0], fps: v.fps } };
  wf["15"] = { class_type: "SaveVideo", inputs: { video: ["14", 0], filename_prefix: "heykoko_vid", format: "mp4", codec: "h264" } };
  return wf;
}

// WAN 2.2 ti2v 5B: one model does text→video AND image→video (pass start_image
// for i2v). Wan22ImageToVideoLatent builds the latent; ModelSamplingSD3 applies
// WAN's shift; frames are muxed to mp4 via CreateVideo→SaveVideo. The 14B variant
// is a different (two-expert) pipeline, dispatched separately.
function buildWanVideo(args) {
  if (/14b/i.test(args.model || "")) return buildWan14B(args);
  const { model, prompt, negative, comp, imageName, seed, v } = args;
  const neg = negative && negative.trim() ? negative : WAN_DEFAULT_NEGATIVE;
  const latentInputs = { vae: ["4", 0], width: v.width, height: v.height, length: v.length, batch_size: 1 };
  if (imageName) latentInputs.start_image = ["12", 0];
  const wf = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: model, weight_dtype: "default" } },
    "2": { class_type: "ModelSamplingSD3", inputs: { model: ["1", 0], shift: v.shift } },
    "3": { class_type: "CLIPLoader", inputs: { clip_name: comp.clip, type: "wan" } },
    "4": { class_type: "VAELoader", inputs: { vae_name: comp.vae } },
    "5": { class_type: "CLIPTextEncode", inputs: { clip: ["3", 0], text: prompt } },
    "6": { class_type: "CLIPTextEncode", inputs: { clip: ["3", 0], text: neg } },
    "7": { class_type: "Wan22ImageToVideoLatent", inputs: latentInputs },
    "8": { class_type: "KSampler", inputs: { seed, steps: v.steps, cfg: v.cfg, sampler_name: v.sampler, scheduler: v.scheduler, denoise: 1, model: ["2", 0], positive: ["5", 0], negative: ["6", 0], latent_image: ["7", 0] } },
    "9": { class_type: "VAEDecode", inputs: { samples: ["8", 0], vae: ["4", 0] } },
    "10": { class_type: "CreateVideo", inputs: { images: ["9", 0], fps: v.fps } },
    "11": { class_type: "SaveVideo", inputs: { video: ["10", 0], filename_prefix: "heykoko_vid", format: "mp4", codec: "h264" } },
  };
  if (imageName) wf["12"] = { class_type: "LoadImage", inputs: { image: imageName } };
  return wf;
}

// Hunyuan Video (t2v_720p): UNET + DualCLIPLoader(clip_l + llava_llama3,
// type hunyuan_video) + Hunyuan VAE. Text→video only (this checkpoint has no
// i2v). ModelSamplingSD3 shift, plain KSampler.
function buildHunyuanVideo({ model, prompt, negative, comp, seed, v }) {
  return {
    "1": { class_type: "UNETLoader", inputs: { unet_name: model, weight_dtype: "default" } },
    "2": { class_type: "DualCLIPLoader", inputs: { clip_name1: comp.clipL, clip_name2: comp.llava, type: "hunyuan_video" } },
    "3": { class_type: "VAELoader", inputs: { vae_name: comp.vae } },
    "4": { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: prompt } },
    "5": { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: negative } },
    "6": { class_type: "EmptyHunyuanLatentVideo", inputs: { width: v.width, height: v.height, length: v.length, batch_size: 1 } },
    "7": { class_type: "ModelSamplingSD3", inputs: { model: ["1", 0], shift: v.shift } },
    "8": { class_type: "KSampler", inputs: { seed, steps: v.steps, cfg: v.cfg, sampler_name: v.sampler, scheduler: v.scheduler, denoise: 1, model: ["7", 0], positive: ["4", 0], negative: ["5", 0], latent_image: ["6", 0] } },
    "9": { class_type: "VAEDecode", inputs: { samples: ["8", 0], vae: ["3", 0] } },
    "10": { class_type: "CreateVideo", inputs: { images: ["9", 0], fps: v.fps } },
    "11": { class_type: "SaveVideo", inputs: { video: ["10", 0], filename_prefix: "heykoko_vid", format: "mp4", codec: "h264" } },
  };
}

// LTX-2 (ltx-2.3-22b, and the same-architecture "sulphur" release) — an AUDIO+VIDEO
// model. The checkpoint provides MODEL + video VAE + audio VAE; LTXAVTextEncoderLoader
// loads the Gemma text encoder with the right projection (a plain CLIPLoader gives a
// dim mismatch). Every path builds a combined AV latent (video latent + audio latent
// → LTXVConcatAVLatent), samples it, splits it back (LTXVSeparateAVLatent), decodes
// video and audio separately, then CreateVideo muxes the audio into the mp4.
//
// Two implementations, picked by whether the cascade parts are installed:
//   • buildLtxCascade     — the official LTX-2.3 recipe (distilled LoRA + upscaler)
//   • buildLtxSingleStage — the older one-pass LTXVScheduler path (fallback)
// Both support the same three input modes: t2v (no image), i2v (one image), and
// keyframes (2+ images pinned at evenly-spaced frames via a chain of LTXVAddGuide).
// Reference caps straight off the node's own autogrow config (min 0 / max N).
const H3_MAX_REF_IMAGES = 9;
// The H3 text encoders on disk. Shared by videoCompanions (which loads one) and
// proxyComfyModels (which offers the list to ⚙) so the two cannot drift apart.
const H3_CLIP_RE = /qwen3vl.*minimax|minimax.*qwen3vl/i;

// MiniMax H3 — ONE graph shape for both weight files; which node it hangs on is the task:
//   MiniMaxH3ImageToVideo     (fl2va) — prompt alone = t2v, + first_frame / last_frame = i2v / FLF
//   MiniMaxH3ReferenceToVideo (ref2va) — reference images (≤9), video (≤3) and audio (≤3)
// Both nodes do their OWN text encoding — they take the CLIP and the raw prompt string
// directly and return the positive conditioning plus a sized empty latent. So there is no
// CLIPTextEncode and no negative branch anywhere: BasicGuider carries a single
// conditioning and the graph has no CFG at all.
//
// Picture and sound come out of ONE latent: the sampler's single output is decoded twice,
// by the video VAE and by the audio VAE, and CreateVideo muxes them into one file. That
// pairing is what applyVideoCodec's tail rewrite has to preserve.
//
// ⚠️ The reference slots are COMFY_AUTOGROW_V3 inputs, and their API key is the
// DOTTED path "<groupId>.<prefix><n>" — ref_images.ref_image_0, ref_videos.ref_video_0,
// ref_video_audios.ref_video_audio_0, ref_audios.ref_audio_0. Not the bare slot name:
// comfy_api/latest/_io.py builds each expanded id with finalize_prefix(["ref_images"],
// "ref_image_0"), registers it in dynamic_paths, and execution.py's build_nested_inputs
// splits that path back into the nested dict execute() actually receives
// (ref_images={"ref_image_0": IMAGE, …}). A bare "ref_image_0" reaches execute() as a
// stray kwarg and raises TypeError at run time.
//
// Nothing catches a wrong key before that run: /prompt validation ignores these slots
// entirely (verified — graphs with dangling and type-mismatched links here pass
// validation silently). It fails loudly rather than quietly, though: an unrecognised key
// is not dropped, it survives into the kwargs and raises. So a run that COMPLETES is
// itself proof the keys landed — which is how the current names were confirmed (both
// weight files verified end-to-end, Aug 2026). "It validated" still proves nothing.
function buildMiniMaxH3({ model, prompt, comp, v, seed, firstFrameName, lastFrameName,
  refImageNames, refVideoName, refAudioName, refImageSize, easyCache }) {
  const isRef = /ref2va/i.test(model || "");
  const refs = (Array.isArray(refImageNames) ? refImageNames : []).filter(Boolean).slice(0, H3_MAX_REF_IMAGES);
  const wf = {
    "unet":  { class_type: "UNETLoader", inputs: { unet_name: model, weight_dtype: "default" } },
    // type "minimax" is a CLIPLoader enum value new in ComfyUI 0.30 — the Qwen3-VL-32B
    // encoder is shared by both H3 weight files.
    "clip":  { class_type: "CLIPLoader", inputs: { clip_name: comp.clip, type: "minimax", device: "default" } },
    "vae":   { class_type: "VAELoader", inputs: { vae_name: comp.vae } },
    "avae":  { class_type: "VAELoader", inputs: { vae_name: comp.audioVae } },
    "noise": { class_type: "RandomNoise", inputs: { noise_seed: seed } },
    "samp":  { class_type: "KSamplerSelect", inputs: { sampler_name: v.sampler } },
    "sig":   { class_type: "BasicScheduler", inputs: { model: ["unet", 0], scheduler: v.scheduler, steps: v.steps, denoise: 1.0 } },
    // EasyCache (⚙, off by default) — a core MODEL→MODEL patch that reuses the previous
    // step's result whenever the step-to-step change falls under reuse_threshold, at the
    // cost of some fidelity. The defaults are the node's own. It is spliced in ONLY
    // between the UNET and the guider: BasicScheduler keeps the RAW model, because sigmas
    // must not depend on whether caching is on.
    //
    // Expectations, so this isn't mistaken for a fix: it removes sampling COMPUTE, not
    // weights, and it holds an extra cached tensor — no help at all on a box that is
    // memory-bound, and on a 32GB card it can push a tight run over. It also has less to
    // work with here than the "~25%" the community quotes: 20 steps leave less
    // step-to-step redundancy than the 40-50-step runs those figures come from, and H3
    // already runs CFG-free (BasicGuider), so the single biggest saving is spent.
    ...(easyCache ? { "ec": { class_type: "EasyCache", inputs: { model: ["unet", 0], reuse_threshold: 0.2, start_percent: 0.15, end_percent: 0.95, verbose: false } } } : {}),
    "guide": { class_type: "BasicGuider", inputs: { model: [easyCache ? "ec" : "unet", 0], conditioning: ["h3", 0] } },
    "ks":    { class_type: "SamplerCustomAdvanced", inputs: { noise: ["noise", 0], guider: ["guide", 0], sampler: ["samp", 0], sigmas: ["sig", 0], latent_image: ["h3", 1] } },
    "vdec":  { class_type: "VAEDecode", inputs: { samples: ["ks", 0], vae: ["vae", 0] } },
    "adec":  { class_type: "VAEDecodeAudio", inputs: { samples: ["ks", 0], vae: ["avae", 0] } },
    "cv":    { class_type: "CreateVideo", inputs: { images: ["vdec", 0], audio: ["adec", 0], fps: v.fps } },
    "save":  { class_type: "SaveVideo", inputs: { video: ["cv", 0], filename_prefix: "heykoko_vid", format: "mp4", codec: "h264" } },
  };
  const h3 = { clip: ["clip", 0], vae: ["vae", 0], prompt: prompt || "",
    width: v.width, height: v.height, length: v.length };
  if (isRef) {
    // ref2va ENCODES reference audio, so unlike fl2va it takes the audio VAE as an input.
    h3.audio_vae = ["avae", 0];
    // "match" scales each reference to the generation's pixel area; "max" runs the
    // reference pipeline at a 2048px short edge for the best identity fidelity. Reference
    // tokens ride through EVERY sampling step, so "max" can be several times slower.
    h3.ref_image_size = refImageSize === "max" ? "max" : "match";
    refs.forEach((name, i) => {
      wf[`ri${i}`] = { class_type: "LoadImage", inputs: { image: name } };
      h3[`ref_images.ref_image_${i}`] = [`ri${i}`, 0];
    });
    if (refVideoName) {
      // Frames and the clip's own soundtrack come off the SAME GetVideoComponents node
      // (slot 0 = IMAGE, slot 1 = AUDIO) and must carry the matching index: the node pairs
      // them by the numeric suffix (ref_video_audios["ref_video_audio_" + n]), not by order.
      wf["rlv"] = { class_type: "LoadVideo", inputs: { file: refVideoName } };
      wf["rgvc"] = { class_type: "GetVideoComponents", inputs: { video: ["rlv", 0] } };
      h3["ref_videos.ref_video_0"] = ["rgvc", 0];
      h3["ref_video_audios.ref_video_audio_0"] = ["rgvc", 1];
    }
    if (refAudioName) {
      wf["rla"] = { class_type: "LoadAudio", inputs: { audio: refAudioName } };
      h3["ref_audios.ref_audio_0"] = ["rla", 0];
    }
    wf["h3"] = { class_type: "MiniMaxH3ReferenceToVideo", inputs: h3 };
  } else {
    // fl2va: the two keyframes are optional and independent — first only (i2v), last only
    // (generate INTO a still), or both (first-and-last-frame). Neither = pure t2v.
    if (firstFrameName) { wf["ff"] = { class_type: "LoadImage", inputs: { image: firstFrameName } }; h3.first_frame = ["ff", 0]; }
    if (lastFrameName) { wf["lf"] = { class_type: "LoadImage", inputs: { image: lastFrameName } }; h3.last_frame = ["lf", 0]; }
    wf["h3"] = { class_type: "MiniMaxH3ImageToVideo", inputs: h3 };
  }
  return wf;
}

function buildLtxVideo(args) {
  const comp = args.comp || {};
  if (comp.msr) return buildLtxMsr(args);
  return comp.distillLora && comp.upscaler ? buildLtxCascade(args) : buildLtxSingleStage(args);
}

// LTX-2.3 MSR V2 — reference-image identity transfer via IC-LoRA. LiconMSR packs the
// subject stills (+ a mandatory background still) into a short "pseudo-video" batch;
// LTXAddVideoICLoRAGuide injects that batch into the conditioning and the latent, and
// LTXVCropGuides strips it again after sampling. The transformer is the distilled
// transformer-only file, so the VAE / audio VAE / text encoder all come from a full
// ltx-2.3 checkpoint loaded alongside it.
//
// Two pieces are load-bearing and easy to mistake for optional:
//   • PromptRelayEncode produces the positive conditioning AND patches the model — it
//     is not a text encoder that a CLIPTextEncode can stand in for. Its global prompt
//     anchors the subjects ("Image 1: …"), its local prompts drive the timeline.
//   • LTX2_NAG takes the model from that patch, and BOTH of its conditioning inputs
//     are the guide's NEGATIVE output.
// Substituting either one yields a clip that runs cleanly and looks like mush.
function buildLtxMsr({ prompt, negative, comp, imageNames, backgroundName, seed, v }) {
  const neg = negative && negative.trim() ? negative : LTX_DEFAULT_NEGATIVE;
  // The prompt is split on the first blank line: the opening paragraph describes the
  // reference images (the identity anchor), everything after it is the scene/action.
  // With no blank line the whole prompt is treated as the scene.
  const parts = String(prompt || "").split(/\n\s*\n/);
  const globalPrompt = parts.length > 1 ? parts[0].trim() : "";
  const localPrompts = (parts.length > 1 ? parts.slice(1).join("\n\n") : parts[0] || "").trim();
  const subjects = (imageNames || []).slice(0, LTX_MSR_MAX_SUBJECTS);
  // Model source feeding the MSR IC-LoRA:
  //   • CLEAN  → the checkpoint (node 3) IS the transformer + VAE + audio + encoder.
  //   • MASHUP → a separate transformer-only UNETLoader (node 191); node 3 is only for its VAE.
  // An optional style/content LoRA (Sulphur) sits BETWEEN that source and the MSR IC-LoRA:
  // <source> → [LoraLoaderModelOnly(192)] → LTXICLoRALoaderModelOnly(10). When absent, the MSR
  // loader reads the source directly.
  const rawModel = comp.clean ? ["3", 0] : ["191", 0];
  const msrModelSrc = comp.lora ? ["192", 0] : rawModel;
  const wf = {
    "3":  { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: comp.baseCkpt } },
    "26": { class_type: "LTXAVTextEncoderLoader", inputs: { text_encoder: comp.encoder, ckpt_name: comp.baseCkpt, device: "default" } },
    "10": { class_type: "LTXICLoRALoaderModelOnly", inputs: { model: msrModelSrc, lora_name: comp.msrLora, strength_model: 1.0 } },
    "8":  { class_type: "EmptyLTXVLatentVideo", inputs: { width: v.width, height: v.height, length: v.length, batch_size: 1 } },
    "180":{ class_type: "PromptRelayEncode", inputs: { model: ["10", 0], clip: ["26", 0], latent: ["8", 0], global_prompt: globalPrompt, local_prompts: localPrompts, segment_lengths: "", epsilon: 0.0011 } },
    "185":{ class_type: "CLIPTextEncode", inputs: { clip: ["26", 0], text: neg } },
    "7":  { class_type: "LTXVConditioning", inputs: { positive: ["180", 1], negative: ["185", 0], frame_rate: v.fps } },
    // LiconMSR's canvas follows the OUTPUT size — the workflow links it to the same
    // width/height constants, and its own widget defaults (a portrait 736×1280) are
    // stale leftovers that would build the reference strip in the wrong aspect.
    "190":{ class_type: "LiconMSR", inputs: { width: v.width, height: v.height, frame_count: LTX_MSR_REF_FRAMES } },
    "9":  { class_type: "LTXAddVideoICLoRAGuide", inputs: { positive: ["7", 0], negative: ["7", 1], vae: ["3", 2], latent: ["8", 0], image: ["190", 0], frame_idx: 0, strength: 1.0, latent_downscale_factor: 1.0, crop: "center", use_tiled_encode: false, tile_size: 256, tile_overlap: 64 } },
    "121":{ class_type: "LTX2_NAG", inputs: { model: ["180", 0], nag_scale: 11, nag_alpha: 0.25, nag_tau: 2.5, nag_cond_video: ["9", 1], nag_cond_audio: ["9", 1], inplace: true } },
    "21": { class_type: "LTXVAudioVAELoader", inputs: { ckpt_name: comp.baseCkpt } },
    "22": { class_type: "LTXVEmptyLatentAudio", inputs: { frames_number: v.length, frame_rate: v.fps, batch_size: 1, audio_vae: ["21", 0] } },
    "23": { class_type: "LTXVConcatAVLatent", inputs: { video_latent: ["9", 2], audio_latent: ["22", 0] } },
    "13": { class_type: "KSamplerSelect", inputs: { sampler_name: v.sampler } },
    "27": { class_type: "ManualSigmas", inputs: { sigmas: LTX_SIGMAS_BASE } },
    "15": { class_type: "RandomNoise", inputs: { noise_seed: seed } },
    "37": { class_type: "CFGGuider", inputs: { model: ["121", 0], positive: ["9", 0], negative: ["9", 1], cfg: v.cfg } },
    "16": { class_type: "SamplerCustomAdvanced", inputs: { noise: ["15", 0], guider: ["37", 0], sampler: ["13", 0], sigmas: ["27", 0], latent_image: ["23", 0] } },
    "24": { class_type: "LTXVSeparateAVLatent", inputs: { av_latent: ["16", 0] } },
    "17": { class_type: "LTXVCropGuides", inputs: { positive: ["9", 0], negative: ["9", 1], latent: ["24", 0] } },
    "38": { class_type: "VAEDecode", inputs: { samples: ["17", 2], vae: ["3", 2] } },
    "174":{ class_type: "LTXVAudioVAEDecode", inputs: { samples: ["24", 1], audio_vae: ["21", 0] } },
    "172":{ class_type: "CreateVideo", inputs: { images: ["38", 0], fps: v.fps, audio: ["174", 0] } },
    "173":{ class_type: "SaveVideo", inputs: { video: ["172", 0], filename_prefix: "heykoko_vid", format: "mp4", codec: "h264" } },
  };
  subjects.forEach((nm, i) => {
    const id = String(200 + i);
    wf[id] = { class_type: "LoadImage", inputs: { image: nm } };
    wf["190"].inputs[String(i + 1)] = [id, 0];   // sockets are literally named "1".."4"
  });
  wf["210"] = { class_type: "LoadImage", inputs: { image: backgroundName } };
  wf["190"].inputs.background = ["210", 0];
  // MASHUP only: the separate transformer-only UNET. CLEAN reads the model straight off node 3.
  if (!comp.clean) wf["191"] = { class_type: "UNETLoader", inputs: { unet_name: comp.transformer, weight_dtype: "default" } };
  if (comp.lora) {
    wf["192"] = { class_type: "LoraLoaderModelOnly", inputs: { model: rawModel, lora_name: comp.lora, strength_model: comp.loraStrength != null ? comp.loraStrength : 1 } };
  }
  return wf;
}

// LTX-2.3 IC-LoRA Union Control — depth-guided structure/motion transfer. Flattened from
// the official `video_ltx2_3_ic_lora` template (two subgraphs → one graph), verified
// end-to-end on the live box. Flow:
//   • MoGe turns the driving video (sliced to `durationSec`) into a depth sequence; that
//     sequence's frame count sets the clip length (GetImageSize → Empty{Video,Audio}Latent).
//   • The reference still becomes the first frame (LTXVImgToVideoInplace).
//   • The union-control IC-LoRA is applied with a PLAIN LoraLoaderModelOnly; its parameters
//     (read by GetICLoRAParameters) feed LTXVAddGuide's optional `iclora_parameters` input —
//     WITHOUT that link the depth frames would be an ordinary guide, not union control.
//   • KSampler runs the distilled 8-step / cfg-1 / linear_quadratic schedule.
// The FULL distilled checkpoint supplies MODEL / VAE (slot 2) / audio VAE / text projection.
function buildLtxUnionControl({ prompt, negative, comp, imageName, videoName, durationSec, v, seed }) {
  const neg = negative && negative.trim() ? negative : LTX_DEFAULT_NEGATIVE;
  const CK = comp.ckpt;
  return {
    "ck":     { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: CK } },
    "te":     { class_type: "LTXAVTextEncoderLoader", inputs: { text_encoder: comp.encoder, ckpt_name: CK, device: "default" } },
    "avae":   { class_type: "LTXVAudioVAELoader", inputs: { ckpt_name: CK } },
    "iclora": { class_type: "LoraLoaderModelOnly", inputs: { model: ["ck", 0], lora_name: comp.unionLora, strength_model: 1.0 } },
    "icparams": { class_type: "GetICLoRAParameters", inputs: { iclora_model: ["iclora", 0] } },
    "lv":     { class_type: "LoadVideo", inputs: { file: videoName } },
    // start_time / duration are SECONDS; strict_duration false → returns fewer frames if the
    // source is shorter than the window (never errors).
    "vslice": { class_type: "Video Slice", inputs: { video: ["lv", 0], start_time: 0.0, duration: durationSec, strict_duration: false } },
    "gvc":    { class_type: "GetVideoComponents", inputs: { video: ["vslice", 0] } },
    "mogeload": { class_type: "LoadMoGeModel", inputs: { model_name: comp.mogeModel } },
    "mogeinf": { class_type: "MoGeInference", inputs: { moge_model: ["mogeload", 0], image: ["gvc", 0], resolution_level: 9, fov_x_degrees: 0.0, batch_size: 4, force_projection: true, apply_mask: true } },
    "depth":  { class_type: "MoGeRender", inputs: { moge_geometry: ["mogeinf", 0], output: "depth" } },
    "gis":    { class_type: "GetImageSize", inputs: { image: ["depth", 0] } },
    "pos":    { class_type: "CLIPTextEncode", inputs: { clip: ["te", 0], text: prompt || "" } },
    "neg":    { class_type: "CLIPTextEncode", inputs: { clip: ["te", 0], text: neg } },
    "emptyvid": { class_type: "EmptyLTXVLatentVideo", inputs: { width: v.width, height: v.height, length: ["gis", 2], batch_size: 1 } },
    "emptyaud": { class_type: "LTXVEmptyLatentAudio", inputs: { frames_number: ["gis", 2], frame_rate: v.fps, batch_size: 1, audio_vae: ["avae", 0] } },
    "li":     { class_type: "LoadImage", inputs: { image: imageName } },
    "inplace": { class_type: "LTXVImgToVideoInplace", inputs: { vae: ["ck", 2], image: ["li", 0], latent: ["emptyvid", 0], strength: 1.0, bypass: false } },
    "cond":   { class_type: "LTXVConditioning", inputs: { positive: ["pos", 0], negative: ["neg", 0], frame_rate: v.fps } },
    "addguide": { class_type: "LTXVAddGuide", inputs: { positive: ["cond", 0], negative: ["cond", 1], vae: ["ck", 2], latent: ["inplace", 0], image: ["depth", 0], frame_idx: 0, strength: 1.0, iclora_parameters: ["icparams", 0] } },
    "concat": { class_type: "LTXVConcatAVLatent", inputs: { video_latent: ["addguide", 2], audio_latent: ["emptyaud", 0] } },
    "ks":     { class_type: "KSampler", inputs: { model: ["iclora", 0], positive: ["addguide", 0], negative: ["addguide", 1], latent_image: ["concat", 0], seed, steps: v.steps, cfg: v.cfg, sampler_name: v.sampler, scheduler: v.scheduler, denoise: 1.0 } },
    "sep":    { class_type: "LTXVSeparateAVLatent", inputs: { av_latent: ["ks", 0] } },
    "crop":   { class_type: "LTXVCropGuides", inputs: { positive: ["addguide", 0], negative: ["addguide", 1], latent: ["sep", 0] } },
    "vdec":   { class_type: "VAEDecodeTiled", inputs: { samples: ["crop", 2], vae: ["ck", 2], tile_size: 768, overlap: 64, temporal_size: 4096, temporal_overlap: 64 } },
    "adec":   { class_type: "LTXVAudioVAEDecode", inputs: { samples: ["sep", 1], audio_vae: ["avae", 0] } },
    "cv":     { class_type: "CreateVideo", inputs: { images: ["vdec", 0], audio: ["adec", 0], fps: v.fps } },
    "save":   { class_type: "SaveVideo", inputs: { video: ["cv", 0], filename_prefix: "heykoko_vid", format: "mp4", codec: "h264" } },
  };
}

// The hand-tuned sigma schedules from the official LTX-2.3 templates. These are NOT
// derivable from a step count — they belong to the distilled LoRA, which is why the
// cascade only runs when that LoRA is present. Stage 1 is 8 steps (9 sigmas) from
// pure noise; stage 2 is a 3-step (4 sigmas) refine starting at 0.85 on the upscaled
// latent.
const LTX_SIGMAS_BASE = "1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0";
const LTX_SIGMAS_REFINE = "0.85, 0.7250, 0.4219, 0.0";

// Per-finetune cascade recipes. The GRAPH is identical for both — half-size base pass,
// latent ×2 upscale, short refine — only the schedule/sampler/LoRA-strength numbers
// differ, so they live here as data instead of forking the builder.
//
// "sulphur" is derived from the user's own ltx23_t2v_distilled workflow, read off the
// live ComfyUI and reduced to the nodes actually REACHABLE from its SaveVideo (that
// file also carries three abandoned ManualSigmas presets and a spare distilled-LoRA
// loader left unconnected on the canvas — dumping widgets without walking the links
// picks up those dead values). The load-bearing difference: Sulphur's base pass does
// NOT use a hand-written sigma list at all. It runs LTXVScheduler with max_shift 4 /
// base_shift 1.5 — far above LTX's 2.05 / 0.95 defaults — which is exactly why
// borrowing ltx-2.3's fixed table blurred: the shift was wrong for this finetune.
// `i2v` holds the parameters that only apply when a still is conditioning the clip:
// the two LTXVImgToVideoInplace strengths, the LTXVPreprocess compression, and — for
// Sulphur — a stage-2 sampler that DIFFERS from its own t2v workflow (lcm for t2v,
// euler_ancestral_cfg_pp for i2v; the two workflows really do disagree here).
const LTX_RECIPES = {
  base: {
    stage1: { sigmas: { manual: LTX_SIGMAS_BASE }, sampler: "euler", distill: 0.5 },
    stage2: { sigmas: { manual: LTX_SIGMAS_REFINE }, sampler: "euler", distill: 0.5 },
    i2v: { stage1Strength: 0.7, stage2Strength: 1.0, imgCompression: 18 },
    tiledDecode: true,
  },
  sulphur: {
    stage1: { sigmas: { scheduler: { steps: 8, max_shift: 4, base_shift: 1.5, stretch: true, terminal: 0.1 } }, sampler: "euler_ancestral_cfg_pp", distill: 0.7 },
    stage2: { sigmas: { manual: LTX_SIGMAS_REFINE }, sampler: "lcm", distill: 0.5 },
    i2v: { stage1Strength: 0.8, stage2Strength: 1.0, imgCompression: 38, stage2Sampler: "euler_ancestral_cfg_pp" },
    tiledDecode: false,
  },
};
// The refine pass takes FIXED noise in the official template, so re-rolling the seed
// varies the composition (stage 1) without also reshuffling the upscale detail.
const LTX_REFINE_NOISE = 42;

// Two-stage cascade: sample at HALF the target size → LTXVLatentUpsampler doubles the
// video latent (spatial upscaler model) → a short refine at the full size → decode.
// The audio latent rides along: stage 1 starts it empty, stage 2 continues the SAMPLED
// audio latent from stage 1, so the soundtrack is refined with the picture rather than
// regenerated. Guides are stripped once, by the LTXVCropGuides between the stages,
// whose cleaned conditioning also drives the refine pass.
//
// The per-stage numbers come from comp.recipe (LTX_RECIPES). The two stages get their
// OWN model chains because they run the distilled LoRA at different strengths — that
// is the only reason the source workflows build the LoRA stack twice.
function buildLtxCascade({ model, prompt, negative, comp, imageName, imageNames, seed, v }) {
  const neg = negative && negative.trim() ? negative : LTX_DEFAULT_NEGATIVE;
  const kf = Array.isArray(imageNames) && imageNames.length >= 2 ? imageNames : null;
  const i2v = !kf && !!imageName;
  const recipe = LTX_RECIPES[comp.recipe] || LTX_RECIPES.base;
  // Stage-1 canvas: half the final size, snapped back to /32 (the latent step). The
  // upscaler then doubles it, so the delivered frame is exactly 2× this — which is
  // why the preset's dims are /64.
  const half = (n) => Math.max(32, Math.round(n / 2 / 32) * 32);
  const w1 = half(v.width), h1 = half(v.height);
  const wf = {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: model } },
    "2": { class_type: "LTXAVTextEncoderLoader", inputs: { text_encoder: comp.encoder, ckpt_name: model, device: "default" } },
    "3": { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: prompt } },
    "4": { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: neg } },
    "5": { class_type: "LTXVConditioning", inputs: { positive: ["3", 0], negative: ["4", 0], frame_rate: v.fps } },
    "20": { class_type: "LTXVAudioVAELoader", inputs: { ckpt_name: model } },
    "21": { class_type: "LTXVEmptyLatentAudio", inputs: { frames_number: v.length, frame_rate: v.fps, batch_size: 1, audio_vae: ["20", 0] } },
    "7": { class_type: "EmptyLTXVLatentVideo", inputs: { width: w1, height: h1, length: v.length, batch_size: 1 } },
    "82": { class_type: "LatentUpscaleModelLoader", inputs: { model_name: comp.upscaler } },
    "9": { class_type: "KSamplerSelect", inputs: { sampler_name: recipe.stage1.sampler } },
    "94": { class_type: "KSamplerSelect", inputs: { sampler_name: (i2v && recipe.i2v.stage2Sampler) || recipe.stage2.sampler } },
    "84": { class_type: "RandomNoise", inputs: { noise_seed: seed } },
    "90": { class_type: "RandomNoise", inputs: { noise_seed: LTX_REFINE_NOISE } },
  };
  // One LoRA stack per stage: the distilled LoRA at that stage's strength, then any
  // user-chosen ⚙ LoRA (the Sulphur style layer arrives this way on an unmerged base)
  // on top. `mk` returns the chain's output ref.
  const mkChain = (distillStrength, idDistill, idUser) => {
    wf[idDistill] = { class_type: "LoraLoaderModelOnly", inputs: { model: ["1", 0], lora_name: comp.distillLora, strength_model: distillStrength } };
    let ref = [idDistill, 0];
    if (comp.lora) {
      wf[idUser] = { class_type: "LoraLoaderModelOnly", inputs: { model: ref, lora_name: comp.lora, strength_model: comp.loraStrength != null ? comp.loraStrength : 1 } };
      ref = [idUser, 0];
    }
    return ref;
  };
  const model1 = mkChain(recipe.stage1.distill, "81", "80");
  const model2 = mkChain(recipe.stage2.distill, "96", "97");
  // Stage sigmas: either a fixed hand-written list, or LTXVScheduler computing them
  // live from a step count + shift pair. Sulphur needs the latter (its shift is well
  // above LTX's defaults); ltx-2.3 needs the former.
  const mkSigmas = (spec, id, latentRef) => {
    wf[id] = spec.manual
      ? { class_type: "ManualSigmas", inputs: { sigmas: spec.manual } }
      : { class_type: "LTXVScheduler", inputs: { ...spec.scheduler, latent: latentRef } };
    return [id, 0];
  };
  // Stage-1 video latent + conditioning. Guide images are prepared once (node 15)
  // and reused by both stages.
  let pos = ["5", 0], negCond = ["5", 1], lat1 = ["7", 0];
  if (kf) {
    const N = kf.length;
    kf.forEach((nm, idx) => {
      const load = String(30 + idx), prep = String(50 + idx), guide = String(70 + idx);
      const frameIdx = N === 1 ? 0 : Math.round((idx * (v.length - 1)) / (N - 1)); // 0 … length-1, evenly spaced
      wf[load] = { class_type: "LoadImage", inputs: { image: nm } };
      wf[prep] = { class_type: "LTXVPreprocess", inputs: { image: [load, 0], img_compression: recipe.i2v.imgCompression } };
      wf[guide] = { class_type: "LTXVAddGuide", inputs: { positive: pos, negative: negCond, vae: ["1", 2], latent: lat1, image: [prep, 0], frame_idx: frameIdx, strength: 1.0 } };
      pos = [guide, 0]; negCond = [guide, 1]; lat1 = [guide, 2];
    });
  } else if (i2v) {
    wf["14"] = { class_type: "LoadImage", inputs: { image: imageName } };
    wf["15"] = { class_type: "LTXVPreprocess", inputs: { image: ["14", 0], img_compression: recipe.i2v.imgCompression } };
    // Inplace writes the still into the existing latent instead of returning a longer
    // one, so no guide frames are added and the conditioning stays untouched. Stage 1
    // holds it below 1 (leaving the sampler room to build motion), stage 2 pins it.
    wf["16"] = { class_type: "LTXVImgToVideoInplace", inputs: { vae: ["1", 2], image: ["15", 0], latent: ["7", 0], strength: recipe.i2v.stage1Strength, bypass: false } };
    lat1 = ["16", 0];
  }
  wf["22"] = { class_type: "LTXVConcatAVLatent", inputs: { video_latent: lat1, audio_latent: ["21", 0] } };
  const sigmas1 = mkSigmas(recipe.stage1.sigmas, "85", ["22", 0]);
  wf["83"] = { class_type: "CFGGuider", inputs: { model: model1, positive: pos, negative: negCond, cfg: v.cfg } };
  wf["10"] = { class_type: "SamplerCustomAdvanced", inputs: { noise: ["84", 0], guider: ["83", 0], sampler: ["9", 0], sigmas: sigmas1, latent_image: ["22", 0] } };
  wf["23"] = { class_type: "LTXVSeparateAVLatent", inputs: { av_latent: ["10", 0] } };
  // Strip the guide frames (keyframe mode) and hand the cleaned conditioning to the
  // refine pass. A no-op for t2v/i2v, where nothing added guides — the official
  // template runs it unconditionally too.
  wf["25"] = { class_type: "LTXVCropGuides", inputs: { positive: pos, negative: negCond, latent: ["23", 0] } };
  wf["86"] = { class_type: "LTXVLatentUpsampler", inputs: { samples: ["25", 2], upscale_model: ["82", 0], vae: ["1", 2] } };
  let lat2 = ["86", 0];
  if (i2v) {
    wf["87"] = { class_type: "LTXVImgToVideoInplace", inputs: { vae: ["1", 2], image: ["15", 0], latent: ["86", 0], strength: recipe.i2v.stage2Strength, bypass: false } };
    lat2 = ["87", 0];
  }
  wf["88"] = { class_type: "LTXVConcatAVLatent", inputs: { video_latent: lat2, audio_latent: ["23", 1] } };
  const sigmas2 = mkSigmas(recipe.stage2.sigmas, "91", ["88", 0]);
  wf["89"] = { class_type: "CFGGuider", inputs: { model: model2, positive: ["25", 0], negative: ["25", 1], cfg: v.cfg } };
  wf["92"] = { class_type: "SamplerCustomAdvanced", inputs: { noise: ["90", 0], guider: ["89", 0], sampler: ["94", 0], sigmas: sigmas2, latent_image: ["88", 0] } };
  wf["93"] = { class_type: "LTXVSeparateAVLatent", inputs: { av_latent: ["92", 0] } };
  // The ltx-2.3 template decodes the full-size refined latent tiled (a plain VAEDecode
  // of a 22B AV latent is where this pipeline runs out of VRAM); the Sulphur workflow
  // decodes it whole, so each recipe keeps its own choice.
  wf["11"] = recipe.tiledDecode
    ? { class_type: "VAEDecodeTiled", inputs: { samples: ["93", 0], vae: ["1", 2], tile_size: 768, overlap: 64, temporal_size: 4096, temporal_overlap: 4 } }
    : { class_type: "VAEDecode", inputs: { samples: ["93", 0], vae: ["1", 2] } };
  wf["24"] = { class_type: "LTXVAudioVAEDecode", inputs: { samples: ["93", 1], audio_vae: ["20", 0] } };
  wf["12"] = { class_type: "CreateVideo", inputs: { images: ["11", 0], fps: v.fps, audio: ["24", 0] } };
  wf["13"] = { class_type: "SaveVideo", inputs: { video: ["12", 0], filename_prefix: "heykoko_vid", format: "mp4", codec: "h264" } };
  return wf;
}

// Single-stage fallback (no distilled LoRA / no spatial upscaler installed): one
// SamplerCustom over an LTXVScheduler ramp at the full size. t2v uses
// EmptyLTXVLatentVideo; i2v uses LTXVImgToVideo (which also yields conditioning);
// keyframes chain LTXVAddGuide and let LTXVCropGuides trim the guide frames after
// sampling. Only the video-latent source + conditioning + decode-latent differ
// between modes; the audio path and sampler are shared.
function buildLtxSingleStage({ model, prompt, negative, comp, imageName, imageNames, seed, v }) {
  const neg = negative && negative.trim() ? negative : LTX_DEFAULT_NEGATIVE;
  const kf = Array.isArray(imageNames) && imageNames.length >= 2 ? imageNames : null;
  const i2v = !kf && !!imageName;
  const wf = {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: model } },
    "2": { class_type: "LTXAVTextEncoderLoader", inputs: { text_encoder: comp.encoder, ckpt_name: model, device: "default" } },
    "3": { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: prompt } },
    "4": { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: neg } },
    "20": { class_type: "LTXVAudioVAELoader", inputs: { ckpt_name: model } },
    "21": { class_type: "LTXVEmptyLatentAudio", inputs: { frames_number: v.length, frame_rate: v.fps, batch_size: 1, audio_vae: ["20", 0] } },
    "9": { class_type: "KSamplerSelect", inputs: { sampler_name: v.sampler } },
  };
  let videoLatentRef, posRef, negRef, decodeLatentRef;
  if (kf) {
    wf["7"] = { class_type: "EmptyLTXVLatentVideo", inputs: { width: v.width, height: v.height, length: v.length, batch_size: 1 } };
    wf["5"] = { class_type: "LTXVConditioning", inputs: { positive: ["3", 0], negative: ["4", 0], frame_rate: v.fps } };
    let p = ["5", 0], n = ["5", 1], l = ["7", 0];
    const N = kf.length;
    kf.forEach((nm, idx) => {
      const load = String(30 + idx), prep = String(50 + idx), guide = String(70 + idx);
      const frameIdx = N === 1 ? 0 : Math.round((idx * (v.length - 1)) / (N - 1)); // 0 … length-1, evenly spaced
      wf[load] = { class_type: "LoadImage", inputs: { image: nm } };
      wf[prep] = { class_type: "LTXVPreprocess", inputs: { image: [load, 0], img_compression: 35 } };
      wf[guide] = { class_type: "LTXVAddGuide", inputs: { positive: p, negative: n, vae: ["1", 2], latent: l, image: [prep, 0], frame_idx: frameIdx, strength: 1.0 } };
      p = [guide, 0]; n = [guide, 1]; l = [guide, 2];
    });
    wf["25"] = { class_type: "LTXVCropGuides", inputs: { positive: p, negative: n, latent: ["23", 0] } };
    videoLatentRef = l; posRef = p; negRef = n; decodeLatentRef = ["25", 2];
  } else if (i2v) {
    wf["14"] = { class_type: "LoadImage", inputs: { image: imageName } };
    wf["7"] = { class_type: "LTXVImgToVideo", inputs: { positive: ["3", 0], negative: ["4", 0], vae: ["1", 2], image: ["14", 0], width: v.width, height: v.height, length: v.length, batch_size: 1, strength: 1.0 } };
    wf["5"] = { class_type: "LTXVConditioning", inputs: { positive: ["7", 0], negative: ["7", 1], frame_rate: v.fps } };
    videoLatentRef = ["7", 2]; posRef = ["5", 0]; negRef = ["5", 1]; decodeLatentRef = ["23", 0];
  } else {
    wf["7"] = { class_type: "EmptyLTXVLatentVideo", inputs: { width: v.width, height: v.height, length: v.length, batch_size: 1 } };
    wf["5"] = { class_type: "LTXVConditioning", inputs: { positive: ["3", 0], negative: ["4", 0], frame_rate: v.fps } };
    videoLatentRef = ["7", 0]; posRef = ["5", 0]; negRef = ["5", 1]; decodeLatentRef = ["23", 0];
  }
  wf["22"] = { class_type: "LTXVConcatAVLatent", inputs: { video_latent: videoLatentRef, audio_latent: ["21", 0] } };
  // Optional LTX-family LoRA, patched onto the checkpoint's model before sampling.
  // Model-ONLY: LTX loads its text encoder separately (LTXAVTextEncoderLoader), so
  // there is no CLIP output on node 1 to patch. Node id 80 is clear of the keyframe
  // branch, which allocates 30+i / 50+i / 70+i for up to 8 guides.
  let modelRef = ["1", 0];
  if (comp.lora) {
    wf["80"] = { class_type: "LoraLoaderModelOnly", inputs: { model: ["1", 0], lora_name: comp.lora, strength_model: comp.loraStrength != null ? comp.loraStrength : 1 } };
    modelRef = ["80", 0];
  }
  wf["6"] = { class_type: "ModelSamplingLTXV", inputs: { model: modelRef, max_shift: 2.05, base_shift: 0.95, latent: ["22", 0] } };
  wf["8"] = { class_type: "LTXVScheduler", inputs: { steps: v.steps, max_shift: 2.05, base_shift: 0.95, stretch: true, terminal: 0.1, latent: ["22", 0] } };
  wf["10"] = { class_type: "SamplerCustom", inputs: { model: ["6", 0], add_noise: true, noise_seed: seed, cfg: v.cfg, positive: posRef, negative: negRef, sampler: ["9", 0], sigmas: ["8", 0], latent_image: ["22", 0] } };
  wf["23"] = { class_type: "LTXVSeparateAVLatent", inputs: { av_latent: ["10", 0] } };
  wf["11"] = { class_type: "VAEDecode", inputs: { samples: decodeLatentRef, vae: ["1", 2] } };
  wf["24"] = { class_type: "LTXVAudioVAEDecode", inputs: { samples: ["23", 1], audio_vae: ["20", 0] } };
  wf["12"] = { class_type: "CreateVideo", inputs: { images: ["11", 0], fps: v.fps, audio: ["24", 0] } };
  wf["13"] = { class_type: "SaveVideo", inputs: { video: ["12", 0], filename_prefix: "heykoko_vid", format: "mp4", codec: "h264" } };
  return wf;
}

function buildVideoWorkflow(videoType, args) {
  if (videoType === "wan") return buildWanVideo(args);
  if (videoType === "hunyuan") return buildHunyuanVideo(args);
  if (videoType === "ltx") return buildLtxVideo(args);
  return null;
}

// Phantom README caps reliable subject references at 4; the node itself takes more but
// quality falls off, and each adds a full vae.encode + a frame to the time axis.
const PHANTOM_MAX_REFS = 4;

// Phantom-Wan companions: umt5 (CLIPLoader type "wan") + the WAN 2.1 VAE. Phantom is
// a single Wan-2.1-based UNET (no high/low MoE, no distill LoRA), so this is all it
// needs beyond the UNET itself.
async function phantomCompanions(model, turbo) {
  const [clips, vaes] = await Promise.all([
    comfyEnum("CLIPLoader", "clip_name"),
    comfyEnum("VAELoader", "vae_name"),
  ]);
  const find = (list, re) => list.find((x) => re.test(x));
  const clip = find(clips, /umt5/i);
  const vae = find(vaes, /wan.?2[._]1.*vae/i) || find(vaes, /wan.*vae/i);
  const missing = [];
  if (!clip) missing.push("umt5_xxl_fp8_e4m3fn_scaled.safetensors → text_encoders/");
  if (!vae) missing.push("wan_2.1_vae.safetensors → vae/");
  if (missing.length) throw new Error("Missing files required by Phantom:\n- " + missing.join("\n- "));
  // ⚙ turbo: a Wan2.1-14B cfg-step-distill LoRA. Phantom-Wan-14B is a Wan2.1 14B
  // finetune (it loads the same umt5 + wan_2.1_vae companions), so the generic
  // lightx2v LoRAs apply — there is no Phantom-specific one, and upstream ships none.
  // Prefer the T2V build: Phantom's base is Wan2.1 T2V, and it takes no start frame.
  //
  // 14B ONLY. The 1.3B variant is a different width — the rank-64 14B LoRA does not
  // fit it, and only 14B LoRAs are published. Asking for turbo on 1.3B is ignored
  // rather than errored (the model still runs; the done-line reports what happened).
  let lora = null;
  if (turbo && /14b/i.test(model || "")) {
    const loras = await comfyEnum("LoraLoaderModelOnly", "lora_name");
    lora = find(loras, /lightx2v.*t2v.*14b.*cfg_step_distill/i)
        || find(loras, /lightx2v.*t2v.*14b.*distill/i)
        || find(loras, /lightx2v.*i2v.*14b.*distill/i);
  }
  return { clip, vae, lora };
}

// Phantom (WanPhantomSubjectToVideo) — subject-to-video: reference subject image(s) +
// a prompt → a video that keeps those subjects' identity, with NO driving video.
//
// The node emits THREE conditionings whose slot NAMES are counter-intuitive (verified
// against comfy_extras/nodes_wan.py):
//   slot 0 "positive"          = pos text + REAL reference-image latent
//   slot 1 "negative_text"     = neg text + REAL reference-image latent   ← has the image
//   slot 2 "negative_img_text" = neg text + ZEROED latent                 ← image removed
// Phantom's upstream CFG (phantom_wan/subject2video.py) is a triple-forward blend with
// two independent scales:
//   pred = neg + g_img·(pos_i − neg) + g_text·(pos_it − pos_i)
// where pos_it=slot0, pos_i=slot1, neg=slot2. That is EXACTLY DualCFGGuider "regular"
// (pred = negative + cfg_conds·(cond1 − cond2) + cfg_cond2_negative·(cond2 − negative))
// under cond1=slot0, cond2=slot1, negative=slot2, cfg_conds=g_text, cfg_cond2_negative=
// g_img. So no custom node is needed — the same guider hey-koko already uses for ip2p
// consumes Phantom's three outputs verbatim. Upstream s2v defaults: g_text 7.5, g_img
// 5.0, 50 steps, uni_pc, shift 5.0, ≤4 reference images.
function buildPhantom({ model, prompt, negative, comp, imageNames, seed, v, imgCfg }) {
  const neg = negative && negative.trim() ? negative : WAN_DEFAULT_NEGATIVE;
  const refs = (imageNames || []).filter(Boolean).slice(0, PHANTOM_MAX_REFS);
  const wf = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: model, weight_dtype: "default" } },
    // ⚙ turbo (node 60 — clear of the 20+ LoadImage block and the 40+ ImageBatch
    // chain the reference images use): a Wan2.1-14B step-distill LoRA. It is cfg-DISTILLED, so the
    // caller also drops both DualCFGGuider scales to 1 — at which point the guider's
    // formula reduces to the plain conditional prediction and Phantom's two-scale
    // subject guidance is gone entirely, not merely weakened. That trade is the whole
    // point of the switch, and the done-line states it.
    "2": { class_type: "ModelSamplingSD3", inputs: { model: comp.lora ? ["60", 0] : ["1", 0], shift: v.shift } },
    "3": { class_type: "CLIPLoader", inputs: { clip_name: comp.clip, type: "wan" } },
    "4": { class_type: "VAELoader", inputs: { vae_name: comp.vae } },
    "5": { class_type: "CLIPTextEncode", inputs: { clip: ["3", 0], text: prompt } },
    "6": { class_type: "CLIPTextEncode", inputs: { clip: ["3", 0], text: neg } },
    // 7 = WanPhantomSubjectToVideo (images wired below); 8 = DualCFGGuider.
    "7": { class_type: "WanPhantomSubjectToVideo", inputs: { positive: ["5", 0], negative: ["6", 0], vae: ["4", 0], width: v.width, height: v.height, length: v.length, batch_size: 1 } },
    "8": { class_type: "DualCFGGuider", inputs: { model: ["2", 0], cond1: ["7", 0], cond2: ["7", 1], negative: ["7", 2], cfg_conds: v.cfg, cfg_cond2_negative: imgCfg, style: "regular" } },
    "9": { class_type: "RandomNoise", inputs: { noise_seed: seed } },
    "10": { class_type: "KSamplerSelect", inputs: { sampler_name: v.sampler } },
    "11": { class_type: "BasicScheduler", inputs: { model: ["2", 0], scheduler: v.scheduler, steps: v.steps, denoise: 1 } },
    "12": { class_type: "SamplerCustomAdvanced", inputs: { noise: ["9", 0], guider: ["8", 0], sampler: ["10", 0], sigmas: ["11", 0], latent_image: ["7", 3] } },
    ...(comp.lora ? { "60": { class_type: "LoraLoaderModelOnly", inputs: { model: ["1", 0], lora_name: comp.lora, strength_model: 1.0 } } } : {}),
    "13": { class_type: "VAEDecode", inputs: { samples: ["12", 0], vae: ["4", 0] } },
    "14": { class_type: "CreateVideo", inputs: { images: ["13", 0], fps: v.fps } },
    "15": { class_type: "SaveVideo", inputs: { video: ["14", 0], filename_prefix: "heykoko_phantom", format: "mp4", codec: "h264" } },
  };
  // Reference subjects → a single IMAGE batch. The node resizes the whole batch to
  // width×height itself, then vae.encodes each frame; ImageBatch takes two at a time,
  // so N images fold left: batch(batch(i0,i1),i2)…. One image needs no batch node.
  if (refs.length) {
    const loadIds = refs.map((name, i) => {
      const id = String(20 + i);
      wf[id] = { class_type: "LoadImage", inputs: { image: name } };
      return [id, 0];
    });
    let acc = loadIds[0];
    for (let i = 1; i < loadIds.length; i++) {
      const bid = String(40 + i); // 40+ keeps clear of the 20+ LoadImage block
      wf[bid] = { class_type: "ImageBatch", inputs: { image1: acc, image2: loadIds[i] } };
      acc = [bid, 0];
    }
    wf["7"].inputs.images = acc;
  }
  return wf;
}

// Bernini-R companions: umt5 (CLIPLoader type "wan") + the WAN 2.1 VAE + the
// optional LightX2V T2V-14B distill LoRA (present → turbo: cfg 1 / 6 steps).
async function berniniCompanions() {
  const [clips, vaes, loras] = await Promise.all([
    comfyEnum("CLIPLoader", "clip_name"),
    comfyEnum("VAELoader", "vae_name"),
    comfyEnum("LoraLoaderModelOnly", "lora_name"),
  ]);
  const find = (list, re) => list.find((x) => re.test(x));
  const clip = find(clips, /umt5/i);
  const vae = find(vaes, /wan.?2[._]1.*vae/i) || find(vaes, /wan.*vae/i); // Bernini uses the WAN 2.1 VAE
  // Turbo distill LoRA (optional). The official template pins the T2V one
  // (lightx2v_T2V_14B_cfg_step_distill_v2_lora_rank64_bf16). The previous pattern had a
  // loose `cfg_step_distill` alternative that ALSO matched Wan Animate's
  // lightx2v_I2V_14B_480p_cfg_step_distill file — and since that name sorts first, every
  // turbo run silently mounted the I2V LoRA at strength 3.0 on a T2V model. Never accept
  // an i2v file here: with no T2V distill LoRA on disk, turbo simply stays off and the
  // 40-step official schedule runs instead, which is the honest fallback.
  const lora = find(loras, /lightx2v.*t2v.*14b.*cfg_step_distill/i) || find(loras, /lightx2v.*t2v.*distill/i);
  // Bernini-R LightX2V speed LoRAs — a dedicated HIGH/LOW pair (Bernini-R_LightX2V_
  // high_noise / low_noise), distinct from the single T2V distill LoRA above. When
  // both are present the ⚙ "LightX2V 4-step" option can run the author's 4-step /
  // KSamplerAdvanced / shift-8 recipe (strength 1.0 each).
  const loraLxHigh = find(loras, /bernini.*lightx2v.*high/i);
  const loraLxLow = find(loras, /bernini.*lightx2v.*low/i);
  const missing = [];
  if (!clip) missing.push("umt5_xxl_fp8_e4m3fn_scaled.safetensors → text_encoders/");
  if (!vae) missing.push("wan_2.1_vae.safetensors → vae/");
  if (missing.length) throw new Error("Missing files required by Bernini:\n- " + missing.join("\n- "));
  return { clip, vae, lora, loraLxHigh, loraLxLow };
}

// Bernini's task system prompts (prepended to the user's instruction — the model
// was trained with these). v2v = plain video edit; rv2v = edit with a reference.
// reference_images is a COMFY_AUTOGROW_V3 slot list whose template declares max 8
// (reference_image_0 … _7). The node reads the slots in sorted() NAME order — safe
// only while the index stays a single digit, which this cap also guarantees.
const BERNINI_MAX_REFS = 8;

// Exact lines from the official template's task table (the "Select Per-Line Text by
// Index" node in video_bernini_r_video_editing) — the model was trained with these,
// so they are quoted verbatim rather than paraphrased.
const BERNINI_SYS_V2V = "You are a helpful assistant specialized in video editing.";
const BERNINI_SYS_RV2V = "You are a helpful assistant specialized in video editing with reference.";
// Table line [5]. The task table has no "reference-to-video" line, and r2v (references
// only, no source clip) has to pick one — this is the only refs→video entry.
const BERNINI_SYS_I2V = "You are a helpful assistant specialized in image-to-video generation.";
const BERNINI_SYS_ADS2V = "You are a helpful assistant specialized in ads insertion.";
// Image-side task lines, taken VERBATIM from the official image-editing template's
// per-line prompt table (indices [1] / [3] / [4]) — never hand-written: an invented
// line is silently accepted and just degrades the result (the ads2v lesson).
// The remaining task lines, also verbatim from the table. [6]/[7]/[10]/[11] all share
// v2v's wiring (source_video only) — they differ ONLY by this line, which is why they
// are a ⚙ task selector on the one bernini entry rather than four dropdown models.
const BERNINI_SYS_GENERIC = "You are a helpful assistant.";                                  // [0]
const BERNINI_SYS_T2V = "You are a helpful assistant specialized in text-to-video generation."; // [2]
const BERNINI_SYS_PROPAGATE = "You are a helpful assistant specialized in video editing on content propagation."; // [7]
const BERNINI_SYS_ACTION = "You are a helpful assistant for editing. You may need to adjust the subject's action or position."; // [10]
const BERNINI_SYS_RESTYLE = "You are a helpful assistant for editing. You might need to adjust the video's style, lighting, colors, textures, and the subject's pose or action."; // [11]
const BERNINI_SYS_T2I = "You are a helpful assistant specialized in text-to-image generation.";
const BERNINI_SYS_I2I = "You are a helpful assistant specialized in image editing.";
const BERNINI_SYS_R2I = "You are a helpful assistant specialized in subject-to-image generation.";

// Bernini-R (WAN 2.2 MoE). The node picks its task from WHICH INPUTS ARE CONNECTED,
// so each mode here is just a different wiring of the same graph:
//   • v2v   — source video + instruction → edited video.
//   • rv2v  — source video + reference image(s) + instruction.
//   • i2v   — reference image only (NO source video) → generated video (the node's own
//             docs call this r2v and list no "i2v"). VERIFIED working end-to-end with the
//             BERNINI_SYS_I2V prompt; behaves as reference-driven i2v.
//   • ads2v — source video + insert image (reference_video) → the image composited in.
// Two-expert CUSTOM sampling: BasicScheduler → SplitSigmas at `split`, then two
// SamplerCustom (high adds noise, low continues), each on its sigma slice. turbo
// (distill LoRA mounted) = cfg 1 / 6 steps / split 3 (high str 3, low 1.5);
// non-turbo = cfg 5 / 40 steps / split 20. v2v/rv2v keep the SOURCE video's fps +
// audio (CreateVideo reads them from GetVideoComponents); i2v uses an explicit fps.
function buildBernini({ model, prompt, negative, comp, videoName, refImageName, refImageNames, insertImageName, sourceImageName, imageMode, imageTask, videoTask, width, height, length, seed, turbo, lightx2v, fps, refMaxSize, experts }) {
  // See buildWan14B: `experts` carries the ⚙-precision-resolved twins when set.
  const highModel = (experts && experts.high) || model.replace(/low_noise/i, "high_noise");
  const lowModel = (experts && experts.low) || model.replace(/high_noise/i, "low_noise");
  const neg = negative && negative.trim() ? negative : WAN_DEFAULT_NEGATIVE;
  // Image mode: same graph, length 1, decoded to a still instead of muxed to a clip.
  // `sourceImageName` binds a LoadImage to source_video (the node's slot is IMAGE —
  // a still is simply a one-frame "video"), which is what selects the i2i task.
  const imgMode = !!imageMode;
  const i2v = !videoName && !sourceImageName; // image-to-video: no source clip to edit
  // reference_images is an AUTOGROW slot list (reference_image_0, _1, …): [0] is the
  // primary, the rest are further views of the same subject. See buildScail2 — the
  // extra views carry information the primary cannot imply (a back view, a close-up).
  const refs = (Array.isArray(refImageNames) && refImageNames.length ? refImageNames : [refImageName])
    .filter(Boolean).slice(0, BERNINI_MAX_REFS);
  // Video task line. An explicit ⚙ choice WINS (it's the only way to reach the
  // source_video-only variants — [7]/[10]/[11] are indistinguishable from plain v2v
  // by wiring alone); otherwise infer from what's connected, as before. With nothing
  // connected at all the task is t2v [2].
  const VIDEO_TASK_SYS = {
    generic: BERNINI_SYS_GENERIC,
    edit: BERNINI_SYS_V2V,
    restyle: BERNINI_SYS_RESTYLE,
    action: BERNINI_SYS_ACTION,
    propagate: BERNINI_SYS_PROPAGATE,
  };
  const sys = imgMode
    ? (imageTask === "i2i" ? BERNINI_SYS_I2I : imageTask === "r2i" ? BERNINI_SYS_R2I : BERNINI_SYS_T2I)
    : insertImageName ? BERNINI_SYS_ADS2V
    : (videoTask && VIDEO_TASK_SYS[videoTask]) ? VIDEO_TASK_SYS[videoTask]
    : i2v ? (refs.length ? BERNINI_SYS_I2V : BERNINI_SYS_T2V)
    : (refs.length ? BERNINI_SYS_RV2V : BERNINI_SYS_V2V);
  // Three sampling modes, most-specific first:
  //   lightx2v — the author's Bernini-R LightX2V recipe: KSamplerAdvanced ×2 +
  //     ModelSamplingSD3 shift 8, 4 steps split at 2, cfg 1, dpmpp_2m_sde / sgm_uniform,
  //     the dedicated high/low LoRA pair at strength 1.0. Needs the pair installed.
  //   turbo    — the older single-distill-LoRA path: SamplerCustom + SplitSigmas,
  //     6 steps, cfg 1, LoRA str 3 / 1.5.
  //   quality  — no LoRA: SamplerCustom + SplitSigmas, 40 steps, cfg 5.
  const useLx = lightx2v && !!(comp.loraLxHigh && comp.loraLxLow);
  const useTurbo = !useLx && turbo && !!comp.lora;
  const steps = useLx ? 4 : useTurbo ? 6 : 40;
  const split = useLx ? 2 : useTurbo ? 3 : 20;
  const cfg = (useLx || useTurbo) ? 1 : 5;
  const wf = {
    "1": { class_type: "CLIPLoader", inputs: { clip_name: comp.clip, type: "wan", device: "default" } },
    "2": { class_type: "VAELoader", inputs: { vae_name: comp.vae } },
    "3": { class_type: "UNETLoader", inputs: { unet_name: highModel, weight_dtype: "default" } },
    "4": { class_type: "UNETLoader", inputs: { unet_name: lowModel, weight_dtype: "default" } },
    "7": { class_type: "CLIPTextEncode", inputs: { clip: ["1", 0], text: `${sys}\n${prompt}` } },
    "8": { class_type: "CLIPTextEncode", inputs: { clip: ["1", 0], text: neg } },
    "9": { class_type: "BerniniConditioning", inputs: { positive: ["7", 0], negative: ["8", 0], vae: ["2", 0], width, height, length, batch_size: 1, ref_max_size: refMaxSize || Math.max(width, height) } },
    "17": { class_type: "VAEDecode", inputs: { samples: ["16", 0], vae: ["2", 0] } },
  };
  if (imgMode) {
    // Still output: the decoded single frame goes straight to SaveImage — no
    // CreateVideo/SaveVideo. A source image (i2i) rides the source_video slot.
    if (sourceImageName) {
      wf["5"] = { class_type: "LoadImage", inputs: { image: sourceImageName } };
      wf["9"].inputs.source_video = ["5", 0];
    }
    wf["19"] = { class_type: "SaveImage", inputs: { images: ["17", 0], filename_prefix: "heykoko" } };
  } else {
    wf["19"] = { class_type: "SaveVideo", inputs: { video: ["18", 0], filename_prefix: "heykoko_bernini", format: "auto", codec: "auto" } };
    // Source clip (v2v/rv2v): LoadVideo → GetVideoComponents feeds source_video and
    // the output's audio + fps. i2v has no source — CreateVideo gets an explicit fps.
    if (!i2v) {
      wf["5"] = { class_type: "LoadVideo", inputs: { file: videoName } };
      wf["6"] = { class_type: "GetVideoComponents", inputs: { video: ["5", 0] } };
      wf["9"].inputs.source_video = ["6", 0];
      wf["18"] = { class_type: "CreateVideo", inputs: { images: ["17", 0], audio: ["6", 1], fps: ["6", 2] } };
    } else {
      wf["18"] = { class_type: "CreateVideo", inputs: { images: ["17", 0], fps: fps || 16 } };
    }
  }
  if (useLx) {
    // Author's verified recipe — mirrors buildWan14B's KSamplerAdvanced two-expert
    // split: UNETLoader → LoRA(str 1.0) → ModelSamplingSD3(shift 8) → KSamplerAdvanced.
    // High runs steps 0→2 leaving residual noise; low continues 2→4. Node ids 31/32
    // (ModelSamplingSD3) sit clear of the 20-27 reference block and 30 (ads2v).
    const LX_SHIFT = 8;
    wf["13"] = { class_type: "LoraLoaderModelOnly", inputs: { model: ["3", 0], lora_name: comp.loraLxHigh, strength_model: 1.0 } };
    wf["14"] = { class_type: "LoraLoaderModelOnly", inputs: { model: ["4", 0], lora_name: comp.loraLxLow, strength_model: 1.0 } };
    wf["31"] = { class_type: "ModelSamplingSD3", inputs: { model: ["13", 0], shift: LX_SHIFT } };
    wf["32"] = { class_type: "ModelSamplingSD3", inputs: { model: ["14", 0], shift: LX_SHIFT } };
    wf["15"] = { class_type: "KSamplerAdvanced", inputs: { model: ["31", 0], add_noise: "enable", noise_seed: seed, steps, cfg, sampler_name: "dpmpp_2m_sde", scheduler: "sgm_uniform", positive: ["9", 0], negative: ["9", 1], latent_image: ["9", 2], start_at_step: 0, end_at_step: split, return_with_leftover_noise: "enable" } };
    wf["16"] = { class_type: "KSamplerAdvanced", inputs: { model: ["32", 0], add_noise: "disable", noise_seed: 0, steps, cfg, sampler_name: "dpmpp_2m_sde", scheduler: "sgm_uniform", positive: ["9", 0], negative: ["9", 1], latent_image: ["15", 0], start_at_step: split, end_at_step: steps, return_with_leftover_noise: "disable" } };
  } else {
    // SamplerCustom + SplitSigmas (turbo single-LoRA, or quality no-LoRA).
    wf["10"] = { class_type: "BasicScheduler", inputs: { model: ["4", 0], scheduler: "simple", steps, denoise: 1 } };
    wf["11"] = { class_type: "SplitSigmas", inputs: { sigmas: ["10", 0], step: split } };
    wf["12"] = { class_type: "KSamplerSelect", inputs: { sampler_name: "res_multistep" } };
    let highRef = ["3", 0], lowRef = ["4", 0];
    if (useTurbo) {
      wf["13"] = { class_type: "LoraLoaderModelOnly", inputs: { model: ["3", 0], lora_name: comp.lora, strength_model: 3 } };
      wf["14"] = { class_type: "LoraLoaderModelOnly", inputs: { model: ["4", 0], lora_name: comp.lora, strength_model: 1.5 } };
      highRef = ["13", 0]; lowRef = ["14", 0];
    }
    wf["15"] = { class_type: "SamplerCustom", inputs: { add_noise: true, noise_seed: seed, cfg, model: highRef, positive: ["9", 0], negative: ["9", 1], sampler: ["12", 0], sigmas: ["11", 0], latent_image: ["9", 2] } };
    wf["16"] = { class_type: "SamplerCustom", inputs: { add_noise: false, noise_seed: 0, cfg, model: lowRef, positive: ["9", 0], negative: ["9", 1], sampler: ["12", 0], sigmas: ["11", 1], latent_image: ["15", 0] } };
  }
  // Reference images — rv2v (alongside a source video) OR i2v (the image is the
  // whole basis). Same autogrow slots either way. Node ids start above the highest
  // fixed id (19) so the loop can never overwrite one of them.
  refs.forEach((name, i) => {
    const id = String(20 + i);
    wf[id] = { class_type: "LoadImage", inputs: { image: name } };
    wf["9"].inputs[`reference_images.reference_image_${i}`] = [id, 0];
  });
  // ads2v: reference_video takes an IMAGE, so a still is simply a one-frame clip. Id 30
  // sits clear of the 20+i reference block (capped at 8 → 20…27).
  if (insertImageName) {
    wf["30"] = { class_type: "LoadImage", inputs: { image: insertImageName } };
    wf["9"].inputs.reference_video = ["30", 0];
  }
  return wf;
}

// Wan 2.2 Animate (Move/pose-transfer) companions: umt5 + WAN 2.1 VAE + clip_vision_h
// + the lightx2v I2V distill LoRA + the relight LoRA. All required.
// InfiniteTalk V2V (audio-driven video dubbing) — Kijai WanVideoWrapper graph, flattened
// from wanvideo_2_1_14B_V2V_InfiniteTalk_example_02.json and LIVE-VERIFIED on the box
// (adapted: GGUF→installed safetensors, vocal-separation stage dropped, side-by-side
// comparison tail dropped, native text encode bridged in).
//
// Shape: the SOURCE VIDEO is VAE-encoded whole and handed to the sampler as `samples`;
// with start_step 2 (of 4) + add_noise_to_samples the first half of the schedule is
// skipped, so the source's motion/identity/scene survive and only the audio-conditioned
// detail (lips/face) is re-synthesised. Speech drives lips via wav2vec2 embeds; the
// InfiniteTalk patch windows long clips internally (81-frame windows, 9-frame motion
// overlap) — ONE graph regardless of length, no client-side chunking. If the audio
// outlasts the clip, generation extends from the last frame; output length = audio
// length exactly (decoded frames are trimmed to the embeds' real frame count, and the
// loudness-normalised audio is muxed back in).
//
// Sizing: output follows the source video's aspect at the 832×480 budget, dims /16
// (ImageResizeKJv2 crops/resizes the source; start frame + gen size derive from it).
// Two modes, keyed by which source is given (exactly one of videoName / imageName):
//   • videoName — V2V dubbing as described above.
//   • imageName — I2V "photo speaks" (per wanvideo_2_1_14B_I2V_InfiniteTalk_example_03):
//     the photo is the start frame + clip-vision reference; with no source latents to
//     preserve there is no `samples` input and the sampler runs the FULL 6-step
//     schedule from step 0 (the V2V 4-step/start_step-2 trick only makes sense when
//     denoising on top of an existing clip). LIVE-VERIFIED on the box.
function buildInfiniteTalk({ prompt, negative, comp, videoName, imageName, audioName, width, height, fps, maxFrames, seed }) {
  const speak = !!imageName;
  const pos = prompt || "a person is talking to the camera, natural speech, lips moving in sync with the audio";
  const neg = negative || "bright tones, overexposed, static, blurred details, subtitles, worst quality, low quality, deformed, disfigured, extra fingers, still picture, messy background";
  const source = speak
    ? {
      // Photo → resized to the output size → start frame (single image, no range pick).
      "7": { class_type: "LoadImage", inputs: { image: imageName } },
      "9": { class_type: "ImageResizeKJv2", inputs: { image: ["7", 0], width, height, upscale_method: "lanczos", keep_proportion: "crop", pad_color: "0, 0, 0", crop_position: "center", divisible_by: 16, device: "cpu" } },
      "11": { class_type: "GetImageSizeAndCount", inputs: { image: ["9", 0] } },
    }
    : {
      // Source video → resized whole → first frame picked for conditioning; the full
      // clip is VAE-encoded below into the sampler's `samples`.
      "7": { class_type: "LoadVideo", inputs: { file: videoName } },
      "8": { class_type: "GetVideoComponents", inputs: { video: ["7", 0] } },
      "9": { class_type: "ImageResizeKJv2", inputs: { image: ["8", 0], width, height, upscale_method: "lanczos", keep_proportion: "crop", pad_color: "0, 0, 0", crop_position: "center", divisible_by: 16, device: "cpu" } },
      "10": { class_type: "GetImageRangeFromBatch", inputs: { images: ["9", 0], start_index: 0, num_frames: 1 } },
      "11": { class_type: "GetImageSizeAndCount", inputs: { image: ["10", 0] } },
      "18": { class_type: "WanVideoEncode", inputs: { vae: ["5", 0], image: ["9", 0], enable_vae_tiling: false, tile_x: 272, tile_y: 272, tile_stride_x: 144, tile_stride_y: 128, noise_aug_strength: 0.0, latent_strength: 1.0 } },
    };
  const samplerExtra = speak
    ? { steps: 6, start_step: 0, add_noise_to_samples: false }
    : { samples: ["18", 0], steps: 4, start_step: 2, add_noise_to_samples: true };
  return {
    ...source,
    // Model stack: base UNET + InfiniteTalk patch + lightx2v distill LoRA (the 4-step
    // cfg-1 schedule below is bound to it) + 20-block swap (VRAM headroom; harmless
    // when there is plenty). sdpa attention — safe everywhere, no sage dependency.
    "1": { class_type: "WanVideoModelLoader", inputs: { model: comp.model, base_precision: "fp16_fast", quantization: "fp8_e4m3fn_scaled", load_device: "offload_device", attention_mode: "sdpa", block_swap_args: ["2", 0], lora: ["3", 0], multitalk_model: ["4", 0] } },
    "2": { class_type: "WanVideoBlockSwap", inputs: { blocks_to_swap: 20, offload_img_emb: false, offload_txt_emb: false, use_non_blocking: true, vace_blocks_to_swap: 0, prefetch_blocks: 1, block_swap_debug: false } },
    "3": { class_type: "WanVideoLoraSelect", inputs: { lora: comp.lora, strength: 1.0, low_mem_load: false, merge_loras: false } },
    "4": { class_type: "MultiTalkModelLoader", inputs: { model: comp.patch } },
    "5": { class_type: "WanVideoVAELoader", inputs: { model_name: comp.vae, precision: "bf16" } },
    "6": { class_type: "CLIPVisionLoader", inputs: { clip_name: comp.clipVision } },
    "12": { class_type: "WanVideoClipVisionEncode", inputs: { clip_vision: ["6", 0], image_1: ["11", 0], strength_1: 1.0, strength_2: 1.0, crop: "center", combine_embeds: "average", force_offload: true, tiles: 0, ratio: 0.5 } },
    // Text: NATIVE loader + bridge. The wrapper's own text encoders reject comfy's
    // scaled-fp8 umt5 ("fp8 scaled is not supported by this node").
    "23": { class_type: "CLIPLoader", inputs: { clip_name: comp.clip, type: "wan", device: "default" } },
    "24": { class_type: "CLIPTextEncode", inputs: { clip: ["23", 0], text: pos } },
    "25": { class_type: "CLIPTextEncode", inputs: { clip: ["23", 0], text: neg } },
    "13": { class_type: "WanVideoTextEmbedBridge", inputs: { positive: ["24", 0], negative: ["25", 0] } },
    "14": { class_type: "WanVideoImageToVideoMultiTalk", inputs: { vae: ["5", 0], width: ["11", 1], height: ["11", 2], frame_window_size: 81, motion_frame: 9, force_offload: false, colormatch: "disabled", start_image: ["11", 0], tiled_vae: false, clip_embeds: ["12", 0], mode: "infinitetalk" } },
    // Speech → wav2vec2 embeds. num_frames is a CAP (actual = audio duration × fps);
    // outputs: [0] embeds, [1] loudness-normalised audio, [2] REAL frame count.
    "15": { class_type: "Wav2VecModelLoader", inputs: { model: comp.wav2vec, base_precision: "fp16", load_device: "main_device" } },
    "16": { class_type: "LoadAudio", inputs: { audio: audioName } },
    "17": { class_type: "MultiTalkWav2VecEmbeds", inputs: { wav2vec_model: ["15", 0], audio_1: ["16", 0], normalize_loudness: true, num_frames: maxFrames, fps, audio_scale: 1.0, audio_cfg_scale: 1.0, multi_audio_type: "para" } },
    "19": { class_type: "WanVideoSampler", inputs: { model: ["1", 0], image_embeds: ["14", 0], text_embeds: ["13", 0], multitalk_embeds: ["17", 0], cfg: 1.0, shift: 11.0, seed, force_offload: true, scheduler: "dpm++_sde", riflex_freq_index: 0, denoise_strength: 1.0, batched_cfg: false, rope_function: "comfy", end_step: -1, ...samplerExtra } },
    "20": { class_type: "WanVideoDecode", inputs: { vae: ["5", 0], samples: ["19", 0], enable_vae_tiling: false, tile_x: 272, tile_y: 272, tile_stride_x: 144, tile_stride_y: 128 } },
    // Trim the last window's padding to the REAL audio frame count, mux the audio.
    "26": { class_type: "GetImageRangeFromBatch", inputs: { images: ["20", 0], start_index: 0, num_frames: ["17", 2] } },
    "21": { class_type: "CreateVideo", inputs: { images: ["26", 0], fps, audio: ["17", 1] } },
    "22": { class_type: "SaveVideo", inputs: { video: ["21", 0], filename_prefix: "heykoko_infinitetalk", format: "auto", codec: "auto" } },
  };
}

// Wan-Dancer (music → dance): reference photo + MUSIC file → the character dances to
// the track. Flattened from the official video_wan_dancer template (2026-07-14), whose
// two-stage hierarchy runs in ONE graph:
//   • GLOBAL expert — plans keyframes for the WHOLE trimmed track in one 149-frame
//     window (time-mapped RoPE stretches them over the full duration), sampled with
//     SkipLayerGuidance (layer 9) + shift 5. Turbo (default): distill LoRA at
//     strength 3, 6 steps, cfg 1; quality: no LoRA, 25 steps, cfg 5.
//   • WanDancerPadKeyframesList — slices keyframes + audio into `segments` 5-second
//     pieces (149 frames @ 30 fps each) as ComfyUI LISTS.
//   • LOCAL expert — refines each segment (list semantics iterate the sub-graph),
//     always distilled: LoRA 1.03, 6 steps, cfg 1, negative = ConditioningZeroOut.
//   • RebatchImages merges the refined segments; CreateVideo muxes the trimmed
//     music back in at 30 fps.
// The template's global positive prompt is style + a STRING the audio encoder emits
// (slot 1, an audio-derived rhythm/genre hint) — kept via StringConcatenate. The
// template's ResizeImageMaskNode (a V3 dynamic node, awkward over the bare API) is
// replaced by ImageScale — equivalent here since width/height already follow the
// photo's aspect. duration = segments × 5 s, both trimmed into TrimAudioDuration
// and fed as num_segments — the template leaves them free to disagree (silent
// mismatch); we derive both from one value.
function buildWanDancer({ prompt, negative, comp, imageName, audioName, width, height, seed, turbo, duration, segments, styleWord, ampWord }) {
  const style = `一个人正在跳舞，舞蹈种类是${styleWord}` + (prompt && prompt.trim() ? `，${prompt.trim()}` : "");
  const amp = `,图像清晰程度高,人物动作幅度${ampWord}`;
  const neg = negative && negative.trim() ? negative : WAN_DEFAULT_NEGATIVE;
  const globalModel = turbo ? ["2", 0] : ["1", 0];
  const wf = {
    // Models. Global expert: the distill LoRA ONLY in turbo (quality runs it bare);
    // local expert: ALWAYS distilled (strength 1.03), there is no quality variant.
    "1": { class_type: "UNETLoader", inputs: { unet_name: comp.global, weight_dtype: "default" } },
    "3": { class_type: "ModelSamplingSD3", inputs: { model: globalModel, shift: 5 } },
    "4": { class_type: "SkipLayerGuidanceDiTSimple", inputs: { model: ["3", 0], double_layers: "9", single_layers: "", start_percent: 0, end_percent: 1 } },
    "5": { class_type: "UNETLoader", inputs: { unet_name: comp.local, weight_dtype: "default" } },
    "6": { class_type: "LoraLoaderModelOnly", inputs: { model: ["5", 0], lora_name: comp.lora, strength_model: 1.03 } },
    "7": { class_type: "CLIPLoader", inputs: { clip_name: comp.clip, type: "wan", device: "default" } },
    "8": { class_type: "CLIPVisionLoader", inputs: { clip_name: comp.clipVision } },
    "9": { class_type: "VAELoader", inputs: { vae_name: comp.vae } },
    // Inputs. The photo is scaled to the output size (which follows its aspect, so
    // this is a resize, not a distortion); the music is trimmed to the exact duration.
    "10": { class_type: "LoadImage", inputs: { image: imageName } },
    "11": { class_type: "ImageScale", inputs: { image: ["10", 0], upscale_method: "lanczos", width, height, crop: "disabled" } },
    "12": { class_type: "LoadAudio", inputs: { audio: audioName } },
    "13": { class_type: "TrimAudioDuration", inputs: { audio: ["12", 0], start_index: 0, duration } },
    // GLOBAL stage — whole track in one window.
    "14": { class_type: "WanDancerEncodeAudio", inputs: { audio: ["13", 0], video_frames: 149, audio_inject_scale: 1 } },
    "15": { class_type: "CLIPVisionEncode", inputs: { clip_vision: ["8", 0], image: ["11", 0], crop: "none" } },
    "16": { class_type: "StringConcatenate", inputs: { string_a: style, string_b: ["14", 1], delimiter: " " } },
    "17": { class_type: "CLIPTextEncode", inputs: { clip: ["7", 0], text: ["16", 0] } },
    "18": { class_type: "CLIPTextEncode", inputs: { clip: ["7", 0], text: neg } },
    "19": { class_type: "WanDancerVideo", inputs: { positive: ["17", 0], negative: ["18", 0], vae: ["9", 0], clip_vision_output: ["15", 0], clip_vision_output_ref: ["15", 0], start_image: ["11", 0], audio_encoder_output: ["14", 0], width, height, length: 149 } },
    "20": { class_type: "RandomNoise", inputs: { noise_seed: seed } },
    "21": { class_type: "KSamplerSelect", inputs: { sampler_name: "euler" } },
    "22": { class_type: "BasicScheduler", inputs: { model: ["4", 0], scheduler: "simple", steps: turbo ? 6 : 25, denoise: 1 } },
    "23": { class_type: "CFGGuider", inputs: { model: ["4", 0], positive: ["19", 0], negative: ["19", 1], cfg: turbo ? 1 : 5 } },
    "24": { class_type: "SamplerCustomAdvanced", inputs: { noise: ["20", 0], guider: ["23", 0], sampler: ["21", 0], sigmas: ["22", 0], latent_image: ["19", 2] } },
    "25": { class_type: "LatentCutToBatch", inputs: { samples: ["24", 0], dim: "t", slice_size: 1 } },
    "26": { class_type: "VAEDecode", inputs: { samples: ["25", 0], vae: ["9", 0] } },
    // Keyframes + audio → per-segment LISTS; everything below runs once per segment.
    "27": { class_type: "WanDancerPadKeyframesList", inputs: { images: ["26", 0], segment_length: 149, num_segments: segments, audio: ["13", 0] } },
    "28": { class_type: "ImageFromBatch", inputs: { image: ["27", 0], batch_index: 0, length: 1 } },
    "29": { class_type: "CLIPVisionEncode", inputs: { clip_vision: ["8", 0], image: ["28", 0], crop: "none" } },
    "30": { class_type: "WanDancerEncodeAudio", inputs: { audio: ["27", 2], video_frames: 149, audio_inject_scale: 1 } },
    "31": { class_type: "CLIPTextEncode", inputs: { clip: ["7", 0], text: style + amp } },
    "32": { class_type: "ConditioningZeroOut", inputs: { conditioning: ["31", 0] } },
    "33": { class_type: "WanDancerVideo", inputs: { positive: ["31", 0], negative: ["32", 0], vae: ["9", 0], clip_vision_output: ["29", 0], clip_vision_output_ref: ["15", 0], start_image: ["27", 0], mask: ["27", 1], audio_encoder_output: ["30", 0], width, height, length: 149 } },
    "34": { class_type: "KSamplerSelect", inputs: { sampler_name: "euler" } },
    "35": { class_type: "BasicScheduler", inputs: { model: ["6", 0], scheduler: "simple", steps: 6, denoise: 1 } },
    "36": { class_type: "SamplerCustom", inputs: { model: ["6", 0], add_noise: true, noise_seed: seed, cfg: 1, positive: ["33", 0], negative: ["33", 1], sampler: ["34", 0], sigmas: ["35", 0], latent_image: ["33", 2] } },
    "37": { class_type: "VAEDecode", inputs: { samples: ["36", 0], vae: ["9", 0] } },
    // Merge the segment list back into one batch, mux the trimmed music, 30 fps.
    "38": { class_type: "RebatchImages", inputs: { images: ["37", 0], batch_size: 4096 } },
    "39": { class_type: "CreateVideo", inputs: { images: ["38", 0], fps: 30, audio: ["13", 0] } },
    "40": { class_type: "SaveVideo", inputs: { video: ["39", 0], filename_prefix: "heykoko_dancer", format: "auto", codec: "auto" } },
  };
  if (turbo) wf["2"] = { class_type: "LoraLoaderModelOnly", inputs: { model: ["1", 0], lora_name: comp.lora, strength_model: 3 } };
  return wf;
}

async function animateCompanions() {
  const [clips, vaes, loras, cvs] = await Promise.all([
    comfyEnum("CLIPLoader", "clip_name"),
    comfyEnum("VAELoader", "vae_name"),
    comfyEnum("LoraLoaderModelOnly", "lora_name"),
    comfyEnum("CLIPVisionLoader", "clip_name"),
  ]);
  const find = (list, re) => list.find((x) => re.test(x));
  const clip = find(clips, /umt5/i);
  const vae = find(vaes, /wan.?2[._]1.*vae/i) || find(vaes, /wan.*vae/i);
  const clipVision = find(cvs, /clip_vision_h|clip.?vision.*h\b/i) || find(cvs, /clip.?vision/i);
  const loraSpeed = find(loras, /lightx2v.*i2v.*14b.*distill|lightx2v_I2V_14B/i);
  const loraRelight = find(loras, /animate.*relight|relight.*lora/i);
  const missing = [];
  if (!clip) missing.push("umt5_xxl_fp8_e4m3fn_scaled.safetensors → text_encoders/");
  if (!vae) missing.push("wan_2.1_vae.safetensors → vae/");
  if (!clipVision) missing.push("clip_vision_h.safetensors → clip_vision/");
  if (!loraSpeed) missing.push("lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16.safetensors → loras/");
  if (!loraRelight) missing.push("WanAnimate_relight_lora_fp16.safetensors → loras/");
  if (missing.length) throw new Error("Missing files required by Wan Animate:\n- " + missing.join("\n- "));
  return { clip, vae, clipVision, loraSpeed, loraRelight };
}

// SCAIL-2 companions. Shares umt5 / clip_vision_h / the Wan 2.1 VAE / the lightx2v
// distill LoRA with Wan Animate, and adds its own DPO LoRA + the SAM3 checkpoint
// (loaded as a plain CheckpointLoaderSimple — its CLIP output drives the
// open-vocabulary text query that picks the subject to track).
async function scail2Companions() {
  const [clips, vaes, loras, cvs, ckpts] = await Promise.all([
    comfyEnum("CLIPLoader", "clip_name"),
    comfyEnum("VAELoader", "vae_name"),
    comfyEnum("LoraLoaderModelOnly", "lora_name"),
    comfyEnum("CLIPVisionLoader", "clip_name"),
    comfyEnum("CheckpointLoaderSimple", "ckpt_name"),
  ]);
  // `skip` drops variants that match the family but are known-broken (see sam3 below).
  const find = (list, re, skip) => list.find((x) => re.test(x) && !(skip && skip.test(x)));
  const clip = find(clips, /umt5/i);
  // The template pins the bf16 Wan 2.1 VAE; any Wan 2.1 VAE works.
  const vae = find(vaes, /wan.?2[._]1.*vae/i) || find(vaes, /wan.*vae/i);
  const clipVision = find(cvs, /clip_vision_h|clip.?vision.*h\b/i) || find(cvs, /clip.?vision/i);
  const loraDistill = find(loras, /lightx2v.*i2v.*14b.*distill|lightx2v_I2V_14B/i);
  const loraDpo = find(loras, /scail.*dpo|dpo.*scail/i);
  // Any fp8 SAM3 is unusable, not merely slower: SAM3_VideoTrack dies on first execution with
  // `NotImplementedError: "addmm_cuda" not implemented for 'Float8_e4m3fn'` — PyTorch ships no
  // fp8 addmm CUDA kernel, so nothing on the graph side can work around it (verified on RTX
  // 5090 / torch 2.10+cu130 / ComfyUI 0.29.0). Excluding it here rather than letting `find`
  // take whichever variant sorts first: with both installed the fp16 file happened to win on
  // alphabetical order alone, so the crash was one filename away the whole time — and the
  // error names a matmul kernel, giving no hint that the wrong checkpoint was picked.
  const sam3 = find(ckpts, /sam3/i, /fp8|float8|e4m3|e5m2/i);
  const missing = [];
  if (!clip) missing.push("umt5_xxl_fp8_e4m3fn_scaled.safetensors → text_encoders/");
  if (!vae) missing.push("Wan2_1_VAE_bf16.safetensors → vae/");
  if (!clipVision) missing.push("clip_vision_h.safetensors → clip_vision/");
  if (!loraDistill) missing.push("lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16.safetensors → loras/");
  if (!loraDpo) missing.push("wan2.1_SCAIL_2_DPO_lora_bf16.safetensors → loras/");
  if (!sam3) missing.push("sam3.1_multiplex_fp16.safetensors → checkpoints/");
  if (missing.length) throw new Error("Missing files required by SCAIL-2:\n- " + missing.join("\n- "));
  return { clip, vae, clipVision, loraDistill, loraDpo, sam3 };
}

// SCAIL-2 (zai-org, built on Wan 2.1) — end-to-end character animation. A reference
// character image + a driving video → the character performs the motion (Animation)
// or replaces the tracked person in the source scene (Replacement, the model's own
// default). Flattened from the official "SCAIL-2: Character Replacement" template
// (Base + Extend subgraphs) — LIVE-VERIFIED end-to-end in both modes.
//
// Unlike Wan Animate there is NO intermediate pose representation: the driving video
// goes straight into the model, so there's no DWPose step to wait on. SAM3 tracks the
// subject in BOTH the driving video and the reference image via an open-vocabulary
// text query ("human" by default); SCAIL2ColoredMask turns the two tracks into the
// colour-coded masks that bind body regions between them. Its background colour is
// what actually selects the mode, hence the single `replace` flag driving both nodes.
//
// The template's Primitive/Switch/MathExpression plumbing is resolved here in JS, and
// ResizeImageMaskNode → ImageScale (the template's own "scale dimensions"+area+center).
//
// LONG SOURCES: the official workflow needs ONE MANUAL RUN PER SEGMENT (its note says
// WanSCAILToVideo "cannot queue all segments automatically"). We emit the whole chain
// in ONE graph instead: segment k slices the source at STRIDE·k, takes segment k−1's
// frames as `previous_frames` (the node reuses the last `previous_frame_count`), drops
// its regenerated overlap, and colour-matches to the previous segment's last frame.
// `segments` = [{offset,length}, …] (length 1 = one pass).
//
// INCREMENTAL SAVE (default; `incrementalSave`). The chain used to end in ONE
// CreateVideo fed by an ImageBatch accumulation of every segment. That accumulator is
// what made long sources unrunnable: the decoded float32 frames of every window stay
// referenced until the very last node runs, MEASURED at ~3.7 GiB of growth per window,
// so peak memory climbs LINEARLY with the clip length (a 110s source — 2643 frames, 22
// windows — reached ~103 GiB and was OOM-killed on a 121.7 GiB DGX Spark, where VRAM is
// system RAM and the kill is driven by anon-rss, not by anything nvidia-smi reports).
// Instead each segment now ends in its OWN silent CreateVideo → SaveVideo, so its frames
// are consumed as soon as that window is written and the peak stops tracking the clip
// length. The budget it should settle at is the sum of the parts that DON'T grow with
// length — measured staged weights 61.6 + node 15's ~27 + one window's working set ≈ 88
// GiB, i.e. under the 121.7 GiB budget with room to spare. The app then joins the N
// clips and lays the source soundtrack over the result (mergeScail2Segments) — the audio
// was never sliced in the old graph either, CreateVideo(audio:["15",1]) muxed it once
// onto the finished picture, so this is the same operation moved out of the graph.
//
// ON ITS OWN this leaves a SOURCE-LENGTH ceiling: node 15 (GetVideoComponents) decodes
// the WHOLE source into one resident batch because every segment slices out of it —
// ~27 GiB of float32 for 110s at 720p, growing with the source however short the windows
// are. `streamSource` below removes node 15 altogether and lifts that ceiling too; the
// two options are the output side and the input side of the same problem. Everything the
// seam depends on — previous_frames, the overlap drop, ColorTransfer — is untouched by
// either, because it all still lives inside a single graph.
const SCAIL2_FRAMES = 81;                          // template default frame_count, 4n+1
const SCAIL2_OVERLAP = 5;                          // previous_frame_count
const SCAIL2_STRIDE = SCAIL2_FRAMES - SCAIL2_OVERLAP; // 76 — pose offset per segment
// Node ids for segment k. 20 apart: a segment spans base+0 … base+13, so a 10-stride
// would silently overwrite the previous segment's nodes — still-valid JSON, corrupted
// graph (that bug shipped once and made only the LAST segment render).
const scail2SegBase = (k) => 100 + k * 20;
// Which node wrote segment k's file. The app fetches each clip from /history by NODE ID,
// never by filename: stampOutputPrefix rewrites every SaveVideo to the same
// `<folder>/<model>` prefix just before queueing, so all N clips differ only by
// ComfyUI's auto-increment counter and their names carry no reliable ordering.
const scail2SaveNodeId = (k) => String(scail2SegBase(k) + 13);

// Segment schedule for a source of `total` frames, capped at `cap` frames per pass.
// windowMult (⚙, 1-4) multiplies the 81-frame window: 81 / 161 / 241 / 321 after snapping
// to 4n+1. 81 is the official template's frame_count, NOT a model limit — the ComfyUI node
// accepts up to 16384 and the reference generate.py exposes --segment_len — so the ladder
// measured 81/161/241/361/481 at 432x768 and saw no quality falloff even at 6x, never OOMing
// on 122GB. Chaining is nonetheless FASTER for the same output length (241 frames: one big
// window 827s vs three 81-frame segments 490s = 1.69x), because per-frame cost climbs
// superlinearly. A wider window is therefore for CONTINUITY, not speed: it removes the
// seams that chaining can leave on long slow moves. Cost scales roughly as pixels^1.45 and
// peak VRAM with it, so 3-4x at 720p/1080p can OOM where 1x fits — hence opt-in, default 1x.
function scail2Segments(total, cap = SCAIL2_FRAMES, windowMult = 1) {
  const snap4 = (n) => Math.max(1, Math.floor((n - 1) / 4) * 4 + 1); // 4n+1, ≤ n
  const mult = [1, 2, 3, 4].includes(Number(windowMult)) ? Number(windowMult) : 1;
  const want = SCAIL2_FRAMES * mult;
  const per = snap4(Math.max(5, Math.min(cap, want)));
  const stride = per - SCAIL2_OVERLAP;
  const segs = [];
  if (!(total > 0)) return [{ offset: 0, length: per }];
  for (let k = 0; k < 400; k++) {
    const offset = stride * k;
    const avail = total - offset;
    if (avail <= 0) break;
    const length = snap4(Math.min(per, avail));
    if (length < 5) break;
    // Test the SNAPPED length, not `avail`: a later segment drops its first
    // SCAIL2_OVERLAP frames, so one that snaps down to exactly the overlap would
    // contribute nothing and hand ColorTransfer an empty batch.
    if (k > 0 && length <= SCAIL2_OVERLAP) break;
    segs.push({ offset, length });
    if (avail <= per) break;
  }
  return segs.length ? segs : [{ offset: 0, length: per }];
}

function buildScail2({ model, prompt, negative, comp, videoName, refImageName, refImageNames, width, height, seed, segments, replace = false, turbo = true, scailRecipe = "balanced", poseStrength = 1, poseStart = 0, poseEnd = 1, sam3VideoObject = "human", sam3ImageObject = "", objectIndices = "", sortBy = "left_to_right", detectionThreshold = 0.5, maxObjects = 4, torchCompile = false, incrementalSave = true, streamSource = false, sourceFps = 0 }) {
  const segs = (Array.isArray(segments) && segments.length) ? segments : [{ offset: 0, length: SCAIL2_FRAMES }];
  // Clamp to the node's own declared ranges — a ⚙ field is free text until it isn't.
  const clamp = (v, lo, hi, dflt) => (typeof v === "number" && isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt);
  const pStrength = clamp(poseStrength, 0, 10, 1);
  const pStart = clamp(poseStart, 0, 1, 0);
  // pose_end below pose_start would open an empty conditioning window — the node takes
  // it without complaint and simply drops the pose, which reads as "the knob did nothing".
  const pEnd = Math.max(pStart, clamp(poseEnd, 0, 1, 1));
  const sam3Vid = String(sam3VideoObject || "").trim() || "human";
  // The reference subject DEFAULTS TO THE DRIVING ONE, so it must default to empty
  // above — a "human" default here would swallow the fallback and quietly pin the
  // reference to "human" whenever the driving subject was something else.
  const sam3Ref = String(sam3ImageObject || "").trim() || sam3Vid;
  // "0, 2" and "0,2" must mean the same thing; the node parses a bare comma list.
  const indices = String(objectIndices || "").split(",").map((s) => s.trim()).filter((s) => /^\d+$/.test(s)).join(",");
  const sort = ["left_to_right", "area", "none"].includes(sortBy) ? sortBy : "left_to_right";
  // SAM3 detection, applied identically to the reference and the driving video — the two
  // masks are only comparable if they were found under the same rules.
  const detThresh = clamp(detectionThreshold, 0, 1, 0.5);
  const maxObj = Math.round(clamp(maxObjects, 0, 64, 4)); // 0 = the node's internal cap of 64
  // ADDITIONAL REFERENCE VIEWS. reference_image is a BATCH: [0] is the primary, and the
  // rest are further views of the same character (back, close-up, occluded background).
  // Verified to carry information the primary cannot imply — with a plain-fronted hoodie
  // whose BACK reads "47", a front-only reference renders a blank back while front+back
  // renders the 47. reference_image and reference_image_mask pair up by BATCH INDEX, so
  // the very same batch has to feed SAM3 (which produces the masks) and WanSCAILToVideo.
  const refs = (Array.isArray(refImageNames) && refImageNames.length ? refImageNames : [refImageName]).filter(Boolean);
  // The template leaves the negative EMPTY (cfg 1 in turbo, so it does nothing);
  // honour an explicit one for the 40-step/cfg-5 non-turbo path.
  const neg = negative && negative.trim() ? negative : "";
  // Three sampling recipes. `turbo` (both here and the ⚙ default) means "balanced", which is
  // what this builder has always shipped; "fast" is the recipe lightx2v publishes for its own
  // step-distill LoRA; "off" drops the LoRA and runs the undistilled 40-step/cfg-5 path.
  //
  // Measured on the RTX 5090 at 736x1280 (same seed, sage on, arms back to back):
  //   balanced  6 steps / 0.8   164s   sharpness 0.888
  //   fast      4 steps / 1.0   114s   sharpness 0.920   -> 1.44x faster AND marginally sharper
  //   off       40 steps / cfg 5      never measured; ~13x more DiT forward passes than
  //                                   balanced (40x2 with CFG vs 6x1 — cfg 1 makes ComfyUI
  //                                   skip the uncond pass, comfy/samplers.py:609)
  // "fast" is not the default because that comparison covers one source clip on plain
  // background; step count fails on hard content first, and that has not been ruled out.
  const recipe = ["fast", "off"].includes(scailRecipe) ? scailRecipe : "balanced";
  const useDistill = turbo && recipe !== "off";
  const steps = !useDistill ? 40 : (recipe === "fast" ? 4 : 6);
  const cfg = useDistill ? 1 : 5;
  const distillStrength = recipe === "fast" ? 1 : 0.8;
  const wf = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: model, weight_dtype: "default" } },
    // The DPO (quality) LoRA is ALWAYS applied; the distill LoRA is the turbo branch.
    "2": { class_type: "LoraLoaderModelOnly", inputs: { model: ["1", 0], lora_name: comp.loraDpo, strength_model: 1 } },
    "5": { class_type: "CLIPLoader", inputs: { clip_name: comp.clip, type: "wan", device: "default" } },
    "6": { class_type: "VAELoader", inputs: { vae_name: comp.vae } },
    "7": { class_type: "CLIPVisionLoader", inputs: { clip_name: comp.clipVision } },
    "8": { class_type: "CLIPTextEncode", inputs: { clip: ["5", 0], text: prompt } },
    "9": { class_type: "CLIPTextEncode", inputs: { clip: ["5", 0], text: neg } },
    "10": { class_type: "LoadImage", inputs: { image: refs[0] } },
    // CLIP vision stays on the PRIMARY view only — it is one conditioning vector for
    // "who this is", not a per-view input; the extra views exist to fill in surfaces the
    // primary cannot show, which is the mask/reference batch's job, not this one's.
    "11": { class_type: "CLIPVisionEncode", inputs: { clip_vision: ["7", 0], image: ["10", 0], crop: "none" } },
    // 12 + 15 (LoadVideo → GetVideoComponents) are added below, and ONLY on the
    // whole-source path — streaming deletes the need for them entirely.
    // SAM3 open-vocabulary tracking. Node 23 tracks the REFERENCE image once and is
    // shared by every segment; each segment tracks its own slice of the driving video.
    "20": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: comp.sam3 } },
    "21": { class_type: "CLIPTextEncode", inputs: { clip: ["20", 1], text: sam3Vid } },
    "22": { class_type: "CLIPTextEncode", inputs: { clip: ["20", 1], text: sam3Ref } },
    "23": { class_type: "SAM3_VideoTrack", inputs: { images: ["10", 0], model: ["20", 0], detection_threshold: detThresh, max_objects: maxObj, detect_interval: 1, conditioning: ["22", 0] } },
    "27": { class_type: "KSamplerSelect", inputs: { sampler_name: "euler" } },
  };
  // STREAMING THE SOURCE. The whole-source path decodes the ENTIRE driving video into one
  // resident frame batch (node 15) and has every segment cut its window out of it with
  // ImageFromBatch — ~27 GiB of float32 for 110s at 720p, and it grows with the source no
  // matter how the output is windowed. That is the input-side twin of the accumulator
  // problem, and the ceiling that incremental save alone does not lift.
  //
  // VHS_LoadVideo takes the window directly (`skip_first_frames` / `frame_load_cap`) and
  // reads only those frames, so nodes 12 and 15 disappear and each segment holds its own
  // 81 frames and nothing else.
  //
  // LIVE-VERIFIED against the whole-source path on the real box (same clip, offset 100,
  // 3 frames, saved as PNG and compared):
  //   • FRAME ALIGNMENT IS EXACT — cross-comparing A's frame 2 against B's 1/2/3 gives
  //     30.4 / 39.0 / 25.2 dB, i.e. the diagonal is the peak. `skip_first_frames` and
  //     `batch_index` are the same 0-based frame index, which is what the segment overlap
  //     (stride 76 = 81 − 5) and previous_frames handshake depend on.
  //   • PIXELS ARE NOT BIT-IDENTICAL: ~39 dB PSNR, per channel B 35.4 / R 41.0 / G 46.8.
  //     That signature is a YUV→RGB matrix/range difference between the two decoders
  //     (GetVideoComponents runs PyAV, VHS runs cv2), not a content difference. It does
  //     mean the SAME SEED renders slightly differently with this on and off.
  //   • `format` is a FRONTEND widget (its "AnimateDiff" default carries target_rate 8,
  //     which would be fatal) — the backend does not apply it: sending it and omitting it
  //     produced files differing only by the 18 bytes of prompt JSON embedded in the PNG.
  //     Passed explicitly as "None" anyway, since it costs nothing to nail down.
  //
  // Requires incrementalSave: the legacy tail muxes its audio from node 15, so keeping
  // that tail means keeping the whole-source decode and there would be nothing to win.
  const stream = streamSource && incrementalSave;
  if (!stream) {
    wf["12"] = { class_type: "LoadVideo", inputs: { file: videoName } };
    wf["15"] = { class_type: "GetVideoComponents", inputs: { video: ["12", 0] } };
  }
  // Output fps. Node 15's FLOAT output is the source's own rate and is preferred when it
  // is there; streaming has no such node, so the probed source fps is passed in instead.
  const fpsRef = stream ? (Number(sourceFps) > 0 ? Number(sourceFps) : 16) : ["15", 2];
  // Chain the extra views onto the primary. SAM3 reads the batch as consecutive "video
  // frames" and tracks the subject across them, so each view comes back masked in the
  // SAME identity colour — which is exactly the pairing WanSCAILToVideo expects.
  let refBatch = ["10", 0];
  refs.slice(1).forEach((name, i) => {
    const L = String(30 + i * 2), B = String(31 + i * 2);
    wf[L] = { class_type: "LoadImage", inputs: { image: name } };
    wf[B] = { class_type: "ImageBatch", inputs: { image1: refBatch, image2: [L, 0] } };
    refBatch = [B, 0];
  });
  wf["23"].inputs.images = refBatch;
  if (useDistill) wf["3"] = { class_type: "LoraLoaderModelOnly", inputs: { model: ["2", 0], lora_name: comp.loraDistill, strength_model: distillStrength } };
  const modelSrc = useDistill ? "3" : "2";
  // Optional torch.compile. LIVE-MEASURED on the DGX Spark: compiled segments run ~2x
  // faster (163s -> 80s per 81-frame segment at 432x768) for a one-time ~80s compile, so
  // a 3-segment run went 490s -> 319s (1.53x) and longer runs approach 2x.
  //
  // The node and its flags are NOT interchangeable — three variants were tried and only
  // this one survives on SCAIL-2's fp8 weights:
  //   • core TorchCompileModel (no options)      -> dynamo symbolic shapes hit comfy/ops.py
  //     cast_bias_weight: "Expect size to be a plain tuple of ints but got torch.Size([s81, s16])"
  //   • TorchCompileModelWanVideoV2 (defaults)   -> fails tracing the quantised weight's
  //     requantize_from_float (the fp8 base + bf16 LoRA merge path)
  //   • backend "cudagraphs"                     -> "cudaMallocAsync does not yet support
  //     checkPoolLiveAllocations" (ComfyUI runs the async allocator)
  // disable_dynamic_vram is what actually unblocks it: ComfyUI's on-demand weight paging
  // is what dynamo cannot trace. That also means the model stays resident, so this is for
  // machines with VRAM to spare — on a tight card it trades OOM-safety for speed.
  const compileSrc = torchCompile ? "26" : modelSrc;
  if (torchCompile) {
    wf["26"] = {
      class_type: "TorchCompileModelAdvanced",
      inputs: {
        model: [modelSrc, 0], backend: "inductor", fullgraph: false, mode: "default",
        dynamic: "false", compile_transformer_blocks_only: true,
        dynamo_cache_size_limit: 64, debug_compile_keys: false, disable_dynamic_vram: true,
      },
    };
  }
  wf["4"] = { class_type: "ModelSamplingSD3", inputs: { model: [compileSrc, 0], shift: 5 } };
  // Mirrors the template: BasicScheduler taps the LoRA'd model BEFORE ModelSamplingSD3.
  wf["18"] = { class_type: "BasicScheduler", inputs: { model: [modelSrc, 0], scheduler: "simple", steps, denoise: 1 } };

  let acc = null, prevOut = null;
  segs.forEach((sg, k) => {
    const b = scail2SegBase(k);
    const F = String(b), R = String(b + 1), G = String(b + 2), T = String(b + 3),
          MK = String(b + 4), S = String(b + 5), K = String(b + 6), D = String(b + 7);
    // The pose offset is applied by taking only this window OF the source; the node's own
    // video_frame_offset stays 0 (exactly what the template does). Both forms below hand
    // the same frames to [F, 0] as an IMAGE batch, so nothing downstream changes.
    wf[F] = stream
      ? { class_type: "VHS_LoadVideo", inputs: { video: videoName, force_rate: 0, custom_width: 0, custom_height: 0, frame_load_cap: sg.length, skip_first_frames: sg.offset, select_every_nth: 1, format: "None" } }
      : { class_type: "ImageFromBatch", inputs: { image: ["15", 0], batch_index: sg.offset, length: sg.length } };
    wf[R] = { class_type: "ImageScale", inputs: { image: [F, 0], upscale_method: "area", width, height, crop: "center" } };
    // Size + length come from the RESIZED slice, so a short tail segment self-corrects.
    wf[G] = { class_type: "GetImageSize", inputs: { image: [R, 0] } };
    wf[T] = { class_type: "SAM3_VideoTrack", inputs: { images: [R, 0], model: ["20", 0], detection_threshold: detThresh, max_objects: maxObj, detect_interval: 1, conditioning: ["21", 0] } };
    wf[MK] = { class_type: "SCAIL2ColoredMask", inputs: { driving_track_data: [T, 0], ref_track_data: ["23", 0], object_indices: indices, sort_by: sort, replacement_mode: replace } };
    const si = {
      positive: ["8", 0], negative: ["9", 0], vae: ["6", 0],
      pose_video: [R, 0], pose_video_mask: [MK, 0],
      reference_image: refBatch, reference_image_mask: [MK, 1],
      clip_vision_output: ["11", 0],
      width: [G, 0], height: [G, 1], length: [G, 2],
      batch_size: 1, pose_strength: pStrength, pose_start: pStart, pose_end: pEnd,
      video_frame_offset: 0, previous_frame_count: SCAIL2_OVERLAP, replacement_mode: replace,
    };
    if (k > 0) si.previous_frames = prevOut;
    wf[S] = { class_type: "WanSCAILToVideo", inputs: si };
    wf[K] = { class_type: "SamplerCustom", inputs: { model: ["4", 0], add_noise: true, noise_seed: seed, cfg, positive: [S, 0], negative: [S, 1], sampler: ["27", 0], sigmas: ["18", 0], latent_image: [S, 2] } };
    wf[D] = { class_type: "VAEDecode", inputs: { samples: [K, 1], vae: ["6", 0] } };
    let out = [D, 0];
    if (k > 0) {
      // Drop the regenerated overlap, then colour-match to the previous segment's
      // last frame so the join can't drift in exposure/tint.
      const C1 = String(b + 8), P1 = String(b + 9), CT = String(b + 10);
      wf[C1] = { class_type: "ImageFromBatch", inputs: { image: [D, 0], batch_index: SCAIL2_OVERLAP, length: 4096 } };
      wf[P1] = { class_type: "ImageFromBatch", inputs: { image: prevOut, batch_index: -1, length: 1 } };
      wf[CT] = { class_type: "ColorTransfer", inputs: { image_target: [C1, 0], image_ref: [P1, 0], method: "reinhard_lab", source_stats: "per_frame", strength: 1 } };
      out = [CT, 0];
    }
    if (incrementalSave) {
      // Write this window NOW, silent, at the source fps. `out` is the only reference
      // to its decoded frames, so once this CreateVideo has run they can be collected
      // instead of being pinned until the end of the graph. No audio here: one
      // soundtrack is laid over the concatenated result by the app (see the header).
      const CV = String(b + 12), SV = String(b + 13);
      wf[CV] = { class_type: "CreateVideo", inputs: { images: out, fps: fpsRef } };
      wf[SV] = { class_type: "SaveVideo", inputs: { video: [CV, 0], filename_prefix: "heykoko_scail2", format: "auto", codec: "auto" } };
    } else if (k === 0) acc = out;
    else { const B = String(b + 11); wf[B] = { class_type: "ImageBatch", inputs: { image1: acc, image2: out } }; acc = [B, 0]; }
    prevOut = out;
  });
  // Legacy single-output path (⚙ "incremental save" off): one CreateVideo over an
  // ImageBatch of every segment — the output keeps the SOURCE fps + audio. Correct, and
  // fine for a clip of a few windows; it is the accumulation that cannot scale.
  if (!incrementalSave) {
    wf["90"] = { class_type: "CreateVideo", inputs: { images: acc, audio: ["15", 1], fps: ["15", 2] } };
    wf["91"] = { class_type: "SaveVideo", inputs: { video: ["90", 0], filename_prefix: "heykoko_scail2", format: "auto", codec: "auto" } };
  }
  return wf;
}

// Wan 2.2 Animate — MOVE mode (pose transfer). A reference person image + a source
// video → the character performs the video's motion. Flattened from the official
// "Wan2.2 14B Animate" template (Move = no background_video / character_mask).
// For a source longer than one pass, the graph CHAINS N chunks IN-GRAPH (the
// template's "Video Extend" mechanism, LIVE-VERIFIED seamless): chunk 0 runs at
// video_frame_offset 0; each later chunk feeds the PREVIOUS chunk's frames into
// continue_motion (the node uses the last continue_motion_max_frames=5 and trims the
// regenerated overlap via trim_latent/trim_image) and takes the previous chunk's
// video_frame_offset OUTPUT as its seek.
//
// INCREMENTAL SAVE (default) writes each chunk to disk as it finishes instead of
// ImageBatch-accumulating every decoded frame for one final CreateVideo — the same
// output-side fix as buildScail2, and the app joins the clips and muxes the source audio.
// It fixes ONLY the output side. Animate's INPUT side keeps the entire source resident in
// four nodes (15 decode at source res, 13 scaled, 16+17 DWPose over the whole clip; Replace
// adds 33 mask + 34 blacked background) — for a 110s/720p source that is ~64 GiB for Move
// and ~80 GiB for Replace before a single frame is generated, and no per-chunk save can
// touch it. SCAIL-2's per-window source reader does NOT port here: chunk k's seek is
// `video_frame_offset: [prevChunk, 5]`, a RUNTIME output of the previous chunk (continue_motion
// trimming changes how many frames it actually consumed), so there is no static offset to
// hand a windowed loader. Lifting that needs the chunks split across PROMPTS. `chunks` = [{offset,length}, …] (length 1 =
// single pass). Two LoRAs (lightx2v distill 6-step turbo + relight); ModelSamplingSD3
// shift 8; optional torch.compile.
// SAM2 positive-seed point for Replace mode. maskPoint = {x,y} normalized 0–1 (the
// user's ⚙ click on the source) → pixel coords in the scaled frame; falls back to
// the frame CENTER (works for a roughly-centered subject) when absent/out of range.
function animateSeedPoint(maskPoint, width, height) {
  const f = (v) => (typeof v === "number" && v >= 0 && v <= 1);
  const x = (maskPoint && f(maskPoint.x)) ? Math.round(maskPoint.x * width) : Math.round(width / 2);
  const y = (maskPoint && f(maskPoint.y)) ? Math.round(maskPoint.y * height) : Math.round(height / 2);
  return JSON.stringify([{ x, y }]);
}

function buildWanAnimate({ model, prompt, negative, comp, videoName, refImageName, width, height, seed, fps, torchCompile = false, chunks, replace = false, relightStrength = 1, maskPoint = null, incrementalSave = true }) {
  const neg = negative && negative.trim() ? negative : WAN_DEFAULT_NEGATIVE;
  // Relight LoRA strength: how hard the character is re-lit to match the scene
  // (0 = keep the reference image's own lighting, 1 = full default). Clamped 0–2.
  const relight = (typeof relightStrength === "number" && relightStrength >= 0 && relightStrength <= 2) ? relightStrength : 1;
  const segs = (Array.isArray(chunks) && chunks.length) ? chunks : [{ offset: 0, length: 77 }];
  const dw = (face) => ({
    class_type: "DWPreprocessor",
    inputs: {
      image: ["13", 0], resolution: ["14", 0],
      detect_hand: face ? "disable" : "enable",
      detect_body: face ? "disable" : "enable",
      detect_face: face ? "enable" : "disable",
      bbox_detector: "yolox_l.onnx",
      pose_estimator: "dw-ll_ucoco_384_bs5.torchscript.pt",
      scale_stick_for_xinsr_cn: "disable",
    },
  });
  // Optional torch.compile (comfy-core TorchCompileModel / inductor) between the
  // relight LoRA and ModelSamplingSD3 — ~20–30% faster after a one-time per-shape compile.
  const samplingSrc = torchCompile ? "25" : "3";
  // Shared loaders + source preprocessing (DWPose pose/face from the full source).
  const wf = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: model, weight_dtype: "default" } },
    "2": { class_type: "LoraLoaderModelOnly", inputs: { model: ["1", 0], lora_name: comp.loraSpeed, strength_model: 1 } },
    "3": { class_type: "LoraLoaderModelOnly", inputs: { model: ["2", 0], lora_name: comp.loraRelight, strength_model: relight } },
    "4": { class_type: "ModelSamplingSD3", inputs: { model: [samplingSrc, 0], shift: 8 } },
    "5": { class_type: "CLIPLoader", inputs: { clip_name: comp.clip, type: "wan", device: "default" } },
    "6": { class_type: "VAELoader", inputs: { vae_name: comp.vae } },
    "7": { class_type: "CLIPVisionLoader", inputs: { clip_name: comp.clipVision } },
    "8": { class_type: "CLIPTextEncode", inputs: { clip: ["5", 0], text: prompt } },
    "9": { class_type: "CLIPTextEncode", inputs: { clip: ["5", 0], text: neg } },
    "10": { class_type: "LoadImage", inputs: { image: refImageName } },
    "11": { class_type: "CLIPVisionEncode", inputs: { clip_vision: ["7", 0], image: ["10", 0], crop: "none" } },
    "12": { class_type: "LoadVideo", inputs: { file: videoName } },
    "15": { class_type: "GetVideoComponents", inputs: { video: ["12", 0] } },
    "13": { class_type: "ImageScale", inputs: { image: ["15", 0], upscale_method: "lanczos", width, height, crop: "center" } },
    "14": { class_type: "PixelPerfectResolution", inputs: { original_image: ["15", 0], image_gen_width: width, image_gen_height: height, resize_mode: "Just Resize" } },
    "16": dw(true),  // face_video
    "17": dw(false), // pose_video (body + hands)
  };
  if (torchCompile) wf["25"] = { class_type: "TorchCompileModel", inputs: { model: ["3", 0], backend: "inductor" } };
  // REPLACE mode: composite the new character back into the SOURCE scene instead of a
  // clean background. Per the official Animate template:
  //  • character_mask  = SAM2 person mask → GrowMask(10) → BlockifyMask(32) (coarse blocks)
  //  • background_video = source frames with the person region painted BLACK (DrawMaskOnImage)
  // SAM2 runs locally (no cloud matte → keeps the privacy guarantee). The person is
  // auto-seeded with a single positive point at frame CENTER (the template's default —
  // works for a roughly-centered subject; a tracked video SAM2 model propagates it).
  // Both feed the SAME full-length nodes; WanAnimateToVideo slices them per chunk by
  // (video_frame_offset, length), exactly like face_video / pose_video.
  if (replace) {
    const centerPt = animateSeedPoint(maskPoint, width, height);
    wf["30"] = { class_type: "DownloadAndLoadSAM2Model", inputs: { model: "sam2_hiera_base_plus.safetensors", segmentor: "video", device: "cuda", precision: "fp16" } };
    wf["31"] = { class_type: "Sam2Segmentation", inputs: { sam2_model: ["30", 0], image: ["13", 0], keep_model_loaded: false, coordinates_positive: centerPt } };
    wf["32"] = { class_type: "GrowMask", inputs: { mask: ["31", 0], expand: 10, tapered_corners: true } };
    wf["33"] = { class_type: "BlockifyMask", inputs: { masks: ["32", 0], block_size: 32 } };
    wf["34"] = { class_type: "DrawMaskOnImage", inputs: { image: ["13", 0], mask: ["33", 0], color: "0, 0, 0" } };
  }
  // Per-chunk: WanAnimateToVideo → KSampler → TrimVideoLatent → VAEDecode → ImageFromBatch.
  // Chunk k>0 continues from chunk k-1 (continue_motion + chained video_frame_offset).
  let accFrames = null;   // [nodeId, 0] of frames accumulated so far (ImageBatch)
  let prevAnim = null, prevFrames = null;
  segs.forEach((ck, k) => {
    const b = animateSegBase(k);
    const A = String(b), S = String(b + 1), T = String(b + 2), D = String(b + 3), F = String(b + 4);
    const animInputs = { positive: ["8", 0], negative: ["9", 0], vae: ["6", 0], clip_vision_output: ["11", 0], reference_image: ["10", 0], face_video: ["16", 0], pose_video: ["17", 0], width, height, length: ck.length, batch_size: 1, continue_motion_max_frames: 5, video_frame_offset: k === 0 ? 0 : [prevAnim, 5] };
    if (replace) { animInputs.background_video = ["34", 0]; animInputs.character_mask = ["33", 0]; }
    if (k > 0) animInputs.continue_motion = [prevFrames, 0]; // prev chunk's frames (node uses last 5)
    wf[A] = { class_type: "WanAnimateToVideo", inputs: animInputs };
    wf[S] = { class_type: "KSampler", inputs: { model: ["4", 0], positive: [A, 0], negative: [A, 1], latent_image: [A, 2], seed, steps: 6, cfg: 1, sampler_name: "euler", scheduler: "simple", denoise: 1 } };
    wf[T] = { class_type: "TrimVideoLatent", inputs: { samples: [S, 0], trim_amount: [A, 3] } };
    wf[D] = { class_type: "VAEDecode", inputs: { samples: [T, 0], vae: ["6", 0] } };
    wf[F] = { class_type: "ImageFromBatch", inputs: { image: [D, 0], batch_index: [A, 4], length: 4096 } };
    if (incrementalSave) {
      // Write this chunk NOW, silent, at the source fps — its decoded frames stop being
      // pinned until the end of the graph. Identical in shape to buildScail2's incremental
      // tail (only the node stride differs), and the app joins the clips and lays the
      // soundtrack over them the same way. NOTE this fixes the OUTPUT side only: Animate's
      // input side keeps the whole source resident in FOUR nodes (15 decode, 13 scale, 16/17
      // DWPose; Replace adds 33/34), which no per-chunk save can touch — see the header.
      const CV = String(b + 6), SV = String(b + 7);
      wf[CV] = { class_type: "CreateVideo", inputs: { images: [F, 0], fps: ["15", 2] } };
      wf[SV] = { class_type: "SaveVideo", inputs: { video: [CV, 0], filename_prefix: "heykoko_animate", format: "auto", codec: "auto" } };
    } else if (k === 0) accFrames = [F, 0];
    else { const B = String(b + 5); wf[B] = { class_type: "ImageBatch", inputs: { image1: accFrames, image2: [F, 0] } }; accFrames = [B, 0]; }
    prevAnim = A; prevFrames = F;
  });
  // Legacy single-output tail (⚙ "Long-clip memory" = Off): one CreateVideo over an
  // ImageBatch of every chunk, keeping the SOURCE fps+audio. Correct, but the accumulation
  // is what cannot scale.
  if (!incrementalSave) {
    wf["90"] = { class_type: "CreateVideo", inputs: { images: accFrames, audio: ["15", 1], fps: ["15", 2] } };
    wf["91"] = { class_type: "SaveVideo", inputs: { video: ["90", 0], filename_prefix: "heykoko_animate", format: "auto", codec: "auto" } };
  }
  return wf;
}

// Wan Animate SINGLE-FRAME (still pose transfer). Reference CHARACTER image + a POSE
// IMAGE → the character posed like the pose image, as ONE still. Same model/pipeline
// as Move but the source is a LoadImage (not a video), ending in SaveImage.
// LIVE-VERIFIED gotcha: length 1 ANCHORS to the reference (the target pose does NOT
// transfer — frame 0 ≈ the reference). So we hold the target pose for STILL_FRAMES
// (RepeatImageBatch the DWPose output) and take the LAST decoded frame, by which point
// the character has settled INTO the pose. Output size follows the pose image.
const STILL_FRAMES = 9; // 4n+1; verified N=9 fully adopts the pose, N=1 does not
function buildWanAnimateStill({ model, prompt, negative, comp, poseImageName, refImageName, width, height, seed, torchCompile = false, relightStrength = 1, replace = false, maskPoint = null }) {
  const neg = negative && negative.trim() ? negative : WAN_DEFAULT_NEGATIVE;
  const relight = (typeof relightStrength === "number" && relightStrength >= 0 && relightStrength <= 2) ? relightStrength : 1;
  const dw = (face) => ({
    class_type: "DWPreprocessor",
    inputs: {
      image: ["13", 0], resolution: ["14", 0],
      detect_hand: face ? "disable" : "enable",
      detect_body: face ? "disable" : "enable",
      detect_face: face ? "enable" : "disable",
      bbox_detector: "yolox_l.onnx",
      pose_estimator: "dw-ll_ucoco_384_bs5.torchscript.pt",
      scale_stick_for_xinsr_cn: "disable",
    },
  });
  const samplingSrc = torchCompile ? "25" : "3";
  const wf = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: model, weight_dtype: "default" } },
    "2": { class_type: "LoraLoaderModelOnly", inputs: { model: ["1", 0], lora_name: comp.loraSpeed, strength_model: 1 } },
    "3": { class_type: "LoraLoaderModelOnly", inputs: { model: ["2", 0], lora_name: comp.loraRelight, strength_model: relight } },
    "4": { class_type: "ModelSamplingSD3", inputs: { model: [samplingSrc, 0], shift: 8 } },
    "5": { class_type: "CLIPLoader", inputs: { clip_name: comp.clip, type: "wan", device: "default" } },
    "6": { class_type: "VAELoader", inputs: { vae_name: comp.vae } },
    "7": { class_type: "CLIPVisionLoader", inputs: { clip_name: comp.clipVision } },
    "8": { class_type: "CLIPTextEncode", inputs: { clip: ["5", 0], text: prompt } },
    "9": { class_type: "CLIPTextEncode", inputs: { clip: ["5", 0], text: neg } },
    "10": { class_type: "LoadImage", inputs: { image: refImageName } },  // reference character
    "11": { class_type: "CLIPVisionEncode", inputs: { clip_vision: ["7", 0], image: ["10", 0], crop: "none" } },
    "12": { class_type: "LoadImage", inputs: { image: poseImageName } }, // pose source (a still)
    "13": { class_type: "ImageScale", inputs: { image: ["12", 0], upscale_method: "lanczos", width, height, crop: "center" } },
    "14": { class_type: "PixelPerfectResolution", inputs: { original_image: ["12", 0], image_gen_width: width, image_gen_height: height, resize_mode: "Just Resize" } },
    "16": dw(true),  // face (1 frame)
    "17": dw(false), // pose (body + hands, 1 frame)
    // Hold the single target pose for STILL_FRAMES so the model can settle into it.
    "16r": { class_type: "RepeatImageBatch", inputs: { image: ["16", 0], amount: STILL_FRAMES } },
    "17r": { class_type: "RepeatImageBatch", inputs: { image: ["17", 0], amount: STILL_FRAMES } },
    "18": { class_type: "WanAnimateToVideo", inputs: { positive: ["8", 0], negative: ["9", 0], vae: ["6", 0], clip_vision_output: ["11", 0], reference_image: ["10", 0], face_video: ["16r", 0], pose_video: ["17r", 0], width, height, length: STILL_FRAMES, batch_size: 1, continue_motion_max_frames: 5, video_frame_offset: 0 } },
    "19": { class_type: "KSampler", inputs: { model: ["4", 0], positive: ["18", 0], negative: ["18", 1], latent_image: ["18", 2], seed, steps: 6, cfg: 1, sampler_name: "euler", scheduler: "simple", denoise: 1 } },
    "20": { class_type: "TrimVideoLatent", inputs: { samples: ["19", 0], trim_amount: ["18", 3] } },
    "21": { class_type: "VAEDecode", inputs: { samples: ["20", 0], vae: ["6", 0] } },
    // Take the LAST frame — by then the character has fully adopted the target pose.
    "22": { class_type: "ImageFromBatch", inputs: { image: ["21", 0], batch_index: STILL_FRAMES - 1, length: 1 } },
    "23": { class_type: "SaveImage", inputs: { images: ["22", 0], filename_prefix: "heykoko_animate_still" } },
  };
  if (torchCompile) wf["25"] = { class_type: "TorchCompileModel", inputs: { model: ["3", 0], backend: "inductor" } };
  // REPLACE still: image[0] is a SCENE (a person to swap out + a background to keep),
  // not just a pose. Same as video Replace but the "source" is the single scene image
  // held for STILL_FRAMES: SAM2 center-point mask → Grow(10) → Blockify(32) = character_mask;
  // DrawMaskOnImage blacks the person out = background_video. The character is composited
  // into the scene at the person's pose+position; take the last settled frame.
  if (replace) {
    const centerPt = animateSeedPoint(maskPoint, width, height);
    wf["13r"] = { class_type: "RepeatImageBatch", inputs: { image: ["13", 0], amount: STILL_FRAMES } };
    wf["30"] = { class_type: "DownloadAndLoadSAM2Model", inputs: { model: "sam2_hiera_base_plus.safetensors", segmentor: "video", device: "cuda", precision: "fp16" } };
    wf["31"] = { class_type: "Sam2Segmentation", inputs: { sam2_model: ["30", 0], image: ["13r", 0], keep_model_loaded: false, coordinates_positive: centerPt } };
    wf["32"] = { class_type: "GrowMask", inputs: { mask: ["31", 0], expand: 10, tapered_corners: true } };
    wf["33"] = { class_type: "BlockifyMask", inputs: { masks: ["32", 0], block_size: 32 } };
    wf["34"] = { class_type: "DrawMaskOnImage", inputs: { image: ["13r", 0], mask: ["33", 0], color: "0, 0, 0" } };
    wf["18"].inputs.background_video = ["34", 0];
    wf["18"].inputs.character_mask = ["33", 0];
  }
  return wf;
}

// Parse intrinsic pixel dimensions from a base64 PNG/JPEG without an image lib.
// Used to match a video's aspect ratio to the i2v conditioning image.
// ── 3D mesh builders ─────────────────────────────────────────────────────────
// Hunyuan3D 2.1 image→mesh (untextured GLB). Port of the official
// `3d_hunyuan3d-v2.1` template: the checkpoint bundles the CLIP-vision encoder and
// the shape VAE, conditioning is image-only (no text encoder anywhere), and the
// sampled latent decodes to a VOXEL grid that surface-net triangulates into a mesh.
//
// The template feeds it a pre-cut-out image, which is why it has no preprocessing —
// and why a plain PHOTO must not be fed in raw: the model reconstructs whatever it
// sees, so a real background comes out as a giant flat SLAB with the subject as a
// bump on it (measured: same photo, 7.5 MB slab raw vs 0.7 MB clean object after
// removal). So the subject is cut out and composited on white first.
//
// Framing matters nearly as much: a subject filling a quarter of the frame decodes
// with a shattered, noisy surface. Cropping to the subject before conditioning
// (autoCrop) fixed exactly that in the same A/B.
//
// paint appends the PBR texturing chain (see PAINT_NODES): the shape half is
// unchanged, its MESH is bridged to the wrapper's TRIMESH world, UV-unwrapped,
// rendered from six fixed views, repainted by the paint model, baked back into an
// albedo + metallic-roughness atlas, and exported as a textured GLB.
function buildHunyuan3D({ ckpt, imageName, seed, steps = 30, cfg = 5, sampler = "euler", scheduler = "normal", resolution = 4096, numChunks = 8000, octreeRes = 256, threshold = 0.6, bgRemoval = null, autoCrop = false, maskName = null, paint = false, paintPrefix = "", paintViews = 768, paintSteps = 10, textureSize = 1024, maxFacenum = 40000 }) {
  // What the CLIP-vision encoder actually sees — the raw image only when there is
  // no background remover installed to prepare it.
  let condImage = ["2", 0];
  const prep = {};
  // A hand-painted mask REPLACES background removal: the user has already said
  // exactly what the subject is, so running BiRefNet on top could only disagree
  // with them. Everything downstream (white plate, composite, crop) is identical —
  // only where the mask comes from changes.
  if (maskName || bgRemoval) {
    if (maskName) {
      prep["12"] = { class_type: "LoadImageMask", inputs: { image: maskName, channel: "red" } }; // painted = subject
    } else {
      prep["11"] = { class_type: "LoadBackgroundRemovalModel", inputs: { bg_removal_name: bgRemoval } };
      prep["12"] = { class_type: "RemoveBackground", inputs: { bg_removal_model: ["11", 0], image: ["2", 0] } }; // MASK: 1 = subject
    }
    // Size the white plate from the image itself rather than parsing it server-side,
    // so it works for any format ComfyUI can load (webp, avif…).
    prep["17"] = { class_type: "GetImageSize", inputs: { image: ["2", 0] } };
    prep["13"] = { class_type: "EmptyImage", inputs: { width: ["17", 0], height: ["17", 1], batch_size: 1, color: 0xffffff } };
    prep["14"] = { class_type: "ImageCompositeMasked", inputs: { destination: ["13", 0], source: ["2", 0], x: 0, y: 0, resize_source: false, mask: ["12", 0] } };
    condImage = ["14", 0];
    if (autoCrop) {
      prep["16"] = { class_type: "ImageCropByMaskAndResize", inputs: { image: ["14", 0], mask: ["12", 0], base_resolution: 1024, padding: 64, min_crop_resolution: 128, max_crop_resolution: 2048 } };
      condImage = ["16", 0];
    }
  }
  // Texturing tail. Numbered from 20 because 1–10 is the shape chain and 11–17 the
  // optional preprocessing. SaveGLB (node 10) is dropped when painting — core
  // SaveGLB only serialises vertices/faces/vertex-colours, so routing the painted
  // TRIMESH back through TrimeshToMESH would silently strip the atlas; the wrapper's
  // own exporter is the only thing that writes the textures out.
  const paintTail = {};
  if (paint) {
    paintTail["20"] = { class_type: "MESHToTrimesh", inputs: { mesh: ["9", 0] } };
    paintTail["21"] = { class_type: "Hy3D21PostprocessMesh", inputs: { trimesh: ["20", 0], remove_floaters: true, remove_degenerate_faces: true, reduce_faces: true, max_facenum: maxFacenum, smooth_normals: false } };
    paintTail["22"] = { class_type: "Hy3D21MeshUVWrap", inputs: { trimesh: ["21", 0] } };
    // Six views: four around the equator plus top and bottom. The weights favour
    // front/back over the profiles, which is the wrapper's own recommended set.
    paintTail["23"] = { class_type: "Hy3D21CameraConfig", inputs: { camera_azimuths: "0, 90, 180, 270, 0, 180", camera_elevations: "0, 0, 0, 0, 90, -90", view_weights: "1, 0.5, 1, 0.5, 1, 1", ortho_scale: 1.1 } };
    // The reference image is the SAME one the shape model saw (cut out and framed),
    // so the paint model isn't asked to match colours from a different crop.
    paintTail["24"] = { class_type: "Hy3DMultiViewsGenerator", inputs: { trimesh: ["22", 0], camera_config: ["23", 0], view_size: paintViews, image: condImage, steps: paintSteps, guidance_scale: 3, texture_size: textureSize, unwrap_mesh: false, seed } };
    paintTail["25"] = { class_type: "Hy3DBakeMultiViews", inputs: { pipeline: ["24", 0], camera_config: ["23", 0], albedo: ["24", 1], mr: ["24", 2] } };
    paintTail["26"] = { class_type: "Hy3DInPaint", inputs: { pipeline: ["25", 0], albedo: ["25", 1], albedo_mask: ["25", 2], mr: ["25", 3], mr_mask: ["25", 4], output_mesh_name: "heykoko_paint" } };
    paintTail["27"] = { class_type: "Hy3D21ExportMesh", inputs: { trimesh: ["26", 2], filename_prefix: paintPrefix, file_format: "glb", save_file: true } };
  }
  return {
    ...prep,
    ...paintTail,
    "1": { class_type: "ImageOnlyCheckpointLoader", inputs: { ckpt_name: ckpt } },
    "2": { class_type: "LoadImage", inputs: { image: imageName } },
    "3": { class_type: "CLIPVisionEncode", inputs: { clip_vision: ["1", 1], image: condImage, crop: "center" } },
    "4": { class_type: "Hunyuan3Dv2Conditioning", inputs: { clip_vision_output: ["3", 0] } },
    "5": { class_type: "EmptyLatentHunyuan3Dv2", inputs: { resolution, batch_size: 1 } },
    "6": { class_type: "ModelSamplingAuraFlow", inputs: { model: ["1", 0], shift: 1 } },
    "7": { class_type: "KSampler", inputs: { model: ["6", 0], positive: ["4", 0], negative: ["4", 1], latent_image: ["5", 0], seed, steps, cfg, sampler_name: sampler, scheduler, denoise: 1 } },
    "8": { class_type: "VAEDecodeHunyuan3D", inputs: { samples: ["7", 0], vae: ["1", 2], num_chunks: numChunks, octree_resolution: octreeRes } },
    "9": { class_type: "VoxelToMesh", inputs: { voxel: ["8", 0], algorithm: "surface net", threshold } },
    ...(paint ? {} : { "10": { class_type: "SaveGLB", inputs: { mesh: ["9", 0], filename_prefix: `${OUT_3D}/mesh` } } }),
  };
}

// MoGe-2 photo→textured scene mesh (geometry ESTIMATION — no sampler, no prompt).
// Flattened from the `3d_moge_perspective_to_mesh` template's subgraph; its
// resize-if-wider-than-2048 switch is replicated server-side (needsResize decided
// from imageDims), so no Switch/Math nodes enter the API graph.
//
// decimation deliberately deviates from the template's 1: at resolution_level 9 an
// undecimated point-map mesh is millions of triangles → a 50–150 MB GLB riding a
// base64 JSON response and chat persistence. 2 quarters the triangle count.
//
// Subject-only mode (a painted mask, or the ⚙ box) reuses Hunyuan3D's cut-out
// preprocessing, and it works for a reason worth writing down: MoGe has no mask
// input, but apply_mask sets its OWN predicted invalid regions to inf so meshing
// culls them — and a flat white plate reads as exactly that. Measured on one photo:
// raw → 475k faces spanning 26×19×113 (a scene slab with the subject buried in it);
// the same photo cut out on white → 11k faces at 1.4×1.1×0.4, subject only, no
// backdrop plane anywhere. Cropping to the subject afterwards spends the pixels on
// the subject instead of the plate (68k faces at the same extents).
function buildMoGeMesh({ modelName, imageName, resolutionLevel = 9, decimation = 2, texture = true, needsResize = false, bgRemoval = null, maskName = null, autoCrop = false, fovX = 0 }) {
  const g = {
    "1": { class_type: "LoadImage", inputs: { image: imageName } },
    "3": { class_type: "LoadMoGeModel", inputs: { model_name: modelName } },
    "5": { class_type: "MoGePointMapToMesh", inputs: { moge_geometry: ["4", 0], batch_index: 0, decimation, discontinuity_threshold: 0.04, texture } },
    "6": { class_type: "SaveGLB", inputs: { mesh: ["5", 0], filename_prefix: `${OUT_3D}/mesh` } },
  };
  if (needsResize) g["2"] = { class_type: "ResizeImagesByLongerEdge", inputs: { images: ["1", 0], longer_edge: 2048 } };
  // Everything downstream reads whatever the resize guard left as "the image".
  const base = [needsResize ? "2" : "1", 0];
  let inferImage = base;
  if (maskName || bgRemoval) {
    if (maskName) {
      g["12"] = { class_type: "LoadImageMask", inputs: { image: maskName, channel: "red" } };
    } else {
      g["11"] = { class_type: "LoadBackgroundRemovalModel", inputs: { bg_removal_name: bgRemoval } };
      g["12"] = { class_type: "RemoveBackground", inputs: { bg_removal_model: ["11", 0], image: base } };
    }
    g["17"] = { class_type: "GetImageSize", inputs: { image: base } };
    g["13"] = { class_type: "EmptyImage", inputs: { width: ["17", 0], height: ["17", 1], batch_size: 1, color: 0xffffff } };
    g["14"] = { class_type: "ImageCompositeMasked", inputs: { destination: ["13", 0], source: base, x: 0, y: 0, resize_source: false, mask: ["12", 0] } };
    inferImage = ["14", 0];
    if (autoCrop) {
      g["16"] = { class_type: "ImageCropByMaskAndResize", inputs: { image: ["14", 0], mask: ["12", 0], base_resolution: 1024, padding: 64, min_crop_resolution: 128, max_crop_resolution: 2048 } };
      inferImage = ["16", 0];
    }
  }
  // fov_x_degrees 0 = recover the focal length from the predicted points, which is
  // right for an ordinary photo. It matters for a phone SWEEP panorama: that is a
  // cylindrical strip, and a pinhole model cannot hold one, so the solve squashes
  // it. Measured on a 216°-wide sweep — auto fitted a 105° cone, 120 opened it to
  // 121° and still held together, 150 tore the mesh apart and 170 blew the depth
  // range from 18× to 159×. A nudge near the automatic value, not a dial to crank.
  g["4"] = { class_type: "MoGeInference", inputs: { moge_model: ["3", 0], image: inferImage, resolution_level: resolutionLevel, fov_x_degrees: fovX, batch_size: 1, force_projection: true, apply_mask: true } };
  return g;
}

// Text (or a photo) → a 360° equirectangular panorama whose left and right edges
// actually MEET.
//
// An ordinary checkpoint asked for an "equirectangular panorama" at 2:1 produces a
// convincing image, but not a wrapping one: rolled by half its width a join appears
// down the middle. Measured as the edge mismatch over what two genuinely adjacent
// columns differ by (1.00 = a perfect wrap): z-image 3.82, flux 1.99 — plausible,
// still visibly broken where the ends meet.
//
// So generate, then repair: roll by half so the join sits in the middle, regenerate
// a band across it, and roll back. Rolling twice by half restores the framing, which
// leaves the repaired strip split across the two edges — where they have to agree.
// Measured after: 0.99.
//
// Two traps, both found the hard way:
//   • FeatherMask fades in from the mask's OWN OUTER EDGES. Feathering the full-size
//     mask does nothing (its border is already black) — the band must be feathered
//     while it is still a small standalone mask, then composited in.
//   • noise_mask alone still lets the decode shift the tone of the whole frame, which
//     showed up as two vertical brightness steps in the sky. The repair is composited
//     back over the original through the same feathered mask to blend that away.
//
// With `imageName` the panorama is grown from a PHOTO instead of from nothing. The
// client has already reprojected it onto the sphere (public/js/equirect.js): what
// arrives is a full-size equirect whose alpha marks the ~90% that has to be invented,
// with that region pre-filled by smearing the photo's own border outwards.
//
// Three things about that stage were established by measurement, not by reasoning:
//   • InpaintModelConditioning cannot be used here. It greys out the masked pixels
//     before encoding, so the pre-fill is discarded and — with a plain checkpoint,
//     which has no inpainting channels — the sampler works from noise alone. It
//     produced a perfectly good panorama with the photo stuck on top like a sticker:
//     the step across the photo's border measured 16.9/255. VAEEncode +
//     SetLatentNoiseMask keeps the pre-fill and takes that step down to 3.5.
//   • Which means `outpaintDenoise` must stay BELOW 1: at exactly 1 the noise mask
//     replaces the region outright and the sticker is back (measured identical to
//     the discarded-pre-fill case). Too low and the smear survives unresolved —
//     0.70 left it almost untouched. 0.85 resolves it while still continuing.
//   • The photo itself is composited back over the decode, so it comes through the
//     VAE round trip bit-for-bit (measured drift 0.00/255).
function buildPanorama360({ ckpt, unet, unetClip, unetClipType, unetVae, shift = 0, zeroNegative = false,
  prompt, negative = "", seed, steps = 20, cfg = 1, guidance = 3.5,
  sampler = "euler", scheduler = "simple", sd3Latent = true, width = 1536, height = 768, seamRepair = true,
  bandFrac = 1 / 3, featherFrac = 0.45, seamDenoise = 1, imageName = "", outpaintDenoise = 0.85,
  lora = "", loraStrength = 1 }) {
  // The recipe is family-agnostic: whichever checkpoint the user picked decides the
  // latent type and whether there is a guidance node at all. Hardcoding Flux's pair
  // would produce a graph that simply fails to validate on an SDXL checkpoint.
  // Two shapes of base. A CHECKPOINT bundles model + CLIP + VAE in one loader; a
  // UNET model (z-image, boogu) needs its text encoder and VAE loaded separately,
  // and rides a shift node. Everything after this point works off the same three
  // references, so the rest of the recipe never learns which it got.
  const g = {};
  let MODEL, CLIP, VAE;
  if (unet) {
    g["1"] = { class_type: "UNETLoader", inputs: { unet_name: unet, weight_dtype: "default" } };
    g["1b"] = { class_type: "CLIPLoader", inputs: { clip_name: unetClip, type: unetClipType, device: "default" } };
    g["1c"] = { class_type: "VAELoader", inputs: { vae_name: unetVae } };
    MODEL = ["1", 0]; CLIP = ["1b", 0]; VAE = ["1c", 0];
  } else {
    g["1"] = { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: ckpt } };
    MODEL = ["1", 0]; CLIP = ["1", 1]; VAE = ["1", 2];
  }
  // An equirectangular LoRA, if the user has one. It goes on before the sampling
  // shift — the shift is a property of how this family is sampled, not of the
  // weights, so patching a shifted model would put the two in the wrong order.
  // LoraLoader patches CLIP as well as the model: a LoRA with no text-encoder keys
  // simply leaves it alone, so this covers both kinds without a second node type.
  if (lora) {
    g["1e"] = { class_type: "LoraLoader", inputs: { model: MODEL, clip: CLIP,
      lora_name: lora, strength_model: loraStrength, strength_clip: loraStrength } };
    MODEL = ["1e", 0]; CLIP = ["1e", 1];
  }
  if (unet && shift) {
    g["1d"] = { class_type: "ModelSamplingAuraFlow", inputs: { model: MODEL, shift } };
    MODEL = ["1d", 0];
  }
  g["2"] = { class_type: "CLIPTextEncode", inputs: { clip: CLIP, text: prompt } };
  // A distilled model runs at cfg 1 with the negative ZEROED, not merely empty —
  // encoding an empty string instead measurably changes what it draws.
  g["3"] = zeroNegative
    ? { class_type: "ConditioningZeroOut", inputs: { conditioning: ["2", 0] } }
    : { class_type: "CLIPTextEncode", inputs: { clip: CLIP, text: negative } };
  g["7"] = { class_type: "VAEDecode", inputs: { samples: ["6", 0], vae: VAE } };
  // Flux-family distilled guidance rides its own node; everything else steers with
  // plain CFG and would reject the extra conditioning stage.
  let positive = ["2", 0];
  if (guidance !== null && guidance !== undefined) {
    g["4"] = { class_type: "FluxGuidance", inputs: { conditioning: ["2", 0], guidance } };
    positive = ["4", 0];
  }
  if (imageName) {
    g["40"] = { class_type: "LoadImage", inputs: { image: imageName } };
    g["41"] = { class_type: "VAEEncode", inputs: { pixels: ["40", 0], vae: VAE } };
    // LoadImage's second output is 1 − alpha: exactly "the part you must invent".
    g["42"] = { class_type: "SetLatentNoiseMask", inputs: { samples: ["41", 0], mask: ["40", 1] } };
    g["6"] = { class_type: "KSampler", inputs: { model: MODEL, positive, negative: ["3", 0],
      latent_image: ["42", 0], seed, steps, cfg, sampler_name: sampler, scheduler, denoise: outpaintDenoise } };
    g["43"] = { class_type: "ImageCompositeMasked", inputs: { destination: ["40", 0], source: ["7", 0],
      x: 0, y: 0, resize_source: false, mask: ["40", 1] } };
  } else {
    g["5"] = { class_type: sd3Latent ? "EmptySD3LatentImage" : "EmptyLatentImage", inputs: { width, height, batch_size: 1 } };
    g["6"] = { class_type: "KSampler", inputs: { model: MODEL, positive, negative: ["3", 0],
      latent_image: ["5", 0], seed, steps, cfg, sampler_name: sampler, scheduler, denoise: 1 } };
  }
  const generated = imageName ? ["43", 0] : ["7", 0];
  // Swap the two halves: crop each, stitch them back the other way round.
  const roll = (id, src) => {
    const a = String(id), b = String(id + 1), c = String(id + 2);
    g[a] = { class_type: "ImageCrop", inputs: { image: src, width: width >> 1, height, x: 0, y: 0 } };
    g[b] = { class_type: "ImageCrop", inputs: { image: src, width: width >> 1, height, x: width >> 1, y: 0 } };
    g[c] = { class_type: "ImageStitch", inputs: { image1: [b, 0], image2: [a, 0],
      direction: "right", match_image_size: false, spacing_width: 0, spacing_color: "white" } };
    return [c, 0];
  };
  // bandFrac 0 means the picture already goes most of the way round, so there is no
  // room to repair without repainting the photo — see seamBandFraction.
  if (!seamRepair || bandFrac <= 0) {
    g["99"] = { class_type: "SaveImage", inputs: { images: generated, filename_prefix: `${OUT_PANO}/pano` } };
    return g;
  }
  const band = Math.max(64, Math.round(width * bandFrac) & ~7);
  const feather = Math.max(1, Math.round(band * featherFrac));
  const rolled = roll(10, generated);
  g["20"] = { class_type: "SolidMask", inputs: { value: 0.0, width, height } };
  g["21"] = { class_type: "SolidMask", inputs: { value: 1.0, width: band, height } };
  g["22"] = { class_type: "FeatherMask", inputs: { mask: ["21", 0], left: feather, top: 0, right: feather, bottom: 0 } };
  g["23"] = { class_type: "MaskComposite", inputs: { destination: ["20", 0], source: ["22", 0],
    x: (width - band) >> 1, y: 0, operation: "add" } };
  g["24"] = { class_type: "InpaintModelConditioning", inputs: { positive, negative: ["3", 0],
    vae: VAE, pixels: rolled, mask: ["23", 0], noise_mask: true } };
  g["25"] = { class_type: "KSampler", inputs: { model: MODEL, positive: ["24", 0], negative: ["24", 1],
    latent_image: ["24", 2], seed: seed + 1, steps, cfg, sampler_name: sampler, scheduler, denoise: seamDenoise } };
  g["26"] = { class_type: "VAEDecode", inputs: { samples: ["25", 0], vae: VAE } };
  g["27"] = { class_type: "ImageCompositeMasked", inputs: { destination: rolled, source: ["26", 0],
    x: 0, y: 0, resize_source: false, mask: ["23", 0] } };
  g["99"] = { class_type: "SaveImage", inputs: { images: roll(30, ["27", 0]), filename_prefix: `${OUT_PANO}/pano` } };
  return g;
}

// MoGe equirectangular 360° panorama → one spherical mesh. Flattened from the
// `3d_moge_panorama_to_mesh` template's subgraph; its resize-if-wider-than-2048
// switch pair is replicated server-side (needsResize from imageDims) so no
// Switch/Math nodes enter the API graph, same as the perspective chain.
//
// MoGePanoramaInference splits the equirect into 12 perspective views, runs MoGe on
// each, then merges the distance maps on the CPU — that merge is the slow phase and
// its cost is set by mergeRes, not by the GPU. The template's own note warns the
// merge grid must never exceed the input's long edge, so the caller clamps it.
//
// The result is a mesh you are meant to view from INSIDE (you are standing in the
// photographed place), which is why decimation matters here more than elsewhere: at
// stride 1 a 1920-wide merge is ~1.8M vertices before it ever reaches a GLB.
// `refineTarget` sharpens the 360 VIEW, which is a texture problem, not a geometry
// one. A panorama's texture has to cover a whole turn: at 1774 px wide a 40° slice
// is 197 texels stretched over ~880 screen px — 4.5× magnification, and that is the
// softness you see standing inside it. Nothing in the chain loses those pixels (the
// baked texture is the source at full size); there simply are not enough of them.
//
// So: run the equirect through a 4× upscale model, then land it back on a chosen
// long edge. Going through the model and back down beats resampling straight to the
// same size — measured on one panorama, screen-space gradient energy 6.05 → 11.25.
//
// The catch is that MoGe's grid is inputWidth/decimation, so more pixels silently
// buy more TRIANGLES too: at 4096 the mesh went 98k → 524k verts and the GLB 6.6 →
// 34.9 MB, which is not something a chat message can carry. The caller compensates
// by raising decimation in step, holding the vertex count flat.
function buildMoGePanorama({ modelName, imageName, resolutionLevel = 9, splitRes = 512, mergeRes = 1920, batchSize = 4, decimation = 4, texture = true, needsResize = false, gapThreshold = 0, refineTarget = 0, refineModel = "", refineNeedsUpscale = true }) {
  const g = {
    "1": { class_type: "LoadImage", inputs: { image: imageName } },
    "3": { class_type: "LoadMoGeModel", inputs: { model_name: modelName } },
    "4": { class_type: "MoGePanoramaInference", inputs: { moge_model: ["3", 0], image: [needsResize ? "2" : "1", 0], resolution_level: resolutionLevel, split_resolution: splitRes, merge_resolution: mergeRes, batch_size: batchSize } },
    // discontinuity_threshold is 0 (OFF) here, unlike the perspective chain. There it
    // usefully separates the subject from the background; inside a panorama the same
    // culling punches holes in the walls and you see white voids through the world.
    "5": { class_type: "MoGePointMapToMesh", inputs: { moge_geometry: ["4", 0], batch_index: 0, decimation, discontinuity_threshold: gapThreshold, texture } },
    "6": { class_type: "SaveGLB", inputs: { mesh: ["5", 0], filename_prefix: `${OUT_3D}/mesh` } },
  };
  if (needsResize) g["2"] = { class_type: "ResizeImagesByLongerEdge", inputs: { images: ["1", 0], longer_edge: 2048 } };
  if (refineTarget && refineModel) {
    // Replaces the ≤2048 guard rather than stacking with it — refinement is a
    // deliberate decision to go ABOVE that cap, so shrinking first then enlarging
    // again would just throw the original detail away and enlarge the loss.
    let src = ["1", 0];
    // Skip the model when the source already has the pixels: a 4× pass on a large
    // equirect is 16× the area for nothing, and can run the GPU out of memory.
    if (refineNeedsUpscale) {
      g["20"] = { class_type: "UpscaleModelLoader", inputs: { model_name: refineModel } };
      g["21"] = { class_type: "ImageUpscaleWithModel", inputs: { upscale_model: ["20", 0], image: ["1", 0] } };
      src = ["21", 0];
    }
    g["22"] = { class_type: "ImageScale", inputs: { image: src, upscale_method: "lanczos", width: refineTarget, height: Math.round(refineTarget / 2), crop: "disabled" } };
    g["4"].inputs.image = ["22", 0];
    delete g["2"];
  }
  return g;
}

// TripoSplat image→Gaussian splat. Flattened from the official template's two
// nested subgraphs (link-for-link; UI-only nodes dropped: PreviewImage, the two
// ComfySwitchNodes, TripoSplatSamplingPreview live-preview wrapper, and the
// BiRefNet subgraph's JoinImageWithAlpha leg — the parent only consumes the raw
// RemoveBackground mask). Background removal is OPTIONAL: without birefnet the mask
// falls back to the input image's own alpha (the template's switch=false leg:
// InvertMask on LoadImage's mask output).
//
// The decode has ONE tail: SplatToMesh → a real triangle mesh with VERTEX COLOURS,
// saved as .glb (the template ships this branch bypassed in favour of .spz).
// The template's other two tails are deliberately gone:
//   • SplatToFile3D('spz') — nothing in this app can open a splat file, and the
//     mesh is the same object in a format the bubble's viewer renders directly.
//   • RenderSplat → CreateVideo → SaveVideo — a 75-frame turntable existed only to
//     preview the unviewable .spz. With a .glb in the bubble you can already orbit
//     the real thing, so it was rendering a video of something you can spin yourself.
function buildTripoSplat({ imageName, comp, seed, steps = 20, cfg = 3, sampler = "dpmpp_2m", scheduler = "simple", numGaussians = 262144, meshDetail = 256, maskName = null }) {
  const g = {
    "1": { class_type: "LoadImage", inputs: { image: imageName } },
    "4": { class_type: "TripoSplatPreprocessImage", inputs: { image: ["1", 0], mask: ["3", 0], erode_radius: 1, size: 1024 } },
    "5": { class_type: "CLIPVisionLoader", inputs: { clip_name: comp.dino } },
    "6": { class_type: "VAELoader", inputs: { vae_name: comp.flux2Vae } },
    "7": { class_type: "UNETLoader", inputs: { unet_name: comp.unet, weight_dtype: "default" } },
    "8": { class_type: "VAELoader", inputs: { vae_name: comp.splatVae } },
    "9": { class_type: "TripoSplatConditioning", inputs: { clip_vision: ["5", 0], vae: ["6", 0], image: ["4", 0] } },
    "10": { class_type: "KSampler", inputs: { model: ["7", 0], positive: ["9", 0], negative: ["9", 1], latent_image: ["9", 2], seed, steps, cfg, sampler_name: sampler, scheduler, denoise: 1 } },
    "11": { class_type: "VAEDecodeTripoSplat", inputs: { samples: ["10", 0], vae: ["8", 0], num_gaussians: numGaussians, seed } },
    // 12–14 were the turntable render; the ids stay free rather than renumbering a
    // graph whose wiring is otherwise a link-for-link port of the template.
    "15": { class_type: "SplatToMesh", inputs: { splat: ["11", 0], resolution: meshDetail, kernel: 5, smooth: 0, level: 0.6, min_component: 500, min_opacity: 0.02, color_sharpen: 2 } },
    "16": { class_type: "SaveGLB", inputs: { mesh: ["15", 0], filename_prefix: `${OUT_3D}/mesh` } },
  };
  // Same rule as Hunyuan3D: a painted mask outranks both the background remover and
  // the alpha fallback — it is the user pointing at the subject directly.
  if (maskName) {
    g["3"] = { class_type: "LoadImageMask", inputs: { image: maskName, channel: "red" } };
  } else if (comp.birefnet) {
    g["2"] = { class_type: "LoadBackgroundRemovalModel", inputs: { bg_removal_name: comp.birefnet } };
    g["3"] = { class_type: "RemoveBackground", inputs: { bg_removal_model: ["2", 0], image: ["1", 0] } };
  } else {
    g["3"] = { class_type: "InvertMask", inputs: { mask: ["1", 1] } };
  }
  return g;
}

// Hunyuan3D's PBR texturing chain. ComfyUI ships only the shape model, so these all
// come from the ComfyUI-Hunyuan3DWrapper custom node plus the paint weights
// (hunyuan3d-paintpbr-v2-1) — absent on a stock install, which is why every use is
// gated on this list and falls back to an untextured mesh.
const PAINT_NODES = ["MESHToTrimesh", "Hy3D21PostprocessMesh", "Hy3D21MeshUVWrap", "Hy3D21CameraConfig",
  "Hy3DMultiViewsGenerator", "Hy3DBakeMultiViews", "Hy3DInPaint", "Hy3D21ExportMesh"];

// ⚙ "Texture quality". These four have to move TOGETHER — a 4096 atlas baked from
// 768 px views is mostly interpolation, and a dense atlas on a 40 k-face mesh has
// nowhere to put the extra detail. view_size is capped at 1024 by the node itself
// (min 512, step 256), so "ultra" buys atlas size + sampling steps, not sharper
// source views. texture_size steps by 512 up to 4096.
const PAINT_TIERS = {
  standard: { textureSize: 1024, paintViews: 768, paintSteps: 10, maxFacenum: 40000 },
  fine: { textureSize: 2048, paintViews: 1024, paintSteps: 20, maxFacenum: 120000 },
  ultra: { textureSize: 4096, paintViews: 1024, paintSteps: 30, maxFacenum: 300000 },
};

// Companion files for the mesh chains, resolved off ComfyUI's own enums. Throws a
// user-actionable error naming the missing file + subfolder, same policy as
// editCompanions.
async function meshCompanions(meshType) {
  if (meshType === "hunyuan3d") {
    // The checkpoint bundles CLIP-vision + VAE, so the only companions are the
    // PREPROCESSING pieces — optional, but without them a photo's background is
    // reconstructed as a slab (see buildHunyuan3D).
    const bgs = await comfyEnum("LoadBackgroundRemovalModel", "bg_removal_name").catch(() => []);
    const weight = bgs.find((n) => /birefnet/i.test(n)) || bgs[0] || null;
    const nodesOk = weight && await comfyHasNodes(["LoadBackgroundRemovalModel", "RemoveBackground", "GetImageSize", "EmptyImage", "ImageCompositeMasked"]);
    const birefnet = nodesOk ? weight : null;
    return { birefnet, autoCrop: birefnet ? await comfyHasNodes(["ImageCropByMaskAndResize"]) : false,
      paint: await comfyHasNodes(PAINT_NODES) };
  }
  if (meshType === "moge") {
    const weights = await comfyEnum("LoadMoGeModel", "model_name").catch(() => []);
    // Prefer MoGe-2 with normals (sharper edges, metric scale); fall back to any.
    const mogeModel = weights.find((n) => /moge_2.*normal/i.test(n)) || weights[0];
    if (!mogeModel) throw new Error("MoGe weight missing: download moge_2_vitl_normal_fp16.safetensors from huggingface.co/Comfy-Org/MoGe into ComfyUI models/geometry_estimation/");
    // Optional: an ESRGAN-family upscaler for panorama refinement. Prefer a "sharp"
    // variant for architecture and text; absent one, the panorama entry simply
    // never offers refinement rather than failing on a setting the user picked.
    const ups = await comfyEnum("UpscaleModelLoader", "model_name").catch(() => []);
    const refiner = await comfyHasNodes(["UpscaleModelLoader", "ImageUpscaleWithModel", "ImageScale"])
      ? (ups.find((n) => /ultrasharp/i.test(n)) || ups.find((n) => /realesrgan/i.test(n)) || ups[0] || null)
      : null;
    return { mogeModel, refiner };
  }
  if (meshType === "triposplat") {
    const [unets, clips, vaes, bgs] = await Promise.all([
      comfyEnum("UNETLoader", "unet_name"),
      comfyEnum("CLIPVisionLoader", "clip_name").catch(() => []),
      comfyEnum("VAELoader", "vae_name").catch(() => []),
      comfyEnum("LoadBackgroundRemovalModel", "bg_removal_name").catch(() => []),
    ]);
    const unet = unets.find((n) => /triposplat/i.test(n));
    const dino = clips.find((n) => /dino_v3/i.test(n));
    const splatVae = vaes.find((n) => /triposplat.*vae|triposplat_vae_decoder/i.test(n));
    const flux2Vae = vaes.find((n) => /flux2.?vae/i.test(n));
    const missing = [];
    if (!unet) missing.push("diffusion_models/triposplat_fp16.safetensors");
    if (!dino) missing.push("clip_vision/dino_v3_vit_h.safetensors");
    if (!splatVae) missing.push("vae/triposplat_vae_decoder_fp16.safetensors");
    if (!flux2Vae) missing.push("vae/flux2-vae.safetensors");
    if (missing.length) throw new Error(`Missing TripoSplat files (huggingface.co/VAST-AI/TripoSplat):\n- ${missing.join("\n- ")}`);
    // birefnet is optional — absent, the input image's own alpha is the mask.
    return { unet, dino, splatVae, flux2Vae, birefnet: bgs.find((n) => /birefnet/i.test(n)) || null };
  }
  return {};
}

function imageDims(b64) {
  try {
    const clean = typeof b64 === "string" && b64.startsWith("data:") ? b64.split(",")[1] : b64;
    const buf = Buffer.from(clean, "base64");
    // PNG: 8-byte signature, then IHDR with width@16, height@20 (big-endian).
    if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    // JPEG: scan segment markers for a Start-Of-Frame (SOFn) that carries dims.
    if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      let o = 2;
      while (o + 9 < buf.length) {
        if (buf[o] !== 0xff) { o++; continue; }
        const m = buf[o + 1];
        // SOF0–SOF15 hold the frame size; skip DHT(C4)/DAC(C8)/DNL(CC) & non-SOF.
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
          return { height: buf.readUInt16BE(o + 5), width: buf.readUInt16BE(o + 7) };
        }
        o += 2 + buf.readUInt16BE(o + 2); // jump past this segment
      }
    }
  } catch { /* unparseable → caller falls back to the preset size */ }
  return null;
}

// Target output size for image-to-image / image-to-video, keeping the INPUT
// image's aspect ratio. With an explicit size in opts the output is scaled to
// that size's PIXEL BUDGET (not its exact dims) so the ratio is preserved;
// without one ("auto") it follows the input's own size. The longer side is
// always capped at maxSide. Returns null when the input dims can't be read.
function editTargetSize(images, opts, maxSide = 2048) {
  const d = imageDims(Array.isArray(images) ? images[0] : images);
  if (!d || !d.width || !d.height) return null;
  const aspect = d.width / d.height;
  const area = (opts && opts.width && opts.height) ? opts.width * opts.height : d.width * d.height;
  let w = Math.sqrt(area * aspect);
  let h = Math.sqrt(area / aspect);
  const longer = Math.max(w, h);
  if (longer > maxSide) { const s = maxSide / longer; w *= s; h *= s; }
  return { width: w, height: h };
}

// Snap a dimension to a multiple of m (default 8 — the SD VAE stride).
function snapDim(v, m = 8) { return Math.max(m, Math.round(v / m) * m); }

// An ImageScale node resizing srcRef ([nodeId, outIdx]) to width×height.
// crop "disabled" + a ratio-preserving target means no distortion.
function scaleNode(srcRef, width, height) {
  return { class_type: "ImageScale", inputs: { image: srcRef, upscale_method: "lanczos", width, height, crop: "disabled" } };
}

// Tell ComfyUI to stop the running prompt. Used when WE give up (timeout or the
// client disconnected) — otherwise the workflow keeps occupying the GPU after we
// stop waiting. Best-effort, with its own short timeout so it can't hang.
async function interruptComfyServer() {
  try {
    await fetch(`${currentComfyUrl()}/interrupt`, { method: "POST", signal: AbortSignal.timeout(5000) });
  } catch { /* best-effort */ }
}

// Upload a base64 image to ComfyUI's input folder so a LoadImage node can use
// it. Returns the name (prefixed with subfolder when ComfyUI nests it). The
// filename defaults to a shared "heykoko_input.png"; pass a distinct name when an
// image must coexist with another upload in the same workflow (e.g. an inpaint
// mask alongside its source — both overwrite=true, so a shared name would clobber).
async function uploadImage(b64, signal, filename = "heykoko_input.png") {
  const clean = typeof b64 === "string" && b64.startsWith("data:") ? b64.split(",")[1] : b64;
  const buf = Buffer.from(clean, "base64");
  const form = new FormData();
  form.append("image", new Blob([buf], { type: "image/png" }), filename);
  form.append("overwrite", "true");
  const r = await fetch(`${currentComfyUrl()}/upload/image`, { method: "POST", body: form, signal });
  if (!r.ok) throw new Error(`image upload failed (${r.status})`);
  const data = await r.json();
  return data.subfolder ? `${data.subfolder}/${data.name}` : data.name;
}

// Upload a source video to ComfyUI's input dir (same /upload/image endpoint —
// it accepts video too). Returns the filename for a LoadVideo node. Used by the
// Bernini video-edit path.
async function uploadVideoBuffer(buf, mime, signal) {
  const m = mime || "video/mp4";
  const ext = /webm/i.test(m) ? "webm" : /quicktime|mov/i.test(m) ? "mov" : "mp4";
  // Per-CONTENT filename. A multi-video batch fires its source-video uploads CONCURRENTLY; a
  // shared name ("heykoko_source.mp4") + overwrite=true makes them clobber each other's bytes
  // mid-write → a corrupt file that GetVideoComponents can't decode ("avcodec_send_packet /
  // [aac] channel element not allocated"). Hashing the content gives DISTINCT clips DISTINCT
  // files (no collision), while the SAME clip maps to one shared file — so ComfyUI's input dir
  // stays bounded by distinct content instead of growing per-upload.
  const hash = crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16);
  const form = new FormData();
  form.append("image", new Blob([buf], { type: m }), `heykoko_source_${hash}.${ext}`);
  form.append("overwrite", "true");
  const r = await fetch(`${currentComfyUrl()}/upload/image`, { method: "POST", body: form, signal });
  if (!r.ok) throw new Error(`video upload failed (${r.status})`);
  const data = await r.json();
  return data.subfolder ? `${data.subfolder}/${data.name}` : data.name;
}

async function uploadVideo(b64, signal, mime = "video/mp4") {
  const clean = typeof b64 === "string" && b64.startsWith("data:") ? b64.split(",")[1] : b64;
  let buf = Buffer.from(clean, "base64");
  const fixed = await makeSourceDecodable(buf);   // Opus etc. → AAC so ComfyUI can decode it
  if (fixed !== buf) { buf = fixed; mime = "video/mp4"; }
  return uploadVideoBuffer(buf, mime, signal);
}

// ffprobe an AUDIO buffer's duration in seconds (0 if ffprobe absent/fails). Drives the
// InfiniteTalk length estimate: output frames = duration × fps.
async function probeAudioDuration(buf) {
  let tmp;
  try {
    tmp = path.join(os.tmpdir(), `hk_ad_${crypto.randomUUID()}.bin`);
    await fsp.writeFile(tmp, buf);
    return await new Promise((resolve) => {
      let out = "";
      const p = spawn("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", tmp]);
      p.stdout.on("data", (d) => { out += d; });
      p.on("close", () => resolve(parseFloat(out.trim()) || 0));
      p.on("error", () => resolve(0));
    });
  } catch { return 0; }
  finally { if (tmp) fsp.unlink(tmp).catch(() => {}); }
}

// Upload a speech/audio file to ComfyUI's input dir (same /upload/image endpoint — it
// accepts audio too; LoadAudio reads from the input dir). Content-hashed filename, same
// dedupe/no-collision rationale as uploadVideoBuffer.
async function uploadAudioBuffer(buf, mime, signal) {
  const m = mime || "audio/wav";
  const ext = /mpeg|mp3/i.test(m) ? "mp3" : /ogg|opus/i.test(m) ? "ogg" : /flac/i.test(m) ? "flac" : /m4a|mp4|aac/i.test(m) ? "m4a" : "wav";
  const hash = crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16);
  const form = new FormData();
  form.append("image", new Blob([buf], { type: m }), `heykoko_speech_${hash}.${ext}`);
  form.append("overwrite", "true");
  const r = await fetch(`${currentComfyUrl()}/upload/image`, { method: "POST", body: form, signal });
  if (!r.ok) throw new Error(`audio upload failed (${r.status})`);
  const data = await r.json();
  return data.subfolder ? `${data.subfolder}/${data.name}` : data.name;
}

async function uploadAudio(b64, signal, mime = "audio/wav") {
  const clean = typeof b64 === "string" && b64.startsWith("data:") ? b64.split(",")[1] : b64;
  return uploadAudioBuffer(Buffer.from(clean, "base64"), mime, signal);
}

// POST /api/comfy-upload-video — the browser sends the source video as the RAW
// request body (a Blob, not base64-in-JSON), we forward it to ComfyUI's input dir
// and return its filename. Keeps the heavy video OFF the generation request body.
async function uploadComfyVideo(req, res) {
  try {
    // Raw-body request → the target endpoint rides in a header.
    comfyCtx.enterWith({ comfyUrl: normComfyUrl(req.headers["x-comfy-url"]) || config.comfyUrl });
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let buf = Buffer.concat(chunks);
    if (!buf.length) { sendJson(res, 400, { error: "empty video body" }); return; }
    let mime = req.headers["content-type"] || "video/mp4";
    // Optional target fps (custom Animate output rate) → resample the source so the
    // output timing is correct (model emits one frame per source frame).
    const targetFps = Number(req.headers["x-target-fps"]) || 0;
    if (targetFps > 0) {
      const rs = await resampleVideo(buf, targetFps);
      if (rs) { buf = rs; mime = "video/mp4"; }
    }
    // Ensure ComfyUI can decode the source audio (Opus etc. break GetVideoComponents).
    // No-op for safe/aac/no-audio clips; only re-encodes a problematic soundtrack.
    const fixed = await makeSourceDecodable(buf);
    if (fixed !== buf) { buf = fixed; mime = "video/mp4"; }
    const [name, probe] = await Promise.all([
      uploadVideoBuffer(buf, mime),
      probeVideo(buf),
    ]);
    sendJson(res, 200, { name, frames: probe.frames, fps: probe.fps });
  } catch (e) {
    sendJson(res, 500, { error: String((e && e.message) || e) });
  }
}

// POST /api/comfy-upload-audio — the browser sends the speech audio as the RAW request
// body (Blob, not base64-in-JSON), we forward it to ComfyUI's input dir and return its
// filename + duration. Same raw-body contract as /api/comfy-upload-video.
async function uploadComfyAudio(req, res) {
  try {
    comfyCtx.enterWith({ comfyUrl: normComfyUrl(req.headers["x-comfy-url"]) || config.comfyUrl });
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const buf = Buffer.concat(chunks);
    if (!buf.length) { sendJson(res, 400, { error: "empty audio body" }); return; }
    const mime = req.headers["content-type"] || "audio/wav";
    const [name, duration] = await Promise.all([
      uploadAudioBuffer(buf, mime),
      probeAudioDuration(buf),
    ]);
    sendJson(res, 200, { name, duration });
  } catch (e) {
    sendJson(res, 500, { error: String((e && e.message) || e) });
  }
}

// Translate the handful of ComfyUI/torch failures that are really "out of VRAM" but say so
// in a way nobody can act on. The one that prompted this: chaining SCAIL-2 segments on a
// 32GB card died with `RuntimeError: Fault failed: 2` raised inside comfy_aimdo's
// model_vbar.fault() — DynamicVRAM's weight pager giving up. Nothing in that string says
// memory, and the failing node is reported as SamplerCustom, so it reads like a sampler bug.
//
// Chained segments make it worse than a plain OOM: every segment lives in ONE graph and the
// earlier segment's output has to stay resident to condition the next, so the budget shrinks
// as the chain advances — which is why segment 1 renders fine and segment 2 dies.
function comfyErrorHint(exc, d) {
  const text = `${exc} ${(d && d.traceback ? [].concat(d.traceback).join(" ") : "")}`;
  const seg = (() => {
    // Segment k's nodes are 100 + 20k..; recovering k makes the hint concrete.
    const id = Number(d && d.node_id);
    return Number.isFinite(id) && id >= 100 ? Math.floor((id - 100) / 20) + 1 : 0;
  })();
  const where = seg ? `segment ${seg}` : "";
  // "Window size" is the ⚙ field's own English label — the user has to be able to find it.
  const fix = "Try: set ⚙ Window size back to 1x, lower the resolution, shorten the clip, or use a machine with more VRAM.";
  if (/Fault failed|vbar_fault|model_vbar/i.test(text))
    return `\n\n⚠️ Out of VRAM${where ? ` (${where} failed to swap in its weights)` : ""} — not a sampler fault. ${fix}`;
  if (/CUDA out of memory|OutOfMemoryError|CUDA error: out of memory/i.test(text))
    return `\n\n⚠️ Out of VRAM${where ? ` (${where})` : ""}. ${fix}`;
  return "";
}

// Pull a human-readable message out of a ComfyUI history `status` whose
// status_str is "error" — the failing node + the exception text (incl. CUDA OOM).
function comfyExecError(status) {
  try {
    const msgs = Array.isArray(status && status.messages) ? status.messages : [];
    const err = msgs.find((m) => Array.isArray(m) && m[0] === "execution_error");
    if (err && err[1]) {
      const d = err[1];
      const exc = d.exception_message || d.exception_type || "unknown error";
      const node = d.node_type ? `node ${d.node_type}${d.node_id != null ? " #" + d.node_id : ""} ` : "";
      return `ComfyUI execution error: ${node}${exc}${comfyErrorHint(exc, d)}`;
    }
  } catch { /* fall through */ }
  return "ComfyUI execution error (no details provided)";
}

// Subscribe to ComfyUI's WebSocket and record which of `wanted` save-nodes have
// finished, and what file each one wrote.
//
// WHY THIS EXISTS — /history is not enough. MEASURED: once a prompt ends in `error`,
// its /history entry carries an EMPTY `outputs`, even for nodes that completed and
// already wrote their file to disk. Interrupting (the Stop button, the timeout path)
// ends the same way. So after any failure the finished segments are sitting in
// ComfyUI's output folder with no way to learn their filenames — and without a
// filename there is nothing to fetch. The `executed` event carries the filename at
// the moment each node finishes, which makes it the only source that survives.
//
// Entirely best-effort: a socket that will not open costs nothing but the ability to
// recover. Preview frames arrive as binary and are skipped.
function watchComfyExecuted(clientId, wanted) {
  const seen = new Map(); // nodeId → { filename, subfolder, type }
  let ws = null;
  try {
    const url = currentComfyUrl().replace(/^http/i, "ws") + `/ws?clientId=${encodeURIComponent(clientId)}`;
    ws = new WebSocket(url);
    ws.onmessage = (e) => {
      if (typeof e.data !== "string") return; // binary = live preview frame
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.type !== "executed" || !m.data) return;
      const nid = String(m.data.node ?? "");
      if (!wanted.has(nid)) return;
      const out = m.data.output || {};
      const f = [...(out.images || []), ...(out.gifs || [])].find((x) => x && x.type !== "temp");
      if (f) seen.set(nid, f);
    };
    ws.onerror = () => {};
  } catch { /* no socket → no recovery, everything else proceeds */ }
  return { seen, close() { try { ws && ws.close(); } catch { /* already gone */ } } };
}

// Salvage a render that died partway: join the segments that DID finish.
//
// TWO SOURCES, unioned, because neither alone is reliable:
//   • the ws `executed` events — recorded live, so they survive even ComfyUI being
//     OOM-killed (the process dies before it ever writes a history entry);
//   • /history — MEASURED to sometimes still list the finished nodes after an `error`
//     and sometimes to be completely empty, depending on where the failing node fell in
//     the execution order. Two runs of the same shape gave both results, so it is a
//     supplement, never the primary.
//
// Only a CONTIGUOUS PREFIX is usable. The soundtrack is laid over the joined picture
// from its start, so dropping segment k and keeping k+1 would put everything after the
// hole out of sync with the audio — worse than returning less. Stopping at the first
// gap yields a shorter but honest clip.
//
// Returns { buf, codec, done, total } or null when nothing is salvageable.
async function mergeFinishedPrefix(watcher, merge, promptId, wantCodec, crf, signal) {
  if (!merge) return null;
  const found = new Map(watcher ? watcher.seen : []);
  if (promptId) {
    try {
      const r = await fetch(`${currentComfyUrl()}/history/${promptId}`, { signal });
      if (r.ok) {
        const outs = (await r.json())[promptId]?.outputs || {};
        for (const nid of merge.saveNodeIds) {
          if (found.has(nid)) continue;
          const o = outs[nid] || {};
          const f = [...(o.images || []), ...(o.gifs || [])].find((x) => x && x.type !== "temp");
          if (f) found.set(nid, f);
        }
      }
    } catch { /* ws-only then */ }
  }
  const files = [];
  for (const nid of merge.saveNodeIds) {
    const f = found.get(nid);
    if (!f) break; // first gap ends the prefix
    files.push(f);
  }
  if (!files.length) return null;
  const bufs = [];
  for (const f of files) {
    try {
      const params = new URLSearchParams({ filename: f.filename, subfolder: f.subfolder || "", type: f.type || "output" });
      const r = await fetch(`${currentComfyUrl()}/view?${params}`, { signal });
      if (!r.ok) break;
      bufs.push(Buffer.from(await r.arrayBuffer()));
    } catch { break; }
  }
  if (!bufs.length) return null;
  const srcBuf = await fetchComfyInputFile(merge.sourceName, signal);
  const merged = await mergeScail2Segments(bufs, srcBuf, wantCodec, crf, signal);
  if (!merged) return null;
  console.log(`[comfy] ${merge.label}: salvaged ${bufs.length}/${merge.saveNodeIds.length} finished segments after an interrupted render`);
  return { ...merged, done: bufs.length, total: merge.saveNodeIds.length };
}

// Poll /history until the queued prompt reports outputs (or it errors / times out /
// aborts). On a ComfyUI execution error we throw the real message (not poll to a
// misleading timeout); we only return empty outputs once the run is truly completed.
async function waitForOutputs(promptId, signal, deadline) {
  while (Date.now() < deadline) {
    if (signal.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
    try {
      const r = await fetch(`${currentComfyUrl()}/history/${promptId}`, { signal });
      if (r.ok) {
        const hist = await r.json();
        const entry = hist[promptId];
        if (entry) {
          const status = entry.status;
          if (status && status.status_str === "error") {
            throw Object.assign(new Error(comfyExecError(status)), { isComfyError: true });
          }
          if (entry.outputs && Object.keys(entry.outputs).length) return entry.outputs;
          // Completed (success) but produced nothing → return empty, let the caller report it.
          if (status && status.completed) return entry.outputs || {};
        }
      }
    } catch (e) {
      if (e.name === "AbortError" || e.isComfyError) throw e;
    }
    await new Promise((res) => setTimeout(res, 800));
  }
  throw Object.assign(new Error("timeout"), { name: "AbortError" });
}

async function generateComfyImage(req, res) {
  let clientGone = false; // set if the client disconnects before we respond
  let isVideoReq = false; // for a video-aware timeout message in the catch
  let precisionUsed = null; // tier(s) actually loaded — always reported
  let ltxLoraUsed = null;   // { name, strength } when an LTX LoRA was actually mounted
  let phantomTurboUsed = null; // { lora } when Phantom's step-distill LoRA was mounted
  let videoCodecUsed = null;   // "h264" | "h265" — codec the video was actually saved as
  let videoCodecNote = null;   // "vhs-missing" when a h265 request fell back to native h264
  let scailStreamNote = null;  // "vhs-missing" when per-window source streaming wasn't available
  // Salvage state, hoisted out of the inner try so the catch below can reach it: the
  // whole point is to still deliver something when the render did NOT finish.
  let segmentMerge = null;   // { label, saveNodeIds, sourceName } once a chunked graph is built
  let execWatcher = null;    // ws subscription recording which segments finished
  let salvageCodec = "h264", salvageCrf = 0;
  let salvagePromptId = null; // the queued prompt, so the catch can re-query /history
  let precisionNote = null; // set only when those differ from the ⚙ request
  // Gallery metadata, filled in once the request is understood. Hoisted so the SALVAGE
  // path in the catch can file a partial render under its real prompt/model too.
  let galleryMeta = null;
  try {
    const body = await readBody(req);
    // Target the ComfyUI endpoint this job was routed to (parallel lanes); default global.
    comfyCtx.enterWith({ comfyUrl: normComfyUrl(body.comfyUrl) || config.comfyUrl });
    const { prompt, negative_prompt, options, images, mask, sourceVideo, sourceVideoName, sourceVideoMime, sourceVideoWidth, sourceVideoHeight, sourceVideoFrames, sourceVideoFps, sourceAudio, sourceAudioName, sourceAudioMime, sourceAudioDuration, continueVideoName, refImageWidth, refImageHeight, timeout: reqTimeout, clientId: bodyClientId } = body;
    let model = body.model;

    // A prompt is only required for pure txt2img — attachment-driven gen (img2img /
    // instruction-edit / video-edit / Wan Animate) may run with an empty prompt.
    const hasImgInput = Array.isArray(images) && images.length > 0;
    const hasVidInput = !!(sourceVideo || sourceVideoName);
    if (!model || (!prompt && !hasImgInput && !hasVidInput)) {
      sendJson(res, 400, { error: "model and prompt are required" });
      return;
    }

    // Preflight: an offline / wrong-IP ComfyUI otherwise surfaces as a bogus
    // "missing model files" error (every companion lookup comes back empty).
    if (!(await comfyReachable())) {
      sendJson(res, 502, { error: `Cannot connect to ComfyUI (${currentComfyUrl()}). Make sure that machine is online, ComfyUI is running, and the address/IP is correct (if the IP changed, update the ComfyUI address in settings).` });
      return;
    }

    const opts = options || {};
    const width = opts.width || 1024;
    const height = opts.height || 1024;
    const seed = opts.seed !== undefined ? opts.seed : Math.floor(Math.random() * 2147483647);
    const isImg2Img = Array.isArray(images) && images.length > 0;
    // Merged WAN 2.2 14B entry → pick the real t2v (no image) or i2v (image) model.
    if (model === WAN14B_AUTO) {
      model = await resolveWan14bAuto(isImg2Img);
      if (!model) {
        sendJson(res, 400, { error: "WAN 2.2 14B model file not found (need wan2.2_{t2v,i2v}_high_noise_14B…)." });
        return;
      }
    }
    // Wan Animate REPLACE shares the Move UNET; resolve the sentinel back to it and
    // flag the build so it adds the mask + blacked-background nodes.
    let animateReplace = false;
    if (model === ANIMATE_REPLACE) {
      model = await resolveAnimateUnet();
      animateReplace = true;
      if (!model) {
        sendJson(res, 400, { error: "Wan Animate model file not found (diffusion_models/ needs an *animate* UNET)." });
        return;
      }
    }
    // Bernini's two dropdown entries are both sentinels for the same MoE pair (insert
    // only rebinds the image), so resolve them HERE — before resolvePrecision. Left in
    // the bernini branch below, resolution happened AFTER it, and a sentinel matches no
    // file on disk: the ⚙ tier silently did nothing (whichever high_noise twin came
    // first won) and the done-line reported the tier as "unknown".
    const berniniInsert = model === BERNINI_INSERT;
    // The IMAGE sentinels resolve to the same weights; remember which task was picked
    // (i2i / r2i / t2i) before the name is overwritten with the real filename.
    const berniniImageTask = model === BERNINI_IMG_EDIT ? "i2i"
      : model === BERNINI_IMG_SUBJECT ? "r2i"
      : model === BERNINI_T2I ? "t2i" : null;
    if (model === BERNINI_AUTO || model === BERNINI_INSERT || berniniImageTask) {
      model = await resolveBerniniAuto();
      if (!model) {
        sendJson(res, 400, { error: "Bernini model file not found (need wan2.2_bernini_r_high_noise…)." });
        return;
      }
    }
    // SCAIL-2 ANIMATE shares the Replace UNET — only the replacement_mode flag differs.
    let scail2Replace = videoTypeOf(model) === "scail2"; // the base entry IS Replacement
    if (model === SCAIL2_ANIMATE) {
      model = await resolveScail2Unet();
      scail2Replace = false;
      if (!model) {
        sendJson(res, 400, { error: "SCAIL-2 model file not found (diffusion_models/ needs a *SCAIL* UNET)." });
        return;
      }
    }
    // ⚙ precision preference. Runs AFTER every sentinel has resolved to a real
    // filename and BEFORE anything reads `model`, so each builder just receives the
    // file it should load. Two-expert models also get their pair pre-resolved —
    // buildWan14B / buildBernini would otherwise derive the twin off the SWAPPED
    // name and ask for a file at a tier that twin may not ship in.
    const prec = await resolvePrecision(model, opts.precision);
    model = prec.model;
    const expertPair = prec.experts;
    precisionNote = prec.note;
    precisionUsed = prec.used;
    // Every sentinel has resolved to a real filename by here, so this records the model
    // that actually runs (not the dropdown alias) — plus the canonical id, which needs
    // BOTH names: the request's (a sentinel carries the graph mode) and the resolved
    // file's (which is the only thing that knows t2v from i2v behind the merged entry).
    galleryMeta = {
      model, modelId: galleryModelId(body.model, model),
      prompt, negative: negative_prompt, seed, params: opts,
      conversationId: body.conversationId, msgId: body.msgId,
    };
    const isMultiImage = Array.isArray(images) && images.length >= 2;
    // Output size for img2img edits, keeping the input's aspect ratio. Only
    // OVERRIDE the builder's natural sizing when we must: a size is specified
    // (default size or --size), or the input exceeds the 2048 cap. In plain
    // "auto" with a within-cap input we leave width/height undefined so edit
    // models keep their native input-inherited sizing (e.g. Kontext's own
    // resolution scaler). When set: specified → the chosen size's pixel budget,
    // over-cap → the input downscaled to fit 2048. Both preserve aspect ratio.
    let ew, eh;
    if (isImg2Img) {
      const hasSpecified = !!(opts.width && opts.height);
      const d = imageDims(images[0]);
      const overCap = d && Math.max(d.width, d.height) > 2048;
      if (hasSpecified || overCap) {
        const ts = editTargetSize(images, opts);
        if (ts) { ew = snapDim(ts.width); eh = snapDim(ts.height); }
      }
    }
    // denoise controls how much the input image is changed (1 = ignore it).
    const denoise = opts.denoise !== undefined ? opts.denoise : 0.75;
    // Inpaint: a painted mask (white = repaint) confines the edit to that region.
    // Only meaningful with a source image; ignored without one.
    const hasMask = isImg2Img && typeof mask === "string" && mask.length > 100;
    // Per-model defaults merged with any user overrides from the params modal.
    const cfg = resolveConfig(model, opts);
    const editType = editTypeOf(model);
    // The bernini image sentinels have already been resolved to a real bernini
    // filename, which videoTypeOf would (correctly, for the video entries) call
    // "bernini" and send down the VIDEO path — force it to null so the image
    // branch below claims them instead.
    const videoType = berniniImageTask ? null : videoTypeOf(model);
    // 3D mesh chains (Hunyuan3D / TripoSplat / MoGe) — output is a .glb/.spz FILE.
    const meshType = meshTypeOf(model);

    // "/imagine -s 10": a DURATION, resolved to a frame count HERE — the first point
    // where the model is a real filename, so the rate is the one that will actually be
    // used. Every downstream consumer of opts.length (resolveVideoConfig's grid snap, and
    // the source-driven builders' own clamps) then works unchanged. It OVERRIDES the ⚙
    // length field: that field is a saved preference, -s was typed for this one run —
    // the same precedence every other /imagine flag has over the panel.
    if (videoType && opts.lengthSec > 0) {
      opts.length = Math.max(1, Math.round(opts.lengthSec * videoRateFor(videoType, model, opts, sourceVideoFps)));
    }

    // Instruction-edit models require a reference image to edit.
    if (editType && !isImg2Img) {
      sendJson(res, 400, { error: "This model is for instruction-based editing. Attach a reference image first, then use /imagine <edit instruction>." });
      return;
    }

    // The browser can supply its own clientId so it can subscribe to ComfyUI's
    // WebSocket for live progress / preview frames using the same id.
    const clientId = (typeof bodyClientId === "string" && bodyClientId) || crypto.randomUUID();
    // Video honors the client's ⚙ timeout VERBATIM: 0 = UNLIMITED (no deadline — the user waits a
    // long Wan Animate render out on a stable box; only a Stop / client disconnect ends it), N =
    // N seconds (the manual cap, NO upper clamp). Images keep the 10-min safety cap.
    isVideoReq = !!videoType;
    // Mesh rides the video timeout policy — Hunyuan3D's octree decode alone can take
    // minutes, so the 10-min image safety cap is the wrong ceiling for it.
    const timeoutMs = (videoType || meshType)
      ? (reqTimeout === 0 ? 0 : Math.max(60, reqTimeout || 1800) * 1000)
      : Math.min(600, Math.max(60, reqTimeout || 120)) * 1000;
    const deadline = timeoutMs ? Date.now() + timeoutMs : Infinity;
    const controller = new AbortController();
    // On timeout (if any), stop waiting AND interrupt ComfyUI so a stuck render doesn't keep
    // running on the GPU after we return a timeout error. Unlimited (0) → no timer at all.
    const timeout = timeoutMs ? setTimeout(() => { controller.abort(); interruptComfyServer(); }, timeoutMs) : null;
    // If the client disconnects (user hit Stop, tab closed, network drop) before
    // we respond, abort our poll/fetches and interrupt ComfyUI too — the browser
    // also POSTs /interrupt on the Stop button, but this covers the cases it can't.
    res.on("close", () => { if (!res.writableFinished) { clientGone = true; controller.abort(); interruptComfyServer(); } });

    try {
      let workflow;
      let videoDims = null; // actual resolved output size (for the client's caption)
      let imagesUsed = 0;   // how many input images the video path actually consumed
      let stillMode = false; // single-frame Wan Animate → return an IMAGE, not a video
      let paintGlb = null;   // Hunyuan3D texturing: filename_prefix of a GLB /history won't report
      // (segmentMerge is declared at function scope — the catch needs it to salvage a
      // render that dies partway.) It holds { label, saveNodeIds, sourceName } once a
      // chunked graph is built, and also keeps the single-output tail rewrites off that
      // workflow (see below).
      let meshViewKind = null; // how the viewer should place its camera, set by the mesh branch
      let panoDims = null;     // the 360 recipe forces its own 2:1 size; the log should say so
      let panoOutpaintUsed = 0; // set only when a photo was grown into the panorama
      let panoLoraUsed = null;  // { name, strength } when an equirect LoRA was mounted
      let panoLoraSkipped = null; // asked for, but the chosen base is the wrong family
      let panoCfg = null;      // …and its own sampler settings, taken from the chosen checkpoint
      let panoBase = "";       // which checkpoint that was, for the log
      let interpWarning = null; // interpolation skipped (source fps already ≥ target) → tell the client
      let upscaleInfo = null;   // { model, denoise } actually used → shown in the result bubble
      let exactTargetFps = 0;   // interpolation: interpolated to ≥ this (ceil mult) → drop frames to EXACTLY this fps
      // denoise / artifact-reduction strength for the upscale paths. Accepts 0–1 or 0–100 (% from the ⚙).
      const upscaleDenoise = (() => { const d = Number(opts.upscaleDenoise) || 0; return d > 1 ? d / 100 : Math.max(0, d); })();
      if (videoType === "bernini") {
        // Bernini-R video EDIT: a SOURCE VIDEO (required) + instruction → edited
        // video (v2v); + a reference image → rv2v. Resolve the merged entry to the
        // real high_noise model, upload the source video (and any ref image).
        const insertMode = berniniInsert; // sentinel already resolved above, with the mode read off it
        const hasVideo = !!(sourceVideo || sourceVideoName);
        const hasImage = Array.isArray(images) && images.length > 0;
        // Source video → v2v (+ ref image → rv2v); image only → i2v; NEITHER → t2v
        // (a legal task: the node simply gets no media). The outer guard already
        // guarantees a prompt when nothing is attached, so t2v can't run empty.
        // ads2v composites the image INTO the clip, so unlike the other modes neither
        // input is optional — with one missing there is nothing to insert, or nowhere
        // to insert it.
        if (insertMode && !(hasVideo && hasImage)) {
          sendJson(res, 400, { error: "Bernini (insert) needs BOTH a source video and an image to insert into it, then use /imagine <where/how to place it>." });
          return;
        }
        const comp = await berniniCompanions();
        // The distill LoRA being INSTALLED used to be the whole condition, which left
        // buildBernini's 40-step/cfg-5 schedule unreachable on any machine that had it.
        // ⚙ quality mode opts out per request.
        const turbo = !!comp.lora && !opts.berniniQuality;
        // ⚙ LightX2V 4-step recipe (its own high/low LoRA pair). Only when requested AND
        // the pair is on disk; otherwise buildBernini falls back to turbo/quality.
        const lightx2v = !!opts.berniniLightx2v && !!(comp.loraLxHigh && comp.loraLxLow);
        // Size to the SOURCE's aspect (video for v2v/rv2v, image for i2v) so frames
        // aren't stretched, at the preset pixel budget (832×480) — or the --size
        // budget if the user set one. Falls back to 832×480.
        let aspW = Number(sourceVideoWidth), aspH = Number(sourceVideoHeight);
        if (!(aspW > 0 && aspH > 0)) {
          // i2v: follow the reference image's aspect. Prefer the browser-decoded
          // size the client sent (any format); fall back to parsing the base64.
          if (Number(refImageWidth) > 0 && Number(refImageHeight) > 0) {
            aspW = Number(refImageWidth); aspH = Number(refImageHeight);
          } else if (hasImage) {
            const d = imageDims(images[0]);
            if (d) { aspW = d.width; aspH = d.height; }
          }
        }
        let bw = snapDim(opts.width || 832, 16);
        let bh = snapDim(opts.height || 480, 16);
        if (aspW > 0 && aspH > 0) {
          const aspect = aspW / aspH;
          const budget = (opts.width && opts.height) ? opts.width * opts.height : 832 * 480;
          bw = snapDim(Math.sqrt(budget * aspect), 16);
          bh = snapDim(Math.sqrt(budget / aspect), 16);
        }
        // BerniniConditioning sizes its empty latent from `length` ALONE, but encodes
        // only the frames the source actually has (it trims with a plain `[:length]`).
        // A `length` above the real frame count leaves latent and context mismatched —
        // the node does not check this, it hands the mismatch to the sampler. So clamp
        // to the source, and snap DOWN to 4n+1: rounding to the NEAREST 4n+1 would put
        // a 50-frame source back up at 53 and re-open the very gap this closes.
        const srcFrames = hasVideo ? (Number(sourceVideoFrames) || 0) : 0;
        // 5 = the shortest legal length (4n+1, n≥1). A source below that can't be
        // edited at all — say so rather than ship a guaranteed latent mismatch.
        if (srcFrames > 0 && srcFrames < 5) { sendJson(res, 400, { error: `Source video is too short to edit (${srcFrames} frames; Bernini needs at least 5).` }); return; }
        let wantLen = opts.length || 81;
        if (srcFrames > 0) wantLen = Math.min(wantLen, srcFrames);
        const bl = Math.max(5, Math.floor((wantLen - 1) / 4) * 4 + 1); // 4n+1, never above the source
        // Source longer than one pass → only the first `bl` frames get edited (the node
        // trims the rest). Tell the client instead of silently returning a short clip.
        const truncatedFrames = srcFrames > bl ? srcFrames : 0;
        const bfps = opts.fps || 16; // i2v output fps (v2v/rv2v keep the source's)
        // ref_max_size caps the reference's LONG EDGE only: references keep their own
        // aspect and are never cropped or fitted to the canvas (only source_video is —
        // see _resize_long_edge, which just shrinks). Tracking the output size, as this
        // used to, therefore only ever threw detail away: a 512×768 run capped the refs
        // at 768, below the official 848 default. Floor at that default and still scale
        // up for bigger outputs — the template's advice for 720p is to raise it to 1280.
        // ⚙ refMaxSize overrides outright: it's the only lever on how much of a
        // reference's identity/detail survives, so an explicit value is never second-
        // guessed — just clamped to the node's own declared 16…8192 range.
        const refMax = opts.refMaxSize > 0
          ? snapDim(Math.min(8192, Math.max(16, opts.refMaxSize)), 16)
          : snapDim(Math.max(848, bw, bh), 16);
        // Prefer a pre-uploaded video (multipart /api/comfy-upload-video) → its
        // ComfyUI filename; else fall back to inline base64.
        const videoName = sourceVideoName || (sourceVideo ? await uploadVideo(sourceVideo, controller.signal, sourceVideoMime) : null);
        const refImageNames = [];
        let insertImageName = null;
        if (insertMode) {
          // ads2v is documented as source_video + reference_video ONLY — extra images
          // have no slot in that combination, so only the first is used.
          insertImageName = await uploadImage(images[0], controller.signal, "heykoko_berniniinsert.png");
          imagesUsed = 1;
        } else {
          // Every attached image is a reference view (see buildBernini), up to the
          // autogrow template's own max of 8 slots. Distinct filenames — a shared one
          // would have each upload overwrite the last.
          const refSrc = hasImage ? images.slice(0, BERNINI_MAX_REFS) : [];
          for (let i = 0; i < refSrc.length; i++) {
            refImageNames.push(await uploadImage(refSrc[i], controller.signal, `heykoko_berniniref${i}.png`));
          }
          imagesUsed = refImageNames.length;
        }
        workflow = buildBernini({ model, prompt, negative: negative_prompt || "", comp, videoName, refImageNames, insertImageName, videoTask: opts.berniniTask || "", width: bw, height: bh, length: bl, seed, turbo, lightx2v, fps: bfps, refMaxSize: refMax, experts: expertPair });
        // v2v/rv2v keep the source video's fps; i2v uses bfps (so it can show duration).
        videoDims = { width: bw, height: bh, length: bl, fps: hasVideo ? undefined : bfps };
        // truncatedNoChain distinguishes this from Wan Animate's truncation: there, the
        // advice is "clear ⚙ Length and it chains the full source". BerniniConditioning
        // has no offset/continue input at all, so that advice would be a lie here.
        if (truncatedFrames) { videoDims.truncatedFrom = truncatedFrames; videoDims.truncatedNoChain = true; }
      } else if (videoType === "enhance") {
        // Interpolate + upscale: source video → AI-upscaled AND frame-interpolated to a target fps.
        // The /imagine "prompt" is just the target fps number (empty / non-numeric →
        // HD upscale only, no interpolation).
        if (!(sourceVideo || sourceVideoName)) { sendJson(res, 400, { error: "Video interpolate + upscale needs a source video: attach a video first, then use /imagine <target fps> (e.g. /imagine 60; leave empty for HD upscale only)." }); return; }
        // ⚙ "upscale model" = Off → skip upscaling: interpolate-only (frames stay at source resolution).
        const noUpscale = opts.upscaleModel === "off";
        const srcFps = Number(sourceVideoFps) || 16;
        const srcFrames = Number(sourceVideoFrames) || 0;
        // Target fps for interpolation: the `/imagine <number>` prompt wins; if it has no number,
        // fall back to the ⚙ "interpolate to FPS" field (same control the other video models use).
        const promptFps = Math.round(parseFloat((prompt || "").trim()));
        const tf = promptFps > 0 ? promptFps : Math.round(Number(opts.targetFps) || 0);
        const willInterp = tf > 0 && tf > srcFps;       // interpolate only when target fps > source
        const willResize = opts.width > 0 && opts.height > 0; // explicit --size
        const willDenoise = upscaleDenoise > 0;
        // Sharpening alone is a valid job: with the upscale model Off and no resize, the
        // clip keeps its exact size and only gets the filter — which is the whole point
        // of the knob ("sharpen this, don't touch anything else").
        const sharpen = sharpenAlphaOf(opts.sharpen);
        const willSharpen = sharpen > 0;
        // Neither interpolation nor upscale (nor denoise / explicit resize) → ComfyUI has nothing to do.
        // Tell the user in the bubble instead of running a pointless re-encode.
        if (noUpscale && !willInterp && !willResize && !willDenoise && !willSharpen) {
          sendJson(res, 200, { noop: true, message: `ℹ️ Nothing to do: neither interpolation nor upscale is enabled — ⚙ "upscale model" is set to "Off", and the target fps (${tf > 0 ? tf : "not set"}) is not higher than the source video fps (${srcFps}). ComfyUI was not called this time.\n\n· To interpolate: \`/imagine <a higher fps>\` (e.g. for a ${srcFps}fps source, enter ${srcFps * 2})\n· To upscale: change ⚙ "upscale model" from "Off" back to "Auto" or a specific model\n· To sharpen at the original size: set ⚙ "Sharpen" to Light/Medium/Strong and leave the upscale model Off` });
          return;
        }
        const videoName = sourceVideoName || await uploadVideo(sourceVideo, controller.signal, sourceVideoMime);
        // Output size = 2× the source, capped so the long side ≤ 2160. A ⚙ --size sets an
        // explicit budget instead. 0/0 = keep the source resolution (Off, or dims unknown).
        // Computed BEFORE the model is chosen, because the ratio it implies is what the
        // auto-pick needs: a 2× target should load a 2× model rather than run a 4× one and
        // throw away 57% of the pixels it just computed (1236 vs 321 ms/frame, measured).
        const HD_LONG_CAP = 2160;
        const even = (n) => Math.max(2, Math.round(n / 2) * 2);
        let outW = 0, outH = 0;
        const sw = Number(sourceVideoWidth), sh = Number(sourceVideoHeight);
        // ⚙ "Upscale to" names the LONG side (1920 / 2560 / 3840), so a portrait clip gets
        // in height what a landscape one gets in width — a target expressed as "1080p"
        // would otherwise mean two different things depending on orientation.
        const targetLong = Math.round(Number(opts.upscaleTarget) || 0);
        if (opts.width > 0 && opts.height > 0 && sw > 0 && sh > 0) {
          // Explicit --size → that pixel budget at the source aspect. A per-command flag
          // outranks the persistent ⚙ setting, same as everywhere else.
          const aspect = sw / sh, budget = opts.width * opts.height;
          outW = even(Math.sqrt(budget * aspect)); outH = even(Math.sqrt(budget / aspect));
        } else if (!noUpscale && targetLong > 0 && sw > 0 && sh > 0) {
          const k = targetLong / Math.max(sw, sh);
          outW = even(sw * k); outH = even(sh * k);
        } else if (!noUpscale && sw > 0 && sh > 0) {
          // Default 2× HD doubling — only when actually upscaling (Off keeps source size).
          let tw = sw * 2, th = sh * 2;
          const longSide = Math.max(tw, th);
          if (longSide > HD_LONG_CAP) { const s = HD_LONG_CAP / longSide; tw *= s; th *= s; }
          outW = even(tw); outH = even(th);
        }
        // Ratio the pipeline actually needs, so the auto-pick can size the model to it.
        const wantScale = (!noUpscale && sw > 0 && outW > 0) ? outW / sw : 0;
        // A target the source already meets has nothing for an upscaler to do — running one
        // and scaling back would cost minutes and add sharpening the user did not ask for.
        // Plain resampling still happens (outW/outH are set); only the AI pass is dropped.
        const resizeOnly = wantScale > 0 && wantScale <= 1.02;
        const comp = (noUpscale || resizeOnly) ? null : await upscaleCompanions(opts.upscaleModel, wantScale);
        // A real de-artifact model when one is installed and the ⚙ denoise knob is up;
        // "off" pins the blur fallback, which is cruder but costs no extra pass.
        const restoreModel = (upscaleDenoise > 0 && opts.restoreModel !== "off")
          ? await restoreCompanion(opts.restoreModel) : null;
        // Interpolation is decided HERE and handed to the builder, which places it before
        // the chunk split — unlike every other video model, where applyVfi splices it in
        // afterwards. CEIL → interpolated fps ≥ target; a post-pass drops to EXACTLY tf.
        const mult = willInterp ? Math.max(2, Math.ceil(tf / srcFps)) : 1;
        const method = /film/i.test(opts.interpMethod || "") ? "film" : "rife";
        const outFps = mult > 1 ? Math.round(srcFps * mult) : srcFps;
        // Frames reaching the UPSCALE — after interpolation has already multiplied them.
        // Sizing the chunk plan off the source count instead would leave (mult−1)/mult of
        // the clip in no chunk at all, and the render would come back truncated.
        const framesIn = (mult > 1 && srcFrames > 0) ? (srcFrames - 1) * mult + 1 : srcFrames;
        // Peak batch is the model's NATIVE output, before any downscale to outW/outH.
        // With no model (resize-only) the ImageScale result is itself the peak, and it is
        // just as capable of exhausting RAM — so that path gets a chunk plan too.
        const mScale = (comp && comp.scale) || 4;   // unknown scale → assume 4x (smaller chunks)
        const chunk = comp ? upscaleChunkPlan(framesIn, sw * mScale, sh * mScale)
          : (outW > 0 ? upscaleChunkPlan(framesIn, outW, outH) : null);
        workflow = buildVideoEnhance({ videoName, upscaleModel: comp ? comp.model : null, outW, outH,
          denoise: upscaleDenoise, restoreModel, sharpen, chunk,
          vfi: mult > 1 ? { mult, method, fps: outFps } : null });
        upscaleInfo = { model: comp ? comp.model : null, scale: comp ? comp.scale : null, resizeOnly, denoise: upscaleDenoise, restoreModel, sharpen: opts.sharpen || null };
        if (chunk) {
          segmentMerge = { label: "Video upscale", saveNodeIds: Array.from({ length: chunk.count }, (_, k) => enhanceSaveNodeId(k)), sourceName: videoName };
          console.log(`[comfy-gen] upscale chunked: ${framesIn} frames → ${chunk.count} × ${chunk.size} @ ${sw * mScale}x${sh * mScale} (${(chunk.perFrame * chunk.size / 2 ** 30).toFixed(1)} GiB/chunk)`);
        }
        if (willInterp) {
          videoDims = { width: outW || undefined, height: outH || undefined, fps: outFps, interpolated: mult, interpMethod: method };
          exactTargetFps = tf;
        } else {
          if (tf > 0 && tf <= srcFps) interpWarning = { baseFps: srcFps, targetFps: tf }; // already ≥ target
          videoDims = { width: outW || undefined, height: outH || undefined, fps: outFps };
        }
        if (srcFrames > 0) videoDims.length = (srcFrames - 1) * mult + 1; // for the done-line duration
      } else if (videoType === "scail2") {
        // SCAIL-2: a reference character image + a driving video. Needs BOTH — the
        // model has no still/single-frame path (the driving motion IS the input).
        if (!sourceVideo && !sourceVideoName) { sendJson(res, 400, { error: "SCAIL-2 needs a source video (the driving motion) plus a character reference image." }); return; }
        if (!(Array.isArray(images) && images.length)) { sendJson(res, 400, { error: "SCAIL-2 needs a character reference image (plus the attached driving video)." }); return; }
        // ⚙ long-clip memory strategy. ONE knob for both halves of the problem, because
        // the useful settings are a ladder rather than two independent switches —
        // streaming the source without incremental save is not expressible, and that is
        // deliberate: the legacy tail muxes its audio from node 15, so keeping that tail
        // means keeping the whole-source decode and streaming would win nothing.
        //   ""            → both (default): stream the source AND save each window
        //   "incremental" → save each window, still decode the whole source
        //   "off"         → the original single-file path, ComfyUI writes one video
        const memMode = ["incremental", "off"].includes(opts.scailMemoryMode) ? opts.scailMemoryMode : "stream";
        const incrementalSave = memMode !== "off";
        // FAIL FAST, before a single byte is uploaded. That path joins the segment clips
        // here once the render is done, so a missing binary would otherwise surface after
        // an hour of GPU time instead of now. ffprobe is checked too, and matters in a
        // less obvious way: it is what decides whether the source HAS an audio track, so
        // without it every merge would quietly produce a SILENT video rather than fail.
        if (incrementalSave) {
          const missing = [];
          for (const tool of ["ffmpeg", "ffprobe"]) if (!(await hasLocalTool(tool))) missing.push(tool);
          if (missing.length) {
            sendJson(res, 400, { error: `SCAIL-2 needs ${missing.join(" and ")} on this machine (the one running hey-koko, not the ComfyUI box) to join the rendered windows and lay the soundtrack over them. Install it (macOS: brew install ffmpeg) — or set ⚙ "Long-clip memory" to Off, which has ComfyUI write one finished file and needs no ffmpeg at all, at the cost of holding every window in memory (long clips will run out of it).` });
            return;
          }
        }
        const comp = await scail2Companions();
        // Output follows the SOURCE video's aspect at the preset (or --size) budget.
        // /32 — the template floors both dims to 32 before the resize.
        let aspW = Number(sourceVideoWidth), aspH = Number(sourceVideoHeight);
        let aw = snapDim(opts.width || 640, 32);
        let ah = snapDim(opts.height || 640, 32);
        if (aspW > 0 && aspH > 0) {
          const aspect = aspW / aspH;
          const budget = (opts.width && opts.height) ? opts.width * opts.height : 640 * 640;
          aw = snapDim(Math.sqrt(budget * aspect), 32);
          ah = snapDim(Math.sqrt(budget / aspect), 32);
        }
        // Segment schedule. A ⚙ length caps how much of the source is used; without
        // one the whole source is tiled. Either way the frames are chained into
        // 81-frame segments in ONE graph.
        //
        // NOT Animate's "a pinned length forces one bounded pass" rule: Animate's cap
        // is a VRAM tier (241 frames at low res, so one pass really does cover most
        // clips), while SCAIL-2's 81 is a fixed MODEL constraint. Bounding the pass
        // here would silently clamp every request over 81 frames down to 81.
        const srcFrames = Number(sourceVideoFrames) || 0;
        let segments, truncatedFrom;
        if (opts.length) {
          const want = srcFrames > 0 ? Math.min(opts.length, srcFrames) : opts.length;
          segments = scail2Segments(want, SCAIL2_FRAMES * 4, opts.scailWindow);
          if (srcFrames > want) truncatedFrom = srcFrames; // pinned length cut the clip
        } else {
          segments = scail2Segments(srcFrames, SCAIL2_FRAMES * 4, opts.scailWindow);
        }
        // Total output = segment 0 in full + each later segment minus its overlap.
        const totalFrames = segments.reduce((a, s, i) => a + s.length - (i > 0 ? SCAIL2_OVERLAP : 0), 0);
        const sfps = Number(sourceVideoFps) || opts.fps || 16;
        const videoName = sourceVideoName || await uploadVideo(sourceVideo, controller.signal, sourceVideoMime);
        // Every attached image is a VIEW of the one character — image[0] is the primary,
        // the rest fill in what it can't show (back, close-up). This is NOT how several
        // characters are given: multiple people go IN one reference image, where SAM3
        // finds them as separate identities and swaps them all at once.
        // Distinct filenames — a shared name would overwrite on upload and every view
        // would end up being the same picture.
        const refImageNames = [];
        for (let i = 0; i < images.length; i++) {
          refImageNames.push(await uploadImage(images[i], controller.signal, `heykoko_scailref${i}.png`));
        }
        imagesUsed = refImageNames.length;
        // Stream the source per window instead of decoding it whole (see buildScail2).
        // Needs VHS_LoadVideo — VideoHelperSuite is per-MACHINE, exactly like the ⚙ H.265
        // tail, so this is checked against the box this job was routed to. Absent → fall
        // back to the whole-source decode, which still WORKS, and say so rather than let
        // a long clip quietly hit the memory ceiling the option exists to avoid.
        const wantStream = memMode === "stream";
        const streamSource = wantStream && await comfyHasNodes(["VHS_LoadVideo"]);
        if (wantStream && !streamSource) scailStreamNote = "vhs-missing";
        workflow = buildScail2({
          streamSource, sourceFps: sfps,
          model, prompt, negative: negative_prompt || "", comp, videoName, refImageNames,
          width: aw, height: ah, seed, segments, replace: scail2Replace, incrementalSave,
          // SAM3 is open-vocabulary: the subject is text, not a fixed "human". The
          // reference falls back to the driving subject inside the builder — they only
          // differ when the driving text targets one person in a crowd ("person in a red
          // shirt") while the reference holds just the character.
          sam3VideoObject: opts.scailSubject,
          sam3ImageObject: opts.scailRefSubject,
          objectIndices: opts.scailIndices,
          sortBy: opts.scailSortBy,
          scailRecipe: opts.scailRecipe,
          poseStrength: opts.poseStrength,
          poseStart: opts.poseStart,
          poseEnd: opts.poseEnd,
          detectionThreshold: opts.scailThreshold,
          maxObjects: opts.scailMaxObjects,
          // TorchCompileModelAdvanced ships with KJNodes, not comfy-core, and it is the
          // ONLY variant that survives SCAIL-2's fp8 weights (see buildScail2). Silently
          // skip the speed-up rather than submit a graph that would fail validation.
          torchCompile: !!opts.torchCompile && await comfyHasNodes(["TorchCompileModelAdvanced"]),
        });
        // Node id → segment order. NOT filenames: stampOutputPrefix gives every SaveVideo
        // the same prefix, so ComfyUI's counter is all that separates them.
        if (incrementalSave) segmentMerge = { label: "SCAIL-2", saveNodeIds: segments.map((_, k) => scail2SaveNodeId(k)), sourceName: videoName };
        videoDims = { width: aw, height: ah, length: totalFrames, fps: sfps, segments: segments.length };
        if (truncatedFrom) videoDims.truncatedFrom = truncatedFrom;
      } else if (videoType === "animate" && !sourceVideo && !sourceVideoName) {
        // Wan Animate SINGLE-FRAME (no source video, TWO images → an IMAGE):
        //  • MOVE still    → image[0] = pose source, image[1] = character; the character
        //    adopts the pose on a clean background.
        //  • REPLACE still → image[0] = a SCENE (person to swap + background to keep),
        //    image[1] = character; the character replaces the person, scene preserved.
        // Both hold STILL_FRAMES frames and return the last settled frame.
        if (!(Array.isArray(images) && images.length >= 2)) {
          const err = animateReplace
            ? "Wan Animate (Replace, single image) needs two images: image 1 = scene (containing the person to replace), image 2 = character (or attach a source video for multiple frames)."
            : "Wan Animate single frame needs two images: image 1 = pose, image 2 = character (or attach a source video for a multi-frame motion).";
          sendJson(res, 400, { error: err });
          return;
        }
        const comp = await animateCompanions();
        // Output size. A ⚙/--size budget (when set) wins → scaled to the pose aspect.
        // "auto" (no size) → use the POSE image's OWN size (capped to STILL_MAX_SIDE so a
        // huge source can't OOM), /16-snapped — a still isn't time-critical and the extra
        // pixels sharpen small faces/hands. Falls back to 896² if the pose dims are unknown.
        const STILL_MAX_SIDE = 1536;
        const d0 = imageDims(images[0]);
        let aw, ah;
        if (opts.width && opts.height) {
          const aspect = (d0 && d0.width > 0) ? d0.width / d0.height : (opts.width / opts.height);
          const budget = opts.width * opts.height;
          aw = snapDim(Math.sqrt(budget * aspect), 16);
          ah = snapDim(Math.sqrt(budget / aspect), 16);
        } else if (d0 && d0.width > 0 && d0.height > 0) {
          const s = Math.min(1, STILL_MAX_SIDE / Math.max(d0.width, d0.height));
          aw = snapDim(d0.width * s, 16);
          ah = snapDim(d0.height * s, 16);
        } else {
          aw = ah = snapDim(896, 16);
        }
        // DISTINCT filenames — uploadImage defaults to "heykoko_input.png" with
        // overwrite, so two default-named uploads would clobber each other (the pose
        // would become the character → DWPose reads the character's own pose → no
        // transfer). Name them apart.
        const poseImageName = await uploadImage(images[0], controller.signal, "heykoko_pose.png");
        const refImageName = await uploadImage(images[1], controller.signal, "heykoko_animref.png");
        imagesUsed = 2;
        stillMode = true;
        workflow = buildWanAnimateStill({ model, prompt, negative: negative_prompt || "", comp, poseImageName, refImageName, width: aw, height: ah, seed, torchCompile: !!opts.torchCompile, relightStrength: opts.relightStrength, replace: animateReplace, maskPoint: opts.maskPoint });
        videoDims = { width: aw, height: ah };
      } else if (videoType === "animate") {
        // Wan Animate MOVE (pose transfer): reference person image + source video
        // (the motion) → the character does the video's motion. Needs BOTH.
        if (!(Array.isArray(images) && images.length)) { sendJson(res, 400, { error: "Wan Animate needs a person reference image (plus an attached motion source video)." }); return; }
        // ⚙ long-clip memory. Animate shares the knob with SCAIL-2 but only has the OUTPUT
        // half of the problem to fix, so "stream" and "incremental" mean the same thing
        // here — the source-streaming half does not port (see buildWanAnimate's header).
        const animIncremental = opts.scailMemoryMode !== "off";
        // FAIL FAST, before anything is uploaded — same reason as SCAIL-2: the clips are
        // joined here after the render, so a missing binary must not surface an hour later.
        if (animIncremental) {
          const missing = [];
          for (const tool of ["ffmpeg", "ffprobe"]) if (!(await hasLocalTool(tool))) missing.push(tool);
          if (missing.length) {
            sendJson(res, 400, { error: `Wan Animate needs ${missing.join(" and ")} on this machine (the one running hey-koko, not the ComfyUI box) to join the rendered chunks and lay the soundtrack over them. Install it (macOS: brew install ffmpeg) — or set ⚙ "Long-clip memory" to Off, which has ComfyUI write one finished file and needs no ffmpeg at all, at the cost of holding every chunk in memory (long clips will run out of it).` });
            return;
          }
        }
        const comp = await animateCompanions();
        // Output follows the SOURCE video's aspect (the pose is scaled to it), at
        // the preset budget (or --size budget). Both dims must be /16.
        let aspW = Number(sourceVideoWidth), aspH = Number(sourceVideoHeight);
        let aw = snapDim(opts.width || 640, 16);
        let ah = snapDim(opts.height || 640, 16);
        if (aspW > 0 && aspH > 0) {
          const aspect = aspW / aspH;
          const budget = (opts.width && opts.height) ? opts.width * opts.height : 640 * 640;
          aw = snapDim(Math.sqrt(budget * aspect), 16);
          ah = snapDim(Math.sqrt(budget / aspect), 16);
        }
        // Chunk schedule. A source longer than the single-pass cap (which scales down
        // with resolution for VRAM) is generated as N chained chunks IN ONE graph
        // (continue_motion → seamless). Deterministic per the LIVE-VERIFIED node rule:
        // offset_out = offset_in + length − trim, trim = continue_motion_max_frames(5)
        // for k>0 else 0. A pinned ⚙ length forces one bounded pass.
        const snap4 = (n) => Math.max(5, Math.floor((n - 1) / 4) * 4 + 1); // 4n+1, ≤ n
        const srcFrames = Number(sourceVideoFrames) || 0;
        const segCap = animateSegmentCap(aw * ah, !!opts.torchCompile, await comfyVramGib());
        const OVERLAP = 5; // == continue_motion_max_frames in buildWanAnimate
        let chunks, truncatedFrom;
        if (opts.length) {
          chunks = [{ offset: 0, length: snap4(Math.min(opts.length, segCap)) }];
          if (srcFrames > chunks[0].length) truncatedFrom = srcFrames; // pinned length cut the clip
        } else if (srcFrames > 0) {
          chunks = [];
          let off = 0, k = 0;
          while (off < srcFrames) {
            const len = snap4(Math.min(segCap, srcFrames - off));
            if (k > 0 && len <= OVERLAP) break; // can't trim the overlap from ≤5 frames
            chunks.push({ offset: off, length: len });
            off = off + len - (k > 0 ? OVERLAP : 0); // = this chunk's video_frame_offset OUTPUT
            k++;
            if (k > 400) break; // safety
          }
        } else {
          chunks = [{ offset: 0, length: 77 }];
        }
        // Total output frames = chunk0 length + Σ(later chunk length − overlap).
        const totalFrames = chunks.reduce((a, c, i) => a + c.length - (i > 0 ? OVERLAP : 0), 0);
        const afps = Number(sourceVideoFps) || opts.fps || 16;
        const videoName = sourceVideoName || await uploadVideo(sourceVideo, controller.signal, sourceVideoMime);
        const refImageName = await uploadImage(images[0], controller.signal);
        imagesUsed = 1;
        workflow = buildWanAnimate({ model, prompt, negative: negative_prompt || "", comp, videoName, refImageName, width: aw, height: ah, seed, fps: afps, torchCompile: !!opts.torchCompile, chunks, replace: animateReplace, relightStrength: opts.relightStrength, maskPoint: opts.maskPoint, incrementalSave: animIncremental });
        // Node id → chunk order. NOT filenames — see animateSaveNodeId.
        if (animIncremental) segmentMerge = { label: "Wan Animate", saveNodeIds: chunks.map((_, k) => animateSaveNodeId(k)), sourceName: videoName };
        videoDims = { width: aw, height: ah, length: totalFrames, fps: afps, segments: chunks.length };
        if (truncatedFrom) videoDims.truncatedFrom = truncatedFrom;
      } else if (videoType === "phantom") {
        // Phantom subject-to-video: reference subject image(s) + prompt → a video that
        // keeps those subjects, NO driving video. Needs at least one image.
        const hasImage = Array.isArray(images) && images.length > 0;
        if (!hasImage) { sendJson(res, 400, { error: "Phantom needs at least one reference image of the subject(s) to keep. Attach 1-4 images, then use /imagine <description of the scene/action>." }); return; }
        // ⚙ turbo is a REQUEST — companions only mount the LoRA when one is installed
        // and the model is 14B, so everything downstream keys off comp.lora, never off
        // the request. Asking for turbo on 1.3B silently runs the normal recipe.
        const comp = await phantomCompanions(model, !!opts.phantomTurbo);
        const phTurbo = !!comp.lora;
        if (phTurbo) phantomTurboUsed = { lora: comp.lora };
        // Size follows the FIRST reference's aspect at the preset budget (a portrait
        // subject → a portrait video), same as the i2v path. --size sets the budget.
        let aspW = Number(refImageWidth), aspH = Number(refImageHeight);
        if (!(aspW > 0 && aspH > 0)) { const d = imageDims(images[0]); if (d) { aspW = d.width; aspH = d.height; } }
        const vOpts = { ...opts };
        if (aspW > 0 && aspH > 0) vOpts.aspect = aspW / aspH;
        const v = resolveVideoConfig("phantom", vOpts, model, phTurbo);
        // g_img (cfg_cond2_negative) — the second, image-fidelity scale, controlling how
        // hard the subject's appearance is enforced vs. the text. Its own ⚙ knob (the
        // ip2p imageCfg field is a different range/meaning); v.cfg carries g_text.
        // g_img must follow cfg to 1 under turbo: with both scales at 1 the guider's
        // formula (neg + a*(pos_i - neg) + b*(pos_it - pos_i)) reduces to pos_it, which
        // is exactly the un-guided input a cfg-distilled LoRA expects. A user-set g_img
        // is ignored here rather than honoured — honouring it would re-introduce the
        // guidance the LoRA was trained without, and burn the output.
        const imgCfg = phTurbo ? 1 : (opts.phantomImgCfg > 0 ? opts.phantomImgCfg : 5.0);
        // Up to PHANTOM_MAX_REFS subjects, distinct filenames (shared name + overwrite
        // would collapse them to the last image).
        const refs = images.slice(0, PHANTOM_MAX_REFS);
        const imageNames = [];
        for (let i = 0; i < refs.length; i++) imageNames.push(await uploadImage(refs[i], controller.signal, `heykoko_phantom${i}.png`));
        imagesUsed = imageNames.length;
        workflow = buildPhantom({ model, prompt, negative: negative_prompt || "", comp, imageNames, seed, v, imgCfg });
        videoDims = { width: v.width, height: v.height, length: v.length, fps: v.fps };
      } else if (videoType === "infinitetalk") {
        // InfiniteTalk, two entries sharing one branch:
        //  • dub (V2V): SOURCE VIDEO (motion/identity/scene) + SPEECH AUDIO. Both required;
        //    the prompt is optional flavour text.
        //  • speak (I2V "photo speaks"): PERSON PHOTO + speech. The speech is an attached
        //    audio file — or, with none, `speechText` (the RAW /imagine prompt, sent
        //    separately so ⚙ prompt-decoration/enhancement can't pollute the read text)
        //    is synthesized by the local TTS daemon (Kokoro, same engine as /voice).
        const speak = model === INFINITETALK_SPEAK;
        const hasAud = !!(sourceAudio || sourceAudioName);
        const speechText = String(body.speechText || prompt || "").trim();
        if (speak) {
          if (!hasImgInput) { sendJson(res, 400, { error: "InfiniteTalk (photo speaks) needs a person photo. Attach one, then /imagine <text to read> (or attach an audio file instead of text)." }); return; }
          if (!hasAud && !speechText) { sendJson(res, 400, { error: "InfiniteTalk (photo speaks) needs the speech: /imagine <text to read> (synthesized locally), or attach an audio file." }); return; }
        } else {
          if (!(sourceVideo || sourceVideoName)) { sendJson(res, 400, { error: "InfiniteTalk needs a source video (the clip to re-lip-sync). Attach a video plus a speech audio file, then /imagine." }); return; }
          if (!hasAud) { sendJson(res, 400, { error: "InfiniteTalk needs a speech audio file (the new voice track). Attach one alongside the source video." }); return; }
        }
        const comp = await infinitetalkCompanions();
        // Output follows the SOURCE's aspect (video for dub, photo for speak) at the
        // model's native 832×480 budget (or the ⚙/--size budget), both dims /16.
        let aspW = Number(sourceVideoWidth), aspH = Number(sourceVideoHeight);
        if (speak) {
          aspW = Number(refImageWidth); aspH = Number(refImageHeight);
          if (!(aspW > 0 && aspH > 0) && hasImgInput) {
            const d = imageDims(images[0]);
            if (d) { aspW = d.width; aspH = d.height; }
          }
        }
        let iw = snapDim(opts.width || 832, 16), ih = snapDim(opts.height || 480, 16);
        if (aspW > 0 && aspH > 0) {
          const aspect = aspW / aspH;
          const budget = (opts.width && opts.height) ? opts.width * opts.height : 832 * 480;
          iw = snapDim(Math.sqrt(budget * aspect), 16);
          ih = snapDim(Math.sqrt(budget / aspect), 16);
        }
        // Output length = AUDIO length (frames = duration × fps; dub follows the source's
        // fps, speak runs at InfiniteTalk's native 25). num_frames on the embeds node is
        // only a CAP; ⚙ length lowers it (e.g. quick tests). If the audio outruns a dub's
        // clip, the tail extends from the last frame.
        const iFps = speak ? (opts.fps || 25) : (Number(sourceVideoFps) || opts.fps || 25);
        const maxFrames = opts.length ? Math.max(5, Math.round(opts.length)) : (speak ? 500 : 1000);
        let audioName;
        let audioDur = Number(sourceAudioDuration) || 0;
        if (sourceAudioName) audioName = sourceAudioName;
        else if (sourceAudio) audioName = await uploadAudio(sourceAudio, controller.signal, sourceAudioMime);
        else {
          // speak + text → local TTS. Voice: ⚙/--voice (accepts "kokoro:zf_xiaoxiao" or a
          // bare id), else auto-picked by script (CJK → Mandarin female, otherwise US female).
          const vPref = String(opts.ttsVoice || "").trim();
          const engine = vPref.includes(":") ? vPref.split(":")[0] : "kokoro";
          const vId = (vPref.includes(":") ? vPref.split(":")[1] : vPref)
            || (/[぀-ヿ一-鿿]/.test(speechText) ? "zf_xiaoxiao" : "af_heart");
          let wavPath;
          try {
            wavPath = await synthToWav({ engine, voice: vId, text: speechText, speed: 1 });
          } catch (e) {
            sendJson(res, 502, { error: `Local TTS failed (${String((e && e.message) || e)}). Attach an audio file instead, or check the TTS setup used by /voice.` });
            return;
          }
          const wavBuf = await fsp.readFile(wavPath);
          audioDur = (await probeAudioDuration(wavBuf)) || audioDur;
          audioName = await uploadAudioBuffer(wavBuf, "audio/wav", controller.signal);
        }
        let videoName = null, imageName = null;
        if (speak) { imageName = await uploadImage(images[0], controller.signal, "heykoko_itref.png"); imagesUsed = 1; }
        else videoName = sourceVideoName || await uploadVideo(sourceVideo, controller.signal, sourceVideoMime);
        // Scene prompt: dub (and speak-with-audio) keep the user prompt; speak-with-TTS
        // reads the prompt ALOUD, so the scene falls back to the builder's generic default.
        const scenePrompt = (speak && !hasAud) ? "" : prompt;
        workflow = buildInfiniteTalk({ prompt: scenePrompt, negative: negative_prompt || "", comp, videoName, imageName, audioName, width: iw, height: ih, fps: iFps, maxFrames, seed });
        videoDims = { width: iw, height: ih, fps: iFps };
        const audioFrames = audioDur > 0 ? Math.round(audioDur * iFps) : 0;
        if (audioFrames) videoDims.length = Math.min(audioFrames, maxFrames);
      } else if (videoType === "dancer") {
        // Wan-Dancer: reference PHOTO + MUSIC file → the character dances to the track.
        // Both are hard requirements — the audio is the driving signal (the global
        // expert plans keyframes from the full trimmed track), not a soundtrack.
        if (!hasImgInput) { sendJson(res, 400, { error: "Wan-Dancer needs a reference photo of the dancer. Attach one, plus a music file, then /imagine." }); return; }
        if (!(sourceAudio || sourceAudioName)) { sendJson(res, 400, { error: "Wan-Dancer needs a music file (the track to dance to). Attach an audio file alongside the photo." }); return; }
        const comp = await wanDancerCompanions(model);
        // Output follows the PHOTO's aspect at the template's 720×1280 budget (or the
        // ⚙/--size budget). Both dims MUST be /64, not the /16 the template floors to:
        // the dancer transformer rearranges the sequence as (t·8) chunks, so the
        // per-frame token count (W/16)·(H/16) must divide by 8 — /64 on both sides
        // guarantees it (÷16), while /16 crashes SamplerCustomAdvanced on most photo
        // aspects ("can't divide axis of length N in chunks of t·8"). The template's
        // own 720×1280 only works because 45×80 happens to divide.
        let aspW = Number(refImageWidth), aspH = Number(refImageHeight);
        if (!(aspW > 0 && aspH > 0)) {
          const d = imageDims(images[0]);
          if (d) { aspW = d.width; aspH = d.height; }
        }
        // Default budget = the template's SMALL preset (480×832 — the WanDancerVideo
        // widget defaults), NOT its 720×1280 exposed default: both stages sample a
        // fixed 149-frame window whatever the duration, so attention cost grows
        // ~quadratically with resolution. At 768×1152 that is ~131k tokens/pass — a
        // single 5-second turbo run blew past 15 minutes on the RTX 5090 (measured,
        // interrupted); 480×832 is ~59k tokens, roughly 4-5× faster. ⚙/--size
        // 720x1280 buys the full-quality render back for final takes.
        let dw = snapDim(opts.width || 448, 64), dh = snapDim(opts.height || 832, 64);
        if (aspW > 0 && aspH > 0) {
          const aspect = aspW / aspH;
          const budget = (opts.width && opts.height) ? opts.width * opts.height : 480 * 832;
          dw = snapDim(Math.sqrt(budget * aspect), 64);
          dh = snapDim(Math.sqrt(budget / aspect), 64);
        }
        // Duration: ⚙ pick, else the attached track's length — snapped DOWN to a
        // multiple of 5 s (each segment is 149 frames ≈ 5 s @ 30 fps), capped at the
        // template's 30 s ceiling (global plans the WHOLE track in one 149-frame
        // window, so keyframe density thins as duration grows).
        const audioDur = Number(sourceAudioDuration) || 0;
        const snap5 = (s) => Math.min(30, Math.max(5, Math.floor(s / 5) * 5));
        const duration = opts.danceDuration > 0 ? snap5(opts.danceDuration) : (audioDur > 0 ? snap5(audioDur) : 5);
        const segments = Math.round(duration / 5);
        // Dance style: ⚙ pick, else sniffed from the prompt, else the template's
        // default (Latin). The five styles are the ones the model was trained on;
        // the words are injected into the fixed Chinese recipe prompt.
        const STYLES = { classic: "古典舞", kpop: "韩舞", street: "街舞", latin: "拉丁舞", tap: "踢踏舞" };
        const sniff = (p) => {
          if (/古典|classic/i.test(p)) return "classic";
          if (/韩舞|k.?pop/i.test(p)) return "kpop";
          if (/街舞|street|hip.?hop|breaking/i.test(p)) return "street";
          if (/踢踏|tap/i.test(p)) return "tap";
          if (/拉丁|latin|salsa/i.test(p)) return "latin";
          return null;
        };
        const styleKey = STYLES[opts.danceStyle] ? opts.danceStyle : (sniff(String(prompt || "")) || "latin");
        const AMPS = { low: "低", medium: "中等", high: "高", max: "最大" };
        const ampWord = AMPS[opts.danceAmplitude] || AMPS.low;
        const imageName = await uploadImage(images[0], controller.signal, "heykoko_dancer_ref.png");
        imagesUsed = 1;
        const audioName = sourceAudioName || await uploadAudio(sourceAudio, controller.signal, sourceAudioMime);
        // Turbo (template default): global expert distill-LoRA×3 / 6 steps / cfg 1.
        // ⚙ quality: 25 steps / cfg 5 / no LoRA on the global stage (local stays distilled).
        const dTurbo = !opts.danceQuality;
        workflow = buildWanDancer({ prompt, negative: negative_prompt || "", comp, imageName, audioName, width: dw, height: dh, seed, turbo: dTurbo, duration, segments, styleWord: STYLES[styleKey], ampWord });
        videoDims = { width: dw, height: dh, length: segments * 149, fps: 30 };
      } else if (videoType === "ltx-union") {
        // LTX Union Control: depth of the SOURCE VIDEO drives a new clip; the reference
        // image sets appearance. Needs BOTH a source video and one reference image.
        if (!sourceVideo && !sourceVideoName) { sendJson(res, 400, { error: "LTX union control needs a source video (the motion/structure to follow) plus a reference image (the appearance). Attach a video, then /imagine <description> with a reference image." }); return; }
        if (!(Array.isArray(images) && images.length)) { sendJson(res, 400, { error: "LTX union control needs a reference image for the appearance (attach one image alongside the source video)." }); return; }
        const comp = await videoCompanions("ltx-union", model, opts);
        const v = resolveVideoConfig("ltx-union", opts, model, false);
        // Output size follows the SOURCE video's aspect at the preset budget (depth is
        // computed from that video, so matching its aspect keeps the structure aligned).
        // Both dims MUST be /64 — the union IC-LoRA's reference_downscale_factor 2 needs the
        // latent (dim/32) even, so /32 alone (an odd latent dim) makes LTXVAddGuide fail.
        let aw = snapDim(v.width, 64), ah = snapDim(v.height, 64);
        const sw = Number(sourceVideoWidth), sh = Number(sourceVideoHeight);
        if (sw > 0 && sh > 0) {
          const aspect = sw / sh;
          const budget = (opts.width && opts.height) ? opts.width * opts.height : v.width * v.height;
          aw = snapDim(Math.sqrt(budget * aspect), 64);
          ah = snapDim(Math.sqrt(budget / aspect), 64);
        } else if (opts.width && opts.height) { aw = snapDim(opts.width, 64); ah = snapDim(opts.height, 64); }
        v.width = aw; v.height = ah;
        // Length follows the DRIVING VIDEO by default — union control's whole job is to
        // track that clip, so "auto" uses its full frame count (the preset's 97 is only the
        // fallback when the source length is unknown). The cap is the single-pass ceiling:
        // there is no in-graph chaining here (unlike Wan Animate), so the entire clip renders
        // in one pass and a very long source (> ~10s) is truncated to UNION_HARD_CAP and
        // noted. ⚙ length overrides — down for a quick test, up to the same ceiling.
        const uFps = Number(sourceVideoFps) || v.fps || 25;
        const srcFrames = Number(sourceVideoFrames) || 0;
        const UNION_HARD_CAP = 241;
        const wantFrames = opts.length ? Math.min(opts.length, UNION_HARD_CAP) : (srcFrames ? Math.min(srcFrames, UNION_HARD_CAP) : v.length);
        const durationSec = wantFrames / uFps;
        const videoName = sourceVideoName || await uploadVideo(sourceVideo, controller.signal, sourceVideoMime);
        const refImageName = await uploadImage(images[0], controller.signal, "heykoko_unionref.png");
        imagesUsed = 1;
        workflow = buildLtxUnionControl({ prompt, negative: negative_prompt || "", comp, imageName: refImageName, videoName, durationSec, v, seed });
        const outFrames = srcFrames ? Math.min(wantFrames, srcFrames) : wantFrames;
        videoDims = { width: v.width, height: v.height, length: outFrames, fps: v.fps };
        if (srcFrames > wantFrames) videoDims.truncatedFrom = srcFrames; // pinned/preset length cut the clip
      } else if (videoType === "minimax-h3") {
        // MiniMax H3. Two weight files with different input contracts, one branch:
        //   fl2va  — 0-2 attached images become first_frame / last_frame (none = t2v)
        //   ref2va — every attached image is a REFERENCE (≤9); an attached video and/or
        //            audio are references too — exemplars for motion / camera / voice,
        //            NOT a clip to edit, so the source video is never carried through
        // Neither graph has a negative branch, so a typed negative prompt is inert here —
        // the "don't do X" instructions belong in the prompt itself, which is also where
        // the soundtrack is described (dialogue, SFX, music are part of the same prompt).
        const isRef = /ref2va/i.test(model);
        // ref2va needs SOMETHING to reference, but the node's own minimum for each of the
        // four groups is 0 — images, a clip and an audio file are interchangeable ways of
        // giving it one. So the gate is "at least one reference of any kind", not "at
        // least one image"; with nothing attached it would be a worse t2v than fl2va.
        const hasRef = (Array.isArray(images) && images.length) || sourceVideoName || sourceVideo || sourceAudioName || sourceAudio;
        if (isRef && !hasRef) {
          sendJson(res, 400, { error: "MiniMax H3 (r2v) needs at least one reference to work from — attach images (up to 9), a video, an audio file, or any combination, then /imagine <description>. For plain text→video or first/last-frame, pick MiniMax H3 (t2v / i2v) instead." });
          return;
        }
        const comp = await videoCompanions("minimax-h3", model, opts);
        const vOpts = { ...opts };
        // Render at the first attachment's aspect ratio (keeping the preset's pixel
        // budget) unless a size was pinned — same reasoning as the generic i2v path: a
        // stretched conditioning frame is what produces ghosted / doubled edges.
        if (Array.isArray(images) && images.length && !opts.width && !opts.height) {
          const dims = imageDims(images[0]);
          if (dims && dims.width && dims.height) vOpts.aspect = dims.width / dims.height;
        }
        const v = resolveVideoConfig("minimax-h3", vOpts, model, false);
        let firstFrameName = null, lastFrameName = null, refImageNames = null;
        if (isRef) {
          // DISTINCT filenames per reference — uploadImage overwrites by name, so a shared
          // default would collapse all nine references onto the last image.
          refImageNames = [];
          // May legitimately be empty now: a clip or an audio file on its own is a valid
          // reference set, so `images` can be absent entirely.
          const refs = (Array.isArray(images) ? images : []).slice(0, H3_MAX_REF_IMAGES);
          for (let i = 0; i < refs.length; i++) refImageNames.push(await uploadImage(refs[i], controller.signal, `heykoko_h3ref${i}.png`));
          imagesUsed = refImageNames.length;
        } else if (Array.isArray(images) && images.length) {
          firstFrameName = await uploadImage(images[0], controller.signal, "heykoko_h3first.png");
          imagesUsed = 1;
          if (images.length >= 2) {
            lastFrameName = await uploadImage(images[1], controller.signal, "heykoko_h3last.png");
            imagesUsed = 2;
          }
        }
        // ref2va's optional exemplars. The node takes up to 3 of each, but the request
        // shape carries a single source video and a single audio file, so one of each is
        // all that can arrive here — the builder writes them at index 0.
        let refVideoName = null, refAudioName = null;
        if (isRef) {
          if (sourceVideoName || sourceVideo) refVideoName = sourceVideoName || await uploadVideo(sourceVideo, controller.signal, sourceVideoMime);
          if (sourceAudioName || sourceAudio) refAudioName = sourceAudioName || await uploadAudio(sourceAudio, controller.signal, sourceAudioMime);
        }
        workflow = buildMiniMaxH3({ model, prompt, comp, v, seed,
          firstFrameName, lastFrameName, refImageNames, refVideoName, refAudioName,
          refImageSize: opts.h3RefSize, easyCache: !!opts.easyCache });
        videoDims = { width: v.width, height: v.height, length: v.length, fps: v.fps };
      } else if (model === PANO_T2I) {
        // A recipe, not a checkpoint: it picks its own weights and forces 2:1, since
        // an equirectangular panorama is 360° across and 180° tall by definition.
        const [panoCkpts, panoUnets] = await Promise.all([
          comfyEnum("CheckpointLoaderSimple", "ckpt_name").catch(() => []),
          comfyEnum("UNETLoader", "unet_name").catch(() => []),
        ]);
        const eligible = [
          ...panoCkpts.filter((n) => !editTypeOf(n) && !videoTypeOf(n) && !meshTypeOf(n)
            && !/hidream/i.test(n) && !isCompanionModel(n)),
          ...panoUnets.filter((n) => (/z.?image/i.test(n) || /boogu/i.test(n)) && !editTypeOf(n)),
        ];
        // ⚙ choice wins if it is still installed; otherwise prefer a panorama-tuned
        // checkpoint, then Flux (measured: its raw wrap is twice as good as
        // z-image's), then whatever else can generate.
        const ck = (opts.panoModel && eligible.includes(opts.panoModel)) ? opts.panoModel
          : (eligible.find((n) => /pano|equirect|360/i.test(n))
            || eligible.find((n) => /flux/i.test(n))
            || eligible[0]);
        if (!ck) {
          sendJson(res, 400, { error: "360° panorama needs a text-to-image checkpoint in ComfyUI models/checkpoints/." });
          return;
        }
        // Sampler settings follow the CHOSEN base, not the sentinel — an SDXL pick
        // needs dpmpp_2m/karras/cfg 7 and no guidance node; a distilled one needs
        // cfg 1 and a zeroed negative.
        panoCfg = resolveConfig(ck, opts);
        panoBase = ck;
        // A UNET model brings no CLIP or VAE of its own; both families this recipe
        // accepts sit on an AuraFlow shift and run distilled.
        const isUnetBase = panoUnets.includes(ck);
        let unetParts = {};
        if (isUnetBase) {
          const comp = /boogu/i.test(ck) ? await boogiCompanions() : await zimageCompanions();
          unetParts = { unet: ck, unetClip: comp.clip, unetVae: comp.vae,
            unetClipType: /boogu/i.test(ck) ? "boogu" : "lumina2",
            shift: 3.0, zeroNegative: panoCfg.cfg <= 1.01 };
        }
        // With a photo attached the client has already reprojected it onto the
        // sphere, so the SIZE is whatever it produced — reading it back off the
        // upload avoids two places computing the same number and disagreeing, which
        // would misalign every crop in the seam repair.
        let pw, ph, panoImageName = "";
        if (hasImgInput) {
          const d = imageDims(images[0]);
          if (!d) {
            sendJson(res, 400, { error: "Could not read the attached image." });
            return;
          }
          if (Math.abs(d.width / d.height - 2) > 0.02) {
            // Only reachable by calling the API directly: the app always sends the
            // reprojected canvas, never the raw photo.
            sendJson(res, 400, { error: `A 360° panorama is 2:1. This chain expects an already-reprojected equirectangular image, got ${d.width}x${d.height}.` });
            return;
          }
          pw = d.width; ph = d.height;
          panoImageName = await uploadImage(images[0], controller.signal, "heykoko_pano_src.png");
          imagesUsed = 1;
        } else {
          pw = Math.max(768, Math.min(2048, (opts.width || 1536) & ~15));
          ph = pw >> 1;
        }
        panoDims = { w: pw, h: ph };
        // How far round the photo reaches decides how wide the seam band may be: the
        // band sits half a turn from the photo, so it may grow until it meets the
        // photo's far edge and no further, or the repair repaints the user's picture.
        const coverDeg = Math.max(0, Math.min(360, Number(opts.panoCoverDeg) || 0));
        const freeDeg = 180 - coverDeg / 2 - 10;    // 10° of margin so they never touch
        const panoBand = !coverDeg ? 1 / 3 : (freeDeg <= 5 ? 0 : Math.min(1 / 3, (2 * freeDeg) / 360));
        // Without this the model just paints an ordinary photo at 2:1 — verified: a
        // plain scene description came back as a normal wide shot, no panoramic
        // projection at all. The cue goes in front so the user's own wording still
        // leads the composition.
        // Stays strictly below 1: at 1 the noise mask discards the pre-fill and the
        // photo stops influencing anything around it.
        if (panoImageName) panoOutpaintUsed = Math.max(0.4, Math.min(0.98, Number(opts.panoOutpaint) || 0.85));
        const panoPrompt = /equirect|360|panoram/i.test(prompt)
          ? prompt
          : `equirectangular 360 degree panorama, full spherical VR photo, seamless wraparound. ${prompt}`;
        // A panorama LoRA is trained on ONE base family. Every one available today is
        // for Flux, so mounting it on an SDXL or z-image pick would load almost no
        // matching keys and silently do nothing — better to drop it and say so than
        // to let the user believe it is on.
        //
        // Empty means AUTO, matching how the base checkpoint is chosen just above:
        // installing an equirectangular LoRA is enough, no second step.
        //
        // But only when generating from TEXT. The zenith row of an equirect is one
        // single point in space and so must be nearly constant; measured at a fixed
        // seed, text-only without the LoRA it varies as much as the horizon does
        // (1.07, and 1.50 at the nadir) — that is the vortex underfoot — and with it,
        // 0.05 / 0.31, against 0.09 / 0.16 for a real photographed panorama.
        //
        // With a PHOTO the poles are already right without it: the pre-fill smears
        // the photo's edges outwards, and that construction converges at the poles by
        // itself (measured 0.01 / 0.07, tighter than the real photo). So the LoRA has
        // no pole left to fix there and its flatten-towards-the-poles prior costs
        // ground detail instead — the bottom quarter's texture fell 0.70 → 0.24 at
        // full strength. Auto therefore leaves it off for a photo; ⚙ still forces it
        // either way, and "off" is how the user declines it for text.
        const askLora = String(opts.panoLora || "").trim();
        let wantLora = "";
        if (askLora === "off") wantLora = "";
        else if (askLora) wantLora = askLora;
        else if (!panoImageName) {
          const installed = await comfyEnum("LoraLoaderModelOnly", "lora_name").catch(() => []);
          wantLora = installed.find((n) => /equirect|panoram|360/i.test(n)) || "";
        }
        if (wantLora && !/flux/i.test(ck)) panoLoraSkipped = { name: wantLora, base: ck, auto: !askLora };
        else if (wantLora) panoLoraUsed = { name: wantLora, strength: Math.max(0, Math.min(2, Number(opts.panoLoraStrength) || 1)), auto: !askLora };
        workflow = buildPanorama360({ ...(isUnetBase ? unetParts : { ckpt: ck }),
          lora: panoLoraUsed ? panoLoraUsed.name : "",
          loraStrength: panoLoraUsed ? panoLoraUsed.strength : 1,
          prompt: panoPrompt, negative: negative_prompt || "",
          seed, steps: panoCfg.steps, cfg: panoCfg.cfg, guidance: panoCfg.guidance,
          sampler: panoCfg.sampler, scheduler: panoCfg.scheduler, sd3Latent: panoCfg.sd3Latent !== false,
          width: pw, height: ph, bandFrac: panoBand,
          imageName: panoImageName,
          outpaintDenoise: panoOutpaintUsed || 0.85,
          seamRepair: opts.panoSeamRepair !== false });
      } else if (meshType) {
        // 3D mesh generation — every chain is image-driven (no text conditioning
        // anywhere in these graphs), so an attached image is mandatory.
        if (!hasImgInput) {
          sendJson(res, 400, { error: "This model turns an image into a 3D model. Attach an image first, then use /imagine." });
          return;
        }
        const imageName = await uploadImage(images[0], controller.signal, "heykoko_mesh_in.png");
        imagesUsed = 1;
        // 🖌 mask: the painted region IS the subject here (in the edit chains it is
        // the region to change). Nothing else in a 3D graph consumes a mask, so
        // there is no other reading, and it saves the user fighting the auto cut-out.
        const meshMaskName = hasMask ? await uploadImage(mask, controller.signal, "heykoko_mesh_mask.png") : null;
        // ⚙ "3D mesh detail" is one knob over both meshers — Hunyuan3D's octree
        // resolution and SplatToMesh's density grid mean the same thing.
        const meshDetail = opts.meshDetail || 256;
        if (meshType === "hunyuan3d") {
          const comp = await meshCompanions("hunyuan3d");
          // Texturing is ON unless the ⚙ box is cleared — and only where the wrapper
          // is installed, so a stock ComfyUI silently makes a white mesh instead of
          // failing on a checkbox the user never touched.
          const paint = opts.paintMesh !== false && comp.paint;
          // Its exporter writes straight to disk and reports NOTHING to /history
          // (verified: the run's outputs list only ever contained the SaveGLB nodes),
          // so the file has to be fetched by name. A per-run token keeps the prefix
          // unused, which pins ComfyUI's counter at _00001_.
          if (paint) paintGlb = `${OUT_3D}/paint_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
          workflow = buildHunyuan3D({ ckpt: model, imageName, seed,
            steps: opts.steps || 30, cfg: opts.cfg !== undefined ? opts.cfg : 5,
            sampler: opts.sampler || "euler", scheduler: opts.scheduler || "normal",
            octreeRes: meshDetail,
            // ⚙ shape detail budget = how many latent tokens describe the surface.
            // Upstream of octreeRes: this decides how much structure the model
            // invents, octree only decides how finely that is triangulated. Floored
            // at 2048 — measured, 1024 doesn't come out coarse, it comes out as
            // scattered fragments (3958 faces vs 181k at the 4096 default).
            ...(opts.shapeTokens ? { resolution: Math.max(2048, Math.min(8192, opts.shapeTokens)) } : {}),
            // ⚙ "keep background" opts out for the rare case the cut-out misfires.
            // A painted mask overrides it: it is a deliberate, per-image gesture,
            // while the checkbox is a sticky setting the user may have left ticked
            // months ago — honouring the stale one would discard the fresh one.
            maskName: meshMaskName,
            bgRemoval: (opts.keepBackground && !meshMaskName) ? null : comp.birefnet,
            autoCrop: (!opts.keepBackground || !!meshMaskName) && comp.autoCrop,
            paint, paintPrefix: paintGlb, ...(PAINT_TIERS[opts.paintQuality] || PAINT_TIERS.standard) });
        } else if (meshType === "moge") {
          const comp = await meshCompanions("moge");
          // Replicate the template's resize-if->2048 guard server-side.
          const d = imageDims(images[0]);
          const needsResize = !!(d && Math.max(d.width, d.height) > 2048);
          // MoGe reconstructs the whole SCENE by default — that is its job, so
          // subject-only is opt-in: a painted mask, or the ⚙ box for when the user
          // wants the automatic cut-out without painting anything.
          const hy = await meshCompanions("hunyuan3d");
          const subject = !!meshMaskName || !!opts.mogeSubjectOnly;
          // A whole-SCENE reconstruction is a window onto the place the camera saw,
          // with the camera at the origin — the same "stand here and look out" data
          // a panorama is, minus the ability to turn all the way round. A cut-out
          // SUBJECT is not: that is an object, and orbiting it is the right camera.
          meshViewKind = subject ? null : "forward";
          workflow = buildMoGeMesh({ modelName: comp.mogeModel, imageName,
            resolutionLevel: opts.mogeDetail !== undefined ? opts.mogeDetail : 9, needsResize,
            maskName: subject ? meshMaskName : null,
            bgRemoval: (subject && !meshMaskName) ? hy.birefnet : null,
            autoCrop: subject && hy.autoCrop,
            // The node's own ceiling is 170: a pinhole has no focal length at 180.
            fovX: Math.max(0, Math.min(170, opts.mogeFov || 0)) });
        } else if (meshType === "moge-pano") {
          const comp = await meshCompanions("moge");
          const d = imageDims(images[0]);
          const needsResize = !!(d && Math.max(d.width, d.height) > 2048);
          // The merge grid must not exceed the (possibly resized) input's long edge —
          // the node's own note is explicit about it, and overshooting only burns CPU
          // upsampling a solve that has no more information in it.
          // ⚙ "Sharpen the 360 view": a target long edge for the equirect, reached
          // through a 4× upscale model. Only offered where an upscaler exists.
          const refineTarget = comp.refiner ? Math.max(0, Math.min(8192, opts.panoRefine || 0)) : 0;
          const srcLong = d ? Math.max(d.width, d.height) : 1920;
          const longEdge = refineTarget
            ? refineTarget
            : (d ? Math.min(srcLong, needsResize ? 2048 : Infinity) : 1920);
          const mergeRes = Math.max(256, Math.min(opts.panoMerge || 1920, longEdge));
          // MoGe's grid is inputWidth/decimation, so refining without touching
          // decimation multiplies the TRIANGLES by the same factor as the pixels —
          // measured, 4096 wide took the mesh to 524k verts and the GLB to 34.9 MB.
          // Scale the stride with the enlargement to hold the vertex count flat
          // (1774→3584 needs 4→8); an explicit ⚙ value still wins.
          const autoDec = refineTarget
            ? Math.max(1, Math.min(8, Math.round(refineTarget * 4 / srcLong)))
            : 4;
          workflow = buildMoGePanorama({ modelName: comp.mogeModel, imageName,
            resolutionLevel: opts.mogeDetail !== undefined ? opts.mogeDetail : 9,
            splitRes: opts.panoSplit || 512, mergeRes, needsResize,
            decimation: opts.panoDecimation || autoDec,
            refineTarget, refineModel: comp.refiner || "",
            refineNeedsUpscale: srcLong < refineTarget });
        } else if (meshType === "triposplat") {
          const comp = await meshCompanions("triposplat");
          workflow = buildTripoSplat({ imageName, comp, seed,
            steps: opts.steps || 20, cfg: opts.cfg !== undefined ? opts.cfg : 3,
            sampler: opts.sampler || "dpmpp_2m", scheduler: opts.scheduler || "simple",
            numGaussians: opts.meshGaussians || 262144,
            meshDetail, maskName: meshMaskName });
        } else {
          sendJson(res, 400, { error: `3D chain "${meshType}" is not wired yet.` });
          return;
        }
      } else if (videoType) {
        // Video. WAN 5B ti2v + 14B i2v do image→video; WAN 14B t2v / Hunyuan are
        // text→video only. The dedicated WAN 2.2 14B i2v model needs a ref image.
        if (videoType === "wan" && /14b/i.test(model) && /i2v/i.test(model) && !isImg2Img) {
          sendJson(res, 400, { error: "This model is for image-to-video. Attach a reference image first, then use /imagine <description>." });
          return;
        }
        const comp = await videoCompanions(videoType, model, opts);
        if (comp.lora) ltxLoraUsed = { name: comp.lora, strength: comp.loraStrength };
        // "turbo" = this model's fast, distilled recipe is available. WAN 14B: both
        // LightX2V expert LoRAs installed → 4-step/cfg-1. LTX: the distilled LoRA +
        // spatial upscaler installed → the two-stage cascade preset (which sizes
        // differently, so the flag has to reach resolveVideoConfig).
        const turbo = !!(comp.loraHigh && comp.loraLow) || !!(comp.distillLora && comp.upscaler);
        // For i2v, match the output to the input's aspect ratio so the
        // conditioning frame isn't stretched (avoids ghosted/doubled edges).
        // A specified size sets the pixel BUDGET (kept at the input ratio);
        // "auto" keeps the input ratio at the model's own preset budget so video
        // stays within the model's practical resolution. resolveVideoConfig snaps
        // to the model's dimMult. t2v keeps the preset (no size unless --size).
        const vOpts = { ...opts };
        if (isImg2Img) {
          const dims = imageDims(images[0]);
          if (dims && dims.width && dims.height) {
            if (opts.width && opts.height) {
              const ts = editTargetSize(images, opts);
              if (ts) { vOpts.width = ts.width; vOpts.height = ts.height; }
            } else {
              vOpts.aspect = dims.width / dims.height;
            }
          }
        }
        const v = resolveVideoConfig(videoType, vOpts, model, turbo);
        videoDims = { width: v.width, height: v.height, fps: v.fps, length: v.length };
        // A WAN 14B t2v checkpoint can't consume a start image — ignore any attach.
        const wantImage = isImg2Img && !(videoType === "wan" && /14b/i.test(model) && /t2v/i.test(model));
        // Multi-image video. WAN 2.2 14B i2v + 2 imgs → first-last-frame (FLF2V).
        // LTX + 2+ imgs → arbitrary keyframes (each image pinned at an evenly-spaced
        // frame via LTXVAddGuide). Everything else uses only the first image.
        const isFLF = wantImage && videoType === "wan" && /14b/i.test(model) && /i2v/i.test(model) && images.length >= 2;
        // MSR reads its attachments as REFERENCES, not keyframes — so it must be
        // checked before the keyframe branch, which would otherwise claim the same
        // "ltx + 2 images" shape.
        const isMsr = model === LTX_MSR;
        const isLtxKeyframes = !isMsr && wantImage && videoType === "ltx" && images.length >= 2;
        const LTX_MAX_KEYFRAMES = 8;
        let imageName = null, endImageName = null, imageNames = null, backgroundName = null;
        if (isMsr) {
          // LiconMSR always needs a background still. With 2+ images the LAST one is
          // that background and the ones before it are the subjects; with a SINGLE
          // image it is BOTH the sole subject and the background (verified — the clip
          // keeps the person's identity and uses the photo's own setting as the
          // scene). So MSR never errors on image count here — wantImage already
          // guarantees at least one.
          const single = images.length === 1;
          const subjects = single ? images.slice(0, 1) : images.slice(0, Math.min(images.length - 1, LTX_MSR_MAX_SUBJECTS));
          imageNames = [];
          for (let i = 0; i < subjects.length; i++) imageNames.push(await uploadImage(subjects[i], controller.signal, `heykoko_msr${i}.png`));
          const bgSource = single ? images[0] : images[images.length - 1];
          backgroundName = await uploadImage(bgSource, controller.signal, "heykoko_msrbg.png");
          imagesUsed = single ? 1 : imageNames.length + 1;
        } else if (wantImage && isLtxKeyframes) {
          imageNames = [];
          // DISTINCT filenames — uploadImage's default name + overwrite would clobber.
          const kfs = images.slice(0, LTX_MAX_KEYFRAMES);
          for (let ki = 0; ki < kfs.length; ki++) imageNames.push(await uploadImage(kfs[ki], controller.signal, `heykoko_kf${ki}.png`));
          imagesUsed = imageNames.length;
        } else if (wantImage) {
          imageName = await uploadImage(images[0], controller.signal, "heykoko_start.png");
          imagesUsed = 1;
          if (isFLF) { endImageName = await uploadImage(images[1], controller.signal, "heykoko_end.png"); imagesUsed = 2; }
        }
        workflow = buildVideoWorkflow(videoType, { model, prompt, negative: negative_prompt || "", comp, imageName, endImageName, imageNames, backgroundName, seed, v, experts: expertPair });
      } else if (berniniImageTask) {
        // Bernini IMAGE side — the video graph at length 1, decoded to a still.
        //   i2i → the attached image rides source_video (edit this picture)
        //   r2i → the attached image(s) ride reference_images (compose a new one)
        //   t2i → nothing connected
        // Same companions and the same three sampling recipes as the video path.
        if (berniniImageTask !== "t2i" && !isImg2Img) {
          sendJson(res, 400, { error: "This Bernini image mode needs an attached image first, then use /imagine <instruction>." });
          return;
        }
        const comp = await berniniCompanions();
        // Output size: an explicit ⚙ --size wins; otherwise follow the FIRST attached
        // image's aspect so an edit comes back framed like its source (the template
        // resizes source_video to width×height and centre-crops, so a mismatched
        // aspect would crop the picture).
        let bw = snapDim(width, 16), bh = snapDim(height, 16);
        if (isImg2Img && !(opts.width && opts.height)) {
          const ts = editTargetSize(images, opts);
          if (ts) { bw = snapDim(ts.width, 16); bh = snapDim(ts.height, 16); }
        }
        let sourceImageName = null;
        const refImageNames = [];
        if (berniniImageTask === "i2i") {
          sourceImageName = await uploadImage(images[0], controller.signal, "heykoko_bimg.png");
          imagesUsed = 1;
        } else if (berniniImageTask === "r2i") {
          // Multi-subject compose: DISTINCT filenames (a shared name + overwrite would
          // collapse every reference to the last one). Prompt must name image0/image1…
          const refs = images.slice(0, BERNINI_MAX_REFS);
          for (let ri = 0; ri < refs.length; ri++) refImageNames.push(await uploadImage(refs[ri], controller.signal, `heykoko_bref${ri}.png`));
          imagesUsed = refImageNames.length;
        }
        workflow = buildBernini({
          model, prompt, negative: negative_prompt || "", comp,
          imageMode: true, imageTask: berniniImageTask, sourceImageName, refImageNames,
          width: bw, height: bh, length: 1, seed,
          turbo: !!comp.lora && !opts.berniniQuality,
          lightx2v: !!opts.berniniLightx2v && !!(comp.loraLxHigh && comp.loraLxLow),
          refMaxSize: opts.refMaxSize > 0 ? snapDim(Math.min(8192, Math.max(16, opts.refMaxSize)), 16) : 848,
          experts: expertPair,
        });
      } else if (editType) {
        // Instruction-edit. Checkpoint-based models (ip2p) bundle CLIP+VAE;
        // HiDream-E1 needs the 4 HiDream encoders; the rest (Kontext/Qwen) pick
        // their own companion files. HiDream-E1 is img2img-style (denoise ~0.85).
        let comp, editDenoise;
        if (editType === "hidream-e1") {
          comp = await hidreamCompanions();
          editDenoise = opts.denoise !== undefined ? opts.denoise : 0.85;
        } else if (editType === "omnigen") {
          comp = await editCompanions("omnigen");
          editDenoise = opts.denoise !== undefined ? opts.denoise : 0.8;
        } else {
          comp = editIsCheckpoint(editType) ? {} : await editCompanions(editType);
        }
        if ((editType === "qwen" || editType === "boogu-edit") && isMultiImage) {
          // Multi-reference compose: Qwen-Image-Edit-2509 Plus, or boogu's
          // TextEncodeBooguEdit autogrow (image_1..image_N). Cap at 3.
          const imageNames = [];
          // DISTINCT filenames — uploadImage's default name + overwrite would clobber,
          // collapsing all references to the last image (breaks multi-subject compose).
          const refs = images.slice(0, 3);
          for (let ri = 0; ri < refs.length; ri++) imageNames.push(await uploadImage(refs[ri], controller.signal, `heykoko_ref${ri}.png`));
          // Background-lock person-swap: a mask painted on the FIRST image (the
          // scene) keeps everything outside it pixel-identical to the source. Qwen
          // composes onto a FRESH latent, so pin its output to the scene's own
          // aspect (from the first image) — otherwise the default 1024² square
          // would distort the pasted-back background. boogu decodes at the scene's
          // native size already, so it needs no size hint.
          const maskName = hasMask ? await uploadImage(mask, controller.signal, "heykoko_mask.png") : null;
          // Qwen composes onto a FRESH EmptySD3 latent, which otherwise defaults to
          // a 1024² SQUARE — wrong for a person-swap (output must equal the scene)
          // and wrong for plain multi-subject compose too. Always pin its output to
          // the FIRST image's (the scene's) aspect ratio when no explicit size is
          // set. boogu decodes at the scene's native size already, so it's exempt.
          let qw = ew, qh = eh;
          if (editType === "qwen" && !(qw && qh)) {
            const ts = editTargetSize(images, opts);
            if (ts) { qw = snapDim(ts.width); qh = snapDim(ts.height); }
          }
          workflow = editType === "boogu-edit"
            ? buildBooguEdit({ model, prompt, negative: negative_prompt || "", imageNames, maskName, seed, cfg, comp })
            : buildQwenEditPlus({ model, prompt, imageNames, maskName, seed, cfg, comp, width: qw, height: qh });
        } else {
          const imageName = await uploadImage(images[0], controller.signal);
          // Masked instruction-edit (Kontext / Qwen): confine the edit to the
          // painted region. Other edit types ignore maskName (their builds don't
          // read it) — they fall back to whole-image editing.
          const maskName = hasMask ? await uploadImage(mask, controller.signal, "heykoko_mask.png") : null;
          workflow = buildEditWorkflow(editType, { model, prompt, negative: negative_prompt || "", imageName, maskName, seed, cfg, comp, denoise: editDenoise, width: ew, height: eh });
        }
      } else if (model === IMAGE_UPSCALE) {
        // Image HD / upscale: attached image → AI upscale model. No prompt needed; a
        // ⚙ --size sets an explicit target (kept at the source aspect, capped 4096),
        // otherwise the model's native output (usually 4×) is returned.
        if (!isImg2Img) { sendJson(res, 400, { error: "Image upscale needs an attached image first, then use /imagine (optionally add --size 1920x1080 to set the target size)." }); return; }
        const noImgUpscale = opts.upscaleModel === "off"; // ⚙ "upscale model" = Off → passthrough
        const imgWillResize = opts.width > 0 && opts.height > 0; // explicit --size
        const imgWillDenoise = upscaleDenoise > 0;
        // Off + no resize + no denoise → passthrough, nothing for ComfyUI to do. Tell the user.
        if (noImgUpscale && !imgWillResize && !imgWillDenoise) {
          sendJson(res, 200, { noop: true, message: "ℹ️ Nothing to do: ⚙ \"upscale model\" is set to \"Off\", so the image will not change and ComfyUI was not called this time.\n\n· To upscale: change ⚙ \"upscale model\" from \"Off\" back to \"Auto\" or a specific model (default output is 4×)" });
          return;
        }
        const imageName = await uploadImage(images[0], controller.signal);
        let outW = 0, outH = 0;
        if (opts.width && opts.height) {
          const ts = editTargetSize(images, opts, 4096);
          if (ts) { outW = snapDim(ts.width, 2); outH = snapDim(ts.height, 2); }
        }
        // With an explicit --size the ratio is known, so the smallest model that reaches
        // it wins; without one there is no target and the general ranking applies.
        const srcDims = imageDims(images[0]);
        const imgWantScale = (outW > 0 && srcDims && srcDims.width > 0) ? outW / srcDims.width : 0;
        const comp = noImgUpscale ? null : await upscaleCompanions(opts.upscaleModel, imgWantScale);
        const restoreModel = upscaleDenoise > 0 ? await restoreCompanion(opts.restoreModel) : null;
        workflow = buildImageUpscale({ imageName, upscaleModel: comp ? comp.model : null, outW, outH, denoise: upscaleDenoise, restoreModel });
        upscaleInfo = { model: comp ? comp.model : null, scale: comp ? comp.scale : null, denoise: upscaleDenoise, restoreModel };
        imagesUsed = 1;
      } else if (/hidream.?o1/i.test(model)) {
        // HiDream-O1 (pixel-space UiT): text→image, or reference editing when
        // image(s) are attached (1 = instruction edit, up to 10 = multi-reference).
        // Everything loads from the checkpoint — no companion files.
        let imageNames = null, ow = width, oh = height;
        if (isImg2Img) {
          imageNames = [];
          // Distinct filenames per reference — uploadImage's default name + overwrite
          // would clobber them down to the last image (breaks multi-reference).
          const refs = images.slice(0, 10);
          for (let ri = 0; ri < refs.length; ri++) imageNames.push(await uploadImage(refs[ri], controller.signal, `heykoko_o1ref${ri}.png`));
          // O1 reference editing ONLY converges at the model's trained resolution
          // (~4MP / 2048²) — verified live: at ≤1024 the edit returns NOISE, at 2048
          // it's clean. So size the canvas to a 4MP budget at the input's aspect
          // ratio (NOT the raw input size), unless the user set an explicit --size.
          if (opts.width && opts.height) { ow = opts.width; oh = opts.height; }
          else {
            let aspect = 1;
            const d = imageDims(images[0]);
            if (d && d.width && d.height) aspect = d.width / d.height;
            const area = 2048 * 2048;
            ow = Math.round(Math.sqrt(area * aspect));
            oh = Math.round(Math.sqrt(area / aspect));
          }
        }
        workflow = buildHiDreamO1({ model, prompt, negative: negative_prompt || "", imageNames, width: ow, height: oh, seed, cfg });
      } else if (/hidream.?i1/i.test(model)) {
        // HiDream-I1 txt2img (UNET + QuadrupleCLIPLoader); ignores any attached image.
        const comp = await hidreamCompanions();
        workflow = buildHiDreamImage({ model, prompt, negative: negative_prompt || "", width, height, seed, cfg, comp });
      } else if (/z.?image/i.test(model)) {
        // Z-Image-Turbo txt2img (UNET + CLIPLoader lumina2 + ae VAE).
        const comp = await zimageCompanions();
        workflow = buildZImage({ model, prompt, width, height, seed, cfg, comp });
      } else if (/qwen.?image/i.test(model)) {
        // Qwen-Image txt2img. Only the BASE model reaches here — editTypeOf routes
        // anything matching /qwen.*edit/ down the edit path long before this.
        const comp = await qwenImageCompanions();
        workflow = buildQwenImage({ model, prompt, negative: negative_prompt || "", width, height, seed, cfg, comp });
      } else if (/boogu/i.test(model)) {
        // boogu txt2img / img2img (UNET + CLIPLoader "boogu" + flux VAE).
        const comp = await boogiCompanions();
        const turbo = /turbo/i.test(model);
        const imageName = isImg2Img ? await uploadImage(images[0], controller.signal) : null;
        // A painted mask turns img2img into inpaint (repaint only the masked region).
        const maskName = hasMask ? await uploadImage(mask, controller.signal, "heykoko_mask.png") : null;
        workflow = buildBoogu({ model, prompt, negative: negative_prompt || "", width: ew || width, height: eh || height, seed, cfg, comp, turbo, imageName, maskName, denoise });
      } else if (hasMask) {
        // Inpaint with a plain checkpoint (SD / SDXL / Flux): repaint ONLY the
        // painted region from the prompt, preserving everything outside the mask.
        // denoise defaults to 1.0 (full repaint of the region) for inpaint.
        const imageName = await uploadImage(images[0], controller.signal);
        const maskName = await uploadImage(mask, controller.signal, "heykoko_mask.png");
        workflow = buildInpaint({
          model,
          prompt,
          negative: negative_prompt || "",
          imageName,
          maskName,
          seed,
          cfg,
          denoise: opts.denoise !== undefined ? opts.denoise : 1,
          width: ew,
          height: eh,
        });
      } else if (isImg2Img) {
        const imageName = await uploadImage(images[0], controller.signal);
        workflow = buildImg2Img({
          model,
          prompt,
          negative: negative_prompt || "",
          seed,
          denoise,
          imageName,
          cfg,
          width: ew,
          height: eh,
        });
      } else {
        workflow = buildTxt2Img({
          model,
          prompt,
          negative: negative_prompt || "",
          width,
          height,
          seed,
          cfg,
        });
      }

      // ⚙ "silent video": unhook the audio before the two rewrites below, since both
      // read CreateVideo's inputs — applyVideoCodec in particular copies the audio link
      // onto the VHS node, which would put the track straight back.
      if (opts.noAudio && workflow) applyMuteAudio(workflow);

      // Frame interpolation: resample the decoded frames up to a TARGET fps via
      // RIFE (default) or FILM VFI, keeping the same duration. Applies to every real
      // video model (not stills/images). ⚙ `targetFps` is the desired output fps; the
      // integer multiplier is derived from the model's own (or source) fps. If the base
      // fps already meets/exceeds the target, interpolation is skipped and the client is
      // told (interpWarning) so the user knows nothing was up-converted.
      const targetFps = Math.round(Number(opts.targetFps) || 0);
      if (videoType && videoType !== "enhance" && !stillMode && workflow && targetFps > 0) {
        // Base fps. Source-fps models (Bernini v2v/rv2v, Wan Animate) leave
        // videoDims.fps unset → fall back to the probed source fps, then 16.
        const baseFps = (videoDims && videoDims.fps) || Number(sourceVideoFps) || 16;
        if (baseFps >= targetFps) {
          interpWarning = { baseFps, targetFps }; // already at/above target → skipped
        } else {
          // CEIL so the interpolated fps is ≥ the target (RIFE/FILM only do integer
          // multiples); a post-pass then drops frames down to EXACTLY targetFps.
          const mult = Math.max(2, Math.ceil(targetFps / baseFps));
          const method = /film/i.test(opts.interpMethod || "") ? "film" : "rife";
          const newFps = applyVfi(workflow, mult, baseFps, method);
          if (videoDims) {
            if (videoDims.length) videoDims.length = (videoDims.length - 1) * mult + 1;
            videoDims.fps = newFps;
            videoDims.interpolated = mult;
            videoDims.interpMethod = method;
          }
          exactTargetFps = targetFps; // resample the output down to this exact fps
        }
      }

      // Video codec: route the tail through VHS_VideoCombine so BOTH h264 and h265 get
      // one CRF quality knob. Only for video workflows (they have a CreateVideo node);
      // requires VideoHelperSuite. After applyVfi so the tail it reads is interpolated.
      //   • VHS present → rewrite for the requested codec (default h264)
      //   • VHS absent  → leave native SaveVideo (h264); a h265 request degrades to
      //                   h264 and says so, rather than failing the whole render.
      // Mesh workflows are excluded even though TripoSplat's turntable tail has a
      // CreateVideo node — a 3-second orbit preview gains nothing from h265/CRF and
      // the ⚙ video codec setting shouldn't silently reshape a 3D result.
      // SCAIL-2's incremental save is excluded: applyVideoCodec assumes ONE CreateVideo +
      // ONE SaveVideo and collapses them into a single VHS node, which on an N-segment
      // graph would delete one pair, leave N−1 intact, and destroy the node-id → segment
      // mapping the merge depends on. Nothing is lost by skipping it — that graph's clips
      // are intermediates, and mergeScail2Segments re-encodes the joined result anyway, so
      // it is the one that honours ⚙ codec/CRF (and reports what it actually used).
      const isVideoTail = !meshType && Object.values(workflow).some((n) => n.class_type === "CreateVideo");
      if (isVideoTail && !segmentMerge) {
        const wantCodec = opts.videoCodec === "h265" ? "h265" : "h264";
        const crf = Number(opts.videoCrf) || 0;
        const vhsOk = await comfyHasNodes(["VHS_VideoCombine"]);
        if (vhsOk && applyVideoCodec(workflow, wantCodec, crf)) {
          videoCodecUsed = wantCodec;
        } else {
          videoCodecUsed = "h264"; // native SaveVideo path
          if (wantCodec === "h265") videoCodecNote = "vhs-missing"; // asked h265, VHS not installed
        }
      }

      // Give the result a home that says what it is and what made it. Deliberately
      // the last thing done to the graph — see stampOutputPrefix.
      stampOutputPrefix(workflow,
        meshType ? OUT_3D : panoDims ? OUT_PANO : isVideoTail ? OUT_VID : OUT_IMG,
        // The panorama recipe is a sentinel, not a checkpoint; name the file after
        // the checkpoint it actually generated with.
        panoDims ? (panoBase || model) : model);

      // Subscribe BEFORE queueing — a segment that finishes between the POST and the
      // subscription would otherwise never be recorded, and it is exactly the early
      // segments that survive an interrupted render.
      if (segmentMerge) {
        salvageCodec = opts.videoCodec === "h265" ? "h265" : "h264";
        salvageCrf = Number(opts.videoCrf) || 0;
        execWatcher = watchComfyExecuted(clientId, new Set(segmentMerge.saveNodeIds));
      }

      // Queue the prompt.
      const queueResp = await fetch(`${currentComfyUrl()}/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: workflow, client_id: clientId }),
        signal: controller.signal,
      });

      if (!queueResp.ok) {
        const text = await queueResp.text();
        sendJson(res, queueResp.status, { error: text || queueResp.statusText });
        return;
      }

      const queued = await queueResp.json();
      if (queued.node_errors && Object.keys(queued.node_errors).length) {
        sendJson(res, 400, { error: "ComfyUI workflow error", detail: queued.node_errors });
        return;
      }
      const promptId = queued.prompt_id;
      salvagePromptId = promptId;
      if (!promptId) {
        sendJson(res, 502, { error: "ComfyUI did not return a prompt_id" });
        return;
      }

      // Wait for completion, then collect outputs. Video files (.mp4/.webm)
      // come back in the same `images` array (with an `animated` flag) — split
      // them out so the client can render <video> vs <img>.
      const outputs = await waitForOutputs(promptId, controller.signal, deadline);
      const outImages = [];
      const outVideos = [];
      const outMeshes = [], meshMimes = [], meshNames = [];
      let videoMime = "video/mp4";
      let firstVideoBuf = null; // kept to ffprobe the real output frame count (animate chunking)
      // Incremental save (SCAIL-2 / Wan Animate): N silent clips → one video + source audio.
      // Done BEFORE the generic collector, which would otherwise hand the client the raw
      // segments as separate videos; their node ids are then skipped there.
      let skipNodes = null;
      if (segmentMerge) {
        const segBufs = [];
        const missing = [];
        for (const nodeId of segmentMerge.saveNodeIds) {
          const entry = outputs[nodeId] || {};
          const file = [...(entry.images || []), ...(entry.gifs || [])].find((f) => f.type !== "temp");
          if (!file) { missing.push(nodeId); continue; }
          const params = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder || "", type: file.type || "output" });
          const r = await fetch(`${currentComfyUrl()}/view?${params}`, { signal: controller.signal });
          if (!r.ok) { missing.push(nodeId); continue; }
          segBufs.push(Buffer.from(await r.arrayBuffer()));
        }
        // A hole in the middle would splice the clip together across a gap and put the
        // rest of it out of sync with the audio — refuse rather than ship that silently.
        if (missing.length || segBufs.length !== segmentMerge.saveNodeIds.length) {
          sendJson(res, 502, { error: `${segmentMerge.label} rendered ${segBufs.length} of ${segmentMerge.saveNodeIds.length} segments — nothing came back from save node(s) ${missing.join(", ") || "?"}. The finished segments are in ComfyUI's output folder (heykoko_vid/) and can be joined by hand; set ⚙ "Long-clip memory" to Off to go back to the single-file path.` });
          return;
        }
        const wantCodec = opts.videoCodec === "h265" ? "h265" : "h264";
        const srcBuf = await fetchComfyInputFile(segmentMerge.sourceName, controller.signal);
        const merged = await mergeScail2Segments(segBufs, srcBuf, wantCodec, Number(opts.videoCrf) || 0, controller.signal);
        if (!merged) {
          sendJson(res, 502, { error: `${segmentMerge.label} rendered all ${segBufs.length} segments but ffmpeg could not join them (is ffmpeg installed and on PATH?). The segments are in ComfyUI's output folder (heykoko_vid/) — nothing was lost. Set ⚙ "Long-clip memory" to Off to have ComfyUI write one file instead.` });
          return;
        }
        firstVideoBuf = merged.buf;
        outVideos.push(merged.buf.toString("base64"));
        videoCodecUsed = merged.codec;
        // Asked for H.265, got H.264 — same wording the VHS-absent path uses, since it is
        // the same outcome: the request degraded instead of failing the render.
        if (wantCodec === "h265" && merged.codec !== "h265") videoCodecNote = "vhs-missing";
        skipNodes = new Set(segmentMerge.saveNodeIds);
      }
      for (const nodeId of Object.keys(outputs)) {
        if (skipNodes && skipNodes.has(nodeId)) continue; // already merged above
        // SaveVideo/SaveImage report under `images`; VHS_VideoCombine (⚙ H.265) reports
        // the saved file under `gifs`; SaveGLB reports under `3d` (ui={"3d": results}) —
        // all the same {filename,subfolder,type} shape for /view.
        for (const img of [...(outputs[nodeId].images || []), ...(outputs[nodeId].gifs || []), ...(outputs[nodeId]["3d"] || [])]) {
          if (img.type === "temp") continue; // skip previews, keep final outputs
          const params = new URLSearchParams({
            filename: img.filename,
            subfolder: img.subfolder || "",
            type: img.type || "output",
          });
          const viewResp = await fetch(`${currentComfyUrl()}/view?${params}`, { signal: controller.signal });
          if (!viewResp.ok) continue;
          const buf = Buffer.from(await viewResp.arrayBuffer());
          // 3D files first: TripoSplat saves BOTH a turntable mp4 and a .spz in one
          // run, so the mesh test must not be an else-arm of the video test.
          if (/\.(glb|gltf|spz|ply|ksplat)$/i.test(img.filename)) {
            outMeshes.push(buf.toString("base64"));
            meshMimes.push(/\.glb$/i.test(img.filename) ? "model/gltf-binary" : "application/octet-stream");
            meshNames.push(img.filename);
          } else if (/\.(mp4|webm|mov)$/i.test(img.filename)) {
            videoMime = /\.webm$/i.test(img.filename) ? "video/webm" : "video/mp4";
            if (!firstVideoBuf) firstVideoBuf = buf;
            outVideos.push(buf.toString("base64"));
          } else {
            outImages.push(buf.toString("base64"));
          }
        }
      }

      // Hunyuan3D texturing: Hy3D21ExportMesh saves the textured GLB itself and returns
      // only a path STRING, so nothing about it reaches /history and the loop above
      // cannot see it. Fetch it by the name ComfyUI's save-path helper builds from our
      // prefix. The counter should always land on 1 (the prefix carries a per-run
      // token), but try a couple more in case the token ever repeats.
      if (paintGlb) {
        const slash = paintGlb.lastIndexOf("/");
        const subfolder = slash >= 0 ? paintGlb.slice(0, slash) : "";
        const stem = slash >= 0 ? paintGlb.slice(slash + 1) : paintGlb;
        for (let n = 1; n <= 3; n++) {
          const filename = `${stem}_${String(n).padStart(5, "0")}_.glb`;
          const params = new URLSearchParams({ filename, subfolder, type: "output" });
          const r = await fetch(`${currentComfyUrl()}/view?${params}`, { signal: controller.signal }).catch(() => null);
          if (!r || !r.ok) continue;
          const buf = Buffer.from(await r.arrayBuffer());
          if (!buf.length) continue;
          outMeshes.push(buf.toString("base64"));
          meshMimes.push("model/gltf-binary");
          meshNames.push(filename);
          break;
        }
      }

      // Interpolation exact-fps pass: RIFE/FILM only multiply by an integer, so the interpolated
      // fps (videoDims.fps) overshoots the user's target. ffmpeg-resample the output DOWN
      // to EXACTLY exactTargetFps (drops frames evenly, keeps duration + audio) — smoother
      // than no interpolation, but at the precise frame rate the user asked for.
      if (exactTargetFps > 0 && outVideos.length && videoDims && videoDims.fps > exactTargetFps) {
        let anyResampled = false;
        for (let vi = 0; vi < outVideos.length; vi++) {
          const rs = await resampleVideo(Buffer.from(outVideos[vi], "base64"), exactTargetFps, videoCodecUsed === "h265");
          if (rs) { outVideos[vi] = rs.toString("base64"); anyResampled = true; }
        }
        // Report the exact fps + matching frame count (duration unchanged) — but only if
        // ffmpeg actually ran; on failure keep the (overshot) interpolated video + its fps.
        if (anyResampled) {
          if (videoDims.length) videoDims.length = Math.max(1, Math.round((videoDims.length / videoDims.fps) * exactTargetFps));
          videoDims.fps = exactTargetFps;
        }
      }

      // Backfill the output size from the ACTUAL rendered video when a path couldn't resolve
      // it ahead of time (e.g. video-enhance/upscale, or an "auto"-sized model) — otherwise the
      // caption shows "?×?". width/height are resample-invariant, so probing firstVideoBuf is safe.
      if (firstVideoBuf && (!videoDims || !videoDims.width || !videoDims.height)) {
        const meta = await probeVideo(firstVideoBuf);
        if (meta.width && meta.height) {
          videoDims = videoDims || {};
          videoDims.width = videoDims.width || meta.width;
          videoDims.height = videoDims.height || meta.height;
        }
      }

      const now = new Date();
      const ts = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;
      // The hoisted snapshot plus what only the finished render knows. `model` can have
      // moved since the snapshot (a builder swapping in a companion file), so the id is
      // recomputed from it rather than left pointing at the pre-flight name.
      galleryMeta = { ...galleryMeta, model, modelId: galleryModelId(body.model, model), precisionUsed };
      if (stillMode) {
        // Single-frame Wan Animate → an IMAGE result (not a video).
        console.log(`${ts} [comfy-gen] model=${model}, mode=animate:still, ${videoDims ? videoDims.width + "x" + videoDims.height : "?"}, images=${outImages.length}`);
        if (!outImages.length) { sendJson(res, 502, { error: "ComfyUI finished but produced no image. Please retry." }); return; }
        const mediaIds = toGallery("image", outImages, null, { ...galleryMeta, width: videoDims?.width, height: videoDims?.height });
        sendJson(res, 200, { images: outImages, mediaIds, model, seed, precisionNote, precisionUsed, width: videoDims?.width, height: videoDims?.height, imagesUsed });
      } else if (meshType) {
        console.log(`${ts} [comfy-gen] model=${model}, mode=mesh:${meshType}, meshes=${outMeshes.length}, videos=${outVideos.length}`);
        if (!outMeshes.length) {
          const nodeIds = Object.keys(outputs || {}).join(", ") || "none";
          const why = paintGlb
            ? `the textured mesh "${paintGlb}_00001_.glb" was not in ComfyUI's output folder — untick "Texture the 3D model" in ⚙ to get the untextured mesh instead`
            : `output nodes: ${nodeIds}`;
          sendJson(res, 502, { error: `ComfyUI finished but produced no 3D file (${why}). Please retry.` });
          return;
        }
        // videos stays in the contract: no 3D chain emits one today (TripoSplat's
        // turntable was dropped), but the client already handles both together.
        const mediaIds = toGallery("mesh", outMeshes, meshMimes[0] || "model/gltf-binary", galleryMeta);
        sendJson(res, 200, { meshes: outMeshes, mediaIds, meshMimes, meshNames,
          // How the viewer should place its camera. A 360° mesh is a shell you stand
          // INSIDE; orbiting it from outside shows only the half facing you. The
          // client can't infer this from the geometry — a closed object encloses its
          // interior too — so the chain that made it has to say so.
          meshView: meshType === "moge-pano" ? "panorama" : (meshViewKind || undefined),
          videos: outVideos.length ? outVideos : undefined,
          videoMime: outVideos.length ? videoMime : undefined,
          model, seed, precisionNote, precisionUsed, imagesUsed });
      } else if (videoType) {
        console.log(`${ts} [comfy-gen] model=${model}, mode=video:${videoType}${isImg2Img ? "(i2v)" : "(t2v)"}, ${videoDims ? videoDims.width + "x" + videoDims.height : "?"}, videos=${outVideos.length}`);
        // Ran to completion but no video file came back — tell the client why rather
        // than a bare "no video" (usually SaveVideo missing or an output-collection miss).
        if (!outVideos.length) {
          const nodeIds = Object.keys(outputs || {}).join(", ") || "none";
          sendJson(res, 502, { error: `ComfyUI finished but produced no video file (output nodes: ${nodeIds}). Make sure the workflow includes a SaveVideo node, or retry.` });
          return;
        }
        const mediaIds = toGallery("video", outVideos, videoMime, { ...galleryMeta, width: videoDims?.width, height: videoDims?.height, fps: videoDims?.fps, length: videoDims?.length });
        sendJson(res, 200, { videos: outVideos, mediaIds, videoMime, model, seed, precisionNote, precisionUsed, width: videoDims?.width, height: videoDims?.height, fps: videoDims?.fps, length: videoDims?.length, segments: videoDims?.segments, truncatedFrom: videoDims?.truncatedFrom, truncatedNoChain: videoDims?.truncatedNoChain, interpolated: videoDims?.interpolated, interpMethod: videoDims?.interpMethod, interpWarning, upscaleModel: upscaleInfo?.model || undefined, upscaleScale: upscaleInfo?.scale || undefined, upscaleResizeOnly: upscaleInfo?.resizeOnly || undefined, upscaleDenoise: upscaleInfo?.denoise || undefined, restoreModel: upscaleInfo?.restoreModel || undefined, sharpen: upscaleInfo?.sharpen || undefined, ltxLora: ltxLoraUsed || undefined, phantomTurbo: phantomTurboUsed || undefined, videoCodec: videoCodecUsed || undefined, videoCodecNote: videoCodecNote || undefined, scailStreamNote: scailStreamNote || undefined, imagesUsed });
      } else {
        // The panorama recipe is neither txt2img nor the generic img2img: with a photo
        // it outpaints around it at its own denoise, and either way it forces its own
        // 2:1 canvas. Reporting the generic branch here named a denoise the chain
        // never used.
        const mode = panoDims
          ? `pano360:${panoOutpaintUsed ? `photo(denoise=${panoOutpaintUsed})` : "text"} ${panoDims.w}x${panoDims.h}${panoLoraUsed ? `, lora=${panoLoraUsed.name}@${panoLoraUsed.strength}` : ""}${panoLoraSkipped ? `, lora SKIPPED (${panoLoraSkipped.base} is not Flux)` : ""}`
          : editType ? `edit:${editType}${hasMask ? "+mask" : ""}` : hasMask ? `inpaint` : isImg2Img ? `img2img(denoise=${denoise})` : `txt2img ${width}x${height}`;
        const c = panoCfg || cfg;
        console.log(`${ts} [comfy-gen] model=${model}${panoCfg ? `(${panoBase})` : ""}, mode=${mode}, sampler=${c.sampler}/${c.scheduler}, cfg=${c.cfg}${c.guidance != null ? `, guidance=${c.guidance}` : ""}, steps=${c.steps}, images=${outImages.length}`);
        const mediaIds = toGallery("image", outImages, null, { ...galleryMeta, width: panoDims?.w || width, height: panoDims?.h || height });
        sendJson(res, 200, { images: outImages, mediaIds, model, seed, precisionNote, precisionUsed, upscaleModel: upscaleInfo?.model || undefined, upscaleScale: upscaleInfo?.scale || undefined, upscaleResizeOnly: upscaleInfo?.resizeOnly || undefined, upscaleDenoise: upscaleInfo?.denoise || undefined, restoreModel: upscaleInfo?.restoreModel || undefined, panoLora: panoLoraUsed || undefined, panoLoraSkipped: panoLoraSkipped || undefined });
      }
    } finally {
      clearTimeout(timeout);
      if (execWatcher) execWatcher.close();
    }
  } catch (error) {
    // SALVAGE. A chunked render writes each segment to disk as it finishes, so a failure
    // partway through — an OOM in a later segment, the ⚙ timeout, ComfyUI interrupted —
    // does not destroy what already rendered. Join the finished PREFIX and return that
    // instead of only an error message; an hour of GPU time is worth more than a clean
    // failure. Deliberately BEFORE the clientGone check: it costs nothing to attempt, and
    // the log line records what was salvaged even when the socket is gone.
    if (segmentMerge) {
      try {
        const partial = await mergeFinishedPrefix(execWatcher, segmentMerge, salvagePromptId, salvageCodec, salvageCrf, undefined);
        if (partial && !clientGone && !res.writableEnded) {
          const why = error.name === "AbortError" ? "was stopped or timed out" : "failed partway";
          // Salvaged pixels are the ones most worth keeping — file them like any other render.
          const salvageB64 = partial.buf.toString("base64");
          const mediaIds = toGallery("video", [salvageB64], "video/mp4", { ...(galleryMeta || {}), precisionUsed, partial: true });
          sendJson(res, 200, {
            videos: [salvageB64], mediaIds, videoMime: "video/mp4",
            model: undefined, videoCodec: partial.codec,
            // The client shows this as a warning next to the clip: the render is INCOMPLETE.
            partial: { done: partial.done, total: partial.total, reason: String(error.message || why).slice(0, 400) },
          });
          return;
        }
      } catch { /* salvage is best-effort — fall through to the real error */ }
      finally { if (execWatcher) execWatcher.close(); }
    }
    if (clientGone || res.writableEnded) return; // client already disconnected — nothing to send
    if (error.name === "AbortError") {
      sendJson(res, 504, { error: isVideoReq
        ? "ComfyUI video generation timed out (exceeded the ⚙ \"timeout\" minutes, default 4 hours). Increase ⚙ \"timeout\", or set it to 0 for no time limit (long videos keep running on the server until done); you can also lower the resolution (⚙ size) or reduce the frame count (⚙ Length)."
        : "ComfyUI image generation timed out. Please retry or reduce the step count." });
    } else if (error.isComfyError || (typeof error.message === "string" && error.message.startsWith("ComfyUI execution error"))) {
      // A real ComfyUI execution error (incl. CUDA OOM) — surface it verbatim, with
      // an actionable hint when we recognize an out-of-memory failure.
      let msg = error.message;
      if (/out of memory|CUDA error|alloc/i.test(msg)) {
        msg += "\n\nOut of VRAM: lower the ⚙ size (e.g. 720p→≤640), disable torch.compile, or reduce the frame count and retry.";
      }
      sendJson(res, 500, { error: msg });
    } else if (typeof error.message === "string" && (error.message.startsWith("Missing") || error.message.includes("not wired up yet"))) {
      // Missing companion files, or an unsupported model — surface the message.
      sendJson(res, 400, { error: error.message });
    } else {
      sendJson(res, 500, {
        error: "ComfyUI image generation failed. Make sure ComfyUI is running and the selected model is loaded.",
        detail: error.message,
      });
    }
  }
}

// POST /api/comfy-automask — one-click "point to segment" for the mask painter.
// The browser sends the source image (base64) + a normalized click point {x,y}
// SAM3.1 "multiplex" checkpoint — an all-in-one file (detector + tracker + text
// encoder), loaded via the stock CheckpointLoaderSimple (it yields both MODEL and
// the text-encoder CLIP). Lives in ComfyUI/models/checkpoints/. Text-prompt
// (open-vocabulary) segmentation runs through it.
const SAM3_CKPT = "sam3.1_multiplex_fp16.safetensors";

// (0–1); SAM2 segments the object under that point and we return the mask as a
// PNG data URL. The painter loads it into its canvas so the user can refine
// (brush/erase) before applying — it flows through the exact same mask pipeline
// as a hand-painted one. `grow` (px) dilates the mask a touch for softer blend
// edges. Self-contained SAM2 graph (no dependency on the edit workflow); the
// point format matches Wan Animate's animateSeedPoint (verified live).
async function comfyAutoMask(req, res) {
  // NOTE: do NOT abort on req "close" — Node fires it as soon as the request BODY
  // is fully read (well before the response), which would cancel the very first
  // uploadImage and return an empty 200. SAM2 is a short job already bounded by the
  // waitForOutputs deadline, so a client-disconnect abort isn't needed here.
  const controller = new AbortController();
  try {
    const body = await readBody(req);
    comfyCtx.enterWith({ comfyUrl: normComfyUrl(body.comfyUrl) || config.comfyUrl });
    const { image, point, box, text, threshold, grow } = body;
    if (!image || typeof image !== "string" || image.length < 100) {
      sendJson(res, 400, { error: "Missing image." });
      return;
    }
    const deadline = Date.now() + 120000; // SAM2/SAM3 are fast; 2 min is ample
    const imageName = await uploadImage(image, controller.signal, "heykoko_automask_src.png");
    const expand = Number.isFinite(grow) ? Math.max(0, Math.min(64, Math.round(grow))) : 6;
    // Three modes on ONE endpoint:
    //   • text (a phrase like "bird")   → SAM3.1 open-vocabulary text segmentation.
    //   • box  ({x1,y1,x2,y2} 0–1)      → SAM2 BOX-prompt (the object inside the box;
    //       HKBoxToBBox turns literal pixel coords into the BBOX link SAM2 requires).
    //   • otherwise (point 0–1)         → SAM2 click-point segmentation.
    // All grow the mask a touch then return a black/white PNG via MaskToImage.
    const wantText = typeof text === "string" && text.trim().length > 0;
    const wantBox = box && typeof box === "object" && ["x1", "y1", "x2", "y2"].every((k) => Number.isFinite(box[k]));
    const isSam2 = !wantText;
    let graph;
    if (wantText) {
      const t = text.trim().slice(0, 200);      // SAM3 truncates to ~32 tokens anyway
      const thr = Number.isFinite(threshold) ? Math.max(0.05, Math.min(0.95, threshold)) : 0.35;
      graph = {
        "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: SAM3_CKPT } },
        "2": { class_type: "CLIPTextEncode", inputs: { clip: ["1", 1], text: t } },
        "3": { class_type: "LoadImage", inputs: { image: imageName } },
        "4": { class_type: "SAM3_Detect", inputs: { model: ["1", 0], image: ["3", 0], conditioning: ["2", 0], threshold: thr, refine_iterations: 2, individual_masks: false } },
        "5": { class_type: "GrowMask", inputs: { mask: ["4", 0], expand, tapered_corners: true } },
        "6": { class_type: "MaskToImage", inputs: { mask: ["5", 0] } },
        "7": { class_type: "SaveImage", inputs: { images: ["6", 0], filename_prefix: `${OUT_TMP}/automask` } },
      };
    } else if (wantBox) {
      // Normalized box (0–1) → pixel XYXY in the LOADED image's space (SAM2's
      // single_image segmentor does NO resize, so LoadImage dims = imageDims).
      const dims = imageDims(image) || { width: 1024, height: 1024 };
      const x1 = Math.round(Math.min(box.x1, box.x2) * dims.width);
      const y1 = Math.round(Math.min(box.y1, box.y2) * dims.height);
      const x2 = Math.round(Math.max(box.x1, box.x2) * dims.width);
      const y2 = Math.round(Math.max(box.y1, box.y2) * dims.height);
      graph = {
        "1": { class_type: "DownloadAndLoadSAM2Model", inputs: { model: "sam2.1_hiera_base_plus.safetensors", segmentor: "single_image", device: "cuda", precision: "fp16" } },
        "2": { class_type: "LoadImage", inputs: { image: imageName } },
        "3": { class_type: "HKBoxToBBox", inputs: { x1, y1, x2, y2, boxes_json: "" } },
        "4": { class_type: "Sam2Segmentation", inputs: { sam2_model: ["1", 0], image: ["2", 0], keep_model_loaded: true, individual_objects: false, bboxes: ["3", 0] } },
        "5": { class_type: "GrowMask", inputs: { mask: ["4", 0], expand, tapered_corners: true } },
        "6": { class_type: "MaskToImage", inputs: { mask: ["5", 0] } },
        "7": { class_type: "SaveImage", inputs: { images: ["6", 0], filename_prefix: `${OUT_TMP}/automask` } },
      };
    } else {
      const dims = imageDims(image) || { width: 1024, height: 1024 };
      const coords = animateSeedPoint(point, dims.width, dims.height); // "[{x,y}]" pixel coords
      graph = {
        "1": { class_type: "DownloadAndLoadSAM2Model", inputs: { model: "sam2.1_hiera_base_plus.safetensors", segmentor: "single_image", device: "cuda", precision: "fp16" } },
        "2": { class_type: "LoadImage", inputs: { image: imageName } },
        "3": { class_type: "Sam2Segmentation", inputs: { sam2_model: ["1", 0], image: ["2", 0], keep_model_loaded: true, coordinates_positive: coords } },
        "4": { class_type: "GrowMask", inputs: { mask: ["3", 0], expand, tapered_corners: true } },
        "5": { class_type: "MaskToImage", inputs: { mask: ["4", 0] } },
        "6": { class_type: "SaveImage", inputs: { images: ["5", 0], filename_prefix: `${OUT_TMP}/automask` } },
      };
    }
    const clientId = crypto.randomUUID();
    const q = await fetch(`${currentComfyUrl()}/prompt`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: graph, client_id: clientId }), signal: controller.signal,
    });
    if (!q.ok) { sendJson(res, q.status, { error: (await q.text()) || q.statusText }); return; }
    const queued = await q.json();
    if (queued.node_errors && Object.keys(queued.node_errors).length) {
      sendJson(res, 400, { error: `${isSam2 ? "SAM2" : "SAM3"} workflow error`, detail: queued.node_errors });
      return;
    }
    if (!queued.prompt_id) { sendJson(res, 502, { error: "ComfyUI did not return a prompt_id" }); return; }
    const outputs = await waitForOutputs(queued.prompt_id, controller.signal, deadline);
    for (const nodeId of Object.keys(outputs)) {
      for (const img of (outputs[nodeId].images || [])) {
        if (img.type === "temp") continue;
        const params = new URLSearchParams({ filename: img.filename, subfolder: img.subfolder || "", type: img.type || "output" });
        const v = await fetch(`${currentComfyUrl()}/view?${params}`, { signal: controller.signal });
        if (!v.ok) continue;
        const buf = Buffer.from(await v.arrayBuffer());
        sendJson(res, 200, { mask: `data:image/png;base64,${buf.toString("base64")}` });
        return;
      }
    }
    sendJson(res, 500, { error: isSam2
      ? "SAM2 returned no mask (you may not have clicked on a segmentable object; try a different spot)."
      : `SAM3 could not find "${text.trim().slice(0, 40)}" (try a simpler English word, or lower the threshold and retry).` });
  } catch (e) {
    if (e && e.name === "AbortError") { try { res.end(); } catch { /* client gone */ } return; }
    sendJson(res, 500, { error: String((e && e.message) || e) });
  }
}

module.exports = { proxyComfyModels, generateComfyImage, uploadComfyVideo, uploadComfyAudio, comfyAutoMask,
  // ffmpeg/ffprobe helpers shared with server/video-edit.js — probing and codec
  // policy live here so the two modules cannot drift apart.
  hasLocalTool, videoParamsOf, videoSizeOf, videoCodecOf, audioCodecOf, probeVideo };