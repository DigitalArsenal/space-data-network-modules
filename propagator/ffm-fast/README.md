# FFM Fast

`com.orbpro.ffm-fast` is a sibling implementation of **FFM-1** beside the
standard FFM module. It retains the same PRW methods and ports. FFM-1 uses
EGM2008 70×70; Sun, Moon, Venus, Mars, and Jupiter from DE440; cannonball SRP
with conical shadow; NRLMSISE-00 drag; IERS 2010 solid tides and relativity;
FES2004 30×30 ocean tides; and Knocke Earth radiation with 15° elements.
All force calculations run in C++/WASM.

The force profile defines the physical model. Fast selects its resident
integrator from the initial GCRF Cartesian state in C++, with no user mode
flag. The public PRW encoding and force models remain the standard's.

Forward elliptic states with eccentricity below 0.25 use GJ8 PEC. For LEO
(apogee below 2,000 km), perigee bands below 300, 450, and 650 km use 10, 15,
and 12 s steps respectively; higher LEO uses 24 s. Near-circular states
(eccentricity below 0.05) with periods strictly inside 600–800 minutes use
75 s, and those inside 1,400–1,480 minutes use 600 s. Other low-eccentricity
elliptic states use a conservative 24 s grid. Altitudes use the standard
Earth radius. These are physical-state bands, never catalog identifiers.
The GPS/GEO grids tighten the study candidates. Qualification must retain
the existing 0.1 mm comparison floor against standard as well as FIT/SCREEN.

GJ nodes share an absolute TT lattice anchored at UTC midnight. An initial
tight RK bridge spans at most one step. Nine history states survive normal
midnight restarts: their force ordinates are rebased onto the new daily
weather/calendar branch. NRLMSISE-00 uses daily Ap; three-hour restarts are
trimmed only with winds disabled. Other models retain their driver breaks.
Shadow geometry is scanned for multiple crossings and grazes, the conical
SRP impulse and first moment are corrected, and corrected paths are rescanned
transactionally. Dense output evaluates fresh physical acceleration at the
corrected state, separately from the PEC predictor ordinate.

Initial eccentricity from 0.25 through less than 1 selects RK78 with Sundman
alpha=1.5 and 200 transformed steps per orbit. GTO-like states with perigee
below 1,000 km and apogee strictly between 30,000 and 45,000 km use 300.
Its normalization and transformed grid persist across weather spans;
physical RK steps land on predicted/verified shadow and weather boundaries.
This transformed grid and GJ use fixed-step numerical policies, not adaptive
tolerance acceptance. Explicit fixed-step diagnostics, backward requests,
nonelliptic states, unsupported GJ force families, and insufficient extra
startup coverage retain standard RK78. If artificial GJ startup history
crosses the reentry surface, RK resumes from the last accepted physical
state and exact epoch; a stop on the physical trajectory remains a failure.
GJ also hands off to adaptive RK before approaching reentry: below the
equatorial Earth radius plus 150 km, RK uses a maximum two-second step.
The 50 km buffer conservatively encloses the geodetic 100 km stop surface;
it changes the numerical integration policy, not the physical stop altitude.
The handoff preserves the accepted state, exact span clock, and remaining
step budget. This prevents a fixed GJ grid from continuing a shallow
atmospheric crossing that the reference resolves as reentry.
GJ currently supports cannonball
conical SRP without ECOM2, and NRLMSISE-00 drag without winds (or either
force disabled). The shared variational/covariance execution path is unchanged.

Selected-object preparation groups at most 32 peers by grid and visits the
early physical nodes first. Fitting and trimming remain interleaved, including
catch-up before the requested window; unselected objects are never advanced.
The original epoch remains authoritative for requests that move backward in
time or behind retained segments.

`FAST_CATALOG_INTEGRATOR` supplies RK fallback settings: tolerance `1e-14`,
initial step 30 s, minimum 0.01 s, maximum 120 s, and 1,000,000 steps.
Qualification covers the fixture regimes and explicit edge cases; those
samples do not establish centimeter accuracy for every possible orbit.

There is one FFM Fast mode. `CATALOG_INTEGRATOR` aliases the same default
as `FAST_CATALOG_INTEGRATOR`; no separate accuracy profile is exposed.
The E2E requires FIT (1 cm through one day) and SCREEN (1 m and 1 mm/s
through three days) in all eight regimes.

## Implementation and historical measurements

- **C1:** Same-degree Pines gravity with tables for each degree/order,
  triangular V/W storage, folded constants, and four accumulators.
- **C4:** Retained gravity scratch, tide fields filled in place, and 64
  preallocated ocean nodes with the standard's farthest-node eviction rule.
- **C3a:** Rotation, UT1, and body states are memoized within one force
  evaluation; the memo expires at the end of that call.
- **C2:** Solid and ocean tide coefficients merge into the gravity field
  for one rotation and recursion. Solid tides share the 120 s TT ocean grid
  and its cubic weights; differing GM/radius fields use the general scale.
- **C3c:** Degree-12 Chebyshev windows cover 3600 s, align to TT hours, and
  split at UTC midnight. Rotation/UT1 use realized TT, ephemerides use TDB,
  ocean nodes retain their 120 s TT grid, and weather remains exact.
- **C7:** `-msimd128` applies to compilation and linking through the small
  driver that delegates to the standard build driver.

Cross-evaluation tide and window caches belong to the force set's
`OceanTideCache`, shared by its resident objects. Without that cache, tides
and time inputs use the exact path. The standard's other configurations,
finite burns, and STM/variational implementation remain available.

The measurements below are historical, from before the standard clock/frame
changes and the current accuracy gates. They isolate the cumulative force
levers against their recorded standard artifact; they are not current
phase acceptance or full-catalog timing evidence.
Errors are maxima over all eight seeds through three days, with identical
request bytes and fixed 60 s RK78 steps at tolerance 1. CPU uses the resident
ingest → prepare → describe path, `process.threadCpuUsage`, interleaved
standard/fast runs, and the minimum of two repetitions. Both sides use
`1e-12` for these lever rows. ISS illustrates the CPU gain; every seed's
CPU, one-day errors, repetitions, and load averages are in
[docs/levers.json](docs/levers.json).

| Through lever | Position error, m | Velocity error, m/s | ISS CPU s/day, standard → fast | Speedup |
| --- | ---: | ---: | ---: | ---: |
| C1 | 1.182e-5 | 1.334e-8 | 0.779399 → 0.457328 | 1.70× |
| C4 | 1.182e-5 | 1.334e-8 | 0.780272 → 0.454413 | 1.72× |
| C3a | 1.182e-5 | 1.334e-8 | 0.809364 → 0.382210 | 2.12× |
| C2 | 3.080e-5 | 3.614e-8 | 0.806053 → 0.321369 | 2.51× |
| C3c | 4.430e-5 | 3.607e-8 | 0.800770 → 0.288506 | 2.78× |
| C7 | 4.430e-5 | 3.607e-8 | 0.837501 → 0.269390 | 3.11× |

C4, C3a, and C7 each add zero error: their fixed-step outputs are
byte-identical to the preceding lever for all eight seeds. CPU measurements
include the recorded host load.

The historical default-profile run used standard `1e-12 / 300 s` and Fast
`1e-14 / 120 s` with a 30 s startup. It passed the then-required SCREEN
gate, but did not meet today's required FIT gate in MOLNIYA and GTO.
The historical maximum three-day errors were 0.301978266 m and
0.000268837 m/s (GTO). The CPU table below belongs to that run.

| Seed | Standard CPU s/day | Fast CPU s/day |
| --- | ---: | ---: |
| ISS | 0.757455 | 0.389544 |
| STARLINK | 0.704225 | 0.352538 |
| SSO800 | 0.706017 | 0.339372 |
| LOW250 | 0.875150 | 0.478713 |
| GPS | 0.187124 | 0.105698 |
| GEO | 0.175001 | 0.102681 |
| MOLNIYA | 0.233321 | 0.123987 |
| GTO | 0.264101 | 0.134355 |

The study's `harness/catalog_weight.py` maps the 2026-09-30
`map/regimes.txt` population of 32,514 objects to these seeds: ISS 1,837;
STARLINK 14,489; SSO800 11,602; LOW250 163; GPS 857; GEO 1,841;
MOLNIYA 1,255; GTO 470. Weighted cost is
`sum(seed count × measured CPU s/day) / 32514`.

In those historical runs, the 120 s cap cost
**0.317933824 CPU s/object-day**, versus
**0.323130420** for 300 s at the same `1e-14` tolerance: a measured
**-1.61%** change. For one catalog-day, those weighted estimates
are **10337.30 versus 10506.26 CPU s**; for three days,
**31011.90 versus 31518.79 CPU s**. The paired standard
in the 120 s run costs 0.640595282 CPU s/object-day
(2.01× the fast cost). These are serial CPU estimates from separate
seed runs. The paired standard also changed from 0.666562529 to
0.640595282 s/object-day between runs. Dividing each fast cost
by its paired standard cost gives a **+2.38%** normalized
120 s versus 300 s change; raw timings include between-run variation.

The historical defaults, the 300 s comparison, population counts, source
hashes, and both runs' load averages are recorded in `docs/levers.json`.
The current integrator defaults are authoritative in `catalog.mjs`.
All six lever measurements retain the standard `1e-12 / 300 s` settings.

## Shared sources and build

`standard.mjs` identifies the standard source directory. The build compiles
its unchanged sources, committed generated headers, third-party code, and
ERFA amalgamation read-only. Fast forks `lib/force_models.cpp`, the resident
dynamics source/header, and the plugin source that routes selected-object
preparation. `forks.mjs` lists these four files and authenticates each base
path and SHA-256; a changed base requires merging the standard changes.
New implementation code stays here. Sharing the ABI, models, standard RK
integrator, and runtime keeps the two modules on one contract.

From the repository root, with dependencies provisioned:

```sh
cd propagator/ffm-fast
# Set SDN_LOCAL_EMSDK_DIR to the provisioned repo-local emsdk directory.
node build.mjs
```

The build uses local LLVM directly, keeps generated files under `.sdk-build`,
and checks that the standard tree and artifact stayed unchanged. It produces
`dist/isomorphic/module.wasm`, the matching browser adapter/artifact, the
manifest, and provenance with source hashes and compiler flags.

## One E2E

From `propagator/ffm-fast`:

```sh
node scripts/e2e-ffm-fast.mjs
```

Node 24.6 or newer runs both artifacts with the SDK's
`createBrowserModuleHarness` in Node. The E2E covers ISS, STARLINK, SSO800,
LOW250, GPS, GEO, MOLNIYA, and GTO for three days from
`2026-08-01T12:00:00.000000` UTC, in GCRF. It checks fixed-step agreement
at 60 s samples and defaults against native T3 truth at 10 s samples plus
every native stop, including eccentric perigee refinement. Both direct
resident dense-state queries and exported PPE are scored. FIT
(`1 cm` through one day), SCREEN (`1 m`, `1 mm/s` through three days),
and improvement over the standard with the stated GPS/GEO truth floors
are required in every regime. CPU is reported separately. Standard
artifact, fork-base, fixture, and exporter hashes must match.

The same E2E checks mixed epochs, selected subsets, midnight transitions,
forward/backward windows, and carried/fresh serialized trajectory agreement.
C++ generates states on both sides of the automatic regime thresholds and
penumbra-only graze candidates; unchanged standard T3 trajectories verify
their accuracy and independently confirm the realized grazing geometry.
An ascending state just above the reentry surface checks startup fallback
after a nonzero alignment bridge against the same standard T3 forward arc.
A descending state at three fractional epochs checks the valid exported arc,
the GJ-to-RK handoff clock, and a named reentry failure without a trajectory.
Its stop must agree within 2.1 s with the two-second-capped T3 reference;
this stop-resolution check is separate from the unchanged 1 ms CA gate.

[Fixture documentation](tests/fixtures/README.md) gives the independent
truth settings, units, TT handling, tolerance rationale, and one-command
regeneration. The E2E prints readable tables and one final JSON record;
exit status 0 means every required check passed.

The initial Phase 2 artifact `b44011744ab1f1cc9a3babe7131799f86d063cc6e411e0b4a55e832d1aacaf15`
passed the then-current E2E on Node 25.4.0: FIT 8/8, SCREEN 8/8, 436,108 direct
dense-state samples, 28 regime-boundary cases, five independently realized
penumbra-only grazes, byte-identical batch/cold results, and startup fallback.
Maximum exported-PPE errors were 2.500 mm through one day and
39.564 mm / 0.118013 mm/s through three days. The fixed-step comparison
added at most 45.414 micrometers. Farm carry/invalidation also retained
identical output for eight sources in each implementation, including
compaction, deletion, and repopulation.

The subsequent full-catalog run exposed one extra hourly trajectory for
NORAD 49158. Standard T3 stopped it at 2026-10-05 09:54:03 UTC, while this
initial GJ candidate continued to 10:28:40 UTC. That candidate remains
unlanded; the near-reentry handoff and extended E2E require renewed
artifact qualification and full-catalog measurements.

[Phase 2 qualification](docs/phase2-qualification.json) records all seed
and event errors, truth provenance, and raw evidence hashes. Both built
artifacts instantiated in the explicit Playwright headless shell and
native/Docker WasmEdge 0.16.4. This verifies runtime linking; it does not
establish FFM numerical parity across those runtimes. Catalog timings
recorded under CPU contention are observational and do not establish a
clean speedup. The eight seeds and selected CA events do not establish
accuracy for every orbit in the full catalog.
The separate resident-T3 versus native-T3 diagnostic did not pass its
extra-strict 1 mm / 1 micrometer-per-second thresholds (maximum three-day
differences 2.583 mm / 0.072473 mm/s). Its full result is retained in the
qualification record; it does not change the CA acceptance gate.

## Catalog acceptance

The CA farm selects `ffm` (default) or `ffm-fast`. It retains unchanged
residents across refreshes and derives only new or changed element sets.
Workers default to at most 16, reserving two logical cores. Catalog churn
compacts original epoch states when retained slabs exceed twice the live
slabs; cold/carry PPE byte agreement covers the compaction path.
The CPU CLI remains outside this change because another lane owns it; the
Fast catalog driver uses the farm library directly.

The 2,000-object, one-day comparison uses the converged T3 integrator
configuration as its oracle: standard FFM with RKF78 at relative and
km-based absolute tolerance `1e-14`, initial/max step 2 s, minimum step
`1e-4` s, and 100,000,000 maximum steps. The evidence-only adapter changes
that configuration while retaining the same farm, inputs, environment,
resident trajectory export, and CA screen. It adds no product mode or flag.
The resident pipeline retains its own segment/output scheduling; this is
not a substitution of the native truth harness's output/stop grid.

Standard and Fast must retain equal exclusion and dropped-object counts;
all three runs report their exclusion, drop, and reentry counts. Fast must
have the same event set as the reference. Every event whose two
GP prediction ages are in `[0, 8]` days must differ from the reference by
at most **1 m in miss distance and 1 ms in TCA**. Older inputs are listed
with both deltas and do not vote. Standard/reference and Fast/reference
deltas, including whether Fast is no worse on each event, are reported
side by side. The E14 sigma fractions are diagnostics only; they cannot
relax the fixed acceptance bounds. E14 is an input GP uncertainty scale,
not calibrated FFM covariance.

`e2e-farm.mjs` runs all three implementations/configurations and records
per-event comparisons. `qualify-ca-reference.mjs` can resume saved evidence
with `--baseline`, `--reference`, `--provenance`, `--catalog`, and `--out`.
It authenticates the exact source/artifact hashes, selected objects,
controls, and environment before reusing standard/Fast results. Failed
qualification evidence stays intact.

The Phase 2 comparison retained all 73 reference events and passed all 71
in-domain events. Maximum in-domain miss/TCA deltas were 0.155967 m /
0.040233 ms for Fast and 8.528437 m / 1.689792 ms for standard. All three
runs excluded zero objects and reported three dropped objects and three
reentries. Independent Python and committed JavaScript reductions agree.
Fast's miss delta was no worse than standard on 71/73 events; its TCA
delta was no worse on all 73. The two larger miss deltas were
45535:57582 (Fast 0.048659 m, standard 0.009737 m) and 31430:38262
(Fast 0.035174 m, standard 0.003217 m); both passed the fixed gate.

The two older-input events are reported without gating:

| Pair | GP ages, days | Standard miss / TCA delta | Fast miss / TCA delta |
| --- | --- | --- | --- |
| 33396:36244 | 10.011565 / 4.067585 | 2.035335 m / 0.804663 ms | 0.037166 m / 0 ms |
| 20308:22812 | 15.209352 / 4.263839 | 14.984864 m / 1.689792 ms | 0.044164 m / 0 ms |
