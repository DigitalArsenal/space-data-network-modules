# CPF (ILRS predictions) Data Source (A2.2c-2)

A Tier-1 `data_source` adapter on the shared provider template
(`common/provider_source.hpp`). On a TIMERS-driven `pull` it discovers the newest
ILRS **Consolidated Prediction Format (CPF v2)** file for a target from an
unauthenticated archive, fetches it, and re-emits it as a schema-exact SDS
**OEM** record with the CPF frame **preserved as declared**, then stores it,
signs its content id, and publishes a schema-exact **PNM** pointer.

## Pull flow (`src/cpf_source.cpp`)

1. **Discover** — GET the per-target CPF directory listing
   (`https://edc.dgfi.tum.de/pub/slr/cpf_predicts_v2/2026/lageos1/`), scan the
   Apache index for `<target>_cpf_…` filenames, select the **newest** (the
   lexically-max filename — embedded `YYMMDD` + sequence sorts chronologically).
2. **Fetch** — GET the selected CPF file (`text/plain`, whitespace-delimited CPF
   v2 records).
3. **Parse** — header `H1`/`H2`/`H5` (terminated by `H9`) + the type-`10`
   position records (stop at the `99` trailer). `00` comments and other record
   types are skipped for the canonical record; raw bytes are preserved by SHA-256
   in provenance.
4. **Canonical record** — a schema-exact SDS OEM, `storage.write` under schema
   `OEM`, `keyslot.sign` its CID, `pubsub.publish` a PNM on `sdn/data-source/cpf`.

## Access: EDC (anonymous), NOT CDDIS (authenticated)

Two archives host ILRS CPF predictions. **CDDIS** (NASA) requires an **Earthdata
Login** — `https://cddis.nasa.gov/archive/slr/cpf_predicts_v2/` silently
redirects to `urs.earthdata.nasa.gov` OAuth (no anonymous access). **EDC**
(EUROLAS Data Center, DGFI-TUM) serves the same predictions over **anonymous
HTTPS** at `https://edc.dgfi.tum.de/pub/slr/cpf_predicts_v2/<year>/<target>/` —
a plain Apache directory index, no login, no cookies, no auth header. The EDC
POST *API* (`/api/v1/`) requires credentials and is **not** used; the anonymous
`/pub/slr/cpf_predicts_v2/` tree is. **This adapter uses EDC.**

- Live smoke 2026-07-13: `HEAD https://edc.dgfi.tum.de/pub/slr/cpf_predicts_v2/2026/lageos1/` → **200** (HTTP/2, unauthenticated). CDDIS redirect-to-Earthdata confirmed separately.

## Schema / frame / time / unit decisions

- **Frame preserved as declared (honest, per A2.2a).** CPF H2 reference-frame
  code `0` = *geocentric true body-fixed* = **ITRF/ECEF** → the adapter emits
  `REFERENCE_FRAME: "ITRF"` and does **NOT** transform. The OD side owns the
  ITRF→TEME transform (A2.2a currently fail-closes on ITRF — the Earth-rotation
  transform is an A2.4/OD residual, see the reference-draft). Frame codes `1`/`2`
  (inertial TOD / J2000) map to `TOD`/`EME2000`; an undocumented code → `UNKNOWN`.
  The raw code is preserved in provenance (`CPF_FRAME_CODE`).
- **Position-only (honest, no fabricated velocity).** CPF type-10 records carry
  X/Y/Z only (velocity record `20` is optional and absent in standard CPF). The
  OEM emits `STATE_VECTOR_SIZE: 3` and `EPHEMERIS_DATA_LINES` of `{EPOCH,X,Y,Z}`
  — velocity is **never** synthesized by differencing.
- **Units metres → km.** CPF positions are metres; the OEM normalises to km (the
  CCSDS OEM canonical unit — a lossless scale, NOT a frame transform). Recorded
  as `SOURCE_UNITS:"m"` / `RECORD_UNITS:"km"` in provenance.
- **Real identity (parsed, not hardcoded).** `NORAD_CAT_ID` from H2 field 3,
  `OBJECT_ID` from the ILRS Satellite ID (H2 field 1) → international designator
  (e.g. `7603901` → `1976-039A`), `OBJECT_NAME` from H1. `ORIGINATOR` = the CPF
  ephemeris-source agency (e.g. `DGF`).
- **Time UTC.** Each record's `(MJD, seconds-of-day)` UTC → ISO 8601; `STEP_SIZE`
  = the declared CPF interval; `TIME_SYSTEM: "UTC"`; `CENTER_NAME: "EARTH"`.
- **Raw CPF bound by SHA-256, not mislabeled.** Raw bytes go into signed
  provenance (`SOURCE_SHA256`), never under a data schema.

## Two prediction products (A2.1 caveat)

The CelesTrak `CPF` SupGP parity (A2.4) is **prediction-vs-prediction**: our OEM
derives from an ILRS CPF *prediction*, and CelesTrak's `CPF` SupGP is itself
CPF-derived — NOT an independent raw-vs-fit gate. Carried into the reference
draft; must not be reported as independent parity.

## Fetch politeness / cadence math

- One directory listing + one small CPF file per pull (LAGEOS-1 CPF ≈ 0.8 MB
  full; the archive is a static file tree).
- **Cadence** — `pull` every **12h** (2×/day). ILRS analysis centers regenerate
  CPF predictions daily (some active targets sub-daily), so 12h catches the daily
  regeneration promptly. Configurable via `{"listingUrl":…,"target":…}`.

## PNM / provenance

- `FILE_ID` = `cpf:OEM:<NORAD>:<START_TIME>`. Published message =
  `{"PNM":{…}, "provenance":{…}}`; provenance carries `SOURCE_NAME` `cpf`,
  `DATA_SOURCE` `CPF`, `RECORD_SCHEMA` `OEM`, `NORAD_CAT_ID`, `OBJECT_ID`,
  `ILRS_SATELLITE_ID`, `CPF_SOURCE_AGENCY`, `CPF_FRAME_CODE`, `REFERENCE_FRAME`,
  `SOURCE_UNITS`/`RECORD_UNITS`, `HAS_VELOCITY:false`, `PRODUCT_KIND:"prediction"`,
  `START_TIME`/`STOP_TIME`, `INTERVAL_SEC`, `POSITION_COUNT`.

## Build & test

```
SDN_LOCAL_EMSDK_DIR=<repo>/licensing/core/deps/emsdk node build.mjs
node --test test/*.test.mjs
```

`test/module.test.mjs` drives the rebuilt WASM with a mock
`space_data_module_host` bridge serving a real EDC directory index + the trimmed
real LAGEOS-1 CPF fixture, and asserts: directory discovery → newest-file
selection, CPF parse → position-only OEM with schema-exact keys, `REFERENCE_FRAME
= ITRF` (not transformed), `STATE_VECTOR_SIZE = 3` with no fabricated velocity
keys, metres→km, real NORAD/COSPAR from H2, signed PNM structure, provenance
`SOURCE_SHA256` binding, `listingUrl`/`target` override, and fail-closed on
failed-listing / 404-file / malformed-CPF. No live network is touched.

Test result: **10/10 pass** against the rebuilt artifact.

## Residuals (handoff)

- **A2.4 parity pair.** The CelesTrak SupGP (`SOURCE=CPF`) same-epoch reference
  was not captured (CelesTrak unreachable — connection timeout from this env).
  Draft + exact query in `test/fixtures/supgp-reference-draft/`. It is a
  prediction-vs-prediction comparison (A2.1 caveat).
- **OD frame prerequisite (blocking the hard gate).** CPF is ITRF; A2.2a's OEM
  parser fail-closes on ITRF. A2.4/OD must add the ITRF→TEME (Earth-rotation)
  transform before the CPF OEM can be fit. Position-only fitting is also required.
- **Discovery HTML dependency.** Selection parses the EDC Apache index; a listing
  format change would need the extractor updated (it scans for `<target>_cpf_`
  filename tokens, robust to relative/absolute hrefs).
- **Frame realization.** CPF declares "geocentric Earth-fixed" but not the ITRF
  realization/epoch; `REFERENCE_FRAME:"ITRF"` is the honest family label, raw code
  preserved in provenance.
- **Binary FlatBuffer / ingest lane / OD consumption** — same A2.2c/A2.3
  residuals as the Starlink/ISS adapters (records are JSON; OD consumes the raw
  CPF via the PNM `FILE_NAME` + `SOURCE_SHA256`, not this JSON record).
- **Time helper duplication.** `civil_from_days` / MJD math is duplicated from the
  OneWeb adapter (`common/` is locked by the GNSS worker) — flag for promotion to
  `common/` with the GPS-time helper.
