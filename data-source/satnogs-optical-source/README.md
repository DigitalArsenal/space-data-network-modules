# SatNOGS Optical Source

An SDK module that turns one station-night of SatNOGS Optical astrometric measurements into SDS tracking data: one RA/Dec `$TDM`
per object-track, at mid-exposure epochs, from the station's site, with each observation's sigma as an `$EOO`, the station's timing
record as a `$GST`, and the CC BY-SA 4.0 licence on the batch. It is the observation source of the angles-only lane:
`analysis/estimation` reads the `$TDM` on `tracking_data`.

The same artifact runs in the browser and WasmEdge. The dump download and its sha256 check, the Parquet decode of
`measurements.parquet`, the schedule and the archive belong to the SDN host flow; the module has no Parquet reader.

## Method

`read_station_night` (typed contracts 1.0, FlatBuffers only).

| Port | Record | What |
| --- | --- | --- |
| `angles` (in) | one `$TDM` | the night's tracks, one segment each: `TRACK_ID`, `PARTICIPANT_1` the station (`SATNOGS-OPTICAL-<id>`), `PARTICIPANT_2` the NORAD number or UNK designation, `ANGLE_TYPE` RADEC, `TIME_SYSTEM` UTC, `ANGLE_1`/`ANGLE_2` each row's `ra_deg`/`dec_deg` at its `t_utc`; the row's `epoch_refers_to` as `INTEGRATION_REF` (exposure-mid MIDDLE, exposure-start START with the exposure as `INTEGRATION_INTERVAL`, frame-arrival none); quarantined rows in a segment with `DATA_QUALITY` DEGRADED; `CREATION_DATE` the dump's stamp |
| `measurements` (in) | one `$EOO` per row, in angle-pair order | `ID` the measurement id, `OB_TIME` its epoch, `IMAGE_SET_ID` the track, `SENSOR_ID`, `ORIG_SENSOR_ID` the station name, `NORAD_CAT_ID`, `UCT`, `RA_UNC`/`DECLINATION_UNC` the row's sigma (degrees), `SENLAT`/`SENLON`/`SENALT` the station file's site, `TIMING_BIAS` the declared bias (s) |
| `config` (in, optional) | `ModuleConfig` | `minimumMeasurements` (default 1), `quarantine` (`refuse`, the default, or `fail`), `objects` (NORAD numbers); any other key is refused |
| `observations` | one `$TDM` per object-track | `OBSERVER_ID`, `OBSERVER_X/Y/Z` the site in Earth-fixed metres, `TIMETAG_REF` RECEIVE, RADEC at mid-exposure epochs, the credit line in `COMMENT` |
| `uncertainty` | one `$EOO` per observation | the input record with `OB_TIME` at mid-exposure and the site as `SENX/SENY/SENZ` (km) |
| `stations` | one `$GST` | the station: site (m; sigma NaN, none declared), `CLOCK_OFFSET_S` the declared timing bias (NaN when it changes within the night), `CLOCK_TIME_SCALE` UTC; a night with two sites is refused |
| `provenance` | one `$PVN` | `SOURCE_ID` satnogs-optical, `SOURCE_KIND` Observation, `ORIGINATOR` the station, `LICENSE_CLASS` ShareAlike, `LICENSE_ID` CC-BY-SA-4.0 |
| `ingest` | one `IngestRequest` | `TAGS`: `SOURCE_NAME` satnogs-optical, `LICENSE` CC-BY-SA-4.0, `LICENSE_URL`, `CITATION` the credit line, `SHARE_ALIKE`; provenance attribute `class` publish-with-credit |
| `report` | one `FlowNotice` | counts, the site, the bias, per track id/object/observations/epochReference/epochShiftNanoseconds, and `refused.<measurement id>` with the reason |

- **Pairing.** The k-th `ANGLE_1`/`ANGLE_2` pair of the `$TDM` (segments in order) is the k-th `$EOO`; its `OB_TIME` and
  `IMAGE_SET_ID` must equal the pair's epoch and track, else the night is refused.
- **Mid-exposure.** The epoch moves by the declared offset, in integer nanoseconds: MIDDLE 0, START +interval/2, END
  -interval/2. An epoch with no declared offset (frame-arrival, which the network folds into its timing sigma, or START or END
  without an exposure) is refused by name. A move of 0 keeps the row's epoch text.
- **Site.** `OBSERVER_X/Y/Z` is the station file's WGS-84 geodetic site on the ellipsoid, the station position
  `analysis/estimation` takes.
- **Quarantine.** A quarantined row is refused by name: not emitted and named in the report, or with `quarantine` `fail` the
  night is refused naming it. A track split by refused rows is still one `$TDM`.
- **Licence.** CC BY-SA 4.0, credit "SatNOGS Optical contributors - https://optical.satnogs.org - CC BY-SA 4.0", on the
  `IngestRequest` tags, the `$PVN` and every `$TDM`. Share-alike binds a database built from the data; results computed from it
  owe the credit.

Errors are flags (an invoke error code and message), never exceptions.

## Why two input records

No SDS 1.276 table holds a SatNOGS row whole. `$EOO` (electro-optical observation) has the row's name, sigma, site and bias but
32-bit angles (about 1e-5 degrees of rounding) and no field for the epoch convention or a withheld row; `$TDM` has 64-bit angles
and the convention in CCSDS terms but no per-observation sigma. Not carried by either: the station's declared timing sigma
(`$GST` has no clock-sigma field; the station file's `timing.rmsTime_declared_ms`), the row's `timing_sigma_ms`, magnitude
and plate-solution fit, and the network's own measured bias (a residual against an SGP4 element set, never used here).

## Build and test

```sh
npm ci
npm run build          # dist/isomorphic/module.wasm and dist/guest-link (single thread, SDK 0.9.12, SDS 1.276.0)
node tests/source.e2e.mjs
```

The E2E reads a real cut: the 423 Sentinel-6B (66514) rows of session 2026-09-21 with every column, and the night's station
file (`tests/fixtures`, provenance in `PROVENANCE.md`). It decodes the Parquet at run time (`tests/parquet.mjs`, a format reader),
converts the rows as the host flow does, and asserts: as many `$TDM` observations and `$EOO` as rows; the first RA and Dec equal
to 1e-9 degrees; every epoch the row's plus the declared offset (exposure-mid: 0 ns; the same rows declared exposure-start with a
1 s exposure: +0.5 s); the licence tags; a quarantined row refused by name; no USER_DEFINED in any record.

## Licence and data

| Source | Terms | In this module |
| --- | --- | --- |
| SatNOGS Optical (Libre Space Foundation), nightly dumps of https://optical.satnogs.org | CC BY-SA 4.0; credit "SatNOGS Optical contributors - https://optical.satnogs.org - CC BY-SA 4.0" | One object-night cut of `measurements.parquet` and one station file, in `tests/fixtures` (provenance in `PROVENANCE.md`), under CC BY-SA 4.0 |

`NOTICE.md` records the terms and credit lines.
