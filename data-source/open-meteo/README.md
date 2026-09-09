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

The core has no host calls and is tested with identical input/output bytes in a browser, native WasmEdge and Docker WasmEdge. The adapter requires an SDK host that supplies `plugin.getConfig`; its configuration and unchanged-response gates are tested with a host stub. The compiled graph is exercised through simulated HTTP and storage calls, including the next refresh on the same instance after failed or skipped cycles. A native Go-host test also stores and paginates 192 records in a temporary FlatSQL database, verifies producer/licence carriage and replacement after failed refreshes, and checks the exact auto-publisher notification. No fixture is published as live weather.

## SDN integration

The stack's `deployment/open-meteo/build-flow.mjs` composes the two modules with the existing `hostcap/http-request` and `hostcap/storage-ingest` sources. It builds compatible WASI link objects in the output directory. Existing transport packages and thread models remain unchanged. Flow compilation requires SDK 0.8.19 or later because older versions incorrectly classify all-sequential WASI flows as threaded.

The flow performs: timer → request plan → HTTP → host receipt → binary normalization → attributed storage. The parser hashes the original response body as the batch ID. Weather records cross the storage boundary as binary segments.

Configure SDN's existing `publishing.auto_publish` lane for `schema: WXF.fbs`, `provider_id: open-meteo` and the configured source name (for example `forecast/52.52,13.41`). Successful storage notifies the daemon's publisher, which exports, pins, signs and announces the dataset. This keeps publication out of the weather module and uses the daemon's duplicate suppression, rate limits, bounded queue and retry policy. See the stack's `publishing.example.yaml`.

Module configuration uses `open_meteo_enabled`, `open_meteo_forecast`, and `open_meteo_producer_peer_id`. See the disabled `node-config.example.json`. Set the producer ID from the actual daemon identity. Forecast length is 1–16 days; one to eight supported variables can be selected. Fetch failures retry on the next hourly cycle; the last successful dataset remains available.

## Access and release status

[Open-Meteo's terms](https://open-meteo.com/en/terms) distinguish the CC BY 4.0 data licence from API access. The free endpoint is for noncommercial use. Live fetching is disabled until the operator selects an appropriate access tier. The portable planner can construct a customer endpoint request without putting credentials into attribution; scheduled customer fetching still needs a credential adapter and is refused rather than sent without credentials. Marine, air-quality, historical and ensemble APIs are outside this initial weather-forecast module.

SDS's legacy PyPI-version publication problem remains tracked separately. It does not change the verified npm/C++ input used for this module; it must not be reported as a successful Python release. No new node, live forecast feed or public demo is claimed by this source package alone.
