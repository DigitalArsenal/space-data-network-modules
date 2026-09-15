# TMPL lane 03 handoff — analytical HPOP STM

## Acceptance status

Numerical implementation delivered on `tmpl/lane-03`, based on current-at-start
`origin/main` **e461236**. The coordinator owns integration; this branch is not
merged and no stack pin is changed.

**SDK acceptance is blocked.** HPOP still uses its pre-existing legacy manifest
identities and CMake build. No new SDS schema was invented. The built WASM is a
diagnostic artifact, not an SDK-compliant publication candidate. The exact SDK
preflight rejects 27 errors before compilation; artifact compliance has the
same 11 errors as the starting artifact.

Private worktree: `/Users/tj/software/worktrees/modules-lane-03`.

## Implementation

- Analytical forward chain-rule force Jacobians for point mass, J2–J6,
  normalized inline harmonics, full loaded/embedded EGM Cunningham/Pines
  recursion, nine third bodies, drag, cannonball SRP including the existing
  conical shadow function, relativistic terms and supported contributions.
- A coupled 6+36 state uses the same RK4, Cash–Karp and Fehlberg stage code as
  the original six-state integrators. Adaptive state and dimensionally scaled
  STM errors share one step acceptance/rejection decision. No acceptance of an
  unmet tolerance at the minimum step.
- `STM_METHOD={ANALYTIC,FINITE_DIFFERENCE}` on `invoke` / `propagate`;
  analytic is the default for requested STMs. `includeSTM`, covariance,
  sample-epoch or maneuver requests activate STM output. State-only requests
  preserve their existing path. The legacy working-state STM/covariance
  exports also default to analytic and expose `plugin_set_stm_method`.
- Configurable `DENSITY_GRADIENT={NEGLECTED,FINITE_DIFFERENCE}`; only scalar
  density is differenced, at ±1 m. Velocity/co-rotation derivatives are analytic.
- Exact scheduled impulse epochs with post-burn output, identity inertial
  jumps and differentiated RTN-basis jumps. `samples[].stm` is cumulative from
  the original epoch, suitable for a caller to pack into estimation's existing
  propagator-sample contract. Covariance uses `Phi P0 Phi^T` without process noise.
- Lane 01's scoped body-position/kernel port supplies all third-body and SRP
  body positions. Kernel mode is covered by WASM invoke and parity fixtures.
- Expected integration failures return explicit statuses. The invoke translation
  unit alone uses `-O0 -fno-inline -fno-lto`: optimized C++ exception cleanup in
  WasmEdge 0.16.4 corrupted pointers in negative-case probes. Physics remains
  `-O3` with LTO; standardized native WASM exceptions are enabled, with no
  JavaScript-assisted exception imports. Negative cases are part of parity.
- Expected-error and dispatch regression tests cover invalid controls,
  unsupported integrators, incomplete integration and weather-epoch restoration.

The [README](../propagator/hpop/README.md#analytical-state-transition-matrix-tmpl-lane-03)
contains the complete invoke request and supported options.

## Authoritative numerical evidence

State units are km and km/s; epochs are JD TDB; the Kepler/J2 tests use
Earth-centred J2000 inertial coordinates. STM rr/vv blocks are dimensionless,
rv is seconds and vr is inverse seconds. Relative matrix error is the Frobenius
norm after scaling `D^-1 Phi D`, `D=diag(1,1,1,n,n,n)`, where n is mean motion.

| Case / independent authority | Measured error | Acceptance bound and rationale |
| --- | ---: | --- |
| Circular 7000 km Kepler, one orbit; Battin CW equations and inertial transformations | 1.2104894e-14 relative | 1e-9; integration error against exact linearized circular flow |
| Eccentric inclined Kepler, a=9000 km, e=0.2, one orbit; analytical implicit derivatives of Battin's Lagrange coefficients | 3.0416791e-14 relative | 1e-9; independent closed-form flow, no ODE-generated goldens |
| Four closed-form Kepler fixtures through actual WASM invoke | 5.6957521e-15 relative | 1e-9; representable target JD used by independent generator |
| J2, 7000 km, i=51.6°, one orbit, rich central differences with Richardson extrapolation | 7.2368748e-10 relative | 1e-6; step-size and integration-control convergence checked |
| Same J2 arc, `abs(det(Phi)-1)` | 1.7763568e-14 | 1e-9; conservative variational flow |
| Same J2 arc, maximum balanced `abs(Phi^T J Phi-J)` | 1.9669591e-13 | 1e-9; actual symplectic identity, not determinant alone |
| 1000 seeded Gaussian nonlinear samples, J2 one orbit; 10 m and 1 cm/s initial standard deviations | max 1.6655687 standard errors; largest diagonal fractional discrepancy 6.041624% | each of 21 unique covariance entries within 4 Wishart standard errors |
| Monte Carlo paired nonlinear residual | 3.9877549e-5 normalized RMS | 1e-3; small perturbations remain in linear covariance regime |
| Mixed inertial and RTN impulses, first/second/final samples versus whole-arc central differences | max 6.2863914e-8 relative | 1e-6; includes the RTN discontinuity and original-epoch cumulative STM |

Kepler RKF78 controls: abs/rel 1e-14, min 0.001 s, max 20 s. J2 FD perturbations
are 20 m / 2 cm/s and half those sizes; FD-step convergence is 5.9362257e-10
relative. Halving the integration cap 15→7.5 s changes the FD reference by
1.0303904e-9. These independent convergence checks are below the 1e-6 bound.

Sources:

- [Battin, MIT 16.346 lecture 4, equations 4.41 and 4.43](https://ocw.mit.edu/courses/16-346-astrodynamics-fall-2008/87431d1d0bfd2488fe402067e0afcb59_lec_04.pdf): eccentric-anomaly equation and Lagrange coefficients; the test differentiates these analytically.
- [Battin lecture 26](https://ocw.mit.edu/courses/16-346-astrodynamics-fall-2008/e4f0632a9f1c98f7e9b25492e1a30eb1_lec_26.pdf): independent CW circular variational solution, transformed at both endpoints into inertial Cartesian coordinates.
- [Battin lecture 19](https://ocw.mit.edu/courses/16-346-astrodynamics-fall-2008/a88bf1b4e2238cd921b395993a22bb28_lec_19.pdf): variational/symplectic structure.
- [IERS Conventions 2010, chapter 6, equation 6.1](https://iers-conventions.obspm.fr/content/chapter6/icc6.pdf): normalized harmonic gravity potential.
- [NIST Wishart distribution](https://www.itl.nist.gov/div898/software/dataplot/refman2/auxillar/wishrand.htm): Gaussian sample covariance distribution. The standard error used is `sqrt((Cij²+Cii*Cjj)/(N-1))`.

The force-only suite adds 55 checks. Closed-form point-mass, illuminated
cannonball and drag-velocity Jacobian relative errors are respectively
1.416e-16, 3.560e-16 and 1.055e-16 (2e-14 bounds). Two-step finite-difference
cross-checks give isolated J2–J6 max 8.508e-10, EGM70 1.317e-9, loaded degree80
1.406e-9, nine third bodies 1.156e-9, drag models 1.693e-9, penumbra 9.705e-10,
and RTN impulse 2.035e-9. Units, frame, fixed epoch 2460000.5 TDB, perturbation
sizes and cancellation-based tolerance rationales are in
`propagator/hpop/tests/force_partials_native.cpp`.

## Timing

Native C++ `-O2`, actual `PropagateWithSTM(FiniteDifference)` versus analytic,
24-hour J2 LEO arc, same controls, 100 repetitions in A/B/A order:

```text
analytic_before_ms=1.86495334
finite_difference_ms=6.45665333
analytic_after_ms=1.94815916
speedup=3.38655276
```

The analytic before/after measurements differ by 4.46%. The retained method performs twelve
perturbed propagations plus one nominal propagation, not seven. This is a local
native timing result; the separate WASM benchmark records its own runtime and
artifact SHA.

Actual WASM invoke benchmark, Node v25.4.0 / V8 14.1.146.11-node.15,
Apple M3 Ultra, 28 cores, one-minute load 14.49 (not CPU-saturated), 20 repeats
in A/B/A order:

```text
analytic_before_ms=4.430375
finite_difference_ms=8.543650
analytic_after_ms=4.3219729
speedup=1.95231042
```

This uses GCRF `[7000,0,0] km`, `[0,7.5,1] km/s`, JD 2451545→2451546 TDB,
J2, RKF78, abs/rel 1e-12, max step 60 s. Physics remains optimized despite the
invoke-wrapper exception workaround. These are local timings, not a fleet
throughput guarantee.

## Exact verification commands and receipts

Commands run from the private worktree root unless shown in a subshell.
The focused and parity harnesses use SDK 0.8.18 with installed SDS 1.202.0;
the explicit SDK-source admission probe uses canonical SDK 0.8.15 and current
SDS 1.217.0+1789398499674. Dependencies/tooling were provisioned only in ignored
private-worktree locations.

### Required SDK admission — BLOCKED, exit 1

```sh
env SDN_MODULE_SDK_ROOT=/Users/tj/software/spacedatanetwork-stack/repos/ancillary-packages/space-data-module-sdk \
SPACE_DATA_STANDARDS_ROOT=/Users/tj/software/spacedatanetwork-stack/repos/main-packages/spacedatastandards.org \
node propagator/hpop/tests/sdk-build-preflight.mjs
```

```text
SDK preflight sdk=0.8.15 standards=1.217.0+1789398499674
SDK BUILD BLOCKED: Manifest validation failed. errors=27
HPOP source preparation skipped: SDK rejected the manifest before compiler selection.
```

There are 11 manifest-shape errors and 16 missing/mismatched standards identity
errors. They concern legacy invoke request/response, resident PRST state, and
batch/trajectory request/results. The probe deliberately contains a sentinel,
not HPOP implementation source: it demonstrates the admission blocker and does
not claim a completed SDK compilation. Source/ABI build migration remains
required after the contract is ratified.

### Diagnostic local-emSDK build — PASS, exit 0

```sh
env SDN_FLATBUFFERS_INCLUDE_DIR=/Users/tj/software/spacedatanetwork-stack/repos/main-packages/flatbuffers/include \
SDN_LOCAL_EMSDK_DIR=/Users/tj/software/spacedatanetwork-stack/repos/main-packages/space-data-network-modules/propagator/hpop/deps/emsdk \
bash propagator/hpop/build.sh
```

```text
[100%] Built target hpop_wasm
=== Build Complete ===
```

Both `dist/browser/module.wasm` and `dist/isomorphic/module.wasm` SHA256:

```text
cbc7a57aab8994cf63d8698f70e5d15aec1c7afb335d0e8aab93d8364afe99ed
```

### Native numerical/control checks — PASS

```sh
node --test propagator/hpop/tests/variational.test.mjs
node --test propagator/hpop/tests/force_partials.test.mjs
node --test propagator/hpop/tests/variational_controls.test.mjs
```

```text
PASS HPOP variational cases=24 failures=0
PASS force partials cases=55 failures=0
PASS HPOP variational controls cases=16 failures=0
```

Each file reports `tests 1; pass 1; fail 0; skipped 0`. The native variational
command includes the 1000-sample test and the native timing above. A separate
final timing run was performed after concurrent builds and parity had finished.

### WASM numerical invoke — PASS

```sh
(cd propagator/hpop && PATH="$HOME/.wasmedge/bin:$PATH" node --test tests/variational_invoke.test.mjs)
```

```text
PASS WASM Kepler STM cases=4 max_relative_error=5.695752054488655e-15 tolerance=1e-9
PASS WASM covariance samples RTN-impulse DE440-drag-SRP
tests 3; pass 3; fail 0; skipped 0
```

Final artifact was also verified by this file as part of the full regression
command below. The test checks named errors and recovery after invalid controls.

### Tri-runtime parity — PASS, no lanes skipped

```sh
PATH="$HOME/.wasmedge/bin:$PATH" node propagator/hpop/tests/variational-parity.mjs
PATH="$HOME/.wasmedge/bin:$PATH" node propagator/hpop/tests/kernel-parity.mjs
```

```text
parity PASS fixture=TMPL lane03 HPOP variational diagnostic artifact module=cbc7a57aab8994cf comparisons=50
10 case(s) byte-identical across 3 lane(s).
parity PASS fixture=TMPL lane01 HPOP diagnostic CMake artifact module=cbc7a57aab8994cf comparisons=30
6 case(s) byte-identical across 3 lane(s).
```

Real browser/V8, native WasmEdge 0.16.4 and container WasmEdge 0.16.4 use the same
bytes. Lane 03 cases include closed-form orbits, J2 FD, DE440 drag/SRP, RTN burn,
invalid STM selector, unsupported integrator and exhausted-step errors.

### Required compatibility and regression — baseline failure remains

```sh
(cd propagator/hpop && PATH="$HOME/.wasmedge/bin:$PATH" node --test tests/sdk_compat.test.mjs)
(cd propagator/hpop && PATH="$HOME/.wasmedge/bin:$PATH" npm test)
```

```text
sdk_compat: tests 10; pass 9; fail 1; skipped 0
npm test:   tests 33; pass 32; fail 1; skipped 0
FAIL built artifact passes SDK compliance checks
```

Both exit 1 for the same legacy manifest compliance failure. Comparing
`code/location` pairs on the final artifact and the `e461236` starting artifact
with the same SDK 0.8.18 yields:

```text
baselineErrors=11 currentErrors=11 identical=true
```

Additional existing checks:

```sh
PATH="$HOME/.wasmedge/bin:$PATH" node --test \
propagator/hpop/tests/kernel_invoke.test.mjs \
propagator/hpop/tests/de440_force.test.mjs \
propagator/hpop/tests/no_duplicate_sources.test.mjs \
propagator/hpop/tests/zonal_crossvalidation.test.mjs
```

```text
tests 6; pass 6; fail 0; skipped 0
```

WASM timing command:

```sh
node propagator/hpop/tests/variational-benchmark.mjs
```

`git diff --check` passes. No failing baseline check was weakened or skipped.

## Remaining limits

1. SDK compile and compliance are blocked by existing legacy invoke/resident
   schemas. SDK contract migration and any necessary standards ratification are
   outside this lane. No SDK-compliant publication claim is made.
2. No additional STM harmonic truncation was introduced. Embedded EGM remains
   degree 70; loaded-field degree 80 is tested. Existing force semantics remain:
   EGM's coefficient gates are unused, its low-order Pines columns can omit
   required zonal x/y terms, and cannonball always selects its conical shadow.
   Derivative agreement does not validate those existing modeling choices.
3. Analytic STM refuses albedo, thermal, tides, empirical accelerations, finite
   thrust, non-cannonball SRP and atmosphere winds. Inline tesseral gravity
   refuses the exact polar coordinate singularity. Piecewise shadow/density
   boundaries do not have a two-sided classical derivative at discontinuities.
4. Analytic integrators: RK4/RKF45/RKF78/RK78/COWELL. Invoke FD additionally
   supports RKDP87/BS. ABM/Encke/other result dispatchers remain unsupported for
   this surface. Backward scheduled impulses are refused; start-epoch burns
   require an already post-burn initial state. Working-state legacy methods do
   not consume entity burn lists.
5. Cd/Cr sensitivity columns were not added: existing plumbing has only a 6×6
   state STM. No full estimation-flow packing, SDK-wide suite, whole-stack
   suite, deployment, publication, main merge or stack pin change was attempted.

## Workspace and commit hygiene

The graph claim returned `no such task: tmpl-lane-03`. Focused commits use the
owner-authorized override:

```sh
GRAPH_PROTOCOL_GENERATION="main:65bfe5c174aebde03cb6c0dab819ce4c4011ec9f"
GRAPH_GUARD_OVERRIDE="TMPL parity lane 03 (owner goal 2026-09-15)"
```

The guard selected an unrelated terrain claim and logged the override. All
tracked edits are in the private worktree. An initial toolchain exception probe
populated an ignored canonical emSDK cache before switching to a private
`EM_CACHE`; no canonical source was edited. No credentials were read and no
production action was taken. The worktree is retained for the coordinator.

## Commits and exact changed files

Implementation and artifact commits:

```text
452c48621581848361150ac1d6f1fd4fce251aea Add analytical HPOP force and impulse Jacobians
b0b978b8e6dac72a4c26728335ec5bfe261ac5ce Integrate HPOP state and STM with shared Runge Kutta stages
00b54070d3507cd83f125c504b1c1c6110dd6ca5 Build and document diagnostic HPOP variational artifact
```

A subsequent handoff-only commit records this report; its SHA and the verified
remote tip are in the coordinator-facing final response.

```text
docs/tmpl-lane-03-handoff.md
propagator/hpop/README.md
propagator/hpop/dist/browser/module.js
propagator/hpop/dist/browser/module.wasm
propagator/hpop/dist/isomorphic/module.wasm
propagator/hpop/lib/astrodynamics.cpp
propagator/hpop/lib/force_partials.cpp
propagator/hpop/lib/force_partials.h
propagator/hpop/lib/integrators.cpp
propagator/hpop/lib/rk_augmented.h
propagator/hpop/lib/variational.cpp
propagator/hpop/lib/variational.h
propagator/hpop/package.json
propagator/hpop/src/cpp/CMakeLists.txt
propagator/hpop/src/cpp/src/plugin_runtime.cpp
propagator/hpop/src/hpop_plugin.cpp
propagator/hpop/tests/force_partials.test.mjs
propagator/hpop/tests/force_partials_native.cpp
propagator/hpop/tests/sdk-build-preflight.mjs
propagator/hpop/tests/variational-benchmark.mjs
propagator/hpop/tests/variational-fixture.mjs
propagator/hpop/tests/variational-kepler-reference.json
propagator/hpop/tests/variational-parity.mjs
propagator/hpop/tests/variational.test.mjs
propagator/hpop/tests/variational_controls.test.mjs
propagator/hpop/tests/variational_controls_native.cpp
propagator/hpop/tests/variational_invoke.test.mjs
propagator/hpop/tests/variational_native.cpp
```
