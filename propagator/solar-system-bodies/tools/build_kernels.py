#!/usr/bin/env python3
"""Host-side kernel preparation for propagator/solar-system-bodies.

Copies the original Chebyshev records (CSPICE spksub_c; no refit) of the
Phase-1 bodies into one SPK and one lunar binary-PCK shard per decade, and
records every input and output hash in kernel-provenance.json. Nothing here is
shipped: the module reads the resulting NAIF files as caller-provided bytes.

  python -I tools/build_kernels.py <naif-dir> <out-dir>

<naif-dir> holds the unmodified NAIF/SSD downloads named in SOURCES below.
Requires SpiceyPy (CSPICE N0067).
"""
import hashlib
import json
import os
import sys

import spiceypy as sp

# (file, url, bodies, first year, last year). Bodies are SPK target codes.
SOURCES = [
    ("de440s.bsp", "https://naif.jpl.nasa.gov/pub/naif/generic_kernels/spk/planets/de440s.bsp",
     [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 199, 299, 301, 399], 1950, 2050),
    ("mar099s.bsp", "https://naif.jpl.nasa.gov/pub/naif/generic_kernels/spk/satellites/mar099s.bsp",
     [401, 402, 499], 2000, 2050),
    ("jup365.bsp", "https://naif.jpl.nasa.gov/pub/naif/generic_kernels/spk/satellites/jup365.bsp",
     [501, 502, 503, 504, 599], 2000, 2050),
    ("sat441.bsp", "https://naif.jpl.nasa.gov/pub/naif/generic_kernels/spk/satellites/sat441.bsp",
     [601, 602, 603, 604, 605, 606, 608, 699], 2000, 2050),
    ("ura184_part-3.bsp", "https://naif.jpl.nasa.gov/pub/naif/generic_kernels/spk/satellites/ura184_part-3.bsp",
     [701, 702, 703, 704, 705, 799], 2000, 2050),
    ("nep097.bsp", "https://naif.jpl.nasa.gov/pub/naif/generic_kernels/spk/satellites/nep097.bsp",
     [801, 899], 2000, 2050),
    ("plu060.bsp", "https://naif.jpl.nasa.gov/pub/naif/generic_kernels/spk/satellites/plu060.bsp",
     [901, 999], 2000, 2050),
    ("sb441-n16.bsp", "https://ssd.jpl.nasa.gov/ftp/eph/small_bodies/asteroids_de441/sb441-n16.bsp",
     [2000001, 2000004], 2000, 2050),
]
LUNAR_PCK = ("moon_pa_de440_200625.bpc",
             "https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/moon_pa_de440_200625.bpc")
TEXT = [
    ("pck00011.tpc", "https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/pck00011.tpc"),
    ("gm_de440.tpc", "https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/gm_de440.tpc"),
    ("moon_de440_250416.tf", "https://naif.jpl.nasa.gov/pub/naif/generic_kernels/fk/satellites/moon_de440_250416.tf"),
]
DECADES = list(range(1950, 2050, 10))
# One core shard per decade (planets, Sun, Moon, planet centres, Ceres, Vesta)
# and one shard per satellite system, so no fetched file exceeds 15 MB and a
# system's moons load only when the viewer asks for them.
SHARDS = {
    "core": [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 199, 299, 301, 399, 499, 599, 699, 799, 899, 999, 2000001, 2000004],
    "mars": [401, 402],
    "jupiter": [501, 502, 503, 504],
    "saturn": [601, 602, 603, 604, 605, 606, 608],
    "uranus": [701, 702, 703, 704, 705],
    "neptune": [801],
    "pluto": [901],
}


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def et_of_year(year):
    """TDB seconds past J2000 at YYYY-01-01T00:00:00 TDB (Gregorian calendar)."""
    y, m = year - 1, 13
    a = y // 100
    jd = int(365.25 * (y + 4716)) + int(30.6001 * (m + 1)) + 1 + 2 - a + a // 4 - 1524.5
    return (jd - 2451545.0) * 86400.0


def segments(path, nd, ni):
    handle = sp.dafopr(path)
    sp.dafbfs(handle)
    out = []
    while sp.daffna():
        summary = sp.dafgs()
        dc, ic = sp.dafus(summary, nd, ni)
        out.append((summary, list(dc), list(ic), sp.dafgn()))
    return handle, out


def build_spk_shard(naif, out, shard, start, stop):
    first, last = et_of_year(start), et_of_year(stop)
    path = os.path.join(out, f"{shard}-{start}.bsp")
    if os.path.exists(path):
        os.remove(path)
    new = None
    written = []
    for name, _url, bodies, y0, y1 in SOURCES:
        lo, hi = max(first, et_of_year(y0)), min(last, et_of_year(y1))
        if lo >= hi:
            continue
        handle, segs = segments(os.path.join(naif, name), 2, 6)
        for summary, dc, ic, ident in segs:
            target, center, frame, kind = (int(v) for v in ic[:4])
            if target not in bodies or target not in SHARDS[shard] or dc[1] < lo or dc[0] > hi:
                continue
            if kind not in (2, 3) or frame != 1:
                raise SystemExit(f"{name} {target}: type {kind} frame {frame} is outside the module's contract")
            a, b = max(lo, dc[0]), min(hi, dc[1])
            if new is None:
                new = sp.spkopn(path, f"{shard} {start}-{stop}", 4096)
            sp.spksub(handle, list(summary)[:5], ident, a, b, new)
            written.append({"target": target, "center": center, "source": name, "et": [a, b]})
        sp.dafcls(handle)
    if new is None:
        return None, written
    sp.spkcls(new)
    return path, written


def build_pck_shard(naif, out, start, stop):
    """Copy the lunar PA type-2 records covering [start, stop) into a new BPC."""
    first, last = et_of_year(start), et_of_year(stop)
    path = os.path.join(out, f"moon-pa-{start}.bpc")
    if os.path.exists(path):
        os.remove(path)
    handle, segs = segments(os.path.join(naif, LUNAR_PCK[0]), 2, 5)
    new = sp.pckopn(path, f"MOON PA {start}-{stop}", 4096)
    for summary, dc, ic, ident in segs:
        body_frame, ref, kind, begin, end = (int(v) for v in ic)
        if kind != 2 or dc[1] < first or dc[0] > last:
            continue
        # Type-2 trailer: INIT, INTLEN, RSIZE, N.
        init, intlen, rsize, n = sp.dafgda(handle, end - 3, end)
        rsize, n = int(rsize), int(n)
        degree = (rsize - 2) // 3 - 1
        i0 = max(0, int((first - init) // intlen))
        i1 = min(n, int(-(-(last - init) // intlen)))
        records = sp.dafgda(handle, begin + i0 * rsize, begin + i1 * rsize - 1)
        # pckw02 wants coefficients only (no MID/RADIUS words per record).
        coeffs = []
        for r in range(i1 - i0):
            rec = records[r * rsize:(r + 1) * rsize]
            coeffs.extend(rec[2:])
        btime = init + i0 * intlen
        sp.pckw02(new, body_frame, sp.frmnam(ref) or "J2000", btime, init + i1 * intlen,
                  ident, intlen, i1 - i0, degree, coeffs, btime)
    sp.dafcls(handle)
    sp.pckcls(new)
    return path


def main():
    naif, out = sys.argv[1], sys.argv[2]
    os.makedirs(out, exist_ok=True)
    provenance = {"tool": "tools/build_kernels.py", "cspice": sp.tkvrsn("TOOLKIT"), "inputs": [], "outputs": []}
    for name, url, *_ in SOURCES:
        provenance["inputs"].append({"file": name, "url": url, "bytes": os.path.getsize(os.path.join(naif, name)),
                                     "sha256": sha256(os.path.join(naif, name))})
    for name, url in [LUNAR_PCK] + TEXT:
        provenance["inputs"].append({"file": name, "url": url, "bytes": os.path.getsize(os.path.join(naif, name)),
                                     "sha256": sha256(os.path.join(naif, name))})
    for start in DECADES:
        made = [build_pck_shard(naif, out, start, start + 10)]
        for shard in SHARDS:
            spk, written = build_spk_shard(naif, out, shard, start, start + 10)
            if spk:
                made.append(spk)
        for path in made:
            provenance["outputs"].append({"file": os.path.basename(path), "bytes": os.path.getsize(path),
                                          "sha256": sha256(path), "coverage": [f"{start}-01-01 TDB", f"{start + 10}-01-01 TDB"]})
        print(start, " ".join(f"{os.path.basename(p)}={os.path.getsize(p) / 1e6:.2f}MB" for p in made))
    for name, _url in TEXT:
        dst = os.path.join(out, name)
        with open(os.path.join(naif, name), "rb") as src, open(dst, "wb") as d:
            d.write(src.read())
        provenance["outputs"].append({"file": name, "bytes": os.path.getsize(dst), "sha256": sha256(dst), "coverage": None})
    with open(os.path.join(out, "kernel-provenance.json"), "w") as f:
        json.dump(provenance, f, indent=2)
        f.write("\n")


if __name__ == "__main__":
    main()
