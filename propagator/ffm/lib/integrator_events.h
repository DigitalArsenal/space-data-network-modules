// The adaptive step loop of the one-step integrators with events located inside it.
//
// An event is a zero crossing of a continuous function g of the integrated state. After each
// accepted step the loop compares g at the two ends; a sign change is bracketed there and
// refined on the integrator's continuous extension by Brent's method (the same refiner the
// sampled-ephemeris locator uses, propagator/events/src/event_locator.hpp), then confirmed
// by re-stepping the integrator itself from the step's start to the candidate epoch and
// correcting it with Newton's method on those exact states. The epoch is therefore a root of
// g along the integrator's own solution: it does not depend on the step size, and it is as
// accurate as the integration.
//
// Every method here has a one-step map and so a re-step: the embedded pairs of lib/rk_engine.h,
// the Runge-Kutta-Nystrom pair, and the step kernels of RK4, Cash-Karp, Fehlberg 7(8) and
// Bulirsch-Stoer. The pairs with a published continuous extension use it; the others use the
// quintic Hermite polynomial through r, v and a at both ends.
#pragma once

#include "integrators.h"
#include "../../events/src/event_locator.hpp"

#include <functional>
#include <memory>
#include <vector>

namespace astro {
namespace Integrator {

enum class EventAction : uint8_t {
    Continue,  ///< located and counted
    Record,    ///< located, counted and reported
    Stop       ///< reported; the propagation ends at the qualifying occurrence
};

struct EventSpec {
    /// g(t, y): t in seconds of the run's clock, y = [r, v] in kilometers and kilometers per
    /// second. False: g is undefined at the state (the true anomaly of a circular orbit).
    std::function<bool(double t, const double* y, double* g)> g;
    sdn::events::Direction direction = sdn::events::Direction::ANY;
    EventAction action = EventAction::Record;
    double toleranceSeconds = 1e-9;
    uint32_t occurrence = 1;
    /// See sdn::events::crossing: positive for a function wrapped to a period.
    double jumpLimit = 0;
};

struct EventHit {
    uint32_t spec = 0;
    double t = 0;  ///< seconds from the start of the run
    double state[6] = {};
    sdn::events::Direction direction = sdn::events::Direction::ANY;  ///< of g in forward time
    double residual = 0;
    uint32_t iterations = 0;
};

/// What the runs of one request located. It spans the runs of one request (the space-weather
/// breaks split an arc), so the caller sizes `occurrences` once and sets `offset` before each run.
struct EventOutcome {
    std::vector<EventHit> hits;         ///< Record and Stop events, in order of propagation; t includes `offset`
    std::vector<uint32_t> occurrences;  ///< qualifying crossings passed, per spec
    int stoppedBy = -1;                 ///< spec that ended a run, or -1
    double offset = 0;                  ///< seconds from the request's start to the run's start
    /// The run's t = 0 on the force clock (two-part TT), set by PropagateWithEvents for the event
    /// functions that read the Sun.
    std::shared_ptr<timesys::Instant> epoch = std::make_shared<timesys::Instant>();
};

/// True for the methods PropagateEngine integrates: those with a one-step map.
bool engineSupports(IntegrationMethod method);

/// Integrate dt seconds (negative: backward) from `initial` under `f`. `boundaries` is the
/// shadow-edge step cut of lib/shadow_events.h (nullptr: none). `events` and `outcome` are
/// both given or both null. A STOP event ends the run at its epoch: totalTime is then the
/// epoch of the event and finalState its state.
PropagateResult PropagateEngine(const StateVector& initial, double dt, const IntegratorConfig& config,
                                const DerivativeFunc& f, void* context,
                                shadow::BoundaryEvents* boundaries,
                                const std::vector<EventSpec>* events, EventOutcome* outcome);

/// PropagateWithResult with events located inside the integration (both given or both null).
/// A method without a continuous extension refuses a request that names events.
PropagateResult PropagateWithEvents(const StateVector& initial, double dt, const IntegratorConfig& config,
                                    ForceModel::ForceModelSet& forces,
                                    const std::vector<EventSpec>* events, EventOutcome* outcome);

/// True when the force set's acceleration does not depend on velocity: the condition of the
/// Runge-Kutta-Nystrom pair.
bool VelocityIndependent(const ForceModel::ForceModelSet& forces);

}  // namespace Integrator
}  // namespace astro
