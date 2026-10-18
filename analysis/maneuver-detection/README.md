# Maneuver detection

FFM (Full Force Model) is defined in [the FFM specification](../../propagator/ffm/FFM.md).

Maneuver detection over any pluggable propagator. The module holds no
propagator: it asks for each element set's trajectory on a query port, the
host routes the query to whatever propagator is plugged in (SGP4, full-force
FFM, any provider of the propagator ABI), and the module compares the
trajectories it gets back. It also checks planned maneuvers against operator
ephemerides and scores detections against truth. Every output is
byte-identical in the browser, WasmEdge and Docker WasmEdge.

| Method | In | Out |
| --- | --- | --- |
| `detect_maneuvers` | element sets (`$OMM`) and their trajectories, or per-set trajectories (`$OEM`) | `$MNV` DETECTED |
| `compare_ephemerides` | ephemeris versions (`$OEM`), planned maneuvers (`$MNV`) | `$MNV` EXECUTED / CANCELLED / UNKNOWN, version changes |
| `score_detections` | detected and truth `$MNV` | recall, time error, delta-V ratio, false alarms (`$MDE`) |

Every method also writes one `$MDE` (maneuver detection evidence) on `report`:
the detect, compare or score report arm. Nothing between modules is JSON;
`study/lib/mde.mjs` renders `$MDE` and `$PRW` records for reading on the host.

## `detect_maneuvers`

| Port | Direction | Type | Content |
| --- | --- | --- | --- |
| `element_sets` | in | `$OMM` | Element sets, plain or a stream of size-prefixed records. Grouped by `NORAD_CAT_ID` (else `OBJECT_ID`, else `OBJECT_NAME`); one set per `EPOCH`, a later record replacing an earlier one |
| `propagation` | in | `$OEM` | Answers to `propagation_requests`: one data block per query, in query order |
| `ephemerides` | in | `$OEM` | Per-set trajectories supplied by the caller instead: one block per element set spanning its neighbouring sets' epochs, grouped by object and ordered by the middle of their span |
| `error_model` | in | `$ERM` (`MODEL`, form `ElementSetModel`) | Optional: `analysis/gp-error-model`'s covariance of SGP4 prediction error by regime and age (`data/e14-s3-kc.erm`). With it every impulsive event between element sets is estimated as one impulse with its uncertainty ([below](#the-impulse-and-its-uncertainty)) |
| (config) | node config | `ModuleConfig` (MCFG) | The options below, as the node's configuration (`plugin.getConfig`, read with `sdm_piv::get_config`) under the `detect` table (keys `detect.*`); every key optional. Keys outside `detect.*` belong to other modules sharing a flow's config and are not read; an unknown key inside `detect.*` is refused. Not an input frame |
| `propagation_requests` | out | `$PRW` (`WINDOW_REQUEST`) | The trajectories the detector needs |
| `maneuvers` | out | `$MNV` | One record per detected maneuver |
| `report` | out | `$MDE` (`DETECT_REPORT`) | Run status, duplicate epochs, refused sets, the options used, and per object: the crossing pairs, the levels (with `report_levels`), every event each detector raised with its evidence, and the emitted events (`MNV_ID` names each `$MNV`) |

### The propagator query port

The pattern is `analysis/estimation`'s inverted port: the request is
stateless and replayed.

1. Call with `element_sets` (the node configuration may name the
   `propagator_port_id` the host routes to). The module answers on
   `propagation_requests` with one `$PRW` whose `WINDOW_REQUEST` holds
   `PROPAGATOR_PORT_ID`, `NEIGHBOUR_SETS`, `INSTRUCTIONS` and one
   `PRWWindowQuery` per element set: `SEQUENCE`, `SET_INDEX`, `OBJECT_KEY`,
   `NORAD_CAT_ID`, `OBJECT_ID`, `SOURCE_EPOCH`, `START`, `STOP` (`TIMInstant`,
   UTC, ISO 8601 to the millisecond) and `STEP_SECONDS`. `SET_INDEX` indexes
   the `$OMM` record in input order. The span runs from the epoch
   `neighbour_sets` sets earlier to the epoch `neighbour_sets` sets later,
   clamped at the ends. The `$MDE` report says `NeedsPropagation` with the
   query count.
2. The host routes every query to the plugged propagator. Each answer is one
   `$OEM` data block with these properties:
   - it is the trajectory of that set alone;
   - it covers `START` to `STOP`;
   - samples are no more than `STEP_SECONDS` apart;
   - UTC, km, km/s;
   - Earth-centred axes, inertial (GCRF, ICRF, J2000, EME2000, TEME, CIRS,
     MOD, TOD, TOE, B1950) or Earth-fixed (ITRF, ECEF, EFG, WGS84, GTOD).

   A set the propagator refuses is answered by an empty block whose `COMMENT`
   begins `REFUSED`.
3. Call again with the same `element_sets` and configuration, plus the answers on
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
| `propagator/ffm` 1.3.0 | `analysis/epoch-state` GCRF state at each set's epoch, then a full-force execution request forwards to the span's end and backwards to its start, sampled at the query's times |

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
| `EVENT_START_TIME`, `EVENT_END_TIME` | The event time (impulsive: equal); with an error model, the burn-time posterior's mode |
| `DELTA_VEL_U` | Radial: 0 without an error model; with one, the impulse estimate's |
| `DELTA_VEL_V`, `DELTA_VEL_W` | In-track and cross-track delta-V, km/s; without an error model 0 unless that component's test fired, with one the impulse estimate's; positive W is along the orbit normal |
| `DELTA_VEL` | The magnitude; with an error model, the posterior mean of the impulse's magnitude |
| `DELTA_POS_U`, `_V`, `_W`, `DELTA_POS` | With an error model: post-burn minus pre-burn position at the event time, km |
| `COV` | With an error model: the covariance of (`DELTA_POS_U`, `_V`, `_W`, `DELTA_VEL_U`, `_V`, `_W`), UVW, km and km/s, 21 values, upper triangle, row-major |
| `MANEUVER_UNC` | Separation of the two trajectories at the event time, km |
| `PRE_EVENT`, `POST_EVENT` | Osculating two-body states and elements at the event time (μ = 398600.4418 km³/s²); with an error model, each set's 1-sigma position there (`SIGMA_U`, `_V`, `_W`, km) |
| `DESCRIPTION` | With an error model: the 1-sigma delta-V, the magnitude and its 1-sigma, the burn window, the minimum two-impulse bound and its 1-sigma, the position mismatch's chi-square and the error-model cells. SDS 1.249.0's `$MNV` has no field for the window or the bound |
| `CHARACTERIZATION` | DEORBIT (post perigee under 120 km); GEO (period 1300–1600 min, e < 0.05): STATION_KEEPING when \|Δa\| < 5 km, else PHASING; then COMBINED, OUT_OF_PLANE, ORBIT_RAISING or ORBIT_LOWERING |
| `MNVR_ACCEL_TIMES`, `MNVR_ACCELS` | D3: the change of in-track acceleration, as U, V, W (radial 0, in-track, cross-track 0; km/s²) |
| `ALGORITHM` | Detector and propagator port, and the error model when given |
| `SOURCED_DATA` | The two bracketing sets (`EPOCH`, and the `$OMM` `COMMENT`, e.g. its GP_ID) |
| `PROVENANCE` | Below |

### The impulse and its uncertainty

With an error model (`error_model`), each event the detectors raise between
element sets A (the last before it, epoch tA) and B (the first after it, tB),
D3's excepted, is one impulse at an unknown time tb in [tA, tB]:

- **Covariance of a set.** `analysis/gp-error-model`'s rule: the regime from
  the set's mean altitude (SGP4's un-Kozai'd mean motion, WGS-72) and its
  eccentricity, the RTN covariance linear in age between bin centers, held
  beyond them, times the cell's factor when it has one. B is predicted
  backwards: the model at the same age with time reversed (velocity, T and N
  change sign).
- **Given tb.** The two trajectories differ by the impulse alone,
  x_B(tb) − x_A(tb) = [0; Δv] + e, e ~ N(0, R), R = P_A + P_B in the RTN axes
  of A at tb. Δv is Gaussian with mean δv − R_vr R_rr⁻¹ δr and covariance
  R_vv − R_vr R_rr⁻¹ R_rv.
- **The burn time.** p(tb) ∝ |R_rr|^(−1/2) exp(−δrᵀ R_rr⁻¹ δr / 2), uniform
  prior over the bracket, on a grid at most 10 s apart and ten points in every
  grid cell above 10⁻⁹ of the largest weight. The event time is the mode, the
  burn window the central 99.73 %.
- **The estimate.** The mixture over tb: `DELTA_VEL_U`, `_V`, `_W` its mean,
  `COV` its covariance (each Δv(tb) in the RTN axes at its own tb), and
  `DELTA_VEL` the mean of the magnitude. A plane change can be made at either
  node: its sign in W is ambiguous and its magnitude is not; `DESCRIPTION`
  counts the modes.
- **One impulse that does not fit.** When the mismatch's chi-square at the
  mode exceeds 14.16 (three degrees of freedom, 99.73 %), the trajectories do
  not meet (several burns, a long burn, or a set fitted across the burn): R is
  scaled by chi-square / 3 and the posterior taken again.
- **The minimum two-impulse bound.** Δv1 at t1 and Δv2 at t2 > t1 in the
  bracket that take A onto B: every pair of times on a grid ranked by the
  transfer linearized about A (two-body and J2 transition matrix), the 24 best
  and their neighbors solved under the nonlinear relative dynamics about A,
  the least |Δv1| + |Δv2|, and its 1-sigma from R at t2. It meets the
  trajectories exactly, errors included, so it can exceed the true impulse.

### `PROVENANCE`

Every `$MNV` this module writes carries a `$PVN`:
- `PRODUCER` is this module and its version (`com.digitalarsenal.analysis.maneuver-detection 0.8.0`);
- `SOURCE_ID`, `SOURCE_KIND`, `ORIGINATOR`, `PROVIDER_ID`, `LICENSE_CLASS`, `LICENSE_ID` and `LINEAGE` are the input's `PROVENANCE`: the `$OMM` element sets for `detect_maneuvers`, the planned `$MNV` for `compare_ephemerides`;
- an input without a `PROVENANCE` (an `$OEM`) gives a record that names only its producer, with `LICENSE_CLASS` Unspecified, which is never a grant;
- an object whose element sets name different sources gets the fields they agree on. A field they differ in is empty, and licence classes that differ give CiteOnly.

## `compare_ephemerides`

The method checks operator files against each other. Its inputs:
- `versions`: one `$OEM` per version, `CREATION_DATE` its issue time, one
  block per object;
- `planned`: `$MNV` records, with `EVENT_START_TIME` the TIG, `DELTA_VEL` the
  planned size, `DELTA_VEL_W` (cross-track, UVW) when the plan leaves the
  orbit plane, and `PROVENANCE`, which the check carries;
- configuration (`ModuleConfig`): `margin_s` (600), `post_start_after_s` (3600),
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

The report (`$MDE` `COMPARE_REPORT`) gives, per object, every version change
(mode, window, semi-major axis change, in-track and cross-track delta-V, gap)
and every planned check (pre and post versions, modelled and executed change,
status), with the executed, cancelled, undecided and unplanned counts.

## `score_detections`

The inputs are `detected` and `truth` (`$MNV`); the configuration (`ModuleConfig`) holds:
- `before_s`, `after_s`: the match window [truth start − before, truth end +
  after];
- `bins_mps`;
- `explained`, `assessed` and `spans`: lists of `{object, from, to}` (TableList).

Matching:
- pairs are one-to-one, nearest first;
- truth delta-V is `DELTA_VEL`, or the integral of `MNVR_ACCEL_TIMES` /
  `MNVR_ACCELS` (each value held until the next time).

The report (`$MDE` `SCORE_REPORT`) gives:
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

The impulse estimate (`tests/dv-uncertainty.e2e.mjs`, error model
`data/e14-s3-kc.erm`):

- **Synthetic truth.** 500 known impulses in RTN (radial and cross-track up to
  1.5 m/s, in-track 0.3 to 3 m/s) inserted in `propagator/ffm` full-force
  trajectories of 50 random LEO orbits (520 to 770 km), with SGP4 sets fitted
  every 8 hours (`study/dv-mc-truth.mjs`, `tests/dv-mc-truth.json`). With
  2-day fit spans the sets' errors at the burn are at the error model's level;
  0.75-day spans gave twice its along-track error. All 500 detected.

  | | Within 1 sigma | Within 3 sigma |
  | --- | --- | --- |
  | U (radial) | 72.0 % | 100 % |
  | V (in-track) | 95.2 % | 100 % |
  | W (cross-track) | 85.8 % | 100 % |
  | Magnitude | 76.8 % | 100 % |

  The burn time was inside the 99.73 % window in every trial.
- **Cosmos 2612 (NORAD 68762), 2026-09-28 to 2026-10-17**, Space-Track GP
  history (ICEYE-X36, 59103: no event):

  | Event time | U, V, W (m/s, 1 sigma) | Magnitude (m/s) | Two-impulse bound (m/s) | Chi-square |
  | --- | --- | --- | --- | --- |
  | 2026-09-30 09:15 | 0.9 ± 29.9, 21.5 ± 8.6, 12.0 ± 45.5 | 29.7 ± 24.6 | 25.50 ± 0.21 (8.3 at 07:03, 17.2 at 09:25) | 125284: one impulse does not fit |
  | 2026-10-07 10:55 | 0.0 ± 0.1, 0.0 ± 0.04, −0.1 ± 4.0 (9 modes, a plane change) | 3.99 ± 0.22 | 3.98 ± 0.23 | 0.1 |
  | 2026-10-12 02:33 | −1.1 ± 29.2, −31.3 ± 8.5, −9.0 ± 42.1 | 35.5 ± 18.8 | 28.52 ± 0.34 (10.9 at 01:53, 17.6 at 02:45) | 105256: one impulse does not fit |
  | 2026-10-15 01:58 | 0.15 ± 0.50, −1.27 ± 0.04, 0.45 ± 0.23 | 1.44 ± 0.13 | 1.39 ± 0.24 | 0.1 |
  | 2026-10-16 06:40 | −0.92 ± 0.44, 1.26 ± 0.04, 0.12 ± 0.22 | 1.61 ± 0.22 | 1.37 ± 0.19 | 6.8 |

## Limits

- Detection works on element-set history. It waits for the next element
  sets: hours for the ISS, a day or more for GNSS and GEO, and up to two weeks
  after some Metop-SG and Galileo burns, when Space-Track issued no sets.
- Thresholds are the ISS tuning window's. For GNSS, D2's in-track floor
  (0.04 m/s) flags 3.7 GP level steps a year that precise orbits do not
  show. For GEO, both floors are above east-west trims.
- Burns minutes apart are one event.
- Without an error model the radial component is not estimated. With one,
  each set's covariance is the error model's for its regime and age: the
  model does not know a set's fit span, and the first sets after a burn are
  often fitted over a few hours.
- The bracket is the two sets' epochs: a burn before the first set's epoch
  (a set fitted across it) is outside it.
- D3 is off by default: it fires 2.3 times a year on the ISS, above the
  plan's limit of 2.
- Measurement-level detection (the estimation module's innovations) is not
  built here.

## Build, test, parity

```sh
npm ci
npm run build
npm test                                          # E2E: 15 cases through the built module
node tests/dv-uncertainty.e2e.mjs                 # E2E: the impulse estimate (synthetic truth, and the GP archive's Cosmos 2612 window)
PATH=$HOME/.wasmedge/bin:$PATH npm run test:parity   # browser, WasmEdge, Docker WasmEdge
```
