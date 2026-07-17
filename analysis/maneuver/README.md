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

## Runtime contract

- Embedded manifest exports:
  - `plugin_get_manifest_flatbuffer`
  - `plugin_get_manifest_flatbuffer_size`
- Command bridge export:
  - `plugin_invoke_stream`
- Browser shim export:
  - `wasm_invoke_json`
- Runtime targets:
  - `browser`
  - `wasi`
  - `wasmedge`

## Build

Native tests:

```bash
cmake -S src/cpp -B build
cmake --build build -j4
ctest --test-dir build --output-on-failure
```

Wasm build:

```bash
bash build.sh
```

Artifacts:

- `dist/maneuver_wasm.js`
- `dist/maneuver_wasm.wasm`

## Verification

SDK, browser, and WasmEdge harness:

```bash
node --test tests/sdk_compat.test.mjs
```

That test covers:

- SDK artifact compliance
- browser wrapper smoke via `dist/maneuver_wasm.js`
- WasmEdge command invoke smoke via `dist/maneuver_wasm.wasm`
- a hosted-runtime example contract check

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
