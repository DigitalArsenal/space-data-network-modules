# propagator/solar-system-bodies

Where every Sun, planet, moon, dwarf planet and asteroid in OrbPro's multi-body
navigation is, how it is turned, how bright it looks, and where the sky's
observer stands. It is the only source of body physics for `scene.bodies`.

## Inputs

Unmodified NASA/JPL NAIF kernels, passed in as bytes and delivered by CID:

| Kernel | Content |
| --- | --- |
| `core-<decade>.bsp` | DE440s planets, Sun, Moon, Earth (1950-2050); planet centers 499..999; Ceres and Vesta (sb441-n16, 2000-2050) |
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
  the Galactic center from the Sun, R0 = 8.178 kpc, z0 = 20.8 pc),
  `ssb_body_record`, `ssb_body_names`, `ssb_et`, `ssb_last_error`,
  `ssb_observer_position`, `ssb_ecliptic`, `ssb_body_coordinates`,
  `ssb_body_surface_points`, and `ssb_body_coordinate_info` (below).
- Command: `evaluate` takes `kernel` frames and one JSON `request`
  (`catalog`, `states`, `orientations`, `apparent`, `observer_state`,
  `hill_radius`) and answers JSON.

States are geometric, ICRF, meters. Rotations are ICRF to IAU_<body> (text PCK)
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
label decluttering on screen, the barycenter and Milky Way labels, the Milky
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

## The observer's position at every scale (0.4.0)

`ssb_observer_position(et, focused, cam, out)`: a camera at `cam` (ICRF, m,
relative to the focused body) answers in one regime, chosen by scale
(`src/observer_position.hpp` has the layout of the 14 doubles):

| Regime | Where | Coordinates |
| --- | --- | --- |
| Body grid | Inside the focused body's Hill sphere, or the sphere of the body it orbits (the walk goes outward); the Sun's grid out to the Alfven surface, 18.8 solar radii (Parker Solar Probe, Kasper et al. 2021), when the Sun is focused | Planetographic (SPICE `recpgr`: spheroid RADII[0], RADII[2], longitude against the rotation, east for the Sun, Earth and Moon), planetocentric (`reclat`), and planetodetic on the triaxial ellipsoid (`nearpt` + `surfnm`, the engine's Cartographic); IAU_<body> or MOON_ME |
| Heliocentric | Out to the heliopause, 120.3 au (Voyager 1 121.6 au, Voyager 2 119.0 au) | Ecliptic J2000 longitude, latitude, au, and x, y, z in au |
| Galactic | Beyond, at any distance | Galactic l, b (Hipparcos), distance from the Sun in ly and pc, distance from the Galactic center in ly and pc |

`ssb_ecliptic(out)` is ICRF to ECLIPJ2000 (IAU 1976 obliquity, as SPICE):
the plane of the solar system. The nearest surface point is Eberly's
bisection (exact to the last bit, inside and outside), with the root carried
as s + 1 so points next to a body's medial axis keep their digits.

## Body coordinate systems (0.5.0)

The allocation-free direct exports use `int32_t` system IDs from
`src/body_coordinates.hpp`. Input points are body-fixed meters, in the exact
frame returned by `rotation(id, et)`: IAU_<body>, or MOON_ME for the Moon.
Bodies without a loaded rotation model use ICRF axes. Epoch `et` is TDB
seconds past J2000.

| ID | System | Applicable bodies | Longitude | Latitude and third value |
| --- | --- | --- | --- | --- |
| 0 | PLANETODETIC | Any body with PCK radii | East, (-pi, pi] | Normal at the nearest point on the PCK triaxial ellipsoid (`nearpt` + `surfnm`); signed height in meters, negative inside |
| 1 | PLANETOCENTRIC | Any body with PCK radii | East, (-pi, pi] | Body-frame `reclat` latitude; radius in meters |
| 2 | PLANETOGRAPHIC | Table planets and table moons with a planet parent, with loaded radii and rotation | IAU sense, [0, 2pi) | `recpgr` on the spheroid with equatorial radius RADII[0] and flattening (RADII[0] - RADII[2]) / RADII[0]; altitude in meters |
| 3 | STONYHURST | Sun (10) | East from the geometric Earth-center meridian, (-pi, pi] | IAU_SUN planetocentric latitude; radius in meters |
| 4 | CARRINGTON | Sun (10) | Apparent Earth-observed Carrington, [0, 2pi) | IAU_SUN latitude; radius in meters |
| 5 | MOON_PA | Moon (301) | East in MOON_PA_DE440, (-pi, pi] | `reclat` after ME → PA rotation; radius in meters |

```c
int32_t ssb_body_coordinates(int32_t id, int32_t system, double et,
    const double* xyz, uint32_t n, double* out);
int32_t ssb_body_surface_points(int32_t id, int32_t system, double et,
    const double* lonlat, uint32_t n, double* out);
int32_t ssb_body_coordinate_info(int32_t id, int32_t system, double et,
    double* out);
```

`ssb_body_coordinates` converts `n × 3` points to `n × 3`
(longitude radians, latitude radians, third value). The origin returns
(0, 0, 0) in every applicable system. Planetographic longitude is east for
Earth and the Moon, and otherwise opposite the sign of BODY*_PM[1],
using the same longitude-sense helper as the observer export. The sense
metadata remains defined for every applicable system, including the Sun
(+1 east).

`ssb_body_surface_points` converts `n × 2` system angles to `n × 2`
PLANETODETIC angles on the PCK triaxial surface for drawing grids. System 0
is the identity. Systems 1, 3, 4, and 5 use the center ray in the requested
system, transformed back to the body's frame. System 2 starts at
`Q = pgrrec(lon, lat, 0)` on the reference spheroid (a, a, c), follows its
outward normal `N`, and intersects the line `P(h) = Q + h N` with the PCK
triaxial ellipsoid. With triaxial radii `r = (a, b, c)`, solve
`A h^2 + 2 B h + C = 0`, where
`A = sum(N_i^2 / r_i^2)`, `B = sum(Q_i N_i / r_i^2)`, and
`C = sum(Q_i^2 / r_i^2) - 1`. The intersection with the smallest absolute
altitude `h` supplies the returned planetodetic longitude and latitude.
A line without a real intersection returns `ErrBadArgument` (-12).

PLANETOGRAPHIC follows the module's IAU WGCCRE policy: `src/bodies.hpp`
is authoritative for body kind and immediate parent. A body must be a
`KindPlanet`, or a `KindMoon` whose parent is a `KindPlanet`. Stars, dwarf
planets, asteroids, comets, their moons, and bodies outside the table return
`ErrBadArgument` from all three new coordinate exports for system 2. This
excludes the Sun, Pluto, Charon, Ceres, Vesta, Eros, Itokawa, Bennu, and Ryugu.
Small bodies and dwarf planets use east-positive, right-hand-rule
PLANETOCENTRIC coordinates; PLANETODETIC remains available for any loaded
PCK ellipsoid. The existing observer export retains its prior behavior.

A planetary moon's normal line may have no real intersection with its
triaxial surface; that input returns `ErrBadArgument`. The E2E reports the
body, epoch, longitude, and latitude of every rejected surface input and
retains the strict `recpgr` roundtrip check for applicable systems.

`ssb_body_coordinate_info` writes three doubles: planetographic longitude
sense (+1 east, -1 west), whether the conversion depends on `et` (1 for
systems 3 and 4, otherwise 0), and whether the body's frame has a loaded
rotation model (1) or uses ICRF axes (0). An inapplicable pair returns
`ErrBadArgument` (-12); missing ephemeris or epoch coverage retains the
module's existing named error codes. Earth supports systems 0–2 in
IAU_EARTH; the host's WGS84 Earth handling is separate.

Stonyhurst subtracts the IAU_SUN longitude of the geometric Earth-center
state relative to the Sun, with no light time. Carrington adds
`BODY10_PM[1] * pi / (180 * 86400) * tau` to the IAU_SUN longitude, where
`tau = (Earth–Sun distance in meters - 695700000) / 299792458`.
This is light time to the nearest solar surface point, without aberration,
matching sunpy 6.0 `sun.L0(nearest_point=True)`. The radius 695700 km is the
IAU 2015 nominal solar radius, independent of the loaded PCK's surface radii.
MOON_ME → MOON_PA_DE440 uses `TKFRAME_31009` directly: the existing
ICRF → ME rotation is its transpose times ICRF → PA.

Sources: NASA/JPL NAIF CSPICE `reclat`, `recpgr`, `pgrrec`, `nearpt`,
`surfnm`, and `pxform`; the loaded `pck00011.tpc` and
`moon_de440_250416.tf`; Thompson (2006), A&A 449, 791–803,
[Coordinate systems for solar image data](https://doi.org/10.1051/0004-6361:20054262);
Prša et al. (2016), AJ 152, 41,
[IAU 2015 Resolution B3](https://doi.org/10.3847/0004-6256/152/2/41);
and sunpy 6.0.6's `HeliographicStonyhurst`, `HeliographicCarrington`, and
`sun.L0` implementations.

`tests/body_coordinates.e2e.test.mjs` is one offline E2E through the SDK's
in-process browser module harness (no browser process). Its isolated,
test-only Python oracle uses SpiceyPy/CSPICE and sunpy on the same kernel
files, including the OSIRIS-REx Bennu and Hayabusa2 Ryugu mission PCKs.
It checks all 33 table bodies plus Eros, Itokawa, Bennu, Ryugu, and the
rotation-free Psyche: 200 picked points and 200 grid coordinates per
applicable system at three epochs in 2020–2030. Angle bounds are 1e-9 rad against CSPICE and
1e-6 degree against sunpy; third values allow 1e-6 meter + 1e-12 of the
distance. The test prints measured worst errors for each body and system,
checks the applicability matrix through all three exports, and reports any
missing intersection or latitude mismatch. A separate CSPICE `pgrrec`
normal-line quadratic check verifies the specified root without suppressing
a strict roundtrip failure. Legacy byte comparisons are a separate one-time
verification and are not part of the committed E2E.

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
- `tests/observer_position.e2e.test.mjs`: 1383 cameras on every body of the
  table (0.2 to a million radii, the poles, the axes, the center, inside) and
  the Sun's out to 1e23 m against CSPICE N0067 on the same kernels: the regime
  CSPICE's distances call for, every time; worst body-grid angle 6.1e-11 rad
  (bound 2e-10), lengths within 1e-6 m + 1e-12 of the distance; ecliptic
  8.9e-16 rad and 4.1e-16 in au; Galactic 8.6 mas from CSPICE's FK4-based
  GALACTIC (the Hipparcos definition is held exactly at the pole and node).
- `tests/observer_state.e2e.test.mjs` (0.4.1): a camera at rest in the
  central body's frame adds omega x r up to the synchronous radius
  (GM / omega^2)^(1/3) and the synchronous orbit's speed beyond it: Earth's
  surface and GEO unchanged (1e-9), the Sun held at 72 km/s from 0.169 au, so
  the co-rotation aberration of any central body stays under 50" (it was
  0.08 c at 1e13 m from the Sun, and the planets slid tens of au across the
  screen while zooming out).
- `tests/moon-magnitude.e2e.test.mjs` (0.5.1): the recorded geocentric JPL
  Horizons APmag and S-T-O phase angle at 24 JD TT epochs across a lunation,
  using the DE440 excerpt and the module's Earth state as the observer.
  Bounds are 0.05 mag and 0.05 degree; every residual is printed, including
  any failures near new moon. Planet magnitudes must exactly equal the
  pre-change module outputs at the same epoch.
- `tests/parity.mjs`: `evaluate` byte-identical in browser, WasmEdge and
  Docker WasmEdge (`conformance/parity.json`).

## Credits

Ephemerides and orientation: NASA/JPL NAIF (DE440, Park et al. 2021; satellite
ephemerides of the JPL Solar System Dynamics group; sb441-n16). Rotation
models: Archinal et al. (2018), WGCCRE 2015. Planet magnitudes: Mallama &
Hilton (2018). Lunar phase function: Krisciunas & Schaefer (1991), PASP
103:1033, [A Model of the Brightness of Moonlight](https://doi.org/10.1086/132921):
`V = 0.21 + 5 log10(r d) + 0.026 |a| + 4e-9 a^4`, with phase angle `a`
in degrees, Sun-Moon distance `r` in au, and observer-Moon distance `d` in au.
The existing `V(1,0) = 0.21` normalization and distance terms are retained.
