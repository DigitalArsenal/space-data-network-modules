# Continuous, distributed, operator-first screening, 2026-10

FFM (Full Force Model) is defined in [the FFM specification](../../../propagator/ffm/FFM.md).

The catalog's coarse grid is kept as its index. When objects get new orbit
data, only they are screened again, against the whole catalog; the result
equals a full re-screen for every pair they are in. The same scoping cuts any
screen into work units whose outputs reproduce byte for byte on any runtime,
so volunteers' machines can run them and replicas verify them. An operator's
node screens its own fresh data the same way and publishes data and results
together. Aggregates only: no element set or event leaves the machine that
computed it.

Module: `analysis/conjunction-assessment` 0.7.0 (`search_grid`), module
SHA-256 `ca5b9898007b5067c88e51bb54de82004a5e0a6e114bdba59843677cd2b6c106`.
Host: Mac Studio, Apple M3 Ultra, 28 cores, shared with other work (1-minute
load 12–40 during the runs); Node.js 25.4.0; 6 module threads unless stated.
Screens: 5 km threshold, 60 s coarse steps, SGP4 in 6-hour windows over 3 days
from 2026-10-01T00:00Z unless stated. Every number below is in
[continuous-distributed-screening-2026-10.json](continuous-distributed-screening-2026-10.json).

## Prior art and what is new

| Topic | Established | Here |
| --- | --- | --- |
| Screening new data against the catalog | 19 SDS screens an uploaded operator ephemeris against the catalog within 8 h; the full catalog screen runs daily, concern-list re-screens every 8 h ([SFS]); NASA's handbook recommends near-real-time screening of operators' ephemerides ([NHB]). TraCSS screens every 4 h ([W25]). SpaceX's platform queues each new trajectory, screens it against the latest trajectories and replaces them ([SSD]); its screener and Aerospace's CSieve found 263,635 and 263,637 conjunctions on one case, 263,633 in common ([AU25]). CSieve offered N-vs-all and a continuous mode ([G11]); CAOS-D indexed ephemerides for streaming updates ([BH14]). | A stated and tested equality: every pair with an updated member equals a full re-screen, and the previous screen with those pairs replaced equals the new full screen, on real update batches (MD2's concern lists "accept some risk of new data not being screened", [W25]). Work per cycle measured against 40 days of Space-Track's update cadence. |
| Pair search | Filters ([H84], [He95], [AR04], [WCS09]); spatial hashing and k-d trees ([BH14]); the module's swept-box grid ([R2]). | The grid kept between cycles as content-addressed f32 rows, searched with roles; a rigorous f32 rounding bound keeps the stored-grid search a superset of the f64 one. |
| Volunteer computing | BOINC: replication, quorum, homogeneous redundancy for floating-point differences, capability-matched dispatch ([B04], [B20], [T05]); sabotage tolerance and spot checks ([Sar02], [GM01]). No conjunction-screening application found. | Conjunction-screening units with content-hashed inputs whose outputs are byte-identical across V8, WasmEdge (interpreted and ahead-of-time) and Docker WasmEdge, so replicas are compared byte for byte with no homogeneous redundancy; WebAssembly's determinism ([Haas17]) carried through a threaded build. |
| Operator data | Operators publish ephemerides (Starlink [SLK]; CelesTrak SupGP republishes fits to them). The Space Data Association's Space Data Center screens operators' ephemerides centrally ([K10]); CCSDS OEM and CDM leave authentication to the network ([ODM], [CDM]). | Operator-run screening published with its data as signed, re-runnable units; an independent runtime reproduces every unit. |

Citations are listed under [References](#references).

## Incremental screening

1. **Index.** Each window's coarse grid (`coarse_grid`: every object's state
   and deviation bound at every 60 s step, f32) is kept: 4,548 MB for the
   3-day catalog of 32,514 objects, built in 15.1 s (100 CPU-s).
2. **Update.** coarse_grid on an index of only the updated objects gives their
   rows; they replace theirs in the kept grid (new objects append).
3. **Search.** `search_grid` searches each block with the updated objects as
   primaries: a pair is searched when one member is primary. Each row's f32
   rounding (≤ 2⁻²⁴ per component) is bounded from its magnitude and added to
   its deviation bound with 1 cm, so the candidates contain every pair-step
   the f64 search finds. A secondary whose radius band cannot come within the
   threshold of a primary's band over the block is skipped.
4. **Refine.** `refine_candidates` re-tests each candidate in f64 on an index
   of only the objects the candidates name, in catalog order, so each pair is
   refined as on the whole catalog's index.

Pairs are screened independently and the module is deterministic, so steps
3–4 return a pair's events exactly as a full screen does. Checked on real
data: the snapshot is Space-Track's GP catalog of 2026-09-30 (element sets
created to 16:56:33Z); each batch applies the element sets Space-Track created
in its interval (`gp_history`, newest epoch per object).

| Batch (element sets created) | Updated (new) | Their share of pairs | Incremental | Full screen | Ratio (CPU) | Events with an updated member | Equal |
| --- | ---: | ---: | --- | --- | ---: | ---: | --- |
| 09-30 16:56Z to 18:15Z | 35 | 0.2 % | 3.8 s, 22 CPU-s | 37.1 s, 195 CPU-s | 8.9 | 132 | yes |
| 18:15Z to 18:30Z, a batch publication | 23,035 (4) | 91.5 % | 67.7 s, 362 CPU-s | 35.7 s, 188 CPU-s | 0.5 | 249,679 | yes |
| 18:30Z to 10-01 00:00Z | 71 | 0.4 % | 5.7 s, 31 CPU-s | 36.7 s, 197 CPU-s | 6.4 | 544 | yes |
| 10-01 00:00Z to 03:30Z | 15 | 0.1 % | 3.7 s, 19 CPU-s | 35.8 s, 189 CPU-s | 9.8 | 9 | yes |
| 03:30Z to 04:00Z, a batch publication | 19,116 (32) | 83.0 % | 64.3 s, 329 CPU-s | 35.4 s, 188 CPU-s | 0.6 | 223,359 | yes |

The snapshot's full screen: 294,544 conjunctions, 36.8 s (186 CPU-s); its
index, 15.1 s (100 CPU-s). The full screens after each batch hold 294,541,
264,388, 264,509, 264,499 and 253,363 conjunctions.

"Equal" means both checks pass, every field of every event compared: the
incremental events are exactly the full re-screen's events that involve an
updated object, and the previous full screen with those pairs replaced is the
new full screen. Two of the batches are Space-Track's batch publications.

### Work by number of updated objects

The objects updated from 16:56Z to 18:30Z on 09-30 (mostly the 18:20Z batch
publication), in a fixed pseudo-random order; the first k applied to the
snapshot, each state compared with the snapshot's screen.

| Updated objects | Their share of pairs | Incremental | Full screen | Ratio (CPU) | Events with an updated member | Equal |
| ---: | ---: | --- | --- | ---: | ---: | --- |
| 100 | 0.6 % | 5.6 s, 32 CPU-s | 36.9 s, 194 CPU-s | 6.0 | 2,171 | yes |
| 300 | 1.8 % | 5.5 s, 35 CPU-s | 37.5 s, 203 CPU-s | 5.9 | 5,868 | yes |
| 1,000 | 6.1 % | 8.6 s, 50 CPU-s | 37.1 s, 201 CPU-s | 4.1 | 19,192 | yes |
| 3,000 | 17.6 % | 18.5 s, 98 CPU-s | 36.9 s, 202 CPU-s | 2.1 | 54,242 | yes |
| 10,000 | 52.1 % | 35.1 s, 187 CPU-s | 35.6 s, 190 CPU-s | 1.0 | 155,025 | yes |

The incremental times include refreshing the updated rows (0.2 s at 100
objects, 6.0 s at 10,000) and refinement on a per-window index of the objects
in candidates.

Below a few hundred objects the incremental screen is dominated by reading
the whole stored grid (about 3.7 s for 3 days on 6 threads: every catalog
row of 4,321 steps, moved into the module and tested against the primaries'
cells). Refinement grows with k. At about 10,000 objects (31 % of the
catalog) it costs as much as a full screen.

## Update cadence

Space-Track `gp_history` by `CREATION_DATE`, 2026-09-01 to 2026-10-11 (40
days, 2,976,351 records; 97.6 % change an object's element set, the rest
repeat its latest one). The catalog held 32,392 to 32,703 objects with an
epoch within 30 days. k is the number of objects whose element set changed
in a cycle (`scripts/update-cadence.mjs`).

| Cycle | Cycles | Empty | k median | k p90 | k max | Batch cycles (k ≥ 10 % of N) | Their share of updates | k outside batches, mean |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 15 min | 3,840 | 1,760 | 1 | 9 | 27,620 | 5.4 a day | 96.2 % | 31 |
| 1 h | 960 | 127 | 6 | 16,889 | 27,620 | 4.3 a day | 98.9 % | 39 |
| 1 day | 40 | 0 | 27,877 | 29,108 | 30,073 | 1 a day | 100 % | – |

Space-Track publishes in batches: about five a day, each changing 10 % to
85 % of the catalog, with a trickle of a few objects between them. In pair
work (a full screen = 1; re-screening k objects covers 1 − (1 − k/N)² of the
pairs), keeping every update screened within 15 minutes costs 3.4 full
screens a day incrementally against 52 full re-screens (one per cycle with an
update); within an hour, 3.2 against 20.8; once a day, 0.97 against 1.

In measured time the stored grid's fixed cost dominates the trickle cycles
(19–31 CPU-s against 186–197 for a full screen, Incremental screening). With
a full screen for each batch publication and the incremental screen for every
other 15-minute cycle with an update, every update is screened within
15 minutes for about 2,200 CPU-s a day (5.4 full screens and 46.6 trickle
cycles), against about 9,900 CPU-s for a full re-screen every cycle
(computed from the measured costs above).

Other sources (CelesTrak supplemental GP, our archive of 2026-10-10 to
10-11, snapshots about every 3.05 h; k per interval, median):

| Group | Objects | k per interval |
| --- | ---: | ---: |
| Starlink | 11,129 | 11,125 |
| OneWeb | 651 | 213 |
| Kuiper | 391 | 320 |
| Planet | 103 | 50 |
| Iridium | 80 | 80 |

An operator's update is its whole constellation at once. AOE's own catalog
(SpaceMapper, channel KY) is one daily batch with epochs at 00:00Z, written
about 01:05Z (E15); the archive held no finished snapshot to count.

## FFM

With a numerical propagator a screen's cost is propagation: 99,929 CPU-s of
the 3-day full-force screen of the catalog
([ffm-full-force-screen-2026-10.md](ffm-full-force-screen-2026-10.md)).
Propagation is per object and deterministic, so the incremental screen
propagates only the objects whose element sets changed and keeps every other
trajectory. Checked with `propagator/ffm` 1.3.0 at full force
(`scripts/incremental-ffm.mjs`; 5 farm workers; the environment as released
at 2026-10-01T00:00Z) on catalog subsets, six 1-hour windows from
2026-10-01T00:00Z:

| Subset | Objects | Full propagation | Batch (created) | Updated | Incremental propagation | Events with an updated member | Equal |
| --- | ---: | ---: | --- | ---: | ---: | ---: | --- |
| Perigee 300–700 km by stride, and every object a batch updates | 2,112 | 1,622 CPU-s | 09-30 18:30Z to 10-01 00:00Z | 71 | 23.8 CPU-s | 9 | yes |
| | | | 10-01 00:00Z to 03:30Z | 15 | 6.2 CPU-s | 0 | yes |
| Perigee 500–600 km, and 200 objects of the 18:20Z batch publication | 3,146 | 3,294 CPU-s | 09-30 18:15Z to 18:30Z | 164 | 92.4 CPU-s | 13 | yes |

The full screens of the three updated subsets hold 171, 171 and 718
conjunctions; each equals the previous screen with the updated pairs
replaced. Determinism: in each run 50 unchanged objects propagated again give
300 of 300 window trajectories with identical coefficients.

An updated element set costs 0.34–0.56 CPU-s here against 0.77–1.05 s for the
subsets' objects: FFM integrates from the element epoch, and a new set's
epoch is recent. Computed from measured values: Space-Track changes 72,400
element sets a day on average (Update cadence); propagating each over a 3-day
horizon at 0.645 CPU-s per object-day (`propagator/ffm` README, "Catalog
cost") is about 140,000 CPU-s a day, 1.6 cores, against 99,929 CPU-s for
each full re-screen.

## Work units and verification

A screen is cut into units:

- **grid units:** a block of catalog rows × a window → those rows' coarse
  grid (the index);
- **screen units:** a block of primaries × a window → the events of its
  pairs. The unit's block is primary, earlier blocks are skipped, everything
  else is secondary, so every pair is in exactly one unit.

A unit record names every input by SHA-256: the module, the sources (the
catalog's OMM records), the window's grid blocks and exclusions, the roles,
and the controls. Its id is the SHA-256 of the record. The module's outputs
do not depend on the runtime or the thread count, so two replicas of a unit
must be byte-identical. Each answer is filed by hash and announced with a PNM
(SDS publish notification: the output's CIDv1, the unit id, an Ed25519
signature).

Local harness (`scripts/distributed-screen.mjs`): five worker processes act
as independent volunteers, each with its own module instance and key, and
declare threads and memory; a unit goes only to a worker with the memory it
needs. A keyed 30 % of units (HMAC of the unit id) run on two workers, a
different runtime where one is free; a mismatch goes to a third worker, the
strict majority wins, the minority worker's answers stop counting, and every
unit that relied on them runs again. A unit unanswered by its deadline goes
to another worker; two such retire a worker.

The 3-day screen of the 32,514-object catalog, 4 row blocks and 4 primary
blocks × 12 windows:

| Worker | Runtime | Threads | Memory | Behaviour | Grid units | Screen units | Outcome |
| --- | --- | ---: | ---: | --- | ---: | ---: | --- |
| w1 | Node V8 | 2 | 4,096 MiB | honest | 21 | 37 | |
| w2 | Node V8 | 1 | 768 MiB | honest | 13 | 0 | too small for a screen unit (856 MiB) |
| w3 | WasmEdge AOT (SDN patches) | 1 | 4,096 MiB | honest | 11 | 26 | |
| w4 | Node V8 | 1 | 4,096 MiB | hides the closest conjunction of half its screen units | 13 | 18 | caught; its 9 altered outputs discarded |
| w5 | Node V8 | 1 | 4,096 MiB | never answers 30 % of its units | 1 | 3 | retired after 2 unanswered |

| Result | |
| --- | ---: |
| Units | 96 (48 grid, 48 screen) |
| Replicated | 29 |
| Replicas compared among honest workers | 27, all byte-identical; 23 across runtimes (V8 and WasmEdge AOT) |
| Mismatches, all w4's | 5, settled by a third run |
| Units run again after w4 was caught | 13 |
| Conjunctions | 294,544; the canonical event set's SHA-256 equals the single-process screen's |
| Time | grids 90.3 s, screen 105.8 s; the single-process screen on 6 threads, 42.6 s |

Replication catches a dishonest worker only through a replicated unit it
altered: with replication r, m altered units escape with probability
(1 − r)^m (0.3 and 9 here: 4 %). Once caught, all of its work is redone.

## Operator-first screening

An operator's node screens its own fresh data against the network's index
and publishes the data and the results together (`scripts/operator-first.mjs`):

1. **Data.** SpaceX's current Starlink ephemerides (MEME, `api.starlink.com`),
   the first two orbits of each file read into memory and never stored.
2. **Fit.** The OD module (`analysis/od`, WASM) fits SGP4 mean elements to
   each (the SupGP practice), so the screen keeps one propagator.
3. **Screen.** Those objects' rows replace theirs in the index; one screen unit
   per window with them as primaries.
4. **Publish.** The element sets, every unit record and every output are filed
   by hash; a manifest lists them; a PNM signed by the operator's key names
   the manifest's CID.
5. **Verify.** An independent process in another runtime (WasmEdge AOT)
   rebuilds each window's grid from the unit's sources with grid units,
   re-runs each unit, and compares bytes.

Two runs on 2026-10-11, 3 days from the start of the hour, against a catalog of
32,611 objects (Space-Track's GP of 2026-10-10 and every newer element set,
created to 10:26Z on 10-11):

| | 64 satellites, SpaceX's files fitted here | The constellation, CelesTrak's fits |
| --- | --- | --- |
| Operator data | 64 of the 11,130 files in SpaceX's manifest, 6.0 MB, fetched in 16.3 s | CelesTrak's supplemental GP of 10:25Z (fits to the same files) |
| Element sets | 64; fit RMS median 0.113 km, largest 0.258 km | 11,129; RMS median 0.246 km |
| From data in memory to the signed PNM | 9.1 s, 23 CPU-s: fit 3.3 s, the operator's rows 0.2 s, 12 units 5.2 s | 45.9 s, 150 CPU-s: rows 5.9 s, 12 units 28.8 s |
| Conjunctions within 5 km | 4,277 (closest 113 m; 167 within 1 km) | 328,759 (closest 16 m; 14,324 within 1 km) |
| Independent check (WasmEdge AOT, separate process) | 12 of 12 window grids rebuilt from the sources byte-identical; 12 of 12 outputs byte-identical; PNM signature valid; 71 s | the same, 12 and 12; 126 s |
| The network's index (not in the latency) | 14.4 s | 15.5 s |

The units' time includes hashing each window's grid (375 MB) to name it.

## Runtime parity and tests

- `scripts/verify-continuous-screening-parity.mjs`: 20 resident requests (an
  index of invented element sets, coarse_grid, search_grid all-vs-all and
  with roles at 1 and 4 threads, search_candidates, a one-object grid, a
  sub-index refinement, two refused requests) are byte-identical in Node V8,
  real Chrome, native WasmEdge, Docker WasmEdge and WasmEdge AOT built
  against SDN's patched WasmEdge 0.16.4. On the same steps search_grid
  proposes the same 205 candidates as search_candidates
  ([continuous-screening-parity.json](continuous-screening-parity.json)).
- `tests/continuousScreening.test.mjs` (invented element sets): incremental
  equals the full re-screen; blocks × windows cover every pair once and
  reproduce the full screen; a unit is byte-identical on two instances at 1
  and 4 threads.

## Where the network part stops

| Piece | SDN mechanism | Here |
| --- | --- | --- |
| Module | Signed module artifacts delivered over the libp2p module-delivery lane | Unit records name the module's SHA-256; a worker refuses a unit for another module |
| Inputs and outputs | Content-addressed records retrieved by CID | A local store filed by SHA-256, verified on every read; CIDv1 (raw, sha2-256) in every PNM |
| Announcement | PNM over pubsub (a flow's publication node has the `pubsub` capability), DPM as the signed manifest | Real SDS PNM records, Ed25519-signed; the manifest is JSON, not a DPM record |
| Keys | The node's identity key | An ephemeral Ed25519 key per worker and per operator |
| Operator pipeline | The supplemental-OMM flow: provider → OD → FlatSQL → publication | The same steps in one script; no flow node wraps the screen |
| Scheduling | None | A coordinator process: capability matching, keyed replication, deadlines, majority; it moves bytes and checks signatures only |

The network part stops at the process boundary: units, records, signatures,
replication and verification run between local processes on one host; no
unit, PNM or output crosses SDN pubsub or libp2p, and no SDN service offers
units to volunteers.

## Limits

| Limit | Effect |
| --- | --- |
| Reading the stored grid | A small update costs about 4–6 s for 3 days on 6 threads, whatever k: every catalog row is moved into the module and tested |
| Batch publications | 96 % of Space-Track's updates arrive in about five batches a day of 10–85 % of the catalog; above about 10,000 objects a full screen costs the same |
| Index memory | 4.5 GB of f32 rows for 3 days of 32,514 objects, kept by the host; each search call passes one block (about 33 MB) |
| One propagator per index | An operator's own ephemeris enters as fitted SGP4 elements; its planned maneuvers past the fit's two orbits do not |
| f32 bound | Assumes IEEE 754 round-to-nearest conversion of finite values (every runtime tested) |
| Replication | Catches an altered unit only when it is replicated; the probability is above |
| One host | Volunteers are local processes; timings are from one shared workstation |
| GPU | The GPU kernel screens all-vs-all only; roles run on the CPU |

## Reproduce

```sh
npm ci && node build.mjs
npm run test:continuous-parity            # five runtimes with CA_WASMEDGE_AOTC/CA_WASMEDGE_AOT_RUNNER set
node --test tests/continuousScreening.test.mjs
node scripts/update-cadence.mjs --gp-history <by-creation> --from 2026-09-01T00:00:00Z --to 2026-10-11T00:00:00Z --supgp <supgp dir> --out cadence.json
node scripts/incremental-screen.mjs --catalog-json gp-2026-09-30.json --gp-history <by-creation> \
  --batches 2026-09-30T18:15:00Z,2026-09-30T18:30:00Z,2026-10-01T00:00:00Z,2026-10-01T03:30:00Z,2026-10-01T04:00:00Z --out batches.json
node scripts/incremental-screen.mjs ... --batches 2026-09-30T18:30:00Z --subsets 100,300,1000,3000,10000 --out sweep.json
node scripts/incremental-ffm.mjs --catalog-json gp-2026-09-30.json --gp-history <by-creation> --base-to 2026-09-30T18:30:00Z \
  --batches 2026-10-01T00:00:00Z,2026-10-01T03:30:00Z --ffm-environment <env> --out ffm.json
node scripts/distributed-screen.mjs --catalog catalog.OMM.uint32be.bin --store <dir> --out distributed.json \
  --workers node:2:4096,node:1:768,wasmedge-aot:1:4096,node:1:4096:cheat=0.5,node:1:4096:drop=0.3 --aotc <aotc> --aot-runner <runner>
node scripts/operator-first.mjs --gp <gp snapshot> --gp-history <by-creation> --store <dir> --out operator.json --verify-runtime wasmedge-aot ...
```

Space-Track and operator data are not redistributable: the catalog files,
the stores and the per-event outputs stay local.

## References

Checked through Crossref, OpenAlex, arXiv and the publishers' pages; [WCS09]
only through citing papers' reference lists.

- [AR04] Alarcón Rodríguez, Martínez Fadrique, Klinkrad, Advances in Space Research 34 (2004) 1120, doi:10.1016/j.asr.2003.01.015 (the smart sieve).
- [AU25] Auman et al., Validation methodology for TraCSS conjunction assessment, AMOS Conference 2025, doi:10.64861/GVYB8737.
- [B04] D. P. Anderson, BOINC: a system for public-resource computing and storage, 5th IEEE/ACM Workshop on Grid Computing (2004) 4–10, doi:10.1109/GRID.2004.14.
- [B20] D. P. Anderson, BOINC: a platform for volunteer computing, Journal of Grid Computing 18 (2020) 99–122, doi:10.1007/s10723-019-09497-9.
- [BH14] Budianto-Ho et al., Scalable conjunction processing using spatiotemporally indexed ephemeris data, AMOS Conference 2014, https://amostech.com/TechnicalPapers/2014/Conjunction_Assessment/BUDIANTO-HO.pdf.
- [CDM] CCSDS 508.0-B-1, Conjunction Data Message (2013, technical corrigendum 2021).
- [G11] George, High performance conjunction assessment technique for cluster and multi-core computers, AMOS Conference 2011, https://amostech.com/TechnicalPapers/2011/Astrodynamics/GEORGE.pdf.
- [GM01] P. Golle, I. Mironov, Uncheatable distributed computations, CT-RSA 2001, doi:10.1007/3-540-45353-9_31.
- [H84] F. R. Hoots, L. L. Crawford, R. L. Roehrich, An analytic method to determine future close approaches between satellites, Celestial Mechanics 33 (1984) 143–158, doi:10.1007/BF01234152.
- [Haas17] A. Haas et al., Bringing the web up to speed with WebAssembly, PLDI 2017, 185–200, doi:10.1145/3062341.3062363.
- [He95] L. M. Healy, Close conjunction detection on parallel computer, Journal of Guidance, Control, and Dynamics 18 (1995) 824–829, doi:10.2514/3.21465.
- [K10] T. S. Kelso, How the Space Data Center is improving safety of space operations, AMOS Conference 2010.
- [NHB] NASA Spacecraft Conjunction Assessment and Collision Avoidance Best Practices Handbook, NASA/SP-20205011318 (2020); revision 1, NASA/SP-20230002470 (2023); revision 2, volumes 1 and 2 (2026), https://ntrs.nasa.gov/citations/20260000453 and https://ntrs.nasa.gov/citations/20260000457.
- [ODM] CCSDS 502.0-B-3, Orbit Data Messages (2023).
- [R2] This module: [gpu-all-vs-all.md](gpu-all-vs-all.md), the swept-box grid and the CPU search.
- [Sar02] L. F. G. Sarmenta, Sabotage-tolerance mechanisms for volunteer computing systems, Future Generation Computer Systems 18 (2002) 561–572, doi:10.1016/S0167-739X(01)00077-2.
- [SFS] 18th and 19th Space Defense Squadrons, Spaceflight Safety Handbook for Satellite Operators, version 1.7 (2023), https://www.space-track.org/documents/SFS_Handbook_For_Operators_V1.7.pdf.
- [SLK] SpaceX, Starlink public ephemerides, https://api.starlink.com/public-files/ephemerides/ (README and MANIFEST).
- [SSD] SpaceX, Starlink space safety documentation (architecture, trajectories, operations), https://docs.space-safety.starlink.com/docs/.
- [T05] M. Taufer et al., homogeneous redundancy for public-computing results, IPDPS 2005, doi:10.1109/IPDPS.2005.247.
- [W25] Wolff, Ramos, Cornelius, Collins, MD2 and TraCSS conjunction assessment compared, AMOS Conference 2025, doi:10.64861/XWVP8211.
- [WCS09] J. Woodburn, V. Coppola, F. Stoner, A description of filters for minimizing the time required for orbital conjunction computations, AAS 09-372 (2009).
