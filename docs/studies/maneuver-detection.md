# Maneuver detection from element-set history

Module: `analysis/maneuver-detection` (`com.digitalarsenal.analysis.maneuver-detection` 0.1.0).
Study date: 2026-09-29.

## Question

Can a propagator-agnostic module find maneuvers in a published element-set
history, estimate when they happened and how large they were, and do so with
few false alarms? The test object is the ISS, because NASA publishes its
planned maneuvers and its own high-accuracy ephemeris, which is independent of
the GP catalog.

## Data

| Source | What | Use |
| --- | --- | --- |
| NASA JSC/FOD/TOPO ISS trajectory archive, `s3://nasa-public-data/iss-coords/<date>/` | 739 dated CCSDS OEMs (EME2000, 4 min), 2020-09 to 2026-09. Each header lists planned events: name, TIG, delta-V, resulting apogee and perigee | Truth |
| Space-Track GP history, from the SDN GP archive (`/opt/data/sdn-archive`) | 10,086 ISS element sets, 2021-01 to 2026-09, one per epoch (latest `CREATION_DATE`) | Input |
| python-sgp4 2.27 (Vallado's SGP4, WGS 72) | TEME trajectories from each OMM | Input propagation |

## Truth

`study/nasa_iss_truth.py` parses every header's event table. For each burn
(delta-V > 0) it keeps the last plan issued within 4 days before the TIG. It
then checks execution with NASA's ephemerides alone:

- the modeled change is the orbit-averaged semi-major axis two revolutions
  before the TIG, against the pre-TIG file's trajectory over the first two
  revolutions of the first file issued after the TIG. That file must come
  before any other planned burn, because across an archive gap a later file
  can include a slipped re-plan;
- the plan is in NASA's trajectory when the modeled change is at least half
  the planned delta-V's semi-major-axis change (2 a dv / v, 1.77 km per m/s);
- the burn happened when the post-TIG file departs from the pre-TIG model by
  less than 35 % of the modeled change.

The result is 79 planned burns (2021-03-12 to 2026-09-25) and 72 confirmed
executed, from 0.2 to 2.8 m/s. The confirmed semi-major-axis change
(`nasa_actual_da_km`) is the delta-V truth.

## Method

`study/gp_trajectories.py` propagates each element set every 60 s from the
epoch two sets before to two sets after. `study/iss_reboost_study.mjs` packs
each month (with a 5-day margin) as one `$OEM` in TEME and runs the built WASM
module with default options. It keeps the month's events. An event matches a
burn when it falls from 3 h before to 36 h after the TIG, because GP element
sets lag a burn.

The detector (see the module README) finds where consecutive trajectories
cross, measures the energy and orbit-normal changes at that instant, and
tests steps in the per-set level of each against a per-object robust scale.

## Results

| In-track floor | Events | Detected | Burn-time error, median / 90 % | GP da / NASA da, median (10-90 %) | Unexplained events |
| --- | --- | --- | --- | --- | --- |
| 0.08 m/s (default) | 119 | 69 / 72 | 22 min / 2.9 h | 1.00 (0.24-1.36) | 7 |
| 0.12 m/s | 105 | 68 / 72 | 22 min / 2.9 h | 1.02 (0.23-1.36) | 4 |

Of the 69 detected burns at the default floor, 62 are characterized
`ORBIT_RAISING`, 4 `ORBIT_LOWERING` and 3 `COMBINED`. The whole 5.5 years runs
in about 20 s.

### Misses

| TIG | Plan | Why |
| --- | --- | --- |
| 2021-08-19 04:04 | 0.7 m/s optional reboost | A backup reboost was planned for 2021-08-21, and NASA's check passes both. The GP history shows one burn, detected at 2021-08-21 04:17 (0.67 m/s). |
| 2021-12-24 01:18 | 1.0 m/s deboost | Detected at 2021-12-23 21:19 (-0.36 m/s), 4 h before the TIG and outside the matching window. |
| 2024-05-24 23:03 | 1.1 m/s reboost | NASA listed the same reboost at 14:16 and at 23:03. A burn was detected at 14:56 (1.06 m/s). |

### Unmatched events

50 events at the default floor match no confirmed burn:

- 34 fall where the archive had no NASA file issued within the day before, so
  there is no plan to compare against;
- 29 are within 1.5 days of a listed event (dockings, undockings, re-planned
  burns);
- 17 are 0.3 m/s or larger, for example 2023-11-09 21:12 (1.47 m/s at a
  listed TIG whose post-TIG check did not pass) and 2022-10-25 02:37
  (0.83 m/s).

Seven events are unexplained: NASA had issued a plan within the previous day
that lists no event within 1.5 days.

| Event | In-track | Cross-track | Note |
| --- | --- | --- | --- |
| 2021-11-18 17:04 | -0.03 | 0 | |
| 2021-12-18 10:19 | 0.13 | 0 | |
| 2023-05-04 21:30 | 0.10 | 0 | |
| 2023-07-25 05:45 | 0 | 0.80 | Only cross-track event |
| 2024-01-03 22:42 | 0.08 | 0 | At the floor |
| 2024-05-11 05:30 | -0.10 | 0 | 2024-05-10/11 geomagnetic storm: drag, not a burn |
| 2025-01-15 23:28 | -0.05 | 0 | |

All are at most 0.13 m/s in-track, or plane-only. Raising the in-track floor
to 0.12 m/s removes three and costs one detected burn.

## What changed during the study

- A plain pairwise test (each consecutive pair against a robust z-score)
  found 55 of 78 planned burns and raised about 700 other events. GP element
  sets issued just after a burn still carry the old orbit, and the settling
  sets after it jump back. Two changes fixed that: the median step test, and
  trajectories spanning two neighbours so that the crossing search reaches
  back past a lagging set.
- The first cut reported the single pair's cross-track jump. It carries
  0.3-1 m/s of GP noise, and it labeled 37 of 71 reboosts out-of-plane or
  combined. Components are now reported only when their own step test fires.

## Limits

- The ISS has frequent, well-fit element sets and only in-plane burns. There
  is no GEO or cross-track truth yet. The GEO station-keeping rule and the
  cross-track floor are closed-form tested only.
- Burn time depends on how fast the catalog reflects the burn. It is a
  property of the input, not of the detector.

## Reproduce

```sh
cd analysis/maneuver-detection
npm install && npm run build
python3 -m venv /tmp/venv && /tmp/venv/bin/pip install sgp4 numpy
W=/tmp/mnv-study; mkdir -p $W
/tmp/venv/bin/python study/nasa_iss_truth.py $W
/tmp/venv/bin/python study/gp_history.py /opt/data/sdn-archive 25544 2021-01-01 $W/gp.json
node study/iss_reboost_study.mjs $W --python /tmp/venv/bin/python
node study/iss_reboost_study.mjs $W --python /tmp/venv/bin/python --options '{"floor_in_track_mps":0.12}'
```

`$W/study-results.json` lists every match and every unmatched event.
