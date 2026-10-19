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
only one skipped analysis beyond the 30 already skipped. That measurement
retained the curvature analysis; the Round 3 comparison below separately
reports the permitted change in labels when omitted curvature is disclosed.

Detailed logs and summary JSON remain in ignored
`tests/data/ca-retime/phaseb/` and `tests/data/ca-retime/pc-tiered-screen-*/`.
They are local benchmark evidence, not redistributed catalog data.

## Round 3: CPU cost and shared-memory diagnosis

The following measurements use the same catalog and 27 workers. Baseline
through Step 3 use catalog floors `1e-4 / 1e-4`; Step 4 uses `1e-4 / 1e-3`.
The default-floor memory stress run uses `1e-7 / 1e-4`.
The load gate is the requested one-minute load of at most 30 before each
run. End load is recorded, not asserted. Some historical E2E runs also
enforced an extra end-load ceiling; that check was removed at the user's
direction. The historical failures below retain the checks that ran at
the time, without treating end load as a current acceptance condition.
Temporary instrumentation records elapsed time with
`steady_clock` and actual worker CPU time with `CLOCK_THREAD_CPUTIME_ID`.
For Node 25.4.0, a local diagnostic loader supplies that WASI clock from
`process.threadCpuUsage()`; no SDK file is changed. Process CPU includes
the whole Node process, while event CPU includes only Pc evaluation.
Elapsed event times include scheduling delays and must not be treated as
CPU time. One refinement boundary repeats a covariance event: 289,456 Pc
evaluations produce 289,455 covariance events plus 5,089 maximum-only events.

| Measurement | Pc | Total elapsed, s | Load stage, s | Search, s | Refine, s | Process CPU, s | 1-minute load, start → end |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| Instrumented baseline | off | 21.136 | 1.503 | 10.154 | 8.294 | 215.080 | 18.47 → 28.88 |
| Instrumented baseline | on | 79.620 | 1.932 | 9.604 | 66.708 | 552.266 | 26.94 → 24.12 |
| Step 1, run 1 | off | 22.150 | 1.582 | 11.223 | 8.095 | 209.962 | 24.22 → 24.86 |
| Step 1, run 2 | on | 43.691 | 1.518 | 9.844 | 30.897 | 489.451 | 24.86 → 40.18 |
| Step 1, run 3 | off | 19.229 | 1.499 | 9.073 | 7.514 | 218.246 | 29.67 → 29.07 |
| Step 1, run 4 | on | 42.016 | 1.496 | 9.525 | 29.607 | 478.545 | 29.07 → 32.52 |
| Step 2, run 1 | off | 19.836 | 1.505 | 9.602 | 7.581 | 212.176 | 24.52 → 31.78 |
| Step 2, run 2 | on | 46.148 | 1.631 | 9.878 | 33.253 | 473.925 | 26.38 → 27.53 |
| Step 2, run 3 | off | 20.163 | 1.540 | 9.651 | 7.744 | 220.962 | 27.53 → 30.41 |
| Step 2, run 4 | on | 50.271 | 1.628 | 10.672 | 36.328 | 485.688 | 28.62 → 40.21 |
| Step 2b, run 1 | off | 18.864 | 1.461 | 8.744 | 7.515 | 226.644 | 29.84 → 32.03 |
| Step 2b, run 2 | on | 43.854 | 1.465 | 8.836 | 32.214 | 504.396 | 29.57 → 39.09 |
| Step 2b, run 3 | off | 18.427 | 1.458 | 8.272 | 7.590 | 234.283 | 25.72 → 29.13 |
| Step 2b, run 4 | on | 43.528 | 1.466 | 8.817 | 31.896 | 484.976 | 29.13 → 24.64 |
| Step 3, run 1 | off | 21.912 | 1.567 | 10.552 | 8.443 | 219.959 | 20.92 → 30.68 |
| Step 3, run 2 | on | 43.183 | 1.602 | 10.158 | 30.021 | 387.126 | 29.82 → 37.53 |
| Step 3, run 3 | off | 20.414 | 1.557 | 9.672 | 8.003 | 227.414 | 27.66 → 24.38 |
| Step 3, run 4 | on | 40.445 | 1.480 | 9.303 | 28.447 | 399.881 | 22.75 → 20.95 |
| Step 4, run 1 | off | 22.249 | 1.544 | 10.471 | 8.839 | 229.588 | 25.86 → 25.28 |
| Step 4, run 2 | on | 44.692 | 1.565 | 11.335 | 30.293 | 377.012 | 25.28 → 25.45 |
| Step 4, run 3 | off | 26.902 | 1.723 | 14.325 | 9.521 | 221.841 | 26.69 → 28.62 |
| Step 4, run 4 | on | 46.337 | 1.574 | 12.560 | 30.850 | 367.857 | 26.97 → 31.10 |
| Default-floor stress | off | 28.022 | 2.459 | 14.655 | 9.555 | 217.646 | 29.56 → 43.23 |
| Default-floor stress | on | 111.600 | 1.687 | 15.374 | 92.778 | 926.566 | 29.29 → 59.72 |

Step 1 combines a deterministic Monte Carlo propagation-work budget with
bounded Screening time-node caches and serial heap preparation. The two
Pc-on runs have identical method/tier counts and no event errors: Foster
288,779, Monte Carlo 676, maximum-only 5,089; valid Foster 25,966,
below-floor 262,813, Monte Carlo 676 and maximum-only 5,089. Both end loads
exceed 30 and are reported as shared-host context. Their mean-total ratio is
2.0712397743 (42.853 s on / 20.690 s off), which also exceeds 2.0.

Step 2 separates Pc2D preparation from fallback evaluation and starts the
estimated expensive fallbacks first, using a second worker pool. Every run
completes with no event errors and unchanged method/tier counts. Mean total
is 48.209 s on / 20.000 s off, ratio 2.4105212561. Mean summed batch wall
time rises from Step 1's 16.617118 s to 20.269946 s; mean event CPU remains
similar, 247.277025 s versus 245.912677 s. This two-pool arrangement does not
improve the measured screen time. Both Pc-off runs and the second Pc-on
run exceed 30 at the end, while all starts meet the load gate. The measured
ratio exceeds the timing limit.

Step 2b reuses one worker pool for both passes. Mean summed batch wall time
is 18.442346 s, with 248.577481 s of event CPU. Mean total is 43.691 s on /
18.646 s off, ratio 2.3432116152. All four runs retain the same counts and
have no event errors. The first off/on pair exceeds the historical extra
end-load ceiling; the second pair has both endpoints below 30. That E2E
reported two now-removed load-check failures and the ratio failure. The
ratio still exceeds the timing limit under the requested start-only gate.

Step 3 adds the disclosed far-below-floor curvature omission described
below. Mean Pc batch wall time is 14.919006 s and mean event CPU is
153.784569 s. Mean total is 41.814 s on / 21.163 s off, ratio 1.9758.
The first off/on pair exceeded the historical extra end-load ceiling, so
that E2E failed two now-removed checks despite meeting the mean timing
threshold. All starts meet the requested load gate. All events
complete without errors and both Pc-on outputs agree: method counts remain
Foster 288,779, Monte Carlo 676 and maximum-only 5,089; tier counts are
`FOSTER-2D` 210,659, below-floor 78,120, Monte Carlo 676 and maximum-only
5,089. The larger Foster tier includes explicitly disclosed curvature
omissions and does not assert full curvature validation.

Step 4 raises the catalog Monte Carlo floor to `1e-3`, retaining the `1e-4`
reporting floor. Mean total is 45.515 s on / 24.575 s off, ratio 1.8520;
mean Pc batch wall time is 14.634239 s and mean event CPU is 129.952648 s.
Every run completes without event errors. Both Pc-on outputs agree on
methods: Foster 288,779, `3D-NC-HALL` 449,
`3D-NC-HALL-QUADRATIC-TIME` 126, Monte Carlo 101 and maximum-only 5,089.
Tier counts are `FOSTER-2D` 210,659, below-floor 78,120, 3D-Nc 575,
Monte Carlo 101 and maximum-only 5,089. The final Pc-on end load is
31.103515625, which triggered the historical extra end-load check despite
meeting the mean timing threshold. All starts meet the requested load gate;
the recorded failure was solely the check that has since been removed.

The default-floor stress runs complete all 294,544 events without traps or
event errors. Their end loads are 43.225098 off and 59.724121 on. These are
memory stress measurements rather than a four-run timing comparison.
Pc-on method counts are
Foster 212,447, Hall 36,581, quadratic-time Hall 38,899, Monte Carlo 1,528
and maximum-only 5,089. Tier counts are `FOSTER-2D` 191,947, below-floor
20,500, 3D-Nc 75,480, Monte Carlo 1,528 and maximum-only 5,089. Pc batches
take 76.744477 elapsed seconds and 691.117630 event CPU-s. The maximum
event uses 4.736300 CPU-s; it ends in Monte Carlo after Nc convergence
failure. By comparison,
the selected `1e-4 / 1e-3` Step 4 measurements have maximum event CPU
0.884530 s.

An isolated native replay separates this outlier's costs: whole-engine
CPU 1.824847 s (elapsed 1.883999 s), Nc including Screening and Reference
recovery 1.808825 CPU-s, and Monte Carlo 0.008174 CPU-s. The returned Nc
result remains unconverged and reports 8,543 evaluations. Monte Carlo completes 49,152
samples with zero hits and zero propagated states because every trajectory
is rejected by the geometric certificate. Its result, Wilson interval and
sample/hit counts exactly match the full-engine replay. The three-million
propagation cap is not reached. Pc2D is `5.898165605276824e-6`, so this
event is below the selected catalog reporting floor `1e-4` and does not
take a fallback there. Native replay load is 27.36 before and 26.29 after.

### Baseline distribution and worker imbalance

The baseline's 31 Pc batches take 52.852009 s of wall time. Summed event CPU
is 315.068492 s, compared with 383.007018 s of summed event elapsed time.
Including per-worker loop overhead, CPU is 315.946411 s. The busiest worker
uses 36.456886 CPU-s; the least busy uses 8.171340 CPU-s. The longest batch
takes 21.069008 s and contains the 21.065260 s event below.

Worker slots aggregate busy time across all 31 batches; elapsed time includes
scheduling delays, while CPU records execution on that slot's thread.

| Worker slot | Busy elapsed, s | Busy CPU, s |
| --- | ---: | ---: |
| 0 | 39.333745 | 36.456886 |
| 1 | 11.453492 | 8.835997 |
| 2 | 14.175701 | 11.771520 |
| 3 | 11.863685 | 9.156049 |
| 4 | 16.343398 | 13.719773 |
| 5 | 14.508808 | 11.938359 |
| 6 | 11.266161 | 8.691393 |
| 7 | 12.069635 | 9.345021 |
| 8 | 11.330462 | 8.916780 |
| 9 | 16.593331 | 14.033380 |
| 10 | 20.113855 | 17.642594 |
| 11 | 11.389283 | 8.884739 |
| 12 | 11.690821 | 9.162300 |
| 13 | 15.873396 | 13.419095 |
| 14 | 11.088755 | 8.514051 |
| 15 | 14.408195 | 12.002922 |
| 16 | 15.823173 | 13.084223 |
| 17 | 17.094703 | 14.684381 |
| 18 | 15.574257 | 13.009273 |
| 19 | 11.641053 | 9.107744 |
| 20 | 11.567265 | 8.967653 |
| 21 | 12.148431 | 9.559417 |
| 22 | 10.949534 | 8.442584 |
| 23 | 11.709102 | 9.142353 |
| 24 | 13.299950 | 10.805488 |
| 25 | 10.931848 | 8.481096 |
| 26 | 10.606179 | 8.171340 |

Histogram boundaries are elapsed seconds: `[0,.001)`, `[.001,.01)`,
`[.01,.1)`, `[.1,1)`, `[1,10)`, and `[10,infinity)`.

| Tier | Evaluations | Event CPU, s | Event elapsed sum, s | <1 ms | 1–10 ms | 10–100 ms | 0.1–1 s | 1–10 s | ≥10 s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Valid Foster | 25,966 | 8.055990 | 10.097613 | 25,248 | 677 | 41 | 0 | 0 | 0 |
| Below floor | 262,814 | 181.576199 | 236.584750 | 207,206 | 53,736 | 1,870 | 2 | 0 | 0 |
| Monte Carlo | 676 | 125.436303 | 136.324654 | 0 | 0 | 582 | 65 | 28 | 1 |

The 20 slowest baseline events are all `SDMC-TWO-BODY`. Batch/index labels
identify local diagnostic slots without publishing catalog records.

| Batch/index | Elapsed, s | CPU, s | Samples | Hits |
| --- | ---: | ---: | ---: | ---: |
| 23/212 | 21.065260 | 20.765950 | 49,152 | 5 |
| 13/48 | 4.844208 | 4.815393 | 49,152 | 2 |
| 13/47 | 4.492664 | 4.456957 | 49,152 | 3 |
| 10/45 | 4.444386 | 4.380805 | 49,152 | 4 |
| 13/49 | 4.243491 | 4.211075 | 49,152 | 0 |
| 8/144 | 3.546514 | 3.334246 | 49,152 | 6 |
| 16/44 | 3.522403 | 3.474165 | 49,152 | 3 |
| 10/46 | 3.482899 | 3.441048 | 49,152 | 3 |
| 8/147 | 3.443106 | 3.226772 | 49,152 | 7 |
| 10/47 | 3.396396 | 3.379216 | 49,152 | 6 |
| 10/48 | 3.372690 | 3.295915 | 49,152 | 5 |
| 16/42 | 3.342823 | 3.304048 | 49,152 | 2 |
| 8/150 | 3.336180 | 3.111518 | 49,152 | 3 |
| 8/153 | 3.145813 | 2.963548 | 49,152 | 3 |
| 16/41 | 3.074087 | 3.026656 | 49,152 | 4 |
| 16/40 | 2.840293 | 2.762373 | 49,152 | 0 |
| 19/48 | 2.482822 | 2.475823 | 49,152 | 1 |
| 8/420 | 2.026294 | 1.811833 | 49,152 | 3 |
| 11/375 | 1.659576 | 1.584348 | 49,152 | 4 |
| 11/362 | 1.386924 | 1.319024 | 49,152 | 1 |

### Native replay of the 29 slow Monte Carlo events

The native replay exactly reproduces all 29 baseline sample counts and hit
counts. All use 49,152 samples. The total is 71.792406 CPU-s and 73.340514
elapsed seconds; the maximum event uses 17.227127 CPU-s. `uptime` reports
one-minute load 22.73 before and 18.53 after. Across these events there are
411,640,418 propagated states, 205,820,209 distance evaluations,
799,744,474 visited intervals and 250,629 bisections. The slowest event
alone uses 101,496,446 propagated states and 50,748,223 distance evaluations.
This identifies repeated two-body propagation as the expensive work.

The earlier 6,000-event native sample projected about 111 CPU-s for a whole
catalog screen's Pc work at `1e-4 / 1e-4`. It included only 12 Monte Carlo
events, with observation windows 1.15–1.89 s and native CPU costs
8.1–8.8 ms. It missed the rare long-window events found by full screening:
the 29 slow events alone consume 71.792406 native CPU-s and 90.067828 WASM
CPU-s. The worst has a 341,216.8 s observation window and relative speed
`9.8678313e-5 km/s`; its 101,496,446 propagated states explain the heavy
cost. A typical-event native projection therefore understated both the
total work and the longest event's effect on batch completion time.

A three-million-propagation budget stops after a complete sample, retaining
seed order, collision decisions and Wilson intervals. In the replay,
28/29 events reach the work budget; 22 finish below the normal 32,768-sample
minimum. Sample counts range from 1,454 to 49,152. Total native CPU falls
to 15.755169 s and summed elapsed time to 16.927423 s; maximum event CPU is
0.600041 s. Load is 17.91 before and 21.51 after. The slowest original event
finishes 1,454 samples with zero hits and Wilson interval `[0,0.002635032]`;
the result explicitly reports that the work budget overrode the sample
minimum.

For this slow-event subset, 22/29 budget estimates lie inside the preceding
Screening estimate's 95% Wilson interval; all 29 pairs of intervals overlap.
The seven outside estimates are zero: slots 8/150, 10/48, 13/47, 16/42,
16/44, 19/48 and 23/212. This comparison uses the preceding Screening run,
not Reference, and does not establish the Reference agreement criterion.
The corresponding capped native and WASM runs match all 29 sample counts
and hit counts exactly, with no missing events or mismatches.

| Pc-on measurement | Sum of batch wall times, s | FOSTER-2D tier CPU, s | Below-floor CPU, s | 3D-Nc CPU, s | Monte Carlo CPU, s | Maximum event CPU, s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Baseline | 52.852009 | 8.055990 | 181.576199 | 0 | 125.436303 | 20.765950 |
| Step 1, run 2 | 17.040219 | 8.217807 | 185.279128 | 0 | 57.199670 | 0.942351 |
| Step 1, run 4 | 16.194016 | 8.038940 | 179.912875 | 0 | 55.905631 | 0.942954 |
| Step 2, run 2 | 19.730812 | 8.126752 | 182.802767 | 0 | 52.757777 | 0.861952 |
| Step 2, run 4 | 20.809079 | 8.284002 | 186.410033 | 0 | 53.444023 | 0.908869 |
| Step 2b, run 2 | 18.537722 | 8.425900 | 190.569421 | 0 | 53.824794 | 0.885116 |
| Step 2b, run 4 | 18.346971 | 8.213874 | 184.000847 | 0 | 52.120125 | 0.888212 |
| Step 3, run 2 | 15.299048 | 50.467409 | 44.876659 | 0 | 54.116799 | 0.937834 |
| Step 3, run 4 | 14.538963 | 60.171620 | 45.644124 | 0 | 52.292527 | 0.856445 |
| Step 4, run 2 | 14.582226 | 44.933879 | 44.297681 | 1.568448 | 43.930879 | 0.884530 |
| Step 4, run 4 | 14.686252 | 34.852359 | 43.726131 | 1.600579 | 44.995340 | 0.872957 |
| Default-floor stress | 76.744477 | 26.417098 | 13.341960 | 281.177674 | 370.180898 | 4.736300 |

### Curvature omission below one-thousandth of the reporting floor

Two fixed 3,000-event native samples compare omission of curvature when
`Pc2D < reporting_floor * 1e-3`, at catalog floors `1e-4 / 1e-4` and 27
workers. The rectilinear and relative-velocity checks remain active. Each
omission records `curvature not evaluated: Pc2D far below the reporting
floor` and leaves `usage_checked=false`.

| Seed | Events | Exact Pc2D comparisons | Disclosed omissions | Below-floor → FOSTER-2D labels | MC before / after | CPU, s | Elapsed, s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 12345 | 3,000 | 2,950 | 2,096 | 1,886 | 8 / 8 | 0.474837 | 0.030166 |
| 67890 | 3,000 | 2,951 | 2,087 | 1,904 | 4 / 4 | 0.432482 | 0.029233 |

All 5,901 available-covariance Pc2D values match the preceding calculations
bit for bit. The 99 maximum-only events remain maximum-only. There are
4,183 disclosed omissions and 3,790 permitted label changes; the latter
are below-floor Foster probabilities whose omitted curvature previously
established a violation. These labels do not claim that curvature was
evaluated. No event enters or leaves the Nc/MC fallback set: all 12 Monte
Carlo memberships remain unchanged, and neither sample contains a 3D-Nc
event at these floors. The comparison reports zero probability, fallback,
relative-velocity diagnostic or disclosure mismatches and zero event errors.
Both samples record one-minute load 17.00 before and after evaluation.

### Shared-memory bulk-copy trap

A minimal WebAssembly diagnostic reproduces the trap on Node 25.4.0 / V8
14.1.146.11-node.15, with 27 consumers sharing imported memory. It contains
only shared memory, atomics, scalar stores, `memory.grow` and `memory.copy`:
no SDK, allocator, C++ containers or Pc calculations. At round 27, worker
19 reports a stale 28-page memory size while shared memory has 29 pages.
Source and destination scalar stores succeed beyond the old limit, then a
valid 272-byte `memory.copy` traps at `wasm-function[0]:0xdb`. The other 26
workers complete the same round and observe 29 pages. Load is 26.11.

Fixed-memory and consumer `memory.grow(0)` controls each complete 1,024
rounds per worker (loads 25.79 and 21.33). An additional control instantiates
all workers with one page, grows serially to 1,025 pages, then enters their
WASM loops: all 27 × 1,024 rounds pass at load 29.66. Expanded diagnostic
growth-only repeats also pass, so the failure depends on scheduling;
`memory.grow(0)` alone is not established as a sufficient fix.

The production preparation reserves allocator-managed pages serially before
parallel screening. It holds 1 MiB allocations until total memory reaches
`min(1 GiB, 128 MiB + 24 KiB/source + 4 MiB/worker)`, then frees them for
reuse. Raw memory growth is avoided. Screening kernel and rate caches each
retain at most 8,192 nodes; eviction recomputes the same arithmetic. Monte
Carlo samples stream through fixed storage.

| Measurement | First reported pages | Peak pages | Peak MiB | Fraction of 32,768-page limit |
| --- | ---: | ---: | ---: | ---: |
| Baseline off, after refinement | 6,817 | 6,871 | 429.4375 | 20.9686% |
| Baseline on, after refinement | 6,808 | 6,867 | 429.1875 | 20.9564% |
| Step 1, all four runs, after reserve | 15,970 | 15,970 | 998.1250 | 48.7366% |
| Step 2, all four runs, after reserve | 15,970 | 15,970 | 998.1250 | 48.7366% |
| Step 2b, all four runs, after reserve | 15,970 | 15,970 | 998.1250 | 48.7366% |
| Step 3, all four runs, after reserve | 15,970 | 15,970 | 998.1250 | 48.7366% |
| Step 4, all four runs, after reserve | 15,970 | 15,970 | 998.1250 | 48.7366% |
| Default-floor stress, off and on | 15,970 | 15,970 | 998.1250 | 48.7366% |

Each Step 1–4 process starts reserve preparation at 2,707 pages and reaches
15,970 pages while holding 843 allocations. Every subsequent refinement
reports the same 15,970 pages, below the 70% limit. These figures are total
WASM linear memory, not live heap allocations. The reserve target itself
does not impose a hard memory limit on arbitrary inputs.
The default-floor stress also remains at 15,970 pages after every refinement,
including its 75,480 Nc and 1,528 Monte Carlo events, with no worker trap.

### Five consecutive runs with the clean artifact

After removing temporary C++ profiling and rebuilding, five consecutive
Pc-on screens at `1e-4 / 1e-3` complete without a worker trap or trap retry.
Each returns 294,544 events, zero event errors and identical method/tier
counts: Foster 288,779, Hall 449, quadratic-time Hall 126, Monte Carlo 101
and maximum-only 5,089; tiers `FOSTER-2D` 210,659, below-floor 78,120,
3D-Nc 575, Monte Carlo 101 and maximum-only 5,089.

| Run | Total elapsed, s | Load stage, s | Search, s | Refine, s | 1-minute load, start → end | Peak WASM pages |
| --- | ---: | ---: | ---: | ---: | --- | ---: |
| 1 | 46.320 | 1.642 | 12.000 | 31.186 | 23.51 → 25.42 | 15,970 |
| 2 | 43.849 | 1.653 | 11.239 | 29.526 | 24.27 → 24.61 | 15,970 |
| 3 | 46.214 | 1.674 | 12.215 | 30.852 | 23.44 → 34.08 | 15,970 |
| 4 | 43.118 | 1.613 | 10.617 | 29.452 | 28.38 → 31.57 | 15,970 |
| 5 | 57.286 | 1.682 | 18.613 | 35.282 | 26.57 → 46.42 | 15,970 |

The host records final linear-memory size on each clean-artifact instance:
15,970 pages, 998.125 MiB, or 48.7366% of its 32,768-page maximum. WASM
memory cannot shrink, so final size includes its peak. Runs 3–5 end above
load 30; all starts meet the requested load gate. This consecutive Pc-on
series demonstrates trap-free execution and bounded memory on the measured
catalog and has no paired Pc-off timing comparison.

### Clean four-screen measurement

The following clean-artifact series uses `1e-4 / 1e-3`, with all starts
below load 30. Every run returns 294,544 events and zero event errors; both
Pc-on runs retain the method and tier counts from the consecutive series.

| Run | Pc | Total elapsed, s | Load stage, s | Search, s | Refine, s | Process CPU, s | 1-minute load, start → end |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | off | 27.882 | 2.115 | 15.148 | 9.173 | 227.764 | 25.26 → 36.41 |
| 2 | on | 48.703 | 2.214 | 12.859 | 32.160 | 369.520 | 28.52 → 32.41 |
| 3 | off | 27.220 | 1.712 | 14.465 | 9.610 | 224.922 | 27.10 → 32.48 |
| 4 | on | 65.231 | 1.944 | 21.107 | 40.236 | 367.968 | 27.96 → 43.80 |

Mean total is 56.967 s on / 27.551 s off, ratio 2.0676755853. The historical
E2E reports four end-load failures from the extra check and one timing-ratio
failure. Removing the extra check leaves the ratio failure unchanged.

### Final default E2E invocation

The final `node tests/pcTieredScreen.e2e.mjs` passes the native and synthetic
stages. Native results are 135 CARA/oracle assertions, 18 engine assertions,
39 fallback assertions, 228 maximum-probability assertions, 121 Monte Carlo
assertions and 13 Hall assertions, all passing. The 20-geometry dblquad
maximum relative error is `2.657747556478e-11`. The embedded tiered-engine
E2E passes 585 assertions, including scalar/batch and reordered-input
agreement at 1/4/27 workers; its synthetic MC comparison places 12/12
estimates inside Reference Wilson intervals.

The 241-object synthetic catalog returns status 200 / statusCode 0 and
272 events for both Pc off and Pc on across `screen_catalog`,
`screen_window` and resident `refine_candidates`. Pc-on methods are Foster
271 and quadratic-time Hall 1; tiers are `FOSTER-2D` 239, below-floor 32
and 3D-Nc 1. The Hall event has the actual method and Pc in its CDM and
maximum-only CQR probability. `SYN-DOWN` remains listed as excluded.
Resident refinement at one and four workers agrees on every scientific
field and event order. The Reference pair's assessed and emitted CDMs also
agree.

The full-catalog stage completes only its first Pc-off run:

| Pc | Total elapsed, s | Load stage, s | Search, s | Refine, s | 1-minute load, start → end | Events / errors |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| off | 31.347 | 2.060 | 16.655 | 11.034 | 29.855469 → 45.245605 | 294,544 / 0 |

Before the first Pc-on run, load stays above 30 for the full 20-minute wait.
The E2E exits 1 with `Screen 2 Pc on: load average stayed above 30 for 20
minutes`; final `uptime` at 18:47 reports 45.62 / 41.79 / 39.35. No final
four-screen ratio exists. The last completed clean four-screen ratio
remains 2.0676755853: its 56.967 s mean Pc-on time exceeds twice the 27.551 s
Pc-off mean by 1.865 s, or 3.38%. Final four-run and consecutive performance
acceptance are not established; the five consecutive runs establish the
separate trap and memory result above.

The remaining measured Pc CPU split from Step 4 is 83.905 s in the 2-D
tiers (64.57%), 44.4631095 s in Monte Carlo (34.22%) and 1.5845135 s in
3D-Nc (1.22%), totaling 129.952648 s. These are measured component costs,
not estimates of unmeasured optimization savings.

### Offline validation

The CDM conformance E2E passes 9/9 tests (load 26.29 → 26.48). The combined
offline Node validation passes 24/24 registered tests: 11 CQR tests, three
continuous-screening tests and ten SDK compatibility tests (load
24.61 → 24.72). The Docker case is explicitly excluded with
`--test-skip-pattern=docker-wasmedge`. `SDM_WASMEDGE_RUNNER_BINARY` points to
the preexisting runner in this worktree, so the native WasmEdge loading
check runs without bootstrapping dependencies.

An earlier helper invocation was interrupted by the offline subprocess
guard before its attempted git bootstrap or Docker execution. The final
invocation avoids that bootstrap and the Docker case; the blocked attempt
is not counted as a scientific validation failure or a successful test.

Round 3 logs, replay counters and the minimal WASM diagnostic are retained
under ignored `tests/data/ca-retime/phaseb/round3/`.
