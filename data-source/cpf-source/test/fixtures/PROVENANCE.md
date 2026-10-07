# CPF adapter test fixtures — provenance

These fixtures drive the offline, mock-host integration test
(`test/module.test.mjs`). No live network is touched by the test.

## `lageos1_cpf_260713_19402.sample.dgf`

A **trimmed** copy of a real ILRS CPF v2 prediction for **LAGEOS-1**.

- **Upstream source:** `https://edc.dgfi.tum.de/pub/slr/cpf_predicts_v2/2026/lageos1/lageos1_cpf_260713_19402.dgf`
  (EDC / EUROLAS Data Center at DGFI-TUM — the ILRS archive verified to allow
  **anonymous, unauthenticated** HTTPS download; produced by DGFI-TUM, agency
  `DGF`). Retrieved 2026-07-13, `HTTP 200`, `Content-Type: text/plain`,
  `Content-Length: 826801`, full file 10085 lines (header + 10080 position
  records + trailer), MD5 `23212dc4226006b53c75f16757b39708`.
- **Trim:** the full header (`H1`/`H2`/`H5`/`H9`) **verbatim**, then the first
  **12 type-10 position records**, then the real `99` trailer. Bytes are
  verbatim (LF line endings) so the test SHA-256s this fixture and matches the
  adapter's `SOURCE_SHA256` provenance.
- **Format (CPF v2, whitespace-delimited records):**
  - `H1 CPF 2 <src> <yyyy mm dd hh> <seq> <subseq> <target> <notes>`
  - `H2 <ILRS-ID> <SIC> <NORAD> <startYMDHMS> <endYMDHMS> <interval> <compat> <class> <frame> <rotangle> <com> <location>`
    — for this file: ILRS-ID `7603901`, NORAD `8820`, interval `60`s, **frame
    code `0` = geocentric true body-fixed = ITRF/ECEF**, com-correction `0`,
    location `1` (Earth orbit).
  - `H5 <CoM-offset-m>` (optional), `H9` end-of-header.
  - `10 <dirflag> <MJD> <sec-of-day> <leap> <X> <Y> <Z>` — position in
    **metres, geocentric Earth-fixed**. `20`/`30`/… velocity/correction records
    are OPTIONAL and **absent** here (standard CPF is position-only).
  - `99` trailer.
- **Frame / time / units (as declared, preserved honestly):** CPF frame code
  `0` → `REFERENCE_FRAME: "ITRF"` (Earth-fixed; the adapter does **not** transform
  — the OD side owns the ITRF→TEME transform per A2.2a). `TIME_SYSTEM: "UTC"`
  (epochs are MJD + seconds-of-day UTC). `CENTER_NAME: "EARTH"`. Positions are
  normalised **metres → kilometres** (CCSDS OEM canonical unit; a lossless scale,
  recorded as `SOURCE_UNITS:"m"` / `RECORD_UNITS:"km"` in provenance).
- **Position-only:** CPF carries NO velocity → the OEM emits
  `STATE_VECTOR_SIZE: 3` with `EPHEMERIS_DATA_LINES` of `{EPOCH,X,Y,Z}` only.
  Velocity is **never fabricated** (no finite-differencing).
- **Real identity (parsed, not hardcoded):** `NORAD_CAT_ID: 8820` (H2 field 3),
  `OBJECT_ID: "1976-039A"` (ILRS ID `7603901` → international designator),
  `OBJECT_NAME: "lageos1"` (H1). LAGEOS-1 is a permanently-tracked passive
  geodetic retroreflector satellite — always has current CPF predictions.

## `lageos1_cpf_260713_19402.4h.dgf`

A longer trim of the **same** prediction, for the supplemental-OMM OD node's
LAGEOS-1 known answer (`flows/supplemental-omm/tests/od-node-cpf-lageos.test.mjs`).

- **Upstream:** the same URL as above, re-fetched 2026-10-07 (anonymous HTTPS,
  `HTTP 200`, `text/plain`, 826801 bytes, MD5
  `23212dc4226006b53c75f16757b39708`, identical to the 2026-07-13 retrieval).
- **Trim:** the header (`H1`/`H2`/`H5`/`H9`) and the first **241** type-10
  position records verbatim (MJD 61234, 0 to 14400 s: 2026-07-13T00:00 to
  04:00 UTC, 60 s cadence, longer than one 225-minute LAGEOS-1 revolution and
  than the OD node's 192-minute fit window), then the real `99` trailer. The
  first 245 lines are byte for byte the upstream file's; LF line endings.
  SHA-256 `6fd408005b7cc5df80312b56d50fd42f9afd7621d7f64440541d2ffea64a3981`.
- **Reference it is checked against:** CelesTrak's CPF SupGP row
  `LAGEOS1 [DGF]` (element set 194, the same DGF prediction sequence, epoch
  2026-07-13T00:00:00) in
  `analysis/od/tests/data/supgp-reference/cpf/celestrak_supgp_cpf_2026-07-13.csv`.

## `listing.sample.html`

A small Apache-style directory index mirroring EDC's per-target year directory
(`.../cpf_predicts_v2/2026/lageos1/`). Contains three `<a href>` CPF filenames:
an older `.dgf` (260712), a same-day lower-sequence `.hts` (260713_19401), and
the newest `.dgf` (260713_19402 — the file above). The adapter selects the
lexically-max filename (`YYMMDD` + sequence sorts chronologically) → the newest
`.dgf`. The two non-selected hrefs use the real EDC filename convention
(`<target>_cpf_<yymmdd>_<seq><subseq>.<provider-ext>`); only the selected file
has a body served in the test.

## `supgp-reference-draft/`

A2.4 seed: the CelesTrak SupGP (`sup-gp.php?SOURCE=CPF`) same-epoch reference
pair could NOT be captured from this environment (CelesTrak is unreachable —
connection timeout, matching A2.1 / the ISS + OneWeb adapters). A `provider.json`
DRAFT + a README documenting the exact query and the parity plan are checked in
there for A2.4 to complete once CelesTrak is reachable (via the reader proxy A2.1
used). NOTE (A2.1 caveat, carried into the draft): the CPF parity is TWO
PREDICTION products (our CPF-derived OEM vs CelesTrak's CPF SupGP), not
raw-vs-fit.
