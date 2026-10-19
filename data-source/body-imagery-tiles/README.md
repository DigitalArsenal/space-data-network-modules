# data-source/body-imagery-tiles

High-resolution global imagery of a body as a 256 px JPEG tile pyramid,
made on a provider node and published over SDN.

| Source | Publication (schema, provider, source) | Levels |
| --- | --- | --- |
| Mars THEMIS Day IR global mosaic 100 m v12 (USGS Astrogeology; NASA/JPL/ASU, public domain) | `PNM.fbs`, `usgs-astrogeology`, `mars-themis-day-ir` | 0-9 (L9 = 81.4 m/px, 1.23 x the source) |

- **Tiling.** The engine's GeographicTilingScheme on the body's sphere:
  2^(L+1) x 2^L tiles of 256 px, x from 180 W, y from the north pole,
  planetocentric latitude (the console draws Mars on the MOLA sphere).
- **Pixels.** Level 9 is the area average of the source pixels each output
  pixel overlaps (0 is no data and is left out). Every coarser level is the
  2 x 2 mean of the level below, so every level is the source's area average,
  from one read of the source.
- **Files.** `imagery/499/themis-day-ir/<L>/<y>_<x/16>.pack`: 16 tiles of one
  row in the `SDNTILE1` layout the engine's `readBodyTilePack` reads, JPEG
  quality 88 (13.5 KB a tile, SSIM 0.983 against the source on 576 test
  tiles). Each pack is added to the node's IPFS and is one `$PNM`.
- **Cycle.** `retrieve_tiles` reads the source by HTTP range, one whole-row
  range per level-9 tile row (If-Match on the file's ETag; the header and
  every strip offset are checked against `src/source.hpp`). A band is one
  level-5 tile row (16 level-9 rows, 1,364 files); each band's `$PNM`
  records are one `storage.ingest_with_source` batch. The body is 32 bands,
  22.8 GB of source read once; levels 0-4 complete with the bands that end
  their rows. The cycle is yearly: the mosaic is a fixed release.

Configuration (`plugin.getConfig`): `body_imagery_tiles_enabled`,
`body_imagery_tiles_producer_peer_id`, `body_imagery_tiles_source_url`
(default the USGS file), `body_imagery_tiles_bands` (level-5 rows; empty is
all 32), `body_imagery_tiles_quality` (88).

## Build and test

```sh
npm install && node build.mjs
SDN_NODE_BINARY=<sdn built from main> SDN_JS=<sdn-js with dist/ from main> node --test tests/themis.e2e.test.mjs
```

The E2E runs a local provider node over one band through a caching range
proxy, reads the lane over SDN as a consumer does, and checks the band's
files, the pack layout, 24 level-9 tiles against GDAL's own area average of
the source (SSIM, registration shift 0), the level-6 pyramid, and the node's
peak RSS (2 GB or less).

Credit: THEMIS: NASA/JPL/ASU (Christensen et al. 2004; Edwards et al. 2011,
JGR 116, E10008); mosaic USGS Astrogeology. Public domain.
