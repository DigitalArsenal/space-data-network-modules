# data-source/osm-source — the OSM context epoch, named

Phase 3 of the "OpenStreetMap on SDN" plan (2026-09-03; owner decision the
same day: the context is hosted as **FlatGeobuf**). The imagery detector in
OrbPro (`packages/orbpro-integration/analysis.imagery-detection`,
`setContext({ source: "fgb", baseUrl })`) needs one thing from a node: which
OSM context epoch it serves and where the epoch's files live relative to the
node's origin. This module answers exactly that and nothing else. The
FlatGeobuf bytes themselves are served by the node's IPFS gateway under the
epoch's CID; clients range-read them (`<origin>/ipfs/<cid>/building.fgb`, …)
and this module never sees them.

Cloned from `data-source/terrain-source`'s catalogue route: one method,
`route`, `$HTQ` in, `$HTR` out, config read once per instance over
`plugin.getConfig` (or handed in on the optional `config` port), capabilities
`[]`, single-thread, browser + wasmedge.

## Routes (mount `/api/v1/osm/`, `flows/osm-serving.flow.json`, anonymous)

| path | answer |
| --- | --- |
| `tileset.json` | the epoch record `tools/osm-context/build-fgb.mjs` wrote (`FORMAT` `osm-context-fgb/1`): `FILES`, `DATASET_EPOCH`, `PROVENANCE` verbatim; `PAYLOAD.CID` set to the pinned CID; `EPOCH_BASE_PATH` = `<gateway path><cid>/`, relative to this origin. `cache-control: public, max-age=60`, strong ETag (sha2-256 multihash of the body), 304 on `If-None-Match`, `access-control-allow-origin: *`. 503 with `missingConfigKeys` when no epoch is pinned. |
| `` / `catalogue.json` | the camelCase discovery document: `epochId`, `delivery` (`ipfs` / `none`), `cid`, `datasetEpoch`, `epochBasePath`, `recordPath`, `format`, `attribution`. Same cache policy. |
| anything else | `404` `no-store`; non-GET/HEAD `405`. |

## Config (flow mount config, all read once per instance)

| key | meaning | default |
| --- | --- | --- |
| `osm_mount_path` | the mount prefix | `/api/v1/osm/` |
| `osm_gateway_path` | the node's IPFS gateway path | `/ipfs/` |
| `osm_epoch_cid` | the pinned epoch directory's CID (base58btc `Qm…` or base32 `b…`) | — (required for a record) |
| `osm_epoch_record` | the builder's `osm-context.fgb.json`, as an object, verbatim | — (required for a record) |
| `osm_attribution` | discovery-document attribution | `© OpenStreetMap contributors` |

## Build and test

```
npm ci
npm run build        # dist/isomorphic/module.wasm + guest-link (SDK compiler, single-thread)
npm test             # tests/serve.test.mjs (routes, ETag/304, 503, 404/405), tests/sdk_compat.test.mjs
```

The epoch itself: `node tools/osm-context/build-fgb.mjs --region <region>`,
`ipfs add -r` the output directory, pin it, then mount this flow with the CID
and the record. Rollback is re-pointing the config at the previous CID.
