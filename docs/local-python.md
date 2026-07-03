# Local Python venv — Text-to-Speech (`/voice`)

> This page also sets up hey-koko's **shared local-Python venv** (`~/venv/heykoko`).
> TTS is the feature that uses it today; other opt-in ML features install into the
> same venv later. Skip this whole page if you don't need local voices.

The `/voice <text>` command synthesizes a **downloadable audio file** with a
local open-source engine. The **Kokoro** engine is light & fast and exposes
fixed preset voices (male/female) selectable in the **Settings voice dropdown**
or inline with `--use`/`-u`:

| Engine | Strength | Preset voices |
|--------|----------|---------------|
| **Kokoro** | light & fast | Chinese `kokoro:zf_xiaoxiao` (女) / `kokoro:zm_yunxi` (男); English `kokoro:af_heart` (US ♀) / `kokoro:bm_george` (UK ♂) … |

These need PyTorch wheels installed into a **dedicated venv (Python 3.10–3.11)**
— the newest Python may not have matching wheels yet, and keeping these ML deps in
their own venv avoids clashing with the system Python. hey-koko uses **one shared
venv, `~/venv/heykoko`**, for its local-Python features (TTS today; other opt-in ML
features can install into the same venv later). The easiest way is
[uv](https://github.com/astral-sh/uv), which also downloads the right Python for
you.

## macOS

(`brew install uv`)

```bash
# Kokoro (light & fast) — recommended
uv venv --python 3.11 ~/venv/heykoko
uv pip install --python ~/venv/heykoko/bin/python kokoro "misaki[zh]" numpy soundfile

# English voices (af_*/am_* US, bf_*/bm_* UK) also need the spaCy English model
# + espeak-ng (otherwise misaki tries to auto-download the model and fails):
uv pip install --python ~/venv/heykoko/bin/python \
  "https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl"
brew install espeak-ng
```

## Linux

Install [uv](https://github.com/astral-sh/uv) first if you don't have it: `curl -LsSf https://astral.sh/uv/install.sh | sh`

```bash
# Kokoro (light & fast) — recommended
uv venv --python 3.11 ~/venv/heykoko
uv pip install --python ~/venv/heykoko/bin/python kokoro "misaki[zh]" numpy soundfile

# English voices (af_*/am_* US, bf_*/bm_* UK) also need the spaCy English model
# + espeak-ng (otherwise misaki tries to auto-download the model and fails):
uv pip install --python ~/venv/heykoko/bin/python \
  "https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl"
sudo apt install -y espeak-ng
```

Verified working on Linux aarch64 (e.g. NVIDIA DGX Spark / Grace) — `uv` picks CUDA-enabled PyTorch wheels automatically when a GPU is present.

## Windows

Use a **standard `venv`** from an installed Python 3.10–3.12
(the venv interpreter is `Scripts\python.exe`, not `bin/python`). Prefer
`python -m venv` over `uv venv` here: a uv-managed interpreter uses a launcher
shim that can break when spawned by the server (the daemon exits with "No Python
at …"), whereas a standard venv copies a real `python.exe`.

```powershell
# Kokoro (light & fast) — recommended. Requires an installed Python 3.10-3.12.
python -m venv "$env:USERPROFILE\venv\heykoko"
$vpy = "$env:USERPROFILE\venv\heykoko\Scripts\python.exe"
& $vpy -m pip install --upgrade pip
& $vpy -m pip install kokoro "misaki[zh]" numpy soundfile

# English voices (af_*/am_* US, bf_*/bm_* UK) also need the spaCy English model
# + espeak-ng (otherwise misaki tries to auto-download the model and fails):
& $vpy -m pip install "https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl"
winget install eSpeak-NG.eSpeak-NG
```

## First run & troubleshooting

On first synthesis Kokoro downloads its ~330 MB model from Hugging Face (cached
under `~/.cache/huggingface`), so the very first `/voice` call is slow; later
calls are fast.

> **Troubleshooting:** if you have `HF_HOME` set globally (e.g. pointing at a
> shared or read-only model cache used by other tools), the download can fail
> with a `PermissionError` on that cache's lock files. Either `unset HF_HOME`
> before starting the server, or point it at a directory your user can write to.

The server **auto-detects the venv** at `~/venv/heykoko` (falling back to the
legacy `~/venv/tts`; using `bin/python` on macOS, `Scripts\python.exe` on
Windows), so you can just run `node server.js` — no extra env var needed. (To use
a different venv, point `TTS_PYTHON` at its interpreter.) AAC encoding uses
`ffmpeg`; without it the audio falls back to wav.

The engine is hidden from the voice dropdown if it fails to import. (On macOS the
built-in `say` voices are always available too; on Windows only the Kokoro voices
are offered.) Usage: `/voice 你好世界`,
`/voice --use kokoro:zm_yunxi --speed 1.1 早上好` (`-u`/`-s` short forms).

Examples:
- `/voice 今天天气不错` → uses the default voice from settings
- `/voice -u kokoro:zm_yunxi 大家好` → specific Kokoro male voice
