# OD Fit Pipeline

Timer-driven module that fits SDN supplemental GP elements (SupGP) to the operator ephemerides already in the
node's store. Typed contracts 1.0: every port is one FlatBuffer type, no JSON and no base64.

```
tick (TimerTick, od-fit-pull every 2 h)
  -> storage.query(SCHEMA, LIMIT)             typed hostcall (storage_query): StoredRecordMeta list + record bytes
  -> od::read_oem_flatbuffer                  analysis/od's $OEM reader (frame / time / center rules, TEME)
  -> od::fit_sgp4_series                      analysis/od's fit
  -> od::build_omm_flatbuffer / build_obd_flatbuffer
  -> omm ($OMM), obd ($OBD), status (FlowNotice)
```

Storing and publishing the fits is the flow's job (`hostcap/storage-ingest` `omm_records`), as for every typed
module; this module calls no storage write, signing or pubsub operation.

## Ports (`fit_pipeline`)

| port | type | carries |
|---|---|---|
| in `tick` | TimerTick (TICK) | the timer tick; `FIRED_MS` stamps the notices. A direct invoke needs none. |
| out `omm` | `$OMM` | one size-prefixed record per fitted object (ORIGINATOR `SDN-OD`) |
| out `obd` | `$OBD` | the fit of each, in the same order (WRMS, iterations, fit span; `SENSORS[0].SENSOR_ID` = the provider's `dataSource`) |
| out `status` | FlowNotice (FNTC) | Skipped: each record not fitted, with the reason, the record's CID in `ITEMS`; Skipped `unconfigured`: the records of no configured provider; Info: one summary per provider (`COUNT` fitted, `ITEMS` their CIDs in the order of the omm records); Missing: storage.query failed |

The `$OMM` and `$OBD` are analysis/od's: for the same `$OEM` and settings they are byte for byte the records
analysis/od's `fit` emits (the test checks it).

## Config (`plugin.getConfig`, one ModuleConfig)

| key | default | |
|---|---|---|
| `querySchema` | `OEM` | the schema storage.query reads |
| `queryLimit` | 500 | the records one pass reads |
| `providers` | `spacex-starlink` (dataSource `SpaceX-E`) and `iss` (`ISS-E`), 50 iterations each | a list of `{sourceName, dataSource, requireConverged, fit: {maxIterations, fitWindowSec, subsample, convergenceTol}}`; given, it replaces the default set |
| `idRegistry` | empty | `{<OBJECT_NAME>: {NORAD_CAT_ID, OBJECT_ID}}`: IDs for records that carry none (slot, name or PRN feeds) |

Fit policy per provider: `maxIterations` (clamped 1..300, as analysis/od's `fit`), `fitWindowSec` (11520 s, about two
LEO orbits), `subsample` (0 = the fitter's default), `convergenceTol` (0.0002), `requireConverged` (true: a fit that
does not converge is reported, not emitted). A host that cannot answer `plugin.getConfig` leaves the defaults.

A record belongs to the provider whose `sourceName` is its stored `SOURCE_NAME`; an untagged record goes to the only
provider of a one-provider configuration, otherwise it is `unconfigured`. A stored record may be the `$OEM` root or a
size-prefixed `$OEM`.

IDs: the record's NORAD number is kept; a record without one takes the registry's IDs by `OBJECT_NAME`; with no
registry entry it is fitted with honest-empty IDs (NORAD 0, `OBJECT_ID` empty). IDs are never made up.

## Reasons a record is not fitted

| reason | cause |
|---|---|
| `unsupported-frame: ...`, `unsupported-time-system: ...`, `unsupported-center: ...` | analysis/od's reader refuses the frame, time system or center (only `EARTH`; TEME, EME2000/J2000/GCRF and Earth-fixed frames; UTC, GPS, TAI) |
| `parse-failed: ...`, `empty-ephemeris: ...`, `inconsistent-segments: ...` | not a readable `$OEM`, no states, or segments that disagree |
| `too-few-samples:<n>` | fewer than 8 states |
| `<norad>:fit-not-converged:rms=<km>` | the fit did not converge and the provider requires it |

## Build & test

```
export SPACE_DATA_STANDARDS_ROOT=<spacedatastandards checkout>
SDN_OD_EIGEN_DIR=<dir holding Eigen/Dense> node build.mjs
node --test test/*.test.mjs
```

`build.mjs` compiles one translation unit through the SDK compiler (thread model `wasi-sequential`):
`src/fit_pipeline.cpp` and the analysis/od sources it calls, read in place from `../src/cpp` with analysis/od's SDS
headers. `build-driver.mjs`, the SDK's compiler hook, adds `-ffast-math` (as analysis/od compiles the fitter) and the
Eigen include. The artifact targets the browser and WasmEdge.

The test runs the shipped artifact in the SDK harness with a stub host that answers `storage.query` with real `$OEM` records: the
SpaceX Starlink records data-source/spacex-starlink-source emits and the NASA ISS records data-source/oem-source-iss
emits, plus records that must be refused. Each fit is compared with analysis/od's `fit` artifact on the same `$OEM`.
