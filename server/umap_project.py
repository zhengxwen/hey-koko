#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 Xiuwen Zheng
#
# hey-koko knowledge star-map projection. Reads a float32 matrix (written by
# server/star-map.js), runs UMAP to 2D + KMeans for constellations + top-3 cosine
# neighbours per point (on the ORIGINAL high-dim vectors, not the 2D layout), and
# emits {"xy": [[x, y], ...], "cluster": [int, ...], "nn": [[j, j, j], ...]} as a
# single JSON line on stdout.
#
# Runs in the shared venv ~/venv/heykoko (kokoro + umap-learn). See
# docs/local-python.md. Warnings/progress go to stderr; stdout is JSON only.
#
# Input file layout: [n u32-le][dim u32-le][ n*dim float32-le ].

import sys
import json
import numpy as np


def read_matrix(path):
    with open(path, "rb") as f:
        n, dim = np.frombuffer(f.read(8), dtype="<u4")
        data = np.frombuffer(f.read(), dtype="<f4")
    return data.reshape(int(n), int(dim))


def top_neighbours(X, k=3):
    """Per-row top-k cosine neighbours (indices), row-chunked so a 10k×4096
    matrix never materialises a full n×n similarity at once."""
    n = X.shape[0]
    if n <= 1:
        return [[] for _ in range(n)]
    k = min(k, n - 1)
    norms = np.linalg.norm(X, axis=1, keepdims=True)
    Xn = X / np.maximum(norms, 1e-12)
    out = []
    step = max(1, min(2048, int(2e8 // max(1, n))))   # ~200M floats per chunk
    for i0 in range(0, n, step):
        sim = Xn[i0:i0 + step] @ Xn.T
        for r in range(sim.shape[0]):
            sim[r, i0 + r] = -2.0                      # never pick yourself
        idx = np.argpartition(-sim, k - 1, axis=1)[:, :k]
        # argpartition is unordered — sort the k picks by similarity
        for r in range(idx.shape[0]):
            row = idx[r]
            out.append(row[np.argsort(-sim[r, row])].tolist())
    return [[int(j) for j in row] for row in out]


def main():
    X = read_matrix(sys.argv[1])
    n = int(X.shape[0])
    if n == 0:
        print(json.dumps({"xy": [], "cluster": [], "nn": []}))
        return

    # constellation count ~ sqrt(n/2), clamped to [1, 40] and never > n
    k = max(1, min(40, int(round((n / 2) ** 0.5)), n))

    if n < 3:
        # UMAP is meaningless below 3 points — place them trivially.
        xy = [[0.0, 0.0], [1.0, 0.0]][:n]
        cluster = [0] * n
    else:
        import umap
        from sklearn.cluster import KMeans

        # n_neighbors must be >= 2 and < n; cap at the usual 15.
        nn = max(2, min(15, n - 1))
        # random_state makes the layout reproducible so the map doesn't reshuffle
        # on every rebuild (it forces single-threaded, fine for a background job).
        reducer = umap.UMAP(n_neighbors=nn, min_dist=0.1, n_components=2,
                            random_state=42, verbose=False)
        xy = np.asarray(reducer.fit_transform(X), dtype=float).tolist()
        cluster = KMeans(n_clusters=k, n_init=10, random_state=42).fit_predict(X).tolist()

    print(json.dumps({"xy": xy, "cluster": [int(c) for c in cluster],
                      "nn": top_neighbours(X)}))


if __name__ == "__main__":
    main()
