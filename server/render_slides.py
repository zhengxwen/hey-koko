#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 Xiuwen Zheng
#
# Render each page of a PDF to a whole-page JPEG (P3 slides visual layer). Uses
# pypdfium2 + Pillow, both already present in MinerU's venv (see config.slidesPython),
# so no new install. Writes page_1.jpg, page_2.jpg, … into the output dir and prints a
# JSON summary. Kept deliberately tiny — the Node side (server/render-slides.js) owns
# the temp files, base64, and doc plumbing.
import sys, os, json, argparse


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("-p", "--pdf", required=True)
    ap.add_argument("-o", "--outdir", required=True)
    ap.add_argument("--scale", type=float, default=2.0)
    ap.add_argument("--quality", type=int, default=80)
    ap.add_argument("--maxpages", type=int, default=80)
    args = ap.parse_args()

    import pypdfium2 as pdfium

    os.makedirs(args.outdir, exist_ok=True)
    pdf = pdfium.PdfDocument(args.pdf)
    n = len(pdf)
    count = min(n, args.maxpages)
    files = []
    for i in range(count):
        page = pdf[i]
        bitmap = page.render(scale=args.scale)
        pil = bitmap.to_pil().convert("RGB")
        out = os.path.join(args.outdir, f"page_{i + 1}.jpg")
        pil.save(out, format="JPEG", quality=args.quality, optimize=True)
        files.append(out)
    print(json.dumps({"pages": n, "rendered": count, "files": files}))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001 — surface any failure as JSON for the Node caller
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)
