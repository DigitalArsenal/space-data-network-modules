# TMPL parity lane 14 — conjunction CQR handoff

## Scope and lineage

Implementation of proposal §6.3: C1a records, C1b sources, W1 serialization,
B1c canonical threading/build, and verification. Design authority is
`modules-lane-11/docs/tmpl-lane-11-proposal.md`, §§1–5, 6.3–6.4, 7 and 8.
This is a contract migration, not a claim of full TMPL capability parity.

- Worktree: `modules-14-conjunction-cqr`; branch: `tmpl/14-conjunction-cqr`.
- Recovered first-pass state checkpointed and pushed as `be357c7` before further
  implementation. Fetched `origin/main` at
  `5cbedd3c33225d1dd83fdf8b17a28cb8491cdf3f` was merged into the lane as `0c5cfb4`.
- Root and module pin published npm `spacedatastandards.org` **1.220.0** exactly;
  module SDK **0.8.18**. Module dependencies installed with `npm ci`.
- Bindings regenerate only from installed published SDS IDL. No local schema
  contract was authored. Generated C++ headers record their complete schema
  closure and hashes in `src/cpp/generated/sds/provenance.json`.
- No canonical checkout source edits, package publication, deployment, credential
  access, or merge into main. The worktree remains available to the coordinator.

## What changed

### Published records and source selection

The manifest advertises all **19** supported methods, including six resident
methods and a CQR-only version query. The retired JSON `invoke` method and private
conjunction schemas/headers/ABI implementation are removed. SDK code owns PIV/TAB,
allocation, manifest accessors, and command framing.

| Methods | Input | Output |
| --- | --- | --- |
| `assess_conjunction` | CQR.PAIR_REQUEST | CQR.EVENT_RESULT |
| `emit_cdm`, `emit_csm` | CQR.PAIR_REQUEST | CDM / CSM root |
| `find_tca` | CQR.PAIR_REQUEST | CQR.TCA_RESULT |
| `alfano_max_probability` | CQR.ALFANO_REQUEST | CQR.ALFANO_RESULT |
| `compute_pc` | CQR.PROBABILITY_REQUEST | CQR.PROBABILITY_RESULT |
| `compute_pc_from_cdm` | CDM root | CQR.PROBABILITY_RESULT |
| `parse_cdm_kvn/xml` | CQR.NATIVE_DOCUMENT on original port | CDM root |
| `write_cdm_kvn/xml` | CDM root | CQR.NATIVE_DOCUMENT on original port |
| `screen_catalog` | CQR.CATALOG_REQUEST + individual OMM frames | Chunked CQR.CATALOG_RESULT |
| Three `prepare_*_screening_index` methods | CQR.INDEX_REQUEST | CQR.INDEX_RESULT |
| `screen_window`, `screen_segment_window` | CQR.WINDOW_REQUEST | Chunked CQR.CATALOG_RESULT |
| `destroy_screening_index` | CQR.DESTROY_REQUEST | Empty successful PIV response |
| `version` | CQR.VERSION_QUERY | CQR.VERSION_RESULT |

All variable-length payloads use genuine canonical FlatBuffers, with matching
TYPE_REF/TAB metadata and exact SDS root identities. False aligned-binary peers
and raw-text ports are gone. CDM external KVN/XML bytes use the typed native
record. Optional CDM ports remain advertised but are not populated with invented
messages; callers request the supported `emit_cdm` method explicitly.

OMM/TLE explicitly select the SGP4 TEME/UTC provider. OEM compact/verbose tracks
and Cartesian Chebyshev PPE support other providers without SGP4. Frames and
coverage are validated before evaluation; source queries are host-resolved
provenance. Every catalog frame is verified and consumed. Missing OMM OBJECT_ID
falls back to its nonzero NORAD ID; missing both identities is rejected.

Physics, propagation, interpolation, probability, time parsing, and frame
interpretation remain in C++/WASM. Host JavaScript only transports/encodes data,
loads the runtime, and compares measured outputs with independent references.
The public browser entrypoint loads without resolving Node-only signing code
and forwards the SDK's browser thread enablement and pool-size options. Bundled
hosts can set `wasiThreadWorkerBaseUrl`; SDK 0.8.18 requires its public global
worker-base setter because its inner harness drops the per-instance base.

### Threading, deterministic results, and failure accounting

`node build.mjs` calls `compileModuleFromSource(...)` with
`threadModel: "emscripten-pthreads"` and manifest targets
`["browser", "wasmedge"]`. That SDK vocabulary selects
`clang --target=wasm32-wasip1-threads -pthread`. The primary artifact imports
`wasi.thread-spawn`, exports `wasi_thread_start`, and has shared memory/atomics
with **no Emscripten worker hooks**. It is never hand-linked/renamed from an
Emscripten browser artifact.

The public SDK compiler hook follows HPOP's constructor-lifetime pattern:
initialization once per resident instance, static destruction deferred to host
instance teardown. The SDK still drives compilation/linking and validates the
artifact. Unlike HPOP, conjunction retains the SDK's no-exception profile and
uses explicit worker-local failure status. Malformed UTC/TLE inputs and
unrepresentable Julian-date resolutions fail explicitly before numerical loops.

SGP4 shared cache initialization is synchronized; mutable SDP4 resonance state
is copied per evaluation. Results use deterministic TCA/object ordering and
64-bit counts. Elapsed timings remain host diagnostics. Resident primary
selection includes primary–primary pairs as well as primary–secondary pairs.

Each response emits at most one bounded event chunk and respects positive PIV
output caps. Continuations retain exact request identity, sequence and final
markers. Failed pair evaluations and worker serialization failures contribute to
FAILED_PAIRS; the final response reports `incomplete-screening`, retaining the
valid results and failure counts instead of silently presenting a complete run.

## Artifact and completion evidence

Final primary path: `analysis/conjunction-assessment/dist/isomorphic/module.wasm`.
Size: **892,091 bytes**. SHA256:
`7ed526ea5b52954dedf4d49d76be1685bb2419631e7b7f5fe74cb33fc335a747`.
Compiler, initialization support, schema and artifact hashes are recorded in
[build provenance](../analysis/conjunction-assessment/dist/build-provenance.json).

Commands run in the module directory with `PATH="$HOME/.wasmedge/bin:$PATH"`.

| Gate | Result | Evidence |
| --- | --- | --- |
| `node build.mjs` | PASS, canonical SDK artifact validation | [build-final.log](evidence/tmpl-lane-14/build-final.log) |
| `node --test tests/sdk_compat.test.mjs` | **10 passed, 0 failed, 0 skipped** (baseline 1 failure) | [sdk-compat-final.log](evidence/tmpl-lane-14/sdk-compat-final.log) |
| `npm test` | **63 passed, 0 failed, 8 dataset skips** | [npm-test-final.log](evidence/tmpl-lane-14/npm-test-final.log) |
| `npm run check:compliance` | **0 standards-aware/artifact errors** (baseline 84), PLG round-trip PASS | [compliance-final.log](evidence/tmpl-lane-14/compliance-final.log) |
| Public native entrypoint and CDM signing | **2 passed, 0 failed**, including actual Pc invocation | [direct-entry-final.log](evidence/tmpl-lane-14/direct-entry-final.log) |
| Public browser entrypoint | **PASS** in real Chrome, two-worker SOCRATES request, **4 real guest spawns** across phases | [browser-wrapper.json](evidence/tmpl-lane-14/browser-wrapper.json) |
| Three-runtime command matrix | **132 runs, 217 comparisons, 0 failures**; browser/WasmEdge/Docker at workers **1/2/4/8** | [runtime receipt](evidence/tmpl-lane-14/cqr-runtime-parity.json), [parity-final.log](evidence/tmpl-lane-14/parity-final.log) |

All three lanes execute the primary artifact hash above. Each lane completes
44 runs covering 14 cases. The **12 SOCRATES runs have byte-identical PIV
output**, SHA256
`102c4565135bfc0782ada60053a802b51ec8273c090d74303c10cc4f080d55f9`.
Requested worker counts 1/2/4/8 produce **0/4/8/14 actual guest spawns** in each
runtime across the screening phases. The matrix also checks converged Pc and
the specified malformed-input/error outcomes. Files named `*-current.log`
and earlier bring-up logs retain diagnostic history; the table identifies the
final acceptance evidence.

The **40 distinct `no-aligned-peer` warnings** are audited variable-length
record sites. Both manifest and artifact checks repeat them. They are not
suppressed, and no fake fixed layout or catalog exception was added.

### Numerical and streaming outcomes

SOCRATES oracle: CelesTrak's committed **2026-03-10** snapshot in
`tests/fixtures/socrates/`. Source/model context:
[SOCRATES Plus](https://celestrak.org/SOCRATES/) and
[Vallado et al., AIAA 2006-6753](https://celestrak.org/publications/AIAA/2006-6753/).
Comparisons use TEME/UTC with unchanged bounds **0.010 s / 5 m / 5 m/s**.

| Pair | TCA error (s) | Miss error (m) | Speed error (m/s) |
| --- | ---: | ---: | ---: |
| 61721–67298 | 0.000724 | 4.177554 | 0.100 |
| 47935–49179 | 0.000322 | 0.303 | 0.304 |
| 48282–58288 | 0.000282 | 0.131 | 0.478708 |

All three events are found with zero extras in every required runtime/worker
combination. Maximum errors are **0.000724196434 s / 4.177554293 m /
0.478707505 m/s**. The runtime receipt records unrounded values and per-runtime
hashes.

Other measured results:

- Centered isotropic covariance Pc: **0.00498752080731768**, absolute bound
  **1e-12**, LAAS_2015 actual algorithm. Oracle is the
  [NIST Rayleigh CDF](https://www.itl.nist.gov/div898/software/dataplot/refman2/auxillar/raycdf.htm),
  with radius 10 m and sigma 100 m; this is not a maximum-Pc comparison.
- Independent linear encounter through compact OEM, verbose OEM and PPE:
  **10 s TCA, 100 m miss, 100 m/s speed**, retained bounds
  **0.01 s / 0.001 m / 0.001 m/s** in GCRF/UTC.
- Resident sampled prepare/screen/destroy/stale-handle rejection passes in
  browser, native WasmEdge and Docker WasmEdge. Four sources/two primaries
  produce **five** eligible pairs, including their primary–primary pair.
- **136** valid events drain as **128 + 8**, cap 1, sequences 0/1. Adding a
  finite but overflowing source produces **153 attempted / 17 failed** pairs,
  retaining those 136 events with explicit final failure status.
- The 1,200-object input consumes all records and accounts for **719,400** pairs
  with zero failed pairs and bounded output. Native interpretation took about
  **44.2 s**. The old machine-specific 8 s assertion was replaced with computable
  counts/output limits as requested; no numerical tolerance was widened.
- Checked-in Aerospace real-window suite: **6/6**, **21/21** recalled,
  max miss error **2.5440 m** within its existing 5 m regression envelope;
  four hard anchors remain below **0.1 m**. The fixture explicitly preserves
  its pre-migration millisecond input timestamps. The general parser preserves
  full source precision. A full-microsecond diagnostic gave max **0.7159 m**,
  but one old anchor moved to **0.206667 m**; that diagnostic does not replace
  the unchanged-input regression gate or establish new accuracy claims.

## Faithful profile limits and remaining debt

- Published **OCM 1.220.0** lacks trajectory reference-frame and state-unit
  declarations. It is rejected explicitly; OEM/PPE provide the typed track
  path. No downstream IDL or invented metadata was added.
- Released CQR uses `HAS_*` presence booleans and `QUERY_SELECTION` provenance;
  the implementation follows the published bindings rather than draft spelling.
- OEM covariance interpolation is unsupported. PPE requires Cartesian
  Chebyshev records, explicit velocity coefficients and contiguous coverage.
  Sample indexes use exact Hermite evaluation; non-mean PPE indexes require
  POLYNOMIAL_ONLY. Unsupported polish/provider/control choices fail explicitly.
- Earth-fixed/cross-frame transforms need a verified FRM/EOP provider outside
  this module profile. ECEF source data is never relabeled as inertial data.
- SDK 0.8.18 exposes TAB FRAME_ID to guest request identity, but not top-level
  PIV trace ID. Concurrent draining streams must use distinct input FRAME_ID
  values; an identity must finish draining before reuse. PIV responses echo
  caller traces, and window methods maintain separate continuation state.
- Installed stock WasmEdge CLIs lack the `wasi.thread-spawn` host import.
  Verification supplies a module-local WasmEdge C API host through SDK
  launch plans, implementing the standard
  [instance-per-thread contract](https://github.com/WebAssembly/wasi-threads#detailed-design-discussion).
  Native threads share the WasmEdge executor so its atomic wait/notify queue is
  shared; each thread still owns its execution stack and guest instance.
  Browser verification serves the installed SDK worker chain in an isolated
  owner worker. This host support does not change guest bytes or physics;
  adopting it in the shared SDK is upstream debt.
- The eight large Aerospace/full-catalog SOCRATES checks still skip because
  the documented ignored `tests/data/` directories contain no datasets in
  either this worktree or the canonical data location. Skip criteria were not
  changed. Checked-in SOCRATES/Aerospace snapshots do run.
- SOCRATES maximum-Pc comparisons remain advisory and do not constitute
  independent covariance probability certification.

## Bounded improvement review

Question: What's the best next safe and deployable and accretive improvement
you could make to this plan/artifact right now, and if none exists return
NO_BETTER_OPTION?

Scores: objective impact / deployability / fail-closed safety / lineage clarity.

| Wave | Candidate | Scores | Decision |
| --- | --- | --- | --- |
| Baseline | Literal transport/build migration | 8 / 8 / 8 / 9 = 33 | Initial |
| 1 | Explicit worker failure accounting and deterministic state | 9 / 9 / 10 / 10 = 38 | Selected |
| 1 | Add local OCM metadata | 7 / 0 / 2 / 0 = 9 | Rejected: violates SDS ownership |
| 1 | New frame/EOP physics | 6 / 3 / 7 / 6 = 22 | Rejected: outside scope |
| 1 | Alternate JSON recovery artifact | 2 / 4 / 2 / 2 = 10 | Rejected: violates typed contract |
| 1 | Unrelated physics features | 2 / 2 / 5 / 4 = 13 | Rejected: outside §6.3 |
| 2 | Further scope additions | 8 / 8 / 9 / 9 = 34 | Rejected: no improvement over selected baseline |

Stop: `NO_BETTER_OPTION`. Selected improvement: explicit failure accounting and
deterministic worker state, with source, resident-pair and drain verification.

## Delivery

Commits use the owner-supplied GRAPH_PROTOCOL_GENERATION and GRAPH_GUARD_OVERRIDE
and `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. WIP checkpoints
are pushed after meaningful steps. Push only `origin tmpl/14-conjunction-cqr`;
the coordinator owns landing. Keep the worktree; do not merge into main.
