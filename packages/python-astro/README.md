# spacedatanetwork-astro — artifact distribution prerelease

**Lane 09 is blocked. This wheel distributes the nine pinned C++ WASM artifacts;
it does not execute astrodynamics from Python.** PyPI's `wasmedge` is an empty
placeholder, and the published SDS Python wheels omit required bindings. There
is no Python physics, JavaScript subprocess fallback, or invented schema here.
See [dependency evidence](docs/dependencies.md) and [verification](docs/verification.md).

## Install and inspect

Build on macOS arm64 (or another platform with Python 3.10+):

```sh
cd packages/python-astro
python3 -m venv .venv
. .venv/bin/activate
python -m pip install build==1.6.1
python -m build
python -m pip install dist/*.whl
python -m spacedatanetwork_astro verify
python -m spacedatanetwork_astro list
python -m spacedatanetwork_astro doctor  # exits 2: execution prerequisites blocked
```

The `py3-none-any` wheel is appropriate: it contains Python source and portable
WASM data, with no native binary. macOS arm64 wheel installation and artifact
integrity are tested locally; native WasmEdge integration is not implied by
this wheel tag. Nothing is published to PyPI.

The supported API retrieves the exact SDK bytes, including publication trailers:

```python
from spacedatanetwork_astro import get_artifact

sgp4 = get_artifact("propagator/sgp4")
hpop = get_artifact("propagator/hpop")
sgp4_wasm = sgp4.read_bytes()  # validates SHA-256 before returning bytes
hpop_wasm = hpop.read_bytes()
print(sgp4.sha256, hpop.sha256)
print(sgp4.source_revision)
```

A runnable SGP4 + HPOP propagation example, NumPy state-vector return types, and
idiomatic numerical wrappers remain blocked. An example calling nonexistent
WasmEdge APIs would not be usable, so none is presented as working.

## Contents and versioning

- `propagator/sgp4`, `propagator/hpop`, `propagator/events`
- `analysis/estimation`, `analysis/conjunction-assessment`, `analysis/access`,
  `analysis/lambert-izzo`
- `foundation/time`, `foundation/frames`

Each artifact comes from its existing SDK `dist/isomorphic/module.wasm` output.
The package does not recompile or transform it. The lock records the source
commit, per-file SHA-256 and size, manifest version, and existing build provenance
where available. The version suffix includes the source commit and a digest of
the complete artifact lock. All nine manifest versions alone would not identify
the shipped bytes, so they are insufficient as a package version pin.

`prepare_artifacts.py` checks the lock and stages data before wheel/sdist builds.
An sdist includes the checked bytes and can build independently of the modules
checkout. A source artifact mismatch fails the build even when a previous staged
copy exists. Update the reviewed lock and `_version.py` together when the
coordinator adopts newer module artifacts; do not silently substitute another
lane's WASM or the conjunction single-thread recovery artifact.

## Linux and Windows builds

Linux x86_64 and arm64 use the same commands and produce the same universal
wheel format. The resulting WASM hashes must match the lock. Wheel ZIP metadata
can differ between builds; artifact bytes cannot.

On Windows PowerShell:

```powershell
py -3 -m venv .venv
.venv\Scripts\python -m pip install build==1.6.1
.venv\Scripts\python -m build
Get-ChildItem dist\*.whl | ForEach-Object { .venv\Scripts\python -m pip install $_.FullName }
.venv\Scripts\python -m spacedatanetwork_astro verify
```

Those Linux/Windows recipes are documented, not locally validated. Once a real
Python WasmEdge SDK and compatible SDS bindings are published, each OS/CPU must
separately validate its native WasmEdge runtime against the same WASM bytes. An
OS-specific wheel tag would not supply that runtime. The official Python SDK
currently remains work in progress; no native dependency is falsely advertised
as installable through `pip install wasmedge`.

## Checks

```sh
python prepare_artifacts.py
PYTHONPATH=src python -m unittest discover -s tests -v
python scripts/audit_published_dependencies.py --output-dir /tmp/lane09-dependency-audit
```

The Python tests verify packaging, version locking and corruption rejection.
They are **not numerical conformance or tri-runtime parity tests**. Existing
module test sources and outstanding Python test work are catalogued in
[authoritative vectors](docs/authoritative-vectors.md).
