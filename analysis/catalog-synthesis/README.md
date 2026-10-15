# Supplemental Catalog Synthesis (App 2, task A2.7)

`com.orbpro.catalog-synthesis` merges the stored `$OMM` records of two lanes into ONE canonical
CelesTrak-replacement OMM catalog, on typed contracts 1.0 (FlatBuffers only, no JSON):

- our OD-fitted supplemental OMMs: `analysis/od/fit-pipeline`'s `$OMM`, stored by the flow under the provider's
  `SOURCE_NAME` (`spacex-starlink`, `iss`, `glonass`, ...);
- Space-Track GP: `$OMM` stored under a Space-Track source name (`spacetrack-gp`, `celestrak-gp`).

```
tick (TICK, optional) -> storage.query(querySchema, queryLimit)        [typed $PIV hostcall, storage_query]
  -> classify (tag first) -> per NORAD the newest record of each lane -> precedence
  -> omm_meta    (IngestRequest, INGQ)                 } for hostcap/storage-ingest (meta + omm_records)
  -> omm_records (size-prefixed $OMM stream, by NORAD)  }
  -> status      (FlowNotice: summary, per provider, quarantine, unreadable, storage.query failure)
```

Storing and publishing the catalog are the flow's (hostcap/storage-ingest and the node's publication); the module
signs nothing and publishes nothing. The only hostcalls are `plugin.getConfig` and `storage.query`.

## Classification (tag first)

A stored record whose `SOURCE_NAME` is in `spacetrackSourceNames` is Space-Track GP; any other `SOURCE_NAME` is our
fit of that provider; an untagged record is an authoritative catalog input (Space-Track kind). A record that is not an
`$OMM` FlatBuffer (`unknown-encoding`, e.g. a legacy JSON fit), a malformed one (`malformed-flatbuffer-omm`) or one
without `EPOCH` (`missing-epoch`) is reported as unreadable and not used.

## Precedence (deterministic; gate status is data)

> Our fitted OMM outranks the Space-Track GP record for the same NORAD ONLY when its provider is at gate level
> `hard-pass` AND the fit is STRICTLY fresher (epoch). Every other case falls back to Space-Track GP. An object present
> in EITHER lane is never dropped. An object with no NORAD is quarantined, never keyed as NORAD 0.

| inputs for the NORAD | winner | `SDN_CATALOG_PRECEDENCE` |
|---|---|---|
| ours (hard-pass) strictly fresher than ST | ours | `ours-hardpass-fresher` |
| ours (hard-pass) not strictly fresher than ST | ST | `spacetrack-ours-not-fresher` |
| ours (another level), ST present | ST | `spacetrack-ours-gate-<level>` |
| ours only | ours | `ours-sole-source-gate-<level>` |
| ST only | ST | `spacetrack-sole-source` |

Epochs compare on a normalized fixed-width key (`YYYYMMDDHHMMSS.ffffff`). Within a lane the newest epoch wins; the tie
break is the lexically smallest CID.

Gate status is [`config/provider-gate-status.json`](config/provider-gate-status.json), compiled into the module by
`build.mjs` as C++ tables (the module parses no JSON). Node config overrides it (`plugin.getConfig`, one
`ModuleConfig`): `gateStatus.providers` (`{<provider>: <level>}`), `gateStatus.spacetrackSourceNames`,
`gateStatus.defaultLevelForUnlistedProvider`, and top-level `spacetrackSourceNames` /
`defaultLevelForUnlistedProvider`; also `querySchema` (`OMM`), `queryLimit` (20000), `sourceName`
(`catalog-synthesis`), `fileIdPrefix`, `dataSource` (recorded as provenance attributes).

## The catalog record

Each record is the winning stored `$OMM` with every field kept and the synthesis provenance appended as
`USER_DEFINED_PARAMETERS` (CCSDS `USER_DEFINED_x` keywords): `SDN_CATALOG_SOURCE_KIND` (`ours-fit` | `spacetrack-gp`),
`SDN_CATALOG_SOURCE_NAME`, `SDN_CATALOG_SOURCE_CID`, `SDN_CATALOG_PRECEDENCE`, `SDN_CATALOG_GATE_STATUS` (the fit's
gate level, `n/a` for a Space-Track winner), `SDN_CATALOG_BATCH`, `SDN_CATALOG_COMMENT`.

The batch's `IngestRequest`: `SCHEMA` `OMM.fbs`; `TAGS` `PROVIDER_ID` = `SOURCE_NAME` = `sourceName`, `BATCH_ID`,
`SOURCE_URL` `sdn://catalog-synthesis`; `RECONCILE` `None`; `PROVENANCE` with the record count, the stream's SHA-256
and the counts as attributes. Nothing is emitted on `omm_meta` / `omm_records` when the catalog is empty.

## FlowNotices (`status`)

- Info, `SOURCE_NAME` = `sourceName`: the summary; `COUNT` catalog records, `REASON`
  `catalog ours-won=N spacetrack-won=M quarantined=Q unreadable=U (R records read)`.
- Info, one per provider (`SOURCE_NAME` the provider): `COUNT` records won, `REASON` kind, candidates, won,
  quarantined.
- Skipped `no-norad-unmapped-object-id`: the quarantined records' CIDs (sorted).
- Skipped `unreadable`: `<reason>:<cid>` (sorted).
- Missing `storage-query-failed: <message>` when the query fails (nothing else is emitted).

Every notice carries the batch id and the tick's `FIRED_MS`.

## Determinism

No wall clock: `batch_id` = SHA-256 of `"catalog-synthesis:v1"` and the sorted input CIDs, joined by line feeds;
NORADs ascend; notices are in a fixed order. Two passes over the same stored records are byte-identical.

## Build and test

```sh
export SPACE_DATA_STANDARDS_ROOT=<spacedatastandards.org 1.249.0 tree>   # until 1.249.0 is on npm
node build.mjs                 # SDK compiler -> dist/isomorphic/module.wasm, dist/guest-link/
node --test test/*.test.mjs    # the built artifact in the SDK harness, stub host for plugin.getConfig/storage.query
```

The tests feed real `$OMM` records: Space-Track GP built from `test/fixtures/spacetrack-gp-current-sample.json` and
`test/fixtures/reference-elements.csv` (both synthetic; see `test/fixtures/PROVENANCE.md`), and our fits as
fit-pipeline stores them.

## Residuals

- Catalog scale: one `storage.query` at `queryLimit`; a full ~30k-object catalog on a busy store may need partitioned
  iteration.
- Fit lineage: the legacy JSON fits carried `USER_DEFINED_SDN_SOURCE_CID` / `_SOURCE_SHA256` / `RMS` / `CONVERGED`,
  which the catalog passed through; fit-pipeline's `$OMM` carries none (its `$OBD` holds the fit quality), so the
  catalog record names the winning stored record's CID only.
