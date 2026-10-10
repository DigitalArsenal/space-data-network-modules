# Synthetic Starlink-style suite

Every number in this directory is invented. Nothing comes from SpaceX or CelesTrak. It sits beside `../starlink`, which holds the real SpaceX MEME files, so the frame checks also run where the CelesTrak SupGP rows paired with those files are absent.

- `meme/MEME_*.txt`: ten ephemerides in the SpaceX MEME layout (header, `UVW`,
  one state and three covariance lines per epoch), 241 epochs at 60 s. Each is
  SGP4 truth from an invented element set (Vallado 2020-07-13, WGS-72, opsmode
  `i`, `propagate_state` of `propagator/sgp4`), written in GCRF. The files hold
  EME2000 axes; GCRF and EME2000 differ by the 23 mas frame bias, 0.8 m at LEO.
  The header says `ephemeris_source:synthetic`. File names, NORAD numbers and
  object names follow the operator's convention so that the source adapters and
  flows see the names they expect; the numbers behind them are not those
  objects'. The covariance is positive semidefinite by construction and grows
  with the age of the prediction.
- `synthetic_reference_elements.csv`: a reference element set for each object in
  the layout of a CelesTrak SupGP CSV. It stands in for a third-party fit of the
  same ephemeris: the truth elements with the mean anomaly moved by 0.019 to
  0.027 deg (2.3 to 3.2 km along track). Its `RMS` column is that element set
  scored against the truth states with the same SGP4.
- `provider.json`: the gate `analysis/od/tests/test_wasm.mjs` runs on them.

A reader that took the MEME states for TEME would put the reference about 35 km
from them (the precession since J2000); a reader that rotates them lands within
metres of truth. That is what the frame checks in `test_wasm.mjs` and in
`flows/supplemental-omm/tests/od-node-starlink-frame.test.mjs` rely on.

Regenerate: `node analysis/od/scripts/synthetic-fixtures.mjs` from the repository
root. CelesTrak publishes no licence for its SupGP rows, so the ones paired with
the real SpaceX files are not in this tree; the tests that use them read them from
`$SDN_MODULES_PRIVATE_FIXTURES` (see `tests/lib/privateFixtures.mjs`) and skip
without it.
