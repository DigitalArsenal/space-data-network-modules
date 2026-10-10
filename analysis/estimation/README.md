# Measurement-based orbit estimation

C++ WASM estimation through the SDK's `dist/isomorphic/module.wasm`. The caller
selects the propagator; the estimator contains no force model. JavaScript only
routes FlatBuffer messages. The build pins SDK **0.8.17** and SDS **1.203.0**.

## Sequential estimators

| Selector | Behavior |
| --- | --- |
| `EXTENDED_KALMAN_FILTER` | Linearizes the measurement about the predicted state; joint vector update and Joseph covariance update. With nonlinear propagation enabled, propagates from the last corrected state and uses the provider's local STM. |
| `UNSCENTED_KALMAN_FILTER` | Wan–van der Merwe sigma points through the selected nonlinear propagator, followed by a joint unscented measurement update. Exposes alpha/beta/kappa; defaults 1/2/0. Regenerates the measurement cloud after adding Q. |
| `LINEAR_KALMAN_FILTER` | Explicit prelinearized affine transition and `y = H x + offset` measurements, or direct position/PV measurements. Rejects nonlinear measurement kinds and nonlinear port mode. |
| `EXTENDED_KALMAN_FILTER_WITH_RTS` | EKF plus backward RTS. `options.smooth` also enables smoothing for UKF or linear KF. UKF smoothing uses the sigma-point transition cross-covariance. |

Batch WLS, simulation, tracking corrections, media and IOD retain their existing
interfaces and authoritative tests. Extended records are sequential-only.

All observations must be chronological; simultaneous independent sensors are
supported. Covariances must be symmetric positive definite. Measurement sigma
values must be positive and finite. Whole-vector sigma editing tests conditional
innovations obtained from the Cholesky factor of S. Any failed component rolls
back the entire observation. NIS is the full joint innovation statistic; editing
is a component gate, not a joint chi-square gate.

### Propagation modes

**Legacy affine mode (default):** supply one `propagator_samples` state and
cumulative STM per observation, starting from the configured initial nominal.
The filter uses `Phi_k = STM_k inverse(STM_(k-1))` to propagate its deviation from
the nominal. UKF remains available for this explicitly affine dynamics model.

**Nonlinear mode:** set `request.options.nonlinear_propagation = true`. Keep the
named `propagator_port_id` and `plugin_propagate plugin_compute_stm` capability.
The required legacy `propagator_samples` input port may carry an empty envelope.

1. Invoke `run_estimation` with the unchanged request and any accumulated
   `EstimationEnvelope.propagation_answers`.
2. A successful transport response with result status `NEEDS_PROPAGATION` holds
   `propagation_requests`. Each includes a sequence, exact six-state seed and
   seed epoch/frame, and a target epoch. There is one seed for EKF and `2n+1`
   seeds for UKF (`n=6` or `8`). Equal epochs require no propagation.
3. Route these seeds to the caller-selected **C++ WASM** propagator. Each sample
   must contain its propagated state and an STM **relative to that seed**.
   Echo the query unchanged in each `PropagationAnswer`, append answers in
   sequence, and repeat the invocation. Use binary generated bindings: rounding
   a seed through a display JSON decoder invalidates its association.
4. The final result has status `OK` and the filtered/smoothed histories. Stale
   seeds, epochs, frames, reordered or excess answers fail explicitly.

The module replays supplied answers deterministically. Every new observation
starts from the preceding posterior; sigma clouds are newly centered after each
update. The protocol is stateless and works across runtimes. Replay storage and
work grow with the observation count; large operational arcs should be split
at posterior boundaries. There is no live HPOP integration in this lane; the
inverted port is exercised with an independent C++ WASM two-body provider.

### Adaptive noise (off by default)

`adaptive_process_noise` enables a bounded scalar innovation covariance-matching
update inspired by [Mehra (1970)](https://doi.org/10.1109/TAC.1970.1099422).
It scales the supplied SNC/DMC and clock Q for **the next** prediction. It does
not identify an unrestricted Q/R matrix. With `Q = q Qbase`, the update uses
`E[nu nu' - S] = (q_true-q) H Qbase H'`, summing diagonal terms normalized by R.
The UKF uses the central measurement Jacobian for this first-order sensitivity.
The target scale is clipped to `minimum_process_scale`/`maximum_process_scale`,
then exponentially averaged by `adaptation_rate` (default 0.05). Rejected or
R-inflated observations do not train Q. Zero observable Q sensitivity leaves
the scale unchanged. Fixed six-state DMC retains its existing approximation;
this extension does not introduce estimated acceleration states.

`inflate_measurement_noise` increases the current observation's diagonal R only
when the existing sigma gate fails, searching up to `maximum_measurement_scale`.
If that cap cannot pass the gate, the observation is rejected. R returns to its
declared value for the next observation. Histories expose actual Q/R scales.
These controls are robustness tools; the tests do not claim universal adaptive
filter convergence or improvement for arbitrary force-model errors.

### PV and receiver clock states

`POSITION_VELOCITY` contains `[x,y,z,vx,vy,vz]` in m and m/s in the request frame.
Use `extended_observations`, which replaces the legacy observation vector and
carries 1–6 values and sigmas. `LINEAR` additionally supplies row-major H
(`measurement count` by `state dimension`) and a matching offset vector.

`estimate_clock` adds receiver bias **in metres** and drift **in metres/second**:
`[x,y,z,vx,vy,vz,b,bdot]`. Supply the full row-major `initial_covariance8` (64
entries, including orbit-clock cross terms), initial bias and drift. Bias evolves
as `b + dt*bdot`. Optional clock PSDs add continuous bias/drift random-walk noise.
`extended_history` contains the full 8-state posterior, smoothed state and 8x8
covariances. The existing state/history records retain their six-state layout.

`PSEUDORANGE` models `distance(receiver, satellite) + b - satellite_clock_bias_m`
plus the selected existing media/hardware corrections, consistent with
[ESA's observable equation](https://gssc.esa.int/navipedia/index.php/GNSS_Basic_Observables).
The transmitter coordinates use `station_position_m`, already corrected to the
reception frame and signal-transmission geometry by the caller. Both generic
light-time and Sagnac corrections must be disabled (`flags: 3`); requests that
leave them enabled fail rather than apply the tracking model with reversed
transmitter/receiver roles. This is a corrected-code observation model, not a
raw navigation-message decoder, transmit-time solver or carrier-phase solver.

## Batch fit with dynamic parameters (`fit_batch`)

Weighted batch least squares of the state at the configuration epoch plus
dynamic parameters (for propagator/hpop: B = Cd·A/m, BDOT, AGOM = Cr·A/m, the
in-track acceleration), Gauss–Newton on whitened residuals (Tapley, Schutz &
Born 2004, §4.3–4.6). The module holds no force model.

- **Request:** a `BATCH_WEIGHTED_LEAST_SQUARES` configuration (epoch, initial
  state), legacy observations or extended observations (1–6 lanes, e.g.
  `POSITION_VELOCITY` for a catalog element set's state at its epoch), and
  `batch_options`: `parameter_kinds` (the caller's
  vocabulary, e.g. PRW `DYNAMIC_PARAMETERS` ordinals, echoed), initial
  `parameter_values`, optional `apriori_covariance` ((6+p)², empty = none),
  optional `observation_covariances` (value_count² per observation, whitened
  by its Cholesky factor; `covariance_axes` 1 states them in the radial,
  transverse and normal axes of each observed `POSITION_VELOCITY` state),
  `maximum_iterations`,
  `correction_tolerance` (√(dxᵀN dx/n)) and `sigma_edit_threshold` (edit an
  observation whose whitened RMS exceeds k × max(1, previous weighted RMS)).
- **Inverted port:** each iteration returns `NEEDS_PROPAGATION` with one
  `PropagationQuery` per observation from one seed (state and
  `parameter_values`). The caller propagates once with the parameters as
  `DYNAMIC_PARAMETERS`, answers each query with the sample state, its 6×6
  STM and the 6×p `sensitivity` (the S block of [[Φ, S], [0, I]]), and
  replays the unchanged request with every answer so far.
- **Result:** `batch_fit`: the estimate [state, parameters], the formal
  covariance (JᵀWJ + P₀⁻¹)⁻¹, the same times the reduced χ²
  (`scaled_covariance`), χ², degrees of freedom, weighted RMS, whitened
  post-fit residuals and edits; status `OK` or `NOT_CONVERGED` in the record
  (the invocation itself succeeds). `estimate` carries the six-state part.
  Process noise is applied when the result is propagated (propagator/hpop
  `PROCESS_NOISE` with the full covariance as `INITIAL_COVARIANCE`).

Authority ([batch_fit.test.mjs](tests/batch_fit.test.mjs)): Orekit 13.1
`BatchLSEstimator` on the same noisy positions
([OrekitBatchReference.java](tests/fixtures/OrekitBatchReference.java)),
with propagator/hpop's WASM answering the queries: LEO 400 km with drag
(state + B, positions), GPS (state + AGOM, positions with per-axis
variances as full 3×3 matrices) and GPS with full-state measurements (with
sigmas, and with RTN covariances rotated by Orekit's QSW frame). The
estimate agrees within 1.1e-3 of a formal sigma (0.8 mm), the covariance
within 2.2e-6 of √(PᵢᵢPⱼⱼ) and χ² within 1.2e-6. Orekit's batch estimator
weights components by their sigmas alone, so a covariance correlated in the
request axes has no Orekit reference.

## Admissible sets: ESPF, set-membership filter and TEAG primitives (extension v3)

Implemented from the papers, independently of their authors' code; every step,
gap, choice and parameter is in [docs/espf-spec.md](docs/espf-spec.md).

| Selector | Behavior |
| --- | --- |
| `ESPF_2025` | The Epistemic Support-Point Filter as Jah and Haslett (arXiv 2508.20806) describe it: 2n + 1 support points, Minkowski prediction, joint epistemic spread, uniform compatibility, surprisal pruning, sup-min fusion, weighted mode, spread, radius and sigma adaptation with the stated temporal decay. `espf.gaussian_limit` runs its appendix's Gaussian limit (the UKF). |
| `ESPF_2026` | The canonical form of the 2026 TEAG papers: a level-3 Smolyak support (85 points), max-plus conjunctive update Phi+ = max(Phi-, q/2) in MVEE-whitened innovation space, Choquet information content, PCRB-admissible basin with N_min = 2n + 1, whitened minimax medoid, MVEE regeneration with the r+ = 1.15 / r- = 0.97 sigma controller. |
| `ELLIPSOIDAL_SET_MEMBERSHIP` | Outer bounding ellipsoids (Schweppe 1968; Bertsekas and Rhodes 1971): predicted F S F' plus the process set, updated by the minimum-trace (or log-det) member of the outer family; empty intersections are flagged and leave the set unchanged. |

They take every measurement kind the EKF/UKF take except `PSEUDORANGE`
(six-state only), `LINEAR` records included (H is value_count x 6).
All three use nonlinear propagation through the same inverted port as the UKF
(`options.nonlinear_propagation`): every support point is a query, answered by
the caller's propagator (propagator/hpop at full force). Options are
`SequentialOptions.espf` and `set_membership`. Results add `support_history`
(per observation: the posterior set, carried and predicted shapes, support and
survivor counts, medoid, Choquet surprisal, information content, rescaling
shift, PCRB basin and floor, sigma, inconsistency) and `final_support`. A
request may start from a previous `final_support` (`options.initial_support`)
at its configuration epoch, so an arc can be split at any observation and
continues exactly. The `filter_history` covariance of these estimators holds the
set's shape, not a covariance; the OCM says so.

`evaluate_teag` exposes the TEAG primitives (src/teag.hpp) on a finite support:
the conjunctive update, rescaling, active-front zones, alpha-cuts, possibility
and necessity of events, Choquet surprisal and information content, the PCRB
basin, the minimum-volume enclosing ellipsoid, the minimax medoid, Smolyak
Clenshaw-Curtis grids, the Minkowski outer bound and the truncated
possibilistic entropy.

Authority:

- [teag.test.mjs](tests/teag.test.mjs): the scalar closed forms of Jah 2026
  ("The ESPF as a Tropical Hamilton-Jacobi System", section 4, eqs. 8-14),
  exactly on dyadic cases; idempotence, Popperian monotonicity, the alpha-cut
  intersection, N(A) = 1 - Pi(A^c) and maxitivity; the MVEE of analytic sets;
  Smolyak counts; the Minkowski bound's containment.
- [mvee.test.mjs](tests/mvee.test.mjs): the MVEE against an independent numpy
  implementation (fixture generated by
  [mvee_numpy_reference.py](tests/fixtures/mvee_numpy_reference.py)), about
  1e-12.
- [espf.test.mjs](tests/espf.test.mjs), with propagator/hpop answering at full
  force: the 2025 Gaussian limit reproduces the UKF (state 1.6e-14, covariance
  1.9e-11 relative over 12 epochs); ESPF 2026 invariants and exact restart;
  the 2025 decay; the set-membership filter keeps the truth inside its bound
  and flags an impossible observation.

## Append-only invoke contract v1

[`schemas/Estimation.fbs`](schemas/Estimation.fbs) is the module-local invoke
contract, extended from the pinned SDK baseline under coordinator authorization.
**No SDS schema is changed.** Build-generated bindings are in
`src/generated/invoke`; a schema compatibility test preserves every legacy
struct, enum ordinal and table field prefix.

Additions:

- Enum suffixes: estimator `LINEAR_KALMAN_FILTER=4`; measurement
  `POSITION_VELOCITY=21`, `PSEUDORANGE=22`, `LINEAR=23`; status
  `NEEDS_PROPAGATION=1`.
- Tables: `SequentialOptions`, `ExtendedObservation`, `ExtendedFilterEpoch`,
  `PropagationQuery`, `PropagationAnswer`.
- Optional suffix fields: request `options`/`extended_observations`; result
  `extended_history`/`propagation_requests`; envelope `propagation_answers`.
- Extension v3: estimator `ESPF_2025=5`, `ESPF_2026=6`,
  `ELLIPSOIDAL_SET_MEMBERSHIP=7`; tables `EspfOptions`, `SetMembershipOptions`,
  `SupportState`, `SupportEpoch`, `TeagRequest`, `TeagResult`; optional suffix
  fields `SequentialOptions.espf`/`set_membership`/`initial_support`,
  `EstimationResult.support_history`/`final_support` and envelope
  `teag_request`/`teag_result`.

The OCM publishes the fit's formal covariance with its assumptions and
`COV_CALIBRATION Uncalibrated` (SDS 1.232.0). The covariance is conditional on
the assumptions and has no coverage evidence of its own.

- `OD_NOISE_MODELS`: zero-mean Gaussian noise, independent between
  observations, with the 1-sigma by measurement type as weighted.
- `OD_DATA_WEIGHTING`: inverse variance, with the edit threshold.
- `OD_PROCESS_NOISE`: kind and acceleration spectral density.
- `OD_APRIORI_DATA`: the a priori sigmas.
- `OD_CONVERGENCE_CRITERIA` (batch).
- `OD_OBSERVATIONS_TYPE` and `OD_OBSERVATIONS_USED`.
- The header comment states:
  - estimated parameters: position and velocity;
  - consider parameters: none;
  - measurement biases: neither estimated nor considered, since error-model
    biases enter simulation only.

ODR/OCM remain six-state **orbit projections**; full clock estimates and adaptive
settings are in `$EST`. Their existing estimator enums have no linear KF value:
ODR uses `UNSPECIFIED`, OCM uses `Unknown` with algorithm text
`LINEAR_KALMAN_FILTER`. No unratified SDS enum values are emitted. Existing SDK
or Python bindings can read the legacy fields but need regeneration from the
module-local schema to access additions; that cross-lane migration is deferred.

## Verification

```sh
npm ci
node build.mjs
node tests/build-provider.mjs
node --test tests/depth.test.mjs tests/sequential.test.mjs tests/depth-invoke.test.mjs
node --test tests/teag.test.mjs tests/mvee.test.mjs tests/espf.test.mjs
node --test tests/sdk_compat.test.mjs
PATH="$HOME/.wasmedge/bin:$PATH" node tests/parity.mjs
node tests/refresh-evidence.mjs
npm test
```

The test provider is an ignored fixture, also built by `npm test`'s pretest hook.
Its physics is C++ WASM. Production artifacts never include that provider.
Parity runs identical estimator bytes in Chrome/V8, native WasmEdge and container
WasmEdge at host worker widths 1/2/4/8. This sequential artifact tests host width
invariance, not concurrent filter updates.

See [original fixture authorities](tests/fixtures/README.md),
[depth authority and reproduction details](tests/fixtures/DEPTH.md), and
[the tri-runtime receipt](conformance/lane05-parity.json).
