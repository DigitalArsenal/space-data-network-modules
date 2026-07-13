# CPF SupGP capture — provenance (A2.4)

## `celestrak_supgp_cpf_2026-07-13.csv`

- **Exact URL:** `https://celestrak.org/NORAD/elements/supplemental/sup-gp.php?SOURCE=CPF&FORMAT=CSV`
- **Captured:** 2026-07-13 (UTC), HTTP 200, 28618 bytes, 193 OMM rows (ILRS laser
  targets; LAGEOS-1 NORAD 8820 present as [DGF]/[HTS]/[SGF] prediction-centre
  variants, EPOCH 2026-07-13T00:00:00).
- **How:** read-only host proxy `ssh space-data-network-02 'curl ...'` (celestrak
  unreachable from build host); serial, ≥3 s spacing; host temp dir cleaned up.
  Byte-exact as served.

## `lageos1.oem_itrf_utc.kvn` (derived operator/prediction fixture)

Position-only CCSDS OEM KVN derived from the ILRS CPF sample
`data-source/cpf-source/test/fixtures/lageos1_cpf_260713_19402.sample.dgf`
(CPF '10' position records, ITRF/ECEF, UTC, metres→km, epoch from CPF
MJD+seconds-of-day). 12-point / 11-min sample arc — the adapter's checked-in
sample. Inline CCSDS `COMMENT` block records the derivation.

## Pairing (PREDICTION-vs-PREDICTION — NOT independent)

Our OEM derives from an ILRS CPF *prediction*; CelesTrak's CPF SupGP also derives
from ILRS CPF predictions. The element-space check (NORAD 8820, LAGEOS1 [DGF],
Δepoch 0 s) is labeled PREDICTION-vs-PREDICTION, not independent raw-vs-fit.
Observed deltas: meanMotion 3.3e-5, eccentricity 1e-7, inclination 0.0005°,
RAAN 0.0003°, arg-lat 0.0001°.
