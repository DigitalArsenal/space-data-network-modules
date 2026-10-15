# files/geotiff

GeoTIFF and Cloud-Optimized GeoTIFF images as globe imagery (owner 2026-10-13:
"add arbitrary imagery layers as well").

| method | in | out |
| --- | --- | --- |
| `describe` | `descriptor`, `ranges` | `info`: one size-prefixed `$GDI` (FORMAT GEOTIFF, EPSG:4326 footprint polygon, source EPSG in KEYWORDS); `levels`: the level table |
| `render` | `descriptor`, `ranges`, `request` (window in EPSG:4326, size, stretch) | `image`: RGBA; `stats`: the stretch used |

Either method answers on `need` instead when the bytes it was given do not
cover what it reads: float64 `(offset, length)` pairs, merged across gaps up to
64 KiB. The caller fetches them (HTTP `Range` for a URL, a slice for a local
file) and calls again. A COG's header is in its first 16 KiB, so a layer costs
one header fetch and then one fetch of the tiles each window needs.

Both methods take `descriptor`, a size-prefixed SDS `$NCD` (FORMAT
`PROVIDER_DEFINED`, name `GeoTIFF`; `SOURCE_BYTE_LENGTH`, when stated, is the
file's size), and `ranges`, the pieces of the file the caller has:
`[u32le count]` then per range `[u64le offset][u32le length][bytes]`. `info`
is an SDS `$GDI` FlatBuffer. `ranges`, `request`, `need`, `levels`, `stats`
and `image` have no SDS identity and travel on the SDK's raw lane (wildcard
ports with a stated media type). Port layouts are in `plugin-manifest.json`.

- **Structure**: classic TIFF and BigTIFF, little- and big-endian; tiles or
  strips; chunky or planar bands; the full image and its reduced levels
  (overviews); internal masks (`NewSubfileType` 4) used as alpha.
- **Compression**: none, LZW, PackBits, DEFLATE (vendored miniz 3.1.2
  inflate), JPEG with `JPEGTables` (vendored stb_image 2.30). LERC, LZMA,
  ZSTD, WebP and JPEG XL are refused by name.
- **Samples**: 8-, 16- and 32-bit integers and 32-bit floats, horizontal (2)
  and floating-point (3) predictors; gray (either polarity), RGB, YCbCr in
  JPEG and palette; extra-sample alpha; GDAL no-data. Data that is not 8-bit
  draws through a linear stretch: stated per band, or the window's 2-98 %
  (reported on `stats` so a layer can pin it for every tile).
- **Georeferencing**: `ModelTransformation`, or tie point + pixel scale
  (PixelIsPoint shifted half a pixel); EPSG:4326 (4269 and 4258 read as it),
  Web Mercator (3857, 900913, 3785, 102100, 102113), UTM on WGS84 (326xx,
  327xx) and GRS80 (NAD83 269xx, ETRS89 258xx). Transverse Mercator is
  Krüger's series to sixth order (Karney 2011), forward and inverse. Other
  codes are refused by name.
- **Resampling**: per output pixel, the window's geographic point projected
  into the file, nearest neighbour, from the coarsest level at least as fine
  as the window's pixels.

Build: `npm ci && node build.mjs`. Tests: `node --test tests/*.test.mjs`. Every
fixture is written by GDAL and every expectation is GDAL's own exact warp of
it (`tests/make-fixtures.py`, run with GDAL 3.13 and PROJ 9).
