# Numbered asteroids (Lowell astorb)

SDN data retrieval module: every numbered asteroid in Lowell Observatory's
`astorb.dat` as SDS `$SBD` small-body records (an asteroid does not orbit the
Earth, so it is never an `$OMM`), run on a provider node by the flow
`com.digitalarsenal.flows.lowell-astorb-ingest`
(stack `deployment/solar-system-provider-node`) and auto-published as
`SBD.fbs`, provider `lowell-astorb`, source `astorb-numbered`.

| Method | In | Out |
| --- | --- | --- |
| `plan_astorb` | source configuration | three ranged GETs (`request0..2`), job |
| `parse_astorb` | job, receipt, `response0..2` | `$SBD` records, ingest meta, report |
| `ingest_astorb` (host adapter) | job, receipt, `response0..2` | the same records stored in ~12 MiB parts (`storage.ingest_with_source`), a report |

- The file is about 112 MB gzip, over the Go host's 100 MB response ceiling, so
  it arrives in three 48 MiB ranges. The join is accepted only when the gzip
  member's CRC-32 and length check, and only with at least 100,000 numbered
  asteroids; nothing is emitted before the whole file validated.
- Each range has its own URL and states its own validator: the host's per-URL
  If-None-Match would otherwise answer one range 304 to another's ETag, and
  freeze a cycle that fetched without landing until Lowell's next update.
- Records, brightest H band first (H < 12, 12-15, 15-17, the rest), then by
  number: `NUMBER`; `NAME`, or `DESIGNATION` when the name columns hold a
  provisional designation; `ORBIT_CLASS` (JPL SBDB classes from a and e) and
  `NEO` (q < 1.3 AU); the orbit with the CCSDS OPM keywords, `CENTER_NAME`
  SUN, `REF_FRAME` ECLIPJ2000 (mean ecliptic and equinox of J2000),
  `TIME_SYSTEM` TDB, `EPOCH`, `SEMI_MAJOR_AXIS` km, `ECCENTRICITY`,
  `INCLINATION`, `RA_OF_ASC_NODE`, `ARG_OF_PERICENTER`, `MEAN_ANOMALY`
  (degrees), `GM` (DE440 Sun); `ABSOLUTE_MAGNITUDE` (H), `SLOPE_PARAMETER` (G),
  `DIAMETER` (IRAS, km); orbit quality `ORBIT_ARC` (days), `OBSERVATION_COUNT`,
  `CEU`, `CEU_RATE`, `CEU_EPOCH`; `PROVENANCE` (PVN: provider lowell-astorb,
  originator Lowell Observatory, licence class Reproducible). Values astorb
  does not give (albedo, rotation period, Earth MOID) are left out (NaN).
- Lowell keeps every epoch of osculation within 50 days of the present (a new
  epoch every 100 days), so the flow's 72 h cadence keeps rows inside
  `propagator/keplerian-reference`'s 60-day window.

Licence: "astorb.dat may be freely used, copied, and transmitted provided
attribution to Dr. Edward Bowell and the aforementioned funding sources is
made" (NASA grant NAG5-4741, the Lowell Observatory endowment). The citation
rides in the ingest meta.

```sh
npm install && npm run build && npm test
```
