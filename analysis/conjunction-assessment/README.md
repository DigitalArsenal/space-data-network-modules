# Conjunction Assessment Plugin

Conjunction assessment and collision probability implemented in C++/WASM,
using the canonical SDK invoke contract and published SDS **1.231.0** records.

## Public methods and records

`plugin-manifest.json` advertises all 25 methods. Requests and results use
ordinary, verified FlatBuffers with explicit UTC times, Earth reference frames,
source provenance, probability algorithms and units.

| Methods | Input | Output |
| --- | --- | --- |
| `assess_conjunction`, `find_tca` | CQR pair request | CQR event / TCA result |
| `emit_cdm`, `emit_csm` | CQR pair request | SDS CDM / CSM |
| `alfano_max_probability`, `compute_pc` | CQR probability request arm for the method | CQR probability result arm |
| `compute_pc_from_cdm` | SDS CDM | CQR probability result |
| `parse_ephemeris` | CQR text, TIM reference epoch, optional CAT identity / CQR format | SDS OEM and CQR validation text |
| `parse_cdm_kvn`, `parse_cdm_xml` | CQR native document | SDS CDM |
| `write_cdm_kvn`, `write_cdm_xml` | SDS CDM | CQR native document |
| `screen_catalog` | CQR catalog request plus verified OMM frames | Chunked CQR catalog results, plus one OMM per object the propagator refuses |
| Three `prepare_*_screening_index` methods | CQR index request | CQR index result |
| `screen_window`, `screen_segment_window` | CQR window request | Chunked CQR catalog results, plus one OMM per object the propagator refuses |
| `coarse_grid` | CQR window request on a resident index, and a `$SCR` BLOCK of coarse steps | `$SCR` GRID: sampled states and motion bounds for the GPU pair search, plus a `$SCR` SEARCH_REPORT with the exclusions |
| `search_candidates` | CQR window request on a resident index, and a `$SCR` BLOCK of coarse steps | `$SCR` CANDIDATES found on the CPU (what `refine_candidates` takes), plus a `$SCR` SEARCH_REPORT with the exclusions |
| `search_grid` | CQR window request (its controls), a `$SCR` GRID `coarse_grid` returned, optional `$SCR` ROLES (primary, secondary, skip per object) | `$SCR` CANDIDATES in grid rows, plus a `$SCR` SEARCH_REPORT of the roles |
| `refine_candidates` | CQR window request on a resident index, optional `$SCR` CANDIDATES and EXCLUSIONS, optional `$ERM` uncertainty model | Chunked CQR catalog results, plus one OMM per object the propagator refuses |
| `destroy_screening_index` | CQR destroy request | Empty successful response |
| `version` | CQR version query | CQR version result |
| `possibility_of_collision` | `$SCR` POSSIBILITY_REQUEST: two admissible sets (finite supports with possibilities, or ellipsoidal kernels) and the combined radius | `$SCR` POSSIBILITY_RESULT: possibility and necessity of collision, miss-distance and closest-approach-time ranges |

Use the exact method names, port names and CQR arms in the manifest. Every port
names one SDS type: CQR, OMM, OEM, EOP, PRW, TIM, CAT, CDM, CSM, the screening
work products as `$SCR` (block, grid, roles, candidates, exclusions, search
report, possibility request and result) and the empirical model as `$ERM`. The
former JSON `invoke` operation envelope, Emscripten JSON exports and the
module-local tagged frames (CAU1, CAB1, CAG1, CAR1, CAC1, CAX1, CPQ1, CPR1) and
JSON reports are retired. `emit_cdm` returns a standalone `$CDM`.
Covariance-bearing events from pair assessment and catalog/window/refinement
screens carry the same builder's CDM in `CQREvent.CONJUNCTION_MESSAGE`.
Events without covariance leave that field empty.

OMM/TLE sources select the built-in SGP4 provider explicitly: the clean-room base
[`foundation/sgp4-str3`](../../foundation/sgp4-str3/README.md) (Spacetrack Report No. 3 with the corrections AIAA
2006-6753 documents), WGS-72, AFSPC mode. An OMM's elements are propagated as published, with no TLE text in
between: B* and the eccentricity keep the digits a TLE would round away, as SOCRATES propagates them
([docs/sgp4-omm-precision-2026-10-29.md](docs/sgp4-omm-precision-2026-10-29.md)). TLE text is read by the
module's own field parser (Alpha-5 numbers; checksums are not checked) and propagates exactly as the same set
given as an OMM at TLE precision. OEM compact arrays,
OEM explicit samples and Cartesian Chebyshev PPE use native track evaluation.
They do not require an external SGP4 module. JavaScript adapters preserve the
native standard records; the guest performs interpolation and physics.
Binary Cartesian OCM sources retain their declared units and frames.
Unsupported providers, frame conversions and controls fail explicitly. See the [lane handoff](../../docs/tmpl-lane-14-conjunction-cqr-handoff.md)
for the exact supported profile and remaining work.

## Ephemeris input

`parse_ephemeris` accepts OEM KVN, Modified ITC/MEME, JSpOC, UTC and NASA
text. Autodetection checks CCSDS headers, UTC field headers, the JSpOC report
header, NASA's initial two-digit-year epoch, then Modified ITC. OCM text is
reserved for S2; XML is unsupported. Supply an explicit UTC reference epoch.
Validation requires six future states, a 42-second to under-21-day span,
WGS-84 surface clearance, speed ≤70 km/s, supported frames/UTC, and complete
PSD covariance when any is supplied. ITRF screening requires `$EOP` records
on `earth_orientation`; without them it fails with `eop-required`.
See [ports, options, validation codes and EOP conventions](docs/ephemeris-input.md).

### Uncertainty and probability

The covariance-based default `FOSTER-2D` is the adaptive Gaussian disk integral.
The former constant-density formula is explicit-only as
`PC2D-SMALL-HBR-APPROX`. See [Pc methods and validation](docs/pc-methods.md)
for covariance repair, shape-conditioned maxima, Frisbee, usage diagnostics,
full-state fallbacks, and output-format limits. The historical no-covariance
spherical value is an approximation, not a bound for arbitrary covariance
shapes.

Uncertainty availability is independent of probability-method success. Slow
encounters retain their supplied covariance and valid 3-D Mahalanobis metric;
an unavailable or unrepresentable CQR probability is omitted, with the actual
method/result or failure reason carried by the embedded CDM. No surrogate
plane variances or zero-valued Mahalanobis measurements replace missing math.

Full-state usage violations follow a validated 2D-Nc → 3D-Nc → sampled Pc
cascade. Numerical convergence and encounter applicability are checked
separately, and the CDM records rejected stages and the observation interval.
`node tests/ncCascade.e2e.mjs` runs the published CARA references, analytical
escalation cases and the same artifact through browser WASI and WasmEdge.
Sphere flux uses published Lebedev/Laikov rules with independent convergence
checks and product quadrature refinement where required. A 3D-Nc evaluation is
bounded (2^30 sphere-point flux evaluations at 2^16 epochs) and stops, by name,
at an epoch whose Hall peak-overlap solve does not converge, as it can for a
needle covariance (along-track sigma hundreds of km); the cascade then samples
(docs/pc-methods.md). `node --test tests/pcElongatedCovariance.e2e.mjs` checks
the bound, the named refusals and byte identity with the previous integral.
Sampling remains SDMC-style two-body propagation; high-fidelity BFMC is not
implemented.

No uncertainty is invented. A TLE or SGP4 element set carries no covariance:

- events report the historical spherical small-HBR statistic (`ALFANO_MAXIMUM`,
  `MAXIMUM_PROBABILITY_ONLY`) and its dilution threshold, and no RTN sigmas,
  unless both sources supplied covariance;
- a covariance method (Foster, Patera, Chan, Alfriend, Alfano 2005, Laas) runs
  only on supplied covariance (`SUPPLIED_COVARIANCE`): `compute_pc`,
  `compute_pc_from_cdm`, or the sources' own. OEM covariance lines and OCM
  `COVARIANCE_DATA` are read with their declared axes: RTN (`RSW`) or the
  source's state frame; OEM ITRF covariance can also be transformed with EOP.
  Other unsupported combinations fail with `covariance-frame-mismatch`.
  Each element is interpolated linearly to the TCA between the bracketing
  epochs; a TCA outside them leaves that spherical statistic. Such events state
  `SOURCE_EPHEMERIS`, `INDEPENDENT` errors, and `CALIBRATION` `Calibrated`
  (with both references) only if both OCMs say `COV_CALIBRATION Calibrated`;
- CDMs in ITRF are evaluated in the non-rotating frame aligned with ITRF at
  TCA (v + w x r); the probability is invariant under the common rotation, so
  no EOP enters. Orekit's real-CDM vectors reproduce to 1e-9
  (`test_pc_methods`);
- FlatBuffer CDMs retain each source's supplied covariance. Missing covariance
  blocks are omitted. Missing or non-PSD covariance, or a failed Pc calculation,
  leaves Pc absent with a COMMENT explaining why. A computed Pc of zero is
  written. `compute_pc_from_cdm` refuses missing covariance
  (`covariance-unavailable`).
- The KVN/XML writers enforce CCSDS 508.0-B-1. They refuse missing covariance
  (`cdm-covariance-required`) and uncatalogued objects
  (`cdm-object-uncatalogued`), returning no document. A NORAD identifier or an
  all-digit source `OBJECT_ID` supplies the SATCAT designator. CDM states from
  TEME evaluation are transformed to EME2000 in C++ with ERFA; event states
  retain TEME. GCRF and EME2000 evaluations retain their frames in the CDM.
  The TEME conversion rotates position and osculating inertial velocity as
  vectors at TCA, preserving the RTN covariance and relative RTN data. The
  E2E compares both vectors against Orekit (200 m and 0.2 m/s tolerances).
  Text uses uppercase values, UTC creation time, unique message identifiers,
  standard keyword order and units, and available OD quality fields.
  Covariance provenance and calibration appear in each object's metadata
  comments; model covariance is `DEFAULT`, source covariance `CALCULATED`.
  Partial object covariance remains available internally, but cannot be
  exported as conformant text until both covariance blocks are available.
- **Empirical model.** Element sets can take covariance from an empirical
  prediction-error model: `analysis/gp-error-model`, scaled and gated by its
  calibration. `scripts/uncertainty-model.mjs` writes the model as the
  `uncertainty_model` record (`$ERM`, MODEL arm: regimes and age bins, and per
  stratum the RTN covariance with its CALIBRATION and reference). An `$ERM`
  model gp-error-model emits is passed through.
  - **Where:** `emit_cdm`, `assess_conjunction`, `screen_catalog`, `screen_window`,
    `screen_segment_window` and `refine_candidates`, with a covariance
    `ALGORITHM`.
  - **How:** for an event between two element sets with no supplied
    covariance, each object's covariance comes from the stratum of its regime
    (mean altitude and eccentricity) and prediction age (TCA minus epoch).
    The covariance method's probability follows.
  - **Labels:** `SYNTHESIZED_COVARIANCE`, `EMPIRICAL_MODEL` for both objects,
    and `INDEPENDENT`. `CALIBRATION` is `Calibrated`, with the gate's
    reference, only when both strata passed the calibration gate; otherwise
    it is `Uncalibrated`.
  - **Fallback:** outside the model (a negative or too-old age, or a stratum
    it lacks), the event keeps the spherical small-HBR statistic.
  - **Fast paths:** with the frame, the element-set screens (fast catalog
    path, resident index, refinement) accept a covariance method.
  - **Historical cost, before the adaptive-integral default:** the 3-day
    full-catalog CPU screen (32,514 objects, Node, 27
    threads) found the same 294,544 conjunctions.
    - Refinement took 7.8 s instead of 7.0 s; the run took 19.6 s end to end
      instead of 18.5 s.
    - With the 2026-08 model, 289,455 events got a covariance probability and
      13,734 are calibrated: both objects in LEO 600–800 km at a passing age.
    - `scripts/run-all-vs-all-cpu.mjs --algorithm FOSTER --uncertainty-model <frame>`.

Each event reports both objects' hard-body radii and where each came from
(`PRIMARY/SECONDARY_HARD_BODY_RADIUS_M`, `*_RADIUS_BASIS`), and
`COMBINED_RADIUS_M` is their sum. A pair request gives the radii itself
(`SUPPLIED`). In a screen, each source's radius is its `HARD_BODY_RADIUS_M`
(`SUPPLIED`), else half its catalog entry's `SIZE` (`CATALOG_SIZE`), else
`sqrt(RCS / pi)` (`RADAR_CROSS_SECTION`, a radar measure rather than a size),
else half the request's `COMBINED_RADIUS_M` (`REQUEST_DEFAULT`). Events also
state each object's covariance basis: `NONE` until a source supplies one or the
empirical model applies.

See the Evidence-Supported ASO Catalog whitepaper, sections 5, 9 and 16.2.

`signCdmOutput(...)` remains a Node.js host utility for signing emitted CDM bytes and
provenance. It does not perform conjunction calculations.

### Screening admissible trajectories (possibility and necessity)

`possibility_of_collision` screens two admissible sets by possibility and
necessity (whitepaper section 12; TEAG, Jah 2026, Remark 3.7). With finite
supports (for example the ESPF support points of `analysis/estimation`, with
their possibilities), a pair collides when its rectilinear closest approach
within a window around the common epoch is within the combined hard-body
radius; a pair's joint possibility is the smaller of the two (non-interactive
objects); the possibility of collision is the largest joint possibility of a
colliding pair, and its necessity is one minus the possibility of the
complement. With ellipsoidal sets carrying Gaussian-shaped possibility kernels,
the relative kernel is bounded from outside by the minimum-trace ellipsoid of
the Minkowski sum (conservative) and evaluated in the encounter plane at the
nominal closest approach, the short-term assumptions of Foster's probability.
Possibility and necessity are not collision probabilities, and finite
supports screen only the encounters they sample. The request and result are
`$SCR` records (POSSIBILITY_REQUEST, POSSIBILITY_RESULT); the evaluation
is in `src/cpp/src/possibility_screening.cpp`, which uses the TEAG primitives
of `analysis/estimation/src/teag.hpp`. Authority:
`tests/possibilityScreening.test.mjs` (definitions on a constructed support,
the encounter-plane closed forms, a brute-force disk search, monotonicity).

## Build and runtime contract

```bash
npm ci
export PATH="$HOME/.wasmedge/bin:$PATH"
node build.mjs
```

The public SDK compiler generates the bridge and embedded PLG manifest. Its
`emscripten-pthreads` vocabulary value selects `wasm32-wasip1-threads -pthread`.
The artifact imports `wasi.thread-spawn`, exports `wasi_thread_start`, and uses
shared memory without Emscripten worker hooks. Runtime targets are `browser`
and `wasmedge`; direct and command invoke surfaces are advertised.

The single primary artifact is `dist/isomorphic/module.wasm`. Its canonical
exports include `plugin_alloc`, `plugin_free`, `plugin_invoke_stream`,
`plugin_get_manifest_flatbuffer` and `plugin_get_manifest_flatbuffer_size`.
Bindings regenerate from the installed published SDS package during every build;
`dist/build-provenance.json` records source/schema hashes and thread features.

In browsers, run the module inside an owner Worker on a cross-origin isolated
page so synchronous WASM atomic waits are available. Bundled hosts should serve
the installed SDK worker dependency chain and pass its directory through
`wasiThreadWorkerBaseUrl`. The public loader enables browser WASI threads by
default and accepts `maxThreads` for the SDK worker pool. The executable
`scripts/verify-cqr-browser-wrapper.mjs` demonstrates that public loading path
against the checked-in SOCRATES snapshot.

## Verification

```bash
node --test tests/sdk_compat.test.mjs
node --test tests/sgp4OmmInput.e2e.mjs      # OMM values reach SGP4 as published; TLE text = OMM at TLE precision
node --test tests/sgp4ByteIdentity.e2e.mjs   # everything without GP input answers as 0.10.0 does
npm test
npm run check:compliance
npm run test:runtime-parity
```

The last command checks the same primary bytes in real Chrome, native WasmEdge
and Docker WasmEdge with worker counts 1/2/4/8. The browser serves the installed
SDK worker chain under COOP/COEP. The installed stock WasmEdge CLIs lack the
`wasi.thread-spawn` import, so verification builds a small WasmEdge C API host
and supplies it through SDK launch plans. This host only provides threading
and transport; calculations remain in the primary WASM artifact. Host build
outputs are ignored under `.sdk-build/`.

Test hosts and scripts encode and decode CQR with flatc-wasm through
`tests/lib/cqr.mjs` (`initCqrFlatc`, `createFlatcRunner`). A plain flatc-wasm
26.1.32 `FlatcRunner` leaves each conversion's argv on its 2 MiB stack and
traps at the 1,783rd CQR encode in a process; the helper runs flatc with argv
on the heap, and `tests/pairCallsOneInstance.test.mjs` makes 10,000 pair calls
on one instance, each request encoded as it is sent.

Measured results, source references, and limitations are in the
[handoff](../../docs/tmpl-lane-14-conjunction-cqr-handoff.md). The eight large
dataset checks require the ignored files documented below; checked-in snapshots
run without those files.

Catalog results emit at most 128 events per frame (`refine_candidates`: 1024). Continue an identical request
until `FINAL_CHUNK` is true, preserving its input `FRAME_ID`. Concurrent drains
must use distinct input frame IDs because SDK 0.8.18 does not expose the PIV
trace ID to guest continuation state. Failed pairs are counted, and the final
response reports `incomplete-screening` when any evaluation failed; its message
names the failed pairs (by catalog number, else OBJECT_ID) and each one's
error, at most eight of them.

### Objects screened in part or excluded

The final chunk carries one `$OMM` per object the screening covered in part or
not at all, on the `excluded` port: an element set the propagator refuses
inside the window (below), or a sampled or polynomial source whose trajectory
covers only part of the window or none of it (after). `COMMENT` says which in a
fixed form, a sentence then its fields, instants UTC to the millisecond; these
fields will become a typed CQR record, and the COMMENT form is the contract
until then:

| Form | COMMENT |
| --- | --- |
| Refused from the window start (excluded) | `Excluded from conjunction screening; SGP4 refuses it from the window start. LAST_VALID=NONE; FIRST_REFUSAL=<ISO>; REFUSAL=<error>` |
| Refused part-way | `Screened until LAST_VALID; SGP4 refuses it from FIRST_REFUSAL. LAST_VALID=<ISO>; FIRST_REFUSAL=<ISO>; REFUSAL=<error>` |
| No coverage in the window (excluded) | `Excluded from conjunction screening; its trajectory does not cover the window. COVERAGE_START=<ISO>; COVERAGE_END=<ISO>` |
| Coverage ends inside the window | `Screened until COVERAGE_END; its trajectory ends inside the window. COVERAGE_START=<ISO>; COVERAGE_END=<ISO>` |
| Coverage starts inside the window | `Screened from COVERAGE_START; its trajectory starts inside the window. COVERAGE_START=<ISO>; COVERAGE_END=<ISO>` |
| Coverage starts and ends inside it | `Screened from COVERAGE_START until COVERAGE_END; its trajectory covers part of the window. COVERAGE_START=<ISO>; COVERAGE_END=<ISO>` |

An excluded object takes part in no pair, and `STATISTICS.TOTAL_OBJECTS` leaves
it out; an object screened in part is counted. Each is reported once per call.

#### Objects the propagator refuses

SGP4 refuses an element set once it decays ("SGP4: decayed (the radius is
below one Earth radius)", "Non-finite or decayed SGP4 state") or its
eccentricity leaves its range ("SGP4: the eccentricity leaves its range
..."). An object refused at the window's first coarse epoch is excluded from
the screening. An object refused part-way through the window is screened up
to its last valid instant: its pairs' searches end there, its conjunctions
before then are reported, and none of its pairs fails. The coarse pass finds
the refusal at a coarse epoch; a search past the last coarse epoch can meet a
refusal no coarse epoch saw, and gives its object a span the same way. The
span ends where bisection between the last valid coarse epoch (or search
instant) and the refused one, a millisecond apart, puts it. Every other pair
is screened exactly as if the object were absent.

Its record is the element set's own `$OMM`: its mean elements, Earth/TEME,
with the first two forms above. LAST_VALID is rounded down and FIRST_REFUSAL
up; REFUSAL is the propagator's error at the first refused instant. An object
refused only after the window end is screened through the window and not
reported.

#### Sampled sources covering part of the window

screen_catalog and screen_window screen each pair of sampled, OCM or
polynomial sources over its joint coverage inside the window: the search stays
inside it, a minimum within a step of a coverage edge is found, and a bracket
that refines onto the edge is not a minimum (an edge is never one). A source
whose coverage holds none of the window takes part in no pair; a pair whose
joint coverage inside the window is empty has no conjunction and no failure.
Such a source's record is an `$OMM` of its identity (OBJECT_NAME, OBJECT_ID,
NORAD_CAT_ID), Earth, its frame and UTC, with no mean elements (their fields
are zero, and MEAN_ELEMENT_THEORY is the schema's default, not a theory), and
one of the coverage forms above: COVERAGE_START rounded up, COVERAGE_END
down. A non-finite state, or samples out of order or overlapping, still refuse
the source by name when it is read. The pair methods and the tight path
(`coarse_grid`, `search_grid`, `search_candidates`, `refine_candidates`) still
refuse a source that does not cover their whole window, naming it and its
coverage.

`OBJECTS_PARSED` counts every object; `STATISTICS.TOTAL_OBJECTS` leaves the
excluded ones out, so the difference is the number of excluded records.
`PAIRS_SCREENED` and
`PAIRS_PREFILTERED` still describe the planned pair set; a pair is prefiltered
when the altitude prefilter below kept it out at every coarse step.

The altitude prefilter compares each pair's epoch perigee-apogee bands, each
widened by 50 km. Epoch bands do not bound an orbit that decays or rises across
the window, so they never drop a pair alone: every object of the request is
propagated at every coarse step, and a pair whose bands are apart is still
screened at each step where its two distances from the Earth's centre can come
within the threshold of each other inside the step's half window (the radial
gate, `|r_i - r_j| <= threshold + reach_i + reach_j`, where a reach bounds how
far a distance from the centre can move in that half window from the state's
radial rate and the natural-motion acceleration bound at the Earth's radius).
The half window is half a coarse step on either side of the step, nothing
before the window's first step, and after its last step the rest of the
window, so every time of the window lies inside the half window of the step
nearest it. Two positions within the threshold have distances from the centre
within the threshold, so a pair whose minimum is within the threshold passes
the gate at the coarse step nearest that minimum and is screened.

Each close approach within the threshold is its own event: a pair that meets
several times in a window is reported at each TCA, and an event belongs to the
window that holds its TCA. One window or consecutive windows over the same span
(on the same coarse-step grid) give the same events: the same pairs, TCAs
within the refinement tolerance, the same miss distances. `KD_TREE_CANDIDATES`
counts pairs with a coarse hit (per chunk past 10000 coarse steps) and
`TCA_REFINED` counts encounters, runs of consecutive coarse hits of one pair.
This holds for SGP4 mean-element sources screened with `ALFANO_MAXIMUM`
(`screen_catalog` and the resident source-description index).

The generic engine path (sampled or non-mean polynomial sources, primaries on
`screen_catalog`, other probability algorithms) reports every local minimum of
each pair's range within the threshold whose TCA lies in `[start, start +
duration)`. The range is sampled on an absolute 5 s grid (`k * 5 s`) reaching
one sample past each window edge. Where that sample would lie outside a
tabulated or polynomial source's coverage, the coverage edge is the sample and
the interval beside it is refined too, so a minimum just inside the start or
end of an ephemeris is found. Each sample below both neighbours is refined (the
range-rate root where the range provably has one minimum, golden section
otherwise), then settled on the representable Julian date of least range. A
window edge or coverage edge is never itself reported, and a minimum refines to
the same TCA in every window that sees it.

The pair methods (`find_tca`, `assess_conjunction`, `emit_cdm`, `emit_csm`) run
this same search for every source kind, with no range bound, and report the
window's minimum of least miss: its TCA, miss distance and probability are
those of the event `screen_catalog` reports for it. A window whose range has
no local minimum (monotonic across it, or with its minima outside it) has no
time of closest approach, and the pair methods refuse it: status 422,
`no-close-approach`. A range constant across the window to within 1 mm
(co-located objects, a formation, zero relative motion) has none either and is
refused apart, with its value: status 422, `constant-range`.
Windows that abut report each minimum exactly once; windows that overlap report
a minimum inside the overlap in each of them, with the same TCA and miss
distance, so a consumer that keeps overlapping windows removes the repeat by
pair and TCA.

`emit_csm` writes the SDS CSM, a summary of the closest approach: the objects,
days since epoch, TCA, range and relative speed, and MAX_PROB and DILUTION. A
CSM's MAX_PROB is the covariance-free Alfano maximum, and DILUTION its
dilution threshold, from the miss distance and the combined hard-body radius,
whatever the sources carry; the covariance Pc is on the CDM (`emit_cdm`). A
message the module cannot write is refused with its reason: status 400,
`cdm-build-failed` with the CDM builder's message (a TEME state that cannot
be rotated to EME2000 at the TCA), or `message-too-large` past 16 MiB.

## Continuous and distributed screening

A window's coarse grid (`coarse_grid`, f32 rows) is the catalog's index for
that window. When some objects get new orbit data, coarse_grid on an index of
just those objects gives their rows, which replace theirs in the kept grid
(`gpu/continuousScreen.mjs`, `spliceGridRows`). `search_grid` then searches
the grid with those objects as primaries: a pair is searched when one member
is a primary and neither is skipped. Each row's f32 rounding is bounded and
added to its deviation bound, so the candidates contain every pair-step
`search_candidates` finds on the same sources; with roles, a secondary whose
radius band cannot come within the threshold of a primary's band over the
block is not searched. `refine_candidates` re-tests the candidates in f64 on
an index of only the objects they name, in grid order, so each pair is
refined exactly as on the whole catalog's index.

The events of every pair with an updated member equal a full re-screen's,
and the previous screen with those pairs replaced equals the new full screen
(`tests/continuousScreening.test.mjs`; on the real catalog,
`scripts/incremental-screen.mjs`). The same roles cut a screen into work
units: the primaries in blocks, a unit's block primary and earlier blocks
skipped, so every pair is in exactly one unit (`unitRoles`).
`gpu/workUnits.mjs` names a unit's inputs by SHA-256 (module, sources, grid
blocks, roles, controls); its output does not depend on the runtime or the
thread count, so replicas compare byte for byte. The local harness
(`scripts/distributed-screen.mjs`, worker processes in
`scripts/lib/screenWorker.mjs`) assigns units by declared memory and threads,
replicates a keyed fraction, signs each answer with a PNM, and catches a
worker that alters or drops units. `scripts/operator-first.mjs` screens an
operator's fresh element sets against the index and publishes data and
results together. Measurements and limits:
[docs/continuous-distributed-screening-2026-10.md](docs/continuous-distributed-screening-2026-10.md).
Runtime parity of the resident calls (Node V8, Chrome, WasmEdge, Docker
WasmEdge, and WasmEdge ahead-of-time compiled with SDN's patches):
`npm run test:continuous-parity`.

## Catalog size and partitioned runs

One `screen_catalog` call screens its whole pair set inside the guest's linear
memory, which is at most 2 GiB. Its coarse pass keeps a record per encounter
run (a pair's consecutive coarse steps inside the coarse radius, 200 times the
threshold without a resident index) and an entry per pair it has hit, and
refines them after the pass, so what it holds grows with the square of the
object count, with the window and with the threshold: about 0.63 encounters
per pair per day over a full catalog at 5 km. A pass may hold 768 MiB of
them, counted for all its workers at every coarse step. An all-vs-all call
(over 250,000 pairs) or a `screen_window` whose pass would hold more screens
its window in chunks, as many coarse steps each as half that holds, and
reports what one pass would. A call with explicit pairs (inline primaries and
secondaries, or a catalog under 250,000 pairs) whose pass would hold more,
or one with a single coarse step that does, is refused: error
`screen-memory-limit`, message `SCREEN_MEMORY_LIMIT: ...` naming the limit, a
window that fits at the request's threshold and a threshold that fits over
its window.

Measured on the 2,000 invented LEO objects of
`tests/screenMemoryLimit.e2e.mjs` (perigee 300–1,500 km, apogee at most
2,000 km), 15 km threshold, 60 s coarse step, 1 ms refinement tolerance,
8 workers, Node V8 host:

| Window | Encounter runs | Peak guest memory | Pass | Result |
| ---: | ---: | ---: | --- | --- |
| 24 h | 4.07 M | 407 MiB | one | 1,350 conjunctions |
| 54 h | 9.12 M | 916 MiB | one | 2,938 conjunctions |
| 72 h | 12.16 M | 1,204 MiB | chunks | 3,873 conjunctions in 151 s, every one those of three 24 h calls |

Time still grows with the encounter runs a call refines.

A whole catalog screens in one pass with the pair search on a GPU
([GPU all-vs-all](docs/gpu-all-vs-all.md)). It takes any propagator's
trajectories: mean elements (SGP4) or PPE, such as HPOP's
conjunction-screening export in TDB/GCRF. `coarse_grid` and
`refine_candidates` keep sampling and refinement in the module and report
`screen_catalog`'s result. `scripts/run-all-vs-all-gpu.mjs` runs
`examples/all-vs-all-gpu` in a WebGPU browser. Three days of the full catalog take 19 s with SGP4 without a GPU (`search_candidates`, in Node; 23 s in SDN's patched WasmEdge, AOT), 21 s with the GPU, and 382–438 s with HPOP, propagation included, in time windows with one propagator per run. [docs/benchmark.md](docs/benchmark.md) runs it on another machine.

Without a GPU, screen larger catalogs with the partitioned runner,
`scripts/run-sdn-omm-partitioned-screen-catalog.mjs`, and
`--catalog-block-size B` ([partition runs](docs/celestrak-full-catalog-partitions.md)):
each invocation carries one block pair, at most `2B` objects and `B * B` pairs,
and the run screens every pair of the catalog exactly once. Size `B` so a
block pair's pass fits in one piece (`B = 1000` for one day at 5 km). The
runner's default ordered-primary mode (`--partition-size`) also screens every
pair once, but every invocation carries the whole catalog.

Authoritative numerical tests include the committed CelesTrak SOCRATES snapshot,
closed-form constant-velocity encounters, the Gaussian/Rayleigh probability
integral, and native published Orekit probability and CDM fixtures. Each
scientific fixture records its source, frame/time, units and tolerances. CMake
builds native numerical tests only; point `SDN_FLATBUFFERS_INCLUDE_DIR` at headers
matching the generated bindings before configuring.

## Local validation data map

Large validation datasets are deliberately kept outside git. Put them under
the package-local ignored test-data directory:

- `tests/data/`
- Detailed layout: `tests/data/README.md`

Place SOCRATES/CelesTrak catalog files directly under `tests/data/`:

- `socrates_current.csv`
- `socrates_full.csv`
- `socrates_maxprob.csv`
- `socrates_minrange_current.csv`
- `socrates_norad_ids.txt`
- `socrates_gp/gp_*.json`

Place Aerospace IVV archive files under `tests/data/aerospace-archives/`:

- `aerospace-archives/AerospaceIVVDataset_20251009a.tar.gz`
- `aerospace-archives/AerospaceIVVDataset_20251009a_Size_ScreeningVolumes.csv.gz`
- `aerospace-archives/IVV_Releasable_Dataset_SFSH_DiscreteHBR.csv.gz`
- `aerospace-archives/IVV_Releasable_Dataset_Spherical_DefaultHBR.csv.gz`
- `aerospace-archives/Conjunction_Screening_Testset_Users_Guide.pdf`

## Aerospace V&V dataset

The protected Aerospace dataset is intentionally not vendored here. The package
now expects the extracted dataset under this gitignored local directory by
default:

- `tests/data/aerospace-ivv/`

The tests run against that location automatically. The extracted directory placed there must contain this structure:

- `tests/data/aerospace-ivv/docs/Conjunction_Screening_Testset_Users_Guide.txt`
- `tests/data/aerospace-ivv/csv/IVV_Releasable_Dataset_Spherical_DefaultHBR.csv`
- `tests/data/aerospace-ivv/csv/IVV_Releasable_Dataset_SFSH_DiscreteHBR.csv`
- `tests/data/aerospace-ivv/csv/AerospaceIVVDataset_20251009a_Size_ScreeningVolumes.csv`
- `tests/data/aerospace-ivv/ocm/AerospaceIVVDataset_20251009/...`

If you want to keep the extracted dataset somewhere else, override the root explicitly:

```bash
export AEROSPACE_IVV_EXTRACTED_ROOT=/absolute/path/to/extracted
npm run test:aerospace
```

`AEROSPACE_IVV_EXTRACTED_ROOT` and
`CONJUNCTION_AEROSPACE_IVV_EXTRACTED_ROOT` are both supported, but the
package-local `tests/data/aerospace-ivv/` location is the default.

## Conjunction parity fixtures

```bash
npm run test:ca-parity
```

The SOCRATES tests use the primary threaded artifact through the SDK browser
direct harness. The snapshot gates event-set recall, TCA, miss distance and
relative speed. Maximum-Pc comparisons remain advisory.

The Aerospace fixtures include synthetic linear encounters with analytic
answers; they are not real Aerospace validation data. Published OCM records with
no frame/unit declaration fail explicitly. Real-data tests retain their existing
data requirements and skip only when the documented datasets are unavailable.
Tolerance definitions live in `tests/lib/caParityTolerances.mjs`; historical
context is retained in `docs/a2.8a-ca-parity-ground-truth.md`.

## Hosted-runtime example

`tests/fixtures/hosted-runtime/conjunction.single-plugin.flow.json` binds a
manual trigger to `screen_catalog` on the typed `request` port. Hosts submit CQR
catalog requests and drain yielded responses without changing the request or
its trace/stream identity. The final chunk reports failure counts/status when
pair evaluation is incomplete, and lists the objects the propagator refuses on
`excluded`.

## License

MIT.
