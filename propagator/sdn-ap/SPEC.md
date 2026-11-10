# SGP4-XP: mathematical specification (clean room, side A)

Version 0.6.9 (dist 072b233c).

**License note.** The US Space Force Sgp4Prop library is used under the USSF open source agreement
(`space-data-network-modules/propagator/sgp4-xp/third_party/ussf-sgp4/AGREEMENT.txt`; the 9.9 package carries the
same agreement as `Licenses/SGP4_Open_License.txt`). Its section 2.A grants Use, Distribution, Reproduction,
Redistribution and Display; it does not grant Modification. This document therefore holds no code of the library and
nothing derived from its code as code: only mathematics in prose and notation, constants with their values, units and
sources, branch conditions and order of operations, each tied to open literature or to black-box behavior of the
unmodified library observed through the oracle harness (private: closed-modules `packages/sgp4-xp-oracle`). Side B
builds from this document and the oracle alone.

**Version specified.** 9.9 (native MacOS ARM library of the archived 9.9 package). Its native library works as an
oracle (the harness's leg `9.9`). Section 11 states where 9.1.1.0 (the vendored WebAssembly build) differs.

**Implementation.** Side B builds the bundle `propagator/sdn-ap/` of the public modules repository (Apache-2.0, except this directory: PolyForm Noncommercial 1.0.0) from this
document; it keeps the name SDN-AP and carries SGP4 and SGP4XP. The public description of SGP4-XP is
[Payne et al. (2022), Improvements to the SGP4 Propagator (SGP4-XP)](https://amostech.com/TechnicalPapers/2022/Astrodynamics/Payne_2.pdf).
Agreement with the USSF library measures implementation conformance, not orbit accuracy. Orbit accuracy
requires forward errors against independent truth, with lead time counted from the end of the fit.

**Status (2026-10-24, side A).** Sections 1-11 are complete, the refusal rules of 8 and 9 included. Not fixed by any
specification: shadow decisions that are rounding-limited (4), for which both outcomes conform. Explicit and
confirmed against the library: constants (1), the native elements (1.5), the zonal rates through J5 (2) and the
averaged third-body rates (5), whose sum reproduces the library's native rates to 1e-8..1e-10; the flux model,
Jacchia-70 temperature, density grid and the complete drag formulation (3, drag rates to 1e-9), with the density
table identified as SR 313's printed Table 6 (3.3); the output-time Sun/Moon (5.4) and SRP (4) corrections and the
J2 short-period corrections (8), which together reproduce epoch states to 1e-9 km; the shadow rule and the
shadow-averaged SRP rates (4); the analytic Sun and Moon (5); the resonance terms of every class with their rate
equations, coefficients, series and exact band limits (6, n-dot to 2e-12); the integrator (9); the version
difference (11).

**Markers.** *[probe]* = confirmed by black-box probing through the oracle; the matching vectors are in
`spec-vectors/` under the same section number. *[doc]* = stated by the library's public release notes, JIRA
summaries or interface documents. *[lit]* = follows the cited open literature. *[study]* = the mathematics as read
from the compiled 9.1.1.0 library (equations, constants and branch conditions only; nothing of its code). *[open]* =
not yet pinned; the probe that pins it is named.

---

## 1. Conventions and constants

### 1.1 Element set (ephemeris type 4)

A type-4 element set is a two-line element set whose line 1 column 63 holds `4` *[doc: Tle interface document;
release notes 8.0, figure 3]*. Fields that differ from types 0 and 2:

| field | type 0/2 meaning | type 4 meaning | columns |
| --- | --- | --- | --- |
| line 1, 34-43 | n-dot/2 | not used | 34-43 |
| line 1, 45-52 | n-ddot/6 | AGOM, solar radiation pressure area-to-mass, m^2/kg, `±NNNNN±E` = ±0.NNNNN x 10^±E | 45-52 |
| line 1, 54-61 | B* (1/earth radii) | B, ballistic coefficient, m^2/kg, same exponent format | 54-61 |
| line 2, 53-63 | Kozai mean motion (type 0) | Brouwer mean motion, rev/day | 53-63 |

All other fields (epoch, inclination, node, eccentricity, argument of perigee, mean anomaly, revolution number) have
their usual meaning (Hoots & Roehrich 1980, section 2). The angles and eccentricity are Brouwer mean elements; no
Kozai-to-Brouwer recovery is applied to type 4 *[doc: release notes 8.0, figure 3 item 4; probe 1.1]*. AGOM folds the reflectivity coefficient in (AGOM = C_R A/m: the SRP acceleration is P AGOM, section 4,
*[study; probe 4.1]*); B = C_D A/m, the drag acceleration being -(1/2) rho B |v_rel| v_rel (section 3.4) *[study; probe 3.2, 3.5]*.

### 1.2 Time

- Epoch: two-digit year (57-99 = 19xx, 00-56 = 20xx) and day of year with fraction, UTC (Hoots & Roehrich 1980).
- Propagation time t: minutes since epoch (`mse`). Days since 1950 January 0.0 UTC (`ds50utc`, the library's
  absolute time) = ds50(epoch) + t/1440 *[probe 1.2]*.
- Greenwich sidereal angle for theory use (resonance, VDS longitudes) follows the 1970-referenced formula of
  Vallado et al. 2006 (the AFSPC "operations mode" alternative): with d = d50 - 7305, days since 1970 January 0.0
  UTC (d = 1 at 1970 January 1.0; d_i = d truncated toward zero, d_f = d - d_i),
  theta_G = THGR70 + C1 d_i + (C1 + 2 pi) d_f + FK5R d^2, reduced to [0, 2 pi),
  THGR70 = 1.7321343856509374 rad, C1 = 1.72027916940703639e-2 rad/day, FK5R = 5.07551419432269442e-15 rad/day^2
  *[lit: Vallado et al. 2006, sgp4 code "ops mode"; study: the three values and the day origin are the library's]*.
  The library's JIRA ASTROSTDS-937 (9.0) records that its theta differs from the theory author's only through the
  flattening used *[doc]*.
- Earth rotation rate: omega_E = 4.37526908801129966e-3 rad/min, the SGP4 deep-space value *[lit: Hoots &
  Roehrich 1980; Vallado et al. 2006; value compiled into the library]*. It is the co-rotation rate of the atmosphere in drag (3.4)
  *[probe 3.2]*.

### 1.3 Earth model (EGM-96 for type 4)

Type 4 uses EGM-96 constants in place of WGS-72 *[doc: release notes 8.0, figure 3 item 8; probe 1.1]*:

| constant | value | units | source |
| --- | --- | --- | --- |
| mu (GM) | 398600.4415 | km^3/s^2 | EGM-96 (Lemoine et al. 1998) |
| R_E | 6378.1363 | km | EGM-96 |
| k_e = 60 sqrt(mu/R_E^3) | 0.074366859954178854 | R_E^1.5 / min | derived; compiled value |
| J2 | 1.08262668355315e-3 | - | EGM-96 unnormalized zonal (-C20 sqrt 5) |
| J3 | -2.53265648533224e-6 | - | EGM-96 |
| J4 | -1.619621591367e-6 | - | EGM-96 |
| J5 | -2.27296082868698e-7 | - | EGM-96; added for XP "for consistency with PPT3 and Brouwer" *[doc: release notes 8.0, item 5]* |
| k2 = J2/2 | 5.4131334177655e-4 | - | Hoots & Roehrich 1980 notation |
| k4 = -3 J4 / 8 | 6.07358096762625e-7 | - | Hoots & Roehrich 1980 notation |
| f (flattening) | 3.3528197529902951e-3 (1/f = 298.256415099) | - | the corrected EGM-96 value adopted for XP in 9.0 *[doc: release notes 9.0, EnvConst]* |

Tesseral and sectoral coefficients for resonance are the full-precision EGM-96 values (fully normalized
C_lm, S_lm from the EGM-96 coefficient file, unnormalized for use) *[doc: release notes 9.1; JIRA ASTROSTDS-1140]*.
Which (l, m) are used is given in section 6.

Kozai/Brouwer mean-motion conversions elsewhere in the library always use WGS-72 *[doc: release notes 8.0,
figure 1 item 10]*; they do not enter type-4 propagation.

### 1.4 Units and canonical scaling

Internally the theory is written in Earth radii and minutes (Hoots & Roehrich 1980): distance unit R_E, time unit
minutes, mu = k_e^2. Positions and velocities are scaled back to km and km/s with the EGM-96 R_E (the 8.2 fix
ASTROSTDS-667 made the back-conversion use the type-4 constants) *[doc; probe 1.1]*.

Mean semi-major axis from the Brouwer mean motion: a = R_E (k_e / n)^(2/3), n in rad/min. At t = 0 the library's
mean Keplerian output equals the element-set values and this a exactly (a = 6883.97761201 km for n = 15.2 rev/day)
*[probe 1.1]*.

### 1.5 Native element set

The theory carries **mean equinoctial elements** (Broucke & Cefola 1972; Cefola 1972), observable through the
oracle's `nativeElements` *[probe 1.3]*:

| # | element | definition | rate units |
| --- | --- | --- | --- |
| 1 | a_f | e cos(omega + Omega) | 1/min |
| 2 | a_g | e sin(omega + Omega) | 1/min |
| 3 | chi | tan(i/2) sin Omega | 1/min |
| 4 | psi | tan(i/2) cos Omega | 1/min |
| 5 | lambda | M + omega + Omega, degrees | deg/day |
| 6 | n | Brouwer mean motion, rev/day | rev/day^2 |

(direct/retrograde factor +1; i < 180 deg). At epoch they equal the element-set values exactly, and lambda advances at
the mean longitude rate (5471.4021 deg/day for the 15.2 rev/day, 51.6 deg case) *[probe 1.3]*. The library's
interface describes the longitude as held relative to Greenwich internally ("subtract thetaG"); the values it
returns are the inertial mean longitude *[doc + probe 1.3]*.

**A native-element report at time t is a fresh initialization at t** *[study; probe 6.8, 6.9]*. The library
propagates the set to t, makes from the mean elements there a new element set with epoch t (same B and AGOM, the
values carried in full precision), initializes it, and reports that set's epoch elements and epoch rates. The
elements are therefore the integrated mean elements at t (cubic Hermite between nodes, 9). The rates are the rate
function at those elements, but as of a new epoch: what initialization fixes, among it the resonance class (6) and
the resonance function values F and G (6.3), is taken from the elements at t instead of the epoch, and theta_G is
the 1.2 value at t. At t = 0 report and integrator agree; later the reported rates are not the rates the
integrator used, and the elements of later times do not follow from integrating them.

---

## 2. Secular and long-period terms (zonals J2-J5)

**Model.** The zonal problem through J5 is treated in the Brouwer (1959) manner. The integrated elements are
averaged over the short period only: the zonal part of the mean-element rates is the derivative of Brouwer's
short-period-averaged Hamiltonian, so it holds both the secular terms (J2, J2^2, J4) and the long-period terms in
omega, 2 omega and 3 omega (J2^2, J3, J4, J5); no separate zonal long-period correction is added at the output
*[lit: Brouwer 1959 sections 4-6; study]*. The rates are formed in Keplerian variables and carried into the
equinoctial rates of 1.5 by the chain rule (Broucke & Cefola 1972) *[study]*. PPT3, which the release notes name,
has the same zonal content through J5 *[doc: release notes 8.0 item 5]*.

Leading secular rates (k2 = J2/2, p = a(1 - e^2), R_E and minutes):

- Omega-dot = -3 k2 n cos i / p^2 x [1 + O(J2)]
- omega-dot = (3/2) k2 n (5 cos^2 i - 1) / p^2 x [1 + O(J2)]
- M-dot = n [1 + (3/2) k2 sqrt(1 - e^2) (3 cos^2 i - 1) / p^2 + O(J2^2, J4)]

with the second-order terms of Brouwer 1959, equations (16)-(18).

**Explicit zonal rates** *[study; probe 2.2]*. The zonal part of the rate function gives the same six-component
set as the output-time third-body terms (5.4): a zero mean-motion rate, then e-dot, i-dot, e varpi-dot (varpi =
omega + Omega), sin i Omega-dot and lambda-dot - n, in rad/min. Notation: n the mean motion (rad/min), p = a (1 - e^2)
in R_E with a = (k_e/n)^(2/3), s = sin i, c = cos i, eta = sqrt(1 - e^2), J2-J5 of 1.3. Each rate is the sum of
the terms listed, each a J coefficient times the bracket:

**e-dot** =
- J2^2 x [-3 e n s^2 (e - 1) (e + 1) (15 s^2 - 14) sin(2 omega)/(32 p^4)]
- J3 x [-3 n s (e - 1) (e + 1) (5 s^2 - 4) cos(omega)/(8 p^3)]
- J4 x [-15 e n s^2 (e - 1) (e + 1) (7 s^2 - 6) sin(2 omega)/(32 p^4)]
- J5 x [-15 n s (e - 1) (e + 1) (126 c^4 e^2 cos(omega) - 63 c^4 e^2 cos(3 omega) + 168 c^4 cos(omega) - 84 c^2 e^2
  cos(omega) + 70 c^2 e^2 cos(3 omega) - 112 c^2 cos(omega) + 6 e^2 cos(omega) - 7 e^2 cos(3 omega) + 8
  cos(omega))/(256 p^5)]

**i-dot** =
- J2^2 x [3 e^2 n (14 - 15 s^2) sin(2 i) sin(2 omega)/(64 p^4)]
- J3 x [3 c e n (4 - 5 s^2) cos(omega)/(8 p^3)]
- J4 x [15 e^2 n (6 - 7 s^2) sin(2 i) sin(2 omega)/(64 p^4)]
- J5 x [15 c e n (-126 c^4 e^2 cos(omega) + 63 c^4 e^2 cos(3 omega) - 168 c^4 cos(omega) + 84 c^2 e^2 cos(omega) -
  70 c^2 e^2 cos(3 omega) + 112 c^2 cos(omega) - 6 e^2 cos(omega) + 7 e^2 cos(3 omega) - 8 cos(omega))/(256 p^5)]

**e varpi-dot** =
- J2 x [3 e n (-2 c - 5 s^2 + 4)/(4 p^2)]
- J2^2 x [3 e n (240 c e^2 s^2 cos(omega)^2 - 140 c e^2 s^2 - 112 c e^2 cos(omega)^2 + 40 c e^2 + 144 c eta s^2 - 96
  c eta + 160 c s^2 - 144 c + 540 e^2 s^4 cos(omega)^2 - 315 e^2 s^4 - 632 e^2 s^2 cos(omega)^2 + 280 e^2 s^2 + 112
  e^2 cos(omega)^2 + 360 eta s^4 - 528 eta s^2 + 192 eta + 120 s^4 cos(omega)^2 + 370 s^4 - 112 s^2 cos(omega)^2 -
  768 s^2 + 384)/(128 p^4)]
- J3 x [3 n s (5 c^3 e^2 - 10 c^2 e^2 - 30 c e^2 s^2 + 15 c e^2 - 5 c s^2 + 4 c - 30 e^2 s^2 + 26 e^2 - 5 s^2 + 4)
  sin(omega)/(8 p^3 (c + 1))]
- J4 x [15 e n (56 c e^2 s^2 cos(2 omega) - 84 c e^2 s^2 - 24 c e^2 cos(2 omega) + 48 c e^2 - 56 c s^2 + 32 c + 126
  e^2 s^4 cos(2 omega) - 189 e^2 s^4 - 140 e^2 s^2 cos(2 omega) + 252 e^2 s^2 + 24 e^2 cos(2 omega) - 72 e^2 + 28
  s^4 cos(2 omega) - 196 s^4 - 24 s^2 cos(2 omega) + 248 s^2 - 64)/(128 p^4)]
- J5 x [5 n s (-2646 c^5 e^4 sin(omega) + 441 c^5 e^4 sin(3 omega) - 5670 c^5 e^2 sin(omega) + 189 c^5 e^2 sin(3
  omega) - 504 c^5 sin(omega) - 2268 c^4 e^4 sin(omega) + 378 c^4 e^4 sin(3 omega) - 5166 c^4 e^2 sin(omega) + 189
  c^4 e^2 sin(3 omega) - 504 c^4 sin(omega) + 1512 c^3 e^4 s^2 sin(omega) - 252 c^3 e^4 s^2 sin(3 omega) + 1764 c^3
  e^4 sin(omega) - 490 c^3 e^4 sin(3 omega) + 2016 c^3 e^2 s^2 sin(omega) + 3780 c^3 e^2 sin(omega) - 210 c^3 e^2
  sin(3 omega) + 336 c^3 sin(omega) + 1512 c^2 e^4 sin(omega) - 420 c^2 e^4 sin(3 omega) + 3444 c^2 e^2 sin(omega) -
  210 c^2 e^2 sin(3 omega) + 336 c^2 sin(omega) - 504 c e^4 s^2 sin(omega) + 140 c e^4 s^2 sin(3 omega) - 126 c e^4
  sin(omega) + 49 c e^4 sin(3 omega) - 672 c e^2 s^2 sin(omega) - 270 c e^2 sin(omega) + 21 c e^2 sin(3 omega) - 24
  c sin(omega) - 108 e^4 sin(omega) + 42 e^4 sin(3 omega) - 246 e^2 sin(omega) + 21 e^2 sin(3 omega) - 24
  sin(omega))/(256 p^5 (c + 1))]

**sin i Omega-dot** =
- J2 x [-3 c n s/(2 p^2)]
- J2^2 x [3 c n s (30 e^2 s^2 cos(2 omega) - 5 e^2 s^2 - 14 e^2 cos(2 omega) - 4 e^2 + 36 eta s^2 - 24 eta + 40 s^2
  - 36)/(32 p^4)]
- J3 x [3 c e n (4 - 15 s^2) sin(omega)/(8 p^3)]
- J4 x [15 c n s (14 e^2 s^2 cos(2 omega) - 21 e^2 s^2 - 6 e^2 cos(2 omega) + 12 e^2 - 14 s^2 + 8)/(32 p^4)]
- J5 x [5 c e n (-378 c^4 e^2 sin(omega) + 63 c^4 e^2 sin(3 omega) - 504 c^4 sin(omega) + 1512 c^2 e^2 s^2
  sin(omega) - 252 c^2 e^2 s^2 sin(3 omega) + 252 c^2 e^2 sin(omega) - 70 c^2 e^2 sin(3 omega) + 2016 c^2 s^2
  sin(omega) + 336 c^2 sin(omega) - 504 e^2 s^2 sin(omega) + 140 e^2 s^2 sin(3 omega) - 18 e^2 sin(omega) + 7 e^2
  sin(3 omega) - 672 s^2 sin(omega) - 24 sin(omega))/(256 p^5)]

**lambda-dot - n** =
- J2 x [3 n (-2 c - 3 eta s^2 + 2 eta - 5 s^2 + 4)/(4 p^2)]
- J2^2 x [3 n (960 c e^4 s^2 cos(2 omega) - 160 c e^4 s^2 - 448 c e^4 cos(2 omega) - 128 c e^4 + 1152 c e^2 eta s^2
  - 768 c e^2 eta - 960 c e^2 s^2 cos(2 omega) + 1440 c e^2 s^2 + 448 c e^2 cos(2 omega) - 1024 c e^2 - 1152 c eta
  s^2 + 768 c eta - 1280 c s^2 + 1152 c + 2256 e^4 eta s^4 cos(2 omega) - 27 e^4 eta s^4 cos(4 omega) - 806 e^4 eta
  s^4 - 2016 e^4 eta s^2 cos(2 omega) - 80 e^4 eta s^2 + 368 e^4 eta + 2160 e^4 s^4 cos(2 omega) - 1512 e^4 s^4 -
  2528 e^4 s^2 cos(2 omega) + 1248 e^4 s^2 + 448 e^4 cos(2 omega) - 64 e^4 + 288 e^2 eta s^4 cos(2 omega) + 1312 e^2
  eta s^4 + 448 e^2 eta s^2 cos(2 omega) - 3584 e^2 eta s^2 + 1280 e^2 eta - 1680 e^2 s^4 cos(2 omega) + 6104 e^2
  s^4 + 2080 e^2 s^2 cos(2 omega) - 9376 e^2 s^2 - 448 e^2 cos(2 omega) + 3648 e^2 + 480 eta s^4 cos(2 omega) - 6176
  eta s^4 - 448 eta s^2 cos(2 omega) + 8704 eta s^2 - 3328 eta - 480 s^4 cos(2 omega) - 4592 s^4 + 448 s^2 cos(2
  omega) + 8128 s^2 - 3584)/(1024 p^4 (e^2 - 1))]
- J3 x [-3 e n s (5 c^3 e^2 - 5 c^3 eta - 5 c^3 - 10 c^2 e^2 + 10 c^2 eta + 10 c^2 - 20 c e^2 eta s^2 + 16 c e^2 eta
  - 50 c e^2 s^2 + 31 c e^2 + 55 c eta s^2 - 35 c eta + 50 c s^2 - 31 c - 20 e^2 eta s^2 + 16 e^2 eta - 50 e^2 s^2 +
  42 e^2 + 55 eta s^2 - 46 eta + 50 s^2 - 42) sin(omega)/(8 p^3 (c + 1) (-e^2 + eta + 1))]
- J4 x [15 n (56 c e^2 s^2 cos(2 omega) - 84 c e^2 s^2 - 24 c e^2 cos(2 omega) + 48 c e^2 - 56 c s^2 + 32 c + 70 e^2
  eta s^4 cos(2 omega) - 105 e^2 eta s^4 - 60 e^2 eta s^2 cos(2 omega) + 120 e^2 eta s^2 - 24 e^2 eta + 126 e^2 s^4
  cos(2 omega) - 189 e^2 s^4 - 140 e^2 s^2 cos(2 omega) + 252 e^2 s^2 + 24 e^2 cos(2 omega) - 72 e^2 - 28 eta s^4
  cos(2 omega) + 24 eta s^2 cos(2 omega) + 28 s^4 cos(2 omega) - 196 s^4 - 24 s^2 cos(2 omega) + 248 s^2 - 64)/(128
  p^4)]
- J5 x [5 e n s (2268 c^5 e^4 eta sin(omega) - 378 c^5 e^4 eta sin(3 omega) + 4914 c^5 e^4 sin(omega) - 819 c^5 e^4
  sin(3 omega) - 4032 c^5 e^2 eta sin(omega) + 1008 c^5 e^2 eta sin(3 omega) + 1638 c^5 e^2 sin(omega) + 819 c^5 e^2
  sin(3 omega) - 7056 c^5 eta sin(omega) - 6552 c^5 sin(omega) + 2268 c^4 e^4 eta sin(omega) - 378 c^4 e^4 eta sin(3
  omega) + 4536 c^4 e^4 sin(omega) - 756 c^4 e^4 sin(3 omega) - 3654 c^4 e^2 eta sin(omega) + 945 c^4 e^2 eta sin(3
  omega) + 1512 c^4 e^2 sin(omega) + 756 c^4 e^2 sin(3 omega) - 6552 c^4 eta sin(omega) - 6048 c^4 sin(omega) - 1512
  c^3 e^4 eta sin(omega) + 420 c^3 e^4 eta sin(3 omega) - 1512 c^3 e^4 s^2 sin(omega) + 252 c^3 e^4 s^2 sin(3 omega)
  - 3276 c^3 e^4 sin(omega) + 910 c^3 e^4 sin(3 omega) + 1512 c^3 e^2 eta s^2 sin(omega) - 252 c^3 e^2 eta s^2 sin(3
  omega) + 2688 c^3 e^2 eta sin(omega) - 1120 c^3 e^2 eta sin(3 omega) - 504 c^3 e^2 s^2 sin(omega) - 252 c^3 e^2
  s^2 sin(3 omega) - 1092 c^3 e^2 sin(omega) - 910 c^3 e^2 sin(3 omega) + 2016 c^3 eta s^2 sin(omega) + 4704 c^3 eta
  sin(omega) + 2016 c^3 s^2 sin(omega) + 4368 c^3 sin(omega) - 1512 c^2 e^4 eta sin(omega) + 420 c^2 e^4 eta sin(3
  omega) - 3024 c^2 e^4 sin(omega) + 840 c^2 e^4 sin(3 omega) + 2436 c^2 e^2 eta sin(omega) - 1050 c^2 e^2 eta sin(3
  omega) - 1008 c^2 e^2 sin(omega) - 840 c^2 e^2 sin(3 omega) + 4368 c^2 eta sin(omega) + 4032 c^2 sin(omega) + 108
  c e^4 eta sin(omega) - 42 c e^4 eta sin(3 omega) + 504 c e^4 s^2 sin(omega) - 140 c e^4 s^2 sin(3 omega) + 234 c
  e^4 sin(omega) - 91 c e^4 sin(3 omega) - 504 c e^2 eta s^2 sin(omega) + 140 c e^2 eta s^2 sin(3 omega) - 192 c e^2
  eta sin(omega) + 112 c e^2 eta sin(3 omega) + 168 c e^2 s^2 sin(omega) + 140 c e^2 s^2 sin(3 omega) + 78 c e^2
  sin(omega) + 91 c e^2 sin(3 omega) - 672 c eta s^2 sin(omega) - 336 c eta sin(omega) - 672 c s^2 sin(omega) - 312
  c sin(omega) + 108 e^4 eta sin(omega) - 42 e^4 eta sin(3 omega) + 216 e^4 sin(omega) - 84 e^4 sin(3 omega) - 174
  e^2 eta sin(omega) + 105 e^2 eta sin(3 omega) + 72 e^2 sin(omega) + 84 e^2 sin(3 omega) - 312 eta sin(omega) - 288
  sin(omega))/(256 p^5 (c + 1) (-e^2 + eta + 1))]

These are Brouwer's (1959) secular and long-period terms of the short-period-averaged zonal Hamiltonian through
J5, the J3 and J5 terms in the nonsingular combinations e varpi-dot and sin i Omega-dot (Lyddane 1963).

*[probe 2.2]* Confirmed together with the averaged third-body rates of section 5: their sum reproduces the
library's native rates at 13-15.2 rev/day (drag and SRP off) to 1e-8 to 1e-10 relative (lambda-dot to 6e-13).

**Deep-space always on.** For type 4 there is no 225-minute period switch: the lunar-solar terms of section 5 are
added for every orbit *[doc: release notes 8.0, item 6]*.

**Confirmed.** For drag-free, SRP-free sets the rates of the native elements are reproduced by the vectors of
section 2 *[probe 2.1]*; the zonal part carries no mean-motion rate. 

## 3. Drag: Jacchia-70 and the generic flux model

**Force.** Atmospheric drag on a cannonball with ballistic coefficient B (1.1); its contribution to the mean-element
rates is the orbit average of the Gauss planetary equations under the drag acceleration, evaluated by 13-point
Gauss-Legendre quadrature in true anomaly (section 3.4) *[lit: Gauss equations, Montenbruck & Gill 2000 3.5;
quadrature Abramowitz & Stegun 1964 table 25.4]*. The density is Jacchia (1970) driven by a solar-flux and
geomagnetic model that is a fixed function of date *[doc: release notes 8.0 item 9; lit: Jacchia 1970]*.

### 3.1 Generic flux model (no F10.7 or Ap input)

With d50 the time in days since 1950 January 0.0 UTC (1.2), the solar-cycle clock is
Y = (d50 - 25567) / 365.2425 years from 2019 December 31 0h UTC (the start of solar cycle 25). Y is reduced into
[0, 11) by whole 11-year cycles, counting the cycle index k = 7 for the cycle that starts at the reference, k - 1 per
cycle earlier, k + 1 per cycle later, clamped to k <= 8 (later cycles reuse cycle 8). The cycle phase is
x = Y / 11 in [0, 1).

- Solar flux (10.7 cm, sfu), the same value serving as daily flux F and 81-day mean F-bar:
  F = (A_k x^p_k (1 - x)^q_k + 70) [(1 + 0.01671 cos(2 pi frac(Y))) / 0.999721]^2,
  frac(Y) the fractional part of Y (the annual 1/r^2 factor with e = 0.01671, normalized by 0.999721).
- Geomagnetic index: Ap = 27.6558 x^0.93682 (1 - x)^0.92198 + 8.
- Cycle coefficients (values compiled into the library; the k = 6 cycle peaks near F = 137 sfu, k = 1 near 246 sfu,
  matching solar cycles 24 and 19):

| k | cycle starts (about) | A_k | p_k | q_k |
| --- | --- | --- | --- | --- |
| 0 | 1942.9 | 3941.23 | 2.10492 | 2.85759 |
| 1 | 1953.9 | 45065.1 | 3.20864 | 5.10803 |
| 2 | 1964.9 | 1125.51 | 1.51623 | 2.34156 |
| 3 | 1975.9 | 11732.2 | 2.81733 | 3.66706 |
| 4 | 1986.9 | 11696.1 | 2.15674 | 5.01571 |
| 5 | 1997.9 | 1367.0 | 1.11698 | 3.21707 |
| 6 | 2008.9 | 8881.53 | 3.06443 | 4.09606 |
| 7 | 2019.9 | 3213.79 | 2.18364 | 3.29520 |
| 8 | 2030.9 and later | 5106.98 | 2.10492 | 3.67530 |

Domain: for d50 < 2192 (before 1956 January 1) the day of year used by the semiannual and seasonal-latitudinal
terms is held at 1.0 of 1956 (N = 366); the cycle index k stays at 0 back to 1942.9 and is undefined before it, so
the model's domain begins at 1942.9 (the release notes say the fit reaches back to 1947) *[study]*.

### 3.2 Exospheric temperature

Jacchia 1970 with the constants below (SR 313 form; R, m, n, beta, p, gamma as named there):

- Night-time minimum: T_c = 383 + 1.80 F + 1.52 F-bar (equivalently 383 + 3.32 F-bar + 1.80 (F - F-bar)).
- Diurnal: T_l = T_c [1 + 0.31 (S + (C - S) cos^3(tau / 2))], S = sin^2.5(|phi + delta_sun| / 2),
  C = cos^2.5(|phi - delta_sun| / 2), tau = H - 37 deg + 6 deg sin(H + 43 deg), phi the geodetic latitude,
  delta_sun the Sun's declination, H the Sun-relative hour angle of the point, tau wrapped to (-pi, pi].
- Semiannual: with D = day of year minus 1 (fractional) and N the days in that year,
  tau_SA = D/N + 0.1145 ([(1 + sin(2 pi D/N + 342.3 deg)) / 2]^2.16 - 1/2),
  Delta T_SA = F-bar (0.349 + 0.206 sin(2 pi tau_SA + 226.5 deg)) sin(4 pi tau_SA + 247.6 deg).
- Geomagnetic: Delta T_G = Ap + 100 (1 - exp(-0.08 Ap)).
- T_inf = T_l + Delta T_SA + Delta T_G + 2.41, clamped to [600, 2000] K.

### 3.3 Density

The density is log10 rho(h, T_inf) (rho in g/cm^3) on a fixed grid, bilinear in (T_inf, h), plus one additive term
*[study; probe 3.5]*:

- **Temperature nodes**: T_c = 600 + 50 (c - 1) K, c = 1..29 (600 to 2000 K). T_inf is clamped to [600, 2000] K;
  for T_c-1 <= T_inf < T_c the value is linear in T_inf with weight (T_inf - T_c-1)/50.
- **Height nodes** (km), H_1..H_111: 10 to 90 every 5 (17 nodes), 92 to 110 every 2 (10), 115 to 160 every 5 (10),
  170 to 400 every 10 (24), 420 to 1000 every 20 (30), 1050 to 1500 every 50 (10), 1600 to 2500 every 100 (10).
- **Height interval**: for the geodetic height h, with the band (B, S, I) = (0, 1000, 1) for h < 10 km, (10, 5, 2)
  for 10 <= h < 90, (90, 2, 18) for 90 <= h < 110, (110, 5, 28) for 110 <= h < 160, (160, 10, 38) for
  160 <= h < 400, (400, 20, 62) for 400 <= h < 1000, (1000, 50, 92) for 1000 <= h < 1500 and (1500, 100, 102) for
  h >= 1500, the upper node is r = min(111, floor((h - B)/S + I + 1e-5)); log10 rho is linear in h between
  H_r-1 and H_r.
- **Below 10 km and above 2500 km** *[study; probe 3.14]*: for a geodetic height below 10 km, negative heights
  included, rho is the 10 km node value at every T_inf (0.41351 kg/m^3): the lowest interval is not
  interpolated. Above 2500 km, rho = 1e-20 kg/m^3. Both reach the rates: drag
  nodes down to -10 km at the epoch give the library's n-dot to 1e-13 with this rule, and above 2500 km the drag
  part of n-dot is linear in B and nonzero (MEO at 20,200 km: 5.5e-14 rev/day^2 for B = 0.01).
- **Node values, 10-85 km** (observed behavior): log10 (g/cm^3) of the U.S. Standard Atmosphere 1976 density at
  the geometric height, the density as the 1976 tables print it (five significant digits) and its logarithm kept to
  nine decimals, independent of T_inf; for example 0.41351 kg/m^3 at 10 km gives -3.383513983 *[lit: U.S. Standard
  Atmosphere 1976; study: all 16 nodes follow this to 5e-10, while the model's own unrounded densities differ by up
  to 1e-5 in the logarithm; probe 6.9: side B's fit of the decaying sets with perigees at 66-71 km finds these
  logarithms (offsets of -0.087 to +0.201 thousandths from the three-decimal values; rates to 2.8e-8 instead of
  4.1e-4)]*.
- **Node values, 90 km**: log10 3.46e-9 = -8.461 at every T_inf, Jacchia's 1970 boundary density (SR 313).
- **Node values, 90-2500 km: the printed table of SR 313** *[study; probe 3.7]*. The 90-2500 km part of the table is
  Jacchia's printed "Summary of log densities", Table 6 of SAO Special Report 313 (Jacchia 1970, pp. 82-87): decimal
  logarithms of the density (g/cm^3) to three decimals for exospheric temperatures 600 to 2000 K every 50 K
  (pp. 82-83: 600-1050 K; pp. 84-85: 1100-1550 K; pp. 86-87: 1600-2000 K; the first page of each pair 90-400 km, the
  second 420-2500 km), on exactly the heights of the grid above. Table 5 of the same report (pp. 52-81) gives the
  full models every 100 K, and its log-density column agrees with Table 6. The printed table is the regeneration
  recipe: side B transcribes Table 6 from the report (open literature); recomputing Jacchia's models does not
  reproduce it to its last digit (a numerical evaluation with the 1971 constants misses by up to 0.13 dex above
  130 km), so it should not be recomputed. Compared entry by entry over a sample (whole rows at 130, 200, 250 and
  420 km, and the 90-290 km block at 600-1050 K), the library's values equal the printed ones except isolated
  entries that are one unit higher in the third decimal, all of them printed with a final zero; they shift the
  density there by 0.23 %. The 3.7 row vectors detect them black-box: with rows transcribed from Table 6, the
  3.7 rates are reproduced exactly (to 1e-9) wherever a row has no such entry, and to 4e-5 to 2e-4 relative at the
  solar-minimum dates where the probe samples one. *[probe 3.9]* The 3.9 vectors pin the rows from 90 to 840 km at
  2026 days 282.5 and 292.5, with the node right ascension at 0, 90, 180 and 270 deg: equatorial near-circular orbits
  whose 13 nodes all sit on one table height, so each n-dot depends only on that row's cells at the nodes'
  exospheric temperatures (900 to 1200 K on those dates), entering with weights that change with the right
  ascension. Of the 37 cells side B lists that are printed with a final zero, the vectors show the library one unit
  higher in the third decimal only at 160 km, 1100 K: the printed entry misses the 160 km vectors by 3e-4 to 5e-4,
  the entry one unit higher reproduces them to 6e-8.
- **Row probes per cell** *[probe 3.11]*: one vector for each of the 379 table cells that side B's heavy-drag sets
  use (90 to 840 km, 900 to 1200 K): an equatorial near-circular orbit on that height, on the 2026 date (days 250.5
  to 330.5) and at the node right ascension (every 30 deg) where its n-dot depends most on that cell. Each vector
  records that dependence, the relative n-dot change that a change of 0.001 in the one entry causes (3.7e-5 to
  9.0e-4, median 5.5e-4). The library's entries reproduce all 379 to 2.3e-7, so an entry held 0.001 away from the
  printed value shows as a miss of about the recorded size. Of the 37 cells side B marks as printed with a final
  zero, only 160 km, 1100 K is held away (next item).
- **Observed behavior, 160 km and 1100 K** *[probe 3.9, 3.10, 3.11]*: the library's entry is one unit above the
  printed Table 6 value in the third decimal. With that entry the 28 vectors on the 160 km row (3.9, and 3.10 at 2026 days
  250.5 to 330.5 with the node right ascension every 90 deg) are reproduced to 7e-8; with the printed value they are
  missed by 1.7e-4 to 5e-4.
- **Observed behavior, further entries** *[probe 3.12]*: 39 more row probes of the 3.11 kind (24 cells of side B's
  refreshed heavy-drag list and its 16 remaining override cells, at the year, date and node right ascension where each
  cell weighs most; recorded weight 9.2e-5 to 8.9e-4). The library's entry is one unit above the printed value in the
  third decimal at 92 km (650, 700, 750 and 800 K), 94 km (700 K), 125 km (850 K), 130 km (650 K), 320 km (1250 K),
  330 km (1350 K), 360 km (800 K), 370 km (750 K), 380 km (750 and 850 K), 500 km (700 K) and 740 km (900 K), and one
  unit below it at 1600 km (700 K); every other probed cell equals the printed value. A row whose vectors disagree with Table 6 elsewhere points at
  another such cell.
- **Seasonal-latitudinal term**, for 90 < h < 300 km only: Delta log10 rho = (1/50) (h - 90) exp(-0.045 (h - 90))
  sin(2 pi (D + 100) / N) cos^2(phi), negated when the geodetic latitude phi of the point (3.4) is negative
  (phi = 0, of either sign of zero, counts as north), D the day of year minus 1, N the days in the year.
- **Units**: rho (kg/m^3) = 10^(log10 rho + Delta log10 rho + 3).

### 3.4 Drag rates and orbit averaging

All quantities in R_E and minutes unless stated; n, a, e, i, Omega, omega the mean elements at the evaluation time,
eta = sqrt(1 - e^2), p = a eta^2, theta = cos i, omega_E = 4.37526908801129966e-3 rad/min, eps^2 = f (2 - f) with
the flattening f of 1.3, B the ballistic coefficient (m^2/kg) *[study; probe 3.5, 3.6]*.

**Arc.** With h_p = R_E [a (1 - e) - 1 + f sin^2 i sin^2 omega] (km) and b = min(900, max(90, h_p)), the band above
perigee is Delta = b (c1 + b (c2 + b (c3 + b (c4 + b (c5 + b (c6 + b c7)))))) km, c1 = -3.130124,
c2 = 0.061710434, c3 = -3.4111266e-4, c4 = 8.7321429e-7, c5 = -1.122534e-9, c6 = 7.1123451e-13,
c7 = -1.776575e-16. If Delta/R_E < 2 a e, nu_c = arccos[(r_p e - Delta/R_E) / (e (r_p + Delta/R_E))],
r_p = a (1 - e); otherwise nu_c = pi.

**Nodes.** nu_j = nu_c x_j, j = 1..13, with the Gauss-Legendre nodes x_j and weights w_j (Abramowitz & Stegun 1964,
table 25.4): x = 0, +/-0.23045831595513480, +/-0.44849275103644692, +/-0.64234933944034023,
+/-0.80157809073330988, +/-0.91759839922297803, +/-0.98418305471858814; w = 0.23255155323087390,
0.22628318026289720, 0.20781604753688851, 0.17814598076194571, 0.13887351021978719, 0.092121499837728452,
0.040484004765315877. At each node, u = omega + nu, D = 1 + e cos nu, and:

- omega (like Omega and M) is the current mean element recovered from the equinoctial set, omega = atan2(a_g, a_f)
  minus atan2(chi, psi), then reduced to [0, 2 pi): an angle beyond 2 pi in magnitude is first reduced modulo 2 pi,
  and a negative one has 2 pi added; u = omega + nu in double precision. With argp = 0 at the epoch (a_f = e
  cos(omega_0 + Omega_0), a_g = e sin(omega_0 + Omega_0), chi = tan(i_0 / 2) sin Omega_0, psi = tan(i_0 / 2) cos
  Omega_0, the angles the element set's degrees times pi / 180) the central node (nu = 0) lies on the equator only
  to rounding: the two arctangents differ by zero or a few units in the last place, and a negative difference
  becomes 2 pi in double precision (6.283185307179586, or one unit lower), whose sine is negative (-2.449e-16). That
  node then counts as southern in the seasonal-latitudinal term (3.3); a zero or positive difference makes it
  northern *[study; probe 3.5, 3.8: all 84 equator-node cases follow this, 15 of them southern]*.
- radius, mean orbit plus the J2 short-period radius of section 8: r = p/D + c [(1 - theta^2) cos 2u
  - (3 theta^2 - 1)(e cos nu/(1 + eta) + 2 eta/D + 1)], c = J2/(4p);
- geocentric latitude phi' = arcsin(sin i sin u); with N = eps^2 sin phi' cos phi', n0 = 1 - eps^2 cos^2 phi',
  W0 = sqrt(1 - eps^2 sin^2 phi'): t1 = N / (n0 + W0 (r - W0)), phi1 = phi' + arctan t1,
  W1 = sqrt(1 - eps^2 sin^2 phi1);
- geodetic height h = R_E [r / sqrt(1 + t1^2) - W1] (km) and geodetic latitude phi = phi' + arctan(N / (n0 + W1 h/R_E));
- Sun-relative hour angle H = alpha - alpha_sun reduced to [0, 2 pi), alpha the right ascension of the direction
  (cos Omega cos u - sin Omega sin u theta, sin Omega cos u + cos Omega sin u theta), alpha_sun and delta_sun from the
  Sun of section 5 at the evaluation time;
- density rho (kg/m^3) from 3.1-3.3 at (h, T_inf), the diurnal term using the GEOCENTRIC latitude phi' with
  delta_sun and H, the seasonal-latitudinal term using the GEODETIC latitude phi (below 10 km and above 2500 km
  as in 3.3);
- speed factor V = sqrt(1 + 2 e cos nu + e^2 - 2 q theta + q^2 cos^2 phi' / D^2), q = omega_E eta^3 / n, which is
  eta |v - omega_E x r| / (n a) (atmosphere co-rotating with the Earth);
- weight K = w_j rho V / D^2.

**Sums** over the 13 nodes: G = sum K, S_D = sum K D, S_e = sum K (e + cos nu), S_su = sum K sin u cos u / D^2,
S_n = sum K sin nu / D, S_nc = sum K sin nu cos nu / D^2, S_uu = sum K cos^2 u / D^2,
S_s = sum K sin nu (1 - q theta / D^2), S_w = sum K (D cos nu + e + cos nu) / D^2.

**Rates** (rad/min; same six as sections 2 and 5): with P = 500 R_E nu_c / pi (R_E in km; P = (R_E in m)
nu_c / (2 pi)), A_r = eta^2 n a / 2, oa = q theta:

- n-dot = P B 3 n (n a / 2) [S_D + e S_e - oa G];
- e-dot = P B A_r [oa S_w - 2 S_e];
- i-dot = -P B sin i q A_r S_uu;
- Omega-dot = -P B q A_r S_su, so the component of section 2 is sin i Omega-dot = -P B q A_r sin i S_su;
- e varpi-dot = P B [e (oa - q) A_r S_su + e oa A_r S_nc - 2 A_r S_s];
- lambda-dot - n = P B [(oa - q) A_r S_su + 2 eta e A_r S_n + (1 - eta) oa A_r S_nc - (2 e A_r / (1 + eta)) S_s].

Since oa - q = -q (1 - cos i), the S_su parts of e varpi-dot and lambda-dot - n are e (1 - cos i) Omega-dot and
(1 - cos i) Omega-dot *[probe 3.13, 6.9, 8.5; side B's fit at 580 of the library's hourly states
along the 3.13 sets gives every coefficient as 1.00000. At 290 library states along the ten 3.13 sets these
equations, with the zonal and third-body rates, reproduce the library's six rates to 2e-7 relative in a_f, chi,
psi and lambda-dot - n and to 2e-5 in a_g (whose rate passes near zero), against 1e-2 to 6e-5 with sin i Omega-dot
for Omega-dot and oa for oa - q; with resonance and SRP added they reproduce the epoch rates of the decaying
0.5-day sets of 6.9 and 8.5 to 1e-8 in every component]*.

For a circular orbit with the atmosphere at rest this is n-dot = (3/2) n rho B v, the drag acceleration
-(1/2) rho B |v_rel| v_rel with B = C_D A/m: no factor 1/2 is folded into B.

*[probe 3.5]* Confirmed: these equations, with the density of 3.1-3.3, reproduce the library's drag rates on the
3.5 cases to 1e-9 (worst 4e-6) relative.

**Sizes of the formulation elements** (log10 of the library's drag n-dot over a variant, 2024 day 100.5; first
value circular at i = 51.6 deg, second e = 0.05 at i = 0.1 deg) *[study; probe 3.6]*:

| element removed | 200 km | 400 km | 600 km | 1000 km |
| --- | --- | --- | --- | --- |
| geodetic height (spherical instead) | -0.080 / 0.000 | -0.044 / 0.000 | -0.034 / 0.000 | -0.013 / 0.000 |
| J2 radius at the nodes (mean radius instead) | +0.008 / +0.107 | +0.005 / +0.058 | +0.004 / +0.046 | +0.001 / +0.019 |
| co-rotation (V without q) | -0.034 / -0.054 | -0.035 / -0.057 | -0.037 / -0.060 | -0.040 / -0.066 |
| perigee arc (full orbit instead) | 0.000 / -0.022 | 0.000 / -0.005 | 0.000 / 0.000 | 0.000 / 0.000 |
| hour angle H shifted by pi | 0.000 / +0.099 | +0.003 / +0.345 | +0.006 / +0.518 | +0.005 / +0.251 |
| hour angle sign flipped (-H) | +0.002 / +0.023 | +0.018 / +0.078 | +0.041 / +0.113 | +0.038 / +0.069 |
| geodetic instead of geocentric latitude in the diurnal term | 0.000 / 0.000 | 0.000 / 0.000 | 0.000 / 0.000 | 0.000 / 0.000 |
| seasonal-latitudinal term | -0.001 / -0.002 | 0.000 / 0.000 | 0.000 / 0.000 | 0.000 / 0.000 |

A positive entry means the variant gives less drag than the library. Circular orbits average the diurnal bulge over
local time; eccentric orbits sample it at the perigee's local time, so the hour-angle convention shows there. The section-3.6 vectors separate these
elements black-box: inclination 0.1-179.9 deg at a 300 km circular perigee (co-rotation and latitude), perigee
latitude 0-90 deg at i = 90 deg and e = 0.05 (oblate height), and e = 0.0001-0.2 at a 300 km perigee (arc and the
J2 radius), each as the B = 0.01 minus B = 0 n rate.

**Confirmed.** *[probe 3.1]* Drag changes the mean motion secularly and depends on the date through the flux model:
for a circular orbit at inclination 51.6 deg, B = 0.01 m^2/kg, the n-dot (rev/day^2) and the effective density
rho_eff = (2/3) (n-dot / n) / (B v) (circular-orbit relation, v the circular speed) are:

| altitude (km) | rho_eff 2009-04-10 (kg/m^3) | rho_eff 2024-04-09 (kg/m^3) |
| --- | --- | --- |
| 300 | 8.29e-12 | 2.50e-11 |
| 400 | 8.35e-13 | 4.23e-12 |
| 500 | 1.12e-13 | 9.12e-13 |
| 600 | 2.12e-14 | 2.27e-13 |
| 800 | 3.27e-15 | 2.16e-14 |

The 2024/2009 ratio follows 3.1 (cycle 25 near maximum against the cycle-24 minimum).

*[probe 3.5]* The density check vectors: the drag part of the n rate (rev/day^2, B = 0.02 and 0.01 minus B = 0)
at epoch for perigee heights 200-1200 km, six dates across solar cycles 22-25 (flux and Ap of 3.1), e = 0.0001 to
0.1 and i = 0.1 to 97.5 deg (360 cases); the matching semi-major-axis rate is a-dot = -(2/3) a n-dot / n. The drag
part is exactly linear in B (ratio 2 to 1e-6), positive, and falls with perigee height at every date, so B enters
only as a factor and the vectors pin rho through the averaged Gauss equations.

*[probe 3.2]* The atmosphere co-rotates with the Earth and the drag is quadratic in the relative speed: at 400 km
the retrograde/prograde equatorial n-dot ratio is 1.2945 against ((v + omega_E r) / (v - omega_E r))^2 = 1.2946,
so the acceleration is -(1/2) rho B |v_rel| v_rel with v_rel = v - omega_E x r and B = C_D A/m (3.4).

*[probe 3.13]* Along 7 days of the ten heavy-drag sets side B lists as worst (15.0 to 15.8 rev/day, e up to 0.02,
perigees near 200 km; AGOM 0), the drag rates of this section with the library's entries reproduce the library's
n-dot, which is the drag alone there, at every hour to 1.4e-9 relative.

## 4. Solar radiation pressure and shadow

**Force.** Cannonball SRP: acceleration magnitude P AGOM, directed away from the Sun, zero in the Earth's shadow,
with P = 4.5e-6 N/m^2 *[study; probe 4.1]* and AGOM from the element set (1.1, so AGOM carries C_R). The value is
scaled to Earth radii and minutes (x 3600 s^2/min^2, / 1000 R_E m) *[study]* and by (1 AU / r_sun)^2, AU =
149597870 km *[probe 4.2: the GEO SRP e-vector rate at perihelion over aphelion is 1.0695, the inverse-square
ratio]*.

**Shadow** (Escobal 1965, 5.3, cylindrical shadow of radius R_E) *[study; probe 4.4, 4.7]*. On the current mean orbit,
with A, B the Sun's unit vector on P, Q (5.4), p = a (1 - e^2) in R_E, x = cos nu and n(nu) = A cos nu + B sin nu,
the boundary function is S(nu) = p^2 n^2 + (1 + e cos nu)^2 - p^2: the satellite is in shadow where n < 0 and S > 0.
Eliminating sin nu gives the quartic in x
K(x)^2 - 4 A^2 B^2 x^2 (1 - x^2) = 0, K(x) = (B^2 - A^2) x^2 + (1 - B^2) - (1 + e x)^2 / p^2.
The library solves it in closed form and then keeps only the roots that pass a boundary test of 1e-12. Its roots
carry rounding errors well above that test at many geometries, so which shadows it finds depends on the exact
sequence below. Every quantity is a double-precision number; sums and products are evaluated from left to right
as written, parentheses first; pow is the general power function, sqrt the square root, atan2(y, x) the
two-argument arctangent, and cbrt(x) = sign(x) |pow(|x|, 1/3)| with 1/3 the double 0.3333333333333333. The
elements are the current mean elements recovered from the equinoctial set: a = pow(k_e / n, 2/3) with 2/3 the double
0.6666666666666666, e = sqrt(a_f a_f + a_g a_g), i = t + t with t = atan(sqrt(chi chi + psi psi)),
Omega = atan2(chi, psi) and omega = atan2(a_g, a_f) - Omega, both reduced to [0, 2 pi) as in step 7 (3.4); the Sun
is that of section 5 at the evaluation time.

1. Direction cosines, with cw = cos omega, sw = sin omega, cO = cos Omega, sO = sin Omega, ci = cos i, si = sin i
   and the Sun's unit vector (s_x, s_y, s_z):
   B = (cw si) s_z + s_x ((cO (-sw)) - ci (cw sO)) + s_y (ci (cw cO) - sO sw),
   A = (sw si) s_z + s_x ((cw cO) - ci (sO sw)) + s_y ((cw sO) + (ci sw) cO).
2. Quartic coefficients, with G = B^2, H = A^2, F = G + H, e2 = e e, p = (1 - e2) a, j = (1/p)(1/p), h = j j,
   k = G - H, g = 1 - G and m = j (-2):
   c4 = (F F + (h e2) e2) + e2 (k m),
   c3 = (e e2)(4 h) + (e (-4 j)) k,
   c2 = (((H (-4)) G + (k + k) g) + (g m) e2) + (6 h) e2 + k m,
   c1 = (4 h) e + (e (-4 j)) g,
   c0 = ((g m + h) + g g).
   If c4 = 0 there is no boundary.
3. Monic and depressed: a3 = c3/c4, a2 = c2/c4, a1 = c1/c4, a0 = c0/c4, f = a3 (-0.25), f2 = f f,
   f3 = pow(f, 3), f4 = pow(f, 4), b3 = 3 a3:
   P = (a2 + 6 f2) + b3 f,
   Q = ((a1 + (a2 + a2) f) + 4 f3) + b3 f2,
   W = (((((a0 + a1 f) + a2 f2) + f4) + a3 f3) (-4)) + P P.
4. Depressed resolvent cubic t^3 + s1 t + s3 = 0:
   s3 = (((Q Q)(-27) + pow(P, 3) 16) + (P (-18)) W) / 27,  s1 = (3 W + (P P)(-4)) / 3,
   D = (s3 s3) 0.25 + pow(s1, 3) / 27, and its roots:
   - D > 0: t1 = cbrt(s3 (-0.5) + sqrt(D)) + cbrt(s3 (-0.5) - sqrt(D)), and t2 = t3 = 0 (zeros stand in for the
     complex pair);
   - D = 0: t1 = 2 cbrt(s3 (-0.5)), t2 = t3 = cbrt(s3 0.5);
   - D < 0: w = sqrt(pow(-s1, 3) / 27), c = -s3 / (w + w), phi = atan2(sqrt(1 - c c), c) / 3,
     u = 2 sqrt(s1 / (-3)): t1 = u cos phi, t2 = u cos(phi + 2 pi/3), t3 = u cos(phi + 4 pi/3), the two angles
     added as the doubles 2.0943951023931953 and 4.1887902047863905;
   - otherwise (D not a number): t1 = t2 = t3 = 0.
5. Resolvent root: z_k = (P (-2)) / 3 + t_k; z is z_2 if z_2 > z_3, else z_3; then z_1 if z_1 > z, else z. If
   z < 0 there is no boundary.
6. Quadratic factors, with r = sqrt(z) and q = Q / r:
   D1 = ((((P + z) - q) 0.5) (-4)) + z and D2 = ((((P + z) + q) 0.5) (-4)) + z.
   Where D1 is not negative it gives y = (sqrt(D1) - r) 0.5 and y = (-r - sqrt(D1)) 0.5; where D2 is not negative
   it gives y = (r + sqrt(D2)) 0.5 and y = (r - sqrt(D2)) 0.5, in this order. Each gives x = f + y and the true
   anomaly nu = arccos x; an x outside [-1, 1] gives no candidate.
7. Candidates, in this order: the (up to) four nu, then 2 pi - nu for each of them in the same order (2 pi the double
   6.283185307179586; every angle reduced to [0, 2 pi): an angle beyond 2 pi in magnitude is first reduced modulo
   2 pi, a negative one has 2 pi added). For each: n = A cos nu + B sin nu, d = e cos nu + 1,
   S = ((p p) n) n + d d - p p, and dS/dnu = ((e d)(-2)) sin nu + ((-A) sin nu + B cos nu)(p p)(n + n). The candidate
   is a boundary when n < 0 and |S| < 1e-12: an entry when dS/dnu > 0, otherwise an exit. Entry and exit anomalies
   start at 0; each of the first two boundaries found sets one of them, and later boundaries are ignored. With fewer
   than two boundaries the orbit counts as wholly sunlit.
8. Eccentric anomalies: E = 2 atan(tan(nu/2) k), k = sqrt((1 - e)/(e + 1)), reduced to [0, 2 pi); E_1 at the exit,
   E_2 at the entry, E_2 + 2 pi when E_2 < E_1; the sunlit arc runs from E_1 to E_2. If |E_2 - E_1| < 1e-12 the
   wholly sunlit formulas apply.

The 1e-12 test is tight against the rounding of this sequence. At GEO (p^2 near 44) its roots usually miss the test,
so the GEO eclipse season is averaged as wholly sunlit, while LEO, MEO and HEO shadows are mostly found *[study;
probe 4.4]*. At high eccentricities the misses are frequent too *[probe 4.7]*: hourly along 7 days of seven of side
B's listed sets (e = 0.70 to 0.73 in the 0.5-day band, and two MEO sets), the library averages 35, 19, 47 and 30 of
the 169 evaluations of four HEO sets as wholly sunlit although the orbit crosses the shadow, and 5 of one MEO set.
The sequence above reproduces the library's decision at 1,179 of the 1,183 evaluations, every miss included. The
other four are rounding-limited: a root near nu = 0 or 2 pi, where arccos magnifies the last bits of x, with |S|
within a factor of three of 1e-12. Two of the listed sets, with e = 0.70 at 2.21 rev/day and with e = 0.016 at 5.43
rev/day, show no misses at all, but 6 and 17 of their 169 evaluations have such a rounding-limited candidate; there
the decision depends on the last bits of the arithmetic (operation order, fused multiply-adds, the elementary
functions), which no specification of the mathematics can fix. The 9.9 and 9.1.1.0 versions differ in this test
in the same way (section 11).

**Rounding-limited decisions** *[study; probe 4.9, 4.10]*. The 9.9 build evaluates parts of this sequence with fused
multiply-adds, and near the 1e-12 test its decision follows from that arithmetic. A decision is rounding-limited
when (a) some candidate with n < 0 has 1e-13 <= |S| <= 1e-11 in the sequence above, or (b) moving each input of the
sequence (a, e, i, Omega, omega and the three components of the Sun direction) by up to 8 units in the last place
changes the decision. Both outcomes of a rounding-limited decision conform. This applies to every rate
evaluation, the node and stage evaluations of the integrator (9) included, and not only to output times. On the
720 geometries of 4.9 the sequence takes the library's decision at 575; all 145 others are rounding-limited (136 by
(a) alone), and 566 of the 720 are rounding-limited in all, the near-circular GEO sets in the eclipse season nearly
always.

**Averaged rates** *[study; probe 4.4]*. With F_s = 4.5e-6 AGOM 3600 / (1000 R_E (r_sun/AU)^2) (R_E/min^2), a in
R_E, n in rad/min, eta = sqrt(1 - e^2) and A, B, C on P, Q, W, the SRP contributions to the equinoctial rates
(rad/min; lambda-dot, n-dot in rad/min^2, chi-dot, psi-dot, a_f-dot, a_g-dot), added to the other rates after their
conversion to equinoctial form:

**Wholly sunlit orbit:**

- lambda-dot = F_s ( A [-3 e (2 e^2 - 3 eta - 2)/(2 a n (e^2 - eta - 1))] + C [-3 e (eta + 1) sin(i) sin(omega)/(2 a
  n (cos(i) + 1) (e^2 - eta - 1))] )
- n-dot = 0
- chi-dot = F_s ( C [3 e sin(Omega + omega)/(2 a eta n (cos(i) + 1))] )
- psi-dot = F_s ( C [3 e cos(Omega + omega)/(2 a eta n (cos(i) + 1))] )
- a_f-dot = F_s ( A [-3 eta sin(Omega + omega)/(2 a n)] + B [-3 eta cos(Omega + omega)/(2 a n)] + C [-3 e^2 sin(i)
  sin(omega) sin(Omega + omega)/(2 a eta n (cos(i) + 1))] )
- a_g-dot = F_s ( A [3 eta cos(Omega + omega)/(2 a n)] + B [-3 eta sin(Omega + omega)/(2 a n)] + C [3 e^2 sin(i)
  sin(omega) cos(Omega + omega)/(2 a eta n (cos(i) + 1))] )

**Sunlit arc from E_1 to E_2:**

- lambda-dot = F_s ( A [-(-12 E_1 e^3 + 18 E_1 e eta + 12 E_1 e + 12 E_2 e^3 - 18 E_2 e eta - 12 E_2 e + 4 e^4
  sin(E_1) - 4 e^4 sin(E_2) - 6 e^3 sin(2E_1) + 6 e^3 sin(2E_2) - 8 e^2 eta sin(E_1) + 8 e^2 eta sin(E_2) + 16 e^2
  sin(E_1) - 16 e^2 sin(E_2) + 5 e eta sin(2E_1) - 5 e eta sin(2E_2) + 6 e sin(2E_1) - 6 e sin(2E_2) - 20 eta
  sin(E_1) + 20 eta sin(E_2) - 20 sin(E_1) + 20 sin(E_2))/(8 pi a n (e^2 - eta - 1))] + B [(5 e^3 eta sin(E_1)^2 - 5
  e^3 eta sin(E_2)^2 + 5 e^3 sin(E_1)^2 - 5 e^3 sin(E_2)^2 + 8 e^2 eta cos(E_1) - 8 e^2 eta cos(E_2) + 10 e^2
  cos(E_1) - 10 e^2 cos(E_2) - 6 e eta sin(E_1)^2 + 6 e eta sin(E_2)^2 - 5 e sin(E_1)^2 + 5 e sin(E_2)^2 - 10 eta
  cos(E_1) + 10 eta cos(E_2) - 10 cos(E_1) + 10 cos(E_2))/(4 pi a n (e^2 - eta - 1))] + C [-(-3 E_1 e eta sin(omega)
  - 3 E_1 e sin(omega) + 3 E_2 e eta sin(omega) + 3 E_2 e sin(omega) + e^3 sin(E_1)^2 cos(omega) - e^3 sin(E_2)^2
  cos(omega) + 2 e^2 eta sin(E_1) sin(omega) - 2 e^2 eta sin(E_2) sin(omega) + 2 e^2 cos(E_1 - omega) - 2 e^2
  cos(E_2 - omega) - e eta sin(E_1) sin(E_1 + omega) + e eta sin(E_2) sin(E_2 + omega) - e sin(E_1) sin(E_1 + omega)
  + e sin(E_2) sin(E_2 + omega) - 2 eta cos(E_1 + omega) + 2 eta cos(E_2 + omega) - 2 cos(E_1 + omega) + 2 cos(E_2 +
  omega)) sin(i)/(4 pi a n (cos(i) + 1) (e^2 - eta - 1))] )
- n-dot = F_s ( A [-3 (cos(E_1) - cos(E_2))/(2 pi a)] + B [-3 eta (sin(E_1) - sin(E_2))/(2 pi a)] )
- chi-dot = F_s ( C [(-12 E_1 e sin(Omega + omega) + 12 E_2 e sin(Omega + omega) + 8 e^2 sin(E_1) sin(Omega + omega)
  - 8 e^2 sin(E_2) sin(Omega + omega) - 4 e eta sin(E_1)^2 cos(Omega + omega) + 4 e eta sin(E_2)^2 cos(Omega +
  omega) - e cos(-2 E_1 + Omega + omega) + e cos(2 E_1 + Omega + omega) + e cos(-2 E_2 + Omega + omega) - e cos(2
  E_2 + Omega + omega) - 8 eta cos(E_1) cos(Omega + omega) + 8 eta cos(E_2) cos(Omega + omega) + 8 sin(E_1)
  sin(Omega + omega) - 8 sin(E_2) sin(Omega + omega))/(16 pi a eta n (cos(i) + 1))] )
- psi-dot = F_s ( C [(-12 E_1 e cos(Omega + omega) + 12 E_2 e cos(Omega + omega) + 8 e^2 sin(E_1) cos(Omega + omega)
  - 8 e^2 sin(E_2) cos(Omega + omega) + 4 e eta sin(E_1)^2 sin(Omega + omega) - 4 e eta sin(E_2)^2 sin(Omega +
  omega) + e sin(-2 E_1 + Omega + omega) - e sin(2 E_1 + Omega + omega) - e sin(-2 E_2 + Omega + omega) + e sin(2
  E_2 + Omega + omega) + 8 eta sin(Omega + omega) cos(E_1) - 8 eta sin(Omega + omega) cos(E_2) + 8 sin(E_1)
  cos(Omega + omega) - 8 sin(E_2) cos(Omega + omega))/(16 pi a eta n (cos(i) + 1))] )
- a_f-dot = F_s ( A [(e - 1) (e + 1) (-6 E_1 sin(Omega + omega) + 6 E_2 sin(Omega + omega) + 2 e cos(-E_1 + Omega +
  omega) - 2 e cos(E_1 + Omega + omega) - 2 e cos(-E_2 + Omega + omega) + 2 e cos(E_2 + Omega + omega) - cos(2 E_1 +
  Omega + omega) + cos(2 E_2 + Omega + omega))/(8 pi a eta n)] + B [-(12 E_1 e^2 cos(Omega + omega) - 12 E_1
  cos(Omega + omega) - 12 E_2 e^2 cos(Omega + omega) + 12 E_2 cos(Omega + omega) + 8 e^3 sin(-E_1 + Omega + omega) -
  8 e^3 sin(E_1 + Omega + omega) - 8 e^3 sin(-E_2 + Omega + omega) + 8 e^3 sin(E_2 + Omega + omega) - e^2 sin(-2 E_1
  + Omega + omega) + e^2 sin(2 E_1 + Omega + omega) + e^2 sin(-2 E_2 + Omega + omega) - e^2 sin(2 E_2 + Omega +
  omega) + 8 e eta sin(Omega + omega) cos(E_1) - 8 e eta sin(Omega + omega) cos(E_2) - 8 e sin(-E_1 + Omega + omega)
  + 8 e sin(E_1 + Omega + omega) + 8 e sin(-E_2 + Omega + omega) - 8 e sin(E_2 + Omega + omega) + 4 eta sin(E_1)^2
  sin(Omega + omega) - 4 eta sin(E_2)^2 sin(Omega + omega) + sin(-2 E_1 + Omega + omega) - sin(2 E_1 + Omega +
  omega) - sin(-2 E_2 + Omega + omega) + sin(2 E_2 + Omega + omega))/(16 pi a eta n)] + C [-e (-3 E_1 e sin(omega)
  sin(Omega + omega) + 3 E_2 e sin(omega) sin(Omega + omega) + 2 e^2 sin(E_1) sin(omega) sin(Omega + omega) - 2 e^2
  sin(E_2) sin(omega) sin(Omega + omega) - e eta sin(E_1)^2 sin(Omega) - e eta sin(E_1)^2 sin(omega) cos(Omega +
  omega) + e eta sin(E_2)^2 sin(Omega) + e eta sin(E_2)^2 sin(omega) cos(Omega + omega) - e sin(E_1) sin(omega)
  sin(Omega + omega) cos(E_1) + e sin(E_2) sin(omega) sin(Omega + omega) cos(E_2) - 2 eta sin(Omega) cos(E_1) + 2
  eta sin(Omega) cos(E_2) - 2 eta sin(omega) cos(E_1) cos(Omega + omega) + 2 eta sin(omega) cos(E_2) cos(Omega +
  omega) + 2 sin(E_1) sin(omega) sin(Omega + omega) - 2 sin(E_2) sin(omega) sin(Omega + omega)) sin(i)/(4 pi a eta n
  (cos(i) + 1))] )
- a_g-dot = F_s ( A [(e - 1) (e + 1) (6 E_1 cos(Omega + omega) - 6 E_2 cos(Omega + omega) + 2 e sin(-E_1 + Omega +
  omega) - 2 e sin(E_1 + Omega + omega) - 2 e sin(-E_2 + Omega + omega) + 2 e sin(E_2 + Omega + omega) - sin(2 E_1 +
  Omega + omega) + sin(2 E_2 + Omega + omega))/(8 pi a eta n)] + B [(-12 E_1 e^2 sin(Omega + omega) + 12 E_1
  sin(Omega + omega) + 12 E_2 e^2 sin(Omega + omega) - 12 E_2 sin(Omega + omega) + 8 e^3 cos(-E_1 + Omega + omega) -
  8 e^3 cos(E_1 + Omega + omega) - 8 e^3 cos(-E_2 + Omega + omega) + 8 e^3 cos(E_2 + Omega + omega) - e^2 cos(-2 E_1
  + Omega + omega) + e^2 cos(2 E_1 + Omega + omega) + e^2 cos(-2 E_2 + Omega + omega) - e^2 cos(2 E_2 + Omega +
  omega) + 8 e eta cos(E_1) cos(Omega + omega) - 8 e eta cos(E_2) cos(Omega + omega) - 8 e cos(-E_1 + Omega + omega)
  + 8 e cos(E_1 + Omega + omega) + 8 e cos(-E_2 + Omega + omega) - 8 e cos(E_2 + Omega + omega) + 4 eta sin(E_1)^2
  cos(Omega + omega) - 4 eta sin(E_2)^2 cos(Omega + omega) + cos(-2 E_1 + Omega + omega) - cos(2 E_1 + Omega +
  omega) - cos(-2 E_2 + Omega + omega) + cos(2 E_2 + Omega + omega))/(16 pi a eta n)] + C [e (-3 E_1 e sin(omega)
  cos(Omega + omega) + 3 E_2 e sin(omega) cos(Omega + omega) + 2 e^2 sin(E_1) sin(omega) cos(Omega + omega) - 2 e^2
  sin(E_2) sin(omega) cos(Omega + omega) + e eta sin(E_1)^2 sin(omega) sin(Omega + omega) - e eta sin(E_1)^2
  cos(Omega) - e eta sin(E_2)^2 sin(omega) sin(Omega + omega) + e eta sin(E_2)^2 cos(Omega) - e sin(E_1) sin(omega)
  cos(E_1) cos(Omega + omega) + e sin(E_2) sin(omega) cos(E_2) cos(Omega + omega) + 2 eta sin(omega) sin(Omega +
  omega) cos(E_1) - 2 eta sin(omega) sin(Omega + omega) cos(E_2) - 2 eta cos(E_1) cos(Omega) + 2 eta cos(E_2)
  cos(Omega) + 2 sin(E_1) sin(omega) cos(Omega + omega) - 2 sin(E_2) sin(omega) cos(Omega + omega)) sin(i)/(4 pi a
  eta n (cos(i) + 1))] )

*[probe 4.4]* Confirmed: with the shadow rule above and these formulas, the SRP rate contributions are reproduced to
1e-13 relative in LEO, MEO, HEO and wholly sunlit GEO cases; in the GEO equinox case the library takes the wholly
sunlit branch (its boundary test fails), and these formulas reproduce it once the same branch is taken.

**Output-time SRP periodic terms.** With AGOM non-zero, analytic SRP short-period corrections (periodic in the
eccentric anomaly E, the Sun held fixed at the output time, no shadow) are added directly to the equinoctial
elements at the output time, after the third-body corrections of 5.4, in both regimes (in the long-period regime
there are no third-body corrections to come first), with E the eccentric anomaly of the interpolated mean elements
(Kozai 1961; Aksnes 1976) *[study; probe 4.3, 4.5]*. With F_s = 4.5e-6 AGOM 3600 / (1000 R_E (r_sun/AU)^2) (the SRP acceleration in R_E/min^2, R_E in km), a in
R_E, n in rad/min, eta = sqrt(1 - e^2) and A, B, C the Sun's unit vector projected on the perigee frame P, Q, W of
5.4:

- Delta lambda = F_s ( A [-(4 e^4 + 6 e^3 cos(E) - 5 e^2 eta - 14 e^2 - 5 e eta cos(E) - 6 e cos(E) + 10 eta + 10)
  sin(E)/(2 a n^2 (e^2 - eta - 1))] + B [-(10 e^3 eta sin(E)^2 - 5 e^3 eta + 10 e^3 sin(E)^2 - 5 e^3 + 16 e^2 eta
  cos(E) + 20 e^2 cos(E) - 12 e eta sin(E)^2 + 6 e eta - 10 e sin(E)^2 + 5 e - 20 eta cos(E) - 20 cos(E))/(4 a n^2
  (e^2 - eta - 1))] + C [(2 e^3 sin(E)^2 cos(omega) - e^3 cos(omega) - 2 e^2 eta sin(E) sin(omega) - 2 e^2 sin(E)
  sin(omega) + 4 e^2 cos(E) cos(omega) - 2 e eta sin(E) sin(E + omega) + e eta cos(omega) - 2 e sin(E) sin(E +
  omega) + e cos(omega) - 4 eta cos(E + omega) - 4 cos(E + omega)) sin(i)/(4 a n^2 (cos(i) + 1) (e^2 - eta - 1))] )
- Delta n = F_s ( A [3 cos(E)/(a n)] + B [3 eta sin(E)/(a n)] )
- Delta chi = F_s ( C [(4 e^2 sin(E) sin(Omega + omega) - 4 e eta cos(E)^2 cos(Omega + omega) + 2 e eta cos(Omega +
  omega) + e cos(-2 E + Omega + omega) - e cos(2 E + Omega + omega) + 8 eta cos(E) cos(Omega + omega) - 8 sin(E)
  sin(Omega + omega))/(8 a eta n^2 (cos(i) + 1))] )
- Delta psi = F_s ( C [(4 e^2 sin(E) cos(Omega + omega) - 4 e eta sin(E)^2 sin(Omega + omega) + 2 e eta sin(Omega +
  omega) - e sin(-2 E + Omega + omega) + e sin(2 E + Omega + omega) - 8 eta sin(Omega + omega) cos(E) - 8 sin(E)
  cos(Omega + omega))/(8 a eta n^2 (cos(i) + 1))] )
- Delta a_f = F_s ( A [(e - 1) (e + 1) (e cos(-E + Omega + omega) - e cos(E + Omega + omega) + cos(2 E + Omega +
  omega))/(4 a eta n^2)] + B [(2 e^3 sin(-E + Omega + omega) - 2 e^3 sin(E + Omega + omega) - e^2 sin(-2 E + Omega +
  omega) + e^2 sin(2 E + Omega + omega) + 8 e eta sin(Omega + omega) cos(E) - 2 e sin(-E + Omega + omega) + 2 e
  sin(E + Omega + omega) + 4 eta sin(E)^2 sin(Omega + omega) - 2 eta sin(Omega + omega) + sin(-2 E + Omega + omega)
  - sin(2 E + Omega + omega))/(8 a eta n^2)] + C [-e (2 e^2 sin(E) sin(omega) sin(Omega + omega) - 2 e eta
  sin(Omega) cos(E)^2 + e eta sin(Omega) - 2 e eta sin(omega) cos(E)^2 cos(Omega + omega) + e eta sin(omega)
  cos(Omega + omega) + 2 e sin(E) sin(omega) sin(Omega + omega) cos(E) + 4 eta sin(Omega) cos(E) + 4 eta sin(omega)
  cos(E) cos(Omega + omega) - 4 sin(E) sin(omega) sin(Omega + omega)) sin(i)/(4 a eta n^2 (cos(i) + 1))] )
- Delta a_g = F_s ( A [(e - 1) (e + 1) (e sin(-E + Omega + omega) - e sin(E + Omega + omega) + sin(2 E + Omega +
  omega))/(4 a eta n^2)] + B [-(2 e^3 cos(-E + Omega + omega) - 2 e^3 cos(E + Omega + omega) - e^2 cos(-2 E + Omega
  + omega) + e^2 cos(2 E + Omega + omega) + 8 e eta cos(E) cos(Omega + omega) - 2 e cos(-E + Omega + omega) + 2 e
  cos(E + Omega + omega) + 4 eta sin(E)^2 cos(Omega + omega) - 2 eta cos(Omega + omega) + cos(-2 E + Omega + omega)
  - cos(2 E + Omega + omega))/(8 a eta n^2)] + C [e (2 e^2 sin(E) sin(omega) cos(Omega + omega) - 2 e eta sin(E)^2
  sin(omega) sin(Omega + omega) + 2 e eta sin(E)^2 cos(Omega) + e eta sin(omega) sin(Omega + omega) - e eta
  cos(Omega) + 2 e sin(E) sin(omega) cos(E) cos(Omega + omega) - 4 eta sin(omega) sin(Omega + omega) cos(E) + 4 eta
  cos(E) cos(Omega) - 4 sin(E) sin(omega) cos(Omega + omega)) sin(i)/(4 a eta n^2 (cos(i) + 1))] )

*[probe 4.3]* Confirmed: with these terms, the third-body terms of 5.4 and the short-period corrections of section 8,
epoch states with AGOM = 0.05 m^2/kg are reproduced to 1.3e-9 km at 15.2 rev/day and to 1.2e-6 km or better at
1.6-5 rev/day (e = 0.0003-0.72); without them the residual is 0.5 m to 90 m.

*[probe 4.5, 4.6]* Long periods, low inclinations and high eccentricities, both regimes (0.5 to 4 rev/day,
e = 0.05 to 0.6, i = 3 to 30 deg, AGOM 0.03 against 0). The formulas of this section, as printed here, agree with
the library's expressions to 3e-13 at 300 random orbits (e up to 0.85, i from 0.5 deg; sunlit, arc and output-time
terms) *[study]*, and against the library: the SRP rate contributions at epoch are reproduced to 4e-9 relative
wherever the shadow decision agrees; epoch states to 1e-11 km in the long-period regime (the SRP part is 40 to
350 m there); states between integrator nodes (47.5 min) and after 1 and 3 days, rebuilt from the library's native
elements at those times, to 3e-6 km. Along the trajectory the averaged SRP rates are evaluated at every integrator
stage with the Sun at that stage's time: one integrator step from the epoch (9) with the rates of sections 2, 4 and
5 reproduces the library's next node to 1e-10 in a_f, a_g and lambda, while holding the SRP Sun at the step start
misses it by 1e-9 to 8e-9 (4.6 vectors: rates at nodes over 13 steps, reproduced to 4e-7 relative). The 4.5 vectors
also carry 30 element sets with AGOM that side B lists as outliers (high-eccentricity sets in the 0.5-day and 1-day
bands, MEO), as given and with AGOM 0, over 7 days: their SRP effect is 0.1 to 13 km, and at epoch the library uses a
sunlit arc for 28 of them (its SRP n-dot is not zero). For the set with e = 0.719 at 2.3765 rev/day the orbit
enters the shadow geometrically, but the library counts it as wholly sunlit: its closed-form boundaries miss the
1e-12 test, as at GEO, so an implementation that solves the quartic more accurately takes the arc there. This is
not rare at these eccentricities: hourly along 7 days of five of the listed sets (e = 0.70 to 0.73, and one MEO
set), the closed-form boundaries miss the test at 3 % to 28 % of the samples where the geometry has a shadow, and
those evaluations are averaged as wholly sunlit *[study; the epoch decisions of all 30 sets agree with the
library]*. Matching the library there needs its closed-form sequence, rounding included, not a better root.

*[probe 4.9]* Side B's SRP outlier sets (near-circular GEO with e = 0.0005 to 0.0025, MEO and VDS), each at 24 epochs
one hour apart: at an epoch the AGOM on-minus-off n-dot is the SRP n-dot alone, zero exactly where the library counts
the orbit wholly sunlit, so these vectors read the library's shadow decision directly. Near-circular GEO in the
eclipse season is almost entirely rounding-limited (20 to 24 of the 24 geometries of each set have a candidate within
a factor of ten of 1e-12), and over all 720 geometries the sequence above takes the library's decision at 575; the
others depend on the last bits of the arithmetic. The VDS set with e = 0.60 at 0.26 rev/day does meet the shadow: the
library takes a sunlit arc at 23 of its 24 geometries, and the sequence agrees at 23.

*[probe 4.10]* Side B's twenty worst sets with e > 0.66 in the 0.5-day band, at node level: from each of the
library's first 8 nodes, one step of 9 with the rates of sections 2 to 6 (the epoch class and F, G at e_0, i_0 of
6.3, the drag terms of 3.4) reproduces the change of n to the next node to 3e-7 of that change at 153 of the 160
steps, most to 1e-8. Each of the other 7 (misses of 1e-4 to 9e-2 of the change) is reproduced to 2e-9 by taking the
other shadow decision at one evaluation of the step (k1, k2 or k4), and each of those 7 decisions is
rounding-limited by (a), with |S| from 1.3e-13 to 1.3e-12; the sequence takes the library's decision at 4 of them.
One such stage decision changes n by up to 2e-9 rad/min, which along track over the remaining days is 80 to 340 m
on these orbits, the size of side B's listed differences for them (30 to 623 m).

*[probe 4.8]* Long periods, e = 0.6 and low inclinations over a week (0.2 to 4 rev/day, i = 1 and 4 deg, AGOM 0.03
against 0; native elements, rates and states every 6 hours for 7 days, and the native elements at the first four
integrator nodes). The output chain of section 8, with the SRP terms at the output time, rebuilds the library's
states from its native elements to 1e-9 km after the first integrator step and to 1e-6 km within it, out to 7 days
and to periods of 14,400 min. Over one integrator step of the long-period regime, the AGOM on-minus-off increment
of a_f, a_g, chi, psi and lambda equals the step of the averaged SRP rates taken at the stage states and times
to 2e-4, whatever the AGOM (0.03, 0.003 or 1e-4); the remainder is of the size of the coupling between the SRP
change and the instantaneous third-body rates. Over a week a remainder of that size moves the position by about
1e-4 of the SRP displacement, so a difference of a per cent of it shows step by step against these node vectors.

**Confirmed.** *[probe 4.1]* For a near-circular GEO orbit on 2024-04-09 with AGOM = 0.02 m^2/kg, the SRP part of
the eccentricity-vector rate is |d(a_f, a_g)/dt| = 2.565e-9 per minute. The circular-orbit relation
|e-dot| = (3/2) F / (n a) gives F = 8.76e-8 m/s^2, consistent with P AGOM cos(delta_sun) (1 AU/r)^2 = 8.9e-8 m/s^2
for P = 4.5e-6 N/m^2, less a sunlit fraction of about 0.985 for that day (GEO eclipse season). The section-4
vectors hold this case and the solstice case (no eclipses). Versions 9.1.1.0 and 9.9 differ only when SRP (and in
some cases drag) is on (section 11), which places the shadow computation as the changed part.

## 5. Lunar and solar terms

**Bodies.** Point-mass Sun and Moon. Mass ratios to the Earth: Sun 332946.038, Moon 0.0123 (also 0.012300034 in
places) *[study; lit: IAU 1976 system]*. Positions:

- Sun *[study; lit: Meeus 1998 ch. 25; Explanatory Supplement 1992]*: with T = (d50 - 18263.5) / 36525 Julian
  centuries from J2000 (d50 as in 1.2), all angles in degrees:
  - mean anomaly M = 357.52772333333 + 35999.05034 T - 1.6027777777777777e-4 T^2 - 3.3333333333333e-6 T^3;
  - eccentricity e = 0.01670832 - 4.2229e-5 T - 1.26e-7 T^2;
  - longitude of perigee varpi = 282.938346111111 + 1.71945722222222 T + 4.62777777777776e-4 T^2
    + 3.3333333333333e-6 T^3;
  - obliquity epsilon = 23.4392635861111 - 0.0130253805555555 T - 1.30555555555555e-7 T^2
    + 5.02777777777776e-7 T^3;
  - true anomaly nu = M + (2e - e^3/4 + 5e^5/96) sin M + (5e^2/4 - 11e^4/24) sin 2M + (13e^3/12 - 43e^5/64) sin 3M
    + (103e^4/96) sin 4M + (1097e^5/960) sin 5M (the classical equation of the center to e^5);
  - ecliptic longitude lambda = nu + varpi; unit vector (cos lambda, sin lambda cos epsilon, sin lambda sin epsilon)
    in the mean equator and equinox of date;
  - distance r = A (r/a) with A = 149597870 km, converted to Earth radii with R_E, and the classical expansion
    r/a = 1 + e^2/2 - (e - 3e^3/8 + 5e^5/192) cos M - (e^2/2 - e^4/3) cos 2M - (3e^3/8 - 45e^5/128) cos 3M
    - (e^4/3) cos 4M - (125e^5/384) cos 5M (Brouwer & Clemence 1961).
  *[study; probe 5.3: this Sun reproduces the library's direction to 1e-14 and distance to 2e-16 relative]*
- Moon *[study; lit: Brown's lunar theory, main terms; IAU 1980 fundamental arguments (Seidelmann 1982); Montenbruck &
  Pfleger 2000]*. Arguments in arcseconds (converted with 1 arcsec = 4.84813681109536e-6 rad), T as for the Sun:
  - l = 485866.733 + 1717915922.633 T + 31.31 T^2 + 0.064 T^3 (Moon's mean anomaly);
  - L = 785939.157 + 1732564372.598 T - 5.802 T^2 + 0.019 T^3 (Moon's mean longitude);
  - D = 1072261.307 + 1602961601.328 T - 6.891 T^2 + 0.019 T^3 (mean elongation);
  - F = 335778.877 + 1739527263.137 T - 13.257 T^2 + 0.011 T^3 (argument of latitude);
  - l' = the Sun's mean anomaly M above.
  - Ecliptic longitude of date, lambda = L + [22639.5 sin l - 4586.465 sin(l - 2D) + 2369.912 sin 2D
    + 769.016 sin 2l - 668.146 sin l' - 411.608 sin 2F - 211.656 sin(2l - 2D) - 205.962 sin(l + l' - 2D)
    + 191.953 sin(l + 2D) - 165.145 sin(l' - 2D) + 147.687 sin(l - l') - 125.154 sin D
    - 109.673 sin(l + l')] arcsec.
  - Latitude argument S = F + [22609.07 sin l - 4578.13 sin(l - 2D) + 2373.36 sin 2D + 767.96 sin 2l
    + 192.72 sin(l + 2D) - 182.36 sin(l + l' - 2D) - 165.06 sin(l' - 2D) - 152.53 sin(2l - 2D) - 138.76 sin(l' - l)
    - 126.98 sin l' - 115.18 sin(l + l') - 112.79 sin D] arcsec.
  - Factor g = 1.00000271 - 1.39978e-4 [0.53858 cos(3.040944319 - 9.253193406 T) + 3.33179 cos(4.523601504
    - 9.242202921 T) + 0.064043 cos(3.295762417 - 9.246503573 T)].
  - Ecliptic latitude (rad) beta = 0.089785955 g sin S - 3.02572e-5 g^3 sin 3S + 1.94e-8 g^5 sin 5S
    - 0.00255045 sin(F - 2D).
  - Horizontal parallax pi = 3422.7 + 186.5398 cos l + 34.3117 cos(l - 2D) + 28.2333 cos 2D + 10.1657 cos 2l
    + 3.0861 cos(l + 2D) + 1.9178 cos(l' - 2D) + 1.4437 cos(l + l' - 2D) + 1.1528 cos(l - l') - 0.9781 cos D
    - 0.949 cos(l + l') - 0.7136 cos(l - 2F) + 0.6215 cos 3l + 0.6008 cos(l - 4D) - 0.3997 cos l'
    + 0.3722 cos(2l - 4D) - 0.3039 cos(2l - 2D) - 0.3 cos(l' + 2D) + 0.2833 cos(2l + 2D) + 0.2607 cos 4D
    + 0.2302 cos(l - l' + 2D) - 0.2257 cos(l - l' - 2D) + 0.1494 cos(l' + D) + 0.1268 cos(2l - l')
    - 0.1187 cos(3l - 2D) - 0.1093 cos(l + D) - 0.1052 cos(2F - 2D) - 0.1038 cos(2l + l') arcsec.
  - Position in Earth radii: (cos beta cos lambda, cos beta sin lambda cos epsilon - sin beta sin epsilon,
    cos beta sin lambda sin epsilon + sin beta cos epsilon) / sin pi, epsilon the obliquity of the Sun model;
    the distance is its norm, the direction its unit vector (mean equator and equinox of date).
  *[study; probe 5.3: this Moon reproduces the library's direction and distance to 3e-13]*
- JPL ephemerides are used only when loaded; the oracle does not load them, and release notes 9.3-9.9 still list
  "replace analytical theory of Sun and Moon position with JPL ephemeris for SGP4-XP" as planned work *[doc]*.

**In the rates, averaged regime (epoch period below 1100 min).** The third-body disturbing function averaged over
the satellite's mean anomaly, to the octupole (Legendre degree 3), each body held fixed at its position at the
evaluation time of the Runge-Kutta stage (Kozai 1959; Danielson et al. 1995) *[lit; study]*. With the strengths
C2 = (mu_b/mu)(a/r_b)^3 n and C3 = C2 (a/r_b) and the direction cosines A, B, C of the output-time terms, the
contributions to the six rates (same set as section 2: n-dot, e-dot, i-dot, e varpi-dot, sin i Omega-dot,
lambda-dot - n; rad/min) are, per body, C2 Q2 + C3 Q3 with *[study; probe 2.2]*:

**n-dot** = 0.

**e-dot** = C2 [ Q2 ] + C3 [ Q3 ], with
- Q2 = A B [-15 e eta/2]
- Q3 = A^2 B [75 eta (6 e^2 + 1)/16] + B^3 [-75 eta (e - 1) (e + 1)/16] + B [-15 eta (3 e^2 + 4)/16]

**i-dot** = C2 [ Q2 ] + C3 [ Q3 ], with
- Q2 = A C [3 (4 e^2 + 1) cos(omega)/(2 eta)] + B C [3 (e - 1) (e + 1) sin(omega)/(2 eta)]
- Q3 = A^2 C [-75 e (4 e^2 + 3) cos(omega)/(16 eta)] + A B C [-75 e (e - 1) (e + 1) sin(omega)/(8 eta)] + B^2 C [75
  e (e - 1) (e + 1) cos(omega)/(16 eta)] + C [15 e (3 e^2 + 4) cos(omega)/(16 eta)]

**e varpi-dot** = C2 [ Q2 ] + C3 [ Q3 ], with
- Q2 = A^2 [6 e eta] + B^2 [-3 e eta/2] + A C [3 e (4 e^2 + 1) sin(i) sin(omega)/(2 eta (cos(i) + 1))] + B C [-3 e
  (e - 1) (e + 1) sin(i) cos(omega)/(2 eta (cos(i) + 1))] + [-3 e eta/2]
- Q3 = A^3 [-75 eta (4 e^2 + 1)/16] + A B^2 [75 eta (3 e^2 - 1)/16] + A^2 C [-75 e^2 (4 e^2 + 3) sin(i)
  sin(omega)/(16 eta (cos(i) + 1))] + A B C [75 e^2 (e - 1) (e + 1) sin(i) cos(omega)/(8 eta (cos(i) + 1))] + B^2 C
  [75 e^2 (e - 1) (e + 1) sin(i) sin(omega)/(16 eta (cos(i) + 1))] + A [15 eta (9 e^2 + 4)/16] + C [15 e^2 (3 e^2 +
  4) sin(i) sin(omega)/(16 eta (cos(i) + 1))]

**sin i Omega-dot** = C2 [ Q2 ] + C3 [ Q3 ], with
- Q2 = A C [3 (4 e^2 + 1) sin(omega)/(2 eta)] + B C [-3 (e - 1) (e + 1) cos(omega)/(2 eta)]
- Q3 = A^2 C [-75 e (4 e^2 + 3) sin(omega)/(16 eta)] + A B C [75 e (e - 1) (e + 1) cos(omega)/(8 eta)] + B^2 C [75 e
  (e - 1) (e + 1) sin(omega)/(16 eta)] + C [15 e (3 e^2 + 4) sin(omega)/(16 eta)]

**lambda-dot - n** = C2 [ Q2 ] + C3 [ Q3 ], with
- Q2 = A^2 [-3 (2 e^2 eta + 4 e^2 + eta + 1)/(eta + 1)] + B^2 [3 (e^2 eta + 2 e^2 - 2 eta - 2)/(2 (eta + 1))] + A C
  [3 (4 e^2 + 1) sin(i) sin(omega)/(2 eta (cos(i) + 1))] + B C [-3 (e - 1) (e + 1) sin(i) cos(omega)/(2 eta (cos(i)
  + 1))] + [(3 e^2 eta + 6 e^2 + 4 eta + 4)/(2 (eta + 1))]
- Q3 = A^3 [75 e (4 e^2 eta + 8 e^2 + 5 eta + 6)/(16 (eta + 1))] + A B^2 [-75 e (3 e^2 eta + 6 e^2 - 5 eta - 6)/(16
  (eta + 1))] + A^2 C [-75 e (4 e^2 + 3) sin(i) sin(omega)/(16 eta (cos(i) + 1))] + A B C [75 e (e - 1) (e + 1)
  sin(i) cos(omega)/(8 eta (cos(i) + 1))] + B^2 C [75 e (e - 1) (e + 1) sin(i) sin(omega)/(16 eta (cos(i) + 1))] + A
  [-15 e (9 e^2 eta + 18 e^2 + 20 eta + 24)/(16 (eta + 1))] + C [15 e (3 e^2 + 4) sin(i) sin(omega)/(16 eta (cos(i)
  + 1))]

*[probe 2.2]* Confirmed: the zonal rates of section 2 plus these Sun and Moon rates reproduce the library's native
rates at epoch (13-15.2 rev/day, drag and SRP off) to 1e-8 to 1e-10 relative in a_f, a_g, chi, psi and 6e-13 in
lambda-dot.

These rates stop at the octupole; AP adds each body's terms of degree 4 to 10 in this regime (16.8).

**At the output time, averaged regime.** The third-body short-period terms (periodic in the satellite's eccentric
anomaly E, the body held fixed at the output time) are added to the interpolated mean elements, once for the Sun
and once for the Moon, from one formula with the body's parameters *[study]*:

- quadrupole strength C2 = (mu_b / mu) (a / r_b)^3 n and octupole strength C3 = (mu_b / mu) (a / r_b)^4 n, with
  mu_b / mu the mass ratio (5), r_b the body's distance and n the mean motion;
- the body's unit vector projected on the satellite's perigee frame: A = s.P, B = s.Q, C = s.W, with
  P = (cos w cos O - sin w sin O cos i, cos w sin O + sin w cos O cos i, sin w sin i),
  Q = (-sin w cos O - cos w sin O cos i, -sin w sin O + cos w cos O cos i, cos w sin i),
  W = (sin O sin i, -cos O sin i, cos i) (w = omega, O = Omega);
- the terms are trigonometric polynomials in E, 2E, 3E and 4E with coefficients in e, sqrt(1 - e^2), A, B, C and
  cos omega, sin omega, giving corrections to a (or n), e, i, Omega, omega and the mean longitude; the Sun and Moon
  corrections are summed, then carried to the equinoctial elements (Delta a_f = Delta e cos(w + O) - e sin(w + O)
  Delta(w + O), Delta a_g likewise, Delta chi and Delta psi through 1 / (1 + cos i)) *[study]*.

This is the classical first-order third-body short-period solution in closed form in E (Kozai 1959; Giacaglia 1973)
and the XP counterpart of SGP4's deep-space lunar-solar periodics (Hoots & Roehrich 1980) *[lit]*.

The six corrections are, in order, Delta n (rad/min, entering a through a = (k_e/n)^(2/3) before the short-period
step), Delta e, Delta i, e Delta varpi, sin i Delta Omega and Delta lambda (radians); each body's are computed with
its own C2, C3, A, B, C and summed, then added to the equinoctial elements as above *[study]*. The explicit terms
follow in 5.4.

*[probe 5.3]* Confirmed. With the Sun and Moon of this section, the terms of 5.4 and the short-period corrections of
section 8, the library's epoch state is reproduced to 1.3e-9 km at 15.2 rev/day (0.6 m without the 5.4 terms),
to 1.2e-6 km at 1.6 rev/day with e = 0.0003 and 0.4 (460 m and 600 m without them), and to 5e-7 km at 2 and
5 rev/day (e = 0.05, 0.2). Velocities agree to 1.6e-10 km/s or better.

### 5.4 Output-time third-body corrections, explicit

Notation: e, i, omega the mean elements, eta = sqrt(1 - e^2), E the eccentric anomaly from M = E - e sin E, n the
mean motion (rad/min), C2 and C3 as above, A, B, C the body's unit vector on P, Q, W. Each correction is
C2 Q2 + C3 Q3 with Q2 quadratic and Q3 cubic in (A, B, C); brackets hold the coefficient of each monomial.
*[study; probe 5.3]*

**Delta n** = C2 [ Q2 ] + C3 [ Q3 ], with
- Q2 = A^2 [9 (4 e cos(E) - cos(2E))/4] + A B [9 eta (e - cos(E)) sin(E)] + B^2 [-9 (e - 1) (e + 1) cos(2E)/4] + [3
  e (e cos(2E) - 4 cos(E))/4]
- Q3 = A^3 [-15 (12 e^2 cos(E) + 12 e sin(E)^2 - 6 e + 3 cos(E) + cos(3E))/8] + A^2 B [45 (e - 1) (e + 1) (4 e^2
  sin(E) - 4 e sin(2E) + sin(E) + sin(3E))/(8 eta)] + A B^2 [45 (e - 1) (e + 1) (2 e cos(2E) + cos(E) - cos(3E))/8]
  + B^3 [15 (e - 1)^2 (e + 1)^2 (-3 sin(E) + sin(3E))/(8 eta)] + A [-9 (2 e^3 cos(2E) - 11 e^2 cos(E) - e^2 cos(3E)
  + 4 e cos(2E) - 4 cos(E))/8] + B [-9 (e - 1) (e + 1) (e^2 sin(E) + e^2 sin(3E) - 4 e sin(2E) + 4 sin(E))/(8 eta)]

**Delta e** = C2 [ Q2 ] + C3 [ Q3 ], with
- Q2 = A^2 [-(e - 1) (e + 1) (6 e sin(E)^2 - 3 e + 3 cos(E) + cos(3E))/(4 n)] + A B [-eta (3 e^2 sin(E) + e^2
  sin(3E) + 9 e sin(2E) - 18 sin(E) - 2 sin(3E))/(4 n)] + B^2 [(e - 1) (e + 1) (12 e sin(E)^2 - 6 e + 15 cos(E) +
  cos(3E))/(4 n)] + [(e - 1) (e + 1) (e cos(2E) - 4 cos(E))/(4 n)]
- Q3 = A^3 [-5 eta^2 (192 e^3 cos(E) + 48 e^2 sin(E)^2 - 24 e^2 + 48 e cos(E) + 16 e cos(3E) - 24 sin(E)^4 + 48
  sin(E)^2 - 15)/(64 n)] + A^2 B [5 eta (120 e^3 sin(E) + 16 e^3 sin(3E) + 120 e^2 sin(2E) - 6 e^2 sin(4E) - 372 e
  sin(E) - 48 e sin(3E) + 48 sin(2E) + 9 sin(4E))/(64 n)] + A B^2 [15 eta^2 (192 e^3 cos(E) + 8 e^2 sin(E)^4 + 64
  e^2 sin(E)^2 - 35 e^2 + 112 e cos(E) + 16 e cos(3E) - 24 sin(E)^4 + 64 sin(E)^2 - 23)/(64 n)] + B^3 [-5 eta (192
  e^3 sin(E) + 8 e^3 sin(3E) + 48 e^2 sin(2E) + 228 e sin(E) - 40 e sin(3E) + 24 sin(2E) + 3 sin(4E))/(64 n)] + B^2
  [-5 e eta (-180 e^2 sin(E) + 8 e^2 sin(3E) - 3 e sin(4E) - 240 sin(E) + 24 sin(3E))/(64 n)] + A [-3 eta^2 (8 e^2
  sin(E)^4 + 16 e^2 sin(E)^2 - 11 e^2 + 64 e cos(E) + 16 sin(E)^2 - 8)/(64 n)] + B [eta (-84 e^3 sin(E) + 32 e^3
  sin(3E) - 192 e^2 sin(2E) - 3 e^2 sin(4E) + 336 e sin(E) + 24 sin(2E))/(64 n)]

**Delta i** = C2 [ Q2 ] + C3 [ Q3 ], with
- Q2 = A C [(12 e^3 sin(E) cos(omega) + 3 e^2 eta sin(omega) cos(2E) + 6 e^2 sin(2E) cos(omega) - 15 e eta
  sin(omega) cos(E) - e eta sin(omega) cos(3E) - 27 e sin(E) cos(omega) - e sin(3E) cos(omega) + 3 eta sin(omega)
  cos(2E) + 3 sin(2E) cos(omega))/(4 eta n)] + B C [(3 e^3 sin(E) sin(omega) + e^3 sin(3E) sin(omega) - 3 e^2 eta
  cos(2E) cos(omega) - 3 e^2 sin(2E) sin(omega) + 15 e eta cos(E) cos(omega) + e eta cos(3E) cos(omega) - 3 e sin(E)
  sin(omega) - e sin(3E) sin(omega) - 3 eta cos(2E) cos(omega) + 3 sin(2E) sin(omega))/(4 eta n)]
- Q3 = A^2 C [-5 (144 e^4 sin(E) cos(omega) + 24 e^3 eta sin(omega) cos(2E) + 72 e^3 sin(2E) cos(omega) - 48 e^2 eta
  sin(omega) cos(E) - 16 e^2 eta sin(omega) cos(3E) - 324 e^2 sin(E) cos(omega) - 24 e^2 sin(3E) cos(omega) + 36 e
  eta sin(omega) cos(2E) + 3 e eta sin(omega) cos(4E) + 96 e sin(2E) cos(omega) + 3 e sin(4E) cos(omega) - 24 eta
  sin(omega) cos(E) - 8 eta sin(omega) cos(3E) - 72 sin(E) cos(omega) - 8 sin(3E) cos(omega))/(64 eta n)] + A B C
  [-5 (36 e^4 sin(E) sin(omega) + 8 e^4 sin(3E) sin(omega) - 24 e^3 eta cos(2E) cos(omega) - 24 e^3 sin(2E)
  sin(omega) - 3 e^3 sin(4E) sin(omega) + 144 e^2 eta cos(E) cos(omega) + 16 e^2 eta cos(3E) cos(omega) - 60 e^2
  sin(E) sin(omega) - 60 e eta cos(2E) cos(omega) - 3 e eta cos(4E) cos(omega) + 24 e sin(2E) sin(omega) + 3 e
  sin(4E) sin(omega) + 24 eta cos(E) cos(omega) + 8 eta cos(3E) cos(omega) + 24 sin(E) sin(omega) - 8 sin(3E)
  sin(omega))/(32 eta n)] + B^2 C [5 (36 e^4 sin(E) cos(omega) + 8 e^4 sin(3E) cos(omega) - 24 e^3 eta sin(E)^4
  sin(omega) + 9 e^3 eta sin(omega) - 24 e^3 sin(2E) cos(omega) - 3 e^3 sin(4E) cos(omega) + 24 e^2 eta sin(omega)
  cos(E) + 8 e^2 eta sin(omega) cos(3E) - 60 e^2 sin(E) cos(omega) + 24 e eta sin(E)^4 sin(omega) + 48 e eta
  sin(E)^2 sin(omega) - 33 e eta sin(omega) + 24 e sin(2E) cos(omega) + 3 e sin(4E) cos(omega) + 72 eta sin(omega)
  cos(E) - 8 eta sin(omega) cos(3E) + 24 sin(E) cos(omega) - 8 sin(3E) cos(omega))/(64 eta n)] + C [-(-108 e^4
  sin(E) cos(omega) + 8 e^4 sin(3E) cos(omega) - 12 e^3 eta sin(omega) cos(2E) - 3 e^3 eta sin(omega) cos(4E) - 96
  e^3 sin(2E) cos(omega) - 3 e^3 sin(4E) cos(omega) + 72 e^2 eta sin(omega) cos(E) + 24 e^2 eta sin(omega) cos(3E) +
  264 e^2 sin(E) cos(omega) + 24 e^2 sin(3E) cos(omega) - 72 e eta sin(omega) cos(2E) - 72 e sin(2E) cos(omega) + 96
  eta sin(omega) cos(E) + 96 sin(E) cos(omega))/(64 eta n)]

**e Delta varpi** = C2 [ Q2 ] + C3 [ Q3 ], with
- Q2 = A^2 [eta (12 e^2 sin(E) - 15 sin(E) + sin(3E))/(4 n)] + A B [-(6 e^3 sin(E)^2 - 3 e^3 + 33 e^2 cos(E) - e^2
  cos(3E) + 6 e sin(E)^2 - 3 e - 18 cos(E) + 2 cos(3E))/(4 n)] + B^2 [-eta (6 e^2 sin(E) - 3 e sin(2E) - 3 sin(E) +
  sin(3E))/(4 n)] + A C [e (24 e^3 sin(E) sin(omega) + 12 e^2 eta sin(E)^2 cos(omega) - 6 e^2 eta cos(omega) + 6 e^2
  cos(2E - omega) - 6 e^2 cos(2E + omega) + 30 e eta cos(E) cos(omega) + 2 e eta cos(3E) cos(omega) - 54 e sin(E)
  sin(omega) - 2 e sin(3E) sin(omega) + 12 eta sin(E)^2 cos(omega) - 6 eta cos(omega) + 3 cos(2E - omega) - 3 cos(2E
  + omega)) sin(i)/(8 eta n (cos(i) + 1))] + B C [-e (6 e^3 sin(E) cos(omega) + 2 e^3 sin(3E) cos(omega) - 12 e^2
  eta sin(E)^2 sin(omega) + 6 e^2 eta sin(omega) - 3 e^2 sin(2E - omega) - 3 e^2 sin(2E + omega) - 30 e eta
  sin(omega) cos(E) - 2 e eta sin(omega) cos(3E) - 6 e sin(E) cos(omega) - 2 e sin(3E) cos(omega) - 12 eta sin(E)^2
  sin(omega) + 6 eta sin(omega) + 3 sin(2E - omega) + 3 sin(2E + omega)) sin(i)/(8 eta n (cos(i) + 1))] + [-eta (e^2
  + e cos(E) - 2) sin(E)/(2 n)]
- Q3 = A^3 [-5 eta (144 e^3 sin(E) + 24 e^2 sin(2E) - 252 e sin(E) + 8 e sin(3E) + 24 sin(2E) - 3 sin(4E))/(64 n)] +
  A^2 B [15 (32 e^4 sin(E)^2 - 16 e^4 + 160 e^3 cos(E) + 16 e^2 sin(E)^4 + 48 e^2 sin(E)^2 - 30 e^2 - 104 e cos(E) +
  8 e cos(3E) - 24 sin(E)^4 - 16 sin(E)^2 + 17)/(64 n)] + A B^2 [5 eta (156 e^3 sin(E) + 8 e^3 sin(3E) - 96 e^2
  sin(2E) + 3 e^2 sin(4E) - 132 e sin(E) + 24 e sin(3E) + 48 sin(2E) - 9 sin(4E))/(64 n)] + B^3 [5 (e - 1) (e + 1)
  (-72 e cos(E) + 8 e cos(3E) - 24 sin(E)^4 + 9)/(64 n)] + A^2 C [-5 e (144 e^4 sin(E) sin(omega) + 48 e^3 eta
  sin(E)^2 cos(omega) - 24 e^3 eta cos(omega) + 36 e^3 cos(2E - omega) - 36 e^3 cos(2E + omega) + 48 e^2 eta cos(E)
  cos(omega) + 16 e^2 eta cos(3E) cos(omega) - 324 e^2 sin(E) sin(omega) - 24 e^2 sin(3E) sin(omega) - 24 e eta
  sin(E)^4 cos(omega) + 96 e eta sin(E)^2 cos(omega) - 39 e eta cos(omega) - 24 e sin(E)^3 sin(omega) cos(E) + 51 e
  cos(2E - omega) - 51 e cos(2E + omega) + 24 eta cos(E) cos(omega) + 8 eta cos(3E) cos(omega) - 72 sin(E)
  sin(omega) - 8 sin(3E) sin(omega)) sin(i)/(64 eta n (cos(i) + 1))] + A B C [5 e (36 e^4 sin(E) cos(omega) + 8 e^4
  sin(3E) cos(omega) - 48 e^3 eta sin(E)^2 sin(omega) + 24 e^3 eta sin(omega) + 24 e^3 sin(E)^3 cos(E) cos(omega) -
  15 e^3 sin(2E - omega) - 15 e^3 sin(2E + omega) - 144 e^2 eta sin(omega) cos(E) - 16 e^2 eta sin(omega) cos(3E) -
  60 e^2 sin(E) cos(omega) + 24 e eta sin(E)^4 sin(omega) - 144 e eta sin(E)^2 sin(omega) + 63 e eta sin(omega) - 24
  e sin(E)^3 cos(E) cos(omega) + 15 e sin(2E - omega) + 15 e sin(2E + omega) - 24 eta sin(omega) cos(E) - 8 eta
  sin(omega) cos(3E) + 24 sin(E) cos(omega) - 8 sin(3E) cos(omega)) sin(i)/(32 eta n (cos(i) + 1))] + B^2 C [5 e (36
  e^4 sin(E) sin(omega) + 8 e^4 sin(3E) sin(omega) + 24 e^3 eta sin(E)^4 cos(omega) - 9 e^3 eta cos(omega) + 24 e^3
  sin(E)^3 sin(omega) cos(E) - 15 e^3 cos(2E - omega) + 15 e^3 cos(2E + omega) - 24 e^2 eta cos(E) cos(omega) - 8
  e^2 eta cos(3E) cos(omega) - 60 e^2 sin(E) sin(omega) - 24 e eta sin(E)^4 cos(omega) - 48 e eta sin(E)^2
  cos(omega) + 33 e eta cos(omega) - 24 e sin(E)^3 sin(omega) cos(E) + 15 e cos(2E - omega) - 15 e cos(2E + omega) -
  72 eta cos(E) cos(omega) + 8 eta cos(3E) cos(omega) + 24 sin(E) sin(omega) - 8 sin(3E) sin(omega)) sin(i)/(64 eta
  n (cos(i) + 1))] + A [-eta (-276 e^3 sin(E) + 8 e^3 sin(3E) - 168 e^2 sin(2E) + 3 e^2 sin(4E) + 624 e sin(E) - 24
  sin(2E))/(64 n)] + B [-3 (32 e^4 sin(E)^2 - 16 e^4 + 88 e^3 cos(E) + 8 e^3 cos(3E) - 8 e^2 sin(E)^4 + 48 e^2
  sin(E)^2 - 21 e^2 - 32 e cos(E) - 16 sin(E)^2 + 8)/(64 n)] + C [-e (-108 e^4 sin(E) sin(omega) + 8 e^4 sin(3E)
  sin(omega) + 24 e^3 eta sin(E)^4 cos(omega) - 48 e^3 eta sin(E)^2 cos(omega) + 15 e^3 eta cos(omega) + 24 e^3
  sin(E)^3 sin(omega) cos(E) - 51 e^3 cos(2E - omega) + 51 e^3 cos(2E + omega) - 72 e^2 eta cos(E) cos(omega) - 24
  e^2 eta cos(3E) cos(omega) + 264 e^2 sin(E) sin(omega) + 24 e^2 sin(3E) sin(omega) - 144 e eta sin(E)^2 cos(omega)
  + 72 e eta cos(omega) - 36 e cos(2E - omega) + 36 e cos(2E + omega) - 96 eta cos(E) cos(omega) + 96 sin(E)
  sin(omega)) sin(i)/(64 eta n (cos(i) + 1))]

**sin i Delta Omega** = C2 [ Q2 ] + C3 [ Q3 ], with
- Q2 = A C [(12 e^3 sin(E) sin(omega) - 3 e^2 eta cos(2E) cos(omega) + 6 e^2 sin(2E) sin(omega) + 15 e eta cos(E)
  cos(omega) + e eta cos(3E) cos(omega) - 27 e sin(E) sin(omega) - e sin(3E) sin(omega) - 3 eta cos(2E) cos(omega) +
  3 sin(2E) sin(omega))/(4 eta n)] + B C [-(3 e^3 sin(E) cos(omega) + e^3 sin(3E) cos(omega) + 3 e^2 eta sin(omega)
  cos(2E) - 3 e^2 sin(2E) cos(omega) - 15 e eta sin(omega) cos(E) - e eta sin(omega) cos(3E) - 3 e sin(E) cos(omega)
  - e sin(3E) cos(omega) + 3 eta sin(omega) cos(2E) + 3 sin(2E) cos(omega))/(4 eta n)]
- Q3 = A^2 C [-5 (144 e^4 sin(E) sin(omega) - 24 e^3 eta cos(2E) cos(omega) + 72 e^3 sin(2E) sin(omega) + 48 e^2 eta
  cos(E) cos(omega) + 16 e^2 eta cos(3E) cos(omega) - 324 e^2 sin(E) sin(omega) - 24 e^2 sin(3E) sin(omega) - 36 e
  eta cos(2E) cos(omega) - 3 e eta cos(4E) cos(omega) + 96 e sin(2E) sin(omega) + 3 e sin(4E) sin(omega) + 24 eta
  cos(E) cos(omega) + 8 eta cos(3E) cos(omega) - 72 sin(E) sin(omega) - 8 sin(3E) sin(omega))/(64 eta n)] + A B C [5
  (36 e^4 sin(E) cos(omega) + 8 e^4 sin(3E) cos(omega) + 24 e^3 eta sin(omega) cos(2E) - 24 e^3 sin(2E) cos(omega) -
  3 e^3 sin(4E) cos(omega) - 144 e^2 eta sin(omega) cos(E) - 16 e^2 eta sin(omega) cos(3E) - 60 e^2 sin(E)
  cos(omega) + 60 e eta sin(omega) cos(2E) + 3 e eta sin(omega) cos(4E) + 24 e sin(2E) cos(omega) + 3 e sin(4E)
  cos(omega) - 24 eta sin(omega) cos(E) - 8 eta sin(omega) cos(3E) + 24 sin(E) cos(omega) - 8 sin(3E)
  cos(omega))/(32 eta n)] + B^2 C [5 (36 e^4 sin(E) sin(omega) + 8 e^4 sin(3E) sin(omega) + 24 e^3 eta sin(E)^4
  cos(omega) - 9 e^3 eta cos(omega) - 24 e^3 sin(2E) sin(omega) - 3 e^3 sin(4E) sin(omega) - 24 e^2 eta cos(E)
  cos(omega) - 8 e^2 eta cos(3E) cos(omega) - 60 e^2 sin(E) sin(omega) - 24 e eta sin(E)^4 cos(omega) - 48 e eta
  sin(E)^2 cos(omega) + 33 e eta cos(omega) + 24 e sin(2E) sin(omega) + 3 e sin(4E) sin(omega) - 72 eta cos(E)
  cos(omega) + 8 eta cos(3E) cos(omega) + 24 sin(E) sin(omega) - 8 sin(3E) sin(omega))/(64 eta n)] + C [-(-108 e^4
  sin(E) sin(omega) + 8 e^4 sin(3E) sin(omega) + 12 e^3 eta cos(2E) cos(omega) + 3 e^3 eta cos(4E) cos(omega) - 96
  e^3 sin(2E) sin(omega) - 3 e^3 sin(4E) sin(omega) - 72 e^2 eta cos(E) cos(omega) - 24 e^2 eta cos(3E) cos(omega) +
  264 e^2 sin(E) sin(omega) + 24 e^2 sin(3E) sin(omega) + 72 e eta cos(2E) cos(omega) - 72 e sin(2E) sin(omega) - 96
  eta cos(E) cos(omega) + 96 sin(E) sin(omega))/(64 eta n)]

**Delta lambda** = C2 [ Q2 ] + C3 [ Q3 ], with
- Q2 = A^2 [-(60 e^3 eta sin(E) + 84 e^3 sin(E) + 42 e^2 eta sin(2E) + 42 e^2 sin(2E) - 159 e eta sin(E) - 9 e eta
  sin(3E) - 189 e sin(E) - 7 e sin(3E) + 21 eta sin(2E) + 21 sin(2E))/(8 n (eta + 1))] + A B [(3 e^4 cos(2E) - 33
  e^3 cos(E) + e^3 cos(3E) + 21 e^2 eta^2 cos(2E) + 21 e^2 eta cos(2E) + 3 e^2 cos(2E) - 105 e eta^2 cos(E) - 7 e
  eta^2 cos(3E) - 105 e eta cos(E) - 7 e eta cos(3E) + 18 e cos(E) - 2 e cos(3E) + 21 eta^2 cos(2E) + 21 eta
  cos(2E))/(4 n (eta + 1))] + B^2 [(9 e^3 eta sin(E) + 7 e^3 eta sin(3E) + 21 e^3 sin(E) + 7 e^3 sin(3E) - 15 e^2
  eta sin(2E) - 21 e^2 sin(2E) - 15 e eta sin(E) - 9 e eta sin(3E) - 21 e sin(E) - 7 e sin(3E) + 21 eta sin(2E) + 21
  sin(2E))/(8 n (eta + 1))] + A C [(24 e^3 sin(E) sin(omega) + 12 e^2 eta sin(E)^2 cos(omega) - 6 e^2 eta cos(omega)
  + 6 e^2 cos(2E - omega) - 6 e^2 cos(2E + omega) + 30 e eta cos(E) cos(omega) + 2 e eta cos(3E) cos(omega) - 54 e
  sin(E) sin(omega) - 2 e sin(3E) sin(omega) + 12 eta sin(E)^2 cos(omega) - 6 eta cos(omega) + 3 cos(2E - omega) - 3
  cos(2E + omega)) sin(i)/(8 eta n (cos(i) + 1))] + B C [-(6 e^3 sin(E) cos(omega) + 2 e^3 sin(3E) cos(omega) - 12
  e^2 eta sin(E)^2 sin(omega) + 6 e^2 eta sin(omega) - 3 e^2 sin(2E - omega) - 3 e^2 sin(2E + omega) - 30 e eta
  sin(omega) cos(E) - 2 e eta sin(omega) cos(3E) - 6 e sin(E) cos(omega) - 2 e sin(3E) cos(omega) - 12 eta sin(E)^2
  sin(omega) + 6 eta sin(omega) + 3 sin(2E - omega) + 3 sin(2E + omega)) sin(i)/(8 eta n (cos(i) + 1))] + [-e (-51
  e^2 eta sin(E) + 7 e^2 eta sin(3E) - 63 e^2 sin(E) + 7 e^2 sin(3E) - 57 e eta sin(2E) - 63 e sin(2E) + 144 eta
  sin(E) + 168 sin(E))/(24 n (eta + 1))]
- Q3 = A^3 [5 (144 e^4 eta sin(E) + 288 e^4 sin(E) + 120 e^3 eta sin(2E) + 144 e^3 sin(2E) - 396 e^2 eta sin(E) - 56
  e^2 eta sin(3E) - 648 e^2 sin(E) - 48 e^2 sin(3E) + 168 e eta sin(2E) + 9 e eta sin(4E) + 192 e sin(2E) + 6 e
  sin(4E) - 144 eta sin(E) - 16 eta sin(3E) - 144 sin(E) - 16 sin(3E))/(64 n (eta + 1))] + A^2 B [-15 (16 e^5
  cos(2E) - 160 e^4 cos(E) + 48 e^3 eta^2 cos(2E) + 48 e^3 eta cos(2E) + 32 e^3 cos(2E) - 2 e^3 cos(4E) - 288 e^2
  eta^2 cos(E) - 32 e^2 eta^2 cos(3E) - 288 e^2 eta cos(E) - 32 e^2 eta cos(3E) + 104 e^2 cos(E) - 8 e^2 cos(3E) +
  120 e eta^2 cos(2E) + 6 e eta^2 cos(4E) + 120 e eta cos(2E) + 6 e eta cos(4E) - 20 e cos(2E) + 3 e cos(4E) - 48
  eta^2 cos(E) - 16 eta^2 cos(3E) - 48 eta cos(E) - 16 eta cos(3E))/(64 n (eta + 1))] + A B^2 [-5 (60 e^4 eta sin(E)
  + 40 e^4 eta sin(3E) + 216 e^4 sin(E) + 48 e^4 sin(3E) - 48 e^3 eta sin(2E) - 21 e^3 eta sin(4E) - 144 e^3 sin(2E)
  - 18 e^3 sin(4E) - 228 e^2 eta sin(E) - 24 e^2 eta sin(3E) - 360 e^2 sin(E) + 96 e eta sin(2E) + 27 e eta sin(4E)
  + 144 e sin(2E) + 18 e sin(4E) + 144 eta sin(E) - 48 eta sin(3E) + 144 sin(E) - 48 sin(3E))/(64 n (eta + 1))] +
  B^3 [5 (e - 1) (e + 1) (-72 e^2 cos(E) + 8 e^2 cos(3E) - 48 e eta^2 sin(E)^4 + 18 e eta^2 - 48 e eta sin(E)^4 + 18
  e eta + 12 e cos(2E) - 3 e cos(4E) - 144 eta^2 cos(E) + 16 eta^2 cos(3E) - 144 eta cos(E) + 16 eta cos(3E))/(64 n
  (eta + 1))] + A^2 C [-5 (144 e^4 sin(E) sin(omega) + 48 e^3 eta sin(E)^2 cos(omega) - 24 e^3 eta cos(omega) + 36
  e^3 cos(2E - omega) - 36 e^3 cos(2E + omega) + 48 e^2 eta cos(E) cos(omega) + 16 e^2 eta cos(3E) cos(omega) - 324
  e^2 sin(E) sin(omega) - 24 e^2 sin(3E) sin(omega) - 24 e eta sin(E)^4 cos(omega) + 96 e eta sin(E)^2 cos(omega) -
  39 e eta cos(omega) - 24 e sin(E)^3 sin(omega) cos(E) + 51 e cos(2E - omega) - 51 e cos(2E + omega) + 24 eta
  cos(E) cos(omega) + 8 eta cos(3E) cos(omega) - 72 sin(E) sin(omega) - 8 sin(3E) sin(omega)) sin(i)/(64 eta n
  (cos(i) + 1))] + A B C [5 (36 e^4 sin(E) cos(omega) + 8 e^4 sin(3E) cos(omega) - 48 e^3 eta sin(E)^2 sin(omega) +
  24 e^3 eta sin(omega) + 24 e^3 sin(E)^3 cos(E) cos(omega) - 15 e^3 sin(2E - omega) - 15 e^3 sin(2E + omega) - 144
  e^2 eta sin(omega) cos(E) - 16 e^2 eta sin(omega) cos(3E) - 60 e^2 sin(E) cos(omega) + 24 e eta sin(E)^4
  sin(omega) - 144 e eta sin(E)^2 sin(omega) + 63 e eta sin(omega) - 24 e sin(E)^3 cos(E) cos(omega) + 15 e sin(2E -
  omega) + 15 e sin(2E + omega) - 24 eta sin(omega) cos(E) - 8 eta sin(omega) cos(3E) + 24 sin(E) cos(omega) - 8
  sin(3E) cos(omega)) sin(i)/(32 eta n (cos(i) + 1))] + B^2 C [5 (36 e^4 sin(E) sin(omega) + 8 e^4 sin(3E)
  sin(omega) + 24 e^3 eta sin(E)^4 cos(omega) - 9 e^3 eta cos(omega) + 24 e^3 sin(E)^3 sin(omega) cos(E) - 15 e^3
  cos(2E - omega) + 15 e^3 cos(2E + omega) - 24 e^2 eta cos(E) cos(omega) - 8 e^2 eta cos(3E) cos(omega) - 60 e^2
  sin(E) sin(omega) - 24 e eta sin(E)^4 cos(omega) - 48 e eta sin(E)^2 cos(omega) + 33 e eta cos(omega) - 24 e
  sin(E)^3 sin(omega) cos(E) + 15 e cos(2E - omega) - 15 e cos(2E + omega) - 72 eta cos(E) cos(omega) + 8 eta
  cos(3E) cos(omega) + 24 sin(E) sin(omega) - 8 sin(3E) sin(omega)) sin(i)/(64 eta n (cos(i) + 1))] + A [(-372 e^4
  eta sin(E) + 40 e^4 eta sin(3E) - 648 e^4 sin(E) + 48 e^4 sin(3E) - 408 e^3 eta sin(2E) - 21 e^3 eta sin(4E) - 576
  e^3 sin(2E) - 18 e^3 sin(4E) + 960 e^2 eta sin(E) + 144 e^2 eta sin(3E) + 1584 e^2 sin(E) + 144 e^2 sin(3E) - 408
  e eta sin(2E) - 432 e sin(2E) + 576 eta sin(E) + 576 sin(E))/(64 n (eta + 1))] + B [3 (16 e^5 cos(2E) - 88 e^4
  cos(E) - 8 e^4 cos(3E) + 24 e^3 eta^2 cos(2E) + 6 e^3 eta^2 cos(4E) + 24 e^3 eta cos(2E) + 6 e^3 eta cos(4E) + 20
  e^3 cos(2E) + e^3 cos(4E) - 144 e^2 eta^2 cos(E) - 48 e^2 eta^2 cos(3E) - 144 e^2 eta cos(E) - 48 e^2 eta cos(3E)
  + 32 e^2 cos(E) + 144 e eta^2 cos(2E) + 144 e eta cos(2E) - 8 e cos(2E) - 192 eta^2 cos(E) - 192 eta cos(E))/(64 n
  (eta + 1))] + C [-(-108 e^4 sin(E) sin(omega) + 8 e^4 sin(3E) sin(omega) + 24 e^3 eta sin(E)^4 cos(omega) - 48 e^3
  eta sin(E)^2 cos(omega) + 15 e^3 eta cos(omega) + 24 e^3 sin(E)^3 sin(omega) cos(E) - 51 e^3 cos(2E - omega) + 51
  e^3 cos(2E + omega) - 72 e^2 eta cos(E) cos(omega) - 24 e^2 eta cos(3E) cos(omega) + 264 e^2 sin(E) sin(omega) +
  24 e^2 sin(3E) sin(omega) - 144 e eta sin(E)^2 cos(omega) + 72 e eta cos(omega) - 36 e cos(2E - omega) + 36 e
  cos(2E + omega) - 96 eta cos(E) cos(omega) + 96 sin(E) sin(omega)) sin(i)/(64 eta n (cos(i) + 1))]

**AP: the quadrature form.** AP (16.1) replaces these corrections with the first-order short-period terms of each
body's tidal terms of degree 2 to 10 (16.8's acceleration), computed by quadrature: for each equinoctial element, the
Gauss rate on the mean orbit at the 32 eccentric longitudes F_j = 2 pi j / 32, less its average over the mean
longitude, times r/a (d lambda = (r/a) dF), is integrated in F through its trigonometric interpolant (a table of the
nodes' cosines and sines) and divided by n, the constant chosen so that the term averages to zero over the mean
longitude; lambda also takes 1/n times the integral of the mean motion's own term. Each body is held at its
output-time position. Against a numerical integration over one orbit (two-body plus the same tidal terms, the bodies
fixed, RK4 in 128,000 steps) at n 2.0059 rev/day, e 0.05, 0.3 and 0.72, in 16.8's three orientations, every element
agrees within 0.10 m RMS for degrees 2 and 3 and for 2 to 10. The closed form above is off by up to 298.2 m in the
mean longitude (G1, e 0.72), 110.6 m in a_f (G2, e 0.72) and 12 m at e 0.05. Most of the mean-longitude error is a
constant over the orbit: the closed form averages to zero over the eccentric anomaly, while the rates of 5 average
over the mean longitude; less its own mean, it is still off by up to 103 m in a_f and 26 m in lambda. The averaged
rates of 5 agree with the quadrature average within 0.001 m per day and are unchanged.
`test/third-body-short-period-eccentric.e2e.mjs` checks these numbers.

**Long-period regime (epoch period 1100 min or more).** The output-time third-body periodic terms are not added;
instead the rates are evaluated from the instantaneous geometry: at each stage the satellite position is computed
from the current equinoctial elements (equinoctial Kepler equation lambda = F + a_g cos F - a_f sin F, solved by a
Halley-type iteration of at most 25 steps) and the third-body accelerations enter the Gauss equations directly,
with the 95-minute step resolving the orbit *[study; probe 9.2]*.

## 6. Resonances

**Model.** Tesseral resonance terms for commensurabilities of the mean motion with Earth rotation enter the rates
through Kaula's disturbing function, restricted to the resonant terms of a class (6.1) and differentiated through
Lagrange's planetary equations (6.3). The tesseral coefficients are the full-precision EGM-96 values (6.2); the
inclination and eccentricity functions are Kaula's F_lmp(i) and G_lpq(e) (6.4) *[doc: release notes 8.0 item 2;
lit: Kaula 1966, ch. 3; Hujsak 1979; study; probe 6.3, 6.4]*:

| regime | commensurability | heritage |
| --- | --- | --- |
| 1 day (GEO) | n ~ 1 rev/day | SGP4 synchronous resonance (Hujsak 1979), extended |
| 0.5 day (GPS, Molniya and other half-day orbits) | n ~ 2 rev/day | SGP4 half-day resonance, now all eccentricities |
| 16 h | n ~ 1.5 rev/day | new in XP |
| 8 h | n ~ 3 rev/day | new in XP |

Release notes 9.0 record a corrected geosynchronous resonance computation; release notes 9.1 the switch to
full-precision tesserals ("using an older version of the propagator with TLEs built with the newer version ... will
sometimes give very inaccurate results"); the 9.1 JIRA records that 18 per-harmonic routines became one general
harmonic routine *[doc]*. The 9.9 oracle confirms the 9.1.1.0 study of this section wherever an effect is measurable
(6.5).

Above the eccentricity switch AP carries the resonances 1:1, 2:1, 3:1 and 3:2 only; every other commensurability is absent:
0.5 to 1.8 km a week on a transfer orbit. On a transfer orbit of 600 x 35,786 km (2.2535 rev/day; 4n = 9.014, 9 omega_E =
9.025) after a 72 h fit with the same forces on both sides, the day-7 error is 485 m with a 12 x 12 field, 58 m with order 9
removed from the truth, and 1.5 to 1.8 km with the full field; a one-day orbit at e 0.82 is 3.65 km at degree 12 against 0.56 km
at degree 4.

**Bands.** The resonance class is decided once, at initialization, from the epoch mean motion n_0 in rad/min (the
element set's mean motion in rev/day times 2 pi / 1440), tested in this order *[study; probe 6.2, 6.10]*:

| class | condition on n_0 (rad/min) | rev/day | period (min) |
| --- | --- | --- | --- |
| 1 day | 0.0035003818 < n_0 < 0.0052505727 | 0.8022284153 - 1.2033426229 | 1196.67 - 1795.00 |
| 0.5 day | 0.0070007636 <= n_0 <= 0.0105011454 | 1.6044568306 - 2.4066852459 | 598.33 - 897.50 |
| 8 h | 0.0105011454 < n_0 <= 0.015751718 | 2.4066852459 - 3.6100278459 | 398.89 - 598.33 |
| 16 h | 0.0052505727 <= n_0 <= 0.007875859 and not 0.5 day, so in effect n_0 < 0.0070007636 | 1.2033426229 - 1.6044568306 | 897.50 - 1196.67 |
| none | otherwise | | |

The six limits are exactly these decimal constants: 0.8, 1.2, 1.6, 2.4, 3.6 and 1.8 times 2 pi / 1436 rad/min, each
rounded to eight significant digits (periods 1795, 1196.67, 897.5, 598.33, 398.89 and 797.78 min). The 16 h upper
limit, 0.007875859 rad/min (1.8050139230 rev/day), lies inside the 0.5-day band and never decides a class.
Inside a band the class's terms are always summed, whether or not the orbit is close to exact commensurability. The
class is held for the whole propagation: when drag carries n out of its band, every rate evaluation of the
integrator still sums the epoch class's terms, and a set outside every band at the epoch never gains terms
*[study; probe 6.10: two decaying sets, of the 0.5-day and the 8 h class, whose n crosses 2.4066852459 and
3.6100278459 rev/day near day 2. From each library node, one step of 9 with the epoch class and F, G at e_0, i_0
reproduces the change of n to the next node to 1e-7 of that change, before and after the crossing; with the class
and F, G of the current elements it misses by up to 4e-3 after the crossing, and with no resonance terms by 6e-4
to 3e-3 throughout]*. A native-element report is different: it re-initializes the set at the requested time (1.5), so its rates
take the class of the mean motion at that time *[probe 6.9]*.
AP holds its class the same way, with its rate and output tables of the epoch class for the whole flight (16.7).

The legacy SGP4 bands (synchronous for 0.0034906585 < n < 0.0052359877 rad/min; half-day for 8.26e-3 <= n <= 9.24e-3
and e >= 0.5) are not used for type 4.

### 6.1 Resonant terms per class

AP adds the half-day terms of degrees 6 through min(d, 31), for every even order m and p = 0..l,
with k = m/2 and q = k - l + 2p (16.2). SGP4XP keeps the class table below.
Against FFM model truth after a 72 h fit, day-1/3/7 3D errors in meters at 0.4.15 are 27.5/70.0/60.1
for the half-day fixture, 45.9/27.0/419.4 for Molniya with drag (its fitted drag coefficient, 16.11), 115.3/79.2/244.3
for GTO, and 22.2/61.4/56.4 for the 55-degree fixture (16.11). Section 16.6 defines the fixtures and signed RTN errors.

A term is labeled (l, m, p, q). Its resonant angle is

    psi_lmpq = (l - 2p) omega + (l - 2p + q) M + m (Omega - theta_G(t)),   theta_G(t) = theta_G(epoch) + omega_E t

(theta_G(epoch) and omega_E as in 1.2), and the class fixes the multiplier k = l - 2p + q of M through
k n ~ m omega_E, so that q = k - l + 2p. The library sums exactly these terms and no others *[study; probe 6.3,
6.4]*:

| class | k | (l, m) with the p used | q | terms |
| --- | --- | --- | --- | --- |
| 1 day | m | (2,2) p = 0-2; (3,1) 0-3; (3,2) 0-2; (3,3) 0-2; (4,1) 0-3; (4,2) 0-3; (4,3) 0-2; (4,4) 0-2 | abs(q) <= 4 | 27 |
| 0.5 day | m/2 | (2,2), (3,2), (4,2), (4,4), (5,2), (5,4), each with every p = 0 to l | -4 to 7 | 29 |
| 8 h | 1 (m = 3) | (3,3) p = 0-3; (4,3) 0-4; (5,3) 0-4; (6,3) 1-5 | -4 <= q <= 5 | 19 |
| 16 h | 2 (m = 3) | (3,3) p = 0-3; (4,3) 0-4; (5,3) 0-4; (6,3) 0-5 | q <= 6 | 20 |

For example the 0.5-day terms of (2,2) are (2,2,0,-1), (2,2,1,1) and (2,2,2,3), with the angles
2 omega + M + 2 (Omega - theta_G), M + 2 (Omega - theta_G) and -2 omega + M + 2 (Omega - theta_G). Degrees run from
2 to 6; there is no (2,1) term.

### 6.2 Tesseral coefficients

Unnormalized EGM-96 values (Lemoine et al. 1998: the normalized coefficients times
N_lm = sqrt((2 - delta_0m)(2l + 1)(l - m)! / (l + m)!)), dimensionless *[study; lit]*:

| coefficient | C_lm | S_lm |
| --- | --- | --- |
| (2,2) | 1.57446037456404e-6 | -9.03803806638557e-7 |
| (3,1) | 2.19263852916859e-6 | 2.68424890296779e-7 |
| (3,2) | 3.08989206880511e-7 | -2.11437612437343e-7 |
| (3,3) | 1.00548778064384e-7 | 1.97222559005906e-7 |
| (4,1) | -5.08799360403833e-7 | -4.49144872839336e-7 |
| (4,2) | 7.84175859843762e-8 | 1.48177868295612e-7 |
| (4,3) | 5.92099402629132e-8 | -1.20077667633627e-8 |
| (4,4) | -3.98407411766274e-9 | 6.52571425370430e-9 |
| (5,2) | 1.05587168390898e-7 | -5.23291936216342e-8 |
| (5,3) | -1.49300637492288e-8 | -7.09734236889537e-9 |
| (5,4) | -2.29930029012696e-9 | 3.86712335850938e-10 |
| (6,3) | 1.18542072651316e-9 | 1.87163685038141e-10 |

### 6.3 Disturbing function and rates

In the canonical units of 1.4 (Earth radii and minutes; mu = k_e^2, equal to n^2 a^3 with a = (k_e / n)^(2/3)), the
resonant disturbing function of a class is the sum over its terms (6.1)

    R = sum of (mu / a^(l+1)) F_lmp G_lpq S_lmpq,
    S_lmpq = C_lm cos psi_lmpq + S_lm sin psi_lmpq      for l - m even,
    S_lmpq = -S_lm cos psi_lmpq + C_lm sin psi_lmpq     for l - m odd

(Kaula 1966, ch. 3). Its partial derivatives are taken term by term: d/dM, d/domega and d/dOmega act on psi only
(factors k, l - 2p and m), d/de on G_lpq only (giving dG_lpq/de), d/di on F_lmp only (dF_lmp/di), and
dR/da = -(l + 1) R_lmpq / a. The rates are Lagrange's planetary equations (Kaula 1966, ch. 3; Brouwer and Clemence
1961), with eta = sqrt(1 - e^2):

    da/dt     = 2 / (n a) dR/dM
    de/dt     = eta^2 / (n a^2 e) dR/dM - eta / (n a^2 e) dR/domega
    di/dt     = (cos i dR/domega - dR/dOmega) / (n a^2 eta sin i)
    domega/dt = -cos i / (n a^2 eta sin i) dR/di + eta / (n a^2 e) dR/de
    dOmega/dt = dR/di / (n a^2 eta sin i)
    dM/dt - n = -eta^2 / (n a^2 e) dR/de - 2 / (n a) dR/da

They are added to the six-component rate set of section 2 as

    n-dot += -(3 n / (2 a)) da/dt,   e-dot += de/dt,   i-dot += di/dt,
    e varpi-dot += e (domega/dt + dOmega/dt),   sin i Omega-dot += sin i dOmega/dt,
    lambda-dot - n += (dM/dt - n) + domega/dt + dOmega/dt

*[study: the library's six resonance rates equal these, symbolically in all inputs, to 1e-15 for every class;
probe 6.3, 6.4]*.

The four function values of each term, F_lmp, dF_lmp/di, G_lpq and dG_lpq/de, are computed once, at initialization,
from the epoch mean elements i_0 and e_0, and held for the whole propagation. Every other quantity in the equations
(a, n, e, eta, cos i, sin i, M, omega, Omega and theta_G(t) = theta_G(epoch) + omega_E t) follows the state being
evaluated *[study; probe 6.8: from each of the 8 library nodes of six 0.5-day HEO sets with AGOM and B zero, one
step of 9 with F and G at e_0, i_0 reproduces the library's change of n to the next node to 4e-9 of that change;
with F and G at the current e and i it misses by 3e-4 to 4e-2]*. The rates of a native-element report at time t are
those of a fresh initialization at t (1.5): F and G at e(t), i(t) and theta_G from 1.2 at t. Because theta_G of 1.2
advances at (C1 + 2 pi) per day, 4.25e-10 rad/min faster than omega_E, the report's resonance angles lead the
integrator's by 6.1e-7 rad per day since the epoch *[probe 6.8: the reported n-dot is reproduced to 1e-13 of its
largest value as a fresh initialization at t; with theta_G(epoch) + omega_E t and F, G at e(t), i(t) to 7e-6; with
F, G at e_0, i_0 to 3e-4 to 2e-3]*.
The terms are the same in the averaged and in the long-period regime (5, 9), and no resonance term
enters the output-time corrections (8) *[study]*.

### 6.4 Inclination and eccentricity functions

**Inclination functions.** F_lmp(i) is Kaula's closed form (Kaula 1966, ch. 3), with k = floor((l - m) / 2):

    F_lmp(i) = sum over t = 0 .. min(p, k) of
               (2l - 2t)! / (t! (l - t)! (l - m - 2t)! 2^(2l - 2t)) sin^(l - m - 2t) i
               x sum over s = 0 .. m of binom(m, s) cos^s i
                 x sum over c of binom(l - m - 2t + s, c) binom(m - s, p - t - c) (-1)^(c - k),

c running over the integers for which both binomial coefficients are defined. The library's F_lmp agree with this to
1e-12 *[study]*. dF_lmp/di is the exact derivative of F_lmp, with one exception *[study; probe 6.3]*: for
(l, m, p) = (6, 3, 2), which occurs in the 8 h and 16 h classes, the library uses in its place, with c = cos i and
s = sin i,

    D_632(i) = (259875 c^6 + 259875 c^5 - 390285 c^4 - 372330 c^3 + 155925 c^2 + 127575 c - 10395) / 128
               - (2835 / 8) s c (1 + c),

whereas the derivative is (311850 c^6 + 259875 c^5 - 448875 c^4 - 326970 c^3 + 162540 c^2 + 82215 c - 10395) / 128
(at i = 0.9 rad: D_632 = -119.140, the derivative 0.562).

**Eccentricity functions.** G_lpq(e) is the Hansen coefficient X^{-(l+1), l-2p}_{l-2p+q}(e) (Kaula 1966, ch. 3;
G_lpq = G_l,l-p,-q):

    G_lpq(e) = (1 / 2 pi) integral over M from 0 to 2 pi of (a / r)^(l+1) cos((l - 2p) f - (l - 2p + q) M) dM.

The library uses its Maclaurin polynomial in e, the terms e^|q|, e^(|q|+2), ... up to e^26 for even q and e^27 for
odd q, and for dG_lpq/de the derivative of that polynomial *[study; probe 6.3]*. The polynomial, not the function, is
the model. The Laplace limit e = 0.6627 concerns a Maclaurin expansion about e = 0 (Brouwer and Clemence 1961),
not an eccentricity cutoff for the Hansen integral or a bound on a finite polynomial's truncation error.
The library evaluates the finite polynomial at every e, with no closed form and no other expansion
*[probe 6.3: at e = 0.7 the library's n-dot matches the polynomials to 4e-14 and the closed-form functions only to
7.5e-4]*. Each term of 6.1 takes the G_lpq of its own (l, p, q): the 0.5-day class has no k = 0 term (no G_20,-2,
for example), and the 16 h term (4,3,1,0) uses G_410. The library's coefficients agree with the exact Maclaurin coefficients to 2e-8 relative, with these
exceptions *[study; probe 6.3, 6.5, 6.6]*:

- 16 h class, G_410: the coefficient of e^2 is 2 instead of 1. The derivative used with it is that of the exact
  polynomial (2e + ...).
- 16 h class, dG_40,-2/de: the e^13 and e^15 terms are absent.
- Series with abs(q) = 1: the coefficient of e^27 is c_27 - 2 c_1 b_27 in place of the exact c_27, where c_1 is the
  series' e^1 coefficient and b_27 = C_13 / 2^27 = 742900 / 134217728 = 0.005535036325454712 is the e^27 coefficient
  of beta = e / (1 + sqrt(1 - e^2)) = sum over k >= 0 of C_k e^(2k+1) / 2^(2k+1) (C_k the Catalan numbers): the
  polynomials are those of an expansion in beta whose series stopped after its e^25 term. The c_1 are -1/2, 3/2, -1,
  3, -3/2, 1/2, 9/2, 5/2, 0, 4, 3/2 and 7/2 for G_20,-1, G_211, G_30,-1, G_311, G_40,-1, G_41,-1, G_411, G_421,
  G_51,-1, G_521, G_62,-1 and G_631 (so G_51,-1 is exact). The derivative series is the derivative of this
  polynomial, with e^26 coefficient 27 (c_27 - 2 c_1 b_27). The rule reproduces every such library coefficient to
  1e-9 relative.
- 1 day class, G_30,-1: the polynomial ends at e^25, while its derivative series also has the e^26 term
  27 (c_27 + 2 b_27) e^26 = 0.5751355376693 e^26 (c_27 the exact e^27 coefficient of G_30,-1, whose c_1 is -1): the
  derivative of the polynomial through e^27 of the previous item, as the 16 h class uses it.

**AP eccentricity approximation.** Section 16.2 uses the corrected Maclaurin coefficients below
`kSeriesE = 0.3`. When the expansion center satisfies e0 >= 0.3 and e0 + 0.001 < 1, the original
resonance terms use the Hansen integral at e0 and a third-order Taylor expansion in de = e - e0 for
current e >= 0.3; otherwise they use the corrected Maclaurin polynomial. They are exact at the
epoch eccentricity to the numerical integral's precision, third order within |de| <= 0.02. The measured
per-term relative truncation errors reported on 2026-11-02 are 1.1e-4 at |de| = 0.01, 1.5e-3 at 0.02,
and 4-15% at 0.05. These are measured errors, not uniform bounds over all terms or eccentricities.
The stated approximation range is |de| <= 0.02; it is not an enforced propagation-refusal condition.
The epoch class expands about epoch e0 for the whole flight (16.7).
The added high-degree half-day tail has its own quadrature and cubic tables described in 16.2.

### 6.5 Checks against the oracle

*[probe 6.3]* Averaged regime (0.5 day, 8 h and 16 h classes; 16 vectors, e = 0.01 to 0.7), drag and SRP off. The
zonal (2) and averaged third-body (5) rates have no n-dot, so the n-dot of the six-rate set is the resonance alone.
The equations of 6.3 with the library's function values reproduce it to 2e-12 relative in every vector, and so do
exact Maclaurin coefficients with the exceptions of 6.4; with exact e^27 coefficients instead, the agreement is only
2e-8 for e <= 0.6 and 5e-7 at e = 0.7. Without the G_410 exception the 16 h n-dot is off by 1e-4 (e = 0.01) to
100 % (e = 0.5). The other five rates equal the library's
minus the zonal and third-body rates to within that subtraction's own accuracy (3e-13 per minute), and the 8 h
class's sin i Omega-dot needs D_632 (without it 2e-3 relative off at e = 0.5).

*[probe 6.4]* 1-day class, always in the long-period regime, where the third body enters through the instantaneous
geometry (5). For fixed elements at 24 epochs over one sidereal day, the library's n-dot minus the n-dot of 6.3 is a
smooth function of the epoch: a degree-8 polynomial fit leaves 8e-22 rad/min^2 RMS, against 8e-13 for the library's
n-dot alone and a resonance n-dot amplitude of 1.6e-11 rad/min^2. The theta_G harmonics of the 1-day terms are
reproduced to about 5e-11 relative.

*[probe 6.5]* High eccentricity, averaged regime (0.5 day at e = 0.72 and 0.74, 16 h at 0.75 and 0.78, 8 h at 0.62
and 0.66): with the exceptions of 6.4 the n-dot is reproduced to 5e-13 relative; with exact e^27 coefficients the
error is 7e-7 to 6e-6.

*[probe 6.6]* 1-day class at e = 0.73 and 0.8, fixed elements at 24 epochs over one sidereal day: the library's
lambda-dot minus that of 6.3 is smooth in the epoch (degree-8 fit residual 4e-19 and 6e-19 rad/min RMS) with the
e^26 term of dG_30,-1/de, and not without it (1e-17 and 3e-16).

*[probe 6.2]* The class changes exactly at the limits above. At each of the five limits that decide a class, the
two element sets that straddle it (mean motions 1e-8 rev/day apart, the element-set resolution) have n-dots that
differ by 10^6 to 10^8 times the step between neighbors on the same side (across 2.4066852459 rev/day n-dot changes
sign); across 0.007875859 rad/min nothing changes. Between two element sets on either side of a limit the class
therefore makes a discontinuity in the rates; along one propagation the class does not change (Bands). The
section-6 vectors scan n through each commensurability; the lambda-dot and n-dot response gives the strength of each
harmonic.

*[probe 6.8]* Six 0.5-day HEO sets with AGOM and B zero, where n-dot is the resonance alone: native reports every
3 hours for 7 days and at the first 9 integrator nodes (t_k+1 = t_k + 4 pi / n_k, n_k reported at node k). The
integration follows F and G at e_0, i_0 (6.3: each node-to-node change of n to 4e-9 of that change, against 3e-4 to
4e-2 with F and G at the current e and i), and the reported rates are those of a fresh initialization at each
time (1.5: the reported n-dot to 1e-13 of its largest value).

*[probe 6.9]* Ten decaying 0.5-day sets (AGOM 0, perigees 66 to 103 km) whose n rises into the 8 h band, and for
several past 3.61 rev/day, within a day: reports every hour for 7 days. Their elements follow the integrator with
the epoch class; their rates take the class and F, G of the elements at each time (1.5), with the drag of 3.3 and
3.4.

*[probe 6.10]* Two decaying sets (AGOM 0, perigees 130 and 140 km), of the 0.5-day and the 8 h class, whose n
crosses 2.4066852459 and 3.6100278459 rev/day near day 2; the first 9 integrator nodes with their reports, reports
every hour and states every 6 hours for 7 days. They separate the integrator's epoch class from the class of the
reports (Bands): after the crossing the reported rates switch class, the node-to-node steps do not.

**AP and the 12-hour class.** XP's averaged lunisolar rates (5) stop at Legendre degree 3; AP adds degrees 4 to 10
for epoch periods below 1100 min and epoch eccentricities below 0.1 (16.8). This class's degree-2 terms (the resonant
table of 6.1, the m-daily and the short-period terms of 16.2) reproduce a numerical reference (EGM96 J2 and J22, no
third bodies, an Etalon-like orbit at 2.13 rev/day) within 0.3 m cross-track and 0.9 m along-track at day 7 once the
fitted set keeps its full precision (16.9): the cross-track floor and the node-dependent errors first attributed to
them were the two-line lattice of the fitted set.

## 7. Very deep space (VDS) / cislunar region

**Model.** "The Very Deep Space / cislunar region is added for multiday orbits" *[doc: release notes 8.0 item 7]*.
The library divides type-4 orbits at an epoch period of 1100 minutes (sections 5, 9): below it, averaged rates with
steps of two periods and analytic output-time lunar-solar periodics; at or above it, rates from the instantaneous
geometry with 95-minute steps and no output-time lunar-solar periodics *[study; probe 9.2]*. Release notes 9.6-9.9
list "add lunar potential and lunar shadow for cislunar propagations" as planned, so 9.9 has neither *[doc]*; the 9.2
JIRA ASTROSTDS-1243 notes the analytic Moon's weakness near the Moon.

The library has no further class: every type-4 orbit with an epoch period of 1100 minutes or more is propagated in
the long-period regime, which is what the release notes call the VDS/cislunar region *[study]*. The section-7
vectors hold states for mean motions 0.9, 0.5, 0.25 and 0.1 rev/day.

## 8. Short-periodics and the osculating output

**Order of operations at the output time** *[study]*:

1. Cubic Hermite interpolation of the mean equinoctial elements between nodes (section 9).
2. Conversion to Keplerian mean elements (angles reduced to [0, 2 pi)); failure if n <= 0 or e >= 1; e < 0 is set
   to 0.
3. Averaged regime only: the Sun and Moon periodic corrections (section 5) are added to the mean elements.
4. With SRP on, in both regimes: the output-time SRP periodic terms of section 4 are added to the equinoctial
   elements, with E the eccentric anomaly of the interpolated mean elements of step 1 and the Sun at the output time
   *[probe 4.3, 4.5]*.
5. Kepler's equation (eccentric anomaly E from M = E - e sin E), true anomaly nu, and the first-order J2
   short-period corrections of Brouwer (1959, section 7), in the arrangement of the SGP4 final step (Hoots &
   Roehrich 1980): corrections to the radius r, the argument of latitude u = omega + nu, the node Omega, the
   inclination i, the radial velocity r-dot and the transverse velocity r f-dot *[lit; study; probe 8.2]*.
6. Position and velocity from the corrected (r, u, Omega, i, r-dot, r f-dot) with the orientation vectors of the
   SGP4 final step, scaled to km and km/s (section 10).

**Refusals** *[study; probe 8.4, 8.5]*. The integrator advances node by node from the epoch (section 9). When a step
fails for good (the tests and the single 90-minute retry of 9), the grid ends at the last good node: the epoch and
every output time up to that node are served, and every later time is refused with the code of the failed test,
4 (eccentricity above 1) or 9 (mean motion not positive); the native elements there carry the same code. A node
whose own rates fail ends the grid the same way. With the first step failing, every time after the epoch is
refused from 1e-6 min on. Strong drag at a low perigee does this: the epoch n-dot is so large that a stage state
leaves the elliptic range.

- Side B's sets 1786, 3850 and 7042 (perigees 56-62 km above the equatorial radius, epoch n-dot 206 to
  553 rev/day^2): the two-period step fails at k2 (e = 4.2 to 12.5). The 90-minute retry fails at k4 for 1786
  (n = -0.40 rev/day, code 9) and 7042 (n = -0.0009 rev/day, code 9); for 3850 its k2 state lies below the ground,
  the 10 km density there (3.3) drives the k3 state to e = 1e4, code 4. Every time after the epoch is refused with
  that code. A 30-minute step would pass for all three (k4 at n = 0.25 to 1.60 rev/day, e < 0.9), but 9.9 has no
  such fallback (9).
- The decaying sets 8788 and 4210 of 6.9 (perigees 66 and 71 km, epoch n-dot 43 and 58 rev/day^2) fail the
  two-period step at k3 (k2 below the ground, k3 at e = 3e4 and 7e4) and pass the 90-minute retry: their first node
  is at 90 min, the next step is two periods at that node's n, and they are served for the 7 days (these steps
  reproduce the library's elements at 90 min and two periods later to 1e-8).
- The 8.4 cases of amendment 5: with a 130 km perigee the first step fails at both lengths (refused from
  1e-6 min); with a 150 km perigee the first two-period step passes (node at 175.24 min) and the second fails at
  both lengths (refused after that node).

**Short-period corrections.** Units R_E and minutes; a = (k_e / n)^(2/3), n the interpolated mean motion
(rad/min), e, i, M, Omega, omega the mean elements after step 3, eta = sqrt(1 - e^2), p = a eta^2,
r = p / (1 + e cos nu), theta = cos i, u = omega + nu, and the abbreviations
c = J2 / (4 p), d = J2 / (4 p^2), Q = (nu - M) + e sin nu with nu - M the equation of the center reduced to
(-pi, pi], n_a = k_e / a^(3/2):

- Delta r = c [ (1 - theta^2) cos 2u - (e cos nu / (1 + eta) + 2 r / (a eta) + 1)(3 theta^2 - 1) ]
- Delta i = d theta sin i [ 3 cos 2u + e (3 cos(2 omega + nu) + cos(2 omega + 3 nu)) ]
- Delta Omega = d theta [ 3 sin 2u - 6 Q + e (3 sin(2 omega + nu) + sin(2 omega + 3 nu)) ]
- Delta u = d [ (1 - eta)(3 theta^2 - 1) sin nu (e / (1 + eta) + cos nu) - 3 (1 - 5 theta^2) Q
  + (1/2)(1 - 7 theta^2) sin 2u + e ((2 - 5 theta^2) sin(2 omega + nu) - theta^2 sin(2 omega + 3 nu)) ]
- Delta r-dot = eta [ -2 c n_a (a/r)^2 (1 - theta^2) sin 2u + c n_a e sin nu (3 theta^2 - 1)((a/r)^2 / (1 + eta)
  + 1/eta^3) ]
- Delta (r f-dot) = eta [ -n_a (a/r)^2 Delta r + n_a (a^2 / r) d sin^2 i (3 cos 2u + e (3 cos(2 omega + nu)
  + cos(2 omega + 3 nu))) ]

with the unperturbed r-dot = n_a a e sin nu / eta and r f-dot = n_a a^2 eta / r. The corrected quantities are
r_k = r + Delta r, u_k = u + Delta u, Omega_k = Omega + Delta Omega, i_k = i + Delta i, and the two velocities plus
their corrections; velocities are converted from R_E/min to km/s by R_E/60. J2 here is the EGM-96 J2 of 1.3.

*[probe 8.2, 8.3]* Confirmed exactly. In the long-period regime (epoch period 1100 min or more) no output-time
Sun/Moon terms are added, so at t = 0 the state is these corrections applied to the element-set values: over 28
cases (n = 1.0027 and 1.3 rev/day, e = 0.0003 to 0.4, i = 0.05 to 63.43 deg, mean anomaly every 45 deg) the
formulas reproduce the library's position to 3e-11 km and velocity to 2e-15 km/s. In the averaged regime the LEO
case (15.2 rev/day, e = 0.001, i = 51.6 deg) is reproduced to 0.6 m (2.4 km without the corrections), the remainder
being the output-time Sun and Moon terms of step 3; at 1.6 rev/day the remainder is 0.15-0.6 km, the size of those
terms there.

**Confirmed.** *[probe 8.1]* The library reports both the mean and the osculating Keplerian elements at each time;
at t = 0 the mean elements are the element-set values and the osculating ones differ by the periodic terms (for
the 15.2 rev/day, e = 0.001, i = 51.6 deg case: osculating a = 6881.0358 km against mean 6883.9776 km, osculating
e = 0.000971, i = 51.5903 deg).

## 9. The internal integrator

**What is integrated.** The six equinoctial elements of 1.5 (with the mean motion carried in rad/min and the angles
in radians) under the rate function of sections 2-7: short-period-averaged rates when the epoch period is below
1100 minutes, rates from the instantaneous third-body geometry at or above it (sections 5, 7) *[probe 1.3: the
native elements and their rates are the library's own observable; study]*.

**Grid.** A fixed grid of nodes anchored at the epoch, built outward from the epoch separately forward (t > 0) and
backward (t < 0). Node 0 is the epoch state with its rates. The step from node k to node k+1 is

- h_k = 4 pi / n_k, two mean periods at the mean motion n_k (rad/min) of node k, for orbits whose epoch period
  2 pi / n_0 is below 1100 minutes;
- h = 95 minutes for orbits whose epoch period is 1100 minutes or more (this class is fixed at initialization).
  AP with a selected gravity replacement and the epoch one-day resonance class uses 38 minutes instead;
  the checkpoint stride uses that same step. Default FORCES retains the 95-minute XP grid.

The grid depends only on the epoch state *[probe 9.1: the library's direct, 1-minute stepped and backward-approach requests
agree to 0 mm]*. An AP state in this module depends on the order of requests: the same record flown in ascending and in random
order differs by up to 12.7 mm at 500 km (median 2.0 mm), 3.8 mm at 830 km, 0.2 mm in medium Earth orbit and 0.27 mm at
geosynchronous altitude; a single state from a fresh record differs from the ascending pass by up to 8.8 mm; over 30 days at
60 s, reversed or shuffled against the ascending pass, test/kernel-cost.mjs --diff measures up to 0.18 m at 300 km (B 6.4e-3
m^2/kg, active weather) and 0.29 m on a low orbit at e 0.05 with tesseral degree 31; on a transfer orbit at e 0.72, 7 days
at 300 s, random against ascending, 0.9 µm. SGP4 differs by 0 in every case. The same build asked the same requests in
the same order writes the same bytes (ascending twice: 0 in every case); a comparison of two builds
(test/kernel-cost.mjs --diff --bound M,MPS) holds the time-order pass to its stated tolerance (0,0 for byte identity)
and prints the reversed and shuffled differences beside it. Out of order AP pays for it: a request outside the cached
bracket integrates from the nearest checkpoint, and in random order an AP state costs 37 to 153 times SGP4's on
near-circular orbits and 1,990 times on the transfer orbit (test/kernel-patterns.mjs order, 7 days at 300 s; 1.2 to
2.5 times ascending). SGP4XP GEO nodes fall on
multiples of 95 minutes *[probe 9.2: native elements between epoch and 95 minutes are reproduced by cubic Hermite
interpolation of the two node values and rates to 1e-8 of their change, against 6e-5 for a 96-minute grid]*.

**Side B cache and query work.** XP/AP retains 12 sparse checkpoints and the latest pair of bracketing
nodes per direction. The ingest-time stride targets roughly eight days each way; checkpoints fill lazily.
A query inside an already cached bracketing interval interpolates without integration. The first distant
query integrates from the epoch through its bracket, creating checkpoints on the way. Once the intervening
checkpoints exist, a query within their span integrates at most one checkpoint interval. Beyond the stored
span it integrates from the nearest preceding retained node, so work grows with the remaining time gap.
The node cache has bounded storage, not a time-independent bound on query work. Request order does not change the epoch-anchored grid; it changes an
AP state by the amounts stated above.

**AP one-day convergence.** The registered unfitted sets have epoch 2026-10-29 00:00 UTC,
n = 1.0027 rev/day, e = 0.0002, i = 0.1 or 15 degrees, node = 40 degrees, argument of perigee = 30 degrees,
M = 20 degrees, B = AGOM = 0 and FORCES (31,20). Against the same module with a 95/16-minute RK3 step,
the measured 3D differences on 2026-11-03 are:

| Inclination | Step (min) | Day 1 (m) | Day 3 (m) | Day 7 (m) |
|---|---:|---:|---:|---:|
| 0.1 degrees | 95 | 12.562 | 35.539 | 72.534 |
| 0.1 degrees | 38 | 0.852 | 2.205 | 4.591 |
| 15 degrees | 95 | 11.121 | 32.048 | 65.087 |
| 15 degrees | 38 | 0.780 | 1.970 | 4.140 |

The 47.5-minute candidate leaves 8.991 and 8.101 m at day 7; 38 minutes is the longest passing step in the
registered set {47.5, 38, 95/3}. A five-day flight of 241 states at 30-minute cadence, including public
`propagate` initialization and output, takes median 11.910 ms versus 10.514 ms at 95 minutes (1.133x),
over nine alternating calls after two warm-ups. These are same-machine synthetic timings, not the
archive fitting workload. Default-FORCES SGP4XP retains its bit-exact conformance digest.
`test/geo-step-convergence.e2e.mjs` asserts day-7 differences below 5 m for both sets and cost below 2x;
`test/results/geo-step-convergence.json` records the measurements.

**Step method.** One explicit Runge-Kutta step per node interval, of third order, with the rates at the start node
as the first stage (they are the node's stored rates). With y0 the start node, f the averaged-rate function, h the
step:

- k1 = f(t0, y0) (stored);
- k2 = f(t0 + (3/8) h, y0 + (3/8) h k1);
- k3 = f(t0 + (9/16) h, y0 + (9/16) h k2), an evaluation whose result does not enter the update;
- k4 = f(t0 + (25/32) h, y0 + h (-(125/672) k1 + (325/336) k2));
- y1 = y0 + h ((37/225) k1 + (44/117) k2 + (448/975) k4), and the new node's rates are f(t0 + h, y1), evaluated
  in the rate function's node mode (the same rates, plus node-only quantities such as the SRP set of section 4).

When the library's partials service is active, seven-element auxiliary integrals are also carried node to node by
the trapezoid rule and interpolated linearly; they do not feed back into the state *[study; probe 9.1]*.

The weights satisfy the order conditions through third order (sum b = 1, sum b c = 1/2, sum b c^2 = 1/3,
b4 a42 c2 = 1/6) and not the fourth (sum b c^3 = 0.2389). The decimal values are -0.18601190476190477,
0.96726190476190477, 0.16444444444444445, 0.37606837606837606, 0.45948717948717949 (study of the compiled library;
the rationals above reproduce them to the last digit). The k3 evaluation only refreshes auxiliary node quantities, which the k4 stage and the new
node's evaluation overwrite; omitting it leaves the state unchanged *[study]*.

**Step control.** No error estimate and no adaptive control *[study; probe 8.4, 8.5]*. Each rate evaluation of a step
(k2, k3 and k4, in that order, and the new node's) first tests the state it is given, converted to Keplerian
elements: an eccentricity above 1 fails with code 4, a mean motion zero or negative with code 9, and, with drag on,
1 - e^2 at or below 1e-12 with code 10. The k3 evaluation, whose rates do not enter the update, is tested like the
others. A NaN passes these tests (they are comparisons). When k2, k3 or k4 fails and the step is longer than
90 minutes, the step is redone once from the same node and rates with 90 minutes (same direction); the node then
lies 90 minutes on, and the step after it is the regular one again (two periods at that node's n). When the
90-minute step fails, or a shorter step fails, or the new node's own rates fail, the integration ends there (8,
Refusals). 9.9 has no further fallback: the 30-minute steps of the 9.1.1.0 build (section 11) are not reached in
9.9.

The step is fixed (95 min in the long-period regime, 38 min in the one-day class) with no error control. It resolves perigee
only for (1 - e)^(3/2) >= 2 pi h / P: e up to 0.44 at 95 min and 0.70 at 38 min on a one-day orbit. Beyond that the theory's
own equations are integrated with a mean-longitude error of 0.2 km a week at e 0.5 and 0.4 to 4.6 km a week at e 0.7 to 0.82 at
95 min, and 0.09 to 0.17 km at e 0.82 at 38 min.

**Output between nodes.** Cubic Hermite interpolation on the bracketing nodes (values and rates), with
q = (t - t_k) / (t_k+1 - t_k): y(t) = (1 + 2q)(1 - q)^2 y_k + q (1 - q)^2 h y'_k + q^2 (3 - 2q) y_k+1 +
q^2 (q - 1) h y'_k+1. If the interpolated mean motion is not positive, linear interpolation of all six elements is
used instead (the "mean motion check for XP interpolator", JIRA ASTROSTDS-1018) *[doc + probe 9.2]*. At a node the
node values are returned unchanged.

**After interpolation** (order of operations): equinoctial to Keplerian mean elements with angles reduced to
[0, 2 pi); Sun and Moon geometry at the output time (section 5); the output-time periodic terms and the
short-period terms (section 8); position and velocity (section 10). Failure codes: mean motion not positive,
eccentricity at or above 1, or an angle beyond 1e10 rad; a negative interpolated eccentricity is set to 0.

## 10. Frames and output

- Output frame: TEME (true equator, mean equinox of date), the same as legacy SGP4 (Vallado et al. 2006,
  section on TEME) *[probe 10.1: the oracle's 9.1.1.0 and 9.9 legs agree; library interface documents]*.
- Units: position km, velocity km/s, scaled with the EGM-96 R_E and k_e of 1.3 *[probe 10.1]*.
- The library also reports geodetic latitude, longitude and height (EGM-96 R_E and the flattening of 1.3, longitude
  from theta_G of 1.2), revolution number, nodal period, apogee and perigee, and the mean and osculating Keplerian
  elements (section 8) *[probe 10.1]*.
- Errors: a nonzero return code marks a refused or decayed propagation; the library tests the mean motion near
  decay before interpolating (JIRA ASTROSTDS-1018) *[doc]*. A mean perigee radius a (1 - e) below 1 R_E is flagged
  as decayed; a failed rate evaluation (for example a non-positive mean motion or e > 1 inside a stage) fails the
  step and triggers the fallbacks of section 9 *[study]*.

---

## 11. 9.1.1.0 (vendored WebAssembly) versus 9.9 (native)

From the JIRAs and release notes between 9.1 and 9.9 the XP-relevant changes are *[doc]*:

- 9.2: JPL Sun/Moon ephemerides made available to XP (used only when loaded; not by the oracle).
- 9.3: shadow quartic made safe for the cube root of a negative number; error handling for NaN cases.
- 9.6: errors from the rate evaluation propagated to its callers.
- 9.9: a new computation of the "G2 matrix" (Hoots) for XP. Probe 11.1 shows no change of the propagated state
  with SRP and drag off, consistent with it serving the differential correction's partials.
- Step control *[study; probe 8.5]*: the 9.1.1.0 driver carries a further fallback to 30-minute steps for a step
  that still fails after its 90-minute retry; in 9.9 that fallback is never reached and the integration ends there
  (9). Side B's sets 1786, 3850 and 7042 are refused after the epoch by both builds (9.1.1.0 with code 2).

The 9.1.1.0 WebAssembly build is a C translation of the 9.1 Fortran; its own release notes record XP mismatches
against the Fortran baseline traced to the SHADOW computation.

*[probe 11.1]* Over 50 XP element sets (LEO, sun-synchronous, MEO, GEO, HEO; to 14 days) the two legs agree to
2 micrometers in GEO, 0.1 m sun-synchronous, 2.1 m LEO, 3.7 m MEO and 15 m HEO. With AGOM set to zero the
differences fall below 1e-6 m in every regime, and for the MEO and LEO cases setting either AGOM or B to zero
removes them: the versions differ only in the non-gravitational (shadow-dependent) path. **This specification
follows 9.9.**

---

## 12. SGP4XP covariance (side B's method, outside the SGP4-XP specification)

This section is side B's own: it specifies how the module gives a covariance with the states of the sets it fits,
SGP4XP. Nothing in it comes from the Space Force library, and no SGP4XP conformance vector depends on it.

**12.1 Fit covariance.** The parameter vector p of a fit is the fit's own (`params_of`): the mean equinoctial af, ag,
chi, psi, lambda0 (rad), n (rad/min), then those of the drag term (BTERM; m^2/kg) and AGOM
(m^2/kg) the fit solved for, each as its natural log where its prior's form is LOG_NORMAL ($PCF FIT.DRAG_PRIOR_FORM,
SRP_PRIOR_FORM: the iteration steps in the log). At the solution (an SGP4XP set at its two-line digits, an AP set at full precision: 16.9), with the residuals e_k (model minus reference position, km, TEME) of the N fit states,

- J_k = d r_k / d p, every column the central difference of the theory itself (steps 1e-6 in af, ag, chi, psi and
  lambda0, 1e-7 n, max(1e-3 |p|, 1e-5) in BTERM and AGOM or their logs; AGOM forward where p - h <= 0,
  the theory reading AGOM <= 0 as no SRP (its log moves both ways); every moved set flies the set's own branch (16.7),
  never the branch its own elements would decide, here and in 12.3;
- s^2 = sum |e_k|^2 / (3N - dim p), the post-fit residual variance per component;
- A = sum J_k^T J_k / s^2 + diag(1 / sigma^2) over the fit's priors (drag, AGOM: FIT.DRAG_PRIOR, FIT.SRP_PRIOR;
  under LOG_NORMAL sigma is that of the log). BTERM's prior, where FIT.DRAG_PRIOR is absent or without a sigma and
  FIT.DRAG_PRIOR_FORM is unset, is LOG_NORMAL with median 0.01 m^2/kg and sigma of the log ln 10, the prior of the free
  fits of experiments xp2-fit-design (1,214 windows, every one converged); AGOM's is GAUSSIAN_SIGNED with mean 0 and
  sigma 0.05 m^2/kg on an arc of 36 h or more and, on a shorter arc (the fit interval's first to last state), the
  Space Force wrapper's AGOM prior, GAUSSIAN_SIGNED 0 +- 0.1 m^2/kg (`propagator/sgp4-xp/src/fit.hpp`
  SGP4XP_PRIOR_SIGMA_AGOM); a FIT.SRP_PRIOR stated with its sigma holds on every arc. Both theories the fit solves
  (SGP4XP, and AP with its FORCES) take the rule. BTERM's prior keeps its form on short arcs: the wrapper's 0 +- 0.05
  moves no drag-free orbit and, below, ended at BTERM <= 0. A Gaussian on BTERM is stated by its mean and sigma
  (FIT.DRAG_PRIOR with HAS_SIGMA true): 0 +- 0.05 ended at BTERM <= 0, no drag at all, on the real ISS window of
  test/fit.e2e.mjs;
- P_p = A^-1; a term estimated as its log is carried back to m^2/kg by the Jacobian (the delta method): its rows and
  columns of P_p times the term, so sigma_B = B sigma_lnB. The $OBD gives the posterior sigma of the log and marks the
  term's covariance prior-limited when that passes 0.5 (the term effectively unobserved: the delta method then stands
  in poorly for a wide log-normal).

Known limit of BTERM's default start *[study 2026-10-31, noise-free synthetic tracks]*. The fit starts at the prior's
median, 0.01 m^2/kg, and an object whose B lies far below it can stop in a local minimum. A day of an SGP4XP set's own
states at 60 s (e 0.0003, i 51.6 deg, AGOM 0.01 m^2/kg; n 15.5, 15.2 and 14.9 rev/day for 400, 500 and 600 km), fitted
back: B of 0.0005 to 0.002 m^2/kg at 400 km and 0.0005 to 0.004 at 500 and 600 km end at a fit RMS of 4.0 to 14.7 m,
against 0.96 to 1.19 m from the former default's start at no drag; B of 0.01 and above recovers to about 1 m at 400 and
500 km. A caller that knows its object's B states a LOG_NORMAL median near it. On 94 real ISS windows (NASA's daily
files, every eighth from 2020-09-10 to 2026-10-13, the first 24 h of each) the former default ended at BTERM <= 0 on 42
(median fit RMS 472 m) and this one on none (457 m; lower on 65, never more than 5 % higher).

Short-arc AGOM prior *[exploratory, 2026-11-03: the AP5 GNSS windows of the 2026-11-03 gap diagnosis, already read]*.
On 748 windows of five GNSS satellites (24 h arcs, 2026-01-01 to 2026-05-31, leads from the fit end), the median paired
day-3 error of SGP4XP minus the Space Force library's fitted SGP4-XP falls from +56.107 m to -4.097 m (medians 211.8
and 152.3 m against the library's 149.4 m); the wrapper's two prior constants stated in $PCF FIT give -4.097 m, within
0.001 m of the AGOM prior alone. On 746 windows of 72 h arcs the errors are unchanged (median paired change 0.000 m at
days 1, 3 and 7). `test/fit-short-arc-priors.e2e.mjs` prints both; unread-window confirmation is separate.

**12.2 Epoch covariance and its record.** With J_0 = d x(0) / d p (x the TEME state, km, km/s) and F(x) the theory
floor (12.4) at the epoch state, the $OMM carries

- COVARIANCE = J_0 P_p J_0^T + F(x(0)), lower triangle (21 values, km^2, km^2/s, km^2/s^2), COV_REFERENCE_FRAME TEME;
- USER_DEFINED_SDNAP_COV_DRAG, _AGOM (those fitted, in that order): for the k-th of them the
  space-separated row of its covariance with X, Y, Z, X_DOT, Y_DOT, Z_DOT at epoch (J_0 P_p), with the earlier ones,
  then its variance (6 + k + 1 numbers);
- USER_DEFINED_SDNAP_COV_FLOOR_UVW (6 numbers, km^2: uu, vu, vv, wu, wv, ww; the floor F of 12.4, k_F of 12.5 applied), _COV_NOISE (12.5), _COV_NG_RATE (1/day)
  and _COV_REGIME (DRAG or ABOVE).

**12.3 Propagation.** A set is read back as the augmented epoch covariance C (state block COVARIANCE - F(x(0)),
consider rows as written). The columns J_0 = [J_x J_c] (elements, consider) give the parameters of a state:
T = [[J_x^-1, -J_x^-1 J_c], [0, I]], P_p = T C T^T. At t minutes from the epoch, J(t) = d x(t) / d p by the same
central differences and

P(t) = J(t) P_p J(t)^T + Q(t) + F(x(t)).

The state transition matrix is J(t) T; at t = 0 it is [I 0], so P(0) is COVARIANCE.

**12.4 Theory floor.** F is the fit's residual covariance in the UVW axes of the state (U radial, V in-track, W along
r x v), R = (1/N) sum u_k u_k^T, u_k the residual e_k in the UVW axes of the model state at t_k; position block
R in TEME axes, velocity block w^2 R (w = |r x v| / |r|^2), no position-velocity block, times the regime's k_F (12.5).
It is the part of the error a mean-element theory leaves at every time (short-period terms it does not carry) and does
not shrink with N.

**12.5 Process noise.** What a mean-element theory gets wrong over days are its element rates. From the end of the
fit arc t_a (minutes from the epoch; from the epoch backward for t < 0) the rates carry errors constant over
the prediction, with d = (t - t_a) / 1 day:

- eccentricity vector: d af, d ag = s_e d each (independent);
- inclination vector: d chi, d psi = s_i d each;
- mean longitude: d lambda = s_l n_d d (s_l a relative mean-motion error, n_d in rad/day);
- non-gravitational n-dot (drag regime): d n(t) = s_d d, d lambda(t) = s_d d^2 / 2, taken as the epoch perturbation
  that gives them at t: d n0 = d n(t), d lambda0 = d lambda(t) - t d n0; s_d = c |n-dot_ng| (rad/day^2), n-dot_ng the
  non-gravitational part of the theory's epoch n-dot (its rates with and without BTERM; USER_DEFINED_SDNAP_COV_NG_RATE
  = n-dot_ng / n per day).

Each is a column g = J(t) dp of 12.3's J(t), and Q(t) = sum g g^T. Q(t) is an epoch-element perturbation of size s d mapped by
the columns from the epoch; its node-coupled part depends on the arc length and on where the epoch is placed (8 times a rate
error from the arc's end, for a 72 h arc at a 24 h lead). The sizes below belong to their arcs: the SGP4XP rows to 24 h
fits; the SDNAP DRAG row to 24 h and 17 h arcs in strong drag and 72 h and 24 h arcs near 700 km. The set carries its sizes and t_a as
USER_DEFINED_SDNAP_COV_NOISE "s_e s_i s_l s_d t_a". They are fitted per regime (DRAG: perigee below
2500 km; ABOVE) by maximum likelihood, the Gaussian negative log-likelihood of the
position errors under P(t), on laser-ranged arcs of 2026-02-01 to 2026-05-31 (Ajisai, Starlette, Stella, LARETS,
WESTPAC, LARES in DRAG; LARES-2, LAGEOS-2, Etalon-1, Etalon-2 ABOVE; LAGEOS-1 never: it is held out), 24 h fits
scored every 30 min over the next 3 days (`test/covariance-realism.mjs --set calibration`,
`test/results/covariance-calibration-*.json`):

| Theory | Regime | Windows | s_e (1/day) | s_i (1/day) | s_l | c |
| --- | --- | --: | --: | --: | --: | --: |
| SGP4XP | DRAG | 136 | 2.813e-6 | 7.432e-6 | 8.505e-7 | 1.275e-6 |
| SGP4XP | ABOVE | 62 | 2.308e-7 | 3.752e-7 | 2.666e-7 | 0 |

These sizes, and the cells of 12.7, were measured on 2026-10-25 (module SHA-256 1f66e6fdf443 and f20f5a059b76) with
`fit`'s former default prior on BTERM, GAUSSIAN_SIGNED 0 +- 0.05, and were not re-measured under the LOG_NORMAL default
of 0.2.0.

SDNAP uses its own table when FORCES requests AP gravity terms; each row also scales the floor of 12.4 by k_F (the
floor the set carries in COV_PROPAGATION and adds at every time, epoch included; 1 for SGP4XP and for ABOVE).

| Theory | Regime | s_e (1/day) | s_i (1/day) | s_l | c | k_F |
| --- | --- | --: | --: | --: | --: | --: |
| SDNAP | DRAG | 1.8579913326733934e-07 | 1.12761105007012e-06 | 7.647194501793458e-07 | 0.112126311682426 | 1.5127596877626373 |
| SDNAP | ABOVE | 9.6961538661171821e-07 | 8.1531127919544734e-07 | 4.753573962018311e-06 | 0 | 1 |

The DRAG row (0.6.1, 2026-11-05) is fitted per axis. Per radial, in-track and cross-track axis (RIC, the truth's
axes) z = e / sigma, the forward error component over the propagated 1-sigma; calibrated, median |z| = 0.674, and the
band [0.603, 0.754] is the one-axis image of 12.7's (0.674 x sqrt of [0.8, 1.25]). The loss is, per regime, the mean
over R, I, C and lead hours 1 to 167 of (ln(median |z| / 0.674))^2, the regimes averaged; s_e, s_i, s_l, c and k_F
are solved jointly by Nelder-Mead on their logs from four starts. The windows are 0.6.0's flights of the coverage
study (experiments COVARIANCE-COVERAGE.md and COVARIANCE-REFIT.md): strong drag (Swarm A, B, C, GRACE-FO 1, 2; 24 h
and 17 h held-B arcs) and near 700 km (Sentinel-1A, 1C; 72 h and 24 h arcs), split by cutoff with a 10-day guard:
training 2025-04-01 to 08-10 and 2026-01-01 to 03-15, held out 2025-08-21 to 12-21 and 2026-03-26 to 05-31. P(t) is
linear in each squared size and the floor adds, so the fit re-weights the module's own per-term variances; no orbit is
re-fitted. The ABOVE row is the 2026-11-03 minimax row (the worst violation of 12.7's mean band across days 1, 2, 3
and 7 on `operator-theory/ap/b040`), unchanged.

Realism is not met, and the covariance is not calibrated (12.7). On the held-out windows the median |z| of 8 of the 18
cells (two regimes, three axes, days 1, 3 and 7) is inside the band, against 1 for 0.6.0, whose DRAG row (s_e 0.0030020720101006817, s_i 1.3729304605949328e-06, s_l
0.00022005794330391744, c 0.52454406174861778) gave a 1-sigma 274 to 530 times too wide in-track and about 1,000 to
7,600 times radially at day 1. The worst held-out |ln(median |z| / 0.674)| goes from 8.77 to 0.74. Median |z|, 0.6.0
to 0.6.1:

| Regime | Day | R | I | C |
| --- | --: | --- | --- | --- |
| Strong drag | 1 | 5.77e-4 to 0.635 | 2.03e-3 to 0.468 | 0.678 to 0.781 |
| Strong drag | 3 | 3.29e-4 to 0.745 | 5.94e-3 to 0.679 | 0.579 to 0.874 |
| Strong drag | 7 | 3.24e-4 to 0.754 | 0.016 to 0.910 | 0.491 to 0.794 |
| Near 700 km | 1 | 4.38e-4 to 0.638 | 1.07e-3 to 0.322 | 0.385 to 0.660 |
| Near 700 km | 3 | 1.50e-4 to 0.638 | 1.63e-3 to 0.487 | 0.207 to 0.560 |
| Near 700 km | 7 | 1.05e-4 to 0.852 | 2.28e-3 to 0.674 | 0.116 to 0.380 |

Strong-drag cross-track is now overconfident at days 1 and 3 (0.78 to 0.87; 0.6.0 was inside or wide there), and near
700 km in-track at day 1 and cross-track at day 7 remain too wide (0.32, 0.38). The limit is the form of the noise,
not its sizes: wherever the strong-drag cross-track median at day 7 is inside the band, the near-700 km one is 0.17 to
0.32, for every s_i and k_F; a row per regime, or a cross-track size growing with the non-gravitational rate, still
leaves held-out cells outside. On the demo's ISS sample the in-track 1-sigma 12 h from the file's start is 0.147 km
(0.6.0: 37.78 km) against the error 0.308 km. `test/covariance-realism.e2e.mjs` reports every held-out cell of both
rows, the shares within 1 and 2 sigma, and the ISS figure on the built module.

**12.6 Calls.** `sdnap_covariance_at(omm, length, minutes, count, out)` gives, per time, the TEME state and P(t)
(42 doubles); `propagate` writes a covariance line per state (COVARIANCE_MATRIX_LINES, the block's own axes: P
rotated with the state) for an SGP4XP set that carries COVARIANCE. An SGP4 set has none.


**12.7 Acceptance band.** Covariance realism acceptance band: mean d^2/3 in [0.8, 1.25] and 95 % coverage in [0.93, 0.97].
Per regime and day of lead (the experiments' band, V1c4), with the coverage the share of samples inside the 95 %
ellipsoid. The measured cells (test/results/covariance-realism-sgp4xp.json, README "Covariance
realism"), 0 of 12 inside:

| Theory | Set | Day | Mean d^2/3 | Inside 95 % | Band |
| --- | --- | --: | --: | --: | --- |
| SGP4XP | LAGEOS-1 (experiment windows) | 1 | 1.82 | 0.725 | outside |
| SGP4XP | LAGEOS-1 (experiment windows) | 2 | 1.93 | 0.738 | outside |
| SGP4XP | LAGEOS-1 (experiment windows) | 3 | 1.91 | 0.773 | outside |
| SGP4XP | LAGEOS-1 (2026-02 .. 05) | 1 | 1.38 | 0.913 | outside |
| SGP4XP | LAGEOS-1 (2026-02 .. 05) | 2 | 1.44 | 0.908 | outside |
| SGP4XP | LAGEOS-1 (2026-02 .. 05) | 3 | 1.44 | 0.93 | outside |
| SGP4XP | LAGEOS-2, Etalon-1/2 | 1 | 1.34 | 0.909 | outside |
| SGP4XP | LAGEOS-2, Etalon-1/2 | 2 | 0.84 | 0.994 | outside |
| SGP4XP | LAGEOS-2, Etalon-1/2 | 3 | 0.69 | 0.998 | outside |
| SGP4XP | LEO set | 1 | 1.09 | 0.98 | outside |
| SGP4XP | LEO set | 2 | 0.91 | 0.988 | outside |
| SGP4XP | LEO set | 3 | 0.76 | 0.992 | outside |

Outside the band: SGP4XP in every cell, LAGEOS-1 at 1.38 to 1.93 throughout, the LAGEOS-2 and Etalon and LEO cells
too large from day 2 (coverage 0.98 to 1.0). The band is not widened.

The covariance is positive semidefinite by construction and is not calibrated. The band of SPEC 12.7 cannot establish
realism: it accepts variance errors of 2.3, 0.2 and 0.01 on the three principal axes together, a perfect covariance fails it
with probability 0.65 at 20 independent forecasts and 0.15 at 200, and the noise sizes were tuned on the windows tested. With
the model otherwise exact, the fitted sigma of B and S is too small by sqrt(3N - L), 46 for a 24 h arc sampled every 120 s.


SDNAP: the held-out cells of 12.5 (per axis); neither theory's table earns a realism label.

**12.8 The drag prior of a fit.** `fit` estimates BTERM under its $PCF FIT.DRAG_PRIOR (MEAN, SIGMA, FORM); a stated
prior is fitted as given on every fit.

Per object: after the call's own $PCF, the `configuration` port takes either no further $PCF or one per 'ephemeris'
frame, in the frames' order. Each states only FIT.DRAG_PRIOR, FIT.SRP_PRIOR and their forms (CONFIGURATION_ID and
PROFILE may stand; anything else is refused by name), and the objects of its frame are fitted under the priors it
states, the call's for the rest: a frame whose $PCF states no drag prior takes the band default below. Each object's
$OBD states its posterior after the prior: under LOG_NORMAL the posterior sigma of the log and the posterior median,
under GAUSSIAN_SIGNED the posterior value and sigma. A catalog that refits daily carries them: BTERM LOG_NORMAL with the
previous posterior median and, as the sigma of the log, the larger of the previous posterior's and 0.3; AGOM
GAUSSIAN_SIGNED with the previous posterior value and the larger of its sigma and 0.01.

Measured on the model truth of the table below, one call with the SWOT-like orbit (true B 0.044) and the
Sentinel-3-like orbit (true B 0.001): each object's set is the bytes of its single-object fit; on the band defaults the
day-3 errors are 82.0 and 24.1 m (B 0.0463 and 0.00115), carried 83.0 and 24.1 m, and with each object's true B
(sigma of the log 0.3) 21.3 and 20.4 m. With SWOT-like's carried prior shared by both, as the call's one $PCF had to
before 0.4.13, the Sentinel-3-like object is at 3,176.9 m. A posterior carried from the same arc returns that arc's
estimate (SWOT-like's 0.0463 against 0.044), so the carried prior gains only as the running estimate converges over
successive arcs, which is the catalog's work. `test/fit-per-object-prior-multi.e2e.mjs` measures these numbers. Unset, the prior is LOG_NORMAL with median 0.01
m^2/kg and sigma of the log ln 10; under NRLMSISE-00 (or a minimum span below 24 h) the median follows the mean altitude
(0.01 below 600 km, 0.002 at 600-800 km, 0.0005 above; above e 0.3 the perigee's altitude, where the drag acts), and
under NRLMSISE-00 at 800-1400 km the sigma of the log is 10 ln 10.

The fit estimates ln B by Gauss-Newton from the median. At B = 0.0005 the arc's sensitivity to ln B is B times its
sensitivity to B, so under sigma ln 10 the prior's curvature dominates and the estimate stays at the median whatever
the arc holds; under 10 ln 10 it reaches the value the arc determines (posterior sigma of the log 0.005 to 0.02 at
814-891 km over 72 h). A GAUSSIAN_SIGNED prior starts at its mean, and at B = 0 the theory carries no drag and the
fit does not move B: a flat 0 +- 10 ends at 0. FFM's estimator (analysis/estimation) bounds each step in ln p to a
factor of ten and judges convergence on the undamped step, its a priori Gaussian in p.

Model truth: FFM EGM96 70x70, Sun and Moon from DE440 and NRLMSISE-00 drag at constant weather on both sides; AP
FORCES 31,20 with NRLMSISE-00; 72 h fits from an osculating perigee; day-3 3D RMS over 2-minute samples (m), the fitted
B in brackets (m^2/kg):

| Orbit, true B | 0.4.11 default | sigma 3 ln 10 | 0.4.12 default | median 0.01, ln 10 | flat Gaussian | 7-day arc, 0.4.11 default | per-object prior |
| --- | --: | --: | --: | --: | --: | --: | --: |
| SWOT-like, 891 km, 0.044 | 1,314 (0.0005) | 1,306 (0.0008) | 82 (0.046) | 677 (0.021) | 1,330 (0) | 80 (0.043) | 21 (0.044) |
| Sentinel-3-like, 814 km, 0.044 | 3,957 (0.0008) | 26 (0.044) | 64 (0.045) | 184 (0.042) | 4,027 (0) | 39 (0.044) | 28 (0.044) |
| Sentinel-3-like, 0.01 | 867 (0.0005) | 227 (0.0075) | 49 (0.0105) | 43 (0.0104) | 916 (0) | 84 (0.0096) | 20 (0.0100) |
| Sentinel-3-like, 0.001 | 51 (0.0005) | | 24 (0.0012) | 516 (0.0067) | | | |
| Jason-like, 1,336 km, 0.044 | 256 (0.0005) | | 256 (0.0006) | 202 (0.010) | | | |
| Jason-like, 0.005 | 37 (0.0005) | | 37 (0.0005) | 22 (0.010) | | | |

The per-object prior is the true B with sigma of the log 0.3. The sigma columns keep the median 0.0005, and the 7-day
arc is a 168 h span (FIT.DEFAULT_SPAN_HOURS and MAXIMUM_SPAN_HOURS); the other columns fit 72 h. At 717 km (median
0.002) the arc determines B under ln 10 already (true 0.044, 0.01 and 0.001: 492, 756 and 91 m at day 3); under 10 ln
10 it gives 310, 316 and 324 m, so the 600-800 km band keeps ln 10. At 1,336 km the 0.4.12 default leaves B at the
median as before; that is the per-object path's case.

The read AP6 altimetry windows (descriptive; paired day-3 AP minus FFM's archived F72 arm, median per object, 0.4.11 to
0.4.12): HY-2C 575.7 to 34.2 m, HY-2D 523.2 to 19.0, SWOT 463.7 to 208.2, Jason-3 180.2 to 34.5, Sentinel-6
82.6 to 53.3, Sentinel-3A 43.9 to -1.8, Sentinel-3B 25.9 to 6.6, CryoSat-2 55.7 and SARAL 47.7 (600-800 km)
unchanged; all 121 windows 167.2 to 34.2 m. A read window counts only where FFM's own day-3 error is under 10 km, since
a maneuver in the truth is not propagation error; the E2E prints each excluded window with FFM's error. Sentinel-6B's
windows are its commissioning: FFM misses four of five by 1.9 to 2,626 km, and on the two that FFM keeps under 10 km
the paired value goes from 191.7 to 3.9 m.
`test/fit-bterm-700-1400-km.e2e.mjs` measures every number of the default and per-object paths and of the windows.

**Diagnostics and the fall-back (0.4.18).** Every fit's $OBD BALLISTIC_COEFF_MODEL carries, after the prior and the
posterior above (BTERM in the $OMM's BSTAR, AGOM in its MEAN_MOTION_DDOT and in AGOM_MODEL, the arc in FIT_SPAN), the arc
check: the arc's hours, its largest gap and where it starts, and the step test's revolutions, velocity step, time, F and
verdict. Where the rule below is judged, BALLISTIC_COEFF_MODEL and the $OMM COMMENT also carry the drag path, `drag
prior: band default at 800-1400 km, no fall-back` or `drag prior: fall-back to the band median's prior (...) on
<reasons>; the band default's fit: BTERM, posterior sigma of the log, sigmas from the band median, fit RMS`, and the
COMMENT the arc check; every other $OMM is 0.4.17's byte for byte. $OBD 0.0.3 has no numeric field for a width, a prior
or a flag, so they are its model text; nothing goes in USER_DEFINED_PARAMETERS.

The arc check. A data gap: two consecutive fitted states more than two revolutions apart. An along-track step (a
maneuver indicator): the fit residuals' along-track component (model minus data along the model's velocity), averaged
per revolution over bins of at least 3 states (9 bins at least), is fitted by least squares with a quadratic in time
and with the quadratic plus a hinge max(0, t - t_h) at each bin boundary with 3 bins on either side; the hinge that
lowers the residual sum the most gives F = (RSS_0 - RSS_h) / (RSS_h / (K - 4)) over K bins and, from its slope c, the
velocity step |c| / 3 (a tangential step dv changes the along-track drift rate by 3 dv). A step is flagged at F >= 100
and at least 0.002 m/s. On the nine step-free model-truth arcs below F is at most 26.5 and the step at most 0.0003 m/s;
tangential steps of 0.005, 0.01, 0.02, 0.05 and 0.5 m/s 36 h into the SWOT-like and Sentinel-3-like arcs are recovered
as 0.0047 to 0.4992 m/s at F 1,335 to 6,550, every one flagged. On the read windows below no arc with a fit RMS under
30 m is flagged (the largest F 139, at 0.0008 m/s) and 17 of the 18 above 80 m are (0.005 to 0.030 m/s; Sentinel-6B
2025-12-14 0.51 m/s); Sentinel-6B 2025-12-19 (1.7 km, its commissioning) gives 0.17 m/s at F 85. A step after the arc's end, its states in the $OEM after USEABLE_STOP_TIME, leaves the fit bit for
bit.

The rule. After a fit of at least 71 h (the 72 h arc and longer) under NRLMSISE-00 at 800-1400 km on the band default,
the fit is redone under 0.4.11's band-median prior (median 0.0005 m^2/kg, sigma of the log ln 10, which is 0.4.11's fit
bit for bit) when the posterior sigma of the log exceeds B = 0.5, or BTERM is more than k = 3 posterior sigmas from the
band median while the fit RMS exceeds the band's median, 15.16 m, by more than 25 % (18.95 m), or the arc check flags a
gap or a step. B, k and the band median come from the model truth of 0.4.12's table (the band default's fit; the band
median's prior, as 0.4.11; day-3 3D RMS, m):

| Orbit, true B | Band default: B, sigma of the log, fit RMS (m), day 3 | Band median prior: B, day 3 | 0.4.18 |
| --- | --- | --- | --- |
| SWOT-like, 0.044 | 0.0463, 0.011, 14.48, 82.0 | 0.0005, 1,314.5 | default |
| SWOT-like, 0.01 | 0.0110, 0.048, 14.73, 42.9 | 0.0005, 279.2 | default |
| SWOT-like, 0.001 | 0.00069, 0.795, 15.16, 15.2 | 0.0005, 15.9 | fall-back, 15.9 |
| Sentinel-3-like, 0.044 | 0.0447, 0.005, 18.52, 63.6 | 0.0008, 3,957.3 | default |
| Sentinel-3-like, 0.01 | 0.0105, 0.021, 18.55, 49.4 | 0.0005, 867.1 | default |
| Sentinel-3-like, 0.001 | 0.00115, 0.196, 18.68, 24.1 | 0.0005, 50.7 | default |
| Jason-like, 1,336 km, 0.044 | 0.00058, 5.36, 17.27, 263.0 | 0.0005, 263.5 | fall-back, 263.5 |
| Jason-like, 0.01 | 0.00052, 4.23, 12.08, 61.5 | 0.0005, 61.6 | fall-back, 61.6 |
| Jason-like, 0.001 | 0.00051, 4.12, 11.48, 14.07 | 0.0005, 14.09 | fall-back, 14.09 |

Where the arc determines B (sigma of the log 0.196 or less) the wide prior gains 26.6 to 3,893.7 m; where it does not
(0.795 or more) B stays near the median and the two priors agree within 0.7 m. B = 0.5 lies between, the covariance's
prior-limited mark. B moves 4.2 to 896 posterior sigmas from the median where the arc determines it and 0.4 or less
where it does not: k = 3. The band median RMS is the median of the nine fits' RMS; no fixture exceeds 18.95 m (the
largest 18.68 m, Sentinel-3-like), so on the model truth the fall-back is taken only where B is undetermined.

AP8's read altimetry windows (DO, 136 paired AP72 windows; descriptive, these windows were read by AP8 and its
diagnosis), 0.4.11 / 0.4.17 / 0.4.18: Sentinel-3A 2025-10-15 day 3 0.087 / 0.312 / 0.087 km and Sentinel-3B 2025-10-25
day 7 0.113 / 1.335 / 0.113 km. 37 windows fall back, each to 0.4.11's fit bit for bit: 13 on k and the RMS (every
Sentinel-3A and -3B window in the band with B determined, fit RMS 19.2 to 86.5 m), 15 on the sigma alone (12 of
Sentinel-6 Michael Freilich's arcs, Jason-3 2025-12-04 and 12-19, Sentinel-6B 2025-12-19) and 9 on the sigma with a
step (fit RMS 145 m to 25.5 km). The day-3 median
change against 0.4.11 stays 0.4.17's on HY-2C (-84.3 %), HY-2D (-90.9 %), SWOT (-48.2 %) and Jason-3 (-69.1 %); SARAL
and CryoSat-2 (600-800 km) are 0.4.17's bit for bit. The diagnostics show the mechanism: on 11 of the 13 Sentinel-3 windows
both priors leave B determined by the arc (posterior sigma of the log 0.004 to 0.012), and 0.4.17 fits it 5 to 26 %
higher at a lower RMS (2025-10-15: 0.0217 at 21.1 m against 0.0190 at 23.8 m), so the losses are a determined estimate
that does not carry forward, which the width B never flags; the arc's RMS above the band's model-truth median separates
them. On the other two (Sentinel-3A 2025-11-24 and 12-19) 0.4.11 left B near the median (sigma 0.53 and 0.56). The rule
returns Sentinel-3A and -3B to 0.4.11 in the band, its gains with its losses: 0.4.17's -41 % day-1 median change goes
(day 1 median 0.058 to 0.090 km on Sentinel-3A), and 2025-11-24, 2025-10-30 and Sentinel-3B 2025-10-30 go from 0.072,
0.128 and 0.114 km at day 3 back to 1.506, 0.502 and 0.482 km. Jason-3 2025-10-10 (day 3 0.203 / 0.250 km, sigma of the
log 0.039, fit RMS 16.1 m) is not reached by the rule.

Cost: the mean fit time of a 72 h DO arc, 0.4.17 to 0.4.18 (12 workers on the owner Mac), outside the band 1,680 to
1,706 ms (the arc check), on the band default kept 1,834 to 2,210 ms (the first fit's covariance and arc check), on a
fall-back 1,790 to 3,430 ms (the second fit); per object-day of the arc a third of that (560 to 569, 611 to 737 and 597
to 1,143 ms). Propagation does not change (XP digest
72dcf6005046). `test/drag-prior-fallback.e2e.mjs` measures every number here.

**Above e 0.3.** Until 0.4.16 Molniya's band default followed its mean altitude (20,180 km, median 0.0005) and the 72 h
fit stayed there (0.000831 against the truth's 0.044, 11,063 m along-track at day 7); at its 541 km perigee the median is
0.01. The arc then determines BTERM, but a 72 h arc at e 0.72-0.74 does not separate it from the third bodies' and the
field's residuals. FFM model truth of 16.12 (Sun and Moon on both sides, AGOM pinned at 0, 10-minute grid; day-7
whole-day RMS along-track/radial after the arc, m; B against the truth's 0.044 and the posterior's sigma):

| Arc, prior | Molniya | GTO-500 |
| --- | --- | --- |
| 72 h, Gaussian 0.044 +- 0.1, 0.4.15 | +3.86 %, 1.09 %; 294.97 / 200.89 | +1.56 %, 0.67 %; 322.48 / 215.92 |
| 72 h, Gaussian 0.044 +- 0.1 | +1.78 %, 1.08 %; 279.49 / 190.28 | +2.42 %, 0.67 %; 736.18 / 473.69 |
| 72 h, Gaussian, Sun and Moon off on both sides | +0.13 %, 0.97 %; 110.03 / 91.29 | +1.92 %, 0.67 %; 566.03 / 364.48 |
| 7 days, band default (day 3 after the arc) | -0.46 %, 0.16 %; 46.64 / 36.98 | -0.28 %, 0.09 %; 157.22 / 105.55 |
| 72 h, the 7-day posterior carried (sigma of the log 0.005), days 7 to 10 | -0.46 %, 0.46 %; 103.54 / 75.20 | -0.29 %, 0.39 %; 87.69 / 48.37 |

On Molniya's 72 h arc the fit's weighted RMS is flat in B to 2 % (0.04319 at 0.044, 0.04240 at 0.0458, the arc's
minimum at +4.1 %, and 0.04250 at 0.0466, BTERM pinned at each), while the forecast from those values is 70.9, 557 and
776 m at day 7; the posterior's 1.1 % does not bound that bias, and where the fit stops on the floor moves with any
change of the model (+3.86 % at 0.4.15, +1.78 % here). On GTO-500 the arc's bias is the field's (+1.92 % without the
Sun and Moon), and with AP's drag now right it maps whole into the forecast: 322.48 to 736.18 m along-track, a
regression of the 72 h arc on a wide prior, which the carried prior removes (87.69 m;
modules-sdn-ap-drag-high-eccentricity-20261103). Seven days determine B to 0.5 % on both fixtures. So above e 0.3 a catalog that refits daily carries BTERM with the sigma of the log at least 0.005
rather than 0.3: the 72 h arc's own pull (+4.1 % at a sigma of 1.1 %) moves a prior that narrow by at most
4.1 / (1 + (1.1 / 0.5)^2) = 0.7 %, and the 7-day arcs' errors (0.46 % and less) fit inside it. `test/drag-high-eccentricity.e2e.mjs`
measures the carried and Gaussian rows.

**The arc above e 0.3 (0.4.17).** For a block whose first state is above e 0.3 with its perigee below 2,500 km and no
stated FIT.DRAG_PRIOR, the fit takes the longest arc the ephemeris holds up to 7 days, ending at the latest useable state
(a USEABLE_START_TIME keeps the caller's arc). On an arc shorter than 7 days the determination says so ("drag coefficient
not separable on this arc", with the arc's hours and the formal sigma) and BTERM's posterior width comes from the RMS
floor: the residual there is the theory's, not noise, so the arc's information on BTERM is the formal information over
the residual components (the offset whose signature over the arc equals the RMS floor), combined with the prior's; the
$OMM covariance's BTERM row and column take the ratio of the widths, so a covariance flown from the set carries it. A
prior that pins BTERM (drag off, a pinned coefficient) and every orbit at e 0.3 and below fit as before, byte for byte.
One independent sample per revolution, tried first, left GTO-500's truth outside one sigma on the 72 h Gaussian arc
(1.83 % against 2.42 %).

FFM model truth of 16.12 (Sun and Moon on, AGOM pinned at 0, 10-minute grid): B against 0.044, the posterior's sigma
(the formal one in brackets where the floor sets it), day-7 whole-day along-track/radial after the arc (m):

| Arc, prior | Molniya | GTO-500 |
| --- | --- | --- |
| 72 h, none (band default) | -3.81 %, 25.0 % (1.21 %); 396.1 / 285.7 | +0.29 %, 14.1 % (0.68 %); 62.8 / 50.3 |
| 72 h, Gaussian 0.044 +- 0.1 | +1.78 %, 22.4 % (1.08 %); 279.5 / 190.3 | +2.42 %, 13.7 % (0.66 %); 736.2 / 473.7 |
| 5 days, none | +0.08 %, 9.5 % (0.35 %); 166.3 / 112.3 | +0.26 %, 5.3 % (0.20 %); 70.1 / 61.3 |
| 5 days, Gaussian 0.044 +- 0.1 | +0.70 %, 9.4 % (0.35 %); 257.8 / 175.4 | +0.34 %, 5.3 % (0.20 %); 98.8 / 73.5 |
| 7 days, none (the policy's arc) | -0.46 %, 0.16 %; 135.5 / 89.7 | -0.28 %, 0.09 %; 291.3 / 179.3 |
| 72 h, the 7-day posterior carried (0.005), days 7 to 10 | -0.46 %, 0.50 % (0.46 %); 103.5 / 75.2 | -0.29 %, 0.50 % (0.39 %); 87.7 / 48.4 |
| 7 days, BTERM pinned at 0.044 | 218.9 | 158.8 |

Seven days determine B to 0.5 %; what remains of the forecast after them is the theory's own (the pinned row), and
GTO-500's -0.28 % costs it 130 m against the truth's 158.8. The 7-day formal sigma (0.16 % and 0.09 %) does not cover
those errors either (2.9 and 3.1 sigma); a catalog carries it with the 0.005 floor above. A 5-day fit with its 7-day
flight took 24 to 39 s per run on the owner Mac under load; the 7-day arc's fit time was not timed apart. The 220 km
GTO's 72 h fit did not finish in 16 minutes on this build and was stopped (the 0.4.15 isolation's 7-day GTO fits ran
past 30): its truth is cached (0.04 s), so the time is the fit's own, the Levenberg-Marquardt stages and their
finite-difference Jacobians each propagating the arc, which costs about 0.1 s on GTO (16.12's 1 h grid cost); its
table rows are not measured.
`test/high-e-fit-arc.e2e.mjs` measures every row but the pinned one.

---

## 13. (removed)

The SDN-AP osculating input (`opm_set`, `propagate` with 'opm' frames) went with the SDN-AP theory (owner 2026-10-25); the
number is not reused.

---

## 14. Epoch store (side B's method, outside the SGP4-XP specification)

**14.1 Load.** `load_epochs` replaces the store with a snapshot: 'omm' frames of size-prefixed $OMM records end to end
(or one record a frame), SGP4 and SGP4XP Earth sets, under the $PCF EPOCH_STORE table (SDS 1.270.0). A series is
one (NORAD_CAT_ID, OBJECT_ID, theory, ORIGINATOR). Kept, per series and by epoch: the sets of the CACHE_DAYS (7) before
the newest epoch of the load, the clock being the data's (no wall clock: the store is a function of its input); at
most MAX_SETS_PER_OBJECT (0: no cap), the newest; THEORIES (empty: both). Two records of one series at one epoch:
the later in the snapshot replaces the earlier. Sets not centered on the Earth are counted and
not stored. A record's theory record (SGP4 Sat or SGP4XP integrator) is made when first needed, two per
series held at a time.

**14.2 Selection.** With E_0 < ... < E_{n-1} a series' epochs and t the request time: NEAREST takes the set whose
epoch is nearest t (switch between E_i and E_{i+1} at tau_i = (E_i + E_{i+1}) / 2); LATEST_BEFORE the latest set at or
before t (switch at tau_i = E_{i+1}; before E_0, set 0). Binary search: O(log n) per series and request.

**14.3 Blend.** With W = BLEND_WINDOW_SECONDS (0: no blend), around each switch tau_i the half-width
h_i = min(W / 2, (E_{i+1} - E_i) / 2) (LATEST_BEFORE also min((E_{i+2} - E_{i+1}) / 2)), so windows never overlap.
For t in (tau_i - h_i, tau_i + h_i), s = (t - tau_i + h_i) / (2 h_i), and x_a, x_b the states of sets i and i + 1 at t:

- SMOOTHSTEP: w = 3 s^2 - 2 s^3, r = (1 - w) r_a + w r_b, v = (1 - w) v_a + w v_b + w' (r_b - r_a) with
  w' = 6 s (1 - s) / (2 h_i): v is the derivative of r, and w and w' are 0 and 0 at the window's start, 1 and 0 at its end.
- HERMITE: r = r_a(t) + c(t), v = v_a(t) + c'(t), c the cubic Hermite with c = 0, c' = 0 at the start and
  c = r_b - r_a, c' = v_b - v_a (both at the window's end) at the end: set a's motion plus a correction that lands on b.

Position and velocity are continuous across the window's edges; the acceleration steps by w'' (r_b - r_a) there.

A blend joins two states of one kind only: two theory states of sets on one branch, or two carried forecasts (18). Every
other switch tau_i is a step of x_b - x_a, as with W = 0, with the selected set's covariance:

- two consecutive AP sets on different branches (16.7: resonance class, the 1,100-minute regime, the eccentricity switches;
  each set's from its own epoch elements): different orbits, never blended;
- a set that gives its carried forecast over the window and one that gives the theory, or a set whose forecast span begins
  or ends inside the window: a blend would be neither a forecast state nor a theory state, and every state the store gives
  is one or the other (18).

Inside the window that switch would have had, `sdnap_epochs_select` gives b = -2 (branches) or -3 (a carried forecast and
the theory) and weight 0; `propagate_epochs` writes the block's COMMENT "Not blended (SPEC 14.3): " with each switch time its
grid crosses and its reason, "(sets on different branches)" or "(a carried forecast and the theory)". Each set's own flight
is continuous in time (16.7), so a blend of two theory sets on one branch is continuous; a carried set's step at its span's
end is 18's.

**14.4 Covariance.** For sets that carry COVARIANCE (SPEC 12), P = (1 - w) P_a + w P_b + w (1 - w) d d^T with
d = x_b - x_a (the smoothstep weight for both shapes): the covariance of the two-component mixture (a blended switch,
14.3).

**14.5 Calls.** `load_epochs`; the resident exports `sdnap_epochs_count`, `_stats` (the load's counts and the store's
bytes), `_series` (identity and epochs), `_select` (the sets and the weight at a time), `_set_at` (one set without
selection) and `_at` (a batch of series at one time, TEME km, km/s or Earth-fixed m, m/s, with the covariance); and
`propagate_epochs`, the store of the call's own snapshot on a grid, one $OEM per series (stateless).

---

## 15. Selectable drag atmosphere (side B's option, outside the SGP4-XP specification)

**15.1 Selection.** `fit`, `propagate`, `load_epochs` and `propagate_epochs` read it from their $PCF FORCES (SDS 1.272.0);
`maneuver` and `ingest_omm` keep section 3. With no FORCES field away from its default and no 'space_weather' or
'density_correction' frame, the drag is section 3 exactly: the default is SGP4XP.

| FORCES | Density at the drag nodes of 3.4 |
| --- | --- |
| ENABLE_DRAG false (default), no rows | section 3: Jacchia 1970 on the generic flux model (3.1) |
| ENABLE_DRAG false, WEATHER_SOURCE RECORDS (or UNSPECIFIED with rows) | 3.2 and 3.3 with F, F-bar and Ap from the rows (15.2) |
| ENABLE_DRAG true, ATMOSPHERE_MODEL NRLMSISE00, rows | NRLMSISE-00 (15.3) |
| as above, DENSITY_CORRECTION DCA_COMMON_MODE, a $DCL | NRLMSISE-00 times exp(s(t)) (15.4) |

Refused by name: another ATMOSPHERE_MODEL, WEATHER_SOURCE CONSTANT and a WEATHER table, WEATHER_EXTENSION REFUSE or
FORECAST_CHAIN (UNSPECIFIED and HOLD_LAST hold the last row), DCA_COMMON_MODE without ENABLE_DRAG, a non-zero
DENSITY_CORRECTION_RELAXATION_HOURS (the $DCL's forecast nodes carry the decay), any other FORCES field but section 16's
(the last two, THIRD_BODY_MAXIMUM_DEGREE and _ORDER, included); rows that NRLMSISE-00
or RECORDS needs and that are absent (space-weather-missing); a $DCL without DCA_COMMON_MODE or the reverse
(density-correction-unselected, density-correction-missing); malformed rows or $DCL (invalid-space-weather,
invalid-density-correction); a call that evaluates a day whose previous day precedes the first row
(space-weather-out-of-range). Every set initialized during the call carries the call's atmosphere.

**15.2 Drivers.** $SPW rows (DATE, F107_OBS, F107_OBS_CENTER81, AP_AVG), plain or size-prefixed end to end, one per
UTC day (a later frame's row of a day replaces an earlier one). At d50 on UTC day d (MJD = floor(d50 + 33281)): F10.7
is F107_OBS of day d - 1, F10.7a F107_OBS_CENTER81 of day d, Ap AP_AVG of day d, each from the last row at or before
its day (past the last row that row holds). This is NRLMSISE-00's daily-Ap convention as propagator/ffm and
analysis/density-calibration read the rows; for Jacchia 1970 the three are 3.2's F, F-bar and Ap.

**15.3 NRLMSISE-00.** gtd7d of the public-domain C port in third_party/nrlmsise00 (Picone, Hedin, Drob and Aikin 2002),
every switch 1 but the output units (the daily-Ap form), the total mass density with anomalous oxygen, at the node's
geodetic latitude phi and height h of 3.4 (below 10 km, 10 km, as 3.3), its longitude alpha - theta_g (alpha the
node's TEME right ascension, theta_g = theta_g0 + omega_E t, 1.2), the UTC day of year and seconds of d50, and the
local solar time UT + longitude / 15. Above 2500 km, 1e-20 kg/m^3 as 3.3. NRLMSISE-00 holds file-static state:
it is evaluated on the calling thread only.

**15.4 Open DCA.** A $DCL as FFM reads the open-DCA product: Solved, ATMOSPHERE NRLMSIS00E, CORRECTION LogDensityNodes
with one finite NODE_LOG_DENSITY_SCALE_DIMENSIONLESS per strictly increasing NODE_TIMES_MS (UTC). s(t) is linear
between nodes and held at the end values outside them; the density is NRLMSISE-00 times exp(s(t)) at every node.

**15.5 Fit, two-stage decoupled tesseral-null pass, and atmosphere mark.** `fit` estimates BTERM and AGOM under the
call's atmosphere, with finite-difference Jacobian fallback (`fit::jacobian_fallback`) enabled under NRLMSISE-00 and
short-span (`< 24 h`) passes. When FIT.DRAG_PRIOR is unset under NRLMSISE-00 or `< 24 h` minimum span, BTERM's
LOG_NORMAL prior takes its median by mean altitude (`0.01` below `600 km`, `0.002` at `600-800 km`, `0.0005` at
`>= 800 km`), and under NRLMSISE-00 at `800-1400 km` the sigma of the log `10 ln 10`, with 12.8's fall-back; a stated FIT.DRAG_PRIOR is
fitted as given. When `FIT.MINIMUM_SPAN_HOURS < 24` and `FIT.DEFAULT_SPAN_HOURS >= 36` on a
non-eccentric orbit without `USEABLE_START_TIME`, `fit` runs a two-stage decoupled solve: Stage 1 fits the `48-72 h`
span to determine `BTERM` and `AGOM`; Stage 2 fits the trailing `MINIMUM_SPAN_HOURS` (e.g. `17.1 h`, the `12 h` order-2
tesseral null) with `BTERM` and `AGOM` pinned to Stage 1 (`sigma = 1e-9`) and the epoch placed at cutoff (`last_useable`).
A set fitted under NRLMSISE-00 records `SDNAP_ATMOSPHERE_MODEL` (`"NRLMSISE00"` or `"NRLMSISE00_DCA"`) in
`$OMM.USER_DEFINED_PARAMETERS`; `propagate`, `ingest_omm`, `load_epochs` and `propagate_epochs` refuse a set whose mark
disagrees with the call's atmosphere (`atmosphere-mismatch`).

---

## 16. AP: an advanced propagator that builds on the entire history of astrodynamics (side B's option, outside the SGP4-XP specification)

AP is an advanced propagator that builds on the entire history of astrodynamics: $PCF FORCES selects its drag atmosphere
(section 15) and the gravity field below. Its sets are SGP4XP sets (BTERM, AGOM) that carry a mark, and it flies on the theory's
own grid.

Given the same forces, AP's first-day error against a numerical orbit is about 20 m below 1,000 km (29 to 72 m at 450 km),
12 m at 1,336 km, 4.5 m at 5,900 km, 4.5 to 7 m in medium orbits and 1 to 6 m in geosynchronous orbits; on eccentric orbits
with low perigee it is 15 to 185 m on the first day and 0.1 to 3.6 km by the seventh. A numerical propagator has no such
floor: AP equals one only where the force model limits both.

**16.1 Selection.** `fit`, `propagate`, `load_epochs` and `propagate_epochs` read FORCES:

| FORCES | Terms |
| --- | --- |
| HAS_MAXIMUM_TESSERAL_DEGREE, MAXIMUM_TESSERAL_DEGREE d, 0 to 70 | the tesseral terms of 16.2, each family to its cap or d, whichever is lower |
| HAS_MAXIMUM_DEGREE, MAXIMUM_DEGREE z, 0 to 70 | the zonal tail J6 to Jz of 16.3 (z below 6: none) |

With both at 0 or unset the theory is SGP4XP bit for bit. Either above 0 also selects the frame policy of 16.4 and the
third-body terms of 16.8. A degree set without its HAS field, or above 70, is refused by name.
MAXIMUM_TESSERAL_DEGREE is a cap on families, not the degree of a field. With tesseral cap d the short-period terms are
complete to first order to degree min(d, 12) only; degrees 13 to min(d, 31) contribute their j = 1 near-resonant terms in low
orbit and the half-day tail, and nothing else. At 800 km the terms of degree 13 to 31 not carried are 14 m RMS (18.9 m in all
against a 31 x 31 field); at 450 km the order-15 terms above degree 31 add 72 m on day 1 and 268 m on day 7 after a 72 h fit.
`maneuver` and `ingest_omm` keep SGP4XP.

**16.2 Tesserals.** The field is the fully normalized EGM-96 of propagator/ffm, pinned by build.mjs. Inclination functions come
from the Fourier coefficients of the normalized Legendre recurrence, stable to degree 70, at the epoch inclination. The Cap column is a cap on families, not the degree of the field (16.1): at
800 km the terms of degree 13 to 31 not carried are 14 m RMS.

| Family | Terms | Cap | Where |
| --- | --- | --- | --- |
| m-daily | Kaula's q = 0, l = 2p, even l, every m | 12 | at output time, first order at the mean elements |
| first-order | every other q in {-1, 0, 1} with \|j\| <= l + 1: the q = +-1 terms are O(e) in G and O(1) in the eccentricity vector, so they carry the radial m-daily signal and, for odd l with j = 0, a line amplified by n / psi-dot | 12 | at output time, first order at the mean elements |
| near-resonant | j = 1 above that degree, at orders whose angle drifts slower than 0.2 n: q = 0 with w = 1 outside the shallow band, q = +1 with w = 0, q = -1 with w = 2 | 31 | at output time |
| half-day resonant tail | l = 6..d, every even m <= l, p = 0..l, k = m/2, q = k - l + 2p; 5,291 additional terms at degree 31 | 31 | in the rates of the half-day class; excluded from the output-time table |
| shallow resonances | k = 1, q = 0, l = 1 mod 2, m from 2, angle drifting slower than 0.045 n | 31 | in the rates, each (k, m) tapered by its current distance from commensurability; orbits outside the classes of section 6 only |

A first-order or near-resonant term is left out when section 6's class or the shallow set carries it in the rates (the shallow set
by the same taper, so a term crossing its band moves from one to the other), when its angle drifts slower than 0.001 n, and when
its position amplitude is below 0.5 m. G is g0 + g1 e about the epoch e: below e = 0.03, q = 0 takes 1 + (l (l + 1) / 4 - w^2) e^2 and
q = +-1 takes ((l + 1) / 2 + q w) e, above it the Hansen coefficient.

Below the eccentricity switch (0.05 in class 0, 0.3 in the resonant classes) the first-order tesseral table keeps |q| <= 1. The
terms dropped are of order e^2 and reach, just below the switch, 14 m at a = 7,600 km (20.6 m against 15.2 m just above it), 12 m
in a 12-hour orbit (13.5 against 6.7 m) and 7.5 m in a geosynchronous orbit (7.6 against 1.1 m), RMS over a 72 h arc.

Section 6's classes keep their terms: the epoch class's, in the rates, for the whole flight (16.7). F is evaluated at the current inclination with the exact dF_632/di;
G_410 has e^2 coefficient 1, dG_40,-2/de includes its e^13 and e^15 terms, and G_30,-1 includes its e^27 term.
When the local Hansen expansion of 6.4 is selected, G for the original resonance terms is exact at the epoch eccentricity to numerical-integral
precision and third order within |de| <= 0.02, as specified in 6.4. The measured per-term relative errors
are 1.1e-4 at |de| = 0.01, 1.5e-3 at 0.02, and 4-15% at 0.05. The Laplace limit does not supply a validity bound for this local expansion.

The half-day tail uses cubic expansions of F about the epoch inclination and G about the epoch eccentricity,
with their consistent derivatives. F comes from the normalized Legendre recurrence; G comes from shared
eccentric-anomaly quadrature. The class's original 29 terms retain their exact inclination functions.

**16.3 Zonal tail.** J6 to Jz in the rates: the secular terms of even l (p = l/2, q = 0) and the long-period terms of odd l
(w = +-1, q = -w), first order, F and dF/di at the epoch inclination and G linearized at the epoch eccentricity.
For e0 at or below 0.3 the zonal tail carries, for even degrees, the secular term only; it omits their cos 2 omega pair, which
is of the same order in e in the perigee rate and 50 to 78 % of the term kept. The perigee rate is short by 2.0e-5 rad/day at
800 x 1,100 km, e 0.0206, i 49.8 deg: a radial error growing 3.1 m/day there, and 6 to 54 m/day at e 0.1 between 500 and
1,200 km. Above e0 0.3 the zonal tail carries every long-period term (16.11).

**16.4 Frame.** Frame policy is selected once by `xp_init` from the epoch propagation branch and the
selected gravity replacements. With d or z above 0, epoch periods below 1100 minutes and the nonzero
resonance classes carry epoch-axis states to TEME of date by M(t) M(t0)^T. M is the GCRF-to-TEME matrix
of `gcrf.inc`, linear between 12-hour nodes: at most 5.6e-9 rad, 0.23 m at the geostationary radius. The Earth's axis is held
at its epoch direction during a flight. With precession alone the error from the epoch is 0.1, 0.8 and 4.1 m at 1, 3 and 7
days at 800 km and 0.2, 1.7 and 9.0 m at 1,336 km, up to twice that with the fortnightly nutation, and below 1 m from 5,900 km
up. The nonresonant long-period branch (epoch period at least
1100 minutes, class 0) retains its native TEME-of-date convention without this additional rotation.
Its instantaneous third-body geometry does not take the epoch-axis output correction.

Fit residuals and propagation share `xp_propagate`, including this policy; there is no separate fit-only
rotation. GCRF fit inputs are converted to TEME at each sample date, and GCRF output converts the propagated
TEME state at that date. The output's GCRF-to-TEME matrix (`propagate`, `propagate_epochs`; EME2000 through it) is the
quintic through the matrix at the six 6-hour nodes about the date (UTC quarter days, held per thread), each node the
same IAU 2006/2000A chain with GMST82 summed without gmst()'s rounding: one IAU 2000A nutation series per 6 hours of
output, not one per state, and a function of the date alone. Against the per-state chain with GMST82 in exact
arithmetic it is off by at most 0.0042 mm at the geostationary radius; the per-state matrix it replaces was off by up
to 1.5 mm there (gmst()'s rounding: up to 3.6e-11 rad), and the two differ by at most 1.6 mm and 1.2e-4 mm/s (SGP4
sets with epochs from 2020 to 2035, 7 days each; test/output-frames.mjs). A GCRF state then costs what a TEME state
costs, against about 31 µs with the matrix at each state; a one-state call at a date whose nodes are not yet held
computes six nodes. The fit's GCRF inputs keep the matrix at each state. GMST82 itself (gmst(), store.inc) sums its
polynomial in seconds of time near 8e8 s and turns that into radians near 6e4 rad, so it is off GMST82 in exact
arithmetic by up to 3.6e-11 rad (1.5 mm at the geostationary radius), an error that changes from one instant to the
next (2020 to 2035, test/output-frames.mjs); the fit's GCRF inputs and every Earth-fixed state (TEME to Earth-fixed by
gmst()) carry that rounding. Default FORCES retains the XP path bit for bit. The one-day class retains its frame
correction and 38-minute grid; the half-day and GTO fixtures retain their previous paths.

The exploratory AP6 replay on 2026-11-03 uses all seven previously read TESS windows, 72-hour fits, the
original 300-second grid, and AP6's pinned foundation/frames conversion for scoring. Leads start at fit end.
The day-3 median paired AP-minus-XP error changes from +420.105792 m to -0.000784 m (acceptance: within
50 m of zero). This is a correction to the model's frame policy; independent-window confirmation is separate.

| Fit end UTC | Previous AP day 3 (m) | AP day 3 (m) | XP day 3 (m) | AP minus XP (m) |
|---|---:|---:|---:|---:|
| 2026-07-27 | 2009.249179 | 1280.596477 | 1280.868413 | -0.271936 |
| 2026-08-03 | 2496.529273 | 2684.873011 | 2684.869564 | 0.003447 |
| 2026-08-10 | 1463.232922 | 1214.681850 | 1214.683662 | -0.001812 |
| 2026-08-17 | 1211.231855 | 791.128364 | 791.126063 | 0.002301 |
| 2026-08-24 | 1850.254952 | 1385.636736 | 1385.640624 | -0.003888 |
| 2026-08-31 | 2017.233821 | 1833.692391 | 1833.693176 | -0.000784 |
| 2026-09-07 | 2157.517187 | 1574.829241 | 1574.457639 | 0.371603 |

`test/heo-frame.e2e.mjs` prints every window and all four synthetic HEO fixtures from the half-day test.
Their day-1/3/7 3D errors change by 0.000 m (acceptance: less than 1 m); the half-day day-7 error remains
104.725 m. XP reproduces the archived AP6 scores within 0.001 m and retains its conformance digest.
`test/results/heo-frame.json` records the per-window errors, fixture checks and kernel hashes.
From 0.4.9 an AP set keeps its full precision while an XP set keeps the two-line lattice (16.9): on the same seven
windows AP then leads XP by a median 137.5 m at day 3 (per window -298.4 to +101.0 m). The E2E requires AP no more than
50 m behind XP, and the fixtures it checks carry their 0.4.11 values.

**16.5 Mark.** A set fitted with either degree set records `SDNAP_GRAVITY_TERMS` (`"<d>,<z>"`) in
`$OMM.USER_DEFINED_PARAMETERS`. `propagate`, `load_epochs` and `propagate_epochs` refuse a set whose mark differs from the call's
degrees, and `ingest_omm` any marked set (`gravity-terms-mismatch`).

**16.6 HEO model truth.** Synthetic GCRF states at 2026-10-29 00:00 UTC, fitted over 72 h through `fit`,
then propagated 1, 3 and 7 days after the fit ends. FFM uses EGM96 70x70, Sun and Moon from DE440, zero EOP,
no SRP, and NRLMSISE-00 only for Molniya (Cd A/m = 0.044 m^2/kg; constant F10.7 = 150, Ap = 15).
AP uses FORCES 31,20. Initial states, kernel and module hashes, signed errors and numerical-reference checks
are in `test/results/heo-model-truth.json` (2026-11-03); `test/heo-model-truth.e2e.mjs` reproduces the comparison.

All cases start at perigee, with argument of perigee 270 degrees. The half-day and Molniya cases have RAAN
300 degrees; GTO has RAAN 40 degrees. These are measured cases, not bounds for all HEO objects. The published
fit rounds its elements to the two-line lattice.

| Case (n rev/day, e, i degrees) | Lead days | R, T, N error (m) | 3D error (m) |
| --- | ---: | --- | ---: |
| Half-day (2.0059, .72, 63.4) | 1 | 185.012, -239.084, -16.201 | 302.743 |
| Half-day (2.0059, .72, 63.4) | 3 | 89.080, -111.146, -32.278 | 146.050 |
| Half-day (2.0059, .72, 63.4) | 7 | -73.019, -37.280, -65.160 | 104.725 |
| Molniya (2, .74, 63.4; drag on) | 1 | 73.173, 29.515, -16.047 | 80.516 |
| Molniya (2, .74, 63.4; drag on) | 3 | 39.674, -125.204, -21.271 | 133.051 |
| Molniya (2, .74, 63.4; drag on) | 7 | 366.657, -540.558, -34.603 | 654.092 |
| GTO (2.40, .72, 27) | 1 | 92.703, -148.066, -114.320 | 208.773 |
| GTO (2.40, .72, 27) | 3 | 75.410, -19.887, 36.370 | 86.052 |
| GTO (2.40, .72, 27) | 7 | -1556.157, -1727.365, -88.427 | 2326.636 |
| 12-hour (2, .72, 55) | 1 | 157.566, -109.427, -46.725 | 197.445 |
| 12-hour (2, .72, 55) | 3 | 2.212, -19.735, -77.195 | 79.709 |
| 12-hour (2, .72, 55) | 7 | -176.410, 22.747, -62.891 | 188.661 |

The half-day case measured 3,116.083 m at day 7 before the degree-31 tail and 104.725 m with it. At 0.4.11 (5.4's
quadrature, 16.8 at every eccentricity) the 3D errors at days 1, 3 and 7 are 123.8, 121.4 and 202.0 m (half-day),
208.3, 253.4 and 338.0 m (Molniya), 253.7, 112.3 and 2444.4 m (GTO) and 139.7, 177.2 and 303.2 m (12-hour 55 deg); the
half-day day-7 sample falls 1 h after a perigee, and `test/heo-model-truth.e2e.mjs` pins it within 0.5 m. Flown
hourly, the day-7 whole-day RMS along-track/radial is 84.2/75.3, 149.8/175.9, 960.8/935.3 and 158.0/105.5 m (0.4.10:
228/85, 687/391, 885/860 and 232/60 m); `test/third-body-short-period-eccentric.e2e.mjs` checks them. From 0.4.14
the half-day class's step (16.10) brings GTO to 237.8, 175.8 and 924.7 m and 419.3/455.9 m whole-day. From 0.4.15 (16.11)
the four are 27.5, 70.0 and 60.1 m (half-day; the sample `test/heo-model-truth.e2e.mjs` pins), 45.9, 27.0 and 419.4 m
(Molniya), 115.3, 79.2 and 244.3 m (GTO) and 22.2, 61.4 and 56.4 m (12-hour 55 deg), and whole-day 34.3/23.1,
291.4/219.7, 204.2/133.9 and 67.3/25.3 m. From 0.4.16 (16.12, 12.8) Molniya is 44.4, 27.5 and 392.6 m and whole-day
276.4/208.3 m, the rest unchanged. Molniya's gap is its 72 h arc's fitted drag coefficient (12.8).
The numerical reference changed by 1.165 m at day 7 when its RK78 tolerance tightened from 1e-12 to 1e-13
and maximum step halved from 300 s to 150 s; a further tightening to 1e-14 and 75 s changed it by 0.255 m.

**16.7 The branch in AP.** A set's branch is decided once, at initialization, from its epoch mean motion and
eccentricity, and held for the whole flight, as SGP4XP holds its class (6, Bands): the resonance class (6), the regime
(period below or above 1,100 min; 5, 9) and the eccentricity switches (the first-order tesseral families on the grid above
0.05 in class 0 and 0.3 in the resonant classes, 16.11; above 0.3 the zonal tail's every long-period term and the perigee
drag passage, 16.3 and 16.12; at or above 0.3 the class's G about e0, 6.4). When drag or a resonance carries the mean
motion across a class limit, the epoch class's terms stay in the rates, with F and G at the current elements (16.2), and
out of the output table; no table is rebuilt during a flight. A record's output is therefore continuous in time: one
seeded set at each of the five mean motions that decide a class (e 0.001, i 55 deg), flown 2 days at 10 s, has a second
difference of position less the two-body term of at most 0.002, 0.003, 0.004, 0.012 and 0.035 m at 0.8022, 1.2033,
1.6045, 2.4067 and 3.6100 rev/day (0.6.5, whose tables followed the current mean motion: 89.9, 135.5, 13.7, 0.012 and
0.035 m, the first three jumps several times a day; review 0, `math/rerun/09-output-continuity.mjs`).

AP's mean elements are defined per resonance class, per regime (period below or above 1,100 min) and per eccentricity branch.
The same six numbers on two sides of a switch are different orbits: 8 to 401 m apart at epoch and up to 33 km after 7 days at
the regime limit. Sets on different sides must not be differenced, blended or interpolated.

The branch is fixed at the epoch, so this holds between records, never along one. With the class held, two sets 2e-9 apart on
either side of a class limit drift further apart than when both followed the current class (review 0's
`08-boundary-jumps.mjs` at e 0.001, day 7: 1,084, 2,291, 88, 1,309 and 3,037 m at the five limits against 279, 16, 266, 49
and 3,682 m on 0.6.5; at the epoch unchanged, 67, 90, 18, 28 and 24 m). The module differences and blends one branch only:

- Covariance (12.1, 12.3): each moved set flies its nominal's branch. Once the class is held, the propagated covariance about
  a limit is continuous in the nominal's mean motion: a fitted record moved to 2e-8 and 3e-7 above 1.2033 rev/day gives the
  same covariance at 0, 1 and 3 days to 2e-4 of its largest position variance (0.6.5: 0.70).
- Fit: the objective jumps at a switch, and a free fit can stop on it (a 72 h arc of a truth at 0.8022 rev/day ended
  1e-16 from the limit, where one Gauss-Newton step of the full theory would have removed 73 % of its cost: its trial
  steps across are refused until it creeps onto the limit). Where the fitted set lies on a switch (within 1e-8, relative
  in n, absolute in e; every other fit is the free one bit for bit), `fit` fits again from it with every trial set
  pinned to its branch (its columns: the analytic two-body and J2 ones, and where an eccentric or short arc takes them,
  one-sided differences of moved sets that fly the iterate's branch, as the covariance's fly the nominal's, so no column
  holds a switch's jump); a minimum on that branch is the answer; a minimum across the switch is fitted again pinned to the
  branch it reached, and its minimum is the answer when it stays there; otherwise the fit is refused fit-at-branch-limit,
  naming the switch, the set's mean motion and eccentricity, and asking for another span or epoch. On the referee's
  full-field truths (its own integrator, 31 x 31, Sun and Moon) seven fits whose mean motion lies 2e-8 to 5.6e-7 from a
  class limit, at each of the five limits, are at the theory's least-squares minimum (a Gauss-Newton polish with the full
  theory's Jacobian lowers the cost by at most 2.3e-8 relative, steps of at most 1 mm); arcs whose two branches' minima lie
  across each other are refused (the 72 h arcs seeded at 0.8022 and at 1.6045 rev/day, whose 24 h arcs fit, and four of
  eight 24 h arcs seeded up to 7e-5 below 0.8022).
- Epoch store (14.3): two sets on different branches are not blended (nor a carried forecast with a theory state).

Model truth (`test/class-crossing.e2e.mjs`): an AP mean-element GTO at 2026-10-29 00:00 UTC seeds FFM with the same GCRF
state. There is no fit. The primary has n = 2.40 rev/day, e = 0.72, i = 27 degrees, RAAN = 40 degrees, argument of perigee
= 270 degrees, M = 0, BTERM = 0.06 m^2/kg and AGOM = 0. The companion changes only n to 2.3966852459, 0.01 rev/day below the
half-day upper edge. FFM uses 16.6's gravity, DE440, zero EOP and the constant weather of `test/lib/spw-constant.mjs`
(NRLMSISE-00); AP uses FORCES 31,20 and NRLMSISE-00. The primary's mean motion reaches 2.4084063 rev/day at day 7 held
(2.4084264 rebuilt), in the eight-hour band; the companion's 2.4039453, inside the half-day band.

| AP treatment | Primary day-7 T error (m) | Companion day-7 T error (m) | Relative difference |
| --- | ---: | ---: | ---: |
| Epoch class held (this version) | -168,218.829 | -136,267.630 | 23.447% |
| Tables rebuilt for the current class (0.6.6 and 0.6.7) | -167,341.326 | -136,267.630 | 22.803% |

Holding the class costs this fixture 0.88 km of day-7 along-track error (0.5 %); the E2E allows 25 % against the companion.
On 2026-11-03, with the earlier constant-weather file, the arms were -32,325.032 (held) and -31,291.823 m (rebuilt), the
companion -26,506.785 m; rebuilding was kept then for its 1.0 km smaller error. It is reversed for continuity in time.
Through 0.6.8 the two (2,2) terms (p,q) = (0,-1), (1,1) left the rates at the crossing and were not in the rebuilt output
table either (that E2E's probe found 0 of 2 there, the failure it reported from 0.6.5 on); held, they stay in the rates.
The E2E flies the primary every 10 s from day 3 to day 7 and finds its output continuous away from perigee (jump detector
0.14 m against 1 m; the same on 0.6.7, whose rebuilt tables kept this set's grid). Within 10 min of each perigee the
detector reaches 129 m on both builds: the perigee drag passage (16.12) steps the output by about 86 m at perigee on this
fixture, a discontinuity in time of its own, outside this section. `test/results/class-crossing.json` keeps the run.

**16.8 Third-body terms beyond the octupole.** With d or z above 0, the epoch period below 1100 min (the regime whose
third-body rates 5 averages; the long-period regime takes the full point-mass acceleration), AP adds to the rates each
body's tidal acceleration of Legendre degree 4 to 10,

a_l = (mu_b / r_b^2) (r / r_b)^(l-1) [(l P_l(u) - u P_l'(u)) r_hat + P_l'(u) s_hat], u = r_hat . s_hat,

averaged over the mean longitude as 5 averages degrees 2 and 3, each body held at its position at the stage time: the
Gauss equations on the mean orbit at 32 equally spaced eccentric longitudes F, weighted by r/a (d lambda = (r/a) dF).
P_l and P_l' follow the Legendre recurrences. Over all degrees from 2, the same quadrature reproduces 5's closed form
for degrees 2 and 3 within 0.1 m of day-3 error on the Etalon model-truth cases; degree 10 leaves under 1e-7 of the
quadrupole at r / r_b = 0.12. The output takes the short-period terms of degrees 2 to 10 by 5.4's quadrature. Default
FORCES keeps SGP4XP bit for bit (XP digest 72dcf6005046). Builds 0.6.5 to 0.6.7 departed from it: their rates took the
semi-latus rectum of SGP4XP's zonal terms from af^2 + ag^2 as summed rather than from e e, a unit in the last place,
which moved 282 of the conformance corpus's 80,974 XP samples (130 sets, 128 of them at e 0.6 to 0.75) by at most
1.13e-5 m and one, a set whose orbit grazes the Earth's shadow so that a rounding-limited decision of 4 went the other
way, by 0.197 m at day 7 (digest 34cc810d5d99); 0.6.8 restores the digest.

Exploratory (the 2026-11-03 AP6 windows, already read; 72 h fits, day 3, leads from the fit end): the median paired
AP-minus-numerical-reference error falls from 26.64 to 22.42 m on Etalon-1 and from 36.39 to 23.55 m on Etalon-2
(11 windows each). The medians of LAGEOS-1 (15.44 to 14.10 m), LAGEOS-2 (11.89 to 12.24 m) and LARES-2 (15.04 to
11.00 m) change as shown; IG (36.258 m) and GE (54.310 m) are unchanged. On an Etalon-like orbit with
the epoch moved by whole sidereal days (the Earth's geometry fixed) the mean along-track offset swings between -47
and +39 m with the Moon, and removing the Moon from AP and the reference leaves about 2 m. Most of the rest of
Etalon's gap was the two-line lattice of the fitted set (16.9). `test/etalon-resonance.e2e.mjs` prints every window
and median.

**The sweep, rerun with 5.4's quadrature; no bound.** On orbits of n 2.0059 rev/day in three orientations (G1: i 63.4,
node 300, perigee 270 deg; G2: 63.4, 60, 90; G3: 55, 180, 0), against FFM EGM96 70x70 with Sun and Moon from an
AP-consistent state (72 h fits, 7 days flown hourly), the day-7 3D RMS with the degree 4 to 10 terms and without them:

| e | G1 on / off (m) | G2 on / off (m) | G3 on / off (m) |
| --: | --: | --: | --: |
| 0.05 | 21 / 99 | 15 / 78 | 35 / 97 |
| 0.07 | 22 / 100 | 15 / 78 | 36 / 98 |
| 0.085 | 22 / 101 | 15 / 78 | 38 / 98 |
| 0.1 | 23 / 102 | 16 / 79 | 39 / 98 |
| 0.2 | 28 / 111 | 21 / 87 | 55 / 102 |
| 0.3 | 35 / 115 | 27 / 101 | 75 / 112 |
| 0.5 | 33 / 73 | 39 / 157 | 123 / 320 |
| 0.65 | 61 / 161 | 78 / 148 | 164 / 166 |
| 0.72 | 121 / 335 | 145 / 217 | 241 / 102 |
| 0.74 | 187 / 504 | 168 / 208 | 355 / 120 |

The terms help at every e in G1 and G2 and up to e 0.65 in G3. At G3 e 0.72 and 0.74 the day-7 values turn while the
terms still help at days 1 and 3 (at e 0.72: 66 and 118 m with them, 143 and 330 m without; without them the error
swings through a minimum near day 7). 0.4.10 applied the terms below e 0.1 only: with 5.4's closed form the first turn
was G2's, between e 0.085 and 0.1, and came from that closed form. AP now applies them at every eccentricity; without
them the e 0.72-0.74 fixtures of 16.6 carry 594.8 m (half-day) and 1177.5 m (Molniya) at day 7, and the day-1
along-track RMS is 91.2 and 78.6 m.

**Perigee radius and GTO.** On the fixtures of 16.6 flown on 2-minute samples, the radial error at each of the
reference's perigees, fitted with a constant, a slope and a term alternating between consecutive perigees, drifts
+1.6 +/- 0.5 m/day (half-day), +3.0 +/- 1.5 (Molniya) and +2.0 +/- 5.8 (GTO) at 0.4.11; +6.9 +/- 1.7, +7.2 +/- 4.1
and -14.2 +/- 5.8 at 0.4.10; +0.8 +/- 0.6, +2.6 +/- 1.1 and +2.5 +/- 6.1 with no Sun or Moon on either side. No
third-body drift remains. On the same samples GTO's day-7 whole-day RMS (along-track/radial) is 958/933 m at 0.4.11,
882/858 m at 0.4.10 and 931/912 m with no Sun or Moon on either side (929/914 and 936/918 m with the Moon removed from
both). 0.4.11 sits within 3 % of the error the Sun and Moon do not cause; 0.4.10's third-body errors partly cancel it.
With the geopotential cut to J2-J4 on both sides (GTO's period is not resonant), the day-7 RMS is 387/392 m at 0.4.11,
381/396 m without Sun or Moon and 480/445 m at 0.4.10. Evaluating the short-period terms with the bodies at the
orbit's middle instead of the output time moves the day-7 RMS by tens of meters either way (half-day 78/101 m, Molniya
161/47 m, GTO 924/905 m); a 24 h fit gives half-day 71/82 m (0.4.10: 182/133 m), GTO 2447/2024 m (1632/1333 m) and
Molniya, whose drag one day does not resolve, 3077/2307 m (3833/2898 m).

**Cost.** Owner Mac under load, browser host, `propagate` over 7 days, median of 7 runs, milliseconds per object-day
from 0.4.10 to 0.4.11: on a 1 h grid LEO 1.73 to 2.10, Etalon-like 4.44 to 5.33, GPS-like 4.36 to 5.66, half-day
12.3 to 11.9, Molniya 11.5 to 12.0 and GEO-like 1.43 to 1.58; on a 1 min grid 58.2 to 73.5, 51.3 to 80.8, 51.5 to
72.5, 65.8 to 80.0, 62.2 to 86.1 and 51.0 to 51.6. Evaluating the nodes' cosines and sines for every term instead of
the table cost about 250 ms per object-day on the 1 min grid.

**16.9 AP sets at full precision.** `fit` rounds an SGP4XP set to the two-line text's digits and searches their
lattice (mean motion 1e-8 rev/day, eccentricity 1e-7, angles 1e-4 deg), the set the Space Force library reads. An AP
set (16.1, marked as 16.5 states, so it flies on AP only) keeps the solution's full precision. One unit of an angle's
last digit is 1.7e-6 rad: 44 m at 25,500 km and 74 m at the geostationary radius, so the lattice bounded AP's error
from below on medium and high orbits.

On an Etalon-like orbit (2.13 rev/day, e 0.0007, i 64.9 deg; nodes 0, 90, 180 and 270 deg) against FFM EGM96 70x70
without third bodies (a test build with both mass ratios 0; 72 h fits, 7 days flown hourly), the day-7 cross-track RMS
falls from 22-23 m to 0.75-0.78 m and the along-track RMS from up to 52 m to 1.8-6.8 m. With J2 alone, or J2 and J22
alone with every piece of the class's degree-2 terms in, both are under 1 m. Exploratory (the AP6 windows, already
read; day 3, leads from the fit end; 0.4.8 to 0.4.9): Etalon-1 paired AP-minus-numerical-reference 22.42 to 10.12 m,
Etalon-2 23.55 to 9.74 m; medians LAGEOS-1 14.10 to 7.81 m, LAGEOS-2 12.24 to 6.78 m, LARES-2 11.00 to 9.73 m, IG
36.26 to 17.10 m, GE 54.31 to 45.86 m. The e 0.72-0.74 fixtures of 16.6 at day 7: half-day 104.7 to 91.4 m, Molniya
654.1 to 700.4 m, GTO 2326.6 to 2356.1 m, 12-hour 55 deg 188.7 to 175.5 m. `test/twelve-hour-class-terms.e2e.mjs`
prints every number. The AP covariance calibration of 12.7 is re-measured on these sets with its noise constants
unchanged: one of its eight cells (ABOVE, day 1) is now inside the band, none was before.

**16.10 The half-day class's step.** The step is fixed (95 min in the long-period regime, 38 min in the one-day class) with no
error control. It resolves perigee only for (1 - e)^(3/2) >= 2 pi h / P: e up to 0.44 at 95 min and 0.70 at 38 min on a
one-day orbit. Beyond that the theory's own equations are integrated with a mean-longitude error of 0.2 km a week at e 0.5 and
0.4 to 4.6 km a week at e 0.7 to 0.82 at 95 min, and 0.09 to 0.17 km at e 0.82 at 38 min.

The averaged regime steps two revolutions (9). AP's half-day class (1.604 to
2.406 rev/day) carries resonant terms in lambda - 2 theta, whose period 2 pi / |n - 2 omega_E| is long near the
commensurability (Molniya at 2.00 rev/day: 183 days; the half-day fixture at 2.0059 and GPS: 6.5 and 22 years) and
short away from it (GTO at 2.40 rev/day: 2.5 days; Galileo at 1.70: 3.3 days; BeiDou at 1.86: 6.9 days); two
revolutions, 20 h on GTO, do not resolve the latter. From 0.4.14 the class steps at most a 32nd of that period: 114
min on GTO, 150 on Galileo, 312 on BeiDou and 357 to 359 on Etalon and GLONASS; near the commensurability the two
revolutions stand, and the half-day, Molniya, 12-hour 55 deg and GPS cases are bit for bit 0.4.13's. Against the class
stepped at 23.75 min (11.875 min moves that by under 0.003 m in 7 days), on seeded FORCES 31,20 sets: GTO 0.065 m RMS
over one orbit (two revolutions: 84.5 m, and 261 m over 7 days), the 500 km perigee GTO 0.057 m, and over 7 days
Galileo-, BeiDou- and Etalon-like orbits 0.004, 0.013 and 0.016 m.

On FFM model truth without Sun or Moon on either side (2-minute samples; day-7 3D RMS, m), the geopotential cut on both
sides, the class stepped two revolutions and 95 min:

| Field (AP degrees) | GTO, 220 km perigee | GTO, 95 min | 500 km perigee | 500 km, 95 min |
| --- | --: | --: | --: | --: |
| 4x4 (4,4) | 237.5 | 233.2 | 195.8 | 189.3 |
| 8x8 (8,8) | 604.6 | 558.1 | 451.7 | 427.0 |
| 12x12 (12,12) | 822.1 | 472.0 | 585.1 | 379.1 |
| 20x20 (20,20) | 1,147.4 | 494.7 | 753.9 | 380.3 |
| 70x70 (31,20) | 1,369.8 | 627.6 | 831.1 | 418.4 |

On GTO at 70x70 the class stepped 600, 450, 300, 190, 95 and 47.5 min gives 639.0, 623.6, 626.3, 627.2, 627.6 and
627.7 m. With zonals only the comparison does not separate the fields: XP's own half-day resonance terms (SPEC 6) have
no counterpart in a zonal truth (4x0 against AP 0,4: 600.3 m). What remains on GTO grows with the degree (233 to 628 m
from 4x4 to 70x70): high-degree terms at perigee that AP does not carry.

FFM model truth with Sun and Moon (`test/gto-geopotential-perigee.e2e.mjs`; hourly, day-7 whole-day RMS
along-track/radial against 0.4.13): GTO 960.82/935.27 to 419.32/455.90 m (day-7 sample 2449.15 to 929.45 m), the 500
km perigee GTO 605.15/576.31 to 295.44/304.96 m; on the read AP6 windows Etalon-1 and -2 move from 6.64 and 7.58 to
6.72 and 7.74 m (paired day 3) and LAGEOS-1 and -2, LARES-2, IG and GE not at all; on the Etalon-like synthetic orbit
of `test/twelve-hour-class-terms.e2e.mjs` (no Sun or Moon) the day-7 along-track RMS at nodes 0, 90, 180 and 270 deg
is 3.22, 2.10, 1.65 and 2.84 m (3.37, 3.19, 1.77 and 6.76 m at 0.4.11), cross-track and radial within 0.02 m.

Cost (owner Mac under load, browser host, `propagate` over 7 days, the two releases interleaved, median of 9 runs,
milliseconds per object-day from 0.4.13 to 0.4.14): on a 1 h grid GTO 12.0 to 16.2, Galileo-like 5.8 to 10.5 and
Etalon-like 5.1 to 6.1; on a 1 min grid 121.3 to 124.3, 86.6 to 89.7 and 74.9 to 76.4; LEO, GPS-like, half-day,
Molniya and GEO-like unchanged (2.1, 5.2, 11.7, 11.6 and 1.4 ms on the 1 h grid).

**16.11 Wide terms above e 0.3; the tesseral switch by class.** A perigee pass spreads each term of the field over the harmonics of M. From 0.4.15,
above an epoch eccentricity of 0.3, AP's zonal tail (16.3) carries every long-period term, w = l - 2p for p = 0..l with
q = -w (G = O(e^|w|)), not only w = 0 and +-1. From 0.6.3 the first-order tesseral terms of degree 2 to 12 (16.2) are not a
series in M there. From 0.6.4 the tesseral families' switch is by the set's resonance class (6, the band of the epoch mean
motion, `src/tesseral.inc` `wide_set`): a set in no resonance band (class 0: low orbit above 3.61 rev/day, the LAGEOS band at
6.4 to 6.5 rev/day, orbits below 0.80 rev/day) flies the grid above an epoch eccentricity of 0.05; a set in the one-day,
half-day, eight-hour or sixteen-hour class keeps the 0.3 switch. The zonal tail's wide set, the perigee drag passage (16.12)
and the fit's wide blocks (12.8) keep 0.3 in every class. Measured against the independent full-force reference of 16.11's
last paragraph (orbit-accuracy-experiments results/ap-truth/tesseral-diagnosis, the kWideE 0.01 probe build, byte-identical
to 0.6.3 above the switch on 12 of 12 sets): in the non-resonant regimes the first-order set fails the one-day line where the
grid passes it (Ajisai at e 0.05 and 0.1; LAGEOS-1 at 0.05, 0.1 and 0.2; LAGEOS-2 at 0.05 and 0.1: forward tesseral shares
of 3.0 to 18.4 m on the set against 0.4 to 3.2 m on the grid) and the grid's one-epoch flight is cheaper by 88 to 408 ms
(the set's first-order table is the larger build there); in the half-day class (GPS, GLONASS, Etalon, Molniya at e 0.05 to
0.29) the resonant mixed share is untouched by either and the grid costs 70 to 167 ms more, so the resonant classes keep the
set. The eight-hour and sixteen-hour classes were not measured and keep the shipped switch. A set keeps its epoch class's
switch for the whole flight (16.7). 0.6.4 therefore changes a flight only for a class 0 set with
0.05 < e <= 0.3; every other set is byte-identical to 0.6.3 (PRODUCER's version aside), and the 0.6.4 validation
(orbit-accuracy-experiments experiments/operator-theory/TESSERAL-SWITCH-BY-CLASS.md) states its cells, the catalog budget on
persistent instances and the identity set.

Above the eccentricity switch AP carries the resonances 1:1, 2:1, 3:1 and 3:2 only; every other commensurability is absent:
0.5 to 1.8 km a week on a transfer orbit (485 m at day 7 with a 12 x 12 field, 58 m without order 9, 1.5 to 1.8 km with the
full field; a one-day orbit at e 0.82 is 3.65 km at degree 12 against 0.56 km at degree 4; 6).

Below the eccentricity switch (0.05 in class 0, 0.3 in the resonant classes) the first-order tesseral table keeps |q| <= 1. The
terms dropped are of order e^2 and reach, just below the switch, 14 m at a = 7,600 km (20.6 m against 15.2 m just above it), 12 m
in a 12-hour orbit (13.5 against 6.7 m) and 7.5 m in a geosynchronous orbit (7.6 against 1.1 m), RMS over a 72 h arc.

For each (l, m, p), the sum over q of G_lpq e^{i(w+q)M} is (a/r)^(l+1) e^{iwf}, so each (m, w) family's
first-order displacement (Lagrange's equations, each harmonic divided by its psi-dot, lambda also through n) is a periodic
function of the anomaly, complete in j. At init it is built on 128 uniform eccentric anomalies from the family's forcing:
H = e^{-i nu e sin E} IFFT(FFT(R (1 - e cos E) e^{i nu e sin E}) / (i (k - nu))) / M-dot, nu = -(w omega-dot + m (Omega-dot -
omega_E)) / M-dot, R the six rates, the harmonics 16.2 leaves out (m-daily, the class's, the half-day class's tail,
|psi-dot| < 0.045 n) subtracted one by one with G and dG/de by the trapezoid on those nodes. Kept on those nodes in single
precision, its derivatives in e, i and a / a (forward differences) on 64 of them in half precision (3.1 MB a grid), and read at
output time by the four-point periodic cubic in E, linear in the mean
elements' offsets, times e^{i(w omega + m beta)}. A grid is built at the set's mean elements at every 48 hours from its epoch
(the same nodes for every set of a fit) and blended linearly into the next node's over the last fifth of each interval. A grid
is keyed by its set's exact elements (bitwise n, e, i, the class and the degree): a lookup matches only that key, and a grid held
from an earlier call is the same bytes a rebuild gives. A copy initialized while its nominal set's xpt::GridShareScope lives (the
covariance's sigma sets, a fit iteration's perturbed copies) reads the nominal's grids, its schedule nodes included, linearly, when
within 3e-4 in e, 1e-4 rad in i and 1e-4 in a / a of them; each set keeps its last two nodes. A grid built by a set initialized on
a thread while tess::FitGridScope lives there (thread-local; the fit holds it around its solve on its calling thread) is freed when
its last holder drops it, never kept idle, so a fit leaves no grid behind. The export sdnap_wide_grid_stats(reset, out) writes the
grid lookups since the last reset, out[0] by sets outside a fit and out[1] by a fit's sets (reset != 0 zeroes them after reading);
sdnap_wide_grid_cache(out) writes the grids the cache holds (out[0]), their bytes (out[1]) and the grids built since the
instance began (out[2]). The 128-node rule is exact to 1e-13 to degree 20; at degree 31 its relative error is 1e-6 at e 0.72 and
2e-3 at e 0.79. Against the full-field quadrature on THEMIS (e 0.82, 7 days at
300 s): 0.12 m RMS, 2.6 m at most, 3 mm second difference, and 0.09 m RMS with the eccentricity drifting 3e-3 a week; a
first-order series in M, the set the grid replaces, was 65 m RMS and 2.96 m. The near-resonant terms above degree 12 stay in
the table (`src/tesseral.inc:323`); the table builds none of the general set above the switch (`src/tesseral.inc:324`). Below the switch both sets are 0.4.14's: propagations at e 0.25 and 0.3 of Etalon- and GPS-like seeded
sets and of LEO sets at e 0.05 and below are byte-identical. The method is fixed once per flight from the fitted epoch elements: `src/tesseral.inc:43` sets
kWideE = 0.3 and `:49` kWideENonResonant = 0.05, `src/tesseral.inc:264` reads `const bool wide = wide_set(cls, e0);` when the set's terms are built at initialization
(`src/xp_theory.inc:1473` builds the grid on the same test of the epoch eccentricity), the output tests only whether the set
holds a grid (`src/xp_theory.inc:1279` and `1290`), and the 48-hour schedule (`src/xp_theory.inc:1719` to `1777`) rebuilds the
grid at the node elements without re-evaluating the test, so no flight switches method in flight. Against an independent
full-force reference (propagator/ffm 2.2.1 with the same field, Sun and Moon from DE440, in vacuum; orbit-accuracy-experiments
e53a8ef0e1261523f5d28a617b9a5177d629e4f2, results/ap-truth/tesseral-all-regimes/table.json, `primary.steps`) a set fitted at
e 0.29 and flown one day is 22 m RMS (41 m at most) for a one-day orbit, 27 m (55 m) for a half-day Molniya-like orbit and 25 m
(56 m) for GTO, the first-order set's own error near 0.3; a set fitted just above 0.3 (e 0.31; Molniya 0.30) is 10 m RMS
(12 m at most), 26 m (45 m) and 15 m (29 m), the grid's. Two sets fitted on either side of 0.3 can therefore differ by about the
first-order set's own error, the set above 0.3 the nearer to the reference. A fit above e 0.3 builds a grid for each
set it initializes at new elements (about 13 an iteration on the GTO fixture, about 45 ms each in wasm), so fits there may take
up to about twice 0.6.2's time; such a fit's wasm memory stays below 90 MiB on THEMIS A, the GTO and the Molniya fixtures.

The 4x4 case of 16.10 measured a mismatch: XP carries J5 (2) at every FORCES and the 4x4 truth has none. With J5 zero on
AP's side 0.4.14 is at 98.9 m on day 7 (2-minute samples, Sun and Moon off both sides, 72 h fits, 3D RMS), flat over the
7 days. The zonal fields alone on both sides, XP's resonance terms off on AP's side: J2 20.8 m, J2-J3 49.8, J2-J4 48.9,
J2-J5 46.6; with XP's J2^2 terms removed 1,873 m. The flat 30 to 50 m is the J3 to J5 short-period set, which XP does
not carry and this release does not derive; it is open. 24 h fits give 66.2 m (J2) and 159.5 m (J2-J4).

The zonal tail's missing long-period terms carried a linear drift. Zonal fields alone, AP (0, d), day-7 3D RMS from 0.4.14
to 0.4.15: 8x0 561.6 to 40.3 m, 12x0 347.5 to 45.1, 20x0 400.1 to 45.1, 40x0 442.7 to 44.8; at degree 70 the fit does
not converge in either release. On GTO the tesseral set's slow terms outside the class carry much of the rest: (m, j) =
(5, 2) and (7, 3) drift at 0.089 n and 0.075 n (4.7 and 5.5 days); keeping only the new terms faster than 0.2 n leaves
the GTO fixture at 721.97/511.68 m.

| Field (AP degrees), Sun and Moon off both sides | 0.4.14 | 0.4.15 |
| --- | --: | --: |
| 4x4 (4,4), J5 zero on AP's side | 98.9 | 89.6 |
| 8x8 (8,8) | 558.1 | 59.3 |
| 12x12 (12,12) | 471.9 | 63.1 |
| 20x20 (20,20) | 494.7 | 85.3 |
| 40x40 (31,40) | 612.9 | 138.3 |
| 70x70 (31,20) | 627.6 | 201.9 |
| 70x70 (31,20), 500 km perigee | 418.3 | 90.9 |

FFM model truth with Sun and Moon (`test/gto-high-degree-perigee-terms.e2e.mjs`; hourly, day-7 whole-day RMS
along-track/radial, m):

| Fixture | 0.4.14 | 0.4.15 |
| --- | --: | --: |
| GTO | 419.32 / 455.90 | 204.15 / 133.92 |
| GTO, 500 km perigee | 295.44 / 304.96 | 109.46 / 70.85 |
| half-day | 84.22 / 75.28 | 34.33 / 23.12 |
| 12 hours at 55 deg | 158.02 / 105.47 | 67.25 / 25.32 |
| Molniya with drag, coefficient fitted | 149.82 / 175.90 | 291.41 / 219.72 |
| Molniya with drag, coefficient pinned at the truth's 0.044 | 159 / 92 | 144 / 120 |

Molniya with its drag coefficient fitted regresses: the 72 h fit takes 0.0457 m^2/kg against the truth's 0.044 (0.4.14:
0.0451), and the along-track error grows quadratically after the fit (33, 41, 51, 86, 142, 209 and 291 m whole-day on
days 1 to 7). Without drag it improves from 108/102 to 51/36 m; with the coefficient pinned at the truth every build
lands at 141 to 159 m along-track. From 0.4.16 the pinned case is 70.9 m with AGOM pinned at 0 (16.12) and the fitted
case 276.4/208.3 m; the 72 h arc does not separate the coefficient at e 0.74 (12.8).

Against independent integrations at the GTO fixture's elements (argument of perigee 270 deg, and 300 deg, where the zonal
e and i rates do not vanish), J6-J20 and the 1,888 tesseral terms kept there: the zonal tail's rates against the potential
averaged over M by quadrature (8,192 points in E) differ by at most 6.5e-6 m over one orbit, the rates moving the elements
by up to 21 m; the tesseral displacements against a numerical integration of their rates (RK4, 0.1 min) by at most
1.1e-9 m RMS (sizes 20 to 165 m), and against Hansen coefficients by quadrature in M (8,192 points; worst relative
difference 8.2e-6) by at most 1.6e-4 m RMS.

Cost (owner Mac under load, browser host, `propagate` over 7 days, the two releases interleaved, median of 9 runs, ms per
object-day from 0.4.14 to 0.4.15):

| Orbit | 1 h grid | 1 min grid |
| --- | --: | --: |
| GTO | 24.6 to 37.0 | 133.5 to 161.9 |
| half-day | 16.3 to 30.3 | 123.6 to 152.6 |
| Molniya | 18.2 to 30.5 | 118.1 to 159.1 |

Orbits at e 0.3 and below run 0.4.14's path, except the tesseral families of a class 0 set above e 0.05, the grid from 0.6.4.

**16.12 Drag above e 0.3.** A drag pass at perigee is narrow against the orbit: the energy goes in a step, at the
Earth angle of the passage. From 0.4.16, above an epoch eccentricity of 0.3 (the set of 16.11), AP evaluates 3.4's drag
per perigee passage:

- **Time.** The rate at t is the mean of the passages before and after t, t_p = t - M/n and t_p + 2 pi/n. Each node of
  a pass takes the date and the Earth angle of its own time on it, t_p + M(nu)/n, M(nu) by Kepler's equation; the flux
  and date terms are the passage's. The rate at t's own Earth angle averaged the density over every longitude, while a
  repeating ground track (Molniya, 2 rev/day) passes perigee at two, alternating. The nearer passage alone is biased by
  the two-revolution step, whose stages fall unequally on the two (+0.4 % in energy on Molniya).
- **Arc.** The arcs nu_c < |nu| < pi are added, 13 Gauss-Legendre nodes each at nu = nu_c + (pi - nu_c) s^2, s_j =
  (x_j + 1)/2, weight w_j (pi - nu_c) s_j / nu_c in the units of the perigee arc's sums; the co-rotating air at the
  node's radius r: V = sqrt(1 + 2 e cos nu + e^2 - 2 q theta rho + q^2 cos^2 phi' rho^2 / D^2), rho = r D / p.
- **Short-period steps.** In the output, each element y_j + (ydot_j / n)(pi - M), M in [0, 2 pi) and ydot the drag's
  rates at the output time, and lambda also + (ndot / n^2)(pi M - M^2/2 - pi^2/3), the integral of n's own sawtooth: the
  osculating elements step at perigee where the mean elements ramp. From 0.6.6 those rates are evaluated per segment,
  the stretch of one revolution (its two passages fixed) inside one interval of the mean-element grid (the mean state
  one cubic): the quadratic in t through the rates at the segment's three points s_0 + (k + 1/2)(s_1 - s_0)/3, each at
  the grid's own mean state there. Three evaluations serve every output state of the segment in place of one at each;
  against the rates at each output time the state differs by 0.23 mm and 1.4e-7 m/s at most over 30 days
  (test/kernel-cost.mjs --diff; the largest at a 250 km perigee, B 0.01 m^2/kg, active weather). A fit keeps the rates
  at each of its states.

At e 0.3 and below, and without drag, the path is 0.4.15's, byte for byte (the XP digest and the drag-off runs below).

Isolation, Sun and Moon off on both sides (AP's masses zero in a test build; FFM without third bodies). AP's set at B =
0.044 flown 7 days against FFM from AP's own epoch state, drag on minus drag off on both sides (the shared gravity
residual cancels); AP's drag energy per perigee pass over FFM's, all passes, and the day-7 whole-day along-track RMS (m):

| AP | Molniya | GTO | GTO-500 |
| --- | --- | --- | --- |
| 0.4.15 | 0.9840, 582 | 0.9907, 102,584 | 0.9958, 1,130 |
| passage times | 1.0002, 669 | 0.9916, 102,030 | 0.9963, 1,127 |
| and the whole orbit | 1.0024, 691 | 0.9995, 117,131 | 0.9990, 1,181 |
| and the short-period steps | 1.0026, 22 | 0.9991, 2,480 | 0.9987, 26 |

AP's density and path were not the error: along FFM's path AP's NRLMSISE-00 integrates to FFM's pass loss within 0.01 %,
and AP's own flown path carries the same work within 0.01 %, its perigee within 2 to 31 m of FFM's. The arc beyond nu_c
held 0.23, 0.88 and 0.30 % of the pass's work, the passage times 1.6 % on Molniya and nothing on the two GTOs, whose
perigee longitudes do not repeat; the quadrature's order changes nothing (13 Gauss-Legendre nodes against 401 Simpson
points). The seeded along-track error was the ramp: a continuous rate against a step is a mean-motion offset of half
the per-pass period change, 582 m to 103 km a week, which a fit takes into the mean motion. With BTERM pinned at the
truth and AGOM pinned at 0 (a 72 h fit) the energy ratio follows the seeded one, 0.9916 to 1.0054 (Molniya) and
0.9963 to 0.9995 (GTO-500), and day 7 goes from 157.2 to 93.4 m and 176.5 to 93.5 m. A pinned fit that leaves AGOM free
takes 0.0007 (Molniya) to 0.0034 m^2/kg (GTO-500) against a truth without SRP and moves the apparent drag by +0.8 and
+1.7 %, of opposite effect on the two fixtures' forecasts.

FFM model truth with the Sun and Moon (`test/drag-high-eccentricity.e2e.mjs`; 72 h fits from an osculating perigee,
7 days on a 10-minute grid, day-7 whole-day RMS along-track/radial, m):

| Case | 0.4.15 | 0.4.16 |
| --- | --: | --: |
| Molniya, BTERM pinned at 0.044 and AGOM at 0 | 165.88 / 125.20 | 70.86 / 48.56 |
| drag theory, seeded, on minus off: Molniya | 593.72 / 411.57 | 26.51 / 20.59 |
| drag theory: GTO | 99,624 / 66,866 | 3,259 / 3,408 |
| drag theory: GTO-500 | 1,118.17 / 728.27 | 31.97 / 29.34 |
| Molniya, drag off | 44.63 / 34.38 | 44.63 / 34.38 |

The fitted coefficient is 12.8's. Against the module's independent integral over one orbit
(`sdnap_drag_orbit_check`: the Gauss equations of -(1/2) rho B |v_rel| v_rel along the mean orbit, the density and the
co-rotating air at the radius of 3.4, every sample at its own time, 20,000 Simpson points per pass) the six elements'
changes over one period agree within 0.0003 m RMS on Molniya and GTO-500 and 0.023 m on GTO (2,168 m in a per orbit),
at days 0, 1, 3 and 7.

Cost (owner Mac under load, browser host, `propagate` of the seeded set over 7 days with drag, the two releases
interleaved, median of 9 runs, ms per object-day from 0.4.15 to 0.4.16):

| Orbit | 1 h grid | 1 min grid |
| --- | --: | --: |
| Molniya | 20.5 to 22.5 | 104.0 to 206.2 |
| GTO | 27.1 to 34.9 | 111.5 to 253.1 |
| GTO-500 | 25.8 to 31.5 | 105.0 to 207.1 |

A rate evaluation takes two passes of 39 nodes against 13; the 1 min grid doubles because every output sample evaluates
the drag's rates for its short-period steps. Orbits at e 0.3 and below, and without drag, run 0.4.15's path.

---

**One-day archive windows.** On 2026-11-03 the selected 38-minute step was confirmed on new 72-hour
fit cutoffs 2025-10-05, 10-09 and 10-13 for every AP6 GE/IG object, absent from AP6's original cutoff
list. These windows share AP6's GFZ truth span; they are not independent-truth validation. The AP6
300-second thinning, 90% fit coverage, 260-sample daily minimum and as-issued weather are retained.
Leads are daily bins after the fit ends. Eighteen GE and 36 IG windows pass coverage; nine GE windows
are excluded for missing fit or lead coverage. Both step arms are fitted independently.

| Group | Day | 95-min median 3D (m) | 38-min median 3D (m) | Median paired change (m) |
|---|---:|---:|---:|---:|
| GE | 1 | 18.988 | 18.512 | -0.740 |
| GE | 3 | 46.658 | 41.876 | 0.193 |
| GE | 7 | 217.657 | 235.913 | 5.860 |
| IG | 1 | 25.405 | 24.723 | -0.306 |
| IG | 3 | 34.989 | 33.328 | -0.361 |
| IG | 7 | 70.488 | 68.410 | 0.189 |

The shorter step reduces numerical integration error; these mixed archive changes do not establish a
uniform forecast-accuracy improvement. All windows and coverage exclusions are printed by the E2E and
stored in `test/results/geo-step-convergence.json`.


## 17. Products: the producer contract (side B's method, outside the SGP4-XP specification)

What `fit` and the covariance exports hand to the product writers P1 to P9 (`spacedatastandards.org` `lib/js/PROD`):
one `$OCM` per fit, its `$ODR` of residuals, and the covariance per epoch. `test/products-parameters.e2e.mjs`.

### 17.1 Parameter order and units

The covariance rows are the state (TEME position, km; velocity, km/s; `COV_TYPE` CARTPV) and then, when present and
solved, in this fixed order:

| Row kind | prwDynamicParameter | Unit | The theories' sensitivity |
| --- | --- | --- | --- |
| 6 | DRAG_AREA_OVER_MASS (BTERM) | m\*\*2/kg | yes (central difference of the theory) |
| 7 | DRAG_AREA_OVER_MASS_RATE | m\*\*2/kg/s | none |
| 8 | SRP_AREA_OVER_MASS (AGOM) | m\*\*2/kg | yes |
| 9 | IN_TRACK_ACCELERATION | m/s\*\*2 | none |
| 10 | OUTGASSING_ACCELERATION | km/s\*\*2 | none |

`COV_SIZE` is 6 plus the solved count; `COV_PARAMETERS` and `COV_PARAMETER_KINDS` have `COV_SIZE - 6` entries in that
order; `COV_UNITS` has `COV_SIZE` entries (km x3, km/s x3, then the parameters' units); `COV_ORDERING` LTM;
`COV_REF_FRAME` the record's `TRAJ_REF_FRAME`. `OD_DYNAMIC_PARAMETERS` names every row, `SOLVED_FOR` true for each;
`fit` lists DRAG_AREA_OVER_MASS and SRP_AREA_OVER_MASS and nothing it does not know.

### 17.2 Parameters the theories have no sensitivity to

SGP4XP and AP have no term in DRAG_AREA_OVER_MASS_RATE, IN_TRACK_ACCELERATION or OUTGASSING_ACCELERATION, and the force
model does not change for them. The fit options `fit_bdot`, `fit_thrust` and `fit_outgassing` (one byte each after
`fit_agom` in the 56-byte `sdnap_fit` options) default off; set, the fit is refused before it runs (`sdnap_fit` status
-4; `sdnap_fit_refusal` gives `parameter-not-modeled:<NAME>`). The `$PCF` has no field for them, so `fit` never sets
them. A record that carries their rows (solved by another determination) is read and flown as constant parameters:
their state transition columns are zero, their variances and mutual terms constant, their cross terms with the state
carried by the state columns (`P(t) = J(t) P_p J(t)^T`, the parameter block of `P_p` the record's).

### 17.3 Statistics

- Weighting: the fit weights each TEME position component with the a priori sigma 1 km (unit weights;
  `OD_DATA_WEIGHTING` states it).
- `WEIGHTED_RMS` = sqrt(sum (r_i / sigma)^2 / (3 N)) over the N fitted states' components = `FIT_RMS_KM` / sqrt(3) / 1 km.
- `SEDR` (W/kg), the energy the non-gravitational forces remove (the `$OCM` definition): -dE/dt =
  (mu / (3 a)) (n-dot_ng / n), positive under drag, with mu / a = (n a)^2 from the set's mean motion and the theory's
  semi-major axis, and n-dot_ng / n the theory's epoch rate with BTERM less the rate without it
  (`COV_PROPAGATION.NON_GRAVITATIONAL_RATE_PER_DAY`, per day, here per second). Written with the covariance.
- Emission refusals, never a partial record: a parameter row without a name (`cov-parameter-unnamed`), a name or kind
  outside the five (`cov-parameter-unknown`), rows out of the fixed order (`cov-parameter-order`), `COV_UNITS` other than
  above (`cov-units`), `COV_SIZE` not 6 plus the solved count (`cov-size`).
- Reading (`cov::read`): rows out of the fixed order, a kind outside the five or not solved for are malformed
  (`invalid-covariance`; `sdnap_covariance_at` -6).

### 17.4 Residual record

`fit` writes one `$ODR` per fit on `residuals`, after its `$OCM`: `RUN_ID` and `OCM_CONTENT_ID` the `$OCM`'s CID,
`CONVERGENCE_REASON`, and `EDITED_OBSERVATIONS`, one per state of the input block in order (the input count):

| Column | Value |
| --- | --- |
| OBSERVATION_ID | `<ephemeris frame>.<block>.<state>`, from 1 |
| EPOCH | the state's UTC time |
| OBSERVATION_TYPE | POSITION_VECTOR |
| OBSERVED_VALUE, COMPUTED_VALUE | the state's and the fitted set's geocentric distance, km (frame independent) |
| WEIGHT | 1 / sigma^2 = 1 per km^2 inside the fit arc; 0 outside |
| ACCEPTED, REASON | inside the fit arc; REASON BEFORE FIT ARC or HELD OUT otherwise |
| NORMALIZED_RESIDUAL | (observed - computed) / sigma |
| PERTURBATION_MODEL_CODE | SGP4XP or AP, the set's theory |

The residual is OBSERVED_VALUE minus COMPUTED_VALUE. A fit whose inputs have no per-observation form writes no rows,
and P9 is then refused downstream.

### 17.5 Covariance per epoch

The covariance the module propagates stays in the `$OCM`'s `COVARIANCE_DATA` layout: `sdnap_covariance_full_at(ocm,
length, minutes, count, out)` gives per time the TEME state and the LTM of the `COV_SIZE` x `COV_SIZE` covariance of the
state and the record's parameter rows (6 + N(N+1)/2 doubles); `sdnap_covariance_at` gives the 6 x 6 state block. The
state transition sensitivities are not exposed in any typed field (no output carries a PRW state matrix), so P8 is
refused.

### 17.6 The $OMM boundary

`export_omm` writes an SGP4XP set's BTERM and AGOM in the `$OMM`'s BTERM and AGOM fields (m\*\*2/kg) and leaves BSTAR and
MEAN_MOTION_DDOT unwritten. `ingest_omm` reads an SGP4XP set's BTERM and AGOM from those fields when either is present;
an SGP4XP `$OMM` with neither carries them, by the SGP4-XP element-set definition, in BSTAR and MEAN_MOTION_DDOT, and is
read from there (program decision D13; the owner may rule to refuse instead). The ingested `$OCM`'s HEADER.COMMENT states
the source in one fixed line: `BTERM_SOURCE=BTERM AGOM_SOURCE=AGOM` or `BTERM_SOURCE=BSTAR AGOM_SOURCE=MEAN_MOTION_DDOT`
(an SGP4 set: no line).

### 17.7 What an AP record's elements and caps mean

AP's mean elements are defined per resonance class, per regime (period below or above 1,100 min) and per eccentricity branch.
The same six numbers on two sides of a switch are different orbits: 8 to 401 m apart at epoch and up to 33 km after 7 days at
the regime limit. Sets on different sides must not be differenced, blended or interpolated.

The branch is fixed at the record's epoch, from its own epoch elements, for the whole flight (16.7): a record's output is
continuous in time wherever its mean motion and eccentricity go. The module differences and blends one branch only: a
covariance's moved sets fly the record's branch (12.1), a fit that would end on a switch is settled on one branch or refused
fit-at-branch-limit (16.7), and the epoch store does not blend two sets on different branches (14.3). A consumer that
differences, blends or interpolates two records of one object must do the same.

MAXIMUM_TESSERAL_DEGREE is a cap on families, not the degree of a field. With tesseral cap d the short-period terms are
complete to first order to degree min(d, 12) only; degrees 13 to min(d, 31) contribute their j = 1 near-resonant terms in low
orbit and the half-day tail, and nothing else. At 800 km the terms of degree 13 to 31 not carried are 14 m RMS (18.9 m in all
against a 31 x 31 field); at 450 km the order-15 terms above degree 31 add 72 m on day 1 and 268 m on day 7 after a 72 h fit.

An AP mean set and the state AP gives for it agree to first order only: integrated numerically that state leaves the AP
trajectory at dn/n = k J2^2 (R/a)^4, k from 1.8 to 9.6, 0.7 to 4.5 km/day in low orbit. AP elements must come from an AP fit.

## 18. The carried forecast (side B's method, outside the SGP4-XP specification)

An `$OCM` element set may carry a numerical forecast of its object (`src/carried.inc`). Inside the forecast's span flight
returns the forecast; everywhere else the theory, exactly as without it: a record without one flies as 0.6.6 (the build
before it) flies it, bit for bit (`test/carried-identity.e2e.mjs`).

### 18.1 Layout

SDS 1.279.0 as pinned, no schema change. `POLYNOMIAL_POSITION_RECORDS`, one `PPEPositionRecord` per segment:
`BASIS_TYPE` CHEBYSHEV, `NUM_COEFFICIENTS` n (fit writes 16, 24 or 32; a reader takes 1 to 64), `POS_COEFF_X`, `_Y`,
`_Z` (km), `EPOCH_MID` (ISO 8601 UTC, microseconds), `EPOCH_HALF_SPAN` (s), `MAX_POSITION_RESIDUAL` and
`RMS_POSITION_RESIDUAL` (km, against the densified forecast, 18.4). No velocity coefficients: the velocity is the series'
derivative. `TRAJ_TYPE` POLYNOMIAL_POS, `TRAJ_BASIS` PREDICTED. The frame is the set's `TRAJ_REF_FRAME`: TEMEOFEPOCH at
the set's `EPOCH` for AP with gravity terms, TEMEOFDATE otherwise. Each segment starts where the one before ends, within
1 ms; the span is the first segment's `EPOCH_MID - EPOCH_HALF_SPAN` to the last's `EPOCH_MID + EPOCH_HALF_SPAN`, both
included. Refused by name, on every flight: `POLYNOMIAL_OE_RECORDS` (carried-type-unsupported), records without
`TRAJ_TYPE` POLYNOMIAL_POS or that type without records (carried-type-mismatch, carried-records-missing), `STATE_DATA`
beside them (carried-state-data), another basis (carried-basis-unsupported), velocity coefficients
(carried-velocity-coefficients), a malformed segment or a coefficient that is not finite (carried-segment-invalid), a
gap or overlap over 1 ms (carried-gap).

### 18.2 Evaluation

The segment holding t (the last starting at or before it), tau = (t - EPOCH_MID) / EPOCH_HALF_SPAN, p = sum c_k T_k(tau),
p' = sum c_k T_k'(tau) / EPOCH_HALF_SPAN. M(t), GCRF to TEME of date: the module's output matrix, the one every GCRF
state takes (gcrf.inc `gcrf_to_teme_output`, the quintic through 6-hour nodes with GMST82 unrounded), made orthonormal
(one Newton step of the polar decomposition); dM/dt its central difference over +-60 s. TEMEOFEPOCH: Q0 = M(t0) at the
set's epoch; TEME r = M Q0^T p, v = M Q0^T p'; GCRF r = Q0^T p, v = Q0^T p'. TEMEOFDATE: TEME r = p, v = p' - dM/dt
M^T p (the module's convention, the GCRF velocity turned by M); GCRF r = M^T p, v = M^T (p' - dM/dt M^T p). EME2000 is
the frame bias of GCRF. No ERFA call per state: a carried GCRF state costs what a carried TEME state costs. M is within
1.1e-13 rad of the exact chain (ERFA, GMST82 unrounded) over 30 days at 7-minute steps (`sdnap_carried_frame_error`):
0.005 mm at 42,164 km. fit undoes its own exact rotation of a GCRF block (gcrf_to_teme), so a forecast given in GCRF
flies back in GCRF to the series alone.

### 18.3 Flight

`propagate`: inside the span the forecast in OUTPUT.FRAME; the theory is not initialized when every requested time is
inside the span and the record carries no `COVARIANCE_DATA`. `load_epochs`: the store keeps the segments;
`sdnap_epochs_set_at`, `sdnap_epochs_at` and `propagate_epochs` time the forecast by the call's split Julian date
(`test/carried-epochs.e2e.mjs`); selection (SPEC 14) is unchanged, and a blend joins two carried forecasts or two theory
states only: a switch between a carried forecast and the theory is a step (14.3). Covariance: the theory's (SPEC 12) beside
the forecast's states. `sdnap_covariance_at`, `sdnap_covariance_full_at`, `events`, `maneuver` and `export_omm` use the
theory; `export_omm` writes the set (an `$OMM` has no place for the forecast). At the span's ends the state jumps by the
theory's distance from the forecast there (no blend), which fit states (18.4).

### 18.4 fit

`$PCF` OUTPUT on fit names the forecast the record carries: START_TIME and STOP_TIME, both or neither; EPOCHS, FRAME
other than UNSPECIFIED, STEP_SECONDS and MAXIMUM_STATES away from their defaults are refused by name
(configuration-refused). The theory set is fitted exactly as without OUTPUT: the block marks its fit arc as before
(USEABLE_STOP_TIME or FIT.HOLDOUT_HOURS), its later states held out and scored. The block's states, ascending, reach from
at or before START_TIME to at or after STOP_TIME (carry-order, carry-not-covered). From those states and up to four
beyond each end:

1. Each state in GCRF (a GCRF or EME2000 block's own, undoing the fit's exact rotation; any other block's by M), then in
   the record's axes: Q0, or M with the velocity M v + dM/dt r.
2. Consecutive states inside the span at most 0.1 rad of arc apart about the Earth's center (carry-states-sparse): 60 s
   in low orbit and at the perigee of a transfer orbit. Measured on FFM states: 0.4 to 5 mm at 0.066 to 0.092 rad; 5 to
   1,600 mm at 0.11 to 0.13 rad (120 s in low orbit).
3. The interpolant: the 4-node Hermite of positions and velocities (degree 7); the 8-node Lagrange of the positions
   when a state has no velocity, or when the velocities differ from that Lagrange's derivative, times the interval to
   the neighbor, by more than 20 mm RMS (FFM: 3 to 11 mm in low orbit at 60 s, under 0.1 mm above; SGP4XP: 37 mm at
   geosynchronous altitude, 1.3 m in low orbit: an analytic theory's velocity is not its position's derivative).
4. Densified: four points per interval and the span's two ends.
5. Segments from the span's start: the longest window of at least n points whose least squares (Householder QR; a
   position row and a velocity row times EPOCH_HALF_SPAN / n per point, the window's two end points weighted 1e4 so that
   consecutive segments share them: position and velocity continuous across a join) holds every point within 5 mm,
   velocity times EPOCH_HALF_SPAN / n included; EPOCH_MID the window's middle at the text's microsecond. n is 16, 24 or
   32, the one with the fewest bytes (112 + 24 n a segment). None holds: carry-tolerance (states too sparse, or a
   forecast that is not smooth: a maneuver).
6. `ORBIT_DETERMINATION.COMMENT`: the segments, the span, the bytes, the largest residual and the interpolant; at the
   span's start and stop, the theory minus the forecast (km, and radial, in-track and cross-track in the forecast's UVW
   axes): the jump flight makes there.

### 18.5 Bound and size

The bound is 1 cm in position everywhere in the span: 5 mm against the densified points, the interpolant's own error
(0.4 mm at 60 s in low orbit) and the frame (18.2). Measured on FFM's flights (70 x 70, Sun, Moon, solar radiation
pressure, drag in low orbit; states at 60 s, the error at every 10 s between them, `test/carried-interpolation.e2e.mjs`
on the module's own flights): largest error and D, the RMS over a lead day of the distance from the forecast:

| Orbit | Largest (mm) | D (mm) | Bytes per object-day | Numbers per object-day | Bytes per object-day at 10 cm |
| --- | --: | --: | --: | --: | --: |
| Low, 300 km | 5.1 | 2.1 to 2.2 | 51,552 | 5,616 | 22,000 |
| Low, 500 km | 4.8 | 2.1 to 2.2 | 38,852 | 4,224 | 18,040 |
| Low, 830 km | 4.7 | 2.2 | 26,584 | 2,880 | 13,640 |
| Low, 1,336 km | 4.7 | 2.1 to 2.2 | 18,264 | 1,968 | 10,560 |
| MEO, 26,560 km | 2.4 | 0.3 to 0.8 | 2,276 | 192 | 1,032 |
| Geosynchronous | 2.1 | 0.2 to 0.3 | 1,080 | 96 | 587 |
| Inclined geosynchronous, e 0.075 | 1.7 | 0.5 to 0.9 | 1,117 | 96 | 880 |
| Transfer, e 0.72 | 4.8 | 0.8 to 0.9 | 7,144 | 720 | 5,160 |
| Molniya, e 0.74 | 3.2 | 0.7 | 5,564 | 576 | 4,816 |
| THEMIS-like, e 0.82, 22.9 h | 4.1 | 0.6 to 0.7 | 4,000 | 416 | 3,211 |
| TESS-like, 13.7 d | 2.3 | 0.03 to 1.9 | 232 | 21 | 189 |

(The 10 cm column is the same algorithm at a 100 mm point tolerance, its largest error 9.4 cm, run outside the module.)
The record is 1 to 3 KB without the forecast. The jump at the span's stop (theory minus forecast; AP with zonal 20,
tesseral 31 and NRLMSISE-00 on the record's rows, fitted to the forecast's first 24 h): after 2 to 3 days 2 to 36 m
above low orbit and at 830 to 1,336 km, 1.6 km at 500 km and 15.9 km at 300 km (drag), 0.16 to 1.7 km on the eccentric
orbits; after 14 days 30 km for TESS; after 8 days 36 to 65 m at MEO and geosynchronous, 0.9 km at 830 km, 63 km at
500 km, 7.1 km at e 0.1 and 85 km on the transfer orbit.

### 18.6 Version 1 does not

Blend at the span's ends (the jump is stated, 18.4); carry the forecast's covariance (a later version writes it as
`COVARIANCE_BLOCKS`, one `OCMCovarianceBlock` with `COV_BASIS` PREDICTED over the span, and flies it inside the span);
let a `$PCF` set the bound (fixed at 1 cm); fly the forecast in `sdnap_covariance_at`, `events` or `maneuver`.

## References

- Payne, T., Hoots, F., Butkus, A., Slatton, Z., and Nguyen, D. (2022).
  [Improvements to the SGP4 Propagator (SGP4-XP)](https://amostech.com/TechnicalPapers/2022/Astrodynamics/Payne_2.pdf).
  Advanced Maui Optical and Space Surveillance Technologies Conference (AMOS).

- Brouwer, D. (1959). Solution of the problem of artificial satellite theory without drag. AJ 64, 378-397.
- Lyddane, R. H. (1963). Small eccentricities or inclinations in the Brouwer theory of the artificial satellite.
  AJ 68, 555-558.
- Hoots, F. R., Roehrich, R. L. (1980). Models for propagation of NORAD element sets. Spacetrack Report No. 3.
- Hujsak, R. S. (1979). A restricted four body solution for resonating satellites without drag. Project Space
  Track Report No. 1.
- Vallado, D. A., Crawford, P., Hujsak, R., Kelso, T. S. (2006). Revisiting Spacetrack Report #3. AIAA 2006-6753.
- Jacchia, L. G. (1970). New static models of the thermosphere and exosphere with empirical temperature profiles.
  SAO Special Report 313 (Table 5, pp. 52-81; Table 6, "Summary of log densities", pp. 82-87).
- Jacchia, L. G. (1971). Revised static models of the thermosphere and exosphere with empirical temperature
  profiles. SAO Special Report 332.
- U.S. Standard Atmosphere, 1976. NOAA/NASA/USAF, Washington.
- Lemoine, F. G. et al. (1998). The development of the joint NASA GSFC and NIMA geopotential model EGM96.
  NASA/TP-1998-206861.
- Broucke, R. A., Cefola, P. J. (1972). On the equinoctial orbit elements. Celestial Mechanics 5, 303-310.
- Cefola, P. J. (1972). Equinoctial orbit elements: application to artificial satellite orbits. AIAA 72-937.
- Danielson, D. A., Sagovac, C. P., Neta, B., Early, L. W. (1995). Semianalytic satellite theory. NPS-MA-95-002.
- Kozai, Y. (1959). On the effects of the Sun and the Moon upon the motion of a close Earth satellite. SAO Special
  Report 22. Kozai, Y. (1961). Effects of solar radiation pressure on the motion of an artificial satellite. SAO
  Special Report 56.
- Giacaglia, G. E. O. (1973). Lunar perturbations of artificial satellites of the Earth. SAO Special Report 352.
- Aksnes, K. (1976). Short-period and long-period perturbations of a spherical satellite due to direct solar
  radiation. Celestial Mechanics 13, 89-104.
- Kaula, W. M. (1966). Theory of Satellite Geodesy. Blaisdell.
- Abramowitz, M., Stegun, I. A. (1964). Handbook of Mathematical Functions, table 25.4 (Gauss-Legendre).
- Escobal, P. R. (1965). Methods of Orbit Determination. Wiley (shadow function, section 5.3).
- Picone, J. M., Hedin, A. E., Drob, D. P., Aikin, A. C. (2002). NRLMSISE-00 empirical model of the atmosphere:
  statistical comparisons and scientific issues. JGR 107(A12), 1468.
- Montenbruck, O., Gill, E. (2000). Satellite Orbits. Springer.
- The Astronomical Almanac, section C (Sun) and D (Moon), low-precision formulas.
- Meeus, J. (1998). Astronomical Algorithms, 2nd ed., chapter 25. Brouwer, D., Clemence, G. M. (1961). Methods of
  Celestial Mechanics. Montenbruck, O., Pfleger, T. (2000). Astronomy on the Personal Computer, 4th ed., chapter 3.
- Seidelmann, P. K., ed. (1992). Explanatory Supplement to the Astronomical Almanac.
- US Space Force Astrodynamics Standards: release notes 7.7-9.9, JIRA summaries 8.2-9.9, Tle and Sgp4Prop
  interface documents (9.9 package); release notes v9.1.1.0 C Sgp4Prop WebAssembly.
