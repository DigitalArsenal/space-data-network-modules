# Licensed space weather over SDN

The node must include SDN commit `1fd9d3203` (2026-10-14), which delivers the SDK TimerTick to scheduled flows. Build the acceptance node from current `origin/main`; canonical stack component checkouts may be stale. See `tests/VERIFICATION.md` for acceptance evidence.

Task `modules-space-weather-source-20261022`. Four anonymous source pulls run in a scheduled WASM flow: GFZ historical and nowcast indices, NOAA SWPC 45-day Ap/F10.7 forecast, and NOAA three-hour Kp forecast. No browser source fetches.

GFZ F10.7/Kp/ap/Ap: CC BY 4.0; GFZ Helmholtz Centre for Geosciences, Matzka et al. (2021), doi:10.1029/2020SW002641; F10.7 from DRAO/Natural Resources Canada. Sunspot numbers are omitted. NOAA SWPC products: public domain, https://www.weather.gov/disclaimer. SET JB2008 indices and CSSI/CelesTrak SW are never retrieved or republished by this module.

SPW DATE names the source UTC day; F107_OBS is that day's flux (FFM reads the preceding day's record). CENTER81 uses exactly 40 days either side, observed where available and forecast otherwise, without padding. GFZ values take precedence; NOAA supplies missing current/future flux, daily Ap and Kp. Missing three-hour ap remains -1. A day is emitted only with eight Kp values, daily Ap, flux and full centred/trailing averages. F107_DATA_TYPE identifies the daily flux as OBS or PRD; the publication documents mixed forecast averages.

Publication: SPW.fbs / provider `space-weather` / source `gfz-noaa`; source URLs, source-content hashes, license and attribution carried in the signed lane manifest. Per-record PVN follows upstream SDS (coordinator scope split 2026-10-22).

Build: `npm ci && npm run build` in this directory. Acceptance: `node data-source/space-weather/tests/space-weather.e2e.mjs` from modules root, with `SDN_NODE_BINARY` naming a freshly built native daemon, `SDN_JS` its built client checkout, and WasmEdge 0.16.4 on `PATH`. It checks real headless-browser/native byte parity, live sources, an isolated native node and binary SDN CID readback. Docker parity is waived by the owner (2026-10-22). No completion claim until that E2E and the graph gauntlet pass.
