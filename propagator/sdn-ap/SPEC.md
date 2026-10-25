# SGP4-XP: mathematical specification (clean room, side A)

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

**Implementation.** Side B builds SDN-AP, the SDN advanced propagator, from this document (`propagator/sdn-ap/` of the
public modules repository, Apache-2.0).

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
The legacy SGP4 bands (synchronous for 0.0034906585 < n < 0.0052359877 rad/min; half-day for 8.26e-3 <= n <= 9.24e-3
and e >= 0.5) are not used for type 4.

### 6.1 Resonant terms per class

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
the model: the series converges only below the Laplace limit e = 0.6627 (Brouwer and Clemence 1961), and above it
the two differ widely. The library evaluates the polynomial at every e, with no closed form and no other expansion
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

The grid depends only on the epoch state, so a state does not depend on which times were requested before, nor in
what order *[probe 9.1: direct, 1-minute stepped and backward-approach requests agree to 0 mm]*. GEO nodes fall on
multiples of 95 minutes *[probe 9.2: native elements between epoch and 95 minutes are reproduced by cubic Hermite
interpolation of the two node values and rates to 1e-8 of their change, against 6e-5 for a 96-minute grid]*.

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

## 12. SDN-AP covariance (side B's method, outside the SGP4-XP specification)

This section is side B's own: it specifies how the module gives a covariance with the states of the sets it fits,
SDN-AP (THEORY SDNAP) and SGP4XP alike. Nothing in it comes from the Space Force library, and no SGP4XP conformance
vector depends on it.

**12.1 Fit covariance.** The parameter vector p of a fit is the fit's own (`params_of`): the mean equinoctial af, ag,
chi, psi, lambda0 (rad), n (rad/min), then those of the drag term (SDN-AP B_eff, SGP4XP BTERM; m^2/kg), AGOM
(m^2/kg), tau0, tauc, taus (m/s^2) the fit solved for. At the solution (an SGP4XP set at its two-line digits), with the residuals e_k (model minus reference position, km, TEME) of the N fit states,

- J_k = d r_k / d p, every column the central difference of the theory itself (steps 1e-6 in af, ag, chi, psi and
  lambda0, 1e-7 n, max(1e-3 |p|, 1e-5) in B_eff and AGOM, max(1e-3 |p|, 1e-10) in tau; AGOM forward where p - h <= 0,
  the theory reading AGOM <= 0 as no SRP);
- s^2 = sum |e_k|^2 / (3N - dim p), the post-fit residual variance per component;
- A = sum J_k^T J_k / s^2 + diag(1 / sigma^2) over the fit's priors (drag, AGOM: FIT.DRAG_PRIOR, FIT.SRP_PRIOR);
- P_p = A^-1.

**12.2 Epoch covariance and its record.** With J_0 = d x(0) / d p (x the TEME state, km, km/s) and F(x) the theory
floor (12.4) at the epoch state, the $OMM carries

- COVARIANCE = J_0 P_p J_0^T + F(x(0)), lower triangle (21 values, km^2, km^2/s, km^2/s^2), COV_REFERENCE_FRAME TEME;
- USER_DEFINED_SDNAP_COV_DRAG, _AGOM, _TAU0, _TAUC, _TAUS (those fitted, in that order): for the k-th of them the
  space-separated row of its covariance with X, Y, Z, X_DOT, Y_DOT, Z_DOT at epoch (J_0 P_p), with the earlier ones,
  then its variance (6 + k + 1 numbers);
- USER_DEFINED_SDNAP_COV_FLOOR_UVW (6 numbers, km^2: uu, vu, vv, wu, wv, ww), _COV_NOISE (12.5), _COV_NG_RATE (1/day)
  and _COV_REGIME (DRAG or ABOVE).

**12.3 Propagation.** A set is read back as the augmented epoch covariance C (state block COVARIANCE - F(x(0)),
consider rows as written). The columns J_0 = [J_x J_c] (elements, consider) give the parameters of a state:
T = [[J_x^-1, -J_x^-1 J_c], [0, I]], P_p = T C T^T. At t minutes from the epoch, J(t) = d x(t) / d p by the same
central differences and

P(t) = J(t) P_p J(t)^T + Q(t) + F(x(t)).

The state transition matrix is J(t) T; at t = 0 it is [I 0], so P(0) is COVARIANCE.

**12.4 Theory floor.** F is the fit's residual covariance in the UVW axes of the state (U radial, V in-track, W along
r x v), R = (1/N) sum u_k u_k^T, u_k the residual e_k in the UVW axes of the model state at t_k; position block
R in TEME axes, velocity block w^2 R (w = |r x v| / |r|^2), no position-velocity block. It is the part of the error a
mean-element theory leaves at every time (short-period terms it does not carry) and does not shrink with N.

**12.5 Process noise.** What a mean-element theory gets wrong over days are its element rates. From the end of the
fit arc t_a (minutes from the epoch; from the epoch backward for t < 0) the rates carry errors constant over
the prediction, with d = (t - t_a) / 1 day:

- eccentricity vector: d af, d ag = s_e d each (independent);
- inclination vector: d chi, d psi = s_i d each;
- mean longitude: d lambda = s_l n_d d (s_l a relative mean-motion error, n_d in rad/day);
- non-gravitational n-dot (drag regime): d n(t) = s_d d, d lambda(t) = s_d d^2 / 2, taken as the epoch perturbation
  that gives them at t: d n0 = d n(t), d lambda0 = d lambda(t) - t d n0; s_d = c |n-dot_ng| (rad/day^2), n-dot_ng the
  non-gravitational part of the theory's epoch n-dot (its rates with and without B_eff and tau; USER_DEFINED_SDNAP_COV_NG_RATE
  = n-dot_ng / n per day).

Each is a column g = J(t) dp of 12.3's J(t), and Q(t) = sum g g^T. The set carries its sizes and t_a as
USER_DEFINED_SDNAP_COV_NOISE "s_e s_i s_l s_d t_a". They are fitted per theory and regime (DRAG: perigee below
2500 km, the density kernel's top; ABOVE) by maximum likelihood, the Gaussian negative log-likelihood of the
position errors under P(t), on laser-ranged arcs of 2026-02-01 to 2026-05-31 (Ajisai, Starlette, Stella, LARETS,
WESTPAC, LARES in DRAG; LARES-2, LAGEOS-2, Etalon-1, Etalon-2 ABOVE; LAGEOS-1 never: it is held out), 24 h fits
scored every 30 min over the next 3 days (`test/covariance-realism.mjs --set calibration`,
`test/results/covariance-calibration-*.json`):

| Theory | Regime | Windows | s_e (1/day) | s_i (1/day) | s_l | c |
| --- | --- | --: | --: | --: | --: | --: |
| SDN-AP | DRAG | 136 | 1.963e-6 | 2.69e-7 | 2.4e-13 | 1.928 |
| SDN-AP | ABOVE | 62 | 1.358e-6 | 3.652e-7 | 5.328e-8 | 0 |
| SGP4XP | DRAG | 136 | 2.813e-6 | 7.432e-6 | 8.505e-7 | 1.3e-6 |
| SGP4XP | ABOVE | 62 | 2.308e-7 | 3.752e-7 | 2.666e-7 | 0 |

**12.6 Calls.** `sdnap_covariance_at(omm, length, minutes, count, out)` gives, per time, the TEME state and P(t)
(42 doubles); `propagate` writes a covariance line per state (COVARIANCE_MATRIX_LINES, the block's own axes: P
rotated with the state) for an SGP4XP or SDN-AP set that carries COVARIANCE. An SGP4 set has none.

---

## 13. SDN-AP osculating input (side B's method, outside the SGP4-XP specification)

**13.1 Record.** An SDS $OPM about the Earth (CENTER_NAME EARTH or absent), TIME_SYSTEM UTC (or absent), EPOCH,
REF_FRAME TEME, GCRF / ICRF or EME2000 / J2000, and GM (km^3/s^2, about the Earth's). The Keplerian block is used when
SEMI_MAJOR_AXIS is on the wire (the other elements as written, a scalar left off the wire being 0; TRUE_ANOMALY when
written, else MEAN_ANOMALY), the state vector otherwise. Refused by name: no-elements (neither), unknown-frame,
missing-gm, unsupported-time-system, unsupported-center, element-set-refused (an open orbit or a radius that is not an
Earth orbit's).

**13.2 State.** Keplerian: E from the true anomaly by tan(E/2) = sqrt((1 - e)/(1 + e)) tan(nu/2), M = E - e sin E, and
the two-body state of (a, e, i, Omega, omega, M) about the record's GM. The axes to TEME at the epoch: GCRF by 10's
GCRF -> TEME; EME2000 by the IAU 2006 frame bias B (r_EME2000 = B r_GCRF) then GCRF -> TEME.

**13.3 Set.** y0 = h^-1(x, t) by the inverse map at the epoch, as launch_set does for an insertion orbit (DESIGN
5.3.1): the mean set whose osculating state at t is x. B_eff and AGOM: C_D A/m and C_R A/m from MASS with DRAG_AREA and
SOLAR_RAD_AREA (C_D 2.2 and C_R 1.0 where the record states none); otherwise the $PCF LAUNCH priors (B_eff 0.01 m^2/kg
with the perigee below 2,500 km, else 0; AGOM 0.01 m^2/kg). The set records where it came from:
USER_DEFINED_SDNAP_SOURCE OSCULATING_OPM, _SOURCE_ELEMENTS (KEPLERIAN or STATE), _SOURCE_FRAME, _SOURCE_GM,
_CONVERSION INVERSE_MAP and _CONVERSION_STEPS, _FORCES (RECORD or REGIME_DEFAULT), and its COMMENT says the same.

**13.4 Covariance.** A COVARIANCE (21 values, COV_REF_FRAME or else REF_FRAME) is rotated to TEME, P' = B P B^T with B
= diag(M, M), and carried as the set's COVARIANCE with the regime's process noise from the epoch (12.5; no consider rows,
no floor). None is made where the record has none.

**13.5 Calls.** `opm_set` gives the set; `propagate` takes 'opm' frames through the same conversion (13.1-13.4), so an
$OPM propagates as its set does. `sdnap_osculating_elements_about(r, v, gm, out)` and `sdnap_kepler_at(r, v, gm, s, out)`
give a state's osculating elements and period, and its two-body motion, about a stated GM.

---

## References

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
- Montenbruck, O., Gill, E. (2000). Satellite Orbits. Springer.
- The Astronomical Almanac, section C (Sun) and D (Moon), low-precision formulas.
- Meeus, J. (1998). Astronomical Algorithms, 2nd ed., chapter 25. Brouwer, D., Clemence, G. M. (1961). Methods of
  Celestial Mechanics. Montenbruck, O., Pfleger, T. (2000). Astronomy on the Personal Computer, 4th ed., chapter 3.
- Seidelmann, P. K., ed. (1992). Explanatory Supplement to the Astronomical Almanac.
- US Space Force Astrodynamics Standards: release notes 7.7-9.9, JIRA summaries 8.2-9.9, Tle and Sgp4Prop
  interface documents (9.9 package); release notes v9.1.1.0 C Sgp4Prop WebAssembly.
