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

Every record names its source in `PROVENANCE` (SDS 1.246.0 PVN, on `$OMM`, `$OCM`
and `$MNV`): `SOURCE_ID`, `SOURCE_KIND`, `ORIGINATOR` the source's originator,
`PROVIDER_ID`, `PRODUCER`, `LICENSE_CLASS`, `LICENSE_ID` and `LINEAGE`. The CCSDS
`ORIGINATOR` of an `$OMM` or `$OCM` names the message's creator, the recipe's
`producer` (this flow). A recipe that does not name the source is refused. Records of
a source without reproduction terms (`LICENSE_CLASS` other than Reproducible) are
computed on and cited, never republished: the report carries the licence of each.

## Covariance for every object

The first rule that applies, by `analysis/gp-error-model` `attach_covariance`
(README there):

1. **Operator covariance, as supplied**: the `ephemeris` frame's covariance lines.
2. **Fit covariance**: the formal covariance of a fit (`fit` frame), times the realism factor the recipe holds for the source and fit class, measured on held-out data. Laser-range fits measured 16 to 21 times too small (E6).
3. **Modeled covariance**: the source's own model of its element sets' error by orbit regime and element-set age (E14 S3-KC), at the epoch plus each age of the recipe.
4. **Pooled model**: the model pooled over all sources, for a source with none of its own.

Rules 3 and 4 cover every object that has an SGP4 element set in a regime the
model covers (LEO-L, LEO-M, LEO-H, MEO, GEO). Each row carries its CVR
(`COV_REALISM`): the rule, the model, the regime and age cell, and the numbers and
verdict of that cell's held-out test. A row is `Calibrated` where its numbers pass
E14's realism rule on the test window for the lineage the source belongs to (E14:
LEO-H at 0 and 0.5 days); otherwise `Uncalibrated`, with the cell's measured
mean d²/3 and coverage.

## Ingress and egress

Every ingress frame is enqueued before the flow drains. A frame enqueued on a
trigger goes to every node port bound to it.

| Trigger | Content | For |
| --- | --- | --- |
| `element_sets` | A source's element-set history (`$OMM`, one frame) | element-set source |
| `models` | The orbit error models of rules 3 and 4 (`$ERM` MODEL records, size-prefixed, in one frame): `analysis/gp-error-model` `data/e14-s3-kc.erm` with `SOURCES` and `POOLED` set (`recipe.mjs` `modelsBytes`) | every source |
| `element_sets_mpe` | The same history as the GP history archive stores it (`$MPE`, one frame); `omm_from_mpe` converts it and the `$OMM` takes the lane of `element_sets` | element-set source that stores `$MPE` |
| `fit_omm` | The SGP4 sets fitted to the ephemeris or the estimated arc (`$OMM`; the newest fit is the product, the history is screened for maneuvers) | ephemeris and observation sources |
| `ephemeris` | The operator's ephemeris (`$OEM`, one object); its covariance lines are rule 1 | ephemeris source |
| `ephemeris_versions`, `planned_maneuvers` | The versions of the ephemeris (`$OEM`, one frame each) and the planned maneuvers (`$MNV`) | ephemeris source |
| `fit` | The estimate's state and formal covariance (`$OCM`) | observation source |

Egress, one sink `sdn.flow.egress` with ports `ocm`, `omm`, `mnv` (the
products) and the typed reports: `covariance_report` and `attribute_report` (`$ERM`
ATTACH_REPORT: the rule per object, why earlier rules did not apply, every row's
verdict, the SHA-256 of each record, the licence), `derive_report` and `mpe_report`
(FlowNotice), `propagation_report` (`$PRW` WINDOW_REPORT), `detect_report` and
`compare_report` (`$MDE`).

## The recipe is the node configuration

A run of the flow is one source. Its recipe is the flow's node configuration
(`plugin.getConfig`, one ModuleConfig that every node of the compiled flow reads),
each module under its own prefix (`recipe.mjs` `flowConfig`):

| Key | Read by |
| --- | --- |
| `derive.ages` | epoch-state `derive_omm` (`s_derive`, `f_derive`): the days after each set's epoch at which the OCM gets a state and its covariance (default `[0]`; `recipe.mjs` sets E14's horizons, 0 to 7 days) |
| `attach.*` (`version`, `source.*`, `producer`, `created`, `latestOnly`, `maxOperatorRows`, `realism`) | gp-error-model `attach_covariance` (`s_attach`, `f_attach`) |
| `attribute.*` (`version`, `source.*`, `producer`) | gp-error-model `attribute_maneuvers` (`s_attribute`, `f_attribute`) |
| root keys | maneuver-detection's options (none set: its defaults) |

Nodes of the same module share their prefix, so one configuration cannot hold two
sources' recipes: run the flow once per source. The models are not configuration
but records, on the `models` trigger. `data/e14-s3-kc.json` in
`analysis/gp-error-model` is the model and its verdicts (`data/e14-s3-kc.erm` the
same as an `$ERM`).

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
of E14's horizons; `flowConfig(recipe)` and `modelsBytes(recipe)` give it as the
flow's node configuration and its `models` frame.

| | Modules |
| --- | --- |
| Give products | `celestrak-reference` and `celestrak-parser` (CelesTrak GP); `spacetrack-source` (Space-Track's REST JSON: `gp`, `gp_history` as `$OMM`, `satcat` as `$CAT`), `gp-archive-records` (`$MPE`) and `retrieval` (a `$QRP` page whose records are `$OMM`; a host drops the page header) for the GP history archive; `spacex-starlink-source`; `iss-source` and `oem-source-iss`; `intelsat-source`; `spacemapper-aoe-source` (SpaceMapper's AOE element sets, channel KY); `celestrak-supgp` (CelesTrak's supplemental GP, non-independent CelesTrak fits); `vimpel-source` (JSC Vimpel's rectangular ephemerides, fitted by `analysis/od`; its osculating-element states and datefirst crosswalk are for the integrator); `sp3-precise-source` (IGS and BKG GPS, ESA GLONASS and ESA POD orbits as SP3, fitted by `analysis/od`); `glonass-source` (IAC); `cpf-source` (ILRS CPF from EDC; ESA's listing by configuration); `ilrs-crd-source` (ILRS normal points in CRD version 2 as `$TDM` laser ranges, the observation source: `analysis/estimation` takes them on `tracking_data`) |
| Cannot yet | `gps-source` (almanac elements, not SGP4; GPS precise orbits are `sp3-precise-source`'s), `oneweb-source` (the LTEF is not decoded): the reason and the task are in the file |
| Describe or identify | `celestrak-request`, `ephemeris-source`, `catalog-source`, `spk-source` |

The sources the ephemeris-source inventory lists that no module gives yet, and
the observation source the paper names that has no module yet (SatNOGS Doppler),
are `missing` in the file, each with the graph task that builds it; a module that
lands moves its entry to `sources`. An observation source (kind `observation`) does
not enter the flow itself: its `$TDM` goes to the lane's estimator, `analysis/estimation`
`run_estimation`, and the estimate's `$OCM` enters on `fit`; its entry names the fit
class and the realism factor measured for it (rule 2). `tests/sources.test.mjs` holds the file to
the modules' manifests and to the flow:

- every module under `data-source` that gives or describes orbit data is
  classified once;
- each module has the method and the typed output port the file names, and the
  flow takes that type where it enters;
- every source of the inventory is wired, refused or missing, and a missing
  entry does not outlive its module;
- the flow, run with each source's recipe on each module's lane, names the source,
  its provider and its licence on the `$OCM`, the `$OMM` and the `$MNV`; for an
  observation source the `$OCM` is the fit's covariance times the measured factor
  (rule 2, `UNCALIBRATED`);
- `tests/source-chain.test.mjs` runs what a module gives, parsed from the provider's
  format, through the flow or, for the observation source, through `analysis/estimation`.

## Build and test

```sh
npm run check   # flow check
npm run build   # flow compile -> dist/ (single-thread Emception link of the modules' guest-link objects)
npm test        # the flow in the SDK's JS flow host, compared byte for byte with the module chain
```

Each module keeps its own copy of the SDS code it was generated against, with
internal linkage: the linker keeps one copy of each equal external C++ symbol, and the
`$OMM` of gp-error-model (release 1.246.0) differs from epoch-state's (1.226.0) in a field
it writes. Without this the flow wrote the older `$OMM` and dropped the CVR and the
source.

The modules' guest-link objects (`dist/guest-link` of `analysis/epoch-state`,
`analysis/gp-error-model`, `analysis/maneuver-detection`) are built by their own
`npm run build`; rebuild them, then this flow. The vendored SGP4 has internal
linkage in `epoch-state` and `gp-error-model` so that their objects, and
`analysis/od`'s, link into one artifact. Each module's methods are byte-identical
in the browser, WasmEdge and Docker WasmEdge (`tests/parity.mjs` in each module).
The compiled flow itself runs in the SDK's JS flow host here; its runtime under
the node's WasmEdge host is exercised by the node's flow integration tests.
