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
  The requested v1 product remains explicitly listed; a v2 listing does not
  change this task's selected edition.

ESA credit: © ESA WorldCover project 2021 / Contains modified Copernicus Sentinel
data (2021) processed by ESA WorldCover consortium.

Canopy citation/attribution will preserve the registry's dataset citation and
source-imagery credit, and identify the retrieval date. The code/model license
in HighResCanopyHeight is separate from the map's CC BY 4.0 license.

## SDS fit check in progress

`DTT` has a `LAND_COVER` attachment but requires a terrain-elevation `PAYLOAD`.
Its raster formats explicitly describe elevation samples. A standalone class
map cannot silently be relabeled elevation. A canopy height relative to local
ground likewise must remain distinguishable from terrain height above a datum.
`TRN` configures terrain; `GDI` describes imagery files without a typed raster
payload; `SCV`/`CVG` describe sensor-coverage products; `TRS` is an RF solve.
The final ruling and any proposed additive schema will be recorded here before
publication work proceeds. No SDS files are edited in this lane.
