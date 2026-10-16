#pragma once
#include "conjunction/conjunction_engine.h"
namespace conjunction {
// Inertial position difference and covariance, km and km^2.
double encounter_mahalanobis_3d(const double dr[3], const Covariance3x3&, const Covariance3x3&);
// Convert RTN position/velocity covariance blocks at the supplied epoch.
PcEncounter make_pc_encounter(const StateVector&, const StateVector&,
    const std::array<double, 21>&, const std::array<double, 21>&, double radius);
}
