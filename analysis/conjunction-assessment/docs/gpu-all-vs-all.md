# All-vs-all screening with the pair search on a GPU

FFM (Full Force Model) is defined in [the FFM specification](../../../propagator/ffm/FFM.md).

Every object of a catalog against every other, for trajectories from any
propagator. The module does all the numerical work in WASM: it samples the
trajectories, re-tests candidates, refines TCAs, computes probability and
handles exclusions. Only the pair search runs on the GPU, and that search
only proposes candidates.

```
prepare_screening_index   module: the catalog, loaded once (any source kind)
  -> coarse_grid          module: every source sampled at a block of coarse steps
  -> GPU search           gpu/screen_kernel.wgsl: proposes (pair, step) candidates
  -> refine_candidates    module: f64 re-test, encounters, TCA, Pc, exclusions
```

`gpu/allVsAll.mjs` moves frames between the module and the GPU and contains
no physics. `gpu/gpuScreen.mjs` runs the kernel on any WebGPU device.

## Sources

A resident index holds one source per object, all in one frame:

| Source | Evaluated as | Motion bound |
| --- | --- | --- |
| Mean elements (OMM, TLE), `PROPAGATOR_PORT_ID=sgp4` | SGP4 in the module | Natural motion: A = 1.05 μ / r_min² |
| PPE from any propagator (FFM's `conjunction-screening` export, or another) | The Chebyshev intervals as given | From the coefficients |

PPE intervals may be in UTC, TT or TDB. A TDB or TT interval maps onto UTC
linearly between its converted ends, using the vendored ERFA from
`foundation/frames`. An interval that contains a leap second is refused.

One propagator per run. An index holds mean elements (SGP4) or trajectories
from one generator (PPE `EPHEMERIS_SOURCE`), never both:
`prepare_screening_index` refuses a mix with `mixed-propagators`. Sampled OEM
tracks cannot bound their motion between samples; supply those as PPE.

A propagator module's output goes in unchanged.
`prepare_screening_index` takes its `$PRW` `DESCRIBE_RESULT` records, as
`propagator/ffm` exports them, on the `trajectories` port. The request's
`SOURCES` then carry identity only: object id, name, catalog number and
handle. Records may be size-prefixed, as a module's `FinishSizePrefixed`
builds them (see the SDK README, "Size-prefixed records"), or plain.

A failed propagation never reaches the grid: `prepare_screening_index`
refuses a PPE whose coefficients are not finite (`invalid-polynomial`) or
whose positions, at each record's ends and middle, leave 6,356.752 km (the
polar radius) to 1e6 km from the Earth's centre (`invalid-trajectory`), naming
the object (`tests/windowedScreenParity.test.mjs`).

## The candidate test

Over a coarse interval [t_k - h, t_k + h], where h is half the coarse step,
each source bounds how far its path strays from the straight line through
its sample:

    |r(t_k + τ) - r_k - v_k τ| <= D     for |τ| <= h

So a pair can come within the threshold during the interval only if the
straight-line relative path comes within threshold + D₁ + D₂.

How each source computes D:

- **SGP4:** D = ½ A h². SGP4 motion is unpowered, and the 5 % margin in A
  covers J2 and drag.
- **PPE:** D = ½ A h² + (J + G) h + P, where:
  - A bounds |r''| from the position coefficients, using |T_k''| <= k²(k² - 1)/3;
  - J and P are the velocity and position jumps where intervals meet, so an
    impulsive maneuver is covered;
  - G is the difference between the velocity series and the derivative of
    the position series.

  The bound uses only the coefficients, so it holds for any force model.
  `src/cpp/tests/test_trajectory_bounds.cpp` checks it against the trajectory
  itself every 0.1 s, across a 5 m/s maneuver. It is never exceeded, and is
  at most 1.34 times the true deviation where the motion is smooth.

The GPU applies the test in f32 with 0.01 km of slack, so it proposes a
superset. `refine_candidates` repeats the test in f64 through
`conjunction::tight_pair_may_close`.

The GPU finds pairs to test with the module's grid (below), in three passes
per step (`gpu/screen_kernel.wgsl`):

1. `insert`: each box goes into the cells it overlaps, hashed into one
   lock-free list per slot. A box spanning four or more cells on an axis goes
   on the step's big list instead.
2. `pairs`: each object walks its cells' lists and tests a pair only in the
   cell holding the low corner of the two boxes' overlap.
3. `bigs_against_all`: each big box is tested against every object.

The cell edge is the 99th-percentile box edge of a sample of the block.
`gpu/gpuScreen.mjs` runs 8 steps per dispatch and halves that if the cell
entries overflow. It proposes exactly the pairs an all-pairs test would: the
full 3-day catalog gives the same 2,678,533 candidates as the all-pairs
kernel it replaced.

Passing steps join into encounters, which are refined as `screen_catalog`
refines its own, through one source-based TCA search
(`conjunction_assessment.h`).

### TCA where the range has one minimum

`find_tca` first tries `solve_unimodal_conjunction`. With A bounding both
objects' accelerations over the window (`acceleration_bound_km_s2`; for SGP4,
1.05 μ / r²_min) and half-width T about its middle:

- |Δṙ| ≥ |Δv| − ε − A T, with ε = 1 m/s for a velocity that differs from the
  rate of the position;
- |Δr| ≤ |Δr_mid| + |Δv| T + A T² / 2.

If q = |Δr|max A / |Δṙ|min² < 1, then d²|Δr|²/dt² > 0 on the window: one
minimum, at the root of the range rate f = Δr · Δv. Newton steps of −f / |Δv|²
converge by a factor q or better; a root outside the window leaves the TCA at
the window edge plus the one second the scan also searches. The solve takes
about ten state evaluations. Where the proof fails (slow pairs, long windows,
sources without an acceleration bound), `find_tca` scans as before.

Fast encounters (at most three coarse hits) use the same solve on their local
window. A minimum strictly inside that window is reported as found.

## Methods

**`coarse_grid`** takes:

- `request`: a CQR `WINDOW_REQUEST` on an index with no primaries, with
  `ALFANO_MAXIMUM` controls;
- `block`: a `$SCR` BLOCK, `FIRST_STEP` and `STEP_COUNT` (1–256).

It returns:

- `grid`: a `$SCR` GRID, `FIRST_STEP`, `STEP_COUNT`, `OBJECTS` and `STEP_S`,
  then `STATES` `[step][object]` (x, y, z, D, vx, vy, vz, 0 as f32) and `BANDS`
  `[object]` (lo, hi radius bounds). Excluded objects are NaN.
- `report`: a `$SCR` SEARCH_REPORT, `LAST_STEP`, `OBJECTS`, and `EXCLUDED`
  (index, first failing JD, reason).

**`refine_candidates`** takes:

- the same `request`;
- optionally, `candidates`: a `$SCR` CANDIDATES, (OBJECT1, OBJECT2, STEP)
  rows;
- optionally, `excluded`: a `$SCR` EXCLUSIONS, (INDEX, FIRST_FAILURE_JD) rows.

It returns `screen_catalog`'s `result` chunks, up to 1,024 events each, and
`excluded` OMMs. Without `candidates`, it runs the CPU search below.

When a refine call would stage more than 16,384 events, the driver splits it
in two.

## Without a GPU

`search_candidates` finds a block's candidates inside the module, with no GPU.
It runs in a browser without WebGPU, in Node, and in WasmEdge as an SDN node or
a Docker container runs modules.

At each coarse step, each object's straight-line segment over ±h, widened by
threshold/2 + D, gives an axis-aligned box. Two objects can close only if their
boxes overlap, so the search discards nothing the tight test would pass.
`tight_box_pairs` finds the overlapping pairs:

- Boxes go into a uniform grid whose cell is the 99th-percentile box edge.
- Each pair is counted once, in the cell holding the low corner of the two
  boxes' overlap.
- The rare larger boxes are paired with every object.

Survivors pass through the same f64 tight test. Steps run on the module's
threads.

`refine_candidates` takes the result exactly as it takes the GPU's, so
refinement, windows and merging are shared. Without `candidates`,
`refine_candidates` runs the same search itself. The driver
(`gpu/allVsAll.mjs`) uses `search_candidates` whenever no GPU screener is
given. `gpu/catalogScreen.mjs` runs one session the same way on every host:
`examples/all-vs-all-gpu/worker.mjs` in a browser, and
`scripts/run-all-vs-all-cpu.mjs` in Node or WasmEdge.

`tests/gpuScreenParity.test.mjs` runs the CPU search against the same
references as the GPU path.

**WasmEdge:** run the module ahead-of-time compiled, as SDN nodes do. Use SDN's
patched WasmEdge 0.16.4: stock `wasmedgec` 0.16.4 miscompiles atomic memory
offsets. With stock AOT, the full-catalog search deadlocked in its second
window; patch `04-atomic-memarg-offset` fixes it. The interpreter is about 75
times slower.

## Time windows

A long screen runs as consecutive windows (`screenWindowsOnGpu` in
`gpu/allVsAll.mjs`):

- **SGP4:** the catalog is loaded once, and every window screens that index.
- **FFM and other trajectory propagators:** each window loads only that
  window's trajectories and releases them after. A day of FFM's 300 s
  segments is about 240 KB per object. A 1-hour window of the full catalog is
  about 390 MB, which `prepare_screening_index` holds in 1.05 GiB of the
  module's 2 GiB; a 2-hour window (700 MB) needs 1.85 GiB before the screen
  itself, so FFM screens default to 1-hour windows.

The merged result is a single screen of the whole span:

- A conjunction belongs to the window that holds its TCA.
- A TCA within the refinement tolerance of a shared edge is reported in both
  windows and kept once.
- An object excluded in any window, by the module or by the propagator, has
  no conjunctions anywhere.

`tests/windowedScreenParity.test.mjs` checks four windows against one screen
for both propagators.

### The FFM propagation farm

`scripts/lib/ffmFarm.mjs` runs on worker threads:

1. `analysis/epoch-state` turns each element set into a GCRF state at its
   epoch: SGP4 at zero elapsed time, then TEME to GCRF through ERFA.
2. `propagator/ffm` integrates those states at full force:
   `propagator/ffm/catalog.mjs` writes the configuration, Cd·A/m comes from
   each element set's B* (converted by the module; 0.01 m²/kg where B* ≤ 0)
   and Cr·A/m is 0.02 m²/kg. `--ffm-environment` supplies the kernel, Earth
   orientation and space weather (`docs/benchmark.md`). A resident instance
   holds at most 1,024 objects; objects are dealt round-robin into about two
   instances per worker.
3. Each window, every instance prepares the window and describes its sources.
   The `$PRW` records go to the page unchanged, and the next window is
   prepared while the page screens the current one.

An object FFM cannot cover is found by preparing objects one at a time and
leaves its instance. FFM ends a trajectory at reentry, 100 km geodetic
altitude (propagator/ffm README, "The end of a trajectory: reentry"):
- an object that reenters before the screen starts is excluded from the whole
  span, as SGP4 excludes a decayed element set;
- one that reenters during the screen keeps the windows before the one that
  holds its reentry, and is absent from that window on;
- any other failure excludes the object from the whole span.

The CPU runner's summary lists them (`ffm.reentries`, `ffm.dropped`).

FFM integrates every object from its element epoch, so the first window
carries that catch-up. FFM prunes cache intervals that end before the
requested window, so an instance holds about one window per object.

## Running it

```
node build.mjs
node scripts/run-all-vs-all-gpu.mjs --catalog <omm.uint32be.bin> --propagator sgp4|ffm \
  --start 2461314.5 --days 3 [--window-hours 6|1] --threshold-km 5 --step-s 60 [--cpu] \
  [--ffm-environment <env dir>] --out summary.json
# no browser, no GPU (Node, or WasmEdge as on an SDN node):
node scripts/run-all-vs-all-cpu.mjs --catalog <omm.uint32be.bin> --runtime wasmedge --aot \
  --propagator sgp4|ffm [--ffm-environment <env dir>] [--farm-workers N] --days 3 --out summary.json
```

The catalog file holds `$OMM` records, each prefixed by its u32 big-endian
length. The runner:

1. bundles `examples/all-vs-all-gpu/worker.mjs`;
2. serves the page with COOP/COEP;
3. runs it in headless Chrome with `--enable-unsafe-webgpu`;
4. prints the timings.

With `--serve`, it leaves the page up for a WebGPU browser instead.

`tests/gpuScreenParity.test.mjs` checks two cases:

- **SGP4:** element sets, including one SGP4 cannot propagate, against
  `screen_catalog`.
- **FFM:** FFM-integrated crossing orbits (`tests/fixtures/ffm-ppe`, from
  `scripts/generate-ffm-ppe-fixture.mjs`). The GPU path must equal the
  exhaustive CPU scan and hold each pair's closest approach as
  `screen_window` finds it.

## Measured

The catalog is the Space-Track GP catalog of 2026-09-30, 32,514 objects. Each
screen covers 2026-10-01T00:00Z plus 3 days with a 5 km threshold and 60 s
steps, on a Mac Studio (28 cores; GPU runs in headless Chrome on Metal), with
27 module threads. The host was shared with other work (1-minute load 20–60),
so times are upper bounds.

### Three days, whole catalog

| Propagator | Pair search | End to end | Search (CPU) or grid + GPU | Refine | Conjunctions |
| --- | --- | ---: | ---: | ---: | ---: |
| SGP4, 12 × 6 h | module, Node | 19.1 s | 9.7 s | 6.6 s | 294,544 (25 objects excluded) |
| SGP4 | module, WasmEdge 0.16.4 AOT, SDN patches | 22.9 s | 11.9 s | 8.7 s | 294,544 |
| SGP4 | GPU | 21.3 s | 6.1 + 2.3 s | 7.2 s | 294,544 |
| FFM, 72 × 1 h | module, Node | 6,383 s on 16 cores (15,210 s measured) | 97.7 s | 40.1 s | 283,700 (21 objects excluded) |

- Each propagator's runs report identical conjunctions (same TCA and miss
  distance) whichever host searched.
- On the GPU path the module samples (6.1 s) and the GPU searches (2.3 s;
  8.5 s with the all-pairs kernel the grid replaced).
- The module's 294,544 conjunctions differ from the 292,516 of the module at
  e1e9b6b8 by +2,839 conjunctions of the 597 objects whose international
  designator is UNKNOWN (windows key objects by designator and catalog number
  since 0.7.0) and -811 events of 71 pairs with identical or nearly identical
  states (the ISS with its modules and visiting vehicles, the Chinese station,
  attached vehicles; relative speed 0, 67 pairs in each window). Since
  4e06269e a window reports a pair's interior minima of range and never a
  window edge, and a constant range has none. The FFM screen differs from its
  earlier run by -4,871 and +47 events for the same reasons; both screens
  have the candidates of the earlier runs.
- FFM's time is propagation: 99,929 CPU-seconds on 8 farm workers
  (user and system time of each worker thread), 0.65 s per object-day; the
  first window, the catch-up from element epochs, took 36 % of it. Its
  end-to-end time is that CPU time on 16 dedicated cores plus search and
  refinement. Measured on the shared host (1-minute load average median 44,
  maximum 82; the farm held its next chunk while the load exceeded 55), the
  screen took 15,210 s, 15,060 s of it waiting on the farm, with 2 module
  threads.
- The FFM row is FFM 1.3.0 at full force with the conjunction module of
  0.7.0, the one the SGP4 rows used, and the environment released at the
  screen's start. 21 objects reentered (100 km) before the screen and are
  excluded; 6 reentered during it and are screened through the last full
  window before their reentry
  ([ffm-full-force-screen-2026-10.md](ffm-full-force-screen-2026-10.md)).
- Against the SGP4 screen (`scripts/compare-screens.mjs`), 39,425 of FFM's
  283,700 conjunctions are the same pair with TCAs within 10 minutes; on
  those, TCAs differ by a median of 1.2 s and miss distances by 691 m.
- AOT compilation (about 10 s, once per install) is not counted.

### Step size

The coarse test is exhaustive at any step, so the step trades sampling for
candidates. SGP4, module search, Node:

| Step | Candidates | Search | Refine | End to end | Conjunctions |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 5 s | 4,748,277 | 92.1 s | 6.9 s | 102.0 s | 294,544 |
| 30 s | 1,414,694 | 17.8 s | 9.7 s | 29.9 s | 294,544 |
| 60 s | 2,675,123 | 9.7 s | 6.6 s | 19.1 s | 294,544 |
| 120 s | 17,116,089 | 10.0 s | 20.4 s | 39.4 s | 294,544 |

The GPU at 5 s took 98.6 s (162.5 s with the all-pairs kernel). All runs report the same conjunctions with miss
distances within 2 mm. TCAs differ by up to 173 ms only on flat minima, where
the miss distance is the same.

### Refinement, step by step

Three days, SGP4, module search, Node, on the same shared host:

| Change | End to end | Refine |
| --- | ---: | ---: |
| Dense TCA scan (modules dc51690) | 131.4 s | 114.3 s |
| Unimodal proof, golden section | 63.9 s | 45.6 s |
| Newton on the range rate | 55.3 s | 38.4 s |
| Same solve as the fast-encounter gate | 34.7 s | 17.6 s |
| Lock-free SGP4 state, GP elements converted once | 25.2 s | 12.7 s |
| Chunked threads, events built in parallel, 1,024-event frames | 19.1 s | 6.6 s |

Every row reports the same conjunctions.

### Against `screen_catalog`

`scripts/compare-single-call.mjs`, stride samples of the same catalog:

| Objects, window | `screen_catalog` | Windowed, CPU search | Conjunctions | Largest difference |
| --- | ---: | ---: | --- | --- |
| 2,000, 0.1 day | 1.1 s | 0.08 s | 23 of 23 | TCA 0.16 ms, miss 0.6 mm |
| 4,000, 1 day | 32.9 s | 0.44 s | 1,068 of 1,068 | TCA 0.64 ms, miss 5 mm |

`screen_catalog` traps out of memory above about 7,000 objects per call.

FFM's own cost at full force is about 0.65 s per object-day on one thread
(0.69 s with perigee below 2,000 km, 0.19 s above; propagator/ffm README,
"Catalog cost"). A day of its 300 s segments is about 240 KB per object, so a
full catalog of PPE does not fit in one module instance; screen it in 1-hour
windows.
