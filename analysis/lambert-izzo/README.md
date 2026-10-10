# Izzo Lambert Solver SDN Module

This package is the SDN module home for Izzo's revisited Lambert solver.

## Upstream

- Source: `sakobu/izzos-lambert`
- Pinned version: `v2.0.0`
- Pinned commit: `65b561b745a0f1afe6a2d73f46f70a3a382e67aa`
- Implementation strategy: the reviewed Izzo equations are shipped as the
  header-only `include/lambert_izzo/solver.hpp`. This module,
  `analysis/maneuver` and `analysis/gp-error-model` compile that one kernel;
  no nested upstream submodule is added. `solve` keeps the 32-revolution cap;
  `solve_revolutions(request, N)` gives both branches for exactly N
  revolutions without it (gp-error-model's multi-day Lambert arcs).
- License: `MIT OR Apache-2.0`; preserve the upstream notice and license text
  when publishing an SDN artifact.

The upstream `lambert_izzo_wasm` wasm-pack adapter is reference material only.
The SDN deliverable must be a Space Data Module SDK artifact with embedded
manifest exports and a shared `dist/isomorphic/module.wasm` that loads in both
browser and WasmEdge.

Do not add a nested upstream submodule.

## API

The primary method is `solve_lambert`.

Input request fields:

- `r1`: initial position vector, km.
- `r2`: final position vector, km.
- `tof`: time of flight, seconds.
- `mu`: central-body gravitational parameter, km^3/s^2.
- `way`: `short` or `long`.
- `maxRevs`: `null`/absent for single-revolution only, otherwise `1..=32`.
- `referenceFrame`: inertial frame label such as `GCRF`, `EME2000`, or `ICRF`.
- `epoch`: optional epoch/time-scale label carried for provenance. The solver
  is time-of-flight based and does not use epoch internally.

Output result fields:

- `single`: departure and arrival velocities for the single-revolution branch,
  in km/s and in the same inertial frame as `r1`/`r2`.
- `multi`: zero or more multi-revolution branch pairs, each with revolution
  count, long-period solution, and short-period solution.
- `diagnostics`: Householder iteration counts aligned with every returned
  branch.
- `error`: structured failure when validation or solving fails.

## Standards Status

`STV` covers a state vector. The Lambert-specific request/result data uses the
SDS-first records below rather than repo-local `.fbs` files in this package.

SDS identifiers:

- `$LMS`: `LMS.fbs` Lambert solve request.
- `$LMO`: `LMO.fbs` Lambert solve output.

## Verification

- The functional suite executes short- and long-way circular cases, typed
  refusals, and both branches of the upstream multi-revolution example.
- A 72-geometry transfer-angle/time-of-flight sweep compares the standalone
  module with the maneuver public surface to `1e-9` relative velocity.
- SDK checks cover manifest round-trip, artifact compliance, the browser
  harness, and WasmEdge when the pinned runtime is available.

## Current Verification Data

- Closed-form circular quarter-orbit benchmark: `r1 = [7000, 0, 0] km`,
  `r2 = [0, 7000, 0] km`, `mu = 398600.4418 km^3/s^2`, and
  `tof = pi/2 * sqrt(7000^3 / mu) s`. This is also the primary
  `lambert_izzo` `v2.0.0` README example. The expected departure velocity is
  `[0, sqrt(mu / 7000), 0] km/s` and the expected arrival velocity is
  `[-sqrt(mu / 7000), 0, 0] km/s`. The SDK compatibility test uses an absolute
  component tolerance of `1e-6 km/s`, which is several orders above double
  roundoff but far below operational Lambert transfer tolerances.

## Lambert grid search (`grid_search`)

`grid_search` evaluates a departure-by-arrival epoch mesh over two externally
sampled ephemerides. For each positive-TOF cell it checks all feasible branches
from zero through `maxRevolutions`, in each requested direction, and minimizes
`norm(v_transfer_departure - v_departure) + norm(v_arrival - v_transfer_arrival)`.
The `best` port identifies the smallest total delta-V over the mesh. A numerical
failure in a requested direction makes the cell unresolved rather than claiming
that the other direction is the minimum.

This belongs alongside `solve_lambert`: it reuses the same C++ kernel, has no
propagator dependency, and adds no host capabilities. Hosts may sample with any
propagator and partition departure ranges across module instances. All physics
runs in C++ WASM. `grid-codec.js` only packs and unpacks SDS bytes.

### Standard and units

The request, every mesh row, and the best-cell result are canonical **`PCE.fbs`
/ `$PCE`** records in the SDK's existing PIV/TAB invoke stream. PCE explicitly
supports `PROVIDER_DEFINED` parameter names, numeric vectors and matrices. The
names below define this provider's parameter vocabulary; they do not create a
new SDS schema or file identifier. PCE uses **SI units**, unlike the original
LMS/LMO solve method's km and km/s. No aligned-binary fallback is needed.

The input contains `EVALUATION_REQUEST.CONTEXT` with:

- `GRAVITATIONAL_PARAMETER`: central-body mu in m³/s².
- `DEFAULT_COORDINATE_SYSTEM_NAME`: the common inertial frame, e.g. GCRF,
  EME2000 or ECLIPJ2000. Both ephemerides must already share this frame and center.
- `DEFAULT_TIME_SYSTEM`: TT, TDB or TAI; epochs are elapsed SI seconds on this
  continuous scale, never civil UTC seconds across a leap second.
- `REFERENCE_EPOCH`: ISO epoch defining zero of all epoch offsets.
- Optional `EVALUATION_REQUEST.TRACE_ID`: copied to each result.

`EVALUATION_RESULT` has status OK and one `PCEParameterSample`. It carries exactly
these 13 `PCEParameterValue` entries, all `PARAMETER=PROVIDER_DEFINED`, status OK:

| Provider-defined name | Payload | PCE unit |
| --- | --- | --- |
| `departure_epochs`, `arrival_epochs` | `VALUES`: strictly increasing N-element vectors | SECOND |
| `departure_positions`, `arrival_positions` | `VALUES`: row-major N×3; `ROW_COUNT=N`, `COLUMN_COUNT=3` | METRE |
| `departure_velocities`, `arrival_velocities` | row-major N×3, same shape | METRE_PER_SECOND |
| `departure_start`, `departure_end` | scalar `VALUE` | SECOND |
| `arrival_start`, `arrival_end` | scalar `VALUE` | SECOND |
| `grid_step` | positive scalar `VALUE`, shared by both axes | SECOND |
| `max_revolutions` | integer `VALUE`, 0..32 | DIMENSIONLESS |
| `direction_flags` | integer `VALUE`: 1 prograde, 2 retrograde, 3 both | DIMENSIONLESS |

Epochs are `start + i*grid_step` through the last epoch not beyond `end`. Each
must match a supplied sample (only floating-point epoch roundoff is tolerated).
The module does **no interpolation**. Resample with the chosen propagator when
changing resolution. Arrays and each grid axis are limited to 400 entries;
input payloads are capped at 256 KiB. Empty arrays, duplicate/unsorted epochs,
nonfinite states, inconsistent shapes/units, missing samples and invalid
controls fail the entire request with `invalid-grid-request` and no outputs.

### Output stream

The `mesh` port returns one PCE frame per departure row, in increasing departure
order. SDK sequence numbers are 0..Ndeparture−1 with end-of-stream on the last
row. Each PCE result contains one sample: its EPOCH/EPOCH_TIME_SYSTEM specify
the epoch origin and scale of the vector-valued grid result. `TRACE_ID` is
preserved. The sample's provider-defined values are:

| Name | Shape / meaning | Unit |
| --- | --- | --- |
| `departure_index` | scalar, zero-based row | dimensionless |
| `departure_epoch`, `arrival_epoch`, `tof` | Narrival-element vectors | s |
| `departure_dv`, `arrival_dv`, `total_dv` | Narrival-element vectors | m/s |
| `departure_c3` | departure_dv squared, for the selected branch | m²/s² |
| `status` | 0 solved; 1 nonpositive TOF; 2 undefined plane; 3 no convergence | dimensionless |
| `revolutions` | selected revolution count, −1 if unsolved | dimensionless |
| `branch` | 0 single; 1 multi left; 2 multi right | dimensionless |
| `direction` | +1 prograde; −1 retrograde; 0 if unsolved | dimensionless |
| `transfer_departure_velocity`, `transfer_arrival_velocity` | Narrival×3 matrices in the input frame | m/s |
| `reference_frame` | `STRING_VALUE`: the input frame label | — |

Branch numbers match the existing LMO enum (`SINGLE`, `MULTI_LONG_PERIOD`,
`MULTI_SHORT_PERIOD`); left/right refer to the Izzo x roots. Direction is defined
by the sign of angular momentum's **z** component in the supplied frame. Polar
planes (|h_z| ≤ 1e−14 |h|) and same-ray collinear endpoints are unresolved. For
exactly antipodal endpoints, departure orbital angular momentum supplies the
plane, with arrival angular momentum as fallback. This supports exact Hohmann
cells without perturbing the endpoints. The original `solve_lambert` method
continues to refuse collinear LMS requests.

Unsolved cells retain their epochs and TOF, have infinite delta-V/C3, and NaN
transfer velocities. Read `status` before plotting. The `best` port returns one
PCE with the same fields as a length-one row plus scalar `arrival_index`. If no
cell solves, both indices are −1 and the vectors are empty. Equal computed costs
retain the earliest cell; within a cell the order is prograde, retrograde, then
zero revolutions and ascending revolution number with left before right.

The kernel retains only input/index arrays, one row, and at most 32 branch pairs:
O(Ndeparture + Narrival + maxRevolutions) working memory. The SDK collects output
frames for one invoke, so total transport memory is O(Ndeparture×Narrival),
hard-bounded by the 400×400 cap. The maximum-grid test produces 22,138,712 payload
bytes (<24 MiB), not an unbounded candidate list. Host-side chunking of departure
ranges can reduce the per-invoke transport allocation further.

`departure_c3` is useful for interplanetary plots. It is **not a separate C3
optimization**: each cell and the best-cell reduction optimize total endpoint
ΔV. For Earth-orbit transfers the endpoint costs are impulses; for heliocentric
planet-state inputs they are v-infinity magnitudes, without parking-orbit
escape/capture, B-plane targeting, perturbations, collision/central-body
clearance, or finite-burn modeling.

### OrbPro MANEUVER usage (host orchestration only)

```js
import { loadModule } from 'space-data-module-sdk/host/isomorphic';
import { encodeGridRequest, decodeGridRecord, isomorphicWasmPath } from
  'space-data-network-plugin-lambert-izzo';

// Obtain sampled states from the console's selected WASM propagator or
// ephemeris provider. Arrays are SI; every requested grid epoch is present.
const module = await loadModule({
  wasmSource: isomorphicWasmPath,
  runtimeKind: 'browser',
});
try {
  const response = await module.invoke(encodeGridRequest({
    departure: departureSamples, // {epochs, positions: N×3, velocities: N×3}
    arrival: arrivalSamples,
    departureStart, departureEnd, arrivalStart, arrivalEnd,
    step: 60, mu: 3.986004418e14,
    maxRevolutions: 3, prograde: true, retrograde: false,
    referenceFrame: 'GCRF', timeScale: 'TT',
    epochOrigin: '2000-01-01T12:00:00', requestId: 'maneuver-transfer-17',
  }));
  if (response.statusCode !== 0) throw new Error(response.errorMessage);
  for (const frame of response.outputs) {
    const record = decodeGridRecord(frame.payload);
    // Existing MANEUVER view consumes mesh rows and highlights best indices.
    if (frame.portId === 'mesh') maneuverView.acceptMeshRow(record);
    else if (frame.portId === 'best') maneuverView.selectBestCell(record);
  }
} finally {
  await module.destroy();
}
```

No console UI is included in this lane. The existing `wasi-sequential` build
requires cross-origin isolation for browser shared memory. Native WasmEdge
must enable its threads proposal even though this guest spawns no threads.

### Authoritative numerical evidence

See [tests/grid.test.mjs](tests/grid.test.mjs), [fixtures](tests/grid-fixtures.mjs)
and [verification report](tests/VERIFICATION.md). Fixtures are independent
closed-form physics or existing ERFA analytics, never outputs of the new solver.

1. **Hohmann:** Vallado 2007, p.327, Algorithm 36, Example 6-1, via the
   [author's companion routine](https://github.com/CelesTrak/fundamentals-of-astrodynamics/blob/main/software/matlab/hohmann.m).
   r1=6678.137 km, r2=42164 km, mu=398600.4418 km³/s²; coplanar GCRF,
   seconds from J2000 TT. Independent vis-viva gives **3.892554386890898 km/s**.
   A 240 s grid differs by 46.9191 m/s; refinement to 60 s reaches an aligned
   Hohmann cell, error 4.1e−12 m/s, against a 0.02 m/s tolerance. The brief's
   **3.935 km/s is not the 300 km case** (it approximates a 200 km LEO case).
2. **Earth–Mars 2005:** [JPL MRO navigation paper, ISSFD 2007](https://issfd.org/ISSFD_2007/3-4.pdf),
   Table 6 gives rounded launch target C3=16 km²/s²; launch is 2005-08-12 and
   encounter 2006-03-10 (Table 10). The daily grid covers 2005-07-01..09-01
   departures and 2006-02-01..04-30 arrivals. At the corresponding midnight TDB
   grid cell, C3=16.3229438633 km²/s² (error +0.3229438633). Tolerance 1 km²/s²
   accounts for the rounded mission target, daily sampling versus actual UTC
   times, center-target versus B-plane, and analytic ephemeris approximation.
   The C3 minimum is 15.8341252955 km²/s² on **2005-08-10 / 2006-02-22**;
   the brief's early-August/March minimum is only approximate. Its loose
   window check uses ±0.5 km²/s², ±15 departure days, ±30 arrival days.
   Total-ΔV best is 6.8004551441 km/s on 2005-08-19 / 2006-03-22.
   Inputs use existing `higherpop/third_party/erfa/epv00.c` for Earth and
   `plan94.c` for Mars, heliocentric J2000 equatorial, TDB. Plan94's published
   [accuracy notes](https://github.com/liberfa/erfa/blob/master/src/plan94.c)
   give Mars velocity RMS ≈1.98 m/s against DE200. This is mission-design
   validation, not a DE ephemeris or navigation-grade reproduction.
3. **Multi-revolution branches:** [Izzo, Revisiting Lambert's Problem](https://arxiv.org/pdf/1403.2705),
   Eqs.18–19, λ=0, M=1, T=3π/2. The left root x=0 is analytic; the right
   x=0.28492937285072095 is independently bracketed from Eq.18 in test code.
   r1=[7000,0,0] km, r2=[−7000,0,0] km; μ as above, GCRF, TT, TOF=1.5 circular
   periods. Endpoint velocities from these conics give zero maneuver cost.
   Both branches are selected correctly from a maxRevolutions=3 search;
   errors are 1.04e−12 and 1.42e−11 m/s, tolerance 1e−6 m/s. These are numerical
   specializations of the paper's published equations, not a claimed table of
   Cartesian example values (the paper supplies no such table).

### Build and verification

```sh
npm ci
npm run build
npm test
npm run check:compliance
node --test tests/sdk_compat.test.mjs
npm run test:parity -- --wasmedge-binary /path/to/wasmedge --timeout-sec 60 --json
```

Build uses `compileModuleFromSource` with `wasi-sequential`, SDK 0.8.15 and SDS
1.217.0. Optional `SPACE_DATA_STANDARDS_ROOT` selects another installed SDS root.
The checked-in `dist/isomorphic/module.wasm` is the artifact used by every lane.
To regenerate the planetary input fixture from the repository root:

```sh
cc -O2 -I higherpop/third_party/erfa analysis/lambert-izzo/tests/planet-states.c \
  higherpop/third_party/erfa/epv00.c higherpop/third_party/erfa/plan94.c \
  higherpop/third_party/erfa/anpm.c -lm -o /tmp/lambert-planet-states
/tmp/lambert-planet-states > analysis/lambert-izzo/tests/fixtures/earth-mars-2005.json
```
