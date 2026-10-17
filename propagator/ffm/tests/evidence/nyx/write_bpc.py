"""FFM's GCRF -> ITRF rotation as a NAIF binary PCK (type 2), for Nyx.

    python -I write_bpc.py <rotations.json> <out.bpc>

<rotations.json>: [{"et": TDB seconds past J2000, "c2t": row-major 3x3}, ...]
on a uniform grid. The even samples are fitted, the odd ones only checked.
Each one-hour record holds Chebyshev polynomials of the three 3-1-3 Euler
angles (SPICE's type-2 PCK layout); the segment gives frame ITRF93 (class 3000)
relative to J2000, which SPICE and ANISE take as the ICRF axes. stdout: JSON
with the fit and read-back residuals (microarcseconds), checked with SPICE's
own pxform on the written file.
"""
import json
import sys

import numpy as np
import spiceypy as sp

UAS = np.pi / 180 / 3600 / 1e6
INTERVAL_S = 3600.0
DEGREE = 12


def angle(a, b):
    """Rotation angle of a b^T, radians (from its antisymmetric part: arccos
    of the trace bottoms out at 4 mas in double precision)."""
    d = a @ b.T
    return float(np.arcsin(min(1.0, np.hypot(d[2, 1] - d[1, 2], np.hypot(d[0, 2] - d[2, 0], d[1, 0] - d[0, 1])) / 2)))


def main(src, out):
    rows = json.load(open(src))
    et = np.array([r["et"] for r in rows])
    mats = [np.array(r["c2t"]).reshape(3, 3) for r in rows]
    fit_idx = np.arange(0, len(rows), 2)
    # m2eul(m, 3, 1, 3) -> (a3, a2, a1) with m = [a3]_3 [a2]_1 [a1]_3.
    eul = np.array([sp.m2eul(m, 3, 1, 3) for m in mats])
    eul = np.unwrap(eul, axis=0)
    first = et[fit_idx[0]]
    n = int(np.floor((et[fit_idx[-1]] - first) / INTERVAL_S))
    cdata = []
    for k in range(n):
        lo, hi = first + k * INTERVAL_S, first + (k + 1) * INTERVAL_S
        sel = fit_idx[(et[fit_idx] >= lo - 1e-6) & (et[fit_idx] <= hi + 1e-6)]
        x = (et[sel] - (lo + hi) / 2) / (INTERVAL_S / 2)
        # Record layout: phi, delta, w (= a1, a2, a3).
        for col in (2, 1, 0):
            cdata.extend(np.polynomial.chebyshev.chebfit(x, eul[sel, col], DEGREE))
    last = first + n * INTERVAL_S
    handle = sp.pckopn(out, "FFM ITRF", 0)
    sp.pckw02(handle, 3000, "J2000", first, last, "FFM IERS 2010 GCRF->ITRF", INTERVAL_S, n, DEGREE, cdata, first)
    sp.pckcls(handle)

    sp.furnsh(out)
    inside = [i for i in range(len(rows)) if first <= et[i] <= last]
    res = {"fitted": [], "checked": []}
    for i in inside:
        r = np.array(sp.pxform("J2000", "ITRF93", float(et[i])))
        res["fitted" if i % 2 == 0 else "checked"].append(angle(r, mats[i]) / UAS)
    sp.kclear()
    print(json.dumps({
        "firstEt": first, "lastEt": last, "records": n, "intervalS": INTERVAL_S, "degree": DEGREE,
        "samples": len(rows), "fittedSamples": len(res["fitted"]), "checkedSamples": len(res["checked"]),
        "maxFittedResidualUas": max(res["fitted"]), "maxCheckedResidualUas": max(res["checked"]),
        "spiceypy": sp.__version__, "cspice": sp.tkvrsn("TOOLKIT"),
    }))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
