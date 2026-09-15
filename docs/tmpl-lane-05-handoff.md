# TMPL lane 05 — estimation depth handoff

## Status and branch

**Partial, blocked on upstream SDK/SDS contracts. Do not mark lane 05 complete.**
Branch: `tmpl/05-estimation`, starting at current-at-start `origin/main`
`902da63d7196a62fd1837de90574be678479a5c9`. Private worktree:
`/Users/tj/software/worktrees/modules-05-estimation`. The coordinator owns
integration. No merge to main, stack pin change, deployment, or publication.

Implementation and artifact commit SHAs are listed at the end of this report.
The following handoff-only commit is identified in the coordinator-facing final
response, which also confirms the remote branch SHA.

## Delivered

- Repaired the existing six-state EKF vector update: each measurement component
  now conditions on preceding components' covariance and explained residual.
  Joseph covariance updates are retained; the full conditional innovation sum
  is the joint NIS. Editing rejects the whole vector and restores its prediction.
- Validated the existing cumulative-STM time update and RTS history. Samples
  must begin at the configured initial nominal and remain paired with
  observations in nondecreasing time order. Simultaneous sensors are supported.
- Rejected malformed sequential controls, nonfinite observations/states, invalid
  sigmas/counts, singular covariance/STM, reversed times and sample-epoch mismatch.
  The wire decoder no longer replaces invalid sequential sigmas with 1.0, and
  oversized counts are rejected before error-model loops can use fixed storage.
- Added independently calculated Gaussian state/covariance/NIS/batch-RMS
  references, verbatim Hipparchus smoother data, 500-run asynchronous fusion
  consistency and smoothing checks, actual WASM invocation tests, SDK checks,
  and tri-runtime parity. Added the missing esbuild browser-harness dependency.
- Updated the manifest and README to identify validated estimator behavior and
  the legacy UKF limitation. Rebuilt through `compileModuleFromSource`, preserving
  `dist/isomorphic/module.wasm`. Refreshed measured conformance evidence.

All production numerics are C++. JavaScript packs SDK inputs, invokes runtimes,
and checks results. Independent Python/C++ providers generate test fixtures.

## Precisely blocked / undone

The exact package pins used to build are **SDK 0.8.17 / SDS 1.203.0**. The
canonical SDK source checkout currently reports 0.8.15; its build/publication
rules were read and followed, while the module retains its installed released
pin. No dependency pin was silently replaced with the older source checkout.

The pinned SDK's `schemas/orbpro/Estimation.fbs` defines a fixed ABI:

| Missing capability | Concrete contract limitation |
| --- | --- |
| True nonlinear-dynamics UKF | Only one nominal state/STM per observation; no sigma-point propagation exchange or per-update recentering. Current UKF only transforms sigma points through the measurement function, after an STM time update. |
| Exposed Julier/Merwe parameters | No alpha/beta/kappa configuration fields; current constants are 1/2/0. |
| Linear KF selection | EstimatorKind has only four existing values. No prelinearized measurement H/affine-term input; SDS ODR likewise lacks a linear-KF enum. |
| Adaptive Q/R | No adaptive-noise controls, forgetting/scaling bounds or inflation policy. Existing fixed SNC/DMC terms and sigma editing are not adaptive noise. |
| GNSS PVT | Measurements have four fixed values/sigmas and no POSITION_VELOCITY kind. |
| Receiver clock bias/drift, GNSS pseudorange | State/config/result/history/sample structs are fixed at six state elements and 36 covariance entries; no clock solve-for representation or dedicated measurement kind. PSEUDONOISE_RANGE is a different existing observable. |

Per the owner's stop rule, no local schema, reserved flag or invented enum was
introduced. SDK/SDS owners must ratify and publish the extended wire and report
contracts, then this lane can finish the features. New source-only functions
that cannot be invoked through the WASM contract were not presented as delivery.

The existing EKF time step is first-order about a caller-supplied nominal
trajectory, not repeated nonlinear repropagation around each filtered state.
A complete nonlinear port exchange and a live HPOP-to-estimation flow remain
undone. Lane 03 HPOP's cumulative STM is compatible, but these tests use an
independent analytical test provider and do not claim HPOP integration.

The requested Orekit **orbital** KalmanEstimator/UnscentedKalmanEstimator
scenario (or a Vallado Chapter 10 filter example) remains undone. The published
Hipparchus filter/smoother scenario is useful additional authority, not a claim
to have reproduced that orbital scenario. Full nonlinear UKF consistency and
adaptive/GNSS validation are blocked with their implementations. The SDK's
legacy covariance-difference check is not proof of a real UKF.

## Authoritative cases and measured errors

Complete source links, inputs, frame/time conventions, tolerances and rationale
are in [tests/fixtures/README.md](../analysis/estimation/tests/fixtures/README.md).
All Cartesian states are m and m/s; covariance blocks use corresponding SI
units. Invoke epoch label is JD 2451545 TAI; all equations use elapsed seconds.

| Case and independent authority | Measured error / statistic | Bound and rationale |
| --- | --- | --- |
| Correlated 3-axis Gaussian conditioning, Boyd EE363 lecture 8; exact rational posterior/NIS | native max `2.7755575615628914e-16` | `2e-14` absolute in stated state/covariance/NIS quantities; double precision on well-conditioned rational input |
| Same exact Gaussian optimum through batch WLS | state `8.326672684688674e-17`; covariance `4.440892098500626e-16`; RMS relative `1.3424259282469662e-16` | `2e-14`; independently derived Gaussian/MAP optimum, no filter-generated goldens |
| Hipparchus 4.0.3 `cv-smoother.txt`, 50 epochs, EKF/RTS | state `1.8873791418627661e-15`; covariance `2.4633073358870661e-16` | `1e-12`; published double values with six-state embedding/order allowance |
| Same published CV case, legacy UKF with native RTS | state `2.6090241078691179e-15`; covariance `1.9081958235744878e-16` | `1e-12`; linear-dynamics special case only, not nonlinear UKF validation |
| 500 circular-orbit fusion runs, exact Battin/CW inertial STM and independent analytic radar/crosslink geometry | ANEES `6.060694900206741` | 99% chi-square interval `[5.60846959,6.40655574]`, df=3000 divided by 500 |
| Same runs, 40 observations / 53 scalar components per run | NIS/dof `1.0015870288622697` | 99% interval `[0.97776439,1.02251913]`, df=26500 divided by 26500 |
| Same runs, complete RTS history | position RMSE `26.790899471004533 → 10.848264806123717 m` | ensemble MSE must not increase; covariance diagonals must decrease within `1e-7` arithmetic allowance |
| Actual WASM Gaussian invocation | max error `4.285460875053104e-13` | `2e-12`, including flatc JSON's 12-decimal rounding; binary OCM covariance separately checked at `2e-14` |
| Actual WASM published smoother | state `4.996003610813204e-13`; covariance `4.977728298993789e-13` | `2e-12`, same test-decoder rounding allowance |
| Actual WASM asynchronous radar/crosslink fusion | final position `6.428884297187561 m` | posterior 3-sigma RSS `49.60681459645298 m`; independent truth; the Monte Carlo test supplies consistency evidence |

The fusion provider uses a 7000 km circular inclined orbit, an idealized
inertially fixed radar platform, and a spacecraft sensor advanced 120 seconds
on the same orbit. This isolates estimation and measurement geometry; it is
not a rotating-Earth or light-time/media test. There are irregular and equal
observation epochs. Independent seeded Gaussian errors drive the Monte Carlo.
Confidence bounds come from NIST's chi-square law with SciPy quantiles.

Sixteen native invalid-input probes and three invalid wire cases also pass.
Compiling the new regression against the unmodified `902da63` core fails its
first exact Gaussian assertion (exit 134), confirming that it detects the old
vector-update bug.

## Final build and verification receipts

Commands below run from `analysis/estimation` unless a different directory is
shown. Full live parity data are in `conformance/lane05-parity.json`; regenerated
native measurements are in `conformance/estimation-evidence.json`.

### SDK build — PASS, exit 0

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run build
```

```text
Built dist/isomorphic/module.wasm against spacedatastandards.org@1.203.0
```

The compile uses the SDK's sanctioned WASI sequential target and embedded
manifest validation. Final WASM SHA256:

```text
a4f45c1095ac91c15aa3c17742bbf4da94cc503a03de8fbf66f88fbc0ab51573
```

### Native, invoke, compatibility and existing conformance — PASS

```sh
node --test tests/native.test.mjs tests/sequential.test.mjs tests/invoke.test.mjs
node --test tests/sdk_compat.test.mjs
node tests/refresh-evidence.mjs
npm test
```

```text
native.test.mjs: PASS native estimation conformance
authority/consistency: PASS sequential validation failures=0
invoke.test.mjs: tests 4; pass 4; fail 0
sdk_compat.test.mjs: tests 2; pass 2; fail 0
PASS refreshed authoritative conformance evidence for a4f45c1095ac91c15aa3c17742bbf4da94cc503a03de8fbf66f88fbc0ab51573
npm test: tests 9; pass 9; fail 0; skipped 0
```

### Tri-runtime isomorphism — PASS, no lanes skipped

```sh
PATH="$HOME/.wasmedge/bin:$PATH" node tests/parity.mjs
```

```text
parity PASS fixture=TMPL lane05 estimation module=a4f45c1095ac91c1 lanes=[browser(28 runs, 2434ms), wasmedge(28 runs, 974ms), docker-wasmedge(28 runs, 26201ms)] comparisons=161
7 case(s) byte-identical across 3 lane(s).
```

Chrome/V8, native WasmEdge 0.16.4 and container WasmEdge 0.16.4 consume the same
bytes at host worker counts 1/2/4/8. Cases include Gaussian correlation, vector
editing, published smoother, asynchronous fusion, invalid sigma, oversized
count, and mismatched epoch. The initial missing-esbuild failure was repaired;
no runtime was omitted to obtain the pass.

### HPOP baseline — unchanged failure

From the worktree root, using the existing SDK 0.8.18 dependency:

```sh
PATH="$HOME/.wasmedge/bin:$PATH" node --test propagator/hpop/tests/sdk_compat.test.mjs
```

```text
tests 10; pass 9; fail 1; skipped 0
FAIL built artifact passes SDK compliance checks
baselineErrors=11 currentErrors=11 HPOPtrackedFilesUnchanged=true
```

HPOP was not rebuilt or modified. The 11 existing `code/location` errors remain
on its identical checked-in artifact/manifest. No HPOP CMake migration or
compliance repair was attempted. No whole-stack or SDK-source full test suite
was run; this lane changes only estimation. `git diff --check` passes and
source/dist manifest files match.

## Workspace and commit hygiene

The attempted exact-scope claim returned `graphctl: no such task: tmpl-lane-05`.
Commits use the explicit owner-provided override:

```sh
GRAPH_PROTOCOL_GENERATION="main:65bfe5c174aebde03cb6c0dab819ce4c4011ec9f"
GRAPH_GUARD_OVERRIDE="TMPL parity lane 05 (owner goal 2026-09-15)"
```

All tracked edits are in the private lane worktree. Canonical foreign changes
were preserved. An ignored worktree-root node_modules symlink provides existing
read-only SDK dependencies for the unchanged HPOP check; estimation has its own
npm-installed dependencies. No recursive submodule commands or credential
access. The worktree is retained for the coordinator to land.

The first commit attempt timed out on the shared registry control lock
(`REGISTRY_BUSY`). An unchanged retry succeeded with the supplied override;
no lock or hook was removed or bypassed. The guard selected an unrelated ocean
claim, and logged the owner-authorized scope override.

## Exact changed files

```text
analysis/estimation/README.md
analysis/estimation/conformance/estimation-evidence.json
analysis/estimation/conformance/lane05-parity.json
analysis/estimation/dist/isomorphic/module.wasm
analysis/estimation/dist/plugin-manifest.json
analysis/estimation/package-lock.json
analysis/estimation/package.json
analysis/estimation/plugin-manifest.json
analysis/estimation/src/estimation.cpp
analysis/estimation/src/module.cpp
analysis/estimation/tests/fixtures.mjs
analysis/estimation/tests/fixtures/README.md
analysis/estimation/tests/fixtures/circular-fusion.json
analysis/estimation/tests/fixtures/generate-cv-inputs.py
analysis/estimation/tests/fixtures/hipparchus-LICENSE.txt
analysis/estimation/tests/fixtures/hipparchus-NOTICE.txt
analysis/estimation/tests/fixtures/hipparchus-cv-inputs.json
analysis/estimation/tests/fixtures/hipparchus-cv-smoother.txt
analysis/estimation/tests/invoke.test.mjs
analysis/estimation/tests/native_conformance.cpp
analysis/estimation/tests/parity.mjs
analysis/estimation/tests/refresh-evidence.mjs
analysis/estimation/tests/sdk_compat.test.mjs
analysis/estimation/tests/sequential.test.mjs
analysis/estimation/tests/sequential_validation.cpp
analysis/estimation/tests/wire.mjs
docs/tmpl-lane-05-handoff.md
```

## Commits

```text
a950e7a429034971bf94087001479b631b893831 Repair EKF vector conditioning and validate sequential estimation
e9777a2bc7eb09d92fb198d8f11696ebd0a090a7 Build estimation WASM and record authoritative runtime evidence
```

The subsequent documentation commit adds this handoff only. Read the exact
pushed tip with `git ls-remote origin refs/heads/tmpl/05-estimation`; the final
coordinator-facing response records its verified SHA.
