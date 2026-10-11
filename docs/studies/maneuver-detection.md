# Maneuver detection from element-set history

Module: `analysis/maneuver-detection` 0.3.0. Study: October 2026,
pre-registered in
[`analysis/maneuver-detection/docs/studies/PLAN-2026-10.md`](../../analysis/maneuver-detection/docs/studies/PLAN-2026-10.md)
(committed 694bffdc before any held-out result; frozen 5ca7e366). It
supersedes the 2026-09-29 study of 0.1.0.

## Question

Can a detector that holds no propagator find maneuvers in published element
sets, and time and size them? The trajectories come through a query port from
whatever propagator is plugged in. Truth is independent of the element sets,
and results are measured on a held-out window.

## Detectors

- **D1:** the crossing of consecutive trajectories, with a median step test
  (0.1.0's detector).
- **D2:** a robust GLR step test on each set's orbit-averaged energy about its
  own epoch, and on a mean-normal chain.
- **D3:** a GLR test for a change of energy rate (low thrust).
- **C:** D1 and D2 merged; the module's default.

Thresholds were tuned on the ISS 2020-09..2024-12 window only. Every class was
then run once with the frozen module, on Space-Track GP history propagated by
`propagator/sgp4` through the query port. Details:
[README](../../analysis/maneuver-detection/README.md).

## Truth

| Class | Truth |
| --- | --- |
| ISS | NASA's public trajectory archive (`s3://nasa-public-data/iss-coords/`). Planned burns come from the file headers; `compare_ephemerides` confirms each against NASA's own later trajectory (the first file starting after the TIG) and measures the executed change |
| Metop-SG A1 (65159) | EUMETSAT AUX_MHF manoeuvre history (newest OPER file, generated 2026-09-15). Burns within 3 h are one manoeuvre; the delta-V is the integral of the stated accelerations |
| GNSS | GPS 26407, 29486, 55268, 67588 (ESA finals) and Galileo 67162 (GFZ MGEX rapid). A change of at least 0.2 km in orbit-averaged SMA between or within daily precise arcs |
| GEO | Intelsat's latest post-manoeuvre IESS-412 file per satellite: a manoeuvre in [m − 3 d, m] |
| Starlink | SpaceX MEME versions, read in memory (descriptive) |

## The three ISS misses of 0.1.0

| TIG | Why it was missed | Now |
| --- | --- | --- |
| 2021-08-19 04:04, 0.7 m/s | It was not executed. The check had used a file re-issued 2.5 h after the TIG that still modelled the plan; NASA's next file shows no change, and a backup reboost on 08-21. | CANCELLED in truth. The 08-21 burn: D1 and C at +14 min |
| 2021-12-24 01:18, −1.0 m/s | Post-burn sets absorbed the burn in B* (4.5e-3), so D1's crossing chain lost 0.7 m/s and timed it 4 h early | C: +3.4 h, −1.06 m/s (NASA −1.06). D1: still −4 h, −0.35 m/s |
| 2024-05-24 23:03, 1.1 m/s | The second burn of a pair 8.8 h apart. D1's median test merged both burns into one event | C: +10 min, 1.06 m/s (D2) |

The tuning window also held one D1 miss that the 0.1.0 study did not list:
2022-10-01 11:05, 1.34 m/s. C finds it at −3.2 h, 1.33 m/s.

## Results

A match is an event in [t − 6 h, t + 36 h] of a truth burn (GNSS: the truth
interval ± 1 d; GEO: [m − 3 d, m + 1 d]). Recall is shown with its Wilson
95 % interval. False alarms count events matching no truth that are not near
a listed event (ISS: a plan was on hand and no event was listed within
1.5 d; Metop-SG: more than 1.5 d from any MHF burn; GNSS: more than 2 d from
a truth manoeuvre or a missing day). The ΔV ratio is in-track, detected over
truth.

| Class, window | Truth | Detector | Recall | Events | False / object-year | Time error, median / 90 % | ΔV ratio, median (10–90 %) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ISS, tuning 2020-09 to 2024-12 | 53 | D1 | 51/53 (0.87–0.99) | 89 | 0.46 | 32 / 228 min | 0.92 (0.22–1.05) |
| | | C | 53/53 (0.93–1.00) | 120 | 1.15 | 31 / 201 min | 0.99 (0.43–1.05) |
| **ISS, held-out 2025-01 to 2026-09** | 25 | D1 | 21/25 (0.65–0.94) | 24 | 0 | 10 / 27 min | 1.02 (0.88–1.12) |
| | | C | 22/25 (0.70–0.96) | 30 | 0.57 | 10 / 46 min | 1.00 (0.94–1.07) |
| **Metop-SG A1, 2025-08 to 2026-09** | 24 | D1 | 12/24 (0.31–0.69) | 13 | 0 | 26 / 318 min | 1.00 (0.95–1.40) |
| | | C | 14/24 (0.39–0.76) | 15 | 0 | 17 / 318 min | 1.00 (0.93–1.40) |
| **GNSS, held-out** (4 GPS, 6.3 object-years) | 6 | D1 | 4/6 (0.30–0.90) | 5 | 0.16 | | 1.00 |
| | | C | 6/6 (0.61–1.00) | 32 | 3.83 | | 0.99 |
| GNSS, tuning (2024-09-24 to 2024-12-31) | 1 | D1, C | 1/1 | 1, 2 | 0 | | |
| **GEO, held-out** (11 files, 1.8 object-years) | 11 | D1 | 2/11 | 26 | (14 events per year) | | |
| | | C | 4/11 | 43 | (24 events per year) | | |

- **ISS held-out.** The three C misses are 0.1 m/s "Settling" burns, 3 to 4
  minutes before a SpX-33 reboost, which the plan lists as separate burns.
  D1 misses four of them. Taken as maneuver sequences, both detectors find all
  21; C also matched one settling burn and added one unexplained event
  (2025-09-23, +0.16 m/s).
- **Metop-SG.** By size, C found:
  - 0/5 below 0.05 m/s;
  - 3/5 from 0.05 to 0.2 m/s;
  - 4/6 from 0.2 to 1 m/s;
  - 7/8 at 1 m/s and above;
  - 12/16 at 0.1 m/s and above.

  Missed:
  - the first burn, a day after launch (2025-08-14, 0.91 m/s);
  - the −2.17 m/s burn of 2026-03-26 and the +0.21 m/s burn of 2026-04-01:
    both fall in a 13.5-day gap with no GP sets;
  - 2026-07-17 (0.16 m/s).

  Rerun with month chunks that reach across gaps (post-read harness fix,
  below), the 03-26/04-01 pair appears as one event of −1.96 m/s (the two
  burns' sum to 0.01 m/s). It is placed 8 h before the burn, so recall is
  unchanged.
- **GNSS.** The six precise-orbit manoeuvres are 0.04–0.20 m/s (Δa
  0.6–2.7 km). GP sets for these satellites have gaps of days to weeks, so
  the timing is coarse. 23 of C's 24 false alarms are D2 in-track steps of
  0.04–0.08 m/s: GP level shifts with no counterpart in the precise orbits.
  The ISS-tuned floor does not transfer to GNSS.
- **GEO.** The truth holds one known manoeuvre per satellite, so events
  outside the window are counted, not called false. 24 events a year matches
  a station-keeping cadence, unverified. East-west trims (about 0.01 to
  0.05 m/s) are under both floors.

### Decision rules

| | Rule | Result |
| --- | --- | --- |
| R1 | ISS held-out: recall(C) ≥ recall(D1), unexplained(C) ≤ unexplained(D1) + 1 per object-year | **Met** (22 ≥ 21; 0.57 ≤ 1.0). C is the default |
| R2 | ISS held-out: median time error of C ≤ D1's | Not met (10.2 vs 9.9 min) |
| R3 | Metop-SG: recall(C) ≥ 0.8 for burns ≥ 0.1 m/s | Not met (12/16 = 0.75) |
| R4 | GNSS: recall(C) ≥ 0.8 for \|Δa\| ≥ 0.5 km | Met (6/6), with 3.8 false alarms per object-year |
| R5 | D3: at most 2 events per object-year on the ISS and Metop-SG | Not met (ISS 2.3, Metop-SG 0.9). D3 stays off by default |

### Propagator swap (descriptive)

The detector ran with three providers behind the query port, on the ISS:
September 2026 (one reboost, 2026-09-25, 1.08 m/s), May 2024 and
December 2021.

| Provider | Answers | Sep 2026 | May 2024 (2 burns) | Dec 2021 (1 burn) |
| --- | --- | --- | --- | --- |
| `propagator/sgp4` | TEME | C 1/1, 3 min, no other event | 2/2, no other event | 1/1, 1 unexplained (D1) |
| `propagator/hpop` 1.3.0, full force | GCRF (from `analysis/epoch-state` states) | 1/1, 31 min, 2 other events | | |
| `propagator/keplerian-reference` (ABI) | Earth-fixed | D1 1/1 (3.6 h); D2 floods (38 events) | 2/2; 57 events | 1/1; 40 events |

The in-track tests work through every provider. The cross-track test needs a
propagator that carries the nodal regression: two-body trajectories of
consecutive sets disagree in plane by metres per second. SGP4 is cleanest
because GP mean elements are SGP4's own. HPOP from SGP4-derived epoch states
inherits their error.

### Starlink and planned-vs-executed (descriptive, live window)

The sample is 20 satellites of the E14 sample, with 60 SpaceX versions issued
2026-10-10 11:33 to 2026-10-11 03:49 UTC, read in memory.
- **Planned against executed.** Each newer orbit determination against the
  previous version's forecast (planned thrust included), over 40 pairs:
  median 3.6 mm/s in-track, 90 % 17 mm/s, maximum 37 mm/s.
- **Thrust in the operator files.** In each version's first 8 h, the mean
  SMA rose in 57 of 179 revolutions (median rise 9.7 m), on 17 of 20
  satellites. Drag only lowers it.
- **GP detection,** 2026-09-01 to 2026-10-11: 27 C events and 15 D3 events
  per object-year, against D3's 2.3 a year on the ISS. The operator window is
  a day, too short to time GP events against.

## What changed after the read

- The ISS truth is encoded as the in-track change alone (in-plane plans). The
  ΔV ratios above use it. A6's tuning table quoted ratios against the vector,
  which included the regression-correction error: 0.89 and 0.94 there;
  0.92 and 0.99 here. Recall, events, false alarms and time are unchanged.
- The month chunks reach at least 10 sets before and after the month (a burn
  in a long GP gap is bracketed). GNSS, GEO and Starlink ran this way. ISS
  (no gap over 4 days) is identical either way. Metop-SG's primary result is
  the days-only run; the rerun changes no match.
- Both changes are in the harness. The module is unchanged from the freeze
  except the default detector set (C, set by R1). Its wasm SHA-256 is
  `eee3dd90…` (frozen run `9ffc182f…`, which differs only in that default).

## Limits

- Detection waits for element sets, and it cannot time a burn inside a GP
  gap.
- Thresholds come from one LEO object. GNSS false alarms and GEO recall show
  they do not transfer as they are.
- Burns minutes apart are one event. The radial component is not estimated.
- The measurement-level tier (estimation-module innovation tests on a
  tracking feed) is not built. It stops at element-set history.

## Prior art and what is new

See the plan's section 9. Element-set time series (Lemmens and Krag 2014),
GLR for jumps (Willsky and Jones 1976; Korn, Gully and Willsky 1982),
change-point segmentation (Page 1954; Killick et al. 2012), energy analysis of
Starlink ephemerides (Liu, Xu and Xiong 2026) and burn calibration from
pre- and post-burn orbits are established and cited. New here:
- a detection SDK whose quantities are differences of trajectories at one
  instant, fed by any propagator through an inverted query port, with
  byte-identical WASM in three runtimes;
- a pre-registered held-out evaluation against truth independent of the
  element sets, across ISS, Metop-SG, GNSS and GEO. This includes ISS burns
  confirmed by NASA's own later trajectories, with the re-issue trap closed;
- two GP failure modes measured and handled: a burn absorbed by the drag term
  of a post-burn set, and burn pairs hours apart.

## Reproduce

From `analysis/maneuver-detection`, with GP histories as one JSON list per
object from the SDN archive (`study/gp_history.py`):

```sh
node study/iss.mjs truth  <work> --from 2025-01-01 --to 2026-10-01
node study/iss.mjs detect <work> --history <gp>/25544.json --from 2025-01-01 --to 2026-10-01 --variants <variants.json>
node study/iss.mjs score  <work> --truth <work>/iss-truth-2025-01-01-2026-10-01.json --events <work>/events-iss-2025-01-01-2026-10-01.json
node study/metop.mjs <work> --mhf-dir /opt/data/sdn-archive/hac/eumetsat-metopsg/AUX_MHF --history <gp>/65159.json --variants <variants.json> --from 2025-08-01 --to 2026-10-01
node study/gnss.mjs <work> --gp-dir <gp> --variants <variants.json>
node study/geo.mjs <work> --listing <intelsat-m.json> --gp-dir <gp> --variants <variants.json>
node study/starlink.mjs <work> --gp-dir <gp> --variants <variants.json> --sample 20
node study/providers.mjs <work> --history <gp>/25544.json --truth <truth.json> --variants <variants.json> --from 2026-09-01 --to 2026-10-01 --providers sgp4,keplerian-reference,hpop --environment <hpop env>
```

`variants.json` lists `{name, options}`; the study's are D1, D2, C and D3 with
the default thresholds. Element sets and operator files stay on the machine
that reads them; only aggregates are committed.
