# ComfyUI Deployment List

Starting from a **blank ComfyUI**, install the custom-node packs and model files below to support every **verified** workflow Hey-Koko currently ships.

See also: [ComfyUI overview](comfyui.md) · [Install](install.md) · [Optional tools](optional-tools.md)

## What this list includes

Only workflows that are **end-to-end verified on real hardware AND fully wired into a build graph** — the criterion is `isModelReady()` in `server/comfy.js`, a hand-maintained allowlist whose own comment reads *"end-to-end verified on real hardware AND fully wired"*.

Four integrations are therefore **excluded**; you do not need their model files:

| Excluded | Why |
|---|---|
| HiDream-O1 | Upstream ComfyUI bug — `hidream_o1/attention.py` calls `scaled_dot_product_attention` without GQA kwargs (32 query heads vs 8 kv heads). Head counts are model constants, so no graph-side parameter works around it. |
| Wan 2.2 fun-VACE | No VACE-specific builder. Running it as a plain t2v would silently ignore the control/reference inputs. |
| Bernini insert (ads2v) | Wired but never live-verified. |
| Phantom (subject-to-video) | ⚠️ **Conflicting records**: `isModelReady()` lists it as ready, but the project notes say "syntax and graph structure verified, **never run on real hardware**". Excluded pending confirmation. |

> Node ownership and model filenames were read from a **running ComfyUI** (`/object_info`, `python_module` field) rather than inferred from names — names mislead (`HKBoxToBBox` is not a Hey-Koko node; `SAM3_*` are core nodes).

---

## 1. Base environment

| | Requirement |
|---|---|
| ComfyUI | **≥ 0.30.0** for the full list. The floor is 0.29.0 for everything except MiniMax H3, whose `MiniMaxH3*` nodes, `CLIPLoader` type `minimax` and `COMFY_AUTOGROW_V3` dynamic inputs all arrived in 0.30. Of the 168 node types Hey-Koko emits, **128 are core** — including `SAM3_*`, `SCAIL2ColoredMask`, `WanSCAILToVideo`, `WanDancer*`, `TripoSplat*`, `MoGe*`, `BerniniConditioning` and `LTXV*`, all of which only entered core in 0.29. |
| ffmpeg / ffprobe | On the machine running **Hey-Koko** (not the ComfyUI host) — used for video transcoding. |

### SageAttention

Install [SageAttention](https://github.com/thu-ml/SageAttention) and launch ComfyUI with `--use-sage-attention`. It is worth doing before anything else — measured speed-up on a single SCAIL-2 segment, warm vs warm:

| Resolution | RTX 5090 | DGX Spark (GB10) |
|---|---|---|
| 736×1280 | **1.95×** | **1.44×** |
| 1088×1920 | **2.28×** | **1.69×** |

The gain **grows with resolution**, because what SageAttention accelerates — attention — is the term that scales quadratically with token count and dominates at higher resolutions.

No measurable quality cost: same-seed before/after renders matched on frame-to-frame difference (flicker), high-frequency energy (sharpness) and SSIM, and were indistinguishable side by side, including hand detail at 2× zoom.

Prebuilt wheels exist for Windows. On ARM64 / GB10 it must be built from source, and the compute capability must be given explicitly on machines that cannot auto-detect it (`TORCH_CUDA_ARCH_LIST="12.1"` for GB10) — its kernels are architecture-specific, so a build targeting a different capability will not load.

> The flag is global: **every** model in ComfyUI will use quantised attention, not just the video ones. The quality check above covers SCAIL-2 only.

---

## 2. Custom node packs

Eleven packs. **The directory name is the identifier** — after installing, `custom_nodes/` should contain a directory of the same name (ComfyUI Manager searches by it).

| `custom_nodes/` directory | Nodes provided | Needed by |
|---|---|---|
| **ComfyUI-KJNodes** | `ImageResizeKJv2` `GetImageSizeAndCount` `GetImageRangeFromBatch` `ImageCropByMaskAndResize` `DrawMaskOnImage` `BlockifyMask` `TorchCompileModelAdvanced` `LTX2_NAG` | SCAIL-2, Wan Animate, InfiniteTalk, LTX MSR, all 3D chains |
| **ComfyUI-VideoHelperSuite** | `VHS_LoadVideo` `VHS_VideoCombine` | SCAIL-2; ⚙ H.265 output (all video workflows) |
| **ComfyUI-WanVideoWrapper** | `WanVideoModelLoader` `WanVideoSampler` `MultiTalkModelLoader` `Wav2VecModelLoader` + 9 more | InfiniteTalk (lip-sync / talking photo) |
| **ComfyUI-segment-anything-2** | `DownloadAndLoadSAM2Model` `Sam2Segmentation` | Wan Animate (Move / Replace) |
| **comfyui_controlnet_aux** | `DWPreprocessor` `PixelPerfectResolution` | Wan Animate (pose extraction) |
| **ComfyUI-LTXVideo** | `LTXICLoRALoaderModelOnly` `LTXAddVideoICLoRAGuide` | LTX MSR V2 |
| **ComfyUI-Licon-MSR** | `LiconMSR` | LTX MSR V2 |
| **ComfyUI-PromptRelay** | `PromptRelayEncode` | LTX MSR V2 |
| **ComfyUI-Hunyuan3d-2-1** | `Hy3DMultiViewsGenerator` `Hy3DBakeMultiViews` `Hy3D21ExportMesh` + 4 more | Hunyuan3D **PBR texturing** |
| **ComfyUI-Hunyuan3DWrapper** (kijai) | `MESHToTrimesh` + 34 more | Hunyuan3D PBR texturing (requires compiling `custom_rasterizer`) |
| **ComfyUI-HKBox** | `HKBoxToBBox` | Wan Animate region box |

> A missing pack never fails silently: Hey-Koko checks with `comfyHasNodes()` up front and either **degrades gracefully or reports the missing pack**, rather than submitting a graph ComfyUI would reject.

### Verify after installing

```bash
node -e '
const NEED=["ImageResizeKJv2","VHS_LoadVideo","VHS_VideoCombine","WanVideoSampler",
"Wav2VecModelLoader","Sam2Segmentation","DWPreprocessor","LTXICLoRALoaderModelOnly",
"LiconMSR","PromptRelayEncode","Hy3DMultiViewsGenerator","MESHToTrimesh","HKBoxToBBox",
"SAM3_VideoTrack","WanSCAILToVideo","WanDancerVideo","TripoSplatConditioning","MoGeInference",
"MiniMaxH3ReferenceToVideo"];   // core, but 0.30+ only — doubles as the version check
fetch("http://<your-comfyui>:8188/object_info").then(r=>r.json()).then(oi=>{
  const miss=NEED.filter(n=>!oi[n]);
  console.log(miss.length?"❌ missing: "+miss.join(", "):"✅ all nodes present");
});'
```

---

## 3. Shared model files

Used by several workflows — **install these first**.

### `models/text_encoders/`
| File | Used by |
|---|---|
| `umt5_xxl_fp8_e4m3fn_scaled.safetensors` | Every Wan family model (t2v/i2v, Animate, SCAIL-2, Bernini, Dancer, InfiniteTalk) |
| `clip_l.safetensors` | Flux, Kontext, HunyuanVideo |
| `t5xxl_fp8_e4m3fn_scaled.safetensors` | Flux, Kontext, HiDream |
| `qwen_2.5_vl_7b_fp8_scaled.safetensors` | Qwen-Image, Qwen-Image-Edit |
| `qwen3vl_8b_fp8_scaled.safetensors` | boogu (generate + edit) |
| `qwen_3_4b.safetensors` | Z-Image Turbo |
| `llava_llama3_fp8_scaled.safetensors` | HunyuanVideo |
| `clip_l_hidream.safetensors`<br>`clip_g_hidream.safetensors`<br>`llama_3.1_8b_instruct_fp8_scaled.safetensors` | HiDream-I1 / E1.1 — **all three**, plus t5xxl |
| `ltx-2.3_text_projection_bf16.safetensors` | All LTX-2.3 |

### `models/vae/`
| File | Used by |
|---|---|
| `wan_2.1_vae.safetensors` | Wan 2.1 family, Bernini |
| `Wan2_1_VAE_bf16.safetensors` | SCAIL-2, InfiniteTalk |
| `wan2.2_vae.safetensors` | Wan 2.2 14B, TI2V-5B |
| `ae.safetensors` | Flux, Kontext, HiDream, Z-Image, OmniGen2 |
| `flux1_vae_bf16.safetensors` | boogu |
| `qwen_image_vae.safetensors` | Qwen-Image, Qwen-Image-Edit |
| `hunyuan_video_vae_bf16.safetensors` | HunyuanVideo |
| `LTX23_video_vae_bf16.safetensors`<br>`LTX23_audio_vae_bf16.safetensors` | LTX-2.3 (the audio VAE is for video with sound) |
| `taeltx2_3.safetensors` | LTX-2.3 previews |

### `models/clip_vision/`
| File | Used by |
|---|---|
| `clip_vision_h.safetensors` | Wan Animate, SCAIL-2, InfiniteTalk, Wan-Dancer |
| `dino_v3_vit_h.safetensors` | TripoSplat |

---

## 4. Per workflow

### 4.1 Image generation

| Workflow | Main model → folder | Also needs |
|---|---|---|
| **Flux.1-dev** | `flux1-dev-fp8.safetensors` → `checkpoints/` | self-contained |
| **Pony Diffusion V6 XL** | `ponyDiffusionV6XL_v6StartWithThisOne.safetensors` → `checkpoints/` | self-contained |
| **Z-Image Turbo** | `z_image_turbo_bf16.safetensors` (or `_nvfp4`) → `diffusion_models/` | qwen_3_4b · ae |
| **Qwen-Image** | `qwen_image_nvfp4.safetensors` → `diffusion_models/` | qwen_2.5_vl_7b · qwen_image_vae |
| **boogu** (base / turbo) | `boogu_image_base_fp8_scaled.safetensors`<br>`boogu_image_turbo_fp8_scaled.safetensors` (each has an `_nvfp4` variant) → `diffusion_models/` | qwen3vl_8b · flux1_vae_bf16 |
| **HiDream-I1** | `hidream_i1_full_fp8.safetensors` → `diffusion_models/` | clip_l_hidream · clip_g_hidream · t5xxl · llama_3.1_8b · ae |

> **nvfp4 precision**: z-image and boogu have nvfp4 variants that run close to twice as fast on Blackwell (z-image bf16 2.5s → nvfp4 1.2s). Install both and the picker merges them into one entry, with precision selectable in ⚙.

### 4.2 Instruction-based image editing

| Workflow | Main model → folder | Also needs |
|---|---|---|
| **Flux Kontext** | `flux1-dev-kontext_fp8_scaled.safetensors` → `diffusion_models/` | t5xxl · clip_l · ae |
| **Qwen-Image-Edit 2509** | `qwen_image_edit_2509_fp8_e4m3fn.safetensors` → `diffusion_models/` | qwen_2.5_vl_7b · qwen_image_vae |
| **OmniGen2** | `omnigen2_fp16.safetensors` → `diffusion_models/` | qwen_2.5_vl · ae |
| **InstructPix2Pix** | `instruct-pix2pix-00-22000.safetensors` → `checkpoints/` | self-contained |
| **boogu edit** | `boogu_image_edit_fp8_scaled.safetensors` (has `_nvfp4`) → `diffusion_models/` | qwen3vl_8b · flux1_vae_bf16 |
| **HiDream-E1.1** | `hidream_e1_1_fp8_e4m3fn.safetensors` → `diffusion_models/` | same as HiDream-I1 |
| **Bernini** (t2i / relight / 2-ref compose) | `wan2.2_bernini_r_high_noise_fp8_scaled.safetensors` + `_low_noise_` → `diffusion_models/` | umt5 · wan_2.1_vae<br>`loras/Bernini-R_LightX2V_high_noise` + `_low_noise` |

### 4.3 Video generation

| Workflow | Main model → `diffusion_models/` | Also needs |
|---|---|---|
| **Wan 2.2 14B** (t2v + i2v, auto-selected) | `wan2.2_t2v_high_noise_14B_fp8_scaled` + `_low_noise_`<br>`wan2.2_i2v_high_noise_14B_fp8_scaled` + `_low_noise_`<br>(**dual expert — four files**) | umt5 · wan2.2_vae<br>`loras/`: `wan2.2_t2v_lightx2v_4steps_lora_v1.1_high/low_noise`<br>`wan2.2_i2v_lightx2v_4steps_lora_v1_high/low_noise` |
| **Wan 2.2 TI2V-5B** | `wan2.2_ti2v_5B_fp16.safetensors` | umt5 · wan2.2_vae |
| **HunyuanVideo** | `hunyuan_video_t2v_720p_bf16.safetensors` | clip_l · llava_llama3 · hunyuan_video_vae_bf16 |
| **LTX-2.3** (dev / distilled) | `ltx-2.3-22b-dev-fp8.safetensors`<br>`ltx-2.3-22b-distilled-fp8.safetensors` → `checkpoints/` | LTX23_video_vae · LTX23_audio_vae · ltx-2.3_text_projection · taeltx2_3<br>`loras/`: `ltx-2.3-22b-distilled-lora-1.1_fro90_ceil72_condsafe` · `ltx-2.3-22b-distilled-lora-384` |
| **LTX Sulphur** | `sulphur_dev_fp8mixed.safetensors` → `checkpoints/`<br>`loras/sulphur_lora_rank_768.safetensors` | Same as LTX-2.3. ⚠️ **Do not stack the ltx-2.3 distill LoRA on it** — measured to produce garbage. Same-family checkpoint + LoRA are mutually exclusive (greyed out) in the UI. |
| **Bernini video** (v2v / rv2v) | `wan2.2_bernini_r_high_noise_fp8_scaled` + `_low_noise_` | umt5 · wan_2.1_vae · Bernini-R_LightX2V LoRAs |
| **MiniMax H3** (t2v / i2v / first-last-frame) | `minimax_h3_fl2va_pruned_int8_convrot.safetensors` (21 GB) | `text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors` (15.7 GB)<br>`vae/minimax_h3_video_vae_fp16.safetensors`<br>`vae/minimax_h3_audio_vae_fp32.safetensors`<br>**no custom node packs** |
| **MiniMax H3 r2v** (reference-driven) | `minimax_h3_ref2va_pruned_int8_convrot.safetensors` (21 GB) | Same three companions. A **separate weight file**, not a mode of the one above — install both to get both entries. |

**Two LTX add-ons** (on top of LTX-2.3 above):

| | Add | Node packs |
|---|---|---|
| **MSR V2** (2–5 reference images, identity preserved) | `loras/LTX-2.3-Licon-MSR-V2.safetensors` | ComfyUI-LTXVideo · ComfyUI-Licon-MSR · ComfyUI-PromptRelay · ComfyUI-KJNodes |
| **Union Control** (depth / structure transfer) | `loras/ltx-2.3-22b-ic-lora-union-control-ref0.5.safetensors` | MoGe model (auto-downloaded by `LoadMoGeModel`) |

**MiniMax H3** is an omni-modal model: text, images, video and audio in; video **with natively generated stereo audio** out (one latent, decoded twice — hence the second VAE). Weights live in [`Comfy-Org/MiniMax-H3`](https://huggingface.co/Comfy-Org/MiniMax-H3).

> ⚠️ **The repo is 343 GB — do not clone it.** Fetch the five files above by path (~60 GB total).
>
> ⚠️ **Skip the 34 GB `_int8_convrot` files.** `pruned_int8_convrot` is the *same* int8 tier: "pruned" only means the modulation weights (~40% of parameters) were replaced by an equivalent lookup table, with no quality change. The non-pruned build is 13 GB larger for nothing. `_bf16` (66.3 GB DiT + 51.5 GB text encoder) is the real quality tier, and needs a machine that can hold it.
>
> **Fixed properties, not settings**: 24 fps, and a frame count on a `17k+5` grid within the model's trained range of **124–362 frames (5.2–15.1 s)**. Hey-Koko pins both — the ⚙ fps field is hidden for H3 (fps reaches only the muxer, so changing it would re-time the picture while the generated soundtrack kept its own length) and the frame field advertises the real grid. There is also no CFG anywhere in the graph (`BasicGuider`, single conditioning), so that field is hidden too.
>
> **Sizing.** Measured on an RTX 5090 (32 GB) + 64 GB RAM: 864×480 × 124 frames took **57 s**, peaking at **34.1 / 34.2 GB VRAM (99.7%)** and **64.5 / 68.2 GB system RAM (94.5%)** — the smallest build has *no* headroom on a 32 GB card, and runs at all only because ComfyUI offloads to system RAM. Treat 864×480 as the working default there and raise resolution deliberately.
>
> **r2v specifics.** Up to 9 reference images, 3 reference videos (+ their soundtracks) and 3 reference audio files. The ⚙ *Reference detail* knob maps to `ref_image_size`: `match` fits each reference to the generation's pixel area, `max` allows a 2048px short edge for better identity fidelity — but reference tokens are re-read at **every** sampling step, so `max` can be several times slower. Both modes only ever scale **down**, so neither adds detail a small reference photo never had. A reference *video* is an exemplar (performance, camera, cutting rhythm), not poses copied frame by frame, and it is **trimmed to the length being generated** — attach a 20 s clip at the default 124 frames and only the first 5.2 s is seen.

### 4.4 Pose transfer

| Workflow | Main model → `diffusion_models/` | Also needs | Node packs |
|---|---|---|---|
| **Wan Animate** (Move / Replace) | `Wan2_2-Animate-14B_fp8_e4m3fn_scaled_KJ.safetensors` | umt5 · wan_2.1_vae · clip_vision_h<br>`loras/lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16`<br>`loras/WanAnimate_relight_lora_fp16` | KJNodes · segment-anything-2 · controlnet_aux · HKBox |
| **SCAIL-2** (animate / replace) | `wan2.1_14B_SCAIL_2_fp8_scaled.safetensors`<br>(`_mxfp8` and `_nvfp4_mxpf8_mix` also exist — **fp8 measured fastest**) | umt5 · Wan2_1_VAE_bf16 · clip_vision_h<br>**`checkpoints/sam3.1_multiplex_fp16.safetensors`**<br>`loras/wan2.1_SCAIL_2_DPO_lora_bf16`<br>`loras/lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16` | KJNodes · VideoHelperSuite |

> SCAIL-2's SAM3 weights go in **`checkpoints/`**, not where you would expect — easy to get wrong.
>
> ⚠️ **Do not install an fp8 SAM3** (e.g. `sam3.1_multiplex_fp8_e4m3fn`). The file loads, but `SAM3_VideoTrack` dies on first execution with `NotImplementedError: "addmm_cuda" not implemented for 'Float8_e4m3fn'` — PyTorch ships no fp8 addmm CUDA kernel, so there is no graph-side workaround. SAM3 is only ~10% of run time anyway. Hey-Koko now skips fp8 variants when resolving the checkpoint.
>
> The DPO LoRA is the paper's Bias-Aware DPO, which targets **finger articulation** specifically. The distill LoRA is lightx2v's general accelerator: it takes sampling from 40 steps at CFG 5 down to 6 steps at CFG 1 — roughly **10–12× faster**, and by far the largest single performance factor in the whole chain.

### 4.5 Audio-driven

| Workflow | Main model | Also needs | Node packs |
|---|---|---|---|
| **InfiniteTalk**<br>(re-dub a video / talking photo) | `diffusion_models/Wan2_1-I2V-14B-480p_fp8_e4m3fn_scaled_KJ.safetensors`<br>`diffusion_models/wan2.1_infiniteTalk_single_fp16.safetensors`<br>(`_multi_fp16` for multiple speakers) | **`models/wav2vec2/wav2vec2-chinese-base_fp16.safetensors`**<br>umt5 · Wan2_1_VAE_bf16 · clip_vision_h<br>`loras/lightx2v_I2V_14B_480p…` | WanVideoWrapper · KJNodes |
| **Wan-Dancer** (photo + music → dance) | `diffusion_models/wan2.2_dancer_14b_global_fp8_scaled.safetensors`<br>`diffusion_models/wan2.2_dancer_14b_local_fp8_scaled.safetensors`<br>(**both experts required**) | umt5 · wan_2.1_vae · clip_vision_h<br>`loras/lightx2v_I2V_14B_480p…` | all core |

### 4.6 3D

| Workflow | Models | Node packs |
|---|---|---|
| **Hunyuan3D 2.1** (image → mesh) | `checkpoints/hunyuan_3d_v2.1.safetensors`<br>or `diffusion_models/hunyuan3D-dit-v2-1-fp16.ckpt` + `vae/Hunyuan3D-vae-v2-1-fp16.ckpt` | KJNodes |
| ↳ **PBR texturing** (⚙ on by default) | plus the paint weights `hunyuan3d-paintpbr-v2-1` | **ComfyUI-Hunyuan3d-2-1** + **ComfyUI-Hunyuan3DWrapper** (requires compiling `custom_rasterizer`) |
| **TripoSplat** (image → Gaussian splat) | `diffusion_models/triposplat_fp16.safetensors`<br>`clip_vision/dino_v3_vit_h.safetensors`<br>`vae/triposplat_vae_decoder_fp16.safetensors`<br>`vae/flux2-vae.safetensors` | all core |
| **MoGe-2** (photo → textured GLB) | auto-downloaded by `LoadMoGeModel` | all core |

> **Background removal matters more than it looks.** Image-to-3D reconstructs everything it sees, so a photo with a real background becomes "the subject stuck on a flat slab". Hey-Koko has BiRefNet cutout + crop built in (measured: 7.5 MB slab → 0.7 MB clean object), with a ⚙ escape hatch when it cuts wrongly. It is **deliberately not applied to MoGe** — reconstructing the whole scene is that model's job.

### 4.7 Tools

| Workflow | Model → `upscale_models/` |
|---|---|
| **Image upscale / video enhance** | `4x-UltraSharp.pth`, `RealESRGAN_x4plus.pth` |
| **360° panorama** (text→pano / image→pano) | `loras/equirectangular_flux_lora_v3_000003072.safetensors`<br>⚠️ This LoRA **only helps pure text→panorama** — for image→panorama the projected base already makes the poles converge. |

---

## 5. Minimal working subset

If you would rather not install everything at once, in order of increasing dependency cost:

1. **Images only** → Z-Image Turbo (`z_image_turbo` + `qwen_3_4b` + `ae`). Three files, zero custom nodes.
2. **Add image editing** → Qwen-Image-Edit 2509 (reuses `qwen_2.5_vl_7b` + `qwen_image_vae`).
3. **Add video** → Wan 2.2 14B (four expert files + four LoRAs + `umt5` + `wan2.2_vae`). Still zero custom nodes.
4. **Add pose transfer** → SCAIL-2. This is the first step that needs custom nodes (KJNodes + VideoHelperSuite).
5. **Everything else as needed.**

MiniMax H3 sits outside that ladder: it needs **no custom nodes at all**, but it is a ~60 GB download and wants ComfyUI ≥ 0.30.0 and a large amount of system RAM to offload into. It generates a soundtrack (as LTX-2.3 does) but is the only one that takes reference images, video **and** audio together, so add it for that combination rather than as a general-purpose video model.

---

## 6. Maintenance

A workflow's verified status lives in exactly one place: **`isModelReady(name, group, type)`** in `server/comfy.js`. It is an **allowlist** — anything it does not match is treated as not ready (greyed out with a ⚠️ warning in the model picker, but still selectable so it can be tested and then promoted).

When a new model passes verification: add it to the `READY` list in `isModelReady()` and update this file to match.
