# Epoch State module

`derive` turns SGP4 element sets into single-row GCRF epoch states, following
section 5 of the Evidence-Supported ASO Catalog whitepaper: the TLE-to-numerical
handoff.

For each `$MPE` on the `elements` stream:

1. SGP4 at zero elapsed time: Vallado 2020-07-13, WGS-72, opsmode `i`. These
   are the same sources and constants as `propagator/sgp4`.
2. TEME to GCRF at the same instant, using the `foundation/frames` axis engine:
   IAU 2006/2000A precession-nutation and the equation of the equinoxes from
   the vendored ERFA. TT comes from UTC through the ERFA leap-second table. The
   velocity includes the frame rotation rate.
3. The round trip back to TEME is checked. A state outside 1e-12 relative is
   refused.
4. One `$OEM` is emitted on `states`:
   - GCRF, UTC, `CENTER_NAME` EARTH, and one `EPHEMERIS_DATA_LINE` in km and
     km/s.
   - `OBJECT.OBJECT_ID` is the MPE `ENTITY_ID`. `NORAD_CAT_ID` is also set when
     the id is `NORAD:<n>`.
   - `COMMENT` carries the lineage and states the initial-condition uncertainty
     as unknown.
   - There is no `CREATION_DATE`: the output bytes depend only on the input.

`report` is JSON. It gives:

- counts of records, derived states and failures;
- epochs outside the leap-second table (before 1960, which are still derived);
- the maximum round-trip residuals;
- each refused element set, with its input index, reason and SGP4 error code.

## Build and test

```sh
npm ci
SDM_MODULE_SIGNING_KEYPAIR_PATH=<keypair.json> npm run build
npm test
```

The tests check the results against Vallado's verification set
(`tests/vallado-verification.json`: `SGP4-VER.TLE` and the t=0 rows of
`tcppver.out`). The GCRF expectations were computed with pyerfa. Astropy's TEME
to GCRS agrees within 0.7 m for the 2000 and 2006 epochs and 2.5 m for 1980.
