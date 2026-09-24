# @orbpro/plugin-hpop

OrbPro High-Precision Orbital Propagator (HPOP) Plugin.

Implements a high-fidelity numerical orbit propagator accounting for full geopotential models, atmospheric drag, solar radiation pressure, and third-body perturbations. Compiled to WebAssembly for high-performance, cross-platform use.

## Atmosphere models (honest labeling)

| Model name | Status |
| --- | --- |
| `NRLMSISE00` | **Full model.** The real NRLMSISE-00 (Picone/Hedin/Drob, JGR 2002) via the public-domain Brodowski C port vendored in `third_party/nrlmsise00/`. Drag uses the gtd7d "effective mass density" (includes anomalous oxygen). Verified against the canonical 17-case output table shipped with the reference package. |
| `USSA1976` | **Full lower-atmosphere model (0-86 km geometric).** US Standard Atmosphere 1976 with the proper geopotential-altitude layer formulation. Above 86 km it hands off to the Vallado exponential table (documented in code). |
| `Exponential` | Piecewise-exponential model, Vallado *Fundamentals of Astrodynamics and Applications* 4th ed., Table 8-4. |
| `JB2008` | **Simplified approximation only** — mimics the Jacchia-Bowman 2008 exospheric-temperature response to S10.7/M10.7/Y10.7 with a single-species barometric profile. NOT the published JB2008 coefficient model. |
| `DTM2020` | **Simplified approximation only** — mimics the DTM2020 F30/Hp temperature response. NOT the published DTM2020 spherical-harmonic model. |
| `HarrisPriester` | Harris-Priester diurnal-bulge table (100-1000 km), with the apex taken from the Sun direction; outside the table the model declines and drag is zero. Selectable as `forces.dragModel` `HARRIS_PRIESTER` and the PRW `HARRIS_PRIESTER` family. |
| `GOST2004` | Enum placeholder only; not implemented and not selectable. |

The typed PRW `ATMOSPHERE_REQUEST` operation exposes only the implemented models
(`NRLMSISE00`, `USSA1976`, `EXPONENTIAL`).

### Drag frame and inputs

The force set integrates GCRF. NRLMSISE-00 (and the JB2008/DTM2020 stand-ins)
need an Earth-fixed position, so drag rotates the GCRF position by GMST about
the GCRF z axis before the geodetic conversion. That fixes the longitude and
local solar time that place the diurnal bulge. Precession, nutation and polar
motion are not applied to this density lookup; together they move the pole by
well under a degree since J2000, below these models' horizontal resolution.
Relative velocity is `v - omega x r` in GCRF with the same axis.

Space-weather inputs follow the NRLMSISE-00 package definitions
(`third_party/nrlmsise00/nrlmsise-00.h`): `F107` is the **observed** flux (at
the Earth's distance, not adjusted to 1 AU) of the day before the epoch,
`F107a` the observed 81-day centered mean, and `Ap` the daily index. HPOP
evaluates NRLMSISE-00 with the daily Ap only (switch 9 = 1).

No validated horizontal wind model ships with HPOP. `includeWinds` is refused:
`plugin_set_drag_options` returns `HPOP_ERR_NOT_IMPLEMENTED` and leaves winds
off, and direct C++ drag calls with `includeWinds` throw
`std::invalid_argument`. The earlier deterministic tidal wind pattern was not a
physical model and has been removed.

## Installation

```bash
npm install @orbpro/plugin-hpop
```

This package is intended to be used within an OrbPro workspace or alongside the OrbPro engine. Standalone use requires the module SDK.

## Building

Build the canonical browser/WasmEdge artifact with the repo-local toolchain:

```bash
npm ci
PATH="$HOME/.wasmedge/bin:$PATH" node build.mjs
```

Artifacts:

- `dist/isomorphic/module.wasm`
- `dist/browser/module.js`
- `dist/browser/module.wasm`

## Portable PRW contract (SDS 1.220.0)

Every advertised method consumes size-prefixed `$PRW` records through the SDK
PIV/TAB invoke envelope. The module builds through `compileModuleFromSource` for
`wasm32-wasip1-threads`, `threadModel: "wasi-sequential"`: one resident instance
performs ordered catalog/cache mutations and one invocation at a time. The
artifact uses shared memory; browser hosts need cross-origin isolation.

| Method | Request arm | Response arm |
| --- | --- | --- |
| `invoke` | `EXECUTION_REQUEST`, `EPHEMERIS_REQUEST`, `ATMOSPHERE_REQUEST`, or `VERSION_QUERY` | Matching result arm |
| `ingest_state` | `RESIDENT_STATE` (1–1024 input records) | No scientific output |
| `propagate_state` | `RESIDENT_REQUEST` | `RESIDENT_STATE` |
| `prepare_trajectory_segments` | `PREPARE_REQUEST` | `PREPARE_RESULT` |
| `describe_trajectory_segments` | `DESCRIBE_REQUEST` | `DESCRIBE_RESULT` containing PPE |

Each PRW record must populate exactly one payload arm. A supplied `invoke.kernel`
contains `NATIVE_INPUT`, including the NCD descriptor and checked SPK bytes.
Public ports do not accept the historical JSON or private pointer envelopes.

### Resident states and handles

Use the SDK **direct** invoke surface with a persistent instance for resident
methods. The SDK command test harness creates an instance per invocation and
therefore does not retain a catalog between calls.

`ingest_state` atomically replaces the catalog. Every record supplies the same
`PRWInstance`: `MODULE_ID="com.orbpro.hpop"`, a nonempty host-assigned unique
`INSTANCE_ID`, and `GENERATION`. Reingest of a previously seen instance identity
requires a strictly larger generation. `ENTITY_HANDLE` values are supplied by
the caller and must be unique; output preserves handles, object IDs, and catalog
numbers. Handles are instance-scoped and must not be persisted as object identity.
The host must choose a new instance ID after replacing the actual WASM instance.
Configuration changes, diagnostic catalog replacement, and burn/cache-grid
mutations invalidate portable queries until a new generation is ingested.

PRW state position and velocity use SI metres and metres/second. Input must be
Cartesian FRM state with explicit ISO epoch, `UTC` or `TDB`, and a resolving RFM
coordinate-system name. Integration and cached polynomials use TDB; C++ converts
UTC internally. This profile accepts Earth-centered (NAIF 399) ICRF axes and
reports them as **GCRF**. Other origins and axes fail. Earth-fixed/TEME requests
fail with `eop-data-required` because the PRW invocation does not supply the
required authoritative Earth-orientation data. There is no silent frame fallback.

Resident per-object covariance, dynamical mass, gravity overrides, and drag/SRP
area-over-mass controls fail with `unsupported-configuration`; use the execution
request for supported rich dynamics. `VALID=false` is retained on ingest and
fails with `invalid-state` when selected for propagation or trajectory export.
Empty selection means all rows; duplicate and unknown handles fail explicitly.
`MAXIMUM_COUNT` limits the requested prefix while preserving its order.

### Trajectory export and continuation

The supported profiles are empty/default and `conjunction-screening`.
`CATALOG_HANDLE=0` selects the current resident catalog; other values fail.
The finite nonnegative preparation duration is limited to 2046 ten-minute cache
segments (1,227,600 seconds). Preparation reports complete interval coverage
separately from fit quality. Segment handles never wrap or reset on reingest.

PPE contains the original 13 coefficients per axis, explicit velocity arrays,
Chebyshev basis, midpoint and half-span, Earth GCRF, TDB epochs, and the existing
PPE km/km/s units. `PRWFitQuality.EVIDENCE_KIND=UNMEASURED`, with both bound
availability flags false. No zero-error certification is claimed. Published PPE
residual scalars have no availability flag: they are omitted and accompanied by
a comment directing consumers to PRW quality; their decoded default zero must
not be interpreted as a measurement.

Each resident batch chunk returns one state; each describe chunk returns one
whole source (never part of a coefficient vector), with `SOURCE_OFFSET` and
`FINAL_CHUNK`. A response with `YIELDED=true` and positive `BACKLOG_REMAINING`
requires resubmitting the same PRW request bytes to obtain the next chunk.
One ordered continuation is active per module instance; a different request
restarts selection. This conservative chunk size respects positive output caps
although SDK 0.8.18 does not expose a guest output-cap accessor.

## Usage

### Via SDN Plugin Delivery (ecies-decrypted bytes)

```javascript
import { createHPOPPropagator } from "@orbpro/plugin-hpop";

// wasmBytes are delivered pre-decrypted by the SDN plugin-delivery system
// (ecies-x25519-hkdf-sha256-aes-256-gcm)
const propagator = await createHPOPPropagator({ wasmBytes });
```

### Direct / Development

```javascript
import { createHPOPPropagator } from "@orbpro/plugin-hpop";

// Without wasmBytes, loads the canonical artifact from dist/isomorphic/module.wasm
const propagator = await createHPOPPropagator();
```

### Options

| Option | Type | Description |
|--------|------|-------------|
| `wasmBytes` | `Uint8Array` | Pre-decrypted WASM bytes from the SDN delivery system. |
| `recipientPrivateKey` | `string` | Optional SDK 0.8 recipient key override for encrypted module envelopes. |
| `lowMemory` | `boolean` | Use reduced memory configuration. |

## Verification

Run the full package suite:

```bash
npm test
```

That covers:

- SDK artifact compliance and harness loading in `tests/sdk_compat.test.mjs`
- PRW resident SI/UTC, handle invalidation, bounded chunks, and PPE quality in
  `tests/prw_resident.test.mjs`
- Tudat-derived propagation regressions in `tests/tudat_wasm_derived.test.mjs`
- Stored Tudat reference vectors in `tests/fixtures/tudat.reference.json`

The Tudat-derived cases are copied from:

- `testTwoBodyPropagation` and `testHighFidelityPropagation` in
  `https://github.com/DigitalArsenal/tudat-wasm/blob/c998d24001af69e60f07cc6a29ddf64c422dd9de/tests/wasm/test_propagation_node.cjs`

The local test preserves the same orbital scenarios and pass/fail thresholds,
adapted to this package's typed PRW command ABI and run through both the SDK browser
and WasmEdge harnesses. The checked-in fixture captures the sampled Tudat state
histories used by the package-local suite, so ordinary verification does not
need a live `../tudat-wasm` checkout.

## License

UNLICENSED — Proprietary. All rights reserved by DigitalArsenal.io, Inc.

## JPL kernel input (TMPL lane 01)

The `invoke` method accepts an optional `kernel` input with canonical type
`NCD.fbs` / `$NCD` / `NCD`. Its payload is the existing orbit-products container
format: `[u32le descriptor_length][$NCD FlatBuffer][SPK bytes]`. Set the
size-prefixed descriptor's `FORMAT` to `SPK_DAF` and `SOURCE_BYTE_LENGTH` to the
kernel byte count; an optional `SOURCE_SHA256` is verified. No kernel is embedded
in the module or opened through a guest filesystem. The module reads Chebyshev
coefficients directly from immutable input bytes, retaining the view only for
that invocation.

For body states, send this JSON on the existing `request` port:

```json
{"operation":"ephemeris","params":{"target":301,"center":399,"epochTDBJD":2461041.5}}
```

The response contains `position` in km, `velocity` in km/s, `frame` equal to
`ICRF/J2000`, and `ephemerisSource` equal to `JPL_SPK`. NAIF target/center IDs are
accepted, including the Sun (10), Moon (301), Earth (399), EMB (3), planetary
barycentres (1–9), and SSB (0). These are geometric states, with no light-time or
aberration correction. The descriptor does not prove a DE release; use the
pinned kernel hash for DE440 provenance rather than inferring a release from a
DAF header.

The same `kernel` port on `operation: "propagate"` selects kernel states for
Sun/Moon/planet third-body forces and SRP. `epochJD` and `targetJD` for this JSON
operation are **TDB Julian dates**, matching the numerical library's state
contract; `epochTimeScale` is reported as `TDB`. Planet flags include
`thirdBodyMercury`, `thirdBodyVenus`, `thirdBodyMars`, `thirdBodyJupiter`,
`thirdBodySaturn`, `thirdBodyUranus`, and `thirdBodyNeptune`.

Without a kernel, propagation explicitly reports `ephemerisSource:
"Analytical"`. The caller can also request `params.ephemerisSource:
"Analytical"` with a kernel present. An invalid kernel, missing body, unsupported
selected segment, or uncovered epoch returns a named failure. It never silently
substitutes analytic data. The existing resident catalogue/trajectory methods
retain their current input contracts; the optional kernel port is scoped to
`invoke`, avoiding reuse of cached trajectories across ephemeris providers.

For native library callers, `Ephemeris::loadEphemerisBuffer(bytes, size, source)`
attaches a borrowed view until `clearEphemerisBuffer()`. An optional DE430/440/441
source label is supplied by the caller; both `BodyState` and `EphemerisState`
report their source. `loadEphemerisFile` now returns false instead of claiming a
file was loaded and returning analytic results. Unsupported INPOP/EPM named
providers likewise return invalid states.

The pinned downloader, CSPICE/Horizons sources, validation tolerances, and 2026
analytic error comparison are documented in
[`docs/de440-validation.md`](../../docs/de440-validation.md). Invoke and parity
examples are in `tests/kernel_invoke.test.mjs` and `tests/kernel-parity.mjs`.

### Build status of this lane

The existing HPOP CMake/Emscripten build is retained for diagnostic validation;
`-ffast-math` was removed so malformed-input finite checks keep their meaning.
Migration to the SDK compiler is still required before claiming this HPOP
artifact meets the SDK build law. The current SDK accepts one translation unit
and generates its own invoke bridge, while HPOP uses multiple translation units
and a legacy native bridge/browser ABI. SDK compliance also rejects pre-existing
legacy request/response types with missing canonical file identifiers. This lane
does not invent replacements for those unratified contracts.

## Analytical state transition matrix (TMPL lane 03)

The existing `invoke` / `propagate` operation can integrate the Cartesian state
and its 6×6 state transition matrix (STM) as one 42-component system. The STM is
`∂x(target)/∂x(epochJD)`, in row-major order for `[x,y,z,vx,vy,vz]`.
All calculations execute in C++ WASM. Example request body:

```json
{
  "operation": "propagate",
  "params": {
    "epochJD": 2451545.0,
    "targetJD": 2451545.01,
    "position": [7000, 0, 0],
    "velocity": [0, 7.5, 1],
    "includeSTM": true,
    "STM_METHOD": "ANALYTIC",
    "DENSITY_GRADIENT": "FINITE_DIFFERENCE",
    "forces": {"gravityMode": "J2"},
    "integrator": {
      "method": "RKF78", "initialStep": 20, "minStep": 0.001,
      "maxStep": 60, "absTolerance": 1e-12, "relTolerance": 1e-12
    }
  }
}
```

- `includeSTM: true` requests `stm`. `STM_METHOD`, `covariance`,
  `sampleEpochsJD`, or `maneuvers` also request it. State-only requests retain
  their existing behavior. The default STM method is `ANALYTIC`;
  `FINITE_DIFFERENCE` retains central differences of twelve perturbed
  trajectories plus the nominal trajectory.
- The state uses GCRF km and km/s, epochs are JD TDB. The STM's position/position
  and velocity/velocity blocks are dimensionless, position/velocity is seconds,
  and velocity/position is inverse seconds. The existing gravity evaluator's
  coordinate conventions are unchanged; this does not add an Earth-fixed
  rotation to its tesseral harmonics.
- `covariance` is 36 row-major entries in the same Cartesian units. The returned
  covariance is `Phi * P0 * Phi^T`, with no added process noise.
- `sampleEpochsJD` returns `samples[]` containing position, velocity, `stm`, and
  optionally covariance. Every sample STM refers to the original `epochJD`.
  Samples are independently propagated from that epoch. The caller may pack
  these arrays into estimation's existing propagator-sample input; no new SDS
  schema or automatic estimation flow is introduced.
- `maneuvers` contains `{epochJD, deltaV: [dx,dy,dz], frame: "INERTIAL"|"RTN"}`;
  delta-v uses km/s. Integration stops at each burn. At a burn epoch the output
  is post-burn. Start-epoch burns are excluded, so supply an already post-burn
  initial state. Inertial jumps have identity Jacobians; RTN jumps differentiate
  the moving basis and left-multiply the cumulative STM. Backward propagation
  with scheduled impulses is explicitly unsupported.
- `DENSITY_GRADIENT` defaults to `NEGLECTED`. `FINITE_DIFFERENCE` differences only
  scalar density at ±1 m; drag velocity and co-rotation partials remain analytic.
  Ignoring density's gradient is a configurable linearization approximation,
  not a claim that density is spatially constant.
- Analytic integration supports RK4, RKF45 (the existing Cash–Karp pair), RKF78,
  RK78, and COWELL (Cash–Karp). Adaptive state and STM share stages, error
  tolerances, accepted steps and rejected steps. STM errors are scaled using
  `D^-1 Phi D` with initial position/velocity magnitudes. Unmet tolerance at
  `minStep` returns an error. RK4 remains fixed-step. The finite-difference
  invoke path additionally supports RKDP87 and BS; other result dispatchers
  are refused explicitly.
- `forces.gravityMode`: `POINT_MASS`, `J2`, `J2_J4`, `SPHERICAL_HARMONICS`, or
  `EGM2008`. Existing low-degree flags remain available; `higherZonals` controls
  the built-in J5/J6 pair. `maxDegree` and `maxOrder` select harmonic truncation.
  `forces.dragModel` accepts `NRLMSISE00`, `EXPONENTIAL`, `USSA1976`, or
  `HARRIS_PRIESTER`. Sun/Moon/planet positions use lane 01's scoped kernel port
  when supplied; missing kernels retain the explicitly reported Analytical
  fallback.

### Coverage and limits

The force Jacobian uses forward analytical chain-rule differentiation, with no
whole-force differencing in `ANALYTIC` mode. It includes point mass, J2–J6,
inline spherical harmonics/custom fields, full loaded and embedded EGM
Cunningham/Pines recursion, nine third-body point masses, atmospheric drag,
cannonball SRP and its conical shadow, relativistic terms and supported
registered contributions. There is **no additional STM harmonic truncation**;
the existing embedded EGM field remains degree 70. Loaded-field degree 80 is
also covered by a Jacobian regression.

The following existing force semantics are preserved: cannonball SRP always
selects the existing conical/linear-penumbra function; EGM low-degree coefficient
gates are not applied by its force evaluator; and the loaded/EGM recursion has
an existing low-order column-coverage defect (for example, order zero omits
required x/y zonal recurrence terms). These are force-model limitations, not
additional derivative truncations. Piecewise shadow/density boundaries use the
selected branch derivative; a discontinuous threshold has no classical
Jacobian at the boundary. Inline tesseral gravity refuses its exact polar
coordinate singularity.

The six-state analytic STM explicitly refuses albedo, thermal reradiation,
tides, empirical accelerations, the legacy fixed-mass finite-thrust force,
non-cannonball SRP and atmosphere winds. Select the finite-difference path for
those legacy forces. Mass-aware finite burns use the seven-state path below.
Cd/Cr are configurable force inputs;
there is no existing parameter-sensitivity matrix plumbing, and this lane does
not add Cd/Cr sensitivity columns.

The legacy working-state exports `plugin_compute_stm` and
`plugin_propagate_covariance` now default to analytic propagation.
`plugin_set_stm_method(method, densityGradient)` selects 0=analytic/neglected,
1=finite-difference for each respective argument. These working-state methods
have no entity burn list; scheduled burn STM jumps are on the invoke surface.

**SDK acceptance remains blocked by pre-existing legacy manifest identities.**
The committed artifact is a diagnostic build using the existing local-emSDK
CMake path. It does not meet the SDK-build/publication gate. See the lane 03
handoff for the exact preflight, compliance and tri-runtime results.

## Finite burns with propagated mass (TMPL lane 04)

The existing JSON `invoke` / `propagate` operation accepts `finiteBurns` and
integrates `[x,y,z,vx,vy,vz,massKg]`, its 7×7 STM, and per-burn accumulated
delta-v and propellant in C++ WASM. This extends the legacy request control
surface; it introduces no SDS schema or resident-state burn contract.

```json
{
  "operation": "propagate",
  "params": {
    "epochJD": 2451545.0,
    "targetJD": 2451545.01,
    "position": [7000, 0, 0],
    "velocity": [0, 7.546053290107542, 0],
    "massKg": 1000,
    "STM_METHOD": "ANALYTIC",
    "forces": {"gravityMode": "POINT_MASS", "j2": false},
    "integrator": {
      "method": "RKF78", "initialStep": 10, "minStep": 0.0001,
      "maxStep": 30, "absTolerance": 1e-11, "relTolerance": 1e-11
    },
    "finiteBurns": [{
      "startSeconds": 60,
      "stopSeconds": 360,
      "thrustNewtons": 20,
      "ispSeconds": 300,
      "frame": "VELOCITY",
      "throttle": [
        {"seconds": 60, "throttle": 1},
        {"seconds": 180, "throttle": 0.5}
      ]
    }]
  }
}
```

### Burn controls

- Supply at most 16 burns. Each requires exactly one positive `thrustNewtons`
  (N) or `accelerationKmS2` (km/s²), and positive `ispSeconds` (s). Throttle
  multiplies that magnitude. Thrust mode applies `a = T/(1000 m)` in km/s²
  and `dm/dt = -T/(Isp g0)` in kg/s, with standard gravity `g0 = 9.80665 m/s²`.
  Acceleration mode varies thrust with the current mass to maintain the chosen
  acceleration, so its mass decays exponentially at constant throttle.
- Initial mass uses top-level `massKg`, otherwise the existing `forces.massKg`
  / `forces.mass` or `spacecraft.massKg` / `spacecraft.mass` selection, default
  1000 kg. Mass must remain positive. Drag and cannonball SRP use the current
  propagated mass as well.
- `startSeconds` and `stopSeconds` are offsets from the original `epochJD`.
  Alternatively, use `startJD` / `stopJD` (`startEpochJD` / `stopEpochJD` aliases)
  in **JD TDB**. Specify only one time representation for each edge. Scheduled
  windows require `0 <= startSeconds < stopSeconds`; overlapping burns add
  their accelerations and mass flows. Propagation is forward only.
- `frame` defaults to `INERTIAL`. `direction` defaults to `[1,0,0]` and is
  normalized. The supported bases are:

  | Frame | Components of `direction` |
  | --- | --- |
  | `INERTIAL` | Fixed GCRF Cartesian axes. |
  | `RTN`, `LVLH` | Radial `r/|r|`, transverse `N×R`, normal `(r×v)/|r×v|`. `LVLH` is explicitly an RTN alias here. |
  | `VNC` | Velocity `v/|v|`, normal `(r×v)/|r×v|`, co-normal `V×N`. |
  | `VELOCITY` | Along instantaneous velocity. No `direction` or `steeringRate` field. |
  | `ANTI_VELOCITY` | Opposite instantaneous velocity. No `direction` or `steeringRate` field. |

- Optional `steeringRate: [dx,dy,dz]` has units s⁻¹ for a dimensionless
  `direction`: the selected-frame vector is
  `normalize(direction + steeringRate * secondsFromEpochJD)`. Its clock stays
  anchored to the original epoch for event starts and intermediate samples.
  Steered vectors that cross zero and singular orbital bases return errors.
- Optional `throttle` is a zero-order-hold table of `{seconds, throttle}`.
  Times are nonnegative, strictly increasing offsets from the original epoch,
  and throttle lies in `[0,1]`. Throttle is 1 before the first entry, and the
  last value remains in effect afterward. A value of 0 provides a duty-cycle
  coast interval. Every scheduled start, stop, impulse, and throttle change
  forces an integrator step boundary, including edges shorter than `minStep`.

### Event starts and stops

Use `startEvent` or `stopEvent` with
`{"kind":"MASS","goal":999,"direction":-1}`, for example, to stop as mass
decreases through 999 kg. Supported event kinds and goal units are `RADIUS`
(km), `SPEED` (km/s), `RADIAL_VELOCITY` (km/s), `NODE` (GCRF z in km), and
`MASS` (kg). `direction` is -1 for decreasing, 0 for either direction (default),
and +1 for increasing. A root at the initial search state is excluded.

When an event is supplied, its scheduled start and stop times bound the search
window. Omitted start time defaults to the original epoch only with
`startEvent`; omitted stop time defaults to `targetJD` only with `stopEvent`.
A stop time always shuts off the burn even if its stop event has not occurred.
A start event that never crosses inside the window leaves the burn unstarted.
The core reuses `propagator/events` stopping functions and Brent root refinement
at a 1 ns time tolerance; it integrates to each located edge before changing
the force. Events require a sign-changing root within an accepted step:
choose `maxStep` shorter than the separation between crossings. Tangencies
and multiple crossings inside one step are not guaranteed to be found.

### Results and STM

`finiteBurns` requests the coupled analytic STM even when `includeSTM` is
omitted. `STM_METHOD: "FINITE_DIFFERENCE"` is rejected for finite burns.
Supported integrators are RK4, RKF45, RKF78, RK78, and COWELL; adaptive methods
share stage evaluations and error control across state, mass, STM, and burn
integrals. Finite-burn RKF78/RK78 also compare a full step with two half steps:
their inherited embedded estimate can vanish for purely time-dependent
thrust even when quadrature error remains. RK4 uses its requested fixed step.
Existing `DENSITY_GRADIENT` choices remain available.

- `massKg` is the final mass. `stm7` contains 49 row-major entries for
  `[x,y,z,vx,vy,vz,massKg]`; its entries carry output-variable units divided by
  input-variable units. `stm` retains the upper-left 6×6 block for Cartesian
  perturbations with known initial mass.
- `covariance` retains the existing 36-entry Cartesian covariance contract,
  treating initial mass as exact. Optional `covariance7` accepts 49 row-major
  entries including mass variance and cross-covariances, and returns
  `Phi7 * P0 * Phi7^T`. Both inputs can be supplied independently. No process
  noise is added. Supply `finiteBurns: []` for seven-state coasting propagation.
- `burnSummary` preserves input burn order and reports `index`, `deltaVKmS`
  (the accumulated integral of that burn's acceleration magnitude),
  `propellantKg`, `started`, `stopped`, and actual `startSeconds` / `stopSeconds`
  and `startEpochJD` / `stopEpochJD`. Times are null until the corresponding
  transition occurs. `startByEvent` / `stopByEvent` distinguish located events
  from scheduled edges, including a stop at the end of an event search window.
  Delta-v is the thrust integral, not the final velocity
  difference, which also includes gravity and other forces.
- Each entry in `samples` includes the same mass, STM, covariance, and burn
  summary fields. Samples are independently integrated from `epochJD`; all
  STMs, propellant totals, and delta-v totals are cumulative from that epoch.
- The analytic derivatives include thrust's inverse-mass dependence, normalized
  steering, moving RTN/VNC/velocity bases, acceleration-mode mass flow, and the
  mass dependence of drag/SRP. Event transitions apply saltation matrices to
  account for a perturbation changing the crossing time. A grazing event,
  whose crossing-time derivative is singular, fails explicitly if detected.
  Simultaneous state-triggered edges are rejected because their ordering is
  ambiguous. A located event within 1 ns of a scheduled start, stop, throttle
  change, impulse, or requested output epoch is also rejected: perturbations
  can change the transition order, so a unique classical STM is not assured
  there. Request a sample after the event to obtain its cumulative STM.
  Existing `maneuvers` can be combined with finite burns; the impulse STM jump extends
  to 7×7 and leaves mass unchanged.

This lane retains the diagnostic build and existing SDK manifest limitations
described above; the new controls do not change the SDK acceptance status.
