# SGP4 on an OMM's values: what SOCRATES propagates, 2026-10-29

An OMM carries B* and the eccentricity with more digits than the same element set's TLE. In Space-Track's
2026-10-29 catalog, B* has more digits than the TLE in 29,490 of 32,823 SGP4 sets and the eccentricity in 29,191; the
TLE's values are the OMM's rounded (every set within half a unit of the TLE's last digit). Propagated, the rounding
grows with B* and with time since epoch, almost wholly along track: 46 m after a day and 6.2 km after a week for a
B* of 0.107 (NORAD 67024). This module propagates the OMM's values as published (0.11.0). Here is which values
SOCRATES (CelesTrak, SGP4 in STK 12.2 CAT) propagates.

## Data

| Item | Value |
| --- | --- |
| Report | SOCRATES Plus `sort-minRange.csv`, published 2026-10-29T08:04:08Z: 193,952 rows, SHA-256 `054a6540…0e065` |
| Element sets | the editions SOCRATES used: Space-Track's 2026-10-28 snapshot (SHA-256 `36730df1…8ac8`) with four editions from gp_history; every row's days since epoch reproduced within 0.0005 d |

## Method

For every row, the minimum range within ±600 s of the reported TCA (a 5 s coarse step, then golden section to
1 µs), from `foundation/sgp4-str3` in AFSPC mode: once on the OMM's values, once with B* and the eccentricity as the
TLE prints them (all other elements are equal in both forms). SOCRATES prints range to 1 m and TCA to 1 ms, so
differences to 0.5 m and 0.5 ms are its rounding.

## Results

|range − SOCRATES|, p99 / max, m, by the larger |B*| of the pair:

| B* | Rows | OMM values | TLE values |
| --- | ---: | --- | --- |
| below 1e-4 | 7,801 | 0.50 / 0.5 | 0.99 / 2.4 |
| 1e-4 to 1e-3 | 146,228 | 0.50 / 0.5 | 3.4 / 2,018 |
| 1e-3 to 1e-2 | 37,604 | 0.49 / 0.5 | 37 / 298 |
| 1e-2 to 0.1 | 2,020 | 0.50 / 0.5 | 389 / 854 |
| 0.1 and above | 282 | 0.49 / 0.5 | 421 / 1,320 |

- On the OMM's values, every range is within SOCRATES's rounding: 193,935 of 193,935 rows, median 0.25 m. The other
  17 rows are formation pairs (0-5 m/s) with no minimum inside the ±600 s window on either form.
- On the TLE's values, 59.1 % are. Where the two forms differ by more than 2 m (20,648 rows), the OMM's values are
  the closer to SOCRATES in every row.
- TCA, relative speed at least 50 m/s (192,251 rows): the OMM's values within 1.9 ms (median 0.25 ms); the TLE's
  values put 513 rows beyond 10 ms (up to 211 ms).
- Relative speed: within 0.5 m/s on the OMM's values.
- The TLE values' error grows with time since epoch: for B* of 1e-3 and above, p99 2.7 m under a day, 15 m at 1-3
  days, 55 m at 3-5 days and 94 m at 5-8 days.

SOCRATES propagates the OMM's values. So does this module.
