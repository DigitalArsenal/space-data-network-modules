# Catalog Editor module

`compose` combines ordered, immutable SDS CAT snapshots. A higher layer wins
unless the recipe selects another layer for that object. Selected records keep
their original size-prefixed FlatBuffer bytes, including fields newer than this
module. Provider catalogs are never edited.

Object identity uses NORAD IDs and unambiguous international designators.
Unnumbered objects retain their original key, namespaced by provider and dataset.
Names and orbital proximity are never join keys. Conflicting identifiers remain
visible in the report and are excluded from the output until the user chooses a
source. Duplicate identities within one source edition are rejected.

The recipe independently orders orbital-state sources globally and per object.
Given candidate record IDs and epochs, the module picks the newest record at or
before `asOf` from the first source within the allowed age. Its result distinguishes
selected, missing, stale, future and unconfigured. This selects a reference; it
does not fetch, propagate or certify an orbit.

## Inputs

Every recipe, request and report of this module is one size-prefixed SDS `$XMT`
(Catalog Cross-Match) with one arm set: `COMPOSE_RECIPE` / `COMPOSE_REPORT`,
`MATCH_REQUEST` / `MATCH_REPORT`, `INTEGRATE_RECIPE` / `INTEGRATE_REPORT`,
`EPOCH_FIT_POLICY` / `EPOCH_FIT_REPORT`. Times are Unix milliseconds.

- `recipe`: `$XMT` `COMPOSE_RECIPE`. `IDENTITY_RULE` `NoradFirst` (NORAD number, then
  international designator, then the source's native key) or `InternationalDesignator`;
  `LAYERS` (`ID`, `NODE`, `PROVIDER`, `SOURCE`, snapshot `HEAD`, optional `NATIVE_KEYS`
  in record order), layer order is precedence.
- `catalogs`: one canonical size-prefixed CAT stream per layer, in the same order.
- Recipe settings: `AS_OF_MS`, `MAX_AGE_S` (required finite under `NoradFirst`), ordered
  `STATE_SOURCES`, optional `STATE_CANDIDATES` (`OBJECT_KEY`, `SOURCE_ID`, `RECORD_ID`,
  `EPOCH_MS`), `COVERAGE` (the designators each state source declares) and `OVERRIDES`
  (`OBJECT_KEY` with `CATALOG_LAYER`, `STATE_SOURCES` or `MAX_AGE_S`; empty or NaN keeps
  the recipe's).

Outputs are a canonical `catalog` stream and an `$XMT` `COMPOSE_REPORT` with, per
object, every layer's record, the chosen layer, the identity status and the state
selection. Source citations and licenses belong to the referenced publication snapshots and
must accompany any derived publication.

Limits: 16 layers, 250,000 input records, 128 MiB of CAT input, 32 MiB of recipe
input. Invalid input returns an invocation error without partial output.

## Build and verification

Run `npm ci --ignore-scripts`, then `SPACE_DATA_STANDARDS_ROOT=<SDS checkout>
npm run build` and `npm test`. The SDK compiler uses its `wasi-sequential`
declaration and canonical `wasm32-wasip1-threads` toolchain. The runtime artifact
is `dist/isomorphic/module.wasm`.

Tests invoke the actual WASM through the SDK browser harness and validate the
manifest/artifact contract (`node --test tests/sdk_compat.test.mjs`). The bundle
contains one SDS APP with a gzip/base64 HTML page, its decoded content hash, and
the exact canonical WASM hash. There are no separate UI artifacts to deploy. Run `npm run test:parity` with
Chromium, native WasmEdge and the SDK container image installed to verify
byte-identical output across all three runtimes.

The editor resolves the selected DSS publication to one complete provider batch,
reads immutable published shards in bounded ranges, verifies every shard hash
and record count, and records the assembled stream's SHA-256. Historical batches
are never combined into one input layer. Each explicit
load refreshes the sources. It saves source order and object overrides in the
host's node/app namespace and supports recipe and CAT downloads. Catalogs remain
read-only; download is disabled until identifier conflicts are resolved.

The editor configures orbital-state priorities; it does not yet fetch candidate
orbit records. The source adapter must provide native identifiers before an
unnumbered, undesignated CAT can be composed. Full datastore FTS, provider
ingestion and operational placement remain in [PLAN.md](PLAN.md).

### Primary-source coverage and identity

Editor recipes use version 2 and international designators from CAT `OBJECT_ID`
for matching. A numeric catalog identifier cannot merge objects. Entries without
an international designator remain separate and are excluded from authoritative
CAT export. Legacy recipes require review of their former object overrides.

Orbital providers are discovered from their published orbital datasets. To be
selectable, a provider publishes a CAT membership catalog under the same node,
provider and source identity. The editor loads that complete immutable catalog,
records its publication head, and compares membership by international
designator. Selecting overlapping sources highlights their shared objects;
**Review overlaps** filters the object list, and each object's editor selects
its orbital source independently. Global maximum state age has been removed.
Providers without published membership remain visible as unavailable coverage;
no other provider's catalog is silently used to infer their coverage.

## Catalog matching review (0.1.7)

`match_catalog` evaluates proposed provider-native associations independently of
CAT layer selection. It **does not merge identities or publish an authoritative
orbit**. The editor's **Match objects** dialog accepts two normalized binary OEM
trajectories or epoch products (OPM or the public Vimpel orbit table), provider/native
IDs, an optional datefirst edition, and four configurable thresholds. Epoch products
run through the selected PRW propagator and native frame/time modules automatically. The downloaded review includes the policy, source-file SHA-256
references, diagnostics and verdict. Thresholds persist with the catalog recipe;
uploaded orbit bytes do not persist in configuration.

The method accepts up to 64 OEM candidates and 4,096 proposed pairs, capped at
128 MiB and four million sample evaluations. Each input is one size-prefixed
canonical `$OEM`, one Earth-centered UTC uniform block, six components per state
(km and km/s), at least five samples. The bound-Earth-satellite profile rejects
positions within the polar Earth radius and nonnegative two-body orbital energy
(using Earth mu 398600.4418 km³/s²); this is only a coarse physical sanity gate. Supported inertial frames are J2000,
EME2000 and GCRF; two compared arcs must have exactly the same frame, START_TIME,
STEP_SIZE and sample count. Unsupported layouts fail explicitly. The editor host adapter
uses its selected propagator and frame module to create this common grid;
the matcher neither hardwires SGP4 nor interprets raw Vimpel elements.

The request (`recipe` port) is an `$XMT` `MATCH_REQUEST`: `POLICY` (`POSITION_TOLERANCE_KM`,
`VELOCITY_TOLERANCE_KM_S`, `FINITE_DIFFERENCE_TOLERANCE_KM_S`, `MINIMUM_SPAN_S`), `TRAJECTORIES`
(`ID`, `PROVIDER`, `NATIVE_ID`, `RECORD_ID`, one per `ephemerides` frame in order) and `PAIRS`, `$OIL`
links whose `LEFT.TRAJECTORY_ID` and `RIGHT.TRAJECTORY_ID` name the trajectories and whose `EVIDENCE`
is the declaration's (e.g. `SOURCE` "datefirst", `RECORD_ID` the crosswalk edition). The `MATCH_REPORT`
gives, per pair, the link as requested, the verdict and its reason, the residuals (NaN when not compared),
the samples and the span.

These example thresholds require calibration for the sources and orbital regime;
they are not validated identity probabilities. For each pair the matcher measures
maximum position and velocity separation over the supplied arc. At every sample it checks a fourth-order derivative, using shifted five-point
stencils at the first/last two epochs and the central derivative
`(r[i-2] - 8*r[i-1] + 8*r[i+1] - r[i+2]) / (12*h)` against supplied velocity. Identical endpoint errors in two products cannot
bypass this check.
Sampling too coarsely can fail this numerical check even with correct velocities;
refine the upstream grid and compare convergence. It cannot establish absolute
orbit accuracy, full dynamical validity, or covariance realism.

Verdicts: `compatible` supports human review; `rejected` exceeds configured
separation thresholds; `insufficient` lacks a common grid, enough arc, or a
consistent finite-difference velocity; `ambiguous` has multiple passing native
objects from the same other provider. Agreement with three distinct providers
is not itself ambiguity. Crosswalk declarations remain evidence, not truth.

Reference: Nicholas J. Baietto (2022), *Space Object Correlation Between the
Space-Track and Vimpel Catalogs*, https://doi.org/10.25394/PGS.19658076.
The thesis documents direct and observation-arc correlation and identifies a
historical datefirst pairing discrepancy. It does not replace verification of
the current provider format. The native method evaluates only the supplied trajectories. Version 0.1.9 adds
automatic preparation and reviewed identity persistence in the embedded APP host
adapter; see [the workflow and live evidence](docs/matching-workflow.md).

See [Vimpel normalization and epoch audit](docs/vimpel-normalization.md) for the
confirmed provider format, differentiation limits and crosswalk policy.

## The `$CAT` integrator (0.2.0)

`integrate_catalog` takes the composed catalog and every source's products and gives
the catalog, the product chosen for each object, and the report that says how (catalog
pipeline, `graph/programs/catalog-pipeline.md` section 3). Feed it `compose`'s output;
composition of snapshots stays `compose`'s. Nothing is estimated and no record is edited
except the catalog's `MANEUVERABLE` and a merged maneuver's status and tags.

| Port | | Content |
| --- | --- | --- |
| `recipe` | in | `$XMT` `INTEGRATE_RECIPE`: `AS_OF_MS`, `IDENTITY`, `SELECTION`, `MANEUVERS` (below) |
| `catalog` | in | The composed `$CAT`: canonical size-prefixed records, each object once |
| `ephemerides` | in | Up to 64 normalized `$OEM` trajectories, one per identity candidate in the recipe's order |
| `omm_products`, `ocm_products`, `mnv_products` | in | Every source's `$OMM`, `$OCM` and `$MNV`, as `flows/source-products` writes them: each names its source in `PROVENANCE` (`$PVN` `SOURCE_ID`), and an `$OMM`'s or `$OCM`'s covariance states its realism in `COV_REALISM` (`$CVR`). A record that names no source or no object is refused and counted |
| `catalog` | out | The input objects in order, original bytes; `MANEUVERABLE` true where the history shows a maneuver |
| `omm` | out | Per object and product kind (`sgp4`, `sgp4xp`) the element set of the selected source, byte for byte |
| `ocm` | out | The selected set's state and covariance with its realism, byte for byte |
| `mnv` | out | The maneuvers of every source, merged |
| `report` | out | `$XMT` `INTEGRATE_REPORT`: the policy, the counts, every identity link with its verdict, per object every candidate and why one was chosen or none, the chosen covariance's `$CVR`, the SHA-256 and CID (CIDv1, raw, sha2-256) of every record written, the records refused or unlinked |

The steps, in order:

1. **Identity.** A product names its object by NORAD number or international designator,
   and both must agree with the catalog's; a conflict is reported, not resolved. A source
   with neither names it natively (an `$OMM`'s `USER_DEFINED_OBJECT_DESIGNATOR`, an `$OCM`'s
   `OBJECT_DESIGNATOR` under its own `CATALOG_NAME`, a `$MNV`'s `ON_ORBIT`), and that name joins
   an object only through a link in the recipe's `identity` section: a `match_catalog` recipe
   (candidates, the four thresholds) whose pairs `{native, reference, object, evidence}` also
   name the catalog object (`{"norad": n}` or `{"cospar": "YYYY-NNNAAA"}`) the native candidate is
   proposed to be. Each pair is tested on the two normalized trajectories (the match core
   `match_catalog` runs) and recorded **compatible, rejected, ambiguous or insufficient**. Only a
   compatible link binds, and not when its native name is proposed for two objects or two references of
   one provider both pass. Names and orbits that merely resemble another never join; an `$OMM` whose
   name is not bound is reported unlinked.
2. **Maneuvers.** Each object's `$MNV` records are sorted by time. Reports within
   `timeToleranceSeconds` of the first report of an event, whose delta-V (when both state one)
   agrees within `deltaVToleranceKmS` or `deltaVRelativeTolerance`, are one event; a source never
   merges with itself. The event is written from its member with the best status
   (EXECUTED, CONFIRMED, DETECTED, PREDICTED, PLANNED, UNKNOWN, CANCELLED), keeps each source's
   status in the tags `member:<source>=<STATUS>` and `merged:<n>`, and an event of one report is that
   record unchanged. The catalog's `MANEUVERABLE` is true where an event began at or before `asOf`
   with a status in `maneuverableStatuses` (default DETECTED, CONFIRMED, EXECUTED). The history sets
   it true and never clears it.
3. **Selection.** For each object and product kind, each source's newest set at or before `asOf` is its
   candidate. A candidate whose epoch precedes the latest event with a status in `retiringStatuses`
   (default DETECTED, CONFIRMED, EXECUTED) is **retired**, one older than `maxAgeDays` is too old.
   The remaining candidates the **measured table** has a row for (source, product, regime, horizon) with
   at least `minSamples` samples (default 30) are ordered by their median 3-D position error; the lowest
   wins, a tie going to the source earlier in `sourceOrder` and then to the newer epoch. An unmeasured
   candidate never beats a measured one. With none measured, `sourceOrder` decides and the report says
   `unmeasured-fallback-order`. When every candidate is retired or too old the object is **stale** and has
   no product. The regime is the one the product's covariance realism names (`COV_REALISM` `REGIME` of the `$OMM`), so the
   covariance model and the selection speak of the same strata; the horizon is the recipe's.
4. **Covariance.** The selected set's own `$OCM` (the same source, first state at the set's epoch) goes out
   with it, and the report carries its realism: rule, model, regime, the held-out test's numbers and verdict. A set
   with no `$OCM` goes out alone and the report reads its realism from the set.

The recipe's fields: `IDENTITY` is a `MATCH_REQUEST` whose `$OIL` links name the native trajectory
(`LEFT.TRAJECTORY_ID`), the reference trajectory (`RIGHT.TRAJECTORY_ID`) and the catalog object
(`RIGHT.NORAD_CAT_ID` or `RIGHT.INTERNATIONAL_DESIGNATOR`). `SELECTION`: `HORIZON_DAYS`, `MIN_SAMPLES`
(default 30), `MAX_AGE_DAYS` (default no limit), `SOURCE_ORDER`, and the measured table `MEASURED`
(`SOURCE_ID`, `PRODUCT`, `REGIME`, `HORIZON_DAYS`, `MEDIAN_3D_KM`, `SAMPLES`). `MANEUVERS`:
`TIME_TOLERANCE_S` (default 3600), `DELTA_V_TOLERANCE_KM_S`, `DELTA_V_RELATIVE_TOLERANCE` (NaN: not
compared), `MANEUVERABLE_STATUSES` and `RETIRING_STATUSES` (empty: DETECTED, CONFIRMED, EXECUTED).

The measured table is an input the experiments refresh. Its regimes are the ones `analysis/gp-error-model`
labels (E14's: LEO-L, LEO-M, LEO-H, MEO, GEO); E3's results are keyed by its own test strata, so a table for this recipe
is keyed by the regimes above. An object whose products carry no regime (a regime without a model, such as HEO) is
selected by `sourceOrder`. It selects and does not fuse: E3 found combining sources no more accurate than selecting one (H2 not
supported in any regime). Limits: 250,000 records per port, 128 MiB of input, 64 trajectories, 4,096 identity links; the report is
about 1.5 KB per object, so a flow shards a large catalog.

`tests/integrator.test.mjs` fixes each outcome by construction: the lowest measured median, a row under
`minSamples` measuring nothing, the newest set per source, `maxAgeDays`, SGP4 and SGP4-XP chosen separately, a burn retiring
the better-measured source, stale, merged and unmerged reports, the covariance and label coming out byte for byte,
links that bind and links that do not, refused records and recipes. `tests/integrator-chain.test.mjs` integrates what the
compiled `flows/source-products` writes for two sources. `npm run test:parity` runs the method in Chromium, native WasmEdge and
container WasmEdge: byte-identical.

## Epoch validation and refinement (0.1.8)

`validate_epoch` checks propagated positions against a hash-verified native
Vimpel position ephemeris. `fit_epoch_step` uses the existing estimation core
and caller-supplied propagation sensitivities to return an unvalidated OPM
candidate; held-out positions do not train the fit. A candidate must be
repropagated and validated before use. These methods accept any propagator that
supplies the declared J2000/UTC grid and retain explicit model provenance.
See [the binary interfaces, policy and verification](docs/epoch-fitting.md).

## Reviewed workflow (0.1.9)

Upload two prepared OEMs or two epoch products, choose provider namespaces and IDs,
and optionally load the attributed `datefirst` crosswalk. For epoch products, set
a bounded UTC grid and review the propagation model. HPOP is the packaged default;
an alternative WASM artifact implementing canonical PRW execution can be selected.
The module and all input/output hashes accompany the review. No JavaScript physics
or mean-element reinterpretation is used.

Download the crosswalk audit to inspect invalid dates, duplicates and conflicting
associations. Only one valid declaration for the chosen products proceeds to the
trajectory check. A compatible result enables **Accept association**; a reason is
required. Decisions persist in the existing node/app configuration namespace and
travel with recipe export/import. Rejection and revocation remain in the bounded
history. Direct and transitive conflicts require revocation before a replacement
is accepted. Identity bindings remain separate from CAT source selection.
