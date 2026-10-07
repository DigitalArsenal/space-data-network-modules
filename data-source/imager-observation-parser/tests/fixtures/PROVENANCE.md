# imager-observation-parser fixtures

## goes19-m1-2026280-0600/ — real GOES-19 ABI files

Five NetCDF4 files of GOES-19 ABI mesoscale sector 1, scan starting 2026-10-07 (day 280) 06:00:28.5 UTC, downloaded
unchanged from NOAA Open Data Dissemination's public bucket (anonymous, `https://noaa-goes19.s3.amazonaws.com/`):

| file | product | variable | field |
| --- | --- | --- | --- |
| `OR_ABI-L2-CMIPM1-M6C13_G19_s20262800600285_e20262800600354_c20262800600415.nc` | ABI-L2-CMIPM, band 13 (10.3 µm), 2 km | `CMI` | brightness_temperature_10um |
| `OR_ABI-L2-CMIPM1-M6C02_G19_s20262800600285_e20262800600343_c20262800600383.nc` | ABI-L2-CMIPM, band 2 (0.64 µm), 0.5 km | `CMI` | reflectance_064um (4 × 4 block mean first) |
| `OR_ABI-L2-ACHAM1-M6_G19_s20262800600285_e20262800600343_c20262800601039.nc` | ABI-L2-ACHAM | `HT` | cloud_top_height |
| `OR_ABI-L2-ACMM1-M6_G19_s20262800600285_e20262800600343_c20262800600453.nc` | ABI-L2-ACMM | `ACM` | cloud_mask (categories, published as their mean) |
| `OR_ABI-L2-ACTPM1-M6_G19_s20262800600285_e20262800600343_c20262800600488.nc` | ABI-L2-ACTPM | `Phase` | cloud_phase (the pixel nearest each cell centre) |

A mesoscale sector goes through exactly the code a full disk does (the fixed grid's scan angles and projection come
from the file); it keeps the fixtures at 2.4 MB. The flow fetches the full-disk products (`...F`).

Licence: NOAA data disseminated through NODD are open to the public (no restrictions on use); cited as "GOES-19 ABI
data courtesy of NOAA via NOAA Open Data Dissemination".

## expected.json and `<field>.<width>.codes.gz` — the independent reference

Written by `generate-expected.py` with the reference producer, `orbpro-gaussian-clouds/tools/raw_satellite.py` in
DigitalArsenal/Cesium_Weather (commit 6c672cc; Python 3.14, numpy 2.5.3, netCDF4 for the reads): its `world_product`,
`world_level` and `quantize` on each file. The codes are the whole world rows of every width (rows 704–832 at 4096,
little-endian, gzip with mtime 0); `expected.json` holds the record attributes. Rerunning the script leaves `git diff`
clean.

Tolerance: none. The parser ports those formulas operation for operation (numpy's float32/float64 promotions and its
block-sum order included), so every code must equal the reference's. Beyond these fixtures the same comparison was run
on full-disk files (cached GOES-18 and GOES-19 ABI F products, 2026-09-26/30): every field, 4096/2048/1024 — natively
for all eight fields on both satellites, and with this compiled wasm on GOES-19 for brightness temperature, cloud-top
height, cloud mask, cloud phase and reflectance (its 143 MB file fetched as two byte ranges) — 0 codes differing in
~9.6 million cells each (wasm: 6.5-7 s a 2 km field, 15 s the 0.5 km band).
