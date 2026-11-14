# Catalog reconciliation flow

The timer flow reads configured OMM sources, CAT identities, SPW weather, and
its durable CAT/OCM outputs through `index_page`. It selects one product per
object, stores the product before replacing the index entry, and clears the
product list with an as-of time when an object leaves the current sources.
The default timer interval is ten minutes. Publication and daily snapshot
export are absent from this flow.

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
They are full 6-by-6 GCRF matrices labeled uncalibrated and identified by the
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
| `catalog.batch_size` | 128 | 1–256 changed objects per tick |
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
