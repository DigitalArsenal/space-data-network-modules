# SGP4-XP against SDN's SGP4

Fit root-mean-square and held-out accuracy of the SGP4-XP element sets this module fits (`fit`, propagator/sgp4-xp 0.1.0,
module.wasm `c92ac99248e835ed`) against the SGP4 element sets of SDN's own fitter (`fit_elements` of analysis/gp-error-model 0.5.0,
module.wasm `53182ac3ef5ac48f`, on main from the merge `1ff06d3e` of task/omm-fit-20261010, whose fitter commits are `cc0cb5ea` and `8398be41`),
on the same ephemerides. Measured 2026-10-11, first with the fitter as it was on the branch (gp-error-model 0.2.0, `8398be41`) and again with the one
on main: all 505 windows, XP and SGP4, give the same numbers to every digit the result files store (the files differ in the fitter's version and the times).

## What is compared

An ephemeris is cut into windows: a fit interval of 24 hours starting at a state of the ephemeris, and the days after it. Both fitters
get the same states of the same interval and put the epoch at the first state. SGP4-XP is fitted by `fit` (eight parameters: the six
mean elements, BTERM and AGOM); SGP4 by `fit_elements` (the six mean elements and B*). Each element set is then propagated over the
days after the fit interval and compared with the ephemeris: **day k** is the root-mean-square 3D position error (km, TEME) over the
states in (E + (k-1) days, E + k days], E the end of the fit interval, counted only where the ephemeris holds at least 90% of that day's
states. **Day 0** is the fit: the same root-mean-square over the fit interval. Medians and means are over windows.

`fit_elements` reports "not converged" for some windows and then returns no element set, so those windows cannot be scored on the days
after the fit. The first table of each source is the windows both fitters fitted (a paired comparison); the second is SGP4-XP on every
window it fitted. The count of windows each fitter failed is given with each source; SGP4-XP failed 0 of 505.

## The ephemerides

| Source | Ephemeris |
| --- | --- |
| ISS | NASA JSC flight dynamics, CCSDS OEM (EME2000, UTC, 4 min), the 15 days of the file current when it was fetched |
| Starlink | SpaceX public ephemerides, MEME (EME2000, UTC, 60 s), 100 satellites of the sample list, two to three days each |
| GNSS | ESA/ESOC final orbits (ESA0OPSFIN, SP3, 5 min) of GPS, Galileo and GLONASS satellites, 20 days from 2024-09-24, as GCRF states by analysis/reference-states |
| Laser-ranged, high (LAGEOS-1/2, Etalon-1/2) | ILRS combined weekly orbits (ilrsa, 2 or 15 min), four weeks each, as GCRF states by analysis/reference-states |
| Laser-ranged, low (Ajisai, Starlette, Stella, LARETS, WESTPAC, LARES, LARES-2) | ILRS analysis-centre 4-day arcs (NSGF, 3 min), eight arcs each, as GCRF states by analysis/reference-states; each arc its own ephemeris |

None is stored. The NASA and SpaceX ephemerides are fetched when the measurement runs and live in memory until it ends (NASA's file is a U.S.
Government work; SpaceX publishes its ephemerides openly). The ESA and ILRS products are read from the archive's reference states, which
`analysis/reference-states` made from the products with Earth orientation applied. The result files hold statistics per window and nothing else
of the ephemerides.

## Results

Position RMS in km, 3D, TEME.

### ISS

1 object; fits of 24 h every 24 h; 14 windows; SGP4-XP failed 0; SGP4 failed 0; both fitted 14. Results: `results/iss-24h.json`.

| Day | n | SGP4-XP median | SGP4-XP mean | SGP4 median | SGP4 mean | SGP4-XP closer |
| --- | --: | --: | --: | --: | --: | --: |
| 0 (the fit) | 14 | 0.455 | 0.455 | 0.461 | 0.458 | 79% |
| 1 | 14 | 2.16 | 2.00 | 2.12 | 2.06 | 21% |
| 3 | 12 | 16.5 | 15.5 | 16.4 | 16.0 | 17% |
| 7 | 8 | 88.9 | 80.1 | 88.8 | 80.7 | 25% |

A fit takes 0.7 s at the median (1.2 s at most) in V8 on a loaded machine.

### Starlink

100 objects; fits of 24 h every 24 h; 196 windows; SGP4-XP failed 0; SGP4 failed 0; both fitted 196. Results: `results/starlink-24h.json`.

| Day | n | SGP4-XP median | SGP4-XP mean | SGP4 median | SGP4 mean | SGP4-XP closer |
| --- | --: | --: | --: | --: | --: | --: |
| 0 (the fit) | 196 | 0.539 | 0.714 | 0.534 | 0.613 | 33% |
| 1 | 196 | 3.67 | 6.68 | 5.92 | 8.59 | 68% |

A fit takes 0.8 s at the median (1.5 s at most) in V8 on a loaded machine.

### GNSS

12 objects; fits of 24 h every 48 h; 120 windows; SGP4-XP failed 0; SGP4 failed 22; both fitted 98. Results: `results/gnss-24h.json`.

| Day | n | SGP4-XP median | SGP4-XP mean | SGP4 median | SGP4 mean | SGP4-XP closer |
| --- | --: | --: | --: | --: | --: | --: |
| 0 (the fit) | 98 | 0.022 | 0.023 | 0.134 | 0.146 | 100% |
| 1 | 98 | 0.057 | 0.063 | 0.420 | 0.482 | 100% |
| 3 | 89 | 0.161 | 0.169 | 2.40 | 2.92 | 100% |
| 7 | 68 | 0.419 | 0.427 | 14.2 | 15.5 | 100% |

SGP4-XP on all 120 windows it fitted:

| Day | n | median | mean | 90th percentile |
| --- | --: | --: | --: | --: |
| 0 (the fit) | 120 | 0.022 | 0.023 | 0.030 |
| 1 | 120 | 0.057 | 0.062 | 0.098 |
| 3 | 108 | 0.162 | 0.172 | 0.290 |
| 7 | 84 | 0.420 | 0.430 | 0.710 |

A fit takes 0.5 s at the median (1.1 s at most) in V8 on a loaded machine.

### Laser-ranged, high (LAGEOS-1/2, Etalon-1/2)

4 objects; fits of 24 h every 72 h; 36 windows; SGP4-XP failed 0; SGP4 failed 0; both fitted 36. Results: `results/slr-24h.json`.

| Day | n | SGP4-XP median | SGP4-XP mean | SGP4 median | SGP4 mean | SGP4-XP closer |
| --- | --: | --: | --: | --: | --: | --: |
| 0 (the fit) | 36 | 0.095 | 0.065 | 0.116 | 0.112 | 89% |
| 1 | 36 | 0.104 | 0.121 | 0.227 | 0.263 | 81% |
| 3 | 36 | 0.242 | 0.300 | 1.22 | 1.50 | 86% |
| 7 | 28 | 0.570 | 0.701 | 6.61 | 8.57 | 89% |

A fit takes 0.6 s at the median (1.5 s at most) in V8 on a loaded machine.

### Laser-ranged, low (Ajisai, Starlette, Stella, LARETS, WESTPAC, LARES, LARES-2)

56 objects; fits of 24 h every 24 h; 139 windows; SGP4-XP failed 0; SGP4 failed 0; both fitted 139. Results: `results/slr-leo-24h.json`.

| Day | n | SGP4-XP median | SGP4-XP mean | SGP4 median | SGP4 mean | SGP4-XP closer |
| --- | --: | --: | --: | --: | --: | --: |
| 0 (the fit) | 139 | 0.371 | 0.355 | 0.389 | 0.355 | 60% |
| 1 | 139 | 0.735 | 0.733 | 0.977 | 1.05 | 60% |
| 2 | 89 | 0.782 | 1.87 | 2.58 | 3.14 | 62% |
| 3 | 75 | 1.16 | 3.75 | 5.10 | 6.89 | 67% |

A fit takes 0.5 s at the median (0.9 s at most) in V8 on a loaded machine.

### SGP4-XP against SGP4 in one table

Median error of SGP4-XP divided by the median error of SGP4, on the windows both fitted (below 1 is SGP4-XP closer to the ephemeris).

| Source | Day 0 (fit) | Day 1 | Day 2 | Day 3 | Day 7 |
| --- | --: | --: | --: | --: | --: |
| ISS | 0.99 | 1.02 |  | 1.00 | 1.00 |
| Starlink | 1.01 | 0.62 |  |  |  |
| GNSS | 0.17 | 0.14 |  | 0.07 | 0.03 |
| Laser-ranged, high (LAGEOS-1/2, Etalon-1/2) | 0.82 | 0.46 |  | 0.20 | 0.09 |
| Laser-ranged, low (Ajisai, Starlette, Stella, LARETS, WESTPAC, LARES, LARES-2) | 0.95 | 0.75 | 0.30 | 0.23 |  |

### What the numbers show

- **ISS.** SGP4-XP and SGP4 are the same to within 2% of the median at every lead (error 0.46 km on the fit, 2.1 at day 1, 16.5 at day 3, 89 at day 7, both).
  The ISS's own manoeuvres and drag changes dominate, not the model.
- **Starlink.** The median error at day 1 is 3.67 km against 5.92 km for SGP4 (0.62 of it) and SGP4-XP is closer in 68% of the windows; the fit is the same
  (0.539 against 0.534 km). The tail is the ephemeris: the 90th percentile is 16.8 km and the worst windows, where a manoeuvre falls in the next day,
  score 63 and 64 km for the two models.
- **GNSS.** SGP4-XP's error is 0.057 km at day 1, 0.161 at day 3 and 0.419 at day 7, against 0.420, 2.40 and 14.2 km for SGP4: from day 1 to day 7 SGP4-XP's error grows 7-fold and SGP4's 34-fold,
  and SGP4's is larger on every one of the 98 windows. SDN's SGP4 fitter did not converge on 22 of the 120 windows; SGP4-XP fitted all 120 (fit RMS 22 m at the median).
- **High laser-ranged.** 0.104, 0.242 and 0.570 km at days 1, 3 and 7 against 0.227, 1.22 and 6.61 km.
- **Low laser-ranged.** 0.735, 1.16 km at days 1 and 3 against 0.977 and 5.10 km; the mean at day 3 is larger (3.75 km) than the median (a few windows hold a manoeuvre).

## Choices the measurement settled

Three constants of the fitter were set from SpaceX's ephemerides, the hardest of the sources (continuous thrust, high drag, a satellite decaying):
the bounds of BTERM and AGOM, the number of states the optimisation sees, and (below) the budget of the search on the text's lattice. Fits of
24 hours of the first 50 Starlink satellites (98 windows), scored on the next day; the unit is km (fit RMS, then day-1 RMS: median / mean / 90th
percentile), "fits not converged" is the fitter's own flag.

| BTERM and AGOM bounds (m^2/kg) | States seen | Fits not converged | Fit RMS median / mean | Day-1 RMS median / mean / 90th |
| --- | --: | --: | --: | --: |
| 0 to 0.5 | 480 | 9 | 0.515 / 0.750 | 2.72 / 4.93 / 6.32 |
| -0.5 to 0.5 | 480 | 0 | 0.501 / 0.668 | 3.93 / 6.92 / 10.72 |
| -0.5 to 5 | 480 | 0 | 0.501 / 0.552 | 3.64 / 5.03 / 10.70 |
| 0 to 5 | 480 | 9 | 0.513 / 0.634 | 2.72 / 3.05 / 6.02 |
| 0 to 20 | 480 | 9 | 0.513 / 0.634 | 2.72 / 3.04 / 6.02 |
| **0 to 5** | **240** | 11 | 0.514 / 0.635 | 2.70 / 3.01 / 6.04 |
| 0 to 5 | 120 | 13 | 0.530 / 0.639 | 2.64 / 2.97 / 5.99 |

- A negative BTERM (the along-track force of a thrusting satellite) absorbs the thrust: the fit improves and no fit fails to converge, but the next day is worse
  by a third or more. BTERM stays at or above zero. The fits that still do not converge are those that want it negative.
- Satellites that need more than 0.5 (a decaying one reached 1.09) were held at the bound; raising it to 5 cuts the mean day-1 error from 4.93 to 3.05 km.
  Twenty changes nothing: no fit goes beyond 4.85. AGOM reaches the bound of 5 on some windows (median 0.20, 90th percentile 1.25).
- 240 states cost a quarter less time than 480 (median 1.03 s against 1.37 s) and score the same; 120 are faster still and fit slightly worse (median 0.530).
  The fitter uses at most 240 states; the statistics are always over all of them.
- The search on the text's lattice changes nothing visible on Starlink (fit RMS median 0.510 km with 400, 100 or no evaluations, over 40 satellites) and matters
  where a fit is a few tens of metres: the GNSS fit RMS median is 0.0223 km with 400 evaluations, 0.0224 with 100 and 0.0242 with none, and 100 evaluations
  take a quarter less time than 400 (0.43 s against 0.60 s). The search spends at most 100.

## Limits of the comparison

- The SGP4 side is SDN's own fitter. A different SGP4 fitter (another weighting, another epoch convention, differential correction as 18 SDS runs it) would score differently. `fit_elements` is in analysis/gp-error-model 0.5.0 on main (`1ff06d3e`).
- The ephemeris is the truth here. An error is whatever the ephemeris holds that neither model represents: manoeuvres, continuous thrust (Starlink orbit raising is a steady along-track force), the operator's own force model, and for the high satellites the products' own uncertainty (centimetres to a decimetre).
- A fitted set is a point of the two-line text's lattice (angles to 1e-4 degree, 12 m at low orbit; mean motion to 1e-8 rev/day; eccentricity to 1e-7), so no fit is better than a few metres at low orbit whatever the model.
- The SpaceX files cover two to three days, so Starlink has days 0 and 1 only; the NSGF arcs are four days, so the low laser-ranged satellites have days 0 to 3; ISS, GNSS and the high laser-ranged satellites have days 0, 1, 3 and 7.
- The reference states are GCRF with Earth orientation applied. The Earth-fixed path of the module (no Earth orientation: UT1 = UTC, mean pole) is checked on a real Earth-fixed ephemeris by `tests/fit.test.mjs` (the ILRS prediction of LAGEOS-1: 10 m over the 2.5 hours fitted), not by these tables.
- Times are for a loaded machine (the load average was 40 to 90) and V8, not for the SDN node's WasmEdge.

## Reproducing

```sh
cd propagator/sgp4-xp && npm ci && npm run build
# the SGP4 fitter is analysis/gp-error-model of this checkout (its committed dist); SDN_GP_ERROR_MODEL=<dir> names another, built
node tests/measure/run.mjs --source iss --fit-hours 24 --stride-hours 24 --leads 1,3,7
node tests/measure/run.mjs --source starlink --limit 100 --fit-hours 24 --stride-hours 24 --leads 1
node tests/measure/run.mjs --source gnss --per 4 --days 20 --fit-hours 24 --stride-hours 48 --leads 1,3,7
node tests/measure/run.mjs --source slr --targets lageos1,lageos2,etalon1,etalon2 --weeks 4 --fit-hours 24 --stride-hours 72 --leads 1,3,7
node tests/measure/run.mjs --source slr-leo --arcs 8 --fit-hours 24 --stride-hours 24 --leads 1,2,3
node tests/measure/tables.mjs      # the tables above, from results/*.json
```

`SDN_ARCHIVE` (default `/opt/data/sdn-archive`) is where the GNSS and laser-ranging reference states are read. The ISS and Starlink ephemerides are fetched from NASA and SpaceX when the command runs.

