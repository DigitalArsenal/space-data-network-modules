#!/usr/bin/env python3
"""A giant planet's cylindrical map as the module's source: RGB planes, planetocentric latitude, east longitude from 0 at the left.
   python3 -I giant-derive.py --src map.tif --out derived.tif --a-km 71492 --b-km 66854 --grid point|area --lon-step-deg 0.1
The OPAL and Cassini maps carry planetographic latitude and System III west longitude decreasing to the right (left edge 0 E).
Each output pixel (area, W = 360 / step columns, W / 2 rows, planetocentric rows) bilinearly samples the map at
tan(phi_graphic) = (a / b)^2 tan(phi_centric); `point` maps (721 x 361, 3601 x 1801: samples on the grid lines) are read at lon / step,
`area` maps (1800 x 900) at lon / step - 0.5. This is the only resampling before the module's own area average."""
import argparse, math
import numpy as np
from osgeo import gdal
gdal.UseExceptions()
ap = argparse.ArgumentParser()
for k in ('src', 'out', 'grid'): ap.add_argument('--' + k, required=True)
ap.add_argument('--a-km', type=float, required=True); ap.add_argument('--b-km', type=float, required=True); ap.add_argument('--lon-step-deg', type=float, required=True)
a = ap.parse_args()
img = gdal.Open(a.src).ReadAsArray().astype(np.float32)          # (3, H, W)
_, H, W = img.shape
step = a.lon_step_deg; Wo = int(round(360 / step)); Ho = Wo // 2
ncol = Wo if a.grid == 'point' else W                                 # point maps repeat the seam column: drop it
off = 0.0 if a.grid == 'point' else 0.5
lon = (np.arange(Wo) + 0.5) * 360.0 / Wo
fc = lon / step - off
phic = np.radians(90.0 - (np.arange(Ho) + 0.5) * 180.0 / Ho)
phig = np.degrees(np.arctan((a.a_km / a.b_km) ** 2 * np.tan(phic)))
fr = (90.0 - phig) / step - off
fr = np.clip(fr, 0, H - 1)
r0 = np.floor(fr).astype(int); r1 = np.minimum(r0 + 1, H - 1); wr = (fr - r0).astype(np.float32)[:, None]
c0 = np.floor(fc).astype(int); wc = (fc - c0).astype(np.float32)[None, :]
c0m = np.mod(c0, ncol); c1m = np.mod(c0 + 1, ncol)
out = np.empty((3, Ho, Wo), np.uint8)
for b in range(3):
    top = img[b][r0][:, c0m] * (1 - wc) + img[b][r0][:, c1m] * wc
    bot = img[b][r1][:, c0m] * (1 - wc) + img[b][r1][:, c1m] * wc
    out[b] = np.clip(np.rint(np.maximum(top * (1 - wr) + bot * wr, 1)), 1, 255).astype(np.uint8)
R = a.a_km * 1000.0; px = R * math.pi / 180 * 360.0 / Wo
d = gdal.GetDriverByName('GTiff').Create(a.out, Wo, Ho, 3, gdal.GDT_Byte, ['COMPRESS=NONE', 'TILED=NO', 'BLOCKYSIZE=1', 'INTERLEAVE=BAND'])
d.SetGeoTransform((0.0, px, 0.0, Ho * px / 2, 0.0, -px))
for b in range(3): d.GetRasterBand(b + 1).WriteArray(out[b])
d = None
print(a.out, Wo, Ho)
