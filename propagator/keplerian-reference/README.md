# Keplerian Reference Propagator

**The reference implementation of the official OrbPro WASM propagator ABI.**
Contract: [`space-data-module-sdk/docs/propagator-abi.md`](../../../space-data-module-sdk/docs/propagator-abi.md).

This module exists to be copied. It is a two-body Keplerian propagator — the
simplest physics that is still honest — so that everything else in the file is
visibly contract rather than cleverness. Every export is annotated with the
section of the ABI document it implements.

```
space-data-module init --family propagator --name my-propagator
```

scaffolds this module's skeleton.

## What it is

| | |
|---|---|
| Family | `propagator` |
| Plugin id | `com.orbpro.keplerian.reference` |
| Toolchain | clang `wasm32-wasip1-threads` via the SDK compiler lane |
| Thread model | `wasi-sequential` (justified — see below) |
| Input port | ratified SDS `$OMM`, typed, no wildcard |
| Output | `OrbProStateVector`, **METERS**, ECEF |
| Artifact | `dist/isomorphic/module.wasm` |

## What it is NOT

It is two-body: no drag, no J2, no third bodies. Against a real satellite it
diverges from SGP4 within hours, **by design**. Comparing it to SGP4 and
calling the difference an error measures the physics it deliberately omits.

## The ABI surface it implements

| Export | ABI § |
|---|---|
| `plugin_init(data, len)` | §4 — generic init over packed `OrbProOMMRecord` |
| `plugin_init_omm(records, count)` | §4 — typed ingest, REPLACES the element set |
| `plugin_ingest_omm_one(record)` | §8 — appends and **returns the handle it assigned** |
| `plugin_propagate(jd, index, out)` | §4 |
| `plugin_propagate_batch(jd, out, count)` | §4 / §9 — host-shardable |
| `plugin_entity_count()` | §4 |
| `plugin_destroy()` | §11 — **real**, and it passes the leak test |
| `ingest_omm` (invoke surface) | typed `$OMM` port; decodes the ratified FlatBuffer |

## Four things it does that the first-party propagators do not

1. **`plugin_destroy` actually releases.** `destroySource()` is literally `{}`
   in both shipped first-party propagators, and both fail the lifecycle leak
   test because of it. This one passes `tests/lifecycle.test.mjs` — 200 cycles,
   zero page growth after warm-up — and the test carries a negative control
   proving the metric can move. Bringing the first-party propagators up to this
   bar is W1.5.
2. **Creating state returns its handle.** `plugin_ingest_omm_one` returns the
   index it assigned. No caller derives "the entity I just created" as
   `count − 1`; three families in this stack reinvented that derivation and all
   three are race-unsafe.
3. **Its ports are typed to ratified `$` identifiers.** No
   `acceptsAnyFlatbuffer`, no invented four-byte type. It decodes the real
   `$OMM` FlatBuffer, with the vtable slots derived at build time from the
   pinned SDS schema rather than hand-typed.
4. **It declares no ABI struct of its own.** The structs come from the
   generated header, resolved from the pinned SDK and inlined by `build.js`.
   Five hand-vendored mirrors of `OrbProStateVector` is what W1.1 ended.

## Thread model

`emscripten-pthreads` (1.7.0; owner 2026-10-13: modules built with pthreads
on a SharedArrayBuffer memory): the SDK's isomorphic wasi-threads contract,
clang `wasm32-wasip1-threads`, an imported shared memory, `wasi.thread-spawn`
and `wasi_thread_start`. `emcc -pthread` is never used: it is browser-only and
cannot thread under WasmEdge.

The propagator ABI's entity exports still spawn nothing and hold no cross-row
state, so a host may shard them as before. The small-body catalog surface
(below) runs its own pool of pthreads.

The single-thread path exists only where the SDK's tri-runtime tools need it:
`dist/sequential/module.wasm` is the same source without the catalog surface,
built `wasi-sequential` for the SDK's propagator conformance runner and the
WasmEdge CLI, which instantiate without threads.

> `build.js` passes `threadModel` explicitly and asserts the compiler agreed.
> That is required, not belt-and-braces: `resolveThreadModel` reads the compile
> option and otherwise infers from `runtimeTargets`, where `"wasmedge"` infers
> pthreads. Tracked as `sdk-manifest-threadmodel-silently-ignored`.

## Build, test, verify

```bash
npm run build            # -> dist/isomorphic/module.wasm
npm test                 # conformance + contract + lifecycle (17 tests)
npm run vectors:check    # the corpus reproduces from its generator

# tri-runtime parity (browser, WasmEdge, Docker WasmEdge) of the threaded
# build: the invoke surface byte-identical in every lane
PATH=$HOME/.wasmedge/bin:$PATH npm run test:parity   # -> conformance/parity.json
```

`npm run build` needs `space-data-module-sdk` resolvable and the wasi
toolchain installed (`brew install wasi-libc wasi-runtimes`).

## Conformance

`vectors/vectors.json` — 15 Tier B closed-form anchors across four element
sets chosen for the failures they expose (near-circular LEO, e=0.72 Molniya,
the e=0/i=0 degenerate case, retrograde sun-synchronous), plus five Tier C
invariants with no stored expectation at all. The generator refuses to emit a
row whose orbital energy does not close.

Provenance, tolerance policy and the reason there is no Tier A row:
[`vectors/PROVENANCE.md`](vectors/PROVENANCE.md).

## Small bodies (1.1.0; perturbed paths 1.6.0)

Asteroids are a second store beside the ABI entity table, because the ABI's
state vector is Earth-fixed by contract and a catalog holds hundreds of
thousands of Sun-centred rows.

| Export | |
|---|---|
| `kepler_small_ingest_sbd_stream(data, len)` | size-prefixed SDS `$SBD` small-body records (asteroids and comets are never `$OMM`): `CENTER_NAME` SUN, `REF_FRAME` ECLIPJ2000 or ICRF / EME2000 / J2000, `TIME_SYSTEM` TDB or TT, `SEMI_MAJOR_AXIS` km and `MEAN_ANOMALY` (or a comet's `PERICENTER_DISTANCE` and `PERICENTER_EPOCH`), `GM` km³/s² (default DE440 Sun), `ABSOLUTE_MAGNITUDE` (H) and `SLOPE_PARAMETER` (G). All or nothing; named refusals (-4 bad input, -6 unphysical, -7 centre, -8 frame, -9 time system) with `kepler_small_failed_record()` |
| `kepler_small_describe_sbd_stream(data, len, count, numbers, hgd, offsets, names, capacity)` | the display fields of the same stream without storing it: uint32 NUMBER, float32 H, G, DIAMETER per record, and NAME (else DESIGNATION) packed as UTF-8 with byte offsets |
| `kepler_small_select_sbd_stream(data, len, class_mask, h_min, h_max, exclude, exclude_bits, out, capacity)` | the records of a stream a selection keeps, unchanged and size-prefixed: ORBIT_CLASS bit in `class_mask` (0 = any), H in [h_min, h_max) (NaN = open), NUMBER not set in the `exclude` bitmap; the console's size-band and class filter. `out` may be `data` (in place) |
| `kepler_small_snapshot(et, first, count, observer, out)` | four float32 per row: x, y, z (m, heliocentric ICRF) and V (H-G, Bowell et al. 1989) from the observer; NaN outside the validity span |
| `kepler_small_snapshot_apparent(et, first, count, observer, out)` | as `kepler_small_snapshot`, but each row is where the body is SEEN: light time (three iterations) and first-order stellar aberration, NAIF LT+S, the correction `propagator/solar-system-bodies` applies to planets. `observer` is 10 doubles: heliocentric position (m), barycentric velocity (m/s), the Sun's barycentric velocity (m/s), and the TDB epoch (s past J2000) they hold at; the module moves the observer on to `et` with its heliocentric velocity, so a host passes its frame's camera as it is; the row is observer + apparent vector, so a host draws it like a geometric row. Against JPL Horizons LT+S (tests/small-bodies-apparent.e2e.test.mjs): (1), (3), (4), (7), (16), (433), (1036), (1862), (4179), (99942), (101955) within 0.79" at the element epoch and ±30, ±45 and ±59.5 days; the geometric rows are 2.6-33.5" off |
| `kepler_small_state(et, index, out)` | one row in double precision: position and velocity, heliocentric ICRF; -10 outside the validity span |
| `kepler_small_set_validity(seconds)` | the span either side of each row's element epoch in which it is drawn (default 60 days). Outside it a snapshot row is NaN and a state is refused |
| `kepler_small_validity_range(out)` | four doubles: the epochs between which every row is valid, and between which any row is |
| `kepler_small_diameter_from_h(h, albedo)` | equivalent-sphere diameter, m |
| `kepler_small_count()`, `kepler_small_clear()` | |

`et` is TDB seconds past J2000; TT epochs are taken as TDB (at most 1.7 ms).
Rows are independent, so a host shards them across its own workers, as for
`plugin_propagate_batch`. The rows are kept in blocks of 65,536 (no
reallocation as a catalog grows shard by shard: a module's linear memory keeps
its high-water mark), and an ingest writes rows straight into the store.

**Perturbed paths (1.6.0; clock-independent 1.8.1; phased grids and one anchor 1.9.0).** Osculating elements are
a conic only at their epoch; the planets pull a body off it (two-body alone put
(16) Psyche 1.44" from Horizons at +45 days and 3" at +60). A row is carried
along its perturbed path on a grid of checkpoints keyed to its element epoch:
every four days for a near-Earth orbit (perihelion within 1.3 AU), every eight
for the rest, whose path leaves a conic by under 80 km over the four days to the
nearest checkpoint. Each row's grid has its own phase (one of 16, a hash of its
elements), so the rows of a catalog cross their checkpoints at different
epochs, not all in one snapshot. Each checkpoint is the one before it on its
side of the epoch integrated one grid step (Encke's method, RK4) under the Sun
and the eight planets (Mercury, Venus, the Earth-Moon barycentre, the Mars,
Jupiter, Saturn, Uranus and Neptune systems; DE440 GMs, places from Standish's
JPL SSD mean orbits, 1800-2050) and re-osculated, and an export at et uses the
conic of the checkpoint nearest et. The RK4 step is the grid step, refined
within 0.2 AU of a planet and near the Sun (0.08 of the body's dynamical time
sqrt(r^3/GM): about half a day at (3200) Phaethon's 0.14 AU perihelion). The
rows of one phase share the planets' places at their steps (a table per pool
thread).

The record's elements are never changed: a checkpoint is held as float32
differences from the record's conic carried to it (semi-major axis,
eccentricity, mean anomaly, and the turn of the perifocal frame, kept as a
quaternion), and a checkpoint is only ever reached from its neighbour toward
the epoch, so a row's place at et is a function of et alone, bit for bit,
whatever the clock visited before. A row keeps its current checkpoint and one
anchor, a checkpoint it passed nearer the epoch: a step away from the epoch
costs one grid step, and a step back continues from the anchor (or the
record). Whenever a row passes checkpoints it keeps as its anchor the one
nearest m - 1 - floor(sqrt(2m)) for its new distance m from the epoch, so a run
back to the epoch costs about 2.3 grid steps a checkpoint on average. A row is
128 bytes; rows a catalog reserves but never fills cost no memory (raw
storage, written when pushed). 1.8.2 kept two anchors and a work slot (272-byte
rows); with every numbered asteroid in the console the slowest snapshot running
toward the epoch at 2-3 days a second was 0.8-1.1 s (every row crossed its
checkpoints in the same snapshot) and the catalogs added 1.19 GB. 1.8.0
replaced the elements in place from wherever the clock had last been, with a
fixed 6-day step (twice Phaethon's dynamical time at perihelion): Phaethon
brought back to its epoch after a visit 50 days earlier was 12,886 km off. The
record's own epoch still bounds the validity span.

Evidence (`tests/small-history.e2e.test.mjs`): states and snapshots
bit-identical after excursions to -50, +55 and -55/+55/-3 days, along a run
from +58 days back across the epoch to -58 days, and after random histories
(runs either way at 0.3-4 days a snapshot, jumps, epoch crossings); against JPL
Horizons over +-55 days after any of those histories, Phaethon 39-102 km and
(137924) 2000 BD19 (q 0.092 AU) 54-254 km. (329915) 2005 MB is 600-3,013 km:
Lowell's orbit for it (computed 2025-08-02, CEU 0.46") is itself 2,192 km from
JPL's at the element epoch, before any propagation. A 56-day sweep of the
1,004-row sample at a snapshot per 12 hours: 25-28 ms away from the epoch and
30-35 ms toward it, the slowest snapshot 0.5-0.7 ms (1.8.2: 29-32 ms, slowest
1.9-2.4 ms).

Evidence (`tests/small-bodies.e2e.test.mjs`, 1,004 Lowell astorb.dat records):
within 78 km of an independent two-body oracle of the record within two days
of the element epoch (the nearest checkpoint is half a grid step away at
most); median 89 km (worst 876 km) from JPL Horizons 30 days either side of the
element epoch along the perturbed path (two-body: median 366 km, worst 3,485
km). The whole numbered catalog (895,910) ingests in 0.4 s.
Credit: astorb.dat, Dr. Edward Bowell, Lowell Observatory (NASA grant
NAG5-4741 and the Lowell Observatory endowment).

## The small-body catalog surface (pthreads, 1.7.0)

One instance holds a whole catalog; its memory is a SharedArrayBuffer the host
reads in place (`src/small_body_catalog.hpp`). `kepler_catalog_init(capacity,
name_bytes, threads)` reserves the rows, the snapshot and the display arrays
and starts a pool of `threads` pthreads; it returns a table of addresses (an
internal layout, documented in the header; no SDS schema describes
engine-module buffers). Jobs are begun, never waited for, by the calling
thread (a browser's main thread may not block): `kepler_catalog_ingest_begin`
(a shard's size-prefixed `$SBD` records, the selection made in place, decoded
into the reserved store with their number, H, G, diameter and name beside
them) and `kepler_catalog_snapshot_begin` (every row's apparent place and V,
row ranges split across the pool). Each returns a sequence; a control word
reaches it when the job is done (the host waits with `Atomics.waitAsync`).
Nothing a job runs allocates, so the caller's own allocations never meet a
pool thread on the allocator's lock; each thread keeps its own planet-place
cache. Without threads a job runs inside its begin call.

On the calling thread: `kepler_catalog_search` (number, then name prefixes,
then inner matches, ASCII case folded), `kepler_catalog_find_number`,
`kepler_catalog_number_bitmap`, and promoted rows (`kepler_catalog_promote`,
`kepler_catalog_state`, `kepler_catalog_apparent_offset`) evaluated in double
precision from a copy made between two jobs.

The small-body layer's display decisions are here too
(`src/small_body_display.hpp`): `kepler_small_fade_rate` (the clock rate and
the fade with the camera's distance), `kepler_small_schedule` (the GPU mix
between two snapshots and when, and for which epoch, the next is asked for;
never past the rows' validity span) and `kepler_small_display_radius`.
Since 1.8.0 the schedule also says when the drawn snapshot is stale (taken for
an observer more than 1e9 m from this one: the camera jumped, and its light
time and aberration are another observer's; the layer is not drawn until a
snapshot for this observer arrives), and asks for the present epoch when the
drawn pair is more than four times wider than the clock rate's spacing (a fast
run leaves pairs up to 12 h apart; a straight mix across them is off by up to
~1" for a near-Earth asteroid) (`tests/small-schedule.e2e.test.mjs`).

Evidence (`tests/small-catalog.e2e.test.mjs`): three pool threads run; a
shard ingests with the select and describe exports' results; a threaded
snapshot equals the single-thread `kepler_small_snapshot_apparent` bit for
bit; a promoted row equals `kepler_small_state`.
