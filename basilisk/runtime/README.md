# Basilisk Runtime Module

This package is the seed for the Basilisk runtime SDN module family. It is not complete
yet: one method verifies the canonical `XTC` dictionary port path that the full
runtime will use for Basilisk telemetry and command metadata, and one runs a
simplified pointing and power scenario for the Sandcastle demo.

## Current Methods

- `echo_xtc_dictionary`: accepts an SDS `XTC` FlatBuffer payload on the
  `dictionary` port and emits the same payload on the `dictionary` output port.
- `run_pointing_power_scenario`: takes a JSON scenario on the `scenario` port
  and emits JSON attitude, power and sensor telemetry on the `telemetry` port.
  The Sandcastle `basilisk-pointing-power` demo calls it.

## Standards

- Invoke: `PIV` request/response through SDK command mode.
- Payload frame: `TAB`.
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

`build.mjs` compiles `src/module.c` with the published `space-data-module-sdk`
pinned in `package.json` (declared thread model `single-thread`) and signs the
artifact with the development module signing key, found in the stack's
`space-data-module-sdk` checkout or at `SDM_MODULE_SIGNING_KEYPAIR_PATH`.

```sh
npm ci
bash build.sh
npm test
```

The tests run on the browser harness and, when `wasmedge` is on `PATH`, on
WasmEdge.
