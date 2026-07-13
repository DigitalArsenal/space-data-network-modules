# ISS (NASA public OEM) Data Source (A2.2c)

A Tier-1 `data_source` adapter on the shared provider template
(`common/provider_source.hpp`, promoted from `spacex-starlink-source` in A2.2c).
On a TIMERS-driven `pull` it fetches the single public NASA ISS ephemeris — a
CCSDS **OEM** KVN file — re-emits it as a schema-exact SDS **OEM** record, stores
it, signs its content id, and publishes a schema-exact **PNM** pointer. This is
the cleanest non-Starlink target: the source is *already* OEM, so the adapter is
a faithful re-serializer, and it exercises the template on a genuinely different
input format (KVN OEM vs Starlink's MEME text).

## Pull flow (`src/iss_source.cpp`)

1. **Fetch** — GET
   `https://nasa-public-data.s3.amazonaws.com/iss-coords/current/ISS_OEM/ISS.OEM_J2K_EPH.txt`
   (one file; single object NORAD 25544; no manifest, no per-object fan-out).
2. **Parse** — the CCSDS OEM KVN header + the (single) META block + explicit-epoch
   state lines (COMMENT / trajectory-event blocks skipped; raw bytes preserved by
   SHA-256 in provenance).
3. **Canonical record** — a schema-exact SDS OEM, `storage.write` under schema
   `OEM`, `keyslot.sign` its CID, `pubsub.publish` a PNM on `sdn/data-source/iss`.

## Schema / frame / time decisions

- **Frame preserved as declared (honest, per A2.2a).** The NASA OEM declares
  `REF_FRAME = EME2000`; the adapter emits `REFERENCE_FRAME: "EME2000"` and does
  **NOT** transform to TEME — the OD side owns the EME2000→TEME transform
  (validated in A2.2a at <1 m fit RMS). `TIME_SYSTEM: "UTC"`, `CENTER_NAME`
  normalized `Earth`→`EARTH`.
- **Real identity.** `OBJECT_NAME: "ISS"`, `OBJECT_ID: "1998-067-A"` (a real
  international designator, unlike Starlink's SpaceX-internal field), and the
  canonical `NORAD_CAT_ID: 25544` (not in the file — constant for the ISS).
- **Verbose OEM format (explicit epochs).** The upstream OEM is **non-uniform**
  in time: mostly 240 s (4-min) steps, but with 58/79/180/223 s steps near
  ascending-node boundaries / reboosts. The adapter therefore emits the SDS OEM
  **verbose** format (`STEP_SIZE = 0` + `EPHEMERIS_DATA_LINES` with an explicit
  `EPOCH` per state), not Starlink's compact row-major array — no reconstruction
  drift, faithful to the source. `META` span fields (`START_TIME`,
  `USEABLE_START_TIME`, `USEABLE_STOP_TIME`, `STOP_TIME`) are preserved.
- **Raw OEM bound by SHA-256, not mislabeled.** The raw source bytes go into
  signed provenance (`SOURCE_SHA256`), never under a data schema.

## Fetch politeness / cadence math

- One file per pull (single GET); no per-object load. Full upstream ≈ 700 KB
  (5403 vectors, 15-day span).
- **Cadence** — `pull` every **12h** (2×/day). NASA refreshes the OEM a few times
  a week, but each file is a *continuous* 15-day ephemeris, so 12h catches every
  refresh with margin: `~700 KB × 2/day ≈ 1.4 MB/day`. Configurable via
  `{"sourceUrl":…}`.

## PNM / provenance

- `FILE_ID` = `iss:OEM:25544:<START_TIME>`. Published message =
  `{"PNM":{…}, "provenance":{…}}`; provenance carries `SOURCE_NAME` `iss`,
  `DATA_SOURCE` `ISS-E`, `RECORD_SCHEMA` `OEM`, `NORAD_CAT_ID`, `OBJECT_ID`,
  `REFERENCE_FRAME`, `CREATION_DATE`, `START_TIME`/`STOP_TIME`, `STATE_COUNT`.

## Build & test

```
SDN_LOCAL_EMSDK_DIR=<repo>/licensing/core/deps/emsdk node build.mjs
node --test test/*.test.mjs
```

`test/module.test.mjs` drives the rebuilt WASM with a mock
`space_data_module_host` bridge serving the trimmed real ISS OEM fixture, and
asserts: KVN parse → verbose OEM record with schema-exact keys, `REFERENCE_FRAME
= EME2000` (not transformed), explicit-epoch lines, signed PNM structure,
provenance `SOURCE_SHA256` binding, `sourceUrl` override, non-200 fail-closed,
and malformed-input fail-closed. No live network is touched.

## Residuals (handoff)

- **A2.4 parity pair.** The CelesTrak SupGP (`SOURCE=ISS-E`) same-epoch reference
  was not captured (CelesTrak `ECONNREFUSED` from this env). Draft + exact query
  in `test/fixtures/supgp-reference-draft/`.
- **Binary FlatBuffer / ingest lane / OD consumption** — same A2.2c/A2.3
  residuals as the Starlink adapter (records are JSON; OD consumes the raw OEM via
  the PNM `FILE_NAME` + `SOURCE_SHA256`, not this JSON record).
