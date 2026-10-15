# Intelsat (public ephemeris) Data Source (A2.2c-2)

Typed contracts 1.0 (FlatBuffers only, no JSON, no base64). The module fetches and stores nothing itself: it is a
pure request-and-parse node beside `hostcap/http-request`, and its `$OEM` output is consumed in memory by
`analysis/od` (`fit`), never stored, signed or published.

## Flow (`src/intelsat_source.cpp`)

| Method | In | Out |
| --- | --- | --- |
| `request` | `tick`: `TimerTick` (TICK; fields not read) | `request`: one GET `HttpRequest` (HREQ) for the public MyIntelsat ephemeris listing |
| `select_file` | `listing`: the listing's `HttpResponse` (HRSP) | `request`: one GET `HttpRequest` for the newest file of the target |
| `emit` | `response`: the file's `HttpResponse` (HRSP) | `oem`: one $OEM (position-only, ECEF/UTC as declared, metres to km, NORAD 0) |

Node config through `plugin.getConfig` (sdm_piv, one `ModuleConfig` read in place; the module's only hostcall):
`listingUrl`, `ephemerisBase`, `target`. Capabilities: none. A transport error, a status other than 200, an empty body, a listing without the target's file
or a file with nothing fittable fails closed (`fetch-failed` / `fetch-empty`); nothing partial is emitted. The flow's
trigger sets the cadence (the former module timer's cadence is noted in the manifest).

The former `pull` method (JSON hostcalls; it declared a signed `$PNM` output but only ever returned the in-memory `$OEM`
stream) and the hand-built guest-link (`guest-link/emit_entry.cpp`, `manifest.js`) are gone: the SDK compiler builds the
module and its guest-link object (`dist/guest-link/`). `test/module.test.mjs` runs the methods in the SDK browser harness
on the fixtures and checks the `$OEM` bytes against the legacy artifact's (`test/fixtures/legacy/oem-stream.bin`).

## Which Intelsat product? ECF (state vectors), not 11-Parameter

Intelsat publishes several products under CelesTrak's `Intelsat-11P` token; only
one is a true state-vector ephemeris:

| category | file kind | what it is | adapter |
|----------|-----------|------------|---------|
| `_e_` | **ECF** | position table (X/Y/Z metres, Earth-fixed) | **ingested → OEM** |
| `_w_` / `_x_` | Weekly / Weekly-prev **11-Parameter** | telex-wrapped GEO longitude/latitude drift-libration model (LM0/LM1/LM2, LONC.., LATC..) — NOT a state vector | documented residual |
| `_m_` | Maneuver | same 11-parameter telex format, irregular epoch | documented residual |
| `_c_` | Center-of-Box | station-keeping polygon entry/exit **event log** | documented residual |

The "11-parameter" model (per IESS-412) is a compact geostationary
drift/libration representation; converting it to a Cartesian state vector is a
**physical propagation** — an **OD-owned transform** per A2.2a. This adapter does
**not** do it (fabricating state vectors from the 11-parameter model would violate
the never-fabricate rule). The ECF product is the honest state-vector ephemeris
and the right input for the OD fit / A2.4 parity. (Parser note for a future
11-parameter pass: negative values in the telex carry BOTH a literal `-` sign
AND a redundant `" (MINUS)"` text suffix, and lines are CRLF-terminated.)

## Intelsat / SES reconciliation (A2.1 flag) — VERDICT: INDEPENDENT feeds

The page is branded **"MyIntelsat – SES"** after the 2025 Intelsat/SES
consolidation. Live investigation 2026-07-13 → **treat Intelsat and SES as 2
INDEPENDENT providers** in the 18-provider inventory. Evidence:

1. **Branding is cosmetic (data layer unchanged).** The page is an SES reskin of
   the legacy MyIntelsat portal: logo `logo-ses-myintelsat-white.png`, footer
   links to `ses.com`, but `<title>` is still "Ephemeris | MyIntelsat", support
   is `MyIntelsat.Support@intelsat.com` (Intelsat domain), Terms is a relative
   Intelsat path `/Legal/Index`. (`intelsat.com/…/ephemeris-data` now 301s to a
   `ses.com` path that 404s — an in-progress, incomplete consolidation.)
2. **Fleet is Intelsat-only.** Every satellite in every dropdown is `IS-*`, `G-*`
   (Galaxy), or JV/leased-capacity (`H-2`, `H-3E`/Horizons, `SKYB-1`, `JSAT-RA`).
   **Zero** SES-branded birds (`SES-*`, `ASTRA*`, `O3b*`) appear on
   `my.intelsat.com/ephemeris/public`.
3. **SES runs its own, separate portal.** `extranet.ses.com/Ephemeris/` — a
   distinct domain on Azure Application Gateway (HTTP 502 this session: backend
   down but architecturally separate, not merged into MyIntelsat). The "extranet"
   naming implies restricted access, unlike Intelsat's `/public`.
4. **CelesTrak likely still separates them.** `Intelsat-11P` and `SES-E`/`SES-11P`
   are believed to be distinct SupGP SOURCE tokens — **UNVERIFIED** this session
   (CelesTrak was unreachable; secondary evidence only).

Bottom line: the "MyIntelsat – SES" branding is a marketing/UI merge, **not** a
data-feed merge. SES remains a separate Tier-2 provider (`SES-E`), owner-gated on
its own portal access.

## Schema / frame / time / unit decisions

- **Frame preserved as declared (honest, per A2.2a).** Intelsat "ECF" =
  Earth-Centered-Fixed → `REFERENCE_FRAME: "ECEF"`; the adapter does **NOT**
  transform. The OD side owns the ECEF→TEME transform (A2.2a currently
  fail-closes on ECEF/ITRF — an A2.4/OD residual). `TIME_SYSTEM: "UTC"`,
  `CENTER_NAME: "EARTH"`.
- **Position-only (honest, no fabricated velocity).** ECF has no velocity columns
  → `STATE_VECTOR_SIZE: 3`, `EPHEMERIS_DATA_LINES` of `{EPOCH,X,Y,Z}` only.
- **Units metres → km** (CCSDS OEM canonical unit; lossless scale, recorded
  `SOURCE_UNITS:"m"` / `RECORD_UNITS:"km"`).
- **Honest identity.** The ECF carries NO NORAD and NO international designator —
  `OBJECT_NAME` is the real operator name from the header (e.g. `IS-21`), but
  `NORAD_CAT_ID: 0` and `OBJECT_ID: ""` (neither fabricated). A name→NORAD
  registry mapping is an A2.4 residual (see the reference-draft). Intelsat slot
  metadata (region, longitude, raw header) is preserved in provenance.
- **Raw ECF bound by SHA-256, not mislabeled.**

## Fetch politeness / cadence math

- One listing page + one ECF file per run (ECF ≈ 32 KB; listing ≈ 79 KB).
- **Cadence** — a run (flow trigger) every **24h** (daily). Intelsat regenerates the public
  ephemeris **weekly** (Thu/Fri, epochs Sat/Sun, 7-day validity) plus 1–3
  maneuver messages/month, so a daily poll catches every weekly refresh with
  margin. Configurable via `{"listingUrl":…,"ephemerisBase":…,"target":…}`.
- Live smoke 2026-07-13: `HEAD https://my.intelsat.com/ephemeris/public` → **200**
  (text/html, unauthenticated, Microsoft-IIS). Intelsat is reachable from this
  env (CelesTrak is not).

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

- **A2.4 parity pair.** CelesTrak SupGP (`SOURCE=Intelsat-11P`) same-epoch
  reference not captured (CelesTrak unreachable — timeout). Draft + exact query in
  `test/fixtures/supgp-reference-draft/`.
- **Name → NORAD registry (blocks keyed parity).** The ECF has no NORAD; A2.4 must
  supply the external name→NORAD mapping (IS-21 = NORAD 38098 / COSPAR 2012-043A)
  — a registry concern, not an in-parser fabrication.
- **OD frame prerequisite (blocks the hard gate).** ECF is ECEF; A2.2a's OEM
  parser fail-closes on ECEF/ITRF. A2.4/OD must add the ECEF→TEME (Earth-rotation)
  transform. Position-only fitting also required.
- **GEO conditioning.** IS-21 is geostationary — element-space RAAN/argp are
  ill-conditioned; A2.4 should compare in equinoctial / position space.
- **11-Parameter product not ingested.** The `_w_`/`_x_`/`_m_` 11-parameter files
  (the literal "Intelsat-11P" named product) are a GEO drift model, not state
  vectors; converting them is OD-owned. Documented but not implemented (would need
  the IESS-412 propagation + the `-`/`(MINUS)` CRLF telex parser).
- **Discovery HTML dependency.** Selection parses the listing page's
  `<option value>` filenames; a page-structure change would need the extractor
  updated (it scans for `_<sat>_` + `_e_` filename tokens).
- **Resolved by typed contracts 1.0:** the module emits `$OEM` FlatBuffers that `analysis/od` reads in memory; no JSON record is built.
