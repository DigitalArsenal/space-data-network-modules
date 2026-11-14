# Catalog reconciliation flow

Population annotation increases record size: two synthetic stored AP products
average 9,592 bytes against 4,536 bytes of raw fit output. Fitting costs CPU,
and durable publication adds retained SDS bytes and synchronous writes.
[Throughput measurements](PERFORMANCE.md) describe a benchmark configuration;
they do not establish sustained capacity with publication retention.

The ten-minute timer reads configured OMM, CAT identity and SPW sources through
`index_page`, chooses one product per object, stores that product, and replaces
its CAT selection. The node provides publication under the behavior in
[publication requirements](PUBLICATION.md). The flow fetches no provider data.

## Selection and recovery

Earlier configured seed sources have priority. Within each source, the newest
epoch wins and an equal-epoch correction takes the later arrival. Work is ordered
by durable selection time, with unserved objects first. Repeated changes to a
recently served object do not precede an older unserved selection.

The numerical seed fields read by ingestion, weather drivers read by fitting,
recipe/acceptance settings and latest identity form the change signature.
Element metadata alone does not cause a refit. Identity changes cause a fresh
composition and recomputation. Weather revisions affect objects whose carried
weather interval includes the revised date; changes outside that interval and
to unused weather fields cause no refit. A revision inside many overlapping
intervals can require a catalog-wide refit. No forecast-distance reuse rule is
applied.

Recipe W calls the unchanged `sdn-ap` ingestion, propagation and fit methods.
The SGP4 flight samples GCRF states from seed epoch minus 2.5 days to plus
5 days at 300-second spacing. The fit uses NRLMSISE00, supplied weather, gravity
degree 20, a 30-day weather horizon from its epoch, and tesseral degree 31 at
eccentricity at most 0.048. Acceptance requires 2,161 states, the exact interval,
and configured RMS/maximum error limits. These are selection limits, not an
accuracy certification. Weather rows span the day before the flight starts
through the fit epoch plus 30 days, inclusive.

Expired, future or excluded seeds use ingestion-only SGP4. Future seeds are
reconsidered when their epoch arrives. Missing/invalid weather and physically
refused fits wait for input changes; other fit refusals carry a ten-minute
retry time. A failed object advances to the following object. Per-instance
failure backoff grows from one to 128 minutes and resets with the instance;
committed fallback retry times survive in the selection reason.

Malformed records are counted and skipped. Notices contain bounded source/hash
examples and object-failure reasons/retry times. `FlowNotice.KIND` is `Info`
for a successful changed tick, `Unchanged` for a successful unchanged tick,
`Skipped` for partial/deferred work, and `Missing` for failed work without a
successful update. Transport corruption or a failed page query stops the scan.
Incomplete sources suppress removals. Composer and annotation refusals return
typed outcomes to the controller.

A matching committed selection avoids any OCM read. After recomputation,
recovery checks only the deterministic product batch, reusing identical stored
bytes after interruption. Products precede index writes; terminal index batch
identifiers end in `:complete`. Each replacement is a complete generation.
The host must preserve referenced products and expose its live index through
complete pages. The controller does not scan retained OCM history or depend
on publication-journal internals. Seed/identity/index paging remains proportional
to those live sources; selection compaction occurs in memory.

## Consumer rules and covariance

Read `CATProduct.KIND` before flying a selected record. `ApElements` and
`Sgp4Elements` distinguish fitted AP and SGP4 fallback products. The stable
`old-span fallback` selection-reason prefix identifies an expired seed.
`CATProduct.STALE` means retirement by a maneuver in the standard; time expiry
does not set it. CAT has no typed enum for a fallback's time-expiry reason.

A nonempty `PRODUCTS_AS_OF` with zero products is a removal, whether the empty
vector is present or omitted by a reader's repack. No index row means unprocessed,
not removed. Removal reasons are retained in the tick notice; CAT has no field
for a reason on an empty selection. More than the configured share of active
selections cannot be removed in a tick without an explicit setting increase.

The fit's entire original byte buffer is preserved without unpack/repack.
Annotation preserves its primary covariance, calibration and propagation inputs.
Seven independent blocks contain the SGP4 seed population model, rotated from
RTN using the seed's SGP4 state at each age midpoint, even when attached to AP.
They do not model the AP fit's error. Block IDs starting `population/` and
CVR rules `SourceModel`/`PooledModel` identify these priors; `EMPIRICAL` is the
standard's most specific applicable block basis. Each block is uncalibrated.
A consumer chooses the closest age block; `sdn-ap` does not propagate these
blocks. Unsupported/nonfinite cases carry labeled absence. The seed epoch
must match ingestion or the exact-W fit interval within one millisecond, which
covers element-epoch rounding. `COV_UNITS` lists diagonal standard-deviation
units, `km km km km/s km/s km/s`; matrix entries therefore have units km²,
km²/s and km²/s². [Encoding details](COMPACTNESS.md).

## Configuration and bounds

Supply `catalog.provider`, `catalog.identity_provider`,
`catalog.identity_source`, `catalog.weather_provider`, `catalog.weather_source`,
and parallel arrays `catalog.seed_providers` and `catalog.seed_sources` (1–16).

| Setting | Default | Bound or meaning |
| --- | --- | --- |
| `catalog.page_size` | 512 | 1–1,000 records; at most 10,000 pages per source |
| `catalog.partition_count` | 1 | 1–8 disjoint object-number modulo partitions |
| `catalog.partition_index` | 0 | Less than partition count |
| `catalog.batch_size` | 128 | 1–1,024 successful changes per invocation |
| `catalog.max_records` | 400,000 | 1–500,000 resident records in this partition |
| `catalog.max_bytes` | 67,108,864 | 1 KiB–96 MiB accounted resident data |
| `catalog.invocation_budget_ms` | 540,000 | 1,000–540,000; below host timeout |
| `catalog.object_allowance_ms` | 2,000 | 2,000–60,000; minimum reserve per object |
| `catalog.max_removal_fraction` | 0.25 | 0–1; explicit permission for larger removals |
| `catalog.recipe_revision` | `W/1` | Signature input |
| `catalog.validity_margin_seconds` | 0 | Nonnegative expiry margin |
| `catalog.nonresonant_max_e` | 0.05 | Configurable downward |
| `catalog.resonant_max_e` | 0.3 | Configurable downward |
| `catalog.max_fit_rms_km` | 2 | Positive finite acceptance bound |
| `catalog.max_fit_error_km` | 10 | Positive finite acceptance bound |

The resonance rule uses mean motion greater than 0.0035003818 and at most
0.015751718 radians/minute. Resident accounting includes bytes plus 256 bytes
per retained entry and replaces superseded entries. Other partitions' records
are validated but not retained. A bounded partial scan reports read count and
settings, processes retained work, and suppresses removals. Increase a binding
setting within its bounds or add partitions. Accounting is not total heap use;
configure at least 4,096 memory pages (256 MiB). Full-catalog heap use is unmeasured.

Monotonic budget checks run between pages and before each object. The reserve
is the larger of the configured allowance and twice the longest observed object
duration. It is not a guarantee against a single slow or blocked operation.
Configure `execution_timeout: 10m` with the 540-second controller budget and
`release_after_run: true` so an interrupted instance is discarded. A host must
replace a poisoned invocation before reuse; keeping an interrupted instance
is unsupported. Instance replacement also adds instantiation/priming costs.

## Build and validation

Build the unsigned `sdn-ap` generated translation unit, then from this directory:

```sh
SDM_MODULE_UNSIGNED_BUILD=1 node build.mjs
SDM_MODULE_UNSIGNED_BUILD=1 node build-flow.mjs
node --test tests/controller.test.mjs tests/sdk_compat.test.mjs
```

`CATALOG_BUILD_DIR` selects chain output; `CATALOG_FLOW_BUILD_DIR` selects
flow output (`dist/flow` by default). `CATALOG_CONTROLLER_DIR`,
`CATALOG_CHAIN_WASM` and `SDNAP_WASM` select test artifacts. The runtime bundle
is `dist/flow/runtime`. Build distinct registered partition program IDs with
`CATALOG_FLOW_PARTITIONS=8`. Configure matching partition counts and unique
indexes, a shared provider, empty `exclusive_group`, `intervals.refresh: 10m`
and `retrieval_interval: 1m`. Reference installed program IDs in service
configuration; the default three-hour debounce does not provide ten-minute
capacity. Failure backoff remains active.

Synthetic compiled tests cover poisoned records, isolated failures, composer
refusal, clock rollback, source precedence, changed-only updates, identity
refresh, fairness, future/expired fallbacks, removals, deadline reserve,
recovery, determinism and stored-product equality to raw fit fields/states/formal
covariance. Covariance rotation also has an independent exact signed-axis case.
The paged connector validates frame lengths/counts and byte/row limits; the
host contract has `TestStorageIndexPageCompleteSnapshots` coverage. Signing,
trust and signed-out reads are excluded.
