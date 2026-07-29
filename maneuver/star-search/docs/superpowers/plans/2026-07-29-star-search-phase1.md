# Star Search Phase 1 C++17 Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce an exception-free native C++17 implementation of the live
ballistic Star pipeline that reproduces the Python `test2_EMEJ` stage counts
and 33-row output.

**Architecture:** Keep the search core filesystem-free and reference-shaped,
with checked nothrow storage, typed problem/ephemeris inputs, deterministic
fixed-range parallel work, and stable row compaction. Keep problem parsing,
file loading, JSONL output, and comparison outside the guest core.

**Tech Stack:** C++17, clang++, C/POSIX allocation and pthread APIs, Python 3
fixture/comparison scripts, the installed upstream Python/NumPy/Numba/SPICE
environment.

---

### Task 1: Freeze authoritative fixtures and probe vectors

**Files:**
- Create: `scripts/dump_ephemeris.py`
- Create: `scripts/dump_reference_vectors.py`
- Create: `tests/vectors/test2_EMEJ.problem`
- Create: `tests/vectors/test2_EMEJ.ephem`
- Create: `tests/vectors/test2_EMEJ.reference.jsonl`
- Create: `tests/vectors/lambert_reference.tsv`

- [ ] Write scripts that accept an explicit upstream root and output path,
  load `test2_EMEJ` through its installed environment, and serialize
  deterministic little-endian ephemeris rows plus selected Lambert branch
  probes.
- [ ] Run the scripts against a temporary copy or through read-only imports;
  verify the original upstream tree has no diff.
- [ ] Check the binary header/counts and require 6,227 encounter entries from
  the same generated grids.
- [ ] Copy the 33-row authoritative JSONL into the module fixture directory and
  verify its SHA-256 against the upstream file.

Run:

```sh
cd <upstream>
uv run python <module>/scripts/dump_ephemeris.py \
  --upstream-root "$PWD" --problem test2_EMEJ \
  --metakernel star/METAKERN.tm \
  --output <module>/tests/vectors/test2_EMEJ.ephem
uv run python <module>/scripts/dump_reference_vectors.py \
  --upstream-root "$PWD" \
  --output <module>/tests/vectors/lambert_reference.tsv
wc -l output/test2_EMEJ.jsonl
```

Expected: encounter count `6227`; JSONL line count `33`.

### Task 2: Establish the exception-free core substrate

**Files:**
- Create: `src/status.hpp`
- Create: `src/status.cpp`
- Create: `src/bounded_buffer.hpp`
- Create: `src/types.hpp`
- Create: `src/constants.hpp`
- Create: `src/constants.cpp`
- Create: `src/threading.hpp`
- Create: `src/threading.cpp`
- Create: `tests/harness/test_core.cpp`
- Create: `tests/harness/Makefile`

- [ ] Write failing tests for checked arithmetic, allocation budgets, row caps,
  stable status strings, fixed range partitioning, forced spawn failure, and
  exact equality between inline and successfully spawned range writes.
- [ ] Build and run to observe failures caused by missing core APIs.
- [ ] Implement `Status`, `MemoryBudget`, move-only `Buffer<T>`, core data
  structures, transcribed constants, and fixed-range pthread execution.
- [ ] Rebuild with `-std=c++17 -fno-exceptions -fno-rtti -O2 -Wall -Wextra
  -Werror -pthread`; require all substrate tests to pass.

Run:

```sh
make -C tests/harness test_core
tests/harness/build/test_core
```

Expected: zero failed assertions and exit status 0.

### Task 3: Decode and query ephemeris input

**Files:**
- Create: `src/ephemeris.hpp`
- Create: `src/ephemeris.cpp`
- Modify: `tests/harness/test_core.cpp`

- [ ] Write failing tests for the valid fixture header, exact sample lookup,
  eight-point Lagrange interpolation of a known polynomial, truncation,
  overflow, duplicate body IDs, unsorted epochs, out-of-range queries, and
  memory-limit failure.
- [ ] Run the tests and confirm the ephemeris API is missing.
- [ ] Implement the bounded field-wise little-endian decoder, exact binary
  search, and direct Lagrange interpolation.
- [ ] Run the complete core test binary and require all ephemeris tests to pass.

### Task 4: Build the deterministic encounter database

**Files:**
- Create: `src/encounter.hpp`
- Create: `src/encounter.cpp`
- Create: `tests/harness/problem_text.hpp`
- Create: `tests/harness/problem_text.cpp`
- Modify: `tests/harness/test_core.cpp`

- [ ] Write failing tests for the `floor(range/dt + 1e-12)` time-grid rule,
  `<= max + 1e-9` retention, stage/body/epoch ordering, invalid bounds, problem
  parser bounds, unsupported feature flags, and the 6,227-row fixture result.
- [ ] Run and confirm failures occur at the absent encounter/problem APIs.
- [ ] Consume upstream-normalized tightened bounds and port encounter
  construction, using exact ephemeris hits and global monotonically assigned
  IE values.
- [ ] Require all unit cases and `entries.size == 6227` to pass.

### Task 5: Port Lambert branch-for-branch

**Files:**
- Create: `src/lambert.hpp`
- Create: `src/lambert.cpp`
- Create: `tests/harness/test_lambert.cpp`
- Modify: `tests/harness/Makefile`

- [ ] Add failing probe tests for `_W_and_derivs`, Halley roots, minimum-TOF
  roots, bracketed roots, `_tof_from_k`, multi-revolution `k0`, and full
  `lambert_batch`, covering elliptic, hyperbolic, near-`sqrt(2)`, small-`k`,
  both `hz` directions, and signed revolution branches.
- [ ] Run and confirm failures are from missing Lambert symbols.
- [ ] Port only the live upstream solver functions with identical constants,
  branches, loop bounds, comparisons, and stable result ordering.
- [ ] Compare every probe field to the Python vectors and print measured
  maximum deviations; keep refining only from a reproduced failing probe.
- [ ] Run the probe suite at one and multiple threads and require identical
  serialized result bytes.

### Task 6: Build ballistic leg databases

**Files:**
- Create: `src/leg.hpp`
- Create: `src/leg.cpp`
- Create: `tests/harness/test_pipeline.cpp`
- Modify: `tests/harness/Makefile`

- [ ] Write failing fixture tests for deterministic pair enumeration, TOF
  boundary inclusion, `hz`/revolution sweep order, v-infinity filtering,
  ballistic `dv_lev=0` and `eta_lev=0.5`, stable IL assignment, row-cap
  failure, and stage 0 count 114,294.
- [ ] Port chunked candidate enumeration, batch Lambert solving, ballistic
  filtering, and fixed-order compaction.
- [ ] Require leg 0 count 114,294 before enabling the next gate.
- [ ] Add and pass the leg 1 count 301,979 gate plus sampled row comparisons to
  Python debug vectors.

### Task 7: Build powered-flyby databases and fixpoint filtering

**Files:**
- Create: `src/flyby.hpp`
- Create: `src/flyby.cpp`
- Modify: `tests/harness/test_pipeline.cpp`

- [ ] Write failing unit cases for parabolic escape delta-v, powered-flyby
  geometry, altitude rejection, patch-dv cap inclusion, encounter grouping,
  stable IF assignment, and fixed-order parallel output.
- [ ] Port flyby pair evaluation and require flyby stage 1 count 20,111.
- [ ] Add the leg 2 gate and require 52,289 rows.
- [ ] Add flyby stage 2 and require 90 rows.
- [ ] Port forward/backward feasibility pruning, iterate to a fixpoint, and
  require one pass with zero removed rows for the fixture.

### Task 8: Port the streaming combo fold and tfilter

**Files:**
- Create: `src/combo.hpp`
- Create: `src/combo.cpp`
- Modify: `tests/harness/test_pipeline.cpp`

- [ ] Write failing tests for six-column-plus-parent stage rows, bounded spool
  append, preemptive tfilter tie ordering, parent reconstruction, total-dv
  pruning, final tfilter binning/ties, and discrete IL/IF preservation.
- [ ] Port the live `run_combo` path, excluding all paper-triplet functions.
- [ ] Require combo stage counts 10 and 90, reconstructed final count 90, and
  final tfilter count 33.
- [ ] Compare all 33 discrete `traj_id`, epoch, body, IL, and IF fields exactly
  to the reference fixture.

### Task 9: Wire the native pipeline and harness

**Files:**
- Create: `src/pipeline.hpp`
- Create: `src/pipeline.cpp`
- Create: `tests/harness/main.cpp`
- Modify: `tests/harness/Makefile`

- [ ] Write failing end-to-end tests for valid execution, every unsupported
  feature status, malformed inputs, row-cap failure, memory-cap failure, and
  forced pthread spawn fallback.
- [ ] Implement validation and the exact stage order, stage statistics, JSONL
  output, and nonzero status exits.
- [ ] Build the requested native executable with clang++ and no exceptions or
  RTTI.
- [ ] Run at one and four requested threads and require identical output files
  and identical stage-statistics files.

Run:

```sh
make -C tests/harness clean all
tests/harness/build/star_search_native \
  --problem tests/vectors/test2_EMEJ.problem \
  --ephemeris tests/vectors/test2_EMEJ.ephem \
  --threads 1 --output tests/vectors/test2_EMEJ.cpp.jsonl
tests/harness/build/star_search_native \
  --problem tests/vectors/test2_EMEJ.problem \
  --ephemeris tests/vectors/test2_EMEJ.ephem \
  --threads 4 --output tests/vectors/test2_EMEJ.cpp.threads4.jsonl
cmp tests/vectors/test2_EMEJ.cpp.jsonl \
    tests/vectors/test2_EMEJ.cpp.threads4.jsonl
```

Expected: exact supplied stage counts and `cmp` exit status 0.

### Task 10: Measure parity and document the result

**Files:**
- Create: `scripts/compare_output.py`
- Create: `tests/vectors/PARITY_RESULT.txt`
- Create: `PORTING_NOTES.md`

- [ ] Write the comparison script to check row count and exact discrete fields,
  then calculate maximum absolute and relative deviation independently for
  every scalar/vector floating field.
- [ ] Run it against the upstream 33-row JSONL and capture its unedited output
  in `PARITY_RESULT.txt`.
- [ ] Record all interface judgments, interpolation behavior, allocation and
  threading decisions, unsupported statuses, compiler/libm deviations, real
  stage counts, and Phase 2 work in `PORTING_NOTES.md`.
- [ ] Scan core source for banned constructs and dependencies.
- [ ] Run fresh full verification and report real successes and failures.

Run:

```sh
python3 scripts/compare_output.py \
  --reference <upstream>/output/test2_EMEJ.jsonl \
  --candidate tests/vectors/test2_EMEJ.cpp.jsonl
rg -n '\\b(throw|try|dynamic_cast)\\b|<filesystem>|<iostream>' src
make -C tests/harness clean test all
git submodule status
git submodule foreach 'git status --short --branch'
```

Expected: comparison reports 33 rows, exact discrete fields, measured
per-field deviations, no banned core hits, native tests/build exit 0. Any
failure is preserved in the recorded result and completion report.
