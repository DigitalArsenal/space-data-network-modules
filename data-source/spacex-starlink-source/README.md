# SpaceX Starlink Data Source (WS5)

The first **executable data-source** SDN module: on a TIMERS-driven `pull` it
fetches SpaceX/Starlink ephemeris over HTTP, parses + validates it, stores the
records, signs a PNM (Provenance/Notification Message), and publishes it — all
through host capabilities.

## Status (WS5.1)

- ✅ `manifest.js` — module contract: `DATA_SOURCE` family, a `pull` method,
  host capabilities `HTTP` + `STORAGE_WRITE` + `CRYPTO_SIGN` + `PUBSUB`, and a
  `TIMERS` `starlink-pull` entry (hourly default). This is the **first** module
  to declare TIMERS + host capabilities.
- ⏳ C++ ABI skeleton (`src/`) + `build.mjs` + WASM build — next (5.1).
- ⏳ discover/fetch (5.2), store + sign-PNM + publish (5.3), run under the Go
  node cron (5.4).

Dependencies on `com.orbpro.starlink-parser` / `com.orbpro.starlink-validator`
are declared on the PLG publish record + the closed-modules dependency graph
(WS4.1 / WS5.4), not the SDK embedded manifest (which has no dependencies field).

## Build

The module WASM builds with the repo-local emscripten toolchain (see the C++
WASM build recipe: `SDN_LOCAL_EMSDK_DIR`, `FLATBUFFERS_INCLUDE_DIR`,
`SDN_MODULE_SIGNING_KEYPAIR`).
