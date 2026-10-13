# Numbered asteroids (Lowell astorb)

SDN data retrieval module: every numbered asteroid in Lowell Observatory's
`astorb.dat` as SDS `$OMM`, run on a provider node by the flow
`com.digitalarsenal.flows.lowell-astorb-ingest`
(stack `deployment/solar-system-provider-node`) and auto-published as
`OMM.fbs`, provider `lowell-astorb`, source `astorb-numbered`.

| Method | In | Out |
| --- | --- | --- |
| `plan_astorb` | source configuration | three ranged GETs (`request0..2`), job |
| `parse_astorb` | job, receipt, `response0..2` | `$OMM` records, ingest meta, report |

- The file is about 112 MB gzip, over the Go host's 100 MB response ceiling, so
  it arrives in three 48 MiB ranges. The join is accepted only when the gzip
  member's CRC-32 and length check, and only with at least 100,000 numbered
  asteroids; nothing is emitted before the whole file validated.
- Each range has its own URL and states its own validator: the host's per-URL
  If-None-Match would otherwise answer one range 304 to another's ETag, and
  freeze a cycle that fetched without landing until Lowell's next update.
- Records, brightest H band first (H < 12, 12-15, 15-17, the rest), then by
  number: `OBJECT_NAME`, `OBJECT_ID` (the number), `CENTER_NAME` SUN,
  `REFERENCE_FRAME` mean ecliptic and equinox of J2000 (RFM, origin NAIF 10),
  `TIME_SYSTEM` TT, `EPOCH`, `SEMI_MAJOR_AXIS` km, `ECCENTRICITY`,
  `INCLINATION`, `RA_OF_ASC_NODE`, `ARG_OF_PERICENTER`, `MEAN_ANOMALY`
  (degrees), `GM` (DE440 Sun), `USER_DEFINED_PARAMETERS` H, G, DIAMETER_KM.
  These are the field values of closed-modules `lowell-astorb-provider`: on
  the 2026-10-12 file all 895,910 records match field for field.
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
