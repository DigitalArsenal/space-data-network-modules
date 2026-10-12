# propagator/solar-system-bodies

Where every Sun, planet, moon, dwarf planet and asteroid in OrbPro's multi-body
navigation is, how it is turned, how bright it looks, and where the sky's
observer stands. It is the only source of body physics for `scene.bodies`.

## Inputs

Unmodified NASA/JPL NAIF kernels, passed in as bytes and delivered by CID:

| Kernel | Content |
| --- | --- |
| `core-<decade>.bsp` | DE440s planets, Sun, Moon, Earth (1950-2050); planet centres 499..999; Ceres and Vesta (sb441-n16, 2000-2050) |
| `mars-`, `jupiter-`, `saturn-`, `uranus-`, `neptune-`, `pluto-<decade>.bsp` | mar099s, jup365, sat441, ura184 part 3, nep097, plu060 moons (2000-2050) |
| `moon-pa-<decade>.bpc` | DE440 lunar principal-axis angles (`moon_pa_de440_200625.bpc`) |
| `pck00011.tpc`, `gm_de440.tpc`, `moon_de440_250416.tf` | WGCCRE 2015 rotation and radii, GM, the PA to ME rotation |

`tools/build_kernels.py` copies the original Chebyshev records (CSPICE
`spksub_c`, no refit) into decade shards of at most 9 MB;
`tools/kernel-provenance.json` lists every input URL and every output hash.
One decade needs 31 MB; all ten need 159 MB.

## Surfaces

- Direct (resident, per frame): `ssb_load_kernel`, `ssb_states`,
  `ssb_orientations`, `ssb_apparent`, `ssb_observer`, `ssb_hill_radius`,
  `ssb_cartographic`, `ssb_light_time`, `ssb_small_body_magnitudes`, `ssb_body_record`,
  `ssb_body_names`, `ssb_et`, `ssb_last_error`.
- Command: `evaluate` takes `kernel` frames and one JSON `request`
  (`catalog`, `states`, `orientations`, `apparent`, `observer_state`,
  `hill_radius`) and answers JSON.

States are geometric, ICRF, metres. Rotations are ICRF to IAU_<body> (text PCK)
and ICRF to MOON_ME. Time is a TAI JulianDate (or TDB `et`), converted with the
SPICE leapseconds-kernel TDB relation. An epoch outside the loaded segments is
`out-of-range` (-5); a body without kernels is `no-ephemeris` (-9).

## Evidence

- `tests/ephemeris.e2e.test.mjs` (A4): 33 bodies at 200 epochs, 2000-2050,
  against CSPICE N0067 on the same files. Measured: worst position difference
  6.1e-5 m (bound 1 m); worst rotation 1.2e-10 rad, which is one unit in the
  last place of W for Phobos and Vesta (bound 1e-10 rad or 2 ulp of W);
  planet V within 0.076 mag of JPL Horizons APmag (bound 0.3 mag).
- `tests/parity.mjs`: `evaluate` byte-identical in browser, WasmEdge and
  Docker WasmEdge (`conformance/parity.json`).

## Credits

Ephemerides and orientation: NASA/JPL NAIF (DE440, Park et al. 2021; satellite
ephemerides of the JPL Solar System Dynamics group; sb441-n16). Rotation
models: Archinal et al. (2018), WGCCRE 2015. Planet magnitudes: Mallama &
Hilton (2018).
