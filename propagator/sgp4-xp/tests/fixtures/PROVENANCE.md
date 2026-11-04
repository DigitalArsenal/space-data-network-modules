# Fixtures

Recorded 2026-11-04 from the dist of modules main 1f806e4bf6 (`dist/isomorphic/module.wasm`, sha256
f61b15c4fd658817e3e43c7818da18c4d08d453ad28e9d704b0cd11b616b7deb, the 0.1.1 build) before the `$OCM` change.

- `xp-fit-current.oem`: the `fit` input, one size-prefixed `$OEM` of two blocks, ORIGINATOR NASA/JSC/FOD/TOPO.
  Block 1: 48 h at 120 s propagated by that dist from the SGP4-XP set n 15.5 rev/day, e 0.0006317, i 51.64,
  RAAN 208.9163, argp 69.9862, M 25.2906, BTERM 0.005, AGOM 0.01 m**2/kg, epoch 2024-04-09T12:00:00Z, TEME;
  fit interval the first 24 h (721 states), 720 held out. Block 2: `files/ccsds-messages/fixtures/real/nasa-iss.oem`
  (a U.S. Government work), EME2000, fit interval its first 91 states, 90 held out.
- `xp-fit-current.omm`: the two size-prefixed `$OMM` that dist's `fit` wrote on 'elements', in block order.
- `xp-fit-current.obd`: the two size-prefixed `$OBD` it wrote on 'determination'.

sha256: oem 7858527b8be52e85a1b7bb2d6b6f7e927bdb3e614c9dc2a014e4c831d8486105, omm
7bab3f60a4e9394a60e9561b7e81802e15d862ca45508609e150bea262ae5f88, obd
7337b3c81bdb868a730a2c5009ad0bfd25b2150b1a05fb4e4bf785aeb5c1b837.

## geo-real-sets.json

The two-line SGP4-XP sets of the GE and IG 2x2 of orbit-accuracy-experiments 55402ef
(`results/operator-theory/geo-sgp4-one-mode`, the stored part-c rows' `lines`): for each of 35 GE windows (9
geosynchronous BeiDou and QZSS satellites) and 60 IG windows (12 inclined geosynchronous ones), October 2025, the
whiteroom fit (propagator/sdn-ap) and the Space Force fit (propagator/sgp4-xp 0.1.1) to 72 h of truth ending at the
window's cutoff; `eclipsed` when the window's truth enters Earth's shadow. Element sets only; no truth.
