#!/usr/bin/env python3
"""Host-side imagery build for propagator/solar-system-bodies (dataset imagery/).

For every body in tools/imagery-sources.json: download the public-domain global
mosaic, warp it with GDAL to a longitude/latitude grid of 512 * 2^L by
256 * 2^L pixels (-180..180, 90..-90), convert IAU planetocentric latitude to
the planetodetic latitude the engine's geographic tiling uses on the body's
PCK ellipsoid (PROJ "+geoc"; only bodies with c != a differ), and cut the
OrbPro GeographicTilingScheme pyramid (2 x 1 tiles at level 0, {z}/{x}/{y},
y from the north) with gdal2tiles. A 2048 x 1024 whole-body texture is made
for the inactive ellipsoid. Temporary files are deleted after each body.

  python3 tools/build-imagery.py <pck00011.tpc> <out-dataset-dir> [naif ...]
  python3 tools/build-imagery.py root <dataset-dir>

The `root` mode closes the dataset: it writes SOURCES.md and licences.json
(one entry for every delivered file, from kernels/kernel-provenance.json,
imagery/index.json), refuses a file no entry
covers, copies SOURCES.md and licences.json into data/, and prints the
directory's root CID (UnixFS, CIDv1, `ipfs add --only-hash`) for a local
copy. No CID is kept in the repository: hosts read the datasets from the SDN
data retrieval modules' publications (owner 2026-10-13). Asteroids are not in
this dataset: they are $SBD small-body records published by the
data-source/lowell-astorb retrieval module.

Writes <out>/imagery/<naif>/{z}/{x}/{y}.jpg, texture.jpg, and
<out>/imagery/index.json. Needs GDAL >= 3.6 (gdalwarp, gdal_translate,
gdal2tiles). Run it niced: it is CPU heavy.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
PROCESSES = int(os.environ.get("IMAGERY_PROCESSES", "4"))


def radii(pck_path):
    raw = open(pck_path, encoding="latin-1").read()
    # Data sections only: the comment text quotes radii in other forms.
    text = "\n".join(re.findall(r"\\begindata(.*?)(?=\\begintext|\Z)", raw, re.S))
    out = {}
    for m in re.finditer(r"BODY(\d+)_RADII\s*=\s*\(([^)]*)\)", text):
        values = [float(v.replace("D", "E")) for v in m.group(2).split()]
        out[int(m.group(1))] = values
    return out


def run(*args):
    done = subprocess.run(["nice", "-n", "10", *args], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    if done.returncode != 0:
        raise RuntimeError(f"{args[0]} failed: {done.stderr.strip()[-600:]}")


def download(url, path):
    with urllib.request.urlopen(url, timeout=600) as response, open(path, "wb") as f:
        shutil.copyfileobj(response, f, 1 << 22)


def band_count(path):
    info = json.loads(subprocess.run(["gdalinfo", "-json", path], check=True, capture_output=True).stdout)
    return len(info.get("bands", []))


def source_radius(path):
    info = json.loads(subprocess.run(["gdalinfo", "-json", path], check=True, capture_output=True).stdout)
    wkt = info.get("coordinateSystem", {}).get("wkt", "")
    m = re.search(r'ELLIPSOID\["[^"]*",\s*([0-9.eE+]+)', wkt)
    return float(m.group(1)) if m else None


def build(entry, r, out_root, work):
    naif = entry["naif"]
    level = entry["maximumLevel"]
    width = 512 * 2 ** level
    height = width // 2
    a, _b, c = r[naif][0] * 1000.0, r[naif][1] * 1000.0, r[naif][2] * 1000.0
    src = os.path.join(work, "src" + os.path.splitext(entry["url"])[1])
    download(entry["url"], src)
    if "georef" in entry:
        ul_lon, ul_lat, lr_lon, lr_lat = entry["georef"]
        georef = os.path.join(work, "georef.tif")
        run("gdal_translate", "-q", "-a_srs", f"+proj=longlat +R={a} +no_defs",
            "-a_ullr", str(ul_lon), str(ul_lat), str(lr_lon), str(lr_lat), src, georef)
        os.remove(src)
        src = georef
    sphere = os.path.join(work, "sphere.tif")
    # Unproject on the mosaic's own sphere (its radius need not be the PCK's):
    # only longitude and planetocentric latitude carry over.
    radius = source_radius(src) or a
    run("gdalwarp", "-q", "-overwrite", "-t_srs", f"+proj=longlat +R={radius} +no_defs",
        "-te", "-180", "-90", "180", "90", "-ts", str(width), str(height),
        "-r", "average", "-ot", "Byte", "-wm", "1024", "-multi", "-wo", f"NUM_THREADS={PROCESSES}", src, sphere)
    os.remove(src)
    grid = sphere
    if abs(a - c) / a > 1e-4:
        # Planetocentric rows to planetodetic rows on the PCK ellipsoid.
        # GeoTIFF cannot store a geocentric-latitude CRS, so it is given as -s_srs.
        grid = os.path.join(work, "detic.tif")
        run("gdalwarp", "-q", "-overwrite", "-s_srs", f"+proj=longlat +a={a} +b={c} +geoc +no_defs",
            "-t_srs", f"+proj=longlat +a={a} +b={c} +no_defs",
            "-te", "-180", "-90", "180", "90", "-ts", str(width), str(height), "-r", "bilinear", sphere, grid)
        os.remove(sphere)
    # Three bands for JPEG tiles.
    rgb = os.path.join(work, "rgb.tif")
    bands = band_count(grid)
    pick = ["-b", "1", "-b", "2", "-b", "3"] if bands >= 3 else ["-b", "1", "-b", "1", "-b", "1"]
    run("gdal_translate", "-q", *pick, "-a_srs", "EPSG:4326", grid, rgb)
    os.remove(grid)
    target = os.path.join(out_root, "imagery", str(naif))
    shutil.rmtree(target, ignore_errors=True)
    os.makedirs(target)
    run("gdal_translate", "-q", "-of", "JPEG", "-co", "QUALITY=88", "-outsize", "2048", "1024",
        "-r", "average", rgb, os.path.join(target, "texture.jpg"))
    run("gdal2tiles", "-q", "-p", "geodetic", "--tmscompatible", "--xyz", "-z", f"0-{level}",
        "-w", "none", "--no-kml", "-r", "average", "--tiledriver=JPEG", f"--processes={PROCESSES}", rgb, target)
    os.remove(rgb)
    for extra in ("openlayers.html", "leaflet.html", "googlemaps.html", "tilemapresource.xml"):
        p = os.path.join(target, extra)
        if os.path.exists(p):
            os.remove(p)
    for dirpath, _dirs, files in os.walk(target):
        for name in files:
            if name.endswith(".aux.xml") or name.endswith(".kml"):
                os.remove(os.path.join(dirpath, name))
    tiles = sum(len(f) for _p, _d, f in os.walk(target)) - 1
    return {"maximumLevel": level, "credit": entry["credit"], "licence": entry["licence"],
            "source": entry["url"], "tiles": tiles}


def main():
    pck, out_root = sys.argv[1], sys.argv[2]
    only = {int(v) for v in sys.argv[3:]}
    sources = json.load(open(os.path.join(HERE, "imagery-sources.json")))["bodies"]
    r = radii(pck)
    index_path = os.path.join(out_root, "imagery", "index.json")
    index = json.load(open(index_path)) if os.path.exists(index_path) else {"bodies": {}}
    for entry in sources:
        if only and entry["naif"] not in only:
            continue
        work = tempfile.mkdtemp(prefix=f"ssb-imagery-{entry['naif']}-", dir=os.environ.get("TMPDIR"))
        try:
            print(f"{entry['name']}: level {entry['maximumLevel']}", flush=True)
            index["bodies"][str(entry["naif"])] = build(entry, r, out_root, work)
            print(f"{entry['name']}: {index['bodies'][str(entry['naif'])]['tiles']} tiles", flush=True)
        except Exception as error:  # keep going: one failed source must not cost the others
            print(f"{entry['name']}: FAILED {error}", flush=True)
        finally:
            shutil.rmtree(work, ignore_errors=True)
        os.makedirs(os.path.dirname(index_path), exist_ok=True)
        with open(index_path, "w") as f:
            json.dump(index, f, indent=1, sort_keys=True)
            f.write("\n")


NAIF_LICENCE = ("NASA/JPL NAIF generic kernels: produced by NASA's Jet Propulsion Laboratory, "
                "distributed freely by the NAIF node of the Planetary Data System")
NAIF_CREDIT = "Ephemerides and orientation: NASA/JPL NAIF (DE440, JPL satellite and small-body ephemerides), IAU WGCCRE 2015"


def root(dataset):
    data_dir = os.path.join(os.path.dirname(HERE), "data")
    kernels = json.load(open(os.path.join(dataset, "kernels", "kernel-provenance.json")))
    imagery = json.load(open(os.path.join(dataset, "imagery", "index.json")))["bodies"]
    entries = [
        {"path": "SOURCES.md", "licence": "CC0 1.0 (this index)", "credit": None},
        {"path": "licences.json", "licence": "CC0 1.0 (this index)", "credit": None},
        {"path": "kernels/kernel-provenance.json", "licence": "CC0 1.0 (provenance record)", "credit": None},
    ]
    for out in kernels["outputs"]:
        entries.append({"path": f"kernels/{out['file']}", "licence": NAIF_LICENCE, "credit": NAIF_CREDIT,
                        "sha256": out["sha256"]})
    for naif, body in sorted(imagery.items(), key=lambda kv: int(kv[0])):
        entries.append({"path": f"imagery/{naif}/", "licence": body["licence"], "credit": body["credit"],
                        "source": body["source"]})
    entries.append({"path": "imagery/index.json", "licence": "CC0 1.0 (index)", "credit": None})
    # Every delivered file must be covered.
    uncovered = []
    for dirpath, _dirs, files in os.walk(dataset):
        for name in files:
            rel = os.path.relpath(os.path.join(dirpath, name), dataset).replace(os.sep, "/")
            if not any(rel == e["path"] or (e["path"].endswith("/") and rel.startswith(e["path"])) for e in entries):
                uncovered.append(rel)
    if uncovered:
        raise SystemExit(f"no licence entry for: {uncovered[:10]}")
    licences = {"dataset": "solar-system", "entries": entries}
    with open(os.path.join(dataset, "licences.json"), "w") as f:
        json.dump(licences, f, indent=1)
        f.write("\n")
    lines = ["# Solar-system dataset", "",
             "Kernels and imagery for OrbPro's scene.bodies, delivered by CID.", "",
             "## Kernels (kernels/)", "",
             f"Decade shards cut by tools/build_kernels.py ({kernels['cspice']}, no refit) from:", ""]
    for item in kernels["inputs"]:
        lines.append(f"- `{item['file']}`: {item['url']} (sha256 {item['sha256'][:16]}...)")
    lines += ["", f"Credit: {NAIF_CREDIT}. Licence: {NAIF_LICENCE}.", "", "## Imagery (imagery/<NAIF id>/)", "",
              "Public-domain global mosaics, planetocentric latitude converted to planetodetic on the PCK ellipsoid, "
              "geographic tiling 2 x 1 at level 0, by tools/build-imagery.py.", "",
              "| NAIF | Levels | Credit | Licence | Source |", "| --- | --- | --- | --- | --- |"]
    for naif, body in sorted(imagery.items(), key=lambda kv: int(kv[0])):
        lines.append(f"| {naif} | 0-{body['maximumLevel']} | {body['credit']} | {body['licence']} | {body['source']} |")
    lines += [""]
    with open(os.path.join(dataset, "SOURCES.md"), "w") as f:
        f.write("\n".join(lines))
    cid = subprocess.run(["ipfs", "add", "-r", "-Q", "--only-hash", "--cid-version", "1", dataset],
                         check=True, capture_output=True, text=True).stdout.strip()
    total = sum(os.path.getsize(os.path.join(d, n)) for d, _s, fs in os.walk(dataset) for n in fs)
    os.makedirs(data_dir, exist_ok=True)
    shutil.copyfile(os.path.join(dataset, "SOURCES.md"), os.path.join(data_dir, "SOURCES.md"))
    shutil.copyfile(os.path.join(dataset, "licences.json"), os.path.join(data_dir, "licences.json"))
    print(f"root {cid} ({total / 1e6:.1f} MB)")


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "root":
        root(sys.argv[2])
    else:
        main()
