# Space Data Network Modules

Canonical Space Data Network module implementations.

This repository is the forward home for SDK-compliant Space Data Network
modules. Existing module packages in `space-data-network-plugins` are reference
implementations during migration; new module families land here unless a split
repository is explicitly required.

## Repository Contract

- Module packages must conform to the `space-data-module-sdk` contract.
- The canonical compiled artifact for each package is
  `dist/isomorphic/module.wasm`.
- Every module must embed a standards-backed `PLG` manifest.
- Invoke surfaces use SDS `PIV` request/response envelopes and `TAB` payload
  frames.
- Durable and externally visible data uses canonical SDS schemas from
  `spacedatastandards.org`.
- Telemetry and command dictionaries use SDS `XTC` when module data represents
  spacecraft telemetry, command packets, device buses, sensor buses, actuator
  commands, or flight-software I/O.
- Golden output produced only by a new module is not authoritative test data.

## Layout

```text
basilisk/
  runtime/        Basilisk scheduler, messaging, scenario execution, replay
  dynamics/       Spacecraft dynamics and effectors
  environment/    Ephemeris, atmosphere, eclipse, ground access, fields
  sensors/        Navigation, sensors, and camera models
  power/          Power, thermal, device, and data-handling modules
  fsw/            Flight-software guidance, control, navigation, estimation
  optical/        Optical navigation and image-processing modules
docs/
  basilisk-module-plan.json
  basilisk-message-standards.json
  basilisk-standards-map.md
scripts/
  build-modules.sh
  check-basilisk-plan.mjs
  generate-basilisk-module-plan.mjs
  generate-basilisk-message-map.mjs
  test-sdk-compat.sh
```

## Validation

Use repo-local commands from the stack root unless a package command must run
inside a module package.

```sh
SPACE_DATA_MODULE_SDK_ROOT=../space-data-module-sdk ./scripts/test-sdk-compat.sh
npm run generate:basilisk-plan
npm run check:basilisk-plan
```

Each package must also carry its own authoritative test fixtures and a README
listing:

- authoritative source for expected values;
- units, frames, epochs/time scales, and tolerances;
- SDS schemas and file identifiers used by each port;
- browser and WasmEdge verification commands;
- known dependency or portability limits.
