# Ratified RFM selector verification

`rfm_selectors.test.mjs` invokes the shipped `dist/isomorphic/module.wasm`
through the SDK. Each request carries canonical `RFMCoordinateSystem`
records inside `$FRM`; responses are decoded as `$FRM`. The tests assert the
ratified `rfmAxisType` ordinals 25 through 32 from SDS 1.219.0. JavaScript
encodes inputs and measures errors; production physics remains C++/WASM.

## Independent numerical authority

All direction cosine matrices (DCMs) below act on column vectors and have
dimensionless entries. Maximum error means the largest absolute component
difference. Inverse expectations are transposes of the independent matrices.

| Selectors | Authority and inputs | Frame and time | Tolerance and rationale |
|---|---|---|---|
| 25, IERS1996 | [SOFA Earth Attitude cookbook](https://www.iausofa.org/s/sofa_pn_c.pdf), rev.1.7, §5.2, printed NPB matrix p.21; observed dPsi=-.0550655arcsec, dEpsilon=-.0063580arcsec | ICRF/GCRF to true equator/equinox of date; 2007-04-05T12:00:00 UTC; TT JD2454195.5+.500754444444444 | 1e-12 DCM, allowing the 15 printed decimal places and floating-point composition |
| 26, IERS2003 | Same cookbook §5.4, printed equinox-based NPB matrix p.24; dX=.0001725arcsec, dY=-.0002650arcsec against IAU2000A | ICRF/GCRF to true equator/equinox of date; same UTC/TT | 1e-12 DCM, same rationale |
| 27/28/29, ENU/NED/SEZ | Independent tangent vectors at geodetic latitude30°, east longitude0°: E=(0,1,0), N=(-1/2,0,sqrt(3)/2), U=(sqrt(3)/2,0,1/2); NED=(N,E,-U), SEZ=(-N,E,U) | Earth BODY_FIXED to local axes, common GROUND_SITE origin at 0m ellipsoid height; same UTC; fixed-to-local orientation is epoch-independent | 1e-14 DCM, allowing trig and composition of two root-to-frame matrices |
| 30, wire VNC | SDS1.219.0 `schema/RFM/main.fbs`: X=velocity, Z=orbit normal, Y completes right-handed set. For r=(2,0,0)m, v=(3,4,0)m/s: X=(.6,.8,0), Y=(-.8,.6,0), Z=(0,0,1) | Earth-centered ICRF object state at same UTC; instantaneous object-centered axes | 1e-15 DCM, normalization of exact rational directions |
| 31, RTN | Same ratified schema: X=radial, Z=normal. Same state gives identity DCM | Same ICRF object state and epoch | 1e-15 DCM, exact Cartesian basis |
| 32, LVLH | Same ratified schema: Z=nadir, Y=-normal. Same state gives rows(0,1,0),(0,0,-1),(-1,0,0) | Same ICRF object state and epoch | 1e-15 DCM, exact signed Cartesian basis |

The new wire VNC order differs from the historical native helper tested by
`reference_frame_cases.cpp`, whose Y axis is normal. The nonperpendicular r/v
fixture distinguishes velocity-aligned axes from radial/transverse axes.

The SOFA EOP row also carries xp=.0349282arcsec, yp=.4833163arcsec and
UT1-UTC=-.072073685s. Angular values are converted using pi/648000 radians per
arcsecond and encoded in SDS double fields. TOD references exclude terrestrial
rotation and polar motion. Tests also require EOP provenance in the response.

### EOP interpolation and convention conversion

For selector25, two synthetic rows at UTC midnight on April5/6 have
(dPsi,dEpsilon)=(-.060000,-.008000) and (-.050131,-.004716)arcsec.
Their noon arithmetic midpoint exactly matches the published SOFA offsets;
the expected output remains the published matrix, not another module result.

For selector26, a separate IAU2006-offset input must realize the same pole as
the IAU2000A example. SOFA's original 2006 offsets use the `Xys06a` angle
formulation, whereas the module's existing default uses `Xy06` series.
The cookbook documents their small difference. The test corrects the supplied
2006 offsets by independently printed CIP differences between §5.3 and §5.6:

- deltaX=.000712264729708-.000712264729525 radians.
- deltaY=.000044385250265-.000044385248875 radians.

The expected result is again the §5.4 TOD matrix at tolerance1e-12. This checks
the conversion without treating distinct angle/series models as identical.

### State translation and velocity

Each selector transforms a relative position (4,5,6)m. Orbital requests send
(6,5,6)m in Earth-centered ICRF and subtract the referenced object's
(2,0,0)m origin. Local source and target share the same surface-site origin.
Expected position is the independent DCM times (4,5,6). Tolerances are
2e-11m for TOD/orbital cases and 1e-8m for local cases; the latter permits
cancellation when translating through approximately 6e6m Earth coordinates.

For the orbital rate tests, the same synthetic state has explicit
mu=10m³/s². Newton's inverse-square acceleration is a=(-2.5,0,0)m/s².
Therefore h_z=8m²/s, RTN/LVLH angular speed=h/r²=2rad/s, and wire VNC
angular speed=(v cross a)_z/v²=.4rad/s. Differentiating the independent
basis vectors gives passive DCM rate `Rdot=-[omega_target]cross R`.
Rates and angular velocities have tolerances1e-14/s and1e-14rad/s for
floating-point multiplication/normalization.

A source state p=(6,5,6)m, v=(2,6,3)m/s has relative p=(4,5,6)m and
v=(-1,2,3)m/s. The exact target velocity `R v+Rdot p` is (.92,-.56,3)m/s
for wire VNC, (9,-6,3)m/s for RTN, and (-6,-3,-9)m/s for LVLH;
tolerance1e-13m/s covers arithmetic roundoff. A source state exactly equal
to the object's state must become zero position and velocity to1e-15 SI.

## Validation and runtime coverage

Tests reject missing Earth EOP, missing/collinear/zero/nonfinite object states,
mismatched object identifiers, non-object origins for orbital selectors,
non-site/mismatched-body local origins, and invalid site latitude.

```sh
node --test tests/rfm_selectors.test.mjs
node tests/run_rfm_selector_runtimes.mjs
SDN_FRAME_TRI_RUNTIME=1 node --test tests/rfm_selectors_parity.test.mjs
```

The standalone runner executes the full numerical suite in browser/V8, native
WasmEdge, and Docker WasmEdge. Each lane loads the same production artifact;
the runner verifies its bytes remain unchanged between lanes and prints the
SHA256 of the loadable WASM. `SDM_WASMEDGE_BINARY` selects native WasmEdge;
`SDN_FRAME_DOCKER_IMAGE` selects the container image. The default image is
`space-data-module-sdk/parity-wasmedge:0.16.4`. Missing selected runtimes fail.
The optional test gate skips only when `SDN_FRAME_TRI_RUNTIME` is unset.

### Measured errors in all three runtimes (2026-09-15)

The enabled parity gate passed 23/23 numerical/validation tests per runtime
with zero skips. Browser/V8, native WasmEdge, and container WasmEdge reported
identical errors below, loading executable SHA256
`e3fbdab658ee30de95dc97f41097319b0e86e00fdad7087a25aa784ae2637071`.
The runner removes inherited `NODE_TEST_CONTEXT` before starting test children
and asserts their TAP test/pass/fail/skip counts, preventing a nested Node
test-runner skip from being mistaken for a successful runtime check.

| Case | Maximum observed error |
|---|---|
| IERS1996 forward/inverse and interpolated offsets | 4.44089210e-16 DCM |
| IERS2003 forward/inverse | 4.92803769e-16 DCM |
| IERS2003 input converted from IAU2006 | 8.81097224e-16 DCM |
| ENU/NED/SEZ forward/inverse | 2.22044605e-16 DCM |
| Wire VNC forward/inverse | 2.22044605e-16 DCM |
| RTN/LVLH forward/inverse | 0 DCM |
| TOD/VNC state position | 5.32907052e-15m |
| Local state position | 8.63900063e-11m |
| RTN/LVLH position, rates, velocity | 0 |
| Wire VNC DCM rate/angular velocity | 5.55111512e-17/s; 2.22044605e-16rad/s |
| Wire VNC target velocity | 8.88178420e-16m/s |

The existing 111-check native/SDK completeness suite is unchanged and retains
its separate SOFA terrestrial-chain, Vallado, CSPICE, and helper-level coverage.
