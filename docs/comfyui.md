# ComfyUI — Advanced Image & Video Generation

Image generation works out of the box with local **Ollama image models** (e.g. `x/flux2-klein:9b`). For high-end text-to-image, instruction-based editing, multi-image composition, and **video**, you can optionally connect a local [ComfyUI](https://github.com/comfyanonymous/ComfyUI) server — all driven from the same `/imagine` command. ComfyUI builds the workflow graphs automatically; you only pick a model. **This is entirely optional**; without it, `/imagine` still generates images via Ollama.

> **Tested hardware:** the ComfyUI workflows (and the VRAM-aware video segment limits) were developed and tested on an **NVIDIA RTX 5090 (32 GB)**. They should work on other CUDA GPUs, but on cards with less VRAM you may need to lower the resolution or video length to avoid out-of-memory errors.

## Setup

1. Install and launch ComfyUI (cross-platform — on Windows the portable build or a manual install both work; see the [ComfyUI repo](https://github.com/comfyanonymous/ComfyUI)), then download the model files you want into its `models/` folders (`checkpoints/`, `diffusion_models/`, `text_encoders/`, `vae/`, `loras/`).
2. In Hey-Koko's **Settings → Model** tab, leave the **Ollama image model** dropdown empty (`Leave empty (use ComfyUI)`).
3. Set the ComfyUI address: click the ✎ next to the ComfyUI URL to enter `host:port` manually, or use the **scan** button to auto-discover ComfyUI on your local network (probes `:8188`). Default is `127.0.0.1:8188` (also configurable via the `COMFYUI_URL` environment variable).
4. Pick a model from the ComfyUI dropdown — it is grouped into **text-to-image**, **instruction edit** (needs a reference image), **video**, and **video editing** (needs a source video).

Hey-Koko reads the model list live from ComfyUI's `/object_info` and auto-selects the required companion files (text encoders, VAEs), so it tells you exactly which file is missing if one isn't installed.

> Setting up a **blank** ComfyUI? [docs/comfyui-setup.md](comfyui-setup.md) lists every custom-node pack and model file the verified workflows need, grouped per workflow, with a minimal-subset path if you don't want to install all of it at once.

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

**Upscaling a finished clip.** Generation and upscaling are deliberately separate steps: generate at 720p, then attach the result to the **Video upscale + sharpen** entry and run it again. ⚙ *Upscale to* names the **long side** (1920 / 2560 / 3840), so a portrait clip gets in height what a landscape one gets in width, and Auto simply doubles the source with the long side capped at 2160.

The cost is *not* smooth across that list, which is the one thing worth knowing before you pick. The upscaler used is the smallest installed model that **reaches** the target, so:

| Target vs. source | Model loaded | Measured |
|---|---|---|
| below 2.5× | a 2× model, result resampled up to the target | 321 ms/frame |
| 2.5× and above | a 4× model, result scaled back down | 1236 ms/frame |

The boundary is 2.5 because the ratio is *rounded* to pick the model, not truncated — it is a
consequence of that rounding, not a measured quality threshold. Between 2× and 2.5× the 2× model
cannot quite reach the target and ordinary resampling covers the gap: at 2.03× (a 710p source at
1440p) that gap is 1.3% and invisible; at 2.4× it is 20% and the result will look a little soft.

A 720p source at 1440p is exactly 2× and takes the cheap path; the same source at 4K is 3×, so a 4× model runs and roughly 57% of the pixels it computes are thrown away in the downscale — about four times the time per frame for the same clip. If you want 4K without that jump, start from something nearer 1080p. The cheap path only exists if a 2× model is actually installed (e.g. `RealESRGAN_x2plus`); with only 4× models on disk, every target runs the 4× one. A target the source already meets skips the AI pass entirely and just resamples.

**Outlining the subject in a reference photo.** On the models that read an attachment as a *reference* — LTX-2.3 MSR, Phantom, SCAIL-2, WAN Animate, Wan-Dancer, MiniMax H3 (r2v), Bernini's subject→image and its video-edit entry — every staged image carries its own 🖌 button, and the mask painted there means the opposite of inpainting: it says **which part of the photo is the subject**, and only that part is sent. Everything outside the outline becomes flat white and the frame is cropped to the outline, so a person standing in a busy room arrives as just that person. This matters for the same reason it does in the 3D chains: the reference is encoded at a fixed size, so a subject filling a tenth of the photo otherwise spends a tenth of the reference on identity and the rest on a room the model was never asked about. The brush's 🪄 point-select and 🔍 find-by-word both work here, so isolating a person is usually one click.

The models whose attachment becomes a real *frame* deliberately have no such button — plain image-to-video, first/last-frame, LTX Union Control and InfiniteTalk's "photo speaks" all put the picture **into** the clip, where a cut-out would simply give you a white background on screen. Bernini is the one entry that is both: with a source video attached its images are references and the button appears, without one the image is frame 0 and it does not. The originals are never altered — the cut-out is baked at generation time, so clearing the mask and resending goes back to the whole photo.

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

**Where the files land.** Under ComfyUI's own `output/`, one folder per kind of result, each file named after the model that made it:

| | |
|---|---|
| `heykoko_img/` | stills — generation, instruction edits, upscale |
| `heykoko_vid/` | video, every family |
| `heykoko_3d/` | `.glb` models |
| `heykoko_pano/` | equirectangular 360° stills |
| `heykoko_tmp/` | working files that are not results (auto-mask previews) |

So a Flux render is `heykoko_img/flux1-dev-fp8_00001_.png` and a Qwen edit is `heykoko_img/qwen_image_edit_2509_fp8_00001_.png`, each with its own counter. The prefix is stamped centrally just before the graph is queued rather than written into each builder, which is why it stays consistent as models are added. The app downloads what it needs into the conversation, so these files are only for finding a result again on the render machine.

**Text → a 360° panorama.** The model entry **360° panorama (text or photo → equirect)** writes an equirectangular image you can then run through MoGe-2 (360°). It is a recipe rather than a checkpoint: it generates at a forced 2:1 with whichever base you pick in ⚙ *Panorama base model*, then *repairs the wrap seam*, which is the one thing an ordinary model gets wrong. Eligible bases are the plain txt2img checkpoints plus the UNET families whose stack this graph knows (z-image, boogu); Auto prefers a panorama-tuned name if you have one, then Flux. The graph follows the family — an SDXL pick gets a plain latent, real CFG and no guidance node; a distilled one gets cfg 1 and a zeroed negative. Measured as the left/right edge mismatch divided by what two genuinely adjacent columns differ by (1.00 = a perfect wrap): z-image 3.82, Flux 1.99, and on one prompt as bad as 39.3 — plausible pictures whose ends simply do not meet. After the repair: 0.92–1.15 across Flux, SDXL and z-image alike, i.e. indistinguishable from any other pair of neighbouring columns, and better than a real stitched photo (3.39). The repair levels the bases out — z-image starts worst and finishes as good as Flux, at two-thirds the time. The repair rolls the image half a turn so the join sits in the middle, regenerates a band across it, composites that back through a feathered mask and rolls back; ⚙ turns it off. The prompt is prefixed with an equirectangular cue unless you already wrote one — without it the model just paints an ordinary photo at 2:1.

**A photo → a 360° panorama.** Attach a photo to that same entry and the panorama is grown *around* it instead of from nothing. The photo is first reprojected onto the sphere in the browser — a flat photo and a panorama are different projections, so pasting it into a 2:1 canvas would leave it visibly bent when you stand inside the result; measured against a view cut out of a real panorama, the reprojection lands back where it came from to 2.5/255 while a flat paste is 21.5. Everything the photo does not cover is then invented, and the seam repair runs as before.

Three ⚙ settings control the photo side. *Attached photo is a…* says what kind of picture it is; Auto reads the frame's shape — much wider than tall is treated as a phone sweep, an exact 2:1 as a panorama already, anything else as a normal photo. A phone's Panoramas mode is **not** equirectangular: it sweeps a cylinder, linear in longitude but still perspective vertically, so it needs the sweep setting to map correctly. *Photo covers (°)* is how much of the turn it spans, estimated from the frame when left empty (75° for a normal photo; for a sweep, from its width against a phone's own ~63° upright view — on a strip built at 200°, the estimate came back 200°). *Reinvent around the photo* is how freely the rest is painted.

That last one matters more than it looks. The unknown part of the sphere is seeded by smearing the photo's own edges outwards, and this setting says how much of that seed to overwrite. At 1.00 the seed is discarded entirely and a plain checkpoint — which has no inpainting channels — paints from noise alone: you get a perfectly good panorama with your photo sitting on it like a sticker, the step across its border measuring 16.9/255. At 0.85 the sky, ground and palette continue and the step is 3.5. Too low and the smear survives unresolved; 0.70 left it almost untouched. Your photo's own pixels are composited back at the end either way, so they come through the round trip unchanged (measured drift 0.00/255).

Choosing *Already a 360° panorama* has nothing to invent, so it becomes a way to repair the wrap seam of a panorama you already have.

**The poles, and the LoRA that fixes them.** The seam repair cannot reach the zenith and nadir, and nothing else in the chain knows what they should look like — in an equirectangular image the whole top row is a *single point in space*, so it has to be nearly constant, and a plain checkpoint has no idea. Measured at a fixed seed, a text-generated panorama's top row varied as much as its horizon (ratio 1.07, and 1.50 at the nadir); a real photographed panorama scores 0.09 and 0.16. That gap is the vortex you see looking straight down in the finished mesh.

An equirectangular LoRA closes it: the same prompt and seed with one applied scored 0.05 and 0.31. Drop any panorama LoRA into ComfyUI's `models/loras/` and ⚙ *Panorama LoRA* picks it up on its own — the one tested is [Flux-LoRA-Equirectangular-v3](https://huggingface.co/MultiTrickFox/Flux-LoRA-Equirectangular-v3), whose trigger phrase happens to be exactly the cue this recipe already prepends. LoRAs are trained for a single base family and every panorama one available today is for Flux, so choosing another base drops it and says so on the done line rather than loading it with nothing matching.

It is applied automatically **only for text**. With a photo attached the poles are already right without it — the pre-fill smears the photo's edges outwards and that construction converges at the poles by itself (measured 0.01 and 0.07, tighter than the real panorama) — so the LoRA has no pole left to fix and its flatten-towards-the-poles prior costs ground texture instead: the bottom quarter's detail fell from 0.70 to 0.24 at full strength. Pick it by hand if you want it there anyway.

Without such a LoRA installed, the poles remain the weak spot: the seam is repaired, but looking straight down in the resulting mesh shows a vortex where a real panorama shows the ground.

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
| `--size WxH` | Explicit output size (e.g. `--size 832x480`), or presets `480p`/`720p`/`1080p` (`-portrait` for vertical), `2k`/`4k`, and `ultrawide` / `ultrawide-small` (1792×768 and 896×384 — 21:9 reduces to 7:3, so those are the ratio exactly, and both sides divide by 64, the strictest alignment any builder needs; the small one is a quarter of the pixels for quick drafts, and its 384px side is below most checkpoints' training resolution, so it looks rougher). For image-to-video the aspect ratio follows the input image. |
| `-m` / `--model <id>` | Pick the ComfyUI model for this run, overriding the dropdown without changing it. Takes a **canonical model id** — lowercase, no precision (`wan2.2-14b`, `phantom-1.3b`, `ltx2.3-22b`); a `:` suffix names a *mode* that shares the same weights (`bernini:insert`, `scail2-14b:animate`, `wan-animate-14b:replace`). Typing `-m ` in the message box pops a completion list. An ambiguous prefix is refused rather than guessed. Append `@tier` to pin a quantisation for this run (`-m zimage-turbo@nvfp4`); only tiers actually installed are accepted. Choosing a video model this way makes the run a video run, whatever the dropdown says. |
| `-s` / `--second N` | Video length as a **duration** in seconds (e.g. `-s 10`) instead of a frame count. Converted using the rate the chosen model actually runs at, then snapped onto that model's frame grid, so the result lands within a fraction of a second of what was asked for. On the source-driven builders (Bernini, Wan Animate, SCAIL-2, InfiniteTalk dubbing, LTX Union) it is measured against the **source clip's** rate and still capped by the source's own length — so `-s 5` on a 20-second clip processes the first 5 seconds. Overrides the ⚙ video-length field; ignored by image models. |
| `--steps N` | Sampling steps |
| `--seed N` | Fixed seed (reproducible) |
| `--enhance` / `-e` | Rewrite the prompt with an LLM first — image-oriented for images, motion/camera-oriented for video. The improved prompt is shown before generation. |
| `--no <text>` | Negative prompt |
| `4x <prompt>` | Batch (generate N images) |

### Model ids

Every model has one canonical id: lowercase, carrying the family, version and (where upstream
publishes one) the parameter count — but never the quantisation. `fp8` / `mxfp8` / `nvfp4` /
`int8` / `bf16` are properties of the *build*, not of the model, so they live in the ⚙ precision
setting and the `@tier` qualifier instead. Downloading another build of a model therefore never
changes its id, which is what lets the gallery group a model's output across builds and lets a
saved choice keep resolving.

A `:` separates a **mode** — the same weights driven by a different workflow. So the model behind
any id is everything before the `:`, and asking the gallery for `bernini` returns all five of its
modes at once.

Sampler, scheduler, CFG, guidance, image-CFG, denoise, video length, and FPS can be overridden in the **⚙ Advanced generation params** popup (next to the ComfyUI model dropdown). `/imagine` flags take precedence over the popup, which takes precedence over the per-model defaults.

While ComfyUI generates, Hey-Koko shows a progress bar and, when ComfyUI is launched with a preview method (`--preview-method auto`), live preview frames decoded during sampling — both in the chat and the [background jobs](../README.md#background-jobs) drawer. Generated videos are click-to-play (with audio) and each has a download button.
