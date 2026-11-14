# Catalog reconciliation flow

The timer flow reads configured OMM sources, CAT identities, SPW weather, and
its durable CAT/OCM outputs through `index_page`. It selects one product per
object, stores the product before replacing the index entry, and clears the
product list with an as-of time when an object leaves the current sources.
The default timer interval is ten minutes. The node supplies automatic
publication; reliable changed-batch delivery and compact daily snapshots
require the host behavior described in [publication requirements](PUBLICATION.md).

The chain adapter calls the unchanged `sdn-ap` ingestion, propagation, and
fit methods. Recipe W samples GCRF states from seed epoch minus 2.5 days to
plus 5 days at 300-second spacing. The fit uses the full usable interval,
NRLMSISE00 with supplied weather, maximum gravity degree 20, a 30-day weather
horizon, and maximum tesseral degree 31 only at eccentricity at most 0.048.
Acceptance requires 2,161 fit states, the exact requested interval, and the
configured limits on the fit's own RMS and maximum errors. These limits are
selection policy, not an accuracy certification.

Earlier configured seed sources have priority. Within a source, the newest
epoch wins; equal-epoch corrections use durable arrival order. The selected
seed bytes, relevant weather bytes, and recipe/acceptance settings form the
input fingerprint. Unchanged selections are skipped. An expired fit becomes
an ingestion-only SGP4 product; the controller does not move the fit window.
A refused fit is retried only after its input fingerprint changes. Objects
outside the configured AP class receive SGP4 products with an explanation in
the header comment and index selection reason.

`gp-error-model:annotate_population` adds seven independently timestamped
population covariance blocks, at the seed epoch plus each model-bin midpoint.
They are symmetric 6-by-6 GCRF matrices encoded in lower-triangular text rows,
labeled uncalibrated and identified by the
model. The AP formal posterior and its propagation flag remain unchanged.
The consumer selects the closest age block; `sdn-ap` does not propagate these
added blocks. Unsupported population-model cases have an explicit explanation
and no population blocks.

The committed CAT selection is the recovery checkpoint. An interrupted object
is recomputed from its unchanged inputs; an exact product found in storage is
reused. Product and index batch identifiers are content hashes. Whole-list
replacement prevents a previous theory from surviving as a second selection.
Tombstones remain available to consumers. The page cursor bounds a sequence
head under append ingestion; it does not protect against concurrent deletion.
A failed or nonadvancing complete read stops reconciliation without committing
that partial sweep. The subsequent tick starts its reads again.

## Configuration and bounds

The service configuration supplies `catalog.provider` as the publishing node's
own provider identifier. It also supplies `catalog.identity_provider`,
`catalog.identity_source`, `catalog.weather_provider`, `catalog.weather_source`,
and parallel string arrays `catalog.seed_providers` and `catalog.seed_sources`.
At most 16 ordered seed sources are accepted.

| Setting | Default | Bound or meaning |
| --- | --- | --- |
| `catalog.page_size` | 512 | 1–1,000 records per storage page |
| `catalog.partition_count` | 1 | 1–8 services; disjoint object-number modulo partitions |
| `catalog.partition_index` | 0 | Zero-based partition, less than the count |
| `catalog.batch_size` | 128 | 1–4096 changed objects per tick; the execution budget remains binding |
| `catalog.max_records` | 200,000 | 1–2,000,000 scanned records |
| `catalog.max_bytes` | 134,217,728 | 1 KiB–512 MiB of accounted scan data |
| `catalog.recipe_revision` | `W/1` | Included in the input fingerprint |
| `catalog.validity_margin_seconds` | 0 | Nonnegative expiry margin |
| `catalog.nonresonant_max_e` | 0.05 | Configurable downward |
| `catalog.resonant_max_e` | 0.3 | Configurable downward |
| `catalog.max_fit_rms_km` | 2 | Positive finite acceptance limit |
| `catalog.max_fit_error_km` | 10 | Positive finite acceptance limit |

The conservative resonance classifier uses mean motion in radians per minute:
greater than 0.0035003818 and at most 0.015751718. It is a stand-in for the
module's documented per-frame class. Every sweep also has a 10,000-page bound.
Scan accounting includes historical input/index bytes and 128 bytes per product
identifier; it is not a measurement of total resident memory. The service's
memory and execution budgets apply independently.

Complete scans become more expensive as retained history grows, even when no
fit changes. Each tick processes objects in catalog-number order and skips
committed matches. The 128-object default therefore limits a ten-minute timer
to 128 changed objects per invocation, even if numerical execution has spare
capacity. Repeated failures on an early object stop progress on later objects.
The two storage sources are `catalog-products` (OCM) and `catalog-index` (CAT).

## Build and verification

Build the unsigned `propagator/sdn-ap` package to prepare its generated C++
translation unit, then run these commands from this directory:

```sh
SDM_MODULE_UNSIGNED_BUILD=1 node build.mjs
SDM_MODULE_UNSIGNED_BUILD=1 node build-flow.mjs
node --test tests/controller.test.mjs tests/sdk_compat.test.mjs
```

`CATALOG_BUILD_DIR` selects an alternate chain output directory;
`CATALOG_FLOW_BUILD_DIR` selects the complete flow output directory, whose
default is `dist/flow`. `CATALOG_CONTROLLER_DIR`, `CATALOG_CHAIN_WASM`, and
`SDNAP_WASM` select alternate test artifacts. The deployed runtime bundle is
`dist/flow/runtime`. Native execution requires a runtime with interruptible
threaded AOT and the node's `index_page` storage capability. The service exposes
`execution_timeout`; its invocation budget must cover the configured batch.

Synthetic tests cover direct-call equality, refusal, source precedence,
equal-epoch correction, recovery after product storage, weather changes,
expiry fallback, tombstones, and selection-map convergence. They do not
establish production orbit accuracy or remote publication/trust behavior.

## Development measurements

Sixteen ABBA rounds compared a primed native reconciliation tick with storage
against the unchanged exact-W chain in Node, using the same two synthetic
objects. The median native time was 0.459 seconds per object. The median
per-round native/control ratio was 1.108; its middle-half range was
1.094–1.147 (4.73% of the median). The comparison includes different execution
backends and the controller's extra work; it does not isolate one overhead.
The two timing slices had starting/ending system loads of 2.84/4.44 and
4.87/5.91, respectively, using the one-minute averages.

The measured small-catalog rate projects to 4.21 hours of processing for
33,000 objects, excluding growth in scan costs. It is not a full-catalog
measurement. The default 128-object batch requires 258 ten-minute invocations
for that first build, approximately 43 hours of scheduled slots. A
256-object setting requires 129 invocations, approximately 21.5 hours.
A native 256-object synthetic test completed within the ten-minute invocation
budget, producing 256 stored products and 256 selections. Guest linear memory
at its endpoint was 99 pages (6,488,064 bytes), excluding host and storage
memory. The rate projection does not raise the controller's batch limit.

Each partition scans the complete configured sources and changes only objects whose object number modulo `catalog.partition_count` equals `catalog.partition_index`. Services share one output provider and use distinct partition indexes. This also partitions expiry and removals. Increasing the batch ceiling does not guarantee completion within the host execution budget.

[Covariance size accounting and compression](COMPACTNESS.md) describe the compact annotation. A 1,024-object native batch completed within a ten-minute invocation budget with 113 guest pages (7,405,568 bytes) and 627,539,968 bytes of whole-process peak RSS. A 1,280-object request reached the deadline after 1,195 complete selections. The largest fully completed tested batch is 1,024; the configured ceiling of 4,096 does not establish a safe batch at every load.

Complete scans count every source record, including those owned by other partitions. A 100,000-object catalog with one seed, identity, selection and product per object exceeds the default 200,000-record scan bound even before weather or retained history. Operators must size the scan and memory limits for the entire retained source population. The 2,000-object throughput sample does not establish memory use at 100,000 objects.

The node registers services by flow program ID and rejects duplicate IDs. Build distinct partition programs with `CATALOG_FLOW_PARTITIONS=8` and `CATALOG_FLOW_BUILD_DIR=build/catalog` when invoking `build-flow.mjs`; the resulting `build/catalog/partitions/0` through `7` bundles have distinct program IDs. Configure one service per bundle, with the same `catalog.partition_count`, distinct `catalog.partition_index` values, the shared catalog provider and source settings, and a suitable `execution_timeout`. Leave `exclusive_group` empty to allow parallel execution and `release_after_run` false to retain primed instances. Partition count and indexes must cover the catalog exactly once.
