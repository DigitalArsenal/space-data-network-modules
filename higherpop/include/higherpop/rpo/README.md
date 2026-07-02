# higherpop RPO suite — relative motion, STMs, and impulsive control

A dependency-free C++17 layer for rendezvous and proximity operations (RPO),
formation flying, and relative-orbit guidance. Everything is expressed in
**quasi-nonsingular relative orbital elements (ROE)** or the **chief LVLH (RTN)
frame**, and reuses the higherpop core (`Vec3`, constants, universal-variable
Kepler). Include the whole suite with `#include "higherpop/rpo.hpp"`.

State definitions
-----------------
Quasi-nonsingular ROE (chief c, deputy d):

    δa  = (a_d − a_c)/a_c
    δλ  = (M_d+ω_d) − (M_c+ω_c) + (Ω_d−Ω_c)cos i_c
    δe_x = e_d cos ω_d − e_c cos ω_c        δe_y = e_d sin ω_d − e_c sin ω_c
    δi_x = i_d − i_c                        δi_y = (Ω_d−Ω_c) sin i_c

LVLH / RTN state `X = [x, y, z, ẋ, ẏ, ż]`: x radial, y along-track, z cross-track.

Components
----------

| Header | Provides | Validation (vs nonlinear truth) |
|---|---|---|
| `roe.hpp` | ROE ↔ Keplerian-element ↔ RV conversions | round-trip exact |
| `stm.hpp` | Keplerian STM; **Koenig–Guffanti–D'Amico J2 ROE STM** (JGCD 2017, Eq. A6) | sub-metre vs secular-mean truth¹ |
| `mean_j2.hpp` | Brouwer secular-J2 mean rates; numerical osculating↔mean | — |
| `lvlh.hpp` | **Clohessy–Wiltshire** (circular) + **Tschauner–Hempel** (eccentric) Cartesian STMs | first-order exact² |
| `maneuvers.hpp` | Gauss control-input matrix Γ; **minimum-energy multi-impulse reconfiguration** | Γ to 4 sig-figs; solver machine-exact³ |
| `lambert.hpp` | universal-variable **Lambert** solver (intercept / rendezvous) | arrival to <1e-3 m, v to ~1e-11 m/s⁴ |

¹ **KGD J2 STM** — validated against the closed-form nonlinear secular-mean
propagation. Sub-metre through ~15 revs in every regime; through 50 revs for
LEO (0.02 m) and Molniya (0.23 m). GTO (e=0.73) reaches ~1.9 m at 50 revs —
this is the gap between first-order secular-mean theory and true averaged J2
dynamics at high eccentricity, not an STM error (the STM reproduces KGD secular
theory to ~0.2 m at 5 revs). The model is valid for arbitrary δλ and δi_y but
small δa, δe, δi_x (the KGD linearization).

² **CW / TH** — both exact to first order; residual is pure O(δ²) nonlinearity,
verified to scale quadratically with formation size. TH beats CW by ~10⁴× on
eccentric chiefs (e=0.3, quarter-rev: TH 0.03 m vs CW 374 m for a 50 m
formation). TH integrates the exact linearized relative EOM with an RK4 whose
step count grows with eccentricity (128/rev at e→0 to ~1024/rev at e=0.9).

³ **Reconfiguration** — the control-input matrix Γ (near-circular form) matches
a finite-difference impulse response to 4 significant digits on every nonzero
coupling. The minimum-energy least-norm solver (`reconfigMinEnergy<N>`) hits the
target ROE **exactly** in its own linear model (closure 9e-13 m); end-to-end in
a full nonlinear propagation a single 100 m reconfiguration lands within a few
metres (first-order model residual), which a closed-loop controller removes with
a follow-up correction. The eccentric Γ (`controlInputMatrix`) retains the exact
out-of-plane rows and leading eccentric in-plane terms but is not independently
validated — the solver uses only the validated near-circular form.

⁴ **Lambert** — safeguarded-Newton on the universal variable z; converges in
~7 iterations across LEO/MEO/GTO with round-trip arrival error <1e-3 m and
velocity recovery to ~1e-11 m/s.

Quick start
-----------
```cpp
#include "higherpop/higherpop.hpp"
#include "higherpop/rpo.hpp"
using namespace hp; using namespace hp::rpo;

// 1. Propagate a formation under J2 in ROE space:
Elements chief{7078, 0.001, 0.9, 0.7, 0.5, 0.0};      // a,e,i,Ω,ω,M
ROE roe0{0, 0, 100e-6, 60e-6, 40e-6, 30e-6};          // initial formation
Mat6 Phi = stmJ2Roe(chief, 3600.0, MU_EARTH);         // 1-hour STM
ROE roe1 = propagateRoe(Phi, roe0);

// 2. Reconfigure to a new formation with minimum-energy impulses:
ROE target{0, 0, 150e-6, 0, 40e-6, 30e-6};
std::array<double,4> burnU{chief.argp+0.3, chief.argp+PI,
                           chief.argp+TWO_PI-0.3, chief.argp+TWO_PI+PI};
ManeuverPlan plan = reconfigMinEnergy<4>(chief, target, burnU, MU_EARTH);

// 3. Lambert intercept of a target position in a fixed time:
LambertSolution s = lambert(r_deputy, r_target, tof, MU_EARTH, /*prograde=*/true);
Vec3 dv_depart = s.v1 - v_deputy;
```

Tests
-----
`test/rpo/{stm,lvlh,maneuver,lambert}_validate.cpp`, built by CMake as
`hp_rpo_*` (or directly: `clang++ -std=c++17 -O3 -march=native -Iinclude
test/rpo/stm_validate.cpp`). Each is a self-checking validation against a
nonlinear two-body or J2 propagation.

References
----------
- Koenig, Guffanti, D'Amico, "New State Transition Matrices for Spacecraft
  Relative Motion in Perturbed Orbits", *JGCD* 40(7), 2017.
- Chernick, D'Amico, "Closed-Form Optimal Impulsive Control of Spacecraft
  Relative Motion Using Reachable Set Theory", arXiv:2002.07832, 2020.
- Chernick, D'Amico, "New Closed-Form Solutions for Optimal Impulsive Control of
  Spacecraft Relative Motion", *JGCD* 41(2), 2018, pp. 301–319.
- Tschauner, Hempel, "Rendezvous zu einem in elliptischer Bahn umlaufenden
  Ziel", *Acta Astronautica*, 1965. Clohessy, Wiltshire, *JAS*, 1960.
