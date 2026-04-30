# Basilisk Runtime Module

This package is the seed for the Basilisk runtime SDN module family. It is not complete
yet: the current method only verifies the canonical `XTC` dictionary
port path that the full runtime will use for Basilisk telemetry and command
metadata.

## Current Method

- `echo_xtc_dictionary`: accepts an SDS `XTC` FlatBuffer payload on the
  `dictionary` port and emits the same payload on the `dictionary` output port.

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

```sh
bash build.sh
node --test tests/*.test.mjs
SPACE_DATA_MODULE_SDK_ROOT=../../space-data-module-sdk ../../scripts/test-sdk-compat.sh basilisk/runtime
```
