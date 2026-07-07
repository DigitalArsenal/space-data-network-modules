# higherpop

A dependency-free, header-only C++17 **special-perturbation propagator core**,
built for the efficiency-critical inner loop of astrodynamics work.

It complements `propagator/hpop` rather than replacing it:

| | `hpop` | `higherpop` |
|---|---|---|
| Role | high-fidelity, WASM-deployed engine | lean native kernel for the hot loop |
| Gravity | EGM2008 full field | zonal J2–J6 (analytic, Legendre recursion) |
| Atmosphere | NRLMSISE-00, US76, JB2008, DTM2020 | **pluggable** — bring any `DensityFn` |
| Deps | flatbuffers, emscripten, vendored C | none (STL only) |
| Formulations | Cowell, Encke, VOP, DROMO, KS | Cowell, Encke, MEE-VOP, **DROMO**, **KS** |

## Why a separate core

The dominant lever on propagation efficiency is the **formulation**, not the
integrator. Integrating slowly-varying orbital *elements* (or a regularized,
time-transformed state) instead of the fast Cartesian state lets the adaptive
stepper take far larger steps for the same accuracy.

Five formulations share one force model and one adaptive DP54 stepper:

| formulation | state | independent var | strength |
|---|---|---|---|
| Cowell | r, v (6) | time | simple, robust; baseline |
| Encke | δr, δv from conic (6) | time | small error/step |
| MEE-VOP | equinoctial elements (6) | time | efficient for low-e |
| **KS** | spinor u, u′, t, E (10) | fictitious s | regularized, uniform step |
| **DROMO** | ζ₁₋₃, quaternion η₁₋₄, τ (8) | ideal anomaly σ | **best for eccentric** |

**Force evaluations to first reach < 0.01 m** vs a tight-Cowell reference, at
the coarsest tolerance that achieves it (from `bench/bench.cpp`; the tolerance
differs per cell, so read these as cost-to-accuracy, not an iso-tolerance
comparison):

| regime | Cowell | Encke | MEE | KS | DROMO |
|---|---|---|---|---|---|
| LEO (J2–J6) | 76.9 k | 24.1 k | **6.0 k** | 51.2 k | 8.8 k |
| GTO (e=0.73) | 44.6 k | 22.6 k | — | 28.4 k | **13.6 k** |
| Molniya (e=0.74) | 44.3 k | 24.5 k | — | 28.5 k | **21.5 k** |

(MEE does not appear for GTO/Molniya because at the benchmark's tolerance grid
it does not cross 0.01 m — its element tolerance must be tightened ~2 orders for
eccentric orbits, as the cross-check confirms.)

**Takeaways**
- **MEE is the cheapest for low-eccentricity orbits** — on LEO it reaches the
  0.01 m floor with ~6 k evaluations, well below every other method. But on
  eccentric orbits its element tolerance maps unevenly to position error near
  perigee, so it needs ~2 orders tighter `rtol` there (see the cross-check).
- **DROMO dominates eccentric orbits** — on GTO, among the methods that reach
  the 0.01 m floor (Cowell, Encke, KS, DROMO), DROMO does so with the fewest
  force evaluations: ~⅓ of Cowell's (13.6 k vs 44.6 k), at 0.8 mm error. (MEE
  uses fewer evaluations at the same tolerance but does not cross the 0.01 m
  floor for this eccentricity.) This is the regularization payoff: the
  ideal-anomaly independent variable
  makes the step size nearly uniform in true anomaly, so perigee no longer
  forces tiny steps. DROMO is also competitive on LEO (~8.8 k).
- **KS** regularizes robustly (uniform step, no Kepler solve) and beats Cowell
  on eccentric arcs, though DROMO is more economical here.
- **Encke** holds a low error/step but pays a universal-Kepler solve every RHS
  call, so its wall-clock is always highest.

See the work–precision diagram in the project artifacts (error vs wall-clock,
all five formulations, four regimes).

## Pluggable atmosphere

Drag fidelity lives entirely in the density model, so `higherpop` takes it as a
plug (`include/higherpop/atmosphere.hpp`):

```cpp
hp::ForceConfig cfg;
cfg.zonalMax = 2;
cfg.useDrag  = true;
cfg.BC       = 0.02;                    // Cd*A/m [m^2/kg]
cfg.density  = hp::makePiecewiseExp();  // built-in Vallado Table 8-4
// ...or any model:  cfg.density = [](const hp::DragQuery& q){ return my_rho(q); };
```

`DragQuery` carries position, altitude, lat/lon and Julian date, so a
high-fidelity model — including a bridge to `hpop`'s NRLMSISE-00 — drops in
without touching the propagator or force code. Two models ship built in:
`SingleExp` and `PiecewiseExp` (Vallado 4th ed. Table 8-4).

## Build

```bash
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j
ctest --test-dir build            # cross-formulation agreement + conservation
./build/hp_bench > bench.csv      # efficiency survey
```

Or directly, no CMake:

```bash
c++ -std=c++17 -O3 -march=native -Iinclude test/validate.cpp -o validate && ./validate
```

## API

```cpp
#include "higherpop/higherpop.hpp"

hp::Vec3 r0{...}, v0{...};                 // ECI, km and km/s
hp::ForceConfig cfg; cfg.zonalMax = 6;

auto res = hp::propagateMee(r0, v0, tf, cfg, /*rtol*/1e-10, /*atol*/1e-13);
// res.r, res.v  (final state);  res.stats.nfev / nsteps / nrejected

// all five share the same signature (rtol, atol):
//   propagateCowell(r0,v0,tf,cfg,rtol,atol)
//   propagateEncke (r0,v0,tf,cfg,rtol,atol, rectFrac=0.01)
//   propagateMee   (r0,v0,tf,cfg,rtol,atol)
//   propagateKS    (r0,v0,tf,cfg,rtol,atol)   // regularized (spinor)
//   propagateDromo (r0,v0,tf,cfg,rtol,atol)   // regularized (ideal anomaly)
```

The regularized methods integrate against a non-time independent variable
(fictitious time s for KS, ideal anomaly σ for DROMO) and recover the requested
physical epoch `tf` by a safeguarded-Newton root-solve on the final step, using
the analytic `dt/ds` (resp. `dτ/dσ`) that is already a component of the RHS —
so hitting `tf` costs ~3–4 extra evaluations, not a bisection sweep.

## Validation

`test/validate.cpp` (no external deps) checks, at rtol=1e-12:
- two-body closure over one period → ~1e-6 m (machine precision);
- Cowell ≡ MEE ≡ Encke under J2 over 10 orbits → agreement ≤ 2 mm;
- J2 SMA bounded; drag produces physical decay.

`test/dromo_test.cpp` checks DROMO two-body closure and DROMO≡Cowell under J2.

### Cross-validation against hpop  (`test/crosscheck_hpop.cpp`)

higherpop is validated against the sibling `propagator/hpop` engine to
**< 0.01 m**. hpop's force model (`SphericalHarmonics`, zonal) is used as an
independent reference oracle: the same physics is integrated by a separate
tight loop, and every higherpop formulation is compared to it.

Worst-case position error over {LEO, GTO, Molniya} × {J2, J4} × {Cowell, MEE,
Encke, KS, DROMO} is **4.1 mm** — all formulations pass the 0.01 m requirement.

`test/match_accel.cpp` additionally confirms zonal accelerations match hpop's
`SphericalHarmonics` to **3e-12 relative** (machine precision) over 20 000
random states, so agreement is at the force-model level, not just end-state.

> **Note — hpop bug found and fixed during this work.** hpop's deployed gravity
> path (`SphericalHarmonics` → `computeSphericalHarmonicGravity`) scaled the
> latitudinal/longitudinal acceleration components by `mu/r³` instead of
> `mu/r²`, an extra factor of `1/r` that collapsed the J2 nodal-regression
> effect by ~7000× (verified against analytic secular theory). Fixed in
> `astrodynamics.cpp` (the `// Scale by mu/r^2` block). After the fix, hpop's
> `SphericalHarmonics`, its `J2Only` closed form, and higherpop all agree.
> See `PATCH_hpop_spherical_harmonics.md`.

To build the cross-check (needs hpop sources):

```bash
cmake -S . -B build -DHIGHERPOP_XCHECK_HPOP=ON
cmake --build build -j
./build/hp_xcheck
```

## Layout

```
include/higherpop/   constants, vec3, atmosphere, forces, kepler, integrator,
                     ks, dromo, formulations, higherpop (umbrella)
include/higherpop/rpo/   roe, stm (KGD J2), mean_j2, lvlh (CW/TH),
                     maneuvers (Γ + min-energy reconfig), lambert; rpo.hpp umbrella
include/higherpop/    frames (IAU-2006/2000A GCRF↔ITRF, ERFA-backed),
                     target (differential corrector), lighting (eclipse/Sun/Moon),
                     stationkeeping (GEO E-W / LEO reboost), interplanetary
                     (patched-conic, gravity assist, B-plane)
third_party/erfa/    vendored ERFA (BSD-3, IAU-SOFA-derived) frame/ephemeris series
test/validate.cpp        correctness harness (no deps)
test/dromo_test.cpp      DROMO self-test (no deps)
test/match_accel.cpp     accel-level match vs hpop
test/crosscheck_hpop.cpp trajectory-level match vs hpop (< 0.01 m)
test/crosscheck_nodal.cpp J2 nodal-regression ground-truth check
test/rpo/*_validate.cpp  RPO suite validation (stm, lvlh, maneuver, lambert)
test/frames/, test/target/, test/lighting/, test/stationkeeping/,
test/interplanetary/     flight-dynamics suite validation (vs ERFA / closed form)
bench/bench.cpp          work-precision survey → CSV
```

## RPO / relative-motion suite

A companion layer for rendezvous, proximity operations, and formation flying,
built on relative orbital elements (ROE) and the chief LVLH frame — see
`include/higherpop/rpo/README.md`. It provides the Koenig–Guffanti–D'Amico J2
ROE state-transition matrix (validated sub-metre vs nonlinear secular-mean truth
through ~15 revs in all regimes), Clohessy–Wiltshire and Tschauner–Hempel
Cartesian STMs (first-order exact), a Gauss control-input matrix with a
minimum-energy multi-impulse reconfiguration solver, and a universal-variable
Lambert solver for intercept/rendezvous. `#include "higherpop/rpo.hpp"`.

## Flight-dynamics suite (STK / FreeFlyer parity)

A dependency-ordered set of operational analyses layered on the propagator and
RPO cores. Each is header-only and validated against an independent oracle
(ERFA for anything astronomical, closed-form theory otherwise).

| Module | Header | Capability | Validation |
|---|---|---|---|
| **Frames** | `frames.hpp` | Full IAU-2006/2000A GCRF↔ITRF chain (precession-nutation-bias via ERFA XY06/s06, ERA, polar motion), WGS84 geodetic | GCRF→ITRF matrix **bit-exact vs ERFA** at 4 epochs; ~7 mm (per-component) vs Vallado Ex. 3-15 |
| **Targeter** | `target.hpp` | Generic differential corrector (Newton / Levenberg-Marquardt, FD Jacobian) driving controls→goals; square/over/under-determined | apogee-raise burn matches exact Hohmann to 1.2e-9 mm/s; reproduces closed-form Lambert v1 to 1e-11 m/s |
| **Lighting** | `lighting.hpp` | Sun/Moon ephemeris (ERFA epv00/moon98), conical umbra/penumbra shadow fraction, beta angle | Sun/Moon vs ERFA to ~4e-7 km; LEO i=51.6° eclipse 36.4% of period |
| **Station-keeping** | `stationkeeping.hpp` | GEO East-West longitude keeping, LEO altitude/ground-track reboost, tangential SMA-control primitive | a_geo 42164 km; SMA control vs vis-viva; E-W & reboost ΔV budgets in operational band |
| **Interplanetary** | `interplanetary.hpp` | Planetary ephemeris (ERFA plan94), patched-conic Lambert transfer, C3 / v∞ / injection ΔV, gravity-assist turn angle, B-plane | Earth→Mars 2020 window C3=14.39 km²/s², arrival v∞=2.56 km/s, injection 3.84 km/s; flyby + B-plane exact vs closed form |

The frame chain, lighting and interplanetary ephemeris link the vendored ERFA
static library (`third_party/erfa/`, BSD-3, derived from IAU SOFA); the targeter
and station-keeping layers are dependency-free.

## Roadmap

1. **DOP853** 8(7) pair behind the existing integrator interface for tighter
   tolerances at lower step count.
2. **NRLMSISE-00 bridge** — a `DensityFn` adapter over `hpop`'s vendored model
   (the interface is ready; `DragQuery` already carries alt/lat/lon/JD).
3. **EDROMO / Stiefel-Scheifele time-elements** for very long arcs where DROMO's
   ideal-anomaly variable accumulates phase error.
4. Batch/SoA propagation for many objects (SIMD over the RHS).
