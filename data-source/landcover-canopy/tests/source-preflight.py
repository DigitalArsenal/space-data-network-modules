"""Test-only live source inspection, NOT the module parity/CID E2E.

Usage: python3 tests/source-preflight.py --scratch /absolute/durable/directory
Requires GDAL CLI. Reads metadata and one 16x16 native pixel window per source.
Source values: WorldCover 2021 v200 dimensionless codes, EPSG:4326;
Meta/WRI v1 heights in meters, EPSG:3857, observation epoch unstated in TIFF.
No reprojection, resampling, scaling, or numeric tolerance: this is inspection,
not a comparison with a module. GDAL is never a production dependency.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
from datetime import datetime, timezone
from urllib.request import Request, urlopen


SOURCES = [
    ("worldcover", "https://esa-worldcover.s3.eu-central-1.amazonaws.com/"
     "v200/2021/map/ESA_WorldCover_10m_2021_v200_N00E006_Map.tif", [8760, 32040, 16, 16]),
    ("canopy-north", "https://dataforgood-fb-data.s3.amazonaws.com/"
     "forests/v1/alsgedi_global_v6_float/chm/001311332.tif", [32760, 32760, 16, 16]),
    ("canopy-west", "https://dataforgood-fb-data.s3.amazonaws.com/"
     "forests/v1/alsgedi_global_v6_float/chm/023001111.tif", [32760, 32760, 16, 16]),
]


def header_range(url, etag=None):
    headers = {"Range": "bytes=0-1023", "Accept-Encoding": "identity"}
    if etag:
        headers["If-Match"] = etag
    with urlopen(Request(url, headers=headers), timeout=30) as response:
        assert response.status == 206, "Refusing a whole-object response"
        content_range = response.headers["Content-Range"]
        assert content_range.startswith("bytes 0-1023/"), content_range
        data = response.read(1025)
        assert len(data) == 1024
        return {
            "status": response.status, "contentRange": content_range,
            "etag": response.headers["ETag"], "headerBytes": len(data),
            "headerSha256": hashlib.sha256(data).hexdigest(),
        }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scratch", type=Path, required=True)
    args = parser.parse_args()
    root = args.scratch.resolve()
    if str(root).startswith(("/tmp/", "/private/tmp/")):
        parser.error("Use a durable scratch directory outside /tmp")
    root.mkdir(parents=True, exist_ok=True)
    run = Path(tempfile.mkdtemp(prefix="source-preflight-", dir=root))
    env = {**os.environ, "GDAL_DISABLE_READDIR_ON_OPEN": "EMPTY_DIR",
           "CPL_VSIL_CURL_ALLOWED_EXTENSIONS": ".tif", "GDAL_NUM_THREADS": "1",
           "GDAL_HTTP_TIMEOUT": "30", "GDAL_HTTP_MAX_RETRY": "0"}

    def gdal(*command):
        return subprocess.check_output(command, env=env, timeout=120)

    evidence = {
        "kind": "source-preflight-only", "moduleParityTested": False,
        "cidReadbackTested": False,
        "retrievedAt": datetime.now(timezone.utc).isoformat(),
        "gdalVersion": gdal("gdalinfo", "--version").decode().strip(), "sources": [],
    }
    for name, url, window in SOURCES:
        directory = run / name
        directory.mkdir()
        before = header_range(url)
        info = json.loads(gdal("gdalinfo", "-json", "/vsicurl/" + url))
        (directory / "gdalinfo.json").write_text(json.dumps(info, indent=2) + "\n")
        assert len(info["bands"]) == 1
        band = info["bands"][0]
        assert band["type"] == "Byte", "Source changed: review the native type"
        target = directory / "window.bil"
        gdal("gdal_translate", "-q", "-of", "EHdr", "-srcwin",
             *map(str, window), "/vsicurl/" + url, str(target))
        values = target.read_bytes()
        assert len(values) == window[2] * window[3]
        after = header_range(url, before["etag"])
        assert before == after, "Source changed during GDAL inspection"
        item = {
            "name": name, "url": url, "rangeProbe": before,
            "size": info["size"], "coordinateSystem": info["coordinateSystem"],
            "geoTransform": info["geoTransform"], "metadata": info["metadata"],
            "band": {key: value for key, value in band.items() if key != "colorTable"},
            "window": window, "sampleCount": len(values),
            "minimum": min(values), "maximum": max(values),
            "uniqueValues": sorted(set(values)),
            "windowSha256": hashlib.sha256(values).hexdigest(),
        }
        evidence["sources"].append(item)
        print(f"{name}: HTTP 206, {band['type']} {info['size']}, block {band['block']}, "
              f"{len(values)} native samples, range {min(values)}..{max(values)}", flush=True)
    output = run / "evidence.json"
    output.write_text(json.dumps(evidence, indent=2) + "\n")
    print(output)


if __name__ == "__main__":
    main()
