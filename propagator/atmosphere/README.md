# Atmosphere Plugin

Atmospheric model queries packaged as a `space-data-module-sdk` plugin for hosted SDN runtimes, WasmEdge, and browser runtimes.

## What it does

This plugin exposes atmosphere computations through these SDK methods:

- `invoke`
- `query_atmosphere_state_batch`
- `vcm_state_to_drag_acceleration_oem`

`invoke` is the legacy command bridge. The request payload is UTF-8 JSON with this envelope:

```json
{
  "operation": "queryAltitude",
  "params": {
    "altitudeM": 10000,
    "model": "US76"
  }
}
```

The response payload is UTF-8 JSON returned on the `response` port.

`query_atmosphere_state_batch` is the binary direct method for module-to-module
use. It accepts SDS `HFC.fbs` (`$HFC`, root `HFC`) on the `atmosphere` port
and optional SDS `SPW.fbs` (`$SPW`, root `SPW`) on the `space_weather` port,
reads `ATMOSPHERE`, `ALTITUDE_M`, and optional sample metadata, and emits SDS
`HFC.fbs` on the `states` port with:

- `ATMOSPHERE_PROVIDER`
- `ATMOSPHERE_MODEL_REVISION`
- `ATMOSPHERE_COUPLING`
- `SAMPLE_EPOCHS` when supplied by the request
- `LATITUDE_DEG` when supplied by the request
- `LONGITUDE_DEG` when supplied by the request
- `ALTITUDE_M`
- `SPEED_M_PER_S` when supplied by the request
- `MACH` when speed samples are supplied
- `DYNAMIC_PRESSURE_PA` when speed samples are supplied
- `DENSITY_KG_PER_M3`
- `TEMPERATURE_K`
- `PRESSURE_PA`
- `SPEED_OF_SOUND_M_PER_S`

For `ATMOSPHERE.MODEL = USSA_XX`, density samples at and above 100 km use the Basilisk `orbitalMotion.c` Standard Atmosphere 1976 orbital density curve fit while lower-altitude state quantities use the US76 layer model.

For `ATMOSPHERE.MODEL = NRLMSIS00E`, supplied `SAMPLE_EPOCHS`,
`LATITUDE_DEG`, and `LONGITUDE_DEG` are converted into the NRLMSISE-00
position/time inputs before density, temperature, pressure, and sound speed are
computed. The output also preserves those request vectors for downstream
module alignment. When a `space_weather` `$SPW` frame is supplied, its F10.7,
centered F10.7A, and Ap fields feed the NRLMSISE-00 solar-activity input.

The C++ model layer also includes Basilisk `orbitalMotion.c` `debyeLength` and
`atmosphericDrag` utilities with SI input/output for native parity coverage.
`vcm_state_to_drag_acceleration_oem` exposes the drag utility through the
binary direct SDK surface: it consumes SDS `VCM.fbs` (`VCM`) with
`STATE_VECTOR`, `MASS`, `DRAG_AREA`, and `DRAG_COEFF`, then emits SDS
`OEM.fbs` (`$OEM`, root `OEM`) on `drag_acceleration` with
`STATE_VECTOR_SIZE=9`. OEM acceleration components are in km/s^2, matching
CCSDS OEM units and Basilisk `orbitalMotion.c` output conventions.
Direct HFC Debye-length output remains open because the current SDS HFC record
has no Debye-length output field.

## Supported operations

- `version`
- `queryAltitude`
- `queryAltitudes`
- `queryAtmosphereStateBatch`
- `vcm_state_to_drag_acceleration_oem`

These operations route the US Standard Atmosphere 1976 implementation (geopotential-altitude formulation, 0-86 km geometric) and the REAL NRLMSISE-00 model (public-domain Picone/Hedin/Drob reference C port by D. Brodowski, vendored in `third_party/nrlmsise00/`) through the canonical SDK command bridge. NRLMSISE-00 mass density is the gtd7d drag-effective density (includes anomalous oxygen); outputs are verified against the canonical 17-case table distributed with the reference package.

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

- `dist/browser/module.js`
- `dist/browser/module.wasm`
- `dist/isomorphic/module.wasm`

## Verification

SDK, browser, and WasmEdge harness:

```bash
npm test
```

That test covers:

- SDK artifact compliance
- browser and WasmEdge command invoke smoke via `dist/isomorphic/module.wasm`
- binary SDS HFC direct-method invoke in browser and WasmEdge
- HFC sample epoch, latitude, and longitude preservation through the direct
  binary method
- HFC NRLMSISE-00 density and temperature variation from per-sample epoch and
  coordinate metadata in browser and WasmEdge
- typed SDS SPW F10.7/F10.7A/Ap input for HFC NRLMSISE-00 in browser and
  WasmEdge
- Basilisk `atmosphericDensity` reference density at 200 km through HFC
- Basilisk `debyeLength` native reference values at 400 km, 1000 km, 10000 km,
  and 34000 km
- Basilisk `atmosphericDrag` native source-vector acceleration and direct
  VCM-to-OEM browser/WasmEdge SDK invocation
- HFC dynamic pressure and Mach derived from speed samples
- a hosted-runtime example contract check

## hosted-runtime example

A minimal single-plugin flow example lives at:

- `tests/fixtures/hosted-runtime/atmosphere.single-plugin.flow.json`

It binds a manual trigger to the plugin's canonical `request` port and invokes method `invoke`.

## Example request

The fixture used by the compatibility tests lives at:

- `tests/fixtures/request.altitude.json`

It queries the US76 atmosphere state at 10 km altitude.

## License

MIT.
