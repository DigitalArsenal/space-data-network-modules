#!/usr/bin/env python3
"""Range-read one bounded window, with a shared halo for deterministic radiometry.

No source is mirrored locally. GDAL handles tiled DEFLATE Int16 CTX COGs and
strip TIFF Moon mosaics. Output is north-first grayscale for tiles_window.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import urllib.request

import numpy as np
from osgeo import gdal

gdal.UseExceptions()
gdal.SetCacheMax(64 * 1024 * 1024)
for k, v in {"GDAL_DISABLE_READDIR_ON_OPEN": "EMPTY_DIR", "GDAL_HTTP_MAX_RETRY": "5",
             "GDAL_HTTP_RETRY_DELAY": "2", "GDAL_NUM_THREADS": "1",
             "CPL_VSIL_CURL_CACHE_SIZE": "33554432"}.items():
    gdal.SetConfigOption(k, v)
SOURCES = json.loads(Path(__file__).with_name("hd-sources.json").read_text())


def box(a, radius=16):
    for axis in (0, 1):
        pad = [(0, 0), (0, 0)]
        pad[axis] = (radius, radius)
        p = np.pad(a, pad, mode="edge")
        p = np.cumsum(p, axis=axis, dtype=np.float64)
        z = [(0, 0), (0, 0)]
        z[axis] = (1, 0)
        p = np.pad(p, z)
        n = 2 * radius + 1
        a = (np.take(p, range(n, p.shape[axis]), axis=axis) -
             np.take(p, range(p.shape[axis] - n), axis=axis)) / n
    return a


def smooth(a):
    for _ in range(3):
        a = box(a)
    return a


def read(url, etag, bounds, width, height, radius):
    # The validator is attached to every GDAL range request, not just HEAD.
    gdal.SetConfigOption("GDAL_HTTP_HEADERS", f'If-Match: "{etag}"')
    d = gdal.Open("/vsicurl/" + url)
    target = f"+proj=longlat +a={radius} +b={radius} +no_defs"
    w = gdal.Warp("", d, format="MEM", dstSRS=target, outputBounds=bounds,
                  width=width, height=height, resampleAlg="bilinear",
                  outputType=gdal.GDT_Float32, dstNodata=float("nan"),
                  multithread=False, warpMemoryLimit=64, overviewLevel="NONE")
    return w.ReadAsArray().astype(np.float64)


def head(url):
    with urllib.request.urlopen(urllib.request.Request(url, method="HEAD")) as r:
        return r.headers["ETag"].strip('"')


def prepare(source, level, row, x, count, out, stretch=None):
    s = SOURCES[source]
    if not (s["minLevel"] <= level <= s["maxLevel"] and 0 <= row < 2**level and
            1 <= count <= 16 and 0 <= x < x + count <= 2**(level + 1) and x//16 == (x+count-1)//16):
        raise ValueError("invalid bounded HD window")
    span = 180 / 2**level
    pixel = span / 256
    # Three radius-16 box filters have finite support 48. A 64-pixel halo
    # makes neighboring outputs independent of file boundaries.
    halo = 64
    west, south = -180 + x * span, -90 + row * span
    bounds = [west-halo*pixel, south-halo*pixel,
              west+count*span+halo*pixel, south+span+halo*pixel]
    width, height = count*256+2*halo, 256+2*halo
    before = head(s["url"])
    if before != s["etag"]:
        raise ValueError("source edition changed")
    raw = read(s["url"], before, bounds, width, height, s["radius"])
    base_etag = head(s["base"])
    base = read(s["base"], base_etag, bounds, width, height, s["radius"])
    valid = np.isfinite(raw)
    if not np.any(valid):
        raise ValueError("source has no coverage in this window")
    if s["naif"] == 499:
        if not stretch or len(stretch) != 2 or stretch[1] <= stretch[0]:
            raise ValueError("CTX requires a frozen region-wide --stretch low high")
        raw = np.clip((raw-stretch[0])*254/(stretch[1]-stretch[0])+1, 1, 255)
    base = np.nan_to_num(base, nan=0)
    raw = np.where(valid, raw, base)
    # Local additive radiometric match: gain 1, offset lowpass(base-source).
    # Shared halos avoid an independently fitted gain at each file boundary.
    correction = smooth(base-raw)
    matched = np.clip(np.floor(raw+correction+0.5), 1, 255)
    matched[~valid] = base[~valid]
    crop = (slice(halo, -halo), slice(halo, -halo))
    image, base_crop = matched[crop].astype(np.uint8), base[crop]
    def energy(a):
        return float(np.mean(np.diff(a.astype(float), axis=0)**2) + np.mean(np.diff(a.astype(float), axis=1)**2))
    record = {"source": source, "etag": before, "baseEtag": base_etag,
              "sourceUrl": s["url"], "baseUrl": s["base"], "level": level, "row": row,
              "x": x, "tiles": count, "bounds": [west, south, west+count*span, south+span],
              "stretch": stretch, "radiometry": "gain=1; offset=three 33px box filters of (base-source); halo=64",
              "validFraction": float(np.mean(valid[crop])), "highFrequencyEnergy": energy(image),
              "baseHighFrequencyEnergy": energy(base_crop),
              "meanAbsToBase": float(np.mean(np.abs(image.astype(float)-base_crop))),
              "meanOffset": float(np.mean(correction[crop])), "gdal": gdal.VersionInfo()}
    if head(s["url"]) != before or head(s["base"]) != base_etag:
        raise ValueError("source changed during read")
    dest = Path(out)
    dest.parent.mkdir(parents=True, exist_ok=True)
    payload = image.tobytes()
    record["rasterSha256"] = hashlib.sha256(payload).hexdigest()
    dest.write_bytes(payload)
    dest.with_suffix(".json").write_text(json.dumps(record, indent=2)+"\n")
    print(json.dumps(record), flush=True)


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--source", required=True, choices=SOURCES)
    for k in ("level", "row", "x", "tiles"):
        p.add_argument("--"+k, type=int, required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--stretch", nargs=2, type=float)
    a = p.parse_args()
    prepare(a.source, a.level, a.row, a.x, a.tiles, a.out, a.stretch)
