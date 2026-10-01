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

An index has one frame (for example TEME for SGP4, GCRF for HPOP), so
mixing SGP4 and HPOP objects requires one propagator to supply the other's
frame. Sampled OEM tracks cannot bound their motion between samples; supply
those as PPE.

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

## Running it

```
node build.mjs
node scripts/run-all-vs-all-gpu.mjs --catalog <omm.uint32be.bin> \
  --start 2461314.5 --days 1 --threshold-km 5 --step-s 60 --out summary.json
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
