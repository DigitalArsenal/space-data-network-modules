# analysis/density-calibration

JB2008 thermospheric mass density at points, with an exospheric-temperature
correction field, and the estimation of that field from observed densities or
from the orbital decay of catalogued objects:
a public, simplified analogue of the Dynamic Calibration of the Atmosphere
(DCA) in the Air Force's High Accuracy Satellite Drag Model (Storz, Bowman,
Branson, Casali and Tobiska 2005, *Adv. Space Res.* 36(12), 2497–2505,
doi:10.1016/j.asr.2005.02.020). DCA estimates corrections to Jacchia's
temperatures every few hours from the drag of calibration satellites; this
module estimates one correction field per time bin from whatever densities
the caller supplies (accelerometer or precise-orbit densities).

C++ compiled to WebAssembly through the `space-data-module-sdk` compiler;
Typed contracts 1.0 (0.5.0): every method takes one SDS `$DCL` (Density
Calibration) record on `request` and answers with one `$DCL`. The request names
the model in `ATMOSPHERE` (`$ATM` `JB08`, or `NRLMSIS00E`), carries the JB2008
drivers as `$PRW` `PRWJB2008IndicesTable` rows (`JB2008_DRIVERS`) or NRLMSISE-00's
daily `$SPW` rows (`SPACE_WEATHER`), the correction (`CORRECTION`), the settings
(`SETTINGS`) and the points (`POINTS`), element-set histories (`OBJECTS`, `$OMM`) or
states (`STATES`, an `$OEM` ephemeris block in GCRF km and km/s) of the method.
Times are Unix milliseconds (UTC) on the wire, read as UTC MJD = (ms + 40587 ×
86400000) / 86400000; element-set and state epochs are ISO 8601 (UTC). No JSON.
A zero in a `SETTINGS` field is its default; `EDIT_SIGMA` below zero turns
robust editing off (0.4.0's `editSigma: 0`).

## Model

- **NRLMSISE-00** (0.4.0; `evaluate` and `drag_work` with `ATMOSPHERE` `NRLMSIS00E`): the real model through the
  public-domain Brodowski C port in `third_party/nrlmsise00` (`gtd7d`, total mass density with anomalous oxygen), driven as
  `propagator/hpop` drives it: on the UTC day d of a point, F10.7 is the observed flux of day d-1, F10.7a the observed 81-day
  centred mean of day d, Ap the daily Ap of day d (all switches 1, the daily-Ap form), local solar time = UT + longitude/15,
  the WGS84 geodetic latitude, longitude and height. Rows are `$SPW` rows (`DATE`, `F107_OBS`, `F107_OBS_CENTER81`,
  `AP_AVG`), strictly increasing; a point whose day or day before has no row, or above 1000 km, is refused. No temperature
  correction applies to it, and `calibrate` stays JB2008.
- **Density:** `propagator/hpop/lib/jb2008.h` unchanged (Orekit 13.1's
  JB2008, itself a port of Space Environment Technologies' Fortran).
- **Drivers:** `$PRW` `PRWJB2008Indices` rows (SET `SOLFSMY.TXT` and
  `DTCFILE.TXT`), read as hpop reads them: each day's solar indices at 12 UT
  of its DATE, interpolated linearly at the instant less JB2008's lags (1 day
  F10 and S10, 2 M10, 5 Y10); DSTDTC linear between hourly values. A point
  outside the rows is refused, never guessed.
- **Geometry:** the point's geodetic latitude, longitude (normalized to
  [−π, π]) and altitude; the Sun's Earth-fixed longitude and geocentric
  latitude from ERFA (`eraEpv00`; IAU 2006/2000A `eraC2i06a` held for an
  hour of TT; `eraEra00` with UT1 = UTC; no polar motion), geometric, as hpop
  and Orekit give JB2008.
- **Correction:** either spherical harmonics per time segment, dT(φ, h) =
  Σ_{l≤L} Σ_{m≤l} P_l^m(sin φ)(a_lm cos mh + b_lm sin mh), Schmidt
  semi-normalized, h the hour angle from the Sun (local solar time = 12 h +
  h), coefficient order (0,0), (1,0), (1,1)c, (1,1)s, (2,0), …, a00 the global
  mean; or values at time nodes, dT(t, z) = Σ_j Σ_a v_ja φ_j(t) w_a(z): linear
  in time between nodes (held outside them) and, when `altitudeKm` lists two
  or more altitudes, linear in altitude between them (extrapolated linearly up
  to 100 km beyond the outer ones, held beyond that; none: one global value).
  Either is added to DSTDTC, i.e. to the local exospheric temperature exactly
  as JB2008's geomagnetic term. A constant dT is the same model as hpop with
  every DTC value raised by dT.
- **Orbital decay** (`decay`, `calibrate_decay`): each element set is
  propagated by Vallado's SGP4 (`propagator/sgp4`'s sources; WGS-72, opsmode
  `i`) from its epoch to the next set's; its mean semi-major axis is SGP4's own
  (Brouwer) a. Drag changes the semi-major axis at da/dt = −(a²/μ) B ρ |v_r|
  (v · v_r), v_r = v − ω_E × r (Gauss's equation for the acceleration −½ B ρ
  |v_r| v_r, B = Cd·A/m, the atmosphere co-rotating), integrated along the
  set's trajectory by the trapezoid rule (`STEP_S`, default 60). ρ is
  JB2008 with the correction at the trajectory's geodetic point: TEME turned
  Earth-fixed by GMST (IAU 1982, UT1 = UTC, no polar motion) as SGP4's TEME is
  defined, then WGS84; the Sun's CIRS direction from ERFA every TT hour,
  interpolated (within 1e-6 rad of the per-point direction). Over whole
  revolutions this is the drag change in mean semi-major axis that the next
  set observes. Points above 2500 km (JB2008's ceiling here) add no drag.
  Sets more than `MAX_GAP_S` (3 days) apart start a new chain with its own
  offset.

## Methods

| Method | `$DCL` request | `$DCL` answer |
| --- | --- | --- |
| `evaluate` | `POINTS` `TIME_MS`, `LATITUDE_DEG`, `LONGITUDE_DEG`, `ALTITUDE_KM`, with the drivers of `ATMOSPHERE`; or with `SUN_RIGHT_ASCENSION_DEG`, `SUN_DECLINATION_DEG` and nine `MODEL_DRIVERS` per point (the arguments of SET's subroutine); optional `CORRECTION` (`Harmonic`: `DEGREE`, `SEGMENTS [{FROM_MS, TO_MS, COEFFICIENTS_K}]`; or `Nodes`: `NODE_TIMES_MS`, `NODE_ALTITUDES_KM`, `NODE_VALUES_K`); `SETTINGS` `WANT_DERIVATIVE`, `WANT_SUN_DIAGNOSTICS` | `result`, `DensityEvaluation`: `POINTS` `DENSITY_KG_M3` (NaN = refused), `DELTA_T_K`, `LOCAL_SOLAR_TIME_H`, `DLN_DENSITY_DT_PER_K`, `SUN_LONGITUDE_DEG`/`SUN_LATITUDE_DEG`, `REFUSED`; the correction as applied |
| `calibrate` | the same points with `OBSERVED_DENSITY_KG_M3` (and `WEIGHT`); `SETTINGS` `DEGREE`, `BIN_S` (3 h), `FROM_MS`, `TO_MS`, `LOG_DENSITY_SIGMA` (0.1), `PRIOR_SIGMA_K` (per degree, 100 K), `MIN_POINTS` (30), `MAX_ITERATIONS` (10), `EDIT_SIGMA` (4) | `calibration`, `DensityCalibration`: `CORRECTION` `Harmonic`, a segment per bin with `COEFFICIENTS_K`, `SIGMAS_K` and its `FIT` (`OBSERVATIONS`, `USED`, `PREFIT_RMS`, `POSTFIT_RMS` in log density, `ITERATIONS`, `CONVERGED`); a bin with too few points has no coefficients |
| `decay` | `JB2008_DRIVERS`; `OBJECTS [{ID, ELEMENT_SETS ($OMM: EPOCH, MEAN_MOTION, ECCENTRICITY, INCLINATION, RA_OF_ASC_NODE, ARG_OF_PERICENTER, MEAN_ANOMALY, BSTAR), BALLISTIC_COEFFICIENT_M2_KG (1), SPAN_S (a single set integrated alone)}]`; optional `CORRECTION` (`Nodes`); `SETTINGS` `STEP_S`, `MAX_GAP_S`, `WANT_SAMPLES` | `result`, `OrbitalDecay`: per object `SET_TIME_MS`, `SET_MEAN_SEMI_MAJOR_AXIS_KM`, `SET_PERIGEE_HEIGHT_KM`, `SET_ECCENTRICITY`, `SET_CUMULATIVE_DECAY_M`, per segment `SEGMENT_DECAY_M` and `SEGMENT_MEAN_ALTITUDE_KM`, `MEAN_ALTITUDE_KM`, `REFUSED`; with `WANT_SAMPLES` every trajectory point (`SAMPLE_*`: TEME state, geodetic point, density, decay factor) |
| `calibrate_decay` | `JB2008_DRIVERS`; `OBJECTS [{ID, ELEMENT_SETS, LN_B_PRIOR_MEAN, LN_B_PRIOR_SIGMA}]`; `SETTINGS` `FROM_MS`, `TO_MS`, `NODE_STEP_S` (6 h), `NODE_ALTITUDES_KM`, `RANDOM_WALK_K_PER_SQRT_DAY` (30), `MEAN_LEVEL_K` (150), `ALTITUDE_DIFFERENCE_K` (100), `STEP_S`, `MAX_GAP_S`, `RESIDUAL_FLOOR_M` (1), `EDIT_SIGMA`, `MAX_ITERATIONS`, `REWEIGHT_ITERATIONS` (4), `TOLERANCE_K`, `TOLERANCE_LN_B`, `TOLERANCE_OFFSET_M` (convergence: every step below; 0.5 K, 1e-3, 0.1 m), `MIN_SETS` (5), `WANT_RESIDUALS` | `calibration`, `DecayCalibration`: `CORRECTION` `Nodes` with `NODE_SIGMAS_K`; per object `LN_B`, `LN_B_SIGMA`, `BALLISTIC_COEFFICIENT_M2_KG`, `RESIDUAL_SCALE_M`, `FIT` (`PREFIT_RMS`, `POSTFIT_RMS` in m), `MEAN_ALTITUDE_KM`, decays, `SET_RESIDUAL_M`/`SET_USED` when asked; skipped objects with `SKIPPED_REASON`; `FIT`, `LEVELS` (each altitude node's level and sigma), `HISTORY`, `LEVEL_LN_B_CORRELATION`, `MEAN_LEVEL_SIGMA_K`; `STATUS` `NotConverged` when the iterations ran out |

`calibrate_decay` solves, by Gauss–Newton, for the correction at its nodes,
each object's ln B and each chain's offset a0: a_k = a0 + B Σ_{segments before
k} D(correction), every set weighted by its object's robust residual scale
(1.4826 MAD, at least `sigmaFloorM`; sets beyond `editSigma` of it left out
from the second iteration; scales and edits re-estimated in the first
`reweightIterations` (4) iterations and then held, so that the iterations
converge on a fixed problem; each object's ln B step limited to 1 and
scaled by a factor halved whenever that step reverses sign once the scales
and edits are held, so that only an object alternating on the fixed problem
is slowed), with a random walk between consecutive nodes
(σ = `randomWalkKPerSqrtDay` √Δt), a Gaussian prior on each altitude node's
mean level (`meanLevelK`), a prior tying neighbouring altitude nodes
(`altitudeDifferenceK`), and each object's prior on ln B. Density and B
enter only as their product: a common scale on every B is the same as a
shift of the correction's level, so the level is set by the objects with
known area to mass (strong ln B priors) and the level prior; the time
variation is set by every object. `fit.level` and `fit.levelLnBCorrelation`
(with the precision-weighted mean ln B) report how well the level is
determined; `fit.history` the largest steps
and the chi-square of each iteration. The start is the correction at zero
and each object's B by linear least squares (an unresolved decay starts at
its prior, at 12.741621 B*, or at 0.01 m²/kg, with a weak prior). σ's are the
formal posterior standard deviations under the residual scales.

`calibrate` minimises Σ w (ln ρ_obs − ln ρ(dT))² / logSigma² + Σ_k a_k² /
σ_l² by Gauss–Newton (the log-density derivative by central differences of
±1 K), with steps limited to 200 K and, from the second iteration, points
beyond `editSigma` robust sigmas (1.4826 × MAD) of the median residual left
out. `sigmas` are the formal posterior standard deviations.

## Orbital energy and drag work

- **`energy`** (`STATES` `EPHEMERIS`, an `$OEM` ephemeris block (GCRF, km and km/s; `EPHEMERIS_DATA_LINES` with their
  `EPOCH`, or the compact `EPHEMERIS_DATA` from `START_TIME` every `STEP_SIZE`), `DUT1_S`, `POLAR_MOTION_X_ARCSEC`,
  `POLAR_MOTION_Y_ARCSEC`; `GRAVITY_DEGREE` 2-70 (0 = 36), `GRAVITY_ORDER` (0 = the degree), `GM_M3_S2` (the central
  term, default 3.986004418e14), `EARTH_ROTATION_RAD_S` (7.292115e-5), `SETTINGS` `WANT_GRADIENT`): the Jacobi
  integral of the geopotential, C = 1/2 |v|^2 + U(r_ef) - omega . (r x v) in J/kg, with U the EGM2008 potential
  energy (the central term -GM/r and the harmonics n >= 2 with EGM2008's own GM and radius, from propagator/hpop's
  `lib/egm2008_data.h`) at the position in IAU 2006/2000A Earth-fixed axes (ERFA, CIO based, Earth rotation angle
  from UT1 = UTC + dut1, polar motion when given) and omega the Earth's rotation vector in GCRF. A static field in
  uniformly turning axes conserves C along an orbit that only the geopotential acts on, and dC/dt = a . v_r,
  v_r = v - omega x r, for every other acceleration a (drag, thrust, radiation pressure, third bodies, tides). It
  returns C, its parts, |v_r| and the WGS84 geodetic point (the inputs of `evaluate`), and with `gradient` dC/dr =
  grad U + omega x v and dC/dv = v_r in GCRF (grad U by central differences, 0.5 m, in Earth-fixed axes).
- **`drag_work`** (`STATES`, `JB2008_DRIVERS` or `ATMOSPHERE` `NRLMSIS00E` with `SPACE_WEATHER`, `CORRECTION` (JB2008 only), `BALLISTIC_COEFFICIENT_M2_KG` (Cd*A/m, 1), `EARTH_ROTATION_RAD_S`): the drag power
  -1/2 B rho |v_r|^3 (W/kg) with rho the JB2008 density, the correction included, or the NRLMSISE-00 density, at each state's geodetic point,
  and the work between consecutive states by the trapezoid rule (J/kg): the energy a drag-only change of C shows. The ratio of the drag works of one
  trajectory under two atmospheres is the factor by which the Cd*A/m that an arc's energy loss implies changes between them.

## Tests

`npm test` (end to end, the built artifact through the SDK harness):

| Test | Independent reference | Result |
| --- | --- | --- |
| JB2008 against SET's Fortran | SET `jb2008validate.zip` expected output (2023 day 91, 00–21 UT every 3 h, 150–600 km, all latitudes and longitudes; 70k points); read from the local archive (`SET_JB2008_VALIDATE`), skipped visibly when absent, since the package states no redistribution licence | within 0.6 % (SET prints the drivers to the unit; half a unit of F10B is ~1.6 K, 0.5 % at 600 km) |
| Calibration recovers a known offset | SET's densities at 03 UT fitted with DSTDTC lowered by 37 K, against a control fit with the printed DSTDTC | a00 rises by 37 K within 0.1 K; other terms unchanged within 0.1 K; control terms below 1.6 K |
| The Sun's direction | JPL Horizons (DE441) sub-solar point, observer at the Sun, four epochs 2023–2026, light time removed and planetodetic latitude converted to geocentric | longitude within 0.02°, latitude within 0.003° |
| Correction = DTC offset | the module's own evaluation with every hourly DTC raised by 40 K | equal to 1e-12 |
| Node corrections | dT linear in time and altitude at six points against the closed form; a constant node correction against raising every DTC value | 1e-9 K; 1e-12 |
| SGP4 trajectory and mean a | Vallado's verification set (SGP4-VER.TLE, tcppver.out t = 0 rows, near-Earth cases); Hoots and Roehrich (1980) Spacetrack Report No. 3 Brouwer semi-major axis with WGS-72 | 2e-8 km, 2e-9 km/s; 1e-6 km |
| Drag decay | `propagator/hpop` integrating the equations of motion (RK78, zonal gravity to degree 4, JB2008 drag with Cd·A/m = B, DE440 Sun, zero EOP) from the set's GCRF epoch state (`analysis/epoch-state`): the change of the osculating semi-major axis averaged over whole nodal periods, one day, constant drivers; with DTC raised by 60 K and the same node correction | circular 400 km: rate within 0.4 %; e = 0.05, perigee 320 km: 1.6 % (SGP4's analytical trajectory, anomaly terms); the response to +60 K within 0.03 % |
| Estimation | synthetic histories of six objects (360–730 km, a set every 8 h, 1 m noise) made by `decay` under a known correction (30 K, a one-day 90 K excursion, 10 K) and known B, and a seventh at 880 km whose sets rise 0.4 m a day (as radiation pressure can make them); one object anchored | converges; steady-state error under 8 K and within the formal sigmas; the six B within 1 %; without the anchor the level's sigma grows more than fourfold and its correlation with the precision-weighted mean ln B is below −0.9 (the degeneracy) |
| Energy conservation | `propagator/hpop` integrating gravity alone (EGM2008 36x36, RK78 at 1e-12, UT1 = UTC, no polar motion) for 6 h from a 500 km sun-synchronous state; C from `energy` at the 1-min samples | constant to 0.06 J/kg (2e-9 of C; the Earth's axis precesses, ~0.01 J/kg an hour); the Kepler energy varies by tens of kJ/kg; degrees 35 and 37 against HPOP's 36 drift by more than 0.4 J/kg |
| Energy gradient | central differences of `energy` itself (2 m, 0.01 m/s) | within 1e-6 and 1e-7 relative |
| Drag work | HPOP with JB2008 drag (Cd*A/m 0.02, constant synthetic drivers) for 6 h at 30 s: the fall of C against the integral of `drag_work` | within 0.3 % |
| NRLMSISE-00 drag work | `propagator/hpop` with NRLMSISE-00 drag (Cd*A/m 0.02, a `space_weather` table whose F10.7, 81-day mean and Ap change from day to day) for 6 h at 30 s across 00:00 UTC: the fall of C against the integral of `drag_work` with `ATMOSPHERE` `NRLMSIS00E`; the same integral with F10.7 read from the epoch's own day | 0.14 %; the wrong-day read differs by 6.3 % |
| SDK compliance | `space-data-module-sdk` `validateArtifactWithStandards`; every port one concrete type (`$DCL`) | pass |
| 0.4.0 parity (measured at the 0.5.0 conversion) | the 0.4.0 JSON artifact on the 27 requests of `tests/cases.mjs` with the same values (times through Unix ms or ISO 8601, positions through km, F10.7 through `$SPW`'s float) | 10,252 numbers bit-identical; refusals with the same error codes |
