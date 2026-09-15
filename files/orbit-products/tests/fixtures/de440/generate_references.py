#!/usr/bin/env python3
"""Independent test-reference acquisition, never imports the module under test.

python -m venv /tmp/de440-reference-venv
/tmp/de440-reference-venv/bin/pip install spiceypy==8.0.0
/tmp/de440-reference-venv/bin/python generate_references.py [--horizons]

CSPICE computes geometric states from the pinned DE440s file. With --horizons,
JPL's public API also supplies vectors whose actual DE source is preserved.
Regeneration is an explicit maintainer action, never part of the tests.
"""
import argparse
import csv
from datetime import datetime, timezone
import io
import json
from pathlib import Path
import urllib.parse
import urllib.request

import spiceypy as spice
from download import DEST, SHA256, URL, download

HERE = Path(__file__).resolve().parent
J2000 = datetime(2000, 1, 1, 12)
MONTH_JDS = [2451545.0 + (datetime(2026, m, 1) - J2000).total_seconds() / 86400 for m in range(1, 13)]
# Jan 1 J2000, monthly 2026, Jan 1 2027: exact half-integer JDs, no rounding
# ambiguity in converting TDB JD into TDB seconds past J2000.
JDS = [2451545.0, *MONTH_JDS, 2461406.5]
PAIRS = [(target, 399) for target in [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 301]] + [(399, 0), (301, 3), (399, 3), (399, 301), (10, 301)]


def write_table(path, rows):
    with path.open("w", newline="") as output:
        writer = csv.writer(output)
        writer.writerow(["target", "center", "jd_tdb", "x_km", "y_km", "z_km", "vx_km_s", "vy_km_s", "vz_km_s"])
        for target, center, jd, state in rows:
            writer.writerow([target, center, format(jd, ".17g"), *[format(float(v), ".17g") for v in state]])


def generate_cspice():
    download()
    spice.furnsh(str(DEST))
    rows = [(target, center, jd, spice.spkez(target, (jd - 2451545.0) * 86400.0, "J2000", "NONE", center)[0])
            for target, center in PAIRS for jd in JDS]
    write_table(HERE / "cspice-de440.csv", rows)
    coverage = list(spice.spkcov(str(DEST), 301))
    metadata = {
        "authority": "NASA/JPL NAIF CSPICE spkez_c evaluated on the published DE440s kernel",
        "source_url": URL, "kernel_sha256": SHA256,
        "cspice_version": spice.tkvrsn("TOOLKIT"), "spiceypy_version": spice.__version__,
        "generated_utc": datetime.now(timezone.utc).isoformat(),
        "frame": "J2000 (DE440 is aligned to ICRF)", "aberration_correction": "NONE (geometric)",
        "units": ["km", "km/s"], "epoch": "TDB Julian date; ET=(JD-2451545.0)*86400",
        "coverage_et_seconds": coverage, "rows": len(rows),
        "tolerances": {"position_km": 1e-6, "velocity_km_s": 1e-9},
        "tolerance_rationale": "Same kernel and geometric frame: floating-point evaluation and barycentre summation only; absolute vector norms, not a model/observational accuracy claim.",
        "documentation": ["https://naif.jpl.nasa.gov/pub/naif/toolkit_docs/C/cspice/spkez_c.html", "https://naif.jpl.nasa.gov/pub/naif/toolkit_docs/C/req/spk.html", "https://naif.jpl.nasa.gov/pub/naif/generic_kernels/spk/planets/de440_and_de441.pdf"]
    }
    (HERE / "cspice-metadata.json").write_text(json.dumps(metadata, indent=2) + "\n")
    spice.kclear()
    print(f"PASS CSPICE {metadata['cspice_version']} reference states: {len(rows)}")


def generate_horizons():
    # Four fixed epochs bound 2026 without producing an unnecessarily large fixture.
    epochs = [MONTH_JDS[i] for i in [0, 3, 6, 9]]
    requests = []
    rows = []
    # All supported planetary barycentres, Sun, Moon, Earth and EMB.
    pairs = [(t, 399) for t in [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 301]] + [(399, 0)]
    for target, center in pairs:
        params = {"format": "json", "COMMAND": f"'{target}'", "OBJ_DATA": "'NO'", "MAKE_EPHEM": "'YES'",
                  "EPHEM_TYPE": "'VECTORS'", "CENTER": f"'500@{center}'", "REF_PLANE": "'FRAME'",
                  "REF_SYSTEM": "'ICRF'", "VEC_CORR": "'NONE'", "OUT_UNITS": "'KM-S'", "VEC_TABLE": "'2'",
                  "CSV_FORMAT": "'YES'", "TIME_TYPE": "'TDB'", "TLIST": "'" + " ".join(map(str, epochs)) + "'"}
        url = "https://ssd.jpl.nasa.gov/api/horizons.api?" + urllib.parse.urlencode(params)
        with urllib.request.urlopen(url, timeout=90) as response:
            payload = json.load(response)
        result = payload.get("result", "")
        if "$$SOE" not in result or "$$EOE" not in result:
            raise RuntimeError(f"Horizons rejected target {target}: {payload}")
        before, rest = result.split("$$SOE", 1)
        vectors, after = rest.split("$$EOE", 1)
        for values in csv.reader(io.StringIO(vectors.strip())):
            rows.append((target, center, float(values[0]), [float(v) for v in values[2:8]]))
        requests.append({"target": target, "center": center, "url": url, "parameters": params,
                         "signature": payload.get("signature"),
                         "source_headers": [line.strip() for line in before.splitlines() if "source:" in line],
                         "response": result})
        print(f"Horizons {target}/{center}: " + "; ".join(requests[-1]["source_headers"]), flush=True)
    write_table(HERE / "horizons.csv", rows)
    (HERE / "horizons-responses.json").write_text(json.dumps({
        "retrieved_utc": datetime.now(timezone.utc).isoformat(),
        "api_documentation": "https://ssd-api.jpl.nasa.gov/doc/horizons.html",
        "note": "Horizons selects its current ephemeris. The response headers, not this test, identify its DE release. Compare to DE440 only with documented cross-release tolerances.",
        "queries": requests}, indent=2) + "\n")
    print(f"PASS public JPL Horizons vectors: {len(rows)}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--horizons", action="store_true")
    args = parser.parse_args()
    generate_cspice()
    if args.horizons:
        generate_horizons()
