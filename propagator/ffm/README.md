# @orbpro/plugin-ffm

## FFM (Full Force Model)

The canonical definition is [FFM.md](FFM.md), with machine-readable profile
[FFM-1](ffm-1.profile.json).

OrbPro FFM propagator plugin.

Implements a high-fidelity numerical orbit propagator accounting for full geopotential models, atmospheric drag, solar radiation pressure, and third-body perturbations. Compiled to WebAssembly for high-performance, cross-platform use.

## Atmosphere models (honest labeling)

| Model name | Status |
| --- | --- |
| `NRLMSISE00` | **Full model.** The real NRLMSISE-00 (Picone/Hedin/Drob, JGR 2002) via the public-domain Brodowski C port vendored in `third_party/nrlmsise00/`. Drag uses the gtd7d "effective mass density" (includes anomalous oxygen). Verified against the canonical 17-case output table shipped with the reference package. |
| `USSA1976` | **Full lower-atmosphere model (0-86 km geometric).** US Standard Atmosphere 1976 with the proper geopotential-altitude layer formulation. Above 86 km it hands off to the Vallado exponential table (documented in code). |
| `Exponential` | Piecewise-exponential model, Vallado *Fundamentals of Astrodynamics and Applications* 4th ed., Table 8-4. |
| `JB2008` | **Full model on the PRW execution path** (`ATMOSPHERE_MODEL` `JB2008`): Bowman et al. (AIAA 2008-6438), `lib/jb2008.h`, a port of Orekit 13.1's JB2008 equal to it to 2e-14 (`tests/atmosphere_ports.test.mjs`), driven by the `jb2008_indices` input. The resident ABI runs the same model (label 4) on drivers held for the arc, set by `plugin_set_jb2008_indices([F10, F10B, S10, S10B, M10, M10B, Y10, Y10B, DSTDTC], 9)`; selecting it before they are set returns `FFM_ERR_NOT_LOADED` (`tests/jb2008_abi.test.mjs`). `ForceModel::JB2008()` and `computeJB2008()` for direct C++ callers evaluate the same model. |
| `JacchiaRoberts` | **Full model on the PRW execution path** (`ATMOSPHERE_MODEL` `JACCHIA_ROBERTS`, a VCM's JACCHIA_70): Jacchia's static diffusion model as Roberts (1971) integrates it in closed form, the GTDS/GMAT "Jacchia-Roberts", with Jacchia 1971's constants (SR 332; SR 313's inflection temperature and 100 km composition differ); `lib/jacchia_roberts.h`, a port of NASA GMAT's density functions, bit for bit. Independently of GMAT, the diffusion equations integrated numerically from 90 km reproduce its closed forms to 1.6e-4, and with Jacchia's own arctangent temperature profile in place of Roberts' exponential fit agree within 4.3 % at 200 km and 2 % from 300 km (`tests/atmosphere_ports.test.mjs`). At equal exospheric temperature its density at 400-700 km is 2-3 times JB2008's. SatelliteToolbox.jl's `jr1971` example (2018-06-19 18:35 UT, 22 S 45 W, 700 km, F10.7 79/73.5, Kp 1.34) gives 9.68e-15 kg/m^3, 26 % below this port's 1.31e-14 although its exospheric temperature is 22 K higher; since the port reproduces the model's own equations, the difference is on SatelliteToolbox's side and is not pursued further. |
| `DTM2020` | **Simplified approximation only** — mimics the DTM2020 F30/Hp temperature response. NOT the published DTM2020 spherical-harmonic model. |
| `HarrisPriester` | Harris-Priester diurnal-bulge table (100-1000 km), with the apex taken from the Sun direction; outside the table the model declines and drag is zero. Selectable as `forces.dragModel` `HARRIS_PRIESTER` and the PRW `HARRIS_PRIESTER` family. |
| `MarsExponential` | **Mars only** (`ATMOSPHERE_MODEL` `MARS_EXPONENTIAL`, with `CENTRAL_BODY_NAIF_ID` 499): the banded exponential profile NASA GMAT R2026a ships (Vallado 8.6), turning with the planet; see [Planetary central bodies](#planetary-central-bodies-the-moon-and-mars). Asked for about another body it is refused. |
| `GOST2004` | Enum placeholder only; not implemented and not selectable. |

The typed PRW `ATMOSPHERE_REQUEST` operation exposes only the implemented models
(`NRLMSISE00`, `USSA1976`, `EXPONENTIAL`).

### Gravity field, Earth orientation and clock

The force set integrates GCRF. The Earth's fields are defined in Earth-fixed
axes, so each is evaluated at R r and its acceleration returned as R' a, where
R is the GCRF to Earth-fixed rotation:
- **With the `earth_orientation` input** (execution requests): ITRF from the
  supplied SDS `$EOP` rows, through the IAU 2006/2000A CIO-based chain of the
  vendored ERFA (`eraXy06` and `eraS06` with the rows' dX and dY,
  `eraC2ixys`, the Earth rotation angle from UT1, `eraPom00` polar motion).
  The rows are read and interpolated by `foundation/frames/src/eop_series.hpp`,
  the code foundation/frames uses, and must cover the arc. The CIP coordinates
  X, Y and the CIO locator s of the series are evaluated on whole hours of TT
  and interpolated linearly between them (within 0.02 mas of the series); the
  EOP's dX and dY, polar motion and the Earth rotation angle are evaluated at
  every call. The rotation is a function of time alone: a trajectory does not
  depend on the order in which the tables are queried.
- **Without it:** the ERFA classical IAU 1976/1980 chain, evaluated at every
  force call through `coords::Epoch`: TT for precession/nutation, UT1 = UTC
  for GAST, zero polar motion and no frame bias. Its difference from a CIO
  chain with EOP is a model/input budget, not an ERFA identity tolerance.

The same axes serve the density models and the co-rotating atmosphere (below).

Gravity selections of the PRW execution request:

| `GRAVITY_CHOICE` | Field |
| --- | --- |
| `POINT_MASS` | `GRAVITATIONAL_PARAMETER` only. |
| `J2_ONLY`, `J2_TO_J4` | The EGM2008 zonal field to degree 2 or 4 (order 0), in Earth-fixed axes. A degree or order with them is refused. |
| `SPHERICAL_HARMONICS`, `EGM2008` | The EGM2008 field to the stated `MAXIMUM_DEGREE` and `MAXIMUM_ORDER` (both required, degree 2-70), every coefficient included; the J flags are not consulted. Order above 0 requires `earth_orientation` (`eop-data-required`). |
| `EGM96` | The same evaluation of EGM96 (`lib/egm96_data.h`, degree 2-70, from NGA's `egm96_to360.ascii` via GMAT's `EGM96.cof`; `scripts/generate-egm96.mjs`; GM and radius as EGM2008's). |
| `GRGM660PRIM`, `MRO120F` | The Moon's and Mars's embedded fields, each only about its own body (`CENTRAL_BODY_NAIF_ID` 301 and 499); about the Earth they are refused. See [Planetary central bodies](#planetary-central-bodies-the-moon-and-mars). |

`MAXIMUM_TESSERAL_DEGREE` (with `SPHERICAL_HARMONICS`, `EGM2008`, `EGM96`)
drops the tesseral and sectorial terms (order >= 1) above that degree while the
zonals run to `MAXIMUM_DEGREE`: a VCM's "36Z,24T" is degree 36, order 24,
tesseral degree 24.
| `INFER_FLAGS` | The legacy flag-selected path (inline field to degree 20). |

The field is the embedded EGM2008 (`lib/egm2008_data.h`) through the
normalized Pines/Cunningham recursion (Montenbruck & Gill eq. 3.33), with
EGM2008's own constants: GM 3.986004415e14 m^3/s^2 (the TT-compatible value)
and radius 6378136.3 m. `GRAVITATIONAL_PARAMETER` sets the central term and
the field's GM its harmonics, as Orekit separates `NewtonianAttraction` from
`HolmesFeatherstoneAttractionModel`. Use 3.986004415e14: the
TCG-compatible 3.986004418e14 is 7.5e-10 larger, about 1 m a day along track
in LEO.

**Clock.** Execution requests integrate on TT, with epochs held as exact
two-part TT seconds from J2000. Request epochs may be `UTC`, `TAI`, `TT` or
`TDB` ISO strings; UTC goes through the leap-second table. The force path carries `timesys::Instant`, a two-part TT Julian date, through
integrator stages, Earth orientation, tides and ephemeris reads. Sun, Moon and
planet SPK reads use seconds past J2000 formed from the two-part TDB date.
TDB - TT retains FFM's two-term model evaluated in seconds; it is not ERFA's
full `eraDtdb` series. Single-double Julian dates label outputs only. Proper time on board is
not modeled; TT is the coordinate time the IAU 2000 conventions pair with
the TT-compatible GM.

### Drag frame and inputs

NRLMSISE-00, JB2008 and the DTM2020 stand-in take an Earth-fixed position.
Drag uses the field's Earth-fixed axes (above): ITRF from the
`earth_orientation` rows when supplied. The geodetic conversion is WGS84,
exact to a nanometer against ERFA `eraGc2gd`. Local solar time is the mean
solar time the model was fitted with, UT + longitude/15 (the reference
driver's `stl = sec/3600 + glong/15`, and Orekit's default from 14.0).
Relative velocity is `v - omega x r` with omega along the same axes' pole.
With these, FFM's density equals Orekit 13.1's NRLMSISE-00 to 1e-8 at the
same points. Direct C++ callers of the drag functions that pass no axes get
GMST about the GCRF z axis.

Space-weather inputs follow the NRLMSISE-00 package definitions
(`third_party/nrlmsise00/nrlmsise-00.h`): `F107` is the **observed** flux (at
the Earth's distance, not adjusted to 1 AU) of the day before the epoch,
`F107a` the observed 81-day centered mean, and `Ap` the daily index. FFM
evaluates NRLMSISE-00 with the daily Ap only (switch 9 = 1).

Horizontal winds come from HWM14 (Drob et al. 2015; NRL release
HWM14.123114, ported bit-exact to C++ in `third_party/hwm14`). With
`includeWinds` the air velocity is `omega x r` plus the HWM14 wind, evaluated
at the geodetic latitude, longitude and height of the Earth-fixed position (the
same axes as the density) and rotated back to GCRF; every drag model and
`computeDragAcceleration` use it. HWM14 winds are horizontal only.

- `windDisturbance` (default on) adds the DWM07 storm-time winds, which need
  the 3-hour Kp of the epoch in `SpaceWeatherData.kp3h`: PRW `KP_INDEX`, an
  explicit JSON `Kp`, or `ap_a[1]` of `plugin_set_solar_activity` through
  HWM14's ap-to-Kp table. `plugin_set_solar_activity_from_prediction` puts the
  predicted daily Ap in `ap_a[1]`, so predicted winds use the daily value.
  Direct C++ calls without a Kp throw `std::invalid_argument`; they are never
  given a default.
- `plugin_set_drag_options(includeWinds, coRotating)`: `includeWinds` 0 off,
  1 total winds, 2 quiet time only; other values return `FFM_ERR_BAD_ARGUMENT`.
  Mode 1 is quiet time while `ap_a[1]` is negative or unset, which is HWM14's
  own convention for a negative ap, so the order of the two setters does not
  matter.
- `get_wind` / `atmosphere_get_wind` return the HWM14 wind (north, east;
  down 0) with the supplied solar activity's `Ap[1]`, and refuse with
  `ATMOSPHERE_ERROR_NOT_INITIALIZED` until solar activity is supplied.
- The analytic STM still refuses winds (their position gradient is not
  analytic here); select the finite-difference STM.

### Published open-DCA density correction

`invoke` execution requests and configured `ingest_state` accept an optional
`density_correction` port carrying the published SDS 1.259.0 `$DCL` record.
The calibration must be `Solved`, name `NRLMSIS00E`, and use
`CORRECTION.FORM = LogDensityNodes`. `NODE_TIMES_MS` are strictly increasing
UTC Unix milliseconds; `NODE_LOG_DENSITY_SCALE_DIMENSIONLESS` contains one
finite dimensionless value per node. Temperature, altitude and harmonic
arrays must be empty. Invalid records fail with `invalid-density-correction`;
using a correction with another atmosphere or disabled drag is refused.

Drag density is NRLMSISE-00 density times `exp(s(t))`. The module linearly
interpolates the published log-density nodes in UTC, holds their endpoint
values outside the span, and applies no additional forecast decay. The same
factor enters the analytic density gradient and ballistic sensitivities.
Absent and all-zero corrections use identical forces and integration steps.
Changes in the node slope form integration boundaries.

The catalog bootstrap accepts a size-prefixed `$DCL` frame alongside its
size-prefixed PRW configuration/environment frames. The SDK port accepts
ordinary or size-prefixed DCL. `plugin_catalog_drag_acceleration(utcJd, slot,
statePtr, outPtr)` diagnoses the configured object's drag at a supplied GCRF
state (six SI doubles), returning three m/s² values without advancing it.

### Radiation pressure

Cannonball radiation pressure uses IAU 2015 Resolution B3's nominal solar
irradiance, 1361 W/m^2 over c at 1 au, scaled by the inverse square of the
Sun distance. The Earth's shadow is conical, with the visible fraction of the
solar disk from the overlap of the apparent disks (Montenbruck & Gill
eqs. 3.85-3.87; Sun radius 695 700 km, IAU 2015 B3), evaluated as two
circular segments so that it keeps its digits (`lib/shadow.h`, shared with
the analytic partials). It equals Orekit 13.1's lighting ratio to 6e-10.

The visible fraction has a kink at each penumbra boundary. The adaptive
integrators (RKF45, RK78/RKF78, RKDP87, BS and the variational integrator)
end a step on each boundary they would cross: the umbra and penumbra edges
are switching functions of the state, a step across one is shortened by the
secant until it ends within 1 ms past it, and the next step resumes at the
size proposed before (`lib/shadow_events.h`), as Orekit's eclipse detectors
do. Radiation pressure therefore needs no special step limit or tolerance:
against Orekit, LEO with radiation pressure and drag at RK78 1e-13 and 300 s
steps is within 2.5 cm after a day with samples and 3.1 cm for the final
epoch alone, which is FFM's own integration error at those steps; with
steps of 30 s it is within 4.2 mm (Agreement with Orekit 13.1, below).
RK4 steps at its fixed size.

#### GNSS box-wing and ECOM2 (`lib/gnss_srp.h`)

Two GNSS radiation-pressure models sit beside the cannonball, under the same
conical shadow:

- **GPS box-wing a priori**: the flat-plate model of Rodriguez-Solano,
  Hugentobler and Steigenberger (2012), "Adjustable box-wing model for solar
  radiation pressure impacting GPS satellites", Adv. Space Res. 49(7),
  doi:10.1016/j.asr.2012.01.016: eq. (6) for the solar arrays, eq. (9) (the
  absorbed energy re-emitted at once as Lambertian heat) for the bus. The
  surfaces are Rodriguez-Solano (2014), *Impact of non-conservative force
  modeling on GNSS satellite orbits and global solutions*, dissertation, TU
  Munich, Appendix Tables 5.4 (GPS IIR, also used for IIR-M) and 5.5 (GPS
  IIF). Attitude is nominal yaw steering (+Z to the Earth, Y = unit(s x r),
  arrays turned about Y to the Sun); the eclipse-season noon and midnight
  turns are not modeled. GPS III has no published box-wing surface set that
  could be checked, so none is provided.
- **ECOM2**: CODE's extended empirical model, Arnold et al. (2015), "CODE's
  new solar radiation pressure model for GNSS orbit determination", J. Geod.
  89:775-791, doi:10.1007/s00190-015-0814-4, eqs. (1), (2) and (5): D0, Y0,
  B0 and the cosine and sine terms of orders 2 and 4 in D and 1 and 3 in B,
  in m/s^2, with the angle du = u - u_sun from the Sun in the orbital plane.
  It is added to whichever a priori model is selected (a cannonball with Cr 0
  for ECOM2 alone) and scaled by the visible fraction of the Sun. Its eleven
  coefficients are dynamic parameters (`ForceModel::DynamicParameter::Ecom2*`)
  with analytic STM sensitivities, so a batch fit can estimate them.

Both have analytic position and velocity partials (the same generic
evaluation through dual numbers). Against Orekit 13.1
(`tests/gnss_srp.test.mjs`, `tests/fixtures/orekit/OrekitGnssSrpReference.java`:
`BoxAndSolarArraySpacecraft` under `GPSBlockIIF`/`GPSBlockIIR` attitude, and
`ECOM2`): accelerations agree to 1e-10 relative, 24 h trajectories to 0.6 mm
(through eclipses included), the STM to 4e-8 and the ECOM2 sensitivities to
1.6e-9 relative. The masses come from the IGS satellite metadata SINEX
(Steigenberger and Montenbruck 2024, doi:10.57677/metadata-sinex) in use.

GPS prediction accuracy on E3's test window (orbit-accuracy-experiments,
2026-09-07..26, 32 GPS satellites, 636 issues; FFM from the ESA ultra-rapid
orbit, scored against ESA final orbits; median 3D error with E3's two-way
object x day bootstrap 95 % interval; `tests/gps-srp-accuracy-*.mjs`,
`tests/gps_srp_accuracy_native.cpp`, results in
`tests/evidence/gps-srp-accuracy/score-test-window.json`):

| Variant | 1 d | 3 d | 7 d |
| --- | ---: | ---: | ---: |
| A: E3 as run (cannonball 1500 kg, 20 m^2, Cr 1.3, URA state at T) | 29.8 m [21.0, 44.6] | 102 m [78, 142] | 336 m [258, 417] |
| B: A with the box-wing a priori (IIR, IIR-M, IIF) | 12.9 m [10.1, 16.6] | 46.4 m [36.4, 57.5] | 168 m [126, 218] |
| C: cannonball, state and Cr*A/m fitted to the URA observed day | 8.1 m [3.7, 11.4] | 37.0 m [17.7, 52.2] | 160 m [81, 234] |
| D: box-wing + ECOM2 D2B1, state and 7 coefficients fitted | 0.7 m [0.5, 0.9] | 3.0 m [2.3, 4.0] | 13.8 m [10.5, 17.9] |
| E: ECOM2 D2B1 alone, fitted | 0.7 m [0.5, 0.9] | 3.1 m [2.2, 4.1] | 14.1 m [11.0, 18.7] |

Variant A reproduces E3's published FFM-URA errors to 3 mm. The fitted
ECOM2 does the work; with it, the box-wing a priori changes nothing
measurable over a one-day fit arc (D/E 0.96-1.01, intervals across 1).

On the PRW request (SDS 1.241.0), `FORCES.RADIATION_PRESSURE_MODEL` selects
`CANNONBALL` (the default; `REFLECTIVITY_COEFFICIENT` and `AREA_M2`),
`GNSS_BOX_WING` (with `GNSS_BLOCK` `GPS_IIR`, `GPS_IIR_M` or `GPS_IIF`, at the
dynamical mass) or `NONE`; `FORCES.ECOM2` (`PCFEcom2`, m/s^2) adds ECOM2 to
any of them, and `DYNAMIC_PARAMETERS` `ECOM2_D0` .. `ECOM2_B3_SIN` carry its
coefficients in the STM and covariance. All of these need `ENABLE_SRP`;
`GNSS_BLOCK` applies to the box-wing only and `SRP_AREA_OVER_MASS` to the
cannonball only. `tests/prw_gnss_srp.test.mjs` runs the four Orekit cases
above through the request: trajectories within 0.3 mm, the STM to 3.5e-12
and the ECOM2 columns to 1.6e-9 (measured); `tests/prw-gnss-parity.mjs` is
their tri-runtime receipt.

#### Earth radiation pressure: albedo and infrared (`lib/earth_radiation.h`)

The sunlight the Earth reflects and the infrared it emits push on the
spacecraft as on an isotropic (cannonball) body: Knocke, Ries and Tapley
(1988), "Earth radiation pressure effects on satellites", AIAA paper 88-4292,
ported from Orekit 13.1's `KnockeRediffusedForceModel` with its constants
(albedo 0.34 + 0.10 cos(annual) P1 + 0.29 P2, emissivity 0.68 - 0.07
cos(annual) P1 - 0.18 P2 of sin(latitude), annual phase from 1981-12-22,
4.5606e-6 N/m^2 at 1 au), the same surface elements (a central cap and
crowns of angular size `resolution`, default 15 degrees, out to the horizon,
on the 6378.137 km sphere) and the flux per element. The acceleration is
Cr*A/m times the summed pressure. One template serves the integrator and the
analytic STM.

On the PRW request (SDS 1.243.0), `FORCES.EARTH_RADIATION` `KNOCKE` selects
it, `EARTH_RADIATION_RESOLUTION_DEG` the element size (1 to 45 degrees), and
`EARTH_RADIATION_AREA_OVER_MASS_M2_KG` (with its `HAS_` flag) its own Cr*A/m.
Without one it uses the cannonball's `REFLECTIVITY_COEFFICIENT` *
`AREA_M2` / `INITIAL_MASS_KG`, and a fitted `SRP_AREA_OVER_MASS` then scales
both (its STM column includes the Earth radiation); a GNSS box-wing request
must state the coefficient.

### Ocean tides (`OceanTideField`, `lib/fes2004_data.h`)

IERS Conventions (2010) section 6.3 with the FES2004 model: the variations
of the normalized Stokes coefficients of its 18 waves (the IERS file
`fes2004_Cnm-Snm.dat`, SHA-256 620dc48f..., embedded to degree and order 50
by `scripts/generate-fes2004.mjs`, coefficients stored as float, under 6e-8 of
each), at their Doodson arguments (GMST + pi from UT1 and the IERS 2010
Delaunay arguments, as the solid tides), summed from degree 2 as Orekit 13.1's
`OceanTidesField` does, without the ocean pole tide, and evaluated in the
force set's Earth-fixed axes like the solid tides. The field's position
partials go into the analytic STM.

On the PRW request (SDS 1.243.0), `FORCES.OCEAN_TIDES` `FES2004` selects it,
with `OCEAN_TIDE_MAXIMUM_DEGREE` and `OCEAN_TIDE_MAXIMUM_ORDER` (default 30,
at most 50); like the solid tides it needs `earth_orientation`.

Against Orekit 13.1 (`tests/orekit_reference.test.mjs`, cases A1, O1, O2 and
C2): after a day, Earth radiation on top of F5 agrees to 18.9 mm in LEO and
0.15 mm at GPS, the effect being 104 m and 0.22 m; FES2004 30x30 on top of F4
to 18.1 mm and 0.15 mm, on effects of 1.9 m and 0.18 m. Those totals are the
common integration difference (1.3 mm and 0.17 mm with steps of 30 s); taken
as (FFM with - without) - (Orekit with - without), the forces agree to
0.22 mm (Earth radiation) and 0.08 mm (FES2004) in LEO and 0.003 mm and
0.001 mm at GPS, and with steps of 30 s to 0.04 mm and 0.004 mm in LEO. With
both forces, the solid tides and the STM, the STM agrees to 1.8e-5 (LEO) and
1.6e-11 (GPS), and the SRP_AREA_OVER_MASS column to 2.7e-5 and 8.9e-9.

## Installation

```bash
npm install @orbpro/plugin-ffm
```

This package is intended to be used within an OrbPro workspace or alongside the OrbPro engine. Standalone use requires the module SDK.

## Building

Build the canonical browser/WasmEdge artifact with the repo-local toolchain:

```bash
npm ci
PATH="$HOME/.wasmedge/bin:$PATH" node build.mjs
```

Artifacts:

- `dist/isomorphic/module.wasm`
- `dist/browser/module.js`
- `dist/browser/module.wasm`

### Runtime notes

- WasmEdge 0.16 (interpreter): a C++ exception thrown and caught inside the module leaves the module's `free` looping afterwards (V8 is unaffected), so module errors are returned or flagged, never thrown across a call.

## Portable PRW contract (SDS 1.240.0)

Every advertised method consumes size-prefixed `$PRW` records through the SDK
PIV/TAB invoke envelope. The module builds through `compileModuleFromSource` for
`wasm32-wasip1-threads`, `threadModel: "wasi-sequential"`: one resident instance
performs ordered catalog/cache mutations and one invocation at a time. The
artifact uses shared memory; browser hosts need cross-origin isolation.

| Method | Request arm | Response arm |
| --- | --- | --- |
| `invoke` | `EXECUTION_REQUEST`, `EPHEMERIS_REQUEST`, `ATMOSPHERE_REQUEST`, or `VERSION_QUERY` | Matching result arm |
| `ingest_state` | `RESIDENT_STATE` (1–1024 input records), `EXECUTION_REQUEST` on `configuration`, and the kernel and environment records | No scientific output |
| `ingest_state_gravity_only` | `RESIDENT_STATE` (1–1024 input records) | No scientific output |
| `propagate_state` | `RESIDENT_REQUEST` | `RESIDENT_STATE` |
| `prepare_trajectory_segments` | `PREPARE_REQUEST` | `PREPARE_RESULT` |
| `describe_trajectory_segments` | `DESCRIBE_REQUEST` | `DESCRIBE_RESULT` containing PPE |

Each PRW record must populate exactly one payload arm. A supplied `invoke.kernel`
contains `NATIVE_INPUT`, including the NCD descriptor and checked SPK bytes.
The optional environment inputs of `invoke` are PRW records too (SDS 1.240.0):
`earth_orientation` the `EARTH_ORIENTATION` arm (SDS `$EOP` rows, up to 366
ordered daily rows covering the arc; see
[Gravity field, Earth orientation and clock](#gravity-field-earth-orientation-and-clock)),
`space_weather` the `SPACE_WEATHER` arm (daily `$SPW` rows) and
`jb2008_indices` the `JB2008_INDICES` arm. Public ports do not accept the
historical JSON or private pointer envelopes.

### The end of a trajectory: reentry

A propagation ends where the trajectory descends below 100 km geodetic
altitude (the Karman line, `lib/reentry.h`). Below it the object is
reentering: a cannonball with a fixed drag coefficient no longer describes
its flight, and integrated further the trajectory reaches the Earth's
interior, where the gravity field diverges. A non-finite state ends it too.

- **Every path.** The state, the transition matrix and finite burns test each
  state their integrator evaluates; the first one below the line ends the
  integration there (the derivative is zero from then on and the RKF78 run
  takes no further step), so the execution path and a resident object stop
  at the same epoch.
- **The error.** `reentry` (or `invalid-state`) with the UTC epoch and the
  height, and on the resident path the object (its handle, OBJECT_ID and
  catalog number), as in the test: `reentry: handle 1 (object-1, catalog 1):
  the trajectory descends below 100 km geodetic altitude (99.5 km) at
  2026-08-02T01:23:07.517546117 UTC; FFM ends it there.` A resident object
  stays queryable before that epoch.
- **The height** is taken about the GCRF pole, within about 0.2 km of the
  Earth-fixed geodetic height (the CIP's offset from the GCRF pole), so the
  test needs no Earth orientation.
- **A flag, not an exception** (see [Runtime notes](#runtime-notes)): the
  integrators and the PRW methods check the recorded stop.

Tests: `tests/reentry.test.mjs` (a 140 km orbit with Cd*A/m 0.02 m²/kg reenters
about 1.4 h after its epoch; both paths report the same epoch; another object
and the decaying one before its reentry stay preparable) and the
`configured-reentry` group of `tests/prw-resident-parity.mjs`, which checks
stop bytes across the headless browser and WasmEdge lanes.
Current receipt availability is recorded under [Verification](#verification).

### VCM parity (SDS 1.240.0)

Everything a Vector Covariance Message carries for propagation has a PRW
field and an implementation checked against Orekit 13.1 or GMAT
(`tests/orekit_reference.test.mjs`, measured values in its header):

- **States in EME2000** (`MEAN_EQUATOR_EQUINOX_J2000` axes, a VCM's "J2K"):
  rotated by the IAU 2000 frame bias (`eraBp00`) on the way in and out,
  with covariances, STMs, impulses and inertial burn directions.
- **Geopotential** EGM96 or EGM2008 with "mmZ,nnT" truncation (above).
- **Drag** NRLMSISE-00, JB2008 (`jb2008_indices`) or Jacchia-Roberts (WEATHER
  or `space_weather`; F10.7 of the previous day and its 81-day centered
  average, Kp 6.7 h earlier); `DRAG_AREA_OVER_MASS_RATE_M2_KG_S` is BDOT,
  Cd*A/m growing linearly from the initial epoch.
- **Daily space weather** (`space_weather`): NRLMSISE-00 reads the previous
  day's observed F10.7, the day's centered average, the daily Ap and the
  three-hour Kp, as Orekit's `CssiSpaceWeatherData` reads them.
- **JB2008 drivers** (`jb2008_indices`): SOLFSMY values at 12 UT of DATE
  interpolated linearly at the instant less JB2008's lags (1 day F10 and S10,
  2 M10, 5 Y10), DSTDTC between hours, as Orekit's
  `JB2008SpaceEnvironmentData`.
- **Solid Earth tides** `SOLID_TIDES` `IERS_2010`: IERS Conventions 2010
  section 6.2 steps 1 and 2 (`lib/iers2010_tides.h`), tide-free field.
- **Relativity** `RELATIVITY` `SCHWARZSCHILD` or `IERS_2010` (with
  Lense-Thirring about the Earth-fixed pole, |J| = 9.8e8 m^2/s, and de
  Sitter). Orekit 13.1's `DeSitterRelativity` evaluates the Earth in the
  Sun's IAU-pole frame against a GCRF velocity; the oracle uses eq. 10.12
  with consistent frames.
- **In-track thrust** `IN_TRACK_ACCELERATION_M_S2`: constant along N x rhat.
- **Covariance with model parameters** `DYNAMIC_PARAMETERS`: Cd*A/m (B), its
  rate (BDOT), Cr*A/m (AGOM) and the in-track acceleration (T) appended to
  the STM ([[Phi, S], [0, I]]) and to `INITIAL_COVARIANCE` and the propagated
  covariances, SI units; S is integrated with the state (ANALYTIC) or by
  central differences of the force set (FINITE_DIFFERENCE). Against Orekit's
  Jacobians: STM 1e-5 (LEO) to 4e-11 (GPS), B/BDOT/T 5e-6, AGOM 1.4e-4 in
  LEO and 5e-10 at GPS.
- **Samples** are visited in time order, forward and backward of the initial
  epoch separately, and each span between consecutive epochs is integrated
  once; the state, the STM (with parameter columns) and the covariance carry
  from one sample to the next, so a day of hourly samples costs about one day
  of integration rather than 25 (about ten times faster for LEO). Each
  sample's STM and covariance still refer to the initial epoch. A sample
  agrees with a request for its epoch alone to the integration tolerance
  (3 mm after a day in LEO, `tests/prw_sequence.test.mjs`). Finite burns,
  whose burn state runs along the arc, still integrate each epoch from the
  initial state.

`analysis/vcm-adapter` reads a VCM into this request: its equinoctial
covariance transformed exactly to Cartesian with the B, BDOT, AGOM and T rows
as `DYNAMIC_PARAMETERS`, and its single EOP point as daily
`EARTH_ORIENTATION` rows; it also writes a result back as a VCM. Integrator
settings, EDR and the weighted RMS are not propagation inputs.

### Resident states and handles

Use the SDK **direct** invoke surface with a persistent instance for resident
methods. The SDK command test harness creates an instance per invocation and
therefore does not retain a catalog between calls.

`ingest_state` and `ingest_state_gravity_only` atomically replace the catalog.
Every record supplies the same `PRWInstance`: `MODULE_ID="com.orbpro.ffm"`, a
nonempty host-assigned unique `INSTANCE_ID`, and `GENERATION`. Reingest of a
previously seen instance identity requires a strictly larger generation.
`ENTITY_HANDLE` values are supplied by the caller and must be unique; output
preserves handles, object IDs, and catalog numbers. Handles are instance-scoped
and must not be persisted as object identity. The host must choose a new
instance ID after replacing the actual WASM instance. Configuration changes,
diagnostic catalog replacement, and burn/cache-grid mutations invalidate
portable queries until a new generation is ingested.

PRW state position and velocity use SI meters and meters/second. Input must be
Cartesian FRM state with explicit ISO epoch, `UTC`, `TT` or `TDB`, and a
resolving RFM coordinate-system name. This profile accepts Earth-centered (NAIF
399) ICRF axes and reports them as **GCRF**. Other origins and axes fail.
Earth-fixed/TEME requests fail with `eop-data-required`. There is no silent
frame fallback. `VALID=false` is retained on ingest and fails with
`invalid-state` when selected for propagation or trajectory export. Empty
selection means all rows; duplicate and unknown handles fail explicitly.
`MAXIMUM_COUNT` limits the requested prefix while preserving its order.

#### Configured profile (`ingest_state`)

The `configuration` port carries one PRW `EXECUTION_REQUEST`: the dynamics of
every resident object. It is validated as an execution request, with the
`kernel`, `earth_orientation`, `space_weather` and `jb2008_indices` records on
the same call, which the instance verifies once (the kernel by SHA-256) and keeps
until the next ingest. Its `INITIAL` and `TARGET_EPOCH` are placeholders: each
resident object is that request with its own state, and each query supplies
the epoch. Each object may carry `MASS_KG` (the dynamical mass, as
`INITIAL.MASS_KG` of an execution request), `DRAG_AREA_OVER_MASS_M2_KG`
(Cd*A/m, which needs drag in the configuration) and `SRP_AREA_OVER_MASS_M2_KG`
(Cr*A/m, which needs cannonball radiation pressure); they replace the
configuration's spacecraft for that object. `catalog.mjs` writes the full force
configuration (the orbit-determination fits' force set) and these records.
Element sets: the module converts B* (1/earth radii) to Cd*A/m with
`plugin_drag_area_over_mass_from_bstar(bstar, nonPositive)`, B = 2 B* / rho0
with rho0 = 2.461e-5 XKMPER kg/m^2/ER (Hoots and Roehrich, Spacetrack Report
No. 3, 1980, sections 8 and 9; the report's RHO = 0.15696615), and returns
`nonPositive` for a B* of zero or below (`tests/ballistic_coefficient.test.mjs`).
`catalog.mjs` states the two assumptions it passes: 0.01 m^2/kg for those
objects and Cr*A/m 0.02 m^2/kg for every object, the fits' a priori values.

Each object is integrated from its epoch, forward and backward as queries need,
with exactly the steps an execution request for that object takes: the same
RK78 run, restarted only where the execution path restarts it (the space
weather's daily and three-hourly changes), never at query or export epochs.
Between accepted steps the state comes from a dense output: Hermite
interpolation of position, velocity and the acceleration the integrator
evaluated at four accepted steps (the nearest at least half a step away on
each side, inside one span and one stretch between shadow boundaries).

Refused with a named error (`configuration-required` when the port is
missing, `unsupported-configuration`, `unsupported-integrator`):
- a configuration with STM, covariance, samples, impulses, finite burns, mass
  dynamics, dynamic parameters or process noise (those are per-request);
- an integrator other than RK78 or RKF78;
- Cd*A/m without drag, Cr*A/m without cannonball radiation pressure, and a
  per-object Cd*A/m rate or in-track acceleration;
- epochs outside the environment records or the kernel (`space-weather-out-of-range`,
  `invalid-earth-orientation`, `ephemeris-failed`), when the integration
  reaches them.

Tests (`tests/prw_resident_configured.test.mjs`), with the full force model
and the catalog integrator (RK78, 1e-12, 300 s): one resident instance holding
LEO 400 km, GPS, GEO and Molniya orbits against the execution path, request by
request, at eleven epochs from one day before to three days after the epoch,
on and between restarts: largest difference 0.052 mm (LEO), 8.9 µm
(Molniya), 9 nm (GPS, GEO).

#### Gravity-only profile (`ingest_state_gravity_only`)

The point mass and the built-in degree/order 20 field (built-in Earth
orientation; no Sun, Moon, drag, radiation pressure or tides), RK78
60/0.01/600 s at 1e-12, with Chebyshev segments fitted at their nodes from
restarted integrations. It is not full force and is never selected by
default. Mass, coefficients and per-object gravitational parameters fail with
`unsupported-configuration`. Its trajectories are named
`com.orbpro.ffm@1.4.0 gravity-only`.

### Covariance and process noise

A propagated covariance is `P(t) = Phi P0 Phi^T + Q`, and the record states the
`Q` it includes (`PRWProcessNoise`, SDS 1.232.0).

- **Resident states.** `ingest_state` takes a six-state `COVARIANCE` (SI;
  finite, symmetric, positive semidefinite) and optional `PROCESS_NOISE` per
  object. Noise without a covariance fails with `invalid-process-noise`.
- **Resident output.** `propagate_state` returns each such object's
  `COVARIANCE` at the target epoch and echoes the `PROCESS_NOISE` it includes.
  The configured profile integrates the state and its transition matrix from
  the object's epoch with the configuration's dynamics, STM technique and
  density treatment, as an execution request with this `INITIAL_COVARIANCE`
  and `PROCESS_NOISE` does (the state returned with it is that integration's).
  The gravity-only profile uses its own force model and integrator with the
  analytic STM. Objects with scheduled burns refuse covariance
  (`unsupported-configuration`); use the execution request.
- **Execution requests.** `INITIAL_COVARIANCE` with `PROCESS_NOISE` returns
  `FINAL_SAMPLE` and `SAMPLES` covariance including `Q`, and the same
  `PROCESS_NOISE`. Noise needs a six-state covariance without mass dynamics.
- **`WHITE_ACCELERATION`.** Zero-mean white acceleration noise (state noise
  compensation).
  - **Inputs:** a spectral density per axis (m²/s³), inertial or radial,
    transverse and normal axes, and `DISCRETIZATION_SECONDS`.
  - **Steps:** the arc is cut into equal steps no longer than
    `DISCRETIZATION_SECONDS`. Each step's STM carries P, and the step adds
    `q [[h³/3, h²/2], [h²/2, h]]` per axis at its end (RTN axes from the state
    there).
  - **No noise:** this is the single-integration `Phi P0 Phi^T`.

Tests (`tests/prw_covariance.test.mjs`):
- the resident covariance against a finite-difference STM of 13 resident
  trajectories;
- the added `Q` on both paths;
- short-arc `Q` against the kinematic closed form;
- the refusals.

### Trajectory export and continuation

The supported profiles are empty/default and `conjunction-screening`.
`CATALOG_HANDLE=0` selects the current resident catalog; other values fail.
The finite nonnegative preparation duration is limited to 1,227,600 seconds.
Segment handles never wrap or reset on reingest.

PPE contains 13 Chebyshev coefficients per axis (degree 12), explicit velocity
coefficients, the midpoint and half-span of each segment, Earth GCRF, and km
and km/s.

- **Configured profile.** Segments of 300 s of TT from each object's epoch,
  labeled on TT (exact; a TDB label would carry the TDB - TT model). They are
  fitted at their Gauss-Lobatto nodes from the dense output. A degree-12
  series resolves about four cycles over its span, so 300 s keeps the terms of
  a 70x70 field in LEO (periods down to about 80 s); 600 s leaves the terms
  above degree 35 to the fit's error, centimeters. Each segment's
  `PRWFitQuality` is `SAMPLED_RESIDUAL`: its largest difference from the
  integrator's accepted states inside it; the prepare result carries the
  largest over the set. The method is stated once per source (the PPE
  comment) and in the prepare result's quality, not in each segment's
  record: a segment is about 0.8 KB, a day about 236 KB per object.
  `EPHEMERIS_SOURCE` is `com.orbpro.ffm@1.4.0`.
  Measured (`tests/prw_resident_configured.test.mjs`, four days, PPE
  evaluated every 61 s): within 0.31 mm of the dense output in LEO and 0.18 mm
  for Molniya (GPS and GEO under 0.1 µm); within 0.08 mm of the execution path;
  reported residuals 0.32 mm (LEO) and 0.17 mm (Molniya).
- **Gravity-only profile.** Segments of 600 s on TDB, fitted from restarted
  integrations, with `PRWFitQuality.EVIDENCE_KIND=UNMEASURED` and both bound
  availability flags false. No zero-error certification is claimed. Published
  PPE residual scalars have no availability flag: they are omitted and
  accompanied by a comment directing consumers to PRW quality; their decoded
  default zero must not be interpreted as a measurement.

Exports move forward window by window: segments that end before a prepared
window are dropped, and an earlier window is fitted again from the object's
epoch. Each resident batch chunk returns one state; each describe chunk returns
one whole source (never part of a coefficient vector), with `SOURCE_OFFSET` and
`FINAL_CHUNK`. A response with `YIELDED=true` and positive `BACKLOG_REMAINING`
requires resubmitting the same PRW request bytes to obtain the next chunk.
One ordered continuation is active per module instance; a different request
restarts selection.

#### Catalog cost

One worker thread (Node.js, Mac Studio M3 Ultra shared with other work, load
12-15 on 28 cores), stride samples of the 2026-09-30 public catalog from each
element set's epoch through 6 h of 2 h windows, in milliseconds per object-day
(catch-up included):

| Profile | All | Perigee below 2,000 km | Perigee above 2,000 km |
| --- | ---: | ---: | ---: |
| Configured, full force, RK78 1e-12, 300 s | 645 | 692 | 190 |
| Gravity-only | 49 | 49 | 48 |

The tolerance: at 1e-12 the integration's own error after three days is
0.1 m (LEO 400 km) to 1.2 m (SSO 700 km) and 0.18 m (Molniya), measured
against 1e-14; it is 6-9 m in LEO at 1e-11 and 46-157 m at 1e-10. A
conjunction screen needs meter-level positions; 1e-12 keeps the integration
there and costs a fifth to a quarter more than 1e-11 in LEO.

## Planetary central bodies: the Moon and Mars

`PCFForceModel.CENTRAL_BODY_NAIF_ID` 301 (the Moon) or 499 (Mars) makes the request fly about that body. The state's origin
is the central body, its axes ICRF (or EME2000), and the `kernel` input is the DE440 short kernel
(`EPHEMERIS_SOURCE` `JPL_SPK`; `Analytical` is refused). Positions of the Sun, the Earth, the Moon and the planets are the
kernel's, relative to the central body; the third bodies are point masses (GM from DE440). The trajectory ends where it
reaches the body's surface sphere (`impact`). Only the state, its samples and its events are propagated: the transition
matrix, covariance, impulses, finite burns, dynamic parameters and process noise are the Earth's and are refused by name.

| | Moon | Mars |
| --- | --- | --- |
| Field | `GRAVITY_CHOICE` `GRGM660PRIM`, degree 2 to 150: GRGM660PRIM (Lemoine et al. 2013; 660 in the PDS table, 150 embedded; a higher degree is refused by name, `unsupported-gravity`), fully normalized, R 1738.0 km, GM 4902.7998069317 km^3/s^2 in its harmonics | `GRAVITY_CHOICE` `MRO120F`, degree 2 to 120: MRO120F (Konopliv et al. 2020), R 3396.0 km, GM 42828.375663957 km^3/s^2 in its harmonics |
| Axes | DE440 lunar libration (principal-axes frame, the Chebyshev records of `moon_pa_de440_200625.bpc` for 2021-12-28 to 2037-01-06 TDB, a day inside each end being the limit of an arc); outside it `orientation-out-of-range` | the Mars-fixed frame of MRO120F's PDS label: N, J fixed; PSI, I, PHI secular; PHI's seasonal spin terms (1, 1/2, 1/3, 1/4 Mars year from January 1999); the nutation corrections of Konopliv et al. 2006 are not in the label and not applied |
| Atmosphere | none (drag refused) | `ATMOSPHERE_MODEL` `MARS_EXPONENTIAL`: the banded exponential profile NASA GMAT R2026a ships (Vallado 8.6), 0 to 2980 km above the reference ellipsoid (3396.19, 3376.20 km), turning with the planet at 350.891985314 deg/day. One mean profile: no solar-cycle, seasonal, diurnal, latitude or dust variation; scale the coefficient |
| Radiation pressure | cannonball, conical shadow of the Moon | cannonball, conical shadow of Mars |

`GRAVITATIONAL_PARAMETER` sets the central term and the field's own GM its harmonics, as for the Earth's EGM2008. The field
tables are float32 reductions of the PDS tables (relative 6e-8, under 1e-11 of the acceleration). A field and an atmosphere belong
to their body and are selected by their own names; asked for about another body they are refused by name, and nothing is read
as the central body's own: `SPHERICAL_HARMONICS`, `EGM2008`, `EGM96`, `J2_ONLY`, `J2_TO_J4`, `INFER_FLAGS` and the Earth's
atmospheres (`EXPONENTIAL` among them) are the Earth's, `GRGM660PRIM` the Moon's, `MRO120F` and `MARS_EXPONENTIAL` Mars's. Mars's center is the Mars system barycenter of the short DE440 kernel (Phobos and Deimos displace it by under 0.2 m);
Phobos and Deimos are not modeled. The Earth's models (tides, Earth radiation, relativity, space weather, GNSS radiation
pressure) are refused for the other bodies.

Extended third-body gravity (`THIRD_BODY_MAXIMUM_DEGREE` and `THIRD_BODY_MAXIMUM_ORDER`, 0 by default: every third body a point
mass): the harmonics (degree 2 up) of the Moon's GRGM660PRIM (to degree 150) on an Earth orbiter, or of the Earth's EGM2008 (to
degree 70) on a lunar orbiter, minus the same field's acceleration at the frame origin, added to that body's point mass. The body
must be in `THIRD_BODY_IDS` (301 about the Earth, 399 about the Moon) with `ENABLE_THIRD_BODY`, and the kernel supplied
(`EPHEMERIS_SOURCE` `JPL_SPK`); the Moon's field is in its principal axes, so an Earth arc must lie in the libration span of the table's Axes row.
No third body of Mars has a field. Any other request, a degree of 1, an order above the degree and a degree past the embedded
field are refused by name, and a resident configuration (point-mass third bodies) refuses it. In the library it is
`ForceModelSet::thirdBodyField` and `ForceModel::ThirdBodyHarmonics`.

Sources, licenses, redistribution and hashes: `scripts/planetary-sources.json` (`node scripts/fetch-planetary-sources.mjs <dir>`
downloads and verifies them; `node scripts/generate-planetary-data.mjs <dir>` writes `lib/data/planetary`). Truth and tests:
`tests/planetary.e2e.mjs` fits the state and the radiation-pressure and drag coefficients to the first day of NAIF's reconstructed
LRO, MRO and MAVEN states and predicts the next three (measured error by day in the file's header comments and output; LRO
window 2026-03-27: 7.4, 13, 19, 49 m, window 2026-03-20: 22, 24, 94, 230 m; MRO: 1.1, 2.3, 4.1, 6.5 m; MAVEN: 4.4, 24, 162, 317 m);
the field's degree is visible in the error (15 km, 1.4 km, 61 m, 24 m at degrees 2, 20, 60, 150 on one LRO window). Past degree
120 the error of the two LRO windows scatters by about a third between degrees (46, 28, 38, 31 m on day 2 at 120, 150, 200, 260,
`tests/planetary-degree-sweep.mjs`), which is why the embedded field stops at 150.

## Integrators and events

The integrator and the events are chosen in the request: `PCFIntegratorSettings.ALGORITHM`
and `PRWExecutionRequest.EVENTS`. No name string and no integer code selects either. A value
the build does not run is refused by name.

| ALGORITHM | method | order | stages per step | continuous extension | source |
| --- | --- | --- | --- | --- | --- |
| RK4 | classical Runge-Kutta, fixed step | 4 | 4 | quintic Hermite | |
| RKF45, COWELL | Cash-Karp | 5(4) | 6 | quintic Hermite | Cash and Karp 1990, ACM TOMS 16:201 |
| RKF78, RK78 | Fehlberg, one pair under two names | 7(8) | 13 | quintic Hermite | Fehlberg 1968, NASA TR R-287 |
| RKDP87 | RK8(7)13M | 8(7) | 13 | degree 6, 14 stages | Prince and Dormand 1981, J. Comput. Appl. Math. 7:67; Bogacki and Shampine 1990, Comput. Math. Appl. 20:15 |
| DOPRI5 | Dormand-Prince | 5(4) | 6, first same as last | order 4 | Dormand and Prince 1980, J. Comput. Appl. Math. 6:19; Shampine 1986, Math. Comp. 46:135 |
| RK65 | RK6(5)8M | 6(5) | 8 | quintic Hermite | Prince and Dormand 1981 |
| RKV98 | Verner efficient 9(8) | 9(8) | 16 | degree 9, 10 further stages | Verner 2010, Numer. Algorithms 53:383 |
| RKN1210 | Runge-Kutta-Nystrom 12(10)17M | 12(10) | 17 | quintic Hermite | Dormand, El-Mikkawy and Prince 1987, IMA J. Numer. Anal. 7:423 |
| BS | Bulirsch-Stoer | | | quintic Hermite | |
| ABM, GAUSS_JACKSON_8 | fixed-step multistep on a uniform grid of whole steps | 4, 8 | 1 or 2 | none | |

The tableaus are in `lib/rk_tableaus.h` and the one stage loop in `lib/rk_engine.cpp`. RKN1210
integrates r'' = a(t, r); a force set with drag, relativity, empirical or thrust acceleration is
refused. ENCKE, EQUINOCTIAL_VOP and GAUSS_VOP integrate a reduced force model and are refused:
FFM runs the full force model. DROMO and STIEFEL are refused: their propagation does not reach
the requested epoch to the integration tolerance. DOPRI853 (Dormand-Prince 8(5,3)) is refused: RKDP87
is the eighth-order Prince-Dormand pair FFM runs.

Over ten LEO orbits (a = 6900 km, e = 0.01) at tolerance 1e-12 the position errors against the
exact two-body state are: RKF45 16 mm in 32 178 evaluations, RKF78 54 mm in 8 697, RKDP87 0.49 mm
in 8 203, DOPRI5 2.5 mm in 36 450, RK65 0.47 mm in 15 440, RKV98 69 um in 7 616, RKN1210 2.0 um
in 2 754, BS 2.8 um in 4 656; RK4 at 1 s is 19 um in 228 164. The Fehlberg pair's embedded
estimate trails its true error, so RKDP87 is two orders more accurate at the same cost.
`tests/integrator-events.e2e.mjs` prints these for LEO, GEO and e = 0.7.

### Events

`EVENTS` holds `PCFEventDefinition` entries, each a continuous function g of the integrated state;
an event is a zero crossing of g.

| KIND | g | INCREASING / DECREASING |
| --- | --- | --- |
| APSIS | r . v | periapsis / apoapsis |
| PLANE_CROSSING | n . r, n = PLANE_NORMAL, default the pole of the request axes | ascending / descending |
| TRUE_ANOMALY | true anomaly minus ANGLE_RAD, wrapped | passage of the angle |
| ARGUMENT_OF_LATITUDE | argument of latitude minus ANGLE_RAD, wrapped | passage of the angle |
| LATITUDE_EXTREMUM | r^2 dz/dt - z (r . v), z along the pole | minimum / maximum of the geocentric latitude |
| UMBRA, PENUMBRA | separation of the Sun and Earth centers minus the difference or sum of the apparent radii | exit / entry |
| CLOSEST_APPROACH | (r - r2) . (v - v2), r2 and v2 from the `second_trajectory` input | minimum / maximum of the range |
| EXPRESSION | the value of a reverse Polish program over named parameters | the program's sign |

`ACTION` is CONTINUE (counted), RECORD (reported) or STOP (reported; the propagation ends at the
`OCCURRENCE`-th qualifying crossing and the final sample is the state there). `DIRECTION`
filters the crossings. `TOLERANCE_SECONDS` is the epoch tolerance (default 1e-9 s). The result
carries `EVENTS` (epoch, elapsed seconds, state, g at the epoch), `EVENT_OCCURRENCES` per spec and
`STOPPED_BY_EVENT`.

After each accepted step the loop compares g at the two ends. A sign change is bracketed
there, refined on the integrator's continuous extension by Brent's method, and confirmed by
re-stepping the integrator itself from the start of the step to the candidate epoch and correcting
it with Newton's method on those states (`lib/integrator_events.cpp`). The epoch is a root of g
along the integrator's own solution, so it does not depend on the step size and is as accurate as
the integration. An EXPRESSION is data, at most 64 terms and 16 deep, over `pceParameter` values
(POSITION_X/Y/Z, VELOCITY_X/Y/Z, POSITION_MAGNITUDE, VELOCITY_MAGNITUDE, RADIAL_VELOCITY,
ANGULAR_MOMENTUM_*, SPECIFIC_ORBITAL_ENERGY, SEMI_MAJOR_AXIS, ECCENTRICITY, INCLINATION,
RIGHT_ASCENSION_OF_ASCENDING_NODE, ARGUMENT_OF_PERIAPSIS, TRUE_ANOMALY, ARGUMENT_OF_LATITUDE,
GEOCENTRIC_LATITUDE) in the catalog's SI units; no code runs and any other parameter is refused by
name. The optional `second_trajectory` input is an `$OEM` (kilometers, kilometers per second, in the
request's axes) that must cover the arc; it is interpolated by Hermite polynomials of degree 7
through the four nodes around the epoch. Events apply to a plain state propagation by RK4, RKF45, COWELL, RKF78, RK78,
RKDP87, DOPRI5, RK65, RKV98, RKN1210 and BS, forward or backward; a request with an STM,
covariance, samples, impulses or burns, or with another integrator, is refused by name. The
latitude extremum is about the pole of the request axes.

## Usage

### Via SDN Plugin Delivery (ecies-decrypted bytes)

```javascript
import { createFFMPropagator } from "@orbpro/plugin-ffm";

// wasmBytes are delivered pre-decrypted by the SDN plugin-delivery system
// (ecies-x25519-hkdf-sha256-aes-256-gcm)
const propagator = await createFFMPropagator({ wasmBytes });
```

### Direct / Development

```javascript
import { createFFMPropagator } from "@orbpro/plugin-ffm";

// Without wasmBytes, loads the canonical artifact from dist/isomorphic/module.wasm
const propagator = await createFFMPropagator();
```

### Options

| Option | Type | Description |
|--------|------|-------------|
| `wasmBytes` | `Uint8Array` | Pre-decrypted WASM bytes from the SDN delivery system. |
| `recipientPrivateKey` | `string` | Optional SDK 0.8 recipient key override for encrypted module envelopes. |
| `lowMemory` | `boolean` | Use reduced memory configuration. |

## Agreement with reference tools

The [72-case reference suite](docs/cross-validation.md#reference-suite-on-72-cases)
reports agreement, supported cases, model settings and measured causes using the
shipped WASM. The [consolidated evidence](tests/evidence/CONSOLIDATED.md) includes
STM, frame/time/ephemeris and SGP4 checks, with reproducible version and checksum pins.

## Verification

Run the full package suite with the provisioned Chromium headless shell:

```bash
export SDM_CHROME_BINARY="$HOME/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell"
export PATH="$HOME/.wasmedge/bin:$PATH"
npm test
```

Browser verification uses only the Playwright headless shell with an isolated
profile. The receipt scripts pin it through `tests/lib/headlessShell.mjs`.
All seven receipts pass on FFM 2.0.0, module SHA-256
`c5c8110182a34484092cf3fd4b623f693b02de3cc6098b746a2af6cc590b8197`,
across the headless-shell browser and native WasmEdge lanes (the owner waived the
Docker leg on 2026-10-22; it is never started). Responses and exit classes agree
byte for byte.

| Receipt | Runs per lane |
| --- | ---: |
| [PRW](tests/evidence/lane13/prw-parity.json) | 72 |
| [GNSS](tests/evidence/gnss-srp/prw-gnss-parity.json) | 20 |
| [Earth radiation/tides](tests/evidence/earth-radiation-tides/prw-earth-radiation-tides-parity.json) | 24 |
| [Variational](tests/evidence/lane13/variational-parity.json) | 40 |
| [Finite burn](tests/evidence/lane13/finite-burn-parity.json) | 180 |
| [Kernel](tests/evidence/lane13/kernel-parity.json) | 24 |
| [Resident](tests/evidence/lane13/resident-stateful-parity.json) | 33 requests per runtime |

That covers:

- SDK artifact compliance and harness loading in `tests/sdk_compat.test.mjs`
- PRW resident SI/UTC, handle invalidation, bounded chunks, and PPE quality in
  `tests/prw_resident.test.mjs` (gravity-only profile)
- The configured profile against the execution path, its PPE interpolation
  and its refusals in `tests/prw_resident_configured.test.mjs`;
  `tests/prw-resident-parity.mjs` checks byte agreement across Chromium
  headless shell and native WasmEdge
- FFM against Orekit 13.1 in `tests/orekit_reference.test.mjs`: five
  orbits (LEO 400 km, SSO 700 km, GPS, GEO, Molniya) by ten force sets
  (point mass; J2; zonal 20; 20x20; with Sun and Moon, radiation pressure and
  NRLMSISE-00 drag), plus the SDS 1.240.0 and 1.243.0 cases (relativity,
  solid tides, in-track thrust, BDOT, daily space weather, EME2000, EGM96,
  36Z,24T, JB2008, Earth radiation, FES2004 ocean tides, and the STM with
  parameter Jacobians): 72 cases, 24 h each, compared hourly. Constants,
  daily Earth orientation (the same IERS rows on the `earth_orientation`
  input), time scales and the atmosphere's conventions are shared by
  construction. The tolerances and their rationale are in the test's header;
  the measured agreement is under "Agreement with Orekit 13.1", below.
- Samples in any order, repeated or before the initial epoch, against
  requests for each epoch alone; the plain path through LEO penumbrae at
  300 s steps; backward requests on forward-only integrators refused, in
  `tests/prw_sequence.test.mjs`.
- The JB2008 and Jacchia-Roberts ports against Orekit and GMAT, and
  Jacchia-Roberts against the diffusion equations integrated numerically, in
  `tests/atmosphere_ports.test.mjs`; their PRW inputs in
  `tests/prw_atmospheres.test.mjs`; dynamic parameters and EME2000 in
  `tests/prw_parameters.test.mjs`.

- The Earth's results against modules main's artifact, byte for byte, in
  `tests/earth-equivalence.mjs` (receipt `tests/evidence/earth-equivalence.json`): the
  responses to the 72 Orekit cases, their final-epoch-only variants and the
  29 cross-validation requests in the browser and in native WasmEdge, the answers
  (accepted, or refused with the text) to 2,211 edits of three Earth requests,
  one field at a time (in native WasmEdge the refusals and every tenth acceptance),
  and the parity receipts above.

The Orekit trajectories are generated by
`tests/fixtures/orekit/OrekitReference.java` (Orekit 13.1, Hipparchus 4.0.1,
the orekit-data DE440 and IERS files) from the coefficients FFM embeds
(`make-gfc.mjs`, EGM2008 and EGM96); `make-eop.mjs` writes the same IERS rows
as `$EOP`, `make-spw.mjs` the CSSI rows as `$SPW` and `make-jb2008.mjs` SET's
SOLFSMY/DTCFILE rows as `PRWJB2008Indices`. The checked-in JSON is what the
test reads; nothing in the suite regenerates it (`OrekitReference.java ...
[only]` regenerates a subset for development).

### Agreement with Orekit 13.1

`npm run orekit:summary` (`tests/orekit-summary.mjs`) scores the shipped
module against the 72 cases at three integrator settings and writes
`tests/evidence/orekit/summary.json`. FFM integrates with RK78 at a relative
tolerance of 1e-13 (the point-mass cases at 1e-15) and the steps the table
names; Orekit with Dormand-Prince 8(5,3) at a relative tolerance of 1e-14 and
steps of at most 10 s.
The [current summary](tests/evidence/orekit/summary.json) pins FFM 1.4.0,
module SHA-256 `eb05fc526683d6592a8207319e6b8b3eda582d00d4da273198e6126467732629`,
and records every case at all three settings. All 72 published suite limits
are met. The [generated comparison table](docs/cross-validation.md#reference-suite-on-72-cases)
reports current maxima by orbit and force class.

The sampled path controls its adaptive steps on the six-state error.
Integration settings account for much of the suite-setting difference in
LEO. Earth-orientation conventions contribute a separate spread: the
trajectory reference uses ITRF with IERS 2010 tidal and libration corrections
(`getITRF(IERS_2010, false)`), while FFM interpolates the supplied daily
IERS rows. The [frame and clock evidence](docs/cross-validation.md#erfa-orekit-and-spice-classical-frames-and-the-force-clock)
separates these model choices from implementation accuracy and reports the
additional before/after trajectory caps.

### Agreement with GMAT R2026a

`tests/evidence/gmat/` runs NASA GMAT R2026a (GmatConsole built 2026-03-26) on
the 57 of the 72 cases whose forces it models, from the tool-neutral case
export, and scores FFM at the same three settings
(`tests/evidence/gmat/summary-gmat-R2026a.json`; method, settings and checksums
in `docs/cross-validation.md`):

| Force set | Cases | Steps of at most 300 s | Steps of at most 30 s | Tolerance 1e-15, steps of at most 10 s |
| --- | ---: | ---: | ---: | ---: |
| Point mass | 5 | 0.32 mm | 0.07 mm | 0.01 mm |
| Field, third bodies, radiation pressure, tides, relativity, thrust | 46 | 4.5 cm | 3.1 cm | 3.0 cm |
| With drag (NRLMSISE-00) | 6 | 7.97 m | 7.95 m | 7.95 m |

The drag rows are the anomalous oxygen GMAT's NRLMSISE-00 leaves out of its
total density (`gtd7`; FFM and Orekit use `gtd7d`): 0.005 % of the density at
400 km and 2.0-2.5 % at 700 km, 2.3 m and 7.9 m over the day; GMAT with its
Cd scaled by that share is within 42.207 mm and 109.950 mm at the suite setting
(`tests/evidence/gmat/anomalous-oxygen.json`). GMAT's 6x6 STM agrees with
FFM's to 4.6e-10 (field, Sun, Moon in LEO) and 2.6e-5 where GMAT leaves terms
out of its variational equations (shadow function, relativity, thrust).

### Classical frame contract and independent evidence

`lib/coords` uses ERFA 2.0.1 for IAU 1976 precession and the full IAU 1980
nutation series. GCRF/J2000 are aliases in this classical API (no frame bias);
MOD, TOD and FK5 TEME follow `eraPmat76`, `eraPnm80` and
`R3(eraEqeq94) * eraPnm80`. ECEF/ITRF/PEF use the equinox chain
`R3(eraGst94) * eraPnm80`; the general API has zero polar motion.
The compatibility `gcrfToItrf` helper accepts xp/yp and applies `eraPom00`
with zero TIO locator.

Every public single-double date is **UTC JD**, split exactly before ERFA's
UTC → TAI → TT conversion. The explicit `coords::Epoch` overload accepts
TT and UT1 as separate two-part dates. Without EOP, UT1 = UTC; omitted DUT1
can reach 0.9 s (13.5 arcsec, about 2.8 km at GEO). This API also omits polar
motion, frame bias and the modern 2006/2000A model. Use the force model's EOP
CIO chain when those are required. Invalid frames/dates return all-NaN
matrices/states, and every valid frame pair is supported.

Velocity follows `v_to = M v_from + Mdot r_from`. The retained derivative is
Earth rotation about the true pole (TOD/PEF/ECEF z), with the analytic
GMST82 rate. Precession/nutation/equinox rates are neglected, including for
inertial-to-inertial transforms: roughly 2e-11 rad/s times radius, about
0.14 mm/s at LEO and 0.8 mm/s at GEO. The full-chain ±1 s central-difference
diagnostic in the E2E measures the actual residual; these scales are
approximate, not strict maxima.

The offline evidence is in `tests/evidence/erfa-spice/`:

- `check-classical-frames.mjs`: 10,000 epochs spanning 1990–2040, every valid
  frame pair, six state directions, native versus independently evaluated
  pyerfa, plus shipped WASM ECEF exports.
- `check-erfa-spice.mjs`: fresh source-built force/frame evaluations at the
  50 case epochs against pinned independent ERFA/SPICE matrices and DE440
  states; all numerical reductions run in C++.
- `run-orekit-frames.mjs`: Orekit 13.1 classical frames and IERS 2010 ITRF,
  with its IERS 1996 series and cubic-versus-linear EOP spreads reported.

[Cross-validation](docs/cross-validation.md) gives measured agreement,
limits, source hashes and before/after values. The SPICE ITRF93 comparison
retains its measured reference-spread miss; it does not define the case EOP
or the IERS 2010 CIO chain.

## License

Apache-2.0.

## JPL kernel input (TMPL lane 01)

The `invoke` method accepts an optional `kernel` input with canonical type
`NCD.fbs` / `$NCD` / `NCD`. Its payload is the existing orbit-products container
format: `[u32le descriptor_length][$NCD FlatBuffer][SPK bytes]`. Set the
size-prefixed descriptor's `FORMAT` to `SPK_DAF` and `SOURCE_BYTE_LENGTH` to the
kernel byte count; an optional `SOURCE_SHA256` is verified. No kernel is embedded
in the module or opened through a guest filesystem. The module reads Chebyshev
coefficients directly from input bytes. The instance keeps the last verified
kernel: the same kernel again (same SHA-256 and length, identical bytes) is
compared byte for byte instead of hashed (17 ms per comparison for DE440s,
32.7 MB). A resident instance keeps the kernel of its
`ingest_state` until the next ingest.

For body states, send this JSON on the existing `request` port:

```json
{"operation":"ephemeris","params":{"target":301,"center":399,"epochTDBJD":2461041.5}}
```

The response contains `position` in km, `velocity` in km/s, `frame` equal to
`ICRF/J2000`, and `ephemerisSource` equal to `JPL_SPK`. NAIF target/center IDs are
accepted, including the Sun (10), Moon (301), Earth (399), EMB (3), planetary
barycenters (1–9), and SSB (0). These are geometric states, with no light-time or
aberration correction. The descriptor does not prove a DE release; use the
pinned kernel hash for DE440 provenance rather than inferring a release from a
DAF header.

The same `kernel` port on `operation: "propagate"` selects kernel states for
Sun/Moon/planet third-body forces and SRP. `epochJD` and `targetJD` for this JSON
operation are **TDB Julian dates**, matching the numerical library's state
contract; `epochTimeScale` is reported as `TDB`. Planet flags include
`thirdBodyMercury`, `thirdBodyVenus`, `thirdBodyMars`, `thirdBodyJupiter`,
`thirdBodySaturn`, `thirdBodyUranus`, and `thirdBodyNeptune`.

Without a kernel, propagation explicitly reports `ephemerisSource:
"Analytical"`. The caller can also request `params.ephemerisSource:
"Analytical"` with a kernel present. An invalid kernel, missing body, unsupported
selected segment, or uncovered epoch returns a named failure. It never silently
substitutes analytic data. A configured resident catalog reads the kernel of
its own `ingest_state`; a new kernel needs a new generation.

For native library callers, `Ephemeris::loadEphemerisBuffer(bytes, size, source)`
attaches a borrowed view until `clearEphemerisBuffer()`. An optional DE430/440/441
source label is supplied by the caller; both `BodyState` and `EphemerisState`
report their source. `loadEphemerisFile` returns false. Unsupported INPOP/EPM named
providers likewise return invalid states.

The pinned downloader, CSPICE/Horizons sources, validation tolerances, and 2026
analytic error comparison are documented in
[`docs/de440-validation.md`](../../docs/de440-validation.md). Invoke and parity
examples are in `tests/kernel_invoke.test.mjs` and `tests/kernel-parity.mjs`.

## Analytical state transition matrix (TMPL lane 03)

The existing `invoke` / `propagate` operation can integrate the Cartesian state
and its 6×6 state transition matrix (STM) as one 42-component system. The STM is
`∂x(target)/∂x(epochJD)`, in row-major order for `[x,y,z,vx,vy,vz]`.
All calculations execute in C++ WASM. Example request body:

```json
{
  "operation": "propagate",
  "params": {
    "epochJD": 2451545.0,
    "targetJD": 2451545.01,
    "position": [7000, 0, 0],
    "velocity": [0, 7.5, 1],
    "includeSTM": true,
    "STM_METHOD": "ANALYTIC",
    "DENSITY_GRADIENT": "FINITE_DIFFERENCE",
    "forces": {"gravityMode": "J2"}
  }
}
```

- `includeSTM: true` requests `stm`. `STM_METHOD`, `covariance`,
  `sampleEpochsJD`, or `maneuvers` also request it. State-only requests retain
  their existing behavior. The default STM method is `ANALYTIC`;
  `FINITE_DIFFERENCE` retains central differences of twelve perturbed
  trajectories plus the nominal trajectory.
- The state uses GCRF km and km/s, epochs are JD TDB. The STM's position/position
  and velocity/velocity blocks are dimensionless, position/velocity is seconds,
  and velocity/position is inverse seconds. The existing gravity evaluator's
  coordinate conventions are unchanged; this does not add an Earth-fixed
  rotation to its tesseral harmonics.
- `covariance` is 36 row-major entries in the same Cartesian units. The returned
  covariance is `Phi * P0 * Phi^T`. On the PRW surface, `PROCESS_NOISE` adds a
  declared `Q` (see Covariance and process noise).
- `sampleEpochsJD` returns `samples[]` containing position, velocity, `stm`, and
  optionally covariance. Every sample STM refers to the original `epochJD`.
  Samples are independently propagated from that epoch. The caller may pack
  these arrays into estimation's existing propagator-sample input; no new SDS
  schema or automatic estimation flow is introduced.
- `maneuvers` contains `{epochJD, deltaV: [dx,dy,dz], frame: "INERTIAL"|"RTN"}`;
  delta-v uses km/s. Integration stops at each burn. At a burn epoch the output
  is post-burn. Start-epoch burns are excluded, so supply an already post-burn
  initial state. Inertial jumps have identity Jacobians; RTN jumps differentiate
  the moving basis and left-multiply the cumulative STM. Backward propagation
  with scheduled impulses is explicitly unsupported.
- `DENSITY_GRADIENT` defaults to `NEGLECTED`. `FINITE_DIFFERENCE` differences only
  scalar density at ±1 m; drag velocity and co-rotation partials remain analytic.
  Ignoring density's gradient is a configurable linearization approximation,
  not a claim that density is spatially constant.
- Analytic integration supports RK4, RKF45 (the existing Cash–Karp pair), RKF78,
  RK78, and COWELL (Cash–Karp). Adaptive state and STM share stages, error
  tolerances, accepted steps and rejected steps. STM errors are scaled using
  `D^-1 Phi D` with initial position/velocity magnitudes. Unmet tolerance at
  `minStep` returns an error. RK4 remains fixed-step. The finite-difference
  invoke path additionally supports RKDP87 and BS; other result dispatchers
  are refused explicitly.
- `forces.gravityMode`: `POINT_MASS`, `J2`, `J2_J4`, `SPHERICAL_HARMONICS`, or
  `EGM2008`. Existing low-degree flags remain available; `higherZonals` controls
  the built-in J5/J6 pair. `maxDegree` and `maxOrder` select harmonic truncation.
  `forces.dragModel` accepts `NRLMSISE00`, `EXPONENTIAL`, `USSA1976`, or
  `HARRIS_PRIESTER`. Sun/Moon/planet positions use lane 01's scoped kernel port
  when supplied; missing kernels retain the explicitly reported Analytical
  fallback.

### Coverage and limits

The force Jacobian uses forward analytical chain-rule differentiation, with no
whole-force differencing in `ANALYTIC` mode. It includes point mass, J2–J6,
inline spherical harmonics/custom fields, full loaded and embedded EGM
Cunningham/Pines recursion, nine third-body point masses, atmospheric drag,
cannonball SRP and its conical shadow (lib/shadow.h), relativistic terms and supported
registered contributions. There is **no additional STM harmonic truncation**;
the existing embedded EGM field remains degree 70. Loaded-field degree 80 is
also covered by a Jacobian regression.

The following force semantics are preserved: cannonball SRP always uses the
conical disk-overlap shadow, and EGM low-degree coefficient gates are not
applied by its force evaluator. These are force-model choices, not derivative
truncations. Piecewise shadow/density boundaries use the
selected branch derivative; a discontinuous threshold has no classical
Jacobian at the boundary. Inline tesseral gravity refuses its exact polar
coordinate singularity.

The six-state analytic STM explicitly refuses thermal reradiation, the pole
tide, empirical accelerations, the legacy fixed-mass finite-thrust force,
attitude-dependent SRP other than the cannonball and the GNSS box-wing, and
atmosphere winds (the solid and ocean tides, Earth radiation, the GNSS
box-wing and ECOM2 have analytic partials). Select the finite-difference path for
those legacy forces. Mass-aware finite burns use the seven-state path below.
Cd/Cr are configurable force inputs; the legacy six-state JSON operation
does not return Cd/Cr sensitivity columns.

The legacy working-state exports `plugin_compute_stm` and
`plugin_propagate_covariance` default to analytic propagation.
`plugin_set_stm_method(method, densityGradient)` selects 0=analytic/neglected,
1=finite-difference for each respective argument. These working-state methods
have no entity burn list; scheduled burn STM jumps are on the invoke surface.

## Finite burns with propagated mass (TMPL lane 04)

The existing JSON `invoke` / `propagate` operation accepts `finiteBurns` and
integrates `[x,y,z,vx,vy,vz,massKg]`, its 7×7 STM, and per-burn accumulated
delta-v and propellant in C++ WASM. This extends the legacy request control
surface; it introduces no SDS schema or resident-state burn contract.

```json
{
  "operation": "propagate",
  "params": {
    "epochJD": 2451545.0,
    "targetJD": 2451545.01,
    "position": [7000, 0, 0],
    "velocity": [0, 7.546053290107542, 0],
    "massKg": 1000,
    "STM_METHOD": "ANALYTIC",
    "forces": {"gravityMode": "POINT_MASS", "j2": false},
    "finiteBurns": [{
      "startSeconds": 60,
      "stopSeconds": 360,
      "thrustNewtons": 20,
      "ispSeconds": 300,
      "frame": "VELOCITY",
      "throttle": [
        {"seconds": 60, "throttle": 1},
        {"seconds": 180, "throttle": 0.5}
      ]
    }]
  }
}
```

### Burn controls

- Supply at most 16 burns. Each requires exactly one positive `thrustNewtons`
  (N) or `accelerationKmS2` (km/s²), and positive `ispSeconds` (s). Throttle
  multiplies that magnitude. Thrust mode applies `a = T/(1000 m)` in km/s²
  and `dm/dt = -T/(Isp g0)` in kg/s, with standard gravity `g0 = 9.80665 m/s²`.
  Acceleration mode varies thrust with the current mass to maintain the chosen
  acceleration, so its mass decays exponentially at constant throttle.
- Initial mass uses top-level `massKg`, otherwise the existing `forces.massKg`
  / `forces.mass` or `spacecraft.massKg` / `spacecraft.mass` selection, default
  1000 kg. Mass must remain positive. Drag and cannonball SRP use the current
  propagated mass as well.
- `startSeconds` and `stopSeconds` are offsets from the original `epochJD`.
  Alternatively, use `startJD` / `stopJD` (`startEpochJD` / `stopEpochJD` aliases)
  in **JD TDB**. Specify only one time representation for each edge. Scheduled
  windows require `0 <= startSeconds < stopSeconds`; overlapping burns add
  their accelerations and mass flows. Propagation is forward only.
- `frame` defaults to `INERTIAL`. `direction` defaults to `[1,0,0]` and is
  normalized. The supported bases are:

  | Frame | Components of `direction` |
  | --- | --- |
  | `INERTIAL` | Fixed GCRF Cartesian axes. |
  | `RTN`, `LVLH` | Radial `r/|r|`, transverse `N×R`, normal `(r×v)/|r×v|`. `LVLH` is explicitly an RTN alias here. |
  | `VNC` | Velocity `v/|v|`, normal `(r×v)/|r×v|`, co-normal `V×N`. |
  | `VELOCITY` | Along instantaneous velocity. No `direction` or `steeringRate` field. |
  | `ANTI_VELOCITY` | Opposite instantaneous velocity. No `direction` or `steeringRate` field. |

- Optional `steeringRate: [dx,dy,dz]` has units s⁻¹ for a dimensionless
  `direction`: the selected-frame vector is
  `normalize(direction + steeringRate * secondsFromEpochJD)`. Its clock stays
  anchored to the original epoch for event starts and intermediate samples.
  Steered vectors that cross zero and singular orbital bases return errors.
- Optional `throttle` is a zero-order-hold table of `{seconds, throttle}`.
  Times are nonnegative, strictly increasing offsets from the original epoch,
  and throttle lies in `[0,1]`. Throttle is 1 before the first entry, and the
  last value remains in effect afterward. A value of 0 provides a duty-cycle
  coast interval. Every scheduled start, stop, impulse, and throttle change
  forces an integrator step boundary, including edges shorter than `minStep`.

### Event starts and stops

Use `startEvent` or `stopEvent` with
`{"kind":"MASS","goal":999,"direction":-1}`, for example, to stop as mass
decreases through 999 kg. Supported event kinds and goal units are `RADIUS`
(km), `SPEED` (km/s), `RADIAL_VELOCITY` (km/s), `NODE` (GCRF z in km), and
`MASS` (kg). `direction` is -1 for decreasing, 0 for either direction (default),
and +1 for increasing. A root at the initial search state is excluded.

When an event is supplied, its scheduled start and stop times bound the search
window. Omitted start time defaults to the original epoch only with
`startEvent`; omitted stop time defaults to `targetJD` only with `stopEvent`.
A stop time always shuts off the burn even if its stop event has not occurred.
A start event that never crosses inside the window leaves the burn unstarted.
The core reuses `propagator/events` stopping functions and Brent root refinement
at a 1 ns time tolerance; it integrates to each located edge before changing
the force. Events require a sign-changing root within an accepted step:
choose `maxStep` shorter than the separation between crossings. Tangencies
and multiple crossings inside one step are not guaranteed to be found.

### Results and STM

`finiteBurns` requests the coupled analytic STM even when `includeSTM` is
omitted. `STM_METHOD: "FINITE_DIFFERENCE"` is rejected for finite burns.
Supported integrators are RK4, RKF45, RKF78, RK78, and COWELL; adaptive methods
share stage evaluations and error control across state, mass, STM, and burn
integrals. Finite-burn RKF78/RK78 also compare a full step with two half steps:
their inherited embedded estimate can vanish for purely time-dependent
thrust even when quadrature error remains. RK4 uses its requested fixed step.
Existing `DENSITY_GRADIENT` choices remain available.

- `massKg` is the final mass. `stm7` contains 49 row-major entries for
  `[x,y,z,vx,vy,vz,massKg]`; its entries carry output-variable units divided by
  input-variable units. `stm` retains the upper-left 6×6 block for Cartesian
  perturbations with known initial mass.
- `covariance` retains the existing 36-entry Cartesian covariance contract,
  treating initial mass as exact. Optional `covariance7` accepts 49 row-major
  entries including mass variance and cross-covariances, and returns
  `Phi7 * P0 * Phi7^T`. Both inputs can be supplied independently. No process
  noise is added. Supply `finiteBurns: []` for seven-state coasting propagation.
- `burnSummary` preserves input burn order and reports `index`, `deltaVKmS`
  (the accumulated integral of that burn's acceleration magnitude),
  `propellantKg`, `started`, `stopped`, and actual `startSeconds` / `stopSeconds`
  and `startEpochJD` / `stopEpochJD`. Times are null until the corresponding
  transition occurs. `startByEvent` / `stopByEvent` distinguish located events
  from scheduled edges, including a stop at the end of an event search window.
  Delta-v is the thrust integral, not the final velocity
  difference, which also includes gravity and other forces.
- Each entry in `samples` includes the same mass, STM, covariance, and burn
  summary fields. Samples are independently integrated from `epochJD`; all
  STMs, propellant totals, and delta-v totals are cumulative from that epoch.
- The analytic derivatives include thrust's inverse-mass dependence, normalized
  steering, moving RTN/VNC/velocity bases, acceleration-mode mass flow, and the
  mass dependence of drag/SRP. Event transitions apply saltation matrices to
  account for a perturbation changing the crossing time. A grazing event,
  whose crossing-time derivative is singular, fails explicitly if detected.
  Simultaneous state-triggered edges are rejected because their ordering is
  ambiguous. A located event within 1 ns of a scheduled start, stop, throttle
  change, impulse, or requested output epoch is also rejected: perturbations
  can change the transition order, so a unique classical STM is not assured
  there. Request a sample after the event to obtain its cumulative STM.
  Existing `maneuvers` can be combined with finite burns; the impulse STM jump extends
  to 7×7 and leaves mass unchanged.


## FFM 2.0 integration

`com.orbpro.ffm` is the single full-force module. Its resident implementation uses automatic GJ8 PEC on absolute TT grids, Sundman RK78 on eccentric arcs, and selected-object batching. The RK core supplies startup, backward queries and physical reentry handoff. There is no selectable legacy implementation. The FFM-1 forces are unchanged.

Run `node scripts/e2e-ffm.mjs` for FIT/SCREEN and resident behavior evidence. `tests/reference/` contains the authenticated numerical oracle only; product builds and package exports do not depend on it.
