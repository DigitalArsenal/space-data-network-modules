# REAL Aerospace-IVV parity window (A2.8c)

**This IS real Aerospace / CSieve data** (a trimmed slice), unlike the
`aerospace-synthetic/` smoke fixture. It is the checked-in REAL-DATA parity
window that `tests/aerospaceRealWindowParity.test.mjs` gates on every CI run,
so genuine CSieve parity is exercised without the full 21.74 GB download.

## Provenance

- **Source dataset:** `AerospaceIVVDataset_20251009a` — TraCSS "Dataset for
  Conjunction Assessment Verification", authored by The Aerospace Corporation
  (Auman / Murphy / George), published by NOAA/Office of Space Commerce,
  **CC0-1.0** (no restrictions on use or dissemination).
- **Answer key:** CSieve spherical run — 10 km spherical screening volume,
  default HBR 0.5 m, screening window 2025-01-01T12:00:00Z .. 2025-01-08T12:00:00Z
  (`IVV_Releasable_Dataset_Spherical_DefaultHBR.csv`).
- The full tarball ships an `MD5SUM` manifest; every OCM here was extracted
  read-only from the owner-provided local copy and trimmed verbatim (node
  position/velocity values are byte-for-byte the source values — only whole
  ephemeris rows outside the window and the COV/OD/PHYS blocks were dropped;
  each OCM records its source path + trim in `COMMENT` lines).

## What is in this window

- `answer_key_spherical.csv` — **21** CSieve reference events (full CSieve output
  columns), plus two derived columns: `stratum` (rel-vel bucket) and
  `parity_anchor` (1 = near-ephemeris-node NLRV event that reproduces CSieve
  within the ≤10 cm analytic miss bound). 42 **distinct** objects (no object
  reused across events → clean per-pair screening).
- `ocm/<file>.ocm` — the 42 CCSDS-OCM CARTPV ephemerides, each trimmed to
  ±300 s around its event's CSieve TCA (~9 native ~65 s nodes each). ~150 KB.

### Selection criteria (documented for reproducibility)

Curated from A2.8c's full replay (first 1500 spherical answer-key rows, 100%
recall). Chosen to be a stratified, honest cross-section:
- 18 NLRV events (Vrel 3.0–15.2 km/s → well-conditioned TCA), spread across the
  measured miss-delta range (0.0002 m … 2.544 m);
- 3 VLRV co-orbital pairs (Vrel ≈ 0 → flat-minimum TCA, recorded-not-gated);
- object-range coverage: one CDM-range event (95025) and one maneuvering-
  ephemeris event (90124) in addition to the TLE catalog range.
- Regenerate: re-run the A2.8c replay + `build_fixture.mjs` (in the worker
  report) against the extracted dataset.

## Gate posture (tolerances in `tests/lib/caParityTolerances.mjs` UNMODIFIED)

| Axis | Posture | Result on this window |
|---|---|---|
| Event-set recall | **HARD** | 21/21 reproduced, 0 missing |
| NLRV TCA | **HARD** (`T.tca.NLRV.hardFailSec` = 10 ms) | max 1.1 ms — passes |
| Miss — parity anchors | **HARD** (`T.missDistance.aerospaceHardFailM` = 10 cm) | 4 anchors ≤ 6.2 cm — passes |
| Miss — all events | REGRESSION envelope (5.0 m, test-local, **not** a tolerance-config value) | max 2.544 m — passes |
| VLRV/LRV TCA | recorded, not gated (flat-minimum) | up to 8.1 s (co-orbital) |
| Pc | report-only, never gated | recorded |

## FINDING F1 — real-OCM miss parity is meters-scale, not ≤10 cm

Against CSieve's **full-precision** answer key, our `screen_catalog` reproduces
the **event set (100 % recall)** and **TCA** (sub-ms typical; NLRV > 10 ms only
0.3 % of the full 1500-row run, all near the 50 m/s boundary) — but the
**miss-distance** delta on the released **65 s-sampled** OCM ephemeris is
**~0.4 m median / meters tail** (full-run p50 0.43 m, p95 2.77 m, max 25.71 m;
worst cases are maneuvering-ephemeris pairs). Root cause (measured, not
inferred): CSieve's reported J2000 states at TCA do **not** lie on any smooth
interpolant of the 65 s OCM nodes — cubic-Hermite AND 5/7/9-point Lagrange
reconstruction all land ~1–3 m off the answer-key state, so this is a
**data-representation limit of the released OCM sampling vs CSieve's internal
higher-precision reference**, affecting any tool that screens the released OCM —
**not** a module regression and **not** closable by better interpolation.

Consequently the ≤10 cm miss bound (which the `aerospace-synthetic/` fixture
meets because its straight-line motion is exactly representable) is **not
achievable** against the real CSieve key except where a conjunction's TCA falls
near an ephemeris node (the `parity_anchor` subset, retained as a genuine ≤10 cm
real-data assertion). The bound is **recorded as a finding, never weakened**.
