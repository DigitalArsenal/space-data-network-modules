# Mars terrain (NASA MGS MOLA)

The Mars terrain lane, run on a provider node by the flow
`com.digitalarsenal.flows.mars-terrain-ingest` (`flow-mars.mjs`, composed by the
stack's `deployment/solar-system-provider-node`). It is the Moon's lane
(`README-moon.md`) with the Mars table of `src/body_plan.hpp`: flow config
`body: mars`. Each packed file is added to the node's IPFS and announced as one
`$PNM`, auto-published as `PNM.fbs`, provider `nasa-mola`, source
`mars-terrain`, files `terrain/499/root.dtts.gz` (levels 0–2) and
`terrain/499/<L>/<X>_<Y>.dtts.gz` (4×4 blocks). Each file is gzip of a
size-prefixed `$DTT` record stream; body payloads use the lossless
`qm-edge-matched-planes-v1` encoding.

Sources: the MOLA Mission Experiment Gridded Data Records in the PDS
Geosciences Node (`mgs-m-mola-5-megdr-l3-v1/mgsl_300x/`, public domain), the
`megr` (planetary radius) products. Heights are radius minus 3,396,000 m, on
the 3396.0 km reference sphere (`CENTER_NAME MARS`, `REFERENCE_SPHERE`),
planetocentric, east-positive. They are not areoid heights: the Olympus Mons
summit is about 21.4 km above the sphere and the north pole about 19.8 km
below it.

| Cap | Product | Levels | Band |
| --- | --- | --- | --- |
| global | `meg004/megr90n000cb` (4 ppd, 14.8 km) | 0-3 | all |
| global | `meg016/megr90n000eb` (16 ppd, 3.7 km) | 4-5 | all |
| global | `meg032/megr90n000fb` (32 ppd, 1.85 km) | 6 | all |
| global | `meg064/megr*gb`, 4 files (64 ppd, 926 m) | 7 | all |
| global | `meg128/megr*hb`, 16 files (128 ppd, 463 m) | 8 | \|lat\| <= 87.1875 |
| polar | `polar/megr_{n,s}_512` (512 ppd, 116 m) | 8 | \|lat\| >= 87.1875 |
| polar | `polar/megr_{n,s}_512` | 9 | \|lat\| >= 78.75 |
| polar | `polar/megr_{n,s}_512` | 10 | \|lat\| >= 84.375 |

The 128 ppd files stop at 88 degrees, so level 8 meets the polar caps on the
87.1875-degree block-row edge. The 128 and 256 ppd polar labels misstate
`RECORD_BYTES` and are not used. The polar labels state `OFFSET = 0`; their
image description puts the values relative to the 3396000 m sphere, which is
how terrain-source reads them. Their projection is spherical polar
stereographic (`r = 2 R tan(colat/2)`), not the `sin` the label formula
states: against the 128 ppd tiles at 79.5-87.5 N the `tan` reading has
33.9 m RMS and `sin` 42.1 m.

A simple cylindrical unit is one block row (runs of at most 64 blocks by
longitude at level 8), reading the row's lines from every file it crosses, one
label and one range per file (at most 8 files, 16 requests). A polar unit is
as the Moon's: at most 64 blocks and `max_range_bytes` of lines, the label and
three ranges. 385 units.

```sh
npm install && npm run build
MOLA_DIR=~/software/data/mola node --test tests/mars_megdr.test.mjs
BODY=mars DATA_DIR=~/software/data/mola node ../terrain-source/tools/body-unit.mjs 100 out
```
