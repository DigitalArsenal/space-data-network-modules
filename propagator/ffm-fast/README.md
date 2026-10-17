# FFM Fast

`com.orbpro.ffm-fast` is a sibling implementation of **FFM-1** beside the
standard FFM module. It retains the same PRW methods and ports. FFM-1 uses
EGM2008 70×70; Sun, Moon, Venus, Mars, and Jupiter from DE440; cannonball SRP
with conical shadow; NRLMSISE-00 drag; IERS 2010 solid tides and relativity;
FES2004 30×30 ocean tides; and Knocke Earth radiation with 15° elements.
All force calculations run in C++/WASM.

The force profile defines the physical model, this implementation reduces
evaluation cost, and the catalog integrator controls numerical accuracy.
`catalog.mjs` reuses the standard's PRW encoding and supplies the Fast
module's resident identity.
Its `fullForceRequest` defaults to `FAST_CATALOG_INTEGRATOR`: RK78,
relative tolerance `1e-14`, absolute tolerances encoded as `1e-14 × 1000`,
initial step 30 s, minimum 0.01 s, maximum 120 s, and 1,000,000 maximum steps.
For forward resident propagation, an initial osculating eccentricity `e >= 0.25`
and `e < 1` automatically selects RK78 with Sundman `alpha = 1.5` instead.
The C++ policy computes the osculating orbit from the initial GCRF state and the
force model's gravitational parameter. It uses 200 transformed steps per orbit;
GTO-like states with perigee altitude below 1,000 km and apogee altitude strictly
between 30,000 and 45,000 km use 300. Altitudes use the standard Earth radius.
The normalization stays tied to the original state across weather spans.
This fixed transformed grid has no adaptive tolerance acceptance; physical-time
RK78 steps land on weather and shadow boundaries. Explicit fixed-step diagnostic
requests, backward propagation, and nonelliptic states retain standard RK78.
The qualification is the eight fixture regimes; those seeds do not establish
centimeter accuracy for every orbit in the broad eccentricity band.

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
ERFA amalgamation read-only. Only `lib/force_models.cpp` is forked; new
implementation code stays here. Sharing the ABI, models, integrators, and
runtime keeps the two modules on one contract. The fork header records its
base path and SHA-256; a changed base requires merging the standard changes.

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
at 60 s samples and defaults against native T3 truth at 60 s samples,
including four interior points of each 300 s resident segment. FIT
(`1 cm` through one day), SCREEN (`1 m`, `1 mm/s` through three days),
and improvement over the standard with the stated GPS/GEO truth floors
are required in every regime. CPU is reported separately. Standard
artifact, fork-base, fixture, and exporter hashes must match.

[Fixture documentation](tests/fixtures/README.md) gives the independent
truth settings, units, TT handling, tolerance rationale, and one-command
regeneration. The E2E prints readable tables and one final JSON record;
exit status 0 means every required check passed.

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

Fast must have the same event set as the reference. Every event whose two
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
