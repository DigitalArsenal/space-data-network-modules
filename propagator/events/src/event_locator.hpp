// event_locator.hpp — one event-location engine, five (and counting) locators.
//
// GMAT-parity program item 6
// (graph/tasks/gmat-06-parameter-catalog-and-event-locators.md).
//
// THE WHOLE POINT. Eclipse, station contact, sensor intrusion, apsides, node
// crossings and a stopping condition on any named catalog parameter are not six
// algorithms. They are six EVENT FUNCTIONS handed to one runner:
//
//     g(t) is continuous;  an event is a sign change of g;
//     the epoch of the event is the root of g, found by refinement.
//
// So this header contains exactly two things a locator does not: a bracketing
// scan and a root refiner. Adding a locator is writing a g. That is the
// acceptance ("adding a new locator requires no change to the runner"), and it
// is why `Analysis.js`'s four separate hand-written scans are retired rather
// than ported one by one.
//
// WHY THE ROOT AND NOT THE SAMPLE. The scans this replaces reported the SAMPLE
// nearest the event, refined by bisection or golden section to about 0.1 s. Two
// runs at different step sizes then reported different epochs for the same
// physical event, which makes the answer a property of the scan rather than of
// the orbit. Brent's method on a continuous g converges to the root itself, so
// the answer stops depending on how you looked for it — the step-independence
// invariant the acceptance names.
//
// UNITS: seconds from the epoch the caller names, metres, metres per second,
// radians. The state source and every g agree on that and convert nowhere else.
//
// This header is dependency-free (STL <cmath> only) so it compiles into the
// WASM module, into a native conformance harness, and into a consumer that
// wants only the refiner.

#ifndef SDN_PROPAGATOR_EVENTS_EVENT_LOCATOR_HPP
#define SDN_PROPAGATOR_EVENTS_EVENT_LOCATOR_HPP

#include <cmath>
#include <cstdint>

namespace sdn {
namespace events {

constexpr double kPi = 3.14159265358979323846264338327950288;

/// Speed of light in vacuum, m/s. Exact by the SI definition of the metre.
constexpr double kSpeedOfLight = 299792458.0;

// ---------------------------------------------------------------------------
// The state source — THE port.
//
// Every locator evaluates a trajectory at an arbitrary epoch and NOTHING here
// knows how that trajectory is produced. A caller drives this with a numerical
// propagator, an analytic one, a sampled ephemeris or a table; the runner sees
// one function pointer. This is the pluggable-propagation law expressed as a
// type: there is no place in this header where a provider could be named.
//
// `secondsFromEpoch` is relative to the caller's reference epoch. `state` is
// position then velocity, in the caller's working coordinate system. A source
// that cannot answer for an epoch returns non-zero and the runner stops rather
// than extrapolating.
// ---------------------------------------------------------------------------
typedef int32_t (*StateSourceFn)(void* context, double secondsFromEpoch, double state[6]);

/// An event function. Returns 0 on success and writes g. The runner never
/// interprets g beyond its sign and its continuity.
typedef int32_t (*EventFn)(void* context, double secondsFromEpoch, const double state[6],
                           double* g);

/// Which crossing direction an event must have to be reported.
enum class Direction : uint8_t {
  /// Either direction.
  ANY = 0,
  /// g goes from negative to positive.
  INCREASING = 1,
  /// g goes from positive to negative.
  DECREASING = 2,
};

enum class Status : uint8_t {
  OK = 0,
  /// The state source refused an epoch inside the requested span.
  STATE_SOURCE_REFUSED = 1,
  /// The event function refused.
  EVENT_FUNCTION_REFUSED = 2,
  /// The refinement did not converge inside its iteration budget. Reported, so
  /// a non-converged root is never returned as if it were one.
  REFINEMENT_DID_NOT_CONVERGE = 3,
  /// More events than the caller's buffer holds. The events found so far are
  /// returned and the count says how many were kept.
  RESULT_TRUNCATED = 4,
  /// The request itself is malformed (non-positive step, reversed span).
  INVALID_REQUEST = 5,
  /// The condition was never met inside the span. Distinct from "no events":
  /// a stopping condition that never fires is an answer the caller must see.
  CONDITION_NOT_MET = 6,
};

/// How the runner brackets and refines. The defaults are stated, not implicit:
/// a caller that changes the coarse step must get the SAME roots, and the only
/// thing the step decides is whether a root is bracketed at all.
struct RefinementSettings {
  /// Coarse scan step, seconds. Chosen to be shorter than the shortest interval
  /// between two roots of g; it does not set the accuracy of a root.
  double coarseStepSeconds = 60.0;
  /// Convergence tolerance on the ROOT, seconds. This is what sets accuracy.
  double toleranceSeconds = 1e-9;
  /// Iteration budget for the refinement. Brent on a bracketed continuous
  /// function converges superlinearly; 100 is a budget, not an expectation.
  int32_t maxIterations = 100;
};

struct Event {
  /// Seconds from the caller's reference epoch.
  double epochSeconds = 0.0;
  /// The event function's value at the reported epoch. Reported rather than
  /// assumed zero, so a caller can see the residual it actually got.
  double residual = 0.0;
  /// Which way g crossed.
  Direction direction = Direction::ANY;
  /// The state at the event, from the same source that found it.
  double state[6] = {0.0, 0.0, 0.0, 0.0, 0.0, 0.0};
  /// How many refinement iterations it took.
  int32_t iterations = 0;
};

// ---------------------------------------------------------------------------
// Brent's method.
//
// Inverse quadratic interpolation where it helps, the secant where it does not,
// bisection where neither does — so the bracket never widens and convergence is
// superlinear on a smooth g. The bracket is a precondition: this function is
// never called without a sign change, which is what makes it unconditionally
// convergent.
// ---------------------------------------------------------------------------

template <typename Fn>
inline bool brentRoot(Fn evaluate, double lower, double upper, double gLower, double gUpper,
                      double tolerance, int32_t maxIterations, double* root, double* residual,
                      int32_t* iterations) {
  if (root == nullptr) return false;
  if (!(gLower * gUpper <= 0.0)) return false;  // not bracketed

  double a = lower;
  double b = upper;
  double fa = gLower;
  double fb = gUpper;
  if (std::fabs(fa) < std::fabs(fb)) {
    const double t = a; a = b; b = t;
    const double ft = fa; fa = fb; fb = ft;
  }
  double c = a;
  double fc = fa;
  double d = b - a;
  double e = d;
  bool usedBisection = true;

  for (int32_t iteration = 0; iteration < maxIterations; ++iteration) {
    if (fb == 0.0 || std::fabs(b - a) <= tolerance) {
      if (root != nullptr) *root = b;
      if (residual != nullptr) *residual = fb;
      if (iterations != nullptr) *iterations = iteration;
      return true;
    }
    double s = 0.0;
    if (fa != fc && fb != fc) {
      // Inverse quadratic interpolation.
      s = a * fb * fc / ((fa - fb) * (fa - fc)) + b * fa * fc / ((fb - fa) * (fb - fc)) +
          c * fa * fb / ((fc - fa) * (fc - fb));
    } else {
      // Secant.
      s = b - fb * (b - a) / (fb - fa);
    }
    const double lowerBound = (3.0 * a + b) / 4.0;
    const bool outside = !((s > lowerBound && s < b) || (s < lowerBound && s > b));
    const bool slowBisection =
        usedBisection && std::fabs(s - b) >= std::fabs(b - c) / 2.0;
    const bool slowInterpolation =
        !usedBisection && std::fabs(s - b) >= std::fabs(c - d) / 2.0;
    const bool tinyBisection = usedBisection && std::fabs(b - c) < tolerance;
    const bool tinyInterpolation = !usedBisection && std::fabs(c - d) < tolerance;
    if (outside || slowBisection || slowInterpolation || tinyBisection || tinyInterpolation) {
      s = (a + b) / 2.0;
      usedBisection = true;
    } else {
      usedBisection = false;
    }
    double fs = 0.0;
    if (!evaluate(s, &fs)) return false;
    d = c;
    c = b;
    fc = fb;
    if (fa * fs < 0.0) {
      b = s;
      fb = fs;
    } else {
      a = s;
      fa = fs;
    }
    if (std::fabs(fa) < std::fabs(fb)) {
      const double t = a; a = b; b = t;
      const double ft = fa; fa = fb; fb = ft;
    }
    (void)e;
  }
  if (root != nullptr) *root = b;
  if (residual != nullptr) *residual = fb;
  if (iterations != nullptr) *iterations = maxIterations;
  return false;
}

// ---------------------------------------------------------------------------
// The runner.
// ---------------------------------------------------------------------------

struct ScanRequest {
  /// Span to search, seconds from the caller's reference epoch. `stop` may be
  /// BEFORE `start`: a backward search is the same algorithm with a negative
  /// step, not a second code path, which is what makes backward propagation a
  /// conformance case rather than a feature.
  double startSeconds = 0.0;
  double stopSeconds = 0.0;
  Direction direction = Direction::ANY;
  RefinementSettings refinement;
  /// Stop after this many events. Zero means "every event in the span"; one is
  /// the propagate-to-condition case.
  int32_t maxEvents = 0;
};

/// Locate every sign change of `eventFunction` over the request's span.
///
/// `events` receives up to `capacity` events; `count` receives how many were
/// written. The status distinguishes "the span held no events" (OK, count 0)
/// from "the source refused" and from "more events than the buffer held".
inline Status scan(StateSourceFn stateSource, void* stateContext, EventFn eventFunction,
                   void* eventContext, const ScanRequest& request, Event* events,
                   int32_t capacity, int32_t* count) {
  if (count == nullptr || events == nullptr || capacity <= 0) return Status::INVALID_REQUEST;
  *count = 0;
  if (stateSource == nullptr || eventFunction == nullptr) return Status::INVALID_REQUEST;
  const double span = request.stopSeconds - request.startSeconds;
  if (!(std::fabs(span) > 0.0)) return Status::INVALID_REQUEST;
  if (!(request.refinement.coarseStepSeconds > 0.0)) return Status::INVALID_REQUEST;
  if (!(request.refinement.toleranceSeconds > 0.0)) return Status::INVALID_REQUEST;

  // The scan walks in the direction of the span, so a backward search is the
  // forward algorithm with a negative increment.
  const double direction = span > 0.0 ? 1.0 : -1.0;
  const double step = request.refinement.coarseStepSeconds * direction;

  // The evaluator the refiner and the scan share. One place reads the state
  // source, so a root can never be refined against a different trajectory from
  // the one that bracketed it.
  bool sourceRefused = false;
  bool functionRefused = false;
  double scratchState[6] = {0.0, 0.0, 0.0, 0.0, 0.0, 0.0};
  const auto evaluate = [&](double time, double* value) {
    double state[6] = {0.0, 0.0, 0.0, 0.0, 0.0, 0.0};
    if (stateSource(stateContext, time, state) != 0) {
      sourceRefused = true;
      return false;
    }
    if (eventFunction(eventContext, time, state, value) != 0) {
      functionRefused = true;
      return false;
    }
    for (int i = 0; i < 6; ++i) scratchState[i] = state[i];
    return true;
  };

  double previousTime = request.startSeconds;
  double previousValue = 0.0;
  if (!evaluate(previousTime, &previousValue)) {
    return sourceRefused ? Status::STATE_SOURCE_REFUSED : Status::EVENT_FUNCTION_REFUSED;
  }

  const int32_t wanted = request.maxEvents > 0 ? request.maxEvents : capacity;
  bool truncated = false;
  bool notConverged = false;

  while (true) {
    double time = previousTime + step;
    const bool last = direction > 0.0 ? time >= request.stopSeconds
                                      : time <= request.stopSeconds;
    if (last) time = request.stopSeconds;

    double value = 0.0;
    if (!evaluate(time, &value)) {
      return sourceRefused ? Status::STATE_SOURCE_REFUSED : Status::EVENT_FUNCTION_REFUSED;
    }

    const bool crossed = (previousValue < 0.0 && value >= 0.0) ||
                         (previousValue > 0.0 && value <= 0.0) ||
                         (previousValue == 0.0 && value != 0.0);
    if (crossed) {
      // The crossing direction is a property of the EVENT, in forward time, not
      // of the order the scan happened to visit the interval in. On a backward
      // scan `time` precedes `previousTime`, so the raw comparison reports the
      // opposite sense — which would make a backward search for an ascending
      // node return a descending one. Multiplying by the step's sign states the
      // slope in forward time whichever way the scan runs.
      const Direction crossingDirection =
          (value - previousValue) * step > 0.0 ? Direction::INCREASING
                                               : Direction::DECREASING;
      const bool wantedDirection = request.direction == Direction::ANY ||
                                   request.direction == crossingDirection;
      if (wantedDirection) {
        double root = 0.0;
        double residual = 0.0;
        int32_t iterations = 0;
        // The bracket is [previousTime, time] in SCAN order, which for a
        // backward scan is decreasing. Brent does not care about the ordering,
        // only that the endpoints straddle the root.
        const bool converged =
            brentRoot(evaluate, previousTime, time, previousValue, value,
                      request.refinement.toleranceSeconds, request.refinement.maxIterations,
                      &root, &residual, &iterations);
        if (sourceRefused) return Status::STATE_SOURCE_REFUSED;
        if (functionRefused) return Status::EVENT_FUNCTION_REFUSED;
        if (!converged) notConverged = true;

        // Re-evaluate AT the root so the reported state is the state at the
        // reported epoch, not whatever the last refinement probe happened to
        // leave behind.
        double rootValue = 0.0;
        if (!evaluate(root, &rootValue)) {
          return sourceRefused ? Status::STATE_SOURCE_REFUSED
                               : Status::EVENT_FUNCTION_REFUSED;
        }

        if (*count < capacity) {
          Event& event = events[*count];
          event.epochSeconds = root;
          event.residual = rootValue;
          event.direction = crossingDirection;
          event.iterations = iterations;
          for (int i = 0; i < 6; ++i) event.state[i] = scratchState[i];
          ++(*count);
        } else {
          truncated = true;
        }
        if (*count >= wanted) break;
      }
    }

    previousTime = time;
    previousValue = value;
    if (last) break;
  }

  if (notConverged) return Status::REFINEMENT_DID_NOT_CONVERGE;
  if (truncated) return Status::RESULT_TRUNCATED;
  return Status::OK;
}

// ---------------------------------------------------------------------------
// Vector helpers, local to this header.
// ---------------------------------------------------------------------------

namespace detail {

struct V3 {
  double x = 0.0;
  double y = 0.0;
  double z = 0.0;
};

inline V3 of(const double v[3]) { return {v[0], v[1], v[2]}; }
inline double dot(const V3& a, const V3& b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
inline V3 sub(const V3& a, const V3& b) { return {a.x - b.x, a.y - b.y, a.z - b.z}; }
inline V3 add(const V3& a, const V3& b) { return {a.x + b.x, a.y + b.y, a.z + b.z}; }
inline V3 scale(const V3& a, double s) { return {a.x * s, a.y * s, a.z * s}; }
inline double norm(const V3& a) { return std::sqrt(dot(a, a)); }
inline V3 unit(const V3& a) {
  const double n = norm(a);
  return n > 0.0 ? scale(a, 1.0 / n) : V3{0.0, 0.0, 0.0};
}
inline V3 cross(const V3& a, const V3& b) {
  return {a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x};
}
/// Angle between two vectors, computed from the half-angle tangent form so it
/// stays accurate for nearly parallel and nearly antiparallel pairs — which is
/// exactly where an eclipse or an FOV boundary lives.
inline double angleBetween(const V3& a, const V3& b) {
  const V3 ua = unit(a);
  const V3 ub = unit(b);
  const double sum = norm(add(ua, ub));
  const double difference = norm(sub(ua, ub));
  return 2.0 * std::atan2(difference, sum);
}

}  // namespace detail

// ---------------------------------------------------------------------------
// A body ephemeris port, for the locators that need one. Same shape as the
// state source and for the same reason: the Sun's and the Moon's positions come
// from wherever the caller's ephemeris comes from.
// ---------------------------------------------------------------------------
typedef int32_t (*BodyPositionFn)(void* context, int32_t bodyId, double secondsFromEpoch,
                                  double position[3]);

// ---------------------------------------------------------------------------
// LOCATOR 1 — eclipse.
//
// The conical shadow written as three apparent angles: the angular radius of
// the occulting body seen from the spacecraft, the angular radius of the
// occulted body (the Sun) seen from the spacecraft, and the angular separation
// of their centres. Their arithmetic gives all three shadow regions with one
// geometry rather than three:
//
//   umbra     separation <  occultingRadius - occultedRadius
//   antumbra  separation <  occultedRadius - occultingRadius   (annular)
//   penumbra  separation <  occultingRadius + occultedRadius
//
// g is NEGATIVE inside the region, so entry is a decreasing crossing and exit
// an increasing one — the convention the external library's own detector uses,
// which is what makes its published epochs directly comparable.
// ---------------------------------------------------------------------------

enum class ShadowRegion : uint8_t {
  PENUMBRA = 0,
  UMBRA = 1,
  ANTUMBRA = 2,
};

struct EclipseContext {
  BodyPositionFn bodyPosition = nullptr;
  void* bodyContext = nullptr;
  /// Body whose light is being occulted, and its radius in metres.
  int32_t occultedBodyId = 10;
  double occultedRadius = 6.957e8;
  /// Body doing the occulting, and its radius. A second occulting body is a
  /// second context and a second scan; the runner is unchanged, which is the
  /// "multiple occulting bodies" requirement met by composition.
  int32_t occultingBodyId = 399;
  double occultingRadius = 6378137.0;
  ShadowRegion region = ShadowRegion::PENUMBRA;
};

inline int32_t eclipseFunction(void* context, double secondsFromEpoch, const double state[6],
                               double* g) {
  EclipseContext* eclipse = static_cast<EclipseContext*>(context);
  if (eclipse == nullptr || eclipse->bodyPosition == nullptr || g == nullptr) return 1;
  double occulting[3] = {0.0, 0.0, 0.0};
  double occulted[3] = {0.0, 0.0, 0.0};
  if (eclipse->bodyPosition(eclipse->bodyContext, eclipse->occultingBodyId, secondsFromEpoch,
                            occulting) != 0) {
    return 1;
  }
  if (eclipse->bodyPosition(eclipse->bodyContext, eclipse->occultedBodyId, secondsFromEpoch,
                            occulted) != 0) {
    return 1;
  }
  const detail::V3 spacecraft{state[0], state[1], state[2]};
  const detail::V3 toOcculting = detail::sub(detail::of(occulting), spacecraft);
  const detail::V3 toOcculted = detail::sub(detail::of(occulted), spacecraft);
  const double occultingDistance = detail::norm(toOcculting);
  const double occultedDistance = detail::norm(toOcculted);
  if (!(occultingDistance > eclipse->occultingRadius) ||
      !(occultedDistance > eclipse->occultedRadius)) {
    // Inside one of the bodies. Refusing is the answer: a shadow function is
    // not defined there and returning some number would be inventing one.
    return 1;
  }
  const double occultingAngle = std::asin(eclipse->occultingRadius / occultingDistance);
  const double occultedAngle = std::asin(eclipse->occultedRadius / occultedDistance);
  const double separation = detail::angleBetween(toOcculting, toOcculted);

  switch (eclipse->region) {
    case ShadowRegion::UMBRA:
      *g = separation - occultingAngle + occultedAngle;
      break;
    case ShadowRegion::ANTUMBRA:
      *g = separation - occultedAngle + occultingAngle;
      break;
    case ShadowRegion::PENUMBRA:
    default:
      *g = separation - occultingAngle - occultedAngle;
      break;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// LOCATOR 2 — station contact, with light time.
//
// g is the elevation of the spacecraft above the station's local horizon minus
// the station's minimum-elevation mask, so a rise is an increasing crossing.
//
// LIGHT TIME. With correction enabled, the elevation is evaluated on the
// spacecraft's position at the TRANSMISSION epoch t - range/c while the station
// sits at the RECEPTION epoch t. That is one fixed-point iteration on the
// range, converging in two or three passes because range/c changes by less than
// a microsecond per iteration. Without it, the epochs shift by exactly range/c,
// which is the acceptance's own check.
// ---------------------------------------------------------------------------

/// Where the observer is, and which way is up there, at an epoch. A site on a
/// rotating body MOVES in the inertial axes the ephemeris is expressed in, so
/// its position is a function of time like everything else here. A caller whose
/// observer genuinely does not move leaves this null and states the two vectors.
typedef int32_t (*SitePositionFn)(void* context, double secondsFromEpoch, double position[3],
                                  double up[3]);

struct ContactContext {
  StateSourceFn stateSource = nullptr;
  void* stateContext = nullptr;
  /// Observer position at each epoch, in the SAME axes as the spacecraft state.
  /// Null means the fixed vectors below.
  SitePositionFn sitePosition = nullptr;
  void* siteContext = nullptr;
  /// Station position in the SAME axes as the spacecraft state, metres, and the
  /// local up direction (the ellipsoid normal, not the radius vector).
  double stationPosition[3] = {0.0, 0.0, 0.0};
  double stationUp[3] = {0.0, 0.0, 1.0};
  /// Minimum elevation, radians.
  double minimumElevation = 0.0;
  bool lightTimeCorrection = false;
  int32_t lightTimeIterations = 3;
};

inline int32_t contactFunction(void* context, double secondsFromEpoch, const double state[6],
                               double* g) {
  ContactContext* contact = static_cast<ContactContext*>(context);
  if (contact == nullptr || g == nullptr) return 1;
  double sitePosition[3] = {contact->stationPosition[0], contact->stationPosition[1],
                            contact->stationPosition[2]};
  double siteUp[3] = {contact->stationUp[0], contact->stationUp[1], contact->stationUp[2]};
  if (contact->sitePosition != nullptr) {
    if (contact->sitePosition(contact->siteContext, secondsFromEpoch, sitePosition, siteUp) !=
        0) {
      return 1;
    }
  }
  const detail::V3 station = detail::of(sitePosition);
  const detail::V3 up = detail::unit(detail::of(siteUp));

  detail::V3 spacecraft{state[0], state[1], state[2]};
  if (contact->lightTimeCorrection) {
    if (contact->stateSource == nullptr) return 1;
    double delay = detail::norm(detail::sub(spacecraft, station)) / kSpeedOfLight;
    for (int32_t iteration = 0; iteration < contact->lightTimeIterations; ++iteration) {
      double delayed[6] = {0.0, 0.0, 0.0, 0.0, 0.0, 0.0};
      if (contact->stateSource(contact->stateContext, secondsFromEpoch - delay, delayed) != 0) {
        return 1;
      }
      const detail::V3 candidate{delayed[0], delayed[1], delayed[2]};
      delay = detail::norm(detail::sub(candidate, station)) / kSpeedOfLight;
      spacecraft = candidate;
    }
  }

  const detail::V3 lineOfSight = detail::sub(spacecraft, station);
  const double range = detail::norm(lineOfSight);
  if (!(range > 0.0)) return 1;
  const double sine = detail::dot(lineOfSight, up) / range;
  const double clamped = sine > 1.0 ? 1.0 : (sine < -1.0 ? -1.0 : sine);
  *g = std::asin(clamped) - contact->minimumElevation;
  return 0;
}

// ---------------------------------------------------------------------------
// LOCATOR 3 — intrusion of a body into a conic field of view.
//
// g is the cone's half angle minus the angular separation between the boresight
// and the direction to the body's CENTRE, so entry is an increasing crossing.
// `includeBodyRadius` grows the cone by the body's apparent radius, which is the
// difference between "the body's centre is inside" and "any part of the body is
// inside" — two different questions that must not share a name.
// ---------------------------------------------------------------------------

struct IntrusionContext {
  BodyPositionFn bodyPosition = nullptr;
  void* bodyContext = nullptr;
  int32_t bodyId = 10;
  double bodyRadius = 6.957e8;
  bool includeBodyRadius = false;
  /// Boresight direction in the working axes, and the cone's half angle.
  double boresight[3] = {0.0, 0.0, 1.0};
  double halfAngle = 0.1;
};

inline int32_t intrusionFunction(void* context, double secondsFromEpoch, const double state[6],
                                 double* g) {
  IntrusionContext* intrusion = static_cast<IntrusionContext*>(context);
  if (intrusion == nullptr || intrusion->bodyPosition == nullptr || g == nullptr) return 1;
  double body[3] = {0.0, 0.0, 0.0};
  if (intrusion->bodyPosition(intrusion->bodyContext, intrusion->bodyId, secondsFromEpoch,
                              body) != 0) {
    return 1;
  }
  const detail::V3 spacecraft{state[0], state[1], state[2]};
  const detail::V3 toBody = detail::sub(detail::of(body), spacecraft);
  const double distance = detail::norm(toBody);
  if (!(distance > 0.0)) return 1;
  const double separation = detail::angleBetween(toBody, detail::of(intrusion->boresight));
  double halfAngle = intrusion->halfAngle;
  if (intrusion->includeBodyRadius && distance > intrusion->bodyRadius) {
    halfAngle += std::asin(intrusion->bodyRadius / distance);
  }
  *g = halfAngle - separation;
  return 0;
}

// ---------------------------------------------------------------------------
// LOCATOR 4 — apsides.
//
// g = r . v, whose zero IS the apsis: the radial rate vanishes there. Apoapsis
// is the decreasing crossing (the radius stops growing), periapsis the
// increasing one.
//
// ON GEOCENTRIC RADIUS, DELIBERATELY. This is the quantity the owner defect of
// 2026-08-13 settled: geodetic height over an oblate body varies about 21 km
// with latitude, which swamps the radial signal of a near-circular orbit and
// puts "apogee" and "perigee" about 90 degrees apart in true anomaly. r . v has
// no ellipsoid in it at all, so the question cannot arise.
// ---------------------------------------------------------------------------

inline int32_t apsisFunction(void* /*context*/, double /*secondsFromEpoch*/,
                             const double state[6], double* g) {
  if (g == nullptr) return 1;
  *g = state[0] * state[3] + state[1] * state[4] + state[2] * state[5];
  return 0;
}

// ---------------------------------------------------------------------------
// LOCATOR 5 — node crossing.
//
// g is the component of position along the reference plane's normal. An
// ascending node is the increasing crossing. The normal is a PARAMETER: the
// node of an equatorial plane and the node of an orbit plane are the same
// question asked about different planes.
// ---------------------------------------------------------------------------

struct NodeContext {
  double planeNormal[3] = {0.0, 0.0, 1.0};
};

inline int32_t nodeFunction(void* context, double /*secondsFromEpoch*/, const double state[6],
                            double* g) {
  NodeContext* node = static_cast<NodeContext*>(context);
  if (node == nullptr || g == nullptr) return 1;
  *g = detail::dot(detail::of(state), detail::unit(detail::of(node->planeNormal)));
  return 0;
}

// ---------------------------------------------------------------------------
// LOCATOR 6 — a stopping condition on ANY scalar of the state.
//
// This is the sixth locator, and it is here to prove the acceptance's own
// claim: it was added without touching one line of the runner. `scalar` is any
// function of the state — a catalog parameter evaluator, in the module — and g
// is that scalar minus the goal.
// ---------------------------------------------------------------------------

typedef int32_t (*ScalarFn)(void* context, double secondsFromEpoch, const double state[6],
                            double* value);

struct StoppingContext {
  ScalarFn scalar = nullptr;
  void* scalarContext = nullptr;
  double goal = 0.0;
};

inline int32_t stoppingFunction(void* context, double secondsFromEpoch, const double state[6],
                                double* g) {
  StoppingContext* stopping = static_cast<StoppingContext*>(context);
  if (stopping == nullptr || stopping->scalar == nullptr || g == nullptr) return 1;
  double value = 0.0;
  if (stopping->scalar(stopping->scalarContext, secondsFromEpoch, state, &value) != 0) {
    return 1;
  }
  *g = value - stopping->goal;
  return 0;
}

/// Propagate to a condition: the first event of `eventFunction` in the span, or
/// CONDITION_NOT_MET. The propagator is the state source, so this verb is the
/// same one line whichever provider is behind it.
inline Status propagateToCondition(StateSourceFn stateSource, void* stateContext,
                                   EventFn eventFunction, void* eventContext,
                                   const ScanRequest& request, Event* event) {
  if (event == nullptr) return Status::INVALID_REQUEST;
  ScanRequest single = request;
  single.maxEvents = 1;
  int32_t count = 0;
  const Status status =
      scan(stateSource, stateContext, eventFunction, eventContext, single, event, 1, &count);
  if (status != Status::OK && status != Status::RESULT_TRUNCATED) return status;
  if (count == 0) return Status::CONDITION_NOT_MET;
  return Status::OK;
}

// ---------------------------------------------------------------------------
// A SYNCHRONIZED multi-spacecraft stop.
//
// The formation stops when the FIRST of its members meets its own condition,
// and every member is then reported at that one epoch. Written as a scan over
// the minimum of the members' event functions, so it is the same runner again:
// the earliest root of min(g_1 ... g_n) with all g_i sharing a bracket is the
// earliest root of any of them.
// ---------------------------------------------------------------------------

struct FormationMember {
  StateSourceFn stateSource = nullptr;
  void* stateContext = nullptr;
  EventFn eventFunction = nullptr;
  void* eventContext = nullptr;
};

struct FormationContext {
  const FormationMember* members = nullptr;
  int32_t memberCount = 0;
  /// Index of the member whose g was the minimum at the last evaluation. The
  /// caller reads it to learn WHICH member stopped the formation.
  int32_t governingMember = -1;
};

inline int32_t formationFunction(void* context, double secondsFromEpoch,
                                 const double /*state*/[6], double* g) {
  FormationContext* formation = static_cast<FormationContext*>(context);
  if (formation == nullptr || formation->members == nullptr || g == nullptr) return 1;
  if (formation->memberCount <= 0) return 1;
  double minimum = 0.0;
  int32_t governing = -1;
  for (int32_t i = 0; i < formation->memberCount; ++i) {
    const FormationMember& member = formation->members[i];
    if (member.stateSource == nullptr || member.eventFunction == nullptr) return 1;
    double state[6] = {0.0, 0.0, 0.0, 0.0, 0.0, 0.0};
    if (member.stateSource(member.stateContext, secondsFromEpoch, state) != 0) return 1;
    double value = 0.0;
    if (member.eventFunction(member.eventContext, secondsFromEpoch, state, &value) != 0) {
      return 1;
    }
    if (governing < 0 || value < minimum) {
      minimum = value;
      governing = i;
    }
  }
  formation->governingMember = governing;
  *g = minimum;
  return 0;
}

}  // namespace events
}  // namespace sdn

#endif  // SDN_PROPAGATOR_EVENTS_EVENT_LOCATOR_HPP
