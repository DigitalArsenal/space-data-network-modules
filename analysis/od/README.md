# Orbit Determination SupGP Module

This module fits SGP4 mean elements to operator ephemeris samples and returns a
SupGP/OMM-style record with the fit RMS preserved as a quality metric.

## Input formats

The `fit` method accepts operator ephemeris on the `meme` port (the port id is
kept for ABI stability, but it carries any supported format). The format is
selected data-level via the optional `options` frame's `inputFormat` field, or
auto-detected from the payload:

- **SpaceX MEME text** (`inputFormat: "meme"`) — the SpaceX/Starlink source
  format. Its state vectors are already effectively TEME.
- **CCSDS OEM KVN** (`inputFormat: "oem"`, CCSDS 502.0-B) — header +
  one-or-more `META_START`/`META_STOP` segments + state lines
  (`epoch  x y z  vx vy vz`, km / km/s). Multiple segments of the same object
  are concatenated. First fixture: NASA's public ISS OEM (EME2000, 4-min steps).

Both parsers produce a single internal **state-vector series** (`StateSeries`,
`include/od/state_series.h`) that the SGP4 fitter consumes, so adding a provider
or format is a parser change, never a fitter change.

### Frame handling (correctness over coverage)

The fitter propagates in **TEME**, so every sample handed to it must be TEME.

- MEME: used as-is (already TEME; confirmed by the <1 m Starlink fit RMS).
- OEM `REF_FRAME`:
  - `TEME` → used as-is.
  - `EME2000` / `J2000` / `GCRF` → rotated to TEME with the standard IAU-76/FK5
    reduction (precession + truncated IAU-1980 nutation + equation of the
    equinoxes), `include/od/frame_transform.h`.
  - anything else → **fails closed** with `unsupported-frame`.
- OEM `TIME_SYSTEM`: `UTC` only; otherwise **fails closed** with
  `unsupported-time-system`.
- OEM `CENTER_NAME`: `EARTH` only; otherwise `unsupported-center`.

### Output labeling

`DATA_SOURCE` flows from the caller/manifest (`options.dataSource`) — it is
**not** hardcoded to any operator. `OBJECT_NAME` / `OBJECT_ID` / `NORAD_CAT_ID`
flow from the parsed ephemeris (OEM `META`) or from `options.objectName` /
`options.objectId` / `options.noradCatId` overrides.

## Workflow

1. Parse the source ephemeris into a TEME state-vector series.
2. Fit a near-term SGP4 element set from the first data point.
3. Use the default near-term window of about two LEO orbital periods
   (`11520` seconds) so downstream maneuvers do not degrade conjunction
   screening quality.
4. Return SupGP/OMM fields, including `RMS` in kilometers.

## Reference Suite (provider-manifest driven)

The checked-in reference suite lives under `tests/data/supgp-reference/<provider>/`,
each with a `provider.json` (source token, input format, gate type, input files,
CelesTrak CSV, tolerances). Adding a provider (A2.4) is a data change, not code.

- `starlink/` — SpaceX Starlink MEME suite (2026-034 batch) + matching CelesTrak
  SupGP CSV. Gate `beatsCelestrak`, the hard acceptance criterion:

  ```text
  OrbPro fitted RMS < CelesTrak SupGP RMS
  ```

  must pass for every checked-in reference case.
- `iss/` — NASA public ISS OEM (trimmed). Gate `elementRange`: proves the
  EME2000→TEME OEM ingest end-to-end (converges, ISS-like mean motion /
  inclination). CelesTrak element-space parity for ISS is deferred to A2.4.

## Build And Test

```sh
npm run build
node --test tests/test_wasm.mjs
node --test tests/sdk_compat.test.mjs
```

For the native benchmark helper:

```sh
cd src/cpp
cmake -B build
cmake --build build --target bench_supgp
./build/bench_supgp ../../tests/data/supgp-reference/starlink/meme 0 \
  ../../tests/data/supgp-reference/starlink/celestrak_supgp_2026-034.csv
```

The broader downloaded SpaceX corpus remains ignored under `tests/data/meme/`
because it can become very large.
