# GPS adapter test fixtures — provenance

These fixtures drive the offline, mock-host integration test
(`test/module.test.mjs`). No live network is touched by the test.

Both files are **verbatim, untrimmed** copies of the real NAVCEN products (they
are small — 19 KB / 7 KB — so no trimming was needed; every PRN is real). Because
`SOURCE_SHA256` provenance binds to the raw bytes the adapter fetched, the test
independently SHA-256s each fixture and asserts equality with the adapter's
`SOURCE_SHA256` (the mock host serves these exact bytes).

## `current_yuma.alm`

The public GPS **YUMA** almanac (human-readable, angles in radians).

- **Upstream source:** `https://www.navcen.uscg.gov/sites/default/files/gps/almanac/current_yuma.alm`
  (US Coast Guard Navigation Center, public, authentication none, `text/plain`).
- **Retrieved:** 2026-07-13 (live smoke `HTTP/2 200`, `content-length: 19008`,
  `last-modified: Mon, 13 Jul 2026 08:57:08 GMT`). 32 PRN blocks, GPS week 379
  (as-distributed 10-bit), toa 319488 s. CRLF line terminators.
- **Format:** one block per PRN — a `******** Week N almanac for PRN-NN ********`
  banner then labelled `Key: value` lines (`ID`, `Health`, `Eccentricity`,
  `Time of Applicability(s)`, `Orbital Inclination(rad)`,
  `Rate of Right Ascen(r/s)`, `SQRT(A) (m 1/2)`, `Right Ascen at Week(rad)`,
  `Argument of Perigee(rad)`, `Mean Anom(rad)`, `Af0(s)`, `Af1(s/s)`, `week`).

## `current_sem.al3`

The public GPS **SEM** almanac (same constellation, same epoch; angles in
**semicircles**, inclination as an **offset from 0.30 semicircles**, plus SVN,
URA and a satellite configuration code that YUMA omits).

- **Upstream source:** `https://www.navcen.uscg.gov/sites/default/files/gps/almanac/current_sem.al3`
  (USCG NAVCEN, public, `text/plain`).
- **Retrieved:** 2026-07-13 (live smoke `HTTP/2 200`, `content-length: 7092`).
  Header `32  CURRENT.ALM` / `379 319488`, then 14 whitespace-separated numeric
  tokens per record. CRLF line terminators.
- **Cross-check:** SEM and YUMA carry the *same* physical elements — the adapter
  parses both and the test asserts SEM PRN-01 reproduces YUMA PRN-01 within the
  source's text precision (validates the semicircle→radian + 0.30-offset
  inclination handling).

## Canonical mapping (why OMM, honesty caveats) — see `../../README.md`

A GPS almanac is **mean quasi-Keplerian ELEMENTS**, not a state-vector
ephemeris. The adapter maps each PRN to a schema-exact SDS **OMM** WITHOUT
fabricating state vectors, honestly labeled `MEAN_ELEMENT_THEORY =
"GPS-LNAV-ALMANAC"` (NOT SGP4), `REFERENCE_FRAME = "GPS-BROADCAST"`,
`TIME_SYSTEM = "GPS"`, `NORAD_CAT_ID = 0` / `OBJECT_ID = ""` (the almanac carries
only PRN/SVN). Full decision + the A2.4 implication are in the adapter README and
the `src/gps_source.cpp` header.

## `supgp-reference-draft/`

A2.4 seed: the CelesTrak SupGP (`sup-gp.php?SOURCE=GPS-A`) same-epoch reference
pair could NOT be captured from this environment (celestrak.org **timed out /
unreachable**, matching A2.1's ECONNREFUSED). A `provider.json` DRAFT + a README
documenting the exact query and the (blocked) parity plan are checked in there.
