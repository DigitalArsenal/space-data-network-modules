# Orbit Determination SupGP Module

This module fits SGP4 mean elements to operator ephemeris samples and returns a
SupGP/OMM-style record with the fit RMS preserved as a quality metric.

The current source adapter parses SpaceX MEME text ephemerides. In product and
demo surfaces, those samples are treated as OEM-compatible CCSDS state-vector
ephemerides; MEME is only the SpaceX source file format. The fitted output is an
OMM-compatible SGP4 mean-element set with SupGP metadata such as `RMS` and
`DATA_SOURCE`.

## Workflow

1. Parse SpaceX source ephemeris text into TEME Cartesian state samples.
2. Fit a near-term SGP4 element set from the first data point.
3. Use the default near-term window of about two LEO orbital periods
   (`11520` seconds) so downstream maneuvers do not degrade conjunction
   screening quality.
4. Return SupGP/OMM fields, including `RMS` in kilometers.

## Reference Suite

The checked-in reference suite lives under:

- `tests/data/supgp-reference/meme/`
- `tests/data/supgp-reference/celestrak_supgp_2026-034.csv`

These are trimmed SpaceX Starlink ephemerides from the 2026-034 batch with
matching CelesTrak SupGP CSV records. The hard acceptance criterion is:

```text
OrbPro fitted RMS < CelesTrak SupGP RMS
```

That comparison must pass for every checked-in reference case.

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
./build/bench_supgp ../../tests/data/supgp-reference/meme 0 ../../tests/data/supgp-reference/celestrak_supgp_2026-034.csv
```

The broader downloaded SpaceX corpus remains ignored under `tests/data/meme/`
because it can become very large.
