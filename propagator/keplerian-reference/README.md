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

`wasi-sequential`, justified as `caller-level-parallelism`.

Propagation is embarrassingly parallel ACROSS entities and strictly sequential
WITHIN one, and the ABI puts the sharding on the HOST: the frame-worker pool
hands each worker the same output base pointer and a disjoint index range. So
this module spawns nothing, holds no cross-row state, and is therefore safe
under any sharding the host chooses. A module that spawned its own pool would
contend with the pool already scheduling it.

Both thread models compile through the same clang `wasm32-wasip1-threads`
toolchain. `emcc -pthread` is never used — it is browser-only and cannot
thread under WasmEdge.

> `build.js` passes `threadModel` explicitly and asserts the compiler agreed.
> That is required, not belt-and-braces: `resolveThreadModel` reads the compile
> option and otherwise infers from `runtimeTargets`, where `"wasmedge"` infers
> pthreads. Tracked as `sdk-manifest-threadmodel-silently-ignored`.

## Build, test, verify

```bash
npm run build            # -> dist/isomorphic/module.wasm
npm test                 # conformance + contract + lifecycle (17 tests)
npm run vectors:check    # the corpus reproduces from its generator

# tri-runtime parity, from the SDK repo:
space-data-module parity-gate \
  --artifact keplerian-reference=./dist/isomorphic/module.wasm:module
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

## Small bodies (1.1.0)

Asteroids are a second store beside the ABI entity table, because the ABI's
state vector is Earth-fixed by contract and a catalog holds hundreds of
thousands of Sun-centred rows.

| Export | |
|---|---|
| `kepler_small_ingest_omm_stream(data, len)` | size-prefixed SDS `$OMM` records: `CENTER_NAME` SUN, `REFERENCE_FRAME` ecliptic J2000 (RFM coordinate system) or ICRF / J2000 / EME2000 axes, `TIME_SYSTEM` TT or TDB, `SEMI_MAJOR_AXIS` km (or `MEAN_MOTION`), `GM` km³/s² (default DE440 Sun). All or nothing; named refusals (-4 bad input, -6 unphysical, -7 centre, -8 frame, -9 time system) with `kepler_small_failed_record()` |
| `kepler_small_set_photometry(first, count, hg)` | float32 H, G pairs |
| `kepler_small_snapshot(et, first, count, observer, out)` | four float32 per row: x, y, z (m, heliocentric ICRF) and V (H-G, Bowell et al. 1989) from the observer |
| `kepler_small_state(et, index, out)` | one row in double precision: position and velocity, heliocentric ICRF |
| `kepler_small_diameter_from_h(h, albedo)` | equivalent-sphere diameter, m |
| `kepler_small_count()`, `kepler_small_clear()` | |

`et` is TDB seconds past J2000; TT epochs are taken as TDB (at most 1.7 ms).
Rows are independent, so a host shards them across its own workers, as for
`plugin_propagate_batch`.

Evidence (`tests/small-bodies.e2e.test.mjs`, 1,004 Lowell astorb.dat records):
within 2.1 mm of an independent two-body oracle at ±30 and ±400 days; median
366 km (worst 3,485 km) from JPL Horizons 30 days either side of the element
epoch, the two-body simplification. The whole numbered catalog (895,910)
ingests in 0.4 s and snapshots in 0.11 s on one thread.
Credit: astorb.dat, Dr. Edward Bowell, Lowell Observatory (NASA grant
NAG5-4741 and the Lowell Observatory endowment).
