# Open-Meteo weather forecasts

SDK module for hourly point forecasts from [Open-Meteo](https://open-meteo.com/en/docs). The portable parser emits size-prefixed **WXF** FlatBuffers. A separate host adapter connects scheduled fetching to SDN's existing HTTP, FlatSQL ingestion and signed IPFS publication services.

One configured location is refreshed hourly. Clients read the node's cached dataset instead of sending their own requests upstream. A successful complete response replaces that location's current source batch. Invalid, failed and HTTP 304 responses leave the previous dataset intact. The response must begin at 00:00 UTC on its retrieval date, as the forecast API specifies; stale editions are rejected.

## Data and units

| API variable | WXF units |
| --- | --- |
| `temperature_2m`, `dew_point_2m` | K |
| `relative_humidity_2m`, `cloud_cover` | Fraction from 0 to 1 |
| `wind_speed_10m` | m/s |
| `pressure_msl`, `surface_pressure` | Pa |
| `precipitation` | Metres of water accumulated over the preceding hour |

Each record is a 1×1 field at the **returned model grid coordinate**, with its UTC valid time, original request URL, retrieval time, producer peer ID and CC BY 4.0 attribution. Missing upstream samples are NaN with an explicit missing count; a real zero remains zero. The `best_match` product can combine models/runs, so initialization time, lead, horizon and ensemble member are not invented. `generationtime_ms` is not used as an epoch.

The WXF additions are in SDS 1.215.0: `TIME_BASIS=ValidTimeOnly`, `LICENSE_CLASS=OpenAttribution`, and `MEMBER_KIND=Unspecified`. Older WXF slots and enum values retain their meanings.

## Build and test

```sh
npm ci --ignore-scripts
npm run build
node host-adapter/build.mjs
SDN_RUN_OPEN_METEO_PARITY=1 npm test
```

The build consumes the C++ header archive from the pinned, published SDS npm package. `SPACE_DATA_STANDARDS_ROOT` is an explicit development override. The core artifact is `dist/isomorphic/module.wasm`; the adapter's artifact is `host-adapter/dist/isomorphic/module.wasm`.

The modules speak the typed contracts (1.0) only: every port names one FlatBuffer type and nothing between modules is JSON (the upstream Open-Meteo body is the one JSON document, parsed in the core). `plan_forecast` takes a `TimerTick`, reads the forecast plan from node CONFIG through the builtin `plugin.getConfig` hostcall (an SDS `$PIV` invocation; one `ModuleConfig` FlatBuffer on raw `config`, read by dotted path such as `open_meteo_forecast.latitude`) and emits one `HttpRequest` whose `CONTEXT` is the plan as one size-prefixed `$WXF` header record (source name, 1x1 requested location, canonical URL, licence, producer peer id). `parse_forecast` takes the `HttpResponse` (the plan echoed in `CONTEXT`, `RETRIEVED_MS` the host's retrieval time), re-derives the plan from its URL and requires it to be canonical, and emits the `$WXF` stream, one `IngestRequest` (reconcile Current) and `FlowNotice` reports; it makes no host call. The adapter gates scheduling on node CONFIG (`TimerTick` forwarded or a `FlowNotice` Skipped) and turns a 304 into a `FlowNotice` Unchanged. Tests run both artifacts through the SDK harness with the typed hostcall, including the adapter -> plan -> HTTP -> receipt -> parse chain. The cross-runtime parity test (`SDN_RUN_OPEN_METEO_PARITY=1`) needs a parity runner that answers the hostcall bridge the core now imports.

## SDN integration

The stack's `deployment/open-meteo/build-flow.mjs` composes the two modules with the existing `hostcap/http-request` and `hostcap/storage-ingest` sources. It builds compatible WASI link objects in the output directory. Existing transport packages and thread models remain unchanged. Flow compilation requires SDK 0.8.19 or later because older versions incorrectly classify all-sequential WASI flows as threaded.

The flow performs: timer → scheduling gate → request plan → HTTP → receipt gate → binary normalization → attributed storage (the parser's `records` stream to storage-ingest's `wxf_records`, its `IngestRequest` to `meta`). The parser hashes the original response body as the batch ID. The stack's flow builder must wire the typed ports (no job or receipt frames remain).

Configure SDN's existing `publishing.auto_publish` lane for `schema: WXF.fbs`, `provider_id: open-meteo` and the configured source name (for example `forecast/52.52,13.41`). Successful storage notifies the daemon's publisher, which exports, pins, signs and announces the dataset. This keeps publication out of the weather module and uses the daemon's duplicate suppression, rate limits, bounded queue and retry policy. See the stack's `publishing.example.yaml`.

Module configuration uses `open_meteo_enabled`, `open_meteo_forecast`, and `open_meteo_producer_peer_id`. See the disabled `node-config.example.json`. Set the producer ID from the actual daemon identity. Forecast length is 1–16 days; one to eight supported variables can be selected. Fetch failures retry on the next hourly cycle; the last successful dataset remains available.

## Access and release status

[Open-Meteo's terms](https://open-meteo.com/en/terms) distinguish the CC BY 4.0 data licence from API access. The free endpoint is for noncommercial use. Live fetching is disabled until the operator selects an appropriate access tier. The portable planner can construct a customer endpoint request without putting credentials into attribution; scheduled customer fetching still needs a credential adapter and is refused rather than sent without credentials. Marine, air-quality, historical and ensemble APIs are outside this initial weather-forecast module.

SDS's legacy PyPI-version publication problem remains tracked separately. It does not change the verified npm/C++ input used for this module; it must not be reported as a successful Python release. No new node, live forecast feed or public demo is claimed by this source package alone.
