# Fixtures of data-source/ilrs-station-coordinates

## `ilrsa.pos+eop.260718.v90.no-matrix.snx` (real)

The ILRS weekly station coordinate and EOP solution of the primary combination centre (ILRSA, ASI) for 2026-07-12 to
2026-07-19, SINEX 2.00, as served by the EUROLAS Data Center (EDC, DGFI-TUM) from its anonymous tree:

- source: https://edc.dgfi.tum.de/pub/slr/products/pos+eop/weekly/2026/260718/ilrsa.pos+eop.260718.v90.snx.gz
- retrieved: 2026-10-09T22:37:17.611Z (39,381 bytes gzip, SHA-256 `406450586c2201f6e13cde95dca6834c0feac2e972c6e4f3f7d3fb3444a812c8`;
  decompressed 124,088 bytes, 1,582 lines, SHA-256 `18c3294d07e2a164dea0613caddfa81a54a1daefdbc3caca472b096298a2f7c5`), archive copy
  `hac/ilrs-edc/pos+eop/ilrsa.pos+eop.260718.v90.snx.gz`
- excerpt: lines 1 to 443 and 1,581 to 1,582 of the decompressed file: every block whole except `SOLUTION/MATRIX_ESTIMATE L COVA`
  (lines 444 to 1,580, the covariance, which the module does not read); line endings as served (CRLF and LF); no value edited.
  35,002 bytes, SHA-256 `7e49b55812ac51cbcdb05e41c5ce954b15540b9cb3b82f93ce1e053c8839f9d0`.
- terms: the ILRS states its data and products are not copyrighted and asks to be cited (data licence audit, id `ilrs`, reproduce:
  yes; https://ilrs.gsfc.nasa.gov/about/cite.html). EDC adds no data terms of its own.
- credit: ILRS data and products (Pearlman et al. 2019, J Geod 93:2161-2180, doi:10.1007/s00190-019-01241-1), combination by the ILRS
  primary combination centre at ASI, CGS Matera, from the EUROLAS Data Center, DGFI-TUM (Noll et al. 2019, doi:10.1007/s00190-018-1207-2).
