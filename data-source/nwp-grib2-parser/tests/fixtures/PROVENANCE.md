# nwp-grib2-parser fixtures

## noaa-2026100600-f024/ — real NOAA GRIB2 messages

GRIB2 messages of the 2026-10-06 00 UTC runs at lead 24 h, fetched unchanged from NOAA Open Data Dissemination's public
buckets by HTTP range through each file's `.idx` inventory (as the source node fetches them). `inventory.json` names
each file's URL and the inventory lines taken.

| file | product | messages |
| --- | --- | --- |
| `gfs-1p00-motion.grib2` | GFS 1° `pgrb2.1p00` | HGT, UGRD, VGRD at 500 and 850 hPa |
| `gefs-0p50-spread.grib2` | GEFS 0.5° ensemble spread `gespr ... pgrb2a.0p50` | UGRD, VGRD at 500 hPa (published at every other point, the 1° grid's) |
| `gfs-0p50-clouds.grib2` | GFS 0.5° `pgrb2.0p50` | TCDC entire atmosphere, LCDC/MCDC/HCDC cloud layers - instantaneous ("24 hour fcst", not the interval means) |
| `gfs-0p25-surface.grib2` | GFS 0.25° `pgrb2.0p25` | TMP 2 m above ground (published in 64-row bands) |

All are complex packing with spatial differencing (template 5.3), as GFS/GEFS publish nearly every field. Licence:
NOAA/NCEP model output via NODD, open to the public (https://www.weather.gov/disclaimer).

`jobs.json` holds the job attributes the source node emits for each product (model key and id, class, stride, bands,
spread).

## expected.json — the independent reference

Written by `generate-expected.py` with ecCodes (ECMWF's GRIB library; eccodes 2.x Python bindings, numpy 2.5.3): every
message read by ecCodes, the packing integer of each grid point recovered from its value exactly
(X = (v·10^D − R)/2^E), laid out as the parser publishes it (rows south to north, every `stride`-th point), and kept as
the SHA-256 of those little-endian uint16 codes plus 64 sampled points; the record names come from ecCodes' own
`shortName`/`typeOfLevel`/`level` keys, the scale and offset from its reference value and scale factors (×1/100 for the
cloud percentages). Rerunning it leaves `git diff` clean.

Tolerance: none - every code must equal ecCodes' integer. The parser's reader (grib2mini) was also checked against
ecCodes on 91 messages (GFS 1/0.5/0.25°, GEFS spread, bitmapped land/sea fields with 1.8 million missing points) in
DigitalArsenal/Cesium_Weather `orbpro-gaussian-clouds/native/grib2mini/compare_eccodes.py`: every integer equal.
