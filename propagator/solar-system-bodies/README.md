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
  `ssb_cartographic`, `ssb_light_time`, `ssb_light_time_point`, `ssb_small_body_magnitudes`,
  `ssb_apparent_offsets` (light time and stellar aberration, so bodies are drawn
  where they are seen), `ssb_apparent_point`, `ssb_radii` (PCK radii of any body,
  Eros included), `ssb_galactic` (ICRS to Galactic axes, Hipparcos definition;
  the Galactic centre from the Sun, R0 = 8.178 kpc, z0 = 20.8 pc),
  `ssb_body_record`, `ssb_body_names`, `ssb_et`, `ssb_last_error`.
- Command: `evaluate` takes `kernel` frames and one JSON `request`
  (`catalog`, `states`, `orientations`, `apparent`, `observer_state`,
  `hill_radius`) and answers JSON.

States are geometric, ICRF, metres. Rotations are ICRF to IAU_<body> (text PCK)
and ICRF to MOON_ME. Time is a TAI JulianDate (or TDB `et`), converted with the
SPICE leapseconds-kernel TDB relation. An epoch outside the loaded segments is
`out-of-range` (-5); a body without kernels is `no-ephemeris` (-9).

## The scene surface (0.3.0)

Everything OrbPro's `scene.bodies` computes for a frame is here
(`src/scene.hpp`), so the engine's JavaScript only moves values between this
module's memory and GPU primitives (owner 2026-10-13): every body's state
relative to the central body and its fixed-frame place, the rotations a frame
needs, the coverage, the central frame, the Earth scope's transform and
camera, the lighting, the sky observer, the apparent places and magnitudes
(four times a second, or when the observer moved far for the nearest body),
the light-time shifts and the drawn places; the level of detail of every body
that is not central (lit ellipsoid or point, point size and opacity from V,
the pick target and whether a moon gives way to a small parent's disc, the
model matrix and the light), the stand-in places of far points and labels,
label decluttering on screen, the barycentre and Milky Way labels, the Milky
Way's frame and fade, the sky box fade, Saturn's ring frame, each body's
orbiter propagation cutoff with its hysteresis, the switch of central body
(the camera re-expressed, the flight to the day side), the camera kept
outside every body, the camera carried with the central body's spin, and the
small-body layer's observer and heliocentric frame.

The surface is typed arrays in this module's memory: `ssb_scene_resize`
returns a table of their addresses (an internal layout, not a standard;
OrbPro mirrors its index constants in `Scene/CelestialBodyLayout.js`). Calls:
`ssb_scene_frame`, `ssb_scene_place`, `ssb_scene_draw`,
`ssb_scene_declutter`, `ssb_scene_galaxy`, `ssb_scene_system_labels`,
`ssb_scene_scopes`, `ssb_scene_earth_scope`, `ssb_scene_ensure_rotation`,
`ssb_scene_body_transform`, `ssb_scene_switch`, `ssb_scene_keep_outside`,
`ssb_scene_carry`, `ssb_scene_beyond_hill`, `ssb_scene_small_body_observer`,
`ssb_sky_alpha`. The per-frame path allocates nothing.

## Threads (0.3.0)

Built `emscripten-pthreads` (wasi-threads) on an imported shared memory. A
binary kernel (SPK, binary PCK) is read on the module's loader thread
(`ssb_kernel_job_begin`, the bytes adopted, no copy), its completion read
from a control word (`ssb_kernel_job_control`), then joined to the loaded set
between two frames (`ssb_kernel_job_commit`). The engine's main thread never
waits for a kernel. Text kernels are read at once (`ssb_load_kernel`).

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
