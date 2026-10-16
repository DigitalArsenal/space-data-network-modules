# Observation simulator

Simulates the raw observations sensors would report for targets on known
trajectories: radar as `$RDO`, optical and laser ranging as `$EOO`, passive
RF as `$RFO`. Every record is marked simulated (`DESCRIPTOR`/`DATA_MODE`
`SIMULATED`) and carries the truth identity (`SAT_NO`, `ORIG_OBJECT_ID`),
except false alarms, which are `UCT` with no identity.

Method `simulate_observations`:

| Port | Direction | Type | Content |
| --- | --- | --- | --- |
| `request` | in | `$ACW` | `REQUEST` with `OPERATION` `SIMULATE_OBSERVATIONS` (SDS 1.242.0+) |
| `radar` | out | `$RDO` | One record per radar observation |
| `optical` | out | `$EOO` | One record per optical or laser-ranging observation |
| `rf` | out | `$RFO` | One record per passive RF observation |
| `result` | out | `$ACW` | `RESULT.TRACKS`: every scheduled track, its scheduled and detected counts and loss reasons |

## Composition

The module needs no propagator and computes no visibility:

1. Truth. `TARGETS[].STATES` holds Earth-fixed positions and velocities from
   any propagator. A maneuvering target is simply a trajectory with its
   burns.
2. Visibility. For each sensor and target, the access module
   (`COMPUTE_ACCESS_WINDOWS`) is run with that sensor's constraints. The
   resulting windows go in `ACCESS`.
3. Observations. This module schedules tracks inside those windows and
   measures them.

## Model

- **Frames and time.** Each observation instant goes from Earth-fixed to
  GCRF by the `foundation/frames` IAU 2006/2000A CIO chain (ERFA), using the
  request's `EARTH_ORIENTATION`, interpolated linearly in MJD. UTC time tags
  come from ERFA's leap-second table. Input JD dates use a consistent 0.1 ms
  grid; split TT day/seconds preserve schedule times and frame derivatives.
- **Measurements.** Each sensor's `ERROR_MODELS` list what an observation
  carries: `RANGE`, `RANGE_RATE`, `DOPPLER`, `AZIMUTH_ELEVATION`,
  `RIGHT_ASCENSION_DECLINATION` or `LASER_RANGE`. Each value is predicted by
  `analysis/estimation`'s `predict_measurement`, the same model the
  estimator inverts:
  - GCRF geometry;
  - when `APPLY_LIGHT_TIME`, two-way inertial light time with moving
    station and Earth Shapiro delay for `LASER_RANGE` and radar `RANGE`,
    `RANGE_RATE`, `DOPPLER` (Orekit Range/ShapiroModel; IERS 2010, section 11);
    other kinds keep their one-way model, and all time tags remain reception;
  - troposphere when `TROPOSPHERE_MODEL` is set, at the true elevation
    under a standard atmosphere.
  Azimuth is measured from north through east. RA/Dec are topocentric GCRF.
  Radar `DOPPLER` is two-way, as `$RDO` defines it: the echo's shift of the
  sensor's `TRANSMIT_FREQUENCY_HZ`: -2 f rdot / c, where rdot is the mean
  of the two geometric leg rates when light time is enabled. Each `$RDO`
  carries it with `DOPPLER_FREQUENCY` = f and
  `DOPPLER_UNC`, so rdot = -c `DOPPLER` / (2 `DOPPLER_FREQUENCY`). A radar
  `DOPPLER` model without `TRANSMIT_FREQUENCY_HZ` is refused.
- **Errors, per model and component.** The error is one bias for the run
  (`BIAS + BIAS_SIGMA * N(0, 1)`, per sensor and model) plus noise with
  standard deviation `NOISE_SIGMA`. The noise is a first-order Gauss-Markov
  sequence with time constant `CORRELATION_TIME_SECONDS` within a track, or
  white when that is 0. Units are SI, with angles in radians. Records
  report the sigma as their `_UNC` fields.
- **Schedule, per sensor.** Tracks are scheduled earliest deadline first
  over the open windows, one track per target at a time. The limits are
  `MAX_SIMULTANEOUS_TRACKS`, `TRACK_DURATION_S` (0 = the whole window) and
  `REVISIT_INTERVAL_S` between a target's tracks. Observations fall every
  `OBSERVATION_INTERVAL_S` from the track start. No track starts at a
  window's last instant.
- **Detection:**
  - Radar: SNR = `REFERENCE_SNR_DB` + 10 log10(RCS / `REFERENCE_RCS_M2`)
    - 40 log10(R / `REFERENCE_RANGE_M`), against `DETECTION_THRESHOLD_DB`.
    With no reference range, every observation is detected.
  - Optical: a ground host needs the Sun below `MAX_HOST_SUN_ELEVATION_RAD`
    (loss reason `DAYLIGHT`). A target in the umbra of a spherical Earth is
    lost (`ECLIPSED`). The magnitude is that of a diffuse sphere,
    m = -26.90 - 2.5 log10[(2/3) p a^2 ((pi - phi) cos phi + sin phi) /
    (pi R^2) (1 au / d_sun)^2], in the Gaia G band of `EOO.MAG`, and must
    not exceed `LIMITING_MAGNITUDE` (0 = no limit).
  - Passive RF: SNR = EIRP - 20 log10(4 pi R f / c) + G/T - 10 log10(k)
    - 10 log10(B). The reported frequency is f (1 - rdot / c), one-way, as
    `$RFO` defines it; with a `DOPPLER` error model it is f plus the Doppler
    as measured, bias and noise included, and `FREQUENCY_UNC` is the model's
    sigma.
  - Laser ranging: always detected.
- **False alarms.** A Poisson number per track at
  `FALSE_ALARM_RATE_PER_HOUR`. Each lands at a uniform time within 5 deg of
  the target's line of sight, at 0.8-1.2 times its range, with the sensor's
  noise.
- **Randomness.** Everything random derives from `RANDOM_SEED` and the
  sensor, model and track names, so one seed reproduces the output exactly.
  A track's noise does not depend on which of its observations are detected.

## Validation

`npm test`. Expected values are independent of the module:

- SDK contract.
- Vallado, *Fundamentals of Astrodynamics and Applications* 4th ed.,
  Example 3-15 (IAU 2006/2000A CIO, with its EOP). The published GCRF
  position and velocity are reproduced through RA/Dec (to the 32-bit `EOO`
  floats) and range rate (2e-8 km/s) from a geocentric observer.
- Topocentric closed form on WGS-84: azimuth, elevation and range to a
  target 300 km east, 400 km north and 500 km up, all to 1e-9. Its range
  rate is 0.
- Radar SNR (R^-4, RCS) and the threshold.
- Optical: the diffuse-sphere magnitude at 90 deg phase (to float32),
  umbra and daylight losses.
- Radar two-way Doppler: a target receding at 1 km/s, observed 2,000 times
  at 10 GHz with 20 Hz noise; association's -c `DOPPLER` /
  (2 `DOPPLER_FREQUENCY`) recovers the range rate, its mean and spread each
  within 4 standard errors.
- Passive RF: link-budget SNR and the Doppler-shifted frequency; a
  `DOPPLER` model's bias and noise in `FREQUENCY` over 2,000 observations,
  each within 4 standard errors, and its sigma as `FREQUENCY_UNC`.
- Noise statistics over 2,000 observations: bias, sigma and the
  Gauss-Markov lag-1 autocorrelation, each within 4 standard errors.
- The exact earliest-deadline-first schedule of two targets with one slot
  and a revisit gap.
- Seed reproducibility, the Poisson false-alarm count, and refusals.

The shared E2E is `analysis/estimation/tests/two-way-light-time.mjs` (build both
modules first, then run it after `tests/build-provider.mjs` in estimation).
Against Orekit 13.1 with zero EOP, a six-hour, 622 km orbit gives over eight
minutes of visibility at each of Graz, Yarragadee and Greenbelt. Its slant
ranges stay below 2,048 km, keeping EOO float rounding below 0.062 m.
Measured 2026-10-16: 156 radar and 52 laser observations, exact whole-second
UTC tags, maximum radar range/rate differences of **1.280569e-8 m** /
**4.098592e-7 m/s**, and laser float difference **0.05994681 m**. The radar
Doppler factor check passes; the one-way control differs by **1.226830 m**.
Feeding the simulated radar ranges into `fit_batch` recovers the epoch state
to **1.531794e-7 m** and **2.208263e-10 m/s**. The 1 mm radar, 1e-5 m/s rate,
0.1 m laser and 5 mm / 1e-5 m/s fit gates all pass.

## Limits

- Troposphere uses a standard atmosphere, not station weather. There is no
  ionosphere, as `ACW` carries no TEC.
- Radar detection is a deterministic SNR threshold: no Swerling fluctuation,
  probability of detection or RCS scintillation. Reported `SNR` is the mean.
- Optical: a diffuse sphere only, with no specular term, attitude or sky
  background. A penumbral target is not dimmed.
- Input JD doubles resolve about 40 us and are rounded to a 0.1 ms grid.
  Internal times retain their seconds offset; UTC output tags resolve 1 us.
- Measurement types outside the six above are refused.

## Build

```sh
npm install
npm run build
npm test
```
