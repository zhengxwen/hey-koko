#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 Xiuwen Zheng
#
# hey-koko knowledge star-map projection. Reads a float32 matrix (written by
# server/star-map.js), runs UMAP to 2D + KMeans for constellations, and emits
# {"xy": [[x, y], ...], "cluster": [int, ...]} as a single JSON line on stdout.
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


def main():
    X = read_matrix(sys.argv[1])
    n = int(X.shape[0])
    if n == 0:
        print(json.dumps({"xy": [], "cluster": []}))
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

    print(json.dumps({"xy": xy, "cluster": [int(c) for c in cluster]}))


if __name__ == "__main__":
    main()
