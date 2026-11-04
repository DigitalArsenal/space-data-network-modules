# Fixtures

- `iss-sgp4xp-3day.oem`: a CCSDS OEM (KVN, EME2000, UTC, 4-minute states, 2024-04-09T12:00 to 2024-04-12T12:00) of a
  known SGP4-XP set (ISS, n 15.5 rev/day, e 0.0006317, i 51.64 deg, RAAN 208.9163 deg, argp 69.9862 deg, M 25.2906 deg,
  BTERM 0.005, AGOM 0.01), propagated by `propagator/sgp4-xp` 0.1.1 `propagate` (the US Space Force Sgp4Prop), as the
  legacy `od-node-sgp4-xp` test made it at run time. Synthetic: no third-party data.
- `starlink-synthetic-12h.oem`: a plain `$OEM` (EME2000, UTC, 60 s, 721 states with velocities, 2026-05-14T00:00 to
  12:00, ORIGINATOR SYNTHETIC) of an invented SGP4-XP set (STARLINK-SYNTHETIC, NORAD 90001, n 15.3 rev/day,
  e 0.00012, i 53.05 deg, RAAN 120.5 deg, argp 90 deg, M 270 deg, BTERM 0.02, AGOM 0.015 m**2/kg), propagated by
  `propagator/sgp4-xp` 0.1.1 `propagate` (dist sha256 f61b15c4fd65...). Synthetic: no SpaceX data; long enough for
  one SGP4-XP window (8 h fitted, 4 h scored), which the 11-minute provider fixtures are not.
- `starlink-previous-xp.omm`, `starlink-previous-sgp4.omm`, `starlink-previous.ocm`, `starlink-previous.obd`: what
  the OD node of modules main 1f806e4bf6 (dist sha256 4dd97163c9cc...) wrote for that ephemeris on the 'starlink'
  port, recorded 2026-11-04 before the `$OCM` change: the SGP4-XP `$OMM` (one window), the OD core's four SGP4
  `$OMM` and four `$OCM`, and the five `$OBD` (four the core's, one the SGP4-XP window's), each size-prefixed, in
  stream order.
- `starlink-xp.ocm`: the SGP4-XP window's `$OCM` the OD node 2.1.1 (over propagator/sgp4-xp 0.2.1) writes for
  `starlink-synthetic-12h.oem` on the 'starlink' port, recorded 2026-11-04 by `tests/fixtures/record-xp.mjs`.
  Amendment (task modules-sgp4-xp-flight-departs-library-20261104): the XP window's statistics anchors moved
  because the 0.1.1 flight returned partial integrator steps. The previous node scored the window's held-out states
  on one library satellite, which answers an SGP4-XP request less than one integrator step past the previous one from
  a partial step; 2.1.1 propagates every state from the set's epoch. The window's elements and fit figures are
  unchanged; its HELD_OUT_RMS_KM moved from 0.268003346 to 0.268003429 km and HELD_OUT_MAX_KM from 0.463066506 to
  0.463066523 km, so the E2E compares FIT_STATISTICS with this record bit for bit. The ephemeris inputs
  (`iss-sgp4xp-3day.oem`, `starlink-synthetic-12h.oem`) were propagated with the 0.1.1 flight and are kept as they
  are: re-propagating them would also move the OD core's records, whose anchors are the previous node's.

