# TMPL lane 05 second-pass handoff

## Candidate

- Branch: `tmpl/05-estimation-depth`; coordinator merges, worker does not.
- Base: `1682a8d832148343b70270d2bb8d7e58faee8966` (origin/main when started).
- Implementation commit: `d6007252f341928c5d356b7aed6321abbf437b41`.
- The following artifact/evidence commit contains this report; final branch head
  is supplied in the worker's final report and can be read with `git rev-parse HEAD`.
- Worktree: `/Users/tj/software/worktrees/modules-05-estimation-depth`.
- Artifact SHA-256: `2589309c8e7b6260118b8233cecfb8d94f6c781497a2808e09635feb90e21e5f`.
- All tracked changes are confined to `analysis/estimation`. No SDS, SDK,
  canonical component checkout, stack pins, or other lane directories edited.

## Implemented

1. Real Wan–van der Merwe UKF with exposed alpha/beta/kappa, nonlinear sigma
   propagation through an inverted request/answer port, full joint measurement
   update, and posterior recentering at every observation. EKF also repropagates
   from the posterior in nonlinear mode. Legacy affine samples remain supported.
2. `LINEAR_KALMAN_FILTER`, arbitrary prelinearized H/offset and direct position/PV.
3. Optional, default-off scalar innovation covariance matching for Q, based on
   Mehra; separately gated/capped measurement-noise inflation using the sigma edit.
4. Six-component `POSITION_VELOCITY`, corrected `PSEUDORANGE`, optional receiver
   clock bias/drift, full eight-state covariance and RTS history.
5. Append-only module-local schema and generated bindings; every old struct,
   enum ordinal and table field prefix is checked against SDK 0.8.17.
6. Nonlinear asynchronous radar range/az-el/co-orbiting range scenario for both
   EKF and UKF, 500 trials each, with NEES/NIS and smoother checks.

## Authoritative numerical evidence

Sources, units, GCRF/inertial frames, TAI epochs, tolerances, rationale and exact
reference generation are in [DEPTH.md](tests/fixtures/DEPTH.md) and the
[original fixture authority document](tests/fixtures/README.md).

| Case / source | Measured maximum error or statistic | Acceptance |
| --- | --- | --- |
| Orekit 13.1 KalmanEstimator, 10 PV updates, independent analytic two-body reference | Native position 1.862645149230957e-8 m; velocity 2.455635694786906e-11 m/s; covariance 3.797850922637736e-12 SI | 1e-6 m / 1e-8 m/s / 1e-6 per covariance entry |
| Orekit 13.1 UnscentedKalmanEstimator, same inputs | Native position 1.676380634307861e-8 m; velocity 2.000888343900442e-11 m/s; covariance 9.610978679575055e-9 SI | Same bounds |
| Orekit comparison via real WASM continuation and C++ WASM provider | EKF position 1.862645149230957e-8 m; UKF position 1.722946763038635e-8 m; UKF covariance 9.605102491150319e-9 SI | Same bounds; 10 EKF / 130 UKF seed propagations |
| Wan–Merwe quadratic sigma transform, alpha=1 and .5 | 1.7763568394002505e-15 and 0 absolute error | 2e-14; next seed exactly equals prior posterior |
| Boyd exact Gaussian posterior/covariance/NIS | 1.1102230246251565e-16 native maximum | 2e-14 |
| Hipparchus 4.0.3 published CV smoother, 50 epochs, EKF | State 2.026157019940911e-15; covariance 5.204170427930421e-17 | 1e-12 native, 2e-12 display-JSON WASM |
| Same published smoother, UKF | State 1.1102230246251565e-15; covariance 1.908195823574488e-16 | Same bounds |
| Exact PV and eight-state linear/clock Gaussian conditioning; ESA pseudorange equation | All assertions below 1e-12; PV below 1e-14; clock drift variance 3/103 | Stated analytic fractions, SI units |
| Mehra restricted scalar covariance matching | Next q scale 2.25 | 1e-14 |
| Sigma-gated R inflation | R scale 100/9-1 = 10.11111111111111; cap=2 rejects | 1e-10 bisection allowance |
| Nonlinear asynchronous EKF, 500 runs | ANEES 6.0606949133425125; NIS/dof 1.0015870253270314 | 99% chi-square: ANEES [5.60846959,6.40655574], NIS/dof [.97776439,1.02251913] |
| Nonlinear asynchronous UKF, 500 runs | ANEES 6.0607138187205525; NIS/dof 1.0015870153542406 | Same intervals |
| Ensemble RTS position RMSE | EKF 26.79089938766964 → 10.848264824935328 m; UKF 26.790908248599195 → 10.848257928968168 m | Smoother MSE does not increase; each covariance diagonal also checked |

## Exact commands and outcomes

Run from `analysis/estimation`. All commands exited 0.
Full stdout is saved under [conformance/depth](conformance/depth).

```text
node build.mjs
Built dist/isomorphic/module.wasm against spacedatastandards.org@1.203.0

node tests/build-provider.mjs
PASS built independent C++ WASM two-body test provider

node --test tests/schema-compat.test.mjs tests/native.test.mjs tests/depth.test.mjs tests/sequential.test.mjs tests/depth-invoke.test.mjs
ℹ tests 6
ℹ pass 6
ℹ fail 0

node --test tests/sdk_compat.test.mjs
ℹ tests 2
ℹ pass 2
ℹ fail 0

node tests/parity.mjs
parity PASS fixture=TMPL lane05 estimation module=2589309c8e7b6260 lanes=[browser(68 runs, 1771ms), wasmedge(68 runs, 2053ms), docker-wasmedge(68 runs, 43597ms)] comparisons=391
  17 case(s) byte-identical across 3 lane(s).

node tests/refresh-evidence.mjs
PASS refreshed authoritative conformance evidence for 2589309c8e7b6260118b8233cecfb8d94f6c781497a2808e09635feb90e21e5f

npm test
ℹ tests 13
ℹ pass 13
ℹ fail 0
ℹ skipped 0

node --test tests/conformance.test.mjs
ℹ tests 1
ℹ pass 1
ℹ fail 0

git diff --check
(no output; exit 0)
```

The parity receipt pins WasmEdge **0.16.4**, tests host widths **1/2/4/8**,
and covers 204 estimator executions including complete nonlinear replay,
intermediate requests, stale-seed rejection, PV/clock and adaptive Q/R.

## Remaining integration work / limits

- No live HPOP-to-estimation flow was assembled. The provider-neutral port is
  implemented and tested through a separate C++ WASM two-body provider. A host
  must route queries to its chosen propagator; it never computes dynamics.
- Raw GNSS transmit-time solution, navigation-message ingestion, relativistic
  corrections and carrier phase are outside this corrected-pseudorange model.
  Satellite positions must already be corrected to the reception frame; the
  generic tracking light-time/Sagnac flags must be disabled.
- SDS migration and cross-lane SDK/Python binding publication are intentionally
  deferred. ODR/OCM are six-state projections; `$EST` has the complete eight-state
  history. Linear KF uses the existing unspecified SDS estimator category.
- Q adaptation is a bounded scalar covariance-matching restriction, not full Q/R
  matrix identification. Neither Q adaptation nor R inflation is on by default.
- The stateless continuation replays prior answers; long-arc throughput and a
  persistent continuation format were not benchmarked.
- No deployment, publication, main merge, stack pin change or skipped test gate.
  The private worktree is retained for coordinator review/landing.

## Workspace guard

The attempted claim reported `no such task: tmpl-05-estimation-depth`.
The commit hook also picked up an unrelated pre-existing terrain-task scope.
The explicit owner override was used for the lane commits:

```text
GRAPH_PROTOCOL_GENERATION=main:65bfe5c174aebde03cb6c0dab819ce4c4011ec9f
GRAPH_GUARD_OVERRIDE=TMPL parity lane 05-estimation-depth (owner goal 2026-09-15)
```

The hook logged its overridden scope refusal. No unrelated staged files or
terrain-task edits were included.

## Exact changed paths

- `analysis/estimation/.gitignore`
- `analysis/estimation/HANDOFF.md`
- `analysis/estimation/README.md`
- `analysis/estimation/build.mjs`
- `analysis/estimation/conformance/depth/build.log`
- `analysis/estimation/conformance/depth/conformance-final.log`
- `analysis/estimation/conformance/depth/focused.log`
- `analysis/estimation/conformance/depth/npm-test.log`
- `analysis/estimation/conformance/depth/parity.log`
- `analysis/estimation/conformance/depth/refresh.log`
- `analysis/estimation/conformance/depth/sdk-compat.log`
- `analysis/estimation/conformance/estimation-evidence.json`
- `analysis/estimation/conformance/lane05-parity.json`
- `analysis/estimation/dist/build-provenance.json`
- `analysis/estimation/dist/isomorphic/module.wasm`
- `analysis/estimation/dist/plugin-manifest.json`
- `analysis/estimation/package.json`
- `analysis/estimation/plugin-manifest.json`
- `analysis/estimation/schemas/Estimation.fbs`
- `analysis/estimation/src/estimation.cpp`
- `analysis/estimation/src/estimation.hpp`
- `analysis/estimation/src/generated/invoke/BaseTypes_generated.h`
- `analysis/estimation/src/generated/invoke/Estimation_generated.h`
- `analysis/estimation/src/generated/invoke/Propagator_generated.h`
- `analysis/estimation/src/module.cpp`
- `analysis/estimation/tests/build-provider.mjs`
- `analysis/estimation/tests/depth-fixtures.mjs`
- `analysis/estimation/tests/depth-invoke.test.mjs`
- `analysis/estimation/tests/depth.test.mjs`
- `analysis/estimation/tests/depth_validation.cpp`
- `analysis/estimation/tests/fixtures/DEPTH.md`
- `analysis/estimation/tests/fixtures/OrekitReference.java`
- `analysis/estimation/tests/fixtures/README.md`
- `analysis/estimation/tests/fixtures/orekit-pv-reference.txt`
- `analysis/estimation/tests/parity.mjs`
- `analysis/estimation/tests/refresh-evidence.mjs`
- `analysis/estimation/tests/schema-compat.test.mjs`
- `analysis/estimation/tests/sequential_validation.cpp`
- `analysis/estimation/tests/two_body_provider.hpp`
- `analysis/estimation/tests/wire.mjs`
