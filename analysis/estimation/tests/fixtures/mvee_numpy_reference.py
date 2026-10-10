#!/usr/bin/env python3
"""Independent minimum-volume enclosing ellipsoids for tests/mvee.test.mjs.

Host-side fixture generation only (never part of the module). Khachiyan's
(1996) barycentric ascent with Todd and Yildirim's (2007) away steps, written
from the papers in plain numpy float64 on mean-centred raw coordinates
(numpy.linalg.solve for every iteration's quadratic forms; no whitening, no
rank-one updates, no final containment scaling), run until the duality gap
max(eps+, eps-) falls below 1e-12. The plain Khachiyan iteration (no away
steps) did not reach a 1e-11 gap within two million iterations on these
clouds, so the away steps are needed for a converged reference. The module
(src/teag.hpp) whitens by the sample covariance, uses Cholesky solves and
scales for exact containment; agreement is evidence that both reach the
unique MVEE.

    python3 tests/fixtures/mvee_numpy_reference.py > tests/fixtures/mvee-numpy-reference.json
"""
import json
import sys

import numpy as np


def khachiyan(points, gap=1e-12, max_iterations=2_000_000):
    n, d = points.shape
    mean = points.mean(axis=0)
    p = points - mean
    q = np.vstack([p.T, np.ones(n)])  # (d + 1) x n
    u = np.full(n, 1.0 / n)
    final_gap = np.inf
    for iteration in range(max_iterations):
        x = (q * u) @ q.T
        g = np.einsum("ij,ji->i", q.T, np.linalg.solve(x, q))
        jp = int(np.argmax(g))
        active = np.flatnonzero(u > 0)
        jm = int(active[np.argmin(g[active])])
        ep, em = g[jp] / (d + 1) - 1, 1 - g[jm] / (d + 1)
        final_gap = max(ep, em)
        if final_gap <= gap:
            break
        if ep >= em or g[jm] - 1 <= 1e-15:
            step = (g[jp] - d - 1) / ((d + 1) * (g[jp] - 1))
            u *= 1 - step
            u[jp] += step
        else:
            step = (d + 1 - g[jm]) / ((d + 1) * (g[jm] - 1))
            drop = step >= u[jm] / (1 - u[jm])
            if drop:
                step = u[jm] / (1 - u[jm])
            u *= 1 + step
            u[jm] -= step
            if drop:
                u[jm] = 0.0
    c = p.T @ u
    shape = d * ((p.T * u) @ p - np.outer(c, c))
    return c + mean, shape, iteration, float(final_gap)


def clouds():
    rng = np.random.default_rng(20261009)
    out = []
    for d, n, kind in [(2, 20, "gauss"), (2, 60, "uniform"), (3, 30, "gauss"), (3, 80, "skewed"),
                       (4, 40, "gauss"), (5, 60, "uniform"), (6, 85, "gauss"), (6, 120, "skewed"), (6, 13, "gauss")]:
        a = rng.normal(size=(d, d))
        scale = np.diag(np.geomspace(1e3, 1.0, d)) if kind != "uniform" else np.eye(d)
        if kind == "gauss":
            z = rng.normal(size=(n, d))
        elif kind == "uniform":
            z = rng.uniform(-1, 1, size=(n, d))
        else:
            z = rng.exponential(size=(n, d)) - 1.0
        pts = z @ (scale @ a).T + rng.normal(scale=1e3, size=d)
        out.append((d, kind, pts))
    return out


def main():
    cases = []
    for d, kind, pts in clouds():
        center, shape, iterations, final_gap = khachiyan(pts)
        cases.append({"dimension": d, "kind": kind, "points": pts.ravel().tolist(), "center": center.tolist(),
                      "shape": shape.ravel().tolist(), "iterations": iterations, "gap": final_gap,
                      "log_det": float(np.linalg.slogdet(shape)[1])})
    json.dump({"source": "tests/fixtures/mvee_numpy_reference.py (Khachiyan with Todd-Yildirim away steps, numpy "
                         + np.__version__ + ", gap 1e-12)", "cases": cases}, sys.stdout, indent=1)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
