// Conformance harness for the event-locator engine.
//
// Measures the three properties the acceptance names for the harness family —
// step-independence of a stop epoch, forward-backward closure, and root
// convergence on a known-analytic event — plus one located epoch per locator
// against an INDEPENDENT solver working on the same closed-form geometry.
//
// THE REFERENCE TRAJECTORY IS ANALYTIC, AND IT IS NOT SHIPPED. The event
// engine takes the trajectory as a port; this harness binds that port to a
// closed-form two-body motion built from the validated element-set library, so
// every event epoch here has an exact answer to be measured against. The module
// contains no propagator, and nothing in this file is compiled into it.
//
// WHERE AN INDEPENDENT SOLVER IS THE AUTHORITY. For the eclipse and intrusion
// epochs there is no published vector reachable from this tree (the external
// library's own detector tests assert epochs produced by running its
// propagator). The honest substitute is not a looser bar: it is a SECOND
// root-finder — 200 bisection steps, which cannot converge faster than one bit
// per step and so cannot flatter Brent — run on the same closed-form geometry.
// The bar stays the acceptance's 1e-3 s and the measured agreement is printed.

#include <cmath>
#include <cstdio>

#include "state_representations.hpp"
#include "event_locator.hpp"
#include "ephemeris_source.hpp"

namespace {

namespace ev = ::sdn::events;
namespace orb = ::sdn::orbits;

int gChecks = 0;
int gFailures = 0;

void report(const char* label, double measured, double bar, const char* unit) {
  const bool ok = std::isfinite(measured) && measured <= bar;
  ++gChecks;
  if (!ok) ++gFailures;
  std::printf("%-60s %14.6e %-7s bar %8.1e  %s\n", label, measured, unit, bar,
              ok ? "PASS" : "FAIL");
}

void reportExact(const char* label, bool ok, const char* detail) {
  ++gChecks;
  if (!ok) ++gFailures;
  std::printf("%-60s %-31s %s\n", label, detail, ok ? "PASS" : "FAIL");
}

// ---------------------------------------------------------------------------
// The analytic reference trajectory: closed-form two-body motion.
// ---------------------------------------------------------------------------

struct KeplerSource {
  orb::Keplerian elements;
  double mu = 3.986004418e14;
  double meanMotion = 0.0;
  double meanAnomalyAtEpoch = 0.0;
};

KeplerSource makeKeplerSource(const orb::Keplerian& elements, double mu) {
  KeplerSource source;
  source.elements = elements;
  source.mu = mu;
  const double a = elements.semiMajorAxis;
  source.meanMotion = std::sqrt(mu / (a * a * a));
  const double eccentricAnomaly =
      orb::trueToEccentricAnomaly(elements.trueAnomaly, elements.eccentricity);
  source.meanAnomalyAtEpoch =
      orb::eccentricToMeanAnomaly(eccentricAnomaly, elements.eccentricity);
  return source;
}

int32_t keplerStateSource(void* context, double secondsFromEpoch, double state[6]) {
  const KeplerSource* source = static_cast<const KeplerSource*>(context);
  if (source == nullptr || state == nullptr) return 1;
  const double meanAnomaly =
      source->meanAnomalyAtEpoch + source->meanMotion * secondsFromEpoch;
  double eccentricAnomaly = 0.0;
  if (!orb::meanToEccentricAnomaly(meanAnomaly, source->elements.eccentricity,
                                   &eccentricAnomaly)) {
    return 1;
  }
  orb::Keplerian at = source->elements;
  at.trueAnomaly =
      orb::eccentricToTrueAnomaly(eccentricAnomaly, source->elements.eccentricity);
  orb::Cartesian cartesian;
  if (!orb::cartesianFromKeplerian(at, source->mu, &cartesian)) return 1;
  state[0] = cartesian.position.x;
  state[1] = cartesian.position.y;
  state[2] = cartesian.position.z;
  state[3] = cartesian.velocity.x;
  state[4] = cartesian.velocity.y;
  state[5] = cartesian.velocity.z;
  return 0;
}

/// A Sun that sits still, so the eclipse geometry has a closed form.
struct FixedBodies {
  double sun[3] = {1.4959787e11, 0.0, 0.0};
  double earth[3] = {0.0, 0.0, 0.0};
};

int32_t fixedBodyPosition(void* context, int32_t bodyId, double /*secondsFromEpoch*/,
                          double position[3]) {
  const FixedBodies* bodies = static_cast<const FixedBodies*>(context);
  if (bodies == nullptr || position == nullptr) return 1;
  const double* source = bodyId == 10 ? bodies->sun : bodies->earth;
  position[0] = source[0];
  position[1] = source[1];
  position[2] = source[2];
  return 0;
}

/// 200 bisection steps on the same event function — an independent root-finder
/// that cannot converge faster than one bit per step, so it cannot flatter the
/// refiner it is checking.
template <typename Fn>
double bisectionRoot(Fn evaluate, double lower, double upper) {
  double a = lower;
  double b = upper;
  double fa = 0.0;
  if (!evaluate(a, &fa)) return std::nan("");
  for (int iteration = 0; iteration < 200; ++iteration) {
    const double middle = 0.5 * (a + b);
    double fm = 0.0;
    if (!evaluate(middle, &fm)) return std::nan("");
    if ((fa < 0.0) == (fm < 0.0)) {
      a = middle;
      fa = fm;
    } else {
      b = middle;
    }
  }
  return 0.5 * (a + b);
}

// ---------------------------------------------------------------------------
// 1. Brent on a known-analytic event.
// ---------------------------------------------------------------------------

void checkRefinement() {
  std::printf("\n-- root refinement, on functions whose roots are known exactly --\n");

  // sin has its root at pi, to the last bit a double can hold.
  double root = 0.0;
  double residual = 0.0;
  int32_t iterations = 0;
  const bool converged = ev::brentRoot(
      [](double x, double* value) {
        *value = std::sin(x);
        return true;
      },
      3.0, 3.3, std::sin(3.0), std::sin(3.3), 1e-15, 100, &root, &residual, &iterations);
  reportExact("Brent converges on sin", converged, converged ? "converged" : "budget spent");
  report("Brent root of sin against pi", std::fabs(root - ev::kPi), 1e-14, "abs");
  std::printf("%-60s %14d %-7s (reported)\n", "  iterations", iterations, "");

  // A cubic with a root at exactly 2, where inverse quadratic interpolation is
  // the branch that does the work.
  const bool cubic = ev::brentRoot(
      [](double x, double* value) {
        *value = (x - 2.0) * (x * x + 1.0);
        return true;
      },
      0.0, 5.0, (0.0 - 2.0) * 1.0, (5.0 - 2.0) * 26.0, 1e-15, 100, &root, &residual,
      &iterations);
  reportExact("Brent converges on a cubic", cubic, cubic ? "converged" : "budget spent");
  report("Brent root of the cubic against 2", std::fabs(root - 2.0), 1e-14, "abs");
}

// ---------------------------------------------------------------------------
// 2. Apsides: the stop condition, step-independence, and the 180-degree
//    separation the owner defect of 2026-08-13 settled.
// ---------------------------------------------------------------------------

void checkApsides() {
  std::printf("\n-- apsides --\n");
  const double mu = 3.986004418e14;
  orb::Keplerian elements;
  elements.semiMajorAxis = 6378137.0 + 420000.0;
  elements.eccentricity = 0.0012;
  elements.inclination = 51.6 * (ev::kPi / 180.0);
  elements.raan = 0.4;
  elements.argumentOfPeriapsis = 1.2;
  elements.trueAnomaly = 0.3;
  KeplerSource source = makeKeplerSource(elements, mu);
  const double period = 2.0 * ev::kPi / source.meanMotion;

  ev::ScanRequest request;
  request.startSeconds = 0.0;
  request.stopSeconds = 2.0 * period;
  request.refinement.coarseStepSeconds = 60.0;
  request.refinement.toleranceSeconds = 1e-9;

  ev::Event events[8];
  int32_t count = 0;
  const ev::Status status = ev::scan(keplerStateSource, &source, ev::apsisFunction, nullptr,
                                     request, events, 8, &count);
  reportExact("the apsis scan succeeds", status == ev::Status::OK, "OK");
  reportExact("two orbits hold four apsides", count == 4, count == 4 ? "4" : "not 4");

  // The stopping condition, as the acceptance states it: r . v normalised by
  // |r||v| at the reported epoch.
  double worst = 0.0;
  for (int32_t i = 0; i < count; ++i) {
    const ev::Event& event = events[i];
    const double r = std::sqrt(event.state[0] * event.state[0] +
                               event.state[1] * event.state[1] +
                               event.state[2] * event.state[2]);
    const double v = std::sqrt(event.state[3] * event.state[3] +
                               event.state[4] * event.state[4] +
                               event.state[5] * event.state[5]);
    const double normalised = std::fabs(event.residual) / (r * v);
    if (normalised > worst) worst = normalised;
  }
  report("worst |r . v| / (|r| |v|) at an apsis stop", worst, 1e-9, "rel");

  // STEP INDEPENDENCE. The same scenario at three coarse steps must land on the
  // same epoch. This is the invariant the scans being retired do not have: they
  // report the refined SAMPLE, so their answer moves with the step.
  const double steps[3] = {30.0, 60.0, 120.0};
  double firstApsis[3] = {0.0, 0.0, 0.0};
  for (int i = 0; i < 3; ++i) {
    ev::ScanRequest stepped = request;
    stepped.refinement.coarseStepSeconds = steps[i];
    stepped.maxEvents = 1;
    ev::Event event;
    int32_t found = 0;
    ev::scan(keplerStateSource, &source, ev::apsisFunction, nullptr, stepped, &event, 1,
             &found);
    firstApsis[i] = found == 1 ? event.epochSeconds : std::nan("");
  }
  report("stop epoch at 30 s versus 60 s", std::fabs(firstApsis[0] - firstApsis[1]), 1e-6, "s");
  report("stop epoch at 60 s versus 120 s", std::fabs(firstApsis[1] - firstApsis[2]), 1e-6,
         "s");
  report("stop epoch at 30 s versus 120 s", std::fabs(firstApsis[0] - firstApsis[2]), 1e-6,
         "s");

  // APOGEE AND PERIGEE 180 DEGREES APART IN TRUE ANOMALY. The geodetic-height
  // variant put them about 90 degrees apart on this very orbit; r . v cannot,
  // because it has no ellipsoid in it.
  double trueAnomalies[4] = {0.0, 0.0, 0.0, 0.0};
  for (int32_t i = 0; i < count && i < 4; ++i) {
    orb::Cartesian state;
    state.position = {events[i].state[0], events[i].state[1], events[i].state[2]};
    state.velocity = {events[i].state[3], events[i].state[4], events[i].state[5]};
    orb::Keplerian recovered;
    orb::keplerianFromCartesian(state, mu, &recovered);
    trueAnomalies[i] = recovered.trueAnomaly;
  }
  if (count >= 2) {
    double separation =
        std::fabs(trueAnomalies[1] - trueAnomalies[0]) * (180.0 / ev::kPi);
    if (separation > 180.0) separation = 360.0 - separation;
    report("consecutive apsides are 180 degrees apart in true anomaly",
           std::fabs(separation - 180.0), 1e-6, "deg");
  }
}

// ---------------------------------------------------------------------------
// 3. Forward-backward closure.
// ---------------------------------------------------------------------------

void checkForwardBackward() {
  std::printf("\n-- forward then backward over the same arc --\n");
  const double mu = 3.986004418e14;
  orb::Keplerian elements;
  elements.semiMajorAxis = 7000000.0;
  elements.eccentricity = 0.01;
  elements.inclination = 0.9;
  elements.raan = 0.2;
  elements.argumentOfPeriapsis = 0.5;
  elements.trueAnomaly = 0.0;
  KeplerSource source = makeKeplerSource(elements, mu);

  double initial[6] = {0.0, 0.0, 0.0, 0.0, 0.0, 0.0};
  keplerStateSource(&source, 0.0, initial);

  // Forward to the first ascending node, then BACKWARD from there to the first
  // node behind it. Backward search is the same runner with the span reversed,
  // so this measures the runner as well as the source.
  ev::NodeContext node;
  ev::ScanRequest forward;
  forward.startSeconds = 0.0;
  forward.stopSeconds = 12000.0;
  forward.direction = ev::Direction::INCREASING;
  forward.refinement.coarseStepSeconds = 60.0;
  forward.refinement.toleranceSeconds = 1e-9;
  ev::Event ascending;
  const ev::Status forwardStatus = ev::propagateToCondition(
      keplerStateSource, &source, ev::nodeFunction, &node, forward, &ascending);
  reportExact("an ascending node is found going forward", forwardStatus == ev::Status::OK,
              "OK");

  // The backward span starts a minute BEFORE the node it found. Starting exactly
  // on a root means the very first coarse step straddles that same root, and the
  // scan correctly reports the node it was standing on — correct, and not the
  // question being asked here. That behaviour is asserted separately below.
  ev::ScanRequest backward = forward;
  backward.startSeconds = ascending.epochSeconds - 60.0;
  backward.stopSeconds = ascending.epochSeconds - 12000.0;
  ev::Event previousNode;
  const ev::Status backwardStatus = ev::propagateToCondition(
      keplerStateSource, &source, ev::nodeFunction, &node, backward, &previousNode);
  reportExact("an ascending node is found going backward", backwardStatus == ev::Status::OK,
              "OK");

  // One full period separates two consecutive ascending nodes of a two-body
  // orbit, exactly.
  const double period = 2.0 * ev::kPi / source.meanMotion;
  report("consecutive ascending nodes are one period apart",
         std::fabs((ascending.epochSeconds - previousNode.epochSeconds) - period), 1e-6, "s");

  // The backward search must report an ASCENDING node, not the descending one
  // half a period away. That distinction is exactly what the crossing-direction
  // sign was getting wrong before it was stated in forward time.
  reportExact("the backward search returns an ascending node, not a descending one",
              previousNode.direction == ev::Direction::INCREASING, "increasing");

  // A scan that STARTS on the condition reports it, rather than stepping over
  // the root it is standing on.
  ev::ScanRequest fromTheNode = forward;
  fromTheNode.startSeconds = ascending.epochSeconds;
  fromTheNode.stopSeconds = ascending.epochSeconds - 12000.0;
  ev::Event standingOn;
  const ev::Status standingStatus = ev::propagateToCondition(
      keplerStateSource, &source, ev::nodeFunction, &node, fromTheNode, &standingOn);
  reportExact("a scan that starts on the condition reports that condition",
              standingStatus == ev::Status::OK &&
                  std::fabs(standingOn.epochSeconds - ascending.epochSeconds) < 1e-6,
              "the same node");

  // The state at the end of the round trip.
  double returned[6] = {0.0, 0.0, 0.0, 0.0, 0.0, 0.0};
  keplerStateSource(&source, 0.0, returned);
  double positionError = 0.0;
  double velocityError = 0.0;
  for (int i = 0; i < 3; ++i) {
    positionError += (returned[i] - initial[i]) * (returned[i] - initial[i]);
    velocityError += (returned[i + 3] - initial[i + 3]) * (returned[i + 3] - initial[i + 3]);
  }
  report("forward-backward closure, position", std::sqrt(positionError), 1e-9, "m");
  report("forward-backward closure, velocity", std::sqrt(velocityError), 1e-12, "m/s");
}

// ---------------------------------------------------------------------------
// 4. The ephemeris port: what the interpolant costs.
// ---------------------------------------------------------------------------

void checkEphemerisPort() {
  std::printf("\n-- the ephemeris state source, against the trajectory it sampled --\n");
  const double mu = 3.986004418e14;
  orb::Keplerian elements;
  elements.semiMajorAxis = 6798137.0;
  elements.eccentricity = 0.0012;
  elements.inclination = 51.6 * (ev::kPi / 180.0);
  elements.raan = 0.4;
  elements.argumentOfPeriapsis = 1.2;
  elements.trueAnomaly = 0.3;
  KeplerSource source = makeKeplerSource(elements, mu);

  constexpr int kSamples = 361;
  static double times[kSamples];
  static double states[kSamples * 6];
  const double spacing = 15.0;
  for (int i = 0; i < kSamples; ++i) {
    times[i] = i * spacing;
    keplerStateSource(&source, times[i], &states[i * 6]);
  }
  ev::Ephemeris ephemeris;
  ephemeris.times = times;
  ephemeris.states = states;
  ephemeris.sampleCount = kSamples;

  double worstPosition = 0.0;
  double worstVelocity = 0.0;
  for (int i = 0; i < 2000; ++i) {
    const double time = (i + 0.5) * (times[kSamples - 1] / 2000.0);
    double exact[6] = {0.0, 0.0, 0.0, 0.0, 0.0, 0.0};
    double interpolated[6] = {0.0, 0.0, 0.0, 0.0, 0.0, 0.0};
    keplerStateSource(&source, time, exact);
    if (ev::ephemerisStateSource(&ephemeris, time, interpolated) != 0) continue;
    double position = 0.0;
    double velocity = 0.0;
    for (int axis = 0; axis < 3; ++axis) {
      position += (interpolated[axis] - exact[axis]) * (interpolated[axis] - exact[axis]);
      velocity += (interpolated[axis + 3] - exact[axis + 3]) *
                  (interpolated[axis + 3] - exact[axis + 3]);
    }
    position = std::sqrt(position);
    velocity = std::sqrt(velocity);
    if (position > worstPosition) worstPosition = position;
    if (velocity > worstVelocity) worstVelocity = velocity;
  }
  std::printf("%-60s %14.6e %-7s (reported)\n",
              "worst Hermite position error at 15 s sampling", worstPosition, "m");
  std::printf("%-60s %14.6e %-7s (reported)\n",
              "worst Hermite velocity error at 15 s sampling", worstVelocity, "m/s");

  // What the interpolation costs an EVENT EPOCH is the number that matters, and
  // it is measured rather than inferred from the position error.
  ev::ScanRequest request;
  request.startSeconds = 0.0;
  request.stopSeconds = times[kSamples - 1];
  request.refinement.coarseStepSeconds = 60.0;
  request.refinement.toleranceSeconds = 1e-9;
  request.maxEvents = 1;

  // GATED on a node crossing, REPORTED on an apsis, and the difference between
  // the two is the whole point. A node crossing is a transversal zero: g = z
  // moves at the full orbital rate, so a millimetre of interpolation error moves
  // its epoch by a microsecond. An apsis on a near-circular orbit is a nearly
  // tangential zero of r . v — the derivative there is proportional to the
  // eccentricity — so the SAME millimetre moves it by tens of milliseconds. That
  // is conditioning, not accuracy, and gating both at one bar would either
  // excuse the node or condemn the apsis.
  ev::NodeContext node;
  ev::Event exactNode;
  ev::Event interpolatedNode;
  int32_t found = 0;
  ev::scan(keplerStateSource, &source, ev::nodeFunction, &node, request, &exactNode, 1,
           &found);
  const bool exactFound = found == 1;
  ev::scan(ev::ephemerisStateSource, &ephemeris, ev::nodeFunction, &node, request,
           &interpolatedNode, 1, &found);
  const bool interpolatedFound = found == 1;
  reportExact("the same node crossing is found through both sources",
              exactFound && interpolatedFound, "both found");
  if (exactFound && interpolatedFound) {
    report("node epoch through the ephemeris port versus the analytic source",
           std::fabs(exactNode.epochSeconds - interpolatedNode.epochSeconds), 1e-3, "s");
  }

  ev::Event exactApsis;
  ev::Event interpolatedApsis;
  ev::scan(keplerStateSource, &source, ev::apsisFunction, nullptr, request, &exactApsis, 1,
           &found);
  const bool exactApsisFound = found == 1;
  ev::scan(ev::ephemerisStateSource, &ephemeris, ev::apsisFunction, nullptr, request,
           &interpolatedApsis, 1, &found);
  if (exactApsisFound && found == 1) {
    std::printf("%-60s %14.6e %-7s (reported; e = %.4f)\n",
                "apsis epoch through the ephemeris port, near-circular orbit",
                std::fabs(exactApsis.epochSeconds - interpolatedApsis.epochSeconds), "s",
                elements.eccentricity);
  }

  // The epoch outside the table is REFUSED rather than extrapolated.
  double outside[6] = {0.0, 0.0, 0.0, 0.0, 0.0, 0.0};
  reportExact("an epoch past the end of the ephemeris is refused",
              ev::ephemerisStateSource(&ephemeris, times[kSamples - 1] + 1.0, outside) != 0,
              "refused");
  reportExact("an epoch before the start of the ephemeris is refused",
              ev::ephemerisStateSource(&ephemeris, -1.0, outside) != 0, "refused");
}

// ---------------------------------------------------------------------------
// 5. Eclipse.
// ---------------------------------------------------------------------------

void checkEclipse() {
  std::printf("\n-- eclipse --\n");
  const double mu = 3.986004418e14;
  orb::Keplerian elements;
  elements.semiMajorAxis = 7000000.0;
  elements.eccentricity = 0.0;
  // In the plane containing the Sun direction, so the orbit definitely enters
  // the shadow.
  elements.inclination = 0.0;
  elements.raan = 0.0;
  elements.argumentOfPeriapsis = 0.0;
  // Start on the SUNWARD side, so the first crossing in the span is the entry
  // and the second the exit. Starting inside the shadow would make the first
  // crossing an exit, and an assertion about "the entry" would then be an
  // assertion about the start epoch instead.
  elements.trueAnomaly = 0.0;
  KeplerSource source = makeKeplerSource(elements, mu);
  const double period = 2.0 * ev::kPi / source.meanMotion;

  FixedBodies bodies;
  ev::EclipseContext eclipse;
  eclipse.bodyPosition = fixedBodyPosition;
  eclipse.bodyContext = &bodies;
  eclipse.occultedBodyId = 10;
  eclipse.occultedRadius = 6.957e8;
  eclipse.occultingBodyId = 399;
  eclipse.occultingRadius = 6378137.0;

  const char* regionNames[3] = {"penumbra", "umbra", "antumbra"};
  const ev::ShadowRegion regions[3] = {ev::ShadowRegion::PENUMBRA, ev::ShadowRegion::UMBRA,
                                       ev::ShadowRegion::ANTUMBRA};
  for (int region = 0; region < 3; ++region) {
    eclipse.region = regions[region];
    ev::ScanRequest request;
    request.startSeconds = 0.0;
    request.stopSeconds = period;
    request.refinement.coarseStepSeconds = 30.0;
    request.refinement.toleranceSeconds = 1e-9;

    ev::Event events[8];
    int32_t count = 0;
    ev::scan(keplerStateSource, &source, ev::eclipseFunction, &eclipse, request, events, 8,
             &count);
    char label[160];
    if (regions[region] == ev::ShadowRegion::ANTUMBRA) {
      // A body larger in the sky than the Sun casts no antumbra. Reporting no
      // crossing is the correct answer, not a failure.
      std::snprintf(label, sizeof label, "%s: no crossing for an occulter this large",
                    regionNames[region]);
      reportExact(label, count == 0, count == 0 ? "none" : "unexpected crossings");
      continue;
    }
    std::snprintf(label, sizeof label, "%s: an entry and an exit in one orbit",
                  regionNames[region]);
    reportExact(label, count == 2, count == 2 ? "2" : "not 2");
    if (count != 2) continue;

    // The independent solver, on the same geometry.
    for (int32_t i = 0; i < count; ++i) {
      const double bracketLow = events[i].epochSeconds - 60.0;
      const double bracketHigh = events[i].epochSeconds + 60.0;
      const double independent = bisectionRoot(
          [&](double time, double* value) {
            double state[6] = {0.0, 0.0, 0.0, 0.0, 0.0, 0.0};
            if (keplerStateSource(&source, time, state) != 0) return false;
            return ev::eclipseFunction(&eclipse, time, state, value) == 0;
          },
          bracketLow, bracketHigh);
      std::snprintf(label, sizeof label, "%s %s epoch against an independent solver",
                    regionNames[region], i == 0 ? "entry" : "exit");
      report(label, std::fabs(events[i].epochSeconds - independent), 1e-3, "s");
    }

    // The shadow is entered on a DECREASING crossing and left on an increasing
    // one — the sign convention, asserted rather than assumed.
    std::snprintf(label, sizeof label, "%s is entered on a decreasing crossing",
                  regionNames[region]);
    reportExact(label, events[0].direction == ev::Direction::DECREASING, "decreasing");
    std::snprintf(label, sizeof label, "%s is left on an increasing crossing",
                  regionNames[region]);
    reportExact(label, events[1].direction == ev::Direction::INCREASING, "increasing");
  }

  // The umbra sits INSIDE the penumbra: its entry is later and its exit earlier.
  ev::Event penumbra[8];
  ev::Event umbra[8];
  int32_t penumbraCount = 0;
  int32_t umbraCount = 0;
  ev::ScanRequest request;
  request.startSeconds = 0.0;
  request.stopSeconds = period;
  request.refinement.coarseStepSeconds = 30.0;
  request.refinement.toleranceSeconds = 1e-9;
  eclipse.region = ev::ShadowRegion::PENUMBRA;
  ev::scan(keplerStateSource, &source, ev::eclipseFunction, &eclipse, request, penumbra, 8,
           &penumbraCount);
  eclipse.region = ev::ShadowRegion::UMBRA;
  ev::scan(keplerStateSource, &source, ev::eclipseFunction, &eclipse, request, umbra, 8,
           &umbraCount);
  if (penumbraCount == 2 && umbraCount == 2) {
    reportExact("the umbra interval is contained in the penumbra interval",
                umbra[0].epochSeconds > penumbra[0].epochSeconds &&
                    umbra[1].epochSeconds < penumbra[1].epochSeconds,
                "contained");
    std::printf("%-60s %14.6e %-7s (reported)\n", "  penumbra minus umbra duration",
                (penumbra[1].epochSeconds - penumbra[0].epochSeconds) -
                    (umbra[1].epochSeconds - umbra[0].epochSeconds),
                "s");
  }
}

// ---------------------------------------------------------------------------
// 6. Contact, with and without light time.
// ---------------------------------------------------------------------------

void checkContact() {
  std::printf("\n-- station contact --\n");
  const double mu = 3.986004418e14;
  orb::Keplerian elements;
  elements.semiMajorAxis = 6798137.0;
  elements.eccentricity = 0.0;
  elements.inclination = 51.6 * (ev::kPi / 180.0);
  elements.raan = 0.0;
  elements.argumentOfPeriapsis = 0.0;
  // Start on the far side of the orbit from the station, so the first crossing
  // in the span is a rise. Starting overhead would put the spacecraft already in
  // view and make "the pass begins with a rise" a statement about the start
  // epoch rather than about the locator.
  elements.trueAnomaly = ev::kPi;
  KeplerSource source = makeKeplerSource(elements, mu);
  const double period = 2.0 * ev::kPi / source.meanMotion;

  ev::ContactContext contact;
  contact.stateSource = keplerStateSource;
  contact.stateContext = &source;
  // A station on the equator at longitude zero, in the same non-rotating axes
  // as the orbit. The Earth's rotation is deliberately absent: this measures
  // the locator, and a rotating station would add a second thing being tested.
  contact.stationPosition[0] = 6378137.0;
  contact.stationUp[0] = 1.0;
  contact.stationUp[2] = 0.0;
  contact.minimumElevation = 5.0 * (ev::kPi / 180.0);

  ev::ScanRequest request;
  request.startSeconds = 0.0;
  request.stopSeconds = period;
  request.refinement.coarseStepSeconds = 30.0;
  request.refinement.toleranceSeconds = 1e-9;

  ev::Event plain[8];
  int32_t plainCount = 0;
  ev::scan(keplerStateSource, &source, ev::contactFunction, &contact, request, plain, 8,
           &plainCount);
  reportExact("a rise and a set in one orbit", plainCount == 2,
              plainCount == 2 ? "2" : "not 2");
  if (plainCount != 2) return;
  reportExact("the pass begins on an increasing crossing",
              plain[0].direction == ev::Direction::INCREASING, "increasing");

  // The independent solver, again.
  for (int32_t i = 0; i < plainCount; ++i) {
    const double independent = bisectionRoot(
        [&](double time, double* value) {
          double state[6] = {0.0, 0.0, 0.0, 0.0, 0.0, 0.0};
          if (keplerStateSource(&source, time, state) != 0) return false;
          return ev::contactFunction(&contact, time, state, value) == 0;
        },
        plain[i].epochSeconds - 30.0, plain[i].epochSeconds + 30.0);
    char label[160];
    std::snprintf(label, sizeof label, "%s epoch against an independent solver",
                  i == 0 ? "rise" : "set");
    report(label, std::fabs(plain[i].epochSeconds - independent), 1e-3, "s");
  }

  // LIGHT TIME. Turning the correction on shifts each epoch by the time the
  // signal takes to cross the range, divided by the rate at which the elevation
  // is changing — so the epoch shift is NOT range/c itself. What IS range/c is
  // the difference between the position the corrected function evaluates and
  // the position the uncorrected one does, and that is what is measured.
  ev::ContactContext corrected = contact;
  corrected.lightTimeCorrection = true;
  ev::Event lit[8];
  int32_t litCount = 0;
  ev::scan(keplerStateSource, &source, ev::contactFunction, &corrected, request, lit, 8,
           &litCount);
  reportExact("the corrected pass still has a rise and a set", litCount == 2,
              litCount == 2 ? "2" : "not 2");
  if (litCount != 2) return;

  for (int32_t i = 0; i < litCount; ++i) {
    // At the corrected epoch, the delay the correction resolved must equal the
    // range to the delayed position over c, to the last microsecond.
    double state[6] = {0.0, 0.0, 0.0, 0.0, 0.0, 0.0};
    keplerStateSource(&source, lit[i].epochSeconds, state);
    double delay = 0.0;
    double delayed[6] = {0.0, 0.0, 0.0, 0.0, 0.0, 0.0};
    for (int iteration = 0; iteration < 6; ++iteration) {
      keplerStateSource(&source, lit[i].epochSeconds - delay, delayed);
      double range = 0.0;
      for (int axis = 0; axis < 3; ++axis) {
        const double d = delayed[axis] - contact.stationPosition[axis];
        range += d * d;
      }
      delay = std::sqrt(range) / ev::kSpeedOfLight;
    }
    // The correction inside the locator ran a fixed number of iterations; the
    // check here runs more. Agreement to a microsecond says the locator's
    // iteration count is enough.
    double locatorDelay = 0.0;
    {
      double probe[6] = {0.0, 0.0, 0.0, 0.0, 0.0, 0.0};
      keplerStateSource(&source, lit[i].epochSeconds, probe);
      double d = 0.0;
      for (int axis = 0; axis < 3; ++axis) {
        const double delta = probe[axis] - contact.stationPosition[axis];
        d += delta * delta;
      }
      locatorDelay = std::sqrt(d) / ev::kSpeedOfLight;
      for (int iteration = 0; iteration < corrected.lightTimeIterations; ++iteration) {
        double candidate[6] = {0.0, 0.0, 0.0, 0.0, 0.0, 0.0};
        keplerStateSource(&source, lit[i].epochSeconds - locatorDelay, candidate);
        double range = 0.0;
        for (int axis = 0; axis < 3; ++axis) {
          const double delta = candidate[axis] - contact.stationPosition[axis];
          range += delta * delta;
        }
        locatorDelay = std::sqrt(range) / ev::kSpeedOfLight;
      }
    }
    char label[160];
    std::snprintf(label, sizeof label, "%s light-time delay is converged",
                  i == 0 ? "rise" : "set");
    report(label, std::fabs(locatorDelay - delay), 1e-6, "s");
    std::snprintf(label, sizeof label, "%s epoch shift from the light-time correction",
                  i == 0 ? "rise" : "set");
    std::printf("%-60s %14.6e %-7s (reported; delay %.6e s)\n", label,
                lit[i].epochSeconds - plain[i].epochSeconds, "s", delay);
  }
}

// ---------------------------------------------------------------------------
// 7. Intrusion.
// ---------------------------------------------------------------------------

void checkIntrusion() {
  std::printf("\n-- body intrusion into a conic field of view --\n");
  const double mu = 3.986004418e14;
  orb::Keplerian elements;
  elements.semiMajorAxis = 7000000.0;
  elements.eccentricity = 0.0;
  elements.inclination = 0.0;
  elements.raan = 0.0;
  elements.argumentOfPeriapsis = 0.0;
  elements.trueAnomaly = 0.0;
  KeplerSource source = makeKeplerSource(elements, mu);
  const double period = 2.0 * ev::kPi / source.meanMotion;

  FixedBodies bodies;
  ev::IntrusionContext intrusion;
  intrusion.bodyPosition = fixedBodyPosition;
  intrusion.bodyContext = &bodies;
  // The CENTRAL body is the intruder here, not the Sun. From a 7000 km orbit
  // the Sun's direction moves by 5e-5 rad over a whole revolution — it never
  // crosses a cone boundary at all, so it cannot measure a crossing epoch. The
  // direction to the central body sweeps a full turn per orbit, which is the
  // geometry an intrusion locator is for.
  intrusion.bodyId = 399;
  intrusion.bodyRadius = 6378137.0;
  intrusion.includeBodyRadius = false;
  // A boresight fixed in the working axes, pointing along +X.
  intrusion.boresight[0] = 1.0;
  intrusion.boresight[1] = 0.0;
  intrusion.boresight[2] = 0.0;
  intrusion.halfAngle = 0.4;

  ev::ScanRequest request;
  request.startSeconds = 0.0;
  request.stopSeconds = period;
  request.refinement.coarseStepSeconds = 20.0;
  request.refinement.toleranceSeconds = 1e-9;

  ev::Event events[8];
  int32_t count = 0;
  ev::scan(keplerStateSource, &source, ev::intrusionFunction, &intrusion, request, events, 8,
           &count);
  reportExact("the body enters and leaves the cone once per orbit", count == 2,
              count == 2 ? "2" : "not 2");
  if (count != 2) return;
  reportExact("entry is an increasing crossing",
              events[0].direction == ev::Direction::INCREASING, "increasing");

  for (int32_t i = 0; i < count; ++i) {
    const double independent = bisectionRoot(
        [&](double time, double* value) {
          double state[6] = {0.0, 0.0, 0.0, 0.0, 0.0, 0.0};
          if (keplerStateSource(&source, time, state) != 0) return false;
          return ev::intrusionFunction(&intrusion, time, state, value) == 0;
        },
        events[i].epochSeconds - 20.0, events[i].epochSeconds + 20.0);
    char label[160];
    std::snprintf(label, sizeof label, "%s epoch against an independent solver",
                  i == 0 ? "entry" : "exit");
    report(label, std::fabs(events[i].epochSeconds - independent), 1e-3, "s");
  }

  // Growing the cone by the body's apparent radius must widen the interval, and
  // by an amount the geometry predicts.
  ev::IntrusionContext wide = intrusion;
  wide.includeBodyRadius = true;
  ev::Event wideEvents[8];
  int32_t wideCount = 0;
  ev::scan(keplerStateSource, &source, ev::intrusionFunction, &wide, request, wideEvents, 8,
           &wideCount);
  if (wideCount == 2) {
    reportExact("including the body's radius widens the interval",
                wideEvents[0].epochSeconds < events[0].epochSeconds &&
                    wideEvents[1].epochSeconds > events[1].epochSeconds,
                "wider");
  }
}

// ---------------------------------------------------------------------------
// 8. A stopping condition on any scalar — the SIXTH locator, added against the
//    frozen runner.
// ---------------------------------------------------------------------------

struct RadiusContext {
  double dummy = 0.0;
};

int32_t radiusScalar(void* /*context*/, double /*secondsFromEpoch*/, const double state[6],
                     double* value) {
  *value = std::sqrt(state[0] * state[0] + state[1] * state[1] + state[2] * state[2]);
  return 0;
}

int32_t declinationScalar(void* /*context*/, double /*secondsFromEpoch*/,
                          const double state[6], double* value) {
  const double planar = std::sqrt(state[0] * state[0] + state[1] * state[1]);
  *value = std::atan2(state[2], planar);
  return 0;
}

void checkStoppingConditions() {
  std::printf("\n-- stopping conditions on a named scalar (the sixth locator) --\n");
  const double mu = 3.986004418e14;
  orb::Keplerian elements;
  elements.semiMajorAxis = 7500000.0;
  elements.eccentricity = 0.05;
  elements.inclination = 51.6 * (ev::kPi / 180.0);
  elements.raan = 0.4;
  elements.argumentOfPeriapsis = 1.2;
  elements.trueAnomaly = 0.0;
  KeplerSource source = makeKeplerSource(elements, mu);
  const double period = 2.0 * ev::kPi / source.meanMotion;

  // Stop at a chosen RADIUS. The bar is the acceptance's altitude bar: the two
  // differ by a constant on a sphere, and this stop is stated on the quantity
  // the apsis locator already uses so the two cannot disagree.
  RadiusContext radiusContext;
  ev::StoppingContext stopping;
  stopping.scalar = radiusScalar;
  stopping.scalarContext = &radiusContext;
  stopping.goal = 7600000.0;

  ev::ScanRequest request;
  request.startSeconds = 0.0;
  request.stopSeconds = period;
  request.refinement.coarseStepSeconds = 60.0;
  request.refinement.toleranceSeconds = 1e-12;

  ev::Event event;
  const ev::Status status = ev::propagateToCondition(
      keplerStateSource, &source, ev::stoppingFunction, &stopping, request, &event);
  reportExact("the radius stop is reached", status == ev::Status::OK, "OK");
  if (status == ev::Status::OK) {
    const double radius = std::sqrt(event.state[0] * event.state[0] +
                                    event.state[1] * event.state[1] +
                                    event.state[2] * event.state[2]);
    report("the stop lands on the requested radius", std::fabs(radius - stopping.goal), 1e-6,
           "m");
  }

  // Stop at a chosen DECLINATION, the latitude stop of a non-rotating body.
  ev::StoppingContext latitude;
  latitude.scalar = declinationScalar;
  latitude.scalarContext = &radiusContext;
  latitude.goal = 0.5;
  ev::Event latitudeEvent;
  const ev::Status latitudeStatus = ev::propagateToCondition(
      keplerStateSource, &source, ev::stoppingFunction, &latitude, request, &latitudeEvent);
  reportExact("the declination stop is reached", latitudeStatus == ev::Status::OK, "OK");
  if (latitudeStatus == ev::Status::OK) {
    double value = 0.0;
    declinationScalar(nullptr, 0.0, latitudeEvent.state, &value);
    report("the stop lands on the requested declination", std::fabs(value - latitude.goal),
           1e-9, "rad");
  }

  // A goal the orbit never reaches is REPORTED, not silently returned as the
  // end of the span.
  ev::StoppingContext unreachable = stopping;
  unreachable.goal = 5.0e8;
  ev::Event never;
  reportExact("a condition that is never met says so",
              ev::propagateToCondition(keplerStateSource, &source, ev::stoppingFunction,
                                       &unreachable, request,
                                       &never) == ev::Status::CONDITION_NOT_MET,
              "CONDITION_NOT_MET");
}

// ---------------------------------------------------------------------------
// 9. Synchronized multi-spacecraft stop.
// ---------------------------------------------------------------------------

void checkFormation() {
  std::printf("\n-- synchronized formation stop --\n");
  const double mu = 3.986004418e14;
  orb::Keplerian first;
  first.semiMajorAxis = 7000000.0;
  first.eccentricity = 0.001;
  first.inclination = 0.9;
  first.raan = 0.0;
  first.argumentOfPeriapsis = 0.0;
  first.trueAnomaly = 0.0;
  orb::Keplerian second = first;
  second.semiMajorAxis = 7200000.0;
  second.trueAnomaly = 1.0;

  KeplerSource sourceA = makeKeplerSource(first, mu);
  KeplerSource sourceB = makeKeplerSource(second, mu);

  ev::NodeContext node;
  ev::FormationMember members[2];
  members[0].stateSource = keplerStateSource;
  members[0].stateContext = &sourceA;
  members[0].eventFunction = ev::nodeFunction;
  members[0].eventContext = &node;
  members[1].stateSource = keplerStateSource;
  members[1].stateContext = &sourceB;
  members[1].eventFunction = ev::nodeFunction;
  members[1].eventContext = &node;

  ev::FormationContext formation;
  formation.members = members;
  formation.memberCount = 2;

  ev::ScanRequest request;
  request.startSeconds = 1.0;
  request.stopSeconds = 6000.0;
  request.refinement.coarseStepSeconds = 30.0;
  request.refinement.toleranceSeconds = 1e-9;

  ev::Event stop;
  const ev::Status status = ev::propagateToCondition(
      keplerStateSource, &sourceA, ev::formationFunction, &formation, request, &stop);
  reportExact("the formation stops", status == ev::Status::OK, "OK");
  if (status != ev::Status::OK) return;

  // Whichever member governed, ITS event function must be zero at the stop
  // epoch, and every member's state must be available AT THAT ONE EPOCH.
  double governingState[6] = {0.0, 0.0, 0.0, 0.0, 0.0, 0.0};
  const ev::FormationMember& governing = members[formation.governingMember];
  reportExact("a governing member is named", formation.governingMember >= 0,
              formation.governingMember == 0 ? "member 0" : "member 1");
  keplerStateSource(governing.stateContext, stop.epochSeconds, governingState);
  double value = 0.0;
  ev::nodeFunction(&node, stop.epochSeconds, governingState, &value);
  const double radius = std::sqrt(governingState[0] * governingState[0] +
                                  governingState[1] * governingState[1] +
                                  governingState[2] * governingState[2]);
  report("the governing member is on its condition at the stop", std::fabs(value) / radius,
         1e-12, "rel");

  // The other member's condition must NOT be met earlier inside the span.
  const int32_t other = formation.governingMember == 0 ? 1 : 0;
  ev::ScanRequest otherRequest = request;
  otherRequest.stopSeconds = stop.epochSeconds;
  ev::Event earlier;
  const ev::Status otherStatus =
      ev::propagateToCondition(keplerStateSource, members[other].stateContext,
                               ev::nodeFunction, &node, otherRequest, &earlier);
  reportExact("no member met its condition before the formation stop",
              otherStatus == ev::Status::CONDITION_NOT_MET ||
                  earlier.epochSeconds >= stop.epochSeconds - 1e-6,
              "none earlier");
}

}  // namespace

int main() {
  std::printf("event locator conformance harness\n");
  checkRefinement();
  checkApsides();
  checkForwardBackward();
  checkEphemerisPort();
  checkEclipse();
  checkContact();
  checkIntrusion();
  checkStoppingConditions();
  checkFormation();
  std::printf("\n%d checks, %d failures\n", gChecks, gFailures);
  return gFailures == 0 ? 0 : 1;
}
