#include "hpop/resident_dynamics.h"
#include <algorithm>
#include <cmath>
#include <limits>

#if !defined(HPOP_MODULE_ID) || !defined(HPOP_MODULE_VERSION)
#error "HPOP_MODULE_ID and HPOP_MODULE_VERSION come from plugin-manifest.json; build with build.mjs"
#endif

namespace hpop {
using namespace astro;
using namespace dynamics;

namespace {

// A node of the dense output: an accepted state of the integration, with
// the acceleration the integrator evaluated there (its next first stage).
// t: seconds from the start of the node's span.
struct Node { double t; double y[6]; double a[3]; };

// The nodes of one smooth stretch of the integration: one span between
// space-weather restarts, cut again where a step ended on a shadow boundary
// (the radiation pressure's kink). The acceleration is smooth inside, so a
// stencil never reaches across a piece's ends.
struct Piece {
    TTEpoch spanStart;
    std::deque<Node> nodes;   // ascending in time
    bool open = true;
};

// Chebyshev series of one segment of TT, with the largest difference
// from the integrator's own accepted states inside it.
struct Segment {
    double c[6][CHEBY_NPTS];
    double positionM = 0, velocityMS = 0;
    uint32_t samples = 0;
};

// Segments of 300 s: a degree-12 series resolves about four cycles over its
// span, so 300 s resolves periods down to about 80 s, the period of a degree
// 70 term of the field in LEO (600 s, the gravity-only profile's span,
// leaves the terms above degree 35 to the fit's error: centimetres).
constexpr double kSegment = 300.0;
constexpr double kHalfSpan = kSegment / 2;

TTEpoch plus(const TTEpoch& at, double seconds) { return normalizeTT(at.whole, at.fraction + seconds); }

// Hermite interpolation of position from position, velocity and acceleration
// at m nodes (confluent divided differences in time scaled to the stencil):
// the polynomial of degree 3m - 1 and its derivative at t.
void hermite(const Node* nodes, int m, double t, double r[3], double v[3]) {
    const double t0 = nodes[0].t, scale = m > 1 ? nodes[m - 1].t - nodes[0].t : 1.0;
    const int n = 3 * m;
    double z[12];
    for (int i = 0; i < m; ++i) z[3 * i] = z[3 * i + 1] = z[3 * i + 2] = (nodes[i].t - t0) / scale;
    const double u = (t - t0) / scale;
    for (int c = 0; c < 3; ++c) {
        double d[12];
        for (int i = 0; i < m; ++i) d[3 * i] = d[3 * i + 1] = d[3 * i + 2] = nodes[i].y[c];
        for (int k = 1; k < n; ++k)
            for (int j = n - 1; j >= k; --j) {
                const int node = j / 3;
                if (z[j] == z[j - k])  // within one node's triple: k = 1 or 2
                    d[j] = k == 1 ? nodes[node].y[3 + c] * scale : 0.5 * nodes[node].a[c] * scale * scale;
                else
                    d[j] = (d[j] - d[j - 1]) / (z[j] - z[j - k]);
            }
        double p = d[n - 1], dp = 0;
        for (int j = n - 2; j >= 0; --j) { dp = dp * (u - z[j]) + p; p = p * (u - z[j]) + d[j]; }
        r[c] = p;
        v[c] = dp / scale;
    }
}

// The integration on one side of the object's epoch: forward (direction +1)
// or backward (-1), span by span between the space-weather restarts, as the
// execution path integrates toward a later or an earlier epoch. Its pieces
// and their nodes are kept in ascending time on both sides.
struct Branch {
    int direction = 1;
    StateVector spanState;
    TTEpoch spanStart, spanEnd;   // the span runs from spanStart toward spanEnd
    bool bounded = false;
    std::unique_ptr<Integrator::ForceRun> run;
    std::deque<Piece> pieces;
    // The piece the run is adding to: the last forward, the first backward.
    Piece& current() { return direction > 0 ? pieces.back() : pieces.front(); }
    void add(Piece piece) { if (direction > 0) pieces.push_back(std::move(piece)); else pieces.push_front(std::move(piece)); }
};

} // namespace

struct ResidentDynamics::Object {
    Execution execution;     // the template with this object's state and coefficients
    bool valid = true;
    Branch forward, backward;
    // Fitted segments, consecutive from grid index firstSegment; the grid is
    // kSegment s of TT from the object's epoch (TT labels are exact; a TDB
    // label would carry the TDB - TT model).
    std::deque<Segment> segments;
    long long firstSegment = 0;

    // The integration starts again from the object's epoch (the fitted
    // segments stay: they are a function of the object alone).
    void restart(Branch& b) {
        b.run.reset();
        b.pieces.clear();
        b.spanState = execution.initial;
        b.spanStart = execution.initialTT;
    }
    void restart() { forward.direction = 1; backward.direction = -1; restart(forward); restart(backward); }
    Branch& branch(const TTEpoch& at) { return elapsedSeconds(execution.initialTT, at) < 0 ? backward : forward; }
    const Branch& branch(const TTEpoch& at) const { return elapsedSeconds(execution.initialTT, at) < 0 ? backward : forward; }
    TTEpoch segmentStart(long long k) const { return normalizeTT(execution.initialTT.whole + double(k) * kSegment, execution.initialTT.fraction); }
};

namespace {
using Object = ResidentDynamics::Object;

// The next space-weather restart in the branch's direction from `from`;
// false when the configuration has none.
bool nextBreak(const Execution& e, int direction, const TTEpoch& from, TTEpoch& out) {
    const double hours = 6 * 3600.0;
    const auto breaks = direction > 0 ? driverBreaks(e, from, plus(from, hours)) : driverBreaks(e, plus(from, -hours), from);
    if (breaks.empty()) return false;
    out = direction > 0 ? breaks.front() : breaks.back();
    return true;
}

void record(Branch& b, Integrator::RKF78Run& run) {
    Node n;
    n.t = run.time();
    for (int i = 0; i < 6; ++i) n.y[i] = run.state()[i];
    const auto& f = run.derivative();
    for (int i = 0; i < 3; ++i) n.a[i] = f[3 + i];
    auto& nodes = b.current().nodes;
    if (b.direction > 0) nodes.push_back(n); else nodes.push_front(n);
}

// Starts the span at (spanState, spanStart): to the next restart, or open.
bool startSpan(Execution& e, Branch& b, const Environment& environment, std::string& error) {
    b.bounded = environment.weather && nextBreak(e, b.direction, b.spanStart, b.spanEnd);
    const double here = b.spanState.epoch;
    const double there = b.bounded ? timesys::ttToTdb(b.spanEnd.jdTt()) : here + b.direction;
    if (!environmentCovers(e, environment, std::min(here, there), std::max(here, there), error) || !preflightKernel(e, there, error)) return false;
    if (b.bounded) setDriverSpan(e, b.spanStart, b.spanEnd);
    if (e.forces.explicitEpochContract) e.forces.integrationEpochTDB = b.spanState.epoch;
    b.run = std::make_unique<Integrator::ForceRun>(b.spanState, b.direction, e.integrator, e.forces, true);
    Piece piece;
    piece.spanStart = b.spanStart;
    b.add(std::move(piece));
    record(b, b.run->run());   // the span's first node: its state, with the span's drivers
    return true;
}

// One accepted step of a branch (or the end of its span and the start of the
// next).
bool step(Execution& e, Branch& b, const Environment& environment, std::string& error) {
    if (!b.run && !startSpan(e, b, environment, error)) return false;
    auto& run = b.run->run();
    const double target = b.bounded ? elapsedSeconds(b.spanStart, b.spanEnd) : b.direction * std::numeric_limits<double>::infinity();
    if (!run.running(target)) {
        if (!b.bounded || std::abs(run.time() - target) > 32 * std::numeric_limits<double>::epsilon() * std::max(1.0, std::abs(target)))
            return prwError(error, "propagation-failed: The integrator stopped short of the next span (MAXIMUM_STEPS).");
        // The span ends on the restart: its last node keeps the acceleration
        // of the drivers it was integrated with; the next span starts from
        // the same state, as the execution path restarts.
        b.current().open = false;
        const auto& y = run.state();
        b.spanState.position = Vec3(y[0], y[1], y[2]);
        b.spanState.velocity = Vec3(y[3], y[4], y[5]);
        b.spanState.epoch = timesys::ttToTdb(b.spanEnd.jdTt());
        b.spanStart = b.spanEnd;
        b.run.reset();   // the next span starts when it is needed
        return true;
    }
    // Another object's steps may have moved the shared driver span.
    if (b.bounded) setDriverSpan(e, b.spanStart, b.spanEnd);
    while (!run.attempt(target))
        if (!run.running(target)) return true;  // ended by the step limits: reported on the next call
    record(b, run);
    if (run.endedOnBoundary()) {
        // A kink lies within the events' tolerance of this node: it closes
        // the piece and opens the next one.
        b.current().open = false;
        Piece piece;
        piece.spanStart = b.spanStart;
        piece.nodes.push_back(b.direction > 0 ? b.current().nodes.back() : b.current().nodes.front());
        b.add(std::move(piece));
    }
    return true;
}

// Epochs this close are the same instant (two-part seconds rounded in their
// fractions).
constexpr double kSameInstant = 1e-9;

// The piece holding `at`, or nullptr when `at` lies outside the kept nodes.
const Piece* pieceAt(const Branch& b, const TTEpoch& at) {
    for (auto p = b.pieces.rbegin(); p != b.pieces.rend(); ++p)
        if (!p->nodes.empty() && elapsedSeconds(p->spanStart, at) >= p->nodes.front().t - kSameInstant) {
            if (elapsedSeconds(p->spanStart, at) > p->nodes.back().t + kSameInstant) return nullptr;
            return &*p;
        }
    return nullptr;
}

// The stencil of the step [t_n, t_n+1]: the step's nodes and, on each side,
// the nearest node at least half the step's length away. A closer neighbour
// would amplify the nodes' local integration errors (the interpolation's
// Lebesgue constant grows from 1.4 to 34 as that gap shrinks from one step to
// a quarter of one); a farther one only widens the stencil.
int leftNeighbor(const std::deque<Node>& nodes, int n) {
    const double half = 0.5 * (nodes[n + 1].t - nodes[n].t);
    for (int j = n - 1; j >= 0; --j) if (nodes[n].t - nodes[j].t >= half) return j;
    return -1;
}
int rightNeighbor(const std::deque<Node>& nodes, int n) {
    const double half = 0.5 * (nodes[n + 1].t - nodes[n].t);
    for (int j = n + 2; j < int(nodes.size()); ++j) if (nodes[j].t - nodes[n + 1].t >= half) return j;
    return -1;
}
// The index n of the step [t_n, t_n+1] holding t (clamped to the nodes).
int bracket(const std::deque<Node>& nodes, double t) {
    const int n = int(std::upper_bound(nodes.begin(), nodes.end(), t, [](double x, const Node& node) { return x < node.t; }) - nodes.begin()) - 1;
    return std::max(0, std::min(n, int(nodes.size()) - 2));
}

// The branch's dense output reaches `at` with whole stencils: the piece
// holding it is closed, or the run has gone past it far enough for the
// neighbour on its side.
bool reaches(const Branch& b, const TTEpoch& at) {
    if (b.pieces.empty()) return false;
    const Piece* p = nullptr;
    for (const auto& piece : b.pieces)
        if (!piece.nodes.empty() && elapsedSeconds(piece.spanStart, at) >= piece.nodes.front().t - kSameInstant &&
            elapsedSeconds(piece.spanStart, at) <= piece.nodes.back().t + kSameInstant) { p = &piece; if (!piece.open) return true; }
    if (!p || p->nodes.size() < 2) return false;
    const double t = elapsedSeconds(p->spanStart, at);
    const int n = bracket(p->nodes, t);
    return b.direction > 0 ? rightNeighbor(p->nodes, n) >= 0 : leftNeighbor(p->nodes, n) >= 0;
}

// `at` lies on the branch's side beyond the far end of its kept nodes... or
// behind their near end: then the branch starts over from the epoch.
bool behind(const Branch& b, const TTEpoch& at) {
    if (b.pieces.empty()) return false;
    if (b.direction > 0) {
        const Piece& first = b.pieces.front();
        return first.nodes.empty() || elapsedSeconds(first.spanStart, at) < first.nodes.front().t - kSameInstant;
    }
    const Piece& last = b.pieces.back();
    return last.nodes.empty() || elapsedSeconds(last.spanStart, at) > last.nodes.back().t + kSameInstant;
}

// Integrates until the dense output reaches `at`, from the object's epoch
// again when `at` lies behind what is kept.
bool reach(Object& o, const Environment& environment, const TTEpoch& at, std::string& error) {
    Branch& b = o.branch(at);
    if (behind(b, at)) o.restart(b);
    while (!reaches(b, at))
        if (!step(o.execution, b, environment, error)) return false;
    return true;
}

// Position (km) and velocity (km/s) at `at` from the dense output.
void evaluate(const Object& o, const TTEpoch& at, double r[3], double v[3]) {
    const Branch& b = o.branch(at);
    const Piece* found = nullptr;
    for (auto p = b.pieces.rbegin(); p != b.pieces.rend() && !found; ++p)
        if (!p->nodes.empty() && elapsedSeconds(p->spanStart, at) >= p->nodes.front().t - kSameInstant) found = &*p;
    const Piece& p = *found;   // reach() kept it
    const double t = elapsedSeconds(p.spanStart, at);
    const auto& nodes = p.nodes;
    if (nodes.size() == 1) {
        for (int i = 0; i < 3; ++i) { r[i] = nodes[0].y[i]; v[i] = nodes[0].y[3 + i]; }
        return;
    }
    const int n = bracket(nodes, t), left = leftNeighbor(nodes, n), right = rightNeighbor(nodes, n);
    Node stencil[4];
    int m = 0;
    if (left >= 0) stencil[m++] = nodes[left];
    stencil[m++] = nodes[n];
    stencil[m++] = nodes[n + 1];
    if (right >= 0) stencil[m++] = nodes[right];
    hermite(stencil, m, t, r, v);
}

// Drops forward nodes the segments from grid index `next` on no longer need.
void trim(Object& o, long long next) {
    Branch& b = o.forward;
    const TTEpoch keep = o.segmentStart(next);
    if (b.pieces.empty() || elapsedSeconds(o.execution.initialTT, keep) <= 0) return;
    while (b.pieces.size() > 1 && !b.pieces.front().open && elapsedSeconds(b.pieces.front().spanStart, keep) > b.pieces.front().nodes.back().t)
        b.pieces.pop_front();
    auto& nodes = b.pieces.front().nodes;
    const double t = elapsedSeconds(b.pieces.front().spanStart, keep);
    const auto at = std::lower_bound(nodes.begin(), nodes.end(), t, [](const Node& n, double x) { return n.t < x; });
    const long long drop = (at - nodes.begin()) - 3;
    if (drop > 0) nodes.erase(nodes.begin(), nodes.begin() + drop);
}

// Fits grid segment k from the dense output and scores it against the
// integrator's accepted states inside it.
bool fit(Object& o, const Environment& environment, long long k, Segment& out, std::string& error) {
    const TTEpoch start = o.segmentStart(k), mid = plus(start, kHalfSpan), end = plus(start, kSegment);
    // A segment lies on one side of the epoch: reach its near end, then its far end.
    const bool forward = k >= 0;
    if (!reach(o, environment, forward ? start : end, error) || !reach(o, environment, forward ? end : start, error)) return false;
    double values[6][CHEBY_NPTS];
    for (int j = 0; j <= CHEBY_N; ++j) {
        double r[3], v[3];
        evaluate(o, plus(start, kHalfSpan * (1 + std::cos(j * M_PI / CHEBY_N))), r, v);
        for (int i = 0; i < 3; ++i) { values[i][j] = r[i]; values[3 + i][j] = v[i]; }
    }
    for (int i = 0; i < 6; ++i) chebyshevFit(values[i], out.c[i]);
    out.positionM = out.velocityMS = 0;
    out.samples = 0;
    for (const Branch* b : {&o.backward, &o.forward})
    for (const auto& piece : b->pieces)
        for (const auto& node : piece.nodes) {
            const double tau = elapsedSeconds(mid, plus(piece.spanStart, node.t)) / kHalfSpan;
            if (tau < -1 || tau > 1) continue;
            double dr = 0, dv = 0;
            for (int i = 0; i < 3; ++i) {
                dr += std::pow(chebyshevEval(out.c[i], tau) - node.y[i], 2);
                dv += std::pow(chebyshevEval(out.c[3 + i], tau) - node.y[3 + i], 2);
            }
            out.positionM = std::max(out.positionM, std::sqrt(dr) * 1000);
            out.velocityMS = std::max(out.velocityMS, std::sqrt(dv) * 1000);
            ++out.samples;
        }
    for (const double* c : {out.c[0], out.c[1], out.c[2], out.c[3], out.c[4], out.c[5]})
        for (int j = 0; j < CHEBY_NPTS; ++j)
            if (!std::isfinite(c[j])) return prwError(error, "propagation-failed: Trajectory fitting produced non-finite coefficients.");
    return true;
}

// Grid indices of the segments covering [start, end].
void segmentRange(const Object& o, const TTEpoch& start, const TTEpoch& end, long long& first, long long& last) {
    const double a = elapsedSeconds(o.execution.initialTT, start) / kSegment;
    const double b = elapsedSeconds(o.execution.initialTT, end) / kSegment;
    first = static_cast<long long>(std::floor(a));
    last = std::max(first, static_cast<long long>(std::ceil(b)) - 1);
}

std::unique_ptr<PRWFitQualityT> sampledResidual(double positionM, double velocityMS) {
    auto q = std::make_unique<PRWFitQualityT>();
    q->EVIDENCE_KIND = prwQualityEvidence::SAMPLED_RESIDUAL;
    q->HAS_MAXIMUM_POSITION_ERROR_M = true;
    q->MAXIMUM_POSITION_ERROR_M = positionM;
    q->HAS_MAXIMUM_VELOCITY_ERROR_M_S = true;
    q->MAXIMUM_VELOCITY_ERROR_M_S = velocityMS;
    q->METHOD = "Degree-12 Chebyshev series at the Gauss-Lobatto nodes of 300 s TT segments, from the integrator's dense output "
                "(Hermite interpolation of position, velocity and acceleration at four accepted steps); the largest difference "
                "from the integrator's accepted states inside the segments.";
    return q;
}

} // namespace

std::string ResidentDynamics::sourceName() { return std::string(HPOP_MODULE_ID) + "@" + HPOP_MODULE_VERSION; }

ResidentDynamics::~ResidentDynamics() = default;

std::unique_ptr<ResidentDynamics> ResidentDynamics::configure(const Inputs& in, KernelStore& kernels, std::string& error) {
    std::unique_ptr<ResidentDynamics> d(new ResidentDynamics);
    const PRW* root = nullptr;
    if (!verifyPrw(in.configuration, in.configurationSize, root, error)) return nullptr;
    const auto* request = root->EXECUTION_REQUEST();
    if (!request) { prwError(error, "invalid-prw-arm: configuration requires EXECUTION_REQUEST."); return nullptr; }
    // The template's own state is a placeholder each object replaces: it
    // carries no object data, and nothing the resident profile cannot carry.
    const auto* initial = request->INITIAL();
    if (request->INCLUDE_STM() || request->INITIAL_COVARIANCE() || request->INITIAL_MASS_COVARIANCE() ||
        (request->SAMPLE_EPOCHS() && request->SAMPLE_EPOCHS()->size()) || (request->IMPULSES() && request->IMPULSES()->size()) ||
        (request->FINITE_BURNS() && request->FINITE_BURNS()->size()) || request->INCLUDE_MASS_DYNAMICS() ||
        (request->DYNAMIC_PARAMETERS() && request->DYNAMIC_PARAMETERS()->size()) || request->PROCESS_NOISE()) {
        prwError(error, "unsupported-configuration: A resident configuration is the dynamics only: no STM, covariance, samples, impulses, burns, mass dynamics, dynamic parameters or process noise.");
        return nullptr;
    }
    if (!initial || initial->COVARIANCE() || initial->HAS_MASS_KG() || initial->MASS_KG() != 0) {
        prwError(error, "unsupported-configuration: The configuration's INITIAL is a placeholder: no covariance or mass; each resident state supplies its own.");
        return nullptr;
    }
    if (in.kernelSize) {
        d->kernel_ = kernels.accept(in.kernel, in.kernelSize, true, error);
        if (!d->kernel_) return nullptr;
    }
    if (!KernelStore::activate(d->kernel_, error)) return nullptr;
    if (!loadEnvironment(in.environment, true, d->environment_, error)) return nullptr;
    coords::Frame axes = coords::Frame::GCRF;
    StateVector probe;
    if (!decodeResidentState(initial, probe, error, &axes)) return nullptr;
    if (axes != coords::Frame::GCRF) { prwError(error, "unsupported-frame: A resident configuration uses Earth-centered ICRF axes (GCRF)."); return nullptr; }
    if (!parseExecution(request, d->environment_.earth != nullptr, d->template_, error)) return nullptr;
    const auto method = d->template_.integrator.method;
    if (method != IntegrationMethod::RK78 && method != IntegrationMethod::RKF78) {
        prwError(error, "unsupported-integrator: Resident trajectories integrate with RK78 or RKF78 (dense output from their accepted steps).");
        return nullptr;
    }
    d->requestWeather_ = request->FORCES()->WEATHER() != nullptr;
    if (!attachEnvironment(d->template_, d->environment_, d->requestWeather_, error)) return nullptr;
    d->gravitationalParameter_ = request->FORCES()->GRAVITATIONAL_PARAMETER();
    d->cannonball_ = request->FORCES()->RADIATION_PRESSURE_MODEL() == prwRadiationPressureFamily::CANNONBALL;
    return d;
}

bool ResidentDynamics::activate(std::string& error) { return KernelStore::activate(kernel_, error); }

bool ResidentDynamics::add(const PRWResidentState* record, std::string& error) {
    auto o = std::make_unique<Object>();
    o->execution = template_;
    auto& e = o->execution;
    o->valid = record->VALID();
    if (!decodeResidentState(record, e.initial, error) || !decodeStateEpochTT(record, e.initialTT, error)) return false;
    e.target = e.initial.epoch;
    e.targetTT = e.initialTT;
    if (record->STATE()->GRAVITATIONAL_PARAMETER() != 0 && record->STATE()->GRAVITATIONAL_PARAMETER() != gravitationalParameter_)
        return prwError(error, "invalid-forces: FRM and configured gravitational parameters disagree.");
    // Coefficients, as the execution request reads its INITIAL's mass and
    // its spacecraft: Cd*A/m and Cr*A/m ride on Cd and Cr over unit area per
    // unit of mass.
    auto& f = e.forces;
    if (!record->HAS_MASS_KG() && record->MASS_KG() != 0) return prwError(error, "invalid-presence: MASS_KG requires HAS_MASS_KG.");
    if (!record->HAS_DRAG_AREA_OVER_MASS_M2_KG() && record->DRAG_AREA_OVER_MASS_M2_KG() != 0)
        return prwError(error, "invalid-presence: DRAG_AREA_OVER_MASS_M2_KG requires HAS_DRAG_AREA_OVER_MASS_M2_KG.");
    if (!record->HAS_SRP_AREA_OVER_MASS_M2_KG() && record->SRP_AREA_OVER_MASS_M2_KG() != 0)
        return prwError(error, "invalid-presence: SRP_AREA_OVER_MASS_M2_KG requires HAS_SRP_AREA_OVER_MASS_M2_KG.");
    if (record->HAS_DRAG_AREA_OVER_MASS_RATE_M2_KG_S() || record->DRAG_AREA_OVER_MASS_RATE_M2_KG_S() != 0 ||
        record->HAS_IN_TRACK_ACCELERATION_M_S2() || record->IN_TRACK_ACCELERATION_M_S2() != 0)
        return prwError(error, "unsupported-configuration: Resident states carry mass, Cd*A/m and Cr*A/m; a Cd*A/m rate or in-track acceleration belongs to an execution request.");
    if (record->HAS_MASS_KG()) {
        if (!positive(record->MASS_KG())) return prwError(error, "invalid-state: Dynamical mass must be positive and finite.");
        f.drag.mass = f.srp.mass = record->MASS_KG();
    }
    if (record->HAS_DRAG_AREA_OVER_MASS_M2_KG()) {
        if (!f.useDrag) return prwError(error, "unsupported-configuration: DRAG_AREA_OVER_MASS_M2_KG needs drag in the configuration.");
        if (!nonnegative(record->DRAG_AREA_OVER_MASS_M2_KG())) return prwError(error, "invalid-state: Cd*A/m must be finite and non-negative.");
        f.drag.Cd = record->DRAG_AREA_OVER_MASS_M2_KG();
        f.drag.area = f.drag.mass;
    }
    if (record->HAS_SRP_AREA_OVER_MASS_M2_KG()) {
        if (!f.useSRP || !cannonball_) return prwError(error, "unsupported-configuration: SRP_AREA_OVER_MASS_M2_KG needs cannonball radiation pressure in the configuration.");
        if (!nonnegative(record->SRP_AREA_OVER_MASS_M2_KG())) return prwError(error, "invalid-state: Cr*A/m must be finite and non-negative.");
        f.srp.Cr = record->SRP_AREA_OVER_MASS_M2_KG();
        f.srp.area = f.srp.mass;
    }
    // The force set's epoch-dependent fields, as parseForces sets them for
    // an execution request starting at this state.
    f.integrationEpochTDB = e.initial.epoch;
    f.dragRateEpochTdb = e.initial.epoch;
    if (!requestWeather_) f.weather.epoch = timesys::taiToUtc(timesys::ttToTai(timesys::tdbToTt(e.initial.epoch)));
    // Each object reads the environment through its own driver span.
    if (!attachEnvironment(e, environment_, requestWeather_, error)) return false;
    o->restart();
    objects_.push_back(std::move(o));
    return true;
}

bool ResidentDynamics::state(size_t i, const TTEpoch& at, StateVector& out, std::string& error) {
    Object& o = *objects_.at(i);
    if (elapsedSeconds(o.execution.initialTT, at) == 0) { out = o.execution.initial; return true; }
    if (!reach(o, environment_, at, error)) return false;
    double r[3], v[3];
    evaluate(o, at, r, v);
    out.position = Vec3(r[0], r[1], r[2]);
    out.velocity = Vec3(v[0], v[1], v[2]);
    out.epoch = timesys::ttToTdb(at.jdTt());
    return true;
}

bool ResidentDynamics::covariance(size_t i, const TTEpoch& at, const Mat6& p0, const Integrator::ProcessNoise& noise,
                                  StateVector& state, Mat6& p, std::string& error) {
    const Object& o = *objects_.at(i);
    Execution e = o.execution;
    if (!attachEnvironment(e, environment_, requestWeather_, error)) return false;
    e.covariance = true;
    e.variational = true;
    e.stateOnly = false;
    e.p = p0;
    e.noise = noise;
    e.targetTT = at;
    e.target = timesys::ttToTdb(at.jdTt());
    if (!environmentCovers(e, environment_, std::min(e.initial.epoch, e.target), std::max(e.initial.epoch, e.target), error) ||
        !preflightKernel(e, e.target, error)) return false;
    if (environment_.weather) e.breaks = driverBreaks(e);
    Cursor c;
    c.state = e.initial;
    c.tt = e.initialTT;
    c.phi.assign(36, 0.0);
    for (int k = 0; k < 6; ++k) c.phi[k * 6 + k] = 1;
    c.p.assign(&p0.m[0][0], &p0.m[0][0] + 36);
    if (!advance(e, c, at, error)) return false;
    state = c.state;
    std::copy(c.p.begin(), c.p.end(), &p.m[0][0]);
    return true;
}

bool ResidentDynamics::prepare(size_t i, const TTEpoch& start, const TTEpoch& end, std::string& error) {
    Object& o = *objects_.at(i);
    long long first, last;
    segmentRange(o, start, end, first, last);
    // Kept segments before this window go; an earlier window starts over.
    if (!o.segments.empty() && first < o.firstSegment) o.segments.clear();
    while (!o.segments.empty() && o.firstSegment < first) { o.segments.pop_front(); ++o.firstSegment; }
    if (o.segments.empty()) o.firstSegment = first;
    for (long long k = o.firstSegment + static_cast<long long>(o.segments.size()); k <= last; ++k) {
        Segment segment;
        if (!fit(o, environment_, k, segment, error)) return false;
        o.segments.push_back(segment);
        trim(o, k + 1);
    }
    return true;
}

bool ResidentDynamics::residuals(size_t i, const TTEpoch& start, const TTEpoch& end, double& positionM, double& velocityMS, std::string& error) {
    const Object& o = *objects_.at(i);
    long long first, last;
    segmentRange(o, start, end, first, last);
    if (first < o.firstSegment || last >= o.firstSegment + static_cast<long long>(o.segments.size()))
        return prwError(error, "coverage-incomplete: Prepared trajectory coverage is unavailable.");
    for (long long k = first; k <= last; ++k) {
        const auto& s = o.segments[static_cast<size_t>(k - o.firstSegment)];
        positionM = std::max(positionM, s.positionM);
        velocityMS = std::max(velocityMS, s.velocityMS);
    }
    return true;
}

bool ResidentDynamics::describe(size_t i, const TTEpoch& start, const TTEpoch& end, PPET& ppe,
                                std::vector<std::unique_ptr<PRWFitQualityT>>& quality, std::string& error) {
    Object& o = *objects_.at(i);
    long long first, last;
    segmentRange(o, start, end, first, last);
    // Segments a later window dropped are fitted again from the object's epoch.
    if (first < o.firstSegment || last >= o.firstSegment + static_cast<long long>(o.segments.size()))
        if (!prepare(i, start, end, error)) return false;
    for (long long k = first; k <= last; ++k) {
        const auto& s = o.segments[static_cast<size_t>(k - o.firstSegment)];
        auto record = std::make_unique<PPEPositionRecordT>();
        record->EPOCH_MID = formatIsoSeconds(plus(o.segmentStart(k), kHalfSpan));
        record->EPOCH_HALF_SPAN = kHalfSpan;
        record->NUM_COEFFICIENTS = CHEBY_NPTS;
        record->HAS_VELOCITY_COEFFICIENTS = true;
        record->POS_COEFF_X.assign(s.c[0], s.c[0] + CHEBY_NPTS);
        record->POS_COEFF_Y.assign(s.c[1], s.c[1] + CHEBY_NPTS);
        record->POS_COEFF_Z.assign(s.c[2], s.c[2] + CHEBY_NPTS);
        record->VEL_COEFF_X.assign(s.c[3], s.c[3] + CHEBY_NPTS);
        record->VEL_COEFF_Y.assign(s.c[4], s.c[4] + CHEBY_NPTS);
        record->VEL_COEFF_Z.assign(s.c[5], s.c[5] + CHEBY_NPTS);
        ppe.POSITION_RECORDS.push_back(std::move(record));
        quality.push_back(sampledResidual(s.positionM, s.velocityMS));
    }
    ppe.TIME_SYSTEM = timingStandard::TT;
    ppe.START_TIME = formatIsoSeconds(o.segmentStart(first));
    ppe.STOP_TIME = formatIsoSeconds(o.segmentStart(last + 1));
    ppe.EPHEMERIS_SOURCE = sourceName();
    ppe.NOMINAL_SEGMENT_SPAN = kSegment;
    ppe.NOMINAL_NUM_COEFFICIENTS = CHEBY_NPTS;
    ppe.COMMENT.push_back("Full-force HPOP: the configured execution request's dynamics integrated forward from the state's epoch; "
                          "segments fitted from the integration's dense output. PRW.SEGMENT_QUALITY gives each segment's largest "
                          "difference from the integrator's accepted states inside it (SAMPLED_RESIDUAL).");
    return true;
}

std::unique_ptr<PRWFitQualityT> ResidentDynamics::quality(double positionM, double velocityMS) { return sampledResidual(positionM, velocityMS); }

} // namespace hpop
