# All-vs-all screening with the pair search on a GPU

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
| PPE from any propagator (HPOP's `conjunction-screening` export, or another) | The Chebyshev intervals as given | From the coefficients |

PPE intervals may be in UTC, TT or TDB. A TDB or TT interval maps onto UTC
linearly between its converted ends, using the vendored ERFA from
`foundation/frames`. An interval that contains a leap second is refused.

One propagator per run. An index holds mean elements (SGP4) or trajectories
from one generator (PPE `EPHEMERIS_SOURCE`), never both:
`prepare_screening_index` refuses a mix with `mixed-propagators`. Sampled OEM
tracks cannot bound their motion between samples; supply those as PPE.

A propagator module's output goes in unchanged.
`prepare_screening_index` takes its `$PRW` `DESCRIBE_RESULT` records, as
`propagator/hpop` exports them, on the `trajectories` port. The request's
`SOURCES` then carry identity only: object id, name, catalog number and
handle. Records may be size-prefixed, as a module's `FinishSizePrefixed`
builds them (see the SDK README, "Size-prefixed records"), or plain.

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
`conjunction::tight_pair_may_close`. Before the test, the GPU skips pairs whose
radius bounds differ by more than the threshold. Each step's bound is the
range of |r_k + v_k τ| over the interval, widened by D.

Passing steps join into encounters, which are refined as `screen_catalog`
refines its own, through one source-based TCA search
(`conjunction_assessment.h`).

## Methods

**`coarse_grid`** takes:

- `request`: a CQR `WINDOW_REQUEST` on an index with no primaries, with
  `ALFANO_MAXIMUM` controls;
- `block`: `CAB1`, then u32 `first_step` and u32 `step_count` (1–256).

It returns:

- `grid`: `CAG1`, then u32 first, count and objects, then f32 states
  `[step][object][x, y, z, D, vx, vy, vz, 0]` and f32 radius bounds
  `[object][lo, hi]`. Excluded objects are NaN.
- `report` (JSON): `last_step`, `objects`, and `excluded` (index, first
  failing JD, reason).

**`refine_candidates`** takes:

- the same `request`;
- optionally, `candidates`: `CAC1`, u32 count, then u32 (obj1, obj2, step)
  triples;
- optionally, `excluded`: `CAX1`, u32 count, then (u32 index, f64 JD).

It returns `screen_catalog`'s `result` chunks and `excluded` OMMs. Without
`candidates`, it scans every pair at every step on the CPU.

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
- **HPOP and other trajectory propagators:** each window loads only that
  window's trajectories and releases them after. A day of HPOP's 10-minute
  intervals is about 90 KB per object; a 2-hour window of the full catalog is
  about 400 MB.

The merged result is a single screen of the whole span:

- A conjunction belongs to the window that holds its TCA.
- A TCA within the refinement tolerance of a shared edge is reported in both
  windows and kept once.
- An object excluded in any window, by the module or by the propagator, has
  no conjunctions anywhere.

`tests/windowedScreenParity.test.mjs` checks four windows against one screen
for both propagators.

### The HPOP propagation farm

`scripts/lib/hpopFarm.mjs` runs on worker threads:

1. `analysis/epoch-state` turns each element set into a GCRF state at its
   epoch: SGP4 at zero elapsed time, then TEME to GCRF through ERFA.
2. `propagator/hpop` integrates those states. A resident instance holds at
   most 1,024 objects; objects are dealt round-robin into about two instances
   per worker.
3. Each window, every instance prepares the window and describes its sources.
   The `$PRW` records go to the page unchanged, and the next window is
   prepared while the page screens the current one.

An object HPOP cannot cover is found by preparing objects one at a time. It
leaves its instance and is excluded from the whole span.

HPOP integrates every object from its element epoch, so the first window
carries that catch-up. HPOP prunes cache intervals that end before the
requested window, so an instance holds about one window per object.

## Running it

```
node build.mjs
node scripts/run-all-vs-all-gpu.mjs --catalog <omm.uint32be.bin> --propagator sgp4|hpop \
  --start 2461314.5 --days 3 [--window-hours 6|2] --threshold-km 5 --step-s 60 [--cpu] --out summary.json
# no browser, no GPU (Node, or WasmEdge as on an SDN node):
node scripts/run-all-vs-all-cpu.mjs --catalog <omm.uint32be.bin> --runtime wasmedge --aot \
  --propagator sgp4|hpop --days 3 --out summary.json
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
- **HPOP:** HPOP-integrated crossing orbits (`tests/fixtures/hpop-ppe`, from
  `scripts/generate-hpop-ppe-fixture.mjs`). The GPU path must equal the
  exhaustive CPU scan and hold each pair's closest approach as
  `screen_window` finds it.

## Measured

### Three days, whole catalog, one propagator per run

The catalog is the Space-Track GP catalog of 2026-09-30, 32,514 objects. The
screen covers 2026-10-01T00:00Z plus 3 days, with a 5 km threshold and 60 s
steps. The host was a Mac Studio (28 cores) running headless Chrome on Metal.

| Propagator | Windows | End to end | Propagation | Grid | GPU | Refine | Candidates | Conjunctions |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| SGP4 (module, element sets) | 12 × 6 h | 132 s | in grid | 8.9 s | 8.3 s | 107.6 s | 2,678,533 | 292,516 (25 objects excluded) |
| HPOP (farm: 26 workers, 52 instances) | 36 × 2 h | 338 s | 320 s, overlapped | 4.2 s | 8.6 s | 16.7 s | 3,080,922 | 301,396 |

- **SGP4:** refinement is the cost, because each TCA solve re-runs SGP4.
- **HPOP:** the propagator is the cost. Its 320 s are 123 s of catch-up in
  the first window, integrating every object from its element epoch, about
  2.4 days on average, then about 5.6 s per 2-hour window. Screening a
  window takes under a second, and it overlaps the next window's
  propagation. Refining on trajectories takes 16.7 s, against 107.6 s with
  SGP4.
- The two runs report different conjunctions because they are different
  propagators.

Without a GPU, with SGP4 over 3 days, 12 × 6 h windows, 27 module threads:

| Host | End to end | Search | Refine | Candidates | Conjunctions |
| --- | ---: | ---: | ---: | ---: | ---: |
| Node (V8) | 131.4 s | 14.4 s | 114.3 s | 2,675,123 | 292,516 |
| WasmEdge 0.16.4, SDN-patched, AOT (as an SDN node) | 161.4 s | 17.4 s | 141.8 s | 2,675,123 | 292,516 |

Both find the same conjunctions as the GPU run. With SGP4, refinement is most
of the time, so the GPU saves little: 132 s with it, 131 s without. AOT
compilation takes about 12 s once per install and is not counted.

### One day, single window

The run used the Space-Track GP catalog of 2026-09-30, with 32,514 objects.
The window was 2026-10-01T00:00Z plus 1 day, with a 5 km threshold and 60 s
steps. The host was a Mac Studio running headless Chrome on Metal, with 27
module threads.

| Stage | Time | |
| --- | ---: | --- |
| Load the index (32,514 SGP4 sources, once) | 1.5 s | |
| `coarse_grid`, 1,441 steps (46 calls) | 3.3 s | |
| GPU pair search, 528.6 M pairs × 1,441 steps | 3.3 s | 829,990 candidates proposed; 828,910 passed the f64 test |
| `refine_candidates` | 46.7 s | 661,321 encounters refined |
| Total | 55.4 s | 77,667 conjunctions; 20 objects excluded |

The first version sent the whole catalog with every call and took 266.7 s.
`screen_catalog` traps out of memory above about 7,000 objects per call.
Refinement is now 84 % of the time.

Against `screen_catalog` on stride samples of the same catalog, with the same
request:

| Objects, window | `screen_catalog` | GPU example | Conjunctions | Largest difference |
| --- | ---: | ---: | --- | --- |
| 2,000, 0.1 day | 2.3 s | 0.3 s | 23 of 23 | TCA 0.3 ms, miss 2 mm |
| 4,000, 1 day | 220.9 s | 4.7 s | 1,068 of 1,068 | TCA 0.64 ms, miss 7 mm |

HPOP's own cost is about 41 ms per object-day for one resident instance
(200 LEO objects, one day, `conjunction-screening` profile). A day of its
10-minute intervals is about 90 KB per object, so a full catalog of PPE does
not fit in one module instance; screen it in time windows.
