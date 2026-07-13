# Aerospace IVV dataset — acquisition & one-command real-dataset replay (A2.8b)

The Aerospace lane gate (`tests/aerospaceScreenCatalogParity.test.mjs`) runs in
**SYNTHETIC** mode by default (checked-in analytic fixture,
`tests/fixtures/aerospace-synthetic/`). It automatically switches to **REAL**
mode when the genuine dataset is present locally. This document is the
one-command path to obtain the real dataset and run the real gate.

## OWNER-ASSIST — why this is not automated

The real dataset (`AerospaceIVVDataset_20251009a`, the TraCSS "Dataset for
Conjunction Assessment Verification", authored by The Aerospace Corporation,
**CC0-1.0**) is:

- **~21.74 GB** (the OCM input tarball alone) — far beyond repo size norms; it
  is never checked in. `tests/data/*` is git-ignored precisely for this.
- **Gated behind a Google account / OSC contact.** The four data files are
  Google Drive links reached from the landing page; access is requested via a
  Google Form or by emailing `Anna.Parikka@noaa.gov`. There is no anonymous
  direct-download URL, so acquisition requires a human with a Google account.

Verified reachability from this environment (2026-07-13): the landing page
`space.commerce.gov` responds **200**, but the Drive files require auth, and
`celestrak.org` is **unreachable (000)**. So the harness ships against the
labeled synthetic fixture; a human runs the real dataset once.

## Source URLs (captured 2026-07-13)

- Landing page:
  `https://space.commerce.gov/dataset-for-conjunction-assessment-verification/`
- Announcement:
  `https://space.commerce.gov/tracss-publishes-dataset-for-conjunction-assessment-verification/`
- User's Guide (public, direct):
  `https://space.commerce.gov/wp-content/uploads/2026/03/Conjunction_Screening_Testset_Users_Guide.pdf`
- Data files (Google Drive, account-gated — map each to a filename after
  download; the Guide's Table 1 lists sizes):
  - `https://drive.google.com/file/d/1QLjBGW74ea3T1p6aeE0iiz_oGNJ_dBZO/view`
  - `https://drive.google.com/file/d/1rN6sqE4kjNV-bwGeoZVoSdBxwcURshiN/view`
  - `https://drive.google.com/file/d/1TZfLyUVtkk_7KnvFS2Aadem1juRHtIpV/view`
  - `https://drive.google.com/file/d/1vMg6g06sIDCIjA1IK88firQZbLsR5s0h/view`
- Access request form:
  `https://docs.google.com/forms/d/e/1FAIpQLSehlXqyP0xQydv26xgurEVHjBl99lZZ5jFTI96z54a7AzLErQ/viewform`

The four downloads (per the Guide, Table 1) are:
`AerospaceIVVDataset_20251009a.tar.gz` (21.74 GB, CCSDS OCM ephemeris),
`IVV_Releasable_Dataset_Spherical_DefaultHBR.csv.gz` (204 MB, CSieve answer key,
10 km spherical / default 0.5 m HBR),
`IVV_Releasable_Dataset_SFSH_DiscreteHBR.csv.gz` (144 MB, SFSH rectangular),
`AerospaceIVVDataset_20251009a_Size_ScreeningVolumes.csv.gz` (145 KB, per-object
HBR + UVW volumes).

## One-command replay (after acquiring the files)

1. Place downloads and extract exactly where the harness looks (see
   `tests/data/README.md`):

   ```sh
   # from analysis/conjunction-assessment/
   mkdir -p tests/data/aerospace-archives tests/data/aerospace-ivv/csv tests/data/aerospace-ivv/ocm
   #  ... copy the 4 downloads into tests/data/aerospace-archives/ ...
   gunzip -k tests/data/aerospace-archives/IVV_Releasable_Dataset_Spherical_DefaultHBR.csv.gz \
     -c > tests/data/aerospace-ivv/csv/IVV_Releasable_Dataset_Spherical_DefaultHBR.csv
   tar -xzf tests/data/aerospace-archives/AerospaceIVVDataset_20251009a.tar.gz \
     -C tests/data/aerospace-ivv/ocm
   ```

   Or override the roots via env (`AEROSPACE_IVV_EXTRACTED_ROOT`,
   `CONJUNCTION_AEROSPACE_IVV_EXTRACTED_ROOT`) — see
   `getDefaultAerospaceReplayPaths` in `tests/lib/aerospaceReplayHarness.mjs`.

2. Run the same gate — it auto-detects the real dataset and switches to REAL
   mode (trims to a representative window of `AEROSPACE_PARITY_LIMIT` answer-key
   rows, default 150):

   ```sh
   node --test tests/aerospaceScreenCatalogParity.test.mjs
   # widen the window: AEROSPACE_PARITY_LIMIT=2000 node --test tests/aerospaceScreenCatalogParity.test.mjs
   ```

## Gate semantics (identical to synthetic mode)

- **Event-set recall** — every sampled CSieve event must be reproduced (hard
  fail on a miss). Precision extras in the trimmed catalog are advisory (no full
  ground truth for the sample), not a fail.
- **TCA** — rel-vel stratified; NLRV (≥50 m/s) hard-gated ≤10 ms; LRV/VLRV
  recorded but not gated (flat-minimum time is ill-defined — AMOS de-emphasizes
  it).
- **Miss distance** — ≤10 cm hard fail (CSieve reports full precision; AMOS
  measured max 6.8 cm / avg 2.8 mm between two passing tools).
- **Pc** — NOT gated (CSieve uses the Alfano-2004 variant; the User's Guide and
  AMOS 2025 both exclude Pc from CS validation). Report-only.

Tolerances are the single-source-of-truth `tests/lib/caParityTolerances.mjs`.
Ground truth: `docs/a2.8a-ca-parity-ground-truth.md`.

## Note on the two screening rounds

The synthetic fixture uses the **spherical** config (10 km / 0.5 m HBR, Round 1).
The real **SFSH** round (8 rectangular per-object U/V/W volumes,
`IVV_Releasable_Dataset_SFSH_DiscreteHBR.csv`) is documented in the tolerance
config (`screening.aerospaceSfsh`) but not yet wired as a second gate — it needs
per-object rectangular screening-volume support in the request path and the
asymmetric A→B ≠ B→A reporting rule. Tracked as an A2.8b follow-up.
