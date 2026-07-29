# Star Phase 1 porting notes

## Scope and interface decisions

This is the ballistic Phase 1 port of the live upstream pipeline:

`EncounterDB -> LegDatabase -> FlybyDB -> streaming combo fold -> tfilter -> OutputDB`

It traces `run_combo`; the unused paper-triplet path is not ported.

The two inputs are deliberately separate:

1. Ephemeris is the temporary in-memory representation of the typed SDS `$OEM`
   input. There is one table per body, corresponding to one
   `EPHEMERIS_DATA_BLOCK`, with `CENTER_NAME=SUN`,
   `REFERENCE_FRAME=ECLIPJ2000`, and row-major `EPHEMERIS_DATA`.
2. The problem definition is a separate native-harness text fixture. It does
   not imply a merged wire contract. The WASM adapter will replace this parser
   with the ratified problem FlatBuffer record when that SDS code exists.

The problem fixture stores the normalized values returned by upstream
`_resolve_problem_config`, including tightened encounter-stage ET bounds. This
keeps the core input at the eventual record-decoder boundary and prevents the
temporary harness format from becoming a schema. The native parser is bounded
to 64 KiB, rejects missing/non-finite required numerics and narrowing
overflows, and is not compiled into the guest core. `tfilter_enabled` preserves
upstream's optional `tfilter_dt_s=None` behavior without inventing a sentinel
bin width.

## Temporary ephemeris binary format

`scripts/dump_ephemeris.py` regenerates the ephemeris and the separate problem
fixture from an installed upstream checkout. The ephemeris binary is versioned,
little-endian, has no pointers, and makes no host-struct padding assumptions.

Header:

| field | encoding |
| --- | --- |
| magic | 8 bytes: `STAREPH\0` |
| version | `u32`, currently 1 |
| body count | `u32` |
| total sample count | `u64` |

Each body table:

| field | encoding |
| --- | --- |
| NAIF body ID | `i32` |
| reserved | `u32`, must be zero |
| GM | `f64`, km³/s² |
| mean radius | `f64`, km |
| sample count | `u64` |

Each sample is seven `f64` values:
`epoch_et_s, x_km, y_km, z_km, vx_km_s, vy_km_s, vz_km_s`.

The core decoder bounds body/sample counts before allocation, rejects duplicate
bodies, non-finite values, non-increasing epochs, invalid constants, and
trailing bytes. Exact epoch matches bypass interpolation. Off-grid requests use
an eight-point centered Lagrange interpolant (or all available points when
fewer than eight exist). Upstream never exercises interpolation because SPICE
is sampled at every encounter-grid epoch; the eight-point policy is therefore
a general-input judgment call, not a parity-path numerical change.

## Numerical fidelity choices

- The Arora–Russell cosine-transformation Lambert solver was translated
  branch-for-branch. The elliptic, hyperbolic, near-`sqrt(2)` series, and
  small-`k` paths retain upstream constants and branching.
- `series_eps=2e-2`, `delta_m=1e-12`, snap thresholds, Halley/bracket
  tolerances, and the fixed 15/20/40 iteration limits are unchanged.
- Batch solution emission retains Python order: input row first, then the same
  zero-/multi-revolution branch order. Parallel workers write fixed input
  ranges to preallocated slots and compaction is by source index.
- Encounter grids retain the exact `floor(range/dt + 1e-12)` and
  `epoch <= max + 1e-9` rules. `IE`, `IL`, and `IF` values are immutable.
- Ballistic legs require `dv_lev_km_s == 0` and emit `eta_lev == 0.5`.
- The leg/flyby fixpoint physically compacts active rows instead of maintaining
  upstream disk `active_mask.npy` files. Original ordering and immutable IDs
  are preserved, so this is a storage-policy difference only.
- Combo stages use the upstream fixed-width columns
  `leg0_il, dep_ie, right_leg_il, dv_total_km_s, flyby_if` plus
  `parent_row`. Prefixes are stored once in append-only bounded buffers and
  only the current stage is expanded. Because the guest core has no filesystem,
  persisted prefix spools remain in bounded linear memory until reconstruction.
- Final tfilter ordering matches NumPy `lexsort`: full body sequence,
  departure bin, arrival bin, delta-V, then original row for stable ties.
- The full DE431 and DE440 GM tables, PCK radius table, and legacy
  semi-major-axis table were transcribed, including upstream's unusual
  barycenter entries in the semi-major-axis dictionary.

The only measured numerical differences are final-bit effects from native
clang/libm versus Python/Numba. No algorithmic tolerance was relaxed.

## Bounds, threading, and errors

- Every growable core array uses `MemoryBudget` and an explicit row cap.
  Exhaustion returns `MemoryLimitExceeded`, `RowLimitExceeded`, or
  `AllocationFailed`; it cannot silently grow to a wasm trap.
- Problem memory caps above 2,147,483,648 bytes are rejected.
- A caller-supplied `MemoryBudget` may be stricter than the problem cap, but
  cannot exceed either the problem cap or the wasm32 ceiling.
- Encounter-grid cardinality and cumulative stage rows are checked against the
  row cap before epoch iteration, so a malicious tiny grid step fails closed
  instead of becoming an unbounded loop.
- Tfilter bin values are range-checked before conversion to signed 64-bit
  indices; non-finite or unrepresentable bins return `InvalidInput`.
- The caller supplies the requested thread count. Work is partitioned into
  fixed contiguous row ranges. A failed `pthread_create` runs that range
  inline, including mixed spawned/inline execution.
- The guest core uses no exceptions, RTTI, filesystem, iostream, or dynamic
  standard-library containers.
- DSM leveraging, resonant legs, and null legs return
  `UnsupportedDsm`, `UnsupportedResonant`, and `UnsupportedNullLeg`
  respectively.

## Recorded `test2_EMEJ` parity

Native build flags:
`clang++ -std=c++17 -fno-exceptions -fno-rtti -O2 -pthread`.

Observed stage counts:

```text
EncounterDB entries: 6227
leg 0: 114294
leg 1: 301979
flyby 1: 20111
leg 2: 52289
flyby 2: 90
final fixpoint: 1 pass, removed=0
combo stage 1: 10
combo stage 2: 90
final trajectories: 90
tfilter: num_bins=33, num_out=33
```

The 1-thread, 4-thread, and forced-spawn-failure JSONL outputs were byte
identical, SHA-256
`a582b549c856f6dacc8f0d043f58215e12f9eb25664115c592b16cc0a5f0a2cf`.
Peak core memory tracked by the fixture run was 62,035,984 bytes.

Against `tests/vectors/reference/test2_EMEJ.jsonl`:

- rows: 33 vs 33
- exact mismatches: 0 for `traj_id`, `body_ids`, `t_et_s`, `leg_ils`,
  and `flyby_ifs`
- maximum relative deviations:
  - `vinfD_km_s`: `6.5760614947210457e-15`
  - `vinfA_km_s`: `9.9984832788791922e-13`
  - `dv_patch_km_s`: `7.111128220422399e-12`
  - `dv_total_km_s`: `2.939830809868499e-12`
  - `dv_escape_km_s`: `3.9807302206984388e-15`
  - `dv_insertion_km_s`: `2.6933663686990533e-15`
- `dv_lev_km_s`, `eta_lev`, `tof_total_days`, and epochs were exact.

The complete per-field measurement is recorded in
`tests/vectors/test2_EMEJ.parity.txt`.

## Phase 2

Still excluded, with explicit unsupported statuses where applicable:

- DSM placement, `solve_arc`, and primer-vector work from
  `maneuver_placement.py`
- resonant legs from `resonant.py`
- null legs
- plotting, `.npy` stage persistence, and memory-report utilities

Phase 2 also needs a parity fixture that exercises DSM placement and the
ratified SDS problem/solution records once their standard codes exist.

The WASM build and guest ABI adapter were deliberately not attempted in this
phase, per the integration boundary for this task. The current source is
multi-translation-unit C++17 and guest-safe; SDK-specific method glue and any
single-TU amalgamation manifest remain build-wiring work once the held problem
and solution SDS records are ratified.
