#!/usr/bin/env python3
"""Local text-to-speech daemon for hey-koko's /voice command.

Wraps two local engines, both exposing a few fixed preset voices (no cloning):
  - kokoro    : light & fast (hexgrad/Kokoro-82M), Mandarin via misaki[zh]
  - cosyvoice : higher Chinese quality (CosyVoice-300M-SFT preset speakers)

Protocol — newline-delimited JSON on stdin/stdout. Model/library logs go to
stderr; ONLY protocol JSON is written to the real stdout (we swap sys.stdout to
stderr so chatty libraries can't corrupt the channel).

  → request : {"id": 1, "engine": "kokoro", "voice": "zf_xiaoxiao",
               "text": "...", "speed": 1.0}
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
_kokoro_pipeline = None


def kokoro_synth(text, voice, speed):
    global _kokoro_pipeline
    import numpy as np
    if _kokoro_pipeline is None:
        from kokoro import KPipeline
        # lang_code 'z' = Mandarin Chinese (needs misaki[zh] for g2p).
        _kokoro_pipeline = KPipeline(lang_code="z")
        log("kokoro pipeline loaded")
    chunks = []
    for _, _, audio in _kokoro_pipeline(text, voice=voice, speed=float(speed)):
        arr = audio.detach().cpu().numpy() if hasattr(audio, "detach") else np.asarray(audio)
        chunks.append(arr.reshape(-1))
    if not chunks:
        raise RuntimeError("kokoro produced no audio")
    return np.concatenate(chunks), 24000


# ── CosyVoice (preset SFT speakers) ─────────────────────────────────────────
_cosy = None


def cosyvoice_synth(text, voice, speed):
    global _cosy
    import numpy as np
    if _cosy is None:
        from cosyvoice.cli.cosyvoice import CosyVoice
        model_dir = os.environ.get(
            "COSYVOICE_MODEL_DIR", "pretrained_models/CosyVoice-300M-SFT"
        )
        _cosy = CosyVoice(model_dir, load_jit=False, load_trt=False, fp16=False)
        log(f"cosyvoice loaded from {model_dir}")
    parts = []
    # inference_sft uses the model's built-in preset speakers (中文女/中文男/…).
    for out in _cosy.inference_sft(text, voice, stream=False, speed=float(speed)):
        sp = out["tts_speech"]
        arr = sp.detach().cpu().numpy() if hasattr(sp, "detach") else np.asarray(sp)
        parts.append(arr.reshape(-1))
    if not parts:
        raise RuntimeError("cosyvoice produced no audio")
    return np.concatenate(parts), _cosy.sample_rate


SYNTH = {"kokoro": kokoro_synth, "cosyvoice": cosyvoice_synth}


def probe_engines():
    """Return the engines whose libraries import successfully."""
    available = []
    try:
        import kokoro  # noqa: F401
        available.append("kokoro")
    except Exception as e:
        log(f"kokoro unavailable: {e}")
    try:
        import cosyvoice  # noqa: F401
        available.append("cosyvoice")
    except Exception as e:
        log(f"cosyvoice unavailable: {e}")
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
        audio, sr = SYNTH[engine](text, voice, speed)
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
