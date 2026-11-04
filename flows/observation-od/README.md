# Observation OD: laser normal points and RA/Dec angles

`org.sdn.flows.observation-od.laser-od` 0.1.1, typed contracts 1.0 (FlatBuffers only). A C++ WebAssembly node that routes
ILRS normal points through `analysis/estimation` `fit_batch` and `propagator/ffm` `invoke` until the estimator converges, and
emits the fit as one Cartesian `$OCM`. The estimator solves and the FFM propagates; the node holds no force model and no state.

## `step`

| In | |
| --- | --- |
| `observations` | one `$TDM` per pass (`data-source/ilrs-crd-source` `read_crd`) |
| `stations` | one `$GST` per pad (`data-source/ilrs-station-coordinates` `read_sinex`) |
| `earth_orientation` | the `$PRW` EARTH_ORIENTATION record `propagator/ffm` takes |
| `execution` | a `$PRW` EXECUTION_REQUEST: INITIAL the first guess (GCRF, UTC), TARGET_EPOCH the estimate's epoch, the dynamics, DYNAMIC_PARAMETERS the solve-for parameters (DRAG_AREA_OVER_MASS, SRP_AREA_OVER_MASS, IN_TRACK_ACCELERATION; first values in FORCES) |
| `config` | optional ModuleConfig: `rangeSigmaM` 0.05, `minimumArcHours` 24, `maximumIterations` 20, `editThreshold` 5, `correctionTolerance` 0.01 |
| `estimation`, `result`, `samples` | on later calls: the `$EST` this node emitted last, `fit_batch`'s `$EST` answer, `propagator/ffm`'s `$PRW` EXECUTION_RESULT |

Each call emits one of `propagation` (a `$PRW` EXECUTION_REQUEST for `propagator/ffm` `invoke`, with its kernel and
`earth_orientation`), `estimation` (the `$EST` envelope for `fit_batch`) or `ocm`. The host routes it and calls `step` again
with the answer:

1. the first guess to every receive epoch and to TARGET_EPOCH;
2. the `fit_batch` request at TARGET_EPOCH, seeded with the guess carried there;
3. each fit round: the round's seed and parameters to every query epoch with the state transition matrix and the parameter
   columns, then the answers appended to the request;
4. the converged fit as the `$OCM`.

A normal point is a two-way laser range at its receive instant (a TRANSMIT-tagged epoch moves forward by 2 x range / c, as
`analysis/estimation` reads a `$TDM`), with the estimator's two-way light time and Marini-Murray troposphere (the pass's
meteorology; wavelength c / TRANSMIT_FREQ_1; the elevation from the first guess). The station is the pad's ITRF reference
point (the `$GST` position plus its XYZ or NEU eccentricity) in GCRF at that instant, through `foundation/frames`' IAU
2006/2000A chain with the supplied EOP. `analysis/estimation`'s `$TDM` input holds one station position for a record, so the
node passes each normal point as an observation with its own.

The `$OCM`: the estimate at TARGET_EPOCH (GCRF, km, km/s), its formal covariance (COV_CALIBRATION Uncalibrated);
ORBIT_DETERMINATION with OD_OBSERVATIONS_USED, the range residuals and their RMS, the solve-for parameters (named in
OD_EST_PARAMETERS; their fitted values in OD_DYNAMIC_PARAMETERS, typed by PARAMETER, SOLVED_FOR true), the pads, and
FIT_STATISTICS (FIT_RMS_KM the range residual RMS, FIT_STATES the normal points used, ITERATIONS, CONVERGED, FIT_START and
FIT_STOP the first and last normal point); PROVENANCE SOURCE_ID ilrs-crd, SOURCE_KIND Observation, ORIGINATOR ILRS,
LICENSE_CLASS Reproducible.

Refused by name: `no-stations` (a pad without a `$GST`, or none), `arc-too-short:<hours>` (the normal points span less than
`minimumArcHours`), `no-convergence:<iterations>` (`fit_batch` ended MAXIMUM_ITERATIONS or STALLED); `bad-input` otherwise.

## RA/Dec angles (0.2.0)

`step` also reads RA/Dec tracks (`ANGLE_TYPE` RADEC, UTC, `TIMETAG_REF` RECEIVE, degrees; data-source/satnogs-optical-source):
each `ANGLE_1`/`ANGLE_2` pair is one `RIGHT_ASCENSION_DECLINATION` observation (geometric topocentric GCRF, one-way light
time, Sagnac off: the station's GCRF motion carries the rotation, as analysis/observation-simulator predicts). The station
is the record's `OBSERVER_ID`: its site is the `$GST` with that `STATION_ID`, else the record's `OBSERVER_X/Y/Z`
(Earth-fixed, m). The sigma is the larger of `RA_UNC` and `DECLINATION_UNC` of the `$EOO` at the same `OB_TIME`
(`uncertainty`), else config `angleSigmaArcsec`. Config `timeBiasSigmaS.<OBSERVER_ID>` adds that station's time bias as a
consider `TIME_BIAS` (value the `$GST` `CLOCK_OFFSET_S`, else 0). The `$OCM` states `OD_OBSERVATIONS_TYPE` RADEC,
`OD_RESIDUAL_RMS` in arcseconds (FIT_RMS_KM NaN), the consider parameters, and the source's `$PVN` from `provenance`
(required for an angles-only fit) with this node as `PRODUCER`.

## Build and test

```sh
npm ci   # or tools/deps-bundle attach
SPACE_DATA_MODULE_SDK_COMPILE_CACHE=0 node build.mjs
node tests/laser-od.e2e.mjs
```

The E2E fits two days of Starlette normal points (`tests/fixtures/PROVENANCE.md`) with EGM2008 70x70, the Sun and the Moon,
cannonball radiation pressure, solid and ocean tides and relativity, solving for the in-track acceleration, and compares
the estimate with NSGF's orbit at the arc's end.
