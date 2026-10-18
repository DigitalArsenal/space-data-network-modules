#pragma once

#include <cstddef>
#include "environment_models.h"

namespace astro::ffm {

// Flat coefficient rows include m=0..n, with zeros above maxOrder.
constexpr std::size_t gravityRow(int n) {
    return std::size_t(n) * std::size_t(n + 1) / 2;
}

// Prepare retained shape tables before force evaluation when constructing a
// force set. The tables contain no environment-specific or time-dependent data.
void prepareGravity(int degree, int order);

// Same fully normalized field, point mass, and result contract as the standard
// extended gravity evaluator. Position is Earth-fixed km; acceleration km/s^2.
GravityAcceleration computeGravity(const Vec3& position,
                                   const ExtendedGravityField& field,
                                   double jd = 0.0);

// One recursion and sum over merged triangular coefficients. Metadata supplies
// mu, reference radius, degree, and order; nested coefficients are never read.
// Returns harmonic acceleration only, leaving point mass to the caller.
Vec3 computeFlatGravity(const Vec3& position,
                        const ExtendedGravityField& metadata,
                        const double* C, const double* S);

} // namespace astro::ffm
