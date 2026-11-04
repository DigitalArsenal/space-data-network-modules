# Fixtures

Recorded 2026-11-04 by `tests/fixtures/record.mjs` at modules d6444440, before the `$OCM` lane. JS only moves bytes:
every element set comes out of a module.

- `xp.ocm`: one SGP4XP `$OCM`, the second record propagator/sgp4-xp 0.2.1 `fit` wrote for its fixture
  (`propagator/sgp4-xp/tests/fixtures/xp-fit-current.ocm`, the NASA ISS block, a U.S. Government work): NORAD 25544,
  1998-067A, ORIGINATOR NASA/JSC/FOD/TOPO, EPOCH 2026-07-13T12:00:00Z, 1,788 B.
- `ap.ocm`: one AP `$OCM` written by the propagator/sdn-ap 0.5.1 dist's `fit` (sha256 d29acd2b...): 48 h of the 550 km
  trajectory of `propagator/sdn-ap/test/lib/fixture-inputs.mjs` (`arcOem(48)`), `$PCF` THEORY AP, FORCES gravity caps
  31 and 20, NRLMSISE-00, WEATHER_SOURCE RECORDS, DENSITY_CORRECTION DCA_COMMON_MODE, FIT.WEATHER_HORIZON_DAYS 32; the
  fixture rows (`spwRows()`) and a Solved NRLMSIS00E `$DCL` of 21 six-hourly LogDensityNodes 2026-09-30T00Z ..
  2026-10-05T00Z, s = 0.01 (k mod 7 - 3). EPOCH 2026-10-01T00:00:00Z (the arc's start), so the record carries 34
  SPACE_WEATHER rows (2026-09-30 .. 2026-11-02) and the nodes; 4,744 B.
- `sgp4.omm`: two foreign SGP4 `$OMM`, size-prefixed, the first two sets data-source/celestrak-supgp 2.0.0 `parse` writes
  for its synthetic SES-E feed (`data-source/celestrak-supgp/test/fixtures/SES-E.trimmed.json`, invented numbers):
  NORAD 26554 and 26580, EPOCH 2026-07-13, no ORIGINATOR, PROVENANCE SOURCE_ID ses.
- `notice.pnv`: one `$PNV` entry, SIGNATURE_VERIFIED (the module reads only that flag).
- `merge-before.json`: the 0.1.0 dist (sha256 bf2047b6...) on the window FROM 2026-01-01T00Z, AS_OF 2026-11-04T00Z, with
  SGP4 set 1 on `cached` and sets 1 and 2 on `pulled` beside the notice: each output frame's port, length and sha256,
  the summary MESSAGE, and the refusal of an `$OCM` frame on `cached` (`invalid-omm-frame`).

sha256: xp.ocm 89806fccac7b9bbb862ab9469c4306509698cc97271907fbc81a571148c1640c, ap.ocm
82b4e416a15745643803157ae1e2f99ba65da3393c24fed4bea424cb50139317, sgp4.omm
6a39e67b7879404fabc5641ecbc768026d4ec8bcb1445d725a27320098078444, notice.pnv
a977c332cca6818bf7449d5f7b35a80cf252af5415441fe84f5d613b928eb580.
