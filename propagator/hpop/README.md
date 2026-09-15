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
| `GOST2004` / `HarrisPriester` | Enum placeholders; dispatch falls through to `NRLMSISE00`. |

The JSON `atmosphere` operation exposes only the honestly-implemented models
(`NRLMSISE00`, `USSA1976`, `EXPONENTIAL`).

## Installation

```bash
npm install @orbpro/plugin-hpop
```

This package is intended to be used within an OrbPro workspace or alongside the OrbPro engine. Standalone use requires the module SDK.

## Building

Build the canonical browser/WasmEdge artifact with the repo-local toolchain:

```bash
bash build.sh
```

Artifacts:

- `dist/isomorphic/module.wasm`
- `dist/browser/module.js`
- `dist/browser/module.wasm`

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
- Resident-state binary stream method declarations in `tests/sdk_compat.test.mjs`
- Inter-module aligned-binary `PropagatorState` handoff from SGP4 to HPOP in
  `tests/intermodule_sgp4_import.test.mjs`
- Tudat-derived propagation regressions in `tests/tudat_wasm_derived.test.mjs`
- Stored Tudat reference vectors in `tests/fixtures/tudat.reference.json`

The Tudat-derived cases are copied from:

- `testTwoBodyPropagation` and `testHighFidelityPropagation` in
  `https://github.com/DigitalArsenal/tudat-wasm/blob/c998d24001af69e60f07cc6a29ddf64c422dd9de/tests/wasm/test_propagation_node.cjs`

The local test preserves the same orbital scenarios and pass/fail thresholds,
adapted to this package's JSON command ABI and run through both the SDK browser
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

Analytic STM explicitly refuses albedo, thermal reradiation, tides, empirical
accelerations, finite thrust, non-cannonball SRP and atmosphere winds. Select the
finite-difference path for those forces. Cd/Cr are configurable force inputs;
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
