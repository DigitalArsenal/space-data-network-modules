# Numbered asteroids (Lowell astorb)

SDN data retrieval module: every numbered asteroid in Lowell Observatory's
`astorb.dat` as SDS `$SBD` small-body records (an asteroid does not orbit the
Earth, so it is never an `$OMM`), run on a provider node by the flow
`com.digitalarsenal.flows.lowell-astorb-ingest`
(stack `deployment/solar-system-provider-node`) and auto-published as three
lanes of provider `lowell-astorb`:

| Lane | Schema | Records |
| --- | --- | --- |
| `astorb-numbered` | `SBD.fbs` | every numbered asteroid (895,910 on 2026-10-13) |
| `astorb-largest-10pct` | `SBD.fbs` | the largest tenth: ceil(N/10) records (89,591), the set the console draws by default |
| `astorb-groups` | `EGP.fbs` | two `$EGP` groups that list the two lanes on the network |

**The largest tenth** (owner 2026-10-13: "only the largest 10% showing by
default") is defined here, not by a client: a row's size is its catalog (IRAS)
diameter when astorb gives one, else the equivalent-sphere diameter from its
absolute magnitude at geometric albedo 0.14, D = 1329 km / sqrt(0.14) x
10^(-H/5) (the albedo of the 140 m NEO threshold at H = 22); a row with
neither ranks last. Rows are ranked largest first, ties by number (a total
order, so every runtime picks the same rows), and the first ceil(N/10) are the
subset, stored as the same records under their own lane (the store keeps one
copy and tags it with both lanes). The ingest report gives the count, how many
ranked by diameter and by H, and the smallest size in the set.

**The groups** (owner 2026-10-13: "a group that is listed on the network (a
catalog)"): `Asteroids (numbered)` and `Asteroids (numbered, largest 10%)`,
each `QUERY_LIVE` with no member list. The query (`DIALECT`
`sdn-data-query`) is the lane as an SDN data query names it
(`{"schema":"SBD.fbs","provider_id":"lowell-astorb","source_name":...}`),
`RESULT_COUNT` its records; the tags carry `cadence:72h`, `schema:sbd` and
`source:<lane>`; the provenance carries the source (Lowell Observatory,
astorb.dat, its URL and SHA-256), the licence and the attribution.

| Method | In | Out |
| --- | --- | --- |
| `plan_astorb` | source configuration | three ranged GETs (`request0..2`), job |
| `parse_astorb` | job, receipt, `response0..2` | `$SBD` records, ingest meta, report; `largest` ($SBD, the largest tenth) and `groups` (two $EGP) |
| `ingest_astorb` (host adapter) | job, receipt, `response0..2` | the same records stored in ~12 MiB parts (`storage.ingest_with_source`): every numbered asteroid, then the largest tenth, then the groups; a report |

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
  `NEO` (q < 1.3 AU); for a NEO, `EARTH_MOID` (AU) and `PHA` (Earth MOID
  <= 0.05 AU and H <= 22; see below); the orbit with the CCSDS OPM keywords, `CENTER_NAME`
  SUN, `REF_FRAME` ECLIPJ2000 (mean ecliptic and equinox of J2000),
  `TIME_SYSTEM` TDB, `EPOCH`, `SEMI_MAJOR_AXIS` km, `ECCENTRICITY`,
  `INCLINATION`, `RA_OF_ASC_NODE`, `ARG_OF_PERICENTER`, `MEAN_ANOMALY`
  (degrees), `GM` (DE440 Sun); `ABSOLUTE_MAGNITUDE` (H), `SLOPE_PARAMETER` (G),
  `DIAMETER` (IRAS, km); orbit quality `ORBIT_ARC` (days), `OBSERVATION_COUNT`,
  `CEU`, `CEU_RATE`, `CEU_EPOCH`; `PROVENANCE` (PVN: provider lowell-astorb,
  originator Lowell Observatory, licence class Reproducible). Values astorb
  does not give (albedo, rotation period) are left out (NaN).
- **Earth MOID and PHA.** astorb.dat has no Earth MOID or hazard flag, so the
  module computes the minimum orbit intersection distance of every NEO against
  the Earth's orbit at the row's epoch (the Earth-Moon barycentre's mean orbit
  from Standish's JPL SSD table, 1800-2050; a MOID needs the orbit, not the
  place, and the table moves a MOID by under 1e-4 AU): a 360 x 180
  eccentric-anomaly grid, then a pattern search from its four lowest minima to
  1e-10 rad. A non-NEO cannot pass within 0.05 AU of the Earth's orbit and
  carries no MOID (its PHA is false). On the 2026-10-12 file: 3,873 NEOs,
  976 PHAs; Eros 0.1489, Icarus 0.0338, Toutatis 0.0065, Itokawa 0.0130,
  Ryugu 0.0009, Bennu 0.0028, Apophis 0.0001 AU (JPL SBDB: 0.148, 0.0339,
  0.0061, 0.0131, 0.0009, 0.0032, 0.0002).
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
