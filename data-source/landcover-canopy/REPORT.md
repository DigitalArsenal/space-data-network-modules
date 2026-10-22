# Land-cover and canopy source investigation

Task: `landcover-canopy-data-source-20261022`; agent: `codex-landcover`.

Status: source preflight preserved; **LACK for a standalone typed SDS raster**.
The typed raster publication part stops at the user's schema boundary. No
module, numerical parity, CID round-trip, or gauntlet pass is claimed. PNM file
announcements are a valid existing alternative, discussed below; this report
does not claim that SDS cannot distribute GeoTIFF files.

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

## SDS fit check

Applied the stack's `.claude/agents/sds-oracle.md` consultation definition to
the IDL directly. This is a source consultation, not a separate oracle agent
session or an AMEND. All paths below are relative to the SDS repository.

```text
THEMIS/CONSULT
VERDICT: LACK (standalone typed land-cover / canopy-height raster)
EVIDENCE: schema/DTT/main.fbs:204,261,312; schema/GDI/main.fbs:15;
schema/PNM/main.fbs:6,38; schema/WXF/main.fbs:4,288.
VERSION: requester root pins 1.220.0; no landcover package pin exists.
DTT header is 1.190.0 at that tag, 1.191.0 in published 1.258.0 and
checkout 2c1f01ddceda11b2f538c80e33d8fa1a3fcb813e.
RULING: DTT's required elevation payload cannot be replaced by class codes
or canopy height above local ground; PNM can announce a GeoTIFF file but
does not itself define a typed raster product.
```

| Candidate | Fit and boundary |
| --- | --- |
| DTT | Required `PAYLOAD` is elevation bytes (261–262). `LAND_COVER` is an accompanying attachment (312–314), not a standalone tile. `CUSTOM` describes a payload encoding, not a new measured quantity. |
| GDI | Imagery-file metadata, including GeoTIFF format and region SRID (26–44); no typed sample quantity, native sample layout, or payload CID. |
| PNM | **HAVE for file publication**: `CID`, `FILE_NAME`, `FILE_ID` (38–53). GIBS uses it for an external WMTS document. Self-describing GeoTIFF windows could use this route if file publication satisfies the intended output contract. It does not supply SDS fields for classification, canopy height, grid geometry, or NoData semantics. |
| WXF | Weather field on regular latitude/longitude cells (4–16, 280–305), not a native EPSG:3857 canopy grid. Treating these source rasters as weather would change their meaning. |
| SCV / CVG | Sensor-coverage raster products / coverage figures of merit, not land cover or canopy. |
| TRN / TRS | Terrain configuration / radio-propagation solve, not this source artifact. |
| SKT | HEALPix celestial sky tiles, not an Earth raster. |

The examined `GDI`, `PNM`, `SCV`, `CVG`, and `TRN` IDL files are byte-identical
between the actual root's v1.220.0 tag, published 1.258.0, and the inspected
checkout. DTT's differences add planetary addressing, body radii, and horizon
angles; they do not remove the elevation requirement. Published 1.258.0's DTT
is byte-identical to the inspected checkout. A pin bump alone does not add the
missing typed raster semantics.

The existing body-imagery module uses DTT CUSTOM for JPEG imagery. That is a
useful range-planning implementation reference, but it cannot override the
canonical IDL's meaning. No such interpretation is copied into this lane.

## Proposed upstream schema (report only)

Propose an additive **Surface Raster Tile** record, with its short code and
file identifier left unassigned for the SDS owner to ratify after a collision
sweep. No local `.fbs`, generated bindings, or SDS edits are introduced.

| Proposed field/group | Type and required meaning |
| --- | --- |
| `DATASET_ID`, `DATASET_EDITION`, `SOURCE_ID` | Required strings: dataset/version and the exact source object's identity. Dataset names and class legends remain data, not provider-specific enum values. |
| `QUANTITY` | Required enum distinguishing categorical land cover from canopy height above local ground. Never terrain elevation. |
| `GRID_WIDTH`, `GRID_HEIGHT`, `SOURCE_X_OFFSET`, `SOURCE_Y_OFFSET` | Unsigned integers; exact native pixel window, upper-left origin, no resampling. |
| `CRS`, `AFFINE_TRANSFORM`, `PIXEL_REGISTRATION` | CRS authority string and six float64 coefficients mapping pixel-corner column/row to native coordinates; explicit area/point registration. Preserve EPSG:4326 or EPSG:3857 as supplied. |
| `SAMPLE_TYPE`, `UNITS` | Native scalar type and units; the inspected files are UInt8, class codes dimensionless and canopy meters. Future source changes must be rejected until the decoder supports their actual type. |
| `NO_DATA_VALUE` | Optional typed value, with absence distinct from zero. Preserve NaN if a future supported source uses it. |
| `CLASS_LEGEND` | Repeated code/label pairs, required for categorical rasters. WorldCover's 11 codes are 10,20,30,40,50,60,70,80,90,95,100; 0 is NoData. Preserve snow/ice and mangroves as well as the nine categories abbreviated in the task. |
| `PAYLOAD` | Existing generic `DTTPayloadRef` shape: CID-first lossless bytes, media type, size, digest; the upstream owner decides whether to reuse that table or factor its generic definition. |
| `PAYLOAD_ENCODING`, `BYTE_ORDER`, `ROW_ORDER` | Explicit GeoTIFF or native scalar raster encoding, sample byte order, and row-major order. No JPEG, palette conversion, interpolation, or rounding of samples. |
| `SOURCE_URL`, `SOURCE_ETAG`, `RETRIEVED_AT` | Replayable public URL, exact object version validator, RFC 3339 UTC retrieval timestamp. |
| `OBSERVATION_START`, `OBSERVATION_END` | Optional source-stated UTC observation interval. Do not invent a date from a version string or retrieval time. |
| `LICENSE`, `LICENSE_URL`, `ATTRIBUTION` | Source-stated redistribution terms and credit; required for publication. |

After that upstream contract exists, the module should use the retrieval
pattern: pure WASM parses TIFF/BigTIFF metadata, plans bounded ranges, decodes
only intersecting tiles/strips, preserves native samples and metadata, and emits
the canonical record. Generic host nodes fetch ranges and persist/publish by
CID. Do not introduce host-side GDAL into production. Require HTTP 206, exact
Content-Range and byte count, consistent ETag/If-Match, bounded metadata and
decompression, and fail closed on an unsupported layout or changed edition.

## Acceptance and verification ledger

| Requirement | Measured result |
| --- | --- |
| 20 sampled tiles equal independent GDAL | **0/20 module comparisons**. Preflight only: 3 source windows, 768 native samples; no module output exists. |
| Class codes and heights unchanged | Not established for a module. GDAL extraction performed no scaling, resampling, or reprojection; source facts and hashes are retained. Eventual comparison tolerance must be exactly zero because native samples must be preserved, not approximated. |
| Local-node CID readback | **0 round-trips**; no local node started and no records published. |
| SDK compatibility after build | Not run: no module/artifact built at the typed schema stop. |
| Browser / native WasmEdge parity | Not run: no module/artifact. |
| Docker WasmEdge parity | **Waived by owner, 2026-10-22**. Docker and Docker Desktop were never started. |
| Declared E2E | `node data-source/landcover-canopy/tests/landcover-canopy.e2e.mjs` is not implemented. The preflight is deliberately not substituted for it. |
| Gauntlet / receipt | **Not run; no receipt.** The user's prerequisite, passing E2E on the committed branch, has not been met. No PASS claimed. |

Resume requires settling the output contract: either publish the proposed
typed schema upstream first, or select the existing PNM + self-describing
GeoTIFF file-publication alternative. Neither an upstream schema release nor
the 20-tile module/CID E2E is completed by this report. The branch remains for
the coordinator; nothing was pushed to main and no graph state was changed.
