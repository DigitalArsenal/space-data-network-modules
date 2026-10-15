# Basilisk Runtime Module

This package is the seed for the Basilisk runtime SDN module family. It is not complete
yet: one method verifies the canonical `XTC` dictionary port path that the full
runtime will use for Basilisk telemetry and command metadata, and one runs a
simplified pointing and power scenario for the Sandcastle demo.

## Current Methods

- `echo_xtc_dictionary`: typed ports (`XTC.fbs` / `$XTC` / `XTC`, wire format
  `flatbuffer`). Accepts one SDS `$XTC` FlatBuffer on `dictionary`, refuses any
  frame that is not an `$XTC` (`invalid-dictionary`), and emits the same bytes
  on the `dictionary` output.
- `run_pointing_power_scenario`: typed ports (`PPS.fbs` / `$PPS` / `PPS`, the SDS
  Pointing and Power Scenario standard). Takes one `$PPS` carrying `SCENARIO` on
  `scenario` and emits one `$PPS` on `telemetry`: the scenario echoed with every
  default resolved, `STATUS` (Nominal, or Degraded when a stated battery floor or
  wheel capacity is violated; InvalidRequest without a `SCENARIO`), `PRODUCTS`,
  `ASSUMPTIONS` and `TELEMETRY`, column-major series parallel to `ELAPSED_S`
  (mode, pointing error, body rate, wheel momentum, sensor noise, relative
  position (3 per sample), illumination, generated / load / net power, battery
  state of charge and energy). A frame that is not a `$PPS` fails
  (`invalid-scenario`). The model is the simplified deterministic replay model
  documented in `src/module.cpp`, at most 256 samples. The Sandcastle
  `basilisk-pointing-power` demo calls it.

  Formerly hidden constants are scenario fields; left 0 they take the old values,
  and the answer's `SCENARIO` states the values used:
  `SOLAR_ARRAY.EFFICIENCY` 0.29, `BATTERY.CAPACITY_WH` 14,000 Wh (or
  `BUS_SPECIFICATION.BATTERY_CAPACITY` when given), `BUS_LOAD_W` 650 W base load
  (the load adds 18 W per N m s of wheel momentum and 0.7 W per arcsec of sensor
  noise), `SOLAR_ARRAY.SOLAR_CONSTANT_W_M2` 1361, `FINE_POINTING_THRESHOLD_DEG`
  0.5, battery charge / discharge efficiency 1. `BATTERY.INITIAL_STATE_OF_CHARGE`
  NaN (the schema default) is 0.72, no `SOLAR_ARRAY` is a 12 m^2 array,
  `DURATION_S` 0 is 600 s and `STEP_S` 0 is 60 s. Pointing segments, the initial
  `$ACM` attitude, the `$OEM` trajectory and the array normal are not modelled,
  and the nested `$ACM` / `$BUS` / `$OEM` tables are not echoed.

## Standards

- Invoke: `PIV` request/response through SDK command mode.
- Payload frame: `TAB`.
- Pointing and power scenario and telemetry: `PPS` with file identifier `$PPS`.
- Manifest: `PLG`.
- Telemetry and command dictionary data: `XTC` with file identifier `$XTC`.

## Authoritative Test Source

The upstream Basilisk WASM test runner is the current binding parity anchor.
On this stack branch, `node run_tests.js --quick` in
`repos/basilisk/tests/wasm` passes 1810/1810 checks after fixing the runner's
summary parser. Those checks prove the existing Basilisk WASM artifact exposes
runtime, messaging, simulation, sensor, environment, power, and FSW binding
surfaces.

This package's own tests are not enough to mark the runtime module complete.
Completion requires scenario step/reset/replay behavior through the SDN module
artifact, backed by upstream Basilisk numerical tests and explicit tolerances.

## Build

`build.mjs` inlines the generated SDS headers of `$PPS` and the standards it
includes (ACM, BUS, OEM and theirs, in include order) and compiles `src/module.cpp` with `space-data-module-sdk` 0.9.3
(`package.json` devDependency; link it at `node_modules/space-data-module-sdk`) (declared thread model `single-thread`) and signs the
artifact with the development module signing key, found in the stack's
`space-data-module-sdk` checkout or at `SDM_MODULE_SIGNING_KEYPAIR_PATH`.

```sh
export SPACE_DATA_STANDARDS_ROOT=<spacedatastandards checkout>
node build.mjs
node --test tests/*.test.mjs
```

The tests run on the browser harness and, when `wasmedge` is on `PATH`, on
WasmEdge (skipped otherwise). `tests/pointing_power.test.mjs` compares the typed
telemetry to the JSON-era artifact's on four scenarios
(`tests/fixtures/legacy-json-telemetry.json`); the old JSON printed 12
significant digits, and every value agrees at that precision.
