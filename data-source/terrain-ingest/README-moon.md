# Moon terrain (NASA LRO LOLA)

The Moon's terrain lane, run on a provider node by the flow
`com.digitalarsenal.flows.moon-terrain-ingest` (`flow-moon.mjs`, composed by the
stack's `deployment/solar-system-provider-node`). Each packed file is added to
the node's IPFS (pinned) and announced as one `$PNM`, auto-published as
`PNM.fbs`, provider `nasa-lola`, source `moon-terrain`. The console resolves
the files through `SOLAR_SYSTEM_LANES.terrain` and fetches each by CID.

Sources: the LOLA gridded data records in the PDS Geosciences Node
(`lrolol_1xxx/data/lola_gdr/`, public domain), keyed by their PDS4 LIDVIDs:

| Cap | Product | Levels | Band |
| --- | --- | --- | --- |
| global | `ldem_4_float` (7.6 km) | 0-3 | all |
| global | `ldem_16_float` (1.9 km) | 4-5 | all |
| global | `ldem_64_float` (474 m) | 6-7 | all |
| polar | `ldem_75{s,n}_240m_float` | 8 | \|lat\| >= 75 |
| polar | `ldem_75{s,n}_120m_float` | 9 | \|lat\| >= 80 |
| polar | `ldem_75s_60m_float` | 10 | lat <= -85 |

A tile is built from a cap only when its whole extent lies inside the band.
Config `lola_caps` (`[{product, min_level, max_level, lat_min, lat_max}]`)
replaces the table.

| Node | Does |
| --- | --- |
| `terrain-ingest:lola_plan` | one unit of the walk: the product's PDS3 label and three whole-line ranges of its image (If-Match on the product's ETag), the tiles' `$DTT` body plan |
| `terrain-source:tile` | quantized mesh on the 1737.4 km sphere (`GEOGRAPHIC_TWO_ROOT_BODY`), oct normals, no water mask, 32 KiB per tile |
| `terrain-source:pack` | `terrain/301/root.dtts` (levels 0-2) and `terrain/301/<L>/<X>_<Y>.dtts` (one 4x4 block), each a size-prefixed `$DTT` stream |
| `host-adapter:publish_files` | `ipfs.add` per file, one `$PNM` (CID, name) each |
| `terrain-ingest:announce_files` | the `$PNM` records and their IngestRequest |
| `terrain-ingest:publish_request` | the `$IRM` mark (`walk:lola`), from the verified store result |

Unit 0 is levels 0-2. A global product is walked one block row per unit; a
polar product by whole 4x4 blocks sorted by the first image line they touch, at
most 64 blocks and `lola_max_range_bytes` (72 MiB) of lines per unit. 199
units, 179,882 tiles, about 4.7 GB of ranges.

Density: each tile takes the coarsest lattice (5 to 321 posts) whose RMS
departure from the product's own posts meets `level_zero_error_m / 2^L`
(1920: 15 m at level 7), under the 32 KiB ceiling.

Measured on the products (`tools/moon-sample-budget.mjs`: levels 0-4 whole,
1,000 tiles a level stratified by row beyond):

| Level | Tiles | Mean bytes | RMS (m) | p99 (m) | Over cap |
| --- | --- | --- | --- | --- | --- |
| 7 | 32,768 | 13,415 | 12.35 | 45 | 0.9% |
| 8 | 21,504 | 6,963 | 6.25 | 22 | 0% |
| 9 | 57,344 | 5,120 | 3.01 | 11 | 0% |
| 10 | 57,344 | 4,107 | 1.54 | 6 | 0% |
| all | 179,882 | | | | at most 2.3% |

Total 1.293 GB (95% upper bound 1.307 GB). One unit peaks at 1.06 GiB RSS
(level 6, 67 MB of lines).

```sh
npm install && npm run build && npm test
LOLA_DIR=~/software/data/lola node ../terrain-source/tools/moon-sample-budget.mjs out.json
LOLA_DIR=~/software/data/lola node ../terrain-source/tools/moon-unit.mjs 16
```
