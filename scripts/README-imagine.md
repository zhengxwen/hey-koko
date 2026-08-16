# imagine.js — terminal `/imagine`

A standalone CLI over the running hey-koko server, so other programs can drive batch
generation without a browser. This file is self-contained: everything needed to call the
tool is here.

```bash
node scripts/imagine.js -m minimax-h3-r2v -i ref.png -s 6 -O out/ "a zebra finch conducts an orchestra"
```

Every recipe decision — companion files, sizing, frame-grid snapping, precision swap,
gallery filing — stays server-side, exactly as it is for the UI. This script adds no
model knowledge of its own; it resolves a model id, POSTs `/api/generate-comfy`, and
writes what comes back.

**Requirements:** Node ≥ 18, no packages. The hey-koko server must be running, and (for
generation) it must be able to reach a ComfyUI instance. `--add` needs neither a GPU nor
ComfyUI.

## How it finds ComfyUI

Two hops. The CLI never talks to ComfyUI directly:

```
imagine.js  ──HTTP──▶  hey-koko server  ──▶  ComfyUI
             default                     server/config.js → comfyUrl
             127.0.0.1:1314
```

1. **Finding the hey-koko server** — `$HEYKOKO_URL`, else `127.0.0.1:$HEYKOKO_PORT`
   (port default 1314). Override per run with `--server http://mac.local:1314`.
   **The server has to be running** (`npm start`, or the app open).
2. **Finding ComfyUI** — the server decides, using the address set in the app's settings
   (`config.comfyUrl`, or the `COMFYUI_URL` environment variable at startup).
3. **Targeting a different box for one run** — `--comfy-url http://192.168.1.25:8188`.
   That one flag covers all three steps (model scan, source upload, render) without
   touching the saved setting.

If ComfyUI is unreachable, the model list comes back nearly empty and `-m` will say so
rather than guessing.

## Nothing is inherited from the app — except the ComfyUI address

**The ⚙ settings panel in the browser has no effect on this CLI.** Those values live in
the browser's localStorage; the server only ever sees them because the page puts them in
its request. A CLI cannot read them and does not try.

So an option you don't pass is **not** "whatever the app is set to" — it falls back to
the **server-side preset for that model** (`videoPreset` / `familyPreset` /
`resolveConfig` in `server/comfy.js`), which is the same value the app itself uses when
its ⚙ field is empty or on "auto". For MiniMax H3 that is 864×480, 124 frames, 24 fps,
20 steps, `res_multistep` + `simple`, precision auto.

| | lives in | inherited? |
| --- | --- | --- |
| ⚙ size / duration / frames / precision / sharpen / timeout / LoRA … | browser localStorage | ✗ — falls back to the model preset |
| ⚙ prompt decoration (prefix/suffix) | browser localStorage | ✗ — the prompt is sent verbatim |
| the app's default image size | browser localStorage | ✗ — width/height are left unset for the model to choose |
| **the ComfyUI address** | the server process | ✅ **shared** |

That last row is the one exception: the address the app is pointed at is pushed to the
server and held there, so the CLI renders on whichever box the app is currently using.
It is **not** written to disk — a server restart resets it to `COMFYUI_URL` (or the
default) until a browser connects and pushes the setting again. Use `--comfy-url` when a
run must go to a specific machine regardless.

Two CLI defaults differ from the app's on purpose: the render timeout is 4 h (what the
app's empty timeout field means), and results are **not** filed in the gallery (the app
always files them) — see [Output](#output).

`--dry-run` shows exactly what is sent; anything missing from its `options` is filled in
by the server from the model preset:

```bash
node scripts/imagine.js -m minimax-h3-r2v -i ref.png --dry-run "…"
# "options": {}   ← nothing specified, so the model's own defaults apply
```

## Basic use

```bash
# What models are installed — the printed id is what -m takes
node scripts/imagine.js --list-models
node scripts/imagine.js --list-models minimax

# One reference-driven video
node scripts/imagine.js -m minimax-h3-r2v -i ref.png -s 6 -O out/ "a bird conducts an orchestra"

# Several references (r2v takes up to 9 images) plus a reference clip and voice
node scripts/imagine.js -m minimax-h3-r2v -i a.jpg -i b.jpg --video motion.mp4 --audio voice.wav -s 8 "…"

# Feed a literal /imagine line — same syntax as in chat
node scripts/imagine.js --cmd "/imagine 2x -m minimax-h3-r2v --size 720p --seed 7 a bird dances --no blurry" -i ref.png
```

## Model selection

`-m` takes a **canonical model id** (`server/model-names.js`), not a filename — stable
across installed quantisations. Matching is exact → prefix → substring, and an ambiguous
token is **refused, never narrowed**: picking for you is how a batch renders the wrong
model for an hour.

```
-m minimax-h3-r2v         exact
-m minimax-h3-r            prefix — fine, only one match
-m minimax                 refused: "minimax-h3-t2v, minimax-h3-r2v"
-m minimax-h3-r2v@int8     pick the int8 build (--list-models shows what is installed)
-m minimax-h3-r2v@bf16     refused: "has no bf16 build installed (has: fp8, int8)"
```

## Batch

`--batch <file>` runs one task per line. Two line formats, freely mixed; `#` comments and
blank lines are skipped. Options given on the command line act as **defaults** for every
line, and a line's own values win (`options` merges key by key).

```
# shots.jsonl
/imagine -m minimax-h3-r2v -s 5 --seed 100 a red panda plays a violin
{"prompt":"a red panda naps in the sun","seconds":8,"seed":200,"out":"nap.mp4"}
{"prompt":"studio portrait","model":"minimax-h3-t2v","size":"480p","options":{"noAudio":true}}
```

```bash
node scripts/imagine.js --batch shots.jsonl -m minimax-h3-r2v -i ref.png -O out/ --json --continue-on-error
```

JSON task keys: `model`, `prompt`, `negative`, `images[]`, `video`, `audio`, `seconds`,
`length`, `size`, `seed`, `steps`, `count`, `precision`, `out`, `enhance`, `options{}`.
Paths are resolved against the current working directory. `--batch -` reads stdin.

Tasks run **sequentially** — one render at a time, in file order — because they share one
GPU. The default is to stop at the first failure; `--continue-on-error` runs the rest.

## Output

Without `-o/--out`, files are named `<stamp>_<model-id>_<seed>[_n].<ext>` under
`--out-dir` (default: the current directory). The stamp is local time, the same clock the
gallery names its files with. `--out` accepts `{i}`, `{seed}`, `{model}` and `{stamp}`;
when one run produces several artifacts and the template has no `{i}`/`{seed}`, a `_1`,
`_2` suffix is appended so nothing overwrites itself.

**The CLI does not file anything in the gallery.** A browser render always keeps a copy
in `~/.hey-koko/gallery`; this one doesn't, because reaching for the CLI usually means
iterating on a prompt, and a dozen throwaway drafts should not end up in the library. The
written file is the only copy, and `mediaId` in the JSON record is `null`.

Pass **`-g/--gallery`** when a result is a keeper: it is then filed exactly as a browser
render is, and `mediaId` comes back as its gallery id
(`~/.hey-koko/gallery/<year-month>/…`).

### `-g` at render time vs `--add` afterwards

Both put the file in the gallery, but they file it as different things — and only one of
them records where it came from:

| ledger field | `-g` (filed as it renders) | `--add` (filed afterwards) |
| --- | --- | --- |
| `source` | `generated` | `upload` |
| `model`, `modelId`, `precisionUsed` | ✅ | ✗ |
| `prompt`, `negative`, `seed`, `params` | ✅ | ✗ |
| `width`, `height`, `fps`, `length` | ✅ | ✅ (probed from the file) |
| `contentHash` (dedup) | — | ✅ |

```jsonc
// -g
{"path":"…_zimage-turbo_s99.png","source":"generated","model":"z_image_turbo_nvfp4.safetensors",
 "modelId":"zimage-turbo","prompt":"a paper boat","seed":99,"precisionUsed":"nvfp4","params":{…}}
// --add
{"path":"…_upload_….mp4","source":"upload","originalName":"…","contentHash":"…","fps":24,"length":124}
```

`--add` goes through the endpoint the browser uses for dragged-in attachments, which only
ever sees bytes — it cannot know a file was generated, let alone with which model or
seed. So **decide before the render**: if a run might be worth keeping, use `-g` and the
entry stays reproducible (model, seed and prompt visible in the app); `--add` is for
footage that has no provenance to record anyway, or for promoting a draft when losing
that provenance is acceptable.

## Machine-readable output — `--json`

`--json` is the mode to use when a program (or an agent) drives this CLI. The contract:

- **stdout carries data only** — one JSON object per line (JSONL), one line per artifact,
  imported file, or model row. Nothing else is ever written there in this mode.
- **stderr carries everything human** — progress, labels, warnings, error text. Discard it
  freely; it is never part of the data.
- **the exit code is the verdict** — `0` all good, `1` usage/connection problem (nothing
  ran), `2` at least one task failed.

Read it line by line; do not try to parse the whole stream as one JSON document.

```bash
node scripts/imagine.js -m <id> -i ref.png -s 6 -O out/ --json "…" 2>/dev/null
```

**A finished render** (one line per artifact; an `-n 3` run emits three):

| field | meaning |
| --- | --- |
| `ok` | always `true` on this record |
| `file` | absolute path of the file written — the deliverable |
| `model` | canonical id as resolved from `-m` |
| `modelFile` | the weights file that actually loaded (may differ: precision swap) |
| `seed` | seed used — pass it back via `--seed` to reproduce |
| `width`, `height` | pixel size of the result |
| `fps`, `frames`, `seconds` | video only; `seconds` = `frames / fps` |
| `precision` | quantisation tier that loaded (`fp8`, `int8`, …), when known |
| `mediaId` | gallery id, or `null` when not filed (the default — see above) |
| `prompt` | prompt actually sent (after `--enhance`, if used) |
| `elapsedSec` | wall-clock seconds for the render |

```json
{"ok":true,"file":"/…/20260815-144527_zimage-turbo_6.png","model":"zimage-turbo","modelFile":"z_image_turbo_nvfp4.safetensors","seed":6,"width":848,"height":480,"precision":"nvfp4","mediaId":null,"prompt":"a paper boat","elapsedSec":1}
```

A third kind, **`noop: true`**, means the server deliberately did no work (see the
upscale tools below) — `ok` is `true` but `file` is `null`.

**A failed task** — same stream, `ok: false`. In a batch with `--continue-on-error` the
run keeps going, so a stream can mix both kinds:

```json
{"ok":false,"task":"line 3","error":"minimax-h3-r2v needs at least one reference (-i image / --video / --audio)","prompt":"…","model":"minimax-h3-r2v"}
```

**`--add` records** — `deduped: true` means those exact bytes were already filed and the
returned `mediaId` is the existing entry (no second copy was made):

```json
{"ok":true,"file":"/…/clip.mp4","mediaId":"2026-08/20260815-175217_upload_clip.mp4","kind":"video","deduped":false,"width":1280,"height":736}
```

**`--list-models --json`** — one row per model; this is how a program discovers what `-m`
will accept, instead of guessing an id:

```json
{"id":"minimax-h3-r2v","label":"MiniMax H3 (r2v)","group":"video-in","caps":["i2v","v2v","audio"],"tiers":["fp8","int8"],"ready":true,"needsImages":true,"needsVideo":true,"videoOptional":true}
```

`group` is `image` / `edit` / `video` / `video-in` / `3d`; `tiers` are the `@tier` values
that model accepts; `needsImages` / `needsVideo` say what it refuses to run without
(`videoOptional` means a clip is one acceptable input among several, not a requirement);
`ready: false` marks a model wired but not yet verified end to end.

`--dry-run` under `--json` prints the request body as a **single line** on the same
stream, so a caller can validate a batch without special-casing the format.

### Recipe for a calling program

```bash
# 1. discover
node scripts/imagine.js --list-models --json 2>/dev/null | jq -r 'select(.group=="video-in") | .id'

# 2. render, collecting the files that came out
node scripts/imagine.js --batch shots.jsonl -O out/ --json --continue-on-error 2>/dev/null \
  | jq -r 'select(.ok) | .file'

# 3. keep the good ones
node scripts/imagine.js --add out/keeper.mp4 --json 2>/dev/null | jq -r .mediaId
```

If every model row comes back with `caps: ["tool"]` (only `image-upscale` and
`video-enhance`), the server cannot see ComfyUI — the box is off or the address is wrong.
`-m` reports that in those words rather than calling your model id a typo.

## Upscale and sharpen — the two model-free tools

Two entries in `--list-models` are tools rather than generators (`caps: ["tool"]`). They
need no diffusion weights, so they are offered even when nothing else is installed:

| id | takes | does |
| --- | --- | --- |
| `video-enhance` | `--video clip.mp4` | AI-upscale and/or sharpen a clip |
| `image-upscale` | `-i photo.jpg` | the same for a single image |

```bash
# 2x upscale (the default) — writes the enlarged clip next to nothing else
node scripts/imagine.js -m video-enhance --video clip.mp4 -O out/

# to a specific long side, with a clean-up pass first
node scripts/imagine.js -m video-enhance --video clip.mp4 --upscale-to 1920 --upscale-denoise 0.2 -O out/

# sharpen ONLY, at the original resolution (no resampling at all)
node scripts/imagine.js -m video-enhance --video clip.mp4 --upscale off --sharpen medium -O out/

# a still
node scripts/imagine.js -m image-upscale -i photo.jpg --upscale 4x-UltraSharp.pth -O out/
```

| flag | values |
| --- | --- |
| `--upscale` | `auto` (default) · `off` · a filename from `--list-models` |
| `--upscale-to` | target **long side** in pixels (1920 / 2560 / 3840). Default is 2× the source, capped at a 2160 long side. A portrait clip gets in height what a landscape one gets in width. |
| `--sharpen` | `off` (default) · `light` · `medium` · `strong` |
| `--upscale-denoise` | `0`–`1` (a value above 1 is read as a percentage) — clean up before upscaling |
| `--restore` | `auto` · `off` · a filename — the denoise model, only used when `--upscale-denoise > 0` |

`--list-models` also prints the installed upscale/restore weights, so those filenames can
be discovered rather than guessed. In `--json` they are rows carrying `file` instead of
`id`:

```json
{"group":"upscaler","file":"4x-UltraSharp.pth"}
```

`--size` works here too and overrides `--upscale-to` with an explicit pixel budget at the
source's aspect ratio.

**A run with nothing to do** — `--upscale off` and no sharpen, denoise or resize — is not
an error: the server declines to call ComfyUI and returns a **noop record**, which a
caller must handle or it will wait for a file that never arrives:

```json
{"ok":true,"noop":true,"model":"video-enhance","message":"ℹ️ Nothing to do: …","file":null}
```

Frame interpolation is deliberately not here: it belongs to the ✂️ video editor in the
app, which owns the output-fps setting.

## Importing existing media

`--add` files media in the gallery **as-is** — no model, no render, no re-encode. It is
the way to promote a draft you kept, or to bring in footage from elsewhere:

```bash
node scripts/imagine.js --add out/20260815-144526_zimage-turbo_5.png
node scripts/imagine.js --add drafts/*.mp4 photo.jpg      # every bare word is a path here
node scripts/imagine.js --add clip.mp4 --json             # {"ok":true,"mediaId":"…","deduped":false}
```

Images, video, audio and `.glb` are accepted. The same bytes filed twice land on the
entry that is already there (`"deduped": true`, same id, no second copy). Pixel size is
read from PNG/JPEG headers, and from `ffprobe` for video when it is installed — without
it the entry is still filed, just with no dimensions on the ledger.

Everything filed this way is recorded as an **upload**, with no model / seed / prompt —
see [`-g` at render time vs `--add` afterwards](#-g-at-render-time-vs---add-afterwards)
before using it to keep a generated clip.

This mode needs no ComfyUI at all, only the hey-koko server.

Exit codes: **0** all good, **1** usage or connection problem, **2** one or more renders failed.

## Options

| Group | Flags |
| --- | --- |
| Model | `-m/--model <id[@tier]>`, `--precision <tier>` |
| Inputs | `-i/--image <path>` (repeatable), `--video <path>`, `--audio <path>` |
| Generation | `-s/--second <n>`, `--length <frames>`, `--size <WxH\|preset>`, `--seed <n>`, `--steps <n>`, `--no <text>`, `-n/--count <1-8>`, `-e/--enhance`, `--enhance-model <llm>` |
| Upscale tools | `--upscale <auto\|off\|file>`, `--upscale-to <px>`, `--sharpen <off\|light\|medium\|strong>`, `--upscale-denoise <0-1>`, `--restore <auto\|off\|file>` |
| ⚙ escape hatch | `--opt key=value` (repeatable) |
| Output | `-o/--out <path>`, `-O/--out-dir <dir>`, `-g/--gallery`, `--json`, `-q/--quiet`, `--dry-run` |
| Import | `--add <file...>` — file existing media in the gallery, no generation |
| Batch | `--batch <file\|->`, `--continue-on-error` |
| Server | `--server <url>`, `--comfy-url <url>`, `--timeout <minutes>` |
| Info | `--list-models [filter]`, `-h/--help` |

Size presets: `480p`, `720p`, `1080p`, `2k`, `4k` (each with a `-portrait` twin),
`ultrawide`, `ultrawide-small` — or any `WxH` between 256 and 4096.

`--timeout` is in minutes; `0` means **unlimited** (only a Ctrl-C ends the render), and
the default is 240. A pinned `--seed` with `-n 3` renders seeds `n`, `n+1`, `n+2`, so the
variations actually differ.

### `--opt` — any ⚙ knob, verbatim

`--opt` passes a key straight into the request's `options`, which is where every
settings-panel value lives. Values are parsed as JSON when they look like it
(`true`, `12`, `"…"`), otherwise kept as a string. Useful ones:

```
--opt noAudio=true              deliver a silent clip
--opt videoCodec=h265           H.265 output (needs VideoHelperSuite on that box)
--opt videoCrf=28               quality/size for the above
--opt easyCache=true            MiniMax H3: EasyCache sampling
--opt h3RefSize=512             MiniMax H3: reference-image working size
--opt h3TextEncoder=<file>      MiniMax H3: pick the Qwen3-VL encoder tier by filename
--opt fps=30 --opt shift=5      models whose preset leaves these tunable
```

Unknown keys are simply ignored by the builder that doesn't read them, so this is a
forward-compatible way to reach a knob the CLI has no flag for.

## Two behaviours worth knowing

- **`--dry-run` prints the exact request and generates nothing.** Use it to check a batch
  file before it reaches the GPU.
- **The app's ⚙ settings never apply here** — see
  [Nothing is inherited from the app](#nothing-is-inherited-from-the-app--except-the-comfyui-address).

## Model-specific notes (MiniMax H3 r2v)

The server enforces these; the CLI just catches the obvious cases earlier:

- Needs **at least one reference** — an image, a video, or an audio file. They are
  interchangeable ways of giving it one, and up to 9 images are used.
- Frame count sits on a **17k+5 grid**, trained range **124–362 frames** (≈5.2–15.1 s at
  24 fps). `-s 6` is snapped onto that grid rather than honoured exactly.
- **fps is fixed at 24** — the length is defined at that rate, so changing it would only
  re-time the picture and desync the generated soundtrack.
- **No negative branch**: `--no` reaches nothing. Say what you don't want positively in
  the prompt, which is also where the soundtrack is directed.
- Default size is `864×480`, the size actually measured to fit a 32 GB card at 124 frames.
  Larger is an explicit `--size` opt-in.
