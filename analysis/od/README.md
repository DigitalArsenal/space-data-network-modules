# Orbit Determination Module

This module fits SGP4 mean elements to operator ephemeris samples and returns
SDS records only: `$OMM` (the elements), `$OCM` (epoch state, covariance or its
explicit absence) and `$OBD` (the OD run, with the fit RMS as `WRMS` in km).

The `fit_ffm` method adds an operator-seeded FFM Fast state + B_eff fit, with
DCL drag, fixed SRP, maneuver segmentation and a strict 48-hour boundary. See
[operator fit](docs/operator-fit.md) for its inputs, covariance and cost contract.
The original `fit` method described below remains the SGP4 path.

## Contract (FlatBuffers only)

| port | type | carries |
|---|---|---|
| in `oem` | `$OEM` | an operator ephemeris |
| in `meme` | `$FIL` | a text ephemeris file (`CONTENT`): SpaceX MEME or CCSDS OEM KVN |
| out `omm` | `$OMM` | the fitted mean elements (ORIGINATOR `SDN-OD`) |
| out `ocm` | `$OCM` | epoch state + formal covariance, or `UNAVAILABLE` |
| out `obd` | `$OBD` | the fit (`METHOD_SOURCE` `SDN-OD`: `WRMS`, `NUM_ITERATIONS`, `FIT_SPAN`, `SENSORS[0].SENSOR_ID` = `dataSource`); plus, when a reference element set is configured, that set scored on the same points (`METHOD_SOURCE` `reference`, `WRMS` = its RMS) |
| out `tle` | `$FIL` | opt-in two-line set, `NAME` `<NORAD>.tle`, `text/plain` |

Exactly one of `oem` / `meme` per invocation. Both fit the same core and emit the
same records (byte-identical for the same states). The options are node CONFIG,
read with `plugin.getConfig` (`sdm_piv::get_config`, a `ModuleConfig`):
`dataSource`, `objectName`, `objectId`, `noradCatId`, `maxIterations`
(or `max_iterations`, clamped 1..300), `inputFormat`, `emitTle`, and the
reference set `refEpoch` + `refMeanMotion` (+ `refEccentricity`,
`refInclination`, `refRaan`, `refArgPericenter`, `refMeanAnomaly`, `refBstar`,
`refMeanMotionDot`, `refMeanMotionDdot`).

## Input formats

The `meme` port's `$FIL` carries any supported text format (the port id is kept).
The format is selected by the `inputFormat` CONFIG key, or auto-detected from the
content:

- **SpaceX MEME text** (`inputFormat: "meme"`) — the SpaceX/Starlink source
  format. Its state vectors are EME2000; the `UVW` header line names the
  covariance frame.
- **CCSDS OEM KVN** (`inputFormat: "oem"`, CCSDS 502.0-B) — header +
  one-or-more `META_START`/`META_STOP` segments + state lines
  (`epoch  x y z  vx vy vz`, km / km/s). Multiple segments of the same object
  are concatenated. First fixture: NASA's public ISS OEM (EME2000, 4-min steps).

Both parsers produce a single internal **state-vector series** (`StateSeries`,
`include/od/state_series.h`) that the SGP4 fitter consumes, so adding a provider
or format is a parser change, never a fitter change.

### Frame handling (correctness over coverage)

The fitter propagates in **TEME**, so every sample handed to it must be TEME.

- MEME: EME2000, rotated to TEME like OEM `EME2000` (`meme_state_series`).
  A fit's own RMS cannot detect a frame error, since the fit is self-consistent
  in any frame. The Starlink reference suites therefore also score CelesTrak's
  SupGP elements on our TEME states (`referenceRmsMaxKm`): 0.4–3.0 km when
  rotated, 35–41 km when the states are read as TEME.
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

The data source flows from node CONFIG (`dataSource`, written to the `$OBD`'s
`SENSORS[0].SENSOR_ID`) — it is **not** hardcoded to any operator.
`OBJECT_NAME` / `OBJECT_ID` / `NORAD_CAT_ID` flow from the parsed ephemeris (OEM
`META`) or from the `objectName` / `objectId` / `noradCatId` CONFIG overrides.

### Two-line output

CONFIG `emitTle: true` adds a `$FIL` on `tle` whose CONTENT is `line1\nline2`: the fitted element set as a legacy
two-line element set (69 columns, both check digits, the international designator of `OBJECT_ID`, the classification,
element set number and revolution number of the record). A catalog number from 100000 to 339999 is written as Alpha-5,
as Space-Track writes it: a letter for the ten-thousands (A to Z without I and O, 10 to 33) and four digits, so 100000
is `A0000`, 123456 is `C3456` and 339999 is `Z9999`. A number outside 0 to 339999 has no two-line form and the fit
fails with `unrepresentable-catalog-number`. `tests/alpha5_tle.test.mjs` checks the lines against the fitted elements
and reads them back with data-source/catalog-source; `tests/parity_alpha5.mjs` holds the same cases byte-identical in
the browser and native WasmEdge (the owner waived the Docker leg on 2026-10-22).

## Workflow

1. Parse the source ephemeris into a TEME state-vector series.
2. Fit a near-term SGP4 element set from the first data point.
3. Use the default near-term window of about two LEO orbital periods
   (`11520` seconds) so downstream maneuvers do not degrade conjunction
   screening quality.
4. Emit the `$OMM`, `$OCM` and `$OBD` (the RMS in kilometers as `WRMS`).

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
- `iss/` — NASA public ISS OEM (trimmed). Gate `beatsCelestrakSameEphemeris`
  (A2.4d, OWNER RULING 2026-07-13 "same ephemeris"): scores CelesTrak's OWN
  Segment-01 SupGP elements via the SAME SGP4 over the SAME source-OEM states our
  fit used, and requires ours ≤ theirs — MEASURED ours 0.071 km ≤ CelesTrak
  0.111 km (margin 0.040 km). This gate is a strict superset of `elementRange`:
  it ALSO runs the EME2000→TEME ingest sanity ranges + same-epoch CelesTrak
  element-space parity. (The raw 0.071-vs-CelesTrak-reported-0.067 comparison is
  NOT used — that 0.067 is CelesTrak's in-sample RMS on their own realization,
  not reproducible on our OEM. The reusable `ref*` fit option that feeds the gate
  is available to any provider whose arc supports it — GLONASS/CPF/Intelsat.)

## OCM emission lane (constellation pipeline)

`scripts/constellation-pipeline.mjs --emit-ocm` builds an SDS **$OCM** (Orbit
Comprehensive Message, CCSDS 502.0-B-3) for every fitted object and publishes it
alongside the fitted **$OMM** (`POST /api/v1/data/publish/batch/OCM.fbs`, same
`source_name`/`provider_id`/`batch_id`/`source_url` tags), so an `OCM.fbs` row
appears on the App 2 board's `/api/v1/stats`.

The record builder + the fit-context→settings mapper live in
`scripts/lib/ocm-record.mjs` (pure, dependency-injected, unit-tested). The OCM
carries:

- **METADATA / HEADER** — object identity (NORAD, name, COSPAR when known) from
  the provider ephemeris, never fabricated.
- **fitted mean-element state** — the same GP elements as the companion $OMM,
  carried as `USER_DEFINED_PARAMETERS` (OCM has no native Keplerian trajectory
  block; its `STATE_DATA` is Cartesian, which an element fit does not produce).
- **ORBIT_DETERMINATION** — method (SGP4 differential correction, Levenberg-
  Marquardt, multi-start), epoch, fit window (`11520` s = 2 orbital periods,
  ~3.2 h), estimated parameters, RMS residuals, data source.
- **PERTURBATIONS** — the propagation context, with FIELD SELECTION taken from
  the US Space Force **Vector Covariance Message (VCM)** taxonomy (CCSDS
  502.0-B-3) used as a **reference specification only**. No VCM schema is
  imported and no VCM record is read or produced; every value is our own SGP4
  fit-theory context (WGS-72 zonal geopotential J2/J3/J4, GM 398600.8, B* drag)
  with honest `N/A` where the theory defines nothing (no density model, no SRP,
  no third-body, no solar-flux/geomagnetic inputs). Provenance COMMENTs cite the
  VCM spec as the field-selection reference and mark `vcm-unavailable`.

To activate real VCM-derived settings, an operator must supply VCM records via an
SSA sharing-agreement lane (this account has no VCM feed); that is a future
mapper, not part of this OCM-only lane.

## Build And Test

```sh
npm run build
node --test tests/test_wasm.mjs
node --test tests/sdk_compat.test.mjs
node --test tests/ocm_emission.test.mjs   # OCM builder + perturbation mapper
node --test tests/alpha5_tle.test.mjs     # Alpha-5 two-line output, read back by catalog-source
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
