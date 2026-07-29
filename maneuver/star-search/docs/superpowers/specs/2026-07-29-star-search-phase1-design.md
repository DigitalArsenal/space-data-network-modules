# Star Search Phase 1 C++17 Port Design

## Goal

Port the live ballistic `Star` search pipeline from its Python/NumPy/Numba
reference to portable, exception-free C++17 while preserving row identity,
selection order, numerical branches, and the published `test2_EMEJ` result.

The acceptance path is:

```text
problem input + ephemeris input
  -> EncounterDB
  -> LegDatabase[0..2]
  -> FlybyDB[1..2]
  -> leg-filter fixpoint
  -> streaming combo fold
  -> final tfilter
  -> OutputDB
```

The implementation must reproduce these gates in order:

```text
EncounterDB: 6227
leg 0:       114294
leg 1:       301979
flyby 1:      20111
leg 2:        52289
flyby 2:          90
fixpoint: 1 pass, removed 0
combo: 10, then 90
final pre-tfilter: 90
final tfilter: 33
```

## Scope

Phase 1 includes the Arora-Russell Lambert batch solver, deterministic encounter
grid generation, ballistic leg construction, powered-flyby patching,
forward/backward fixpoint pruning, the live `run_combo` streaming left fold,
output reconstruction, and final tfilter.

DSM/primer-vector placement, resonant legs, null legs, plotting, NumPy stage
files, and memory-report tooling are excluded. Requests that enable one of
these features return a specific `Unsupported*` status before search work
begins.

The unused paper-triplet path is not ported.

## Chosen Architecture

The port is reference-shaped. Functions and stage boundaries follow the Python
call path closely enough that a mismatch can be localized against a named
upstream function. This is preferred over either a generic trajectory-search
framework or mechanical whole-file transpilation: both alternatives make
ordering and branch-parity failures harder to isolate.

Core files are split by responsibility:

- `status.*`: stable status codes and static diagnostic text.
- `bounded_buffer.*`: checked `malloc`/`realloc`-backed storage and a shared
  byte budget; no throwing allocation in the guest core.
- `types.*`: problem, ephemeris, database, output, limit, and statistics types.
- `constants.*`: exactly transcribed upstream GM, radius, and semi-major-axis
  tables.
- `ephemeris.*`: bounded versioned binary decoder, exact-grid lookup, and
  off-grid Lagrange interpolation.
- `threading.*`: fixed range partitioning, pthread spawn/join, and inline
  fallback for every range whose spawn fails.
- `lambert.*`: branch-for-branch Arora-Russell batch solver.
- `encounter.*`: normalized stage-bound consumption, the exact time-grid rule,
  and global IE assignment. The temporary fixture generator obtains tightened
  bounds from upstream `_resolve_problem_config`.
- `leg.*`: deterministic pair generation, chunked Lambert solving, ballistic
  filtering, and IL assignment.
- `flyby.*`: powered-flyby evaluation, IF assignment, and fixpoint filters.
- `combo.*`: fixed-width stage rows, append-only parent spools, preemptive and
  final tfilter, reconstruction, and output assembly.
- `pipeline.*`: validation, unsupported-feature gates, stage ordering, limits,
  and statistics.

Native-only files under `tests/harness/` own filesystem access, problem-text
parsing, binary-file loading, JSONL formatting, and process exit codes. Core
`src/` code has no filesystem or iostream dependency.

## Two Independent Input Ports

The fixture inputs deliberately remain separate because they model separate
future module ports.

### Ephemeris binary

The ephemeris fixture is a versioned little-endian binary:

```text
magic[8] = "STAREPH\0"
u32 version = 1
u32 body_count
u64 total_sample_count
repeat body_count:
  i32 body_id
  u32 reserved = 0
  f64 gm_km3_s2
  f64 mean_radius_km
  u64 sample_count
  repeat sample_count:
    f64 epoch_et_s
    f64 position_km[3]
    f64 velocity_km_s[3]
```

Fields are decoded individually, so the format has no host-struct padding or
pointer assumptions. Counts, multiplication, remaining bytes, body uniqueness,
epoch order, and configured limits are checked before allocation.

This is the in-memory shape later populated by the typed SDS `$OEM` port: one
`EPHEMERIS_DATA_BLOCK` per body, `CENTER_NAME=SUN`,
`REFERENCE_FRAME=ECLIPJ2000`, row-major `EPHEMERIS_DATA`.

Exact epoch matches return the stored sample without arithmetic. Off-grid
queries use up to eight consecutive neighboring samples with direct Lagrange
polynomial evaluation, independently for all six state components. Queries
outside a body's sample range fail with `EphemerisOutOfRange`. The interpolation
choice cannot affect `test2_EMEJ`, whose fixture contains every encounter epoch.

### Problem fixture

The problem fixture is a versioned, line-oriented text file parsed only by the
native harness:

```text
STAR_PROBLEM 1
key = scalar-or-comma-list
```

Indexed stage, TOF-matrix, Lambert, flyby, tfilter, reference-altitude, and
limit keys make the file human-diffable. The parser is standalone and bounded:
it caps file bytes, line length, token count, stages, bodies, and matrix
dimensions. It does not enter the guest core. The later problem FlatBuffer
decoder will populate the same typed `Problem` structure.

## Error and Memory Model

Every core entry point returns `Status` and writes results through out
parameters. No core code uses `throw`, `try`, RTTI, `dynamic_cast`, filesystem,
or iostream.

The allocator uses checked integer arithmetic and `malloc`/`realloc` return
values. A shared budget tracks live and peak bytes. Every retained stage also
checks an explicit row cap before growth. Exceeding a cap returns
`RowLimitExceeded` or `MemoryLimitExceeded`; malformed counts return
`InvalidInput`; allocation failure returns `AllocationFailed`. The search
stops and publishes no partial result.

Candidate cross-products are chunked. Only one Lambert/flyby work chunk and one
combo frontier are resident in addition to retained databases and fixed-width
parent spools. Spool rows contain six columns total, including a `parent_row`
index, matching the live Python design.

## Determinism and Threading

The requested thread count is an input. Guest code never asks for hardware
concurrency.

For a batch of `N` rows, `P` fixed contiguous ranges are computed solely from
`N` and the requested count. Each range writes to its own preassigned indices.
The executor attempts `pthread_create` in range order. If a create call fails
(including the `wasi.thread-spawn` `-1`/`EAGAIN` path), that exact range runs
inline. Spawned ranges are joined, then valid rows are reduced and compacted
in original row-index order.

No result ordering or floating-point reduction depends on completion order.
The native acceptance test compares serialized output and all stage counts at
one thread and multiple threads byte-for-byte.

## Numerical Fidelity

The Lambert implementation preserves the upstream:

- elliptic, hyperbolic, near-`sqrt(2)`, and small-`k` branches;
- `series_eps=2e-2`, `delta_m=1e-12`, and `k_snap_eps`;
- Halley, minimum-TOF, bracketed-root, and multi-revolution initial-guess
  iteration limits and tolerances;
- sweep order for `hz` and signed revolution branches;
- row filtering and stable compaction order.

The native build uses `clang++ -std=c++17 -fno-exceptions -fno-rtti -O2`
without fast-math. Operation grouping is written explicitly where NumPy/Numba
evaluation order affects results. Any compiler/libm-dependent residual observed
by the comparison is measured and recorded rather than hidden.

IE, IL, and IF assignment is performed only after stable, ascending input-order
compaction. Comparisons preserve the Python inclusive/exclusive operators and
the encounter grid's `1e-12` and `1e-9` adjustments.

## Test Strategy

Development is test-first:

1. Decoder and limit tests cover truncated data, count overflow, bad ordering,
   unsupported features, row caps, and memory caps.
2. Encounter tests verify time-grid boundaries, exact ephemeris lookup,
   interpolation, deterministic IE order, and the 6,227-row oracle.
3. Lambert tests use Python-generated authoritative rows covering every
   numerical branch and signed multi-revolution case.
4. Leg tests gate on 114,294 then 301,979 rows and compare sampled IL endpoint
   identities and velocity components.
5. Flyby tests gate on 20,111 rows, then leg 2 on 52,289 and flyby 2 on 90.
6. Fixpoint tests verify one pass and zero removals.
7. Combo tests verify 10 then 90 candidates, exact reconstructed IL/IF arrays,
   90 final rows, and 33 tfilter survivors.
8. The complete harness runs at one and multiple threads and requires identical
   output bytes.
9. `scripts/compare_output.py` compares the 33 C++ rows to the upstream JSONL,
   checks exact discrete fields, and prints measured maximum absolute and
   relative deviations for every floating field.

`scripts/dump_ephemeris.py` runs in the upstream environment and regenerates the
ephemeris binary from SPICE at the exact encounter-grid epochs. Reference probe
vectors are generated from a temporary copy of the Python tree; the read-only
upstream tree is never edited.

## Deliverables and Phase 2 Seam

The native harness, fixtures, comparison utility, and recorded result live with
the module. `PORTING_NOTES.md` records this two-port choice, interpolation
choice, allocation and threading model, every numerical deviation, unsupported
status behavior, and the remaining DSM, resonant, and null-leg work.

WASM build wiring and the final SDS problem record are outside Phase 1. The core
accepts typed structures so those later decoders can be added without changing
the search pipeline.
