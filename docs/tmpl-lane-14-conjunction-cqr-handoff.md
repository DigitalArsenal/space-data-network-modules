# TMPL parity lane 14 — conjunction CQR handoff

Status: implementation and verification in progress. This file is finalized with
measured gate results before the lane commit.

## Scope and lineage

- Worktree: `modules-14-conjunction-cqr`; branch: `tmpl/14-conjunction-cqr`.
- Fresh fetched base: `ee14a6836727d4aedc8693477fcd6c3f2bb45090`.
- Design: coordinator-provided `modules-lane-11/docs/tmpl-lane-11-proposal.md`,
  sections 1–5, 6.3–6.4, 7 and 8.
- Root and module pin published npm `spacedatastandards.org` **1.220.0** exactly;
  module SDK **0.8.18**. Locks updated; module installed with `npm ci`.
- No schema is authored in this lane. C++ bindings regenerate from the installed
  published npm package, with a recorded schema closure and source hashes.

## Changes

### CQR records, sources and serialization

The manifest advertises all 19 methods: the twelve prior declared methods,
six resident index methods, and a CQR-only version query. All variable-length
payloads use canonical FlatBuffers with matching PIV/TAB metadata. CQR replaces
private conjunction records and raw CDM text ports; standalone CDM, CSM and OMM
ports retain their SDS identities. CDM KVN/XML text lives in CQRNativeDocument.
The SDK generates the PIV bridge, entrypoints and embedded manifest.

OMM/TLE SGP4 sources and native OEM/PPE tracks carry explicit Earth frame and UTC
time metadata. Source queries remain host-resolved provenance. Catalog OMM input
is decoded one verified record per frame. The numerical implementation, source
interpolation, propagation, frame/time interpretation and probability calculations
remain C++/WASM.

### Canonical threading and failures

`node build.mjs` calls the public SDK compiler with
`threadModel: "emscripten-pthreads"` and
`runtimeTargets: ["browser", "wasmedge"]`. The historical thread-model label
selects `wasm32-wasip1-threads -pthread`. The primary path is
`dist/isomorphic/module.wasm`; no Emscripten artifact is hand-linked or renamed.

The SDK disables C++ exceptions. Validation and numerical failures therefore use
explicit per-worker error status. Failed refinement/assessment pairs increment
`FAILED_PAIRS`; coarse propagation failures become evaluation failures. A failed
screening cannot report a silent successful subset. Thread-local error storage is
trivial fixed storage, requiring no unavailable TLS destructor runtime. Shared
SGP4 cache initialization is synchronized, and SDP4's mutable resonance integrator
is copied per evaluation so worker order cannot mutate shared numerical state.

## Evidence

Primary canonical SDK build passes. The first primary artifact was 874,030 bytes;
final build size and SHA256 are recorded after integrated fixes. Standards-aware
manifest validation: **0 errors** (baseline 84), **40** audited warnings for
canonical variable-length records without invented aligned peers.

The browser-direct primary-artifact SOCRATES/PIV gate passes **7/7**. Snapshot
oracle: CelesTrak SOCRATES Plus, captured **2026-03-10**, committed under
`analysis/conjunction-assessment/tests/fixtures/socrates/`. [SOCRATES methodology](https://celestrak.org/SOCRATES/)
and [Vallado et al., AIAA 2006-6753](https://celestrak.org/publications/AIAA/2006-6753/)
provide the source/model context; the committed snapshot is the numerical oracle.
TEME/UTC comparison, unchanged tolerances: **0.010 s / 5 m / 5 m/s**.

| Pair | TCA error (s) | Miss error (m) | Speed error (m/s) |
| --- | ---: | ---: | ---: |
| 61721–67298 | 0.00072 | 4.178 | 0.100 |
| 47935–49179 | 0.00032 | 0.303 | 0.304 |
| 48282–58288 | 0.00028 | 0.131 | 0.479 |

All three events found; no extras. See
[evidence/browser-focused.log](evidence/tmpl-lane-14/browser-focused.log).

Remaining final gates: full module suite, SDK compatibility, artifact compliance,
and browser/native/container command parity.

An early native C++ diagnostic compiled without exceptions and screened the
six-object SOCRATES snapshot. All worker counts 1/2/4/8 found three events with
zero failed pairs and identical numerical outputs. This is diagnostic evidence;
it does not replace the primary WASM and three-runtime gates below.

## Contract limitations and remaining debt

- Published OCM 1.220.0 has state samples and time metadata but no trajectory
  reference frame or state-unit declaration. The adapter rejects this source
  with an explicit unsupported-source error instead of inventing those fields.
  OEM/PPE provide the faithful typed sampled/polynomial path.
- Published CQR represents optional scalar presence using explicit `HAS_*`
  booleans and uses `QUERY_SELECTION` for resolved query provenance; the consumer
  follows those released bindings rather than the proposal's draft spellings.
- OEM covariance interpolation is not implemented. PPE requires Cartesian
  Chebyshev records with explicit velocity coefficients and contiguous coverage.
  Sampled resident indexes use exact Hermite evaluation; non-mean PPE indexes
  use polynomial-only evaluation. Unsupported exact-polish/provider combinations
  and nonzero guest progress cadence fail explicitly.
- Earth-fixed and cross-frame evaluation require verified FRM/EOP input not
  available through this module profile. Such requests fail explicitly. Existing
  SGP4 sample-helper output was ECEF while the old JSON adapter ignored its frame;
  it is no longer relabeled as an inertial track.
- Large Aerospace and full-catalog SOCRATES datasets are absent from the
  documented canonical ignored `tests/data/` layout. Their skipped tests are
  reported separately from checked-in SOCRATES snapshot acceptance.
- SOCRATES maximum-Pc comparisons remain advisory. They are not independent
  covariance probability certification. The centered isotropic probability
  test uses the analytical Gaussian/Rayleigh integral.

## Bounded improvement review

Baseline: execute the specified CQR migration, canonical build and listed gates.
Scores are ordered impact / deployability / fail-closed safety / lineage clarity.

| Wave | Candidate | Scores | Decision |
| --- | --- | --- | --- |
| Baseline | Literal transport/build migration | 8 / 8 / 8 / 9 = 33 | Initial baseline |
| 1 | Explicit worker failure accounting and deterministic shared-state handling | 9 / 9 / 10 / 10 = 38 | Selected; required to preserve truthful screening under wasi-threads |
| 1 | Introduce new OCM metadata outside published SDS | 7 / 0 / 2 / 0 = 9 | Rejected; outside canonical schema ownership |
| 1 | Expand to new frame/EOP physics | 6 / 3 / 7 / 6 = 22 | Rejected; outside bounded migration and available contracts |
| 1 | Retain alternate JSON artifact for recovery | 2 / 4 / 2 / 2 = 10 | Rejected; violates advertised typed contract |
| 1 | Add unrelated physics capability | 2 / 2 / 5 / 4 = 13 | Rejected; outside section 6.3 |
| 2 | Further additions beyond required gates | 8 / 8 / 9 / 9 = 34 | Rejected; no improvement over selected baseline |

Stop reason: `NO_BETTER_OPTION`. Selected improvement: explicit failure status
and deterministic numerical worker state, verified with the prescribed gates.

## Delivery

Commit uses the owner-supplied graph generation and lane override, with the
requested co-author trailer. Push only `origin tmpl/14-conjunction-cqr`; retain
the worktree. No main merge, package publication, deployment or credential access.
