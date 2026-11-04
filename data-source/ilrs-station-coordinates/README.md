# ILRS Station Coordinates

An SDK module that reads the ILRS station coordinate solution (SINEX `pos+eop`, the weekly combination of the ILRS combination
centres) into one canonical SDS `$GST` per station: the coordinates a laser range is reduced from. It is the station supplier of
the laser observation chain: `data-source/ilrs-crd-source` gives the normal points as `$TDM`, naming each station by its CDP pad,
and this module gives that pad's position, eccentricity and identity.

The same artifact runs in the browser and WasmEdge. The download from EDC or CDDIS, the gunzip of the served `.snx.gz`, the schedule
and the archive belong to the SDN host flow.

## Method

`read_sinex` (typed contracts 1.0, FlatBuffers only): input `source`, the `HttpResponse` (HRSP) hostcap/http-request answers, BODY
one decompressed SINEX file as text (up to 64 MiB); outputs `stations` (one `$GST` per station, up to 1,024), `provenance` (one
`$PVN`) and `report` (one `FlowNotice`, KIND Info, COUNT the `$GST` emitted). A 304 gives one `FlowNotice` (Unchanged) and no
record; another status or a transport error is refused. The parser takes no configuration: every station in the file is emitted.

The authority is the SINEX format, version 2.02 (IERS). Blocks read: the `%=SNX` header, `SITE/ID`, `SOLUTION/EPOCHS`,
`SITE/ECCENTRICITY` and `SOLUTION/ESTIMATE`, by their fixed columns; every other block is passed over and counted in the report.

- **A station** is one site code, point code and solution number with `STAX`, `STAY` and `STAZ` in `SOLUTION/ESTIMATE`.
- **What the `$GST` holds** is what the file states, with no transform: `STATION_ID` and `CDP_NUMBER` the CDP pad (the key a CRD
  file's `OBSERVER_ID` begins with), `DOMES_NUMBER` and `NAME` from `SITE/ID`, `NETWORK` ILRS, `REFERENCE_EPOCH` the estimates'
  epoch (ISO 8601), `POSITION_*` in metres and `POSITION_SIGMA_*` their standard deviations, `VELOCITY_*` (m/y) from `VELX`,
  `VELY`, `VELZ` when the file estimates them, `ECCENTRICITY_*` from the `SITE/ECCENTRICITY` row valid at the reference epoch
  (`XYZ` as given; `UNE` as `NEU`, each component in its own field), `VALID_FROM` and `VALID_TO` the solution's data window from
  the header, `SOURCE` the file name.
- **Velocity.** The ILRS weekly solution estimates positions only. A zero `VELOCITY_*` would claim the station does not move, so a
  file without velocities gives NaN.
- **Frame.** A SINEX file does not name its terrestrial frame realization; `FRAME_REALIZATION` is `UNSPECIFIED` and the report says
  so. The host that knows the product's frame states it.
- **Provenance.** One `$PVN` for the file: `SOURCE_ID` the combination centre's file prefix (`ilrsa`), `SOURCE_KIND` Reference,
  `ORIGINATOR` ILRS, `PROVIDER_ID` the URL's host, `PRODUCER` this module and version, `LICENSE_CLASS` Reproducible, `LICENSE_ID`
  and `LINEAGE` `ilrs`, `SOURCE_URL`, `SOURCE_VERSION` the header's agency and creation time, `RETRIEVED_AT` from the
  `HttpResponse`. `SOURCE_SHA256` is empty: the module sees the decompressed text, not the bytes as retrieved.
- **The report** items: format, agency, created, solutionStart, solutionEnd, technique, sites, estimates, stations,
  stationsWithVelocity, stationsWithEccentricity, frameRealization, `parametersNotRead.<type>` (the EOP estimates XPO, YPO, LOD),
  `blockNotRead.<block>`, and per station `station.<k>.code/point/solution/domes/dataStart/dataEnd/meanEpoch`.
- **Refused whole, with no partial output:** a gzip body, a NUL, no `%=SNX` header, no `%ENDSNX` (truncated), a block left open,
  no `SOLUTION/ESTIMATE`, a station with part of its position or velocity, a position on different epochs or not in `m`, two
  eccentricities at one reference epoch, or a number or epoch that does not read.

Errors are flags (an invoke error code and message), never exceptions.

## Why `$GST`

`$GST` (SDS 1.276.0, Ground/Tracking Station Definition) is the type for one station's geodetic identity: frame realization,
reference epoch, position, velocity, sigmas, eccentricity, DOMES and CDP numbers. `$TRH` (Tracking Hardware) holds antennas,
transmitters, receivers, transponders and their delays, and has no position, velocity, epoch or station identifier. `$CRD` holds
six bare numbers and a frame code, with no station, epoch, sigma or eccentricity. `$GST` has no PVN field, so the provenance is
its own `$PVN` frame (a PVN on its own describes one source).

## Build and test

```sh
npm ci
npm run build          # dist/isomorphic/module.wasm and dist/guest-link (single thread, SDK 0.9.12, SDS 1.276.0)
node tests/sinex.e2e.mjs
```

The E2E reads a real file, the ILRSA weekly solution of 2026-07-18 without its covariance block (`tests/fixtures`, provenance in
`PROVENANCE.md`): 20 `$GST`, one per station of `SOLUTION/ESTIMATE`; Graz (7839) and Yarragadee (7090) equal to the printed
estimates to the millimeter, with Yarragadee's printed eccentricity; one `$PVN`; no USER_DEFINED in any record.

## Licence and data

| Source | Terms | In this module |
| --- | --- | --- |
| ILRS weekly station coordinate solutions (SINEX pos+eop) via EDC (DGFI-TUM) and CDDIS, audit id `ilrs` | The ILRS states its data and products are not copyrighted and asks to be cited (https://ilrs.gsfc.nasa.gov/about/cite.html); EDC adds no data terms; reproduce: yes | One real file without its covariance block, with its provenance in `tests/fixtures/PROVENANCE.md` |

`NOTICE.md` records the terms and credit lines. Obtain the data from the EUROLAS Data Center
(https://edc.dgfi.tum.de/pub/slr/products/pos+eop/weekly/) or the NASA CDDIS.
