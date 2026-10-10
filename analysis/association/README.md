# Observation association

Associates observations with catalog predictions for catalog maintenance:
which object each radar, optical or RF observation belongs to, how well it
fits, whether that is ambiguous, and which observations fit nothing
(uncorrelated tracks, UCTs). C++ through the SDK's
`dist/isomorphic/module.wasm`; `wasi-sequential`.

## Method `associate_observations`

| Port | Direction | Type | Content |
| --- | --- | --- | --- |
| `radar_observations` | in | `$RDO` | RANGE, RANGE_RATE or Doppler (DOPPLER, DOPPLER_FREQUENCY), AZIMUTH, ELEVATION |
| `optical_observations` | in | `$EOO` | RA, DECLINATION, AZIMUTH, ELEVATION, RANGE, RANGE_RATE |
| `rf_observations` | in | `$RFO` | RANGE, RANGE_RATE or Doppler (FREQUENCY, NOMINAL_FREQUENCY), AZIMUTH, ELEVATION |
| `predictions` | in | `$OEM` | One block per catalog object span, with COVARIANCE_MATRIX_LINES |
| `earth_orientation` | in, optional | `$EOP` | Rows bracketing the observations; required for Earth-fixed sensors or predictions |
| `options` | in, optional | JSON | Below |
| `radar_associated`, `optical_associated`, `rf_associated` | out | `$RDO`, `$EOO`, `$RFO` | The associated records, identity set, `UCT` false |
| `radar_ucts`, `optical_ucts`, `rf_ucts` | out | `$RDO`, `$EOO`, `$RFO` | The uncorrelated records, `UCT` true |
| `report` | out | JSON | Every candidate's d², p-value, posterior, residuals and geometry |

Every SDS port also accepts the aligned-binary peer of its type (the same
FlatBuffer bytes on an 8-byte boundary). Plain and size-prefixed frames are
both read.

### Observations

A field is a measurement when its 1-sigma uncertainty (`*_UNC`) is positive.
`OB_TIME` is UTC. Units are the records': km, km/s, degrees.

- **Sensor.** `$RDO`: `SENX/SENY/SENZ` (km) in `SEN_REFERENCE_FRAME`
  (ITRF/ECEF when empty, or GCRF/J2000). `$EOO`: `SENX/SENY/SENZ` or, when
  those are zero, `SENLAT/SENLON/SENALT` (WGS-84), in `SEN_REFERENCE_FRAME`
  (ITRF when absent). `$RFO`: `SENLAT/SENLON/SENALT`. Range rate, azimuth
  and elevation need an Earth-fixed sensor.
- **RA and declination** (`$EOO`) are topocentric in `REFERENCE_FRAME`:
  J2000 when absent (the record's own default), or GCRF/ICRF.
- **Doppler.** `$RFO` (SatNOGS style), with no `RANGE_RATE_UNC`:
  `FREQUENCY` and `NOMINAL_FREQUENCY` (MHz) give the one-way, first-order
  range rate `c (1 - f / f0)`, with 1-sigma `FREQUENCY_UNC` (MHz, required).
  `$RDO`, with no `RANGE_RATE_UNC`: `DOPPLER` (Hz, 1-sigma `DOPPLER_UNC`) is
  a monostatic radar's two-way shift of its carrier `DOPPLER_FREQUENCY` (Hz,
  required), range rate `-c DOPPLER / (2 DOPPLER_FREQUENCY)`.
- Biases (`*_BIAS`, `TIMING_BIAS`) are not applied. Angles are geometric:
  no aberration, no refraction.

### Predictions

`$OEM`, `TIME_SYSTEM` UTC, centred on Earth, in GCRF, ICRF, J2000, EME2000,
TEME or an ITRF realization; covariance in the state frame or
`RSW_INERTIAL`. The state is Lagrange-interpolated (`INTERPOLATION_DEGREE`,
default 7); the covariance is the line at the observation time, or the
linear interpolation of the two around it. A block without covariance is
refused: there is no default. A block that does not span an observation is
not a candidate for it.

### Method

1. **Geometry, in GCRF.** Earth-fixed sensors and predictions are rotated by
   the `foundation/frames` chain (ERFA, IAU 2006/2000A, CIO based) with the
   supplied `$EOP`. An Earth-fixed point moves with the rate of that
   rotation (a ±1 s central difference of the same chain, UT1 advancing
   at 1 − LOD/86400): r_g = Mᵀ r, v_g = Mᵀ v + Ṁᵀ r, so polar motion and
   precession-nutation enter as well as the Earth rotation angle. The
   report gives each observation's `sensor_gcrf_km` and
   `sensor_velocity_gcrf_km_s` (null for an inertial sensor, which carries
   no velocity). The predicted state is taken at the emission time t − tau,
   tau = |r(t − tau) − s(t)| / c. Range rate is the derivative of that range,
   u·(v − v_s) / (1 + u·v / c).
2. **Gate.** For every observation and every prediction covering its time:
   the innovation nu = z − h(x) over the measured components (RA and
   azimuth wrapped), the Jacobian H at the predicted state,
   S = H P Hᵀ + R with R = diag(sigma²), and d² = nuᵀ S⁻¹ nu (Cholesky).
   A prediction is in the gate when d² ≤ the chi-square quantile of the
   observation's dimension m at `gate_probability`.
3. **Probability.** p-value = Q(m/2, d²/2), the chi-square tail. Posterior
   p_j = L_j / (beta + Σ L_k) over the in-gate candidates, with
   L = exp(−d²/2) / sqrt(det 2πS) and beta = `clutter_density`.
4. **Assignment.** Observations of one scan (by default one sensor at one
   time) are assigned jointly by the Hungarian method: each to at most one
   object and each object to at most one observation of the scan, minimising
   the summed d², where leaving an observation unassigned costs its gate.
5. **Outcome.** An assigned observation is re-emitted with `UCT` false,
   `SAT_NO` (`$EOO`: `NORAD_CAT_ID`) and `ON_ORBIT` (`$EOO`: `ID_ON_ORBIT`)
   set to the prediction's object, and the posterior in `$RDO` and `$EOO`
   `CORR_QUALITY` or `$RFO` `CONFIDENCE`. Every record, associated or not,
   carries `CORR_MAHALANOBIS_SQ` (d²), `CORR_DOF`, `CORR_GATE`,
   `CORR_P_VALUE` and `CORR_AMBIGUOUS`; a UCT's d² and p-value are its
   nearest candidate's (0 when no prediction covered it). The others are UCTs, with the reason
   `no-prediction`, `outside-gate` or `lost-assignment`. An observation is
   **ambiguous** when its assigned candidate's posterior is below
   `min_posterior`, or when the assignment gave it other than its best
   candidate.

### Options

| Field | Default | |
| --- | --- | --- |
| `gate_probability` | 0.9973 | Gate as a chi-square probability |
| `light_time` | true | Light-time correction |
| `min_posterior` | 0.99 | Posterior below which an association is ambiguous |
| `clutter_density` | 0 | New-object density beta in the posterior |
| `scan` | `sensor_time` | `sensor_time`, `track` (`TRACK_ID`) or `observation` (no joint constraint) |
| `max_candidates` | 5 | Out-of-gate candidates listed per observation |
| `geometry` | true | Predicted GCRF state and position covariance per listed candidate |

## Method `solve_assignment`

The same Hungarian solver on any problem: `{cost: [[...]]}` (null =
forbidden) or `{rows, columns, entries: [[i, j, c]]}`, optional
`unassigned_cost` (one number or one per row). Returns the column per row
(−1 = unassigned) and the total cost.

## Records

The association statistics are SDS fields (spacedatastandards.org 1.241.0):
`CORR_MAHALANOBIS_SQ`, `CORR_DOF`, `CORR_GATE`, `CORR_P_VALUE` and
`CORR_AMBIGUOUS` on `$RDO`, `$EOO` and `$RFO`, `$RDO` `CORR_QUALITY`, and
the Doppler inputs `$RFO` `FREQUENCY_UNC` and `$RDO` `DOPPLER_FREQUENCY`.
The JSON report adds every candidate's residuals, posterior and geometry.

## Verification

```sh
npm ci
node build.mjs
npm test
node --test tests/sdk_compat.test.mjs
PATH="$HOME/.wasmedge/bin:$PATH" node tests/parity.mjs
```

| Test | Reference | Tolerance |
| --- | --- | --- |
| Gate thresholds, m = 1..6, P = 0.90..0.999 | NIST/SEMATECH e-Handbook 1.3.6.7.4 chi-square table | 5e-4 (half the printed digit) |
| Assignment | Seeded problems of the OR-Library sizes (dense 100 and 200, sparse 800), optimum by an independent Hungarian method (`tests/assignment-problems.mjs`) | exact (integer costs) |
| Global vs nearest-neighbour assignment, posterior, RSW covariance, the records' `CORR_*` | closed form and exhaustive enumeration | 1e-6 relative |
| `$RDO` two-way Doppler | the same range rate as `RANGE_RATE`, closed-form conversion | 1e-9 relative in d² |
| Earth-fixed sensor to GCRF | Vallado, *Fundamentals of Astrodynamics and Applications* 4th ed., §3.7 worked example (2004-04-06) | 2 cm (ERFA reproduces the printed vector to 1.1 cm) |
| GNSS association | Synthetic GNSS day (2026-08-02, SGP4 truth): truth orbits with a few-millimetre offset from the catalog's; radar, optical and Doppler observations generated at three IGS sites | no unflagged wrong association; Galileo and two withheld GPS satellites are UCTs; p-values uniform (KS, alpha 0.01) |

The GNSS fixture (`tests/fixtures/gps-20260802.json.gz`) is built by
`scripts/build-gps-fixture.mjs` from SGP4 truth: 32 GPS-like and 24 Galileo-like
satellites, the GPS-like ones through `files/orbit-products` and
`analysis/reference-states` to GCRF states with covariance. The ESA/ESOC and IGS
final orbits it once held are not redistributable and are not used. [`conformance/parity.json`](conformance/parity.json) is the
tri-runtime receipt: Chrome, native WasmEdge and Docker WasmEdge, worker
widths 1/2/4/8, byte-identical.
