# Python dependency gate — 2026-09-15

This audit distinguishes missing **published Python bindings** from missing
ratified schemas. Existing module sources already use the required standards;
this lane does not create, regenerate, or patch their bindings.

## WasmEdge

[PyPI wasmedge 0.0.1](https://pypi.org/project/wasmedge/0.0.1/) describes itself
as an empty package. Its sole 991-byte source archive was uploaded
2021-05-13. Its `wasmedge/__init__.py` contains a print statement and no runtime
API. There are no wheels or load/invoke/memory APIs to implement this lane against.
The [official Python SDK documentation](https://wasmedge.org/docs/embed/python/intro/)
says work in progress; the [WasmEdge roadmap](https://github.com/WasmEdge/WasmEdge/blob/master/docs/ROADMAP.md)
lists it under the inactive roadmap. The [draft Python SDK PR #633](https://github.com/WasmEdge/WasmEdge/pull/633)
is not a released dependency. The C API, command runner and JS SDK are different
integration surfaces and do not make the requested Python SDK available.

## Space Data Standards

Both published wheels were downloaded and checked against PyPI SHA-256:

| Version | Upload time (UTC) | Finding |
| --- | --- | --- |
| [23.3.3.0.3.7](https://pypi.org/project/spacedatastandards.org/23.3.3.0.3.7/) | 2026-03-19 21:34:06 | PyPI default/highest version; old binding surface |
| [1.99.0](https://pypi.org/project/spacedatastandards.org/1.99.0/) | 2026-05-06 19:35:54 | Chronologically newer, still behind modules using SDS 1.199–1.203 |

These wheels **do contain FlatBuffers-generated Python**, under top-level names
such as `from OMM.OMM import OMM`. They do not contain a
`spacedatastandards` Python namespace. Installing the package without an exact
version selects the older `23.3.3.0.3.7` version series.

| Wrapper | Missing or unusable published Python surface |
| --- | --- |
| SGP4 | No `orbpro.propagator.PropagatorBatchRequest`, `orbpro.plugins.PropagatorState` or query types; `REC.REC` imports missing `Record` |
| HPOP | No `orbpro.hpop.InvokeRequest/InvokeResponse`, resident state/request or trajectory segment types |
| Estimation | No `orbpro.estimation.EstimationEnvelope/EstimationRequest/EstimationResult`, MEM, ODR or TRH |
| Conjunction | No legacy `orbpro.conjunction` request/result types; `CDM.CDM` imports missing `CDMObject` |
| Access | No ACW bindings |
| Events | No EVL, PCE or FRM; EOP is stale and RFM import fails |
| Lambert | 1.99.0 contains LMS/LMO, but `LMO.LMO` imports missing `lambertSolutionBranch`; default release lacks both |
| Time | TIM has only TIME_SYSTEM; lacks INSTANT, CONVERSION_REQUEST, CONVERSION_RESULT and associated tables |
| Frames | No FRM; `RFM.RFM` imports missing `CelestialFrameWrapper`; EOP lacks high-precision fields and other current metadata |

Isolated imports with the published FlatBuffers runtime confirmed that
`OMM.OMM`, `TIM.TIM`, `EOP.EOP`, and 1.99.0 `LMS.LMS` import successfully.
The failed imports above were observed directly; file presence alone is not
evidence of a usable generated binding.

`scripts/audit_published_dependencies.py` reproduces the archive hashes, member
presence, missing TIM/EOP fields and problematic bare imports without installing
or executing the downloaded packages. Its checked result is
`docs/dependency-audit.json`. The audit script's success means the evidence was
reproduced, not that these dependencies satisfy Lane 09.

## Required unblock

1. Supply a released, supported Python WasmEdge SDK with module loading,
   linear-memory access, export invocation, WASI and the required thread/host
   imports, plus supported native runtime versions/platforms.
2. Publish complete, importable Python bindings for the schemas already consumed
   by the modules, including legacy types or their ratified replacements. Fix
   generated cross-table Python imports upstream. Do not invent local schemas.
3. Implement wrappers and NumPy marshalling against those published APIs; extract
   the existing authoritative test vectors into shared fixtures without changing
   the expected numbers. Run numerical tests through Python and the same bytes
   in browser/V8, native WasmEdge and container WasmEdge.

The artifact-only prerelease intentionally has no `Requires-Dist: wasmedge` or
stale SDS dependency. Installing a known placeholder would give a misleading
impression that runtime dependencies had been satisfied.
