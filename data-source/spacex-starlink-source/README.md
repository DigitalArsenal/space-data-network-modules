# SpaceX Starlink Data Source (WS5)

The first **executable data-source** SDN module and the **provider-adapter
template** (A2.2b). On a TIMERS-driven `pull` it fetches the SpaceX/Starlink
public ephemeris manifest, plans a capped + polite per-object fetch, and for
each object parses the raw MEME ephemeris into a canonical CCSDS **OEM** record,
stores it, signs its content id, and publishes a schema-exact **PNM** pointer —
all through host capabilities.

## Pull flow (`src/spacex_starlink_source.cpp`)

1. **Discover** — GET `.../ephemerides/MANIFEST.txt`; parse to one MEME filename
   per line (`listing_lines`).
2. **Plan (capped)** — take the first `objectCap` entries (default 25).
3. **Per object** — GET `.../ephemerides/<filename>`; on non-200/empty, skip
   that object (halt-friendly, never fails the whole pull).
4. **Canonical record** — parse the MEME header + state vectors into a CCSDS
   **OEM** record (compact row-major format) with schema-exact keys, and
   `storage.write` it under schema `"OEM"`.
5. **Sign + publish** — `keyslot.sign` the stored record's content id (CID) via
   the host-side crypto oracle (the slot's private key never enters guest
   memory), build a schema-exact PNM, and `pubsub.publish` it on
   `sdn/data-source/spacex-starlink`.

## Schema / storage decisions

- **Canonical record = CCSDS `OEM`.** MEME state vectors are operator ephemeris,
  which maps directly onto the OEM compact format (`START_TIME`, `STEP_SIZE`,
  `STATE_VECTOR_SIZE`, `EPHEMERIS_DATA` row-major array). Emitted as a
  schema-exact JSON record (mirroring the OD module's `elements_to_json` OMM
  output), keys per the SDS `OEM` schema
  (`EPHEMERIS_DATA_BLOCK[].{CENTER_NAME, REFERENCE_FRAME, TIME_SYSTEM,
  START_TIME, STOP_TIME, STEP_SIZE, STATE_VECTOR_SIZE, EPHEMERIS_DATA}` +
  `OBJECT_NAME`/`NORAD_CAT_ID`). MEME state vectors are **EME2000**; the `UVW`
  line is the *covariance* frame only, so `REFERENCE_FRAME` = `EME2000` and
  analysis/od rotates the states to TEME before the SGP4 fit. A fit's own RMS
  cannot detect a frame error (it is self-consistent in any frame): labelled
  `TEME`, the fitted GP sat 35-41 km off CelesTrak SupGP scored on the same
  states; labelled `EME2000` it agrees within a few km.
- **The raw MEME text is bound by SHA-256, not mislabeled.** The old adapter
  stored the raw manifest listing bytes under an `"OEM"` label (the A2.1-flagged
  placeholder bug). There is no honest raw-blob SDS type, so the raw MEME source
  artifact is instead hashed (`SOURCE_SHA256`, the DPM "SHA-256 of raw source
  bytes" convention) and carried in the signed provenance sidecar — never stored
  under a data-record schema.
- **`OBJECT_ID` stays empty.** The MEME filename's 4th field is a SpaceX-internal
  id, not an international designator (per A2.2a); `NORAD_CAT_ID` and
  `OBJECT_NAME` come from the filename.
- **PNM is schema-exact.** `MULTIFORMAT_ADDRESS`, `PUBLISH_TIMESTAMP`, `CID`,
  `FILE_NAME`, `FILE_ID`, `SIGNATURE`, `SIGNATURE_TYPE`. `FILE_ID` follows the
  CelesTrak `<source>:<schema>:<key>:<epoch>` partition convention
  (`spacex-starlink:OEM:<NORAD>:<START_TIME>`). The published pubsub message is
  `{"PNM":{…}, "provenance":{…}}` (provenance sidecar mirrors the CelesTrak
  ingest `provenance` object: `SOURCE_NAME`, `SOURCE_URL`, `SOURCE_SHA256`,
  `DATA_SOURCE` = `SpaceX-E`, `RECORD_SCHEMA`, `NORAD_CAT_ID`, `OBJECT_NAME`, …).

## Fetch politeness

This adapter must never hammer `api.starlink.com`.

- **Per-pull object cap** (`objectCap`, default **25**) bounds burst load.
- **Cadence** — the module `timers` block runs `pull` every **6h** (4×/day),
  matching SpaceX's few-times-daily MEME regeneration (verified live: a MEME
  file fetched 2026-07-13 carried `created:` ~20 min before its
  `ephemeris_start`). The old hourly timer over-polled a feed that does not
  change that often. At 25 objects/pull × ~115 KB × 4 pulls/day ≈ **11 MB/day**.
- **`fetchIntervalMs`** (default 2000) is an *advisory* intra-pull pacing hint.
  The WASM guest is synchronous with no clock/sleep, so it does not busy-wait;
  it is echoed in the summary for a host scheduler to honor. Actual load is
  bounded by the object cap × timer cadence.

All three are configurable via the invoke request payload
(`{"objectCap":…, "fetchIntervalMs":…, "manifestUrl":…}`); a binary PIV request
leaves defaults intact.

## Template shape (for A2.2c)

`common/provider_source.hpp` factors the reusable scaffold — base64, in-guest
SHA-256, JSON helpers, the hostcall transport, the `http`/`storage.write`/
`pubsub.publish` cap wrappers, `keyslot_sign`, `listing_lines`, the PNM builder,
and the generic `publish_record` (store → sign CID → build PNM → publish) flow.
Only MEME-specific parsing + the OEM mapping live in the `.cpp`.

**Promotion note (A2.2c, done 2026-07-13):** the scaffold was promoted verbatim
from this module's `src/provider_source.hpp` to the repo-root
`common/provider_source.hpp` (alongside `common/sdm_hostcall_wire.hpp`) when the
first sibling adapters landed (`data-source/oneweb-source`,
`data-source/iss-source`). Each adapter's `build.mjs` already puts `common/` on
its `-I` path (`SDN_COMMON_DIR`), so all three include it by bare name
(`#include "provider_source.hpp"`). No behavior change to this module — same
bytes, same 8 tests.

## Manifest (`plugin-manifest.json`)

`data_source` family; `pull` method; host capabilities `http`, `storage_write`,
`wallet_sign`, `crypto_sign`, `pubsub`; a `starlink-pull` TIMERS entry
(`defaultIntervalMs` 21600000 = 6h) that the provider-agnostic scheduler
(`plugins/manager.go` CronMethodSpec) runs with zero Go changes.

## Build & test

```
SDN_LOCAL_EMSDK_DIR=<repo-local emsdk> node build.mjs   # dist/*.wasm (signed + isomorphic)
node --test test/*.test.mjs                             # ABI/manifest + fixture-driven pull
```

`test/module.test.mjs` instantiates the rebuilt WASM with a mock
`space_data_module_host` bridge that serves the checked-in fixtures
(`test/fixtures/MANIFEST.sample.txt` + trimmed real MEME files, see
`test/fixtures/PROVENANCE.md`) over `http.request`, and asserts: manifest parse
→ capped fetch plan, MEME → canonical OEM record bytes with schema-exact keys,
signed PNM structure, provenance `SOURCE_SHA256` matching an independent hash of
the fixture, and the 404-skip path. No live network is touched by the tests.

## Residuals (handoff)

- **Binary FlatBuffer materialization.** Records are emitted as schema-exact
  JSON (matching the OD module's JSON-record precedent). Producing
  size-prefixed OEM FlatBuffers (`FinishSizePrefixedOEMBuffer`, the CelesTrak
  `celestrak-parser` convention) for full FlatSQL field indexing is an A2.2c/A2.3
  upgrade.
- **Ingest lane + raw archival.** This adapter uses `storage.write` + `pubsub`.
  Graduating to `storage.ingest_with_source` (provenance + raw-artifact archive
  segment, the CelesTrak ingest lane) is the natural A2.3 step; the raw MEME is
  currently anchored by `SOURCE_SHA256` only.
- **Covariance.** The MEME per-state 21-element UVW covariance is parsed-past,
  not carried into the OEM `COVARIANCE_MATRIX_LINES`. Add when a downstream
  consumer needs it.
- **PUBLISH_TIMESTAMP** uses the source ephemeris `created` time (deterministic,
  testable). A host-clock publish time is a production upgrade.
- **OD consumption (A2.3).** The OD module parses raw MEME / CCSDS OEM KVN text,
  not this JSON OEM record; A2.3 wires the fit to consume the source referenced
  by the PNM (`FILE_NAME` + `SOURCE_SHA256`).
