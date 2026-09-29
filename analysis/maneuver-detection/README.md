# Maneuver detection

Detects maneuvers in an element-set history and emits `$MNV` records with
`STATUS: DETECTED`. The module does no propagation: the caller propagates each
element set with the provider of its choice (SGP4 for GP data, HPOP, an
operator ephemeris) and passes the trajectories as `$OEM`.

Method `detect_maneuvers`:

| Port | Direction | Type | Content |
| --- | --- | --- | --- |
| `ephemerides` | in | `$OEM` (one or more frames) | One data block per element set, Earth-centred inertial frame, UTC |
| `options` | in, optional | JSON | Thresholds (below) |
| `maneuvers` | out | `$MNV` | One frame per detected maneuver |
| `report` | out | JSON | Per-pair crossing times, jumps, steps and thresholds; each event's evidence |

## Input contract

- Each block is one element set's trajectory, sampled densely enough for cubic
  Hermite interpolation (60 s in LEO interpolates position to about 0.4 m).
- Each block spans at least its neighbouring element sets' epochs. Two
  neighbours on each side is recommended: a GP element set issued just after
  a burn is often still fit to pre-burn data, and the wider span lets the
  crossing search reach back past it.
- Blocks are grouped by `OBJECT` (`OBJECT_ID`, else `NORAD_CAT_ID`) and
  ordered by the midpoint of their span.
- Frames: GCRF, ICRF, J2000, EME2000, TEME, CIRS, MOD, TOD, TOE or B1950
  (Earth-centred). One frame per object. Earth-fixed frames are refused.
- A block's `COMMENT` (for example the element set's GP_ID and epoch) is copied
  into `SOURCED_DATA` of every event it bounds.

## Method

For each pair of consecutive blocks:

1. **Crossing.** The time t* at which the two trajectories are closest over
   their common span (60 s grid, then golden-section refinement). An impulsive
   burn keeps position continuous, so t* estimates the burn time.
2. **Jumps at t*.** Both states are at one instant and one position, so the
   propagator's periodic terms cancel:
   - in-track, from the energy change (vis-viva): dv_T = v da / (2a);
   - cross-track, from the orbit-normal change: an out-of-plane burn turns the
     normal about r, dh_hat = -(dv_N / v) T_hat, so dv_N = -v dh_hat . T_hat.
     The step test uses v (h_hat1 - h_hat0) in inertial components, which
     has no singularity at zero inclination.
3. **Step test.** Each quantity is summed into a per-element-set level. A
   pair's step is the median of the next `median_sets` levels minus the median
   of the previous ones, so one bad element set, or a settling tail after a
   burn, does not register. A pair is a candidate when either step exceeds
   `k` times the robust scale (1.4826 MAD over +-`scale_window_pairs`) and its
   absolute floor.
4. **Events.** Each run of candidates is one event, placed at the pair with
   the largest jump relative to its thresholds. A component is reported only
   if its step test fired; otherwise it is 0.

## Output

| `$MNV` field | Value |
| --- | --- |
| `EVENT_START_TIME`, `EVENT_END_TIME` | t*, the impulsive estimate (equal) |
| `DELTA_VEL_U` | In-track delta-V, km/s (0 unless its test fired) |
| `DELTA_VEL_V` | Cross-track delta-V, km/s, positive along the orbit normal (0 unless its test fired) |
| `DELTA_VEL_W` | Radial: not estimated, 0 |
| `DELTA_VEL` | Magnitude of U and V |
| `MANEUVER_UNC` | Separation of the trajectories at t*, km |
| `PRE_EVENT`, `POST_EVENT` | Osculating two-body states and elements at t* (mu = 398600.4418 km^3/s^2; apogee and perigee as altitudes over 6378.137 km) |
| `CHARACTERIZATION` | Rules below |
| `CHARACTERIZATION_UNC` | Smaller raw component over the larger (0 = one pure axis) |
| `REPORT_TIME` | `options.report_time`, else the first `$OEM` `CREATION_DATE` |
| `SAT_NO`, `ORIG_OBJECT_ID`, `SOURCED_DATA` | From the blocks |

U, V and W follow the component comments in the SDS `MNV` schema (U
along-track, V cross-track, W radial).

Characterization, in order:

1. `DEORBIT` when the post-event perigee altitude is under 120 km.
2. GEO (period 1300-1600 min, e < 0.05): `STATION_KEEPING` when |da| < 5 km,
   otherwise `PHASING`.
3. Both components fired: `COMBINED`. Cross-track only: `OUT_OF_PLANE`.
   In-track only: `ORBIT_RAISING` or `ORBIT_LOWERING` by sign.

## Options

| Key | Default | Meaning |
| --- | --- | --- |
| `k` | 8 | Robust-scale multiple |
| `floor_in_track_mps` | 0.08 | Absolute floor on the in-track step, m/s |
| `floor_cross_track_mps` | 1.0 | Absolute floor on the cross-track step, m/s |
| `median_sets` | 3 | Element sets on each side of a step |
| `scale_window_pairs` | 100 | Pairs on each side for the robust scale |
| `grid_step_s` | 60 | Crossing-search grid, s |
| `report_time` | first `CREATION_DATE` | `REPORT_TIME` of every event |

The defaults come from the ISS study (LEO GP data). The in-track floor is
0.08 m/s, which is about 0.14 km in semi-major axis at the ISS. A GEO
east-west trim of 0.05 m/s changes the semi-major axis by 1.4 km and needs a
lower floor; no GEO study has set one yet.

## Validation

`npm test`: the SDK contract, plus closed-form two-body cases (Kepler by
universal variables in the test, independent of the module):

- no burn: no event;
- 1 m/s in-track burn on a sample node: exact time, delta-V equal to the
  vis-viva value to 1 um/s;
- the same between nodes: time within 0.5 s and delta-V within 1 mm/s, the
  Hermite bound;
- 2 m/s cross-track burn: `OUT_OF_PLANE`, V = v sin(atan(dv / v)) to
  1 um/s, and U = 0 because its jump (dv^2 / 2v) is under the floor;
- one outlying element set (0.5 km higher, alone): no event;
- GEO 0.05 m/s trim with a 0.02 m/s floor: `STATION_KEEPING`, da = 2 a dv / v;
- an Earth-fixed ephemeris: refused.

ISS reboosts, 2021-03 to 2026-09 (study below). The truth is 72 burns from
NASA's public ISS trajectory archive, with execution confirmed by NASA's own
ephemerides, against Space-Track GP history propagated with SGP4:

| In-track floor | Detected | Median / 90 % burn-time error | GP da / NASA da (median) | Unexplained events |
| --- | --- | --- | --- | --- |
| 0.08 m/s (default) | 69 / 72 | 22 min / 2.9 h | 1.00 | 7 |
| 0.12 m/s | 68 / 72 | 22 min / 2.9 h | 1.02 | 4 |

"Unexplained" counts events for which NASA had issued a plan within the
previous day that lists no event within 1.5 days. Method, misses and
reproduction: [`docs/studies/maneuver-detection.md`](../../docs/studies/maneuver-detection.md).

## Limits

- Detection works on element-set history, so it waits for the next element
  set: hours for a well-tracked LEO object. Measurement-level detection, with
  a filter's innovations as the burns happen, is the next tier.
- GP element sets issued right after a burn lag it. The burn time has a
  median error of 22 min, with a tail of several hours when fits lag.
- The radial component is not estimated.
- A drag step (for example the 2024-05-10/11 geomagnetic storm) can register
  as a small negative in-track event.
- Probability of a maneuver is not stated. The report gives each step against
  its threshold.

## Build

```sh
npm install
npm run build
npm test
```
