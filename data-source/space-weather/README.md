# Licensed space weather over SDN

**WIP: blocked on the SDN cron ingress contract.** The module source comparison passes, but the local node sends an untyped JSON timer frame; the typed flow never starts and publishes nothing. This is not a deployable acceptance result. See `tests/VERIFICATION.md`.

Task `modules-space-weather-source-20261022`. Four anonymous source pulls run in a scheduled WASM flow: GFZ historical and nowcast indices, NOAA SWPC 45-day Ap/F10.7 forecast, and NOAA three-hour Kp forecast. No browser source fetches.

GFZ F10.7/Kp/ap/Ap: CC BY 4.0; GFZ Helmholtz Centre for Geosciences, Matzka et al. (2021), doi:10.1029/2020SW002641; F10.7 from DRAO/Natural Resources Canada. Sunspot numbers are omitted. NOAA SWPC products: public domain, https://www.weather.gov/disclaimer. SET JB2008 indices and CSSI/CelesTrak SW are never retrieved or republished by this module.

SPW DATE names the source UTC day; F107_OBS is that day's flux (FFM reads the preceding day's record). CENTER81 uses exactly 40 days either side, observed where available and forecast otherwise, without padding. GFZ values take precedence; NOAA supplies missing current/future flux, daily Ap and Kp. Missing three-hour ap remains -1. A day is emitted only with eight Kp values, daily Ap, flux and full centred/trailing averages. F107_DATA_TYPE identifies the daily flux as OBS or PRD; the publication documents mixed forecast averages.

Publication: SPW.fbs / provider `space-weather` / source `gfz-noaa`; source URLs, source-content hashes, license and attribution carried in the signed lane manifest. Per-record PVN follows upstream SDS (coordinator scope split 2026-10-22).

Build: `npm ci && npm run build` in this directory. Acceptance: `node data-source/space-weather/tests/space-weather.e2e.mjs` from modules root (live sources, isolated native node, CID readback). No completion claim until that E2E and the graph gauntlet pass.
