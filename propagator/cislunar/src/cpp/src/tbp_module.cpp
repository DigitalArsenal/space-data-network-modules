/*
 * propagator/cislunar — CR3BP operations on the SDS Three-Body Problem standard (typed contracts 1.0).
 *
 *   invoke — one "request" frame, a $TBP whose PROBLEM names the question and whose SYSTEM names the two primaries
 *            -> one "response" frame, a $TBP: the same PROBLEM and SYSTEM, STATUS, and the answer fields.
 *
 * build.mjs inlines, ahead of this file, the generated SDS headers ($TBP and the standards it includes, in include
 * order) and the CR3BP core (include/cislunar/{constants,types,cr3bp}.h + src/cr3bp.cpp), so the numerics are the
 * module's own unchanged code.
 *
 * Problems answered (request fields -> answer fields):
 *   Propagation         PROPAGATION {INITIAL_STATE, DURATION, STEP (0 = 0.001), OUTPUT_POINTS (0 = 1000),
 *                       STATE_TRANSITION} -> TRAJECTORY {TIMES, STATES, STATE_TRANSITION when asked, JACOBI}.
 *   LibrationPoints     -> LIBRATION_POINTS L1..L5: position, Jacobi constant, eigenvalues of the linearised
 *                       dynamics, STABLE (collinear points never; L4/L5 when MASS_RATIO < Routh's 0.03852).
 *   JacobiConstant      STATE -> STATE, JACOBI.
 *   PeriodicOrbit       ORBITS[0] {FAMILY HaloNorthern|HaloSouthern (Unspecified = HaloNorthern), LIBRATION_POINT
 *                       L1|L2 (UNSPECIFIED = L2), AMPLITUDE (Az), TOLERANCE (0 = 1e-12), MAX_ITERATIONS (0 = 100)}
 *                       -> ORBITS[0] corrected: INITIAL_STATE, PERIOD, PERIOD_S, JACOBI, CONVERGED, ITERATIONS,
 *                       MONODROMY (one full period), FLOQUET_*, STABILITY_INDEX, STABLE, TRAJECTORY (one period).
 *   HaloFirstGuess      ORBITS[0] {FAMILY, LIBRATION_POINT, AMPLITUDE} -> ORBITS[0] {INITIAL_STATE, CORRECTED false}.
 *   NearRectilinearHalo ORBITS[0] {LIBRATION_POINT, PERILUNE_ALTITUDE_KM (0 = 3500), APOLUNE_ALTITUDE_KM (0 = 70000),
 *                       TOLERANCE, MAX_ITERATIONS} -> ORBITS[0] as PeriodicOrbit, FAMILY NearRectilinearHalo.
 *   Transfer            TRANSFER {KIND LowEnergy (Unspecified = LowEnergy) | FreeReturn | PeriodicOrbitInsertion
 *                       (TARGET_ORBIT.INITIAL_STATE), PARKING_ALTITUDE_KM, TARGET_ALTITUDE_KM, INCLINATION_DEG}
 *                       -> TRANSFER {CONVERGED, BURNS "departure" + "arrival" ($MPL burns, Inertial axes, km/s),
 *                       TOTAL_DELTA_V_KM_S, TIME_OF_FLIGHT_S}.
 *   StationKeeping      STATION_KEEPING {ORBIT {INITIAL_STATE, PERIOD, JACOBI, MONODROMY optional},
 *                       NAVIGATION_ERROR_KM, EXECUTION_ERROR_FRACTION, CYCLES (0 = 12)} -> the budget in km/s.
 *   FrameConversion     FRAME_CONVERSION {DIRECTION, ELAPSED_S, SYNODIC | INERTIAL (km, km/s)} -> the other one.
 *
 * Units on the wire are the standard's: lengths km, speeds km/s, angles deg. The core works in m, m/s and rad; the
 * conversions are exact scalings (x 1000, / 1000, x DEG_TO_RAD). Libration points are rfmLibrationPoint (L1 = 1);
 * the core's LagrangePoint counts from 0.
 *
 * A request this module cannot answer (no SYSTEM, a problem or family it does not implement) is answered in band:
 * STATUS InvalidRequest with ERROR_CODE / ERROR_MESSAGE. A frame that is not a verifiable $TBP fails the invoke.
 */

#include <algorithm>
#include <array>
#include <cfloat>
#include <cmath>
#include <cstdint>
#include <string>
#include <vector>

#include "space_data_module_invoke.h"
#include "TBP_generated.h"  // spacedatastandards.org lib/cpp/{RFM,...,MPL,TBP}/main_generated.h, inlined by build.mjs

namespace {

using namespace cislunar;
namespace fb = flatbuffers;

constexpr const char* kProducer = "cislunar-propagator";

// ---------------------------------------------------------------------------
// Eigenvalues of a real 6x6 matrix: reduction to upper Hessenberg form by stabilised elementary similarity
// transformations, then the shifted QR algorithm (elmhes + hqr, Numerical Recipes 3rd ed. section 11.6).
// ---------------------------------------------------------------------------
using Mat6 = std::array<std::array<double, 6>, 6>;

void to_hessenberg(Mat6& a) {
    const int n = 6;
    for (int m = 1; m < n - 1; ++m) {
        double x = 0.0;
        int i = m;
        for (int j = m; j < n; ++j) {
            if (std::fabs(a[j][m - 1]) > std::fabs(x)) {
                x = a[j][m - 1];
                i = j;
            }
        }
        if (i != m) {
            for (int j = m - 1; j < n; ++j) std::swap(a[i][j], a[m][j]);
            for (int j = 0; j < n; ++j) std::swap(a[j][i], a[j][m]);
        }
        if (x != 0.0) {
            for (i = m + 1; i < n; ++i) {
                double y = a[i][m - 1];
                if (y != 0.0) {
                    y /= x;
                    a[i][m - 1] = y;
                    for (int j = m; j < n; ++j) a[i][j] -= y * a[m][j];
                    for (int j = 0; j < n; ++j) a[j][m] += y * a[j][i];
                }
            }
        }
    }
    for (int r = 2; r < n; ++r)
        for (int c = 0; c < r - 1; ++c) a[r][c] = 0.0;
}

double sign_of(double a, double b) { return b >= 0.0 ? std::fabs(a) : -std::fabs(a); }

bool hessenberg_eigenvalues(Mat6 a, std::array<double, 6>& wr, std::array<double, 6>& wi) {
    const int n = 6;
    int nn, m, l, k, j, its, i, mmin;
    double z = 0.0, y, x, w, v, u, t, s, r = 0.0, q = 0.0, p = 0.0, anorm = 0.0;
    const double eps = DBL_EPSILON;
    for (i = 0; i < n; ++i)
        for (j = std::max(i - 1, 0); j < n; ++j) anorm += std::fabs(a[i][j]);
    nn = n - 1;
    t = 0.0;
    while (nn >= 0) {
        its = 0;
        do {
            for (l = nn; l > 0; --l) {
                s = std::fabs(a[l - 1][l - 1]) + std::fabs(a[l][l]);
                if (s == 0.0) s = anorm;
                if (std::fabs(a[l][l - 1]) <= eps * s) {
                    a[l][l - 1] = 0.0;
                    break;
                }
            }
            x = a[nn][nn];
            if (l == nn) {
                wr[nn] = x + t;
                wi[nn--] = 0.0;
            } else {
                y = a[nn - 1][nn - 1];
                w = a[nn][nn - 1] * a[nn - 1][nn];
                if (l == nn - 1) {
                    p = 0.5 * (y - x);
                    q = p * p + w;
                    z = std::sqrt(std::fabs(q));
                    x += t;
                    if (q >= 0.0) {
                        z = p + sign_of(z, p);
                        wr[nn - 1] = wr[nn] = x + z;
                        if (z != 0.0) wr[nn] = x - w / z;
                        wi[nn - 1] = wi[nn] = 0.0;
                    } else {
                        wr[nn - 1] = wr[nn] = x + p;
                        wi[nn - 1] = -(wi[nn] = z);
                    }
                    nn -= 2;
                } else {
                    if (its == 60) return false;
                    if (its == 10 || its == 20) {
                        t += x;
                        for (i = 0; i < nn + 1; ++i) a[i][i] -= x;
                        s = std::fabs(a[nn][nn - 1]) + std::fabs(a[nn - 1][nn - 2]);
                        y = x = 0.75 * s;
                        w = -0.4375 * s * s;
                    }
                    ++its;
                    for (m = nn - 2; m >= l; --m) {
                        z = a[m][m];
                        r = x - z;
                        s = y - z;
                        p = (r * s - w) / a[m + 1][m] + a[m][m + 1];
                        q = a[m + 1][m + 1] - z - r - s;
                        r = a[m + 2][m + 1];
                        s = std::fabs(p) + std::fabs(q) + std::fabs(r);
                        p /= s;
                        q /= s;
                        r /= s;
                        if (m == l) break;
                        u = std::fabs(a[m][m - 1]) * (std::fabs(q) + std::fabs(r));
                        v = std::fabs(p) * (std::fabs(a[m - 1][m - 1]) + std::fabs(z) + std::fabs(a[m + 1][m + 1]));
                        if (u <= eps * v) break;
                    }
                    for (i = m; i < nn - 1; ++i) {
                        a[i + 2][i] = 0.0;
                        if (i != m) a[i + 2][i - 1] = 0.0;
                    }
                    for (k = m; k < nn; ++k) {
                        if (k != m) {
                            p = a[k][k - 1];
                            q = a[k + 1][k - 1];
                            r = 0.0;
                            if (k + 1 != nn) r = a[k + 2][k - 1];
                            if ((x = std::fabs(p) + std::fabs(q) + std::fabs(r)) != 0.0) {
                                p /= x;
                                q /= x;
                                r /= x;
                            }
                        }
                        if ((s = sign_of(std::sqrt(p * p + q * q + r * r), p)) != 0.0) {
                            if (k == m) {
                                if (l != m) a[k][k - 1] = -a[k][k - 1];
                            } else {
                                a[k][k - 1] = -s * x;
                            }
                            p += s;
                            x = p / s;
                            y = q / s;
                            z = r / s;
                            q /= p;
                            r /= p;
                            for (j = k; j < nn + 1; ++j) {
                                p = a[k][j] + q * a[k + 1][j];
                                if (k + 1 != nn) {
                                    p += r * a[k + 2][j];
                                    a[k + 2][j] -= p * z;
                                }
                                a[k + 1][j] -= p * y;
                                a[k][j] -= p * x;
                            }
                            mmin = nn < k + 3 ? nn : k + 3;
                            for (i = l; i < mmin + 1; ++i) {
                                p = x * a[i][k] + y * a[i][k + 1];
                                if (k + 1 != nn) {
                                    p += z * a[i][k + 2];
                                    a[i][k + 2] -= p * r;
                                }
                                a[i][k + 1] -= p * q;
                                a[i][k] -= p;
                            }
                        }
                    }
                }
            }
        } while (l + 1 < nn);
    }
    return true;
}

bool eigenvalues(Mat6 a, std::vector<double>& re, std::vector<double>& im) {
    to_hessenberg(a);
    std::array<double, 6> wr{}, wi{};
    if (!hessenberg_eigenvalues(a, wr, wi)) return false;
    re.assign(wr.begin(), wr.end());
    im.assign(wi.begin(), wi.end());
    return true;
}

// The linearised CR3BP at a point (second partials of the pseudo-potential plus the Coriolis terms).
Mat6 linearised_dynamics(double x, double y, double z, double mu) {
    const double dx1 = x + mu, dx2 = x - 1.0 + mu;
    const double r1 = std::sqrt(dx1 * dx1 + y * y + z * z);
    const double r2 = std::sqrt(dx2 * dx2 + y * y + z * z);
    const double a1 = (1.0 - mu) / (r1 * r1 * r1), a2 = mu / (r2 * r2 * r2);
    const double b1 = 3.0 * (1.0 - mu) / std::pow(r1, 5.0), b2 = 3.0 * mu / std::pow(r2, 5.0);
    const double uxx = 1.0 - a1 - a2 + b1 * dx1 * dx1 + b2 * dx2 * dx2;
    const double uyy = 1.0 - a1 - a2 + (b1 + b2) * y * y;
    const double uzz = -a1 - a2 + (b1 + b2) * z * z;
    const double uxy = (b1 * dx1 + b2 * dx2) * y;
    const double uxz = (b1 * dx1 + b2 * dx2) * z;
    const double uyz = (b1 + b2) * y * z;
    Mat6 a{};
    a[0][3] = a[1][4] = a[2][5] = 1.0;
    a[3] = {uxx, uxy, uxz, 0.0, 2.0, 0.0};
    a[4] = {uxy, uyy, uyz, -2.0, 0.0, 0.0};
    a[5] = {uxz, uyz, uzz, 0.0, 0.0, 0.0};
    return a;
}

// State transition matrix over one full period from the corrected initial state, in equal RK4 steps no longer
// than the core's 0.001 (the corrector's own STM stops at the half-period crossing).
Mat6 full_period_monodromy(const CR3BPState& s, double period, double mu) {
    std::vector<double> aug(42, 0.0);
    aug[0] = s.x; aug[1] = s.y; aug[2] = s.z; aug[3] = s.vx; aug[4] = s.vy; aug[5] = s.vz;
    for (int i = 0; i < 6; ++i) aug[6 + i * 6 + i] = 1.0;
    const int steps = std::max(1, static_cast<int>(std::ceil(period / 0.001)));
    const double dt = period / steps;
    for (int i = 0; i < steps; ++i) aug = rk4StepSTM(aug, mu, dt);
    Mat6 m{};
    for (int i = 0; i < 6; ++i)
        for (int j = 0; j < 6; ++j) m[i][j] = aug[6 + i * 6 + j];
    return m;
}

// ---------------------------------------------------------------------------
// Wire <-> core
// ---------------------------------------------------------------------------
CR3BPState core_state(const tbpState* s) {
    CR3BPState c{};
    if (!s) return c;
    c.x = s->X(); c.y = s->Y(); c.z = s->Z(); c.vx = s->VX(); c.vy = s->VY(); c.vz = s->VZ();
    return c;
}

fb::Offset<tbpState> wire_state(fb::FlatBufferBuilder& b, const CR3BPState& s, double time = 0.0) {
    return CreatetbpState(b, s.x, s.y, s.z, s.vx, s.vy, s.vz, time);
}

CR3BPSystem core_system(const tbpSystem* s) {
    CR3BPSystem c{};
    c.mu = s->MASS_RATIO();
    c.l_star = s->CHARACTERISTIC_LENGTH_KM() * 1000.0;
    c.t_star = s->CHARACTERISTIC_TIME_S();
    c.m1 = s->PRIMARY_MASS_KG();
    c.m2 = s->SECONDARY_MASS_KG();
    c.name = s->NAME() ? s->NAME()->str() : std::string{};
    return c;
}

fb::Offset<tbpSystem> echo_system(fb::FlatBufferBuilder& b, const tbpSystem* s) {
    if (!s) return 0;
    return CreatetbpSystem(b, s->NAME() ? b.CreateString(s->NAME()->str()) : 0, s->PRIMARY_BODY_ID(),
                           s->SECONDARY_BODY_ID(), s->MASS_RATIO(), s->PRIMARY_MASS_KG(), s->SECONDARY_MASS_KG(),
                           s->CHARACTERISTIC_LENGTH_KM(), s->CHARACTERISTIC_TIME_S());
}

// rfmLibrationPoint (L1 = 1) -> the core's LagrangePoint (L1 = 0); UNSPECIFIED = L2, the module's old default.
LagrangePoint core_point(rfmLibrationPoint p) {
    return p == rfmLibrationPoint_UNSPECIFIED ? LagrangePoint::L2 : static_cast<LagrangePoint>(static_cast<int>(p) - 1);
}
rfmLibrationPoint wire_point(LagrangePoint p) { return static_cast<rfmLibrationPoint>(static_cast<int>(p) + 1); }

struct Answer {
    tbpStatus status = tbpStatus_Solved;
    std::string error_code, error_message;
    fb::Offset<tbpTrajectory> trajectory = 0;
    fb::Offset<fb::Vector<fb::Offset<tbpLibrationPoint>>> points = 0;
    fb::Offset<tbpState> state = 0;
    double jacobi = 0.0;
    fb::Offset<fb::Vector<fb::Offset<tbpPeriodicOrbit>>> orbits = 0;
    fb::Offset<tbpTransfer> transfer = 0;
    fb::Offset<tbpStationKeeping> station_keeping = 0;
    fb::Offset<tbpFrameConversion> frame_conversion = 0;

    void invalid(const char* code, std::string message) {
        status = tbpStatus_InvalidRequest;
        error_code = code;
        error_message = std::move(message);
    }
};

std::vector<double> flatten(const std::vector<Vector6>& states) {
    std::vector<double> out;
    out.reserve(states.size() * 6);
    for (const auto& s : states) out.insert(out.end(), s.begin(), s.end());
    return out;
}

// Propagation: the core's propagateCR3BP; with STATE_TRANSITION the same fixed-step loop also carries the STM
// (the states come from the same rk4Step calls, so they equal the plain propagation's).
void answer_propagation(fb::FlatBufferBuilder& b, const TBP* req, const CR3BPSystem& sys, Answer& a) {
    const auto* p = req->PROPAGATION();
    if (!p || !p->INITIAL_STATE()) return a.invalid("missing-propagation", "Propagation needs PROPAGATION.INITIAL_STATE.");
    CR3BPPropOptions o{};
    o.duration = p->DURATION();
    o.stepSize = p->STEP() > 0.0 ? p->STEP() : 0.001;
    o.outputPoints = p->OUTPUT_POINTS() > 0 ? static_cast<int>(p->OUTPUT_POINTS()) : 1000;
    o.computeSTM = p->STATE_TRANSITION();
    const CR3BPState s0 = core_state(p->INITIAL_STATE());
    const auto r = propagateCR3BP(s0, sys.mu, o);
    std::vector<double> stm;
    if (o.computeSTM) {
        Vector6 state = {s0.x, s0.y, s0.z, s0.vx, s0.vy, s0.vz};
        std::vector<double> aug(42, 0.0);
        for (int i = 0; i < 6; ++i) aug[i] = state[i];
        for (int i = 0; i < 6; ++i) aug[6 + i * 6 + i] = 1.0;
        double t = 0.0, next = 0.0;
        const double out_dt = o.duration / o.outputPoints;
        while (t <= o.duration + 1e-12) {
            if (t >= next - 1e-12) {
                stm.insert(stm.end(), aug.begin() + 6, aug.end());
                next += out_dt;
            }
            aug = rk4StepSTM(aug, sys.mu, o.stepSize);
            t += o.stepSize;
        }
    }
    const auto states = flatten(r.states);
    a.trajectory = CreatetbpTrajectoryDirect(b, false, 0, 0, &r.times, &states, o.computeSTM ? &stm : nullptr, r.jacobi);
}

void answer_libration_points(fb::FlatBufferBuilder& b, const CR3BPSystem& sys, Answer& a) {
    const auto points = computeLagrangePoints(sys.mu);
    std::vector<fb::Offset<tbpLibrationPoint>> out;
    for (const auto& lp : points) {
        std::vector<double> re, im;
        const bool solved = eigenvalues(linearised_dynamics(lp.position[0], lp.position[1], lp.position[2], sys.mu), re, im);
        const bool stable = computeStability(sys.mu, lp.point).stable;
        out.push_back(CreatetbpLibrationPointDirect(b, wire_point(lp.point), lp.position[0], lp.position[1],
                                                    lp.position[2], lp.jacobi, solved ? &re : nullptr,
                                                    solved ? &im : nullptr, stable));
    }
    a.points = b.CreateVector(out);
}

void answer_jacobi(fb::FlatBufferBuilder& b, const TBP* req, const CR3BPSystem& sys, Answer& a) {
    if (!req->STATE()) return a.invalid("missing-state", "JacobiConstant needs STATE.");
    const CR3BPState s = core_state(req->STATE());
    a.state = wire_state(b, s, req->STATE()->TIME());
    a.jacobi = jacobiConstant({s.x, s.y, s.z, s.vx, s.vy, s.vz}, sys.mu);
}

const tbpPeriodicOrbit* first_orbit(const TBP* req) {
    return req->ORBITS() && req->ORBITS()->size() > 0 ? req->ORBITS()->Get(0) : nullptr;
}

bool halo_family(tbpOrbitFamily f) {
    return f == tbpOrbitFamily_Unspecified || f == tbpOrbitFamily_HaloNorthern || f == tbpOrbitFamily_HaloSouthern;
}

// One corrected orbit (PeriodicOrbit / NearRectilinearHalo) on the wire.
fb::Offset<tbpPeriodicOrbit> wire_corrected(fb::FlatBufferBuilder& b, const PeriodicOrbitResult& r,
                                            const CR3BPSystem& sys, tbpOrbitFamily family, rfmLibrationPoint point,
                                            double amplitude, double perilune_km, double apolune_km, double tol,
                                            uint32_t max_it) {
    fb::Offset<fb::Vector<double>> monodromy = 0, f_re = 0, f_im = 0;
    fb::Offset<tbpTrajectory> trajectory = 0;
    double index = 0.0;
    bool stable = false;
    if (r.converged) {
        const Mat6 m = full_period_monodromy(r.initialState, r.period, sys.mu);
        std::vector<double> flat;
        for (const auto& row : m) flat.insert(flat.end(), row.begin(), row.end());
        monodromy = b.CreateVector(flat);
        std::vector<double> re, im;
        if (eigenvalues(m, re, im)) {
            double largest = 0.0;
            for (size_t i = 0; i < re.size(); ++i) largest = std::max(largest, std::hypot(re[i], im[i]));
            index = largest > 0.0 ? 0.5 * (largest + 1.0 / largest) : 0.0;
            stable = index <= 1.0 + 1e-6;
            f_re = b.CreateVector(re);
            f_im = b.CreateVector(im);
        }
        // The core's one-period sample (propagateCR3BP over PERIOD, 0.001 steps, 1000 outputs).
        CR3BPPropOptions o{};
        o.duration = r.period;
        const auto prop = propagateCR3BP(r.initialState, sys.mu, o);
        const auto states = flatten(prop.states);
        trajectory = CreatetbpTrajectoryDirect(b, false, 0, 0, &prop.times, &states, nullptr, r.jacobi);
    }
    const auto initial = wire_state(b, r.initialState);
    return CreatetbpPeriodicOrbit(b, family, point, amplitude, perilune_km, apolune_km, initial, r.period,
                                  r.period * sys.t_star, r.jacobi, true, r.converged,
                                  static_cast<uint32_t>(r.iterations), tol, max_it, monodromy, f_re, f_im, index,
                                  stable, trajectory);
}

void answer_periodic_orbit(fb::FlatBufferBuilder& b, const TBP* req, const CR3BPSystem& sys, Answer& a) {
    const auto* o = first_orbit(req);
    if (!o) return a.invalid("missing-orbit", "PeriodicOrbit needs ORBITS[0] (FAMILY, LIBRATION_POINT, AMPLITUDE).");
    if (!halo_family(o->FAMILY()))
        return a.invalid("unsupported-family", "The corrector solves halo orbits (HaloNorthern, HaloSouthern) only.");
    const LagrangePoint point = core_point(o->LIBRATION_POINT());
    if (point != LagrangePoint::L1 && point != LagrangePoint::L2)
        return a.invalid("unsupported-libration-point", "Halo orbits are corrected about L1 or L2 only.");
    PeriodicOrbitConfig c{};
    c.family = o->FAMILY() == tbpOrbitFamily_HaloSouthern ? OrbitFamily::HALO_SOUTH : OrbitFamily::HALO_NORTH;
    c.point = point;
    c.amplitude = o->AMPLITUDE();
    c.maxIterations = o->MAX_ITERATIONS() > 0 ? static_cast<int>(o->MAX_ITERATIONS()) : 100;
    c.tolerance = o->TOLERANCE() > 0.0 ? o->TOLERANCE() : 1e-12;
    const auto r = computePeriodicOrbit(c, sys);
    if (!r.converged) a.status = tbpStatus_NotConverged;
    const tbpOrbitFamily family =
        c.family == OrbitFamily::HALO_SOUTH ? tbpOrbitFamily_HaloSouthern : tbpOrbitFamily_HaloNorthern;
    const auto orbit = wire_corrected(b, r, sys, family, wire_point(point), c.amplitude, 0.0, 0.0, c.tolerance,
                                      static_cast<uint32_t>(c.maxIterations));
    a.orbits = b.CreateVector(&orbit, 1);
}

void answer_halo_guess(fb::FlatBufferBuilder& b, const TBP* req, const CR3BPSystem& sys, Answer& a) {
    const auto* o = first_orbit(req);
    if (!o) return a.invalid("missing-orbit", "HaloFirstGuess needs ORBITS[0] (FAMILY, LIBRATION_POINT, AMPLITUDE).");
    if (!halo_family(o->FAMILY()))
        return a.invalid("unsupported-family", "The Richardson first guess is for halo orbits only.");
    const LagrangePoint point = core_point(o->LIBRATION_POINT());
    if (point != LagrangePoint::L1 && point != LagrangePoint::L2)
        return a.invalid("unsupported-libration-point", "The Richardson first guess is for L1 and L2 only.");
    const bool northern = o->FAMILY() != tbpOrbitFamily_HaloSouthern;
    CR3BPState s;
    if (!richardsonHaloGuess(sys.mu, point, o->AMPLITUDE(), northern, s))
        return a.invalid("unsupported-libration-point", "The Richardson first guess is for L1 and L2 only.");
    const auto initial = wire_state(b, s);
    const auto orbit = CreatetbpPeriodicOrbit(b, northern ? tbpOrbitFamily_HaloNorthern : tbpOrbitFamily_HaloSouthern,
                                              wire_point(point), o->AMPLITUDE(), 0.0, 0.0, initial);
    a.orbits = b.CreateVector(&orbit, 1);
}

void answer_nrho(fb::FlatBufferBuilder& b, const TBP* req, const CR3BPSystem& sys, Answer& a) {
    const auto* o = first_orbit(req);
    NRHOConfig c{};
    if (o) {
        c.point = core_point(o->LIBRATION_POINT());
        if (o->PERILUNE_ALTITUDE_KM() > 0.0) c.perilune_km = o->PERILUNE_ALTITUDE_KM();
        if (o->APOLUNE_ALTITUDE_KM() > 0.0) c.apolune_km = o->APOLUNE_ALTITUDE_KM();
        if (o->MAX_ITERATIONS() > 0) c.maxIterations = static_cast<int>(o->MAX_ITERATIONS());
        if (o->TOLERANCE() > 0.0) c.tolerance = o->TOLERANCE();
    }
    if (c.point != LagrangePoint::L1 && c.point != LagrangePoint::L2)
        return a.invalid("unsupported-libration-point", "NRHOs are corrected about L1 or L2 only.");
    if (!(sys.l_star > 0.0))
        return a.invalid("missing-characteristic-length", "NearRectilinearHalo needs SYSTEM.CHARACTERISTIC_LENGTH_KM.");
    const auto r = computeNRHO(c, sys);
    if (!r.converged) a.status = tbpStatus_NotConverged;
    const double az = (c.perilune_km * 1e3) / sys.l_star * 2.0;  // the core's amplitude estimate
    const auto orbit = wire_corrected(b, r, sys, tbpOrbitFamily_NearRectilinearHalo, wire_point(c.point), az,
                                      c.perilune_km, c.apolune_km, c.tolerance, static_cast<uint32_t>(c.maxIterations));
    a.orbits = b.CreateVector(&orbit, 1);
}

fb::Offset<mplBurn> wire_burn(fb::FlatBufferBuilder& b, const char* name, const Vector3& dv_ms, double offset_s,
                              double true_anomaly_deg) {
    const std::vector<double> dv = {dv_ms[0] / 1000.0, dv_ms[1] / 1000.0, dv_ms[2] / 1000.0};
    const double magnitude = std::sqrt(dv_ms[0] * dv_ms[0] + dv_ms[1] * dv_ms[1] + dv_ms[2] * dv_ms[2]) / 1000.0;
    return CreatemplBurnDirect(b, name, maneuverCharacterization_UNKNOWN, 0, offset_s, true_anomaly_deg,
                               mplAxes_Inertial, &dv, magnitude);
}

void answer_transfer(fb::FlatBufferBuilder& b, const TBP* req, const CR3BPSystem& sys, Answer& a) {
    const auto* t = req->TRANSFER();
    if (!t) return a.invalid("missing-transfer", "Transfer needs TRANSFER.");
    TransferConfig c{};
    c.parkingAlt = t->PARKING_ALTITUDE_KM() * 1000.0;
    c.targetAlt = t->TARGET_ALTITUDE_KM() * 1000.0;
    c.inclination = t->INCLINATION_DEG() * DEG_TO_RAD;
    if (t->MAX_ITERATIONS() > 0) c.maxIterations = static_cast<int>(t->MAX_ITERATIONS());
    if (t->TOLERANCE() > 0.0) c.tolerance = t->TOLERANCE();
    TransferResult r{};
    tbpTransferKind kind = t->KIND();
    switch (kind) {
        case tbpTransferKind_Unspecified:
        case tbpTransferKind_LowEnergy:
            kind = tbpTransferKind_LowEnergy;
            c.type = TransferType::LOW_ENERGY;
            r = computeLowEnergyTransfer(sys, c);
            break;
        case tbpTransferKind_FreeReturn:
            c.type = TransferType::FREE_RETURN;
            r = computeFreeReturn(sys, c);
            break;
        case tbpTransferKind_PeriodicOrbitInsertion: {
            if (!t->TARGET_ORBIT() || !t->TARGET_ORBIT()->INITIAL_STATE())
                return a.invalid("missing-target-orbit", "PeriodicOrbitInsertion needs TARGET_ORBIT.INITIAL_STATE.");
            PeriodicOrbitResult target{};
            target.initialState = core_state(t->TARGET_ORBIT()->INITIAL_STATE());
            target.period = t->TARGET_ORBIT()->PERIOD();
            r = computeHaloInsertion(sys, target, c);
            break;
        }
        default:
            return a.invalid("unsupported-transfer-kind",
                             "Transfers built: LowEnergy, FreeReturn, PeriodicOrbitInsertion.");
    }
    std::vector<fb::Offset<mplBurn>> burns = {
        wire_burn(b, "departure", r.dvDepart, 0.0, 0.0),
        wire_burn(b, "arrival", r.dvArrive, r.tof, std::numeric_limits<double>::quiet_NaN()),
    };
    a.transfer = CreatetbpTransferDirect(b, kind, t->PARKING_ALTITUDE_KM(), t->TARGET_ALTITUDE_KM(),
                                         t->INCLINATION_DEG(), 0, t->MAX_ITERATIONS(), t->TOLERANCE(), r.converged,
                                         &burns, r.dvTotal / 1000.0, r.tof);
    if (!r.converged) a.status = tbpStatus_NotConverged;
}

void answer_station_keeping(fb::FlatBufferBuilder& b, const TBP* req, const CR3BPSystem& sys, Answer& a) {
    const auto* k = req->STATION_KEEPING();
    if (!k || !k->ORBIT() || !k->ORBIT()->INITIAL_STATE())
        return a.invalid("missing-orbit", "StationKeeping needs STATION_KEEPING.ORBIT.INITIAL_STATE and PERIOD.");
    PeriodicOrbitResult orbit{};
    orbit.initialState = core_state(k->ORBIT()->INITIAL_STATE());
    orbit.period = k->ORBIT()->PERIOD();
    orbit.jacobi = k->ORBIT()->JACOBI();
    orbit.converged = true;
    if (const auto* m = k->ORBIT()->MONODROMY(); m && m->size() == 36)
        for (int i = 0; i < 6; ++i)
            for (int j = 0; j < 6; ++j) orbit.monodromy[i][j] = m->Get(i * 6 + j);
    StationKeepingConfig c{};
    c.strategy = static_cast<SKStrategy>(k->STRATEGY());
    c.navError = k->NAVIGATION_ERROR_KM();
    c.maneuverError = k->EXECUTION_ERROR_FRACTION();
    c.numCycles = k->CYCLES() > 0 ? static_cast<int>(k->CYCLES()) : 12;
    const auto r = estimateStationKeeping(orbit, sys.mu, c);
    std::vector<double> cycles;
    for (double v : r.cycleDVs) cycles.push_back(v / 1000.0);
    const auto initial = wire_state(b, orbit.initialState);
    const auto kept = CreatetbpPeriodicOrbit(b, k->ORBIT()->FAMILY(), k->ORBIT()->LIBRATION_POINT(),
                                             k->ORBIT()->AMPLITUDE(), 0.0, 0.0, initial, orbit.period,
                                             orbit.period * sys.t_star, orbit.jacobi);
    a.station_keeping = CreatetbpStationKeepingDirect(b, kept, k->STRATEGY(), c.navError, c.maneuverError,
                                                      static_cast<uint32_t>(c.numCycles), r.annualDV / 1000.0,
                                                      r.meanCycleDV / 1000.0, r.maxCycleDV / 1000.0, &cycles,
                                                      r.stable);
}

void answer_frame_conversion(fb::FlatBufferBuilder& b, const TBP* req, const CR3BPSystem& sys, Answer& a) {
    const auto* f = req->FRAME_CONVERSION();
    if (!f) return a.invalid("missing-frame-conversion", "FrameConversion needs FRAME_CONVERSION.");
    if (!(sys.l_star > 0.0) || !(sys.t_star > 0.0))
        return a.invalid("missing-characteristic-scales",
                         "FrameConversion needs SYSTEM.CHARACTERISTIC_LENGTH_KM and CHARACTERISTIC_TIME_S.");
    if (f->DIRECTION() == tbpConversionDirection_SynodicToInertial) {
        if (!f->SYNODIC()) return a.invalid("missing-synodic", "SynodicToInertial needs FRAME_CONVERSION.SYNODIC.");
        const CR3BPState s = core_state(f->SYNODIC());
        const Vector6 eci = rotatingToECI(s, sys, f->ELAPSED_S());
        std::vector<double> km(6);
        for (int i = 0; i < 6; ++i) km[i] = eci[i] / 1000.0;
        a.frame_conversion = CreatetbpFrameConversionDirect(b, f->DIRECTION(), f->REFERENCE_EPOCH_MS(),
                                                            f->ELAPSED_S(), wire_state(b, s, f->SYNODIC()->TIME()), &km);
        return;
    }
    if (!f->INERTIAL() || f->INERTIAL()->size() != 6)
        return a.invalid("missing-inertial", "InertialToSynodic needs FRAME_CONVERSION.INERTIAL (6 values, km, km/s).");
    Vector6 eci{};
    std::vector<double> km(6);
    for (int i = 0; i < 6; ++i) {
        km[i] = f->INERTIAL()->Get(i);
        eci[i] = km[i] * 1000.0;
    }
    const CR3BPState s = eciToRotating(eci, sys, f->ELAPSED_S());
    a.frame_conversion = CreatetbpFrameConversionDirect(b, f->DIRECTION(), f->REFERENCE_EPOCH_MS(), f->ELAPSED_S(),
                                                        wire_state(b, s), &km);
}

}  // namespace

extern "C" {

int invoke(void) {
    const int32_t idx = plugin_find_input_index("request", 0);
    const plugin_input_frame_t* frame = idx < 0 ? nullptr : plugin_get_input_frame(static_cast<uint32_t>(idx));
    if (!frame || !frame->payload || frame->payload_length == 0) {
        plugin_set_error("missing-request", "invoke needs one \"request\" frame, a $TBP.");
        return 400;
    }
    fb::Verifier verifier(frame->payload, frame->payload_length);
    if (!VerifyTBPBuffer(verifier)) {
        plugin_set_error("invalid-request", "The \"request\" frame is not a verifiable $TBP.");
        return 400;
    }
    const TBP* req = GetTBP(frame->payload);

    fb::FlatBufferBuilder b(1024);
    Answer a;
    const tbpSystem* system = req->SYSTEM();
    if (!system) {
        a.invalid("missing-system", "Every TBP request names its SYSTEM (MASS_RATIO at least).");
    } else if (!(system->MASS_RATIO() > 0.0 && system->MASS_RATIO() <= 0.5)) {
        a.invalid("invalid-mass-ratio", "SYSTEM.MASS_RATIO must be in (0, 0.5].");
    } else {
        const CR3BPSystem sys = core_system(system);
        switch (req->PROBLEM()) {
            case tbpProblem_Propagation: answer_propagation(b, req, sys, a); break;
            case tbpProblem_LibrationPoints: answer_libration_points(b, sys, a); break;
            case tbpProblem_JacobiConstant: answer_jacobi(b, req, sys, a); break;
            case tbpProblem_PeriodicOrbit: answer_periodic_orbit(b, req, sys, a); break;
            case tbpProblem_HaloFirstGuess: answer_halo_guess(b, req, sys, a); break;
            case tbpProblem_NearRectilinearHalo: answer_nrho(b, req, sys, a); break;
            case tbpProblem_Transfer: answer_transfer(b, req, sys, a); break;
            case tbpProblem_StationKeeping: answer_station_keeping(b, req, sys, a); break;
            case tbpProblem_FrameConversion: answer_frame_conversion(b, req, sys, a); break;
            default:
                a.invalid("unsupported-problem",
                          "Problems answered: Propagation, LibrationPoints, JacobiConstant, PeriodicOrbit, "
                          "HaloFirstGuess, NearRectilinearHalo, Transfer, StationKeeping, FrameConversion.");
        }
    }

    const auto id = req->ID() ? b.CreateString(req->ID()->str()) : 0;
    const auto producer = b.CreateString(kProducer);
    const auto sys_echo = echo_system(b, system);
    const auto code = a.error_code.empty() ? 0 : b.CreateString(a.error_code);
    const auto message = a.error_message.empty() ? 0 : b.CreateString(a.error_message);
    FinishTBPBuffer(b, CreateTBP(b, id, 0, producer, req->PROBLEM(), sys_echo, a.status, code, message, 0,
                                 a.trajectory, a.points, a.state, a.jacobi, a.orbits, a.transfer, a.station_keeping,
                                 a.frame_conversion));
    const int32_t pushed = plugin_push_output_ex("response", "TBP.fbs", TBPIdentifier(),
                                                 PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "TBP", 0, 0,
                                                 b.GetBufferPointer(), static_cast<uint32_t>(b.GetSize()));
    return pushed < 0 ? 500 : 0;
}

}  // extern "C"
