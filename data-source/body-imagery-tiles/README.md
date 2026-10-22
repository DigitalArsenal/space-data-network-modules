# body-imagery-tiles

A body's high-definition global imagery as the console's tile pyramid, in the files the engine's `imageryFromTileFiles` reads for the Moon (`data-source/moon-imagery`). First source: Mars, the USGS Astrogeology THEMIS Day IR global mosaic 100 m v12 (NASA/JPL/ASU, public domain), planetocentric on the 3396190 m MOLA sphere. Level 9 (81.4 m/px at the equator) is the deepest.

Served from R2 bucket `spaceaware` through https://terrain.spacedatanetwork.org (CORS on); no node, no IPFS.

```
imagery/499/root.dtts                    levels 0-2 (42 tiles)
imagery/499/<L>/<x/16>_<row from south>.dtts   16 tiles of one row, levels 3-9
imagery/499/MANIFEST.json                credit, licence, source edition, files/bytes per level, ledger digest
```

Each file is a size-prefixed `$DTT` stream (`[u32 LE length][record]`); one record per 256 px baseline JPEG tile (`GEOGRAPHIC_TWO_ROOT_BODY`, `PAYLOAD_FORMAT CUSTOM`, `image/jpeg`, quality 88, grayscale, 0 = no data).

## Module (pure transforms, WASM, single thread)

- `tiles_plan`: level-9 tile row -> the whole-row byte range of the mosaic (`If-Match` on its ETag) and the unit.
- `tiles_direct`: unit + the range's `HttpResponse` -> the row's 1024 tiles in 64 files (area average of the measured source pixels).
- `tiles_reduce`: level L row from the two child rows' files (JPEG decode, 2 x 2 mean of the measured pixels, JPEG); level 2 builds `root.dtts` from level 3.

## Tools

- `tools/encode.mjs --out DIR --level 9 --workers 4` (then `--level 8..3 --children DIR`, `--level 2`): resumable, byte-identical at any worker count, `DIR/ledger.jsonl` of path/bytes/sha256/md5.
- `tools/publish.mjs`: `aws s3 sync` of a level and its verification against the bucket listing (size and ETag = ledger md5), then `--manifest`. `R2_AWS` names the command that runs `aws` against the bucket.
- `tests/themis.e2e.test.mjs`: the module against GDAL's own read of the source (SSIM, 20 IAU features, layout, pyramid); `THEMIS_VERIFY_R2=1` adds the bucket and live-HEAD checks.

Build: `node build.mjs`.
