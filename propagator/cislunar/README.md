# Cislunar Propagation Plugin

Circular restricted three-body problem (CR3BP) solutions on the SDS Three-Body Problem standard (`$TBP`,
spacedatastandards.org `schema/TBP/main.fbs`). Typed contracts 1.0: FlatBuffers only, no JSON.

## Contract

One method, `invoke`:

| port | type | carries |
| --- | --- | --- |
| `request` (in, 1 frame) | `$TBP` (`TBP.fbs`, root `TBP`) | `PROBLEM`, `SYSTEM` and the request fields of that problem |
| `response` (out, 1 frame) | `$TBP` | the same `PROBLEM`, `SYSTEM`, `ID`; `PRODUCER` `cislunar-propagator`; `STATUS`; the answer |

`SYSTEM` is required: `MASS_RATIO` in (0, 0.5]; `CHARACTERISTIC_LENGTH_KM` and `CHARACTERISTIC_TIME_S` where a
problem needs dimensions (periods in seconds, NRHO, transfers, frame conversion); primary masses for transfers.
`SYNODIC_FRAME` is not echoed.

| `PROBLEM` | request | answer |
| --- | --- | --- |
| `Propagation` | `PROPAGATION` {`INITIAL_STATE`, `DURATION`, `STEP` (0 = 0.001), `OUTPUT_POINTS` (0 = 1000), `STATE_TRANSITION`} | `TRAJECTORY` {`TIMES`, `STATES`, `STATE_TRANSITION` (36 per sample) when asked, `JACOBI`} |
| `LibrationPoints` | - | `LIBRATION_POINTS` L1..L5: position, Jacobi constant, eigenvalues of the linearised dynamics, `STABLE` (collinear: never; L4/L5: mass ratio below Routh's 0.03852) |
| `JacobiConstant` | `STATE` | `STATE`, `JACOBI` |
| `PeriodicOrbit` | `ORBITS[0]` {`FAMILY` HaloNorthern / HaloSouthern (Unspecified = HaloNorthern), `LIBRATION_POINT` L1 / L2 (UNSPECIFIED = L2), `AMPLITUDE` (Az), `TOLERANCE` (0 = 1e-12), `MAX_ITERATIONS` (0 = 100)} | `ORBITS[0]` differentially corrected: `INITIAL_STATE`, `PERIOD`, `PERIOD_S`, `JACOBI`, `CONVERGED`, `ITERATIONS`, `MONODROMY` (one full period), `FLOQUET_REAL` / `FLOQUET_IMAGINARY`, `STABILITY_INDEX`, `STABLE`, `TRAJECTORY` (one period) |
| `HaloFirstGuess` | `ORBITS[0]` {`FAMILY`, `LIBRATION_POINT`, `AMPLITUDE`} | `ORBITS[0]` {`INITIAL_STATE`, `CORRECTED` false} (Richardson third order) |
| `NearRectilinearHalo` | `ORBITS[0]` {`LIBRATION_POINT`, `PERILUNE_ALTITUDE_KM` (0 = 3500), `APOLUNE_ALTITUDE_KM` (0 = 70000), `TOLERANCE`, `MAX_ITERATIONS`} | as `PeriodicOrbit`, `FAMILY` NearRectilinearHalo |
| `Transfer` | `TRANSFER` {`KIND` LowEnergy (Unspecified = LowEnergy) / FreeReturn / PeriodicOrbitInsertion (`TARGET_ORBIT.INITIAL_STATE`), `PARKING_ALTITUDE_KM`, `TARGET_ALTITUDE_KM`, `INCLINATION_DEG`} | `TRANSFER` {`CONVERGED`, `BURNS` "departure" and "arrival" (`$MPL` burns, Inertial axes, km/s, `OFFSET_S`), `TOTAL_DELTA_V_KM_S`, `TIME_OF_FLIGHT_S`} |
| `StationKeeping` | `STATION_KEEPING` {`ORBIT` {`INITIAL_STATE`, `PERIOD`, `JACOBI`, `MONODROMY` optional}, `NAVIGATION_ERROR_KM`, `EXECUTION_ERROR_FRACTION`, `CYCLES` (0 = 12)} | the budget: `ANNUAL_DELTA_V_KM_S`, `MEAN_` / `MAX_CYCLE_DELTA_V_KM_S`, `CYCLE_DELTA_V_KM_S`, `BOUNDED` |
| `FrameConversion` | `FRAME_CONVERSION` {`DIRECTION`, `ELAPSED_S`, `SYNODIC` or `INERTIAL` (km, km/s)} | the other state |

Libration points are `rfmLibrationPoint` (L1 = 1). A request the module cannot answer (no `SYSTEM`, the `Family`
problem, a non-halo family, a transfer kind it does not build) is answered in band with `STATUS` InvalidRequest and
`ERROR_CODE` / `ERROR_MESSAGE`; a frame that is not a verifiable `$TBP` fails the invoke. Module identity and version
are in the embedded manifest (`$PLG`).

## Build and test

```bash
export SPACE_DATA_STANDARDS_ROOT=/path/to/spacedatastandards.org
mkdir -p node_modules && ln -sfn /path/to/space-data-module-sdk node_modules/space-data-module-sdk
node build.mjs          # dist/isomorphic/module.wasm + dist/guest-link/
node --test tests/*.test.mjs
```

`build.mjs` inlines the generated SDS headers ($TBP and every standard it includes, in include order) and the CR3BP
core (`src/cpp/include/cislunar/*.h`, `src/cpp/src/cr3bp.cpp`) ahead of `src/cpp/src/tbp_module.cpp`. The core's
native C++ tests still build with `cmake -S src/cpp -B build && cmake --build build && ctest --test-dir build`.

`tests/legacy_parity.test.mjs` compares the typed answers to the JSON-era module's (0.1.0) answers on the same inputs
(`tests/fixtures/legacy-json-outputs.json`). The legacy artifact was built with `-ffast-math -flto` by emsdk 6.0.1;
the SDK compiler builds the same core strictly, so values agree to within 4e-12 relative rather than to the bit.
