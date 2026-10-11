# HPOP full-catalog screen at full force, 2026-10

The three-day all-vs-all screen of the public catalog with HPOP 1.3.0 at full
force: the conjunction paper's HPOP row. Aggregates only; the element sets
and the events stay on the machine that ran it.

## Configuration

- **Catalog.** Space-Track GP catalog of 2026-09-30, 32,514 objects.
- **Screen.** 2026-10-01T00:00Z plus 3 days, 5 km threshold, 60 s coarse
  steps, 72 windows of 1 hour, CPU search in Node.js
  (`scripts/run-all-vs-all-cpu.mjs --propagator hpop --window-hours 1
  --farm-workers 16 --workers 8 --load-ceiling 45`).
- **Modules.** The conjunction module of e1e9b6b8 (the module of the SGP4
  rows in `gpu-all-vs-all.md`); propagator/hpop 1.3.0 (module 9c24bf0e) and
  the farm of this commit.
- **HPOP.** `propagator/hpop/catalog.mjs`: EGM2008 70×70; the Sun, Moon,
  Venus, Mars and Jupiter from DE440s; NRLMSISE-00; cannonball radiation
  pressure with the conical shadow; Knocke Earth radiation; IERS 2010 solid
  tides and relativity; FES2004 ocean tides 30×30; RK78 at 1e-12, steps of
  at most 300 s; 300 s Chebyshev segments on TT. Cd·A/m from B* (0.01 m²/kg
  for the 6,069 element sets with B* ≤ 0), Cr·A/m 0.02 m²/kg for all 32,514.
- **Environment, as released at 2026-10-01T00:00Z.** DE440s; IERS finals2000A
  rows to the day before, the last one held; GFZ Kp, ap and F10.7, then NOAA
  SWPC's latest daily report and its 3-day forecast, the last day held.
- **Host.** Mac Studio (28 cores) shared with other work: 1-minute load
  average median 40, 90th percentile 47, maximum 62 over the run (one sample
  a minute). The farm held its next chunk of 64 objects while the load
  exceeded 45.

## Results

| | |
| --- | ---: |
| Conjunctions | 288,524 |
| Candidates | 2,644,693 |
| Objects excluded (reentered before the screen) | 21 |
| Farm CPU time, propagation (16 worker threads, user and system) | 110,642 s |
| of which the first window (catch-up from element epochs) | 40,118 s |
| later windows, mean | 993 s |
| Farm CPU time per object-day (153,120 object-days) | 0.72 s |
| On 16 dedicated cores, plus search and refinement | 6,964 s |
| Measured on the shared host: end to end | 9,294 s |
| waiting on the farm | 9,231 s |
| search (8 module threads) | 33.8 s |
| refinement | 14.8 s |
| Process CPU time (farm, module threads and host) | 111,651 s |

On one thread of the same host (load 12–15), `propagator/hpop` README,
"Catalog cost", measured 0.645 s per object-day on stride samples: the farm's
0.72 s is 12 % more.

A day of HPOP's 300 s segments is about 240 KB per object; a 1-hour window of
the catalog is about 390 MB of PPE, which `prepare_screening_index` holds in
1.05 GiB of the module's 2 GiB.

## Reentries

HPOP ends a trajectory at 100 km geodetic altitude (propagator/hpop README,
"The end of a trajectory: reentry"). An object that reenters before the
screen starts is excluded; one that reenters during it is screened through
the last full window before its reentry.

- **Before the screen (21, excluded):** NORAD 58993, 69730, 40972, 40021,
  39473, 58306, 62620, 60508, 62618, 48909, 58286, 56746, 46459, 54352,
  54334, 48964, 34861, 53453, 44772, 53480, 43879, in order of reentry
  (2026-09-09 09:51Z to 2026-09-30 03:03Z), each integrated from its element
  set's epoch.
- **During the screen (6):** NORAD 270365 (2026-10-01 01:14Z), 20861
  (10-01 11:20Z), 53505 (10-01 16:31Z), 45670 (10-01 22:24Z), 23966
  (10-02 17:42Z) and 53444 (10-02 20:44Z).

## Agreement with the SGP4 screen

`scripts/compare-screens.mjs`: the same pair with TCAs within 10 minutes,
nearest first. The SGP4 screen is the same catalog, start, threshold and
steps with the module's SGP4 (292,516 conjunctions).

| TCA day | SGP4 | HPOP | Matched | Share of HPOP | TCA difference, median | Miss difference, median |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 76,919 | 80,788 | 17,354 | 21 % | 0.75 s | 617 m |
| 2 | 94,806 | 95,460 | 12,014 | 13 % | 1.43 s | 683 m |
| 3 | 120,791 | 112,276 | 10,118 | 9 % | 2.25 s | 753 m |
| All | 292,516 | 288,524 | 39,486 | 14 % | 1.19 s | 670 m |

Both start from the same element sets; the numerical propagation of the
epoch state and SGP4's mean-element theory diverge by kilometres within a day
(`analysis/gp-error-model/docs/hpop-calibration-2026-08.md`), so a 5 km
screen's conjunctions differ.
