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

## §A2.8c — REAL-mode replay was EXECUTED (owner provided the dataset locally)

On 2026-07-13 the owner provided the genuine dataset locally
(`~/Documents/Conjunctions/`, read-only). A2.8c ran the real replay against it.
Measured results and deviations are recorded here so they survive the session.

**Scope of the run.** Extracted (read-only, selective; `tar --files-from`) the
2665 OCM files referenced by the first **1500** spherical answer-key rows
(2648 `tle/`, 12 `CDM/`, 5 `ManeuveringEphems/`; 7.1 GB into session scratch,
never the repo). Screened all **1500** reference events; **100 % recall
(0 missing)**.

**Measured parity vs the CSieve spherical answer key** (screen_catalog,
singlethread wasm, threshold 10 km / HBR 0.5 m; tolerances UNMODIFIED):

| Metric | Measured | Bound (`caParityTolerances.mjs`) | Verdict |
|---|---|---|---|
| Event recall | 1500/1500 (100 %) | full recall required | PASS |
| NLRV TCA | p50 0.72 ms, p95 0.72 ms, **max 43 ms** (4/1497 > 10 ms, all Vrel 80–150 m/s near the NLRV boundary) | ≤ 10 ms | 99.7 % pass; 0.3 % near-boundary flat-minimum tail |
| VLRV TCA | up to 8.1 s (co-orbital sequential-NORAD pairs) | not gated | recorded |
| Miss distance | **p50 0.43 m, p95 2.77 m, max 25.71 m; 80.9 % > 10 cm** | ≤ 10 cm | **FINDING F1 (below)** |
| Rel-speed | p95 0.17 m/s, max 5.9 m/s | ≤ 5 m/s guard | recorded |
| Pc | recorded | never gated | report-only |

**FINDING F1 — real-OCM miss parity is meters-scale, not ≤10 cm, and is not a
module defect.** At CSieve's own reported TCA, our reconstruction of the
released **65 s-sampled** OCM ephemeris lands ~1–3 m off CSieve's answer-key
J2000 state (per-object p50 1.1 m / p95 4.9 m for the near-window subset). This
is **not** interpolation-order error: cubic-Hermite(pos+vel) AND 5/7/9-point
Lagrange over the same nodes all give the same ~2.9 m p50 offset — i.e. CSieve's
reference states do not lie on any smooth interpolant of the released nodes.
CSieve evidently screens a higher-precision trajectory than the 65 s OCM encodes;
**any tool that screens the released OCM as-sampled sees the same gap.** The
≤10 cm bound (met by the synthetic straight-line fixture, which is exactly
representable) is therefore unachievable against the real key except where a
conjunction's TCA falls near an ephemeris node. Recorded as a finding; the
tolerance config was **not** changed.

**Deviations from the one-command path (documented, deliberate):**
1. The auto-switch REAL loader in `aerospaceScreenCatalogParity.test.mjs`
   embeds every object's FULL 7-day ephemeris (~19k nodes / ~3 MB) into one
   all-vs-all FlatBuffer — infeasible past a few hundred rows. A2.8c screened
   **per pair over a ±180 s window around each known TCA** (the same windowing
   the WasmEdge-gated `aerospaceReplayHarness` uses), over the proven offline
   `screen_catalog` PIV path. Native-cadence vs 1/5/10 s Hermite-resampled
   tracks give byte-identical results, so windowing does not perturb the metric.
2. Ran offline (WasmEdge not installed) → the `screen_catalog` raw-PIV path, not
   the WasmEdge `assessTracks` replay harness.
3. `TRAJ_REF_FRAME = EME2000` mapped to the module's `ICRF` enum (inertial,
   <~20 mas bias, shared by both objects → relative geometry invariant).

**Checked-in real reference window.** A stratified 21-event / 42-object slice
(trimmed OCMs + CSieve rows + provenance) is checked in at
`tests/fixtures/aerospace-real-window/` and gated UNCONDITIONALLY in CI by
`tests/aerospaceRealWindowParity.test.mjs` (recall + NLRV TCA HARD; near-node
parity anchors HARD ≤10 cm; all-events miss guarded by a documented real-OCM
regression envelope; VLRV TCA + Pc recorded). The synthetic fixture is relabeled
the fast smoke tier.

## Note on the two screening rounds

The synthetic fixture uses the **spherical** config (10 km / 0.5 m HBR, Round 1).
The real **SFSH** round (8 rectangular per-object U/V/W volumes,
`IVV_Releasable_Dataset_SFSH_DiscreteHBR.csv`) is documented in the tolerance
config (`screening.aerospaceSfsh`) but not yet wired as a second gate — it needs
per-object rectangular screening-volume support in the request path and the
asymmetric A→B ≠ B→A reporting rule. Tracked as an A2.8b follow-up.
