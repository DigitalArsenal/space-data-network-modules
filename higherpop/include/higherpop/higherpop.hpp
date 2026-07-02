// higherpop.hpp — single-include public API for the higherpop core.
//
// higherpop is a dependency-free, header-only C++17 special-perturbation
// propagator core. It complements propagator/hpop: hpop is the high-fidelity,
// WASM-deployed engine (EGM2008, NRLMSISE-00, tides, SRP, third-body);
// higherpop is a lean, cache-friendly kernel for the efficiency-critical inner
// loop, with a pluggable atmosphere so drag fidelity is not sacrificed.
//
// Formulations: Cowell, Encke, Equinoctial VOP (MEE).
// Integrator:   adaptive Dormand-Prince 5(4) with PI step control.
// Forces:       zonal J2–J6 (Legendre recursion) + pluggable-density drag.
//
//   #include "higherpop/higherpop.hpp"
//   hp::ForceConfig cfg; cfg.zonalMax = 6;
//   auto res = hp::propagateMee(r0, v0, tf, cfg, 1e-10, 1e-13);
//   // res.r, res.v, res.stats.nfev
#pragma once
#include "constants.hpp"
#include "vec3.hpp"
#include "atmosphere.hpp"
#include "forces.hpp"
#include "kepler.hpp"
#include "integrator.hpp"
#include "ks.hpp"
#include "dromo.hpp"
#include "formulations.hpp"
