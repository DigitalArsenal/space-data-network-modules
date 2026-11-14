# Catalog reconciliation flow

Population annotation increases record size. Fitting consumes CPU; durable
attempt snapshots add writes before processing; publication adds retained SDS
copies. Instance replacement adds startup cost. Sustained throughput and
compression of this configuration are unmeasured. [Resident capacity](PERFORMANCE.md)
describes a synthetic memory fixture, not processing or publication capacity.

The ten-minute timer reads configured OMM, CAT identity and SPW sources through
`index_page`, chooses one product per object, and commits one generation per tick: bounded
product batches followed by one complete CAT batch. The node provides publication under the behavior in
[publication requirements](PUBLICATION.md). The flow fetches no provider data.

## Selection and recovery

Earlier configured seed sources have priority. Within each source, the newest
epoch wins and an equal-epoch correction takes the later arrival. Work is ordered
by durable selection time, with unserved objects first. Repeated changes to a
recently served object do not precede an older unserved selection.

The numerical seed fields read by ingestion, weather drivers read by fitting,
recipe/acceptance settings form the numerical change signature. Identity has a separate signature.
Element metadata alone does not cause a refit. Seed object identifiers, name,
originator and provenance copied into the product remain those of its last
numerical rebuild; a metadata-only seed reissue deliberately leaves them stale.
The CAT selection uses the latest identity. Consumers use CAT for display
identity and the product for the seed/provenance of its numerical state. Identity-only changes replace CAT while preserving its selected product without a refit. Weather revisions affect objects whose carried
weather interval includes the revised date; changes outside that interval and
to unused weather fields cause no refit. A revision inside many overlapping
intervals can require a catalog-wide refit. No forecast-distance reuse rule is
applied.

Recipe W calls the unchanged `sdn-ap` ingestion, propagation and fit methods.
The SGP4 flight samples GCRF states from seed epoch minus 2.5 days to plus
5 days at 300-second spacing. The fit uses NRLMSISE00, supplied weather, gravity
degree 20, a 30-day weather horizon from its epoch, and tesseral degree 31 at
eccentricity at most 0.048. Acceptance requires 2,161 states, the exact interval,
with an absolute interval difference strictly below one millisecond, and configured RMS/maximum error limits. These are selection limits, not an
accuracy certification. Weather rows span the day before the flight starts
through the fit epoch plus 30 days, inclusive.

Expired, future or excluded seeds use ingestion-only SGP4 and do not hash
weather. Future seeds are reconsidered at eligibility. Every fallback is
relabeled `old-span fallback` when its seed expires. Deterministic refusals
wait for input changes. A backward clock defers affected selections before
fitting or storage, with one clock diagnostic per tick.

Before numerical dispatch or removal composition, the controller stores and awaits acknowledgment of its `$NEV` operational state. `catalog-attempts` is used for one partition; partitioned services use `catalog-attempts-<index>-of-<count>`. One serial service owns each source. Changing the partition count requires an explicit state migration or acceptance of reset backoff.

State contains only in-progress or failed objects plus bounded quarantine observations. Each dispatch/failure replaces the source's current batch with one snapshot; a committed selection removes its marker, without a success event. An empty snapshot contains no events. `RECONCILE=Current` must durably ingest the whole replacement before deleting older source batches. A crash between ingestion and reconciliation can leave multiple snapshots; explicit per-event sequence numbers resolve equal-time attempts independently of page order. Matching committed selections discard stale markers. Source state must remain private to this service and outside catalog publication.

The combined bound is 4,096 object/poison entries and an 8 MiB serialized snapshot. The operational-source read checks an 8,192-record threshold at page boundaries and fetches at most 8,192 plus twice the configured page size (10,192 at the maximum); incomplete or oversized state stops dispatch without replacing it. Each state write serializes the live entries, so persistent failures increase write cost even when unrelated objects succeed. A healthy catalog leaves one empty snapshot, independent of the number of successful updates. Preserve failed markers across restarts: deleting them resets backoff. An unfinished attempt is deferred for 20 minutes, doubling to a 24-hour ceiling; final failures await changed inputs. Failed state storage stops dispatch. A transient fit refusal stores the first SGP4 fallback, retains retry state, and upgrades after recovery. Repeated transient refusals with the same fallback update only operational state; product/index bytes remain unchanged. The changed signature format causes older selections to be recomputed once.

Malformed records are counted and skipped. Bounded `$NEV` warnings record up
to three observations per source/digest across instance replacement. The first
observation supplies an example; repetitions only increase the invalid count.
After three observations a malformed seed, identity or index row is quarantined and no
longer makes that source incomplete. Quarantine can permit a missing-source
removal; the mass-removal guard still applies. Quarantine shares the 4,096-entry operational-state bound; excess unknown defects remain conservative for absence decisions.
Operational-source defects are recorded in the same quarantine state and removed by source compaction. Incomplete index scans are retried on each tick and explicitly defer unselected objects. Weather defects do not disable removals. Incomplete weather scans defer all fits, preserving existing AP selections; ingestion-only fallbacks and independently decidable decays remain available. A known decay needs only that object's
valid identity and retained selection. Missing-source removal needs complete
seed and identity sources; unknown or dropped selection rows are never new work.

Notice examples have separate four-example quotas for invalid records,
failures, bounds, removals, clock and general information. Removal proposals
have an aggregate count; their reasons are sampled, not a durable per-object
removal log. Successful changed ticks use `Info`; bounded ticks without changes
use `Unchanged`, including backoff and quarantine. Exhausting the scan budget uses `Missing` and identifies scan exhaustion even when no object was processed. Diagnostics distinguish
these outcomes in `REASON`. Fatal scan/storage errors use `Missing` and fail
the invocation. The node timer recognizes only `Unchanged` as a successful
no-batch result. `Info`, `Skipped`, `Missing` and `Expired` without a batch do
not receive that exemption and can widen retrieval backoff. One deferred
object therefore does not slow an otherwise healthy timer.

Product lookup refusals are isolated per object. Three consecutive lookup
failures stop dispatch for the tick; a staged selection resets that count.
A refused product or index generation batch stops the invocation and preserves
the previous committed selection. Durable attempts retain prepared batch references
for recovery after backoff. Annotation/composer refusals return typed outcomes. Transport
corruption and failed source-page queries stop the scan.

A matching committed selection avoids any OCM read. After recomputation,
recovery checks only the prepared product batches named in durable attempt state,
reusing identical stored records after interruption, including when the retry's
object grouping changes. Legacy single-product batch identifiers remain readable.
The controller stages successful selections; a failed object retains its attempt
state and does not prevent the others from committing. Product batches are bounded
to 4 MiB and 1,000 records; the single terminal index batch is bounded to 4 MiB,
and staged output to 32 MiB. These output buffers are additional to resident-input
accounting. A 256-object tick with products fitting in 4 MiB uses one product batch
and one index batch, rather than 512 publication batches. Operational snapshots
remain separate writes: one before each dispatch, one before generation storage,
and one after the index acknowledgment, plus failures or quarantine updates.

Products precede the index write; only the terminal batch identifier ends in
`:complete`. A kill between them leaves the prior selection visible. The retry
obeys durable attempt backoff, reuses stored products, and commits the complete
replacement. A refused product or index batch aborts generation storage; successful
objects retain their attempts for recovery. A byte-bound stop flushes staged
objects and defers the object that did not fit. No tick publishes an intermediate
index generation.
The host must preserve referenced products and expose its live index through
complete pages. The controller does not scan retained OCM history or depend
on publication-journal internals. Seed/identity/index paging remains proportional
to those live sources; selection compaction occurs in memory.

## Consumer rules and covariance

Read `CATProduct.KIND` before flying a selected record. `ApElements` and
`Sgp4Elements` distinguish fitted AP and SGP4 fallback products. The stable
`old-span fallback` selection-reason prefix identifies an expired seed.
Independently check an AP product's `FIT_START` and `FIT_STOP` against the
requested propagation time, including the configured validity margin. Do not
fly a selected AP product outside that interval merely because the timer has
not replaced it. Selection reasons describe the selection time, not a promise
that a product remains valid as the consumer's clock advances. Request or use
a suitable SGP4 product when the fitted span no longer covers the request.
`CATProduct.STALE` means retirement by a maneuver in the standard; time expiry
does not set it. CAT has no typed enum for a fallback's time-expiry reason.

A nonempty `PRODUCTS_AS_OF` with zero products is a removal, whether the empty
vector is present or omitted by a reader's repack. No index row means unprocessed,
not removed. A bounded sample of removal reasons appears in the tick notice; CAT has no field
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
must match ingestion or the exact-W fit interval with an absolute interval difference strictly below one millisecond, which
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

The exact class setting is `catalog.nonresonant_max_e: 0.05` together with
`catalog.resonant_max_e: 0.3`. Eccentricity above the relevant limit produces
`KIND: Sgp4Elements` with reason `outside configured AP class`; equality remains
eligible for fitting. The module's resonance bands (`src/resonance.inc::band_of`
in `sdn-ap`) in radians/minute are (0.0035003818, 0.0052505727),
[0.0070007636, 0.0105011454], (0.0105011454, 0.015751718], and
[0.0052505727, 0.007875859]. Their union is (0.0035003818, 0.015751718],
which is the controller's test. Mean motion converts from revolutions/day by
multiplying by 2π/1440. No additional class option is required. Resident accounting includes bytes plus 256 bytes
per retained entry and replaces superseded entries. Other partitions' records
are validated but not retained. Operational-state bookkeeping has the combined 4,096-entry bound above. A bounded partial scan reports read count and
settings and processes only objects with retained seed, identity and selection
when capacity is exceeded. The removal guard counts known decays and absences proved by complete sources; capacity-dropped identities do not count as absent. Operational state is scanned before selections so index quarantine is available; selections precede seeds, identities and weather. Any dropped
replacement makes that object ineligible for work. A partial scan suppresses
absence removals; a known decay remains independently decidable. Increase a binding
setting within its bounds or add partitions. Accounting is not total heap use;
configure at least 4,096 memory pages (256 MiB). Full-catalog heap use is unmeasured.

Monotonic budget checks run between pages and before each object. The reserve
is the larger of the configured allowance and twice the longest observed object
duration. It is not a guarantee against a single slow or blocked operation.
Configure `execution_timeout: 10m` with the 540-second controller budget and
`release_after_run: true` so an interrupted instance is discarded. A host must
replace a poisoned invocation before reuse; keeping an interrupted instance
is unsupported. Durable attempt events preserve failure backoff across that replacement.

## Operator configuration: 33,000 objects on four services

Build the unsigned bundle with `CATALOG_FLOW_PARTITIONS=4`, install the four
`dist/flow/partitions/0` through `dist/flow/partitions/3` bundles under their
program IDs below, and prime their native compiled artifacts through the host's
flow installation/prewarm path. The host needs indexed storage pages, threaded
flow execution, typed timer input and paired catalog publication. This example
is a host configuration fragment; JSON is also valid YAML. Merge it into the
node configuration, preserving other required services and publication rules.

Replace `catalog-producer` consistently with the node's publication provider ID.
Replace the three input provider/source pairs with the exact sources populated
by the installed element, identity and weather retrieval flows. The controller
performs no retrieval. Inputs are `OMM.fbs`, `CAT.fbs` identities and `SPW.fbs`;
outputs are `OCM.fbs/catalog-products`, `CAT.fbs/catalog-index`, and private
`NEV.fbs/catalog-attempts-0-of-4` through `catalog-attempts-3-of-4` under that
same provider. Each operational source has exactly one serial service owner;
exclude those four sources from automatic publication and expiry. Enable
publication retention on empty product/index sources in store format 4 before
first ingestion; keep effective series-retention overrides at zero.

```json
{
  "flows": {
    "enabled": true,
    "max_flows": 4,
    "max_memory_pages": 4096,
    "first_fire_when_due": true,
    "services": [
      {
        "flow": "com.digitalarsenal.flows.catalog-builder.partition-0",
        "memory_pages": 4096,
        "execution_timeout": "10m",
        "release_after_run": true,
        "exclusive_group": "",
        "intervals": {
          "refresh": "10m"
        },
        "retrieval_interval": "1m",
        "config": {
          "catalog.provider": "catalog-producer",
          "catalog.identity_provider": "identity-provider",
          "catalog.identity_source": "current-identities",
          "catalog.weather_provider": "weather-provider",
          "catalog.weather_source": "daily-weather",
          "catalog.seed_providers": [
            "element-provider"
          ],
          "catalog.seed_sources": [
            "public-elements"
          ],
          "catalog.nonresonant_max_e": 0.05,
          "catalog.resonant_max_e": 0.3,
          "catalog.batch_size": 256,
          "catalog.partition_count": 4,
          "catalog.partition_index": 0,
          "catalog.page_size": 512,
          "catalog.max_records": 400000,
          "catalog.max_bytes": 67108864,
          "catalog.invocation_budget_ms": 540000,
          "catalog.object_allowance_ms": 2000,
          "catalog.max_removal_fraction": 0.25,
          "catalog.recipe_revision": "W/1",
          "catalog.validity_margin_seconds": 0,
          "catalog.max_fit_rms_km": 2,
          "catalog.max_fit_error_km": 10
        }
      },
      {
        "flow": "com.digitalarsenal.flows.catalog-builder.partition-1",
        "memory_pages": 4096,
        "execution_timeout": "10m",
        "release_after_run": true,
        "exclusive_group": "",
        "intervals": {
          "refresh": "10m"
        },
        "retrieval_interval": "1m",
        "config": {
          "catalog.provider": "catalog-producer",
          "catalog.identity_provider": "identity-provider",
          "catalog.identity_source": "current-identities",
          "catalog.weather_provider": "weather-provider",
          "catalog.weather_source": "daily-weather",
          "catalog.seed_providers": [
            "element-provider"
          ],
          "catalog.seed_sources": [
            "public-elements"
          ],
          "catalog.nonresonant_max_e": 0.05,
          "catalog.resonant_max_e": 0.3,
          "catalog.batch_size": 256,
          "catalog.partition_count": 4,
          "catalog.partition_index": 1,
          "catalog.page_size": 512,
          "catalog.max_records": 400000,
          "catalog.max_bytes": 67108864,
          "catalog.invocation_budget_ms": 540000,
          "catalog.object_allowance_ms": 2000,
          "catalog.max_removal_fraction": 0.25,
          "catalog.recipe_revision": "W/1",
          "catalog.validity_margin_seconds": 0,
          "catalog.max_fit_rms_km": 2,
          "catalog.max_fit_error_km": 10
        }
      },
      {
        "flow": "com.digitalarsenal.flows.catalog-builder.partition-2",
        "memory_pages": 4096,
        "execution_timeout": "10m",
        "release_after_run": true,
        "exclusive_group": "",
        "intervals": {
          "refresh": "10m"
        },
        "retrieval_interval": "1m",
        "config": {
          "catalog.provider": "catalog-producer",
          "catalog.identity_provider": "identity-provider",
          "catalog.identity_source": "current-identities",
          "catalog.weather_provider": "weather-provider",
          "catalog.weather_source": "daily-weather",
          "catalog.seed_providers": [
            "element-provider"
          ],
          "catalog.seed_sources": [
            "public-elements"
          ],
          "catalog.nonresonant_max_e": 0.05,
          "catalog.resonant_max_e": 0.3,
          "catalog.batch_size": 256,
          "catalog.partition_count": 4,
          "catalog.partition_index": 2,
          "catalog.page_size": 512,
          "catalog.max_records": 400000,
          "catalog.max_bytes": 67108864,
          "catalog.invocation_budget_ms": 540000,
          "catalog.object_allowance_ms": 2000,
          "catalog.max_removal_fraction": 0.25,
          "catalog.recipe_revision": "W/1",
          "catalog.validity_margin_seconds": 0,
          "catalog.max_fit_rms_km": 2,
          "catalog.max_fit_error_km": 10
        }
      },
      {
        "flow": "com.digitalarsenal.flows.catalog-builder.partition-3",
        "memory_pages": 4096,
        "execution_timeout": "10m",
        "release_after_run": true,
        "exclusive_group": "",
        "intervals": {
          "refresh": "10m"
        },
        "retrieval_interval": "1m",
        "config": {
          "catalog.provider": "catalog-producer",
          "catalog.identity_provider": "identity-provider",
          "catalog.identity_source": "current-identities",
          "catalog.weather_provider": "weather-provider",
          "catalog.weather_source": "daily-weather",
          "catalog.seed_providers": [
            "element-provider"
          ],
          "catalog.seed_sources": [
            "public-elements"
          ],
          "catalog.nonresonant_max_e": 0.05,
          "catalog.resonant_max_e": 0.3,
          "catalog.batch_size": 256,
          "catalog.partition_count": 4,
          "catalog.partition_index": 3,
          "catalog.page_size": 512,
          "catalog.max_records": 400000,
          "catalog.max_bytes": 67108864,
          "catalog.invocation_budget_ms": 540000,
          "catalog.object_allowance_ms": 2000,
          "catalog.max_removal_fraction": 0.25,
          "catalog.recipe_revision": "W/1",
          "catalog.validity_margin_seconds": 0,
          "catalog.max_fit_rms_km": 2,
          "catalog.max_fit_error_km": 10
        }
      }
    ]
  },
  "publishing": {
    "enabled": true,
    "retention": {
      "keep_series": 0
    },
    "auto_publish": [
      {
        "schema": "OCM.fbs",
        "provider_id": "catalog-producer",
        "source_name": "catalog-products",
        "retain_for_publication": true,
        "min_interval": "5m",
        "settle": "10s"
      },
      {
        "schema": "CAT.fbs",
        "provider_id": "catalog-producer",
        "source_name": "catalog-index",
        "retain_for_publication": true,
        "min_interval": "5m",
        "settle": "10s"
      },
      {
        "schema": "CAT.fbs",
        "provider_id": "catalog-producer",
        "source_name": "catalog-index",
        "publish_scope": "source",
        "paired_publication": true,
        "catalog_product_source": "catalog-products",
        "min_interval": "24h"
      }
    ]
  }
}
```

This starts four independent modulo partitions, with 256 successful objects per
tick and a ten-minute timer, a 540-second controller budget and ten-minute host
timeout. The one-minute retrieval debounce admits each scheduled tick; failures
still back off. Each instance has 4,096 memory pages (256 MiB), so four service
limits sum to 1 GiB of guest linear memory, excluding host, runtime and publication
memory. Distinct program IDs and empty exclusive groups permit four services;
the memory and CPU cost remains operator provisioned.

For an evenly distributed 33,000-object catalog, 8,250 objects per partition need
33 full-capacity rounds at 256 objects each. That is 330 minutes of ten-minute
schedule slots, or 147,456 processing slots/day across four services. These are
arithmetic ceilings, not measured fit throughput; source scans, fitting, durable
state writes, failures, and publication can bind earlier. Each ordinary
256-object tick contributes two catalog batches and one complete generation.
All four services contribute eight such batches per round. Larger products can
require additional 4 MiB product batches, still followed by one index batch.

The first consumer follows whole paired snapshots at the configured 24-hour
interval. Both signed snapshot announcements are needed: products and index at
the same cutoff. The five-minute batch rules retain and drain changed batches
through the host's publication path; they do not change that consumer policy.
Inspect publication backlog and errors before increasing batch size or cadence.
[Publication and trust requirements](PUBLICATION.md) describe verification and
the schema-wide anonymous-read boundary.

## Build and validation

The bundled exact-W chain is built against sdn-ap 0.6.60 with chain adapter 0.1.0.
Build the unsigned `sdn-ap` generated translation unit, then from this directory:

```sh
SDM_MODULE_UNSIGNED_BUILD=1 node build.mjs
SDM_MODULE_UNSIGNED_BUILD=1 node build-flow.mjs
node --test tests/controller.test.mjs tests/production.test.mjs tests/sdk_compat.test.mjs
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
recovery after a WebAssembly trap, deterministic refusals after instance
replacement, poison quarantine, storage circuit breaking, submillisecond epochs,
and stored AP/SGP4 equality to original fields/states/formal covariance.
Covariance tests construct axes independently, compare an exact signed-axis
case, and rotate the population model using an independently propagated seed.
The paged connector validates frame lengths/counts and byte/row limits; the
host contract has `TestStorageIndexPageCompleteSnapshots` coverage. A loopback publication check uses throwaway signing identities, verifies snapshot and changed-batch imports into a separate consumer store, and rejects untrusted signatures and tampered shards. Anonymous-read policy is inspected without changing it; deployment is excluded.

## Chain refusal classification

`control.cpp::transient_refusal` is the classification boundary. Only
`out-of-memory`, `pool-dead`, `output-failed`, `output`, and `host-failed` are transient:
resource availability or delivery can change without a different seed. A transient fit refusal can select its SGP4 fallback while retaining the retry marker; output/storage failures preserve the prior committed selection. All other codes are final for the input
signature, including unknown codes; changing the recipe revision permits a
retry after a software correction. No attempt time is included in an orbit.

The chain sources (`src/chain.cpp`, `src/chain_inputs.cpp`) emit `invalid-input`,
`missing-input`, `chain-output-bound`, `missing-sgp4`, `missing-flight`,
`invalid-flight`, and `missing-fit`. These are deterministic contract failures.
The ingestion, propagation and fit methods also return deterministic validation
or physical refusals, grouped by their source:

| Source in `propagator/sdn-ap/src` | Codes or code families | Why final for identical inputs |
| --- | --- | --- |
| `ingest_omm.inc` | `invalid-omm`, `missing-omm`, `unsupported-center`, `theory-not-ingestable:AP`, user-parameter refusals | Seed content or theory |
| `fit_oem.inc` | `invalid-pvn`, `provenance-count`, `invalid-oem`, `missing-oem`, `unsupported-center`, `reference-frame-undeclared`, `reference-frame-conflict`, `unsupported-frame`, `unsupported-time-system`, `too-few-states`, `fit-failed`, `fit-implausible`, `decayed-in-arc:<date>`, covariance-layout refusals | Fixed arc, fit policy, frames and numerical solve |
| Configuration helpers | `configuration-missing`, `invalid-configuration`, `configuration-refused` | The configured PCF does not change between attempts |
| Weather helpers | `weather-rows-missing`, `weather-rows-invalid`, `weather-rows-short`, `weather-rows-unselected`, `weather-source-unspecified` | Weather content and interval |
| Propagation and record helpers | `element-set-refused`, `propagation-failed`, `frame-failed`, `fit-at-branch-limit`, `cov-*`, `invalid-covariance`, `unsupported-*`, `carried-*`, `carry-*`, model/force/parameter refusals | Record, force policy, carried data or numerical limits |
| Controller acceptance | `fit-statistics refusal fallback` | Fixed state count, interval and error limits |

The final-by-default rule covers every returned code, including dynamic date
and parameter suffixes. A resource refusal never becomes a stored physical
refusal. A repeated deterministic fallback with the same signature emits no
product or index write.

### Refusal code inventory

The ingestion/flight/fit helper inventory below is final for identical inputs,
except the four resource/delivery codes identified above. The helpers also
guard cases excluded by exact W; those guards retain the same classification.

- `abi.inc`: `elements-other-theory`.
- `constants.inc`: `out-of-memory`.
- `pcf.inc`: `configuration`, `configuration-missing`, `configuration-refused`, `invalid-configuration`.
- `ingest_omm.inc`: `invalid-omm`, `missing-omm`, `out-of-memory`, `output-failed`, `unsupported-center`.
- `propagate.inc`: `element-set-refused`, `frame-failed`, `output-failed`, `propagation-failed`.
- `fit_oem.inc`: `fit-failed`, `fit-implausible`, `invalid-oem`, `invalid-pvn`, `missing-oem`, `output-failed`, `provenance-count`, `reference-frame-conflict`, `reference-frame-undeclared`, `too-few-states`, `unsupported-center`, `unsupported-frame`, `unsupported-time-system`, `weather-rows-short`.
- `fit.inc`: `fit-at-branch-limit`.
- `ocm.inc`: `atmosphere-unsupported`, `atmosphere-weather-mismatch`, `cov-parameter-order`, `cov-parameter-unknown`, `cov-parameter-unnamed`, `cov-size`, `cov-units`, `dcl-not-flown`, `density-correction-atmosphere-mismatch`, `density-correction-cid-missing`, `density-correction-missing`, `density-correction-unselected`, `elements-other-theory`, `frame-pairing-invalid`, `gravity-model-mismatch`, `grid-not-flown`, `invalid-density-correction`, `invalid-ocm`, `mean-element-theory-unspecified`, `mean-elements-missing`, `missing-ocm`, `omm-not-flown`, `orb-averaging-mismatch`, `radiation-model-mismatch`, `radiation-model-superseded`, `solid-tides-unsupported`, `spw-not-flown`, `unsupported-center`, `weather-rows-invalid`, `weather-rows-missing`, `weather-rows-short`, `weather-rows-unselected`, `weather-source-unspecified`.
- `oem.inc`: `bad-grid`, `output-failed`, `too-many-states`.
- `atmosphere_inputs.inc`: `density-correction-missing`, `density-correction-unselected`, `invalid-density-correction`, `weather-rows-invalid`, `weather-rows-missing`, `weather-rows-unselected`.
- `carried.inc`: `carried-basis-unsupported`, `carried-gap`, `carried-records-missing`, `carried-segment-invalid`, `carried-state-data`, `carried-type-mismatch`, `carried-type-unsupported`, `carried-velocity-coefficients`, `carry-not-covered`, `carry-order`, `carry-states-sparse`, `carry-tolerance`, `frame-failed`, `frame-pairing-invalid`.

Dynamic final codes are `user-defined-parameters:<count>`,
`decayed:<epoch>`, `decayed-in-arc:<epoch>`,
`parameter-not-modeled:<parameter>`, `theory-not-flown:<theory>`, and the
`weather-rows-invalid:<day>` / `weather-rows-short:<day>` variants. Empty or
unrecognized codes are final contract failures. The inventory and the
final-by-default classifier prevent a new deterministic code from silently
becoming a periodic product rewrite.

### Downstream refusal classification

Annotation errors `invalid-input`, `invalid-ocm`, `invalid-elements`, `unsupported-ocm`, `seed-mismatch`, `seed-epoch-mismatch`, `already-annotated`, `invalid-output`, and `invalid-models`, composer `invalid-replacement`, and malformed chain/fit/annotation/composition results are final for the same numerical signature. Resource, output and storage failures remain retryable. A recipe revision permits retry after a software or embedded-model correction.

The controller and population annotator share `common/catalog_epoch.hpp`: comparisons use unrounded UTC seconds and the same strict one-millisecond bound. AP annotation embeds the original fit buffer unchanged. SGP4 fallback annotation unpacks and repacks the input to append its reason comment: FlatBuffer layout, offsets and padding can differ. Tests prove equality of every preexisting decoded field and bit-identical propagated states and formal covariance; they do not claim original SGP4 wire-byte identity.


### Fallback records and repeated inputs

An SGP4 fallback is an `$OCM` containing the seed set's mean elements, with
`KIND=Sgp4Elements` in its catalog selection. `MEAN_ELEMENTS` carries
`MEAN_ELEMENT_THEORY=SGP4`, `EPOCH` (UTC), `MEAN_MOTION` (revolutions/day),
`ECCENTRICITY`, `INCLINATION`, `RA_OF_ASC_NODE`, `ARG_OF_PERICENTER`,
`MEAN_ANOMALY` (angles in degrees), `BSTAR`, `MEAN_MOTION_DOT` and
`MEAN_MOTION_DDOT`. These are every seed field read by the module's SGP4
path; none is missing. The record also declares Earth, UTC, Kozai averaging
and WGS-72 gravity. A catalog consumer converts these typed fields to its
SGP4 input representation. No Cartesian state is required for that conversion.
See `propagator/sdn-ap/src/ingest_omm.inc`, `src/ocm.inc` in that module,
and this flow's `src/chain.cpp`.

When ingestion succeeds but the seed cannot be propagated, the product still
carries those mean elements and has no `STATE_DATA` state. Its header comment
and the catalog product's `SELECTION_REASON` contain
`fit refusal fallback: element-set-refused` for initialization refusal, or
`fit refusal fallback: propagation-failed` for failure during flight. The
selection reason also carries input and identity fingerprints. These reasons
distinguish a failed flight from a policy fallback such as
`outside configured AP class`; neither fallback supplies a Cartesian state.
If ingestion itself refuses the seed, there is no new fallback product: the
controller records the failure and preserves any previous selection.
See `control/control.cpp` (`chain`) and the module's `src/propagate.inc`.

Posting byte-identical element-set data has the same content record identifier
and is not a new arrival. With unchanged weather, recipe and validity class,
the controller's numerical-input fingerprint also stays equal, so the post
rebuilds neither the product nor its selection. Independent weather changes,
validity expiry or a transient failure's retry remain reconciliation triggers.
See `common/sds_cid.hpp` and `control/control.cpp` (`fit_seed_signature` and
`next_object`).
