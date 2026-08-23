// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

// MODEL IDENTITY. One canonical, stable, lowercase id per model — the key the gallery
// records, the `-m/--model` flag accepts, and the picker labels itself from.
//
// Why this module exists at all: everything used to be keyed by the FILENAME of a
// quantisation group's representative, and that representative is chosen by PREC_AUTO_ORDER
// from whatever is installed. Download one more build and the representative moves
// (z_image_turbo_nvfp4 → z_image_turbo_fp8), taking the key with it — a saved dropdown
// choice stops matching and silently falls back to the first option, and gallery rows
// written before and after the download no longer group together. A model's identity must
// not depend on which of its builds happen to be on this disk.
//
// The naming convention:
//   IN   family + version, parameter count, and the WEIGHT-level role (t2v / i2v / edit /
//        turbo / dev / kontext) — anything that means "a different file".
//   OUT  quantisation (fp8 / mxfp8 / nvfp4 / int8 / bf16), "pruned", packaging noise
//        (_scaled, _e4m3fn, _convrot, _KJ), the extension. Precision travels as its own
//        field; it is a property of the build, not of the model.
//   ":"  separates a MODE — same weights, different graph (bernini:insert, scail2-14b:animate).
//        "-" separates things that are different weights. So the model behind any id is
//        `id.split(":")[0]`, which is what the gallery groups by.
//
// Parameter counts follow what upstream PUBLISHES, not bytes on disk: Wan 2.2 14B is 14B
// even though its two-expert pair is ~28B on disk, and a "pruned" H3 is the same model at
// the same size (pruning swaps modulation weights for a lookup table). A count that
// upstream does not publish is NOT invented — it appears only when it distinguishes
// (phantom-14b vs phantom-1.3b) or is already part of the published name (ltx2.3-22b).
//
// THE ID IS PRIMARY AND THE LABEL IS DERIVED FROM IT — never the reverse. Labels are
// display strings that get reworded; if ids were derived from them, a copy edit would
// silently re-partition the gallery.

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
// fp8mixed (Sulphur's naming) sits BEFORE the bare fp8 alternative — alternation takes
// the first match, so "fp8|fp8mixed" would match "fp8" and then fail the [_.-]|$
// lookahead on the trailing "mixed", leaving the file unclassified.
// "comfy[-_]int8[-_]convrot" covers the LTX-2.5 spelling (hyphens, plus a "comfy-"
// packaging prefix: ltx-2.5-…-comfy-int8-convrot). Without it only the bare "int8"
// would match, leaving "-comfy…-convrot" glued to the base — so the int8 build would
// not collapse with its nvfp4/bf16 siblings and would show as a second model.
const PRECISION_TOKENS = "fp8_e4m3fn_scaled|fp8_e4m3fn_fast|fp8_e4m3fn|fp8_e5m2|fp8_scaled|fp8mixed|fp8_mixed|fp8|mxfp8|nvfp4_mxpf8_mix|nvfp4|comfy[-_]int8[-_]convrot|int8[-_]convrot|int8|fp16|bf16";
// "pruned" is an OPTIONAL PREFIX on the quantisation token, not a token of its own.
// MiniMax H3 ships the same tier both ways (…_pruned_int8_convrot, …_pruned_fp8_scaled,
// and community …_pruned_nvfp4): pruning only replaces the modulation weights (~40% of
// the parameters) with an equivalent lookup table, so it is the same model at the same
// precision. Treating it as a prefix is what makes every H3 variant collapse to one
// base; writing it into the token list instead only ever fixes the ONE spelling listed
// there, and the next variant silently splits into a second identical dropdown entry.
const PRECISION_RE = new RegExp(`(?:^|[_-])(?:pruned_)?(${PRECISION_TOKENS})(?=[_.-]|$)`, "i");
const PRECISION_RE_G = new RegExp(`(?:^|[_-])(?:pruned_)?(?:${PRECISION_TOKENS})(?=[_.-]|$)`, "ig");

function precisionOf(name) {
  const m = PRECISION_RE.exec(name || "");
  if (!m) return null;
  const tok = m[1].toLowerCase();
  if (tok.startsWith("nvfp4")) return "nvfp4";
  if (tok === "mxfp8") return "mxfp8";
  if (tok.startsWith("fp8")) return "fp8";
  if (tok.includes("int8")) return "int8"; // includes, not startsWith — "pruned_int8_convrot"

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

// Which build to load when a model ships several and the user expressed NO ⚙
// preference. fp8 stays first so every model that has an fp8 build behaves exactly as
// it did before this order existed; the rest only decides the cases that previously
// had no rule at all and fell through to whatever disk order happened to be — which
// is how a model shipping int8 + bf16 ended up defaulting to the unquantised 21 GB
// file. Quantised beats unquantised, and nvfp4 sits last of the quantised tiers
// because the most aggressive one should be asked for, not handed out by default.
const PREC_AUTO_ORDER = ["fp8", "mxfp8", "int8", "nvfp4", "fp16"];
function bestTier(list, nameOf = (x) => x) {
  const arr = list || [];
  for (const tier of PREC_AUTO_ORDER) {
    const hit = arr.find((x) => precisionOf(nameOf(x)) === tier);
    if (hit) return hit;
  }
  return arr[0] || null;   // nothing carries a recognisable token — keep disk order
}

// ── The id table ─────────────────────────────────────────────────────────────

// Sentinels are dropdown values that name no file on disk — a merged two-expert entry,
// or one graph MODE of a shared set of weights. They are already stable strings, so they
// are mapped rather than renamed: comfy.js dispatches on these exact literals (and has
// been bitten before by one sentinel's substring matching another's), so they must not
// move. Historically they were also spelled three different ways (wan2.2_14B, ltx-msr,
// bernini) — the id is where that becomes consistent.
const SENTINEL_IDS = {
  "wan2.2_14B": "wan2.2-14b",
  bernini: "bernini:i2v",
  bernini_insert: "bernini:insert",
  bernini_image_edit: "bernini:edit",
  bernini_subject_image: "bernini:subject",
  bernini_text_image: "bernini:t2i",
  panorama_360_text: "panorama-360",
  wan_animate_replace: "wan-animate-14b:replace",
  scail2_animate: "scail2-14b:animate",
  "ltx-msr": "ltx2.3-22b:msr",
  "ltx-union": "ltx2.3-22b:union",
  "ltx25-union": "ltx2.5-22b:union",
  "ltx25-ingredients": "ltx2.5-22b:ingredients",
  "ltx25-upscale": "ltx2.5-22b:upscale",
  "ltx25-outpaint": "ltx2.5-22b:outpaint",
  "ltx25-inpaint": "ltx2.5-22b:inpaint",
  "ltx-foley": "ltx2.3-22b:foley",
  "ltx25-track": "ltx2.5-22b:track",
  infinitetalk: "infinitetalk:dub",
  infinitetalk_speak: "infinitetalk:speak",
  "video-enhance": "video-enhance",
  "image-upscale": "image-upscale",
  triposplat: "triposplat",
  "moge-mesh": "moge2:mesh",
  "moge-panorama": "moge2:panorama",
  // Krea-2's style-reference route is the SAME turbo weights plus the ostris
  // style-reference LoRA and a different graph (TextEncodeQwenImageEditPlus +
  // SamplerCustomAdvanced), so it is a MODE — ":" — not a separate model.
  krea2_style_ref: "krea2-turbo:style-ref",
  // The Qwen-Image control / decomposition routes: the same base weights driven through a
  // different control mechanism, so each is a MODE of qwen-image — except Fun Union, which
  // only runs on the 2512 base, and Relight, which is a LoRA on the 2509 edit weights.
  "qwen-control": "qwen-image:control",
  "qwen-control-patch": "qwen-image:control-patch",
  "qwen-control-lora": "qwen-image:control-lora",
  "qwen-control-2512": "qwen-image-2512:control",
  "qwen-inpaint": "qwen-image:inpaint",
  "qwen-layered": "qwen-image:layered",
  "qwen-relight": "qwen-image-edit:relight",
  "qwen-angles": "qwen-image-edit:angles",
};

// Filename → id, matched against the PRECISION-STRIPPED base. Stripping first is what
// makes the id independent of which builds are installed. Ordered: a more specific
// pattern must precede the family it belongs to (kontext before flux, hunyuan3d before
// the hunyuan video rule, phantom-14b before phantom).
//
// These must cover the RESOLVED filenames too, not just what the dropdown lists — the
// gallery records what actually ran, and a sentinel has become a real filename by then.
const FILE_ID_RULES = [
  [/flux.*kontext/, "flux1-kontext"],
  [/flux1?.?dev/, "flux1-dev"],
  [/pony/, "pony-v6-xl"],
  [/hidream.?i1/, "hidream-i1"],
  [/hidream.?o1/, "hidream-o1"],
  [/hidream.?e1/, "hidream-e1.1"],
  [/z.?image.?turbo/, "zimage-turbo"],
  // Krea-2 ships two open checkpoints of the same 12B DiT: `raw` (the pretrained
  // base, for finetuning / LoRA training) and `turbo` (8-step distilled). Different
  // weights, so different ids — and `raw` must be tested first or the bare /krea2/
  // rule below would claim it for the turbo id.
  [/krea2.*raw/, "krea2-raw"],
  [/krea2/, "krea2-turbo"],
  [/boogu.*edit/, "boogu-edit"],
  [/boogu.*base/, "boogu-base"],
  [/boogu.*turbo/, "boogu-turbo"],
  [/qwen.?image.?edit.*2511|qwen.*2511.*edit/, "qwen-image-edit-2511"],
  [/qwen.?image.?edit/, "qwen-image-edit"],
  [/qwen.?image.*2512|qwen.*2512/, "qwen-image-2512"],
  [/qwen.?image/, "qwen-image"],
  [/omnigen/, "omnigen2"],
  [/pix2pix|instruct.?pix/, "instruct-pix2pix"],
  [/sulphur/, "ltx2-sulphur"],
  [/ltx.?2[._]?5/, "ltx2.5-22b"],
  [/ltx/, "ltx2.3-22b"],
  // Music 3 BEFORE the H3 rules. They do not collide today (/minimax.?h3/ cannot match
  // "minimax_music3" — the ".?" would have to swallow "_mu"), but the two are one
  // vendor prefix apart and a looser H3 pattern later would silently claim the song
  // model. The DiT is the only file that reaches an id: its text encoder and audio VAE
  // are companions resolved off disk, never dropdown entries.
  [/minimax.?music.?3/, "minimax-music3"],
  [/minimax.?h3.*ref2va/, "minimax-h3-r2v"],
  [/minimax.?h3/, "minimax-h3-t2v"],
  [/phantom.*14b/, "phantom-14b"],
  [/phantom/, "phantom-1.3b"],
  [/hunyuan[._-]?3d/, "hunyuan3d-2.1"],
  [/hunyuan/, "hunyuanvideo"],
  [/dancer/, "wan-dancer-14b"],
  [/fun.?vace/, "wan2.2-funvace-14b"],
  [/ti2v.*5b/, "wan2.2-5b-ti2v"],
  // Bernini publishes no parameter count, so none is invented — it is the only model in
  // its family. Its MODE comes from the sentinel; the bare weights default to i2v.
  [/bernini/, "bernini:i2v"],
  [/animate/, "wan-animate-14b:move"],
  [/scail/, "scail2-14b:replace"],
  // The two-expert 14B pair, whose files carry the role the merged sentinel hides.
  [/wan2.2.*i2v.*14b|wan2.2.*14b.*i2v/, "wan2.2-14b-i2v"],
  [/wan2.2.*t2v.*14b|wan2.2.*14b.*t2v/, "wan2.2-14b-t2v"],
];

// Display label per id. Derived FROM the id, so rewording one never moves any data.
// An id with no entry falls back to the id itself, which is already readable.
const ID_LABELS = {
  "wan2.2-14b": "Wan 2.2 14B",
  "wan2.2-14b-t2v": "Wan 2.2 14B (t2v)",
  "wan2.2-14b-i2v": "Wan 2.2 14B (i2v)",
  "wan2.2-5b-ti2v": "Wan 2.2 TI2V 5B",
  "wan2.2-funvace-14b": "Wan 2.2 Fun-VACE 14B",
  "wan-dancer-14b": "Wan Dancer 14B (music → dance)",
  "wan-animate-14b:move": "Wan Animate 14B (move)",
  "wan-animate-14b:replace": "Wan Animate 14B (replace)",
  "scail2-14b:animate": "SCAIL-2 14B (animate)",
  "scail2-14b:replace": "SCAIL-2 14B (replace)",
  "bernini:i2v": "Bernini (i2v / video edit)",
  "bernini:insert": "Bernini (insert image)",
  "bernini:edit": "Bernini (image edit / relight)",
  "bernini:subject": "Bernini (subject → image)",
  "bernini:t2i": "Bernini (text → image)",
  "phantom-14b": "Phantom-Wan 14B",
  "phantom-1.3b": "Phantom-Wan 1.3B",
  "minimax-music3": "MiniMax Music 3 (text → song)",
  "minimax-h3-t2v": "MiniMax H3 (t2v / i2v)",
  "minimax-h3-r2v": "MiniMax H3 (r2v)",
  "ltx2.3-22b": "LTX-2.3 22B",
  "ltx2.5-22b": "LTX-2.5 22B",
  "ltx2.5-22b:union": "LTX-2.5 22B Union",
  "ltx2.5-22b:ingredients": "LTX-2.5 22B Ingredients",
  "ltx2.5-22b:upscale": "LTX-2.5 22B Pixel Upscale ×2",
  "ltx2.5-22b:outpaint": "LTX-2.5 22B Outpaint",
  "ltx2.5-22b:inpaint": "LTX-2.5 22B Inpaint",
  "ltx2.3-22b:foley": "LTX-2.3 22B Foley (video → sound)",
  "ltx2.5-22b:track": "LTX-2.5 22B Motion Track",
  "ltx2.3-22b:msr": "LTX-2.3 22B MSR",
  "ltx2.3-22b:union": "LTX-2.3 22B Union",
  "ltx2-sulphur": "LTX-2 Sulphur",
  hunyuanvideo: "HunyuanVideo",
  "hunyuan3d-2.1": "Hunyuan3D 2.1",
  "infinitetalk:dub": "InfiniteTalk (dub / lip-sync)",
  "infinitetalk:speak": "InfiniteTalk (photo speaks)",
  "flux1-dev": "Flux.1 dev",
  "flux1-kontext": "Flux.1 Kontext",
  "pony-v6-xl": "Pony Diffusion V6 XL",
  "hidream-i1": "HiDream-I1",
  "hidream-o1": "HiDream-O1",
  "hidream-e1.1": "HiDream-E1.1",
  "zimage-turbo": "Z-Image Turbo",
  "krea2-turbo": "Krea-2 Turbo",
  "krea2-raw": "Krea-2 Raw",
  "krea2-turbo:style-ref": "Krea-2 Turbo (style reference)",
  "boogu-base": "Boogu (base)",
  "boogu-turbo": "Boogu (turbo)",
  "boogu-edit": "Boogu Edit",
  "qwen-image": "Qwen-Image",
  "qwen-image-edit": "Qwen-Image-Edit 2509",
  "qwen-image-edit-2511": "Qwen-Image-Edit 2511",
  "qwen-image-2512": "Qwen-Image 2512",
  "qwen-image:control": "Qwen-Image ControlNet (InstantX Union)",
  "qwen-image:control-patch": "Qwen-Image ControlNet (DiffSynth patch)",
  "qwen-image:control-lora": "Qwen-Image ControlNet (DiffSynth union LoRA)",
  "qwen-image-2512:control": "Qwen-Image 2512 ControlNet (Fun Union)",
  "qwen-image:inpaint": "Qwen-Image Inpainting (InstantX)",
  "qwen-image:layered": "Qwen-Image Layered",
  "qwen-image-edit:relight": "Qwen-Image-Edit Relight",
  "qwen-image-edit:angles": "Qwen-Image-Edit 3D Camera (96 angles)",
  omnigen2: "OmniGen2",
  "instruct-pix2pix": "Instruct-Pix2Pix",
  triposplat: "TripoSplat (image → 3D splat)",
  "moge2:mesh": "MoGe-2 (photo → 3D scene)",
  "moge2:panorama": "MoGe-2 (360° panorama → 3D scene)",
  "panorama-360": "360° panorama (text or photo → equirect)",
  "video-enhance": "Video interpolate + upscale",
  "image-upscale": "Image upscale",
};

// Last-resort id for a file no rule claims: its precision-stripped base, slugified.
// Still stable across installed builds (that is what the stripping buys) and still
// lowercase — just not pretty. A model that shows up here wants a FILE_ID_RULES entry.
function slugify(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

// The canonical id for a dropdown value or a resolved filename. Always lowercase.
function canonicalModelId(name) {
  const n = String(name || "").trim();
  if (!n) return null;
  if (Object.prototype.hasOwnProperty.call(SENTINEL_IDS, n)) return SENTINEL_IDS[n];
  // The LTX-2.5 effect sentinels are a family ("ltx25-fx-<effect>"): one graph, one
  // IC-LoRA per effect, so the effect rides the MODE part of the id.
  if (n.startsWith("ltx25-fx-")) return "ltx2.5-22b:fx-" + n.slice(9);
  const base = precisionBase(n);
  for (const [re, id] of FILE_ID_RULES) if (re.test(base)) return id;
  return slugify(base) || null;
}

// The id the GALLERY should record for a run: the user picked `requested` (a dropdown
// value, possibly a sentinel) and the server ran `resolved` (a real file).
//
// Neither alone is right. A sentinel carries the MODE, which the file cannot (both Wan
// Animate modes load the same UNET; all five Bernini tasks share one MoE pair) — so a
// mode-bearing sentinel wins. But the merged "wan2.2_14B" entry hides the opposite
// case: it resolves to a t2v or an i2v file depending on whether an image was attached,
// and only the resolved name knows which. Hence: keep the sentinel when it names a mode,
// otherwise prefer the more specific id the resolved file gives.
function galleryModelId(requested, resolved) {
  const reqId = canonicalModelId(requested);
  if (reqId && reqId.includes(":")) return reqId;
  return canonicalModelId(resolved) || reqId;
}

// Display name for an id (or for a raw name, via its id).
function labelForId(id) {
  if (ID_LABELS[id]) return ID_LABELS[id];
  if (String(id || "").startsWith("ltx2.5-22b:fx-")) {
    const fx = id.slice(14).replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    return `LTX-2.5 22B ${fx}`;
  }
  return id || "";
}

module.exports = {
  PRECISION_RE_G, PREC_AUTO_ORDER,
  precisionOf, precisionBase, pickPrecision, bestTier,
  canonicalModelId, galleryModelId, labelForId,
};
