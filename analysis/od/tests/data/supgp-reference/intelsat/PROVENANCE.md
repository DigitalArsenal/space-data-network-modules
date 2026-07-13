# Intelsat-11P SupGP capture — provenance (A2.4)

## `celestrak_supgp_intelsat-11p_2026-07-13.csv`

- **Exact URL:** `https://celestrak.org/NORAD/elements/supplemental/sup-gp.php?SOURCE=Intelsat-11P&FORMAT=CSV`
- **Captured:** 2026-07-13 (UTC), HTTP 200, 20366 bytes, 127 OMM rows (Intelsat/
  Galaxy GEO fleet + weekly [PM] maneuver snapshots).
- **How:** read-only host proxy `ssh space-data-network-02 'curl ...'` (celestrak
  unreachable from build host); serial, ≥3 s spacing; host temp dir cleaned up.
  Byte-exact as served.

## NORAD-KEY CORRECTION (caught by real data)

The A2.2c DRAFT asserted IS-21 = NORAD 38098 / COSPAR 2012-043A. **Wrong.**
CelesTrak's own Intelsat-11P SupGP shows:
- NORAD **38098** = INTELSAT **22 (IS-22)**, COSPAR 2012-011A
- COSPAR **2012-043A** = INTELSAT **20 (IS-20)**, NORAD 38740
- the real **IS-21** = NORAD **38749**, COSPAR **2012-045A**  ← used here

The name→NORAD registry (owner-assist) must use 38749 for IS-21.

## `is-21.oem_ecef_utc.kvn` (derived operator fixture)

Position-only CCSDS OEM KVN derived from
`data-source/intelsat-source/test/fixtures/i_aor_e_302.00_is-21_20260710_235300.sample.txt`
(ECEF, UTC, metres→km). 12-point / 5.5 h sample arc. OBJECT_ID left EMPTY: the
ECF source carries no NORAD/COSPAR; the 38749 key lives in provider.json.

## Pairing (NON-INDEPENDENT, GEO ill-conditioned, Δepoch ~2 days)

CelesTrak's Intelsat-11P SupGP is fit from the same public Intelsat feed → not
independent. Nearest captured IS-21 epoch is 2026-07-09 (Δ ~2 days from our
2026-07-10 operator fixture). At near-zero inclination (~0.006°) / eccentricity
(~0.00017), RAAN/argp/MA are ill-conditioned (Δ 150°+, meaningless) and are NOT
compared — only MEAN_MOTION (observed Δ 1.3e-4, tol 8e-4).
