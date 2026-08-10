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
