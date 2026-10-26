# FFM against other full-force propagators: speed

FFM (Full Force Model) is defined in [the FFM profile](../../../FFM.md).

FFM and five open full-force propagators run the same cases on one machine
(Mac Studio M3 Ultra, 28 logical CPUs). The cost of each case is CPU seconds
per object-day, always with the integrator, tolerance and largest step. Its
accuracy is the largest 3D position difference over 3 days from FFM's
converged run. Results: `results-2026-10-26.json`. FFM is com.orbpro.ffm
2.0.0 at modules 9cc55924, the shipped `dist/isomorphic/module.wasm`, in the
SDK browser harness (Node.js 25, V8). The other engines were measured on
2026-10-25 with the same plan, inputs and settings.

| Engine | Version | Runtime |
| --- | --- | --- |
| Orekit | 13.1 (Hipparchus 4.0.1) | Java 25 |
| GMAT | R2026a | GmatConsole |
| Tudat | tudatpy 1.0.0 | native kernel |
| Nyx | nyx-space 2.6.0, ANISE 0.10.6 | Rust release build |
| Basilisk | 2.12.0 | native modules |

STK (HPOP), FreeFlyer and ODTK are not installed or licensed on this
machine, so no figures are given for them.

## Cases

- **Orbits:** the five cross-validation orbits (LEO400, SSO700, GPS, GEO,
  MOLNIYA) from their GCRF states at 2026-08-02 00:00 UTC, for 3 days with
  hourly samples.
- **Inputs:** the same constants, the FFM-embedded EGM2008 coefficients,
  DE440, IERS finals rows and constant space weather (F10.7 150, Ap 15) for
  every engine.
- **FFM1 force tier:** FFM-1 on the benchmark spacecraft. Only FFM and Orekit
  model all of it. Orekit gets FFM's drag cutoff at 2,500 km and its default
  tide caches.
- **COMMON force tier:** EGM2008 70x70, Sun and Moon, cannonball radiation
  pressure with a conical shadow, and NRLMSISE-00 drag on LEO400 and SSO700.
  Every engine runs it.
- **Integrators:**
  - `fixed-30s`: eighth-order Runge-Kutta at a fixed 30 s step, which is
    identical work.
  - `tol1e-12-max300s` and `tol1e-14-max120s`: relative tolerance, absolute
    tolerance r x 1000 (m, m/s), and the largest step.
- **Error norms differ by engine:**
  - FFM and Tudat: the largest component.
  - Orekit: root mean square.
  - GMAT: RSSState.
  - Nyx: RSSCartesianState.

  Each row therefore also reports the engine's own integration error.

## Results, LEO400 / GPS, one thread (CPU-s per object-day)

| Tier | Engine and integrator | fixed 30 s | rel 1e-12, max 300 s | rel 1e-14, max 120 s |
| --- | --- | --- | --- | --- |
| FFM1 | FFM RKDP87 (RK8(7)13M) | 0.31 / 0.22 | 0.26 / 0.035 | 0.48 / 0.065 |
| FFM1 | FFM RK78 (Fehlberg) | | 0.14 / 0.033 | 0.21 / 0.062 |
| FFM1 | Orekit DormandPrince853 | 4.60 / 2.96 | 2.25 / 0.30 | 4.07 / 0.71 |
| COMMON | FFM RKDP87 | 0.29 / 0.19 | 0.24 / 0.023 | 0.42 / 0.052 |
| COMMON | FFM RK78 | | 0.14 / 0.023 | 0.20 / 0.050 |
| COMMON | Orekit DormandPrince853 | 1.26 / 0.86 | 0.64 / 0.10 | 1.16 / 0.26 |
| COMMON | GMAT PrinceDormand78 | 1.31 / 1.12 | 0.92 / 0.12 | 6.05 / 0.29 |
| COMMON | Tudat rkdp_87 | 2.53 / 2.18 | 2.12 / 0.22 | 4.09 / 0.56 |
| COMMON | Nyx DormandPrince78 | 1.01 / 0.75 | 0.70 / 0.076 | 1.26 / 0.19 |
| COMMON | Basilisk RKF78, task = step | 0.49 / 0.49 | 0.23 / 0.050 | 0.47 / 0.12 |

Per force evaluation, from the fixed 30 s runs (LEO400):
- FFM: 8.8 us for FFM1 and 8.3 us for COMMON.
- Orekit: 105 us for FFM1 and 28.8 us for COMMON.

Position differences from FFM over 3 days:
- Orekit, FFM1 at the tightest setting:
  - LEO400 0.20 m;
  - SSO700 0.02 m;
  - GPS and GEO under 1 mm;
  - MOLNIYA 0.32 m.
- Tudat: 0.3 to 0.5 m in LEO, under 1 mm on GPS and GEO.
- GMAT: 20 to 71 m in LEO. R2026a's NRLMSISE-00 omits anomalous oxygen
  (`../gmat/anomalous-oxygen.json`). GPS and GEO agree to under 2 mm.
- Nyx: 95 m on LEO400, from its NRLMSISE-00 port
  (`../../../docs/cross-validation.md`); 6 mm on GPS.
- Basilisk: kilometers. Basilisk computes the environment (Earth orientation,
  ephemerides, shadow, density) once per task, holds it across the task, and
  extrapolates the orientation linearly. At a 2 s task it costs 6.5 to
  7.5 CPU-s per object-day and is 2.2 m off on GPS.

## Results, all threads and the catalog

26 concurrent copies of LEO400 at rel 1e-12, max 300 s (CPU-s per
object-day):

| Engine | Tier | CPU-s per object-day |
| --- | --- | --- |
| FFM RK78 | FFM1 | 0.18 |
| Orekit, one JVM per copy | FFM1 | 2.76 |
| FFM RKDP87 | COMMON | 0.30 |
| Orekit | COMMON | 0.72 |
| GMAT | COMMON | 0.99 |
| Tudat | COMMON | 2.66 |
| Nyx | COMMON | 0.85 |
| Basilisk | COMMON | 0.27 |

Whole catalog: the 32,522 objects of the 2026-10-04 Space-Track snapshot,
each from its element-set epoch over 2026-10-05 to 2026-10-08, FFM-1 forces,
26 cores.

- **FFM, measured:** 419 s wall, 8,815 CPU-s, 0.090 CPU-s per
  object-day, 233 object-days per second.
  - The path is the shipped resident one, GJ8 PEC with Sundman RK78 for
    e >= 0.25.
  - The cost includes catch-up from each epoch and the Chebyshev segment
    export.
- **Orekit, extrapolated by stratum** from 1,300 sampled objects run as 26
  single-thread JVMs:
  - DormandPrince853 at 1e-12 and 300 s: 2.28 CPU-s per object-day, 2.4 to
    3.3 h.
  - DormandPrince853 at 1e-14 and 120 s: 4.14 CPU-s per object-day, 4.3 to
    5.8 h.
  - One JVM with 26 threads keeps only about 7 cores busy, because its shared
    frame caches lock.
- **The 1,300 sampled objects, measured on 26 cores:**
  - FFM: 22.5 s wall, 0.084 CPU-s per object-day, with catch-up and export.
  - Orekit DormandPrince853: 356 s wall and 1.72 CPU-s per object-day at
    1e-12 and 300 s; 656 s and 3.27 CPU-s per object-day at 1e-14 and
    120 s. These Orekit figures count propagation only.

## Reproduce

`plan.mjs <work>` writes the cases (`plan.json`, `plan.tsv`) and the
coefficient files. Then each driver writes `<engine>.json` into `<work>`:

```sh
node tests/evidence/engines/run-ffm.mjs <work>
java -cp "<orekit jars>/*" tests/evidence/engines/OrekitBench.java <orekit-data> <work> <work>/orekit.json single
node tests/evidence/engines/run-gmat.mjs <GmatConsole> <work>
<tudat python> -I tests/evidence/engines/run-tudat.py <work>
cargo build --release --offline --manifest-path tests/evidence/engines/nyx/Cargo.toml
node tests/evidence/engines/run-nyx.mjs <nyx binary> <work> <pck08.pca> <earth_latest_high_prec.bpc>
<basilisk python> -I tests/evidence/engines/run-basilisk.py <work>
node tests/evidence/engines/score.mjs <work>
```

- `parallel.mjs` runs N copies of any driver command.
- The catalog run uses three scripts and one Orekit mode:
  - `catalog-environment.mjs` writes the environment frames;
  - `catalog-states.mjs` writes the sampled initial states;
  - `OrekitBench.java ... catalog` runs Orekit on them;
  - `catalog-score.mjs` extrapolates by stratum.
- FFM's catalog run is `scripts/benchmark-catalog.mjs`.
- `resident-ab.mjs` is the E2E of each speed change: candidate against
  baseline on the resident path.
- `e2e.mjs` checks the harness on FFM alone.
