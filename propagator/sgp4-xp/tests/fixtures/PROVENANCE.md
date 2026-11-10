# Fixtures

## xp-fit-current.*

Recorded 2026-11-04 by `tests/fixtures/record.mjs` from the propagator/sgp4-xp 0.2.2 dist; the inputs are the ones
recorded from the 0.1.1 dist (modules 1f806e4bf6) before the `$OCM` change.

Amendment (0.2.1, task modules-sgp4-xp-flight-departs-library-20261104): the anchors moved because the 0.1.1 flight
returned partial integrator steps. 0.1.1 flew every grid on one library satellite, and the library answers an SGP4-XP
request less than one integrator step past the previous one from a partial step, so block 1 of the ephemeris and both
fits were made with that flight. Re-recorded from 0.2.1, whose every state is the propagation from the set's epoch:
block 1's states moved by up to 0.538 m, its fit RMS from 2.45e-7 km to 8.17e-8 km and AGOM from 0.0099994 to
0.0099998 m**2/kg; block 2 (NASA ISS) kept its elements and fit statistics, its held-out RMS moved by 0.1 mm (0.802918196 to
0.802918300 km).

Amendment (0.2.2, task modules-sgp4-xp-flight-cost-20261104): re-recorded from 0.2.2, whose SGP4-XP flight flies
dense times in chains of new satellites and returns 0.2.1's states bit for bit. The `.oem` and `.omm` are
byte-identical; the `.ocm` differs in two bytes, the version in each `$OCM`'s PROVENANCE.PRODUCER.

Amendment (0.3.0, DigitalArsenal/spacedatanetwork-stack#389): re-recorded from 0.3.0, built over foundation/frames
0.3.0, whose TEME is AIAA 2006-6753's (r_PEF = R3(GMST82) r_TEME; until then the x axis was placed by GMST06). The
`.oem` is byte-identical (block 1 is TEME). Block 2 (NASA ISS, EME2000) is turned into a TEME 58.9 mas away from
0.2.2's about the pole at 2026-07-13 (1.94 m at its radius): its fitted set moved 0.99 m RMS, 1.70 m at worst over its
181 epochs; MEAN_MOTION 15.48824912 to 15.4882492, ARG_OF_PERICENTER 42.9463 to 42.9462, MEAN_ANOMALY 270.2725 to
270.2726, FIT_RMS_KM 0.163595 to 0.163584, HELD_OUT_RMS_KM 0.802918 to 0.802836, iterations 12 to 15. The `.omm`
carries those elements; both records name 0.3.0 as PRODUCER.

- `xp-fit-current.oem`: the `fit` input, one size-prefixed `$OEM` of two blocks, ORIGINATOR NASA/JSC/FOD/TOPO.
  Block 1: 48 h at 120 s propagated by the dist from the SGP4-XP set n 15.5 rev/day, e 0.0006317, i 51.64,
  RAAN 208.9163, argp 69.9862, M 25.2906, BTERM 0.005, AGOM 0.01 m**2/kg, epoch 2024-04-09T12:00:00Z, TEME;
  fit interval the first 24 h (721 states), 720 held out. Block 2: `files/ccsds-messages/fixtures/real/nasa-iss.oem`
  (a U.S. Government work), EME2000, fit interval its first 91 states, 90 held out. Every other field is the 0.1.1
  recording's.
- `xp-fit-current.ocm`: the two size-prefixed `$OCM` the dist's `fit` writes for it, in block order.
- `xp-fit-current.omm`: the `ingest_omm` input, two foreign size-prefixed SGP4XP `$OMM` (BTERM in BSTAR, AGOM in
  MEAN_MOTION_DDOT) carrying the fitted `$OCM`'s elements; their 19 free-form parameters are the 0.1.1 module's,
  kept for the refusal by count.

sha256: oem 5c7ff4e36c16ca536b82908b40c469c8ab1ea2ab7c70272ddefd06984c08ba77, ocm
4a63334317cb7b1c7751dca405f122b893c4d630ca7229838b0ad481f0630e12, omm
91e130d31fcc75281b60563b4f3a4226081acf91936420e788abca7458d4fc7b.

## geo-real-sets.json

The two-line SGP4-XP sets of the GE and IG 2x2 of orbit-accuracy-experiments 55402ef
(`results/operator-theory/geo-sgp4-one-mode`, the stored part-c rows' `lines`): for each of 35 GE windows (9
geosynchronous BeiDou and QZSS satellites) and 60 IG windows (12 inclined geosynchronous ones), October 2025, the
whiteroom fit (propagator/sdn-ap) and the Space Force fit (propagator/sgp4-xp 0.1.1) to 72 h of truth ending at the
window's cutoff; `eclipsed` when the window's truth enters Earth's shadow. Element sets only; no truth.

## flight-0-2-1.json

Recorded 2026-11-04 by `tests/fixtures/record-flight.mjs` from the propagator/sgp4-xp 0.2.1 dist (module.wasm sha256
816fd137d76197f2af93501d7d71c527383f7589ab698d5d1d3544782cd2feef), before the change of its SGP4-XP flight: for every
set of `geo-real-sets.json`, the SHA-256 of the states `propagate` returns (x, y, z, x_dot, y_dot, z_dot of every line,
in order, as little-endian doubles) on the lead grid (the 91 epochs `tests/flight-parity-real-sets.e2e.mjs` compares
with the oracle) and on the week grid (2,016 states, every 5 minutes from 5 minutes after the set's epoch to 7 days
after it), both built by `tests/lib/flight-grids.mjs`. 0.2.1 flies every SGP4-XP state from the epoch on a new library
satellite; the week grid took 1.56 s per set (median, at most 1.76 s; 1-minute load 20 to 30 on 28 cores). The module's
own states only, hashed; nothing of the oracle is stored.

sha256: e9a89e0389cd7335fac9f8e29f70e4b03d5d676f73cd2cbcdb138d8dfcb68382.
