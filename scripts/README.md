# scripts/

Command-line tools that ship with hey-koko. All are plain `node`, no dependencies.

- **[imagine.js](imagine.js)** — terminal `/imagine`; batch image/video generation (documented below).
- **[fetch-vendor.js](fetch-vendor.js)** — download the pinned third-party UI libraries into `public/vendor/`.
- **[fetch-skills.js](fetch-skills.js)** — download the model prompt-writing guides into `~/.hey-koko/skills/`.

---

# imagine.js — terminal `/imagine`

A standalone CLI over the running hey-koko server, so other programs can drive batch
generation without a browser.

```bash
node scripts/imagine.js -m minimax-h3-r2v -i ref.png -s 6 -O out/ "a zebra finch conducts an orchestra"
```

Every recipe decision — companion files, sizing, frame-grid snapping, precision swap,
gallery filing — stays server-side, exactly as it is for the UI. This script adds no
model knowledge of its own; it resolves a model id, POSTs `/api/generate-comfy`, and
writes what comes back.

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

With `--json`, one JSON line per finished artifact goes to **stdout** while all progress
and logging goes to **stderr**, so the stream can be piped straight into another program:

```json
{"ok":true,"file":"/…/20260815-191639_zimage-turbo_99.png","model":"zimage-turbo",
 "modelFile":"z_image_turbo_nvfp4.safetensors","seed":99,"width":848,"height":480,
 "precision":"nvfp4","mediaId":"2026-08/…","prompt":"a paper boat","elapsedSec":2}
```

A failed task emits `{"ok":false,"task":"line 3","error":"…"}` on the same stream.

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

Exit codes: **0** all good, **1** usage or connection problem, **2** one or more renders failed.

## Options

| Group | Flags |
| --- | --- |
| Model | `-m/--model <id[@tier]>`, `--precision <tier>` |
| Inputs | `-i/--image <path>` (repeatable), `--video <path>`, `--audio <path>` |
| Generation | `-s/--second <n>`, `--length <frames>`, `--size <WxH\|preset>`, `--seed <n>`, `--steps <n>`, `--no <text>`, `-n/--count <1-8>`, `-e/--enhance`, `--enhance-model <llm>` |
| ⚙ escape hatch | `--opt key=value` (repeatable) |
| Output | `-o/--out <path>`, `-O/--out-dir <dir>`, `-g/--gallery`, `--json`, `-q/--quiet`, `--dry-run` |
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
