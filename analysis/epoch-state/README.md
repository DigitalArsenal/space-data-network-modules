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

## `derive_omm`

The same derivation for `$OMM` element sets, which element-set sources publish
(CelesTrak, Space-Track, SpaceMapper, Vimpel, and the `analysis/od` fit). The
input is a size-prefixed `$OMM` stream on `omm`. The object is the set's
`NORAD_CAT_ID` (`OBJECT_ID` of the `$OEM` is `NORAD:<n>`), else its
`OBJECT_ID`, else its `OBJECT_NAME`; the `$OEM` `OBJECT` also carries the set's
`OBJECT_NAME`. A set with none of the three, an invalid `EPOCH`, or a theory
other than SGP4 is listed in the report and produces no `$OEM`.

## Ages

`derive` and `derive_omm` take an optional `options` frame, `{"ages": [days]}`
(up to 64 ages, 0 to 400 days). The `$OEM` then has one line per age: SGP4
evaluated at the epoch plus the age (forward only), rotated to GCRF at that
row's instant, each row with its own round-trip check. Without `options` the
output is the epoch state alone, byte for byte as before. The covariance
models of `analysis/gp-error-model` are indexed by this age.

## `answer_propagation_requests`

SGP4 as the plugged propagator of the query port of
`analysis/maneuver-detection`. Its `detect_maneuvers` asks for each element
set's trajectory on `propagation_requests` and is called again with the
answers. This method is the answering step, so a flow can run both passes:

| Port | Direction | Content |
| --- | --- | --- |
| `requests` | in | The detector's `propagation_requests` |
| `element_sets` | in | The `$OMM` sets the queries name; `set` indexes them in input order over all frames |
| `options` | in, out | The detector's options, forwarded unchanged |
| `propagation` | out | One `$OEM` per query, in query order |
| `element_sets` | out | The sets, forwarded unchanged |
| `report` | out | Queries answered and refused, with reasons |

Each answer is one block: the set's SGP4 trajectory in TEME (UTC, km, km/s)
from the query's start to its stop in uniform steps no longer than `step_s`,
with the first sample at the start and the last at the stop. A set SGP4 will not
propagate (theory other than SGP4, invalid elements, an SGP4 error) is answered
by an empty block whose `COMMENT` begins `REFUSED`, the detector's refusal
convention. Forwarding the sets and options makes the second pass see exactly
what the first saw.

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

The rows at later ages, and the TEME trajectory the query port answers, are
checked against `tests/ages-reference.json`, written by
`tests/ages-reference.py` from python-sgp4 2.27 and pyerfa 2.0.1.5 (positions
within 1 mm, velocities within 1e-9 km/s). Tri-runtime parity (browser,
WasmEdge, Docker WasmEdge) of the three methods: `PATH=$HOME/.wasmedge/bin:$PATH
node tests/parity.mjs`.
