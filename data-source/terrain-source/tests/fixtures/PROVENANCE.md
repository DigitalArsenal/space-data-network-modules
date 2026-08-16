# Fixture provenance

The terrain tests carry **no committed binary fixtures**: every DEM granule
under test is a **synthetic GeoTIFF built programmatically at test time** by
`tests/helpers.mjs` (`buildGeoTiff`), and the tests never touch the network.

## Why synthetic, when the geonames lane insists on verbatim slices

The geonames fixtures exist to pin a *live server's* column contract, which a
hand-written fixture cannot refute. Here the artifact under test is the
opposite kind: the input contract is the **TIFF 6.0 / BigTIFF byte format
itself** (a published spec, not a server's habit), and the property the tests
must be able to fail is the *decoder's arithmetic* — DEFLATE chunks, the
floating-point predictor's byte-plane unshuffle, tile-vs-strip assembly,
georeferenced bilinear sampling, quantized-mesh encoding. A generated granule
whose every height is a known closed-form function (`h = 100 + px + 2·py`, a
plane, exact in float32) is *stronger* than a real crop for that purpose: the
expected value at every post is computable independently, so a one-bit
predictor bug or a half-pixel georeference shift fails an equality instead of
sliding under a tolerance tuned to real-terrain noise.

What the synthetic granules deliberately reproduce from the real source
granules (verified against live Copernicus GLO-30 COG headers, 2026-08-15):
little-endian classic TIFF, single-band Float32 (`BitsPerSample 32`,
`SampleFormat 3`), `Compression 8` (zlib-wrapped DEFLATE), predictor 1 **and**
predictor 3 (floating-point), tiled and strip layouts,
`ModelTiepoint`/`ModelPixelScale` georeferencing, and the dataset's stated
`NO_DATA` value **-32767**.

Deferred to a live-granule integration pass (recorded, not hidden): BigTIFF
headers (the reader supports them; no fixture exercises them yet) and a real
1201×1201 GLO-30 crop as an end-to-end regression anchor.

## Licence terms carried in the tests

The provenance strings the tests assert ride **verbatim** are the source
dataset's own terms, verified 2026-08-15:

- `LICENSE`: `Licence for Copernicus DEM instance COP-DEM-GLO-30-F`
- `LICENSE_URL`:
  <https://docs.sentinel-hub.com/api/latest/static/files/data/dem/resources/license/License-COPDEM-30.pdf>
- `ATTRIBUTION`: `produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014
  and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by
  the European Union and ESA; all rights reserved`
- Source URL pattern (unauthenticated S3, `eu-central-1`, bucket
  `copernicus-dem-30m`):
  `Copernicus_DSM_COG_10_<lat>_<lon>_DEM/Copernicus_DSM_COG_10_<lat>_<lon>_DEM.tif`
  (water-body mask beside it under `AUXFILES/…_WBM.tif`, the future
  `WATER_MASK_PROVENANCE` source).

The obligation is discharged at runtime the same way every other provider's
is: the plan frame carries these strings and the module writes them into
`$DTT.PROVENANCE` on **every** record, because the standard names no dataset
and the credit line therefore has to live in the data.
