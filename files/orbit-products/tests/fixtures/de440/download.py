#!/usr/bin/env python3
"""Download the public NAIF DE440 short kernel, verifying the pinned bytes.

Host-side fixture preparation only. Production WASM receives caller-owned
kernel bytes through its invoke input and never opens a filesystem path.
"""
import hashlib
from pathlib import Path
import urllib.request

URL = "https://naif.jpl.nasa.gov/pub/naif/generic_kernels/spk/planets/de440s.bsp"
SHA256 = "c1c7feeab882263fc493a9d5a5b2ddd71b54826cdf65d8d17a76126b260a49f2"
SIZE = 32726016
DEST = Path(__file__).resolve().parent / "de440s.bsp"


def digest(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def download():
    if DEST.exists() and DEST.stat().st_size == SIZE and digest(DEST) == SHA256:
        print(f"PASS pinned DE440s already present: {DEST}")
        return
    partial = DEST.with_suffix(".bsp.part")
    try:
        with urllib.request.urlopen(URL, timeout=60) as source, partial.open("wb") as target:
            while chunk := source.read(1024 * 1024):
                target.write(chunk)
        if partial.stat().st_size != SIZE or digest(partial) != SHA256:
            raise RuntimeError("DE440s size/SHA-256 mismatch; refusing changed source bytes")
        partial.replace(DEST)
        print(f"PASS downloaded DE440s: {SIZE} bytes SHA256 {SHA256}")
    finally:
        partial.unlink(missing_ok=True)


if __name__ == "__main__":
    download()
