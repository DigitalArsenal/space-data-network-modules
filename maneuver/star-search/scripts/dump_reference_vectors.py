#!/usr/bin/env python3
"""Generate deterministic Lambert probes from the installed Python reference."""

from __future__ import annotations

import argparse
import csv
import os
from pathlib import Path
import sys

import numpy as np


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--upstream-root", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    root = args.upstream_root.resolve()
    sys.path.insert(0, str(root))
    os.chdir(root)

    from star.lambert import (
        _W_and_derivs_scalar_jit,
        _tof_from_k_scalar_row_jit,
        lambert_batch,
    )

    # Direct scalar probes pin every W branch and both revolution terms.
    scalar_rows: list[list[object]] = []
    for nrev in (0, 1, 2):
        for k in (-3.0, -1e-3, 0.0, 1e-3, np.sqrt(2.0) - 1e-3, np.sqrt(2.0) + 1e-3, 2.5):
            W, dW, d2W = _W_and_derivs_scalar_jit(float(k), int(nrev), 2e-2, 1e-12)
            tof = _tof_from_k_scalar_row_jit(float(k), 0.2, 3.5, int(nrev), 2e-2, 1e-12)
            scalar_rows.append(["scalar", nrev, k, W, dW, d2W, tof])

    # Full-batch probes include zero and multi-revolution sweep ordering.
    r1 = np.asarray(
        [
            [1.0, 0.0, 0.0],
            [1.2, -0.1, 0.2],
            [0.7, 0.8, -0.1],
            [-0.8, 0.5, 0.3],
        ],
        dtype=float,
    )
    r2 = np.asarray(
        [
            [0.0, 1.0, 0.0],
            [-0.2, 1.1, 0.1],
            [-0.9, 0.1, 0.2],
            [0.6, -0.7, 0.1],
        ],
        dtype=float,
    )
    tof = np.asarray([1.7, 4.2, 8.0, 12.0], dtype=float)
    batch_rows: list[list[object]] = []
    v1, v2, axis, nrev, index = lambert_batch(
        r1,
        r2,
        tof,
        mu=1.0,
        N=2,
        hz=0,
        sweep_rev=True,
        series_eps=2e-2,
        tol=1e-6,
    )
    for row in range(int(index.size)):
        source = int(index[row])
        batch_rows.append(
            [
                "batch",
                source,
                int(nrev[row]),
                *r1[source].tolist(),
                *r2[source].tolist(),
                float(tof[source]),
                *v1[row].tolist(),
                *v2[row].tolist(),
                float(axis[row]),
            ]
        )

    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("w", newline="", encoding="utf-8") as stream:
        writer = csv.writer(stream, dialect="excel-tab", lineterminator="\n")
        writer.writerow(
            [
                "kind",
                "i0",
                "i1",
                "x0",
                "x1",
                "x2",
                "x3",
                "x4",
                "x5",
                "x6",
                "x7",
                "x8",
                "x9",
                "x10",
                "x11",
                "x12",
                "x13",
                "x14",
                "x15",
            ]
        )
        writer.writerows(scalar_rows)
        writer.writerows(batch_rows)

    print(f"scalar_rows={len(scalar_rows)}")
    print(f"batch_rows={len(batch_rows)}")
    print(f"output={args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
