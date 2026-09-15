# Foundation Frames

`foundation/frames` provides a standalone SDK-compliant C++/WASM module for SDS `FRM` frame and geodetic transform requests. The first supported surface ports Basilisk `geodeticConversion` utility tests for PCI/PCPF position transforms, ellipsoid-based LLA/PCPF conversion, and Basilisk's negative-polar-radius spherical LLA/PCPF branch.

## Build

```sh
npm ci
npm run build
npm test
npm run test:sdk-compat
```

The module accepts `FRMFrameTransformRequest` envelopes on the `request` port and emits `FRMFrameTransformResult` envelopes on the `result` port.

## Reference-frame conventions

SDS `spacedatastandards.org@1.219.0` supplies the following ratified
`RFMCoordinateSystem.AXIS_TYPE` selectors. They are accepted on either side of
FRM `FRAME_ROTATION` and `STATE_TRANSFORM` requests.

| Value | `rfmAxisType` |
|---|---|
| 25 | `TRUE_OF_DATE_EQUATOR_IERS1996` |
| 26 | `TRUE_OF_DATE_EQUATOR_IERS2003` |
| 27 | `TOPOCENTRIC_EAST_NORTH_UP` |
| 28 | `TOPOCENTRIC_NORTH_EAST_DOWN` |
| 29 | `TOPOCENTRIC_SOUTH_EAST_ZENITH` |
| 30 | `ORBITAL_VELOCITY_NORMAL_CONORMAL` |
| 31 | `ORBITAL_RADIAL_TRANSVERSE_NORMAL` |
| 32 | `ORBITAL_LOCAL_VERTICAL_LOCAL_HORIZONTAL` |

The two IERS selectors return true-of-date equatorial axes, before Earth spin
and polar motion. Earth `BODY_FIXED` continues to use the IAU 2006/2000A ITRF
chain. All three named local selectors require a valid Earth `GROUND_SITE`
origin and EOP. Named orbital selectors require a `SPACE_OBJECT` origin and
its Earth-centred ICRF position and velocity on `object_state`. Their rates
assume central acceleration, using the state's positive gravitational
parameter or the default Earth GM; no perturbed acceleration is inferred.

The ratified wire VNC has X along velocity, Z along the orbit normal, and
Y = Z cross X. This differs from the internal engine's VNC row order. The
adapter applies the ratified order. FRM `BODY_FIXED` also provides full IAU
body models, including periodic terms, for Moon, Mars, Venus, Mercury,
Jupiter, Saturn, and Sun.

See [conventions, input contracts, and authoritative tests](docs/reference-frames.md)
for complete frame definitions, rates, time scales, correction handling,
lunar model provenance, and reproduction commands.

`tests/rfm_selectors.test.mjs` exercises every new selector through the
production FlatBuffer invoke surface. Its SOFA and closed-form reference
cases, units, tolerances, and runtime checks are documented in
[RFM selector verification](tests/RFM_SELECTORS_VERIFICATION.md).

## EOP tables and interpolation

`transform_frame_position` accepts `earth_orientation` as one instantaneous
SDS `$EOP` row, several row frames, or a stream of size-prefixed standalone
rows from [eop-parser](../../data-source/eop-parser/README.md). At most 366
rows may be supplied. This extends the existing invoke port without a schema
change. A host should select a short window covering the request epoch.

One row retains the established contract: its values are the caller's EOP
for this invocation, even if its DATE is the daily source epoch. With two or
more rows, MJD must be strictly increasing and every supplied DATE must agree
with MJD at 00:00 UTC. The requested UTC epoch must fall within the table;
there is no extrapolation. Mixed SERIES, IAU_CONVENTION, DATA_SET_CID or
DATA_SET_EPOCH values are rejected. Provenance is retained in the FRM result.

The C++ adapter linearly interpolates xp, yp, dX, dY, LOD, and the direct
IAU1980 nutation corrections `NUTATION_DPSI_RADIANS` and
`NUTATION_DEPS_RADIANS`. It interpolates
UT1−TAI and converts back to UT1−UTC at the query epoch, avoiding a spurious
ramp across a leap second. The fraction uses elapsed TAI between samples;
on ordinary daily intervals this is the ordinary UTC-day linear fraction.
ERFA `eraDat`/`eraUtctai` provide leap-second offsets; existing
`eraDtf2d`/`eraUtcut1`/`eraTaitt` construct the time scales used by the axis
engine. Samples exactly at table nodes retain their original doubles.

Each `_HP` field is authoritative **when present**, including zero. Other
quantities independently fall back to their legacy float fields. Omitted
optional LOD/CIP corrections therefore use the SDS zero default; this is
not an assertion that an upstream observation of zero exists. The two direct
nutation fields also default independently to zero when omitted. IERS1996
uses those fields directly; the adapter invents no observed corrections from
dX/dY and adds no extra secular precession correction.

Unspecified IAU convention retains the established 2006/2000A interpretation.
The adapter keeps separate IAU2000A and IAU2006 correction sets. At the query
epoch it adds the difference between the source and selected model's nominal
CIP to dX/dY, preserving the observed CIP: IERS2003 receives IAU2000A offsets,
and the default Earth chain receives IAU2006 offsets. IAU2000B/unknown
conventions are rejected.

No subdaily ocean-tide/libration correction is added. Linear interpolation
is the requested daily-table policy and does not claim subdaily IERS tide
accuracy. `eraUt1utc` converts time scales; `eraPmsafe` propagates stellar
proper motion and is not an EOP tide routine. Those routines cannot substitute
for the IERS ocean-tide/libration models. Storage, source selection and
publication remain host concerns.

### Authoritative EOP verification

`tests/eop_interpolation.test.mjs` compares GCRF→ITRF with the published matrix
in [SOFA Tools for Earth Attitude](https://www.iausofa.org/s/sofa_pn_c.pdf),
revision 1.7, §5.6, printed page 27. The engine uses that section's X,Y-series
method; §5.5's classical-angle method has a slightly different printed matrix.

Epoch: 2007-04-05 12:00:00 UTC. xp=0.0349282 arcsec,
yp=0.4833163 arcsec, UT1−UTC=−0.072073685 seconds,
dX=+0.0001750 arcsec, dY=−0.0002259 arcsec. The dimensionless row-major
matrix must agree within 1e-12 per entry; the bound allows published decimal
rounding and library arithmetic, without relaxing to model accuracy.

Other checks use published finals2000A MJD60000/60001 values at the nodes and
midpoint, and MJD57753/57754 UT1 values across the 2016 leap second. Expected
interpolation is independently calculated from those input decimals in the
tests. They also cover mixed provenance, malformed buffers, duplicate dates,
extrapolation refusal, HP zero presence and partial HP/float records.

```sh
node build.mjs
node --test tests/sdk_compat.test.mjs
node --test tests/rfm_selectors.test.mjs
SDN_FRAME_TRI_RUNTIME=1 node --test tests/rfm_selectors_parity.test.mjs
SDN_RUN_EOP_PARITY=1 node --test tests/*.test.mjs
```

The parity suite runs the same bytes in real Chrome, native WasmEdge 0.16.4,
and Docker WasmEdge 0.16.4. The established axis-engine/coordinate-system
and signed-artifact checks remain part of the full suite.
