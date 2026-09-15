# Reference-frame conventions and evidence

All production orientation evaluation is C++ in `src/axis_engine.hpp`,
`src/iau_body_models.hpp`, and the `src/frames_module.cpp` adapter, compiled through the SDK into
`dist/isomorphic/module.wasm`. JavaScript builds, transports records, and
compares test results. The default Earth chain remains IAU 2006/2000A.

## Ratified SDS selectors

The module consumes SDS `spacedatastandards.org@1.219.0` and its generated
bindings. The following `rfmAxisType` values are supported in either
`SOURCE_COORDINATE_SYSTEM` or `TARGET_COORDINATE_SYSTEM` of a `$FRM`
`FRAME_ROTATION` or `STATE_TRANSFORM` request:

| Value | Selector | Axes / implementation |
|---|---|---|
| 25 | `TRUE_OF_DATE_EQUATOR_IERS1996` | IAU1976/1980 true equator and equinox, with direct observed nutation corrections; `gcrfToTod1996` |
| 26 | `TRUE_OF_DATE_EQUATOR_IERS2003` | IAU2000A true equator and equinox, including bias, precession-rate adjustments, and observed CIP corrections; `gcrfToTod2003` |
| 27 | `TOPOCENTRIC_EAST_NORTH_UP` | Rows east, north, up; engine `ENU` |
| 28 | `TOPOCENTRIC_NORTH_EAST_DOWN` | Rows north, east, down; engine `NED` |
| 29 | `TOPOCENTRIC_SOUTH_EAST_ZENITH` | Rows south, east, zenith; engine `SEZ` |
| 30 | `ORBITAL_VELOCITY_NORMAL_CONORMAL` | X along velocity, Z along orbit normal, Y = Z cross X; adapter reorders engine `VNC` |
| 31 | `ORBITAL_RADIAL_TRANSVERSE_NORMAL` | Rows radial, transverse, normal; engine `radialTransverseNormal` |
| 32 | `ORBITAL_LOCAL_VERTICAL_LOCAL_HORIZONTAL` | Rows transverse, negative normal, negative radial; permutation of the same RTN triad |

The request `EPOCH` is required and `EPOCH_TIME_SYSTEM` must be UTC (UTC is
also the default if omitted). The provider constructs TT and UT1 internally.
`FRAME_ROTATION` returns the source-to-target DCM, its derivative per second,
and the angular velocity of target axes relative to source axes in source
components, in rad/s. `STATE_TRANSFORM` additionally applies origin position,
origin velocity, and the rotation derivative to the input state; output
Cartesian position and velocity are metres and metres/second. EOP provenance
is retained in the response.

No downstream schema is introduced. Existing `BODY_FIXED` together with
`AXIS_REFERENCE_BODY_ID` selects the built-in body rotations.

## Earth convention selection

The C++ engine's `celestialToItrf(AxisType, Epoch, EarthOrientation, Mat3*)` accepts `ICRF`
(default 2006/2000A), `GCRF_1996`, or `GCRF_2003`. These names select a
celestial-to-terrestrial **convention**, not different inertial GCRF axes.
Matrices rotate column vectors from celestial to terrestrial coordinates;
transpose gives the inverse. TT and UT1 are two-part Julian dates. Polar motion
and celestial-pole corrections are radians. Angular rates can be obtained with
the existing `rotationWithRate` composition; origins remain independent.

The two new SDS IERS selectors select the **true-of-date equatorial** part of
these chains. They do not include Greenwich rotation or polar motion. Their
wire values are not aliases for the engine's full `GCRF_1996` and `GCRF_2003`
celestial-to-ITRF routes. Earth `BODY_FIXED` still selects the default
IAU2006/2000A terrestrial chain. Both IERS TOD selectors require a supplied
`earth_orientation` row or table, even when its corrections are zero.

### 1996

The operational [IERS TN21, chapter 5, pp.21–25](https://ilrs.gsfc.nasa.gov/docs/1996/iers_1996_conventions.pdf)
route uses IAU-1976 precession (`eraPmat76`), IAU-1980 nutation (`eraNut80`),
and **total observed** `EarthOrientation.dPsi/dEpsilon`. These offsets account
for nutation-model, precession-rate, and celestial-frame errors. Adding another
nominal rate correction or frame-bias matrix would count those effects twice.
With zero offsets the result is the uncorrected dynamical J2000/FK5 convention;
zero offsets do not realize GCRF to observational accuracy.

On the wire, these direct corrections come from `$EOP`
`NUTATION_DPSI_RADIANS` and `NUTATION_DEPS_RADIANS`. Missing fields retain
their independent SDS zero defaults. The adapter neither derives observed
IAU1980 corrections from dX/dY nor substitutes nominal precession-rate
corrections for them. The EOP table adapter interpolates both direct nutation
fields with the same elapsed-TAI fraction as xp, yp, dX, dY and LOD, and rejects
nonfinite values.

The matrix is `Pom00(xp,yp,0) R3(GAST) N P`, where
`GAST = Gmst82(UT1) + Eqeq94(TT) + dPsi cos(Obl80(TT))`.
`Eqeq94` includes `0.00264 sin(Omega) + 0.000063 sin(2 Omega)` arcsec.
As in SOFA, this route applies those terms proleptically, including before their
1997-01-01 operational introduction. This choice is explicit for historical use.

TN21 also describes a separate Herring prediction theory. Its fixed-J2000-
ecliptic precession corrections are `delta psi_A=-0.2957 T` and
`delta omega_A=-0.0227 T` arcsec, exposed by
`iers1996PrecessionRateCorrections`. They are **not** interchangeable with
observed moving-ecliptic nutation offsets. The full Herring Tables5.2–5.3 are
not implemented; this lane supplies the observed-correction route, not an
independent complete Herring predictor.

### 2003

The nominal `gcrfToTod2003` overload uses `eraPnm00a`: IAU2000A nutation, frame bias, and Lieske
precession **with IAU2000 rate adjustments**. It is not unmodified `Pmat76`.
The terrestrial chain uses `Gmst00`, `Ee00`, and `Pom00` with `Sp00`.
Observed `dX/dY` must refer to IAU2000A; the 2006 route needs IAU2006/2000A
corrections instead. Conversion from CIP offsets to nutation offsets follows
[SOFA Earth Attitude cookbook §5.4](https://www.iausofa.org/s/sofa_pn_c.pdf).
See also ERFA [`bp00`](https://github.com/liberfa/erfa/blob/master/src/bp00.c)
and [`pr00`](https://github.com/liberfa/erfa/blob/master/src/pr00.c).

The EOP overload used by the wire selector applies the corrected nutation
matrix before returning TOD. EOP `IAU_CONVENTION` identifies the model of
the supplied dX/dY. The adapter keeps separate 2000A and 2006 sets, adding
the difference between their nominal CIP coordinates at the request epoch
to preserve the observed pole. An unspecified convention retains the
established IAU2006 interpretation; IAU2000B and unknown conventions are
rejected. Direct dPsi/dEpsilon remain independent of this conversion.

SDS 1.219.0 explicitly names `MEAN_OF_DATE_EQUATOR_FK5` (23) as the
mean-of-date selector under the 2003 reduction. That selector retains the
engine's IAU1976 `gcrfToModFk5` behavior. The 2003 **true-of-date** reduction
includes IAU2000 precession-rate corrections and frame bias internally;
its intermediate precession matrix is therefore not identical to the
standalone FK5 mean-of-date matrix. The adapter follows both ratified
definitions without changing selector 23.

## Local and orbital axes

### Orbital frames

Let R be unit position, N be unit `r cross v`, T = N cross R, and V be unit
velocity. Ratified wire RTN has rows `[R,T,N]`; LVLH has rows `[T,-N,-R]`.
Wire VNC has rows `[V,N cross V,N]`. On eccentric orbits V and T differ.
The internal `orbitalFrame(VNC,r,v,...)` convention has rows
`[V,N,V cross N]`; the wire adapter reorders these rows and changes the sign
needed to implement the ratified right-handed convention.

All three named orbital selectors require a `SPACE_OBJECT` origin and an
`object_state` `$FRM` envelope whose
`FRAME_TRANSFORM_REQUEST.SOURCE_STATE.POSITION` and `VELOCITY` contain the
object's instantaneous Earth-centred ICRF state in metres and metres/second,
at the transform epoch. This auxiliary port carries an absolute geocentric
state; it is not a state relative to the requested spacecraft origin. The
auxiliary request's `SOURCE_COORDINATE_SYSTEM.ORIGIN.OBJECT_ID` identifies the
object. If both that ID and the requested origin's `OBJECT_ID` are supplied,
they must agree. The provider currently accepts Earth as the axis reference
body, with ID 399 or the default 0. It rejects missing state, nonfinite
position/velocity, invalid GM, and degenerate orbital geometry. The host is
responsible for supplying the root frame and epoch promised by this port.

The orbital rate model assumes central acceleration `a=-mu*r/|r|^3` because
`FRMStateVector` carries no acceleration. The supplied nonzero
`GRAVITATIONAL_PARAMETER` must be finite and positive, in m³/s²; zero or an
omitted field selects Earth GM `3.986004418e14 m³/s²`. With `h=r cross v`,
RTN and LVLH angular velocity is `h/|r|²`; VNC angular velocity is
`mu*h/(|r|³*|v|²)`. For rotation matrix Q, rates use the passive-rotation sign
`Qdot=-[Q*omega]cross*Q`. Spacecraft-origin translation uses the supplied
position and velocity. These rates describe the central-force model, not
acceleration from arbitrary orbit perturbations or thrust.

### Surface frames

`topocentricFromBodyFixed(type,lat,lon,...)` supports `ENU`, `SEZ`, and `NED`;
`TOPOCENTRIC` retains ENU. Latitude is geodetic and longitude is east, in radians.
These engine functions rotate directions. Longitude still defines the tangent
directions at a pole. The named wire selectors require a `GROUND_SITE` origin
with finite geodetic latitude in [-90,90] degrees, finite east longitude in
degrees, and finite ellipsoid height in metres. `SITE_BODY_ID` must match
`AXIS_REFERENCE_BODY_ID`, with 0 defaulting to Earth (399).

The current FRM origin provider resolves ground sites only on Earth, using
the WGS84 ellipsoid. It composes the named local rotation with ITRF and
computes the site's geocentric position and velocity for full state
transforms. Earth sites require EOP. Although the orientation engine supports
other bodies, a non-Earth ground-site origin is currently rejected; an
orientation model alone does not supply that site's origin translation.

## Built-in body orientations

`icrfToIauBodyFixed(tdb1,tdb2,bodyId,...)` evaluates the full polynomial and
periodic orientation series in **TDB**. The `Epoch` overload converts TT to
geocentric TDB using ERFA `eraDtdb`; it does not silently use TT as TDB.
Named selectors are `IAU_MOON`, `IAU_MARS`, `IAU_VENUS`, `IAU_MERCURY`,
`IAU_JUPITER`, `IAU_SATURN`, and `IAU_SUN`. Generic `BODY_FIXED` record
resolution now uses the same full models, as do body-equator, body-inertial,
and spin/sun orientations. Earth remains the
EOP-based ITRF chain. `SPICE_DEFINED` continues to require an external provider;
no kernel-defined frame is silently replaced with a polynomial approximation.

Planet/Sun coefficients come from Archinal et al.,
[WGCCRE2015, Table1](https://doi.org/10.1007/s10569-017-9805-5), encoded by
[NAIF pck00011](https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/pck00011.tpc).
Moon uses the **retained WGCCRE2009** E1–E13 series and quadratic W term:
the 2015 report no longer tabulates lunar elements. It is the analytical
`IAU_MOON` Mean Earth/Polar Axis approximation, not binary-PCK `MOON_PA` or
`MOON_ME`. The old six-coefficient `RotationElements` API remains available for
explicit mean-element/custom calculations; it is no longer the built-in model.

## Authoritative numerical tests

### Production FlatBuffer selector tests

`tests/rfm_selectors.test.mjs` invokes `dist/isomorphic/module.wasm` with
ratified `$RFM` coordinate systems inside `$FRM` requests. Shared fixtures
in `tests/rfm_selector_harness.mjs` exercise all eight selectors. Complete
source, input, units, frame, time-scale, and tolerance metadata are recorded
in [RFM selector verification](../tests/RFM_SELECTORS_VERIFICATION.md).

| Invoke case | Independent reference | Tolerance and rationale |
|---|---|---|
| IERS1996 and IERS2003 TOD | SOFA cookbook §5.2, printed p.21, and §5.4, printed p.24: intermediate bias/precession/nutation matrices at 2007-04-05 12:00:00 UTC | DCM max element error 1e-12 for published decimal rounding and binary64 composition |
| ENU/NED/SEZ | Exact latitude 30°, longitude 0° tangent directions, compared from Earth-fixed axes | DCM max element error 1e-14 for trigonometry and composed rotations |
| Ratified VNC/RTN/LVLH | `r=(2,0,0) m`, `v=(3,4,0) m/s`; independent rational direction vectors in ICRF | DCM max element error 1e-15 for vector normalization |
| Orbital rates and state transforms | Central-force derivatives with `mu=10 m³/s²`: VNC `omega_z=0.4 rad/s`, RTN/LVLH `omega_z=2 rad/s`; independent origin-relative position/velocity formulas | Per-case tolerances are specified in the verification record, including binary64 rounding rationale |

`tests/run_rfm_selector_runtimes.mjs` drives those same production module
bytes and fixtures in the browser/V8 harness, native WasmEdge, and container WasmEdge.
`tests/rfm_selectors_parity.test.mjs` enables this check with
`SDN_FRAME_TRI_RUNTIME=1`. The existing 111-check completeness suite remains
in place alongside these invoke-surface tests.

### Existing engine and body references

`reference_frame_cases.cpp` is executed natively and as an SDK-built guest.
The test guest uses a no-input/no-output method to execute C++ assertions;
it creates no data standard. Test-only expected data come from published
sources or CSPICE, never from the new implementation.

| Case | Source/input/frame/time | Tolerance and rationale |
|---|---|---|
| 1996, 2003, 2006 Earth matrices | SOFA cookbook §§5.2,5.4,5.6; 2007-04-05 12:00 UTC, TT/UT1 converted with ERFA; celestial→ITRF DCM | Max element error1e-12, accommodating15 published decimal digits and floating-point composition |
| Vallado3-15 | [CelesTrak companion](https://github.com/CelesTrak/fundamentals-of-astrodynamics/blob/main/software/matlab/ex3_15.m); ITRF↔GCRF position, km | Max component error1e-6km, printed6 decimal-km precision |
| Body models,22 cases | CSPICE_N0067 `pxform('J2000','IAU_*',et)`, pck00011 SHA256 pinned in `body_orientation_reference.json`; TDB days0,2651.5,-1000, plus Moon36525 | Dimensionless DCM1e-12 for Moon/all J2000,1e-11 other epochs; large-W argument reduction rounding, not claimed physical model accuracy |
| VNC | r=(2,0,0)m,v=(3,4,0)m/s in same inertial axes, instantaneous; rows(.6,.8,0),(0,0,1),(.8,-.6,0) |1e-15 for normalization of exact rational directions |
| ENU/SEZ/NED | Geodetic latitude30°, longitude0; exact E=(0,1,0),N=(-1/2,0,sqrt3/2),U=(sqrt3/2,0,1/2); fixed→local DCM, epoch-independent |1e-15 for trig rounding |
| TN21 secular rates | Fixed J2000 ecliptic,1 Julian century TT; published rates above |1e-21rad, binary64 multiplication rounding |
| Rotation identities | `R R^T=I`, dimensionless; same epochs |1e-14 for composed orthonormal matrices |

Cookbook EOP: DUT1=-0.072073685s,xp=.0349282arcsec,yp=.4833163arcsec.
The1996 case uses dPsi=-55.0655mas,dEpsilon=-6.3580mas;2003 uses
(dX,dY)=(.1725,-.2650)mas;2006 uses(.1750,-.2259)mas.

**Vallado precision:** the companion's UTC is07:51:28.386009, not rounded
07:51:28.386. DUT1=-.4399619s,xp=-.140682arcsec,yp=.333309arcsec,
dPsi=-.052195arcsec,dEpsilon=-.003875arcsec. Its code collapses UT1 to one
double `2453101.827406783`; the reproduction test explicitly uses that value.
The printed target cannot satisfy1mm if the brief's rounded timestamp is used.
Production retains two-part Julian dates. Both directions use the published
ITRF(-1033.4793830,7901.2952754,6380.3565958)km and
GCRF(5102.508958,6123.011401,6378.136928)km vectors.

Run focused tests:

```sh
node build.mjs
node --test tests/sdk_compat.test.mjs
node --test tests/rfm_selectors.test.mjs
node --test tests/*.test.mjs
SDN_FRAME_TRI_RUNTIME=1 node --test tests/reference_frame_completeness.test.mjs
SDN_FRAME_TRI_RUNTIME=1 node --test tests/rfm_selectors_parity.test.mjs
node tests/run_rfm_selector_runtimes.mjs
node tests/run_body_fixed_runtimes.mjs
```

Tri-runtime verification requires native `wasmedge` on PATH (or
`SDM_WASMEDGE_BINARY`), Docker, and the SDK's
`space-data-module-sdk/parity-wasmedge:0.16.4` image (override
`SDN_FRAME_DOCKER_IMAGE`). Missing runtimes fail the explicitly enabled check.
The disabled gate reports a skip in routine tests. Python/SpiceyPy is needed
only to regenerate independent body fixtures, not for builds or production.

`body_fixed.test.mjs` additionally checks the **production** FRM wire for all
seven bodies at UTC2007-04-05T12:00:00, against CSPICE with independently
computed UTC→TDB. The complete provenance and tolerance rationale are in
`body_fixed_utc_reference.json`. `run_body_fixed_runtimes.mjs` runs that same
production artifact in all three hosts and prints its executable-byte hash.
It also checks that Earth BODY_FIXED continues to refuse a missing EOP row;
non-Earth body-fixed axes no longer require unrelated Earth EOP.
