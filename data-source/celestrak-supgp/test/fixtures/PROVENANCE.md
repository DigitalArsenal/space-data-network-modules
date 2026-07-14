# CelesTrak SupGP fixtures — provenance + probe log (A2.9)

All fixtures are trimmed **byte-exact prefixes** of live CelesTrak Supplemental GP
(SupGP) captures taken 2026-07-13 (UTC). celestrak.org is unreachable from the
build host (erroneous upstream block), so captures were fetched **read-only** via
the host proxy, exactly as A2.4 did:

```
ssh space-data-network-02 'curl -s --max-time 25 -H "User-Agent: sdn-supgp-reference-capture/1.0" "<url>"'
```

Serial, ≥4 s spacing; halt after 2 consecutive 404s; each host temp file
`rm -f`'d inline; nothing else on the host touched. Endpoint (docs page is the
token authority — `celestrak.org/NORAD/documentation/sup-gp-queries.php`):

```
https://celestrak.org/NORAD/elements/supplemental/sup-gp.php?SOURCE=<token>&FORMAT=<JSON|CSV>
```

## Probe log — 12 requests total (the hard budget), all accounted

| # | Token | Format | HTTP | Bytes | Objects | Verdict |
|---|-------|--------|------|-------|---------|---------|
| 1 | SES-E | JSON | 200 | 29372 | 68 | LIVE |
| 2 | SES-E | CSV | 200 | 9663 | 68 | LIVE (format-parity check) |
| 3 | Planet | JSON | 200 | 49440 | 109 | LIVE |
| 4 | Iridium | JSON | 200 | 36219 | 80 | LIVE |
| 5 | Telesat | JSON | 200 | 6604 | 15 | LIVE |
| 6 | AST | JSON | 200 | 4538 | 10 | LIVE |
| 7 | Kuiper-E | JSON | 200 | 177773 | 393 | LIVE |
| 8 | CSS-E | JSON | 200 | 12736 | 28 | LIVE (1 object, 28 time-segments; NORAD 48274) |
| 9 | GPS-E | JSON | 404 | 19 | — | DEAD — body "No SupGP data found" |
| 10 | GPS-E | CSV | 404 | 19 | — | DEAD — confirmed both formats (not a JSON-only quirk) |
| 11 | EUMETSAT-E | JSON | 404 | 19 | — | DEAD — "No SupGP data found" |
| 12 | Orbcomm-TLE | JSON | 404 | 19 | — | DEAD — "No SupGP data found" (2-consec-404 halt fired) |

**JSON verified working** for every live token (schema-exact CCSDS OMM array with
`RMS`/`DATA_SOURCE` extras). The A2.4 `GPS-A&FORMAT=JSON` 404 was almanac-specific;
operator-ephemeris SupGP tokens serve JSON. GPS-E CSV (#10) was probed to confirm
its 404 is a data-presence 404 ("No SupGP data found"), not a format quirk.

Not re-probed this session (budget exhausted at 12) — A2.1 status carried:
`Intelsat-E`, `SES-11P`, `METEOSAT-SV` (A2.1: 404/422; rideshare `-SV` tokens
likely populated only post-launch). Intelsat is already covered independently by
`data-source/intelsat-source` (token `Intelsat-11P`).

## Trimming

Each `*.trimmed.json` is the raw capture truncated to its first N flat OMM objects
(brace-depth-1 slice, real bytes verbatim, closing `]` re-appended). `AST.trimmed.json`
is the FULL 10-object capture. `SES-E.csv.trimmed.csv` is the CSV header + first 4
data rows. Object counts drive the test assertions:

| Fixture | Objects | Note |
|---------|---------|------|
| SES-E.trimmed.json | 4 | GEO, first NSS-11 (NORAD 26554) |
| Planet.trimmed.json | 4 | first SKYSAT-A |
| Iridium.trimmed.json | 4 | first IRIDIUM 106 |
| Telesat.trimmed.json | 4 | first NIMIQ 2 |
| Kuiper-E.trimmed.json | 4 | from 393; first KUIPER-00008 |
| AST.trimmed.json | 10 | full; DATA_SOURCE = "AST-E" (≠ token "AST") |
| CSS-E.trimmed.json | 3 | 3 time-segments of one object (NORAD 48274, 6h apart) |
| SES-E.csv.trimmed.csv | 4 | CSV-fallback parser fixture |

Records are stored/hashed over the trimmed fixture bytes (honest provenance of the
trimmed artifact, exactly as `iss-source` handles its trimmed OEM).
