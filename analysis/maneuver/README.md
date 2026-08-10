# Maneuver Planning Plugin

Classical orbital maneuver and ROE targeting operations packaged as a canonical `space-data-module-sdk` command-surface plugin for hosted SDN runtimes, WasmEdge, and browser runtimes.

## What it does

This plugin exposes maneuver computations through a single canonical SDK method:

- `invoke`

The request payload is UTF-8 JSON with this envelope:

```json
{
  "operation": "hohmannTransfer",
  "params": {
    "r1": 6778000.0,
    "r2": 42164000.0,
    "mu": 398600441800000.0
  }
}
```

The response payload is UTF-8 JSON returned on the `response` port.

## Supported operations

- `version`
- `hohmannTransfer`
- `biEllipticTransfer`
- `solveLambert`
- `solveLambertMinDV`
- `phasingManeuver`
- `phasingFromTargetState`
- `planeChange`
- `combinedManeuver`
- `computeRoeStateTransition`
- `planRelativeWaypointMission`
- `computeCAM`
- `computeApproach`
- `simulateRendezvous`

These operations mirror the repo’s existing maneuver math and targeting helpers and are routed through the canonical SDK command bridge.

## simulateRendezvous

Closed-loop rendezvous simulation in the target LVLH frame (x = radial,
y = along-track, z = cross-track; a chaser behind the target on V-bar has
y < 0). The guidance profile follows Fehse (*Automated Rendezvous and Docking
of Spacecraft*):

1. **Combined-case drift leg** — free-drift HCW motion whose initial velocity
   is solved as a Clohessy–Wiltshire two-point boundary value problem so the
   chaser arrives at the V-bar brake point after `driftDuration`.
2. **Fifth-order braking segment** — a per-axis quintic polynomial that
   matches position, velocity, and acceleration at the brake handoff and
   reaches the hold point with zero velocity and zero acceleration.
3. **Station-keeping hold** at the hold point for `holdDuration`.

The controller is feedback-linearized PD: it commands the reference
acceleration (feedforward), cancels the Coriolis (`2n·v`) and gravity-gradient
(`3n²x`, `−n²z`) coupling of the HCW dynamics, and adds proportional/derivative
error correction, yielding a per-axis double-integrator closed loop.

The truth model is deliberately *not* the HCW linearization: target and chaser
are propagated in the inertial frame with nonlinear two-body gravity (optional
J2) by fixed-step RK4, the control acceleration is mapped LVLH → inertial and
held over each step, and the controller re-derives the LVLH state from both
inertial states every step — the same architecture as a Basilisk-style
simulation. HCW model error therefore shows up as a real disturbance the PD
loop must absorb.

### Tunable levers

Boundary conditions and profile (`params`, meters / m/s / seconds):

| Lever | Default | Effect |
| --- | --- | --- |
| `chief` | required | Target orbit (`semiMajorAxis`, `eccentricity`, `inclination`, `raan`, `argumentOfPerigee`, `meanAnomaly`, `mu`). The reference model assumes near-circular; eccentricity appears as a tracking disturbance. |
| `initialPosition` | required | Chaser LVLH start, e.g. `[100, -338.8, 0]` = 338.8 m behind, 100 m radial offset. |
| `initialVelocity` | solved | Explicit LVLH start velocity. Providing it disables the BVP solve unless `solveInitialVelocity` is forced back to `true`. |
| `solveInitialVelocity` | `true` | Solve the CW BVP for the drift-leg initial velocity that arrives at `brakePoint` after `driftDuration`. Fails (with an explanatory error) when `driftDuration` is near an integer number of orbital periods, where the transfer matrix is singular. |
| `brakePoint` | required | V-bar brake gate in LVLH, e.g. `[0, -80, 0]`. |
| `holdPoint` | required | Final V-bar hold point reached with zero relative velocity and acceleration. |
| `driftDuration` | required | Combined-case drift leg duration. Longer drifts cost less delta-v but take longer; avoid multiples of the orbital period. |
| `brakeDuration` | required | Quintic braking segment duration. Shorter braking raises peak commanded acceleration. |
| `holdDuration` | `0` | Station-keeping tail after the braking segment. |

Controller (`params.control`):

| Lever | Default | Effect |
| --- | --- | --- |
| `bandwidth` | `10 n` | Closed-loop natural frequency ωₙ [rad/s]. Higher tracks tighter but commands more acceleration. |
| `dampingRatio` | `1.0` | Closed-loop damping ratio ζ (1 = critically damped). |
| `kp` | `ωₙ²` | Explicit proportional gain; overrides the bandwidth derivation when set. |
| `kd` | `2ζ√kp` | Explicit derivative gain; overrides the damping derivation when set. |
| `useFeedforward` | `true` | Apply the reference acceleration as feedforward. Disable to study pure-feedback tracking. |
| `compensateCoriolis` | `true` | Cancel the `2n·v` velocity coupling of the HCW dynamics. |
| `compensateGravityGradient` | `true` | Cancel the `3n²x` / `−n²z` position coupling. |
| `maxAccel` | unlimited | Per-command acceleration saturation [m/s²]. Clipped steps are counted in `metrics.saturatedSteps`. |

Truth model and integration (`params.integration`):

| Lever | Default | Effect |
| --- | --- | --- |
| `timeStep` | `1.0` | RK4 step and controller update period (zero-order hold) [s]. Must not exceed either segment duration. |
| `outputEvery` | `10` | Log every Nth step to `trajectory` (the final step is always logged). |
| `includeJ2` | `false` | Add the J2 zonal term to the inertial truth gravity for both vehicles. |

### Example

See `tests/fixtures/request.rendezvous.json`:

```json
{
  "operation": "simulateRendezvous",
  "params": {
    "chief": { "semiMajorAxis": 6778000.0, "eccentricity": 0.0, "inclination": 0.9006, "mu": 398600441800000.0 },
    "initialPosition": [100.0, -338.8, 0.0],
    "brakePoint": [0.0, -80.0, 0.0],
    "holdPoint": [0.0, -30.0, 0.0],
    "driftDuration": 2000.0,
    "brakeDuration": 400.0,
    "holdDuration": 300.0,
    "integration": { "timeStep": 0.5, "outputEvery": 40 }
  }
}
```

The response reports the solved drift-leg initial velocity, resolved gains,
phase boundaries, tracking/effort metrics (`totalDeltaV`, max/RMS/per-phase
position error, final position and velocity error, saturation count), and a
decimated `trajectory` log with actual state, reference state, and commanded
control acceleration per sample.

## Errors

**No input traps this module.** Every refusal — an unknown operation, a missing
or mistyped parameter, a value outside a validator's range, a malformed body, a
geometry with no solution — comes back as a non-zero `statusCode` with a stable
`errorCode` and a `response` frame carrying:

```json
{ "error": "[phasing]: Number of revolutions must be >= 1", "errorCode": "invalid-parameter" }
```

and **the instance keeps working**. This is worth stating plainly because it was
not true before 0.2.0: 0.1.0 linked without exception support, so its `try`/
`catch` was compiled away, every `throw` became a trap, and a single bad
parameter poisoned the instance for every subsequent call. Every validator
message in this module was unreachable for its entire life.

Codes: `invalid-parameter`, `malformed-request`, `unknown-operation`,
`no-solution`, `infeasible`, `singular-configuration`, `missing-request-input`,
`emit-failed`, `internal-error`.

## Notes on specific operations

- **`phasingManeuver`** clamps the phasing orbit so its far apse cannot fall
  below `Re + 100 km` (WGS-84), and REPORTS the clamp:
  `clampedToEarthFloor`, `farApse`, `earthFloorRadius`, `requestedPhasingSMA`,
  and `achievedPhaseAngle` — the phase shift the clamped orbit actually
  delivers, which is the number to show an operator who asked for more than the
  requested revolutions can buy.
- **`phasingFromTargetState`** (**0.4.0**) is the map from a TARGET SPACECRAFT
  to the angle `phasingManeuver` consumes, and then to the plan itself. It
  exists because the angle cannot be derived by the caller: a console holding
  two spacecraft states had to difference two mean anomalies in JavaScript to
  get it, which the no-JS-physics law forbids and which is wrong anyway the
  moment the two orbits' apsides differ.

  Each craft arrives under EXACTLY ONE of two keys — `chaser` / `target` for a
  classical element set (the same shape `chief` takes elsewhere), or
  `chaserState` / `targetState` for `{position[3], velocity[3]}` in SI metres
  and m/s in an inertial frame. Both keys for one craft, or neither, is a
  refusal that names both spellings; there is no sniffing of one polymorphic
  key, so a request always says which form it carries.

  **`relativePhaseAngle`** is the answer: signed, wrapped to `(-pi, pi]`,
  POSITIVE when the TARGET LEADS and the chaser must gain phase. It is the
  quasi-nonsingular relative mean longitude this module already uses as
  `dlambda` — `(lambda_target - lambda_chaser) + dRAAN * cos(i_chaser)`, where
  `lambda` is the mean ARGUMENT OF LATITUDE (`argumentOfPerigee + meanAnomaly`)
  and not the mean anomaly. Both are published, side by side, because on a pair
  whose apsides are opposed they differ by 180 degrees and only one of them is
  the separation.

  **Both directions are always answered.** `catchUpAngle` in `(0, 2pi]` and
  `fallBehindAngle` in `[-2pi, 0)` are the two ways to fly the same rendezvous,
  `direction` (`"short"` default, `"catchUp"`, `"fallBehind"`) picks which one
  drives the plan, and the `catchUp` and `fallBehind` sub-objects summarise
  BOTH whichever was picked. /beta has a CATCH S/C card and a FALL BEHIND card
  and each means its direction literally; on a target leading by 30 degrees the
  long way round costs eight times the short way, and a module that quietly
  substituted the cheap one would be answering the card that was not pressed.

  **`recommendedRevs`** is the revolution-count trade, made here because this is
  where the Earth-floor clamp lives: the smallest count in `[1, maxRevs]` whose
  plan neither clamps nor exceeds `deltaVBudget` (default 1% of the chaser's
  circular speed — ~77 m/s in LEO, ~31 m/s at GEO). Both conditions relax
  monotonically with the count, so the first hit is the answer and the scan
  never ranks. `maxRevs` is CLAMPED into `[1, 100000]` and reported.

  **Three verdicts, each beside the threshold that produced it**: `coplanar`
  (on `planeAngle`, the angle between the orbit NORMALS — two orbits can share
  an inclination and be 180 degrees apart in RAAN), `nearCircular` (on both
  eccentricities) and `coOrbital` (on `semiMajorAxisDifference`). None of them
  is a refusal. The composed far rendezvous plans the plane change FIRST and
  needs this stage's numbers afterwards, so refusing a non-coplanar pair would
  break the composition the operation exists to complete.

  The plan itself is emitted under `phasingManeuver`'s own key names — `dv1`,
  `dv2`, `totalDeltaV`, `phasingPeriod`, `phasingSMA`, `totalTime`, `numRevs`,
  `phaseAngle`, `dv1_ric`, `dv2_ric` and the whole Earth-floor group — by the
  same writer, so the two operations cannot drift into two spellings of one
  solution. `phasingRadius` says what the plan was flown at: the chaser's
  SEMI-MAJOR AXIS, because the phasing model's period comes from `a` and
  seeding it with the instantaneous `|r|` would produce a plan for an orbit the
  chaser is not on.

- **`solveLambert`** is a bracketed, residual-checked universal-variable solve
  (Bate-Mueller-White / Curtis Algorithm 5.2). `converged` is a MEASUREMENT —
  the residual met its gate — never a literal, and the response carries
  `residual`, `residualBudget`, `z` and `iterations` so the claim is auditable.
  A geometry with no arc of the requested revolution count returns
  `no-solution` rather than a velocity that flies nowhere.

  The zero-revolution search marches down from `z = 0` and, since **0.3.0**,
  respects the branch's own domain boundary: a probe that lands where `y(z) < 0`
  bisects back toward the boundary instead of doubling further past it. 0.2.0
  doubled unconditionally and so reported `no-solution` for a whole class of
  short-transfer-angle hyperbolic arcs — Curtis example 5.3 among them, whose
  root at `z = -0.173` sits inside a domain that ends at `z = -0.398`.

- **`branch`** (request, optional, **0.3.0**): `"low"` | `"high"`, default
  `"low"`. A Lambert problem with `nRevs >= 1` has TWO arcs per revolution
  count, because `F(z)` on `((2πN)², (2π(N+1))²)` dips and rises — a given time
  of flight is met twice. `"low"` is the first crossing and is what every
  version through 0.2.0 returned; `"high"` is the second. On Der's Molniya
  geometry the two one-revolution arcs differ by 1.03 km/s in departure speed.
  The response carries `branch` whenever `revolutions >= 1`, and carries no such
  key at zero revolutions, where the root is unique and there is no branch to
  name.

  On `solveLambertMinDV` the parameter NARROWS the candidate set rather than
  choosing an arc: the default is to rank over both branches of every revolution
  count, and the response publishes the whole set it ranked as `branches` —
  `{revolutions, branch, dv1, dv2, totalDeltaV}` in canonical order (revolutions
  ascending, low before high). 0.2.0 saw one arc per revolution count and so
  minimised over half its domain while presenting the winner as global.

- **The transfer arc's own conic** (response, **0.3.0**). A converged Lambert
  answer now says how low and how high the arc goes, so the CONSUMER can screen:
  `perigeeRadius` [m from the centre], `transferEccentricity`, and
  `transferConic` (`"elliptic"` | `"parabolic"` | `"hyperbolic"`) are always
  present; `apogeeRadius` and `transferSemiMajorAxis` appear only where the
  quantity exists and is representable — a hyperbolic transfer has no apoapsis,
  a parabolic one has neither, and `transferConic` is what distinguishes "this
  arc has no apoapsis" from "this field was dropped".

  This is a REPORT, never a refusal. Six of the published conformance geometries
  in `vectors/vectors.json` produce transfers that pass through the Earth —
  Vallado example 7-5 dives to 3,186 km from the centre, Der's Molniya case to
  909 km — and every one is a correct answer that hapsira, Orekit or Vallado
  asserts. Lambert is also an orbit-determination tool, and an arc between two
  observations owes nothing to any floor. A manoeuvre card screens on
  `perigeeRadius` and refuses; an IOD caller ignores it.

- **`solveLambert` / `solveLambertMinDV` delta-v.** The scalars are named for
  what they are: `v1Magnitude` / `v2Magnitude` are the transfer SPEEDS. Real
  `dv1` / `dv2` / `totalDeltaV` appear only when the caller states the orbits
  being left and joined, via `departureVelocity` and `arrivalVelocity`.
  `solveLambertMinDV` REQUIRES them — ranking revolution counts needs a cost,
  and 0.1.0 ranked on `|v1| + |v2|`, which is not the cost of anything.
- **Signed RIC arrays** are serialised by every operation that computes one:
  `dv1_ric` / `dv2_ric` / `dv3_ric` / `dv_ric`. Read the array, never the
  scalar — the scalars are magnitudes.

## Runtime contract

- Thread model: **`wasi-sequential`** (`threadModel` in `plugin-manifest.json`,
  with a machine-readable `sequentialJustification`). Compiled by the SDK lane
  with clang `wasm32-wasip1-threads`; the module spawns nothing.
- Embedded manifest exports (generated by the SDK from the manifest itself):
  - `plugin_get_manifest_flatbuffer`
  - `plugin_get_manifest_flatbuffer_size`
- Command bridge export:
  - `plugin_invoke_stream`
- Runtime targets: `browser`, `wasi`, `wasmedge`
- Imports: `wasi_snapshot_preview1` only.

> **Running it under a bare `wasmedge`:** pass `--enable-threads`. On the
> `wasm32-wasip1-threads` triple wasm-ld DECLARES a shared memory (limits flags
> `0x03`) even for a sequential guest with no atomics, and WasmEdge refuses to
> LOAD such a module without the proposal enabled — reporting
> `integer too large / At AST node: limit`, which looks like a corrupt artifact
> and is not one. The module owns its memory (it imports none) and spawns no
> threads. The SDK's own loader passes the flag by default.

## Build

The wasm artifact is built through the SDK compiler lane:

```bash
npm run build            # node build.js
```

`build.js` amalgamates `src/cpp/{include,src}` into the single translation unit
`compileModuleFromSource` takes, and passes `threadModel` explicitly (the
compiler reads the OPTION, not the manifest field, and infers pthreads from
`runtimeTargets` otherwise). Output: `dist/isomorphic/module.wasm` plus
`dist/plugin-manifest.json`.

There is **one** artifact. 0.1.0 also shipped an emcc `dist/browser/module.js`
+ `.wasm` pair; that lane is retired. It was outside the sanctioned toolchain,
it was the direct cause of the missing error path, and a second artifact built
from one set of sources is the drift the isomorphic law exists to refuse.

Native C++ unit tests (same `-fno-exceptions` dialect as the shipped artifact):

```bash
cmake -S src/cpp -B build && cmake --build build -j4
ctest --test-dir build --output-on-failure
```

## Verification

```bash
npm test                 # sdk_compat + behavior + vectors + error_path
```

- `tests/sdk_compat.test.mjs` — SDK artifact compliance, the isomorphic surface,
  the browser harness, the WasmEdge server path, the hosted-runtime example.
- `tests/ratchet.test.mjs` — the vector ratchet: counts and the GREEN count may
  only grow (`vectors/ratchet.json`), so a row deleted or demoted to
  expected-to-fail is a test failure rather than a quiet loss.
- `tests/vectors.test.mjs` — the three-tier parity vectors
  (`vectors/vectors.json`), plus the Lambert LEO sweep: 72 geometries whose
  every claimed solution must actually arrive, adjudicated by the independent
  Kepler propagator in `vectors/index.mjs`.
- `tests/error_path.test.mjs` — every refusal is structured, the instance
  survives, and a 698-input fuzz pass proves no input traps the module.
- `tests/behavior.test.mjs` — the relative-motion operations no command card
  consumes yet.

Tri-runtime parity:

```bash
node ../../node_modules/space-data-module-sdk/bin/space-data-module.js parity \
  --wasm dist/isomorphic/module.wasm \
  --fixture parity/maneuver-command.json \
  --lanes browser,wasmedge,docker-wasmedge
```

## hosted-runtime example

A minimal single-plugin flow example lives at:

- `tests/fixtures/hosted-runtime/maneuver.single-plugin.flow.json`

It binds a manual trigger to the plugin’s canonical `request` port and invokes method `invoke`.

## Example request

The fixture used by the compatibility tests lives at:

- `tests/fixtures/request.hohmann.json`

It exercises a Hohmann transfer from LEO-like radius to GEO.

## License

Apache-2.0.
