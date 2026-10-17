#!/usr/bin/env python3
"""Serial, offline Basilisk oracle for the neutral FFM export.

Invoke with bsk-venv/bin/python -I. Basilisk owns force evaluation and RKF78;
the backend adapts the exported environment to Basilisk's public messages.
The unchanged Nyx C++ helper measures convergence. No FFM physics is here.
"""
import argparse
import hashlib
import importlib.metadata
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

for name in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS", "VECLIB_MAXIMUM_THREADS", "NUMEXPR_NUM_THREADS"):
    os.environ[name] = "1"
os.environ["TZ"] = "UTC"
time.tzset()
sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[4]
EXPORT = HERE.parent / "cases/ffm-reference-cases.json"
WORK = HERE / ".work"


def digest(file):
    return hashlib.file_digest(open(file, "rb"), "sha256").hexdigest()


def pin(file):
    p = Path(file).resolve()
    return {"path": os.path.relpath(p, HERE), "sha256": digest(p)}


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(value, indent=1, allow_nan=False) + "\n")
    temp.replace(path)


def skip_reason(c):
    f = c["forces"]
    reasons = []
    if c["frame"] != "GCRF":
        reasons.append("EME2000 axes are not configured in this Basilisk GCRF evidence adapter")
    if f.get("relativity", "none") != "none":
        reasons.append("Basilisk spacecraft has no matching " + f["relativity"] + " relativistic acceleration")
    if f.get("solidTides"):
        reasons.append("no matching IERS 2010 frequency-dependent solid Earth gravity tides")
    if f.get("oceanTides"):
        reasons.append("no matching exported FES2004 ocean gravity tide model")
    if f.get("earthRadiation"):
        reasons.append("no matching Knocke albedo/infrared 15-degree quadrature")
    if f.get("inTrackAccelerationMS2"):
        reasons.append("exported continuous in-track acceleration is not a native configured Basilisk thrust model")
    drag = f.get("drag") or {}
    if drag.get("atmosphere") == "JB2008":
        reasons.append("Basilisk does not supply JB2008 atmosphere")
    if c.get("sensitivities") or c.get("jacobians") or c["forceSet"].startswith(("C1-", "C2-")):
        reasons.append("Basilisk spacecraft has no variational equations for the requested STM and parameter sensitivities")
    return "; ".join(reasons)


def gravity_file(export, c):
    f = c["forces"]["gravityField"]
    if not f:
        return None
    source = export["models"]["gravityFields"][f["model"]]
    file = ROOT / source["path"]
    if digest(file) != source["sha256"]:
        raise ValueError("Gravity source SHA-256 mismatch: " + str(file))
    coefficients = {(int(n), int(m)): (a, b) for n, m, a, b in re.findall(
        r"\{\s*(\d+),\s*(\d+),\s*([-+\d.eE]+),\s*([-+\d.eE]+)\s*\}", file.read_text())}
    degree, order = f["degree"], f["order"]
    tesseral = f.get("tesseralDegree", degree)
    output = WORK / "fields" / f"{f['model']}-{degree}z-{tesseral}t-{order}o.csv"
    output.parent.mkdir(parents=True, exist_ok=True)
    # Basilisk's loader wants a square triangular file even for zonal fields.
    # Zero only the coefficients excluded by the exported degree/order mask.
    rows = [f"{f['radiusM']:.17g},{c['forces']['centralBody']['gmM3S2']:.17g},0,{degree},{degree},1,0,0"]
    for n in range(degree + 1):
        for m in range(n + 1):
            a, b = coefficients.get((n, m), ("1" if n == 0 else "0", "0"))
            if m > order or (m > 0 and n > tesseral):
                a, b = "0", "0"
            rows.append(f"{n},{m},{a},{b},0,0")
    output.write_text("\n".join(rows) + "\n")
    return str(output)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--xval", type=Path, default=Path("/Users/tj/software/tools/xval"))
    parser.add_argument("--only", help="case-ID substring (diagnostic partial run)")
    parser.add_argument("--step", type=float, default=10.0)
    parser.add_argument("--out", type=Path, default=HERE / "basilisk-2.12.0.json")
    parser.add_argument("--variant", default="nominal", choices=("nominal", "wgs84", "wgs84-gtd7d", "no-wind", "no-eclipse"))
    parser.add_argument("--min-step", type=float, default=0.078125)
    args = parser.parse_args()
    if not sys.flags.isolated or sys.version_info[:2] != (3, 14):
        raise RuntimeError("Run the installed Python 3.14 with -I")
    if not 0 < args.step <= 10:
        raise ValueError("The maximum step must be positive and no more than 10 s")
    WORK.mkdir(exist_ok=True)
    try:
        os.nice(10)
    except PermissionError:
        pass
    export = json.loads(EXPORT.read_text())
    kernel = ROOT / export["models"]["ephemeris"]["path"]
    if digest(kernel) != export["models"]["ephemeris"]["sha256"]:
        raise ValueError("Exported DE440 SHA-256 mismatch")
    # Explicit isolated imports, never PYTHONPATH or user site discovery.
    erfa_site = args.xval / "erfa-spice/lib/python3.14/site-packages"
    sys.path.append(str(erfa_site))
    import Basilisk
    import erfa
    import numpy
    from Basilisk import _buildInfoData
    if Basilisk.__version__ != "2.12.0":
        raise RuntimeError("Expected the pinned Basilisk 2.12.0 wheel")
    backend = load_module("basilisk_evidence_backend", HERE / "basilisk-backend.py")
    metrics = WORK / "score-metrics"
    command = ["c++", "-std=c++17", "-O2", "-I", str(HERE.parents[2] / "src/cpp/include"),
               str(HERE.parent / "nyx/score-metrics.cpp"), "-o", str(metrics)]
    subprocess.run(command, check=True, cwd=WORK, env={**os.environ, "TMPDIR": str(WORK)})

    def difference(a, b):
        request = {"mode": "positions", "positions": [s[1:4] for s in a[1:]], "scale": 1, "samples": b}
        return json.loads(subprocess.check_output([metrics], input=json.dumps(request).encode(), cwd=WORK))

    support = args.xval / "bsk-data/supportData"
    bsk = Path(Basilisk.__file__).parent
    dist = Path(importlib.metadata.distribution("bsk")._path)
    files = [EXPORT, kernel, Path(sys.executable), HERE / "run-basilisk.py", HERE / "basilisk-backend.py",
             HERE / "investigate-basilisk.py",
             HERE.parent / "erfa-spice/reference.py", HERE.parent / "erfa-spice/tools.json",
             Path(erfa.__file__).parent / "ufunc.abi3.so", Path(numpy.__file__),
             bsk / "_buildInfoData.py", bsk / "_buildAbiData.py", dist / "METADATA", dist / "WHEEL", dist / "RECORD"]
    for name in ("spacecraft", "svIntegrators", "gravityEffector", "spiceInterface", "radiationPressure", "eclipse", "msisAtmosphere", "dragDynamicEffector"):
        files += [bsk / "simulation" / ("_" + name + ".so"), bsk / "simulation" / (name + ".py")]
    # Authenticate the complete wheel's extension surface, including native
    # messaging/architecture bridges used indirectly by the public wrappers.
    files += sorted(bsk.rglob("*.so"))
    files += sorted((bsk / ".dylibs").glob("*.dylib"))
    files += sorted(Path(numpy.__file__).parent.rglob("*.so"))
    files += sorted(Path(numpy.__file__).parent.rglob("*.dylib"))
    files += [Path(erfa.__file__).parent / "core.py"]
    for name in ("naif0012.tls", "de-403-masses.tpc", "pck00010.tpc", "GGM03S.txt", "NRLMSISE00Nominal.txt"):
        found = list(support.rglob(name))
        if len(found) != 1:
            raise RuntimeError("Missing or ambiguous installed support data: " + name)
        files += found
    for item in export["models"]["gravityFields"].values():
        files.append(ROOT / item["path"])
    input_pins = [pin(p) for p in dict.fromkeys(files)]
    recipe = hashlib.sha256(json.dumps(input_pins, sort_keys=True).encode()).hexdigest()
    record = {
        "about": "Independent Basilisk 2.12.0 spacecraft oracle; state-only, SI units, GCRF, hourly samples. No FFM numerical implementation is linked.",
        "caseExportSha256": digest(EXPORT),
        "tool": {"name": "Basilisk (AVS Lab)", "version": Basilisk.__version__, "license": "ISC",
                 "python": sys.version, "numpy": numpy.__version__, "pyerfa": erfa.__version__,
                 "erfa": erfa.version.erfa_version, "buildInfo": _buildInfoData.buildInfoData},
        "settings": {"integrator": "native Basilisk RKF78", "maximumStepS": args.step,
                     "convergenceLimitM": 0.0003, "variant": args.variant, "threads": 1,
                     "earthOrientation": "Exported EOP, pinned ERFA IAU 2006/2000A CIO GCRF-to-ITRF; orthogonal midpoint rotation held over each step, refined with the integration step",
                     "ephemeris": "SpiceInterface with the exported DE440; geometric Earth-centered J2000 (ICRF) states",
                     "stm": "Unavailable: Basilisk spacecraft has no variational equations"},
        "inputFiles": input_pins, "provenance": {"recipeSha256": recipe, "supportData": str(support),
            "kernelSelection": "DE430 is neither loaded nor used; the export's SHA-256-authenticated DE440 replaces it"},
        "cases": [], "skipped": [],
    }
    for c in export["cases"]:
        reason = skip_reason(c)
        if reason:
            record["skipped"].append({"id": c["id"], "reason": reason})
            continue
        if args.only and args.only not in c["id"]:
            continue
        field = gravity_file(export, c)
        if field and pin(field) not in record["inputFiles"]:
            record["inputFiles"].append(pin(field))
        config = {"export": export, "case": c, "gravityFile": field, "supportData": str(support),
                  "kernel": str(kernel), "variant": args.variant, "referenceModule": str(HERE.parent / "erfa-spice/reference.py")}
        slug = re.sub(r"[^A-Za-z0-9_-]", "_", c["id"])

        def simulate(step):
            cache = WORK / "runs" / (slug + f"-{args.variant}-{step:g}.json")
            identity = {"recipe": recipe, "step": step, "variant": args.variant, "id": c["id"], "field": digest(field) if field else None}
            if cache.exists():
                old = json.loads(cache.read_text())
                if old.get("identity") == identity:
                    return old["result"]
            started = time.monotonic()
            print(f"RUN {c['id']} {args.variant}, maximum step {step:g} s", flush=True)
            result = backend.run({**config, "maxStepS": step})
            write_json(cache, {"identity": identity, "result": result})
            print(f"DONE {c['id']} {step:g} s: {time.monotonic() - started:.1f} s", flush=True)
            return result

        step = args.step
        base = simulate(step)
        attempts = []
        while True:
            fine = simulate(step / 2)
            change = difference(base["samples"], fine["samples"])
            attempts.append({"maxStepS": step, "fineStepS": step / 2, **change})
            print(f"CONVERGENCE {c['id']}: {step:g}/{step/2:g} s, {change['worstM']:.9g} m", flush=True)
            if change["worstM"] < 0.0003:
                row = {k: c[k] for k in ("id", "orbit", "forceSet", "row", "toleranceClass")}
                row.update(samples=base["samples"], fineSamples=fine["samples"], maxStepS=step, fineStepS=step / 2,
                           convergenceAttempts=attempts, diagnostics=base.get("diagnostics", {}))
                record["cases"].append(row)
                break
            if step / 2 < args.min_step:
                raise RuntimeError(f"{c['id']}: did not converge below 0.3 mm; inspect cached measurements before proceeding")
            base, step = fine, step / 2
        write_json(args.out, record)
    write_json(args.out, record)
    print(f"Wrote {args.out}: {len(record['cases'])} trajectories, {len(record['skipped'])} skipped", flush=True)


if __name__ == "__main__":
    main()
