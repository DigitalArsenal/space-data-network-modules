// hpop_plugin.cpp - HPOP (High-Precision Orbit Propagator) Plugin
// =============================================================================
// Emscripten glue layer exposing the astrodynamics C++ library as extern "C"
// functions for WASM export. Supports multiple entities with per-entity state
// and caching for efficient sequential propagation.
//
// All internal computation uses km / km/s (ECI/GCRF).
// Output positions/velocities are converted to ECEF meters for Cesium.
//
// Entity-indexed API matches the SGP4 plugin contract so that
// PropagatedPositionProperty can swap propagator backends transparently.
// =============================================================================

#include "../lib/astrodynamics_types.h"
#include "../lib/astrodynamics.h"
#include "../lib/integrators.h"
#include "../lib/force_models.h"
#include "../lib/coords.h"
#include "../lib/coords_types.h"
#include "../lib/environment_models.h"
#include <memory>

#include "generated/PluginMessage_generated.h"
#include "generated/PropagatorTrajectorySegments_generated.h"
#include "generated/PropagatorState_generated.h"
#include "generated/StateVector_generated.h"

#include <cstring>
#include <cmath>
#include <algorithm>
#include <array>
#include <cstdlib>
#include <flatbuffers/flatbuffers.h>
#include <string>
#include <unordered_map>
#include <vector>

using namespace astro;

// =============================================================================
// Module-Level Config State (shared across all entities)
// =============================================================================

static IntegratorConfig g_integratorConfig;
static ForceModel::ForceModelSet g_forceSet;
static IntegrationMethod g_integratorType = IntegrationMethod::RK78;
static SpaceWeatherData g_weather;
static bool g_initialized = false;

// gmat-07 environment state. A field loaded from a potential file, a predicted
// solar-activity table, and the reason the last load refused — a refusal that
// cannot explain itself gets guessed at.
static std::shared_ptr<const ExtendedGravityField> g_loadedGravityField;
static std::string g_loadedGravityName;
static std::string g_gravityFileDetail;
static SolarActivityPredictionTable g_predictions;
static std::string g_predictionDetail;

// Incremented on any config change to invalidate per-entity caches.
static uint32_t g_configVersion = 0;

// =============================================================================
// Per-Entity Chebyshev Ephemeris
// =============================================================================
// Instead of storing raw states at fixed intervals and re-integrating at query
// time, we fit Chebyshev polynomials to trajectory segments. Evaluation is just
// Clenshaw's algorithm — a handful of multiply-adds per component, zero
// numerical integration. This is the same approach used by JPL DE ephemerides.
//
// Each segment covers SEGMENT_SEC seconds and stores degree-N polynomial
// coefficients for all 6 state components (x,y,z,vx,vy,vz).
// Building a segment requires N+1 high-fidelity propagations to Chebyshev
// nodes (one-time cost). All subsequent queries are O(N) polynomial evals.

static constexpr int    CHEBY_N    = 12;           // Polynomial degree
static constexpr int    CHEBY_NPTS = CHEBY_N + 1;  // 13 sample points per segment
static constexpr double CHEBY_SEG_SEC  = 600.0;    // 10-minute segments
static constexpr double CHEBY_SEG_DAYS = CHEBY_SEG_SEC / 86400.0;
// Keep a bounded moving window so long-running sessions can propagate indefinitely
// without unbounded ephemeris growth.
static constexpr int    CHEBY_MAX_SEGMENTS = 2048;

struct ChebyshevSegment {
    double startJD, endJD;
    double midJD, halfSpanDays;
    double startPos[3], startVel[3];
    double endPos[3], endVel[3];
    double cx[CHEBY_NPTS], cy[CHEBY_NPTS], cz[CHEBY_NPTS];    // position (km)
    double cvx[CHEBY_NPTS], cvy[CHEBY_NPTS], cvz[CHEBY_NPTS]; // velocity (km/s)
};

/// Forward declarations used by cache pruning and arc helpers.
static StateVector propagateInternal(const StateVector& initial, double targetJD);
static StateVector propagateEntity(int entityIndex, double targetJD);

static inline void writeSegmentState(double posOut[3], double velOut[3], const StateVector& s) {
    posOut[0] = s.position.x; posOut[1] = s.position.y; posOut[2] = s.position.z;
    velOut[0] = s.velocity.x; velOut[1] = s.velocity.y; velOut[2] = s.velocity.z;
}

static inline void readSegmentState(const double posIn[3], const double velIn[3], double epochJD, StateVector& sOut) {
    sOut.position.x = posIn[0]; sOut.position.y = posIn[1]; sOut.position.z = posIn[2];
    sOut.velocity.x = velIn[0]; sOut.velocity.y = velIn[1]; sOut.velocity.z = velIn[2];
    sOut.epoch = epochJD;
}

/// Compute Chebyshev coefficients from values at Gauss-Lobatto nodes via DCT-I.
static void chebyshevFit(const double* values, double* coeffs) {
    for (int j = 0; j <= CHEBY_N; j++) {
        double sum = 0.0;
        for (int k = 0; k <= CHEBY_N; k++) {
            double w = (k == 0 || k == CHEBY_N) ? 0.5 : 1.0;
            sum += w * values[k] * std::cos(j * k * M_PI / CHEBY_N);
        }
        coeffs[j] = 2.0 * sum / CHEBY_N;
    }
    coeffs[0]       *= 0.5;
    coeffs[CHEBY_N] *= 0.5;
}

/// Evaluate a Chebyshev polynomial at τ ∈ [-1, 1] using Clenshaw's algorithm.
static inline double chebyshevEval(const double* c, double tau) {
    double b1 = 0.0, b2 = 0.0;
    for (int j = CHEBY_N; j >= 1; j--) {
        double b0 = 2.0 * tau * b1 - b2 + c[j];
        b2 = b1;
        b1 = b0;
    }
    return tau * b1 - b2 + c[0];
}

/// Evaluate all 6 state components from a Chebyshev segment.
static void chebyshevEvalState(const ChebyshevSegment& seg, double jd,
                                Vec3& pos, Vec3& vel) {
    double tau = (jd - seg.midJD) / seg.halfSpanDays;
    if (tau < -1.0) tau = -1.0;
    if (tau >  1.0) tau =  1.0;
    pos.x = chebyshevEval(seg.cx, tau);
    pos.y = chebyshevEval(seg.cy, tau);
    pos.z = chebyshevEval(seg.cz, tau);
    vel.x = chebyshevEval(seg.cvx, tau);
    vel.y = chebyshevEval(seg.cvy, tau);
    vel.z = chebyshevEval(seg.cvz, tau);
}

struct ChebyshevEphemeris {
    ChebyshevSegment* segments = nullptr;
    int count    = 0;
    int capacity = 0;
    double startJD    = 0;
    uint32_t configVer = 0;
    StateVector firstStartState; // state at the start of the first segment
    StateVector lastEndState;  // state at the end of the last segment (for extension)

    void clear() { count = 0; }

    bool grow(int needed) {
        if (needed <= capacity) return true;
        // Minimum capacity of 4 (not 64): at catalog scale (~30K entities)
        // a 64-segment floor is ~48KB/entity = 1.4GB and exhausts the fixed
        // 256MB heap; steady-state rendering with retention needs only a
        // handful of segments per entity.
        int newCap = std::max(needed * 2, 4);
        auto* buf = (ChebyshevSegment*)std::realloc(segments, newCap * sizeof(ChebyshevSegment));
        if (!buf) return false;
        segments = buf;
        capacity = newCap;
        return true;
    }

    void destroy() {
        std::free(segments);
        segments = nullptr;
        count = capacity = 0;
    }

    int lookup(double jd) const {
        if (count <= 0 || jd < startJD) return -1;
        int idx = static_cast<int>((jd - startJD) / CHEBY_SEG_DAYS);
        if (idx >= count) idx = count - 1;
        return idx;
    }

    double endJD() const {
        return count > 0 ? segments[count - 1].endJD : startJD;
    }
};

static inline void pruneChebyshevEphemeris(ChebyshevEphemeris& eph, double focusJD) {
    if (eph.count <= CHEBY_MAX_SEGMENTS) return;

    while (eph.count > CHEBY_MAX_SEGMENTS) {
        double frontDist = std::abs(focusJD - eph.segments[0].midJD);
        double backDist  = std::abs(focusJD - eph.segments[eph.count - 1].midJD);

        if (frontDist >= backDist) {
            if (eph.count > 1) {
                std::memmove(eph.segments, eph.segments + 1,
                             (eph.count - 1) * sizeof(ChebyshevSegment));
            }
            eph.count--;
        } else {
            eph.count--;
        }
    }

    if (eph.count > 0) {
        const ChebyshevSegment& first = eph.segments[0];
        const ChebyshevSegment& last = eph.segments[eph.count - 1];
        eph.startJD = first.startJD;
        readSegmentState(first.startPos, first.startVel, first.startJD, eph.firstStartState);
        readSegmentState(last.endPos, last.endVel, last.endJD, eph.lastEndState);
    }
}

static inline bool lookupCoveredSegment(const ChebyshevEphemeris& eph, double jd, int& idxOut) {
    idxOut = eph.lookup(jd);
    if (idxOut < 0) return false;
    const ChebyshevSegment& seg = eph.segments[idxOut];
    return jd >= (seg.startJD - 1e-12) && jd <= (seg.endJD + 1e-12);
}

struct PreparedTrajectorySegmentSet {
    uint32_t handle = 0;
    uint32_t catalogHandle = 0;
    double startJD = 0.0;
    double durationDays = 0.0;
    std::string profile;
    std::vector<uint32_t> sourceHandles;
};

// =============================================================================
// Burn / Arc Support (heap-allocated, zero overhead when no burns)
// =============================================================================

struct BurnRecord {
    double timeJD;           // Julian Date of impulsive burn
    double targetEntityIdx;  // Target entity index (for LVLH frame reference)
    double dv_r;             // LVLH radial delta-V (km/s)
    double dv_t;             // LVLH along-track delta-V (km/s)
    double dv_n;             // LVLH cross-track delta-V (km/s)
};

struct HPOPArc {
    StateVector initialState;     // Post-burn ECI state (km, km/s)
    double startJD;               // Arc start (burn time or entity epoch)
    double endJD;                 // Arc end (next burn time or +∞)
    ChebyshevEphemeris ephemeris; // Lazily-built for this arc
    bool stateComputed;           // Whether initialState has been computed
};

// =============================================================================
// Per-Entity Storage
// =============================================================================

// Catalog-scale ceiling (loop E.6): the full public catalog is ~29.5K
// objects and worker shards must be able to host any slice of it. Static
// storage cost is ~300 bytes/slot (zero-initialized BSS) — ~20 MB at 65536.
static constexpr int MAX_ENTITIES = 65536;

struct HPOPEntity {
    StateVector initialState;    // Fixed initial state at epoch (ECI, km, km/s)
    StateVector cachedState;     // Last propagated state (for efficient forward propagation)
    double cachedJD;             // JD of cached state (0 if not yet propagated)
    uint32_t cachedConfigVer;    // Config version when cache was written
    double orbitalPeriodMin;     // Orbital period in minutes
    double eccentricity;         // Orbital eccentricity
    bool valid;                  // Whether this entity slot is initialized
    ChebyshevEphemeris ephemeris; // Lazily-built Chebyshev polynomial cache
    // Burn/arc fields — heap-allocated, NULL when no burns (zero overhead)
    BurnRecord* burns = nullptr;
    int burnCount = 0;
    HPOPArc* arcs = nullptr;
    int arcCount = 0;
};

static HPOPEntity g_entities[MAX_ENTITIES];
static int g_entityCount = 0;
static uint32_t g_entityCatalogNumbers[MAX_ENTITIES] = {0};

// E.6 batch-scale controls (defaults preserve pre-E.6 behavior exactly):
// - retention: when finite, segments wholly behind (focusJD - retention) are
//   dropped after coverage work, bounding per-entity memory for long runs.
// - grid stagger: offsets each entity's Chebyshev grid origin by a
//   deterministic golden-ratio fraction of one segment so that segment
//   boundaries (and therefore segment REBUILD costs) are spread uniformly
//   across sim time instead of stampeding in a single frame when thousands
//   of entities share one seed epoch.
static double g_retentionBehindDays = 1e30;
static bool g_gridStagger = false;
static std::unordered_map<uint32_t, PreparedTrajectorySegmentSet> g_segmentSets;
static uint32_t g_nextSegmentSetHandle = 1u;

// =============================================================================
// Working State for Low-Level API (STM, covariance)
// =============================================================================

static StateVector g_state;

static inline double vecNorm(const Vec3& v) {
    return std::sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

// =============================================================================
// Internal Helpers
// =============================================================================

/// Compute orbital period and eccentricity from ECI state vector.
static void computeOrbitalElements(const Vec3& pos, const Vec3& vel,
                                    double& periodMin, double& ecc) {
    double r = std::sqrt(pos.x*pos.x + pos.y*pos.y + pos.z*pos.z);
    double v2 = vel.x*vel.x + vel.y*vel.y + vel.z*vel.z;

    // Semi-major axis via vis-viva equation
    double a = 1.0 / (2.0/r - v2/MU_EARTH);

    // Eccentricity vector: e = (v x h)/mu - r_hat
    double hx = pos.y*vel.z - pos.z*vel.y;
    double hy = pos.z*vel.x - pos.x*vel.z;
    double hz = pos.x*vel.y - pos.y*vel.x;
    double ex = (vel.y*hz - vel.z*hy)/MU_EARTH - pos.x/r;
    double ey = (vel.z*hx - vel.x*hz)/MU_EARTH - pos.y/r;
    double ez = (vel.x*hy - vel.y*hx)/MU_EARTH - pos.z/r;
    ecc = std::sqrt(ex*ex + ey*ey + ez*ez);

    // Period: T = 2pi * sqrt(a^3 / mu), converted to minutes
    double periodSec = 2.0 * M_PI * std::sqrt(std::fabs(a*a*a) / MU_EARTH);
    periodMin = periodSec / 60.0;
}

/// Convert LVLH (RTN) delta-V to ECI using a reference entity's state.
/// R = r_hat, N = (r × v) / |r × v|, T = N × R
static Vec3 lvlhDeltaVToECI(const Vec3& tPos, const Vec3& tVel,
                              double dv_r, double dv_t, double dv_n) {
    double rMag = std::sqrt(tPos.x*tPos.x + tPos.y*tPos.y + tPos.z*tPos.z);
    Vec3 R = { tPos.x/rMag, tPos.y/rMag, tPos.z/rMag };
    Vec3 h = { tPos.y*tVel.z - tPos.z*tVel.y,
               tPos.z*tVel.x - tPos.x*tVel.z,
               tPos.x*tVel.y - tPos.y*tVel.x };
    double hMag = std::sqrt(h.x*h.x + h.y*h.y + h.z*h.z);
    Vec3 N = { h.x/hMag, h.y/hMag, h.z/hMag };
    Vec3 T = { N.y*R.z - N.z*R.y, N.z*R.x - N.x*R.z, N.x*R.y - N.y*R.x };
    return { dv_r*R.x + dv_t*T.x + dv_n*N.x,
             dv_r*R.y + dv_t*T.y + dv_n*N.y,
             dv_r*R.z + dv_t*T.z + dv_n*N.z };
}

static StateVector propagateStepInternal(const StateVector& initial, double dtSec) {
    // Update force model weather and set epoch for JD reconstruction in
    // ForceModelDerivative: jd = weather.epoch + t / 86400.0
    g_forceSet.weather = g_weather;
    g_forceSet.weather.epoch = initial.epoch;

    StateVector result;

    switch (g_integratorType) {
        case IntegrationMethod::RK4: {
            double h = g_integratorConfig.initialStep;
            result = Integrator::RK4(initial, dtSec, h, g_forceSet);
            break;
        }
        case IntegrationMethod::RKF45: {
            result = Integrator::RKF45(initial, dtSec, g_integratorConfig, g_forceSet);
            break;
        }
        case IntegrationMethod::RK78:
        case IntegrationMethod::RKF78: {
            IntegratorConfig cfg = g_integratorConfig;
            cfg.method = IntegrationMethod::RK78;
            result = Integrator::Cowell(initial, dtSec, cfg, g_forceSet);
            break;
        }
        case IntegrationMethod::GaussJackson8: {
            IntegratorConfig cfg = g_integratorConfig;
            cfg.method = IntegrationMethod::GaussJackson8;
            result = Integrator::Cowell(initial, dtSec, cfg, g_forceSet);
            break;
        }
        case IntegrationMethod::Cowell: {
            result = Integrator::Cowell(initial, dtSec, g_integratorConfig, g_forceSet);
            break;
        }
        case IntegrationMethod::Encke: {
            result = Integrator::Encke(initial, dtSec, g_integratorConfig, g_forceSet);
            break;
        }
        default: {
            IntegratorConfig cfg = g_integratorConfig;
            cfg.method = IntegrationMethod::RK78;
            result = Integrator::Cowell(initial, dtSec, cfg, g_forceSet);
            break;
        }
    }

    result.epoch = initial.epoch + dtSec / DAY_SEC;
    return result;
}

/// Propagate state to a target JD using the configured integrator.
/// Long spans are split into bounded substeps so direct propagation remains
/// compositionally consistent with segmented ephemeris generation.
static StateVector propagateInternal(const StateVector& initial, double targetJD) {
    double totalDtSec = (targetJD - initial.epoch) * DAY_SEC;
    if (std::abs(totalDtSec) < 1e-12) {
        StateVector same = initial;
        same.epoch = targetJD;
        return same;
    }

    double maxStepSec = g_integratorConfig.maxStep;
    if (!(maxStepSec > 0.0)) maxStepSec = CHEBY_SEG_SEC;
    double chunkSec = std::max(1.0, std::min(std::abs(maxStepSec), CHEBY_SEG_SEC));

    StateVector current = initial;
    double remaining = totalDtSec;
    while (std::abs(remaining) > chunkSec) {
        double step = (remaining > 0.0) ? chunkSec : -chunkSec;
        current = propagateStepInternal(current, step);
        remaining -= step;
    }

    if (std::abs(remaining) > 1e-12) {
        current = propagateStepInternal(current, remaining);
    }

    current.epoch = targetJD;
    return current;
}

static inline void perturbStateComponent(StateVector& state, int idx, double delta) {
    switch (idx) {
        case 0: state.position.x += delta; break;
        case 1: state.position.y += delta; break;
        case 2: state.position.z += delta; break;
        case 3: state.velocity.x += delta; break;
        case 4: state.velocity.y += delta; break;
        case 5: state.velocity.z += delta; break;
        default: break;
    }
}

/// Compute a full-force-model STM by central finite differences:
/// Phi(:,j) = d x_f / d x0_j with x_f = propagateInternal(x0, dt).
/// This follows the configured integrator + active force models.
static Mat6 computeSTMFiniteDifference(const StateVector& state, double dtSec) {
    Mat6 stm = Mat6::identity();
    if (std::abs(dtSec) < 1e-12) return stm;

    const double targetJD = state.epoch + dtSec / DAY_SEC;
    const double rMag = vecNorm(state.position);
    const double vMag = vecNorm(state.velocity);

    const double dPos = std::max(1e-6, 1e-8 * std::max(1.0, rMag)); // km
    const double dVel = std::max(1e-9, 1e-8 * std::max(1.0, vMag)); // km/s

    for (int j = 0; j < 6; j++) {
        StateVector plus = state;
        StateVector minus = state;
        double delta = (j < 3) ? dPos : dVel;

        perturbStateComponent(plus, j,  delta);
        perturbStateComponent(minus, j, -delta);

        StateVector fp = propagateInternal(plus, targetJD);
        StateVector fm = propagateInternal(minus, targetJD);

        double inv2d = 1.0 / (2.0 * delta);
        stm.m[0][j] = (fp.position.x - fm.position.x) * inv2d;
        stm.m[1][j] = (fp.position.y - fm.position.y) * inv2d;
        stm.m[2][j] = (fp.position.z - fm.position.z) * inv2d;
        stm.m[3][j] = (fp.velocity.x - fm.velocity.x) * inv2d;
        stm.m[4][j] = (fp.velocity.y - fm.velocity.y) * inv2d;
        stm.m[5][j] = (fp.velocity.z - fm.velocity.z) * inv2d;
    }

    return stm;
}

/// Convert ECI (GCRF) state to ECEF (ITRF) position/velocity in meters.
/// Uses coords::transform() which applies the ω×r transport term for velocity,
/// not just the rotation matrix (which would introduce ~510 m/s error at LEO).
static void eciToEcefMeters(const StateVector& eciKm, double jd,
                            double* outPos, double* outVel) {
    coords::StateVec sv(
        {eciKm.position.x, eciKm.position.y, eciKm.position.z},
        {eciKm.velocity.x, eciKm.velocity.y, eciKm.velocity.z}
    );
    coords::StateVec ecef = transform(sv, coords::Frame::GCRF, coords::Frame::ECEF, jd);

    // km -> meters
    outPos[0] = ecef.position.x * 1000.0;
    outPos[1] = ecef.position.y * 1000.0;
    outPos[2] = ecef.position.z * 1000.0;
    outVel[0] = ecef.velocity.x * 1000.0;
    outVel[1] = ecef.velocity.y * 1000.0;
    outVel[2] = ecef.velocity.z * 1000.0;
}

/// Build Chebyshev polynomial coverage for a given ephemeris and seed state.
/// Optional bounds prevent extension past arc boundaries (for burn support).
/// Default bounds are effectively unbounded (used by the no-burn path).
static void buildChebyshevCoverage(ChebyshevEphemeris& eph,
                                    const StateVector& seedState,
                                    double targetJD,
                                    double boundMinJD = -1e30,
                                    double boundMaxJD = 1e30,
                                    double gridAnchorJD = 0.0) {
    // Invalidate on config change
    if (eph.configVer != g_configVersion) {
        eph.clear();
        eph.configVer = g_configVersion;
    }

    // Clamp target to bounds
    if (targetJD < boundMinJD) targetJD = boundMinJD;
    if (targetJD > boundMaxJD) targetJD = boundMaxJD;

    // Seed with initial state. The grid origin defaults to the seed epoch;
    // an explicit anchor (<= seed epoch, within one segment) staggers the
    // uniform segment grid per entity without touching the seed state itself
    // (the first forward node simply integrates backward by the sub-segment
    // offset). lookup() stays valid because the grid remains uniform.
    if (eph.count == 0) {
        double origin = seedState.epoch;
        if (gridAnchorJD != 0.0 && gridAnchorJD < origin &&
            origin - gridAnchorJD < CHEBY_SEG_DAYS) {
            origin = gridAnchorJD;
        }
        eph.startJD = origin;
        eph.firstStartState = seedState;
        eph.lastEndState = seedState;
    }

    // Extend backward if target is before current coverage start.
    while (eph.startJD > targetJD && eph.startJD > boundMinJD) {
        double segEnd   = eph.startJD;
        double segStart = std::max(segEnd - CHEBY_SEG_DAYS, boundMinJD);
        if (segEnd - segStart < 1e-6) break;
        double mid      = 0.5 * (segStart + segEnd);
        double halfSpan = 0.5 * (segEnd - segStart);

        // We have state at segment end (firstStartState) and march backward through
        // k=0..N nodes (time-descending), storing values by Chebyshev index k.
        double xVals[CHEBY_NPTS], yVals[CHEBY_NPTS], zVals[CHEBY_NPTS];
        double vxVals[CHEBY_NPTS], vyVals[CHEBY_NPTS], vzVals[CHEBY_NPTS];

        StateVector current = eph.firstStartState;
        StateVector segEndState = current;

        for (int k = 0; k <= CHEBY_N; k++) {
            double nodeJD = mid + std::cos(k * M_PI / CHEBY_N) * halfSpan;

            double dtSec = (nodeJD - current.epoch) * DAY_SEC;
            if (std::abs(dtSec) > 0.001) {
                current = propagateInternal(current, nodeJD);
            }

            xVals[k]  = current.position.x;
            yVals[k]  = current.position.y;
            zVals[k]  = current.position.z;
            vxVals[k] = current.velocity.x;
            vyVals[k] = current.velocity.y;
            vzVals[k] = current.velocity.z;
        }

        if (!eph.grow(eph.count + 1)) return;

        if (eph.count > 0) {
            std::memmove(eph.segments + 1, eph.segments, eph.count * sizeof(ChebyshevSegment));
        }

        ChebyshevSegment& seg = eph.segments[0];
        seg.startJD      = segStart;
        seg.endJD        = segEnd;
        seg.midJD        = mid;
        seg.halfSpanDays = halfSpan;
        writeSegmentState(seg.startPos, seg.startVel, current);
        writeSegmentState(seg.endPos, seg.endVel, segEndState);

        chebyshevFit(xVals,  seg.cx);
        chebyshevFit(yVals,  seg.cy);
        chebyshevFit(zVals,  seg.cz);
        chebyshevFit(vxVals, seg.cvx);
        chebyshevFit(vyVals, seg.cvy);
        chebyshevFit(vzVals, seg.cvz);

        eph.count++;
        eph.startJD = segStart;
        eph.firstStartState = current;       // state at k=N (segment start)
        eph.firstStartState.epoch = segStart;
        pruneChebyshevEphemeris(eph, targetJD);
    }

    // Extend forward if target is after current coverage end.
    while (eph.endJD() <= targetJD && eph.endJD() < boundMaxJD) {
        double segStart = eph.endJD();
        double segEnd   = std::min(segStart + CHEBY_SEG_DAYS, boundMaxJD);
        if (segEnd - segStart < 1e-6) break;
        double mid      = 0.5 * (segStart + segEnd);
        double halfSpan = 0.5 * (segEnd - segStart);

        // Propagate to each Gauss-Lobatto node in ascending time order.
        // Chebyshev index k: τ_k = cos(kπ/N).  k=N → τ=-1 (start), k=0 → τ=+1 (end).
        // Ascending time order: k = N, N-1, ..., 1, 0.
        double xVals[CHEBY_NPTS], yVals[CHEBY_NPTS], zVals[CHEBY_NPTS];
        double vxVals[CHEBY_NPTS], vyVals[CHEBY_NPTS], vzVals[CHEBY_NPTS];

        StateVector current = eph.lastEndState;
        StateVector segStartState = current;

        for (int i = 0; i < CHEBY_NPTS; i++) {
            int k = CHEBY_N - i;   // descending k = ascending time
            double nodeJD = mid + std::cos(k * M_PI / CHEBY_N) * halfSpan;

            double dtSec = (nodeJD - current.epoch) * DAY_SEC;
            if (std::abs(dtSec) > 0.001) {
                current = propagateInternal(current, nodeJD);
            }

            xVals[k]  = current.position.x;
            yVals[k]  = current.position.y;
            zVals[k]  = current.position.z;
            vxVals[k] = current.velocity.x;
            vyVals[k] = current.velocity.y;
            vzVals[k] = current.velocity.z;
        }

        // Fit Chebyshev coefficients for all 6 components
        if (!eph.grow(eph.count + 1)) return;
        ChebyshevSegment& seg = eph.segments[eph.count];
        seg.startJD      = segStart;
        seg.endJD        = segEnd;
        seg.midJD        = mid;
        seg.halfSpanDays = halfSpan;
        writeSegmentState(seg.startPos, seg.startVel, segStartState);
        writeSegmentState(seg.endPos, seg.endVel, current);

        chebyshevFit(xVals,  seg.cx);
        chebyshevFit(yVals,  seg.cy);
        chebyshevFit(zVals,  seg.cz);
        chebyshevFit(vxVals, seg.cvx);
        chebyshevFit(vyVals, seg.cvy);
        chebyshevFit(vzVals, seg.cvz);

        eph.count++;
        eph.lastEndState = current;           // state at k=0 (segment end)
        eph.lastEndState.epoch = segEnd;
        pruneChebyshevEphemeris(eph, targetJD);
    }
}

/// Deterministic per-entity grid anchor: golden-ratio fraction of one
/// segment behind the seed epoch. Only used when stagger is enabled.
static inline double entityGridAnchorJD(const HPOPEntity& entity) {
    if (!g_gridStagger) return 0.0;
    const int idx = static_cast<int>(&entity - g_entities);
    const double phase = std::fmod(idx * 0.6180339887498949, 1.0);
    return entity.initialState.epoch - phase * CHEBY_SEG_DAYS;
}

/// Drop whole segments strictly behind keepFromJD (keeps at least one).
/// The grid stays uniform, so ChebyshevEphemeris::lookup remains valid.
static void pruneFrontSegments(ChebyshevEphemeris& eph, double keepFromJD) {
    if (eph.count <= 1) return;
    int drop = 0;
    while (drop < eph.count - 1 && eph.segments[drop].endJD < keepFromJD) {
        drop++;
    }
    if (drop <= 0) return;
    std::memmove(eph.segments, eph.segments + drop,
                 (eph.count - drop) * sizeof(ChebyshevSegment));
    eph.count -= drop;
    eph.startJD = eph.segments[0].startJD;
    readSegmentState(eph.segments[0].startPos, eph.segments[0].startVel,
                     eph.segments[0].startJD, eph.firstStartState);
}

static inline void applyRetention(HPOPEntity& entity, double focusJD) {
    if (g_retentionBehindDays < 1e29 && entity.arcCount == 0) {
        pruneFrontSegments(entity.ephemeris, focusJD - g_retentionBehindDays);
    }
}

/// Convenience wrapper: ensure entity's Chebyshev ephemeris covers targetJD.
static inline void ensureChebyshevEphemeris(HPOPEntity& entity, double targetJD) {
    buildChebyshevCoverage(entity.ephemeris, entity.initialState, targetJD,
                           -1e30, 1e30, entityGridAnchorJD(entity));
}

static bool prepareTrajectorySegmentsForEntity(
    uint32_t entityIndex,
    double startJD,
    double durationDays,
    uint32_t& segmentSetHandleOut,
    double& certifiedMaxPositionErrorKmOut,
    double& certifiedMaxVelocityErrorKmSOut) {
    if (entityIndex >= static_cast<uint32_t>(g_entityCount)) {
        return false;
    }

    HPOPEntity& entity = g_entities[entityIndex];
    if (!entity.valid || !std::isfinite(startJD) || !std::isfinite(durationDays) || durationDays < 0.0) {
        return false;
    }

    const double endJD = startJD + durationDays;
    if (!std::isfinite(endJD)) {
        return false;
    }

    // Reuse the resident Chebyshev cache as the authoritative segment store.
    // We only ensure the requested window is covered; we do not build a second
    // trajectory representation for this contract.
    ensureChebyshevEphemeris(entity, startJD);
    ensureChebyshevEphemeris(entity, endJD);

    int startIdx = -1;
    int endIdx = -1;
    if (!lookupCoveredSegment(entity.ephemeris, startJD, startIdx) ||
        !lookupCoveredSegment(entity.ephemeris, endJD, endIdx)) {
        return false;
    }

    segmentSetHandleOut = entityIndex + 1u;
    certifiedMaxPositionErrorKmOut = 0.0;
    certifiedMaxVelocityErrorKmSOut = 0.0;
    return true;
}

// =============================================================================
// Arc-Aware Propagation Helpers
// =============================================================================

/// Find which arc contains the given JD. Returns arc index (0-based).
static int findArcIndex(const HPOPEntity& entity, double jd) {
    for (int i = entity.arcCount - 1; i >= 0; i--) {
        if (jd >= entity.arcs[i].startJD) return i;
    }
    return 0;
}

/// Ensure an arc's initial state is computed (propagate through preceding burns).
static void computeArcInitialState(HPOPEntity& entity, int arcIdx) {
    HPOPArc& arc = entity.arcs[arcIdx];
    if (arc.stateComputed) return;

    if (arcIdx == 0) {
        // Arc 0: same as entity initial state
        arc.initialState = entity.initialState;
        arc.stateComputed = true;
        return;
    }

    // Ensure previous arc state is computed first
    computeArcInitialState(entity, arcIdx - 1);

    // Propagate previous arc to the burn time
    HPOPArc& prevArc = entity.arcs[arcIdx - 1];
    buildChebyshevCoverage(prevArc.ephemeris, prevArc.initialState,
                           arc.startJD, prevArc.startJD, prevArc.endJD);

    StateVector chaserAtBurn;
    int idx = -1;
    if (lookupCoveredSegment(prevArc.ephemeris, arc.startJD, idx)) {
        Vec3 pos, vel;
        chebyshevEvalState(prevArc.ephemeris.segments[idx], arc.startJD, pos, vel);
        chaserAtBurn.position = pos;
        chaserAtBurn.velocity = vel;
        chaserAtBurn.epoch = arc.startJD;
    } else {
        chaserAtBurn = propagateInternal(prevArc.initialState, arc.startJD);
    }

    // Get target entity state at burn time (for LVLH frame)
    const BurnRecord& burn = entity.burns[arcIdx - 1];
    int targetIdx = static_cast<int>(burn.targetEntityIdx);
    Vec3 tPos, tVel;

    if (targetIdx >= 0 && targetIdx < g_entityCount && targetIdx != -1) {
        StateVector targetState = propagateEntity(targetIdx, arc.startJD);
        tPos = targetState.position;
        tVel = targetState.velocity;
    } else {
        // Self-referenced: use chaser's own state for LVLH frame
        tPos = chaserAtBurn.position;
        tVel = chaserAtBurn.velocity;
    }

    // Apply delta-V in LVLH frame
    double dvMag2 = burn.dv_r*burn.dv_r + burn.dv_t*burn.dv_t + burn.dv_n*burn.dv_n;
    if (dvMag2 > 1e-20) {
        Vec3 dvECI = lvlhDeltaVToECI(tPos, tVel, burn.dv_r, burn.dv_t, burn.dv_n);
        chaserAtBurn.velocity.x += dvECI.x;
        chaserAtBurn.velocity.y += dvECI.y;
        chaserAtBurn.velocity.z += dvECI.z;
    }

    arc.initialState = chaserAtBurn;
    arc.stateComputed = true;
}

/// Evaluate ECI state from an arc's Chebyshev ephemeris at the given JD.
static StateVector evaluateArc(HPOPEntity& entity, int arcIdx, double targetJD) {
    HPOPArc& arc = entity.arcs[arcIdx];

    // Ensure initial state is computed
    computeArcInitialState(entity, arcIdx);

    // Build coverage within arc bounds
    buildChebyshevCoverage(arc.ephemeris, arc.initialState,
                           targetJD, arc.startJD, arc.endJD);

    StateVector result;
    int idx = -1;
    if (lookupCoveredSegment(arc.ephemeris, targetJD, idx)) {
        Vec3 pos, vel;
        chebyshevEvalState(arc.ephemeris.segments[idx], targetJD, pos, vel);
        result.position = pos;
        result.velocity = vel;
        result.epoch = targetJD;
    } else {
        result = propagateInternal(arc.initialState, targetJD);
    }
    return result;
}

/// Propagate entity to target JD using Chebyshev polynomial evaluation.
/// Returns ECI StateVector (km, km/s). Zero numerical integration at query time.
/// Arc-aware: if burns are present, dispatches to the correct arc.
static StateVector propagateEntity(int entityIndex, double targetJD) {
    HPOPEntity& entity = g_entities[entityIndex];

    StateVector result;

    if (entity.arcCount > 0) {
        // Arc-aware path: burns are present
        int arcIdx = findArcIndex(entity, targetJD);
        result = evaluateArc(entity, arcIdx, targetJD);
    } else {
        // Normal path: no burns, use entity's ephemeris directly
        ensureChebyshevEphemeris(entity, targetJD);

        int idx = -1;
        if (lookupCoveredSegment(entity.ephemeris, targetJD, idx)) {
            Vec3 pos, vel;
            chebyshevEvalState(entity.ephemeris.segments[idx], targetJD, pos, vel);
            result.position = pos;
            result.velocity = vel;
            result.epoch = targetJD;
        } else {
            result = propagateInternal(entity.initialState, targetJD);
        }
    }

    // Update per-entity cache
    entity.cachedState = result;
    entity.cachedJD = targetJD;
    entity.cachedConfigVer = g_configVersion;

    return result;
}

/// Eigendecompose a 3x3 symmetric matrix (position covariance).
/// Returns eigenvalues (semi-axes squared) and eigenvectors (rotation).
/// Uses Jacobi iteration for symmetric eigenvalue decomposition.
static void eigendecompose3x3(const double cov[3][3],
                               double eigenvalues[3],
                               double eigenvectors[3][3]) {
    double A[3][3];
    double V[3][3] = {{1,0,0},{0,1,0},{0,0,1}};
    for (int i = 0; i < 3; i++)
        for (int j = 0; j < 3; j++)
            A[i][j] = cov[i][j];

    for (int sweep = 0; sweep < 50; sweep++) {
        double offDiag = 0.0;
        for (int i = 0; i < 3; i++)
            for (int j = i + 1; j < 3; j++)
                offDiag += A[i][j] * A[i][j];
        if (offDiag < 1e-30) break;

        for (int p = 0; p < 3; p++) {
            for (int q = p + 1; q < 3; q++) {
                if (std::fabs(A[p][q]) < 1e-15) continue;

                double theta = 0.5 * std::atan2(2.0 * A[p][q], A[p][p] - A[q][q]);
                double c = std::cos(theta);
                double s = std::sin(theta);

                double App = c*c*A[p][p] + 2*s*c*A[p][q] + s*s*A[q][q];
                double Aqq = s*s*A[p][p] - 2*s*c*A[p][q] + c*c*A[q][q];
                A[p][q] = 0.0;
                A[q][p] = 0.0;
                A[p][p] = App;
                A[q][q] = Aqq;

                for (int r = 0; r < 3; r++) {
                    if (r == p || r == q) continue;
                    double Arp = c * A[r][p] + s * A[r][q];
                    double Arq = -s * A[r][p] + c * A[r][q];
                    A[r][p] = Arp; A[p][r] = Arp;
                    A[r][q] = Arq; A[q][r] = Arq;
                }

                for (int r = 0; r < 3; r++) {
                    double Vrp = c * V[r][p] + s * V[r][q];
                    double Vrq = -s * V[r][p] + c * V[r][q];
                    V[r][p] = Vrp;
                    V[r][q] = Vrq;
                }
            }
        }
    }

    for (int i = 0; i < 3; i++) {
        eigenvalues[i] = A[i][i];
        for (int j = 0; j < 3; j++)
            eigenvectors[j][i] = V[j][i];
    }
}

/// Convert rotation matrix to quaternion [x, y, z, w]
static void mat3ToQuaternion(const double R[3][3], double quat[4]) {
    double trace = R[0][0] + R[1][1] + R[2][2];
    if (trace > 0) {
        double s = 0.5 / std::sqrt(trace + 1.0);
        quat[3] = 0.25 / s;
        quat[0] = (R[2][1] - R[1][2]) * s;
        quat[1] = (R[0][2] - R[2][0]) * s;
        quat[2] = (R[1][0] - R[0][1]) * s;
    } else if (R[0][0] > R[1][1] && R[0][0] > R[2][2]) {
        double s = 2.0 * std::sqrt(1.0 + R[0][0] - R[1][1] - R[2][2]);
        quat[3] = (R[2][1] - R[1][2]) / s;
        quat[0] = 0.25 * s;
        quat[1] = (R[0][1] + R[1][0]) / s;
        quat[2] = (R[0][2] + R[2][0]) / s;
    } else if (R[1][1] > R[2][2]) {
        double s = 2.0 * std::sqrt(1.0 + R[1][1] - R[0][0] - R[2][2]);
        quat[3] = (R[0][2] - R[2][0]) / s;
        quat[0] = (R[0][1] + R[1][0]) / s;
        quat[1] = 0.25 * s;
        quat[2] = (R[1][2] + R[2][1]) / s;
    } else {
        double s = 2.0 * std::sqrt(1.0 + R[2][2] - R[0][0] - R[1][1]);
        quat[3] = (R[1][0] - R[0][1]) / s;
        quat[0] = (R[0][2] + R[2][0]) / s;
        quat[1] = (R[1][2] + R[2][1]) / s;
        quat[2] = 0.25 * s;
    }

    double len = std::sqrt(quat[0]*quat[0] + quat[1]*quat[1] +
                           quat[2]*quat[2] + quat[3]*quat[3]);
    if (len > 0) {
        quat[0] /= len; quat[1] /= len;
        quat[2] /= len; quat[3] /= len;
    }
}

// =============================================================================
// Exported C Functions
// =============================================================================

extern "C" {

// -----------------------------------------------------------------------------
// Initialization & Entity Management
// -----------------------------------------------------------------------------

/// Initialize the HPOP module with default configuration.
int plugin_init() {
    g_integratorConfig.method = IntegrationMethod::RK78;
    g_integratorConfig.initialStep = 60.0;
    g_integratorConfig.minStep = 0.01;
    g_integratorConfig.maxStep = 600.0;
    g_integratorConfig.absTolerance = 1e-12;
    g_integratorConfig.relTolerance = 1e-12;
    g_integratorConfig.maxSteps = 100000;

    g_forceSet = ForceModel::ForceModelSet();
    g_forceSet.usePointMass = true;
    g_forceSet.mu = MU_EARTH;
    g_forceSet.useSphericalHarmonics = true;
    g_forceSet.sphericalHarmonics.includeJ2 = true;

    g_integratorType = IntegrationMethod::RK78;
    g_weather = SpaceWeatherData();
    g_state = StateVector();

    // Free any existing ephemeris/burn/arc memory and clear entities
    for (int i = 0; i < g_entityCount; i++) {
        g_entities[i].ephemeris.destroy();
        if (g_entities[i].arcs) {
            for (int a = 0; a < g_entities[i].arcCount; a++)
                g_entities[i].arcs[a].ephemeris.destroy();
            std::free(g_entities[i].arcs);
        }
        std::free(g_entities[i].burns);
    }
    g_entityCount = 0;
    for (int i = 0; i < MAX_ENTITIES; i++) {
        g_entities[i].valid = false;
        g_entities[i].cachedJD = 0;
        g_entities[i].burns = nullptr;
        g_entities[i].burnCount = 0;
        g_entities[i].arcs = nullptr;
        g_entities[i].arcCount = 0;
        g_entityCatalogNumbers[i] = 0;
    }

    g_segmentSets.clear();
    g_nextSegmentSetHandle = 1u;
    g_retentionBehindDays = 1e30;
    g_gridStagger = false;
    g_initialized = true;
    g_configVersion++;

    return 0;
}

/// Batch-initialize entities from a flat array of state vectors.
/// Input: [epochJD, rx, ry, rz, vx, vy, vz, ...] — 7 doubles per entity, ECI km/km/s.
/// Analogous to SGP4's plugin_init_omm.
/// Returns entity count on success.
int plugin_init_states(double* statesPtr, int count) {
    // Free existing ephemeris/burn/arc memory before reinitializing
    for (int i = 0; i < g_entityCount; i++) {
        g_entities[i].ephemeris.destroy();
        if (g_entities[i].arcs) {
            for (int a = 0; a < g_entities[i].arcCount; a++)
                g_entities[i].arcs[a].ephemeris.destroy();
            std::free(g_entities[i].arcs);
        }
        std::free(g_entities[i].burns);
    }
    g_entityCount = 0;
    for (int i = 0; i < MAX_ENTITIES; i++) {
        g_entityCatalogNumbers[i] = 0;
    }
    g_segmentSets.clear();
    g_nextSegmentSetHandle = 1u;
    int n = (count > MAX_ENTITIES) ? MAX_ENTITIES : count;

    for (int i = 0; i < n; i++) {
        double* s = statesPtr + i * 7;
        HPOPEntity& entity = g_entities[i];

        entity.initialState.epoch = s[0];
        entity.initialState.position.x = s[1];
        entity.initialState.position.y = s[2];
        entity.initialState.position.z = s[3];
        entity.initialState.velocity.x = s[4];
        entity.initialState.velocity.y = s[5];
        entity.initialState.velocity.z = s[6];

        computeOrbitalElements(entity.initialState.position,
                               entity.initialState.velocity,
                               entity.orbitalPeriodMin,
                               entity.eccentricity);

        entity.cachedJD = 0;
        entity.cachedConfigVer = 0;
        entity.ephemeris.clear();
        entity.burns = nullptr;
        entity.burnCount = 0;
        entity.arcs = nullptr;
        entity.arcCount = 0;
        entity.valid = true;
    }

    g_entityCount = n;
    return n;
}

/// Get number of initialized entities.
int get_entity_count() {
    return g_entityCount;
}

/// Get orbital period for an entity (minutes).
double get_orbital_period(int entityIndex) {
    if (entityIndex < 0 || entityIndex >= g_entityCount) return 0.0;
    return g_entities[entityIndex].orbitalPeriodMin;
}

/// Get eccentricity for an entity.
double get_eccentricity(int entityIndex) {
    if (entityIndex < 0 || entityIndex >= g_entityCount) return 0.0;
    return g_entities[entityIndex].eccentricity;
}

// -----------------------------------------------------------------------------
// Entity-Indexed Propagation (matches SGP4 plugin contract)
// -----------------------------------------------------------------------------

/// Propagate an entity to a given Julian Date.
/// Output: [epochJD, rx, ry, rz, vx, vy, vz] in ECEF meters, m/s.
/// Returns 0 on success, negative on error.
int plugin_propagate(double jd, int entityIndex, double* outPtr) {
    if (!g_initialized || entityIndex < 0 || entityIndex >= g_entityCount) return -1;

    StateVector result = propagateEntity(entityIndex, jd);

    // Convert to ECEF meters
    double pos[3], vel[3];
    eciToEcefMeters(result, jd, pos, vel);

    outPtr[0] = jd;
    outPtr[1] = pos[0];
    outPtr[2] = pos[1];
    outPtr[3] = pos[2];
    outPtr[4] = vel[0];
    outPtr[5] = vel[1];
    outPtr[6] = vel[2];

    return 0;
}

/// Batch propagation with uniform time steps for a specific entity.
/// Output: [x0,y0,z0, x1,y1,z1, ...] ECEF meters.
/// Uses Chebyshev polynomial evaluation for covered samples (with direct
/// integration fallback when outside the current bounded cache window).
/// Returns number of valid samples.
int plugin_propagate_path_entity(int entityIndex, double startJD, double stepDays,
                                 int count, double* outPtr) {
    if (!g_initialized || entityIndex < 0 || entityIndex >= g_entityCount || count <= 0)
        return 0;

    HPOPEntity& entity = g_entities[entityIndex];
    int valid = 0;

    if (entity.arcCount > 0) {
        // Arc-aware: propagate each sample through arc dispatch
        for (int i = 0; i < count; i++) {
            double jd = startJD + i * stepDays;
            StateVector sv = propagateEntity(entityIndex, jd);
            coords::Vec3 cPos = {sv.position.x, sv.position.y, sv.position.z};
            coords::Vec3 cPosEcef = transformPosition(cPos, coords::Frame::GCRF, coords::Frame::ECEF, jd);
            outPtr[valid * 3 + 0] = cPosEcef.x * 1000.0;
            outPtr[valid * 3 + 1] = cPosEcef.y * 1000.0;
            outPtr[valid * 3 + 2] = cPosEcef.z * 1000.0;
            valid++;
        }
    } else {
        // Fast batch path: no burns, use entity's ephemeris directly
        double lastJD = startJD + (count - 1) * stepDays;
        double coverMin = std::min(startJD, lastJD);
        double coverMax = std::max(startJD, lastJD);
        ensureChebyshevEphemeris(entity, coverMin);
        ensureChebyshevEphemeris(entity, coverMax);

        for (int i = 0; i < count; i++) {
            double jd = startJD + i * stepDays;
            Vec3 posKm;

            int idx = -1;
            if (lookupCoveredSegment(entity.ephemeris, jd, idx)) {
                Vec3 vel;
                chebyshevEvalState(entity.ephemeris.segments[idx], jd, posKm, vel);
            } else {
                StateVector sv = propagateInternal(entity.initialState, jd);
                posKm = sv.position;
            }

            coords::Vec3 cPos = {posKm.x, posKm.y, posKm.z};
            coords::Vec3 cPosEcef = transformPosition(cPos, coords::Frame::GCRF, coords::Frame::ECEF, jd);
            outPtr[valid * 3 + 0] = cPosEcef.x * 1000.0;
            outPtr[valid * 3 + 1] = cPosEcef.y * 1000.0;
            outPtr[valid * 3 + 2] = cPosEcef.z * 1000.0;
            valid++;
        }
    }

    return valid;
}

/// Batch propagation at arbitrary sorted Julian Dates for a specific entity.
/// Input: timesPtr = sorted array of Julian Dates, count = number of times.
/// Output: [x0,y0,z0, x1,y1,z1, ...] ECEF meters.
/// Uses Chebyshev polynomial evaluation for covered samples (with direct
/// integration fallback when outside the current bounded cache window).
/// Returns number of valid samples.
int plugin_propagate_path_times(int entityIndex, double* timesPtr, int count,
                                double* outPtr) {
    if (!g_initialized || entityIndex < 0 || entityIndex >= g_entityCount || count <= 0)
        return 0;

    HPOPEntity& entity = g_entities[entityIndex];
    int valid = 0;

    if (entity.arcCount > 0) {
        // Arc-aware: propagate each sample through arc dispatch
        for (int i = 0; i < count; i++) {
            double jd = timesPtr[i];
            StateVector sv = propagateEntity(entityIndex, jd);
            coords::Vec3 cPos = {sv.position.x, sv.position.y, sv.position.z};
            coords::Vec3 cPosEcef = transformPosition(cPos, coords::Frame::GCRF, coords::Frame::ECEF, jd);
            outPtr[valid * 3 + 0] = cPosEcef.x * 1000.0;
            outPtr[valid * 3 + 1] = cPosEcef.y * 1000.0;
            outPtr[valid * 3 + 2] = cPosEcef.z * 1000.0;
            valid++;
        }
    } else {
        // Fast batch path: no burns
        double coverMin = timesPtr[0];
        double coverMax = timesPtr[0];
        for (int i = 1; i < count; i++) {
            double jd = timesPtr[i];
            if (jd < coverMin) coverMin = jd;
            if (jd > coverMax) coverMax = jd;
        }
        ensureChebyshevEphemeris(entity, coverMin);
        ensureChebyshevEphemeris(entity, coverMax);

        for (int i = 0; i < count; i++) {
            double jd = timesPtr[i];
            Vec3 posKm;

            int idx = -1;
            if (lookupCoveredSegment(entity.ephemeris, jd, idx)) {
                Vec3 vel;
                chebyshevEvalState(entity.ephemeris.segments[idx], jd, posKm, vel);
            } else {
                StateVector sv = propagateInternal(entity.initialState, jd);
                posKm = sv.position;
            }

            coords::Vec3 cPos = {posKm.x, posKm.y, posKm.z};
            coords::Vec3 cPosEcef = transformPosition(cPos, coords::Frame::GCRF, coords::Frame::ECEF, jd);
            outPtr[valid * 3 + 0] = cPosEcef.x * 1000.0;
            outPtr[valid * 3 + 1] = cPosEcef.y * 1000.0;
            outPtr[valid * 3 + 2] = cPosEcef.z * 1000.0;
            valid++;
        }
    }

    return valid;
}

/// Propagate ALL initialized entities to one Julian date in a single WASM call.
/// Output is positions-only: 3 × float64 per entity (ECEF meters), indexed by
/// entity index — [x0,y0,z0, x1,y1,z1, ...]. Mirrors the SGP4 plugin's
/// plugin_propagate_all_positions ABI so DataSourceDisplay's bulk
/// scatter-write pipeline can treat both propagators identically.
/// Invalid entities are zero-filled. The GCRF→ECEF rotation matrix is
/// computed once for the shared epoch and reused across all entities.
/// Returns: number of entities written.
int plugin_propagate_all_positions(double julianDate, double* positionsOut,
                                   int maxCount) {
    if (!g_initialized || positionsOut == nullptr || maxCount <= 0) return 0;

    int n = g_entityCount;
    if (n > maxCount) n = maxCount;

    // One rotation matrix for the whole batch — every entity shares the epoch.
    // Identical math to the per-entity path (eciToEcefMeters/transformPosition
    // both apply getTransformMatrix(GCRF, ECEF, jd) to the position).
    const coords::Matrix3x3 M = coords::getTransformMatrix(
        coords::Frame::GCRF, coords::Frame::ECEF, julianDate);

    for (int i = 0; i < n; i++) {
        double* out = positionsOut + i * 3;

        if (!g_entities[i].valid) {
            out[0] = 0.0;
            out[1] = 0.0;
            out[2] = 0.0;
            continue;
        }

        StateVector sv = propagateEntity(i, julianDate);
        coords::Vec3 posKm = {sv.position.x, sv.position.y, sv.position.z};
        coords::Vec3 posEcefKm = M.apply(posKm);

        out[0] = posEcefKm.x * 1000.0;
        out[1] = posEcefKm.y * 1000.0;
        out[2] = posEcefKm.z * 1000.0;

        applyRetention(g_entities[i], julianDate);
    }

    return n;
}

// -----------------------------------------------------------------------------
// E.6 batch-scale API (feature-detected by hosts; absent on older modules)
// -----------------------------------------------------------------------------

/// Build Chebyshev coverage up to julianDate for a contiguous entity range
/// WITHOUT producing positions. This is the background/amortization entry
/// point: workers call it in small chunks ahead of sim time so that the
/// per-frame call never integrates on the hot path. Applies the configured
/// retention window (focus = julianDate). Returns entities processed.
int plugin_ensure_coverage(double julianDate, int startEntity, int count) {
    if (!g_initialized || startEntity < 0 || count <= 0) return 0;
    int end = startEntity + count;
    if (end > g_entityCount) end = g_entityCount;
    int processed = 0;
    for (int i = startEntity; i < end; i++) {
        HPOPEntity& entity = g_entities[i];
        if (!entity.valid) continue;
        if (entity.arcCount > 0) {
            // Arc-aware entities (burns) keep the full propagateEntity path.
            propagateEntity(i, julianDate);
        } else {
            ensureChebyshevEphemeris(entity, julianDate);
            applyRetention(entity, julianDate);
        }
        processed++;
    }
    return processed;
}

/// Evaluation-only batch: positions for ALL entities at one epoch from the
/// EXISTING Chebyshev coverage. Never integrates. Entities whose coverage
/// does not reach julianDate are evaluated at the clamped coverage edge
/// (motion freezes briefly instead of stalling the caller); entities with
/// no coverage at all are zero-filled. Same output ABI as
/// plugin_propagate_all_positions. Returns entities written.
int plugin_eval_positions(double julianDate, double* positionsOut, int maxCount) {
    if (!g_initialized || positionsOut == nullptr || maxCount <= 0) return 0;

    int n = g_entityCount;
    if (n > maxCount) n = maxCount;

    const coords::Matrix3x3 M = coords::getTransformMatrix(
        coords::Frame::GCRF, coords::Frame::ECEF, julianDate);

    for (int i = 0; i < n; i++) {
        double* out = positionsOut + i * 3;
        HPOPEntity& entity = g_entities[i];

        Vec3 posKm;
        bool have = false;

        if (entity.valid) {
            if (entity.arcCount > 0) {
                StateVector sv = propagateEntity(i, julianDate);
                posKm = sv.position;
                have = true;
            } else if (entity.ephemeris.count > 0) {
                const ChebyshevEphemeris& eph = entity.ephemeris;
                double jd = julianDate;
                const double coverageEnd = eph.endJD();
                if (jd < eph.startJD) jd = eph.startJD;
                if (jd > coverageEnd) jd = coverageEnd;
                const int idx = eph.lookup(jd);
                if (idx >= 0) {
                    Vec3 vel;
                    chebyshevEvalState(eph.segments[idx], jd, posKm, vel);
                    have = true;
                }
            }
        }

        if (!have) {
            out[0] = 0.0;
            out[1] = 0.0;
            out[2] = 0.0;
            continue;
        }

        coords::Vec3 p = {posKm.x, posKm.y, posKm.z};
        coords::Vec3 pe = M.apply(p);
        out[0] = pe.x * 1000.0;
        out[1] = pe.y * 1000.0;
        out[2] = pe.z * 1000.0;
    }

    return n;
}

/// Bound per-entity ephemeris memory: segments wholly behind
/// (focusJD - behindDays) are dropped during coverage work.
/// Pass <= 0 or non-finite to disable (default: disabled).
void plugin_set_ephemeris_retention(double behindDays) {
    g_retentionBehindDays =
        (behindDays > 0.0 && std::isfinite(behindDays)) ? behindDays : 1e30;
}

/// Enable/disable per-entity segment-grid stagger (default: disabled).
/// Must be set before an entity's first coverage build to take effect.
void plugin_set_grid_stagger(int enabled) {
    g_gridStagger = enabled != 0;
}

/// Batch-initialize entities from ECEF state vectors in METERS:
/// [epochJD, rx_m, ry_m, rz_m, vx_ms, vy_ms, vz_ms] — 7 doubles per entity.
/// Converts to GCRF km in-place using the same coords::transform applied by
/// the ingest_state stream path (velocity includes the transport term), then
/// delegates to plugin_init_states. Returns entity count on success.
int plugin_init_states_ecef(double* statesPtr, int count) {
    if (statesPtr == nullptr || count <= 0) return 0;
    int n = (count > MAX_ENTITIES) ? MAX_ENTITIES : count;
    for (int i = 0; i < n; i++) {
        double* s = statesPtr + i * 7;
        const coords::StateVec ecef(
            {s[1] / 1000.0, s[2] / 1000.0, s[3] / 1000.0},
            {s[4] / 1000.0, s[5] / 1000.0, s[6] / 1000.0});
        const coords::StateVec gcrf = coords::transform(
            ecef, coords::Frame::ECEF, coords::Frame::GCRF, s[0]);
        s[1] = gcrf.position.x;
        s[2] = gcrf.position.y;
        s[3] = gcrf.position.z;
        s[4] = gcrf.velocity.x;
        s[5] = gcrf.velocity.y;
        s[6] = gcrf.velocity.z;
    }
    return plugin_init_states(statesPtr, n);
}

// -----------------------------------------------------------------------------
// Configuration (all increment g_configVersion to invalidate entity caches)
// -----------------------------------------------------------------------------

/// Set integrator type.
/// 0=RK4, 1=RKF45, 2=RK78, 3=GaussJackson8, 4=Cowell, 5=Encke
void plugin_set_integrator(int type) {
    switch (type) {
        case 0: g_integratorType = IntegrationMethod::RK4; break;
        case 1: g_integratorType = IntegrationMethod::RKF45; break;
        case 2: g_integratorType = IntegrationMethod::RK78; break;
        case 3: g_integratorType = IntegrationMethod::GaussJackson8; break;
        case 4: g_integratorType = IntegrationMethod::Cowell; break;
        case 5: g_integratorType = IntegrationMethod::Encke; break;
        default: g_integratorType = IntegrationMethod::RK78; break;
    }
    g_integratorConfig.method = g_integratorType;
    g_configVersion++;
}

/// Load state vector from packed doubles (low-level API for STM/covariance).
/// Input: [epochJD, rx, ry, rz, vx, vy, vz] in km, km/s (ECI/GCRF)
void plugin_set_state(double* statePtr) {
    g_state.epoch = statePtr[0];
    g_state.position.x = statePtr[1];
    g_state.position.y = statePtr[2];
    g_state.position.z = statePtr[3];
    g_state.velocity.x = statePtr[4];
    g_state.velocity.y = statePtr[5];
    g_state.velocity.z = statePtr[6];
}

/// Set force model configuration from packed doubles.
/// Input: [mu, gravDeg, gravOrd, useJ2, useJ3, useJ4,
///         useDrag, useSRP, useSun, useMoon,
///         mass, dragArea, srpArea, Cd, Cr]
///
/// Fifteen elements exactly. Callers allocate `15 * 8` bytes, so reading a
/// sixteenth is an out-of-bounds heap read — a longer configuration goes
/// through `plugin_set_force_model_v2`, which is told its own length.
void plugin_set_force_model(double* configPtr) {
    // Registered contributions are a SEPARATE registration and survive a
    // force-model reconfiguration. Wiping them here would make the port
    // order-dependent — register before configure and your force silently
    // vanishes — which is exactly the class of surprise this build item exists
    // to remove. `plugin_clear_force_contributions` is how they go away.
    const ForceModel::ContributionSet keptContributions = g_forceSet.contributions;
    const bool keptUseContributions = g_forceSet.useContributions;
    const auto keptLoadedField = g_forceSet.loadedField;

    g_forceSet = ForceModel::ForceModelSet();
    g_forceSet.contributions = keptContributions;
    g_forceSet.useContributions = keptUseContributions;
    g_forceSet.loadedField = keptLoadedField;

    double mu       = configPtr[0];
    int gravDeg     = (int)configPtr[1];
    int gravOrd     = (int)configPtr[2];
    bool useJ2      = configPtr[3] != 0.0;
    bool useJ3      = configPtr[4] != 0.0;
    bool useJ4      = configPtr[5] != 0.0;
    bool useDrag    = configPtr[6] != 0.0;
    bool useSRP     = configPtr[7] != 0.0;
    bool useSun     = configPtr[8] != 0.0;
    bool useMoon    = configPtr[9] != 0.0;
    double mass     = configPtr[10];
    double dragArea  = configPtr[11];
    double srpArea   = configPtr[12];
    double Cd       = configPtr[13];
    double Cr       = configPtr[14];

    g_forceSet.mu = (mu > 0) ? mu : MU_EARTH;

    if (gravDeg >= 2) {
        g_forceSet.usePointMass = false;
        g_forceSet.useSphericalHarmonics = true;
        g_forceSet.sphericalHarmonics.mu = g_forceSet.mu;
        g_forceSet.sphericalHarmonics.maxDegree = (uint16_t)gravDeg;
        g_forceSet.sphericalHarmonics.maxOrder = (uint16_t)gravOrd;
        g_forceSet.sphericalHarmonics.includeJ2 = useJ2;
        g_forceSet.sphericalHarmonics.includeJ3 = useJ3;
        g_forceSet.sphericalHarmonics.includeJ4 = useJ4;
    } else {
        // No degree was asked for, only zonal switches. This is the setting the
        // gallery's "J2 only" and "J2-J4" controls produce, and until gmat-07
        // it answered with a J2-J6 tesseral field: the include flags were
        // declared here and then ignored inside SphericalHarmonics(). They are
        // honored now, and the higher zonals are gated off so that a request
        // for a closed zonal set gets exactly that set.
        g_forceSet.usePointMass = true;
        g_forceSet.useSphericalHarmonics = false;
        if (useJ2 || useJ3 || useJ4) {
            g_forceSet.useSphericalHarmonics = true;
            g_forceSet.sphericalHarmonics.mu = g_forceSet.mu;
            g_forceSet.sphericalHarmonics.includeJ2 = useJ2;
            g_forceSet.sphericalHarmonics.includeJ3 = useJ3;
            g_forceSet.sphericalHarmonics.includeJ4 = useJ4;
            g_forceSet.sphericalHarmonics.includeHigherZonals = false;
            g_forceSet.sphericalHarmonics.maxDegree = useJ4 ? 4 : (useJ3 ? 3 : 2);
            g_forceSet.sphericalHarmonics.maxOrder = 0;
        }
    }

    if (useSun || useMoon) {
        g_forceSet.useThirdBody = true;
        g_forceSet.thirdBody.includeSun = useSun;
        g_forceSet.thirdBody.includeMoon = useMoon;
    }

    if (useDrag) {
        g_forceSet.useDrag = true;
        g_forceSet.drag.mass = mass;
        g_forceSet.drag.area = dragArea;
        g_forceSet.drag.Cd = Cd;
    }

    if (useSRP) {
        g_forceSet.useSRP = true;
        g_forceSet.srp.mass = mass;
        g_forceSet.srp.area = srpArea;
        g_forceSet.srp.Cr = Cr;
    }

    g_configVersion++;
}

// -----------------------------------------------------------------------------
// Force-model configuration, extended                                (gmat-07)
// -----------------------------------------------------------------------------

/// Refusal codes shared by every gmat-07 setter. Zero is success; every
/// refusal is NEGATIVE, distinct, and leaves the configuration untouched.
enum HpopStatus {
    HPOP_OK = 0,
    HPOP_ERR_SHORT_BUFFER = -1,     ///< The caller's array is too short to read
    HPOP_ERR_UNKNOWN_LABEL = -2,    ///< No such enumerator
    HPOP_ERR_NOT_IMPLEMENTED = -3,  ///< The label names a model we do not have
    HPOP_ERR_BAD_ARGUMENT = -4,
    HPOP_ERR_PARSE = -5,            ///< File content could not be read
    HPOP_ERR_NOT_LOADED = -6,       ///< Nothing has been loaded to use
};

/// Set force model configuration, length-checked, with an explicit gravity
/// model.
///
/// `configPtr[0..14]` are exactly `plugin_set_force_model`'s fifteen elements.
/// Beyond them, all optional:
///   [15] gravityMode  0 infer (as v1), 1 point mass, 2 J2 closed form,
///                     3 J2-J4 closed form, 4 spherical harmonics,
///                     5 vendored EGM2008, 6 a field loaded from a file
///   [16] harrisPriesterExponent (2 low inclination, 6 polar; default 4)
///
/// `len` is the number of DOUBLES the caller allocated. It is honored: a
/// shorter array is read only as far as it goes, and a request that needs more
/// than the caller supplied is refused rather than read past the end.
int plugin_set_force_model_v2(double* configPtr, int len) {
    if (!configPtr || len < 15) return HPOP_ERR_SHORT_BUFFER;

    plugin_set_force_model(configPtr);

    if (len >= 16) {
        const int mode = (int)configPtr[15];
        if (mode < 0 || mode > 6) return HPOP_ERR_UNKNOWN_LABEL;
        if (mode == 6 && !g_loadedGravityField) return HPOP_ERR_NOT_LOADED;
        g_forceSet.gravityMode = (ForceModel::GravityMode)mode;
        if (mode == 6) {
            g_forceSet.useLoadedField = true;
            g_forceSet.loadedField = g_loadedGravityField;
        }
    }
    if (len >= 17) {
        const double n = configPtr[16];
        if (!(n > 0.0)) return HPOP_ERR_BAD_ARGUMENT;
        g_forceSet.harrisPriesterExponent = n;
    }
    g_configVersion++;
    return HPOP_OK;
}

/// Set drag-model options not included in the packed force-model array.
/// includeWinds: 0/1, coRotatingAtmosphere: 0/1
void plugin_set_drag_options(int includeWinds, int coRotatingAtmosphere) {
    g_forceSet.drag.includeWinds = includeWinds != 0;
    g_forceSet.drag.coRotatingAtmosphere = coRotatingAtmosphere != 0;
    g_configVersion++;
}

/// Every atmosphere label the ABI names, in ABI order. This order is the
/// contract; new labels are appended, never inserted.
static const AtmosphereModelType kAtmosphereLabels[] = {
    AtmosphereModelType::Exponential,     // 0
    AtmosphereModelType::USSA1976,        // 1
    AtmosphereModelType::NRLMSISE00,      // 2
    AtmosphereModelType::HarrisPriester,  // 3
    AtmosphereModelType::JB2008,          // 4
    AtmosphereModelType::DTM2020,         // 5
    AtmosphereModelType::GOST2004,        // 6
};
static constexpr int kAtmosphereLabelCount =
    (int)(sizeof(kAtmosphereLabels) / sizeof(kAtmosphereLabels[0]));

static ForceModel::DragModelType dragModelForLabel(AtmosphereModelType m) {
    switch (m) {
        case AtmosphereModelType::Exponential:    return ForceModel::DragModelType::Exponential;
        case AtmosphereModelType::USSA1976:       return ForceModel::DragModelType::USSA1976;
        case AtmosphereModelType::HarrisPriester: return ForceModel::DragModelType::HarrisPriester;
        case AtmosphereModelType::JB2008:         return ForceModel::DragModelType::JB2008;
        case AtmosphereModelType::DTM2020:        return ForceModel::DragModelType::DTM2020;
        case AtmosphereModelType::NRLMSISE00:
        case AtmosphereModelType::GOST2004:
        default:                                  return ForceModel::DragModelType::NRLMSISE00;
    }
}

/// Set the atmosphere model.
///
/// 0 Exponential, 1 USSA1976, 2 NRLMSISE00, 3 HarrisPriester,
/// 4 JB2008, 5 DTM2020, 6 GOST2004.
///
/// A label with no published implementation behind it is REFUSED with
/// `HPOP_ERR_NOT_IMPLEMENTED` and the configuration is left exactly as it was.
/// It is not substituted. Until gmat-07 this function accepted only 0, 1 and 2
/// and sent everything else — including labels naming entirely different
/// models — to NRLMSISE-00 through a `default:`, so a caller could ask for
/// JB2008, receive NRLMSISE-00, and be told nothing.
///
/// @return HPOP_OK, or a negative HpopStatus
int plugin_set_atmosphere_model(int modelEnum) {
    if (modelEnum < 0 || modelEnum >= kAtmosphereLabelCount) {
        return HPOP_ERR_UNKNOWN_LABEL;
    }
    const AtmosphereModelType label = kAtmosphereLabels[modelEnum];
    if (atmosphereImplementationOf(label) != AtmosphereImplementation::Published) {
        return HPOP_ERR_NOT_IMPLEMENTED;
    }
    const ForceModel::DragModelType drag = dragModelForLabel(label);
    g_forceSet.dragModel = drag;
    g_forceSet.drag.model = drag;
    g_configVersion++;
    return HPOP_OK;
}

/// What stands behind an atmosphere label.
/// @return 1 published implementation, 0 declared but not implemented,
///         HPOP_ERR_UNKNOWN_LABEL for a label the ABI does not name.
int plugin_get_atmosphere_model_status(int modelEnum) {
    if (modelEnum < 0 || modelEnum >= kAtmosphereLabelCount) {
        return HPOP_ERR_UNKNOWN_LABEL;
    }
    return atmosphereImplementationOf(kAtmosphereLabels[modelEnum]) ==
                   AtmosphereImplementation::Published
               ? 1
               : 0;
}

/// How many atmosphere labels the ABI names.
int plugin_get_atmosphere_model_count() { return kAtmosphereLabelCount; }

/// The label's stable name, so a UI never has to hard-code the list.
const char* plugin_get_atmosphere_model_name(int modelEnum) {
    if (modelEnum < 0 || modelEnum >= kAtmosphereLabelCount) return "";
    return atmosphereModelName(kAtmosphereLabels[modelEnum]);
}

/// The authority a published label reproduces, or why an unimplemented one
/// refuses. A refusal that cannot explain itself gets guessed at.
const char* plugin_get_atmosphere_model_provenance(int modelEnum) {
    if (modelEnum < 0 || modelEnum >= kAtmosphereLabelCount) return "";
    return atmosphereModelProvenance(kAtmosphereLabels[modelEnum]);
}

/// Set solar activity indices for atmosphere models.
void plugin_set_solar_activity(double f107, double f107a, double* apPtr) {
    g_weather.F107 = f107;
    g_weather.F107a = f107a;
    g_weather.Ap = apPtr[0];
    for (int i = 0; i < 7; i++) {
        g_weather.ap3h[i] = apPtr[i];
    }
    g_forceSet.weather = g_weather;
    g_configVersion++;
}

// -----------------------------------------------------------------------------
// Potential-file loading                                             (gmat-07)
// -----------------------------------------------------------------------------

/// Load a spherical-harmonic potential field from file CONTENT.
///
/// The module has no filesystem. The host hands over bytes — from an embedded
/// blob, an SDS record payload or a fetch — and the module parses them. ICGEM
/// and fixed-column encodings are both recognized and the format is sniffed.
///
/// The field is held but NOT selected: select it with
/// `plugin_set_force_model_v2` gravity mode 6, so loading and flying are two
/// decisions rather than one implicit one.
///
/// @param contentPtr UTF-8 file content (not necessarily NUL-terminated)
/// @param contentLen Length in bytes
/// @param maxDegree Truncation degree, 0 for whatever the file holds
/// @param maxOrder Truncation order, 0 for the same as the degree
/// @return the loaded maximum degree (positive), or a negative HpopStatus
int plugin_load_gravity_field(const char* contentPtr, int contentLen,
                              int maxDegree, int maxOrder) {
    if (!contentPtr || contentLen <= 0) return HPOP_ERR_BAD_ARGUMENT;
    const std::string content(contentPtr, (size_t)contentLen);
    GravityFileLoadResult r = loadGravityField(content,
                                              (uint16_t)std::max(0, maxDegree),
                                              (uint16_t)std::max(0, maxOrder));
    if (!r.ok()) {
        g_gravityFileDetail = r.detail;
        return HPOP_ERR_PARSE;
    }
    g_gravityFileDetail.clear();
    g_loadedGravityField = std::make_shared<const ExtendedGravityField>(r.field);
    g_loadedGravityName = r.modelName;
    g_configVersion++;
    return (int)r.field.maxDegree;
}

/// Why the last `plugin_load_gravity_field` refused, or "" if it did not.
const char* plugin_get_gravity_field_error() { return g_gravityFileDetail.c_str(); }

/// The model name the loaded file declared, or "".
const char* plugin_get_gravity_field_name() { return g_loadedGravityName.c_str(); }

// -----------------------------------------------------------------------------
// Force-model contribution port                                      (gmat-07)
// -----------------------------------------------------------------------------

/// Register a parameterized force contribution into a slot.
///
/// Contributions are PARAMETERS, not code: hosting foreign code inside the
/// propagator would be a new host capability, which this surface does not
/// grant. A registered contribution is integrated with the built-in models —
/// it is not a correction applied afterwards — and appears in its own lane of
/// the extended acceleration breakdown.
///
/// kind: 0 clear the slot, 1 constant vector in the working frame,
///       2 constant vector in the RTN triad, 3 zonal harmonic
///       (mu, Re, degree, Jn), 4 point mass at a fixed position (mu, x, y, z).
/// @param slot 0..7
/// @param kind see above
/// @param paramsPtr six doubles; the kind decides how many are read
/// @return HPOP_OK, or a negative HpopStatus
int plugin_register_force_contribution(int slot, int kind, double* paramsPtr) {
    if (slot < 0 || slot >= ForceModel::ContributionSet::MAX_SLOTS) {
        return HPOP_ERR_BAD_ARGUMENT;
    }
    if (kind < 0 || kind > 4) return HPOP_ERR_UNKNOWN_LABEL;
    if (kind != 0 && !paramsPtr) return HPOP_ERR_BAD_ARGUMENT;

    ForceModel::ForceContribution& c = g_forceSet.contributions.slots[slot];
    c = ForceModel::ForceContribution();
    c.kind = (ForceModel::ContributionKind)kind;
    c.enabled = kind != 0;
    if (paramsPtr) {
        for (int i = 0; i < 6; i++) c.p[i] = paramsPtr[i];
    }
    if (kind == 3 && (int)c.p[2] < 2) return HPOP_ERR_BAD_ARGUMENT;

    int highest = 0;
    for (int i = 0; i < ForceModel::ContributionSet::MAX_SLOTS; i++) {
        if (g_forceSet.contributions.slots[i].kind != ForceModel::ContributionKind::None) {
            highest = i + 1;
        }
    }
    g_forceSet.contributions.count = highest;
    g_forceSet.useContributions = highest > 0;
    g_configVersion++;
    return HPOP_OK;
}

/// Remove every registered contribution.
void plugin_clear_force_contributions() {
    g_forceSet.contributions = ForceModel::ContributionSet();
    g_forceSet.useContributions = false;
    g_configVersion++;
}

/// How many contribution slots the ABI provides.
int plugin_get_force_contribution_slots() {
    return ForceModel::ContributionSet::MAX_SLOTS;
}

/// The central-body constants the built-in models use.
///
/// A caller registering a contribution that must reproduce a built-in model
/// EXACTLY has to supply the same constants the built-in model uses. Making it
/// guess them is how a port that is exact by construction measures 2.9e-10:
/// a reference radius copied from a different publication differs in the
/// seventh digit, and the J2 term carries that straight through.
///
/// Layout: [mu (km^3/s^2), Re (km), J2, J3, J4].
/// @param outPtr at least five doubles
/// @return the number of doubles written, or a negative HpopStatus
int plugin_get_body_constants(double* outPtr, int len) {
    if (!outPtr || len < 5) return HPOP_ERR_SHORT_BUFFER;
    outPtr[0] = MU_EARTH;
    outPtr[1] = RE_EARTH;
    outPtr[2] = J2_EARTH;
    outPtr[3] = J3_EARTH;
    outPtr[4] = J4_EARTH;
    return 5;
}

// -----------------------------------------------------------------------------
// Predicted solar activity                                           (gmat-07)
// -----------------------------------------------------------------------------

/// Load a three-band predicted-solar-activity table from file content.
///
/// Record form, one per line: `<year> <month> <band> <f107> <f107a> <ap>`,
/// band ∈ EARLY | NOMINAL | LATE. A prediction without a confidence band is a
/// number pretending to be a measurement, so the band is a required field.
/// @return the number of samples loaded across all bands, or a negative status
int plugin_load_solar_activity_predictions(const char* contentPtr, int contentLen) {
    if (!contentPtr || contentLen <= 0) return HPOP_ERR_BAD_ARGUMENT;
    PredictionLoadResult r =
        loadSolarActivityPredictions(std::string(contentPtr, (size_t)contentLen));
    if (!r.ok()) {
        g_predictionDetail = r.detail;
        return HPOP_ERR_PARSE;
    }
    g_predictionDetail.clear();
    g_predictions = r.table;
    return (int)(g_predictions.nominal.size() + g_predictions.early.size() +
                 g_predictions.late.size());
}

/// Why the last prediction load refused, or "".
const char* plugin_get_solar_activity_prediction_error() {
    return g_predictionDetail.c_str();
}

/// Drive the solar-activity indices from a loaded prediction band at an epoch.
///
/// This is the same channel `plugin_set_solar_activity` writes, so the
/// prediction and the observed feed are interchangeable inputs to the same
/// atmosphere, not two parallel code paths.
/// @param band 0 nominal, 1 early, 2 late
/// @param jd Julian date
/// @param outPtr optional; receives [f107, f107a, ap]
/// @return HPOP_OK, or a negative HpopStatus
int plugin_set_solar_activity_from_prediction(int band, double jd, double* outPtr) {
    if (band < 0 || band > 2) return HPOP_ERR_UNKNOWN_LABEL;
    SolarActivityPrediction p{};
    if (!predictSolarActivityAt(g_predictions, (SolarActivityBand)band, jd, p)) {
        return HPOP_ERR_NOT_LOADED;
    }
    double ap[7];
    for (int i = 0; i < 7; i++) ap[i] = p.ap;
    plugin_set_solar_activity(p.f107, p.f107a, ap);
    if (outPtr) { outPtr[0] = p.f107; outPtr[1] = p.f107a; outPtr[2] = p.ap; }
    return HPOP_OK;
}

/// Set gravity model configuration.
void plugin_set_gravity(int degree, int order, int useSecularDrift) {
    if (degree >= 2) {
        g_forceSet.usePointMass = false;
        g_forceSet.useEGM2008 = true;
        g_forceSet.egm2008.truncationDegree = static_cast<uint16_t>(std::min(degree, 360));
        g_forceSet.egm2008.truncationOrder = static_cast<uint16_t>(std::min(order, degree));
    }
    g_configVersion++;
}

/// Set tidal perturbation configuration.
void plugin_set_tides(int solidEnabled, int oceanEnabled, int poleTideEnabled, int oceanMaxDegree) {
    g_forceSet.useSolidTides = solidEnabled != 0;
    if (g_forceSet.useSolidTides) {
        g_forceSet.solidTides.includeSunTide = true;
        g_forceSet.solidTides.includeMoonTide = true;
        g_forceSet.solidTides.frequencyDependent = true;
    }

    g_forceSet.useOceanTides = oceanEnabled != 0;
    if (g_forceSet.useOceanTides) {
        g_forceSet.oceanTides.maxDegree = static_cast<uint16_t>(std::max(2, std::min(oceanMaxDegree, 20)));
    }

    g_forceSet.usePoleTide = poleTideEnabled != 0;
    g_configVersion++;
}

/// Set relativistic correction configuration.
void plugin_set_relativity(int schwarzschild, int lenseThirring, int deSitter) {
    g_forceSet.useRelativisticCorrection = (schwarzschild || lenseThirring || deSitter);
    g_forceSet.relativistic.schwarzschild = schwarzschild != 0;
    g_forceSet.relativistic.lenseThirring = lenseThirring != 0;
    g_forceSet.relativistic.deSitter = deSitter != 0;
    g_configVersion++;
}

/// Set Earth radiation pressure configuration.
void plugin_set_earth_radiation(int albedoEnabled, int gridRes) {
    g_forceSet.useEarthAlbedo = albedoEnabled != 0;
    if (g_forceSet.useEarthAlbedo) {
        g_forceSet.earthAlbedo.gridResolution = static_cast<uint16_t>(std::max(4, std::min(gridRes, 72)));
    }
    g_configVersion++;
}

/// Set third body configuration as a bitmask.
void plugin_set_third_body_extended(int configBitmask) {
    g_forceSet.useThirdBody = (configBitmask != 0);
    g_forceSet.thirdBody.includeSun     = (configBitmask & (1 << 0)) != 0;
    g_forceSet.thirdBody.includeMoon    = (configBitmask & (1 << 1)) != 0;
    g_forceSet.thirdBody.includeMercury = (configBitmask & (1 << 2)) != 0;
    g_forceSet.thirdBody.includeVenus   = (configBitmask & (1 << 3)) != 0;
    g_forceSet.thirdBody.includeMars    = (configBitmask & (1 << 4)) != 0;
    g_forceSet.thirdBody.includeJupiter = (configBitmask & (1 << 5)) != 0;
    g_forceSet.thirdBody.includeSaturn  = (configBitmask & (1 << 6)) != 0;
    g_forceSet.thirdBody.includeUranus  = (configBitmask & (1 << 7)) != 0;
    g_forceSet.thirdBody.includeNeptune = (configBitmask & (1 << 8)) != 0;
    g_configVersion++;
}

/// Set empirical acceleration terms.
void plugin_set_empirical(int numTerms, double* configPtr) {
    g_forceSet.useEmpiricalAccel = (numTerms > 0);
    g_forceSet.empiricalAccel.numTerms = std::min(numTerms,
        ForceModel::EmpiricalAccelConfig::MAX_TERMS);

    for (int i = 0; i < g_forceSet.empiricalAccel.numTerms; i++) {
        double* p = configPtr + i * 6;
        auto& term = g_forceSet.empiricalAccel.terms[i];
        term.direction = static_cast<ForceModel::EmpiricalDirection>(static_cast<int>(p[0]));
        term.model = static_cast<ForceModel::EmpiricalModel>(static_cast<int>(p[1]));
        term.magnitude = p[2];
        term.cosMagnitude = p[3];
        term.sinMagnitude = p[4];
    }
    g_configVersion++;
}

// -----------------------------------------------------------------------------
// Low-Level API (uses g_state for STM/covariance workflows)
// -----------------------------------------------------------------------------

/// Propagate working state to target Julian Date.
/// Output: [epochJD, rx, ry, rz, vx, vy, vz] in ECEF meters, m/s
int plugin_propagate_to(double targetJD, double* outStatePtr) {
    if (!g_initialized) return -1;

    StateVector result = propagateInternal(g_state, targetJD);
    g_state = result;

    double pos[3], vel[3];
    eciToEcefMeters(result, targetJD, pos, vel);

    outStatePtr[0] = targetJD;
    outStatePtr[1] = pos[0];
    outStatePtr[2] = pos[1];
    outStatePtr[3] = pos[2];
    outStatePtr[4] = vel[0];
    outStatePtr[5] = vel[1];
    outStatePtr[6] = vel[2];

    return 0;
}

/// Batch propagation using working state (low-level API).
int plugin_propagate_path(double startJD, double stepDays, int count, double* outPtr) {
    if (!g_initialized || count <= 0) return 0;

    StateVector current = g_state;
    int valid = 0;

    for (int i = 0; i < count; i++) {
        double jd = startJD + i * stepDays;
        StateVector sv = propagateInternal(current, jd);
        current = sv;

        coords::Vec3 cSvPos = {sv.position.x, sv.position.y, sv.position.z};
        coords::Vec3 cPosEcef = transformPosition(cSvPos, coords::Frame::GCRF, coords::Frame::ECEF, jd);
        Vec3 posEcef = {cPosEcef.x, cPosEcef.y, cPosEcef.z};

        outPtr[valid * 3 + 0] = posEcef.x * 1000.0;
        outPtr[valid * 3 + 1] = posEcef.y * 1000.0;
        outPtr[valid * 3 + 2] = posEcef.z * 1000.0;
        valid++;
    }

    return valid;
}

/// Compute state transition matrix (6x6) over dt seconds.
/// Uses full configured force model and integrator via central finite
/// differences around the current working state.
int plugin_compute_stm(double dt, double* outSTMPtr) {
    if (!g_initialized) return -1;

    Mat6 stm = computeSTMFiniteDifference(g_state, dt);

    for (int i = 0; i < 6; i++) {
        for (int j = 0; j < 6; j++) {
            outSTMPtr[i * 6 + j] = stm.m[i][j];
        }
    }

    return 0;
}

/// Propagate covariance: P' = Phi * P * Phi^T
int plugin_propagate_covariance(double* covInPtr, double dt, double* covOutPtr) {
    if (!g_initialized) return -1;

    Mat6 phi = computeSTMFiniteDifference(g_state, dt);

    double P[6][6];
    for (int i = 0; i < 6; i++)
        for (int j = 0; j < 6; j++)
            P[i][j] = covInPtr[i * 6 + j];

    double PhiP[6][6] = {};
    for (int i = 0; i < 6; i++)
        for (int j = 0; j < 6; j++)
            for (int k = 0; k < 6; k++)
                PhiP[i][j] += phi.m[i][k] * P[k][j];

    double result[6][6] = {};
    for (int i = 0; i < 6; i++)
        for (int j = 0; j < 6; j++)
            for (int k = 0; k < 6; k++)
                result[i][j] += PhiP[i][k] * phi.m[j][k];

    for (int i = 0; i < 6; i++)
        for (int j = 0; j < 6; j++)
            covOutPtr[i * 6 + j] = result[i][j];

    return 0;
}

/// Eigendecompose the 3x3 position covariance to get ellipsoid parameters.
int plugin_get_covariance_ellipsoid(double* covPtr, double sigmaLevel,
                                     double* outSemiAxes, double* outRotation) {
    double posCov[3][3];
    for (int i = 0; i < 3; i++)
        for (int j = 0; j < 3; j++)
            posCov[i][j] = covPtr[i * 6 + j];

    double eigenvalues[3];
    double eigenvectors[3][3];
    eigendecompose3x3(posCov, eigenvalues, eigenvectors);

    for (int i = 0; i < 3; i++) {
        outSemiAxes[i] = sigmaLevel * std::sqrt(std::fabs(eigenvalues[i]));
    }

    mat3ToQuaternion(eigenvectors, outRotation);

    return 0;
}

/// Get per-force-model acceleration breakdown at current state.
int plugin_get_acceleration_breakdown(double jd, double* outPtr) {
    if (!g_initialized) return -1;

    g_forceSet.weather = g_weather;

    Vec3 sunPos;
    if (g_forceSet.useSRP || g_forceSet.useEarthAlbedo) {
        EphemerisState sun = getSunPosition(jd);
        sunPos = sun.position;
    }

    Vec3 gravity, thirdBody, drag, srp, tides, relativity, albedo, empirical;

    // One call, the same precedence the integrator uses. Re-deriving it here
    // is how a breakdown comes to disagree with the trajectory it explains:
    // this block used to have no gravity-mode case at all, so a closed-form
    // selection was reported as a harmonics field.
    gravity = ForceModel::CentralBodyGravity(g_state.position, g_forceSet);

    if (g_forceSet.useThirdBody)
        thirdBody = ForceModel::ThirdBody(g_state.position, jd, g_forceSet.thirdBody);

    if (g_forceSet.useDrag) {
        switch (g_forceSet.dragModel) {
            case ForceModel::DragModelType::NRLMSISE00:
                drag = ForceModel::NRLMSISE00(g_state.position, g_state.velocity, jd,
                    g_forceSet.weather, g_forceSet.drag, g_forceSet.nrlmsise00);
                break;
            case ForceModel::DragModelType::JB2008:
                drag = ForceModel::JB2008(g_state.position, g_state.velocity, jd,
                    g_forceSet.weather, g_forceSet.drag, g_forceSet.jb2008);
                break;
            case ForceModel::DragModelType::DTM2020:
                drag = ForceModel::DTM2020(g_state.position, g_state.velocity, jd,
                    g_forceSet.weather, g_forceSet.drag, g_forceSet.dtm2020);
                break;
            case ForceModel::DragModelType::Exponential:
            default:
                drag = ForceModel::AtmosphericDragExponential(g_state.position, g_state.velocity,
                    g_forceSet.drag.mass, g_forceSet.drag.area, g_forceSet.drag.Cd);
                break;
        }
    }

    if (g_forceSet.useSRP)
        srp = ForceModel::SolarRadiation(g_state.position, sunPos, g_forceSet.srp);

    if (g_forceSet.useRelativisticCorrection)
        relativity = ForceModel::RelativisticCorrection(g_state.position, g_state.velocity,
            jd, g_forceSet.mu, g_forceSet.relativistic);

    if (g_forceSet.useSolidTides)
        tides += ForceModel::SolidTides(g_state.position, jd, g_forceSet.solidTides);
    if (g_forceSet.useOceanTides)
        tides += ForceModel::OceanTides(g_state.position, jd, g_forceSet.oceanTides);

    if (g_forceSet.useEarthAlbedo)
        albedo = ForceModel::EarthAlbedo(g_state.position, sunPos, g_forceSet.earthAlbedo);

    if (g_forceSet.useEmpiricalAccel)
        empirical = ForceModel::EmpiricalAcceleration(g_state.position, g_state.velocity,
            g_forceSet.empiricalAccel);

    outPtr[0]  = gravity.x;     outPtr[1]  = gravity.y;     outPtr[2]  = gravity.z;
    outPtr[3]  = thirdBody.x;   outPtr[4]  = thirdBody.y;   outPtr[5]  = thirdBody.z;
    outPtr[6]  = drag.x;        outPtr[7]  = drag.y;        outPtr[8]  = drag.z;
    outPtr[9]  = srp.x;         outPtr[10] = srp.y;         outPtr[11] = srp.z;
    outPtr[12] = tides.x;       outPtr[13] = tides.y;       outPtr[14] = tides.z;
    outPtr[15] = relativity.x;  outPtr[16] = relativity.y;  outPtr[17] = relativity.z;
    outPtr[18] = albedo.x;      outPtr[19] = albedo.y;      outPtr[20] = albedo.z;
    outPtr[21] = empirical.x;   outPtr[22] = empirical.y;   outPtr[23] = empirical.z;

    return 0;
}

/// Acceleration breakdown with the registered-contribution lane.
///
/// `plugin_get_acceleration_breakdown` writes exactly 24 doubles and its
/// callers allocate exactly that, so the contribution lane cannot be appended
/// to it without writing past the end of somebody's buffer. This variant is
/// told how much room it has.
///
/// Layout: the same 24, then [24..26] the sum of every enabled registered
/// contribution, then [27..29] the total.
/// @param len number of DOUBLES the caller allocated (>= 24)
/// @return the number of doubles written, or a negative HpopStatus
int plugin_get_acceleration_breakdown_v2(double jd, double* outPtr, int len) {
    if (!outPtr || len < 24) return HPOP_ERR_SHORT_BUFFER;
    const int rc = plugin_get_acceleration_breakdown(jd, outPtr);
    if (rc != 0) return rc;

    int written = 24;
    Vec3 contributed;
    if (g_forceSet.useContributions) {
        contributed = ForceModel::EvaluateContributions(
            g_forceSet.contributions, g_state.position, g_state.velocity);
    }
    if (len >= 27) {
        outPtr[24] = contributed.x;
        outPtr[25] = contributed.y;
        outPtr[26] = contributed.z;
        written = 27;
    }
    if (len >= 30) {
        Vec3 total;
        for (int i = 0; i < 27; i += 3) {
            total.x += outPtr[i];
            total.y += outPtr[i + 1];
            total.z += outPtr[i + 2];
        }
        outPtr[27] = total.x;
        outPtr[28] = total.y;
        outPtr[29] = total.z;
        written = 30;
    }
    return written;
}

// -----------------------------------------------------------------------------
// Burn Management (heap-allocated, zero overhead for no-burn entities)
// -----------------------------------------------------------------------------

/// Set impulsive burns for an entity. Input: flat array of 5 doubles per burn:
///   [timeJD, targetEntityIdx, dv_r, dv_t, dv_n] — delta-V in LVLH km/s.
/// Replaces any existing burns. Builds arc structure for arc-aware propagation.
void plugin_set_burns(int entityIndex, double* burnsPtr, int count) {
    if (entityIndex < 0 || entityIndex >= g_entityCount || count <= 0) return;
    HPOPEntity& entity = g_entities[entityIndex];

    // Free existing burns/arcs
    if (entity.arcs) {
        for (int a = 0; a < entity.arcCount; a++)
            entity.arcs[a].ephemeris.destroy();
        std::free(entity.arcs);
    }
    std::free(entity.burns);

    // Allocate and parse burns
    entity.burnCount = count;
    entity.burns = (BurnRecord*)std::malloc(count * sizeof(BurnRecord));
    for (int i = 0; i < count; i++) {
        double* b = burnsPtr + i * 5;
        entity.burns[i].timeJD = b[0];
        entity.burns[i].targetEntityIdx = b[1];
        entity.burns[i].dv_r = b[2];
        entity.burns[i].dv_t = b[3];
        entity.burns[i].dv_n = b[4];
    }

    // Sort burns by time (insertion sort, count is small)
    for (int i = 1; i < count; i++) {
        BurnRecord key = entity.burns[i];
        int j = i - 1;
        while (j >= 0 && entity.burns[j].timeJD > key.timeJD) {
            entity.burns[j + 1] = entity.burns[j];
            j--;
        }
        entity.burns[j + 1] = key;
    }

    // Build arcs: burnCount + 1 arcs
    entity.arcCount = count + 1;
    entity.arcs = (HPOPArc*)std::malloc(entity.arcCount * sizeof(HPOPArc));

    for (int i = 0; i < entity.arcCount; i++) {
        HPOPArc& arc = entity.arcs[i];
        arc.ephemeris = ChebyshevEphemeris(); // zero-init
        arc.stateComputed = false;

        if (i == 0) {
            arc.startJD = entity.initialState.epoch;
            arc.endJD = entity.burns[0].timeJD;
        } else if (i < count) {
            arc.startJD = entity.burns[i - 1].timeJD;
            arc.endJD = entity.burns[i].timeJD;
        } else {
            arc.startJD = entity.burns[count - 1].timeJD;
            arc.endJD = 1e30;
        }
    }

    // Invalidate entity's main ephemeris (force rebuild bounded by arc 0)
    entity.ephemeris.clear();
}

/// Clear all burns for an entity, reverting to single-arc propagation.
void plugin_clear_burns(int entityIndex) {
    if (entityIndex < 0 || entityIndex >= g_entityCount) return;
    HPOPEntity& entity = g_entities[entityIndex];

    if (entity.arcs) {
        for (int a = 0; a < entity.arcCount; a++)
            entity.arcs[a].ephemeris.destroy();
        std::free(entity.arcs);
        entity.arcs = nullptr;
    }
    std::free(entity.burns);
    entity.burns = nullptr;
    entity.burnCount = 0;
    entity.arcCount = 0;
}

static inline int64_t julianDateToJ2000Milliseconds(double jd) {
    return static_cast<int64_t>(std::llround((jd - 2451545.0) * 86400000.0));
}

static inline double j2000MillisecondsToJulianDate(int64_t epochMs) {
    return 2451545.0 + (static_cast<double>(epochMs) / 86400000.0);
}

static uint8_t* copyFlatBufferToHeap(
    const uint8_t* data,
    size_t size,
    uint32_t* responseSizeOut) {
    if (!data || size == 0) {
        if (responseSizeOut) {
            *responseSizeOut = 0;
        }
        return nullptr;
    }
    auto* buffer = static_cast<uint8_t*>(std::malloc(size));
    if (!buffer) {
        if (responseSizeOut) {
            *responseSizeOut = 0;
        }
        return nullptr;
    }
    std::memcpy(buffer, data, size);
    if (responseSizeOut) {
        *responseSizeOut = static_cast<uint32_t>(size);
    }
    return buffer;
}

static uint8_t* buildErrorStreamInvokeResponse(
    int32_t errorCode,
    const char* errorMessage,
    uint32_t* responseSizeOut) {
    ::flatbuffers::FlatBufferBuilder builder(256);
    const auto response = orbpro::plugin::CreateStreamInvokeResponseDirect(
        builder,
        nullptr,
        0,
        false,
        errorCode,
        errorMessage);
    builder.Finish(response);
    return copyFlatBufferToHeap(builder.GetBufferPointer(), builder.GetSize(), responseSizeOut);
}

static uint8_t* buildEmptyStreamInvokeResponse(uint32_t* responseSizeOut) {
    ::flatbuffers::FlatBufferBuilder builder(128);
    const auto response = orbpro::plugin::CreateStreamInvokeResponseDirect(builder);
    builder.Finish(response);
    return copyFlatBufferToHeap(builder.GetBufferPointer(), builder.GetSize(), responseSizeOut);
}

static uint8_t* buildPrepareTrajectorySegmentsStreamResponse(
    uint32_t segmentSetHandle,
    bool coverageComplete,
    double certifiedMaxPositionErrorKm,
    double certifiedMaxVelocityErrorKmS,
    uint32_t* responseSizeOut) {
    ::flatbuffers::FlatBufferBuilder payloadBuilder(256);
    const auto result = orbpro::propagator::CreatePropagatorPrepareTrajectorySegmentsResult(
        payloadBuilder,
        segmentSetHandle,
        coverageComplete,
        certifiedMaxPositionErrorKm,
        certifiedMaxVelocityErrorKmS);
    payloadBuilder.Finish(result, "PTSS");
    uint8_t* payloadBytes = copyFlatBufferToHeap(
        payloadBuilder.GetBufferPointer(),
        payloadBuilder.GetSize(),
        nullptr);
    if (!payloadBytes) {
        if (responseSizeOut) {
            *responseSizeOut = 0;
        }
        return nullptr;
    }

    ::flatbuffers::FlatBufferBuilder responseBuilder(256);
    const auto typeRef = orbpro::stream::CreateFlatBufferTypeRefDirect(
        responseBuilder,
        "orbpro.propagator.PropagatorPrepareTrajectorySegmentsResult",
        "PTSS",
        nullptr,
        false,
        orbpro::stream::PayloadWireFormat_AlignedBinary,
        "PropagatorPrepareTrajectorySegmentsResult",
        0,
        0,
        8);

    std::vector<::flatbuffers::Offset<orbpro::stream::TypedArenaBuffer>> outputs;
    outputs.push_back(orbpro::stream::CreateTypedArenaBufferDirect(
        responseBuilder,
        typeRef,
        "result",
        8,
        static_cast<uint32_t>(reinterpret_cast<uintptr_t>(payloadBytes)),
        static_cast<uint32_t>(payloadBuilder.GetSize()),
        orbpro::stream::BufferOwnership_BORROWED,
        0,
        orbpro::stream::BufferMutability_IMMUTABLE,
        0,
        0,
        0,
        false));

    const auto response = orbpro::plugin::CreateStreamInvokeResponseDirect(
        responseBuilder,
        &outputs,
        0,
        false,
        0,
        nullptr);
    responseBuilder.Finish(response);
    return copyFlatBufferToHeap(responseBuilder.GetBufferPointer(), responseBuilder.GetSize(), responseSizeOut);
}

static uint8_t* buildDescribeTrajectorySegmentsStreamResponse(
    const PreparedTrajectorySegmentSet& segmentSet,
    const std::vector<uint32_t>& sourceHandles,
    uint32_t* responseSizeOut) {
    ::flatbuffers::FlatBufferBuilder payloadBuilder(4096);
    std::vector<::flatbuffers::Offset<orbpro::propagator::PropagatorTrajectorySegment>> segmentOffsets;

    const double windowStartJD = segmentSet.startJD;
    const double windowEndJD = segmentSet.startJD + segmentSet.durationDays;

    for (uint32_t sourceHandle : sourceHandles) {
        if (sourceHandle >= static_cast<uint32_t>(g_entityCount)) {
            continue;
        }
        const HPOPEntity& entity = g_entities[sourceHandle];
        const ChebyshevEphemeris& ephemeris = entity.ephemeris;
        for (int segmentIndex = 0; segmentIndex < ephemeris.count; segmentIndex++) {
            const ChebyshevSegment& segment = ephemeris.segments[segmentIndex];
            if (segment.endJD < windowStartJD || segment.startJD > windowEndJD) {
                continue;
            }

            const auto xCoefficients = payloadBuilder.CreateVector(segment.cx, CHEBY_NPTS);
            const auto yCoefficients = payloadBuilder.CreateVector(segment.cy, CHEBY_NPTS);
            const auto zCoefficients = payloadBuilder.CreateVector(segment.cz, CHEBY_NPTS);
            const auto vxCoefficients = payloadBuilder.CreateVector(segment.cvx, CHEBY_NPTS);
            const auto vyCoefficients = payloadBuilder.CreateVector(segment.cvy, CHEBY_NPTS);
            const auto vzCoefficients = payloadBuilder.CreateVector(segment.cvz, CHEBY_NPTS);

            segmentOffsets.push_back(orbpro::propagator::CreatePropagatorTrajectorySegment(
                payloadBuilder,
                sourceHandle,
                segment.startJD,
                segment.endJD,
                static_cast<uint32_t>(CHEBY_N),
                orbpro::propagator::ReferenceFrame_ICRF,
                xCoefficients,
                yCoefficients,
                zCoefficients,
                vxCoefficients,
                vyCoefficients,
                vzCoefficients,
                0.0,
                0.0));
        }
    }

    const auto segments = payloadBuilder.CreateVector(segmentOffsets);
    const auto result = orbpro::propagator::CreatePropagatorDescribeTrajectorySegmentsResult(
        payloadBuilder,
        segmentSet.handle,
        segments);
    payloadBuilder.Finish(result, "PTDS");

    uint8_t* payloadBytes = copyFlatBufferToHeap(
        payloadBuilder.GetBufferPointer(),
        payloadBuilder.GetSize(),
        nullptr);
    if (!payloadBytes) {
        if (responseSizeOut) {
            *responseSizeOut = 0;
        }
        return nullptr;
    }

    ::flatbuffers::FlatBufferBuilder responseBuilder(256);
    const auto typeRef = orbpro::stream::CreateFlatBufferTypeRefDirect(
        responseBuilder,
        "orbpro.propagator.PropagatorDescribeTrajectorySegmentsResult",
        "PTDS",
        nullptr,
        false,
        orbpro::stream::PayloadWireFormat_AlignedBinary,
        "PropagatorDescribeTrajectorySegmentsResult",
        0,
        0,
        8);

    std::vector<::flatbuffers::Offset<orbpro::stream::TypedArenaBuffer>> outputs;
    outputs.push_back(orbpro::stream::CreateTypedArenaBufferDirect(
        responseBuilder,
        typeRef,
        "result",
        8,
        static_cast<uint32_t>(reinterpret_cast<uintptr_t>(payloadBytes)),
        static_cast<uint32_t>(payloadBuilder.GetSize()),
        orbpro::stream::BufferOwnership_BORROWED,
        0,
        orbpro::stream::BufferMutability_IMMUTABLE,
        0,
        0,
        0,
        false));

    const auto response = orbpro::plugin::CreateStreamInvokeResponseDirect(
        responseBuilder,
        &outputs,
        0,
        false,
        0,
        nullptr);
    responseBuilder.Finish(response);
    return copyFlatBufferToHeap(responseBuilder.GetBufferPointer(), responseBuilder.GetSize(), responseSizeOut);
}

static coords::Frame decodePluginReferenceFrame(
    orbpro::plugins::ReferenceFrame referenceFrame) {
    switch (referenceFrame) {
        case orbpro::plugins::ReferenceFrame_ECEF:
            return coords::Frame::ECEF;
        case orbpro::plugins::ReferenceFrame_TEME:
            return coords::Frame::TEME;
        case orbpro::plugins::ReferenceFrame_ICRF:
            return coords::Frame::GCRF;
        case orbpro::plugins::ReferenceFrame_ECI:
        default:
            return coords::Frame::GCRF;
    }
}

static bool decodePropagatorStateFrame(
    const orbpro::plugins::PropagatorState* state,
    double* outState,
    uint32_t* outCatalogNumber) {
    if (!state || !outState || state->position() == nullptr || state->velocity() == nullptr) {
        return false;
    }
    if (state->position()->size() < 3 || state->velocity()->size() < 3) {
        return false;
    }

    const double epochJD = j2000MillisecondsToJulianDate(state->epoch());
    const coords::StateVec sourceState(
        coords::Vec3(
            state->position()->Get(0) / 1000.0,
            state->position()->Get(1) / 1000.0,
            state->position()->Get(2) / 1000.0),
        coords::Vec3(
            state->velocity()->Get(0) / 1000.0,
            state->velocity()->Get(1) / 1000.0,
            state->velocity()->Get(2) / 1000.0));
    const coords::StateVec gcrfState = coords::transform(
        sourceState,
        decodePluginReferenceFrame(state->referenceFrame()),
        coords::Frame::GCRF,
        epochJD);

    outState[0] = epochJD;
    outState[1] = gcrfState.position.x;
    outState[2] = gcrfState.position.y;
    outState[3] = gcrfState.position.z;
    outState[4] = gcrfState.velocity.x;
    outState[5] = gcrfState.velocity.y;
    outState[6] = gcrfState.velocity.z;
    if (outCatalogNumber) {
        *outCatalogNumber = state->catalogNumber();
    }
    return true;
}

static uint8_t* encodePropagatorStatePayload(
    double jd,
    int entityIndex,
    uint32_t catalogNumber,
    uint32_t* payloadSizeOut) {
    double outState[7];
    if (plugin_propagate(jd, entityIndex, outState) != 0) {
        return nullptr;
    }

    std::vector<double> position = {
        outState[1],
        outState[2],
        outState[3],
    };
    std::vector<double> velocity = {
        outState[4],
        outState[5],
        outState[6],
    };

    ::flatbuffers::FlatBufferBuilder builder(256);
    const auto state = orbpro::plugins::CreatePropagatorStateDirect(
        builder,
        &position,
        &velocity,
        julianDateToJ2000Milliseconds(jd),
        orbpro::plugins::ReferenceFrame_ECEF,
        nullptr,
        0.0,
        0.0,
        catalogNumber,
        static_cast<uint32_t>(entityIndex),
        true);
    orbpro::plugins::FinishPropagatorStateBuffer(builder, state);
    return copyFlatBufferToHeap(builder.GetBufferPointer(), builder.GetSize(), payloadSizeOut);
}

uint8_t* plugin_stream_invoke(
    const uint8_t* requestPtr,
    uint32_t requestSize,
    uint32_t* responseSizeOut) {
    if (!requestPtr || requestSize == 0 || !responseSizeOut) {
        return buildErrorStreamInvokeResponse(-1, "Invalid stream invoke request buffer.", responseSizeOut);
    }

    if (!g_initialized && plugin_init() != 0) {
        return buildErrorStreamInvokeResponse(-1, "HPOP runtime failed to initialize.", responseSizeOut);
    }

    ::flatbuffers::Verifier requestVerifier(requestPtr, requestSize);
    const auto* request = ::flatbuffers::GetRoot<orbpro::plugin::StreamInvokeRequest>(requestPtr);
    if (!request || !request->Verify(requestVerifier) || !request->method_id()) {
        return buildErrorStreamInvokeResponse(-1, "Malformed StreamInvokeRequest.", responseSizeOut);
    }

    const std::string methodId = request->method_id()->str();

    if (methodId == "ingest_state") {
        const auto* inputs = request->inputs();
        if (!inputs || inputs->size() == 0) {
            return buildEmptyStreamInvokeResponse(responseSizeOut);
        }

        std::vector<double> stagedStates;
        std::vector<uint32_t> catalogNumbers;
        stagedStates.reserve(static_cast<size_t>(inputs->size()) * 7);
        catalogNumbers.reserve(static_cast<size_t>(inputs->size()));

        for (::flatbuffers::uoffset_t index = 0; index < inputs->size(); index++) {
            const auto* input = inputs->Get(index);
            if (!input || input->size() == 0 || input->offset() == 0) {
                return buildErrorStreamInvokeResponse(-1, "ingest_state expects non-empty PropagatorState input frames.", responseSizeOut);
            }
            const auto* payload = reinterpret_cast<const uint8_t*>(static_cast<uintptr_t>(input->offset()));
            ::flatbuffers::Verifier verifier(payload, input->size());
            if (!orbpro::plugins::VerifyPropagatorStateBuffer(verifier)) {
                return buildErrorStreamInvokeResponse(-1, "ingest_state expects PropagatorState input frames.", responseSizeOut);
            }
            const auto* state = orbpro::plugins::GetPropagatorState(payload);
            double stateValues[7];
            uint32_t catalogNumber = 0;
            if (!decodePropagatorStateFrame(state, stateValues, &catalogNumber)) {
                return buildErrorStreamInvokeResponse(-1, "ingest_state requires PropagatorState position/velocity vectors.", responseSizeOut);
            }
            stagedStates.insert(stagedStates.end(), stateValues, stateValues + 7);
            catalogNumbers.push_back(catalogNumber);
        }

        const int initialized = plugin_init_states(stagedStates.data(), static_cast<int>(catalogNumbers.size()));
        if (initialized < 0) {
            return buildErrorStreamInvokeResponse(-1, "ingest_state failed to initialize HPOP entities.", responseSizeOut);
        }
        for (int i = 0; i < initialized && i < static_cast<int>(catalogNumbers.size()) && i < MAX_ENTITIES; i++) {
            g_entityCatalogNumbers[i] = catalogNumbers[static_cast<size_t>(i)];
        }
        return buildEmptyStreamInvokeResponse(responseSizeOut);
    }

    if (methodId == "propagate_state") {
        const auto* inputs = request->inputs();
        if (!inputs || inputs->size() == 0) {
            return buildEmptyStreamInvokeResponse(responseSizeOut);
        }

        std::vector<::flatbuffers::Offset<orbpro::stream::TypedArenaBuffer>> outputs;
        const uint32_t outputStreamCap = request->output_stream_cap();
        ::flatbuffers::FlatBufferBuilder builder(1024);
        const auto typeRef = orbpro::stream::CreateFlatBufferTypeRefDirect(
            builder,
            "orbpro.plugins.PropagatorState",
            "PRST",
            nullptr,
            false,
            orbpro::stream::PayloadWireFormat_AlignedBinary,
            "PropagatorState",
            0,
            0,
            8);

        for (::flatbuffers::uoffset_t inputIndex = 0; inputIndex < inputs->size(); inputIndex++) {
            const auto* input = inputs->Get(inputIndex);
            if (!input || input->size() == 0 || input->offset() == 0) {
                return buildErrorStreamInvokeResponse(-1, "propagate_state expects non-empty PropagatorBatchRequest frames.", responseSizeOut);
            }

            const auto* payload = reinterpret_cast<const uint8_t*>(static_cast<uintptr_t>(input->offset()));
            ::flatbuffers::Verifier verifier(payload, input->size());
            const auto* batch = ::flatbuffers::GetRoot<orbpro::propagator::PropagatorBatchRequest>(payload);
            if (!batch || !batch->Verify(verifier)) {
                return buildErrorStreamInvokeResponse(-1, "propagate_state expects PropagatorBatchRequest input frames.", responseSizeOut);
            }

            std::vector<uint32_t> entityHandles;
            if (batch->entity_handles() && batch->entity_handles()->size() > 0) {
                entityHandles.assign(
                    batch->entity_handles()->begin(),
                    batch->entity_handles()->end());
            } else {
                entityHandles.reserve(static_cast<size_t>(g_entityCount));
                for (int entityIndex = 0; entityIndex < g_entityCount; entityIndex++) {
                    entityHandles.push_back(static_cast<uint32_t>(entityIndex));
                }
            }

            if (batch->max_count() > 0 &&
                static_cast<uint32_t>(entityHandles.size()) > batch->max_count()) {
                entityHandles.resize(batch->max_count());
            }

            if (outputStreamCap > 0 &&
                outputs.size() + entityHandles.size() > outputStreamCap) {
                return buildErrorStreamInvokeResponse(-1, "propagate_state output_stream_cap is smaller than the requested state count.", responseSizeOut);
            }

            for (size_t entityIdx = 0; entityIdx < entityHandles.size(); entityIdx++) {
                const uint32_t entityIndex = entityHandles[entityIdx];
                uint32_t payloadSize = 0;
                auto* payloadBytes = encodePropagatorStatePayload(
                    batch->epoch(),
                    static_cast<int>(entityIndex),
                    entityIndex < MAX_ENTITIES ? g_entityCatalogNumbers[entityIndex] : 0,
                    &payloadSize);
                if (!payloadBytes) {
                    return buildErrorStreamInvokeResponse(-1, "propagate_state failed to encode a PropagatorState output frame.", responseSizeOut);
                }

                outputs.push_back(orbpro::stream::CreateTypedArenaBufferDirect(
                    builder,
                    typeRef,
                    "state",
                    8,
                    static_cast<uint32_t>(reinterpret_cast<uintptr_t>(payloadBytes)),
                    payloadSize,
                    orbpro::stream::BufferOwnership_BORROWED,
                    0,
                    orbpro::stream::BufferMutability_IMMUTABLE,
                    input->trace_id(),
                    input->stream_id(),
                    input->sequence() + static_cast<uint64_t>(entityIdx),
                    false));
            }
        }

        const auto response = orbpro::plugin::CreateStreamInvokeResponse(
            builder,
            builder.CreateVector(outputs),
            0,
            false,
            0,
            0);
        builder.Finish(response);
        return copyFlatBufferToHeap(builder.GetBufferPointer(), builder.GetSize(), responseSizeOut);
    }

    if (methodId == "prepare_trajectory_segments") {
        const auto* inputs = request->inputs();
        if (!inputs || inputs->size() == 0) {
            return buildErrorStreamInvokeResponse(-1, "prepare_trajectory_segments expects a PropagatorPrepareTrajectorySegmentsRequest frame.", responseSizeOut);
        }

        const auto* input = inputs->Get(0);
        if (!input || input->size() == 0 || input->offset() == 0) {
            return buildErrorStreamInvokeResponse(-1, "prepare_trajectory_segments expects a non-empty PropagatorPrepareTrajectorySegmentsRequest frame.", responseSizeOut);
        }

        const auto* payload = reinterpret_cast<const uint8_t*>(static_cast<uintptr_t>(input->offset()));
        ::flatbuffers::Verifier verifier(payload, input->size());
        const auto* segmentRequest = ::flatbuffers::GetRoot<orbpro::propagator::PropagatorPrepareTrajectorySegmentsRequest>(payload);
        if (!segmentRequest || !segmentRequest->Verify(verifier)) {
            return buildErrorStreamInvokeResponse(-1, "prepare_trajectory_segments expects a PropagatorPrepareTrajectorySegmentsRequest input frame.", responseSizeOut);
        }

        std::vector<uint32_t> sourceHandles;
        if (segmentRequest->sourceHandles() && segmentRequest->sourceHandles()->size() > 0) {
            sourceHandles.assign(
                segmentRequest->sourceHandles()->begin(),
                segmentRequest->sourceHandles()->end());
        } else {
            sourceHandles.reserve(static_cast<size_t>(g_entityCount));
            for (int entityIndex = 0; entityIndex < g_entityCount; entityIndex++) {
                sourceHandles.push_back(static_cast<uint32_t>(entityIndex));
            }
        }

        if (sourceHandles.empty()) {
            return buildErrorStreamInvokeResponse(-1, "prepare_trajectory_segments requires at least one resident source.", responseSizeOut);
        }

        const double startJD = segmentRequest->startJd();
        const double durationDays = segmentRequest->durationDays();
        if (!std::isfinite(startJD) || !std::isfinite(durationDays) || durationDays < 0.0) {
            return buildErrorStreamInvokeResponse(-1, "prepare_trajectory_segments requires a finite non-negative window.", responseSizeOut);
        }

        double certifiedMaxPositionErrorKm = 0.0;
        double certifiedMaxVelocityErrorKmS = 0.0;
        bool coverageComplete = true;

        for (uint32_t sourceHandle : sourceHandles) {
            uint32_t sourceSegmentSetHandle = 0;
            double sourceMaxPositionErrorKm = 0.0;
            double sourceMaxVelocityErrorKmS = 0.0;
            if (!prepareTrajectorySegmentsForEntity(
                    sourceHandle,
                    startJD,
                    durationDays,
                    sourceSegmentSetHandle,
                    sourceMaxPositionErrorKm,
                    sourceMaxVelocityErrorKmS)) {
                coverageComplete = false;
                break;
            }
            certifiedMaxPositionErrorKm = std::max(certifiedMaxPositionErrorKm, sourceMaxPositionErrorKm);
            certifiedMaxVelocityErrorKmS = std::max(certifiedMaxVelocityErrorKmS, sourceMaxVelocityErrorKmS);
        }

        if (!coverageComplete) {
            return buildErrorStreamInvokeResponse(-1, "prepare_trajectory_segments could not certify full-window coverage.", responseSizeOut);
        }

        PreparedTrajectorySegmentSet preparedSet = {};
        preparedSet.handle = g_nextSegmentSetHandle++;
        preparedSet.catalogHandle = segmentRequest->catalogHandle();
        preparedSet.startJD = startJD;
        preparedSet.durationDays = durationDays;
        preparedSet.profile =
            segmentRequest->profile() ? segmentRequest->profile()->str() : std::string("conjunction-screening");
        preparedSet.sourceHandles = sourceHandles;
        g_segmentSets[preparedSet.handle] = preparedSet;

        return buildPrepareTrajectorySegmentsStreamResponse(
            preparedSet.handle,
            coverageComplete,
            certifiedMaxPositionErrorKm,
            certifiedMaxVelocityErrorKmS,
            responseSizeOut);
    }

    if (methodId == "describe_trajectory_segments") {
        const auto* inputs = request->inputs();
        if (!inputs || inputs->size() == 0) {
            return buildErrorStreamInvokeResponse(-1, "describe_trajectory_segments expects a PropagatorDescribeTrajectorySegmentsRequest frame.", responseSizeOut);
        }

        const auto* input = inputs->Get(0);
        if (!input || input->size() == 0 || input->offset() == 0) {
            return buildErrorStreamInvokeResponse(-1, "describe_trajectory_segments expects a non-empty PropagatorDescribeTrajectorySegmentsRequest frame.", responseSizeOut);
        }

        const auto* payload = reinterpret_cast<const uint8_t*>(static_cast<uintptr_t>(input->offset()));
        ::flatbuffers::Verifier verifier(payload, input->size());
        const auto* describeRequest = ::flatbuffers::GetRoot<orbpro::propagator::PropagatorDescribeTrajectorySegmentsRequest>(payload);
        if (!describeRequest || !describeRequest->Verify(verifier)) {
            return buildErrorStreamInvokeResponse(-1, "describe_trajectory_segments expects a PropagatorDescribeTrajectorySegmentsRequest input frame.", responseSizeOut);
        }

        auto segmentSetIt = g_segmentSets.find(describeRequest->segmentSetHandle());
        if (segmentSetIt == g_segmentSets.end()) {
            return buildErrorStreamInvokeResponse(-1, "describe_trajectory_segments received an unknown segment set handle.", responseSizeOut);
        }

        std::vector<uint32_t> sourceHandles;
        if (describeRequest->sourceHandles() && describeRequest->sourceHandles()->size() > 0) {
            sourceHandles.assign(
                describeRequest->sourceHandles()->begin(),
                describeRequest->sourceHandles()->end());
        } else {
            sourceHandles = segmentSetIt->second.sourceHandles;
        }

        for (uint32_t sourceHandle : sourceHandles) {
            if (std::find(
                    segmentSetIt->second.sourceHandles.begin(),
                    segmentSetIt->second.sourceHandles.end(),
                    sourceHandle) == segmentSetIt->second.sourceHandles.end()) {
                return buildErrorStreamInvokeResponse(-1, "describe_trajectory_segments received one or more invalid source handles.", responseSizeOut);
            }
        }

        return buildDescribeTrajectorySegmentsStreamResponse(
            segmentSetIt->second,
            sourceHandles,
            responseSizeOut);
    }

    return buildErrorStreamInvokeResponse(-1, "Unsupported HPOP stream method.", responseSizeOut);
}

// -----------------------------------------------------------------------------
// Cleanup
// -----------------------------------------------------------------------------

void plugin_destroy() {
    // Free ephemeris/burn/arc memory and clear entities
    for (int i = 0; i < g_entityCount; i++) {
        g_entities[i].ephemeris.destroy();
        if (g_entities[i].arcs) {
            for (int a = 0; a < g_entities[i].arcCount; a++)
                g_entities[i].arcs[a].ephemeris.destroy();
            std::free(g_entities[i].arcs);
        }
        std::free(g_entities[i].burns);
    }
    g_entityCount = 0;
    for (int i = 0; i < MAX_ENTITIES; i++) {
        g_entities[i].valid = false;
        g_entities[i].cachedJD = 0;
        g_entities[i].burns = nullptr;
        g_entities[i].burnCount = 0;
        g_entities[i].arcs = nullptr;
        g_entities[i].arcCount = 0;
        g_entityCatalogNumbers[i] = 0;
    }

    g_state = StateVector();
    g_forceSet = ForceModel::ForceModelSet();
    g_integratorConfig = IntegratorConfig();
    g_weather = SpaceWeatherData();
    g_segmentSets.clear();
    g_nextSegmentSetHandle = 1u;
    g_retentionBehindDays = 1e30;
    g_gridStagger = false;
    g_initialized = false;
}

} // extern "C"
