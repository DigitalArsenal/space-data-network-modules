# Maneuver detection

Maneuver detection over any pluggable propagator. The module holds no
propagator: it asks for each element set's trajectory on a query port, the
host routes the query to whatever propagator is plugged in (SGP4, full-force
HPOP, any provider of the propagator ABI), and the module compares the
trajectories it gets back. It also checks planned maneuvers against operator
ephemerides and scores detections against truth. Every output is
byte-identical in the browser, WasmEdge and Docker WasmEdge.

| Method | In | Out |
| --- | --- | --- |
| `detect_maneuvers` | element sets (`$OMM`) and their trajectories, or per-set trajectories (`$OEM`) | `$MNV` DETECTED |
| `compare_ephemerides` | ephemeris versions (`$OEM`), planned maneuvers (`$MNV`) | `$MNV` EXECUTED / CANCELLED / UNKNOWN, version changes |
| `score_detections` | detected and truth `$MNV` | recall, time error, delta-V ratio, false alarms (JSON) |

## `detect_maneuvers`

| Port | Direction | Type | Content |
| --- | --- | --- | --- |
| `element_sets` | in | `$OMM` | Element sets, plain or a stream of size-prefixed records. Grouped by `NORAD_CAT_ID` (else `OBJECT_ID`, else `OBJECT_NAME`); one set per `EPOCH`, a later record replacing an earlier one |
| `propagation` | in | `$OEM` | Answers to `propagation_requests`: one data block per query, in query order |
| `ephemerides` | in | `$OEM` | Per-set trajectories supplied by the caller instead: one block per element set spanning its neighbouring sets' epochs, grouped by object and ordered by the middle of their span |
| `options` | in | JSON | Below; every field optional |
| `propagation_requests` | out | JSON | The trajectories the detector needs |
| `maneuvers` | out | `$MNV` | One record per detected maneuver |
| `report` | out | JSON | Per object: the pairs, the levels (with `report_levels`), each detector's events and their evidence |

### The propagator query port

The pattern is `analysis/estimation`'s inverted port: the request is
stateless and replayed.

1. Call with `element_sets` (and `options`, which may name the
   `propagator_port_id` the host routes to). The module answers on
   `propagation_requests`, `{status: "needs-propagation", propagator_port_id,
   neighbour_sets, queries: [...]}`. There is one query per element set:
   `{sequence, object, norad, object_id, set, epoch, start, stop, step_s}`.
   `set` indexes the `$OMM` record in input order. The span runs from the
   epoch `neighbour_sets` sets earlier to the epoch `neighbour_sets` sets
   later, clamped at the ends.
2. The host routes every query to the plugged propagator. Each answer is one
   `$OEM` data block with these properties:
   - it is the trajectory of that set alone;
   - it covers `start` to `stop`;
   - samples are no more than `step_s` apart;
   - UTC, km, km/s;
   - Earth-centred axes, inertial (GCRF, ICRF, J2000, EME2000, TEME, CIRS,
     MOD, TOD, TOE, B1950) or Earth-fixed (ITRF, ECEF, EFG, WGS84, GTOD).

   A set the propagator refuses is answered by an empty block whose `COMMENT`
   begins `REFUSED`.
3. Call again with the same `element_sets` and `options`, plus the answers on
   `propagation`. The module rebuilds the queries from the element sets and
   checks each answer against its query: same object, span covered, step
   respected. An answer out of order, or short of its span, is refused, so it
   can never be paired with the wrong set.

The spans are those of `propagator/sgp4`'s `propagate_ephemeris` with
`element_set_blocks` and the same `neighbour_sets`, so an SGP4 host answers a
whole object in one call. Earth-fixed answers (what the propagator ABI's
providers write) are turned to TEME by GMST (IAU 1982, UT1 = UTC) with
velocity v + ω × r: the inverse of the providers' own TEME → Earth-fixed
rotation. Every comparison is between two states at one instant, so one
shared rotation leaves delta-V unchanged.

Host adapters used in the study (`study/lib/`), as examples:

| Provider | Route |
| --- | --- |
| `propagator/sgp4` | `propagate_ephemeris`, TEME, one call per object |
| `propagator/keplerian-reference` | the propagator ABI (`plugin_init_omm`, `plugin_propagate`), Earth-fixed metres written as km |
| `propagator/hpop` 1.3.0 | `analysis/epoch-state` GCRF state at each set's epoch, then a full-force execution request forwards to the span's end and backwards to its start, sampled at the query's times |

### Detectors

Defaults are frozen from the ISS tuning window
([PLAN-2026-10](docs/studies/PLAN-2026-10.md), amendment A6).

| | Quantity | Test | Event time |
| --- | --- | --- | --- |
| D1 | At the crossing t* of consecutive trajectories: in-track delta-V from the energy change, v Δa / 2a; cross-track from the orbit-normal change, −v Δĥ · T̂ | Median-of-`median_sets` step in each set's cumulative level, against `k` × 1.4826 MAD over ±`scale_window_pairs` and a floor | t* of the event's largest jump |
| D2 | In-track: each set's orbit-averaged semi-major axis over one revolution about its own epoch. Cross-track: a chain of each set's mean orbit normal against the previous set's, both over that revolution | For each gap: robust (Huber, 1.345σ) regression over ±`glr_span_days` and up to `glr_sets` sets per side, of a level, a drag trend and a step. Λ = (δ / s_δ)², the generalised likelihood ratio for a jump (Willsky and Jones 1976), against `glr_h`² and a floor. Steps are accepted strongest first, each then a known regressor. A second step in one window needs two agreeing sets between them | The crossing of the last set on the old level and the first on the new |
| D3 | D2's in-track levels | Hinge regression y = a + b(t − τ) + g(t − τ)₊ over ±`lt_span_days`, Λ_g against `lt_h`² and `lt_floor_mps_per_day`; the hinge must fit better than a step | The gap's middle |
| C | D1 and D2 events of one object within `merge_hours` are one event | | D2's time and delta-V when they come from a crossing, else D1's |

D2's level of a set is taken where that set's fit is centred. A set fitted
across a burn can absorb the burn in its drag term; D1's crossing chain then
loses part of it, and D2's level does not. The revolution starts at the
ascending node (or the +x axis within 1° of the equator) fixed at the set's
epoch, so what remains of the short-period terms is the same constant for
every set. Each revolution is averaged over 64 samples.

| Option | Default | Meaning |
| --- | --- | --- |
| `detectors` | `["D1", "D2"]` (C) | Any of D1, D2, D3 |
| `propagator_port_id` | none | Echoed in the queries and in `$MNV` `ALGORITHM` |
| `neighbour_sets` | 2 | Sets on each side of a query's span |
| `grid_step_s` | 60 | Answer sample step and crossing-search grid, s |
| `k`, `floor_in_track_mps`, `floor_cross_track_mps`, `median_sets`, `scale_window_pairs` | 8, 0.08, 1.0, 3, 100 | D1 |
| `glr_sets`, `glr_span_days`, `glr_h`, `glr_floor_in_track_mps`, `glr_floor_plane_rad` | 8, 3, 10, 0.04, 4e-4 | D2 (the plane floor is an angle: v × angle in m/s, 3.1 m/s at the ISS) |
| `lt_h`, `lt_floor_mps_per_day`, `lt_span_days`, `lt_sets` | 6, 0.05, 5, 20 | D3 |
| `merge_hours` | 12 | C |
| `report_time` | first `CREATION_DATE` | `REPORT_TIME` of every event |
| `report_pairs`, `report_levels` | true, false | Report detail |

### `$MNV` fields

Delta-V is in UVW as the Astrodynamics Standards and the VCM define it: U radial,
V in-track (W × U), W cross-track along the orbit normal; km/s.

| Field | Value |
| --- | --- |
| `EVENT_START_TIME`, `EVENT_END_TIME` | The event time (impulsive: equal) |
| `DELTA_VEL_U` | Radial: not estimated, 0 |
| `DELTA_VEL_V`, `DELTA_VEL_W` | In-track and cross-track delta-V, km/s, 0 unless that component's test fired; positive W is along the orbit normal |
| `MANEUVER_UNC` | Separation of the two trajectories at the event time, km |
| `PRE_EVENT`, `POST_EVENT` | Osculating two-body states and elements at the event time (μ = 398600.4418 km³/s²) |
| `CHARACTERIZATION` | DEORBIT (post perigee under 120 km); GEO (period 1300–1600 min, e < 0.05): STATION_KEEPING when \|Δa\| < 5 km, else PHASING; then COMBINED, OUT_OF_PLANE, ORBIT_RAISING or ORBIT_LOWERING |
| `MNVR_ACCEL_TIMES`, `MNVR_ACCELS` | D3: the change of in-track acceleration, as U, V, W (radial 0, in-track, cross-track 0; km/s²) |
| `ALGORITHM` | Detector and propagator port |
| `SOURCED_DATA` | The two bracketing sets (`EPOCH`, and the `$OMM` `COMMENT`, e.g. its GP_ID) |

## `compare_ephemerides`

The method checks operator files against each other. Its inputs:
- `versions`: one `$OEM` per version, `CREATION_DATE` its issue time, one
  block per object;
- `planned`: `$MNV` records, with `EVENT_START_TIME` the TIG and `DELTA_VEL`
  the planned size;
- `options`: `margin_s` (600), `post_start_after_s` (3600),
  `executed_fraction` (0.5), `cancelled_fraction` (0.25),
  `unplanned_threshold_km` (off), `within_version` (false).

Comparisons use orbit-averaged semi-major axis and mean orbit normal over
whole revolutions.
- **Consecutive versions:** the newer version's first revolution is compared
  with the older version over the same revolution (the new orbit
  determination against the old forecast: executed minus planned). When the
  older version does not reach it, the comparison is with its last
  revolution (adjacent arcs, e.g. precise daily orbits).
- **A planned burn:**
  - the pre-burn version is the latest issued before the TIG, and models the
    burn as a step across it;
  - the post-burn version is the first that starts at least
    `post_start_after_s` after the TIG. All of its trajectory then comes from
    tracking after the burn; a file issued just after a TIG can be a re-issue
    still carrying the plan;
  - executed = modelled step + (post − pre) over the post version's first
    revolution;
  - burns with no clean post-burn version between them are checked as a
    group, the executed change shared in proportion to the plan.
- **Status:** EXECUTED when the executed size reaches `executed_fraction` of
  the plan, CANCELLED below `cancelled_fraction`, else UNKNOWN.
- **In-plane plans** (no `DELTA_VEL_W`) are judged by the in-track change.
  Across a TIG the normals of different revolutions are compared after a
  nodal-regression correction, which leaves a few tenths of a m/s of
  cross-track error in LEO.

## `score_detections`

The inputs are `detected` and `truth` (`$MNV`) and `options`:
- `before_s`, `after_s`: the match window [truth start − before, truth end +
  after];
- `bins_mps`;
- `explained`, `assessed` and `spans`: lists of `{object, from, to}`.

Matching:
- pairs are one-to-one, nearest first;
- truth delta-V is `DELTA_VEL`, or the integral of `MNVR_ACCEL_TIMES` /
  `MNVR_ACCELS` (each value held until the next time).

The report gives:
- recall with its Wilson 95 % interval, overall and by delta-V bin;
- burn-time error and delta-V ratio distributions;
- false alarms: unmatched events that are assessed and not explained, per
  object-year over `spans`;
- every match, miss and unmatched event.

## Validation

[PLAN-2026-10](docs/studies/PLAN-2026-10.md) was committed before any
held-out result (694bffdc); the thresholds were frozen at 5ca7e366. Every
held-out window was read once. Input everywhere: Space-Track GP history,
propagated by `propagator/sgp4` through the query port. Results and method:
[`docs/studies/maneuver-detection.md`](../../docs/studies/maneuver-detection.md).

| Class (held-out unless noted) | Truth | D1 | C (default) |
| --- | --- | --- | --- |
| ISS, 2025-01 to 2026-09 | 25 burns confirmed by NASA's later trajectories (4 are 0.1 m/s settling burns minutes before a reboost) | 21/25, 0 false | 22/25, 0.57 false per year |
| ISS, tuning 2020-09 to 2024-12 | 53 | 51/53, 0.46 per year | 53/53, 1.15 per year |
| Metop-SG A1, 2025-08 to 2026-09 | 24 manoeuvres (EUMETSAT AUX_MHF) | 12/24, 0 false | 14/24, 0 false |
| GNSS (4 GPS), 2025-01 to 2026-09 | 6 manoeuvres in precise orbits | 4/6, 0.16 per year | 6/6, 3.8 per year |
| GEO (Intelsat), 2025-01 to 2026-09 | 11 post-manoeuvre files | 2/11 | 4/11 |

## Limits

- Detection works on element-set history. It waits for the next element
  sets: hours for the ISS, a day or more for GNSS and GEO, and up to two weeks
  after some Metop-SG and Galileo burns, when Space-Track issued no sets.
- Thresholds are the ISS tuning window's. For GNSS, D2's in-track floor
  (0.04 m/s) flags 3.7 GP level steps a year that precise orbits do not
  show. For GEO, both floors are above east-west trims.
- Burns minutes apart are one event.
- The radial component is not estimated.
- D3 is off by default: it fires 2.3 times a year on the ISS, above the
  plan's limit of 2.
- Measurement-level detection (the estimation module's innovations) is not
  built here.

## Build, test, parity

```sh
npm ci
npm run build
npm test                                          # E2E: 13 cases through the built module
PATH=$HOME/.wasmedge/bin:$PATH npm run test:parity   # browser, WasmEdge, Docker WasmEdge
```
