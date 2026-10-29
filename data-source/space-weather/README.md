# Licensed space weather over SDN

The node must include SDN commit `1fd9d3203` (2026-10-14), which delivers the SDK TimerTick to scheduled flows. Build the acceptance node from current `origin/main`; canonical stack component checkouts may be stale. See `tests/VERIFICATION.md` for acceptance evidence.

Tasks `modules-space-weather-source-20261022`, `modules-space-weather-forecast-horizon-20261023`. Five anonymous source pulls run in a scheduled WASM flow: GFZ historical and nowcast indices, NOAA SWPC 45-day Ap/F10.7 forecast, NOAA three-hour Kp forecast, and NOAA SWPC's predicted solar cycle (monthly F10.7). No browser source fetches.

GFZ F10.7/Kp/ap/Ap: CC BY 4.0; GFZ Helmholtz Centre for Geosciences, Matzka et al. (2021), doi:10.1029/2020SW002641; F10.7 from DRAO/Natural Resources Canada. Sunspot numbers are omitted. NOAA SWPC products: public domain, https://www.weather.gov/disclaimer. SET JB2008 indices and CSSI/CelesTrak SW are never retrieved or republished by this module.

## Days

One SPW record per UTC day, none missing, from 40 days before today through 400 days after it. SPW DATE names the source UTC day; F107_OBS is that day's flux (FFM reads the preceding day's record). A day is emitted only with eight Kp values, daily Ap, flux and full centered/trailing averages. If any day through today + 400 cannot be built, or today cannot, the batch is refused and the previous batch stays.

F107_DATA_TYPE says where the day's flux came from:

| Type | Flux | Days |
| --- | --- | --- |
| OBS | GFZ's observed F10.7 (DRAO) | each day GFZ has flux for: through yesterday, and today once GFZ has it |
| PRD | NOAA's 45-day forecast | each later day through the forecast's last day (today + 44 when it starts today) |
| PRM | NOAA's predicted solar cycle | every day after the forecast's last day |

GFZ values take precedence; NOAA fills what GFZ lacks. Missing three-hour ap is -1.

The predicted cycle gives one F10.7 per month. Each value stands at the month's midpoint; a day's flux is linear in time between the two midpoints around noon of that day. Months must be consecutive and cover every day through today + 440, or the batch is refused.

CENTER81 is the mean of F10.7 over exactly 40 days either side of the day, LAST81 over the 80 days before it and the day itself. Both run over the one series (OBS, then PRD, then PRM) and never over padding. F107_ADJ_CENTER81 and F107_ADJ_LAST81 are -1 when any day in the window has no GFZ adjusted flux, as for every forecast day.

## Values past the sources

- Ap on each day after the 45-day forecast's last day is the mean of GFZ's daily Ap over the 365 days before today, rounded; every one of those days must be in GFZ's files or the batch is refused. Lineage `ap-climatology-gfz-365d`.
- NOAA's Kp forecast ends about two days out. A day after today without all eight Kp from GFZ and NOAA gets all eight from its daily Ap: the Kp (in thirds, times ten, as GFZ's files round them) whose standard Kp-ap table entry is nearest to the Ap, a tie going to the lower Kp; AP1 to AP8 equal the Ap. The table is 0, 2, 3, 4, 5, 6, 7, 9, 12, 15, 18, 22, 27, 32, 39, 48, 56, 67, 80, 94, 111, 132, 154, 179, 207, 236, 300, 400 for Kp 0o to 9o; the E2E holds it to every Kp/ap pair of GFZ's file since 1932. Lineage `kp-derived-from-ap`. FFM rejects a row set with a Kp outside 0 to 9, so no Kp is left unknown.

## The join

NOAA's 45-day forecast and the predicted cycle are separate products and meet without a blend, so the series steps where PRD ends: on 2026-10-29 the last PRD day, 2026-12-12 (+44), is 80.0 sfu and the first PRM day, 2026-12-13 (+45), is 125.8 sfu. The CENTER81 of the days before the join already averages in PRM days: 96.6 sfu today, 104.2 at +44, 123.6 at +100. Observed monthly means of F10.7 against the predicted cycle's value for the month: April 120.0/133.4 = 0.90, May 125.8/132.7 = 0.95, June 138.6/131.7 = 1.05, July 136.2/129.0 = 1.06, August 116.4/126.9 = 0.92, September 106.5/125.7 = 0.85, October (to the 28th) 111.1/125.9 = 0.88. Every PRM day carries PRM in F107_DATA_TYPE, and every day whose CENTER81 reaches a PRM day carries `noaa-swpc-predicted-cycle` in its lineage.

## Provenance and publication

Publication: SPW.fbs / provider `space-weather` / source `gfz-noaa`; source URLs, source-content hashes, license and attribution carried in the signed lane manifest. Every record carries a PVN: SOURCE_ID `gfz-noaa`, SOURCE_KIND Observation (SDS has no forecast kind; F107_DATA_TYPE and the lineage say what is forecast), PRODUCER `space-weather/0.3.0`, and LINEAGE `gfz-kp-ap;drao-f107;noaa-swpc`, then `noaa-swpc-predicted-cycle`, `ap-climatology-gfz-365d` and `kp-derived-from-ap` where they apply, then `canonical-source-batch-sha256=<hash of the five source bodies>`. The batch is about 815 bytes a day (359 KB for 441 days), one shard under the lane's 1 MiB limit.

The batch's ingest metadata is bounded by the node's `storage.ingest` operation: citation 255 bytes, license 128, source and license URLs 255, provider, source name and batch id 128, schema 64. A longer value makes the node refuse the batch with nothing landed and no error in the flow. The citation is 244 bytes and a compile-time check holds it to 255; the horizon E2E checks every field.

FFM never reads F107_DATA_TYPE. It needs a row for every day of an arc and the day before it, F10.7 and CENTER81 positive, Ap not negative and eight Kp in 0 to 9 on every row.

## Build and acceptance

Build: `npm ci && npm run build` in this directory. Acceptance of the horizon: `node data-source/space-weather/tests/forecast-horizon.e2e.mjs` from modules root (network; `npm ci` here and in `propagator/ffm`). It holds every published record to an independent reading of the five live sources, checks the PRD and PRM horizon, the refusals, and that FFM flies 7-, 30- and 365-day arcs on the rows and refuses the same rows cut at today + 2. Acceptance of the node path: `node data-source/space-weather/tests/space-weather.e2e.mjs` from modules root, with `SDN_NODE_BINARY` naming a freshly built native daemon, `SDN_JS` its built client checkout, and WasmEdge 0.16.4 on `PATH`. It checks real headless-browser/native byte parity, live sources, an isolated native node and binary SDN CID readback. Docker parity is waived by the owner (2026-10-22).
