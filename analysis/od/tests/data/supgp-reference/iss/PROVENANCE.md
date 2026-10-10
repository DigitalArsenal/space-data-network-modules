# ISS OEM fixture

`ISS.OEM_J2K_EPH.trimmed.txt` is the NASA public ISS ephemeris (CCSDS OEM,
EME2000, UTC), retrieved 2026-07-13, START_TIME 2026-07-13T12:00:00, trimmed.
Source: NASA Johnson Space Center, Flight Operations Directorate (TOPO),
https://www.nasa.gov/spot-the-station/ . A U.S. Government work, public domain.

The CelesTrak ISS-E SupGP capture that the reference gate paired with it is not
licensed for redistribution and is not in this tree. The gate
(`provider.json`, the SupGP CSV and the A2.4 analysis) runs from
`$SDN_MODULES_PRIVATE_FIXTURES/analysis/od/tests/data/supgp-reference/iss`
(see `tests/lib/privateFixtures.mjs`).
