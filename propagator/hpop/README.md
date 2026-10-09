# @orbpro/plugin-hpop

OrbPro High-Precision Orbital Propagator (HPOP) Plugin.

Implements a high-fidelity numerical orbit propagator accounting for full geopotential models, atmospheric drag, solar radiation pressure, and third-body perturbations. Compiled to WebAssembly for high-performance, cross-platform use.

## Atmosphere models (honest labeling)

| Model name | Status |
| --- | --- |
| `NRLMSISE00` | **Full model.** The real NRLMSISE-00 (Picone/Hedin/Drob, JGR 2002) via the public-domain Brodowski C port vendored in `third_party/nrlmsise00/`. Drag uses the gtd7d "effective mass density" (includes anomalous oxygen). Verified against the canonical 17-case output table shipped with the reference package. |
| `USSA1976` | **Full lower-atmosphere model (0-86 km geometric).** US Standard Atmosphere 1976 with the proper geopotential-altitude layer formulation. Above 86 km it hands off to the Vallado exponential table (documented in code). |
| `Exponential` | Piecewise-exponential model, Vallado *Fundamentals of Astrodynamics and Applications* 4th ed., Table 8-4. |
| `JB2008` | **Full model on the PRW execution path** (`ATMOSPHERE_MODEL` `JB2008`): Bowman et al. (AIAA 2008-6438), `lib/jb2008.h`, a port of Orekit 13.1's JB2008 equal to it to 2e-14 (`tests/atmosphere_ports.test.mjs`), driven by the `jb2008_indices` input. The resident ABI runs the same model (label 4, published since 2026-10-08) on drivers held for the arc, set by `plugin_set_jb2008_indices([F10, F10B, S10, S10B, M10, M10B, Y10, Y10B, DSTDTC], 9)`; selecting it before they are set returns `HPOP_ERR_NOT_LOADED` (`tests/jb2008_abi.test.mjs`). `ForceModel::JB2008()` and `computeJB2008()` for direct C++ callers evaluate the same model (the single-species stand-in they used to be is gone). |
| `JacchiaRoberts` | **Full model on the PRW execution path** (`ATMOSPHERE_MODEL` `JACCHIA_ROBERTS`, a VCM's JACCHIA_70): Jacchia's static diffusion model as Roberts (1971) integrates it in closed form, the GTDS/GMAT "Jacchia-Roberts", with Jacchia 1971's constants (SR 332; SR 313's inflection temperature and 100 km composition differ); `lib/jacchia_roberts.h`, a port of NASA GMAT's density functions, bit for bit. Independently of GMAT, the diffusion equations integrated numerically from 90 km reproduce its closed forms to 1.6e-4, and with Jacchia's own arctangent temperature profile in place of Roberts' exponential fit agree within 4.3 % at 200 km and 2 % from 300 km (`tests/atmosphere_ports.test.mjs`). At equal exospheric temperature its density at 400-700 km is 2-3 times JB2008's. SatelliteToolbox.jl's `jr1971` example (2018-06-19 18:35 UT, 22 S 45 W, 700 km, F10.7 79/73.5, Kp 1.34) gives 9.68e-15 kg/m^3, 26 % below this port's 1.31e-14 although its exospheric temperature is 22 K higher; since the port reproduces the model's own equations, the difference is on SatelliteToolbox's side and is not pursued further. |
| `DTM2020` | **Simplified approximation only** — mimics the DTM2020 F30/Hp temperature response. NOT the published DTM2020 spherical-harmonic model. |
| `HarrisPriester` | Harris-Priester diurnal-bulge table (100-1000 km), with the apex taken from the Sun direction; outside the table the model declines and drag is zero. Selectable as `forces.dragModel` `HARRIS_PRIESTER` and the PRW `HARRIS_PRIESTER` family. |
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
  the code foundation/frames uses, and must cover the arc. Precession-nutation
  is held for an hour of TT; the rotation angle is evaluated at every call.
- **Without it:** precession IAU 1976, nutation IAU 1980, GAST from UTC, no
  polar motion; within 0.2 arcsec of ERFA `c2t06a`
  (`tests/environment_conformance.cpp` section 10).

The same axes serve the density models and the co-rotating atmosphere (below).

Gravity selections of the PRW execution request:

| `GRAVITY_CHOICE` | Field |
| --- | --- |
| `POINT_MASS` | `GRAVITATIONAL_PARAMETER` only. |
| `J2_ONLY`, `J2_TO_J4` | The EGM2008 zonal field to degree 2 or 4 (order 0), in Earth-fixed axes. A degree or order with them is refused. |
| `SPHERICAL_HARMONICS`, `EGM2008` | The EGM2008 field to the stated `MAXIMUM_DEGREE` and `MAXIMUM_ORDER` (both required, degree 2-70), every coefficient included; the J flags are not consulted. Order above 0 requires `earth_orientation` (`eop-data-required`). |
| `EGM96` | The same evaluation of EGM96 (`lib/egm96_data.h`, degree 2-70, from NGA's `egm96_to360.ascii` via GMAT's `EGM96.cof`; `scripts/generate-egm96.mjs`; GM and radius as EGM2008's). |

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
`TDB` ISO strings; UTC goes through the leap-second table. The Sun, Moon and
planets are read at TDB; outputs report TDB epochs. Proper time on board is
not modelled; TT is the coordinate time the IAU 2000 conventions pair with
the TT-compatible GM.

Faults fixed on 2026-10-08, found against Orekit 13.1
(`tests/orekit_reference.test.mjs`):
- **The recursion's columns.** The column recursion stopped at the maximum
  order, but the acceleration reads column m+1; an order-0 field lost its x
  and y zonal terms (290 km in a day in LEO).
- **The tesseral y sign.** The y component's m-1 term had the wrong sign
  (37.6 km in a day in LEO). The extended and inline evaluators now agree to
  1e-12.
- **`SPHERICAL_HARMONICS` without flags was the point mass.**
- **The clock.** Epochs were single Julian-date doubles (40 microseconds) on
  TDB with a TCG-compatible GM.

Earlier, on 2026-10-02, the fields were moved from inertial to Earth-fixed
axes and the built-in field was completed past degree 4; see
`analysis/gp-error-model/docs/hpop-calibration-2026-08.md`.

### Drag frame and inputs

NRLMSISE-00, JB2008 and the DTM2020 stand-in take an Earth-fixed position.
Drag uses the field's Earth-fixed axes (above): ITRF from the
`earth_orientation` rows when supplied. The geodetic conversion is WGS84,
exact to a nanometre against ERFA `eraGc2gd`. Local solar time is the mean
solar time the model was fitted with, UT + longitude/15 (the reference
driver's `stl = sec/3600 + glong/15`, and Orekit's default from 14.0).
Relative velocity is `v - omega x r` with omega along the same axes' pole.
With these, HPOP's density equals Orekit 13.1's NRLMSISE-00 to 1e-8 at the
same points. Direct C++ callers of the drag functions that pass no axes get
GMST about the GCRF z axis.

Space-weather inputs follow the NRLMSISE-00 package definitions
(`third_party/nrlmsise00/nrlmsise-00.h`): `F107` is the **observed** flux (at
the Earth's distance, not adjusted to 1 AU) of the day before the epoch,
`F107a` the observed 81-day centered mean, and `Ap` the daily index. HPOP
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
  1 total winds, 2 quiet time only; other values return `HPOP_ERR_BAD_ARGUMENT`.
  Mode 1 is quiet time while `ap_a[1]` is negative or unset, which is HWM14's
  own convention for a negative ap, so the order of the two setters does not
  matter.
- `get_wind` / `atmosphere_get_wind` return the HWM14 wind (north, east;
  down 0) with the supplied solar activity's `Ap[1]`, and refuse with
  `ATMOSPHERE_ERROR_NOT_INITIALIZED` until solar activity is supplied.
- The analytic STM still refuses winds (their position gradient is not
  analytic here); select the finite-difference STM.

### Radiation pressure

Cannonball radiation pressure uses IAU 2015 Resolution B3's nominal solar
irradiance, 1361 W/m^2 over c at 1 au, scaled by the inverse square of the
Sun distance. The Earth's shadow is conical, with the visible fraction of the
solar disk from the overlap of the apparent disks (Montenbruck & Gill
eqs. 3.85-3.87; Sun radius 695 700 km, IAU 2015 B3), evaluated as two
circular segments so that it keeps its digits (`lib/shadow.h`, shared with
the analytic partials). It equals Orekit 13.1's lighting ratio to 6e-10.
Until 2026-10-08 the penumbra was a linear ramp in distance from the shadow
axis.

The visible fraction has a kink at each penumbra boundary. The adaptive
integrators (RKF45, RK78/RKF78, RKDP87, BS and the variational integrator)
end a step on each boundary they would cross: the umbra and penumbra edges
are switching functions of the state, a step across one is shortened by the
secant until it ends within 1 ms past it, and the next step resumes at the
size proposed before (`lib/shadow_events.h`), as Orekit's eclipse detectors
do. Radiation pressure therefore needs no special step limit or tolerance:
against Orekit, LEO with radiation pressure and drag at RK78 1e-13 and 300 s
steps is within 1.6 cm after a day with samples and 2.8 cm for the final
epoch alone. Until 2026-10-08 the boundaries were crossed without being
located, and the plain path needed steps of 10 s or less (21 cm a day at
60 s). RK4 steps at its fixed size.

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
  turns are not modelled. GPS III has no published box-wing surface set that
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
2026-09-07..26, 32 GPS satellites, 636 issues; HPOP from the ESA ultra-rapid
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

Variant A reproduces E3's published HPOP-URA errors to 3 mm. The fitted
ECOM2 does the work; with it, the box-wing a priori changes nothing
measurable over a one-day fit arc (D/E 0.96-1.01, intervals across 1).

PRW (SDS 1.240.0) cannot select these models or name the ECOM2 parameters:
until SDS carries them, they are reachable from C++ only, and every PRW
request runs exactly as before (all Orekit cases return byte-identical
responses).

## Installation

```bash
npm install @orbpro/plugin-hpop
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

## Portable PRW contract (SDS 1.240.0)

Every advertised method consumes size-prefixed `$PRW` records through the SDK
PIV/TAB invoke envelope. The module builds through `compileModuleFromSource` for
`wasm32-wasip1-threads`, `threadModel: "wasi-sequential"`: one resident instance
performs ordered catalog/cache mutations and one invocation at a time. The
artifact uses shared memory; browser hosts need cross-origin isolation.

| Method | Request arm | Response arm |
| --- | --- | --- |
| `invoke` | `EXECUTION_REQUEST`, `EPHEMERIS_REQUEST`, `ATMOSPHERE_REQUEST`, or `VERSION_QUERY` | Matching result arm |
| `ingest_state` | `RESIDENT_STATE` (1–1024 input records) | No scientific output |
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

### VCM parity (SDS 1.240.0)

Everything a Vector Covariance Message carries for propagation has a PRW
field and an implementation checked against Orekit 13.1 or GMAT
(`tests/orekit_reference.test.mjs`, measured values in its header):

- **States in EME2000** (`MEAN_EQUATOR_EQUINOX_J2000` axes, a VCM's "J2K"):
  rotated by the IAU 2000 frame bias (`eraBp00`) on the way in and out,
  with covariances, STMs, impulses and inertial burn directions.
- **Geopotential** EGM96 or EGM2008 with "mmZ,nnT" truncation (above).
- **Drag** NRLMSISE-00, JB2008 (`jb2008_indices`) or Jacchia-Roberts (WEATHER
  or `space_weather`; F10.7 of the previous day and its 81-day centred
  average, Kp 6.7 h earlier); `DRAG_AREA_OVER_MASS_RATE_M2_KG_S` is BDOT,
  Cd*A/m growing linearly from the initial epoch.
- **Daily space weather** (`space_weather`): NRLMSISE-00 reads the previous
  day's observed F10.7, the day's centred average, the daily Ap and the
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

`ingest_state` atomically replaces the catalog. Every record supplies the same
`PRWInstance`: `MODULE_ID="com.orbpro.hpop"`, a nonempty host-assigned unique
`INSTANCE_ID`, and `GENERATION`. Reingest of a previously seen instance identity
requires a strictly larger generation. `ENTITY_HANDLE` values are supplied by
the caller and must be unique; output preserves handles, object IDs, and catalog
numbers. Handles are instance-scoped and must not be persisted as object identity.
The host must choose a new instance ID after replacing the actual WASM instance.
Configuration changes, diagnostic catalog replacement, and burn/cache-grid
mutations invalidate portable queries until a new generation is ingested.

PRW state position and velocity use SI metres and metres/second. Input must be
Cartesian FRM state with explicit ISO epoch, `UTC` or `TDB`, and a resolving RFM
coordinate-system name. Integration and cached polynomials use TDB; C++ converts
UTC internally. This profile accepts Earth-centered (NAIF 399) ICRF axes and
reports them as **GCRF**. Other origins and axes fail. Earth-fixed/TEME requests
fail with `eop-data-required` because the PRW invocation does not supply the
required authoritative Earth-orientation data. There is no silent frame fallback.

Resident dynamical mass, gravity overrides, and drag/SRP area-over-mass controls
fail with `unsupported-configuration`; use the execution request for supported
rich dynamics. Per-object covariance and process noise are accepted (see
[Covariance and process noise](#covariance-and-process-noise)). `VALID=false` is retained on ingest and
fails with `invalid-state` when selected for propagation or trajectory export.
Empty selection means all rows; duplicate and unknown handles fail explicitly.
`MAXIMUM_COUNT` limits the requested prefix while preserving its order.

### Covariance and process noise

A propagated covariance is `P(t) = Phi P0 Phi^T + Q`, and the record states the
`Q` it includes (`PRWProcessNoise`, SDS 1.232.0).

- **Resident states.** `ingest_state` takes a six-state `COVARIANCE` (SI;
  finite, symmetric, positive semidefinite) and optional `PROCESS_NOISE` per
  object. Noise without a covariance fails with `invalid-process-noise`.
- **Resident output.** `propagate_state` returns each such object's
  `COVARIANCE` at the target epoch and echoes the `PROCESS_NOISE` it includes.
  It uses the resident force model (point mass and the degree/order 20 field,
  in Earth-fixed axes; no Sun, Moon, drag or radiation pressure)
  and integrator (RK78, 60/0.01/600 s, 1e-12), with the analytic STM. Objects
  with scheduled burns refuse covariance (`unsupported-configuration`); use
  the execution request.
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
The finite nonnegative preparation duration is limited to 2046 ten-minute cache
segments (1,227,600 seconds). Preparation reports complete interval coverage
separately from fit quality. Segment handles never wrap or reset on reingest.

PPE contains the original 13 coefficients per axis, explicit velocity arrays,
Chebyshev basis, midpoint and half-span, Earth GCRF, TDB epochs, and the existing
PPE km/km/s units. `PRWFitQuality.EVIDENCE_KIND=UNMEASURED`, with both bound
availability flags false. No zero-error certification is claimed. Published PPE
residual scalars have no availability flag: they are omitted and accompanied by
a comment directing consumers to PRW quality; their decoded default zero must
not be interpreted as a measurement.

Each resident batch chunk returns one state; each describe chunk returns one
whole source (never part of a coefficient vector), with `SOURCE_OFFSET` and
`FINAL_CHUNK`. A response with `YIELDED=true` and positive `BACKLOG_REMAINING`
requires resubmitting the same PRW request bytes to obtain the next chunk.
One ordered continuation is active per module instance; a different request
restarts selection. This conservative chunk size respects positive output caps
although SDK 0.8.18 does not expose a guest output-cap accessor.

## Usage

### Via SDN Plugin Delivery (ecies-decrypted bytes)

```javascript
import { createHPOPPropagator } from "@orbpro/plugin-hpop";

// wasmBytes are delivered pre-decrypted by the SDN plugin-delivery system
// (ecies-x25519-hkdf-sha256-aes-256-gcm)
const propagator = await createHPOPPropagator({ wasmBytes });
```

### Direct / Development

```javascript
import { createHPOPPropagator } from "@orbpro/plugin-hpop";

// Without wasmBytes, loads the canonical artifact from dist/isomorphic/module.wasm
const propagator = await createHPOPPropagator();
```

### Options

| Option | Type | Description |
|--------|------|-------------|
| `wasmBytes` | `Uint8Array` | Pre-decrypted WASM bytes from the SDN delivery system. |
| `recipientPrivateKey` | `string` | Optional SDK 0.8 recipient key override for encrypted module envelopes. |
| `lowMemory` | `boolean` | Use reduced memory configuration. |

## Verification

Run the full package suite:

```bash
npm test
```

That covers:

- SDK artifact compliance and harness loading in `tests/sdk_compat.test.mjs`
- PRW resident SI/UTC, handle invalidation, bounded chunks, and PPE quality in
  `tests/prw_resident.test.mjs`
- HPOP against Orekit 13.1 in `tests/orekit_reference.test.mjs`: five
  orbits (LEO 400 km, SSO 700 km, GPS, GEO, Molniya) by ten force sets
  (point mass; J2; zonal 20; 20x20; with Sun and Moon, radiation pressure and
  NRLMSISE-00 drag), plus the SDS 1.240.0 cases (relativity, solid tides,
  in-track thrust, BDOT, daily space weather, EME2000, EGM96, 36Z,24T, JB2008,
  and the STM with parameter Jacobians): 63 cases, 24 h each, compared
  hourly. Constants, Earth orientation (the same IERS rows on the
  `earth_orientation` input), time scales and the atmosphere's conventions
  are shared by construction; the agreement is 0.6 mm for the point mass,
  9 mm with the field and third bodies, and 1.6 cm with radiation pressure
  and drag (2.8 cm for a final epoch alone at 300 s steps). The tolerances
  and their rationale are in the test's header.
- Samples in any order, repeated or before the initial epoch, against
  requests for each epoch alone; the plain path through LEO penumbrae at
  300 s steps; backward requests on forward-only integrators refused, in
  `tests/prw_sequence.test.mjs`.
- The JB2008 and Jacchia-Roberts ports against Orekit and GMAT, and
  Jacchia-Roberts against the diffusion equations integrated numerically, in
  `tests/atmosphere_ports.test.mjs`; their PRW inputs in
  `tests/prw_atmospheres.test.mjs`; dynamic parameters and EME2000 in
  `tests/prw_parameters.test.mjs`.

The Orekit trajectories are generated by
`tests/fixtures/orekit/OrekitReference.java` (Orekit 13.1, Hipparchus 4.0.1,
the orekit-data DE440 and IERS files) from the coefficients HPOP embeds
(`make-gfc.mjs`, EGM2008 and EGM96); `make-eop.mjs` writes the same IERS rows
as `$EOP`, `make-spw.mjs` the CSSI rows as `$SPW` and `make-jb2008.mjs` SET's
SOLFSMY/DTCFILE rows as `PRWJB2008Indices`. The checked-in JSON is what the
test reads; nothing in the suite regenerates it (`OrekitReference.java ...
[only]` regenerates a subset for development).

The Tudat-derived regressions (`tests/tudat_wasm_derived.test.mjs`) were
removed on 2026-10-08. Their high-fidelity case allowed 60 km, and their
vectors came from a port in this organization rather than a public authority.

## License

UNLICENSED — Proprietary. All rights reserved by DigitalArsenal.io, Inc.

## JPL kernel input (TMPL lane 01)

The `invoke` method accepts an optional `kernel` input with canonical type
`NCD.fbs` / `$NCD` / `NCD`. Its payload is the existing orbit-products container
format: `[u32le descriptor_length][$NCD FlatBuffer][SPK bytes]`. Set the
size-prefixed descriptor's `FORMAT` to `SPK_DAF` and `SOURCE_BYTE_LENGTH` to the
kernel byte count; an optional `SOURCE_SHA256` is verified. No kernel is embedded
in the module or opened through a guest filesystem. The module reads Chebyshev
coefficients directly from immutable input bytes, retaining the view only for
that invocation.

For body states, send this JSON on the existing `request` port:

```json
{"operation":"ephemeris","params":{"target":301,"center":399,"epochTDBJD":2461041.5}}
```

The response contains `position` in km, `velocity` in km/s, `frame` equal to
`ICRF/J2000`, and `ephemerisSource` equal to `JPL_SPK`. NAIF target/center IDs are
accepted, including the Sun (10), Moon (301), Earth (399), EMB (3), planetary
barycentres (1–9), and SSB (0). These are geometric states, with no light-time or
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
substitutes analytic data. The existing resident catalogue/trajectory methods
retain their current input contracts; the optional kernel port is scoped to
`invoke`, avoiding reuse of cached trajectories across ephemeris providers.

For native library callers, `Ephemeris::loadEphemerisBuffer(bytes, size, source)`
attaches a borrowed view until `clearEphemerisBuffer()`. An optional DE430/440/441
source label is supplied by the caller; both `BodyState` and `EphemerisState`
report their source. `loadEphemerisFile` now returns false instead of claiming a
file was loaded and returning analytic results. Unsupported INPOP/EPM named
providers likewise return invalid states.

The pinned downloader, CSPICE/Horizons sources, validation tolerances, and 2026
analytic error comparison are documented in
[`docs/de440-validation.md`](../../docs/de440-validation.md). Invoke and parity
examples are in `tests/kernel_invoke.test.mjs` and `tests/kernel-parity.mjs`.

### Build status of this lane

The existing HPOP CMake/Emscripten build is retained for diagnostic validation;
`-ffast-math` was removed so malformed-input finite checks keep their meaning.
Migration to the SDK compiler is still required before claiming this HPOP
artifact meets the SDK build law. The current SDK accepts one translation unit
and generates its own invoke bridge, while HPOP uses multiple translation units
and a legacy native bridge/browser ABI. SDK compliance also rejects pre-existing
legacy request/response types with missing canonical file identifiers. This lane
does not invent replacements for those unratified contracts.

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
    "forces": {"gravityMode": "J2"},
    "integrator": {
      "method": "RKF78", "initialStep": 20, "minStep": 0.001,
      "maxStep": 60, "absTolerance": 1e-12, "relTolerance": 1e-12
    }
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

The six-state analytic STM explicitly refuses albedo, thermal reradiation,
tides, empirical accelerations, the legacy fixed-mass finite-thrust force,
SRP other than the cannonball, the GNSS box-wing and ECOM2, and atmosphere winds. Select the finite-difference path for
those legacy forces. Mass-aware finite burns use the seven-state path below.
Cd/Cr are configurable force inputs;
there is no existing parameter-sensitivity matrix plumbing, and this lane does
not add Cd/Cr sensitivity columns.

The legacy working-state exports `plugin_compute_stm` and
`plugin_propagate_covariance` now default to analytic propagation.
`plugin_set_stm_method(method, densityGradient)` selects 0=analytic/neglected,
1=finite-difference for each respective argument. These working-state methods
have no entity burn list; scheduled burn STM jumps are on the invoke surface.

**SDK acceptance remains blocked by pre-existing legacy manifest identities.**
The committed artifact is a diagnostic build using the existing local-emSDK
CMake path. It does not meet the SDK-build/publication gate. See the lane 03
handoff for the exact preflight, compliance and tri-runtime results.

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
    "integrator": {
      "method": "RKF78", "initialStep": 10, "minStep": 0.0001,
      "maxStep": 30, "absTolerance": 1e-11, "relTolerance": 1e-11
    },
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

This lane retains the diagnostic build and existing SDK manifest limitations
described above; the new controls do not change the SDK acceptance status.
