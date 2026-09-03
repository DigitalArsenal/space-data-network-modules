# osm-context — what the 2026-09-03 builds measured

Committed so a reviewer can check the tool's stated figures without
re-downloading half a gigabyte of extracts. The archives are not here (58 and
107 MB; `out/` is gitignored); these are the numbers read off them.

Two runs are recorded: the **prototype** (`build.sh` + `write_record.py`,
under `/private/tmp/claude-501/osm-context`, no repository involved), and the
**port's proof run** (`build.mjs` in this directory, offline, against the
prototype's cached inputs), which reproduced the prototype's Zuid-Holland
archive byte for byte.

## Machine and versions

- macOS arm64, 28 cores, 256 GB RAM; JVM given `-Xmx24g`, the regional builds
  use far less.
- planetiler 0.10.2, git `0e5588c4a6e8c29a270a33afe8df62027d889604`, built
  2026-03-28; jar sha256
  `f310bd0413e2e4512b27f4046d418664e8e1d3bf31603c2a70e23de06c167e4d`, equal to
  the release's `planetiler.jar.sha256`. Apache-2.0.
- OpenJDK 25.0.2 (Homebrew). Prints two `sun.misc.Unsafe` / native-access
  warnings from protobuf and jffi; harmless.
- go-pmtiles 1.31.2 (commit a3e4951, built 2026-07-22), Darwin arm64 zip
  sha256 `40528f7f616fcbf91207cd48c8fc023d213f6d86c0cbf1f748732803d1880f3d`.
  BSD-3-Clause. Used for `pmtiles show` only.
- Prototype-only Python tooling (not ported): pmtiles 3.7.0, mapbox-vector-tile
  2.2.0, shapely 2.1.2 under Python 3.14.

## Inputs

| extract | URL | bytes | md5 (verified against the published `.md5`) | state.txt |
| --- | --- | --- | --- | --- |
| Hessen | https://download.geofabrik.de/europe/germany/hessen-latest.osm.pbf | 344,477,469 | `1bb43d38b0e417656157ccf5aa22f276` | timestamp `2026-09-02T20:20:51Z`, sequenceNumber 4890, planet minutely seq 7269936 |
| Zuid-Holland | https://download.geofabrik.de/europe/netherlands/zuid-holland-latest.osm.pbf | 210,780,407 | `c7ee6d2cce54e7c981ed3b4e8a044cbd` | timestamp `2026-09-02T20:20:51Z`, sequenceNumber 2839, planet minutely seq 7269936 |

Retrieved 2026-09-03T18:56:15Z (Hessen) and 2026-09-03T19:09:14Z
(Zuid-Holland). planetiler wrote the same timestamp from the PBF header into
each archive as `planetiler:osm:osmosisreplicationtime`; the state file and
the header agree for both.

Ocean: https://osmdata.openstreetmap.de/download/water-polygons-split-3857.zip,
928,928,907 B, sha256
`05ba9c22b108adcae9724946f6da9b395119556c75cfac12cddc0f8079215435`, retrieved
2026-09-03T18:57:35Z; the shapefile inside (1,267,373,328 B) is dated
2026-09-01 23:28 UTC. This is the pin in `regions.json`.

## Results

| | Hessen | Zuid-Holland |
| --- | --- | --- |
| build wall time (build step only) | 17 s (planetiler overall 16 s, cpu 3m10s) | 15 s (14 s, cpu 2m34s) |
| archive | `osm-context-hessen-20260902T202051Z.pmtiles` | `osm-context-zuid-holland-20260902T202051Z.pmtiles` |
| size | 107,086,168 B (102.1 MiB) | 58,306,577 B (55.6 MiB) |
| sha256 | `e4bfa21bc3539e71a6ea605c77bf046a69c28dc226068b8972870ff68f4c7f39` | `f543f2ed8277cbf29ea0018dbffb6836c7bdf5b0e12b06ed24772b986b59fb56` |
| bounds (from the PBF header) | 7.768021, 49.393212, 10.245952, 51.659158 | 3.345328, 51.642520, 5.032393, 52.476112 |
| addressed tiles / entries / distinct contents | 13,150 / 13,150 / 13,150 | 5,500 / 2,591 / 2,427 (identical ocean tiles deduplicated) |
| features | 6,964,957 | 3,512,770 |
| max tile (raw / gzip) | 231 kB / 151 kB (z13 over Frankfurt, buildings) | 375 kB / 221 kB |
| avg tile (raw / gzip, OSM-traffic weighted) | 28 kB / 19 kB | 38 kB / 25 kB |
| z14 tiles, gzip bytes | 9,674 tiles, 77.2 MB | 4,057 tiles, 44.7 MB |
| z13 tiles, gzip bytes | 2,527 tiles, 26.2 MB | 1,049 tiles, 9.6 MB |
| archive / extract byte ratio | 0.311 | 0.277 |
| ocean pass | 6 s (shapefile read 3 s; out-of-bounds polygons dropped) | same |
| planetiler data errors | — | `render_snap_fix_input` 9,914, `osm_multipolygon_missing_way` 72 |

Per-layer share of raw (uncompressed) tile bytes, summed over the archive:

| layer | Hessen | Zuid-Holland |
| --- | --- | --- |
| building | 72.2 % | 72.4 % |
| road | 22.1 % | 7.8 % |
| water | 2.1 % | 15.5 % (ocean and the Rotterdam harbour basins) |
| parking | 1.8 % | 2.5 % |
| industrial | 0.9 % | 1.3 % |
| rail | 0.6 % | 0.4 % |
| aeroway | 0.2 % | 0.0 % |

Archive metadata carries `attribution` (the OSM copyright link),
`vector_layers` with field names and per-layer min/max zoom (road 5,
aeroway/rail 8, water 8 for Hessen and 0 for Zuid-Holland because only the
latter has ocean, industrial 10, building/parking 13; all max 14) and
`planetiler:osm:osmosisreplicationtime = 2026-09-02T20:20:51Z`.

## Decoded z14 tiles

Tile numbers are lon/lat to Web Mercator z14 by the standard slippy-map
formula; decoding by the prototype's `inspect_tile.py`.

- **Frankfurt Airport** (8.5622 E, 50.0379 N) → `14/8581/5553`, 15,197 B gzip:
  aeroway 131 features (116 LineString runway/taxiway, 15 Polygon
  apron/hangar/…), building 123 (19 with `building:levels`, 17 `roof:shape`,
  1 `height`), industrial 30, parking 17, rail 1, road 29 (24 with `lanes`,
  4 with `width`). Samples: apron polygon id 348558732 (= way 34855873), 228
  vertices, `kind=apron`; a runway LineString `kind=runway`; building id
  42428353 (= relation 4242835) `building:levels=12, roof:shape=flat`, which
  is also in `parking` (the terminal garage); road `class=trunk_link,
  lanes=3`; industrial `kind=storage_tank`.
- **The Main, central Frankfurt** (8.6828 E, 50.1085 N) → `14/8587/5548`,
  92 kB gzip: water 13 polygons, all `kind=water`; building 3,001 (1,118 with
  levels, 240 roof:shape, 26 height, 1 min_height); road 61; rail 3
  (`light_rail`); parking 72.
- **North Sea off Hoek van Holland** (3.95 E, 52.00 N) → `14/8371/5411`:
  exactly one 5-vertex polygon `kind=ocean`, 55 B raw.
- **Rotterdam Waalhaven** → `14/8393/5420`: industrial 27 (18 polygons, 7
  `pier` lines, 2 points), water 9, building 298.
- **No duplicate feature ids** in any inspected tile after the profile moved
  from `geometry: any` to explicit polygon/line/point blocks. Before that fix,
  14 of 145 aeroway and 30 of 60 industrial features in the airport tile were
  duplicates: a closed way without an `area` tag is both `canBePolygon` and
  `canBeLine`, planetiler's matcher fires once per geometry trigger and
  `anyGeometry()` picks polygon each time.
- **Outline fidelity.** Building outlines at z14 against the live OSM API
  (`/api/0.6/way/<id>`), the six largest fully-inside way-buildings of the
  Main tile: 168/168, 147/147, 98/98 unique vertices identical; 150→147,
  148→146, 130→129 for the other three. The losses are the MVT integer-grid
  snap (4096 units per tile = 0.38 m at 50° N) merging near-coincident
  vertices; Douglas-Peucker is off at z14.
- **Feature id** = `osm_id * 10 + {1 node, 2 way, 3 relation}` (planetiler
  `OsmElement.vectorTileFeatureId`); clients can recover the OSM id.

## The prototype's commands

```sh
cd /private/tmp/claude-501/osm-context
java -Xmx4g  -jar bin/planetiler.jar verify profile/osm-context.yml        # 21 passed
java -Xmx24g -jar bin/planetiler.jar generate-custom \
  --schema=profile/osm-context.yml --area=hessen \
  --output=out/osm-context-hessen-20260902T202051Z.pmtiles \
  --force --maxzoom=14 --render_maxzoom=14
./build.sh hessen       https://download.geofabrik.de/europe/germany/hessen-latest.osm.pbf
./build.sh zuid-holland https://download.geofabrik.de/europe/netherlands/zuid-holland-latest.osm.pbf
```

`run-hessen.txt` and `run-zuid-holland.txt` are `build.sh`'s console output,
verbatim, including the `pmtiles show` header lines.
`osm-context-<region>-20260902T202051Z.vtt.json` are the records
`write_record.py` wrote beside the archives.

## The port's proof run (build.mjs, 2026-09-03T22:33Z)

```sh
node tools/osm-context/build.mjs --region zuid-holland --offline \
  --cache /private/tmp/claude-501/osm-context/data \
  --planetiler-jar /private/tmp/claude-501/osm-context/bin/planetiler.jar \
  --pmtiles /private/tmp/claude-501/osm-context/bin/pmtiles
```

Exit 0 in 19 s wall (build step 17 s; planetiler overall 16 s, cpu 2m23s;
osm_pass1 3 s, osm_pass2 4 s, ocean 7 s, sort 0.4 s, archive 1 s). The
profile's 21 cases passed; the ocean digest matched the pin; the cached extract
matched its `.md5`; the archive read back as 5,500 / 2,591 / 2,427 tiles,
3,512,770 features, max tile 375k (gzip 221k), and its metadata epoch and
sequence matched the state file. The archive's sha256 is
`f543f2ed8277cbf29ea0018dbffb6836c7bdf5b0e12b06ed24772b986b59fb56` — **the
prototype's, byte for byte** — and the record it wrote is byte-identical to
`osm-context-zuid-holland-20260902T202051Z.vtt.json` here. The run report is
`port-run-zuid-holland.run.json`. planetiler is deterministic on these inputs.

`--verify-only` through the same script, same jar: 21/21 passed, planetiler
exit 0, exit 0.

## What is in each file

- `osm-context-hessen-20260902T202051Z.vtt.json`,
  `osm-context-zuid-holland-20260902T202051Z.vtt.json` — the prototype's
  records. The Hessen one is also the writer's test oracle
  (`tests/write-record.test.mjs`).
- `run-hessen.txt`, `run-zuid-holland.txt` — the prototype's console output.
- `port-run-zuid-holland.run.json` — the port's run report for the proof run:
  every input's path, bytes and digest, the JVM and jar, the exact command,
  planetiler's counters and timings, the header, the metadata, `pmtiles show`.
- `BUILD-EVIDENCE.md` — this file.
