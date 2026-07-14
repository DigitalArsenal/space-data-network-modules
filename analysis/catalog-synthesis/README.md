# Supplemental Catalog Synthesis (App 2 — task A2.7, owner goal 3)

Scheduler-driven module that merges two stored OMM inputs into **one canonical
CelesTrak-replacement OMM catalog**, published under the synthesis provider
identity so any SDN node can subscribe to the replacement catalog.

```
storage.query(schema="OMM")                         [consumption lane, cap: storage_query]
   ├─ our OD-fitted supplemental OMMs   (JSON; USER_DEFINED_SDN_SOURCE_* lineage; UNTAGGED today)
   └─ Space-Track GP OMM records        ($OMM FlatBuffer; SourceName="spacetrack-gp")
      → catsyn::read_stored_omm          (encoding-agnostic normalize + source classify)
      → deterministic per-NORAD precedence + newest-epoch dedup
      → schema-exact canonical OMM JSON + full provenance
      → publish_record_with_source(OMM)  [common/provider_source.hpp]
           storage.ingest_with_source → keyslot.sign(CID) → schema-exact PNM → pubsub.publish
      → synthesis summary                (returned + published on the channel)
```

- **SourceName** `catalog-synthesis`
- **PNM topic** `sdn/data-source/catalog-synthesis`
- **Schema** `OMM` (schema-exact GP keys throughout)
- **Timer** `catalog-synthesis-pull` → `synthesize_catalog`, default **6h** (matches
  the Space-Track current-gp poll; the newest inputs refresh on a 2–6h cadence).
- **Capabilities** `storage_query`, `storage_ingest`, `wallet_sign`, `pubsub`.

## The two inputs coexist under one schema in TWO encodings

The FlatSQL store persists each writer's record bytes **verbatim** (SDN
`internal/storage/flatsql.go` `storeOne` → `appendFlatSQLStreamRecord`: no
re-encode), so a single `storage.query(schema="OMM")` returns a **mixed** stream:

| input | writer | on-the-wire form | SourceTags |
|---|---|---|---|
| our OD-fitted OMMs | `analysis/od/fit-pipeline` via `storage.write` | **raw JSON** (`od::elements_to_json` + `COMMENT[]` + `USER_DEFINED_SDN_SOURCE_*`) | **none** (untagged today — see migration note) |
| Space-Track GP | Go `internal/ingest/spacetrack_supplemental.go` → `ingestGPRows` → `sds.NewOMMBuilder` → `store.StoreWithSourceTags` | **`$OMM` FlatBuffer** | `SourceName="spacetrack-gp"`, `ProviderID="space-track"`, `ORIGINATOR "18 SPCS"` |

`src/omm_reader.hpp` detects the encoding per record (`{` ⇒ JSON; `$OMM` at byte
4/8 ⇒ FlatBuffer, verified before decode via the SDS `OMM_generated.h` bindings)
and normalizes both into one `CanonOmm` with schema-exact GP element keys. Nothing
is fabricated: an unreadable record is skipped with a reason; a record with no
NORAD is surfaced for quarantine.

### Source classification — tag-first, USER_DEFINED fallback (documented policy)

1. **`SourceTags.SourceName` present** (the `storage.query` projection fix, SDN
   `8a52a3b3`, projects it): a name in `spacetrackSourceNames`
   (`spacetrack-gp`/`celestrak-gp`) ⇒ **Space-Track GP**; any other name ⇒ **our
   fit**, provider = the tag (this is what a *migrated* fit-pipeline will emit,
   e.g. `spacex-starlink`).
2. **Untagged** ⇒ fall back to the record's `USER_DEFINED_SDN_SOURCE_NAME`
   (⇒ **our fit**, provider = that value). This is the path our fit records take
   **today** (they are written untagged via `storage.write` but carry the
   `USER_DEFINED_SDN_SOURCE_NAME` field).
3. An untagged bare OMM with neither is treated as an authoritative catalog input
   (Space-Track-GP kind) — never mis-attributed to a real provider.

## Precedence policy (deterministic; gate status is DATA)

For each NORAD present in either input, exactly one canonical record is emitted:

> **Our fitted OMM outranks the Space-Track GP record for the same NORAD ONLY when
> its provider is at A2.4 gate level `hard-pass` AND the fit is STRICTLY fresher
> (epoch). Every other case falls back to Space-Track GP. An object present in
> EITHER input is never dropped. An object with no NORAD is quarantined, never
> keyed as NORAD 0.**

Per-NORAD decision (`decide()` in `src/catalog_synthesis.cpp`):

| inputs for the NORAD | winner | `USER_DEFINED_SDN_CATALOG_PRECEDENCE` |
|---|---|---|
| ours (hard-pass) **strictly fresher** than ST | **ours** | `ours-hardpass-fresher` |
| ours (hard-pass) not strictly fresher than ST | ST | `spacetrack-ours-not-fresher` |
| ours (interim/blocked), ST present | ST | `spacetrack-ours-gate-<level>` |
| ours only (no ST) | **ours** | `ours-sole-source-gate-<level>` |
| ST only (no ours) | ST | `spacetrack-sole-source` |

- **Strictly fresher** = `epoch_ours > epoch_st`. Equal epoch ⇒ ST wins (no
  freshness advantage → prefer the authoritative catalog). Epochs are compared on
  a normalized, fixed-width, chronological key (`YYYYMMDDHHMMSS.ffffff`), robust
  to the `T`/space separator, a trailing `Z`, and fractional-digit length.
- **Sole-source safety net.** When our fit is the ONLY data for an object, it is
  included regardless of gate level (never dropped) — the gate governs whether we
  can OUTRANK Space-Track, and there is nothing to outrank. The gate level is
  still recorded in provenance (`ours-sole-source-gate-interim`, etc.).
- **Gate status is a checked-in JSON config**, not code:
  [`config/provider-gate-status.json`](config/provider-gate-status.json), which
  CI/coordinator maintains. The build embeds it as the compiled default; a runtime
  `gateStatus` override (request payload > `plugin.getConfig`) can promote/demote a
  provider without a rebuild. Keys are the provider registry tokens (== adapter
  `SourceName` == fitted `USER_DEFINED_SDN_SOURCE_NAME`). Current truth
  (2026-07-13): `spacex-starlink=hard-pass`, `iss/glonass/cpf/intelsat=interim`,
  `gps/oneweb=blocked`. **Only `hard-pass` providers' fits outrank Space-Track.**

### Dedup within a source

Newest-epoch-wins per (source-kind, NORAD). Tie-break on identical epoch =
lexicographically smallest CID (deterministic, no wall-clock). Distinct NORADs are
never collapsed.

### Quarantine (no fabricated identity)

Records with no NORAD (our unmapped-object-id fits) are quarantined into the
summary with their honest identity (CID, provider, OBJECT_NAME, `id_status`) and
are NEVER stored/keyed as NORAD 0. Space-Track GP records always carry a NORAD.

## Provenance per catalog record

Every catalog record is the winning source's schema-exact OMM (JSON passthrough
for our fits — preserving their `COMMENT[]`/`USER_DEFINED_SDN_SOURCE_*` fit
lineage; re-serialized from the `$OMM` FlatBuffer for Space-Track) plus a uniform
synthesis provenance block:

```
USER_DEFINED_SDN_CATALOG_SOURCE_KIND   "ours-fit" | "spacetrack-gp"
USER_DEFINED_SDN_CATALOG_SOURCE_NAME   winning provider token
USER_DEFINED_SDN_CATALOG_SOURCE_CID    winning source record CID
USER_DEFINED_SDN_CATALOG_PRECEDENCE    the rule applied (table above)
USER_DEFINED_SDN_CATALOG_GATE_STATUS   ours: provider gate; ST winner: "n/a"
USER_DEFINED_SDN_CATALOG_BATCH         the run's batch id
USER_DEFINED_SDN_CATALOG_COMMENT       human-readable winning-source + rule note
```

The published PNM carries a matching `provenance` sidecar (`WINNING_SOURCE_*`,
`PRECEDENCE_RULE`, `GATE_STATUS`, `BATCH_ID`, and — for our fits —
`FIT_SOURCE_CID`/`FIT_SOURCE_SHA256`/`FIT_RMS_KM`/`FIT_CONVERGED`/`FIT_ID_STATUS`).

## Determinism guarantees

Two runs over the same stored inputs produce **byte-identical** outputs:

- **No wall-clock anywhere.** Record + PNM `PUBLISH_TIMESTAMP` = the winning
  record's own `EPOCH` (a sourced timestamp). No `time()` call exists in the path.
- **`batch_id` = SHA-256 of the sorted set of input record content ids**
  (`"catalog-synthesis:v1\n" + join(sort(all input CIDs), "\n")`). Identical
  stored inputs ⇒ identical CIDs ⇒ identical batch. All records in a run share it.
- **Deterministic ordering.** NORAD iteration is ascending (`std::map`), provider
  aggregation is by name, quarantine/skip lists are sorted — independent of the
  order `storage.query` returns records.
- **Deterministic signing.** ed25519 (RFC 8032) is deterministic; the in-guest
  CID (`cid_v1_raw_sha256`) is a content hash. Same key + same record ⇒ same CID
  ⇒ same signature.

Proven: two consecutive runs of the checked-in fixture hash identically —
`a1829c1f5db3d9884a40ef78083c65b0db31995d366cb79518ed75693db9303d` — with
`batch_id=eceade82560a70b18876371a9f4c2db863473b43931c7244d5a18dccaeb2b53a`.

## DEPENDENCY — deferred fit-pipeline tag migration (A2.3/A2.2c-3 residual)

`analysis/od/fit-pipeline` currently writes its fitted OMMs via `storage.write`
(**untagged**), so this module classifies them by the `USER_DEFINED_SDN_SOURCE_NAME`
field (the documented fallback above). This is correct and tested, but it means a
fitted record and a Space-Track record are told apart by *record content*, not by
*source tag*.

When the `analysis/od/**` lock frees, the fit-pipeline OUTPUT must migrate from
`storage.write` → `storage.ingest_with_source` (mirroring what the seven adapters
did in A2.2c-3), tagging each fitted OMM with:

- `source_name` = the provider registry token (`spacex-starlink`, `iss`,
  `glonass`, …) — **the same token used as the gate-status key and the
  `USER_DEFINED_SDN_SOURCE_NAME` value today**, so gate lookup is unaffected;
- `provider_id` = the provider token (adapters reuse `source_name`);
- `batch_id` = the fit run's source sha256;
- `reconcile` = `"none"` (never collapse distinct sibling NORAD-0 objects).

**This module needs NO change when that lands** — its classifier is tag-first, so
tagged fitted records are picked up by rule 1 (provider = the tag) exactly as the
untagged ones are today by rule 2. The only observable difference: the summary's
per-provider grouping becomes tag-driven rather than content-driven. This module's
`test/module.test.mjs` already asserts BOTH paths (tagged + untagged our-fit
records classify identically) so the migration is regression-covered in advance.

## Build & test

```
SDN_LOCAL_EMSDK_DIR=<repo>/licensing/core/deps/emsdk node build.mjs
node --test test/module.test.mjs
```

Build inputs (no orbit math — this module only reads/merges/republishes OMMs):
`src/catalog_synthesis.cpp` + `src/omm_reader.hpp` + generated
`dist/manifest-exports.cpp` (embedded `$PLG` manifest) + generated
`dist/gate-status-embed.cpp` (embedded `config/provider-gate-status.json`),
compiled against `common/provider_source.hpp`, the SDK keyslot client, the SDS
`OMM_generated.h` FlatBuffer reader (`licensing/core` generated bindings), and the
repo-vendored flatbuffers headers (`SDN_FLATBUFFERS_INCLUDE_DIR`, default
`repos/main-packages/flatbuffers/include`). PURE_WASI standalone, same as the
adapters/fit-pipeline.

The test builds a fixture constellation with BOTH inputs — fitted OMMs (JSON,
real fit-pipeline provenance shape) and Space-Track GP `$OMM` FlatBuffers (built
with the SDS OMM binding from the trimmed live gp JSON at
`test/fixtures/spacetrack-gp-current-sample.json` + CelesTrak SupGP reference rows
for the overlap objects) — drives the rebuilt WASM through a mock
`space_data_module_host` bridge (serving `storage.query`, capturing
`storage.ingest_with_source`/`pubsub.publish`, signing `keyslot.sign`), and
asserts the packet acceptance items:

- **(a) union completeness** — every NORAD in either input is in the catalog; NORAD 0 never keyed.
- **(b) determinism** — two runs hash identically.
- **(c) precedence** — hard-pass fresher fit wins (Starlink 67850); an *interim*
  fit that is *fresher* still loses (ISS 25544); a *staler* hard-pass fit loses
  (Starlink 67851); a sole-source fit is kept (GLONASS 32393).
- **(d) quarantine** — the unmapped fit is quarantined, never a catalog record.
- **(e) element-space diff** — every overlap winner is within A2.4 tolerances of
  its epoch-aligned CelesTrak reference row (exercises both the JSON passthrough
  and the FlatBuffer decode+reserialize fidelity).

plus the ABI/manifest contract, schema-exact keys + SourceTags on every record,
tag-first/USER_DEFINED-fallback classification, and a runtime gate-status override.

## Residuals / follow-ups

- **Catalog-scale pull.** `storage.query` filters only `{schema, day,
  norad_cat_id, entity_id, limit}` (no source filter). This module issues one
  query at a large `queryLimit`; a full ~30k-object catalog on a busy store may
  need day/NORAD-partitioned iteration (a straightforward loop) — deferred until a
  live catalog-scale store exists (rides A2.6's continuous-operation lane).
- **Fit-pipeline output tag migration** (above) — the one change required when
  `analysis/od/**` frees; this module is already forward-compatible and tested.
- **Space-Track frame/time constants.** Space-Track GP is invariantly TEME/UTC/
  SGP4/EARTH (18 SPCS); the FlatBuffer re-serialization emits those as documented
  constants rather than decoding the enum fields. If a non-TEME GP source is ever
  tagged into the OMM table, add enum decoding.
