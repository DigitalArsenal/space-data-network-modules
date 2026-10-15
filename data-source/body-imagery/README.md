# Body imagery (NASA and USGS global mosaics)

SDN data retrieval module for the imagery the console draws on planets, moons
and asteroids, run on a provider node by the flow
`com.digitalarsenal.flows.body-imagery-ingest` (stack
`deployment/solar-system-provider-node`). Each built file is added to the
node's IPFS (pinned) and announced as one `$PNM`, auto-published as `PNM.fbs`,
provider `usgs-astrogeology`, source `body-imagery`. It replaces
`propagator/solar-system-bodies/tools/build-imagery.py` and the dataset CID.

Sources (the table is in `src/body_imagery.cpp`):
- 22 public global equirectangular GeoTIFFs (USGS Astrogeology, NASA SVS,
  NASA/JPL Photojournal): Mercury, Venus, the Moon, Mars, Phobos, Jupiter, Io,
  Europa, Ganymede, Callisto, Mimas (Cassini, PIA17214), Enceladus, Tethys,
  Dione, Rhea, Titan, Iapetus, Triton, Pluto, Charon, Ceres and Vesta;
- 3 cloud maps of the giant planets that have no surface mosaic: Saturn,
  Uranus and Neptune, Solar System Scope's 2048 x 1024 JPEG textures (made
  from NASA mission imagery; CC BY 4.0, credited per body). A JPEG source is
  read whole by the first range and decoded in the module (vendored
  stb_image 2.30, public domain/MIT, JPEG only, SHA-256 pinned in
  `build.mjs`).
- No licence-clear global map exists for Deimos or the Uranian moons (Voyager
  saw their southern hemispheres only): the console draws them in their
  colour.

| Stage | Asks for (HTTP ranges) |
| --- | --- |
| `plan_imagery` | the first MiB of every source (TIFF header and directory) |
| `advance_imagery` | directory arrays outside that MiB, then image data in whole strips or tile rows, at most three 48 MiB ranges per stage |
| `build_imagery` | nothing: per body a tile pack and a 2048 x 1024 texture, and `imagery/index.json` |
| `announce_imagery` | nothing: one `$PNM` per file from the host adapter's IPFS add results |

- Uncompressed and LZW (horizontal predictor) strips and tiles, chunky or
  planar. The GeoTIFF keys give the central meridian and the semi-major axis.
- Rows are converted from IAU planetocentric latitude to the planetodetic
  latitude of the engine's geographic tiling on the body's PCK ellipsoid
  (tan φd = (a/c)² tan φc), then area-averaged into the output as they arrive.
  A body holds only its output grid (4096 x 2048 at most).
- `tiles.pack` ("SDNTILE1"): the engine's GeographicTilingScheme, 2 x 1 tiles
  of 256 px at level 0, levels 0 to 3, baseline JPEG (quality 85). The engine
  reads it with `readBodyTilePack` and `imageryFromPublishedFiles`.
- A body whose source fails is left out and named in the job report; the
  others are published.
- Against the Phase-1 GDAL pyramid on the live sources, the mean difference
  is 1.7 to 5.8 of 255 (JPEG and resampling), with no offset.

Licence: NASA mission products, public domain (USGS Astrogeology, NASA SVS,
NASA/JPL Photojournal), NASA Dawn data with its mission credit, and the Solar
System Scope textures under CC BY 4.0 with their credit. Each
body's credit and licence ride in `imagery/index.json` and the ingest meta.

```sh
npm install && npm run build && npm test
SDN_RUN_IMAGERY_PARITY=1 node --test tests/parity.test.mjs   # browser, WasmEdge, container WasmEdge
```
