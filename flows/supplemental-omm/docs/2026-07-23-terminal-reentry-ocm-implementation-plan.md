# Terminal-Reentry OCM Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` or
> `superpowers:executing-plans` task-by-task. Every production edit follows an
> observed RED test.

**Goal:** Complete every current Starlink source transaction by retaining
strict paired OMM/OCM OD for orbital trajectories and emitting one honest
state-series OCM for terminal reentries.

**Architecture:** Terminal classification and record construction live in the
frozen C++ fit core linked into the independently signed OD WASM node. The node
admits an OCM-only stream only when the fit core explicitly marks a terminal
reentry result. Normal eight-hour OD retains strict gates and uses a
four-hour/three-hour-spacing retry when required.

**Tech Stack:** C++17, WASI threads, FlatBuffers/SDS `$OCM`, JavaScript
`node:test`, browser WASM harness, WasmEdge 0.14.1.

---

### Task 1: Specify terminal and adaptive-fit behavior with executable RED tests

**Files:**

- Modify: `tests/od-node.test.mjs`
- Modify: `tests/benchmark-scripts.test.mjs`

- [x] Add a synthetic complete MEME fixture whose final state crosses the
  120 km reentry interface.
- [x] Add a direct signed-node test requiring zero `omm` records, exactly one
  `ocm` record, all source states in `STATE_DATA`, complete time metadata,
  absent covariance, absent `ORBIT_DETERMINATION`, and COMPLETE status with one
  affected record.
- [x] Add a paired negative fixture ending above 120 km whose invalid fit must
  remain `od-quality-gate`.
- [x] Extend the env-gated real-corpus validator to accept OCM-only output only
  when the decoded record is explicitly terminal-reentry state-series OCM.
- [x] Run the exact tests against artifact `7eefbe94...` and retain the expected
  failures: the current artifact rejects terminal files and cannot emit an
  OCM-only transaction.

Run:

```sh
node --test --test-concurrency=1 \
  --test-name-pattern='terminal reentry|complete real MEME' \
  tests/od-node.test.mjs
```

### Task 2: Add terminal OCM construction and four-hour fallback to the frozen core

**Files:**

- Modify: `nodes/od/vendor/od_batch_fit.hpp`
- Modify: `nodes/od/vendor/od-fit-core-source.patch`
- Modify: `nodes/od/vendor/od-fit-core.o`
- Modify: `nodes/od/vendor/NOTICE.md`
- Modify: `nodes/od/build.mjs`

- [x] Reconstruct base revision
  `551f6e178c3332cad46171fd1a0002345271144c` in a temporary archive and apply
  the current vendored patch.
- [x] Extend the plain C++ OCM builder with a terminal state-series input that
  populates all TEME states and deterministic metadata while omitting
  covariance and orbit determination.
- [x] Classify only finite, ordered, uniformly sampled trajectories whose final
  geocentric altitude is at most 120 km.
- [x] Return one explicitly tagged OCM-only `PluginFitFBResult` before SGP4
  fitting for a terminal trajectory.
- [x] For nonterminal trajectories, rerun the complete file at four-hour
  windows/three-hour spacing if any eight-hour result is non-converged,
  non-finite, or has `RMS >= 12 km`.
- [x] Rebuild the relocatable fit core with the recorded wasi-sdk 24 image and
  flags, update its pinned SHA-256 and provenance hashes, and verify the
  untouched reconstructed source reproduces the previous object hash before
  accepting the new object.

### Task 3: Admit an explicitly marked OCM-only transaction

**Files:**

- Modify: `nodes/od/src/node.cpp`
- Test: `tests/od-node.test.mjs`

- [x] Preserve the explicit terminal flag from `BatchResult`.
- [x] Keep strict OMM/OCM pairing for every normal epoch.
- [x] Permit one nonempty OCM and an empty OMM only for an explicitly tagged
  terminal result with no additional epochs.
- [x] Generalize deterministic output identity derivation to the ordered
  nonempty subset of declared record ports while rejecting duplicates,
  undeclared ports, and an empty set.
- [x] Count the OCM record in COMPLETE status when no OMM stream exists and
  identify the terminal-reentry completion in the status message.
- [x] Run the Task 1 tests and confirm they are GREEN without weakening the
  nonterminal negative test.

### Task 4: Rebuild and verify exact signed artifacts

**Files:**

- Generated: `nodes/od/plugin-manifest.json`
- Generated: `nodes/od/dist/isomorphic/module.wasm`
- Generated: `nodes/od/dist/isomorphic/artifact.json`
- Generated: `nodes/od/publisher.json`
- Modify: `flow.json`

- [x] Run `node nodes/od/build.mjs` and update only the OD hash declaration in
  `flow.json`.
- [x] Run `tests/od-memory-budget.test.mjs`,
  `tests/od-node.test.mjs`, `tests/benchmark-scripts.test.mjs`, and the focused
  flow/source suites.
- [x] Run the former 22-file reject corpus and require 22 successful source
  transactions: twenty paired results plus two OCM-only terminal results.
- [ ] Run fresh-process width 1/2/4/8/16 samples, then a full current live
  manifest width-16 benchmark with exact manifest/artifact hashes.
- [x] Signature-verify and execute the exact signed artifact in WasmEdge and
  the browser-compatible harness; require byte-identical terminal OCM output.
- [x] Update benchmark evidence and task checkboxes only after the corresponding
  commands pass.

No branch, worktree, commit, push, deployment, release signing, Go edit, or
submodule-pin update is included.
