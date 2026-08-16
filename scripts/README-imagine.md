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

This mode needs no ComfyUI at all, only the hey-koko server.

Exit codes: **0** all good, **1** usage or connection problem, **2** one or more renders failed.

## Options

| Group | Flags |
| --- | --- |
| Model | `-m/--model <id[@tier]>`, `--precision <tier>` |
| Inputs | `-i/--image <path>` (repeatable), `--video <path>`, `--audio <path>` |
| Generation | `-s/--second <n>`, `--length <frames>`, `--size <WxH\|preset>`, `--seed <n>`, `--steps <n>`, `--no <text>`, `-n/--count <1-8>`, `-e/--enhance`, `--enhance-model <llm>` |
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
- **The browser's ⚙ prompt decoration is not applied.** Those settings live in the
  browser's localStorage, which a CLI cannot read, so the prompt is sent verbatim.

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
