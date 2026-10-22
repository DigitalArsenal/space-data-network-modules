# Land-cover and canopy source investigation

Task: `landcover-canopy-data-source-20261022`; agent: `codex-landcover`.

Status: WIP. Source verification and the mandatory SDS fit check precede
implementation. No module, numerical parity, CID round-trip, or gauntlet pass is
claimed by this checkpoint.

## Contracts read

- Stack design principles, component-development layer, and SDS oracle definition.
- Module repository AGENTS.md and README.md.
- SDK AGENTS.md and browser/WasmEdge isomorphic artifact contract.
- Existing `gibs`, `terrain-source`, `retrieval`, and `body-imagery-tiles` patterns.

The supplied nested SDS schema path does not exist in this checkout. The actual
schema tree is `schema/` at SDS commit
`2c1f01ddceda11b2f538c80e33d8fa1a3fcb813e`.

## Live sources checked, 2026-10-22

- [ESA AWS registry](https://registry.opendata.aws/esa-worldcover-vito/):
  `esa-worldcover`, `eu-central-1`, CC-BY 4.0.
- [ESA data access](https://esa-worldcover.org/en/data-access):
  `v200/2021/map/`, 3-by-3-degree EPSG:4326 COG tiles, 11 classes.
- [Meta/WRI AWS registry](https://registry.opendata.aws/dataforgood-fb-forests/):
  `s3://dataforgood-fb-data/forests/v1/alsgedi_global_v6_float/`,
  `us-east-1`; license field is `https://creativecommons.org/licenses/by/4.0/`.
  The requested v1 product remains explicitly listed. The selected maps are
  under the `chm/` subdirectory of that prefix.

ESA credit: © ESA WorldCover project 2021 / Contains modified Copernicus Sentinel
data (2021) processed by ESA WorldCover consortium.

Canopy credit: Meta and WRI, High Resolution Canopy Height Maps (2024).
Source imagery for CHM © 2016 Maxar. Accessed October 22, 2026.
The registry's license field is exactly
`https://creativecommons.org/licenses/by/4.0/`. The Apache-2.0 code/model
license in HighResCanopyHeight is separate from the map's CC BY 4.0 license.

## Source preflight measured after recovery

`python3 data-source/landcover-canopy/tests/source-preflight.py --scratch <durable-directory>`
passed with GDAL 3.13.3. The earlier EHdr extraction failed; direct XYZ output
from `gdal_translate -srcwin` succeeded without resampling or scaling.
See `tests/evidence/source-preflight.json` for URLs, ETags, source metadata,
pixel windows, retrieval time, and SHA-256 values.

| Source tile | Native window | Samples | Values | GDAL layout |
| --- | --- | ---: | --- | --- |
| WorldCover N00E006 | x=8760, y=32040, 16×16 | 256 | 10, 30, 50 | Byte; 1024×1024 blocks; DEFLATE; COG |
| Canopy 001311332 | x=32760, y=32760, 16×16 | 256 | 0 | Byte; 65536×1 strips; DEFLATE; predictor 2 |
| Canopy 023001111 | x=32760, y=32760, 16×16 | 256 | 11–17 | Byte; 65536×1 strips; DEFLATE; predictor 2 |

All three source probes returned HTTP 206 for bytes 0–1023 and matched their
ETags after the GDAL reads. This is **three source windows / 768 samples**, not
module parity or the requested 20-tile E2E. No dataset was mirrored.

WorldCover codes are dimensionless on EPSG:4326, observation interval
2021-01-01T00:00:00Z through 2021-12-31T23:59:59Z; its NoData code is 0.
The inspected canopy files state meters on EPSG:3857 and have no TIFF NoData
tag or observation epoch. Zero must not be silently recast as missing.
The registry advertises companion GeoJSON observation dates; these have not
been inspected. The `float` prefix does not determine the sample type.
The two inspected canopy files are striped TIFFs, and GDAL reports no COG
layout marker. Future range planning must support their actual compressed
strips rather than assuming square COG blocks. This observation is limited
to these files, not a claim about the entire product.

## SDS fit check in progress

`DTT` has a `LAND_COVER` attachment but requires a terrain-elevation `PAYLOAD`.
Its raster formats explicitly describe elevation samples. A standalone class
map cannot silently be relabeled elevation. A canopy height relative to local
ground likewise must remain distinguishable from terrain height above a datum.
`TRN` configures terrain; `GDI` describes imagery files without a typed raster
payload; `SCV`/`CVG` describe sensor-coverage products; `TRS` is an RF solve.
The final ruling and any proposed additive schema will be recorded here before
publication work proceeds. No SDS files are edited in this lane.
