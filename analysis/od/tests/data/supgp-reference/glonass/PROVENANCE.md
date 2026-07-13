# GLONASS-RE SupGP capture — provenance (A2.4)

## `celestrak_supgp_glonass-re_2026-07-13.csv`

- **Exact URL:** `https://celestrak.org/NORAD/elements/supplemental/sup-gp.php?SOURCE=GLONASS-RE&FORMAT=CSV`
- **Captured:** 2026-07-13 (UTC), HTTP 200, 4124 bytes, 25 OMM rows (GLONASS
  constellation, EPOCH 2026-07-11T23:59:42), each with a real NORAD_CAT_ID.
- **How:** read-only host proxy `ssh space-data-network-02 'curl ...'` (celestrak
  unreachable from build host — erroneous block); serial, ≥3 s spacing; host temp
  dir cleaned up. Byte-exact as served.

## `R03.oem_igs20_gps.kvn` (derived operator fixture)

Position-only CCSDS OEM KVN derived from the authoritative IAC SP3-d fixture
`../../glonass/iac_glonass.sp3.glo` (satellite R03, P-records at lines 26/52/78;
upstream `ftp://ftp.glonass-iac.ru/MCC/PRODUCTS/26192/rapid/Sta24266.sp3.glo`).
IGS20/ECEF, GPS time, positions in km copied verbatim (no value altered). Inline
CCSDS `COMMENT` block records the full derivation.

## Pairing (distributional, NOT per-object)

The SP3 carries only the slot id `R03` (no NORAD), and no authoritative GLONASS
slot→NORAD registry is available (OWNER-ASSIST), so R03 cannot be keyed to a
per-object CelesTrak RMS/OMM row. The captured CSV is a DISTRIBUTIONAL reference:
real GLONASS-RE MEAN_MOTION 2.13100–2.13106, INCLINATION 63.62–65.59°, eccMax
0.0025. Our short-arc fit (MEAN_MOTION 2.1287, INCLINATION 65.28°) is inside
range; MEAN_MOTION sits ~0.1% below the full-arc SupGP (documented short-arc
bias). Gate is a hard fail-closed elementRange, not beatsCelestrak.
