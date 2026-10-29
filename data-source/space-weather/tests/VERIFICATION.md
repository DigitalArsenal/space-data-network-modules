# Acceptance status, 2026-10-29

Module 0.3.0 and flow 0.2.0 (`modules-space-weather-forecast-horizon-20261023`), built on SDK 0.9.12 and SDS 1.261.0. Portable module SHA-256 `74517789dd72666c150ff50a92e74f4ee3e48a49d010757f9ca5a5a1bf397d9f`; flow `runtime.wasm` SHA-256 `971bf56881eca92abfb6833fce5c4ce81bb8bf1990ba0d00bd6ea0f59a4784ee`.

`node data-source/space-weather/tests/forecast-horizon.e2e.mjs` PASS on the live sources of 2026-10-29:
- 441 days, 2026-09-19 to 2027-12-03: OBS 40, PRD 45 (to 2026-12-12), PRM 356 (to today + 400). Every record equals an independent reading of the five sources: flux, type, Ap, Kp, three-hour ap, both 81-day averages, the adjusted averages, lineage and PVN.
- An empty predicted cycle, one that ends before the horizon, and a corrupt GFZ body are each refused, and nothing is published.
- FFM flew a 7-day and a 30-day arc in a 400 km orbit and a 365-day arc at 700 km on those rows. The same rows cut at today + 2, the horizon before this change, gave `space-weather-out-of-range` for the 7-day arc.

Before the behavior change, `parse_weather` was split into `readSources`, `assemble`, `publishable` and `publish`. On captured GFZ and NOAA bodies at a fixed retrieval time, the previous and the split builds gave byte-identical records (SHA-256 `f3e53e0d...`, 43 days), meta and report, and the same refusals for a corrupt GFZ body, a corrupt Kp forecast and a truncated 45-day forecast.

Chromium headless shell and native WasmEdge 0.16.4 give byte-identical outputs for `plan_weather`, `parse_weather` on the live sources, and the refused case. A native SDN node built from SDN `4c18b5308` (WasmEdge 0.16.4) AOT-prewarmed the flow `runtime.wasm` with `prewarm-aot`.

`tests/space-weather.e2e.mjs` (the isolated native node with signing, AOT prewarm and binary SDN CID readback) expects five sources and the same oracle.

The rollout scripts, backup and live CID-check procedure are in stack `deployment/space-weather-provider-node`. No production SSH, installation or restart occurred.
