# ComfyUI — Advanced Image & Video Generation

Image generation works out of the box with local **Ollama image models** (e.g. `x/flux2-klein:9b`). For high-end text-to-image, instruction-based editing, multi-image composition, and **video**, you can optionally connect a local [ComfyUI](https://github.com/comfyanonymous/ComfyUI) server — all driven from the same `/imagine` command. ComfyUI builds the workflow graphs automatically; you only pick a model. **This is entirely optional**; without it, `/imagine` still generates images via Ollama.

> **Tested hardware:** the ComfyUI workflows (and the VRAM-aware video segment limits) were developed and tested on an **NVIDIA RTX 5090 (32 GB)**. They should work on other CUDA GPUs, but on cards with less VRAM you may need to lower the resolution or video length to avoid out-of-memory errors.

## Setup

1. Install and launch ComfyUI (cross-platform — on Windows the portable build or a manual install both work; see the [ComfyUI repo](https://github.com/comfyanonymous/ComfyUI)), then download the model files you want into its `models/` folders (`checkpoints/`, `diffusion_models/`, `text_encoders/`, `vae/`, `loras/`).
2. In Hey-Koko's **Settings → Model** tab, leave the **Ollama image model** dropdown empty (`Leave empty (use ComfyUI)`).
3. Set the ComfyUI address: click the ✎ next to the ComfyUI URL to enter `host:port` manually, or use the **scan** button to auto-discover ComfyUI on your local network (probes `:8188`). Default is `127.0.0.1:8188` (also configurable via the `COMFYUI_URL` environment variable).
4. Pick a model from the ComfyUI dropdown — it is grouped into **text-to-image**, **instruction edit** (needs a reference image), **video**, and **video editing** (needs a source video).

Hey-Koko reads the model list live from ComfyUI's `/object_info` and auto-selects the required companion files (text encoders, VAEs), so it tells you exactly which file is missing if one isn't installed.

## Capabilities

| Mode | How to use | Models (auto-detected by filename) |
|------|-----------|-----------------------------------|
| **Text-to-image** | `/imagine <prompt>` | Flux, SDXL / Pony / Illustrious, SD3, HiDream-I1, Z-Image-Turbo |
| **Image-to-image** | Attach an image + `/imagine <prompt>` | Any checkpoint (VAE-encode + partial denoise) |
| **Instruction edit** | Attach an image + `/imagine <edit instruction>` | FLUX.1 Kontext, Qwen-Image-Edit, InstructPix2Pix, OmniGen2, HiDream-E1.1 |
| **Multi-image composition** | Attach 2–3 images + `/imagine <how to combine>` | Qwen-Image-Edit-2509 Plus |
| **Text-to-video** | `/imagine <prompt>` | WAN 2.2 (5B / 14B), Hunyuan Video, LTX-2.3 |
| **Image-to-video** | Attach an image + `/imagine <prompt>` | WAN 2.2 (5B ti2v / 14B i2v), LTX-2.3 |
| **Video editing** | Attach a source video + `/imagine <prompt>` | WAN 2.2 (Bernini v2v/rv2v), WAN 2.2 Animate (pose transfer) |
| **Image → 3D model** | Attach an image + `/imagine` (prompt optional) | Hunyuan3D 2.1, TripoSplat, MoGe-2, MoGe-2 panorama |

Each model family ships with sane sampling defaults (Flux guidance distillation, InstructPix2Pix dual-CFG, WAN's standard negative prompt, the LTX audio+video pipeline, etc.).

- **WAN 2.2 14B** is a two-expert (high-noise + low-noise) model — Hey-Koko chains both experts automatically and collapses the pair into a single dropdown entry. With the **LightX2V 4-step LoRAs** installed it auto-switches to the fast 4-step / cfg-1 path (~6–10× faster).
- **LTX-2.3** generates synchronized **audio**, muxed into the output MP4.

## 3D generation

Three image-to-3D chains appear in the **3D models** dropdown group once their weights are installed. All are image-driven (the prompt is ignored); results show as an interactive in-chat 3D viewer (drag to orbit, wheel to zoom, double-click for fullscreen — with a toolbar and shortcuts: R reset, Space auto-rotate, +/− zoom, arrows turn) plus a download button.

| Model | Output | Weights (→ ComfyUI `models/` subfolder) |
|-------|--------|------------------------------------------|
| **Hunyuan3D 2.1** | Untextured mesh (`.glb`) | `checkpoints/hunyuan_3d_v2.1.safetensors` (~4.9 GB) — [Comfy-Org/hunyuan3D_2.1_repackaged](https://huggingface.co/Comfy-Org/hunyuan3D_2.1_repackaged) |
| **TripoSplat** | Coloured mesh (`.glb`) — vertex colours, no texturing add-on needed | `diffusion_models/triposplat_fp16.safetensors`, `clip_vision/dino_v3_vit_h.safetensors`, `vae/triposplat_vae_decoder_fp16.safetensors`, `vae/flux2-vae.safetensors` — [VAST-AI/TripoSplat](https://huggingface.co/VAST-AI/TripoSplat); optional `background_removal/birefnet.safetensors` — [Comfy-Org/BiRefNet](https://huggingface.co/Comfy-Org/BiRefNet) (without it the input image's own alpha is used as the subject mask) |
| **MoGe-2** | Textured scene mesh (`.glb`, geometry estimation — fast) | `geometry_estimation/moge_2_vitl_normal_fp16.safetensors` (~1.3 GB) — [Comfy-Org/MoGe](https://huggingface.co/Comfy-Org/MoGe) |
| **MoGe-2 (360° panorama)** | The whole place as one spherical mesh you view from inside — equirectangular 2:1 input, same weights as MoGe-2 | same as MoGe-2 |

**Photos are cut out first.** Image-to-3D reconstructs whatever it is shown, so a photo with a real background comes back as a large flat slab with the subject as a bump on it. Hunyuan3D therefore removes the background (BiRefNet), places the subject on white and crops to it before conditioning — which also sharpens the result, since a subject filling a quarter of the frame decodes with a broken, noisy surface. ⚙ *Keep photo background* opts out if the automatic cut-out ever grabs the wrong thing. TripoSplat does its own equivalent; MoGe deliberately keeps the whole scene, because that is its job — ⚙ *Subject only* (or a painted mask) switches it to the cut-out behaviour when you want just the object. Painting a mask with the brush tells any of these chains which part of the photo is the subject and replaces the automatic cut-out entirely.

**Sweep panoramas (phone "Panorama" mode).** These are *cylindrical strips*, not equirectangular: wide, vertically only as tall as the lens (~60–70°), with no zenith or nadir. Send them to **MoGe-2**, not MoGe-2 (360°) — the 360° chain maps any image onto the full sphere and would stretch a 65° band to 180°. MoGe fits a pinhole camera, which cannot hold a sweep, so a wide one comes back compressed: measured on a 216°-wide band, the automatic solve settled on a 105° cone. ⚙ *Source field of view* overrides that, but it is a nudge and not a repair — on the same band, 120 opened the cone to 121° and still held together, 150 tore the reconstruction apart, and 170 blew the depth range from 18× to 159×. Leave it empty for ordinary photos.

**Text → a 360° panorama.** The model entry **360° panorama (text → equirect)** writes an equirectangular image you can then run through MoGe-2 (360°). It is a recipe rather than a checkpoint: it generates at a forced 2:1 with whichever base you pick in ⚙ *Panorama base model*, then *repairs the wrap seam*, which is the one thing an ordinary model gets wrong. Eligible bases are the plain txt2img checkpoints plus the UNET families whose stack this graph knows (z-image, boogu); Auto prefers a panorama-tuned name if you have one, then Flux. The graph follows the family — an SDXL pick gets a plain latent, real CFG and no guidance node; a distilled one gets cfg 1 and a zeroed negative. Measured as the left/right edge mismatch divided by what two genuinely adjacent columns differ by (1.00 = a perfect wrap): z-image 3.82, Flux 1.99, and on one prompt as bad as 39.3 — plausible pictures whose ends simply do not meet. After the repair: 0.92–1.15 across Flux, SDXL and z-image alike, i.e. indistinguishable from any other pair of neighbouring columns, and better than a real stitched photo (3.39). The repair levels the bases out — z-image starts worst and finishes as good as Flux, at two-thirds the time. The repair rolls the image half a turn so the join sits in the middle, regenerates a band across it, composites that back through a feathered mask and rolls back; ⚙ turns it off. The prompt is prefixed with an equirectangular cue unless you already wrote one — without it the model just paints an ordinary photo at 2:1.

Poles are still the weak spot: nothing here teaches the model what the zenith and nadir of an equirect look like, so looking straight down in the resulting mesh shows a vortex where a real panorama shows the ground. A panorama LoRA would fix both at once; this fixes the seam with what is already installed.

**Viewing a scene reconstruction.** MoGe-2's whole-scene output is a *window*: the camera sits at the origin and everything it saw is in front of it (measured on one photo, z spans −117…−4). Orbiting that from outside shows an unrecognisable shard, so the viewer stands at the camera and looks out, exactly as it does for a panorama — the only difference is that it will not turn past the edge of what was captured. The turn limit comes from the geometry itself (the cone of directions that actually carry surface) and tightens as you zoom out, since a wider lens reaches the edge sooner. A *cut-out subject* (painted mask or ⚙ *Subject only*) is not a scene, so it keeps the orbit camera.

This also gives you **text → a place you can look around in**, with no extra models: `/imagine` a wide-angle scene, then run that image through MoGe-2. Measured on one generated courtyard, the result covers 103° × 86°. It is a single viewpoint — you can look, not walk — and a pinhole projection cannot reach a full 180°, so a true half-dome needs a real panorama instead.

**Viewing a 360° panorama.** A panorama mesh is a shell built outwards from where the photo was taken, so the viewer stands *at that point and looks out* rather than orbiting it from outside — orbiting only ever shows the half of the world facing you, with the ground hidden behind its own back. Drag to look around, wheel to change the field of view; there is nowhere to back out to. The equirect's wrap seam is stitched closed on load, so the join between the image's left and right edges is not a slit through the world.

**Sharpness of the 360 view.** Standing inside means magnifying the photo hard: one full turn is spread across the view, so a 1774 px equirect shows a 40° slice at about 4.5× enlargement, and that is what makes it look soft — nothing in the chain loses those pixels, there simply are not enough of them. ⚙ *Sharpen the 360 view* runs the photo through a 4× upscale model first and lands it on 2560 / 3584 / 4096 px. Measured on one panorama the enlargement drops to 3.1× / 2.2× / 1.9× and on-screen sharpness nearly doubles at 3584. The mesh keeps the same triangle count either way — MoGe's grid is *input width ÷ decimation*, so the stride is raised in step, otherwise the extra pixels would quietly multiply the triangles too (at 4096 unchecked: 98 k → 524 k vertices, 6.6 → 34.9 MB). The file still grows with the texture: roughly 1.3× / 2× / 2.7×. Needs an upscale model in `models/upscale_models/` (e.g. 4x-UltraSharp or RealESRGAN_x4plus); without one the setting is simply not offered.

**Colour:** ComfyUI's native nodes ship Hunyuan3D's *shape* model only — its texture-painting model isn't included, so Hunyuan3D meshes are always white. For a **coloured** 3D file, use TripoSplat: its splat is meshed with vertex colours and exported as a `.glb` you can spin in the chat (slightly softer surface than the splat it came from). MoGe bakes the source photo as a real texture, but only reconstructs the side the camera can see — it is a single-view relief, not a closed object.

The ⚙ popup exposes: *3D mesh detail* (grid resolution — Hunyuan3D's octree and TripoSplat's meshing grid), *3D shape detail budget* and *Texture the 3D model* + *Texture quality* (Hunyuan3D), *3D splat count* (TripoSplat), *3D detail level*, *Subject only* and *Source field of view* (MoGe), *Sharpen the 360 view* (panorama), and the keep-background toggle; Hunyuan3D and TripoSplat also honour the sampler/steps/CFG/seed fields. Every chain returns a `.glb`, which opens right in the chat. Painting a mask with the brush tells all three chains which part of the photo is the subject, replacing the automatic background removal.

## `/imagine` flags

The basic ones also work with Ollama image models:

| Flag | Effect |
|------|--------|
| `--size WxH` | Explicit output size (e.g. `--size 832x480`), or presets `480p`/`720p`/`1080p` (`-portrait` for vertical). For image-to-video the aspect ratio follows the input image. |
| `--steps N` | Sampling steps |
| `--seed N` | Fixed seed (reproducible) |
| `--enhance` / `-e` | Rewrite the prompt with an LLM first — image-oriented for images, motion/camera-oriented for video. The improved prompt is shown before generation. |
| `--no <text>` | Negative prompt |
| `4x <prompt>` | Batch (generate N images) |

Sampler, scheduler, CFG, guidance, image-CFG, denoise, video length, and FPS can be overridden in the **⚙ Advanced generation params** popup (next to the ComfyUI model dropdown). `/imagine` flags take precedence over the popup, which takes precedence over the per-model defaults.

While ComfyUI generates, Hey-Koko shows a progress bar and, when ComfyUI is launched with a preview method (`--preview-method auto`), live preview frames decoded during sampling — both in the chat and the [background jobs](../README.md#background-jobs) drawer. Generated videos are click-to-play (with audio) and each has a download button.
