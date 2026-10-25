# Supplemental OMM flow

Hourly supplemental orbit determination on typed contracts 1.0: every frame between nodes and every hostcall is an
SDS FlatBuffer or a module-SDK runtime type. No JSON, no FSB/FSO transport.

```
host-cron TimerTick (hourly)
 ├─ spacex-starlink-source plan ─ http ─ select_objects ─ http ─ emit ─┐
 ├─ glonass-source request ─ http ─ emit ──────────────────────────────┤
 ├─ intelsat-source request ─ http ─ select_file ─ http ─ emit ────────┤  $OEM, one object a frame,
 ├─ cpf-source request ─ http ─ select_file ─ http ─ emit ─────────────┤  on its provider's port
 └─ iss-source request ─ http ─ emit ──────────────────────────────────┘
                                      od fit ─ omm_meta + omm ─ storage-ingest ─ IngestResult ─ od publish_request ─ http
                                             ─ ocm_meta + ocm ─ storage-ingest ─ ...
                                             ─ obd_meta + obd ─ storage-ingest ─ ...
                                             ─ status (FlowNotice)
 status record_event: the $OEM, the FlowNotices and the IngestResults -> one $DSS per route (provider-*.dss, od.dss, store.dss)
```

- **Sources** are the typed modules in `data-source/` (`spacex-starlink-source`, `glonass-source`, `intelsat-source`,
  `cpf-source`, `iss-source`); `hostcap/http-request` makes every fetch (HttpRequest / HttpResponse, the job in
  CONTEXT where a source needs one). Nothing here parses a provider's format.
- **`nodes/od`** fits each `$OEM` with the frozen complete-arc OD core (its epoch-specific `$OMM`, `$OCM`, `$OBD`) and
  SGP4-XP (an `$OMM` and `$OBD` per full-day window, `propagator/sgp4-xp` with the US Space Force Sgp4Prop joined in).
  Position-only sources (GLONASS SP3, Intelsat ECF, CPF) are fitted from positions alone in their own axes,
  Earth-fixed included, which `analysis/od` refuses. Each standard's record stream goes out with the IngestRequest
  (`PROVIDER_ID supplemental-omm`, `SOURCE_NAME` the provider, `BATCH_ID` the stream's SHA-256) that
  `hostcap/storage-ingest` files it by; `publish_request` turns each stored batch's IngestResult into the
  dataset-publication POST (config `omm_publish_url`; nothing when unset). See [the OD node](nodes/od/README.md).
- **`nodes/status`** keeps the APP status board's counters and emits one canonical `$DSS` per route; `app/` is the
  board, which reads the routes and nothing else.
- **Egress**: `result` (IngestResult), `notice` (FlowNotice: Starlink objects unavailable; OD `fitted`, `unfittable`,
  `fit-failed`), `publication` (HttpResponse).

## Config

The service's node config (`plugin.getConfig`, one block for the flow): `omm_publish_url` (OD), and the sources' own
keys (their READMEs). The legacy flow fetched GLONASS from CODE's ultra-rapid SP3
(`https://www.aiub.unibe.ch/download/CODE/COD0OPSULT.SP3`); `glonass-source` defaults to the IAC's `ftp://` product,
which an HTTP connector cannot fetch, so the service sets `sourceUrl`. `iss-source` reads the same key, and
`intelsat-source` and `cpf-source` share `listingUrl` and `target`: one block cannot configure them apart.

## Build, release, test

```sh
WASI_SDK_PATH=<wasi-sdk 30> npm run build     # nodes/od and nodes/status, unsigned (nodes/od/build.mjs says why wasi-sdk)
npm run check                                # the SDK's flow check
SUPPLEMENTAL_OMM_SIGNING_SEED_HEX=<seed> SUPPLEMENTAL_OMM_SIGNING_KEY_ID=<id> NODE_ENV=production npm run release
npm test
```

`node_modules` holds `space-data-module-sdk` (0.9.3), `spacedatastandards.org` (1.249.0) and `flatbuffers`; the
standards root for validation is `SPACE_DATA_STANDARDS_ROOT`, else that package.

`scripts/release.mjs` is the release: it takes every child UNSIGNED from its package (deps.json), compiles its WasmEdge
universal-AOT section (production: WasmEdge at the SDK's pin, `scripts/compile-universal-aot.sh`), signs it with the
release key, compiles `flow.json` with every node an isomorphic child bound by SHA-256 to its signed artifact, and
signs the single-file bundle (`dist/isomorphic/module.wasm`) with the same key. The key is only ever in the
environment (`nodes/signing.mjs`); the tests build the release with a key they generate and throw away.

The tests run the built artifacts end to end: the release in the SDK's isomorphic flow host on the source modules'
provider fixtures (`tests/flow.test.mjs`), the OD and status nodes in the browser module harness. The stored records
are the OD node's release records (`nodes/od/release-records`) for the same provider input, byte for byte.
