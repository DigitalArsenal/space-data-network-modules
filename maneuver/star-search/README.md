# Star — interplanetary broad search

Patched-conic interplanetary mission design as an SDN module. Given a body
sequence, epoch windows and grid steps, it returns a **Pareto set of
trajectories** — encounter sequences with their delta-V, flight time, launch C3
and arrival v-infinity.

C++ port of **[UzTak/star-search](https://github.com/UzTak/star-search)** (MIT,
Copyright (c) 2026 Yuji Takubo), pinned at `5c66706`. The Star algorithm is
originally due to **Damon Landau**. Full attribution, the derived-from hash
manifest, and the three paper citations are in
[`vendor/star-search/PROVENANCE.md`](vendor/star-search/PROVENANCE.md).

## How it works

```
EncounterDB  ->  LegDatabase  ->  FlybyDB  ->  streaming combo fold  ->  tfilter  ->  OutputDB
  (nodes)         (arcs)          (patches)     (chains)                             (trajectories)
```

Encounters are discretized into a grid of (body, epoch) nodes. Every feasible
Lambert arc between adjacent grids is pre-solved once. Consecutive arcs are
patched by a powered flyby (delta-V at the patch point). Survivors are stitched
into full trajectories by a streaming left-fold. Because arcs are pre-generated
and **reused**, search cost is polynomial rather than combinatorial — that is
the whole point of the method.

Read [`vendor/star-search/NOTATION.md`](vendor/star-search/NOTATION.md) before
reading the source. The code keeps upstream's paper notation (`IE`, `IL`, `IF`,
`dv_lev`, `eta_lev`, `tfilter`, "null leg") and that file is the glossary.

## Three decisions worth knowing about

### Ephemeris is INPUT, not computation

The module never fetches SPICE kernels — it can't, and it shouldn't. Planetary
states arrive on a typed **`$OEM`** port, one `EPHEMERIS_DATA_BLOCK` per body,
`CENTER_NAME = SUN`, `REFERENCE_FRAME = ECLIPJ2000`. Themis ruled this carrier
on 2026-07-29.

This works because upstream's SPICE surface is tiny: it calls only `furnsh`,
`str2et` and `spkezr`, and `spkezr` only at **encounter grid nodes**. DSMs are
placed mid-arc by Kepler propagation from leg endpoints, never from ephemeris.
So the module's entire ephemeris need is "planetary states at epochs I chose on
a regular grid" — which is a table, not a service.

The payoff is in validation: with ephemeris supplied as data, port fidelity is
isolated from ephemeris error, so parity against the Python reference measures
the *algorithm* and nothing else. An embedded analytic ephemeris would confound
the two. (VSOP87/Meeus-class is fine for broad-search *ranking* — ~150 km
position error at 1 AU against grid steps during which Earth moves ~2.6e6 km —
but it can never reproduce reference vectors, so it stays a gated internal
fallback, off by default and never used in the parity suite.)

### Threaded — unlike the sibling codec

`codec/ccsds124-pocketplus` is deliberately single-threaded because POCKET+ is
inherently sequential. Star is the opposite, and upstream proves it rather than
us asserting it: the reference already marks its hot kernels
`@njit(parallel=True)` (`star/lambert.py:90, 148, 226, 430, 441, 491`), all
row-independent batch Lambert solves. Measured scale on the fast test problem:
leg stages of 114,294 / 301,979 / 52,289 rows, each row an independent
Halley/bracketed root solve.

So this compiles isomorphic-pthreads — clang `wasm32-wasip1-threads` via
`threadModel: "emscripten-pthreads"`. Never `emcc -pthread` (browser-only trap).

Two hard rules follow:

- **`wasi.thread-spawn` can return -1** (the browser lane runs single-threaded
  unless cross-origin isolated). The inline fallback is mandatory, not a
  nicety.
- **Output must be bit-identical at every thread count.** Fixed row-range
  partitioning, preallocated output slots (never completion-order append),
  fixed-index-order reductions.

### Memory is bounded by construction

wasm32 caps at **2 GiB** here (`--max-memory=2147483648`). Upstream's databases
reach 52.6M leg rows / 735.1M flyby rows on its largest problem, so this must be
designed for, not discovered.

The port inherits upstream's own solution: `_ComboStageRows` keeps **six fixed
columns total, including a `parent_row` pointer** into the previous stage's
append-only spool — O(1) row width, each prefix stored once, peak RAM of one stage's
frontier — instead of `SegmentDB` rows that carry full history and force the
cross-product into RAM. Full paths are rebuilt once, for survivors only. An
explicit row cap **fails closed with a status code** rather than trapping.

## Validation

`tests/vectors/reference/` holds the parity oracle: outputs of the upstream
program run unmodified. Both committed problems reproduce upstream's own
published row counts exactly (`test2_EMEJ` → 33, `test1_DVEGA` → 5,952), which
is what makes them worth diffing against. Stage-level intermediate counts are
recorded too, because they localize a bug far faster than the final rows.

See [`tests/vectors/reference/README.md`](tests/vectors/reference/README.md) for
the parity criterion, the pinned NAIF kernel hashes, and `generate-reference.sh`
to reproduce the whole oracle from scratch.

Native Phase 1 build and parity run:

```sh
make -C tests/harness test
make -C tests/harness all
tests/harness/build/star_search_native \
  --problem tests/vectors/test2_EMEJ.problem \
  --ephemeris tests/vectors/test2_EMEJ.ephem \
  --output tests/vectors/test2_EMEJ.cpp.jsonl \
  --threads 1
scripts/compare_output.py \
  tests/vectors/reference/test2_EMEJ.jsonl \
  tests/vectors/test2_EMEJ.cpp.jsonl
```

`STAR_SEARCH_THREADS` is used when `--threads` is omitted. The harness also
accepts `--force-spawn-failure` to exercise the mandatory inline fallback.
The fixture generator takes the upstream checkout explicitly and writes the
two independent inputs:

```sh
scripts/dump_ephemeris.py \
  --upstream-root /path/to/upstream/star-search \
  --problem test2_EMEJ \
  --metakernel star/METAKERN.tm \
  --output tests/vectors/test2_EMEJ.ephem \
  --problem-output tests/vectors/test2_EMEJ.problem
```

The binary layout, interface judgments, stage counts, and measured deviations
are recorded in [`PORTING_NOTES.md`](PORTING_NOTES.md).

## Typed port status

| port | status |
| --- | --- |
| `ephemeris` (input) | typed `$OEM` — **ruled and declared** |
| `problem` (input) | typed `$SLP` solver/search definition |
| `solutions` (output) | typed `$PSS` Pareto solution set |

The two records are shared with targeting and optimization. `$SLP` names the
propagator and evaluator ports instead of binding a provider; `$PSS` carries
each candidate's objective vector, dominance rank, verification residual and
provenance.

Separately, the `$OEM` port also trips `invalid-integer` on the aligned-binary
peer's `byteLength` — but so does every other shipped manifest in this repo,
including `analysis/od`. That is fleet-wide drift, not a defect of this family;
see graph task `mod-manifest-aligned-peer-bytelength-drift`.

Phase 1 scope is the ballistic subset (no DSM leveraging, no resonant legs, no
null legs) — enough for full `test2_EMEJ` parity. Phase 2 adds
`maneuver_placement` (primer-vector DSM placement) and validates against
`test1_DVEGA`. See `PORTING_NOTES.md`.

## Layout

```
plugin-manifest.json          module manifest (attribution + ports + threading)
build.mjs                     SDK build: amalgamate src/ -> one TU -> wasm32-wasip1-threads
scripts/verify-vendor.mjs     license/attribution gate; --against-clone re-proves upstream hashes
src/                          the C++ core (exception-free, wasm-clean)
tests/harness/                native build for fast numerical iteration
tests/vectors/reference/      the parity oracle + its generation script
vendor/star-search/           upstream LICENSE (verbatim), PROVENANCE, NOTATION
```

## License

The port is MIT, matching upstream. `vendor/star-search/LICENSE` is the
upstream notice preserved verbatim; `scripts/verify-vendor.mjs` fails the build
if it is modified.
