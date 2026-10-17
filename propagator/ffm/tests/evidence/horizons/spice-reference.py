#!/usr/bin/env python3
"""Offline transport to native CSPICE via the requested SpiceyPy environment.
No Python dynamics or vector arithmetic. Epoch and state computations are CSPICE;
all reductions/units/FFM epoch calculations are in horizons-metrics.cpp.
"""
import json
import sys
import spiceypy as sp

data = json.load(sys.stdin)
sp.furnsh(data["lsk"])
sp.furnsh(data["de440"])
ids = list(sp.spkobj(data["de440"]))
out = {"tools": {"spiceypy": sp.__version__, "cspice": sp.tkvrsn("TOOLKIT")},
       "kernelTargetIds": ids, "bodies": {}}
for body, specification in data["bodies"].items():
    # The authenticated target contract and each body's own raw epochs come
    # from horizons-common.mjs. Never substitute a planet's body center for
    # its system barycenter, or borrow another response's rounded epochs.
    target = specification["target"]
    if target not in ids:
        raise ValueError(f"{body}: target {target} is absent from exported DE440")
    rows = []
    for epoch in specification["epochs"]:
        # C++ splits the decimal JD and formats ISO without single-JD loss.
        et = sp.str2et(epoch["rawUtcIso"].replace("T", " ") + " UTC")
        et_jd = sp.str2et("JD " + epoch["rawJdUtcText"].strip() + " UTC")
        et_nominal = sp.str2et(epoch["utc"].replace("T", " ") + " UTC")
        def state(instant):
            return list(sp.spkgeo(target, instant, "J2000", 399)[0])
        rows.append({"utc": epoch["utc"], "rawUtcIso": epoch["rawUtcIso"],
                     "rawJdUtcText": epoch["rawJdUtcText"], "etRawSpice": et, "etSpiceJdParser": et_jd,
                     "rawUtc": state(et), "nominalUtc": state(et_nominal),
                     "jdParserUtc": state(et_jd),
                     "ffmInstant": state(epoch["etFfm"]),
                     "nominalFfmInstant": state(epoch["etNominalFfm"])})
    out["bodies"][body] = {"target": target, "epochs": rows}
sp.kclear()
json.dump(out, sys.stdout)
print()
