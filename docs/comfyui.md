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
| **Image → 3D model** | Attach an image + `/imagine` (prompt optional) | Hunyuan3D 2.1, TripoSplat, MoGe-2 |

Each model family ships with sane sampling defaults (Flux guidance distillation, InstructPix2Pix dual-CFG, WAN's standard negative prompt, the LTX audio+video pipeline, etc.).

- **WAN 2.2 14B** is a two-expert (high-noise + low-noise) model — Hey-Koko chains both experts automatically and collapses the pair into a single dropdown entry. With the **LightX2V 4-step LoRAs** installed it auto-switches to the fast 4-step / cfg-1 path (~6–10× faster).
- **LTX-2.3** generates synchronized **audio**, muxed into the output MP4.

## 3D generation

Three image-to-3D chains appear in the **3D models** dropdown group once their weights are installed. All are image-driven (the prompt is ignored); results show as an interactive in-chat 3D viewer (drag to orbit, wheel to zoom, double-click for fullscreen — with a toolbar and shortcuts: R reset, Space auto-rotate, +/− zoom, arrows turn) plus a download button.

| Model | Output | Weights (→ ComfyUI `models/` subfolder) |
|-------|--------|------------------------------------------|
| **Hunyuan3D 2.1** | Untextured mesh (`.glb`) | `checkpoints/hunyuan_3d_v2.1.safetensors` (~4.9 GB) — [Comfy-Org/hunyuan3D_2.1_repackaged](https://huggingface.co/Comfy-Org/hunyuan3D_2.1_repackaged) |
| **TripoSplat** | Gaussian splat (`.spz`) — or a **coloured mesh** (`.glb`, see below) — plus a turntable preview video | `diffusion_models/triposplat_fp16.safetensors`, `clip_vision/dino_v3_vit_h.safetensors`, `vae/triposplat_vae_decoder_fp16.safetensors`, `vae/flux2-vae.safetensors` — [VAST-AI/TripoSplat](https://huggingface.co/VAST-AI/TripoSplat); optional `background_removal/birefnet.safetensors` — [Comfy-Org/BiRefNet](https://huggingface.co/Comfy-Org/BiRefNet) (without it the input image's own alpha is used as the subject mask) |
| **MoGe-2** | Textured scene mesh (`.glb`, geometry estimation — fast) | `geometry_estimation/moge_2_vitl_normal_fp16.safetensors` (~1.3 GB) — [Comfy-Org/MoGe](https://huggingface.co/Comfy-Org/MoGe) |

**Colour:** ComfyUI's native nodes ship Hunyuan3D's *shape* model only — its texture-painting model isn't included, so Hunyuan3D meshes are always white. For a **coloured** 3D file, tick ⚙ *Coloured mesh instead of splat file* on TripoSplat: its splat is meshed with vertex colours and exported as a `.glb` you can spin in the chat (bigger file, slightly softer surface than the splat it came from). MoGe bakes the source photo as a real texture, but only reconstructs the side the camera can see — it is a single-view relief, not a closed object.

The ⚙ popup exposes: *3D mesh detail* (grid resolution — Hunyuan3D's octree and TripoSplat's meshing grid), *3D splat count* (TripoSplat), *3D detail level* (MoGe), and the coloured-mesh toggle; Hunyuan3D and TripoSplat also honour the sampler/steps/CFG/seed fields. `.spz` splats are download-only (drop them into a splat viewer or game engine); `.glb` files open right in the chat.

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
