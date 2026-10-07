#!/usr/bin/env python3
"""
Writes the two mixed-segment SPK fixtures and their CSPICE reference state.

Every byte of both kernels is written by the official NAIF toolkit (CSPICE
through spiceypy), and the reference state is CSPICE's own spkpvn on the
readable segment. Nothing here was produced by the code it tests.

  spk_mixed_t2_t13.bsp   segment 0: type 2 (Chebyshev, position only)
                         segment 1: type 13 (Hermite, unequal-step layout)
  spk_chebyshev_only.bsp segment 0: type 2, segment 1: type 3 (Chebyshev,
                         position and velocity)

The ephemeris propagator reads SPK types 8, 9 and 13 as state rows. A type 2 or
type 3 segment stores coefficients, not states, so the propagator skips it; the
first kernel must load with exactly one entity (the type-13 body) and the
second must be refused, because nothing in it is readable as rows.

Needs spiceypy (any CSPICE N0067 build) and numpy; the test suite does not run
this, it reads what this wrote. Usage:

    python3 make_mixed_kernels.py <fixtures dir>
"""

import hashlib
import json
import os
import struct
import sys

import numpy as np
import spiceypy as sp

MU_EARTH = 398600.4418  # km^3/s^2, the value every other SPK fixture uses
# The readable (type 13) body is a 7000 km LEO arc; the Chebyshev bodies fly a
# 26560 km arc, so a state served from the wrong segment is off by ~20000 km,
# never by a rounding error.
LEO = (7000.0, 51.6)
MEO = (26560.0, 55.0)

# 2026-05-02T12:00:00 TDB: 9618 whole days past J2000, so the Julian date of
# every probe below is exactly representable and maps back to ET exactly.
T0 = 9618 * 86400.0
SPAN = 3600.0
STEP = 60.0
# 3/128 day = 2025 s: an INTERIOR epoch (33.75 steps in), on the 2^-31-day
# Julian-date grid, so (jd - 2451545) * 86400 reproduces it with no rounding.
PROBE_ET = T0 + 2025.0
PROBE_JD = 2451545.0 + 9618.0 + 3.0 / 128.0


def arc(t, orbit):
    """Circular two-body arc, analytic in position and velocity."""
    radius, inc_deg = orbit
    w = (MU_EARTH / radius ** 3) ** 0.5
    a = w * (t - T0)
    ca, sa = np.cos(a), np.sin(a)
    inc = inc_deg * np.pi / 180.0
    ci, si = np.cos(inc), np.sin(inc)
    return np.array([
        radius * ca, radius * sa * ci, radius * sa * si,
        -radius * w * sa, radius * w * ca * ci, radius * w * ca * si,
    ])


def chebyshev_records(intlen, degree, components):
    """Least-squares Chebyshev fit per interval on Chebyshev nodes; one record
    is X..., Y..., Z... (and VX..., VY..., VZ... for type 3)."""
    n = int(round(SPAN / intlen))
    nodes = np.cos(np.pi * (np.arange(4 * (degree + 1)) + 0.5) / (4 * (degree + 1)))
    out = []
    for k in range(n):
        mid = T0 + (k + 0.5) * intlen
        samples = np.array([arc(mid + x * intlen / 2.0, MEO) for x in nodes])
        for c in range(components):
            out.extend(np.polynomial.chebyshev.chebfit(nodes, samples[:, c], degree))
    return n, np.array(out)


def write_type2(handle, body, segid):
    n, cdata = chebyshev_records(600.0, 9, 3)
    sp.spkw02(handle, body, 399, "J2000", T0, T0 + SPAN, segid, 600.0, n, 9, cdata, T0)


def write_type3(handle, body, segid):
    n, cdata = chebyshev_records(600.0, 9, 6)
    sp.spkw03(handle, body, 399, "J2000", T0, T0 + SPAN, segid, 600.0, n, 9, cdata, T0)


def write_type13(handle, body, segid):
    epochs = T0 + STEP * np.arange(int(SPAN / STEP) + 1)
    states = np.array([arc(t, LEO) for t in epochs])
    sp.spkw13(handle, body, 399, "J2000", epochs[0], epochs[-1], segid, 7,
              len(epochs), states, epochs)


def hexbits(x):
    return "%016x" % struct.unpack("<Q", struct.pack("<d", float(x)))[0]


def segment_descr(path, index):
    handle = sp.dafopr(path)
    try:
        sp.dafbfs(handle)
        for _ in range(index + 1):
            if not sp.daffna():
                raise IndexError(index)
        return handle, sp.dafgs(5)
    except Exception:
        sp.dafcls(handle)
        raise


def spkpvn(path, index, et):
    handle, descr = segment_descr(path, index)
    try:
        ref, state, center = sp.spkpvn(handle, descr, et)
        return int(ref), [float(v) for v in state], int(center)
    finally:
        sp.dafcls(handle)


def summaries(path):
    handle = sp.dafopr(path)
    out = []
    try:
        sp.dafbfs(handle)
        while sp.daffna():
            dc, ic = sp.dafus(sp.dafgs(5), 2, 6)
            out.append({"name": sp.dafgn(100).strip(), "target": int(ic[0]),
                        "center": int(ic[1]), "frame": int(ic[2]), "type": int(ic[3]),
                        "start_et": float(dc[0]), "stop_et": float(dc[1])})
    finally:
        sp.dafcls(handle)
    return out


def main(out_dir):
    kernels = {
        "spk_mixed_t2_t13.bsp": [
            (write_type2, -961, "T2-CHEBYSHEV-COEFFICIENTS"),
            (write_type13, -960, "T13-HERMITE-STATES"),
        ],
        "spk_chebyshev_only.bsp": [
            (write_type2, -962, "T2-CHEBYSHEV-COEFFICIENTS"),
            (write_type3, -963, "T3-CHEBYSHEV-COEFFICIENTS"),
        ],
    }
    report = {
        "generator": "data-source/spk-source/fixtures/make_mixed_kernels.py",
        "toolkit": sp.tkvrsn("TOOLKIT"),
        "spiceypy": sp.__version__,
        "arc": {"mu_km3_s2": MU_EARTH, "start_et": T0, "span_s": SPAN,
                "type13": {"radius_km": LEO[0], "inclination_deg": LEO[1], "step_s": STEP,
                           "degree": 7},
                "chebyshev": {"radius_km": MEO[0], "inclination_deg": MEO[1],
                              "interval_s": 600.0, "degree": 9}},
        "kernels": {},
    }
    for name, segments in kernels.items():
        path = os.path.join(out_dir, name)
        if os.path.exists(path):
            os.remove(path)
        handle = sp.spkopn(path, name[:-4].upper(), 0)
        try:
            for writer, body, segid in segments:
                writer(handle, body, segid)
        finally:
            sp.spkcls(handle)
        data = open(path, "rb").read()
        report["kernels"][name] = {"bytes": len(data),
                                   "sha256": hashlib.sha256(data).hexdigest(),
                                   "segments": summaries(path)}

    mixed = os.path.join(out_dir, "spk_mixed_t2_t13.bsp")
    ref, state, center = spkpvn(mixed, 1, PROBE_ET)
    cheb_ref, cheb_state, cheb_center = spkpvn(mixed, 0, PROBE_ET)
    report["probe"] = {
        "kernel": "spk_mixed_t2_t13.bsp",
        "how": "spiceypy.spkpvn(handle, descr of segment 1, et): the segment's own frame and center",
        "et": PROBE_ET, "et_hex": hexbits(PROBE_ET),
        "julian_date": PROBE_JD, "julian_date_hex": hexbits(PROBE_JD),
        "segment_index": 1, "frame": ref, "center": center,
        "state_km": state, "state_hex": [hexbits(v) for v in state],
        "analytic_km": [float(v) for v in arc(PROBE_ET, LEO)],
        "type2_segment_state_km": cheb_state,
    }
    with open(os.path.join(out_dir, "spk_mixed_reference.json"), "w") as f:
        json.dump(report, f, indent=2)
        f.write("\n")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.abspath(__file__)))
