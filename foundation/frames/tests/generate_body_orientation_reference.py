#!/usr/bin/env python3
"""Regenerate independent body-frame fixtures with NAIF CSPICE N0067.

Test-data maintenance only: pip install spiceypy==8.2.0 in a disposable venv,
then run this script. Production code does not import or depend on Python,
SpiceyPy, CSPICE, or a downloaded kernel. The generator never calls the new
C++ implementation. The kernel hash is checked before loading reference data.
"""

import argparse
import hashlib
import json
from pathlib import Path
import tempfile
import urllib.request

import spiceypy as spice


KERNEL_URL = "https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/pck00011.tpc"
KERNEL_SHA256 = "3dff7b1dbeceaa01f25467767d3fa25816051c85d162d1edf04acb310ee28bb1"
BODIES = {
    10: "IAU_SUN",
    199: "IAU_MERCURY",
    299: "IAU_VENUS",
    301: "IAU_MOON",
    499: "IAU_MARS",
    599: "IAU_JUPITER",
    699: "IAU_SATURN",
}


def generate(kernel_bytes):
    digest = hashlib.sha256(kernel_bytes).hexdigest()
    if digest != KERNEL_SHA256:
        raise ValueError(f"Reference kernel changed: expected {KERNEL_SHA256}, got {digest}")
    if spice.tkvrsn("TOOLKIT") != "CSPICE_N0067":
        raise ValueError("Use CSPICE_N0067 to reproduce these reference matrices")
    spice.kclear()
    with tempfile.TemporaryDirectory(prefix="iau-body-reference-") as directory:
        kernel_path = Path(directory) / "pck00011.tpc"
        kernel_path.write_bytes(kernel_bytes)
        spice.furnsh(str(kernel_path))
        cases = []
        for body_id, frame in BODIES.items():
            # Two signs of time exercise secular rates and periodic phases.
            # The lunar century point makes its -1.4e-12*d*d W term observable.
            epochs = [0.0, 2651.5, -1000.0]
            if body_id == 301:
                epochs.append(36525.0)
            for days in epochs:
                matrix = spice.pxform("J2000", frame, days * 86400.0)
                cases.append({
                    "body_id": body_id,
                    "frame": frame,
                    "tdb_days_since_j2000": days,
                    "epoch_jd_tdb": 2451545.0 + days,
                    "matrix_icrf_to_fixed": matrix.reshape(-1).tolist(),
                    "tolerance": 1e-12 if body_id == 301 or days == 0.0 else 1e-11,
                })
        spice.kclear()

    return {
        "source": {
            "report": "Archinal et al., Report of the IAU Working Group on Cartographic Coordinates and Rotational Elements: 2015, CMDA 130:22 (2018), Table 1",
            "report_url": "https://doi.org/10.1007/s10569-017-9805-5",
            "lunar_model": "WGCCRE 2009, as retained by pck00011: the 2015 report no longer tabulates lunar rotational elements. IAU_MOON approximates the Mean Earth/Polar Axis frame, not the binary-PCK MOON_PA/MOON_ME models.",
            "pck_documentation": "https://naif.jpl.nasa.gov/pub/naif/toolkit_docs/C/req/pck.html#Orientation%20Models%20used%20by%20PCK%20Software",
        },
        "kernel": {"url": KERNEL_URL, "sha256": digest},
        "generator": {
            "program": "generate_body_orientation_reference.py",
            "spiceypy_version": spice.__version__,
            "cspice_version": spice.tkvrsn("TOOLKIT"),
            "method": "spice.pxform('J2000', frame, tdb_days_since_j2000 * 86400.0); only the hash-pinned PCK is loaded",
            "independence": "Expected values come from NAIF CSPICE, never from the module or a port of its implementation.",
        },
        "metadata": {
            "units": "dimensionless direction cosines, flattened row-major 3x3 matrices",
            "frame": "ICRF to the named IAU body-fixed axes; the text PCK uses SPICE's historical J2000 label for ICRF",
            "time_scale": "TDB; epoch origin JD 2451545.0 TDB (2000-01-01 12:00:00 TDB); one day = 86400 TDB seconds",
            "tolerance_kind": "maximum absolute matrix-element error",
            "tolerance_rationale": "1e-12 at J2000 and for every lunar case resolves the periodic and lunar quadratic terms while allowing floating-point Euler evaluation. The other nonzero epochs allow 1e-11 because large prime-meridian angles (up to 2.4 million degrees) lose several 1e-12 in binary64 multiplication and reduction when algebraically equivalent implementations differ in operation order. These tolerances test agreement with the analytical PCK model; they do not assert physical orientation accuracy of 1e-12 radians.",
        },
        "cases": cases,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--kernel", type=Path, help="Local copy of the hash-pinned pck00011.tpc; otherwise download from NAIF")
    parser.add_argument("--output", type=Path, default=Path(__file__).with_name("body_orientation_reference.json"))
    args = parser.parse_args()
    if args.kernel:
        kernel_bytes = args.kernel.read_bytes()
    else:
        with urllib.request.urlopen(KERNEL_URL, timeout=30) as response:
            kernel_bytes = response.read()
    args.output.write_text(json.dumps(generate(kernel_bytes), indent=2) + "\n")


if __name__ == "__main__":
    main()
