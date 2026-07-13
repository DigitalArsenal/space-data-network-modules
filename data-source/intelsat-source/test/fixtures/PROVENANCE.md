# Intelsat adapter test fixtures — provenance

These fixtures drive the offline, mock-host integration test
(`test/module.test.mjs`). No live network is touched by the test.

## `i_aor_e_302.00_is-21_20260710_235300.sample.txt`

A **trimmed** copy of a real Intelsat public **ECF** ephemeris for **IS-21**.

- **Upstream source:** `https://my.intelsat.com/Resource/Ephemeris/i_aor_e_302.00_is-21_20260710_235300.txt`
  (MyIntelsat public ephemeris, **unauthenticated** — no login/cookie/token).
  Retrieved 2026-07-13, `HTTP 200`, `Content-Type: text/plain`, full file 31,750
  bytes / 437 lines (432 data rows, ~9-day span at 30-min steps).
- **Trim:** the header (title + column/units lines) + the first **12 data rows**,
  bytes **verbatim** (CRLF line endings preserved) so the test SHA-256s this
  fixture and matches the adapter's `SOURCE_SHA256` provenance.
- **Filename convention:** `<owner>_<region>_<category>_<longitude>_<sat>_<YYYYMMDD>_<HHMMSS>`
  — `owner` `i`=Intelsat-owned / `n`=non-Intelsat carrying Intelsat capacity;
  `region` aor/apr/iar/ior/por; **`category` `e`=ECF**, `c`=Center-of-Box,
  `m`=Maneuvers, `w`=Weekly, `x`=Weekly-prev. Files are served at
  `/Resource/Ephemeris/<name>.txt` (the listing `<option value>` is the bare name).
- **Format (ECF — a true state-vector table, POSITION-ONLY):**
  ```
  ECF Ephemeris for Intelsat IS-21 / 302.00 deg E /  58.00 deg W
                      UTC       ECF Pos.X       ECF Pos.Y       ECF Pos.Z
                                   meters          meters          meters
  2026/07/10 23:53:00.000      22351147.8     -35753346.9     -8311.65859
  ```
  Columns: UTC `YYYY/MM/DD HH:MM:SS.sss`, X/Y/Z in **metres, ECF
  (Earth-Centered-Fixed)**. No velocity columns.
- **Frame / time / units (as declared, preserved honestly):** `REFERENCE_FRAME:
  "ECEF"` (Intelsat "ECF" = Earth-Centered-Fixed; the adapter does **not**
  transform — the OD side owns the ECEF→TEME transform per A2.2a). `TIME_SYSTEM:
  "UTC"`, `CENTER_NAME: "EARTH"`. Positions normalised **metres → kilometres**
  (`SOURCE_UNITS:"m"` / `RECORD_UNITS:"km"` in provenance).
- **Position-only:** `STATE_VECTOR_SIZE: 3`, `EPHEMERIS_DATA_LINES` of
  `{EPOCH,X,Y,Z}` only. Velocity is **never fabricated**.
- **Identity (honest — the ECF carries no NORAD/COSPAR):** `OBJECT_NAME: "IS-21"`
  (parsed from the header), `NORAD_CAT_ID: 0`, `OBJECT_ID: ""` — neither is
  fabricated. A satellite-name → NORAD registry mapping is an A2.4 residual.

## `ephemeris_public.sample.html`

A small MyIntelsat listing page mirroring the real one (real SES-reskin markup:
`logo-ses-myintelsat-white.png`, `ses.com` footer link, `MyIntelsat.Support@intelsat.com`).
Contains the **real** IS-21 `<option value>` filenames for all 5 categories
(c/e/m/w/x) plus two other satellites' real ECF options (IS-34, IS-23), and one
**older** IS-21 ECF (`…_20260703_235300`) added ONLY to exercise the
newest-among-multiple selection (its file is never fetched). The adapter selects
the newest IS-21 ECF (`_e_` + `_is-21_`, lexically-max date) → the file above,
proving both category filtering (ignores c/m/w/x) and date selection.

## SES reconciliation (recorded here per the A2.1 flag)

The page is branded **"MyIntelsat – SES"** post-2025 consolidation. Verdict from
live investigation 2026-07-13: **INDEPENDENT feeds** (treat Intelsat and SES as 2
providers in the 18-provider inventory). Evidence: (1) branding is cosmetic —
page `<title>` still "Ephemeris | MyIntelsat", support email `@intelsat.com`,
Terms path `/Legal/Index`; (2) fleet on `my.intelsat.com/ephemeris/public` is
**Intelsat-only** — every dropdown satellite ID is `IS-*`/`G-*` or JV/leased
(`H-2`, `H-3E`, `SKYB-1`, `JSAT-RA`); **zero** `SES-*`/`ASTRA*`/`O3b*`; (3) SES
operates its **own separate** portal on distinct infrastructure
(`extranet.ses.com/Ephemeris/`, Azure App Gateway — returned HTTP 502 this
session, i.e. down but architecturally separate, not merged); (4) CelesTrak
likely still lists `Intelsat-11P` and `SES-E`/`SES-11P` as distinct SupGP tokens
(unverified — CelesTrak unreachable this session). No shared satellite IDs
observed between the two feeds. Full detail in `../../README.md`.

## supgp-reference-draft/

A2.4 seed: the CelesTrak SupGP (`sup-gp.php?SOURCE=Intelsat-11P`) same-epoch
reference pair could NOT be captured (CelesTrak unreachable — connection timeout,
matching A2.1). A `provider.json` DRAFT + a README with the exact query are
checked in there for A2.4 to complete.
