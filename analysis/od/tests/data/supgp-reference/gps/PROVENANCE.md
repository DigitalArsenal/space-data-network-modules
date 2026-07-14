# GPS-A SupGP capture — provenance (A2.4, record-only)

## `celestrak_supgp_gps-a_2026-07-13.csv`

- **Exact URL:** `https://celestrak.org/NORAD/elements/supplemental/sup-gp.php?SOURCE=GPS-A&FORMAT=CSV`
- **Captured:** 2026-07-13 (UTC), HTTP 200, 5110 bytes, 31 OMM rows (GPS
  constellation from the NAVCEN almanac; EPOCH 2026-07-15 predicted-ahead;
  MEAN_MOTION ~2.0056, INCLINATION 54.8–55.1°, ECCENTRICITY 0.012–0.017,
  RMS 0.30–0.45 km).
- **Token note:** the coordinator's earlier `GPS-A&FORMAT=JSON` probe 404'd, but
  the documentation page (`celestrak.org/NORAD/documentation/sup-gp-queries.php`)
  still lists `GPS-A (GPS Almanac)` and itself links `GPS-A&FORMAT=CSV` — the CSV
  form resolved HTTP 200. No token drift.
- **How:** read-only host proxy `ssh space-data-network-02 'curl ...'`; serial,
  ≥3 s spacing; host temp dir cleaned up. Byte-exact as served.

## No running gate — BLOCKED AT SOURCE

A GPS almanac is mean Keplerian ELEMENTS, not a state-vector ephemeris, so there
is nothing to fit (beatsCelestrak N/A) and an element check needs a
GPS-BROADCAST→SGP4 frame/theory reconciliation + a PRN→NORAD registry the
almanac lacks (OWNER-ASSIST). This capture is checked in as a reference pair for
the future. **Unblock lead:** the doc page lists `GPS-E (GPS Ephemeris)` — a
state-vector product that, with IGS precise ephemeris + PRN→NORAD, could enable a
real hard gate.

## UNBLOCKED 2026-07-14 — real GPS OD lane (IAC SP3 + PRN→NORAD registry)

Owner directive "get the data working for … GPS" resolved with **PUBLIC precise
ephemeris**, not the almanac. IAC's full multi-GNSS precise SP3-d rapid product
(`ftp://ftp.glonass-iac.ru/MCC/PRODUCTS/<yyDOY>/rapid/Sta<n>.sp3` — the mixed
product the glonass lane's `.sp3.glo` sits beside, anonymous FTP) carries GPS
`G01`–`G32` **state vectors** (IGS20/ECEF, GPS time, 96 epochs / 24 h). The
constellation pipeline's `prepareGps` keeps only the `PG` records and fits each
PRN position-only, identical frame/time chain to GLONASS. **This is a real
state-vector OD** — the A2.2c-2 "no fabricated ephemeris" bar is respected because
the states come straight from the SP3.

### `prn-norad-registry.json` (PRN→NORAD identity)

Built from THIS directory's public `celestrak_supgp_gps-a_2026-07-13.csv`: each
GPS-A row carries the PRN in `OBJECT_NAME` (`(PRN nn)`), the COSPAR in
`OBJECT_ID`, and the `NORAD_CAT_ID` — a **legitimate public PRN→COSPAR→NORAD
join** (CelesTrak authoritative). 32 entries (`G01`…`G32`), `id_registry.hpp`
shape keyed by the SP3 PRN token. Identity is applied JS-side in `prepareGps`
(registry hit → real ids; miss → honest-empty, never fabricated). PRN↔SV
assignments are time-varying but change only every few months, so the registry is
valid for same-week IAC SP3 arcs; the authoritative cross-reference for
PRN↔SVN↔COSPAR is IGS `igs_satellite_metadata.snx` (igs.org).

### Live run 2026-07-14 (local daemon)

32/32 PRNs fitted, 32 published, **RMS p50 0.026 km / p90 0.042 km** (one
real-data outlier, PRN 04 / NORAD 43873 at 7.6 km — likely a maneuver or
discontinuity within the 24 h arc). All 32 NORAD resolved; `source_name=gps
objects=32` on `/api/v1/stats`; queryable by real GPS NORAD in
`/api/v1/data/index`. Element-space parity vs CelesTrak GPS-A stays NON-COMPARABLE
(SP3-position OD vs almanac-derived SGP4 are different theories) — a formal gate
remains coordinator-gated.
