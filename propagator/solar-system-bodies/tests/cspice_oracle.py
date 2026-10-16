#!/usr/bin/env python3
"""TEST-ONLY ORACLE. NASA/JPL NAIF CSPICE (through SpiceyPy) on the same kernel
files the module is given. Never imported by shipped code.

stdin: {"kernels": [paths in load order], "epochs": [ET], "bodies": [NAIF ids],
        "frames": {"<id>": "<SPICE frame name>"}}
stdout: {"states": [[[x,y,z,vx,vy,vz] km, km/s per body] per epoch],
         "rotations": [[[9] row-major J2000 -> frame, or null] per epoch],
         "apparent": [[[x,y,z] km or null per body] per epoch] when the request
         has "apparentFrom": NAIF id (spkpos J2000 CN+S, converged light time, from that body),
         "observer": per case of the request's "observer" list ({et, focused,
         cam [km, J2000, from focused], chain [ids, focused outward],
         frames {id: frame}}): per chain body {rel km, hill km (Hill radius
         from spkgeo and the GM pool, the Sun's absent), pgr [lon, lat, alt km]
         (recpgr), lat [r km, lon, lat] (reclat), nearpt [lon, lat, alt km]
         (nearpt + surfnm on the triaxial radii)}, "sun" {rel km, ecl [r km,
         lon, lat] in ECLIPJ2000, gal [r km, lon, lat] in GALACTIC}}
States are spkgeo geometric states relative to the SSB in J2000 (CSPICE's
J2000 is the ICRF realisation the kernels are written in)."""
import json
import sys

import spiceypy as sp

req = json.load(sys.stdin)
for k in req["kernels"]:
    sp.furnsh(k)
states, rotations = [], []
for et in req.get("epochs", []):
    row_s, row_r = [], []
    for body in req["bodies"]:
        try:
            st, _lt = sp.spkgeo(body, et, "J2000", 0)
            row_s.append([float(v) for v in st])
        except Exception:
            row_s.append(None)
        frame = req["frames"].get(str(body))
        try:
            m = sp.pxform("J2000", frame, et) if frame else None
            row_r.append([float(v) for v in m.flatten()] if m is not None else None)
        except Exception:
            row_r.append(None)
    states.append(row_s)
    rotations.append(row_r)
apparent = []
if "apparentFrom" in req:
    for et in req["epochs"]:
        row = []
        for body in req["bodies"]:
            try:
                pos, _lt = sp.spkpos(str(body), et, "J2000", "CN+S", str(req["apparentFrom"]))
                row.append([float(v) for v in pos])
            except Exception:
                row.append(None)
        apparent.append(row)


def parent_of(body, chain):
    i = chain.index(body)
    return chain[i + 1] if i + 1 < len(chain) else None


observer = []
for case in req.get("observer", []):
    et, focused, cam, chain = case["et"], case["focused"], case["cam"], case["chain"]
    bodies = {}
    for body in chain:
        rel = [float(a + b) for a, b in zip(sp.spkgeo(focused, et, "J2000", body)[0][:3], cam)] if body != focused else list(cam)
        entry = {"rel": rel}
        parent = parent_of(body, chain)
        if parent is not None:
            st, _lt = sp.spkgeo(body, et, "J2000", parent)
            gm = sp.bodvcd(body, "GM", 1)[1][0]
            gp = sp.bodvcd(parent, "GM", 1)[1][0]
            entry["hill"] = float(sp.vnorm(st[:3]) * (gm / (3.0 * gp)) ** (1.0 / 3.0))
        radii = [float(v) for v in sp.bodvcd(body, "RADII", 3)[1]]
        entry["radii"] = radii
        frame = case["frames"].get(str(body))
        if frame:
            p = sp.mxv(sp.pxform("J2000", frame, et), rel)
            re, rp = radii[0], radii[2]
            lon, lat, alt = sp.recpgr(sp.bodc2n(body), p, re, (re - rp) / re)
            entry["pgr"] = [float(lon), float(lat), float(alt)]
            r, lon, lat = sp.reclat(p)
            entry["lat"] = [float(r), float(lon), float(lat)]
            pt, alt = sp.nearpt(p, radii[0], radii[1], radii[2])
            n = sp.surfnm(radii[0], radii[1], radii[2], pt)
            _r, lon, lat = sp.reclat(n)
            entry["nearpt"] = [float(lon), float(lat), float(alt)]
        bodies[str(body)] = entry
    sun = [float(a + b) for a, b in zip(sp.spkgeo(focused, et, "J2000", 10)[0][:3], cam)] if focused != 10 else list(cam)
    ecl = sp.reclat(sp.mxv(sp.pxform("J2000", "ECLIPJ2000", et), sun))
    gal = sp.reclat(sp.mxv(sp.pxform("J2000", "GALACTIC", et), sun))
    observer.append({"bodies": bodies, "sun": {"rel": sun, "ecl": [float(v) for v in ecl], "gal": [float(v) for v in gal]}})
json.dump({"toolkit": sp.tkvrsn("TOOLKIT"), "states": states, "rotations": rotations, "apparent": apparent,
           "observer": observer}, sys.stdout)
