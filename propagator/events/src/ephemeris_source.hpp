// ephemeris_source.hpp — the state source, as a sampled trajectory.
//
// The event runner takes the trajectory as a function pointer and never learns
// what produces it. This header is ONE implementation of that port: a table of
// states, sampled by whatever propagator the caller chose, made continuous by
// Hermite interpolation.
//
// WHY HERMITE AND NOT LAGRANGE. The samples carry velocity as well as position,
// so the interpolant can match BOTH at every node. That makes it C1 — the
// interpolated velocity is exactly the derivative of the interpolated position
// — which matters directly here: the apsis event function is r . v, and with a
// position-only interpolant its zero would sit where the interpolated position
// happened to turn rather than where the trajectory does. Matching the
// derivative at the nodes removes that whole class of error.
//
// A caller whose propagator emits only positions is not served by pretending:
// it must difference its own positions and say so, or hand this header a
// velocity it believes.
//
// UNITS: seconds from the caller's reference epoch, metres, metres per second.

#ifndef SDN_PROPAGATOR_EVENTS_EPHEMERIS_SOURCE_HPP
#define SDN_PROPAGATOR_EVENTS_EPHEMERIS_SOURCE_HPP

#include <cmath>
#include <cstdint>

namespace sdn {
namespace events {

/// A sampled trajectory. `times` is strictly increasing; `states` holds six
/// doubles per sample, position then velocity.
struct Ephemeris {
  const double* times = nullptr;
  const double* states = nullptr;
  int32_t sampleCount = 0;
  /// Number of samples the interpolant spans. Two is cubic Hermite; four is
  /// septic. Higher is not automatically better — a wide stencil on a coarse
  /// table rings — so the caller states it and the conformance harness measures
  /// what it bought.
  int32_t stencil = 2;
};

namespace detail {

/// Index of the last sample at or before `time`, by binary search. Returns -1
/// when the epoch is outside the table: an ephemeris is not extrapolated.
inline int32_t lowerSample(const Ephemeris& ephemeris, double time) {
  if (ephemeris.sampleCount < 2) return -1;
  if (time < ephemeris.times[0]) return -1;
  if (time > ephemeris.times[ephemeris.sampleCount - 1]) return -1;
  int32_t low = 0;
  int32_t high = ephemeris.sampleCount - 1;
  while (high - low > 1) {
    const int32_t middle = (low + high) / 2;
    if (ephemeris.times[middle] <= time) {
      low = middle;
    } else {
      high = middle;
    }
  }
  return low;
}

}  // namespace detail

/// Cubic Hermite on one interval, for position and its derivative together.
inline void hermiteSegment(double t0, double t1, const double* s0, const double* s1,
                           double time, double state[6]) {
  const double h = t1 - t0;
  const double u = (time - t0) / h;
  const double u2 = u * u;
  const double u3 = u2 * u;
  // Basis and its derivative with respect to u.
  const double h00 = 2.0 * u3 - 3.0 * u2 + 1.0;
  const double h10 = u3 - 2.0 * u2 + u;
  const double h01 = -2.0 * u3 + 3.0 * u2;
  const double h11 = u3 - u2;
  const double d00 = 6.0 * u2 - 6.0 * u;
  const double d10 = 3.0 * u2 - 4.0 * u + 1.0;
  const double d01 = -6.0 * u2 + 6.0 * u;
  const double d11 = 3.0 * u2 - 2.0 * u;
  for (int axis = 0; axis < 3; ++axis) {
    const double p0 = s0[axis];
    const double v0 = s0[axis + 3];
    const double p1 = s1[axis];
    const double v1 = s1[axis + 3];
    state[axis] = h00 * p0 + h10 * h * v0 + h01 * p1 + h11 * h * v1;
    state[axis + 3] = (d00 * p0 + d10 * h * v0 + d01 * p1 + d11 * h * v1) / h;
  }
}

/// The state source over an `Ephemeris`. Bind it with the ephemeris as the
/// context; the runner sees only `StateSourceFn`.
inline int32_t ephemerisStateSource(void* context, double secondsFromEpoch, double state[6]) {
  const Ephemeris* ephemeris = static_cast<const Ephemeris*>(context);
  if (ephemeris == nullptr || state == nullptr) return 1;
  const int32_t index = detail::lowerSample(*ephemeris, secondsFromEpoch);
  if (index < 0) return 1;
  const int32_t next = index + 1 < ephemeris->sampleCount ? index + 1 : index;
  if (next == index) {
    for (int i = 0; i < 6; ++i) state[i] = ephemeris->states[index * 6 + i];
    return 0;
  }
  hermiteSegment(ephemeris->times[index], ephemeris->times[next],
                 &ephemeris->states[index * 6], &ephemeris->states[next * 6],
                 secondsFromEpoch, state);
  return 0;
}

/// The body-position port over the same table shape: one ephemeris per body.
struct BodyEphemeris {
  int32_t bodyId = 0;
  Ephemeris ephemeris;
};

struct BodyEphemerisSet {
  const BodyEphemeris* bodies = nullptr;
  int32_t bodyCount = 0;
};

inline int32_t bodyEphemerisPosition(void* context, int32_t bodyId, double secondsFromEpoch,
                                     double position[3]) {
  const BodyEphemerisSet* set = static_cast<const BodyEphemerisSet*>(context);
  if (set == nullptr || position == nullptr) return 1;
  for (int32_t i = 0; i < set->bodyCount; ++i) {
    if (set->bodies[i].bodyId != bodyId) continue;
    double state[6] = {0.0, 0.0, 0.0, 0.0, 0.0, 0.0};
    Ephemeris ephemeris = set->bodies[i].ephemeris;
    if (ephemerisStateSource(&ephemeris, secondsFromEpoch, state) != 0) return 1;
    position[0] = state[0];
    position[1] = state[1];
    position[2] = state[2];
    return 0;
  }
  return 1;
}

}  // namespace events
}  // namespace sdn

#endif  // SDN_PROPAGATOR_EVENTS_EPHEMERIS_SOURCE_HPP
