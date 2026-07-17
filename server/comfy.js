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
async function resampleVideo(buf, targetFps) {
  let inP, outP;
  try {
    const id = crypto.randomUUID();
    inP = path.join(os.tmpdir(), `hk_rs_in_${id}.mp4`);
    outP = path.join(os.tmpdir(), `hk_rs_out_${id}.mp4`);
    await fsp.writeFile(inP, buf);
    const ok = await new Promise((resolve) => {
      // Keep the audio (-c:a aac) — the merge step re-muxes the source soundtrack
      // onto the chunked output, so a resampled source must still carry its audio.
      const p = spawn("ffmpeg", ["-y", "-i", inP, "-r", String(targetFps), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", outP]);
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

// Frames Wan Animate can generate in one pass, by OUTPUT pixel budget (width×height).
// 3D-attention VRAM/compute grows with (spatial tokens × frames), so higher
// resolution needs a shorter segment to stay within a 32GB budget. Mirrors
// animateSegmentCap in public/js/image-gen.js (the client drives the chunk loop;
// this is the fallback / single-pass default).
function animateSegmentCap(pixelBudget, torchCompile = false) {
  // torch.compile adds VRAM overhead → use one tier shorter segments when it's on
  // (mirrors public/js/image-gen.js).
  const tiers = torchCompile
    ? [[520000, 121], [1000000, 65], [2100000, 33]]
    : [[520000, 241], [1000000, 161], [2100000, 81]]; // 720p 161f (well-tested); 1080p 81f ≈ half of 720p's cap (1080p has ~2.25× the pixels) — conservative vs the 65f→22.9GB measurement
  for (const [lim, cap] of tiers) if (pixelBudget <= lim) return cap;
  return torchCompile ? 17 : 33;
}

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
function videoTypeOf(model) {
  if (!model) return null;
  // Video enhance (interpolate + upscale): a model-free post-process (frame interpolation +
  // AI upscale) on a source video. A fixed sentinel, not a checkpoint filename.
  if (/^video-enhance$/i.test(model)) return "enhance";
  // Bernini (video-edit), Animate (pose-transfer) and SCAIL-2 (character animation)
  // are all WAN variants whose filenames contain "wan" — check them BEFORE the
  // generic /wan/ branch.
  // scail BEFORE animate: the "scail-2 (animate)" sentinel contains BOTH words, and
  // no real filename contains the other's keyword — so this order is unambiguous.
  if (/bernini/i.test(model)) return "bernini";
  if (/scail/i.test(model)) return "scail2";
  if (/animate/i.test(model)) return "animate";
  if (/wan/i.test(model)) return "wan";
  if (/ltx/i.test(model)) return "ltx";
  if (/hunyuan.?video/i.test(model)) return "hunyuan";
  return null;
}

// ── Quantisation variants ────────────────────────────────────────────────────
// The same weights ship as sibling files differing ONLY by a quantisation token
// (wan2.2_bernini_r_high_noise_{fp8_scaled,mxfp8}.safetensors). Strip the token and
// two files that are the same model collapse to one "base"; the ⚙ precision
// preference then picks which sibling to actually load.
//
// Tokens are matched longest-first so fp8_e4m3fn_scaled doesn't degrade to "fp8"
// and leave "_e4m3fn_scaled" glued to the base. NOTE the HF filename
// wan2.1_14B_SCAIL_2_nvfp4_mxpf8_mix has "mxPF8" — a typo upstream, not mxfp8; it's
// an nvfp4 file and must not be matched by the mxfp8 rule.
//
// This list is RECOGNITION, not the ⚙ menu (which is the <option> set in index.html).
// int8 stays here despite not being offerable: an installed int8 build must still be
// recognised as a variant so it collapses into its model's single dropdown entry
// instead of showing up as a separate model.
const PRECISION_TOKENS = "fp8_e4m3fn_scaled|fp8_e4m3fn_fast|fp8_e4m3fn|fp8_e5m2|fp8_scaled|fp8|mxfp8|nvfp4_mxpf8_mix|nvfp4|int8_convrot|int8|fp16|bf16";
const PRECISION_RE = new RegExp(`(?:^|[_-])(${PRECISION_TOKENS})(?=[_.-]|$)`, "i");
const PRECISION_RE_G = new RegExp(`(?:^|[_-])(?:${PRECISION_TOKENS})(?=[_.-]|$)`, "ig");
function precisionOf(name) {
  const m = PRECISION_RE.exec(name || "");
  if (!m) return null;
  const tok = m[1].toLowerCase();
  if (tok.startsWith("nvfp4")) return "nvfp4";
  if (tok === "mxfp8") return "mxfp8";
  if (tok.startsWith("fp8")) return "fp8";
  if (tok.startsWith("int8")) return "int8";
  return "fp16"; // fp16 / bf16 — the unquantised tier
}

// Filename minus its quantisation token + extension — the identity a set of
// precision variants share.
function precisionBase(name) {
  return String(name || "")
    .replace(/\.(safetensors|ckpt|gguf|pth|sft|bin)$/i, "")
    .replace(PRECISION_RE_G, "")
    .replace(/[_-]{2,}/g, "_")
    .replace(/^[_-]+|[_-]+$/g, "")
    .toLowerCase();
}

// Swap `name` for its sibling at the preferred precision. PER-FILE best effort: a
// tier the sibling doesn't ship in keeps the name unchanged rather than failing —
// which is what lets a half-quantised MoE pair (mxfp8 high + fp8 low) load instead
// of 404 while only one twin has been re-quantised.
function pickPrecision(all, name, pref) {
  if (!name || !pref || pref === "auto") return name;
  if (precisionOf(name) === pref) return name;
  const base = precisionBase(name);
  return (all || []).find((n) => precisionBase(n) === base && precisionOf(n) === pref) || name;
}

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
// Best file for one expert: the asked-for tier, else fp8 (what the app loaded before
// the ⚙ preference existed), else whatever that model ships. null = no such model.
function pickByBase(all, base, pref) {
  const group = (all || []).filter((n) => precisionBase(n) === base);
  if (!group.length) return null;
  return group.find((n) => precisionOf(n) === pref)
      || group.find((n) => precisionOf(n) === "fp8")
      || group[0];
}

async function resolvePrecision(model, pref) {
  // `used` names the tier actually loaded and is always filled in, including under
  // "auto" — the done-line states it every time, so it cannot depend on a preference
  // having been expressed. `note` is the narrower "you did not get what you asked
  // for" signal and stays null when the request was honoured.
  const out = { model, experts: null, note: null, used: precisionOf(model) };
  if (!model || !pref || pref === "auto") return out;
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

async function resolveBerniniAuto() {
  const unets = await comfyEnum("UNETLoader", "unet_name");
  return unets.find((n) => /bernini/i.test(n) && /high_noise/i.test(n)) || null;
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

// Sentinel for the "video enhance" (interpolate + upscale) dropdown entry — a source video is
// AI-upscaled and frame-interpolated to a target fps. Has no diffusion model, so it
// resolves to nothing on disk; the pipeline is built directly at generation time.
const VIDEO_ENHANCE = "video-enhance";

// Sentinel for the "image upscale" (image HD / upscale) dropdown entry — an attached
// image is run through the AI upscale model. Lives in the image `models` list; the
// dispatch matches it by exact name (no diffusion model, no companion files).
const IMAGE_UPSCALE = "image-upscale";

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
    const [ckpts, unets, upscaleModels, hostname] = await Promise.all([
      comfyEnum("CheckpointLoaderSimple", "ckpt_name"),
      comfyEnum("UNETLoader", "unet_name"),
      comfyEnum("UpscaleModelLoader", "model_name").catch(() => []),
      hostnameFor(scanUrl).catch(() => ""),
    ]);
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
          videoModels.push({ name: BERNINI_AUTO, type: "bernini", label: "bernini (i2v / video edit)", needsVideo: true, videoOptional: true });
          // ads2v — needs BOTH a source clip and an image, so no videoOptional here.
          videoModels.push({ name: BERNINI_INSERT, type: "bernini", label: "bernini (insert image into video)", needsVideo: true });
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
        videoModels.push({ name: ANIMATE_REPLACE, type: "animate", label: "wan animate (replace)", needsVideo: true });
        continue;
      }
      // SCAIL-2 (character animation) — one UNET, two modes, same split as Animate:
      //  • replace → character REPLACES the tracked person in the source video
      //  • animate → character performs the source video's motion
      // Unlike Animate it feeds the driving video to the model DIRECTLY (no DWPose
      // stick-figure step), and it tracks the subject with SAM3 instead of SAM2.
      if (vt === "scail2") {
        videoModels.push({ name: SCAIL2_ANIMATE, type: "scail2", label: "scail-2 (animate)", needsVideo: true });
        videoModels.push({ name: n, type: "scail2", label: "scail-2 (replace)", needsVideo: true });
        continue;
      }
      const is14b = /14b/i.test(n);
      if (is14b && /low_noise/i.test(n)) continue; // hidden — derived from the high twin
      if (merge14b && is14b && (/t2v/i.test(n) || /i2v/i.test(n))) {
        if (!added14bAuto) { videoModels.push({ name: WAN14B_AUTO, type: "wan", label: "wan2.2_14B" }); added14bAuto = true; }
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
    // Whether the ⚙ sampler / scheduler / steps / cfg fields do anything for this model.
    // Only the preset-driven builders read them (resolveVideoConfig merges the ⚙ values
    // over the preset); scail2 / animate / bernini hardcode a schedule their distill LoRA
    // is bound to, and silently ignore the fields. Decided HERE rather than by a type list
    // on the frontend so adding a model can't leave the two out of step.
    for (const m of videoModels) m.samplerTunable = !!videoPreset(m.type, m.name, true);
    // Checkpoints that are COMPANIONS to another model rather than something to
    // generate with. SAM3 is a segmentation model SCAIL-2 loads for subject tracking —
    // it sits in checkpoints/ and matches none of the edit/video tests, so it would
    // otherwise fall through into txt2img as a pickable (and instantly broken) option.
    const isCompanionModel = (n) => /sam[-_]?[23]|segment.?anything/i.test(n);
    // txt2img list: plain checkpoints (excluding edit/video/HiDream/companions) +
    // HiDream-I1 (a diffusion model loaded specially with QuadrupleCLIPLoader).
    const plainCkpts = ckpts.filter((n) => !editTypeOf(n) && !videoTypeOf(n) && !/hidream/i.test(n) && !isCompanionModel(n));
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
        // Representative = the fp8 build when present (what the app loaded before this
        // existed), else whatever came first — a stable, precision-independent choice.
        const rep = group.find((x) => precisionOf(nameOf(x)) === "fp8") || group[0];
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
    sendJson(res, 200, { models: [...imageOut, IMAGE_UPSCALE], imageCollapsed, editModels: editOut, videoModels: videoOut, upscaleModels, hostname });
  } catch {
    sendJson(res, 200, { models: [], editModels: [], videoModels: [], upscaleModels: [] });
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
// COMFY_AUTOGROW_V3 named `images` that takes a LIST of image links
// (`[[id,0],[id,0],…]`) — VERIFIED on the live node: the indexed `image_1` keys
// and the hand-export's singular `image` both fail at execute(); a single link
// errors "Boolean value of Tensor ambiguous"; only the list form runs. Same
// AuraFlow shift-3 + flux-VAE stack.
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
  const imageLinks = refs.map((name, i) => {
    const id = String(30 + i);
    wf[id] = { class_type: "LoadImage", inputs: { image: name } };
    return [id, 0];
  });
  wf["4"] = { class_type: "TextEncodeBooguEdit", inputs: { prompt, negative_prompt: negative || "", clip: ["2", 0], vae: ["3", 0], images: imageLinks } };
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

async function videoCompanions(videoType, model) {
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
  if (videoType === "ltx") {
    // LTX-2 uses a Gemma text encoder (loaded via LTXAVTextEncoderLoader with the
    // model's own ckpt); VAE comes from the checkpoint, so no separate VAE needed.
    // Must be the 12B Gemma-3 — the smaller gemma4_e4b (Gemma 3n) is a different
    // model and produces broken output, and it sorts first so a bare /gemma/ grabs
    // the wrong one.
    const encoder = find(clips, /gemma.*12b/i) || find(clips, /gemma_?3/i) || find(clips, /gemma/i) || find(clips, /t5xxl/i);
    if (!encoder) throw new Error("Missing LTX-2 text encoder:\n- gemma_3_12B_it…safetensors (or t5xxl) → text_encoders/");
    return { encoder };
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
  if (videoType === "hunyuan") {
    return { sampler: "euler", scheduler: "simple", cfg: 6, steps: 20, shift: 7.0, width: 720, height: 480, length: 49, fps: 24, dimMult: 16, lenMult: 4 };
  }
  if (videoType === "ltx") {
    // LTX uses its own LTXVScheduler (scheduler/shift here are unused); dims must
    // be /32, frames 8n+1. cfg is low (~3). The 22b model is undersampled at 20
    // steps (motion ghosting / trailing edges) — 30 is the quality sweet spot.
    return { sampler: "euler", scheduler: "simple", cfg: 3, steps: 30, shift: 0, width: 768, height: 512, length: 97, fps: 24, dimMult: 32, lenMult: 8 };
  }
  return null;
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
    // Frame count must be lenMult·n + 1 — snap to the nearest valid value.
    length: Math.max(p.lenMult + 1, Math.round((L - 1) / p.lenMult) * p.lenMult + 1),
    fps: opts.fps || p.fps,
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
function applyVfi(wf, mult, baseFps, method) {
  const m = Math.round(Number(mult) || 0);
  if (!wf || m < 2) return baseFps;
  let cvId = null;
  for (const id in wf) if (wf[id].class_type === "CreateVideo") { cvId = id; break; }
  if (!cvId) return baseFps;
  const cv = wf[cvId];
  // clear_cache_after_n_frames keeps VRAM bounded on long clips; multiplier inserts
  // (m−1) interpolated frames between each pair → (N−1)·m + 1 frames out.
  wf["vfi"] = /film/i.test(method || "")
    ? { class_type: "FILM VFI", inputs: { ckpt_name: "film_net_fp32.pt", frames: cv.inputs.images, clear_cache_after_n_frames: 10, multiplier: m } }
    : { class_type: "RIFE VFI", inputs: { ckpt_name: "rife47.pth", frames: cv.inputs.images, clear_cache_after_n_frames: 10, multiplier: m, fast_mode: true, ensemble: true, scale_factor: 1, dtype: "float32", torch_compile: false, batch_size: 1 } };
  cv.inputs.images = ["vfi", 0];
  const newFps = Math.round((Number(baseFps) || 0) * m);
  if (newFps > 0) cv.inputs.fps = newFps;
  return newFps > 0 ? newFps : baseFps;
}

// AI upscale model for the video-enhance (HD) pipeline. Auto-picks a sensible
// default from models/upscale_models/ (prefer a 4× general model), erroring with a
// download hint if the folder is empty.
async function upscaleCompanions(preferred) {
  const models = await comfyEnum("UpscaleModelLoader", "model_name");
  // A user-picked model (⚙ "upscale model") wins when it's actually installed; otherwise
  // fall through to the auto-pick. Match exact name first, then case-insensitively.
  if (preferred) {
    const exact = models.find((x) => x === preferred) || models.find((x) => x.toLowerCase() === String(preferred).toLowerCase());
    if (exact) return { model: exact };
  }
  const find = (re) => models.find((x) => re.test(x));
  // RealESRGAN first — it cleans compression artifacts and is temporally steadier on
  // video; UltraSharp (sharper but amplifies noise frame-to-frame) is the next choice.
  const model =
    find(/realesrgan.*x4plus(?!.*anime)/i) ||
    find(/realesrgan(?!.*anime)/i) ||
    find(/4x.?ultrasharp/i) ||
    find(/4x.?foolhardy|remacri|nmkd/i) ||
    find(/realesrgan/i) ||
    find(/(^|[^0-9])4x/i) ||
    find(/x4|x2|2x/i) ||
    models[0];
  if (!model) throw new Error("Missing upscale model: put an upscale model (e.g. RealESRGAN_x4plus.safetensors or 4x-UltraSharp.pth) into ComfyUI/models/upscale_models/ and retry.");
  return { model };
}

// Video enhance (interpolate + upscale). Source video → GetVideoComponents → AI-upscale every
// frame (UpscaleModelLoader + ImageUpscaleWithModel) → optionally downscale to a
// bounded HD target (outW/outH, already even; 0 = keep the model's native output) →
// CreateVideo, keeping the SOURCE audio + fps. Frame interpolation to the target fps
// is layered ON TOP by applyVfi (called from the dispatch) — it splices a RIFE/FILM
// node before CreateVideo and rewrites the (numeric) fps. Single pass over the whole
// clip (no diffusion); keep clips modest so the upscaled frame batch fits VRAM.
function buildVideoEnhance({ videoName, upscaleModel, outW, outH, denoise }) {
  const wf = {
    "5": { class_type: "LoadVideo", inputs: { file: videoName } },
    "6": { class_type: "GetVideoComponents", inputs: { video: ["5", 0] } },
  };
  const clean = denoiseBeforeUpscale(wf, ["6", 0], denoise, "20", "21"); // pre-clean each frame (denoise)
  // No upscale model (⚙ "upscale model" = Off) → skip the AI upscale stage: interpolate-only (frames
  // stay at source resolution; interpolation is still layered on by applyVfi).
  let framesRef = clean;
  if (upscaleModel) {
    wf["7"] = { class_type: "UpscaleModelLoader", inputs: { model_name: upscaleModel } };
    wf["8"] = { class_type: "ImageUpscaleWithModel", inputs: { upscale_model: ["7", 0], image: clean } };
    framesRef = ["8", 0];
  }
  if (outW > 0 && outH > 0) {
    wf["9"] = { class_type: "ImageScale", inputs: { image: framesRef, upscale_method: "lanczos", width: outW, height: outH, crop: "disabled" } };
    framesRef = ["9", 0];
  }
  wf["18"] = { class_type: "CreateVideo", inputs: { images: framesRef, audio: ["6", 1], fps: ["6", 2] } };
  wf["19"] = { class_type: "SaveVideo", inputs: { video: ["18", 0], filename_prefix: "heykoko_enhance", format: "auto", codec: "auto" } };
  return wf;
}

// Pre-upscale denoise (denoise / artifact reduction). Upscale models AMPLIFY whatever's in the input —
// including compression noise / grain / JPEG artifacts. Blending the input toward a
// mildly Gaussian-blurred copy (by `strength` 0–1) cleans that grain BEFORE the model
// sees it, so it isn't sharpened up. 0 → untouched (sharpest); 1 → full blur (cleanest
// but softest). Works with ANY upscale model (core nodes only). Adds ImageBlur+ImageBlend
// under blurId/blendId; returns the cleaned image ref to feed ImageUpscaleWithModel.
function denoiseBeforeUpscale(wf, srcRef, strength, blurId, blendId) {
  const s = Math.max(0, Math.min(1, Number(strength) || 0));
  if (s <= 0) return srcRef;
  wf[blurId] = { class_type: "ImageBlur", inputs: { image: srcRef, blur_radius: 2, sigma: 1.5 } };
  wf[blendId] = { class_type: "ImageBlend", inputs: { image1: srcRef, image2: [blurId, 0], blend_factor: s, blend_mode: "normal" } };
  return [blendId, 0];
}

// Image upscale (image HD / upscale): attached image → AI upscale model → bigger, sharper
// image. `denoise` (0–1) pre-cleans the input (denoise). `outW/outH` (already even)
// optionally resize the upscaled result (e.g. --size); 0 = keep the model's native
// output (usually 4×). Output is a normal image.
function buildImageUpscale({ imageName, upscaleModel, outW, outH, denoise }) {
  const wf = { "1": { class_type: "LoadImage", inputs: { image: imageName } } };
  const clean = denoiseBeforeUpscale(wf, ["1", 0], denoise, "5", "6");
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

// LTX-2 (ltx-2.3-22b) — an AUDIO+VIDEO model. Checkpoint provides MODEL + video
// VAE + audio VAE; LTXAVTextEncoderLoader loads the Gemma text encoder with the
// right projection (plain CLIPLoader gives a dim mismatch). The pipeline builds a
// combined AV latent (video latent + empty audio latent → LTXVConcatAVLatent),
// samples it, splits it back (LTXVSeparateAVLatent), decodes video + audio
// separately, then CreateVideo muxes the audio into the mp4. t2v uses
// EmptyLTXVLatentVideo; i2v uses LTXVImgToVideo (also yields conditioning).
// Three input modes: t2v (no image); i2v (one image → LTXVImgToVideo); and
// keyframes (2+ images → each pinned at an evenly-spaced frame via a chain of
// LTXVAddGuide, then LTXVCropGuides trims the guide frames after sampling). Only
// the video-latent source + conditioning + decode-latent differ between modes;
// the audio path and sampler are shared.
function buildLtxVideo({ model, prompt, negative, comp, imageName, imageNames, seed, v }) {
  const neg = negative && negative.trim() ? negative : "worst quality, inconsistent motion, blurry, jittery, distorted";
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
  wf["6"] = { class_type: "ModelSamplingLTXV", inputs: { model: ["1", 0], max_shift: 2.05, base_shift: 0.95, latent: ["22", 0] } };
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
  const lora = find(loras, /lightx2v.*t2v.*14b.*distill|cfg_step_distill/i); // distill turbo LoRA (optional)
  const missing = [];
  if (!clip) missing.push("umt5_xxl_fp8_e4m3fn_scaled.safetensors → text_encoders/");
  if (!vae) missing.push("wan_2.1_vae.safetensors → vae/");
  if (missing.length) throw new Error("Missing files required by Bernini:\n- " + missing.join("\n- "));
  return { clip, vae, lora };
}

// Bernini's task system prompts (prepended to the user's instruction — the model
// was trained with these). v2v = plain video edit; rv2v = edit with a reference.
// reference_images is a COMFY_AUTOGROW_V3 slot list whose template declares max 8
// (reference_image_0 … _7). The node reads the slots in sorted() NAME order — safe
// only while the index stays a single digit, which this cap also guarantees.
const BERNINI_MAX_REFS = 8;

const BERNINI_SYS_V2V = "You are a helpful assistant specialized in video editing.";
const BERNINI_SYS_RV2V = "You are a helpful assistant specialized in video editing with reference.";
const BERNINI_SYS_I2V = "You are a helpful assistant specialized in image-to-video generation.";

// Bernini-R (WAN 2.2 MoE). The node picks its task from WHICH INPUTS ARE CONNECTED,
// so each mode here is just a different wiring of the same graph:
//   • v2v   — source video + instruction → edited video.
//   • rv2v  — source video + reference image(s) + instruction.
//   • i2v   — reference image only (NO source video) → generated video (the node's own
//             docs call this r2v and list no "i2v"; whether BERNINI_SYS_I2V is the
//             prompt this task was trained with is UNVERIFIED).
//   • ads2v — source video + insert image (reference_video) → the image composited in.
// Two-expert CUSTOM sampling: BasicScheduler → SplitSigmas at `split`, then two
// SamplerCustom (high adds noise, low continues), each on its sigma slice. turbo
// (distill LoRA mounted) = cfg 1 / 6 steps / split 3 (high str 3, low 1.5);
// non-turbo = cfg 5 / 40 steps / split 20. v2v/rv2v keep the SOURCE video's fps +
// audio (CreateVideo reads them from GetVideoComponents); i2v uses an explicit fps.
function buildBernini({ model, prompt, negative, comp, videoName, refImageName, refImageNames, insertImageName, width, height, length, seed, turbo, fps, refMaxSize, experts }) {
  // See buildWan14B: `experts` carries the ⚙-precision-resolved twins when set.
  const highModel = (experts && experts.high) || model.replace(/low_noise/i, "high_noise");
  const lowModel = (experts && experts.low) || model.replace(/high_noise/i, "low_noise");
  const neg = negative && negative.trim() ? negative : WAN_DEFAULT_NEGATIVE;
  const i2v = !videoName; // image-to-video: no source clip to edit
  // reference_images is an AUTOGROW slot list (reference_image_0, _1, …): [0] is the
  // primary, the rest are further views of the same subject. See buildScail2 — the
  // extra views carry information the primary cannot imply (a back view, a close-up).
  const refs = (Array.isArray(refImageNames) && refImageNames.length ? refImageNames : [refImageName])
    .filter(Boolean).slice(0, BERNINI_MAX_REFS);
  // ads2v's own system prompt isn't documented anywhere we can see; the with-reference
  // one is the closest of the three we know. UNVERIFIED — if insert results come out
  // ignoring the instruction, this line is the first suspect.
  const sys = insertImageName ? BERNINI_SYS_RV2V
    : (i2v ? BERNINI_SYS_I2V : (refs.length ? BERNINI_SYS_RV2V : BERNINI_SYS_V2V));
  const useTurbo = turbo && !!comp.lora;
  const steps = useTurbo ? 6 : 40;
  const split = useTurbo ? 3 : 20;
  const cfg = useTurbo ? 1 : 5;
  const wf = {
    "1": { class_type: "CLIPLoader", inputs: { clip_name: comp.clip, type: "wan", device: "default" } },
    "2": { class_type: "VAELoader", inputs: { vae_name: comp.vae } },
    "3": { class_type: "UNETLoader", inputs: { unet_name: highModel, weight_dtype: "default" } },
    "4": { class_type: "UNETLoader", inputs: { unet_name: lowModel, weight_dtype: "default" } },
    "7": { class_type: "CLIPTextEncode", inputs: { clip: ["1", 0], text: `${sys}\n${prompt}` } },
    "8": { class_type: "CLIPTextEncode", inputs: { clip: ["1", 0], text: neg } },
    "9": { class_type: "BerniniConditioning", inputs: { positive: ["7", 0], negative: ["8", 0], vae: ["2", 0], width, height, length, batch_size: 1, ref_max_size: refMaxSize || Math.max(width, height) } },
    "10": { class_type: "BasicScheduler", inputs: { model: ["4", 0], scheduler: "simple", steps, denoise: 1 } },
    "11": { class_type: "SplitSigmas", inputs: { sigmas: ["10", 0], step: split } },
    "12": { class_type: "KSamplerSelect", inputs: { sampler_name: "res_multistep" } },
    "17": { class_type: "VAEDecode", inputs: { samples: ["16", 0], vae: ["2", 0] } },
    "19": { class_type: "SaveVideo", inputs: { video: ["18", 0], filename_prefix: "heykoko_bernini", format: "auto", codec: "auto" } },
  };
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
  // Models feeding the two samplers — turbo mounts the distill LoRA on each.
  let highRef = ["3", 0], lowRef = ["4", 0];
  if (useTurbo) {
    wf["13"] = { class_type: "LoraLoaderModelOnly", inputs: { model: ["3", 0], lora_name: comp.lora, strength_model: 3 } };
    wf["14"] = { class_type: "LoraLoaderModelOnly", inputs: { model: ["4", 0], lora_name: comp.lora, strength_model: 1.5 } };
    highRef = ["13", 0]; lowRef = ["14", 0];
  }
  wf["15"] = { class_type: "SamplerCustom", inputs: { add_noise: true, noise_seed: seed, cfg, model: highRef, positive: ["9", 0], negative: ["9", 1], sampler: ["12", 0], sigmas: ["11", 0], latent_image: ["9", 2] } };
  wf["16"] = { class_type: "SamplerCustom", inputs: { add_noise: false, noise_seed: 0, cfg, model: lowRef, positive: ["9", 0], negative: ["9", 1], sampler: ["12", 0], sigmas: ["11", 1], latent_image: ["15", 0] } };
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
  const find = (list, re) => list.find((x) => re.test(x));
  const clip = find(clips, /umt5/i);
  // The template pins the bf16 Wan 2.1 VAE; any Wan 2.1 VAE works.
  const vae = find(vaes, /wan.?2[._]1.*vae/i) || find(vaes, /wan.*vae/i);
  const clipVision = find(cvs, /clip_vision_h|clip.?vision.*h\b/i) || find(cvs, /clip.?vision/i);
  const loraDistill = find(loras, /lightx2v.*i2v.*14b.*distill|lightx2v_I2V_14B/i);
  const loraDpo = find(loras, /scail.*dpo|dpo.*scail/i);
  const sam3 = find(ckpts, /sam3/i);
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
// its regenerated overlap, and colour-matches to the previous segment's last frame —
// then ImageBatch concatenates. `segments` = [{offset,length}, …] (length 1 = one pass).
const SCAIL2_FRAMES = 81;                          // template default frame_count, 4n+1
const SCAIL2_OVERLAP = 5;                          // previous_frame_count
const SCAIL2_STRIDE = SCAIL2_FRAMES - SCAIL2_OVERLAP; // 76 — pose offset per segment

// Segment schedule for a source of `total` frames, capped at `cap` frames per pass.
function scail2Segments(total, cap = SCAIL2_FRAMES) {
  const snap4 = (n) => Math.max(1, Math.floor((n - 1) / 4) * 4 + 1); // 4n+1, ≤ n
  const per = snap4(Math.max(5, Math.min(cap, SCAIL2_FRAMES)));
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

function buildScail2({ model, prompt, negative, comp, videoName, refImageName, refImageNames, width, height, seed, segments, replace = false, turbo = true, poseStrength = 1, poseStart = 0, poseEnd = 1, sam3VideoObject = "human", sam3ImageObject = "", objectIndices = "", sortBy = "left_to_right", detectionThreshold = 0.5, maxObjects = 4 }) {
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
  const steps = turbo ? 6 : 40;
  const cfg = turbo ? 1 : 5;
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
    "12": { class_type: "LoadVideo", inputs: { file: videoName } },
    "15": { class_type: "GetVideoComponents", inputs: { video: ["12", 0] } },
    // SAM3 open-vocabulary tracking. Node 23 tracks the REFERENCE image once and is
    // shared by every segment; each segment tracks its own slice of the driving video.
    "20": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: comp.sam3 } },
    "21": { class_type: "CLIPTextEncode", inputs: { clip: ["20", 1], text: sam3Vid } },
    "22": { class_type: "CLIPTextEncode", inputs: { clip: ["20", 1], text: sam3Ref } },
    "23": { class_type: "SAM3_VideoTrack", inputs: { images: ["10", 0], model: ["20", 0], detection_threshold: detThresh, max_objects: maxObj, detect_interval: 1, conditioning: ["22", 0] } },
    "27": { class_type: "KSamplerSelect", inputs: { sampler_name: "euler" } },
  };
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
  if (turbo) wf["3"] = { class_type: "LoraLoaderModelOnly", inputs: { model: ["2", 0], lora_name: comp.loraDistill, strength_model: 0.8 } };
  const modelSrc = turbo ? "3" : "2";
  wf["4"] = { class_type: "ModelSamplingSD3", inputs: { model: [modelSrc, 0], shift: 5 } };
  // Mirrors the template: BasicScheduler taps the LoRA'd model BEFORE ModelSamplingSD3.
  wf["18"] = { class_type: "BasicScheduler", inputs: { model: [modelSrc, 0], scheduler: "simple", steps, denoise: 1 } };

  let acc = null, prevOut = null;
  segs.forEach((sg, k) => {
    // 20 apart: a segment spans b+0 … b+11, so a 10-stride would silently overwrite
    // the previous segment's nodes — still-valid JSON, corrupted graph.
    const b = 100 + k * 20;
    const F = String(b), R = String(b + 1), G = String(b + 2), T = String(b + 3),
          MK = String(b + 4), S = String(b + 5), K = String(b + 6), D = String(b + 7);
    // The pose offset is applied by SLICING the source; the node's own
    // video_frame_offset stays 0 (exactly what the template does).
    wf[F] = { class_type: "ImageFromBatch", inputs: { image: ["15", 0], batch_index: sg.offset, length: sg.length } };
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
    if (k === 0) acc = out;
    else { const B = String(b + 11); wf[B] = { class_type: "ImageBatch", inputs: { image1: acc, image2: out } }; acc = [B, 0]; }
    prevOut = out;
  });
  // One CreateVideo over every segment — the output keeps the SOURCE fps + audio.
  wf["90"] = { class_type: "CreateVideo", inputs: { images: acc, audio: ["15", 1], fps: ["15", 2] } };
  wf["91"] = { class_type: "SaveVideo", inputs: { video: ["90", 0], filename_prefix: "heykoko_scail2", format: "auto", codec: "auto" } };
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
// video_frame_offset OUTPUT as its seek; ImageBatch concatenates all chunks; ONE
// CreateVideo muxes the source audio+fps. `chunks` = [{offset,length}, …] (length 1 =
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

function buildWanAnimate({ model, prompt, negative, comp, videoName, refImageName, width, height, seed, fps, torchCompile = false, chunks, replace = false, relightStrength = 1, maskPoint = null }) {
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
    const b = 100 + k * 10;
    const A = String(b), S = String(b + 1), T = String(b + 2), D = String(b + 3), F = String(b + 4);
    const animInputs = { positive: ["8", 0], negative: ["9", 0], vae: ["6", 0], clip_vision_output: ["11", 0], reference_image: ["10", 0], face_video: ["16", 0], pose_video: ["17", 0], width, height, length: ck.length, batch_size: 1, continue_motion_max_frames: 5, video_frame_offset: k === 0 ? 0 : [prevAnim, 5] };
    if (replace) { animInputs.background_video = ["34", 0]; animInputs.character_mask = ["33", 0]; }
    if (k > 0) animInputs.continue_motion = [prevFrames, 0]; // prev chunk's frames (node uses last 5)
    wf[A] = { class_type: "WanAnimateToVideo", inputs: animInputs };
    wf[S] = { class_type: "KSampler", inputs: { model: ["4", 0], positive: [A, 0], negative: [A, 1], latent_image: [A, 2], seed, steps: 6, cfg: 1, sampler_name: "euler", scheduler: "simple", denoise: 1 } };
    wf[T] = { class_type: "TrimVideoLatent", inputs: { samples: [S, 0], trim_amount: [A, 3] } };
    wf[D] = { class_type: "VAEDecode", inputs: { samples: [T, 0], vae: ["6", 0] } };
    wf[F] = { class_type: "ImageFromBatch", inputs: { image: [D, 0], batch_index: [A, 4], length: 4096 } };
    if (k === 0) accFrames = [F, 0];
    else { const B = String(b + 5); wf[B] = { class_type: "ImageBatch", inputs: { image1: accFrames, image2: [F, 0] } }; accFrames = [B, 0]; }
    prevAnim = A; prevFrames = F;
  });
  // Single CreateVideo over all accumulated frames — output keeps the SOURCE fps+audio.
  wf["90"] = { class_type: "CreateVideo", inputs: { images: accFrames, audio: ["15", 1], fps: ["15", 2] } };
  wf["91"] = { class_type: "SaveVideo", inputs: { video: ["90", 0], filename_prefix: "heykoko_animate", format: "auto", codec: "auto" } };
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
      return `ComfyUI execution error: ${node}${exc}`;
    }
  } catch { /* fall through */ }
  return "ComfyUI execution error (no details provided)";
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
  let precisionNote = null; // set only when those differ from the ⚙ request
  try {
    const body = await readBody(req);
    // Target the ComfyUI endpoint this job was routed to (parallel lanes); default global.
    comfyCtx.enterWith({ comfyUrl: normComfyUrl(body.comfyUrl) || config.comfyUrl });
    const { prompt, negative_prompt, options, images, mask, sourceVideo, sourceVideoName, sourceVideoMime, sourceVideoWidth, sourceVideoHeight, sourceVideoFrames, sourceVideoFps, continueVideoName, refImageWidth, refImageHeight, timeout: reqTimeout, clientId: bodyClientId } = body;
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
    if (model === BERNINI_AUTO || model === BERNINI_INSERT) {
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
    const videoType = videoTypeOf(model);

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
    const timeoutMs = videoType
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
        // Source video → v2v (+ ref image → rv2v); image only → i2v.
        if (!hasVideo && !hasImage) { sendJson(res, 400, { error: "Bernini needs a source video (video edit, v2v) or an image (image-to-video, i2v), then use /imagine <description>." }); return; }
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
        // The reference resolution must track the output size — a fixed large
        // ref_max_size (848) crops the reference into a small output frame.
        const refMax = snapDim(Math.max(bw, bh), 16);
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
        workflow = buildBernini({ model, prompt, negative: negative_prompt || "", comp, videoName, refImageNames, insertImageName, width: bw, height: bh, length: bl, seed, turbo, fps: bfps, refMaxSize: refMax, experts: expertPair });
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
        // Neither interpolation nor upscale (nor denoise / explicit resize) → ComfyUI has nothing to do.
        // Tell the user in the bubble instead of running a pointless re-encode.
        if (noUpscale && !willInterp && !willResize && !willDenoise) {
          sendJson(res, 200, { noop: true, message: `ℹ️ Nothing to do: neither interpolation nor upscale is enabled — ⚙ "upscale model" is set to "Off", and the target fps (${tf > 0 ? tf : "not set"}) is not higher than the source video fps (${srcFps}). ComfyUI was not called this time.\n\n· To interpolate: \`/imagine <a higher fps>\` (e.g. for a ${srcFps}fps source, enter ${srcFps * 2})\n· To upscale: change ⚙ "upscale model" from "Off" back to "Auto" or a specific model` });
          return;
        }
        const comp = noUpscale ? null : await upscaleCompanions(opts.upscaleModel);
        const videoName = sourceVideoName || await uploadVideo(sourceVideo, controller.signal, sourceVideoMime);
        // Output size = 2× the source (a clean HD doubling — the 4× upscale model adds
        // detail, then we downsample for crispness), capped so the long side ≤ 2160 to
        // avoid 4K+-per-frame monsters. A ⚙ --size sets an explicit budget instead.
        // 0/0 = keep the source resolution (Off, or source dims unknown).
        const HD_LONG_CAP = 2160;
        const even = (n) => Math.max(2, Math.round(n / 2) * 2);
        let outW = 0, outH = 0;
        const sw = Number(sourceVideoWidth), sh = Number(sourceVideoHeight);
        if (opts.width > 0 && opts.height > 0 && sw > 0 && sh > 0) {
          // Explicit --size → that pixel budget at the source aspect.
          const aspect = sw / sh, budget = opts.width * opts.height;
          outW = even(Math.sqrt(budget * aspect)); outH = even(Math.sqrt(budget / aspect));
        } else if (!noUpscale && sw > 0 && sh > 0) {
          // Default 2× HD doubling — only when actually upscaling (Off keeps source size).
          let tw = sw * 2, th = sh * 2;
          const longSide = Math.max(tw, th);
          if (longSide > HD_LONG_CAP) { const s = HD_LONG_CAP / longSide; tw *= s; th *= s; }
          outW = even(tw); outH = even(th);
        }
        workflow = buildVideoEnhance({ videoName, upscaleModel: comp ? comp.model : null, outW, outH, denoise: upscaleDenoise });
        upscaleInfo = { model: comp ? comp.model : null, denoise: upscaleDenoise };
        // Frame interpolation to the requested fps. applyVfi multiplies the
        // source fps to a NUMBER and splices RIFE/FILM before CreateVideo.
        let outFps = srcFps, mult = 1;
        if (willInterp) {
          // CEIL → interpolated fps ≥ target; a post-pass drops frames to EXACTLY tf.
          mult = Math.max(2, Math.ceil(tf / srcFps));
          const method = /film/i.test(opts.interpMethod || "") ? "film" : "rife";
          outFps = applyVfi(workflow, mult, srcFps, method);
          videoDims = { width: outW || undefined, height: outH || undefined, fps: outFps, interpolated: mult, interpMethod: method };
          exactTargetFps = tf; // resample the output down to this exact fps
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
          segments = scail2Segments(want);
          if (srcFrames > want) truncatedFrom = srcFrames; // pinned length cut the clip
        } else {
          segments = scail2Segments(srcFrames);
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
        workflow = buildScail2({
          model, prompt, negative: negative_prompt || "", comp, videoName, refImageNames,
          width: aw, height: ah, seed, segments, replace: scail2Replace,
          // SAM3 is open-vocabulary: the subject is text, not a fixed "human". The
          // reference falls back to the driving subject inside the builder — they only
          // differ when the driving text targets one person in a crowd ("person in a red
          // shirt") while the reference holds just the character.
          sam3VideoObject: opts.scailSubject,
          sam3ImageObject: opts.scailRefSubject,
          objectIndices: opts.scailIndices,
          sortBy: opts.scailSortBy,
          poseStrength: opts.poseStrength,
          poseStart: opts.poseStart,
          poseEnd: opts.poseEnd,
          detectionThreshold: opts.scailThreshold,
          maxObjects: opts.scailMaxObjects,
        });
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
        const segCap = animateSegmentCap(aw * ah, !!opts.torchCompile);
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
        workflow = buildWanAnimate({ model, prompt, negative: negative_prompt || "", comp, videoName, refImageName, width: aw, height: ah, seed, fps: afps, torchCompile: !!opts.torchCompile, chunks, replace: animateReplace, relightStrength: opts.relightStrength, maskPoint: opts.maskPoint });
        videoDims = { width: aw, height: ah, length: totalFrames, fps: afps, segments: chunks.length };
        if (truncatedFrom) videoDims.truncatedFrom = truncatedFrom;
      } else if (videoType) {
        // Video. WAN 5B ti2v + 14B i2v do image→video; WAN 14B t2v / Hunyuan are
        // text→video only. The dedicated WAN 2.2 14B i2v model needs a ref image.
        if (videoType === "wan" && /14b/i.test(model) && /i2v/i.test(model) && !isImg2Img) {
          sendJson(res, 400, { error: "This model is for image-to-video. Attach a reference image first, then use /imagine <description>." });
          return;
        }
        const comp = await videoCompanions(videoType, model);
        // WAN 14B with the LightX2V LoRAs installed → 4-step/cfg-1 turbo preset.
        const turbo = !!(comp.loraHigh && comp.loraLow);
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
        const isLtxKeyframes = wantImage && videoType === "ltx" && images.length >= 2;
        const LTX_MAX_KEYFRAMES = 8;
        let imageName = null, endImageName = null, imageNames = null;
        if (wantImage && isLtxKeyframes) {
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
        workflow = buildVideoWorkflow(videoType, { model, prompt, negative: negative_prompt || "", comp, imageName, endImageName, imageNames, seed, v, experts: expertPair });
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
        const comp = noImgUpscale ? null : await upscaleCompanions(opts.upscaleModel);
        const imageName = await uploadImage(images[0], controller.signal);
        let outW = 0, outH = 0;
        if (opts.width && opts.height) {
          const ts = editTargetSize(images, opts, 4096);
          if (ts) { outW = snapDim(ts.width, 2); outH = snapDim(ts.height, 2); }
        }
        workflow = buildImageUpscale({ imageName, upscaleModel: comp ? comp.model : null, outW, outH, denoise: upscaleDenoise });
        upscaleInfo = { model: comp ? comp.model : null, denoise: upscaleDenoise };
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
      let videoMime = "video/mp4";
      let firstVideoBuf = null; // kept to ffprobe the real output frame count (animate chunking)
      for (const nodeId of Object.keys(outputs)) {
        for (const img of outputs[nodeId].images || []) {
          if (img.type === "temp") continue; // skip previews, keep final outputs
          const params = new URLSearchParams({
            filename: img.filename,
            subfolder: img.subfolder || "",
            type: img.type || "output",
          });
          const viewResp = await fetch(`${currentComfyUrl()}/view?${params}`, { signal: controller.signal });
          if (!viewResp.ok) continue;
          const buf = Buffer.from(await viewResp.arrayBuffer());
          if (/\.(mp4|webm|mov)$/i.test(img.filename)) {
            videoMime = /\.webm$/i.test(img.filename) ? "video/webm" : "video/mp4";
            if (!firstVideoBuf) firstVideoBuf = buf;
            outVideos.push(buf.toString("base64"));
          } else {
            outImages.push(buf.toString("base64"));
          }
        }
      }

      // Interpolation exact-fps pass: RIFE/FILM only multiply by an integer, so the interpolated
      // fps (videoDims.fps) overshoots the user's target. ffmpeg-resample the output DOWN
      // to EXACTLY exactTargetFps (drops frames evenly, keeps duration + audio) — smoother
      // than no interpolation, but at the precise frame rate the user asked for.
      if (exactTargetFps > 0 && outVideos.length && videoDims && videoDims.fps > exactTargetFps) {
        let anyResampled = false;
        for (let vi = 0; vi < outVideos.length; vi++) {
          const rs = await resampleVideo(Buffer.from(outVideos[vi], "base64"), exactTargetFps);
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
      if (stillMode) {
        // Single-frame Wan Animate → an IMAGE result (not a video).
        console.log(`${ts} [comfy-gen] model=${model}, mode=animate:still, ${videoDims ? videoDims.width + "x" + videoDims.height : "?"}, images=${outImages.length}`);
        if (!outImages.length) { sendJson(res, 502, { error: "ComfyUI finished but produced no image. Please retry." }); return; }
        sendJson(res, 200, { images: outImages, model, seed, precisionNote, precisionUsed, width: videoDims?.width, height: videoDims?.height, imagesUsed });
      } else if (videoType) {
        console.log(`${ts} [comfy-gen] model=${model}, mode=video:${videoType}${isImg2Img ? "(i2v)" : "(t2v)"}, ${videoDims ? videoDims.width + "x" + videoDims.height : "?"}, videos=${outVideos.length}`);
        // Ran to completion but no video file came back — tell the client why rather
        // than a bare "no video" (usually SaveVideo missing or an output-collection miss).
        if (!outVideos.length) {
          const nodeIds = Object.keys(outputs || {}).join(", ") || "none";
          sendJson(res, 502, { error: `ComfyUI finished but produced no video file (output nodes: ${nodeIds}). Make sure the workflow includes a SaveVideo node, or retry.` });
          return;
        }
        sendJson(res, 200, { videos: outVideos, videoMime, model, seed, precisionNote, precisionUsed, width: videoDims?.width, height: videoDims?.height, fps: videoDims?.fps, length: videoDims?.length, segments: videoDims?.segments, truncatedFrom: videoDims?.truncatedFrom, truncatedNoChain: videoDims?.truncatedNoChain, interpolated: videoDims?.interpolated, interpMethod: videoDims?.interpMethod, interpWarning, upscaleModel: upscaleInfo?.model || undefined, upscaleDenoise: upscaleInfo?.denoise || undefined, imagesUsed });
      } else {
        const mode = editType ? `edit:${editType}${hasMask ? "+mask" : ""}` : hasMask ? `inpaint` : isImg2Img ? `img2img(denoise=${denoise})` : `txt2img ${width}x${height}`;
        console.log(`${ts} [comfy-gen] model=${model}, mode=${mode}, sampler=${cfg.sampler}/${cfg.scheduler}, cfg=${cfg.cfg}${cfg.guidance != null ? `, guidance=${cfg.guidance}` : ""}, steps=${cfg.steps}, images=${outImages.length}`);
        sendJson(res, 200, { images: outImages, model, seed, precisionNote, precisionUsed, upscaleModel: upscaleInfo?.model || undefined, upscaleDenoise: upscaleInfo?.denoise || undefined });
      }
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
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
        "7": { class_type: "SaveImage", inputs: { images: ["6", 0], filename_prefix: "heykoko_automask" } },
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
        "7": { class_type: "SaveImage", inputs: { images: ["6", 0], filename_prefix: "heykoko_automask" } },
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
        "6": { class_type: "SaveImage", inputs: { images: ["5", 0], filename_prefix: "heykoko_automask" } },
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

module.exports = { proxyComfyModels, generateComfyImage, uploadComfyVideo, comfyAutoMask };