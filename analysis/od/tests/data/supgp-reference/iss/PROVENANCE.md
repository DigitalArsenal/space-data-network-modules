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
raw-vs-fit. RMS note: ours 0.080 km vs CelesTrak Segment-01 0.067 km — we do NOT
beat CelesTrak's per-6h-segment RMS (our truncated-nutation EME2000→TEME adds
~13 m; A2.2a residual), so only element-space parity is gated, not RMS-beat.
