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
and zero to 64 daily SDS `SPW.fbs` (`$SPW`, root `SPW`) records on the
`space_weather` port, reads `ATMOSPHERE`, `ALTITUDE_M`, and sample metadata,
and emits SDS `HFC.fbs` on the `states` port with:

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
- `ASSUMPTIONS`: the model inputs and approximations actually used

An absent `ATMOSPHERE` means `USSA_XX` 1976. Any other model family is refused
with `unsupported-atmosphere-model`; the module never answers a request with a
different model than the one named.

For `ATMOSPHERE.MODEL = USSA_XX`, density samples at and above 100 km use the
Basilisk `orbitalMotion.c` Standard Atmosphere 1976 orbital density curve fit
while lower-altitude state quantities use the US76 layer model. That curve fit
is an approximation, and `ASSUMPTIONS` says so.

For `ATMOSPHERE.MODEL = NRLMSIS00E`, every sample needs a UTC `SAMPLE_EPOCHS`
entry, `LATITUDE_DEG`, `LONGITUDE_DEG`, and an `ALTITUDE_M` geodetic height in
0–1 000 000 m. `TIME_SYSTEM` must be `UTC` or absent. Space weather comes from
the daily `$SPW` records, following the NRLMSISE-00 package definitions
(`third_party/nrlmsise00/nrlmsise-00.h`, notes on input variables and
`struct ap_array`):

- F10.7 is the **observed** flux (`F107_OBS`) of the UTC day **before** the
  sample. The model was built on flux at the Earth's actual distance, so the
  1 AU adjusted fields are never read.
- F10.7A is the observed 81-day centered mean (`F107_OBS_CENTER81`) of the
  sample's own day.
- The daily Ap is the sample day's `AP_AVG`.
- When the 3-hour bins (`AP1`..`AP8`) covering the 57 hours before the sample
  are all present, the model runs with switch 9 = -1 and the epoch-relative
  ap history: current bin, 3 h, 6 h and 9 h before, and the means of the eight
  bins 12–33 h and 36–57 h before. Otherwise it uses the daily Ap alone.
  `ASSUMPTIONS` reports how many samples used each mode, and any use of
  forecast flux (`F107_DATA_TYPE` `PRD`/`PRM`).

Supply the sample day and the day before at minimum. Supply the three days
before as well to get the ap history. Local solar time follows from UT and
longitude. There are no default weather, time or position values.

Refusals carry stable error codes: `missing-space-weather`,
`missing-space-weather-day`, `missing-previous-day-f107`,
`missing-centered-f107`, `duplicate-spw-day`, `invalid-spw-date`,
`invalid-spw-value`, `too-many-spw-records`, `missing-sample-epochs`,
`invalid-sample-epoch`, `missing-sample-positions`, `invalid-sample-position`,
`altitude-out-of-range`, `invalid-altitude`, `invalid-speed`,
`unsupported-time-system`, `unsupported-atmosphere-model`.

The JSON command bridge follows the same rule for `NRLMSISE00`: `solar`
(`F107`, `F107A`, `Ap`), `position` and `epoch` are required, and
`"apHistory": true` passes a full 7-element `Ap` array as the model's ap
history. Unknown `model` names are refused.

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
cmake -S src/cpp -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j4
ctest --test-dir build --output-on-failure
```

`test_nrlmsise_package` runs the vendored model over all 17 published cases of
the NRLMSISE-00 C package, including the ap-history cases 16 and 17.
`test_space_weather` checks the daily-record-to-model-input selection.

Wasm build. `build.sh` regenerates the SDS bindings from the published
`spacedatastandards.org` package with `generate-sds-headers.mjs`, so install
the pinned packages first:

```bash
npm ci
bash build.sh
```

The build has no `-ffast-math`: it would let the compiler assume NaN and
infinity never occur and remove the input validation.

Artifacts:

- `dist/browser/module.js`
- `dist/browser/module.wasm`
- `dist/isomorphic/module.wasm`

## Verification

SDK, browser, and WasmEdge harness:

```bash
PATH="$HOME/.wasmedge/bin:$PATH" npm test
```

The WasmEdge cases need `wasmedge` on `PATH`. That test covers:

- SDK artifact compliance
- browser and WasmEdge command invoke smoke via `dist/isomorphic/module.wasm`
- binary SDS HFC direct-method invoke in browser and WasmEdge
- HFC sample epoch, latitude, and longitude preservation through the direct
  binary method
- HFC NRLMSISE-00 input selection from daily SPW records: observed
  previous-day flux, centered mean, epoch-relative ap history, daily-Ap
  fallback and forecast reporting, each checked against the same model
  evaluated with independently stated inputs, in browser and WasmEdge
- refusal codes for missing weather, epochs, positions, out-of-range altitude,
  non-UTC time systems, duplicate days and unsupported models
- NRLMSISE-00 published case 16 (ap history) through the JSON bridge
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
