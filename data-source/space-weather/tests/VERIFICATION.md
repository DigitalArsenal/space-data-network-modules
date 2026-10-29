# Acceptance status, 2026-10-29

Module 0.3.0 and flow 0.2.0 (`modules-space-weather-forecast-horizon-20261023`), built on SDK 0.9.12 and SDS 1.261.0. Portable module SHA-256 `7abd9f36f0044a9dc3a26a4d57ef7f426834d661a261e25522bfac314b16ff42`; flow `runtime.wasm` SHA-256 `abf54cd3723b6caf03a0a234c9cad7ee3de61f488d9608595995ae27d9c2fcfb`.

`node data-source/space-weather/tests/forecast-horizon.e2e.mjs` PASS on the live sources of 2026-10-29:
- 441 days, 2026-09-19 to 2027-12-03: OBS 40, PRD 45 (to 2026-12-12), PRM 356 (to today + 400); 359,356 bytes. Every record equals an independent reading of the five sources: flux, type, Ap, Kp, three-hour ap, both 81-day averages, the adjusted averages, lineage and PVN.
- The batch's ingest metadata fits every field of the node's `storage.ingest` operation (citation 244 of 255 bytes).
- An empty predicted cycle, one that ends before the horizon, and a corrupt GFZ body are each refused, and nothing is published.
- FFM flew a 7-day and a 30-day arc in a 400 km orbit and a 365-day arc at 700 km on those rows. The same rows cut at today + 2, the horizon before this change, gave `space-weather-out-of-range` for the 7-day arc.

`node data-source/space-weather/tests/space-weather.e2e.mjs` PASS with a native SDN node built from SDN `55517f005` (WasmEdge 0.16.4): the module's 441 days equal the oracle's; Chromium headless shell and native WasmEdge give byte-identical outputs for `plan_weather`, `parse_weather` on the live sources and the refused case; the signed flow installed with AOT prewarm, its first scheduled run landed the batch, and a separate SDN client read the signed manifest and the 359,356-byte shard by CID, 441 days equal to the oracle's reading of the same sources (the shard lists them in the store's order). The CIDs belong to the scratch node and are not persistent.

Before the behavior change, `parse_weather` was split into `readSources`, `assemble`, `publishable` and `publish`. On captured GFZ and NOAA bodies at a fixed retrieval time, the previous and the split builds gave byte-identical records (SHA-256 `f3e53e0d...`, 43 days), meta and report, and the same refusals for a corrupt GFZ body, a corrupt Kp forecast and a truncated 45-day forecast.

The rollout scripts, backup and live CID-check procedure are in stack `deployment/space-weather-provider-node`. No production SSH, installation or restart occurred.
