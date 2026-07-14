# ISS-E SupGP capture — provenance (A2.4)

## `celestrak_supgp_iss-e_2026-07-13.csv`

- **Exact URL:** `https://celestrak.org/NORAD/elements/supplemental/sup-gp.php?SOURCE=ISS-E&FORMAT=CSV`
- **Captured:** 2026-07-13 (UTC), HTTP 200, 9837 bytes, 60 OMM rows (ISS split into
  6 h [Segment NN] rows, all NORAD 25544).
- **How:** celestrak.org is unreachable from the build host (erroneous upstream
  block). Fetched read-only via the host proxy
  `ssh space-data-network-02 'curl -s --max-time 20 -H "User-Agent: sdn-supgp-reference-capture/1.0" "<url>"'`.
  Serial, ≥3 s spacing; host temp dir cleaned up after capture.
- **Byte-exact:** the CSV is stored exactly as CelesTrak served it (no hand-edit).
- **RMS/DATA_SOURCE columns:** the SupGP CSV carries two extra columns beyond a
  standard OMM CSV — `RMS` (CelesTrak's own fit residual, km) and `DATA_SOURCE`.

## Pairing (same-epoch, independent raw-vs-fit)

`../ISS.OEM_J2K_EPH.trimmed.txt` is the NASA public ISS OEM (EME2000/UTC,
retrieved 2026-07-13, START_TIME 2026-07-13T12:00:00). CelesTrak's ISS-E SupGP
fits the SAME NASA OEM, and its `[Segment 01]` row has EPOCH 2026-07-13T12:00:00
== our fit epoch (Δepoch 0 s). Element-space parity is therefore INDEPENDENT
raw-vs-fit. RMS note: ours 0.080 km vs CelesTrak Segment-01 0.067 km — only
element-space parity is gated, not RMS-beat.

## A2.4b — corrected RMS-gap root cause

The earlier claim that the 0.080-vs-0.067 RMS gap came from truncated 10-term
nutation (~13 m) was WRONG. The OD frame transform now carries the FULL 106-term
IAU-1980 nutation series (SOFA/ERFA `eraNut80`, pinned in `test_frame_time_fit`),
and the ISS fit is **byte-identical** before/after that upgrade — same RMS 0.080,
same MEAN_MOTION/INCLINATION/RAAN. The measured nutation-truncation effect is
~0.09 m at LEO, not 13 m. More fundamentally, an EME2000→TEME rotation error is a
near-constant rotation over the fit arc that SGP4 absorbs into fitted orientation
(RAAN/argp/incl); it does not enter the position-residual RMS. Confirmed
directly: fitting only CelesTrak's 6 h Segment-01 window (12:00–18:00) gives the
SAME 0.080 RMS as the full 12 h arc (so arc length isn't the cause either). The
residual gap is fitter convergence — our Levenberg-Marquardt lands elements
within tolerance of CelesTrak's but at a slightly looser RMS minimum than
CelesTrak's differential correction. That is an OD-fitter improvement (must keep
Starlink MEME byte-identical), not a frame-transform fix; the gate stays honest.
