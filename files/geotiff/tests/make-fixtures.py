"""Fixtures and references for tests/geotiff.test.mjs, made with GDAL (the
independent reference): each fixture is written by GDAL's GTiff/COG drivers,
and each reference window is GDAL's own warp of it to EPSG:4326 (gdal.Warp,
nearest neighbour, exact per-pixel transform (errorThreshold=0), the same
window and size the test asks the module for).

    python3 -I tests/make-fixtures.py tests/fixtures
"""
import json
import sys
import numpy as np
from osgeo import gdal, osr

gdal.UseExceptions()
out = sys.argv[1]
W, H = 512, 384


def pattern(bands, dtype, scale=1.0, offset=0.0):
    y, x = np.mgrid[0:H, 0:W]
    planes = [
        (x * 255.0 / (W - 1)),
        (y * 255.0 / (H - 1)),
        (((x // 32 + y // 32) % 2) * 200.0 + 30.0 + np.sin(x / 9.0) * 20.0),
        np.full((H, W), 255.0),
    ]
    data = [(planes[b] * scale + offset).astype(dtype) for b in range(bands)]
    return data


def srs(epsg):
    s = osr.SpatialReference()
    s.ImportFromEPSG(epsg)
    return s.ExportToWkt()


def mem(bands, gdt, data, epsg, gt, nodata=None, ct=None, photometric_rgb=False):
    ds = gdal.GetDriverByName("MEM").Create("", W, H, bands, gdt)
    ds.SetGeoTransform(gt)
    ds.SetProjection(srs(epsg))
    for b in range(bands):
        band = ds.GetRasterBand(b + 1)
        band.WriteArray(data[b])
        if nodata is not None:
            band.SetNoDataValue(nodata)
    if ct is not None:
        ds.GetRasterBand(1).SetRasterColorTable(ct)
    if bands == 4:
        ds.GetRasterBand(4).SetColorInterpretation(gdal.GCI_AlphaBand)
    return ds


GEO = (-77.3, 0.5 / W, 0, 39.0, 0, -0.3 / H)
MERC = (-8605000.0, 55000.0 / W, 0, 4720000.0, 0, -41000.0 / H)
UTM33 = (420000.0, 30.0, 0, 5320000.0, 0, -30.0)
UTM18S = (300000.0, 60.0, 0, 8650000.0, 0, -60.0)

cases = []


def write(name, ds, driver, options, window, request_stretch=None):
    path = f"{out}/{name}.tif"
    gdal.GetDriverByName(driver).CreateCopy(path, ds, options=options)
    west, south, east, north, w, h = window
    warped = gdal.Warp("", path, format="MEM", dstSRS="EPSG:4326", outputBounds=(west, south, east, north), width=w, height=h,
                       resampleAlg="near", dstAlpha=True, errorThreshold=0)
    arrays = [warped.GetRasterBand(b + 1).ReadAsArray().astype(np.float64) for b in range(warped.RasterCount)]
    alpha = arrays[-1] > 0
    color = arrays[:-1]
    src = gdal.Open(path)
    ct = src.GetRasterBand(1).GetColorTable()
    if ct is not None:
        lut = np.array([ct.GetColorEntry(i)[:3] for i in range(ct.GetCount())], dtype=np.float64)
        idx = color[0].astype(int)
        rgb = [lut[idx, k] for k in range(3)]
    elif len(color) >= 3:
        rgb = color[:3]
    else:
        rgb = [color[0]] * 3
    if request_stretch:
        rgb = [np.round(np.clip((rgb[k] - request_stretch[2 * min(k, len(color) - 1)]) /
                                 (request_stretch[2 * min(k, len(color) - 1) + 1] - request_stretch[2 * min(k, len(color) - 1)]), 0, 1) * 255) for k in range(3)]
    rgba = np.zeros((h, w, 4), dtype=np.uint8)
    for k in range(3):
        rgba[..., k] = np.where(alpha, rgb[k], 0).astype(np.uint8)
    rgba[..., 3] = np.where(alpha, 255, 0)
    rgba.tofile(f"{out}/{name}.rgba")
    cases.append({"name": name, "window": window, "stretch": request_stretch})


rgb = pattern(3, np.uint8)
win_geo = [-77.25, 38.75, -76.85, 38.97, 160, 96]
write("rgb-4326-jpeg-cog", mem(3, gdal.GDT_Byte, rgb, 4326, GEO), "COG", ["COMPRESS=JPEG", "QUALITY=95", "BLOCKSIZE=128"], win_geo)
write("rgb-4326-lzw-cog", mem(3, gdal.GDT_Byte, rgb, 4326, GEO), "COG", ["COMPRESS=LZW", "PREDICTOR=YES", "BLOCKSIZE=128"], win_geo)
write("rgb-3857-deflate-cog", mem(3, gdal.GDT_Byte, rgb, 3857, MERC), "COG", ["COMPRESS=DEFLATE", "PREDICTOR=YES", "BLOCKSIZE=128"],
      [-77.25, 38.75, -76.85, 38.97, 160, 96])
u16 = pattern(1, np.uint16, scale=40.0, offset=1000.0)
write("u16-32633-deflate-pred2", mem(1, gdal.GDT_UInt16, u16, 32633, UTM33), "GTiff", ["COMPRESS=DEFLATE", "PREDICTOR=2", "TILED=YES", "BLOCKXSIZE=128", "BLOCKYSIZE=128"],
      [13.95, 47.86, 14.12, 47.99, 128, 96], [2000.0, 9000.0, 0, 0, 0, 0])
f32 = pattern(1, np.float32, scale=0.5, offset=-20.0)
f32[0][10:60, 10:60] = -9999.0
write("f32-4326-pred3-bigendian", mem(1, gdal.GDT_Float32, f32, 4326, GEO, nodata=-9999.0), "GTiff",
      ["COMPRESS=DEFLATE", "PREDICTOR=3", "ENDIANNESS=BIG", "TILED=YES", "BLOCKXSIZE=256", "BLOCKYSIZE=256"], win_geo, [0.0, 100.0, 0, 0, 0, 0])
ct = gdal.ColorTable()
for i in range(256):
    ct.SetColorEntry(i, ((i * 7) % 256, (i * 13) % 256, 255 - i, 255))
pal = [(pattern(1, np.uint8)[0] // 4).astype(np.uint8)]
write("palette-4326-packbits-strips", mem(1, gdal.GDT_Byte, pal, 4326, GEO, ct=ct), "GTiff", ["COMPRESS=PACKBITS", "BLOCKYSIZE=7"], win_geo)
rgba = pattern(4, np.uint8)
rgba[3][:, :64] = 0
write("rgba-32718-bigtiff-planar", mem(4, gdal.GDT_Byte, rgba, 32718, UTM18S), "GTiff",
      ["COMPRESS=DEFLATE", "BIGTIFF=YES", "INTERLEAVE=BAND", "TILED=YES", "BLOCKXSIZE=128", "BLOCKYSIZE=128"], [-76.85, -12.45, -76.6, -12.25, 128, 96])
write("rgb-mask-32633-jpeg-cog", mem(4, gdal.GDT_Byte, rgba, 32633, UTM33), "COG", ["COMPRESS=JPEG", "QUALITY=95", "BLOCKSIZE=128"],
      [13.92, 47.91, 14.15, 48.04, 128, 96])
gdal.GetDriverByName("COG").CreateCopy(f"{out}/rgb-webp-cog.tif", mem(3, gdal.GDT_Byte, rgb, 4326, GEO), options=["COMPRESS=WEBP"])
json.dump(cases, open(f"{out}/cases.json", "w"), indent=1)
print(json.dumps([c["name"] for c in cases]))
