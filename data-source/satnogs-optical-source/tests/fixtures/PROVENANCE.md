# Fixtures of data-source/satnogs-optical-source

Both files come from the SatNOGS Optical dump of session 2026-09-21, generation
`c8a9045ea794a1ac41aff2096b05c7e15e7eaaab8533ab25dde0431019e63ef8` (manifest SHA-256
`32fe43fdbf749d02f64c1ddf9fde0de9a956223a7217abaa4a1889a300d872d3`, generated 2026-09-24T06:43:09.883796Z, correlation run 889),
retrieved 2026-11-04T16:17:16Z from https://pub-ace0a918977843e5a065d3239b3ae105.r2.dev/products/session_date=2026-09-21/generations/c8a9045ea794a1ac41aff2096b05c7e15e7eaaab8533ab25dde0431019e63ef8/
by the archive capture (archive copy `hac/satnogs-optical/session_date=2026-09-21/generations/c8a9045e.../`, provenance row in
`hac/satnogs-optical/provenance.jsonl`).

## `satnogs-optical-2026-09-21-66514.parquet` (real, cut)

The 423 rows of `measurements.parquet` (3,342,807 bytes, SHA-256 `d9b76c85fb5dc8777ac6bc0347bd030343750a07c594010d3a5e8880034be8ef`,
31,596 rows) whose `correlation_object_norad_id` is 66514 (Sentinel-6B; one track, 75451, station 11), every one of its 34 columns,
values copied unedited, the source's `satnogs_optical` key-value metadata verbatim. Written by `cut.mjs` (one row group, PLAIN,
uncompressed): `node tests/fixtures/cut.mjs <measurements.parquet> 66514 <out>`. 140,466 bytes, SHA-256
`d86739e7861add4d587fb15a3b6056bd95edc237eba2c5ade820fa78e67b315f`.

## `station-11.json` (real)

`stations/station-11.json` of the same generation, verbatim (9,761 bytes, SHA-256
`690a3466c2d94d60dc6ab6418934f4d3e85d1c6e671669f0b4edfc68a29fdb82`): the station's site, name, declared timing and licence.

## Terms

CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/), as the network's data page and every dump manifest state. Credit:
SatNOGS Optical contributors - https://optical.satnogs.org - CC BY-SA 4.0. These two files remain under CC BY-SA 4.0.
