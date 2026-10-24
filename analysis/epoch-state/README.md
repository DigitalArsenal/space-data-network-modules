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

`report` is one FlowNotice (`FNTC`, kind Info, `SCHEMA` `$OEM`, `COUNT` the states
derived, `REASON` `derived` or `refused-element-sets`). Its `ITEMS` give:

- `records=`, `derived=`, `failed=`, `rows=` and `ages_days=`;
- `epochs_outside_leap_second_table=` (before 1960, which are still derived);
- `max_round_trip_position_km=` and `max_round_trip_velocity_km_s=` (`%.17g`);
- one `failure index=<i> entity_id=<id> reason=<r> sgp4_error=<n>` per refused
  element set.

## `derive_omm`

The same derivation for `$OMM` element sets, which element-set sources publish
(CelesTrak, Space-Track, SpaceMapper, Vimpel, and the `analysis/od` fit). The
input is a size-prefixed `$OMM` stream on `omm`. The object is the set's
`NORAD_CAT_ID` (`OBJECT_ID` of the `$OEM` is `NORAD:<n>`), else its
`OBJECT_ID`, else its `OBJECT_NAME`; the `$OEM` `OBJECT` also carries the set's
`OBJECT_NAME`. A set with none of the three, an invalid `EPOCH`, or a theory
other than SGP4 is listed in the report and produces no `$OEM`.

## `omm_from_mpe`

The `$OMM` of each `$MPE` element set: what the GP history archive stores
(`data-source/gp-archive-records`) as what element-set consumers read. The
fields map one to one. `ENTITY_ID` `NORAD:<n>` is `NORAD_CAT_ID`; any other
entity id is `OBJECT_ID`. `EPOCH` (Unix seconds) becomes ISO 8601 UTC, the mean
elements, B* and the theory are kept. There is no `ORIGINATOR` or
`CREATION_DATE`: the output depends only on the input, and the source's flow
names the originator. A record with no entity id or epoch is listed in the
report and not converted.

## Ages

`derive` and `derive_omm` read the ages from the node config (`plugin.getConfig`,
one ModuleConfig): the NumberList `derive.ages`, else `ages`, in days (up to 64
ages, 0 to 400 days; another kind is refused). A flow whose config also holds
other nodes' recipes names this node's key, `derive.ages`. The `$OEM` then has one line per age: SGP4
evaluated at the epoch plus the age (forward only), rotated to GCRF at that
row's instant, each row with its own round-trip check. Without ages the
output is the epoch state alone, byte for byte as before. The covariance
models of `analysis/gp-error-model` are indexed by this age.

## `answer_propagation_requests`

SGP4 as the plugged propagator of the query port of
`analysis/maneuver-detection`. Its `detect_maneuvers` asks for each element
set's trajectory on `propagation_requests` and is called again with the
answers. This method is the answering step, so a flow can run both passes:

| Port | Direction | Content |
| --- | --- | --- |
| `requests` | in | The detector's `propagation_requests`: one `$PRW` whose `WINDOW_REQUEST` holds a `PRWWindowQuery` per window (`SET_INDEX`, `START`/`STOP` as UTC `TIMInstant`s in ISO 8601 or Unix seconds, `STEP_SECONDS`; `ENTITY_HANDLE` 0) |
| `element_sets` | in | The `$OMM` sets the queries name; `SET_INDEX` indexes them in input order over all frames |
| `propagation` | out | One `$OEM` per query, in query order |
| `element_sets` | out | The sets, forwarded unchanged |
| `report` | out | One `$PRW` `WINDOW_REPORT`: queries, answered, refused, source records, the refusals (`SEQUENCE`, `SET_INDEX`, `REASON`) and the provider |

Each answer is one block: the set's SGP4 trajectory in TEME (UTC, km, km/s)
from the query's start to its stop in uniform steps no longer than `STEP_SECONDS`,
with the first sample at the start and the last at the stop. A set SGP4 will not
propagate (theory other than SGP4, invalid elements, an SGP4 error) is answered
by an empty block whose `COMMENT` begins `REFUSED`, the detector's refusal
convention. Forwarding the sets makes the second pass see exactly what the first saw; the
detector reads its own options from its node config, so none are forwarded.

## Build and test

```sh
mkdir -p node_modules && ln -sfn <space-data-module-sdk 0.9.3> node_modules/space-data-module-sdk
export SPACE_DATA_STANDARDS_ROOT=<SDS tree with the $PRW window arms>
SDM_MODULE_SIGNING_KEYPAIR_PATH=<keypair.json> npm run build
npm test
```

The C++ headers of every SDS family the module reads are generated from
`$SPACE_DATA_STANDARDS_ROOT/schema` (`generate-sds-headers.mjs`), and the tests
build and read `$PRW` through flatc from the same schema.

The tests check the results against Vallado's verification set
(`tests/vallado-verification.json`: `SGP4-VER.TLE` and the t=0 rows of
`tcppver.out`). The GCRF expectations were computed with pyerfa. Astropy's TEME
to GCRS agrees within 0.7 m for the 2000 and 2006 epochs and 2.5 m for 1980.

The rows at later ages, and the TEME trajectory the query port answers, are
checked against `tests/ages-reference.json`, written by
`tests/ages-reference.py` from python-sgp4 2.27 and pyerfa 2.0.1.5 (positions
within 1 mm, velocities within 1e-9 km/s). Parity (browser and
native WasmEdge; the owner waived the Docker leg on 2026-10-22) of the methods:
`PATH=$HOME/.wasmedge/bin:$PATH node tests/parity.mjs`.
