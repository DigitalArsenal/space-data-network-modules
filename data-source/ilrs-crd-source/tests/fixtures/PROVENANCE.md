# Fixtures of data-source/ilrs-crd-source

## `lageos1_20261008.first-two-passes.np2` (real)

The first two passes of the ILRS daily normal point file for LAGEOS-1, 2026-10-08, in CRD version 2, as served by the EUROLAS Data Center
(EDC, DGFI-TUM) from its anonymous tree:

- source: https://edc.dgfi.tum.de/pub/slr/data/npt_crd_v2/lageos1/2026/lageos1_20261008.np2
- retrieved: 2026-10-11 (the file is 49,750 bytes, SHA-256 `596595d8214c8e8529c175c5ecafeacdda4b5fed6f0d085b7ff1986a3c8c71a6`)
- excerpt: lines 1 to 19 (station SVEL, CDP pad 1888, 9 normal points, 1 meteorological record) and lines 20 to 53 (station TKBL, CDP pad
  7306, 6 normal points, 6 meteorological records), each pass whole from its `H1` to its `H8`, then an `H9` footer added to close the
  excerpt; no value is edited. 3,256 bytes.
- terms: the ILRS states its data and products are not copyrighted and asks to be cited (data licence audit, id `ilrs`, reproduce:
  yes; https://ilrs.gsfc.nasa.gov/about/cite.html). EDC adds no data terms of its own.
- credit: ILRS data and products (Pearlman et al. 2019, J Geod 93:2161-2180, doi:10.1007/s00190-019-01241-1), from the EUROLAS Data
  Center, DGFI-TUM (Noll et al. 2019, doi:10.1007/s00190-018-1207-2). Observations of the stations SVEL (Svetloe) and TKBL.

## `crd-format.mjs` (synthetic)

CRD version 2 files built from synthetic passes in the layout the ILRS Consolidated Laser Ranging Data Format, version 2.01 fixes
(https://ilrs.gsfc.nasa.gov/docs/2022/crd_v2.01e3.pdf): the cases a real day does not hold (a pass across midnight, other epoch
events, full-rate and one-way sessions, other time scales, two system configurations, damaged files). No value in it comes from a
station.
