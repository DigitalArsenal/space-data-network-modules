# Foundation Frames

`foundation/frames` provides a standalone SDK-compliant C++/WASM module for SDS `FRM` frame and geodetic transform requests. The first supported surface ports Basilisk `geodeticConversion` utility tests for PCI/PCPF position transforms, ellipsoid-based LLA/PCPF conversion, and Basilisk's negative-polar-radius spherical LLA/PCPF branch.

## Build

```sh
npm install
npm run build
npm test
npm run test:sdk-compat
```

The module accepts `FRMFrameTransformRequest` envelopes on the `request` port and emits `FRMFrameTransformResult` envelopes on the `result` port.

## Reference-frame conventions

The shared C++ axis engine includes selectable IERS1996 and IERS2003 Earth
chains, VNC and named SEZ/ENU/NED rotations, and full built-in IAU body models
for Moon, Mars, Venus, Mercury, Jupiter, Saturn, and Sun. Existing FRM
`BODY_FIXED` requests use those models, including periodic terms. The new
Earth/local names require an SDS `rfmAxisType` extension before they can be
selected through FRM.

See [conventions, schema limitations, and authoritative tests](docs/reference-frames.md)
for time scales, correction handling, lunar model provenance, and reproduction
commands.

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

The C++ adapter linearly interpolates xp, yp, dX, dY and LOD. It interpolates
UT1−TAI and converts back to UT1−UTC at the query epoch, avoiding a spurious
ramp across a leap second. The fraction uses elapsed TAI between samples;
on ordinary daily intervals this is the ordinary UTC-day linear fraction.
ERFA `eraDat`/`eraUtctai` provide leap-second offsets; existing
`eraDtf2d`/`eraUtcut1`/`eraTaitt` construct the time scales used by the axis
engine. Samples exactly at table nodes retain their original doubles.

Each `_HP` field is authoritative **when present**, including zero. Other
quantities independently fall back to their legacy float fields. Omitted
optional LOD/CIP corrections therefore use the SDS zero default; this is
not an assertion that an upstream observation of zero exists. Unspecified
IAU convention retains the legacy caller-supplied 2006/2000A interpretation.
IAU 2000A offsets are adjusted by the difference between ERFA's IAU2000A CIP
and this engine's IAU2006 X,Y series at the query epoch, preserving the
observed CIP. IAU2006 offsets are applied directly; IAU2000B/unknown
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
SDN_RUN_EOP_PARITY=1 node --test tests/*.test.mjs
```

The parity suite runs the same bytes in real Chrome, native WasmEdge 0.16.4,
and Docker WasmEdge 0.16.4. The established axis-engine/coordinate-system
and signed-artifact checks remain part of the full suite.
