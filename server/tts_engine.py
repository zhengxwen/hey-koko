#!/usr/bin/env python3
"""Local text-to-speech daemon for hey-koko's /voice command.

Wraps local engines:
  - kokoro    : light & fast (hexgrad/Kokoro-82M), Mandarin via misaki[zh];
                fixed preset voices
  - qwen3     : Qwen3-TTS (Apache-2.0) "designed" voices — a persona described in
                words. VoiceDesign renders a reference clip of it ONCE (cached on
                disk); every line is then spoken by the Base model cloning that clip,
                so the same persona sounds the same across clips and sessions.
                Lives in its OWN venv (it pins transformers 4.57), so tts.js runs a
                second copy of this daemon there; each copy reports what imports.

Protocol — newline-delimited JSON on stdin/stdout. Model/library logs go to
stderr; ONLY protocol JSON is written to the real stdout (we swap sys.stdout to
stderr so chatty libraries can't corrupt the channel).

  → request : {"id": 1, "engine": "kokoro", "voice": "zf_xiaoxiao",
               "text": "...", "speed": 1.0}
              {"id": 2, "engine": "qwen3", "voice": "anchor_f", "text": "...",
               "design": {"instruct": "...", "language": "Chinese",
                          "ref_text": "...", "ref_wav": "/abs/path.wav"}}
              {"cmd": "list"}                      # which engines imported OK
  ← reply   : {"id": 1, "ok": true, "wav_path": "/tmp/hk_tts_xxx.wav",
               "sample_rate": 24000}
              {"id": 1, "ok": false, "error": "..."}
  ← startup : {"ready": true, "engines": ["kokoro"]}

Engines are imported lazily on first use; an engine that fails to import is
simply reported unavailable rather than crashing the daemon. The Node side
(server/tts.js) reads the returned wav file, base64-encodes it for the browser,
then deletes it.
"""
import sys
import os
import io
import json
import wave
import tempfile

# On Windows, sys.stdin/stdout/stderr default to the locale code page (e.g.
# cp1252 / cp936), which corrupts the UTF-8 JSON the Node server exchanges with
# us: non-ASCII text (Chinese, etc.) arrives as mojibake and the model
# mispronounces it. Force UTF-8 on the protocol streams before we touch them.
for _s in (sys.stdin, sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

# Swap stdout → stderr so libraries that print (modelscope, torch, etc.) never
# corrupt the JSON protocol. _OUT is the real stdout, used only by emit().
_OUT = sys.stdout
sys.stdout = sys.stderr


def emit(obj):
    _OUT.write(json.dumps(obj) + "\n")
    _OUT.flush()


def log(msg):
    sys.stderr.write(f"[tts_engine] {msg}\n")
    sys.stderr.flush()


# ── WAV writing (no extra deps: numpy + stdlib wave) ───────────────────────
def write_wav(path, audio, sample_rate):
    """audio: 1-D float array in [-1, 1] (numpy/torch/list). Writes 16-bit PCM."""
    import numpy as np
    a = np.asarray(audio, dtype=np.float32).reshape(-1)
    a = np.clip(a, -1.0, 1.0)
    pcm = (a * 32767.0).astype("<i2")
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(int(sample_rate))
        w.writeframes(pcm.tobytes())


# ── Kokoro ─────────────────────────────────────────────────────────────────
# Kokoro picks language from the pipeline's lang_code, which matches the voice
# id's first letter: 'z' = Mandarin (needs misaki[zh]), 'a' = American English,
# 'b' = British English, etc. One pipeline is kept warm per language.
_kokoro_pipelines = {}


def kokoro_synth(text, voice, speed, req=None):
    import numpy as np
    lang = (voice or "z")[0]  # first char of the voice id = Kokoro lang code
    pipe = _kokoro_pipelines.get(lang)
    if pipe is None:
        from kokoro import KPipeline
        pipe = KPipeline(lang_code=lang)
        _kokoro_pipelines[lang] = pipe
        log(f"kokoro pipeline loaded (lang={lang})")
    chunks = []
    for _, _, audio in pipe(text, voice=voice, speed=float(speed)):
        arr = audio.detach().cpu().numpy() if hasattr(audio, "detach") else np.asarray(audio)
        chunks.append(arr.reshape(-1))
    if not chunks:
        raise RuntimeError("kokoro produced no audio")
    return np.concatenate(chunks), 24000


# ── Qwen3-TTS ──────────────────────────────────────────────────────────────
# Design-then-clone, the upstream README's recipe for "a consistent character voice
# across many lines": VoiceDesign is sampled afresh on every call, so the same
# description gives a slightly different speaker each time — fine for one clip, wrong
# for a recurring digital human. So VoiceDesign speaks a fixed reference sentence once,
# the clip is kept at design["ref_wav"] (tts.js names it after a hash of the persona,
# so editing the description re-designs), and every request is the Base model cloning
# that clip. Both models load lazily and stay warm.
QWEN3_REPO = "Qwen/Qwen3-TTS-12Hz-1.7B-"
# Weights fetched by hand (aria2c etc.) into $QWEN3_TTS_DIR/<repo name>/ are used as-is;
# otherwise from_pretrained pulls the HF repo into the usual cache.
QWEN3_DIR = os.environ.get("QWEN3_TTS_DIR", "")
_qwen_models = {}
_qwen_prompts = {}  # (ref_wav, mtime) → reusable voice-clone prompt


def _qwen_model(kind):
    m = _qwen_models.get(kind)
    if m is None:
        import torch
        from qwen_tts import Qwen3TTSModel
        if torch.cuda.is_available():
            dev, dtype = "cuda:0", torch.bfloat16
        elif torch.backends.mps.is_available():
            dev, dtype = "mps", torch.bfloat16
        else:
            dev, dtype = "cpu", torch.float32
        local = os.path.join(QWEN3_DIR, "Qwen3-TTS-12Hz-1.7B-" + kind) if QWEN3_DIR else ""
        src = local if local and os.path.isfile(os.path.join(local, "model.safetensors")) else QWEN3_REPO + kind
        m = Qwen3TTSModel.from_pretrained(src, device_map=dev, dtype=dtype, attn_implementation="sdpa")
        _qwen_models[kind] = m
        log(f"qwen3 {kind} loaded on {dev}")
    return m


def qwen3_synth(text, voice, speed, req=None):
    design = (req or {}).get("design") or {}
    ref_wav, ref_text, instruct = design.get("ref_wav"), design.get("ref_text"), design.get("instruct")
    if not (ref_wav and ref_text and instruct):
        raise RuntimeError(f"qwen3 voice '{voice}' has no persona definition")
    lang = design.get("language") or "Auto"
    if not os.path.exists(ref_wav):
        wavs, sr = _qwen_model("VoiceDesign").generate_voice_design(text=ref_text, language=lang, instruct=instruct)
        os.makedirs(os.path.dirname(ref_wav), exist_ok=True)
        tmp = ref_wav + ".part"
        write_wav(tmp, wavs[0], sr)
        os.replace(tmp, ref_wav)  # atomic: a half-written reference must never be cloned
        log(f"qwen3 designed voice '{voice}' → {ref_wav}")
    base = _qwen_model("Base")
    key = (ref_wav, os.path.getmtime(ref_wav))
    prompt = _qwen_prompts.get(key)
    if prompt is None:
        prompt = base.create_voice_clone_prompt(ref_audio=ref_wav, ref_text=ref_text)
        _qwen_prompts[key] = prompt
    wavs, sr = base.generate_voice_clone(text=text, language=lang, voice_clone_prompt=prompt)
    return wavs[0], sr


SYNTH = {"kokoro": kokoro_synth, "qwen3": qwen3_synth}


def probe_engines():
    """Return the engines whose libraries import successfully."""
    available = []
    try:
        import kokoro  # noqa: F401
        available.append("kokoro")
    except Exception as e:
        log(f"kokoro unavailable: {e}")
    try:
        import qwen_tts  # noqa: F401
        available.append("qwen3")
    except Exception as e:
        log(f"qwen3 unavailable: {e}")
    return available


def handle(req):
    if req.get("cmd") == "list":
        emit({"id": req.get("id"), "ok": True, "engines": probe_engines()})
        return
    rid = req.get("id")
    engine = req.get("engine")
    text = (req.get("text") or "").strip()
    voice = req.get("voice")
    speed = req.get("speed", 1.0)
    if engine not in SYNTH:
        emit({"id": rid, "ok": False, "error": f"unknown engine: {engine}"})
        return
    if not text:
        emit({"id": rid, "ok": False, "error": "empty text"})
        return
    try:
        audio, sr = SYNTH[engine](text, voice, speed, req)
        fd, path = tempfile.mkstemp(prefix="hk_tts_", suffix=".wav")
        os.close(fd)
        write_wav(path, audio, sr)
        emit({"id": rid, "ok": True, "wav_path": path, "sample_rate": sr})
    except Exception as e:
        emit({"id": rid, "ok": False, "error": f"{type(e).__name__}: {e}"})


def main():
    emit({"ready": True, "engines": probe_engines()})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception as e:
            emit({"ok": False, "error": f"bad request json: {e}"})
            continue
        handle(req)


if __name__ == "__main__":
    main()
