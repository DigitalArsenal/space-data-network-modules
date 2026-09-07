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
