# Fixtures of flows/observation-od

## `starlette-20260713T15-20260715T15.np2` (real, cut)

Starlette (NORAD 7646, ILRS 7501001) normal points of 2026-07-13T15:00 to 2026-07-15T15:00 UTC, CRD v2, cut from the EUROLAS
Data Center's monthly file:

- source: https://edc.dgfi.tum.de/pub/slr/data/npt_crd_v2/starlette/2026/starlette_202607.np2
- retrieved: 2026-10-09T22:48:51.721Z (1,479,104 bytes, SHA-256 `6ae609e395ebcc8d2ae9451c8fe1f431fc4d1a6bc4e62a30eb9cd8d67b3dc5bd`),
  archive copy `hac/ilrs-edc/npt_crd_v2/starlette/starlette_202607.np2`
- cut: `node tests/fixtures/cut-crd.mjs <file>`: every pass (h1 to h8, verbatim) whose h4 session starts at or after
  2026-07-13T15:00 and ends at or before 2026-07-15T15:00, at a pad the station fixture holds (Arequipa, 7403, is not in
  ilrsa.pos+eop.260718.v90: 3 passes left out), then H9. 65 passes, 380 normal-point records; 109,256 bytes, SHA-256
  `002d6f2c01e69a2e3c034ff11f87478a79675fa929b82c2f7926546f36cf2e8a`. data-source/ilrs-crd-source reads 58 of the passes,
  335 normal points (its rules for the passes it reads).
- terms: the ILRS states its data and products are not copyrighted and asks to be cited (data licence audit, id `ilrs`;
  https://ilrs.gsfc.nasa.gov/about/cite.html). EDC adds no data terms of its own.
- credit: ILRS data (Pearlman et al. 2019, J Geod 93:2161-2180, doi:10.1007/s00190-019-01241-1), from the EUROLAS Data Center,
  DGFI-TUM (Noll et al. 2019, doi:10.1007/s00190-018-1207-2).

## `eopc04-20260710-20260720.txt` (real, cut)

IERS EOP 20 C04 (consistent with ITRF 2020), the header and the rows of 2026-07-10 to 2026-07-20:

- source: https://hpiers.obspm.fr/iers/eop/eopc04/eopc04.1962-now, archive copy `reference-states/products/eopc04.1962-now`
  (modified 2026-10-01T22:15:20Z, 5,173,509 bytes, SHA-256 `a14854ff3fa974a6783b31ed0d6642c9d477647547949e2794308cb46dfeb2b3`),
  the series the NSGF reference states were converted to GCRF with
- cut: lines 1 to 6 and the 11 rows of 2026-07-10 to 2026-07-20, unedited; 17 lines, SHA-256
  `ef53363cbe7d456828fa42337c972176c552a649197ec9f99845404da3cb3bd5`
- credit: IERS Earth Orientation Centre, Paris Observatory.

## Shared and read in place

- `data-source/ilrs-station-coordinates/tests/fixtures/ilrsa.pos+eop.260718.v90.no-matrix.snx` (its PROVENANCE.md).
- `files/orbit-products/tests/fixtures/de440/de440-2026.bsp` (its README.md).

## The first guess and the truth (in `laser-od.e2e.mjs`)

NSGF rapid orbits of Starlette from EDC, converted ITRF to GCRF (IAU 2006/2000A, IERS EOP C04) in the archive's
`reference-states/reference/`:

- the first guess: the 2026-07-13T15:00 state of `nsgf.orb.starlette.260715.v000/7646.oem` (SHA-256
  `802fb5b8e29cc0ced1443454714cdd8bf591b142a4ae8d3406bfb244747977a6`; covers 2026-07-11T00:00 to 2026-07-14T22:30), rounded
  to 100 m and 0.1 m/s;
- the truth: the 2026-07-15T15:00 state of `nsgf.orb.starlette.260716.v000/7646.oem` (SHA-256
  `8f50e071ddb14a1f3c799d5905f36632713454700f052ffdefe64014c97a88c9`), the next product, as recorded there. Its stated accuracy
  is 0.26 m per axis (the RMS of its overlap with the next day's arc).
