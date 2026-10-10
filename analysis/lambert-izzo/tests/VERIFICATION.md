# Lane 07 verification — 2026-09-15

Branch: `tmpl/lambert-grid`. Base: modules `283026f` (origin/main at lane start).
Private worktree: `/Users/tj/software/worktrees/modules-lambert-grid`.
No canonical module checkout edits, stack pin changes, schema changes, deploys,
publication, or main-branch integration. The coordinator owns integration.

## Delivered

`grid_search` adds a 400×400 bounded sweep to the existing Izzo module, using the
same C++ solver. It evaluates all requested directions and feasible revolution
branches, returns per-cell endpoint/total ΔV, C3, TOF, branch/revolution/direction,
velocities and explicit unresolved statuses, and reduces the best total-ΔV cell.
Canonical `$PCE` parameter records carry SI data in the existing SDK PIV/TAB
stream: one departure row per frame plus a best-cell record. No new SDS schema
or aligned-binary fallback was necessary. JavaScript only encodes/decodes bytes.

The optional antipodal plane in the shared kernel permits exact Hohmann cases;
existing LMS invocation behavior is preserved. MANEUVER host usage is documented
in the README. Builds now generate C++ headers from released SDS schemas, rather
than assuming a sibling checkout includes generated headers.

## 2026-10-09: shared-kernel refactor, rebuilt artifact

`include/lambert_izzo/solver.hpp` split `solve()` into `prepare` and
`revolution_branches` and gained `solve_revolutions(request, N)`, both branches
for exactly N revolutions without `solve()`'s 32-revolution cap (used by
`analysis/gp-error-model`). `solve()` keeps its checks, statuses and cap.
Rebuilt, the artifact behaves as before: 1,008 `solve_lambert` requests
(18 transfer angles, a quarter to 34 periods, `MAX_REVS` 0 to 40, short and
long way) return byte-identical outputs and statuses from the previous and the
rebuilt artifact, and the six grid parity cases return byte-identical outputs
in all three runtimes (receipt below, compared run by run with the previous
receipt). `npm test`: 45 pass.

## Artifact and dependencies

- WASM SHA-256: `6ab466391b30858b4f5719546fb89681ac3a47a3eb6758ffbb1163e72e576b25`
  (rebuilt 2026-10-09 with SDK 0.8.25 from the refactored shared kernel; the
  previous artifact was `2f8e9c05…cd5d07e19`, 154,461 bytes).
- Artifact: `dist/isomorphic/module.wasm`, 154,635 bytes.
- SDK: 0.8.15; authoritative local revision
  `1362cccb044fcc945b7e8356b5392359e6f543e3` (clean checkout).
- Published SDK 0.8.15 compiler, invoke glue, parity harness and lane runner
  sources were checked byte-for-byte against those used in this run: identical.
- SDS: released npm 1.217.0; flatc-wasm 26.1.32; flatbuffers JS 25.9.23.
  RFM/FRM/PCE/LMS/LMO published schema files match the ratified checkout.
- Compiler: SDK `compileModuleFromSource`, C++, `wasi-sequential`.
- WasmEdge pin: 0.16.4 for native and container; real headless Chrome browser.

## Numerical cases

Sources, units, frames, time scales and tolerance rationale are in README
“Authoritative numerical evidence” and the test comments. All errors below are
measured from this artifact, not stored outputs used as expectations.

| Independent reference | Measured result/error | Acceptance |
| --- | --- | --- |
| Vallado 2007 p.327 Algorithm 36 / Example 6-1, companion `hohmann.m`; vis-viva, 300 km LEO→42164 km GEO; GCRF, TT | Expected total 3.892554386890898 km/s; actual 3.892554386890902; error 4.092726e−12 m/s | 0.02 m/s; coarse 240 s grid error 46.919149 m/s reduces to the aligned 60 s result |
| JPL MRO Navigation, ISSFD 2007, Table 6 C3=16 km²/s², 2005-08-12 / 2006-03-10; ERFA epv00+plan94 inputs, heliocentric J2000 equatorial, daily TDB samples | C3 16.322943863349; error +0.322943863349 km²/s² | 1 km²/s²: rounded target, daily versus actual launch/encounter times, point-planet versus B-plane, analytic ephemeris |
| Early-August 2005 / March 2006 approximate C3 basin in the brief | Minimum 15.834125295547 km²/s² on 2005-08-10 / 2006-02-22; error −0.165874704453 versus ≈16 | ±0.5 km²/s², ±15 departure days from Aug 5, ±30 arrival days from March 1; approximate check supplements the primary JPL case |
| Izzo paper Eqs.18–19, λ=0, M=1, T=3π/2; r=7000 km; GCRF, TT; left x=0 | Correctly selects M=1/left, zero-cost residual 1.036589e−12 m/s | 1e−6 m/s |
| Same published equations; independently bracketed right root x=0.28492937285072095 | Correctly selects M=1/right, zero-cost residual 1.421085e−11 m/s | 1e−6 m/s |

Important corrections to the brief: 3.935 km/s approximates **200 km**, not
300 km LEO→GEO. The paper's multi-revolution cases above are independently
calculated specializations of its equations; no published Cartesian table is
claimed. The Earth–Mars C3 minimum is not precisely a March arrival, and the
**total-ΔV** optimum is a different cell: 6.800455144091 km/s on
2005-08-19 / 2006-03-22. No golden from the new solver defines these expectations.

Primary sources:

- [Vallado companion Hohmann implementation](https://github.com/CelesTrak/fundamentals-of-astrodynamics/blob/main/software/matlab/hohmann.m)
- [JPL MRO navigation, ISSFD 2007](https://issfd.org/ISSFD_2007/3-4.pdf), Tables 6 and 10
- [Izzo, Revisiting Lambert's Problem](https://arxiv.org/pdf/1403.2705), Eqs.18–19
- [ERFA plan94 accuracy and source](https://github.com/liberfa/erfa/blob/master/src/plan94.c)

## Commands and results

Commands below were run from this private module package (or equivalently with
its path as the prefix). Native checks used `PATH=/Users/tj/.wasmedge/bin:$PATH`.

```text
node build.mjs
Built dist/isomorphic/module.wasm — SDK validation PASS

npm test
ℹ tests 45
ℹ pass 45
ℹ fail 0
ℹ skipped 0

node --test tests/sdk_compat.test.mjs
ℹ tests 16
ℹ pass 16
ℹ fail 0
ℹ skipped 0

npm run check:compliance
ℹ tests 20
ℹ pass 20
ℹ fail 0
ℹ skipped 0

npm run test:parity -- --wasmedge-binary /Users/tj/.wasmedge/bin/wasmedge --timeout-sec 60 --json
"ok": true
"pin": "0.16.4"
"failures": []
```

[Full tri-runtime receipt](fixtures/grid-parity-receipt.json): six cases × three
runtimes, 18 runs; byte-identical complete outputs and exit classes. Cases cover
Hohmann, both multi-rev branches, the full planetary grid, 400×400, and invalid
step. Command ABI returns the invalid request as a structured error response;
the direct tests independently assert the error code and absence of outputs.

The pre-existing 72-geometry Izzo/maneuver comparison passes on browser/V8 and
native WasmEdge: `attempted=72 compared=72`, worst relative velocity difference
`2.002471e-15` at `190deg/0.25P/v1`. Existing WasmEdge tests needed
`enableThreads: true` for the already-shared-memory `wasi-sequential` profile.

The 400×400 test verifies all 160,000 cells and reduction of the best cell:
401 frames, 22,138,712 payload bytes (<24 MiB). The C++ kernel retains one row;
the SDK invoke transport accumulates the bounded output, as described in README.
This is a memory-bound functional check, not a benchmark or latency claim.

## Limits and skipped work

No requested implementation or runtime verification is blocked. Actual OrbPro
UI integration, main-branch merge, SDK-repository full suite and deployment were
outside this lane. `npm ci` was not run in the shared environment; the checked-in
lock is generated against released packages, and build/parity used the source
and schema versions documented above. No schema was invented to force an ABI.

Inputs require common-center inertial states sampled at exact grid epochs;
there is no interpolation, central-body collision filter, or perturbation
propagation in this solver. Unsolved cells stay explicit. An unresolved requested
direction cannot silently claim a global minimum. C3 is reported for the
selected total-ΔV branch; it is not a second optimizer.

The guard identified the unrelated ocean task as the component claim, refused
the Lambert paths, and logged each owner-authorized override to graph/events.log.
The active stack graph already contained 15 non-terminal tasks. This lane used
the explicitly authorized per-commit override rather than editing the canonical
stack graph:

```sh
GRAPH_PROTOCOL_GENERATION="main:65bfe5c174aebde03cb6c0dab819ce4c4011ec9f"
GRAPH_GUARD_OVERRIDE="TMPL parity lane 07-lambert-grid (owner goal 2026-09-15)"
```

## Code commits

```text
faa63026f6716a94f1a70d5f50940c3f5a7341b6 feat(lambert): expose SDS grid streams with authoritative WASM tests
268d03196483eece52d0b21b4581516826f8564b feat(lambert): minimize sampled transfer grids across Izzo branches
```

## Files changed

All changes are confined to this module. The compatibility test moved from
`sdk-compat.test.mjs` to the requested `sdk_compat.test.mjs` spelling.

```text
analysis/lambert-izzo/README.md
analysis/lambert-izzo/build.mjs
analysis/lambert-izzo/dist/isomorphic/module.wasm
analysis/lambert-izzo/dist/plugin-manifest.json
analysis/lambert-izzo/generate-sds-headers.mjs
analysis/lambert-izzo/grid-codec.js
analysis/lambert-izzo/include/lambert_izzo/grid.hpp
analysis/lambert-izzo/include/lambert_izzo/solver.hpp
analysis/lambert-izzo/index.js
analysis/lambert-izzo/package-lock.json
analysis/lambert-izzo/package.json
analysis/lambert-izzo/plugin-manifest.json
analysis/lambert-izzo/src/grid_module.cpp
analysis/lambert-izzo/tests/VERIFICATION.md
analysis/lambert-izzo/tests/fixtures/earth-mars-2005.json
analysis/lambert-izzo/tests/fixtures/earth-mars.pce
analysis/lambert-izzo/tests/fixtures/grid-parity-receipt.json
analysis/lambert-izzo/tests/fixtures/grid-parity.json
analysis/lambert-izzo/tests/fixtures/hohmann.pce
analysis/lambert-izzo/tests/fixtures/invalid-step.pce
analysis/lambert-izzo/tests/fixtures/izzo-left.pce
analysis/lambert-izzo/tests/fixtures/izzo-right.pce
analysis/lambert-izzo/tests/fixtures/max-grid.pce
analysis/lambert-izzo/tests/generate-parity.mjs
analysis/lambert-izzo/tests/grid-fixtures.mjs
analysis/lambert-izzo/tests/grid.test.mjs
analysis/lambert-izzo/tests/maneuver-parity.test.mjs
analysis/lambert-izzo/tests/manifest-sdk.test.mjs
analysis/lambert-izzo/tests/planet-states.c
analysis/lambert-izzo/tests/sdk_compat.test.mjs
```
