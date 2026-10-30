# Space-Track GP element sets, 2026-10-29

`gp-2026-10-29.json` holds twenty SGP4 element sets exactly as Space-Track.org published them in its GP class: the
field text is unchanged, a subset of the fields is kept (the OMM's mean elements, `CREATION_DATE`, `GP_ID` and the
two TLE lines). They come from the full-catalog snapshot retrieved 2026-10-29 (archived as
`spacetrack/gp/2026/2026-10-29.json.gz`, SHA-256
`a0ff07183325e857180a822e6799713f66cbbfa28ed82f6d9996e02672020a9d`), selected by catalog number:

| Role | NORAD |
| --- | --- |
| B* 0.1 to 0.2 (Starlink, perigee 480-510 km) | 67024, 67087, 66831, 66834 |
| B* about 0.025 | 52634, 52699 |
| B* about 0.0015 | 51132, 62600 |
| B* about -0.0004 | 54853, 62428 |
| ISS | 25544 |
| Perigee below 220 km (STR#3's truncated drag terms) | 32730, 44478 |
| Deep space at low inclination, node near 0 | 40942, 58346 |
| 12-hour resonant | 45254 |
| Geosynchronous resonant cluster (19.2 deg E) | 29055, 31306, 33436, 37775 |

The OMM carries more digits than its own TLE: B* to eight or more significant digits where the TLE has five, and the
eccentricity to eight decimals where the TLE has seven. `tests/sgp4OmmInput.e2e.mjs` uses both forms.

Source: USSPACECOM / 18th Space Defense Squadron, via Space-Track.org (https://www.space-track.org), redistributed
under USSPACECOM's blanket approval for basic SSA data with citation (`NOTICE.md`).
