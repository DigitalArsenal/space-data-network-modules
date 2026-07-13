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
