#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 Xiuwen Zheng
#
# Thin CLI wrapper around baidu/Unlimited-OCR (a local DeepSeek-OCR-derived model)
# so the Node server can spawn it exactly like MinerU: `-p input.pdf -o outDir`.
# It rasterizes the PDF with PyMuPDF (300 DPI), runs the model, and leaves a
# `result.md` (+ an `images/` subdir) in outDir — the same shape MinerU produces,
# so parse-file.js's existing output collector reads it unchanged.
#
# Progress is printed to stdout as MinerU-style lines (containing "page"/"%") that
# parse-file.js's isProgressLine filter forwards to the browser. The model's own
# chatty token/TPS stdout is muted so only our clean progress lines surface.

import argparse
import contextlib
import os
import sys
import tempfile
import threading
import time


def log(msg):
    # A line the parse-file.js isProgressLine filter will forward (has "page"/"%").
    print(msg, flush=True)


def pdf_to_images(pdf_path, dpi, tmp_dir):
    import fitz  # PyMuPDF
    doc = fitz.open(pdf_path)
    n = doc.page_count
    mat = fitz.Matrix(dpi / 72, dpi / 72)
    paths = []
    for i, page in enumerate(doc):
        out = os.path.join(tmp_dir, f"page_{i + 1:04d}.png")
        page.get_pixmap(matrix=mat).save(out)
        paths.append(out)
        log(f"rendering page {i + 1}/{n}")
    doc.close()
    return paths


class Heartbeat:
    """Emit a 'parsing N pages… Ns' progress line every few seconds while the
    single-pass model.generate() runs (it gives no per-page callback)."""
    def __init__(self, n_pages, interval=4.0):
        self.n_pages = n_pages
        self.interval = interval
        self._stop = threading.Event()
        self._t0 = time.time()
        self._out = sys.stdout            # captured before we mute the model's stdout
        self._thread = threading.Thread(target=self._run, daemon=True)

    def _run(self):
        while not self._stop.wait(self.interval):
            elapsed = int(time.time() - self._t0)
            print(f"parsing {self.n_pages} page(s)… {elapsed}s", flush=True, file=self._out)

    def __enter__(self):
        self._thread.start()
        return self

    def __exit__(self, *exc):
        self._stop.set()
        self._thread.join(timeout=1.0)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("-p", "--pdf", required=True, help="input PDF path")
    ap.add_argument("-o", "--out", required=True, help="output directory")
    ap.add_argument("--model", default=os.environ.get("UNLIMITED_OCR_MODEL", "baidu/Unlimited-OCR"))
    ap.add_argument("--dpi", type=int, default=300)
    ap.add_argument("--max-length", type=int, default=32768)
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    os.makedirs(os.path.join(args.out, "images"), exist_ok=True)

    # 1) Rasterize (fast, real per-page progress).
    tmp_dir = tempfile.mkdtemp(prefix="unlimited_ocr_")
    pages = pdf_to_images(args.pdf, args.dpi, tmp_dir)
    if not pages:
        print("error: PDF has no pages", file=sys.stderr, flush=True)
        return 2

    # 2) Load the model (heavy: torch + weights). Warnings go to stderr; the Node
    #    side only surfaces stderr lines matching the progress filter, so the
    #    torch/transformers noise is harmless.
    log(f"loading model ({len(pages)} page(s) to parse)…")
    import torch
    from transformers import AutoModel, AutoTokenizer
    tokenizer = AutoTokenizer.from_pretrained(args.model, trust_remote_code=True)
    model = AutoModel.from_pretrained(
        args.model, trust_remote_code=True, use_safetensors=True, dtype=torch.bfloat16,
    ).eval().cuda()

    # 3) Infer. Single page → gundam (crop_mode, higher quality); multi → base pass.
    #    Mute the model's token/TPS stdout and its save-progress tqdm (stderr) so only
    #    our clean progress lines show; the text is read back from result.md. Inference
    #    stderr is captured, not dropped: on failure we replay it so the real traceback
    #    reaches the Node side's error message.
    import io
    real_stderr = sys.stderr
    err_buf = io.StringIO()
    devnull = open(os.devnull, "w")
    try:
        with Heartbeat(len(pages)), contextlib.redirect_stdout(devnull), contextlib.redirect_stderr(err_buf):
            if len(pages) == 1:
                model.infer(
                    tokenizer, prompt="<image>document parsing.", image_file=pages[0],
                    output_path=args.out, base_size=1024, image_size=640, crop_mode=True,
                    max_length=args.max_length, no_repeat_ngram_size=35, ngram_window=128,
                    save_results=True,
                )
            else:
                model.infer_multi(
                    tokenizer, prompt="<image>Multi page parsing.", image_files=pages,
                    output_path=args.out, image_size=1024,
                    max_length=args.max_length, no_repeat_ngram_size=35, ngram_window=1024,
                    save_results=True,
                )
    except Exception:
        real_stderr.write(err_buf.getvalue())
        raise
    finally:
        devnull.close()

    md = os.path.join(args.out, "result.md")
    if not os.path.exists(md):
        print("error: model produced no result.md", file=sys.stderr, flush=True)
        return 3

    # The multi-page model marks page boundaries with a literal `<PAGE>` line; turn
    # those into Markdown thematic breaks so the result renders cleanly downstream.
    import re
    with open(md, "r", encoding="utf-8") as f:
        txt = f.read()
    parts = [p.strip() for p in re.split(r"^\s*<PAGE>\s*$", txt, flags=re.M)]
    parts = [p for p in parts if p]
    with open(md, "w", encoding="utf-8") as f:
        f.write("\n\n---\n\n".join(parts))

    log("done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
