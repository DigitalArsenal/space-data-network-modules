# analysis/density-calibration

JB2008 thermospheric mass density at points, with an exospheric-temperature
correction field, and the estimation of that field from observed densities:
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
- **Correction:** dT(φ, h) = Σ_{l≤L} Σ_{m≤l} P_l^m(sin φ)(a_lm cos mh +
  b_lm sin mh), Schmidt semi-normalized, h the hour angle from the Sun
  (local solar time = 12 h + h). It is added to DSTDTC, i.e. to the local
  exospheric temperature exactly as JB2008's geomagnetic term. A constant dT
  is the same model as hpop with every DTC value raised by dT. Coefficient
  order: (0,0), (1,0), (1,1)c, (1,1)s, (2,0), …; a00 is the global mean.

## Methods

| Method | Input (`request`) | Output |
| --- | --- | --- |
| `evaluate` | `points {mjd, latDeg, lonDeg, altKm}` (UTC MJD) or `raw [{mjd, sunRaRad, sunDecRad, lonRad, latRad, altKm, inputs[9]}]` (the arguments of SET's subroutine); `jb2008 {rows}`; optional `correction {degree, segments [{fromMjd, toMjd, coefficients}]}`; `derivative`; `diagnostics` | `result`: `density` (kg/m³), `deltaT` (K), `lstHours`, `dLnRhoDT` (1/K, with `derivative`), `sunLonDeg`/`sunLatDeg` (with `diagnostics`), `refused` |
| `calibrate` | the same points plus `rho` (and optional `weight`); `degree`, `binHours`, `fromMjd`, `toMjd`, `logSigma`, `priorSigmaK` (per degree), `minPoints`, `iterations`, `editSigma` | `calibration`: per bin `coefficients` (K), `sigmas`, `n`, `used`, `prefitRms`, `postfitRms` (log density), `iterations`, `converged` |

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
| SDK compliance | `space-data-module-sdk` `validateArtifactWithStandards` | pass |
