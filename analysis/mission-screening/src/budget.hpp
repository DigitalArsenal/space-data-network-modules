#ifndef MISSION_SCREENING_BUDGET_HPP
#define MISSION_SCREENING_BUDGET_HPP
#include <cmath>
#include <limits>

// SI throughout. These are circular parking-orbit impulses, not Star's
// excess above parabolic escape. The caller supplies body GM and orbit radius.
namespace mission_screening {
inline double circular_impulse(double vinf, double mu, double radius) {
  if (!std::isfinite(vinf) || vinf < 0 || !std::isfinite(mu) || mu <= 0 ||
      !std::isfinite(radius) || radius <= 0)
    return std::numeric_limits<double>::quiet_NaN();
  return std::sqrt(vinf * vinf + 2 * mu / radius) - std::sqrt(mu / radius);
}
struct Budget {
  double departure_c3, departure_vinf, arrival_vinf, sum_vinf;
  double parking_injection, flyby_impulse, capture, total_impulse;
};
inline Budget evaluate(double departure, double arrival, double flyby,
                       double departure_mu, double departure_radius,
                       double arrival_mu, double arrival_radius) {
  const double injection = circular_impulse(departure, departure_mu, departure_radius);
  const double capture = circular_impulse(arrival, arrival_mu, arrival_radius);
  return {departure * departure, departure, arrival, departure + arrival,
          injection, flyby, capture, injection + flyby + capture};
}
}
#endif
