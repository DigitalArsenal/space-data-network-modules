# CPF (ILRS predictions) Data Source (A2.2c-2)

Typed contracts 1.0 (FlatBuffers only, no JSON, no base64). The module fetches and stores nothing itself: it is a
pure request-and-parse node beside `hostcap/http-request`, and its `$OEM` output is consumed in memory by
`analysis/od` (`fit`), never stored, signed or published.

## Flow (`src/cpf_source.cpp`)

| Method | In | Out |
| --- | --- | --- |
| `request` | `tick`: `TimerTick` (TICK; fields not read) | `request`: one GET `HttpRequest` (HREQ) for the EDC CPF v2 directory listing of the target |
| `select_file` | `listing`: the listing's `HttpResponse` (HRSP) | `request`: one GET `HttpRequest` for the newest file of the target |
| `emit` | `response`: the file's `HttpResponse` (HRSP) | `oem`: one $OEM (position-only, the CPF's declared frame, UTC, international designator from the ILRS id) |

Node config through `plugin.getConfig` (sdm_piv, one `ModuleConfig` read in place; the module's only hostcall):
`listingUrl`, `target`. Capabilities: none. A transport error, a status other than 200, an empty body, a listing without the target's file
or a file with nothing fittable fails closed (`fetch-failed` / `fetch-empty`); nothing partial is emitted. The flow's
trigger sets the cadence (the former module timer's cadence is noted in the manifest).

The former `pull` method (JSON hostcalls; it declared a signed `$PNM` output but only ever returned the in-memory `$OEM`
stream) and the hand-built guest-link (`guest-link/emit_entry.cpp`, `manifest.js`) are gone: the SDK compiler builds the
module and its guest-link object (`dist/guest-link/`). `test/module.test.mjs` runs the methods in the SDK browser harness
on the fixtures and checks the `$OEM` bytes against the legacy artifact's (`test/fixtures/legacy/oem-stream.bin`).

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

- One directory listing + one small CPF file per run (LAGEOS-1 CPF ≈ 0.8 MB
  full; the archive is a static file tree).
- **Cadence** — a run (flow trigger) every **12h** (2×/day). ILRS analysis centers regenerate
  CPF predictions daily (some active targets sub-daily), so 12h catches the daily
  regeneration promptly. Configurable via `{"listingUrl":…,"target":…}`.

## Build & test

```
export SPACE_DATA_STANDARDS_ROOT=<spacedatastandards.org checkout>
node build.mjs
node --test test/*.test.mjs
```

`build.mjs` compiles through the SDK (`scripts/lib/build-source-module.mjs`: the SDS `$OEM` headers generated for the
build, `common/oem_fb_builder.hpp`, this module's source). The test drives the methods in the SDK browser harness with
the node config on `plugin.getConfig`, hands the fixtures back as `HttpResponse`s, compares the `$OEM` bytes with the
legacy artifact's and checks the config overrides and the fail-closed cases. No live network is touched.

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
- **Resolved by typed contracts 1.0:** the module emits `$OEM` FlatBuffers that `analysis/od` reads in memory; no JSON record is built.
- **Time helper duplication.** `civil_from_days` / MJD math is duplicated from the
  OneWeb adapter (`common/` is locked by the GNSS worker) — flag for promotion to
  `common/` with the GPS-time helper.
