#!/usr/bin/env python3
"""TEST-ONLY ORACLE. NASA/JPL NAIF CSPICE (through SpiceyPy) on the same kernel
files the module is given. Never imported by shipped code.

stdin: {"kernels": [paths in load order], "epochs": [ET], "bodies": [NAIF ids],
        "frames": {"<id>": "<SPICE frame name>"}}
stdout: {"states": [[[x,y,z,vx,vy,vz] km, km/s per body] per epoch],
         "rotations": [[[9] row-major J2000 -> frame, or null] per epoch]}
States are spkgeo geometric states relative to the SSB in J2000 (CSPICE's
J2000 is the ICRF realisation the kernels are written in)."""
import json
import sys

import spiceypy as sp

req = json.load(sys.stdin)
for k in req["kernels"]:
    sp.furnsh(k)
states, rotations = [], []
for et in req["epochs"]:
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
json.dump({"toolkit": sp.tkvrsn("TOOLKIT"), "states": states, "rotations": rotations}, sys.stdout)
