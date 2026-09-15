# Measurement-based orbit estimation

This module implements the ratified `estimation` harness family. The estimator
never selects a force model: its `propagator_samples` input is populated by the
caller-selected propagator through `plugin_propagate` and `plugin_compute_stm`.
The same module therefore fits HPOP, numerical, ephemeris-driven, or future
propagators without changing estimator code.

The C++ core owns all measurement physics, corrections, linear algebra,
simulation, filtering and smoothing. JavaScript wrappers only move ABI bytes.
`$ODR` is the canonical run report and `$OCM` carries the estimator covariance.

The `REFERENCE_PROFILE` ionosphere selection consumes total electron content
and its time derivative from the caller's IRI-class media provider. The guest
then applies the published P.531 range and Doppler conversion; no atmospheric
profile or provider is hardwired into the estimator.

## TMPL lane 05 validation and contract hold

**Partial delivery; full estimation parity is blocked on SDK/SDS contracts.**
The public state is six-dimensional. No schema, enum value, reserved flag, or
unpublished field was invented for the missing capabilities.

| Selection | What is implemented and validated |
| --- | --- |
| Batch WLS | Existing iterative fit; exact correlated Gaussian state, covariance and residual RMS added in lane 05. Existing Orekit measurement/media and Vallado IOD checks remain. |
| EKF | Sequential covariance filtering about caller-supplied nominal states and cumulative STMs. Correct conditional vector measurement updates, Joseph covariance updates and complete joint NIS. Exact Gaussian conditioning and 500-run circular reference fusion tested. |
| EKF with RTS | Backward covariance/state smoothing; 50 published Hipparchus 4.0.3 constant-velocity reference epochs, covariance reduction and ensemble position-error reduction tested. |
| UKF | Legacy **measurement-only** unscented update, with fixed alpha=1, beta=2, kappa=0. It matches the published constant-velocity smoother in a linear-dynamics special case. **It is not a validated nonlinear-dynamics UKF:** no sigma points pass through the nonlinear propagator. |

Hipparchus is Orekit's filtering dependency; its published smoother test is
additional authority, **not a reproduction of Orekit's orbital
KalmanEstimator/UnscentedKalmanEstimator scenario**. That requested orbital
scenario remains undone. The SDK's legacy `ekf-ukf-not-aliased` receipt checks
only that covariances differ; passing it cannot certify a nonlinear UKF.

### Sequential input and update semantics

Supply paired observations and nominal propagation samples in nondecreasing
measurement-epoch order. Equal epochs are supported for independent sensors.
The filter rejects descending epochs, mismatched sample times (over 1e-8 s),
invalid kinds/counts, nonfinite states, nonpositive measurement sigmas,
non-SPD covariance, and invalid process-noise controls. Error-model overrides
are applied before validating the effective observation sigmas. Rejected
observations retain their prediction and are indexed in input order.

The initial state is also the initial nominal for the supplied trajectory.
Each sample STM maps perturbations from that initial epoch. The time update
uses `Phi_k = STM_k inverse(STM_(k-1))`, propagates the estimated deviation from
the previous nominal, and computes `Pminus = Phi P Phi^T + Q`. This is a
first-order update about a supplied trajectory; the module cannot request a
new nonlinear propagation around each corrected estimate through the current
single-shot input. HPOP lane 03 supplies compatible *cumulative* STMs, but no
live HPOP-to-estimation flow was built by lane 05.

Within a vector observation, `H` stays at the predicted state. Each scalar
component uses the updated covariance and subtracts the correction already
explained by earlier components from its innovation. With diagonal measurement
noise this equals the joint linearized Kalman update. Conditional sigma editing
retains its component-wise semantics: if any component exceeds the threshold,
the entire observation is rolled back. The full conditional NIS sum is still
reported. This edit can depend on component ordering; it is not a joint
chi-square gate or adaptive measurement-noise inflation.

RTS is tested over the history and across an ensemble. Its final state equals
the final filtered state by definition. Smoothing need not reduce realized
error at every individual epoch/run, even when its expected error decreases.

### Required upstream decisions

The installed, exact build pins are SDK **0.8.17** and SDS **1.203.0**.
`node_modules/space-data-module-sdk/schemas/orbpro/Estimation.fbs` has:

- `EstimatorKind` values 0–3 only; no linear KF selector or prelinearized `H`
  measurement input. The SDS ODR estimator enum likewise lacks linear KF.
- `EstimationObservation.value/sigma` fixed at four lanes; no
  `POSITION_VELOCITY` or GNSS pseudorange-with-clock measurement kind.
- `EstimationConfig.initial_state[6]`, covariance `[36]`, and matching fixed
  six-state sample, history and result records; no receiver clock bias/drift.
- No adaptive-Q/R controls or exposed Julier/Merwe parameters.
- A single vector of nominal states/STMs, with no request/response association
  for nonlinear sigma-point propagation or iterative recentering.

Ratify and publish the SDK/SDS extensions before completing those features.
`PSEUDONOISE_RANGE` is an existing tracking observable, not an implementation
of GNSS pseudorange with estimated receiver clocks. Fixed SNC/DMC covariance
terms are not adaptive noise; the existing six-state DMC approximation is not
an augmented acceleration-state Gauss-Markov filter.

### Reproduce the checks

From `analysis/estimation`, with the SDK-supported WASI compiler and WasmEdge
0.16.4, Chrome, and Docker installed:

```sh
npm ci
npm run build
node --test tests/native.test.mjs tests/sequential.test.mjs tests/invoke.test.mjs
node --test tests/sdk_compat.test.mjs
PATH="$HOME/.wasmedge/bin:$PATH" node tests/parity.mjs
node tests/refresh-evidence.mjs
npm test
```

The parity harness tests the identical `dist/isomorphic/module.wasm` in real
Chrome/V8, native WasmEdge and container WasmEdge with worker widths 1/2/4/8.
The artifact is inherently sequential; these widths test host invariance,
not concurrent filter updates. Structured error responses travel over a
successful command transport; `invoke.test.mjs` checks their nonzero guest
statuses. `esbuild` is an explicit test dependency for the SDK browser harness.

See [fixture authorities and tolerances](tests/fixtures/README.md), the
[tri-runtime receipt](conformance/lane05-parity.json), and the
[coordinator handoff](../../docs/tmpl-lane-05-handoff.md). The refreshed legacy
conformance receipt uses live native measurements and the new exact Gaussian
batch authority, not copied zero-error placeholders.
