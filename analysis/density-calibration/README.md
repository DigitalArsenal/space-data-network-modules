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
JSON control frames in and out.

## Model

- **Density:** `propagator/hpop/lib/jb2008.h` unchanged (Orekit 13.1's
  JB2008, itself a port of Space Environment Technologies' Fortran).
- **Drivers:** PRW `JB2008_INDICES` rows as JSON (SET `SOLFSMY.TXT` and
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
  set's trajectory by the trapezoid rule (`stepSeconds`, default 60). ρ is
  JB2008 with the correction at the trajectory's geodetic point: TEME turned
  Earth-fixed by GMST (IAU 1982, UT1 = UTC, no polar motion) as SGP4's TEME is
  defined, then WGS84; the Sun's CIRS direction from ERFA every TT hour,
  interpolated (within 1e-6 rad of the per-point direction). Over whole
  revolutions this is the drag change in mean semi-major axis that the next
  set observes. Points above 2500 km (JB2008's ceiling here) add no drag.
  Sets more than `maxGapDays` (3) apart start a new chain with its own
  offset.

## Methods

| Method | Input (`request`) | Output |
| --- | --- | --- |
| `evaluate` | `points {mjd, latDeg, lonDeg, altKm}` (UTC MJD) or `raw [{mjd, sunRaRad, sunDecRad, lonRad, latRad, altKm, inputs[9]}]` (the arguments of SET's subroutine); `jb2008 {rows}`; optional `correction` (`{degree, segments [{fromMjd, toMjd, coefficients}]}` or `{nodesMjd, altitudeKm, values}`); `derivative`; `diagnostics` | `result`: `density` (kg/m³), `deltaT` (K), `lstHours`, `dLnRhoDT` (1/K, with `derivative`), `sunLonDeg`/`sunLatDeg` (with `diagnostics`), `refused` |
| `calibrate` | the same points plus `rho` (and optional `weight`); `degree`, `binHours`, `fromMjd`, `toMjd`, `logSigma`, `priorSigmaK` (per degree), `minPoints`, `iterations`, `editSigma` | `calibration`: per bin `coefficients` (K), `sigmas`, `n`, `used`, `prefitRms`, `postfitRms` (log density), `iterations`, `converged` |
| `decay` | `jb2008 {rows}`; `objects [{id, sets [{mjd (UTC), MEAN_MOTION, ECCENTRICITY, INCLINATION, RA_OF_ASC_NODE, ARG_OF_PERICENTER, MEAN_ANOMALY, BSTAR}], B? (m²/kg, default 1), spanDays? (a single set integrated alone)}]`; optional `correction` (time nodes), `stepSeconds`, `maxGapDays`, `samples` | `result`: per object the sets' mean semi-major axes (`aKm`), perigee heights, the drag decay of each segment (`decayM`) and its cumulative sum at each set, the mean geodetic altitude; with `samples` every trajectory point (TEME state, geodetic point, density) |
| `calibrate_decay` | `jb2008 {rows}`; `objects [{id, sets, lnBPrior? {mean, sigma}}]`; `nodes {fromMjd, toMjd, stepHours, altitudeKm?}`; `priors {randomWalkKPerSqrtDay, meanLevelK, altitudeDifferenceK?}`; `stepSeconds`, `maxGapDays`, `sigmaFloorM`, `editSigma`, `iterations`, `reweightIterations`, `tolerance {K, lnB, a0M}` (convergence: every step below; 0.5 K, 1e-3, 0.1 m), `minSets`, `residuals` | `calibration`: `correction {nodesMjd, altitudeKm, values, sigmas}` (K), per object `lnB`, `lnBSigma`, `B`, `sigmaM` (its robust residual scale), `rmsM`, `prefitRmsM`, `meanAltitudeKm`, decays; `fit` with the level of each altitude node and its sigma, and the correlation of the level with the mean ln B |

`calibrate_decay` solves, by Gauss–Newton, for the correction at its nodes,
each object's ln B and each chain's offset a0: a_k = a0 + B Σ_{segments before
k} D(correction), every set weighted by its object's robust residual scale
(1.4826 MAD, at least `sigmaFloorM`; sets beyond `editSigma` of it left out
from the second iteration; scales and edits re-estimated in the first
`reweightIterations` (4) iterations and then held, so that the iterations
converge on a fixed problem; each object's ln B step limited to 1 and
scaled by a factor halved whenever that step reverses sign), with a random walk between consecutive nodes
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
| SDK compliance | `space-data-module-sdk` `validateArtifactWithStandards` | pass |
