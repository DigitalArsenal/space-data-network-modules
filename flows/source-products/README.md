# Source products flow

One pure-compute flow that gives the products of one source, whatever its type
(catalog pipeline C2, `graph/programs/catalog-pipeline.md`, section 1). Every
source gets the same records for every object it covers, so sources are
compared like for like and any one can be shown on its own:

| Product | SDS | Element-set source | Ephemeris source | Observation source |
| --- | --- | --- | --- | --- |
| SGP4 elements | `$OMM` | the source's own newest set per object | the set the OD fitted to the ephemeris | the set fitted to the estimated arc |
| SGP4-XP elements | `$OMM`, theory SGP4XP | passed through with the source named; no covariance until the XP propagator and error model land (`modules-sgp4-xp-fits-20261011`) | same | same |
| State and covariance | `$OCM` | SGP4 epoch states (`analysis/epoch-state`) with the modeled covariance | the operator's covariance as supplied, else the same modeled covariance | the estimate's formal covariance times the measured realism factor |
| Maneuvers | `$MNV` | `detect_maneuvers` over the set history, SGP4 answering the propagator query port | `compare_ephemerides` (the versions against the planned maneuvers) and the same detector over the history of fitted sets | the detector over the history of fitted sets, when the host supplies several |

Every record names its source: `ORIGINATOR` the source's originator, the
provider, the licence class and the lineage in `USER_DEFINED_PARAMETERS`
(`$OCM` and `$OMM`) and `TAGS` (`$MNV`, which has no `ORIGINATOR`). A
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
| `element_sets_mpe` | The same history as the GP history archive stores it (`$MPE`, one frame); `omm_from_mpe` converts it and the `$OMM` takes the lane of `element_sets` | element-set source that stores `$MPE` |
| `fit_omm` | The SGP4 sets fitted to the ephemeris or the estimated arc (`$OMM`; the newest fit is the product, the history is screened for maneuvers) | ephemeris and observation sources |
| `ephemeris` | The operator's ephemeris (`$OEM`, one object); its covariance lines are rule 1 | ephemeris source |
| `ephemeris_versions`, `planned_maneuvers` | The versions of the ephemeris (`$OEM`, one frame each) and the planned maneuvers (`$MNV`) | ephemeris source |
| `fit` | The estimate's state and formal covariance (`$OCM`) | observation source |
| `fit_recipe` | The recipe (JSON) | ephemeris and observation sources |

Egress, one sink `sdn.flow.egress` with ports `ocm`, `omm`, `mnv` (the
products) and `covariance_report`, `derive_report`, `mpe_report`, `detect_report`,
`propagation_report`, `compare_report`, `attribute_report` (provenance: the
rule per object, why earlier rules did not apply, every row's verdict, the
SHA-256 of each record, the licence).

The recipe (`analysis/gp-error-model` README) also carries `ages`: the days
after each set's epoch at which the OCM gets a state and its covariance
(default `[0]`; `recipe.mjs` sets E14's horizons, 0 to 7 days). `data/e14-s3-kc.json` in
`analysis/gp-error-model` is the model and its verdicts.

## The fit stage

An ephemeris or observation source brings the SGP4 sets fitted to its states. The
fit is not a node of this flow. The production fit stage is the OD node of
`flows/supplemental-omm`, which reads the provider-native responses of Starlink,
the ISS, Intelsat, GLONASS and CPF (Earth-fixed and position-only states
included) and gives `$OMM`, `$OCM` and `$OBD` record streams. `analysis/od` is
built as a `wasm32-wasip1-threads` module (0.1.2) and its committed guest-link
object is of 0.1.0: it references `od::build_ocm_flatbuffer` without defining
it, so the flow compiler cannot link it either. A host unwraps the OD node's
record streams and enqueues the `$OMM` on `fit_omm`.

## Sources

`sources.json` registers every orbit data-source module of this repository and
where it enters the flow; `recipe.mjs` (`recipeFor(id, { created, via, ages })`)
makes the recipe of a registered source: its originator, lineage and licence,
the provider (the plugin id of the module that gave the records), the E14 model
(rule 3 for the sources E14 measured, rule 4 pooled for the others) and the ages
of E14's horizons.

| | Modules |
| --- | --- |
| Give products | `celestrak-reference` and `celestrak-parser` (CelesTrak GP); `spacetrack-source` (Space-Track's REST JSON: `gp`, `gp_history` as `$OMM`, `satcat` as `$CAT`), `gp-archive-records` (`$MPE`) and `retrieval` (`$OMM`) for the GP history archive; `spacex-starlink-source`; `iss-source` and `oem-source-iss`; `intelsat-source`; `vimpel-source` (JSC Vimpel's rectangular ephemerides, fitted by `analysis/od`; its osculating-element states and datefirst crosswalk are for the integrator); `glonass-source` (IAC); `cpf-source` (ILRS CPF from EDC; ESA's listing by configuration) |
| Cannot yet | `celestrak-supgp` (pull-only), `gps-source` (almanac elements, not SGP4), `oneweb-source` (the LTEF is not decoded): the reason and the task are in the file |
| Describe or identify | `celestrak-request`, `ephemeris-source`, `catalog-source`, `spk-source` |

The sources the ephemeris-source inventory lists that no module gives yet, and
the observation sources the paper names (ILRS CRD normal points, SatNOGS Doppler),
are `missing` in the file, each with the graph task that builds it; a module that
lands moves its entry to `sources`. `tests/sources.test.mjs` holds the file to
the modules' manifests and to the flow:

- every module under `data-source` that gives or describes orbit data is
  classified once;
- each module has the method and the typed output port the file names, and the
  flow takes that type where it enters;
- every source of the inventory is wired, refused or missing, and a missing
  entry does not outlive its module;
- the flow, run with each source's recipe on each module's lane, names the source,
  its provider and its licence on the `$OCM`, the `$OMM` and the `$MNV`.

## Build and test

```sh
npm run check   # flow check
npm run build   # flow compile -> dist/ (single-thread Emception link of the modules' guest-link objects)
npm test        # the flow in the SDK's JS flow host, compared byte for byte with the module chain
```

Each module keeps its own copy of the SDS code it was generated against, with
internal linkage: the linker keeps one copy of each equal external C++ symbol, and the
`$OMM` of gp-error-model (release 1.245.0) differs from epoch-state's (1.226.0) in a field
it writes. Without this the flow wrote the older `$OMM` and dropped the label.

The modules' guest-link objects (`dist/guest-link` of `analysis/epoch-state`,
`analysis/gp-error-model`, `analysis/maneuver-detection`) are built by their own
`npm run build`; rebuild them, then this flow. The vendored SGP4 has internal
linkage in `epoch-state` and `gp-error-model` so that their objects, and
`analysis/od`'s, link into one artifact. Each module's methods are byte-identical
in the browser, WasmEdge and Docker WasmEdge (`tests/parity.mjs` in each module).
The compiled flow itself runs in the SDK's JS flow host here; its runtime under
the node's WasmEdge host is exercised by the node's flow integration tests.
