// higherpop/rpo.hpp — single include for the relative-motion / RPO suite.
//
// Rendezvous, proximity operations, and formation control built on relative
// orbital elements (ROE) and the chief LVLH frame. All headers are dependency-
// free C++17 and reuse the higherpop core (Vec3, constants, kepler).
//
//   Relative dynamics (state transition matrices):
//     roe.hpp     — quasi-nonsingular ROE, element/RV conversions.
//     stm.hpp     — Keplerian + Koenig–Guffanti–D'Amico J2 ROE STM (Eq. A6).
//     mean_j2.hpp — Brouwer secular-J2 mean rates + numerical osc↔mean.
//     lvlh.hpp    — Cartesian STMs: Clohessy–Wiltshire (circular) and
//                   Tschauner–Hempel (eccentric, exact linearized).
//
//   Impulsive control:
//     maneuvers.hpp — Gauss control-input matrix Γ + minimum-energy
//                     multi-impulse ROE reconfiguration.
//     lambert.hpp   — universal-variable Lambert solver for intercept/rendezvous.
//
//   #include "higherpop/rpo.hpp"
//   using namespace hp::rpo;
#pragma once
#include "rpo/roe.hpp"
#include "rpo/stm.hpp"
#include "rpo/mean_j2.hpp"
#include "rpo/lvlh.hpp"
#include "rpo/maneuvers.hpp"
#include "rpo/lambert.hpp"
