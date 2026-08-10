// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

// The simple video editor's engine: trim N gallery clips, concatenate them (optionally
// with a crossfade), control the soundtrack, and file the result back into the gallery.
//
// AI video generation is a gacha: many takes, each with only a usable stretch. This
// turns those stretches into one clip — locally, with ffmpeg, in seconds. No GPU, no
// ComfyUI round-trip, no upload.
//
// Two-stage pipeline, generalised from mergeScail2Segments (server/comfy.js):
//   1. NORMALIZE — each clip is trimmed (-ss/-t) and re-encoded to a common signature:
//      clip 0's pixel size (scale + pad, never distort), one fps, yuv420p, and — when
//      audio is kept — uniform AAC 48k stereo, silent-padded for clips with no track
//      (the concat/acrossfade steps hard-require every input to have audio).
//   2. SPLICE — the normalized intermediates agree by construction, so the concat
//      DEMUXER stream-copies them (one encode generation total). A crossfade swaps
//      this stage for an xfade/acrossfade filter chain (a second generation — the
//      price of the effect). An external audio track ("track") muxes a donor over the
//      silent picture, the same -map dance the SCAIL-2 merge uses.
//
// Trims are expressed in SECONDS and re-encode; no keyframe-exact copy trims — for
// stitching gacha clips, frame-exactness is not worth the complexity.
//
// The result is recorded with modelId "video-edit" and `params.edit` carrying the whole
// request, so an edit can later be reopened/reproduced. fps/length are ffprobed from
// the actual output — the gallery derives duration from the ledger, never the file.

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");
const gallery = require("./gallery");
const { hasLocalTool, videoParamsOf } = require("./comfy");
const { sendJson, readBody } = require("./utils");

const MAX_CLIPS = 20;
const CRF_DEFAULT = 18;   // stitching already-compressed clips: err on the high-quality side

function run(args, signal, tag) {
  return new Promise((resolve) => {
    const p = spawn("ffmpeg", ["-y", ...args], signal ? { signal } : undefined);
    let err = "";
    p.stderr.on("data", (d) => { err += d; });
    p.on("close", (code) => {
      if (code !== 0) console.log(`[video-edit] ${tag} failed: ${err.trim().split("\n").slice(-3).join(" | ")}`);
      resolve(code === 0);
    });
    p.on("error", () => resolve(false));
  });
}

// First audio stream's codec name of a FILE ("" when none) — the buffer-based twin
// lives in comfy.js; here the sources are already on disk.
function audioCodecOfFile(file) {
  return new Promise((resolve) => {
    let out = "";
    const p = spawn("ffprobe", ["-v", "error", "-select_streams", "a:0",
      "-show_entries", "stream=codec_name", "-of", "default=noprint_wrappers=1:nokey=1", file]);
    p.stdout.on("data", (d) => { out += d; });
    p.on("close", () => resolve(out.trim()));
    p.on("error", () => resolve(""));
  });
}

// Resolve and validate the request into concrete clips with absolute paths, real
// durations, and clamped trim points. Throws with a user-readable message.
async function resolveClips(clips) {
  if (!Array.isArray(clips) || !clips.length) throw new Error("no clips");
  if (clips.length > MAX_CLIPS) throw new Error(`too many clips (max ${MAX_CLIPS})`);
  const resolved = [];
  for (const c of clips) {
    const id = String((c && c.id) || "");
    const e = gallery.get(id);
    if (!e) throw new Error(`not in gallery: ${id}`);
    if (e.kind !== "video") throw new Error(`not a video: ${id}`);
    const abs = gallery.absPathOf(id);
    if (!abs || !fs.existsSync(abs)) throw new Error(`file missing: ${id}`);
    let { fps, length, width, height } = e;
    if (!(fps > 0) || !(length > 0) || !(width > 0) || !(height > 0)) {
      const s = await gallery.probeSpecs(abs);
      fps = fps > 0 ? fps : s.fps;
      length = length > 0 ? length : s.length;
      width = width > 0 ? width : s.width;
      height = height > 0 ? height : s.height;
    }
    if (!(fps > 0) || !(length > 0)) throw new Error(`cannot determine duration: ${id}`);
    const dur = length / fps;
    const inS = Number(c.inSec) || 0;
    const outS = c.outSec == null || c.outSec === "" ? dur : Number(c.outSec);
    if (inS < 0 || !(outS > inS) || inS >= dur) throw new Error(`bad trim on ${id}: ${inS}–${outS} (clip is ${dur.toFixed(2)}s)`);
    const out = Math.min(outS, dur);
    resolved.push({
      id, abs, fps, width, height, dur,
      in: inS, out, len: out - inS,
      // A whisker off either end is "not trimmed": ledger durations are derived and
      // a browser's duration can differ from ffprobe's by a frame.
      trimmed: inS > 0.001 || out < dur - 0.001,
    });
  }
  return resolved;
}

// The main event. `spec`:
//   { clips: [{id, inSec, outSec}], codec: "h264"|"h265", crf, audio: "keep"|"mute"|"track",
//     audioId, transition: {type: "none"|"crossfade", durSec}, fps, conversationId, msgId }
// `onProgress(stage, progress)` fires between ffmpeg runs. Returns { id, entry, codec }.
async function editVideo(spec, onProgress = () => {}, signal) {
  const clips = await resolveClips(spec.clips);
  const audioMode = ["keep", "mute", "track"].includes(spec.audio) ? spec.audio : "keep";
  const wantCodec = spec.codec === "h265" ? "h265" : "h264";
  const crfN = Number(spec.crf);
  const crf = Number.isFinite(crfN) && crfN > 0 ? Math.min(51, crfN) : CRF_DEFAULT;

  let fade = 0;
  if (spec.transition && spec.transition.type === "crossfade" && clips.length >= 2) {
    fade = Number(spec.transition.durSec) || 0.5;
    if (!(fade > 0)) fade = 0.5;
    fade = Math.min(fade, 2);
    const minLen = Math.min(...clips.map((c) => c.len));
    // xfade needs both neighbours to still exist while it blends; a fade longer than
    // half the shortest clip cannot.
    if (fade >= minLen / 2) throw new Error(`crossfade too long: ${fade}s needs every clip > ${(fade * 2).toFixed(1)}s`);
  }

  // External audio donor: a gallery audio entry, or any video whose soundtrack to lift.
  let donor = null;
  if (audioMode === "track") {
    const id = String(spec.audioId || "");
    const e = gallery.get(id);
    if (!e) throw new Error(`audio track not in gallery: ${id}`);
    const abs = gallery.absPathOf(id);
    if (!abs || !fs.existsSync(abs)) throw new Error(`audio track file missing: ${id}`);
    if (!(await audioCodecOfFile(abs))) throw new Error(`no audio stream in: ${id}`);
    donor = abs;
  }

  const uid = crypto.randomUUID();
  const tmp = (name) => path.join(os.tmpdir(), `hk_vedit_${uid}_${name}`);
  const segPaths = clips.map((_, i) => tmp(`${String(i).padStart(3, "0")}.mp4`));
  const listPath = tmp("list.txt");
  const mergedPath = tmp("merged.mp4");
  const outPath = tmp("out.mp4");
  const temps = [...segPaths, listPath, mergedPath, outPath];

  // Segments carry their own audio only in "keep"; "mute"/"track" build a silent
  // picture (the donor is muxed at the very end).
  const wantAudio = audioMode === "keep";

  try {
    onProgress("probe", 0.03);

    // h265 = Apple's hardware HEVC, same policy as mergeScail2Segments: hvc1-tagged so
    // it plays in Safari, no CRF knob, and on a non-mac host it simply fails — probed
    // once on the first clip, then the whole run falls back to libx264 and reports it.
    let vcodec = ["-c:v", "libx264", "-crf", String(crf)];
    let actualCodec = "h264";
    if (wantCodec === "h265") { vcodec = ["-c:v", "hevc_videotoolbox", "-tag:v", "hvc1"]; actualCodec = "h265"; }

    // ---- Fast path: nothing trimmed, no fade, and the originals genuinely agree →
    // pure demuxer stream-copy, zero re-encode (the SCAIL-2 lesson: the demuxer must
    // be gated on a real parameter check, it will not refuse a mismatch itself).
    let copied = false;
    if (!fade && wantCodec !== "h265" && clips.every((c) => !c.trimmed)) {
      const sigs = await Promise.all(clips.map((c) => videoParamsOf(c.abs)));
      const agree = sigs[0] && sigs.every((s) => s === sigs[0]);
      let audioAgree = true;
      if (agree && wantAudio) {
        const acs = await Promise.all(clips.map((c) => audioCodecOfFile(c.abs)));
        audioAgree = acs.every((a) => a === acs[0]);   // all "" (silent) also agrees
      }
      if (agree && audioAgree) {
        onProgress("concat", 0.5);
        await fsp.writeFile(listPath, clips.map((c) => `file '${c.abs}'`).join("\n") + "\n");
        const args = ["-f", "concat", "-safe", "0", "-i", listPath,
                      ...(wantAudio ? ["-c", "copy"] : ["-c:v", "copy", "-an"])];
        copied = await run([...args, mergedPath], signal, "stream-copy");
        if (copied) actualCodec = /hevc|h265/i.test(sigs[0]) ? "h265" : "h264";
      }
    }

    // ---- Stage 1: normalize each clip to a common signature.
    const W = clips[0].width, H = clips[0].height;
    const fpsN = Number(spec.fps);
    const F = fpsN > 0 ? fpsN : clips[0].fps;
    if (!copied) {
      if (!(W > 0) || !(H > 0)) throw new Error(`cannot determine pixel size: ${clips[0].id}`);
      // Reads `vcodec` at call time, so the h265→h264 fallback below can re-run it.
      const normalizeOne = async (i, tag) => {
        const c = clips[i];
        const hasAud = wantAudio ? !!(await audioCodecOfFile(c.abs)) : false;
        const args = [];
        if (c.in > 0) args.push("-ss", c.in.toFixed(3));
        args.push("-t", c.len.toFixed(3), "-i", c.abs);
        if (wantAudio && !hasAud) args.push("-f", "lavfi", "-t", c.len.toFixed(3),
                                            "-i", "anullsrc=channel_layout=stereo:sample_rate=48000");
        // scale-to-fit + pad: a differently-shaped clip gets bars, never a stretch.
        args.push("-vf", `scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
                         `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${F}`);
        args.push("-map", "0:v:0");
        if (wantAudio) args.push("-map", hasAud ? "0:a:0" : "1:a:0", "-c:a", "aac", "-ar", "48000", "-ac", "2");
        else args.push("-an");
        args.push(...vcodec, "-pix_fmt", "yuv420p", "-shortest");
        return run([...args, segPaths[i]], signal, tag);
      };
      for (let i = 0; i < clips.length; i++) {
        if (signal?.aborted) throw new Error("cancelled");
        onProgress(`clip ${i + 1}/${clips.length}`, 0.05 + 0.6 * (i / clips.length));
        let ok = await normalizeOne(i, `normalize ${i}`);
        if (!ok && actualCodec === "h265") {
          // No hardware HEVC here (or it refused this size) — drop to H.264 for the
          // whole run and redo any segments already written.
          vcodec = ["-c:v", "libx264", "-crf", String(crf)];
          actualCodec = "h264";
          for (let j = 0; j <= i; j++) {
            ok = await normalizeOne(j, `normalize ${j} (h264 fallback)`);
            if (!ok) throw new Error(`ffmpeg failed normalizing clip ${j + 1}`);
          }
        } else if (!ok) {
          throw new Error(`ffmpeg failed normalizing clip ${i + 1}`);
        }
      }

      // ---- Stage 2: splice.
      onProgress("concat", 0.7);
      if (clips.length === 1) {
        await fsp.rename(segPaths[0], mergedPath);
      } else if (!fade) {
        await fsp.writeFile(listPath, segPaths.map((p) => `file '${p}'`).join("\n") + "\n");
        if (!(await run(["-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", mergedPath],
                        signal, "concat"))) throw new Error("ffmpeg failed concatenating");
      } else {
        // Crossfade chain over the (uniform) intermediates. Offsets accumulate the
        // trimmed lengths minus one fade per joint; expected output = ΣL − (N−1)·fade.
        const inputs = [];
        for (const p of segPaths) inputs.push("-i", p);
        const vParts = [], aParts = [];
        let prevV = "[0:v]", prevA = "[0:a]", offset = 0;
        for (let i = 1; i < clips.length; i++) {
          offset += clips[i - 1].len - fade;
          const vOut = i === clips.length - 1 ? "[v]" : `[vx${i}]`;
          vParts.push(`${prevV}[${i}:v]xfade=transition=fade:duration=${fade}:offset=${offset.toFixed(3)}${vOut}`);
          prevV = vOut;
          if (wantAudio) {
            const aOut = i === clips.length - 1 ? "[a]" : `[ax${i}]`;
            aParts.push(`${prevA}[${i}:a]acrossfade=d=${fade}${aOut}`);
            prevA = aOut;
          }
        }
        const filter = [...vParts, ...aParts].join(";");
        const args = [...inputs, "-filter_complex", filter, "-map", "[v]"];
        if (wantAudio) args.push("-map", "[a]", "-c:a", "aac");
        args.push(...vcodec, "-pix_fmt", "yuv420p");
        if (!(await run([...args, mergedPath], signal, "xfade"))) throw new Error("ffmpeg failed crossfading");
      }
    }

    // ---- External audio track, muxed over the finished picture.
    let finalPath = mergedPath;
    if (donor) {
      onProgress("audio", 0.88);
      if (!(await run(["-i", mergedPath, "-i", donor, "-map", "0:v:0", "-map", "1:a:0",
                       "-c:v", "copy", "-c:a", "aac", "-shortest", outPath], signal, "mux audio")))
        throw new Error("ffmpeg failed muxing the audio track");
      finalPath = outPath;
    }

    // ---- File it. fps/length from the ACTUAL output — the gallery badge reads the
    // ledger, and a wrong length would lie about the duration forever.
    onProgress("filing", 0.95);
    const buf = await fsp.readFile(finalPath);
    const specs = await gallery.probeSpecs(finalPath);
    const entry = gallery.record({
      kind: "video", mime: "video/mp4", buffer: buf,
      meta: {
        model: "video-edit", modelId: "video-edit",
        fps: specs.fps, length: specs.length, width: specs.width, height: specs.height,
        conversationId: spec.conversationId, msgId: spec.msgId,
        dedup: false,
        params: { edit: {
          clips: clips.map((c) => ({ id: c.id, inSec: c.in, outSec: c.out })),
          codec: actualCodec, crf, audio: audioMode,
          audioId: audioMode === "track" ? spec.audioId : undefined,
          transition: fade ? { type: "crossfade", durSec: fade } : { type: "none" },
          fps: F,
        } },
      },
    });
    gallery.makeThumb(entry.path).catch(() => {});   // best-effort; the browser can too
    console.log(`[video-edit] ${clips.length} clip(s) → ${(buf.length / 1048576).toFixed(1)} MB ${actualCodec}` +
                `${fade ? ` (crossfade ${fade}s)` : ""} → ${entry.path}`);
    return { id: entry.path, entry, codec: actualCodec };
  } finally {
    for (const f of temps) fsp.unlink(f).catch(() => {});
  }
}

// POST /api/video-edit — NDJSON stream: {type:"progress",stage,progress}… then
// {type:"done",result} | {type:"error",error}. The exact shape jobs.js's youtube
// branch already consumes, so the bg-queue integration is a clone of that branch.
async function handleVideoEdit(req, res) {
  let body;
  try { body = await readBody(req); } catch { sendJson(res, 400, { error: "invalid body" }); return; }

  // Fail fast, BEFORE any work: no ffmpeg → an actionable 400, not a mid-stream error.
  const missing = [];
  for (const tool of ["ffmpeg", "ffprobe"]) if (!(await hasLocalTool(tool))) missing.push(tool);
  if (missing.length) {
    sendJson(res, 400, { error: `Video editing needs ${missing.join(" + ")} on the server. Install with \`brew install ffmpeg\`.` });
    return;
  }

  res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" });
  const ctrl = new AbortController();
  req.on("close", () => ctrl.abort());
  const send = (obj) => { try { res.write(JSON.stringify(obj) + "\n"); } catch { /* client gone */ } };
  try {
    const result = await editVideo(body, (stage, progress) => send({ type: "progress", stage, progress }), ctrl.signal);
    send({ type: "done", result });
  } catch (e) {
    if (!ctrl.signal.aborted) send({ type: "error", error: (e && e.message) || "video edit failed" });
  } finally {
    try { res.end(); } catch { /* already closed */ }
  }
}

module.exports = { editVideo, handleVideoEdit };
