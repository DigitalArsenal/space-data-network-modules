# All-vs-all screening with the pair search on a GPU

Every object of a catalog against every other. The module still runs SGP4,
refinement, probability and exclusions in WASM. Only the pair search moves to
the GPU, and the result is `screen_catalog`'s result for the same request.

```
coarse_grid        module: SGP4 for every object at a block of coarse steps
  -> GPU search    gpu/screen_kernel.wgsl: proposes (pair, step) candidates
  -> refine_candidates   module: f64 re-test, encounters, TCA, Pc, exclusions
```

`gpu/allVsAll.mjs` moves frames between the module and the GPU and contains no
physics. `gpu/gpuScreen.mjs` runs the kernel on any WebGPU device.

## The candidate test

Take a coarse interval [t_k - h, t_k + h], where h is half the coarse step.
Over that interval an object's true path stays within ½ A τ² of the straight
line from its sample. A bounds the acceleration over the interval:
A = 1.05 μ / (|r| - |v| h)², floored at a radius of 6,000 km. The 5 % covers
J2 and drag.

So a pair can come within the threshold during the interval only if the
straight-line relative path comes within threshold + ½ (A₁ + A₂) h².

`conjunction::tight_pair_may_close` (`src/cpp/include/conjunction/screening_tight.h`)
is the authoritative form of the test:

- The GPU applies it in f32, adding 0.01 km of slack, so it proposes a superset.
- `refine_candidates` repeats it in f64.
- Passing steps of each pair are joined into encounters. They are then refined
  as `screen_catalog` refines its coarse encounters.

## Methods

**`coarse_grid`** takes:

- `request`: a CQR `CATALOG_REQUEST`, all-vs-all, `ALFANO_MAXIMUM`;
- `catalog`: the OMM frames;
- `block`: `CAB1`, then u32 `first_step` and u32 `step_count` (1–256).

It returns:

- `grid`: `CAG1`, then u32 first, count and objects, then f32 states
  `[step][object][x, y, z, A, vx, vy, vz, 0]` and f32 radius bands
  `[object][lo, hi]`. Excluded objects are NaN.
- `report` (JSON): `last_step`, `objects`, and `excluded` (index, first failing
  JD, reason).

**`refine_candidates`** takes:

- the same `request` and `catalog`;
- optionally, `candidates`: `CAC1`, u32 count, then u32 (obj1, obj2, step) triples;
- optionally, `excluded`: `CAX1`, u32 count, then (u32 index, f64 JD).

It returns `screen_catalog`'s `result` chunks and `excluded` OMMs. Without
`candidates` it scans every pair at every step on the CPU, which is the
reference for the GPU path.

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

`tests/gpuScreenParity.test.mjs` checks the path against `screen_catalog` on a
committed catalog that includes an object SGP4 cannot propagate. The candidate
search in that test proposes every pair, so the module's f64 test decides
every candidate.

## Measured

The run used the Space-Track GP catalog of 2026-09-30, with 32,514 objects.
The window was 2461314.5 (2026-10-01T00:00Z) plus 1 day, with a 5 km
threshold and 60 s coarse steps. The host was a Mac Studio running headless
Chrome on Metal, with 27 module threads.

| Stage | Time | |
| --- | ---: | --- |
| `coarse_grid`, SGP4 at 1,441 steps (46 calls) | 113.8 s | |
| GPU pair search, 528.6 M pairs × 1,441 steps | 3.2 s | 829,990 candidates proposed; 828,910 passed the f64 test |
| `refine_candidates` (8 calls; one call over the 16,384-event output staging limit was split) | 148.3 s | 661,321 encounters refined |
| Total | 266.7 s | 77,667 conjunctions; 20 objects excluded |

`screen_catalog` traps out of memory above about 7,000 objects per call.

The same candidate search on the CPU took 159.9 s; it was the f64 test in
native C++ on 28 threads, over the same grid. Both found the same 828,910
candidates after the f64 test.

Against `screen_catalog` on stride samples of the same catalog, with the same
request:

| Objects, window | `screen_catalog` | GPU example | Conjunctions | Largest difference |
| --- | ---: | ---: | --- | --- |
| 2,000, 0.1 day | 2.3 s | 0.3 s | 23 of 23 | TCA 0.3 ms, miss 2 mm |
| 4,000, 1 day | 220.9 s | 4.7 s | 1,068 of 1,068 | TCA 0.64 ms, miss 7 mm |
