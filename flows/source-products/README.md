# Source products flow

One pure-compute flow that gives the products of one source, whatever its type
(catalog pipeline C2, `graph/programs/catalog-pipeline.md`, section 1). Every
source gets the same records for every object it covers, so sources are
compared like for like and any one can be shown on its own:

| Product | SDS | Element-set source | Ephemeris source | Observation source |
| --- | --- | --- | --- | --- |
| SGP4 elements | `$OMM` | the source's own newest set per object | the set `analysis/od` fitted to the ephemeris | the set fitted to the estimated arc |
| SGP4-XP elements | `$OMM`, theory SGP4XP | passed through with the source named; no covariance until the XP propagator and error model land (`modules-sgp4-xp-fits-20261011`) | same | same |
| State and covariance | `$OCM` | SGP4 epoch states (`analysis/epoch-state`) with the modeled covariance | the operator's covariance as supplied, else the same modeled covariance | the estimate's formal covariance times the measured realism factor |
| Maneuvers | `$MNV` | `detect_maneuvers` over the set history, SGP4 answering the propagator query port | `compare_ephemerides`, planned against executed | none |

Every record names its source: `ORIGINATOR` the source's originator, the
provider, the licence class and the lineage in `USER_DEFINED_PARAMETERS`
(`$OCM`), `COMMENT` (`$OMM`) and `TAGS` (`$MNV`, which has no `ORIGINATOR`). A
recipe that does not name them is refused. Records of a source without
reproduction terms are computed on and cited, never republished: the report
carries the licence of each.

## Covariance for every object

The first rule that applies, by `analysis/gp-error-model` `attach_covariance`
(README there):

1. **Operator covariance, as supplied**: the `ephemeris` frame's covariance lines.
2. **Fit covariance**: the formal covariance of a fit (`fit` frame), times the realism factor the recipe holds for the source and fit class, measured on held-out data. Laser-range fits measured 16 to 21 times too small (E6).
3. **Modeled covariance**: the source's own model of its element sets' error by orbit regime and element-set age (E14 S3-KC), at the epoch plus each age of the recipe.
4. **Pooled model**: the model pooled over all sources, for a source with none of its own.

Rules 3 and 4 cover every object that has an SGP4 element set in a regime the
model covers (LEO-L, LEO-M, LEO-H, MEO, GEO). Each row carries its label:
method, source, regime and age cell, and the held-out verdict for that cell.
A row is `CALIBRATED` where E14's realism rule passed on the test window for
the lineage the source belongs to (E14: LEO-H at 0 and 0.5 days); otherwise
`UNCALIBRATED`, with the cell's measured mean d²/3 and coverage and the reason.

## Ingress and egress

Every ingress frame is enqueued before the flow drains. A frame enqueued on a
trigger goes to every node port bound to it.

| Trigger | Content | For |
| --- | --- | --- |
| `element_sets`, `element_set_recipe` | A source's element-set history (`$OMM`, one frame) and its recipe (JSON) | element-set source |
| `fit_omm` | The SGP4 set fitted to the ephemeris or the estimated arc (`$OMM`, `analysis/od` fit) | ephemeris and observation sources |
| `ephemeris` | The operator's ephemeris (`$OEM`, one object); its covariance lines are rule 1 | ephemeris source |
| `ephemeris_versions`, `planned_maneuvers` | The versions of the ephemeris (`$OEM`, one frame each) and the planned maneuvers (`$MNV`) | ephemeris source |
| `fit` | The estimate's state and formal covariance (`$OCM`) | observation source |
| `fit_recipe` | The recipe (JSON) | ephemeris and observation sources |

Egress, one sink `sdn.flow.egress` with ports `ocm`, `omm`, `mnv` (the
products) and `covariance_report`, `derive_report`, `detect_report`,
`propagation_report`, `compare_report`, `attribute_report` (provenance: the
rule per object, why earlier rules did not apply, every row's verdict, the
SHA-256 of each record, the licence).

The recipe (`analysis/gp-error-model` README) also carries `ages`: the days
after each set's epoch at which the OCM gets a state and its covariance
(default `[0]`). `data/e14-s3-kc.json` in `analysis/gp-error-model` is the
model and its verdicts.

## Why `analysis/od` is not a node

`analysis/od` is built as a `wasm32-wasip1-threads` module (0.1.2) and its
committed guest-link object is of 0.1.0: it references `od::build_ocm_flatbuffer`
without defining it, so the flow compiler cannot link it. The source's own
flow runs the fit and hands this flow the set it fitted. When OD's guest-link
object is current, `f_od` is one node and two edges (`ephemeris` and `arc` into
its `oem`; its `omm` into `f_derive` and `f_attach`).

## Sources

`sources.json` lists every orbit data-source module in this repository, the
ingress it feeds and what it cannot give (the GPS almanac is not SGP4, the
OneWeb LTEF is undecoded, SPK ephemerides are not Earth-orbiting).
`tests/sources.test.mjs` checks each against its manifest and against the
flow's ports with the SDK's flow checker.

## Build and test

```sh
npm run check   # flow check
npm run build   # flow compile -> dist/ (single-thread Emception link of the modules' guest-link objects)
npm test        # the flow in the SDK's JS flow host, compared byte for byte with the module chain
```

The modules' guest-link objects (`dist/guest-link` of `analysis/epoch-state`,
`analysis/gp-error-model`, `analysis/maneuver-detection`) are built by their own
`npm run build`; rebuild them, then this flow. The vendored SGP4 has internal
linkage in `epoch-state` and `gp-error-model` so that their objects, and
`analysis/od`'s, link into one artifact. Each module's methods are byte-identical
in the browser, WasmEdge and Docker WasmEdge (`tests/parity.mjs` in each module).
The compiled flow itself runs in the SDK's JS flow host here; its runtime under
the node's WasmEdge host is exercised by the node's flow integration tests.
