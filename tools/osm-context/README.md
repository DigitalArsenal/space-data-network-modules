# tools/osm-context — the OSM context tileset builder

Phase 2 of the "OpenStreetMap on SDN" plan (2026-09-03): the imagery detector
and the LOD1 building work need water, roads, rails, aeroways, parking,
industrial land and building footprints as context, and they must not fetch it
from the public Overpass API — no service level, an external origin, no
epochs, and query cost that scales with the view. This tool turns a dated
Geofabrik extract into ONE PMTiles archive of Mapbox Vector Tiles (spec 2.1),
seven purpose-built layers, zoom 0–14, Web Mercator, plus the tileset record
that names it. The archive is what gets pinned and served by CID; the record
is what a node renders for clients.

It is built OFF-FLEET, like `tools/terrain-pyramid`: the build machine cuts,
a node serves. Nothing here talks to the fleet. The processor is
[planetiler](https://github.com/onthegomap/planetiler) (Apache-2.0, Java),
driven by a YAML custom-schema profile so the layer rules are data, not code,
and carry their own test cases.

## Why PMTiles rather than a directory of tile files

Terrain publishes a directory (`<cid>/{z}/{x}/{y}.terrain`) because a regional
cut holds thousands of tiles. A planet vector set to z14 is roughly 360 million
addresses, most of them open ocean; pinning that as files is not viable.
PMTiles packs the pyramid into one file with a directory of byte offsets, so a
client reads any tile with one HTTP range request. IPFS gateways honor Range,
CDNs cache ranges, and the file is immutable per epoch, so cache keys never go
stale. Identical tiles (full-tile ocean) are stored once: the Zuid-Holland
archive addresses 5,500 tiles with 2,427 distinct tile contents.

## The layers

Every layer exists because the detector or the extrusion step consumes it.
Attributes are the ones kept; everything else on the OSM element is dropped.

| layer | OSM source | kept attributes | first zoom | used for |
| --- | --- | --- | --- | --- |
| `water` | `natural=water`, `waterway=riverbank\|dock`, `landuse=reservoir\|basin`, plus ocean polygons from `natural=coastline` (osmcoastline, via osmdata.openstreetmap.de) | `kind` | ocean 0, water 8, dock 12 | ship/harbour require; vehicle, tank, building reject |
| `road` | `highway=*` minus `footway\|path\|steps\|cycleway`, lines only | `class`, `lanes`, `width` | motorway 5 … service 13 | vehicle context; bridge require |
| `rail` | `railway=rail\|light_rail\|tram` | `class` | mainline 8, sidings/light rail/tram 12 | bridge require |
| `aeroway` | `aeroway=aerodrome\|apron\|runway\|taxiway\|helipad\|hangar` (polygon, line and point blocks) | `kind` | aerodrome 8, runway 10, apron/taxiway 11, rest 13 | airplane require (only when present) |
| `parking` | `amenity=parking` | — | 13 | vehicle context |
| `industrial` | `landuse=industrial\|port\|harbour`, `man_made=works\|storage_tank\|pier` | `kind` | landuse 10, rest 13 | storage-tank context |
| `building` | `building=*` minus `building=no` | `height`, `building:levels`, `roof:shape`, `min_height` | 13 | pre-classified footprints; LOD1 extrusion heights |

Max zoom is 14 for every layer: ~2.4 m/pixel at the equator, and MVT keeps
polygon edges at 4096 units per tile (0.38 m at 50° N), which is finer than
any mask the detector rasterizes. At z14 the building layer is neither
simplified nor size-filtered (`tolerance_at_max_zoom: -1`,
`min_size_at_max_zoom: 0`); measured against the live OSM API, six large
Frankfurt footprints came back with 168/168, 147/147 and 98/98 vertices
identical and three others one to three vertices short, the loss being the
integer-grid snap merging near-coincident points. The MVT feature id is
`osm_id * 10 + {1 node, 2 way, 3 relation}`, so a client can recover the OSM id.
`aeroway` and `industrial` contain Point features (aerodrome/helipad and
works/storage-tank nodes); clients must accept them.

The layer rules and the zoom ladder are in `profile/osm-context.yml`, verbatim
from the prototype build, with 21 `verify` cases at the bottom that planetiler
checks without any data.

## Layout

```
build.mjs            verify -> inputs -> build -> header -> record -> run report, one region per call
write-record.mjs     the tileset record from an archive's header and metadata (CLI and library)
profile/             osm-context.yml, the planetiler custom-schema profile with its test cases
regions.json         the Geofabrik extracts the builder knows, and the ocean polygons pin
tests/               node:test suites that need neither Java nor network
evidence/            the prototype's two records, its console output, the port's proof run, BUILD-EVIDENCE.md
bin/                 planetiler jar (gitignored, downloaded and sha256-checked)
cache/               extracts, .md5 and state files, ocean polygons (gitignored)
out/                 archives, records, run reports, build logs (gitignored)
```

## Running it

Needs Node 22 or newer (developed on 25.4) and a Java 21 or newer on `PATH`,
in `$JAVA`, or at `--java <path>`. Nothing is installed with npm; the only
non-Node dependency is the planetiler jar, which the builder downloads to
`bin/` and refuses unless its sha256 is the pinned release digest.

```sh
# The profile's own test cases, no data needed (~2 s after the jar is cached)
node tools/osm-context/build.mjs --verify-only

# One regional epoch: downloads the extract, its checksum and state file, and
# the ocean polygons into cache/, builds, and writes three files into out/
node tools/osm-context/build.mjs --region hessen
node tools/osm-context/build.mjs --region zuid-holland

# Re-cut from what is already in cache/, touching no network at all
node tools/osm-context/build.mjs --region zuid-holland --offline

# The record alone, from any archive planetiler wrote
node tools/osm-context/write-record.mjs --archive out/osm-context-hessen-20260902T202051Z.pmtiles \
  --region hessen --source-url https://download.geofabrik.de/europe/germany/hessen-latest.osm.pbf \
  --retrieved-at 2026-09-03T18:56:15Z --processor "planetiler 0.10.2"
```

| flag | meaning |
| --- | --- |
| `--region <name>` | a key of `regions.json` (`hessen`, `zuid-holland`) |
| `--verify-only` | stop after the profile's test cases |
| `--offline` | use `cache/` as it is; refuse anything missing rather than fetch it |
| `--out`, `--bin`, `--cache <dir>` | where archives, the jar and the inputs live (defaults: this directory's `out/`, `bin/`, `cache/`) |
| `--java <path>` | the JVM; otherwise `$JAVA`, then `java` on `PATH`, then Homebrew's OpenJDK |
| `--xmx 24g` | JVM heap cap (planetiler's regional builds use far less; a planet build wants most of the box) |
| `--planetiler-jar <path>` | an already-downloaded jar; still sha256-checked against the pin |
| `--pmtiles <path>` | the go-pmtiles CLI for an independent `pmtiles show`; otherwise `bin/pmtiles` or `PATH`, and skipped if absent |
| `--ocean-sha256 <hex>` | accept a newer daily ocean file by stating its digest (see below) |

Tests: `node --test "tools/osm-context/tests/*.test.mjs"` (Node 25 does not
take a bare directory).

### What a build does, and where it refuses

1. **The processor is pinned.** planetiler 0.10.2, sha256
   `f310bd04…67e4d` from the release's `planetiler.jar.sha256`, checked whether
   the jar was just downloaded or was already there; its `--version` must say
   0.10.2. Java must be 21 or newer.
2. **The profile is verified.** planetiler `verify` runs the 21 cases. Its
   exit code is 0 even when cases fail (observed with 0.10.2 on 2026-09-03,
   fixture in `tests/fixtures/planetiler-verify-fail.txt`), so the builder
   parses the output and accepts only "n passed" with n equal to the number
   of examples in the profile.
3. **The extract is what Geofabrik says it is.** `<region>-latest.osm.pbf.md5`
   and `<region>-updates/state.txt` are fetched fresh (they are a line each);
   a cached extract whose md5 does not match is downloaded again, and a
   download whose md5 still does not match is refused as a rolled extract.
   The state file's `timestamp` is the epoch and names the archive and the
   record.
4. **The ocean is pinned per build.** osmdata replaces
   `water-polygons-split-3857.zip` daily at the same URL and publishes no
   checksum, so `regions.json` pins the digest of the file the evidence build
   used. A fresh download will not match it; the builder keeps the file,
   prints its digest and refuses until the operator re-runs with
   `--ocean-sha256 <digest>` (recorded in the run report) or updates the pin.
   That is deliberate: the ocean layer's date is part of what the archive
   means, and it is stated rather than drifting silently.
5. **planetiler builds** with absolute paths for everything, a temp directory
   under `out/`, `--force`, `--maxzoom=14 --render_maxzoom=14`, and the log
   goes to `out/build-<region>.log`.
6. **The archive is read back and cross-checked.** `write-record.mjs` parses
   the PMTiles v3 header and metadata natively: tile type must be MVT, max zoom
   14, `planetiler:osm:osmosisreplicationtime` and `…seq` must equal the state
   file's timestamp and sequence number, and the `vector_layers` ids must be
   the profile's layer ids. `pmtiles show` is printed beside that when the CLI
   is around, as a second opinion.
7. **Two files land beside the archive.** `<name>.vtt.json`, the tileset
   record, and `<name>.run.json`, the run report: every input's URL, byte
   count, digest and retrieval time, the JVM and jar, the exact command,
   planetiler's tile/feature counts and phase timings, the header and metadata.

RETRIEVED_AT in the record is the time the extract's bytes landed on disk —
the download record when this tool fetched them, the file's mtime when they
were put in `cache/` by hand — and the run report says which.

## The record

`write-record.mjs` writes the DTT-shaped record the prototype wrote
(`evidence/osm-context-hessen-20260902T202051Z.vtt.json`): tileset id and name,
tiling scheme, zoom range, bounds from the header, the layer list with
per-layer zooms and field names from the archive's `vector_layers`, a payload
block (CID empty until pinned, size, sha256 digest, media type
`application/vnd.pmtiles`) and a provenance block (OpenStreetMap, the extract
URL and epoch, ODbL-1.0 with share-alike, the attribution line, the
processor). The real `$VTT` table is phase 1 of the plan and lands in
spacedatastandards.org first; until then this is a fixture with the keys the
plan proposes, not an IDL-exact projection, and the tests only assert that it
stays byte-identical to what the prototype produced.

## Verification, and what was measured

`evidence/BUILD-EVIDENCE.md` has the numbers from the 2026-09-03 prototype run
on Hessen (Frankfurt) and Zuid-Holland (Rotterdam), and from the port's own
proof run, which rebuilt Zuid-Holland from the same cached inputs and produced
a byte-identical archive (same sha256) and a byte-identical record. Beyond the
profile's cases and the header cross-check, the prototype decoded z14 tiles
over Frankfurt Airport, the Main in central Frankfurt, the North Sea off Hoek
van Holland and Rotterdam's Waalhaven and read the layers, attribute keys,
geometry types and duplicate ids off them; the two Python decoders it used
(`inspect_tile.py`, `layer_sizes.py`) were not ported, and a Node tile decoder
belongs with the client work in phase 4, where the MVT reader is vendored.

## Sizes and the planet projection

| | Hessen | Zuid-Holland |
| --- | --- | --- |
| extract | 344,477,469 B | 210,780,407 B |
| archive | 107,086,168 B (102.1 MiB) | 58,306,577 B (55.6 MiB) |
| build wall time | 17 s | 15 s (port: 17 s) |
| archive / extract bytes | 0.311 | 0.277 |
| building layer share of raw tile bytes | 72.2 % | 72.4 % |

**Planet, as an estimate — no planet build has been run.** `planet-260831` is
88 GiB of PBF; the two regional ratios give 24–27 GiB of PMTiles. Both regions
are among the most densely mapped places on Earth and buildings are 72 % of
their tile bytes, while the planet carries proportionally more of what this
schema discards (landuse, boundaries, waterways, POIs) and vast sparsely
mapped areas, so the true ratio is likely lower; 24–27 GiB is an upper-leaning
figure at the low end of the plan's 25–40 GB guess. Europe (34.9 GB PBF) would
be ~10 GB, Germany (4.83 GB) ~1.4 GB. Ocean does not change this materially:
identical full-tile ocean tiles deduplicate, only the directory grows. Raising
buildings to z15 would roughly double their share. Planet build resources:
planetiler's published planet runs take ~3 h on 32 cores / 128 GB with
`--nodemap-type=array --storage=ram`; this profile does less per element, so
the same order of magnitude, dominated by the node map and the ocean pass.

## Open items

1. **Ocean epoch drift.** The water polygons are osmdata's daily osmcoastline
   build (2026-09-01 for the evidence archives), not derived from the extract,
   so the ocean layer can be up to a day off the extract epoch. planetiler
   cannot run osmcoastline. The plan's open decision stands: run osmcoastline
   on the same planet file in the builder, or take the ocean from the terrain
   water mask the node already serves.
2. **Numeric coercion of `height`, `building:levels`, `lanes`, `width`.**
   planetiler's `double`/`integer` coercion has no unit parsing: `height="12 m"`,
   `"12,5"` or `lanes="2;3"` fail and the attribute is dropped. A CEL
   `replaceRegex` could strip units but has no error path for garbage; a Java
   profile would parse properly. Most German and Dutch heights are plain
   numbers; decide before LOD1 extrusion relies on the field.
3. **Closed pier ways are emitted twice.** A closed `man_made=pier` way without
   `area=*` is both a polygon and a line to planetiler, so it appears in
   `industrial` as both. The same rule is why the profile uses explicit
   polygon/line/point blocks instead of `geometry: any`, which emitted every
   closed aeroway and industrial way twice in the first build.
4. **Edge clipping.** A regional archive is clipped to the extract's polygon,
   not to its bounding box, so tiles at the region's edge are partial. This is
   a property of regional builds and does not exist for a planet build; a
   client stitching neighbouring regional archives must expect it.
5. Whether the building layer alone goes to z15 in dense cores, and the
   planet cadence, are the plan's open decisions, not this tool's.
6. The `$VTT` IDL, the IDL-exact projection and the CID come from phases 1
   and 2 of the plan; this record is the fixture until then.

## Licenses

planetiler is Apache-2.0. OpenStreetMap data and the osmdata water polygons
are ODbL-1.0: attribution ("© OpenStreetMap contributors") must appear where
the data is shown and the published archive is itself ODbL, which is fine
because it is public by design; there is no non-commercial clause. go-pmtiles
(optional, `pmtiles show` only) is BSD-3-Clause; the version and digest the
prototype used are in `build.mjs`.
