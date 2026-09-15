#!/usr/bin/env python3
"""CSPICE copies (never refits) DE440s records covering calendar year 2026 TDB.

Uses NASA/JPL NAIF spksub_c: https://naif.jpl.nasa.gov/pub/naif/toolkit_docs/C/cspice/spksub_c.html
Run with the same SpiceyPy 8.0.0 environment as generate_references.py.
This is fixture preparation on the host, never a production physics path.
"""
import hashlib
import json
from pathlib import Path
import spiceypy as spice
from download import DEST, SHA256, download

HERE = Path(__file__).resolve().parent
OUT = HERE / "de440-2026.bsp"


def extract():
    download()
    if OUT.exists():
        raise RuntimeError(f"refusing to replace {OUT}; remove it explicitly before regenerating")
    source = spice.dafopr(str(DEST))
    target = spice.spkopn(str(OUT), "DE440 2026 COPY VIA NAIF SPKSUB", 0)
    first, last = (2461041.5 - 2451545.0) * 86400, (2461406.5 - 2451545.0) * 86400
    segments = []
    try:
        spice.dafbfs(source)
        while spice.daffna():
            descriptor = spice.dafgs(5)
            name = spice.dafgn()
            dc, ic = spice.dafus(descriptor, 2, 6)
            spice.spksub(source, descriptor, name, first, last, target)
            segments.append({"target": int(ic[0]), "center": int(ic[1]), "frame": int(ic[2]), "type": int(ic[3])})
    finally:
        spice.spkcls(target)
        spice.dafcls(source)
    with OUT.open("rb") as stream:
        sha = hashlib.file_digest(stream, "sha256").hexdigest()
    metadata = {"source_file": "de440s.bsp", "source_sha256": SHA256,
                "output": OUT.name, "sha256": sha, "size_bytes": OUT.stat().st_size,
                "epoch_scale": "TDB", "start_jd": 2461041.5, "end_jd": 2461406.5,
                "tool": spice.tkvrsn("TOOLKIT"), "spiceypy": spice.__version__,
                "procedure": "spksub_c copies only the records needed for each original segment; it does not refit or compute coefficients.",
                "source_url": "https://naif.jpl.nasa.gov/pub/naif/generic_kernels/spk/planets/de440s.bsp",
                "tool_documentation": "https://naif.jpl.nasa.gov/pub/naif/toolkit_docs/C/cspice/spksub_c.html",
                "segments": segments}
    (HERE / "excerpt-metadata.json").write_text(json.dumps(metadata, indent=2) + "\n")
    print(f"PASS DE440 2026 excerpt {len(segments)} segments; {OUT.stat().st_size} bytes; SHA256 {sha}")


if __name__ == "__main__":
    extract()
