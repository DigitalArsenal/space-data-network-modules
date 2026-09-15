# Reference-frame conventions and evidence

All production orientation evaluation is C++ in `src/axis_engine.hpp` and
`src/iau_body_models.hpp`, compiled through the SDK into
`dist/isomorphic/module.wasm`. JavaScript builds, transports records, and
compares test results. The default Earth chain remains IAU 2006/2000A.

## Earth convention selection

`celestialToItrf(AxisType, Epoch, EarthOrientation, Mat3*)` accepts `ICRF`
(default 2006/2000A), `GCRF_1996`, or `GCRF_2003`. These names select a
celestial-to-terrestrial **convention**, not different inertial GCRF axes.
Matrices rotate column vectors from celestial to terrestrial coordinates;
transpose gives the inverse. TT and UT1 are two-part Julian dates. Polar motion
and celestial-pole corrections are radians. Angular rates can be obtained with
the existing `rotationWithRate` composition; origins remain independent.

### 1996

The operational [IERS TN21, chapter 5, pp.21–25](https://ilrs.gsfc.nasa.gov/docs/1996/iers_1996_conventions.pdf)
route uses IAU-1976 precession (`eraPmat76`), IAU-1980 nutation (`eraNut80`),
and **total observed** `EarthOrientation.dPsi/dEpsilon`. These offsets account
for nutation-model, precession-rate, and celestial-frame errors. Adding another
nominal rate correction or frame-bias matrix would count those effects twice.
With zero offsets the result is the uncorrected dynamical J2000/FK5 convention;
zero offsets do not realize GCRF to observational accuracy.

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

`gcrfToTod2003` uses `eraPnm00a`: IAU2000A nutation, frame bias, and Lieske
precession **with IAU2000 rate adjustments**. It is not unmodified `Pmat76`.
The terrestrial chain uses `Gmst00`, `Ee00`, and `Pom00` with `Sp00`.
Observed `dX/dY` must refer to IAU2000A; the 2006 route needs IAU2006/2000A
corrections instead. Conversion from CIP offsets to nutation offsets follows
[SOFA Earth Attitude cookbook §5.4](https://www.iausofa.org/s/sofa_pn_c.pdf).
See also ERFA [`bp00`](https://github.com/liberfa/erfa/blob/master/src/bp00.c)
and [`pr00`](https://github.com/liberfa/erfa/blob/master/src/pr00.c).

## Local and orbital axes

`orbitalFrame(VNC,r,v,...)`: X is unit velocity, Y is unit `r cross v`,
Z is X cross Y. Conormal is not generally radial. Zero/collinear geometry and
nonfinite inputs are refused. Position and velocity must share inertial axes
and consistent length/time units.

`topocentricFromBodyFixed(type,lat,lon,...)` supports `ENU`, `SEZ`, and `NED`;
`TOPOCENTRIC` retains ENU. Latitude is geodetic and longitude is east, in radians.
These functions rotate directions; caller-supplied site translation remains a
separate operation. Longitude still defines the tangent directions at a pole.

## Built-in body orientations

`icrfToIauBodyFixed(tdb1,tdb2,bodyId,...)` evaluates the full polynomial and
periodic orientation series in **TDB**. The `Epoch` overload converts TT to
geocentric TDB using ERFA `eraDtdb`; it does not silently use TT as TDB.
Named selectors are `IAU_MOON`, `IAU_MARS`, `IAU_VENUS`, `IAU_MERCURY`,
`IAU_JUPITER`, `IAU_SATURN`, and `IAU_SUN`. Generic `BODY_FIXED` record
resolution now uses the same full models, as do non-Earth topocentric,
body-equator, body-inertial, and spin/sun orientations. Earth remains the
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

## SDS mapping blocker

The actual installed dependency is `spacedatastandards.org@1.202.0`.
Its `schema/RFM/main.fbs:316` `rfmAxisType` ends with the two FK5 entries (23,24).
`GCRF_1996`, `GCRF_2003`, `VNC`, `SEZ`, `ENU`, and `NED` are not members of
that enum. VNC/SEZ occur in `OrbitRelativeFrame`, and ENU/NED in `CustomFrame`,
but `RFMCoordinateSystem.AXIS_TYPE` does not use those enums. FRM refers to
`RFMCoordinateSystem`; there is no convention selector there. The canonical
checkout's actual schema location is `schema/`, not the obsolete
`packages/spacedatastandards.org/schema/` location in the brief.

No schema, generated binding, wire value, magic system-name alias, or record
field was invented. New engine selectors await SDS ratification to become
selectable on this FRM wire. Existing `BODY_FIXED` plus
`AXIS_REFERENCE_BODY_ID` already represents the seven body rotations.
The named local/earth extensions are tested in a separate SDK reference guest
because the existing production ABI cannot yet express those selectors.

## Authoritative numerical tests

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
node --test tests/*.test.mjs
SDN_FRAME_TRI_RUNTIME=1 node --test tests/reference_frame_completeness.test.mjs
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
