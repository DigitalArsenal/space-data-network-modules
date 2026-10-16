# All-vs-all benchmark on another machine

Screens a whole catalog all-vs-all over three days and checks the result
against the reference run below. Results go back as the summary JSON files.

## 1. Set up

Requires Node.js 20 or newer (tested on 25) and git. The GPU run also needs
Chrome or Chromium with WebGPU; set `SDM_CHROME_BINARY` to its path if it is
not installed in the usual place.

```
git clone https://github.com/DigitalArsenal/space-data-network-modules.git
cd space-data-network-modules/analysis/conjunction-assessment
npm ci
```

The module (`dist/isomorphic/module.wasm`) is committed; do not rebuild it.

## 2. Make the catalog

Use the full GP catalog. From Space-Track (an account is required; do not
commit or share the file, as Space-Track's terms forbid redistribution):

```
https://www.space-track.org/basicspacedata/query/class/gp/decay_date/null-val/epoch/%3Enow-30/orderby/norad_cat_id/format/json
```

Save it as `gp.json`, then:

```
node scripts/make-omm-catalog.mjs gp.json catalog.OMM.uint32be.bin
```

Without an account, CelesTrak's JSON works the same way for a smaller run,
for example `https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=json`.

## 3. Run

Start each screen at 2026-10-01T00:00Z (`--start 2461314.5`). On a different
date, pass the Julian date of a midnight within a few days of the catalog's
epochs.

```
# CPU, no GPU (Node): the main result
node scripts/run-all-vs-all-cpu.mjs --runtime node --catalog catalog.OMM.uint32be.bin \
  --start 2461314.5 --days 3 --out cpu-sgp4.json

# GPU, headless Chrome with WebGPU (skip if there is no GPU)
node scripts/run-all-vs-all-gpu.mjs --catalog catalog.OMM.uint32be.bin \
  --start 2461314.5 --days 3 --out gpu-sgp4.json

# HPOP at full force, CPU, 1-hour windows (propagation dominates; see Reference)
node scripts/run-all-vs-all-cpu.mjs --runtime node --propagator hpop \
  --hpop-environment <env dir> --catalog catalog.OMM.uint32be.bin --start 2461314.5 --days 3 \
  [--farm-workers N] [--load-ceiling L] --out cpu-hpop.json
```

The HPOP farm needs `npm ci` in `propagator/hpop` as well. `<env dir>` holds
the environment as PRW records: `kernel.prw` (a NATIVE_INPUT with JPL's
DE440s), `earth_orientation.prw` (IERS finals2000A rows) and
`space_weather.prw` (daily rows from GFZ's Kp, ap and F10.7 and SWPC's
reports), covering the oldest element epoch to the end of the screen, as
released at the screen's start. `--hpop-profile gravity-only` runs the point
mass and degree/order 20 field instead. On a shared host, report the HPOP
farm's CPU time from the summary (`hpop.cpu`, each worker thread's user and
system time) beside the wall clock; `--load-ceiling L` holds the farm's next
chunk of objects while the 1-minute load average exceeds L.

Each prints one summary line: candidates, conjunctions, excluded objects, end
to end time, and the time per stage. `--workers N` sets module threads (default:
cores − 1). Close other heavy work first, and report the 1-minute load average.

WasmEdge (`--runtime wasmedge --aot`) needs SDN's patched WasmEdge 0.16.4.
Stock 0.16.4 ahead-of-time compilation deadlocks on this module (see
[gpu-all-vs-all.md](gpu-all-vs-all.md#without-a-gpu)). Use Node unless that
build is available.

## 4. Check

- All runs on one catalog and propagator must report the same conjunctions;
  `cpu-sgp4.json` and `gpu-sgp4.json` hold them as `events`.
- Agreement with the single-call screen on a stride sample:
  `node scripts/compare-single-call.mjs <sample.OMM.uint32be.bin> 1` (keep the
  sample to a few thousand objects).
- `npm test` runs the parity suites.

## 5. Report

Return, for each run: the summary line, the summary JSON, the CPU model and
core count, the GPU (if any), the Node version, the load average, and the
catalog's source and date.

## Reference

Mac Studio, 28 cores, Space-Track GP catalog of 2026-09-30 (32,514 objects),
5 km threshold, 60 s steps, host shared with other work:

| Run | End to end | Conjunctions |
| --- | ---: | ---: |
| SGP4, CPU, Node | 19.1 s | 294,544 (25 objects excluded) |
| SGP4, GPU (Metal) | 21.3 s | 294,544 |
| HPOP at full force, CPU, Node, 72 × 1 h | 99,929 CPU-s on 8 workers: 6,383 s on 16 dedicated cores (15,210 s measured, load median 44) | 283,700 (21 objects excluded) |

The numbers of conjunctions match only for the same catalog snapshot.

## Tiered Pc, 2026-10-16

Node, 27 module workers, the same 32,514-object Space-Track GP snapshot and
3-day window above; empirical covariance from the 2026-08 scaled model and
calibration. Each completed run returned 294,544 conjunctions and 25 excluded
objects. Pc off selects `ALFANO_MAXIMUM`; Pc on selects `FOSTER` with the
`$ERM` model and Screening grade. Every run started below a one-minute load
average of 30. Load columns show `os.loadavg()[0]` at process start and end;
the E2E also records `uptime` immediately before each invocation. Times are
seconds, and total is process wall time including module startup.

| Floors, reporting / MC | Run | Pc | Total | Load stage | Search | Refine | 1-minute load, start → end |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- |
| `1e-7 / 1e-4` | A1 | off | 19.848 | 1.496 | 8.884 | 8.308 | 14.23 → 16.66 |
| `1e-7 / 1e-4` | A2 | on | 181.943 | 1.498 | 8.760 | 170.493 | 15.64 → 21.34 |
| `1e-7 / 1e-4` | A3 | off | 20.157 | 1.951 | 8.792 | 8.241 | 21.34 → 23.29 |
| `1e-7 / 1e-4` | A4 | on | — | — | — | — | 23.29 before invocation |
| `1e-7 / 1e-4` | repeat A1 | off | 19.736 | 1.490 | 8.823 | 8.256 | 6.67 → 6.14 |
| `1e-7 / 1e-4` | repeat A2 | on | — | — | — | — | 7.17 before invocation |
| `1e-4 / 1e-4` | initial B1 | off | 21.173 | 1.490 | 10.201 | 8.195 | 28.45 → 39.59 |
| `1e-4 / 1e-4` | initial B2 | on | 113.908 | 1.477 | 8.862 | 102.395 | 29.11 → 30.06 |
| `1e-4 / 1e-4` | optimized B1 | off | 20.859 | 1.815 | 9.897 | 7.964 | 19.35 → 30.82 |
| `1e-4 / 1e-4` | optimized B2 | on | — | — | — | — | 29.47 before invocation |
| `1e-4 / 1e-4` | optimized repeat B1 | off | 19.555 | 1.496 | 9.222 | 7.677 | 25.72 → 23.69 |
| `1e-4 / 1e-4` | optimized repeat B2 | on | 81.948 | 1.514 | 10.790 | 68.209 | 22.19 → 32.25 |
| `1e-4 / 1e-4` | optimized repeat B3 | off | 19.850 | 1.542 | 9.470 | 7.682 | 28.42 → 26.86 |
| `1e-4 / 1e-4` | optimized repeat B4 | on | 78.153 | 1.564 | 9.244 | 66.007 | 26.86 → 30.80 |
| `1e-4 / 1e-4` | clean build B1 | off | 20.540 | 1.530 | 9.909 | 7.884 | 27.71 → 34.12 |
| `1e-4 / 1e-4` | clean build B2 | on | 80.836 | 1.595 | 10.273 | 67.619 | 24.23 → 27.70 |
| `1e-4 / 1e-4` | clean build B3 | off | 20.514 | 1.552 | 9.932 | 7.856 | 27.70 → 28.17 |
| `1e-4 / 1e-4` | clean build B4 | on | 79.355 | 1.581 | 9.982 | 66.423 | 27.11 → 27.69 |

A4 and repeat A2 trapped a WASM worker in Hall integration at window 11 of
12 (`memory access out of bounds`). Their partial timings are excluded from
the table. Neither attempt supplies two completed Pc-on runs, so there is
no four-run acceptance ratio for these floors. The completed A2 Pc-on run
took 9.167 times its preceding Pc-off run.

Temporary instrumentation separated A2's refinement into preparation
0.823 s, Pc batch 154.241 s, sequential CQR/CDM construction 3.545 s,
serialization 2.750 s, JS decode 3.268 s, and other refinement work 5.866 s.
The completed run's method counts were `FOSTER-2D` 212,443,
`3D-NC-HALL` 36,585, `3D-NC-HALL-QUADRATIC-TIME` 38,899,
`SDMC-TWO-BODY` 1,528 and maximum-only 5,089. Its tier counts were valid
Foster 25,966, below-floor 186,477, 3D-Nc 75,484, Monte Carlo 1,528 and
maximum-only 5,089. Every Pc-off result was maximum-only.

Initial B2 completed all events, but four Foster disk integrations reported
an unavailable probability, failing the E2E's no-event-errors assertion.
Its refinement split was preparation 0.781 s, Pc batch 87.018 s, CQR/CDM
construction 3.222 s, serialization 2.384 s, JS decode 3.339 s and other
refinement work 5.651 s. Method counts were Foster 288,775, Monte Carlo 676
and maximum-only 5,093, including the four unavailable events. Tier counts
were valid Foster 25,966, below-floor 262,809, Monte Carlo 676 and
maximum-only 5,093. These initial A/B measurements handled 421,847
overlapping refinement candidates before emitting 294,544 distinct events.

The optimized bridge reduces prepared events from 421,847 to 294,545 before
Pc evaluation (one chunk-boundary duplicate precedes the 294,544 emitted
events) and avoids duplicating usage diagnostics in CDM object comments.
Foster's guarded positive quadrature recovers the four far-tail integrations; see
[Pc methods](pc-methods.md#tiered-probability-and-numerical-grades).
Optimized B2 trapped in the unchanged coarse-search `tight_box_pairs` path
in its first window, before Pc evaluation. Worker traps therefore also
occurred outside Hall integration.

The optimized repeat completed off/on/off/on with no event errors. Both
Pc-on runs had identical method and tier counts: Foster 288,779, Monte
Carlo 676 and maximum-only 5,089; valid Foster 25,966, below-floor 262,813,
Monte Carlo 676 and maximum-only 5,089. Mean totals were 19.703 s off and
80.050 s on, a ratio of 4.0629 against the 2.0 limit.

With instrumentation removed and WASM rebuilt, the four-run measurement
gave mean totals of 20.527 s off and 80.095 s on: ratio 3.9020. Every run
completed without event errors; both Pc-on runs retained the same method
and tier counts above. The E2E failed only its 2.0 timing limit. Process
CPU times were 223.178/217.711 s off and 546.344/555.085 s on.

| Optimized Pc-on run | Preparation | Pc batch | CQR/CDM construction | Serialization | JS decode | Other refine |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| repeat B2 | 0.664 | 54.035 | 2.287 | 2.385 | 3.495 | 5.343 |
| repeat B4 | 0.630 | 52.594 | 2.270 | 2.121 | 3.205 | 5.187 |

Construction remained sequential; Pc batch dominates the measured refine
time. Catalog floors are `1e-4 / 1e-4`; pair-assessment defaults remain
`1e-7 / 1e-4`. Raising the catalog floor preserves the below-floor Pc2D
values and violation labels, and every event remains in the output.

Per-method instrumentation measured elapsed time inside each worker call.
The sums below include scheduling delays and are neither process CPU time
nor batch wall time. The extra Foster evaluation is the chunk-boundary
duplicate above.

| Optimized Pc-on run | Method | Evaluations | Summed worker elapsed, s | Mean, ms | Maximum, s |
| --- | --- | ---: | ---: | ---: | ---: |
| repeat B2 | Foster | 288,780 | 288.166 | 0.998 | 0.229 |
| repeat B2 | Monte Carlo | 676 | 140.569 | 207.942 | 21.030 |
| repeat B4 | Foster | 288,780 | 238.225 | 0.825 | 0.072 |
| repeat B4 | Monte Carlo | 676 | 133.933 | 198.126 | 21.426 |

Measured process CPU time was 220.486/217.557 s for the two Pc-off runs and
542.918/549.851 s for Pc on. Foster usage/curvature analysis is the remaining
large fixed cost; individual Monte Carlo calls exceeding 21 s limit batch
parallelism.

The isolated window-11 diagnostics used the same `1e-7 / 1e-4` floors:

| Workers / diagnostic | Total | Load stage | Search | Refine | 1-minute load, start → end |
| --- | ---: | ---: | ---: | ---: | --- |
| 27, initial | — | — | — | — | 13.60 → 17.08 |
| 1 | 138.976 | 1.526 | 13.104 | 124.210 | 17.03 → 14.60 |
| 27, explicit 2 MiB worker stack | 20.396 | 1.533 | 1.211 | 17.517 | 17.50 → 28.89 |
| 27, pre-grown 1 GiB memory | 19.726 | 1.594 | 1.103 | 16.906 | 19.24 → 21.31 |

The initial diagnostic trapped; the other three returned the same 31,031
events and method/tier counts. The existing worker stack was already 2 MiB.
Neither the stack trial nor pre-grown memory established the cause of the
intermittent trap; both diagnostic changes were removed.

On the 6,000-encounter native bench, 4,183 Pc2D values were at least three
decades below a `1e-4` reporting floor. Omitting curvature changed 3,790
tiers; conservatively flagging every omitted analysis changed 362. Limiting
the omission to existing rectilinear violations preserved tiers but added
only one skipped analysis beyond the 30 already skipped. The screen keeps
the curvature analysis.

Detailed logs and summary JSON remain in ignored
`tests/data/ca-retime/phaseb/` and `tests/data/ca-retime/pc-tiered-screen-*/`.
They are local benchmark evidence, not redistributed catalog data.
