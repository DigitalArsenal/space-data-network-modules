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

- `recipe`: one explicit JSON control frame, version 1. `layers` contains `id`,
  `node`, `provider`, `source`, snapshot `head`, and optional
  `nativeKeys` in record order. Layer order is precedence.
- `catalogs`: one canonical size-prefixed CAT stream per layer, in the same order.
- Recipe settings: `asOf` (Unix seconds), `maxAgeSeconds`, ordered `stateSources`,
  optional `stateCandidates` (`objectKey`, `sourceId`, `recordId`, `epoch`), and
  `overrides` keyed by object identity with `catalogLayer`, `stateSources` or
  `maxAgeSeconds`.

Outputs are a canonical `catalog` stream and a JSON `report` control frame with
the chosen source, original frame/record provenance and state selection. The
recipe/report are configuration and UI diagnostics; they are not SDS observations.
Source citations and licenses belong to the referenced publication snapshots and
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

Control recipe (`recipe` port, JSON configuration, never observational data):

```json
{
  "version": 1,
  "candidates": [
    {"id":"a","provider":"vimpel","nativeId":"example-a","recordId":"immutable-reference-a"},
    {"id":"b","provider":"other","nativeId":"example-b","recordId":"immutable-reference-b"}
  ],
  "pairs": [{"left":"a","right":"b","evidence":{"source":"datefirst","recordId":"crosswalk-edition"}}],
  "positionToleranceKm": 10,
  "velocityToleranceKmS": 0.01,
  "finiteDifferenceToleranceKmS": 0.001,
  "minimumSpanSeconds": 3600
}
```

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
