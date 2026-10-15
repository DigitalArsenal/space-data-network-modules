#include "maneuver/plugin_runtime.h"
#include "maneuver/json_lite.h"

#include "space_data_module_invoke.h"

#include <cmath>
#include <cstdint>
#include <cstring>
#include <limits>
#include <memory>
#include <string>
#include <vector>

/**
 * THE $MPL WIRE.
 *
 * The `plan` method takes one $MPL (maneuver plan) request on `request` and
 * answers with one $MPL on `plan`: the request echoed (it is unpacked into
 * MPLT and packed back) with STATUS, the burns, arcs, totals, options and the
 * problem's solution detail filled in.
 *
 * The operations themselves are unchanged. This file builds, from the request,
 * the parameter tree each operation already read (SI: metres, m/s, radians,
 * m^3/s^2), runs it through `invoke_operation`, and reads the operation's
 * answer document back into the plan in the standard's units (km, km/s,
 * degrees, km^3/s^2). The unit conversions are the only arithmetic here, and
 * each is one IEEE operation with a fixed constant:
 *
 *     metres  = km * 1000          km  = metres / 1000
 *     radians = deg * (pi / 180)   deg = radians * (180 / pi)
 *     m^3/s^2 = km^3/s^2 * 1e9     m^2/s = km^2/s * 1e6
 *
 * The internal answer document carries every double in its shortest
 * round-trip decimal form (json_lite::numberToString), so reading it back is
 * exact: a plan value is the operation's SI value through exactly one of the
 * conversions above.
 *
 * "0 = default" fields of the standard map to an ABSENT parameter, so the
 * operation applies its own documented default.
 */

namespace maneuver {
namespace mpl_bridge {
namespace {

using json_lite::Kind;
using json_lite::Value;

constexpr double kPiValue = 3.14159265358979323846;
constexpr double kKm = 1000.0;
constexpr double kKm3 = 1.0e9;
constexpr double kKm2 = 1.0e6;
constexpr double kDegToRad = kPiValue / 180.0;
constexpr double kRadToDeg = 180.0 / kPiValue;

// ---------------------------------------------------------------------------
// Parameter-tree builders
// ---------------------------------------------------------------------------

Value number(double v) {
    Value x;
    x.kind = Kind::Number;
    x.number = v;
    return x;
}

Value boolean(bool b) {
    Value x;
    x.kind = Kind::Bool;
    x.boolean = b;
    return x;
}

Value text(std::string s) {
    Value x;
    x.kind = Kind::String;
    x.text = std::move(s);
    return x;
}

Value array(const std::vector<double>& values, double scale) {
    Value x;
    x.kind = Kind::Array;
    for (double v : values) x.items.push_back(number(v * scale));
    return x;
}

Value array3(double a, double b, double c) {
    Value x;
    x.kind = Kind::Array;
    x.items.push_back(number(a));
    x.items.push_back(number(b));
    x.items.push_back(number(c));
    return x;
}

struct Obj {
    Value v;
    Obj() { v.kind = Kind::Object; }
    Obj& set(const char* key, Value value) {
        v.members.emplace_back(key, std::move(value));
        return *this;
    }
    Obj& set(const char* key, Obj value) { return set(key, std::move(value.v)); }
};

Value positionM(const ephemerisDataLineT& line) {
    return array3(line.X * kKm, line.Y * kKm, line.Z * kKm);
}

Value velocityMs(const ephemerisDataLineT& line) {
    return array3(line.X_DOT * kKm, line.Y_DOT * kKm, line.Z_DOT * kKm);
}

/// A bridge-level refusal: the request does not say what the operation needs.
struct Refusal {
    bool raised = false;
    std::string code;
    std::string message;
    void invalid(std::string why) {
        if (raised) return;
        raised = true;
        code = "invalid-parameter";
        message = std::move(why);
    }
};

/// A reference (chief) orbit, as the relative-motion and phasing operations
/// read it: semi-major axis, eccentricity, angles, MEAN anomaly, mu and an
/// optional angular momentum.
Obj chiefElements(const mplElementsT& e, double planMuKm3, Refusal* refusal,
                  const char* what) {
    Obj o;
    o.set("semiMajorAxis", number(e.SEMI_MAJOR_AXIS_KM * kKm))
        .set("eccentricity", number(e.ECCENTRICITY))
        .set("inclination", number(e.INCLINATION_DEG * kDegToRad))
        .set("raan", number(e.RAAN_DEG * kDegToRad))
        .set("argumentOfPerigee", number(e.ARG_OF_PERIAPSIS_DEG * kDegToRad));
    if (!std::isnan(e.MEAN_ANOMALY_DEG)) {
        o.set("meanAnomaly", number(e.MEAN_ANOMALY_DEG * kDegToRad));
    } else if (!std::isnan(e.TRUE_ANOMALY_DEG) || !std::isnan(e.ECCENTRIC_ANOMALY_DEG)) {
        refusal->invalid(std::string(what) +
                         " places the object by MEAN_ANOMALY_DEG; a true or "
                         "eccentric anomaly is not read here.");
    }
    const double mu = e.MU_KM3_S2 != 0.0 ? e.MU_KM3_S2 : planMuKm3;
    if (mu != 0.0) o.set("mu", number(mu * kKm3));
    if (e.ANGULAR_MOMENTUM_KM2_S != 0.0) {
        o.set("angularMomentum", number(e.ANGULAR_MOMENTUM_KM2_S * kKm2));
    }
    return o;
}

/// An orbit for the orbit-geometry operations: "state" or "elements".
void geometryOrbit(Obj& params, const mplOrbitT* orbit, Refusal* refusal) {
    if (orbit == nullptr) {
        refusal->invalid("GEOMETRY.ORBIT is required for this problem.");
        return;
    }
    if (orbit->STATE && orbit->ELEMENTS) {
        refusal->invalid("An mplOrbit carries exactly one of ELEMENTS or STATE; both were given.");
        return;
    }
    if (orbit->STATE) {
        Obj state;
        state.set("position", positionM(*orbit->STATE)).set("velocity", velocityMs(*orbit->STATE));
        params.set("state", std::move(state));
    } else if (orbit->ELEMENTS) {
        const mplElementsT& e = *orbit->ELEMENTS;
        Obj elements;
        elements.set("semiMajorAxis", number(e.SEMI_MAJOR_AXIS_KM * kKm))
            .set("eccentricity", number(e.ECCENTRICITY))
            .set("inclination", number(e.INCLINATION_DEG * kDegToRad))
            .set("raan", number(e.RAAN_DEG * kDegToRad))
            .set("argumentOfPeriapsis", number(e.ARG_OF_PERIAPSIS_DEG * kDegToRad));
        if (!std::isnan(e.TRUE_ANOMALY_DEG)) {
            elements.set("trueAnomaly", number(e.TRUE_ANOMALY_DEG * kDegToRad));
        }
        if (!std::isnan(e.MEAN_ANOMALY_DEG)) {
            elements.set("meanAnomaly", number(e.MEAN_ANOMALY_DEG * kDegToRad));
        }
        params.set("elements", std::move(elements));
    } else {
        refusal->invalid("An mplOrbit carries exactly one of ELEMENTS or STATE; neither was given.");
    }
}

/// A phasing craft: "<name>" elements or "<name>State".
void phasingCraft(Obj& params, const mplOrbitT* orbit, const char* elementsKey,
                  const char* stateKey, double planMuKm3, Refusal* refusal) {
    if (orbit == nullptr) return;  // the operation names the missing craft
    if (orbit->ELEMENTS) {
        params.set(elementsKey, chiefElements(*orbit->ELEMENTS, planMuKm3, refusal, elementsKey));
    }
    if (orbit->STATE) {
        Obj state;
        state.set("position", positionM(*orbit->STATE)).set("velocity", velocityMs(*orbit->STATE));
        params.set(stateKey, std::move(state));
    }
}

const char* axesName(mplAxes axes) {
    switch (axes) {
        case mplAxes::Inertial: return "ECI";
        case mplAxes::RIC: return "RIC";
        case mplAxes::VNC: return "VNC";
        default: break;
    }
    return "";
}

Obj relativeState(const mplRelativeRequestT& r) {
    Obj state;
    if (r.RELATIVE_STATE) {
        state.set("position", positionM(*r.RELATIVE_STATE))
            .set("velocity", velocityMs(*r.RELATIVE_STATE));
    }
    return state;
}

Obj dragConfig(const mplDifferentialDragT& drag) {
    Obj o;
    o.set("type", text(drag.MODEL == mplRelativeDynamics::J2DragArbitrary ? "arbitrary" : "eccentric"))
        .set("daDotDrag", number(drag.DA_DOT_PER_S))
        .set("dexDotDrag", number(drag.DEX_DOT_PER_S))
        .set("deyDotDrag", number(drag.DEY_DOT_PER_S));
    return o;
}

/// The operation name and parameter tree for one request.
bool buildCommand(const MPLT& plan, std::string* operation, Obj* params, Refusal* refusal) {
    if (!plan.REQUEST) {
        refusal->invalid("The $MPL request carries no REQUEST table.");
        return false;
    }
    const mplRequestT& q = *plan.REQUEST;
    const double muKm3 = q.MU_KM3_S2;
    auto setMu = [&](Obj& o) {
        if (muKm3 != 0.0) o.set("mu", number(muKm3 * kKm3));
    };
    auto need = [&](const void* table, const char* name) {
        if (table == nullptr) refusal->invalid(std::string("REQUEST.") + name + " is required for this problem.");
        return table != nullptr;
    };

    switch (plan.PROBLEM) {
        case mplProblem::Hohmann:
        case mplProblem::BiElliptic:
        case mplProblem::CombinedTransfer:
        case mplProblem::PlaneChange: {
            if (!need(q.TRANSFER.get(), "TRANSFER")) return false;
            const mplTransferRequestT& t = *q.TRANSFER;
            if (plan.PROBLEM == mplProblem::PlaneChange) {
                *operation = "planeChange";
                params->set("orbitalRadius", number(t.INITIAL_RADIUS_KM * kKm))
                    .set("velocity", number(t.SPEED_KM_S * kKm))
                    .set("deltaInclination", number(t.INCLINATION_CHANGE_DEG * kDegToRad));
                return true;
            }
            params->set("r1", number(t.INITIAL_RADIUS_KM * kKm)).set("r2", number(t.FINAL_RADIUS_KM * kKm));
            if (plan.PROBLEM == mplProblem::Hohmann) {
                *operation = "hohmannTransfer";
            } else if (plan.PROBLEM == mplProblem::BiElliptic) {
                *operation = "biEllipticTransfer";
                params->set("rIntermediate", number(t.INTERMEDIATE_RADIUS_KM * kKm));
            } else {
                *operation = "combinedManeuver";
                params->set("deltaInclination", number(t.INCLINATION_CHANGE_DEG * kDegToRad));
            }
            setMu(*params);
            return true;
        }
        case mplProblem::Lambert:
        case mplProblem::LambertMinimumDeltaV: {
            if (!need(q.LAMBERT.get(), "LAMBERT")) return false;
            const mplLambertRequestT& l = *q.LAMBERT;
            const bool minimum = plan.PROBLEM == mplProblem::LambertMinimumDeltaV;
            *operation = minimum ? "solveLambertMinDV" : "solveLambert";
            if (l.DEPARTURE) params->set("r1", positionM(*l.DEPARTURE));
            if (l.ARRIVAL) params->set("r2", positionM(*l.ARRIVAL));
            params->set("tof", number(l.TIME_OF_FLIGHT_S));
            setMu(*params);
            params->set("prograde", boolean(l.PROGRADE));
            params->set(minimum ? "maxRevs" : "nRevs", number(static_cast<double>(l.REVOLUTIONS)));
            if (l.ENDPOINT_VELOCITIES) {
                if (l.DEPARTURE) params->set("departureVelocity", velocityMs(*l.DEPARTURE));
                if (l.ARRIVAL) params->set("arrivalVelocity", velocityMs(*l.ARRIVAL));
            }
            if (static_cast<uint8_t>(l.BRANCH) > static_cast<uint8_t>(mplLambertBranch::High)) {
                refusal->invalid("LAMBERT.BRANCH must be Unspecified, Low or High: a multi-revolution "
                                 "Lambert problem has exactly two arcs per revolution count.");
            }
            if (l.BRANCH == mplLambertBranch::Low) params->set("branch", text("low"));
            if (l.BRANCH == mplLambertBranch::High) params->set("branch", text("high"));
            return true;
        }
        case mplProblem::Phasing: {
            if (!need(q.PHASING.get(), "PHASING")) return false;
            const mplPhasingRequestT& p = *q.PHASING;
            *operation = "phasingManeuver";
            params->set("currentRadius", number(p.ORBIT_RADIUS_KM * kKm))
                .set("phaseAngle", number(p.PHASE_ANGLE_DEG * kDegToRad));
            if (p.HAS_REVOLUTIONS) params->set("numRevs", number(static_cast<double>(p.REVOLUTIONS)));
            setMu(*params);
            return true;
        }
        case mplProblem::PhasingToTarget: {
            if (!need(q.PHASING.get(), "PHASING")) return false;
            const mplPhasingRequestT& p = *q.PHASING;
            *operation = "phasingFromTargetState";
            setMu(*params);
            phasingCraft(*params, p.CHASER.get(), "chaser", "chaserState", muKm3, refusal);
            phasingCraft(*params, p.TARGET.get(), "target", "targetState", muKm3, refusal);
            if (static_cast<uint8_t>(p.DIRECTION) > static_cast<uint8_t>(mplPhasingDirection::FallBehind)) {
                refusal->invalid("PHASING.DIRECTION must be Shortest, CatchUp or FallBehind.");
            }
            params->set("direction", text(p.DIRECTION == mplPhasingDirection::CatchUp ? "catchUp"
                                          : p.DIRECTION == mplPhasingDirection::FallBehind ? "fallBehind"
                                                                                           : "short"));
            if (p.HAS_REVOLUTIONS) params->set("numRevs", number(static_cast<double>(p.REVOLUTIONS)));
            if (p.MAX_REVOLUTIONS != 0) params->set("maxRevs", number(static_cast<double>(p.MAX_REVOLUTIONS)));
            if (p.DELTA_V_BUDGET_KM_S != 0.0) params->set("deltaVBudget", number(p.DELTA_V_BUDGET_KM_S * kKm));
            if (p.DELTA_V_BUDGET_FRACTION != 0.0) params->set("deltaVBudgetFraction", number(p.DELTA_V_BUDGET_FRACTION));
            if (p.HAS_COPLANAR_TOLERANCE) {
                params->set("coplanarTolerance", number(p.COPLANAR_TOLERANCE_DEG * kDegToRad));
            }
            if (p.HAS_ECCENTRICITY_TOLERANCE) params->set("eccentricityTolerance", number(p.ECCENTRICITY_TOLERANCE));
            if (p.HAS_CO_ORBITAL_TOLERANCE) {
                if (p.CO_ORBITAL_TOLERANCE_BASIS == mplToleranceBasis::AbsoluteKm) {
                    // Converted to a fraction with the chaser's semi-major axis
                    // inside the operation, once it has read the chaser.
                    params->set("coOrbitalToleranceMetres", number(p.CO_ORBITAL_TOLERANCE * kKm));
                } else if (p.CO_ORBITAL_TOLERANCE_BASIS == mplToleranceBasis::RelativeToChaserSemiMajorAxis) {
                    params->set("coOrbitalTolerance", number(p.CO_ORBITAL_TOLERANCE));
                } else {
                    refusal->invalid("PHASING.CO_ORBITAL_TOLERANCE_BASIS must be AbsoluteKm or RelativeToChaserSemiMajorAxis.");
                }
            }
            return true;
        }
        case mplProblem::RelativeStateTransition:
        case mplProblem::RelativeWaypoints:
        case mplProblem::CollisionAvoidance:
        case mplProblem::ApproachCorridor: {
            if (!need(q.RELATIVE.get(), "RELATIVE")) return false;
            const mplRelativeRequestT& r = *q.RELATIVE;
            if (r.REFERENCE) params->set("chief", chiefElements(*r.REFERENCE, muKm3, refusal, "REFERENCE"));
            const bool includeJ2 = r.DYNAMICS != mplRelativeDynamics::Keplerian;
            if (plan.PROBLEM == mplProblem::RelativeStateTransition) {
                *operation = "computeRoeStateTransition";
                params->set("deltaTime", number(r.DURATION_S));
                switch (r.STM_DYNAMICS) {
                    case mplRelativeDynamics::Keplerian: params->set("model", text("keplerian")); break;
                    case mplRelativeDynamics::J2: params->set("model", text("j2")); break;
                    case mplRelativeDynamics::J2DragEccentric: params->set("model", text("j2-drag-eccentric")); break;
                    case mplRelativeDynamics::J2DragArbitrary: params->set("model", text("j2-drag-arbitrary")); break;
                    case mplRelativeDynamics::Unspecified: break;  // the planner's default, J2
                    default:
                        refusal->invalid("RELATIVE.STM_DYNAMICS must be Keplerian, J2, J2DragEccentric or "
                                         "J2DragArbitrary for a relative-orbital-element state transition.");
                        break;
                }
                if (!r.INITIAL_ROE.empty()) {
                    params->set("initialRoe", array(r.INITIAL_ROE, 1.0));
                    params->set("includeJ2", boolean(includeJ2)).set("includeDrag", boolean(r.DRAG != nullptr));
                    if (r.DRAG) params->set("dragConfig", dragConfig(*r.DRAG));
                }
                return true;
            }
            if (r.RELATIVE_STATE) params->set("initialState", relativeState(r));
            if (plan.PROBLEM == mplProblem::RelativeWaypoints) {
                *operation = "planRelativeWaypointMission";
                Obj options;
                options.set("includeJ2", boolean(includeJ2)).set("includeDrag", boolean(r.DRAG != nullptr));
                if (r.DRAG) options.set("dragConfig", dragConfig(*r.DRAG));
                if (r.MAX_ITERATIONS != 0) options.set("maxIterations", number(static_cast<double>(r.MAX_ITERATIONS)));
                if (r.POSITION_TOLERANCE_KM != 0.0) options.set("positionTolerance", number(r.POSITION_TOLERANCE_KM * kKm));
                if (r.VELOCITY_TOLERANCE_KM_S != 0.0) options.set("velocityTolerance", number(r.VELOCITY_TOLERANCE_KM_S * kKm));
                if (r.LEG_TIME_LOWER_ORBITS != 0.0) options.set("tofMinOrbits", number(r.LEG_TIME_LOWER_ORBITS));
                if (r.LEG_TIME_UPPER_ORBITS != 0.0) options.set("tofMaxOrbits", number(r.LEG_TIME_UPPER_ORBITS));
                if (!r.TARGET_VELOCITY_KM_S.empty()) options.set("targetVelocity", array(r.TARGET_VELOCITY_KM_S, kKm));
                if (r.SAMPLES_PER_LEG != 0) options.set("pointsPerLeg", number(static_cast<double>(r.SAMPLES_PER_LEG)));
                params->set("options", std::move(options));
                Value waypoints;
                waypoints.kind = Kind::Array;
                for (const auto& w : r.WAYPOINTS) {
                    Obj item;
                    if (w) {
                        item.set("position", array(w->POSITION_KM, kKm));
                        if (!w->VELOCITY_KM_S.empty()) item.set("velocity", array(w->VELOCITY_KM_S, kKm));
                        if (w->TIME_OF_FLIGHT_S != 0.0) item.set("tof", number(w->TIME_OF_FLIGHT_S));
                    }
                    waypoints.items.push_back(std::move(item.v));
                }
                params->set("waypoints", std::move(waypoints));
                return true;
            }
            if (plan.PROBLEM == mplProblem::CollisionAvoidance) {
                *operation = "computeCAM";
                Obj config;
                if (r.MISS_DISTANCE_KM != 0.0) config.set("minMissDistance", number(r.MISS_DISTANCE_KM * kKm));
                if (r.TIME_TO_CLOSEST_APPROACH_S != 0.0) config.set("timeToTCA", number(r.TIME_TO_CLOSEST_APPROACH_S));
                if (r.HAS_MAX_DELTA_V) {
                    // Stated: 0 = unlimited, otherwise that limit. Unstated: the planner's default.
                    config.set("maxDeltaV", number(r.MAX_DELTA_V_KM_S == 0.0
                                                       ? std::numeric_limits<double>::infinity()
                                                       : r.MAX_DELTA_V_KM_S * kKm));
                }
                config.set("preferRadial", boolean(r.PREFER_RADIAL));
                params->set("config", std::move(config));
                return true;
            }
            *operation = "computeApproach";
            Obj config;
            config.set("axis", number(static_cast<double>(static_cast<uint8_t>(r.APPROACH_AXIS))));
            if (!r.APPROACH_TARGET_KM.empty()) config.set("targetPosition", array(r.APPROACH_TARGET_KM, kKm));
            if (r.APPROACH_SPEED_KM_S != 0.0) config.set("approachSpeed", number(r.APPROACH_SPEED_KM_S * kKm));
            if (r.CORRIDOR_HALF_WIDTH_KM != 0.0) config.set("safetyCorridorWidth", number(r.CORRIDOR_HALF_WIDTH_KM * kKm));
            params->set("config", std::move(config));
            return true;
        }
        case mplProblem::RendezvousSimulation: {
            if (!need(q.RENDEZVOUS.get(), "RENDEZVOUS")) return false;
            const mplRendezvousRequestT& r = *q.RENDEZVOUS;
            *operation = "simulateRendezvous";
            if (r.REFERENCE) params->set("chief", chiefElements(*r.REFERENCE, muKm3, refusal, "REFERENCE"));
            if (!r.INITIAL_POSITION_KM.empty()) params->set("initialPosition", array(r.INITIAL_POSITION_KM, kKm));
            if (!r.INITIAL_VELOCITY_KM_S.empty()) params->set("initialVelocity", array(r.INITIAL_VELOCITY_KM_S, kKm));
            if (!r.BRAKE_POINT_KM.empty()) params->set("brakePoint", array(r.BRAKE_POINT_KM, kKm));
            if (!r.HOLD_POINT_KM.empty()) params->set("holdPoint", array(r.HOLD_POINT_KM, kKm));
            params->set("driftDuration", number(r.DRIFT_DURATION_S)).set("brakeDuration", number(r.BRAKE_DURATION_S));
            if (r.HOLD_DURATION_S != 0.0) params->set("holdDuration", number(r.HOLD_DURATION_S));
            Obj control;
            if (r.BANDWIDTH_RAD_S != 0.0) control.set("bandwidth", number(r.BANDWIDTH_RAD_S));
            if (r.HAS_DAMPING_RATIO) control.set("dampingRatio", number(r.DAMPING_RATIO));
            if (r.HAS_KP) control.set("kp", number(r.KP_PER_S2));
            if (r.HAS_KD) control.set("kd", number(r.KD_PER_S));
            control.set("useFeedforward", boolean(r.FEEDFORWARD))
                .set("compensateCoriolis", boolean(r.COMPENSATE_CORIOLIS))
                .set("compensateGravityGradient", boolean(r.COMPENSATE_GRAVITY_GRADIENT));
            if (r.MAX_ACCELERATION_KM_S2 != 0.0) control.set("maxAccel", number(r.MAX_ACCELERATION_KM_S2 * kKm));
            params->set("control", std::move(control));
            Obj integration;
            if (r.TIME_STEP_S != 0.0) integration.set("timeStep", number(r.TIME_STEP_S));
            if (r.OUTPUT_EVERY != 0) integration.set("outputEvery", number(static_cast<double>(r.OUTPUT_EVERY)));
            integration.set("includeJ2", boolean(r.INCLUDE_J2));
            params->set("integration", std::move(integration));
            return true;
        }
        case mplProblem::OrbitGeometry:
        case mplProblem::AnomalyConversion:
        case mplProblem::TimeOfFlight:
        case mplProblem::OrbitSampling:
        case mplProblem::DeltaVTransform: {
            if (!need(q.GEOMETRY.get(), "GEOMETRY")) return false;
            const mplGeometryRequestT& g = *q.GEOMETRY;
            if (plan.PROBLEM == mplProblem::AnomalyConversion) {
                *operation = "convertOrbitAnomaly";
                const char* from = g.ANOMALY_KIND == mplAnomalyKind::TrueAnomaly ? "true"
                                   : g.ANOMALY_KIND == mplAnomalyKind::MeanAnomaly ? "mean"
                                   : g.ANOMALY_KIND == mplAnomalyKind::EccentricAnomaly ? "eccentric"
                                                                                       : "";
                params->set("eccentricity", number(g.ECCENTRICITY))
                    .set("anomaly", number(g.ANOMALY_DEG * kDegToRad))
                    .set("from", text(from));
                return true;
            }
            if (plan.PROBLEM == mplProblem::DeltaVTransform) {
                *operation = "transformDeltaV";
                if (!g.ORBIT || !g.ORBIT->STATE) {
                    refusal->invalid("DeltaVTransform needs GEOMETRY.ORBIT.STATE: the axes are built from an inertial state.");
                    return false;
                }
                if (!g.BURN) {
                    refusal->invalid("DeltaVTransform needs GEOMETRY.BURN: the delta-v to rotate.");
                    return false;
                }
                const mplAxes from = g.BURN->AXES;
                const mplAxes to = from == mplAxes::RIC ? mplAxes::Inertial : mplAxes::RIC;
                if (g.TO_AXES != mplAxes::Unspecified && (from == g.TO_AXES ||
                        (from == mplAxes::RIC || from == mplAxes::Inertial) && g.TO_AXES != to)) {
                    refusal->invalid("DeltaVTransform rotates between RIC and Inertial only; TO_AXES must be the other one.");
                    return false;
                }
                params->set("position", positionM(*g.ORBIT->STATE))
                    .set("velocity", velocityMs(*g.ORBIT->STATE))
                    .set("deltaV", array(g.BURN->DELTA_V, kKm))
                    .set("from", text(axesName(from)));
                return true;
            }
            setMu(*params);
            geometryOrbit(*params, g.ORBIT.get(), refusal);
            if (plan.PROBLEM == mplProblem::OrbitGeometry) {
                *operation = "evaluateOrbitGeometry";
                if (!std::isnan(g.AT_TRUE_ANOMALY_DEG)) params->set("atTrueAnomaly", number(g.AT_TRUE_ANOMALY_DEG * kDegToRad));
                if (g.HAS_ELAPSED) params->set("elapsedSeconds", number(g.ELAPSED_S));
                if (g.BURN) {
                    params->set("deltaV", array(g.BURN->DELTA_V, kKm)).set("deltaVFrame", text(axesName(g.BURN->AXES)));
                }
            } else if (plan.PROBLEM == mplProblem::TimeOfFlight) {
                *operation = "orbitTimeOfFlight";
                params->set("fromTrueAnomaly", number(g.FROM_TRUE_ANOMALY_DEG * kDegToRad))
                    .set("toTrueAnomaly", number(g.TO_TRUE_ANOMALY_DEG * kDegToRad))
                    .set("revolutions", number(static_cast<double>(g.REVOLUTIONS)));
            } else {
                *operation = "sampleOrbitGeometry";
                params->set("count", number(static_cast<double>(g.SAMPLE_COUNT)));
                if (g.FROM_TRUE_ANOMALY_DEG != 0.0) params->set("fromTrueAnomaly", number(g.FROM_TRUE_ANOMALY_DEG * kDegToRad));
                if (g.HAS_SWEEP) params->set("sweep", number(g.SWEEP_DEG * kDegToRad));
            }
            return true;
        }
        default:
            break;
    }
    refusal->invalid("PROBLEM must name a maneuver problem (Hohmann through DeltaVTransform); Unspecified is not one.");
    return false;
}

// ---------------------------------------------------------------------------
// Answer readers
// ---------------------------------------------------------------------------

double num(const Value& o, const char* key) {
    const Value* v = o.find(key);
    return v != nullptr && v->isNumber() ? v->number : 0.0;
}

bool has(const Value& o, const char* key) {
    const Value* v = o.find(key);
    return v != nullptr && !v->isNull();
}

bool flag(const Value& o, const char* key) {
    const Value* v = o.find(key);
    return v != nullptr && v->isBool() && v->boolean;
}

std::string str(const Value& o, const char* key) {
    const Value* v = o.find(key);
    return v != nullptr && v->isString() ? v->text : std::string();
}

const Value& member(const Value& o, const char* key) {
    static const Value empty;
    const Value* v = o.find(key);
    return v != nullptr ? *v : empty;
}

std::vector<double> numbers(const Value& o, const char* key, double divide) {
    std::vector<double> out;
    const Value* v = o.find(key);
    if (v == nullptr || !v->isArray()) return out;
    for (const Value& item : v->items) out.push_back(item.number / divide);
    return out;
}

void append3(std::vector<double>* out, const Value& o, const char* key, double divide) {
    for (double v : numbers(o, key, divide)) out->push_back(v);
}

std::unique_ptr<ephemerisDataLineT> line(const std::vector<double>& position,
                                         const std::vector<double>& velocity) {
    auto l = std::make_unique<ephemerisDataLineT>();
    if (position.size() == 3) {
        l->X = position[0];
        l->Y = position[1];
        l->Z = position[2];
    }
    if (velocity.size() == 3) {
        l->X_DOT = velocity[0];
        l->Y_DOT = velocity[1];
        l->Z_DOT = velocity[2];
    }
    return l;
}

std::unique_ptr<mplBurnT> burn(const char* name, double offset, mplAxes axes,
                               std::vector<double> deltaV, double magnitudeSi, int arcIndex) {
    auto b = std::make_unique<mplBurnT>();
    b->NAME = name;
    b->OFFSET_S = offset;
    b->AXES = axes;
    b->DELTA_V = std::move(deltaV);
    b->MAGNITUDE_KM_S = std::abs(magnitudeSi) / kKm;
    b->ARC_INDEX = arcIndex;
    return b;
}

std::unique_ptr<mplArcT> arc(const char* name, mplArcRole role, double start, double duration) {
    auto a = std::make_unique<mplArcT>();
    a->NAME = name;
    a->ROLE = role;
    a->START_OFFSET_S = start;
    a->DURATION_S = duration;
    return a;
}

std::unique_ptr<mplElementsT> chiefOut(const Value& c) {
    auto e = std::make_unique<mplElementsT>();
    e->SEMI_MAJOR_AXIS_KM = num(c, "semiMajorAxis") / kKm;
    e->ECCENTRICITY = num(c, "eccentricity");
    e->INCLINATION_DEG = num(c, "inclination") * kRadToDeg;
    e->RAAN_DEG = num(c, "raan") * kRadToDeg;
    e->ARG_OF_PERIAPSIS_DEG = num(c, "argumentOfPerigee") * kRadToDeg;
    e->MEAN_ANOMALY_DEG = num(c, "meanAnomaly") * kRadToDeg;
    e->MU_KM3_S2 = num(c, "mu") / kKm3;
    return e;
}

mplLambertBranch branchOf(const Value& o) {
    const std::string b = str(o, "branch");
    if (b == "low") return mplLambertBranch::Low;
    if (b == "high") return mplLambertBranch::High;
    return mplLambertBranch::Unspecified;
}

mplPhasingDirection directionOf(const std::string& d) {
    if (d == "catchUp") return mplPhasingDirection::CatchUp;
    if (d == "fallBehind") return mplPhasingDirection::FallBehind;
    return mplPhasingDirection::Shortest;
}

mplRelativeSolutionT& relative(MPLT& plan) {
    if (!plan.RELATIVE) plan.RELATIVE = std::make_unique<mplRelativeSolutionT>();
    return *plan.RELATIVE;
}

mplGeometrySolutionT& geometry(MPLT& plan) {
    if (!plan.GEOMETRY) plan.GEOMETRY = std::make_unique<mplGeometrySolutionT>();
    return *plan.GEOMETRY;
}

void writePhasing(MPLT& plan, const Value& a) {
    const double totalTime = num(a, "totalTime");
    plan.ARCS.push_back(arc("phasing", mplArcRole::Phasing, 0.0, totalTime));
    plan.ARCS.back()->REVOLUTIONS = static_cast<uint32_t>(num(a, "numRevs"));
    plan.ARCS.back()->SEMI_MAJOR_AXIS_KM = num(a, "phasingSMA") / kKm;
    plan.ARCS.back()->PERIOD_S = num(a, "phasingPeriod");
    plan.BURNS.push_back(burn("enter phasing orbit", 0.0, mplAxes::RIC, numbers(a, "dv1_ric", kKm), num(a, "dv1"), 0));
    plan.BURNS.push_back(burn("leave phasing orbit", totalTime, mplAxes::RIC, numbers(a, "dv2_ric", kKm), num(a, "dv2"), -1));
    plan.TOTAL_DELTA_V_KM_S = num(a, "totalDeltaV") / kKm;
    plan.TOTAL_TIME_S = totalTime;
    if (!plan.PHASING) plan.PHASING = std::make_unique<mplPhasingSolutionT>();
    mplPhasingSolutionT& p = *plan.PHASING;
    p.PHASE_ANGLE_DEG = num(a, "phaseAngle") * kRadToDeg;
    p.ACHIEVED_PHASE_ANGLE_DEG = num(a, "achievedPhaseAngle") * kRadToDeg;
    p.REQUESTED_SEMI_MAJOR_AXIS_KM = num(a, "requestedPhasingSMA") / kKm;
    p.REQUESTED_PERIOD_S = num(a, "requestedPhasingPeriod");
    p.FLOOR_RADIUS_KM = num(a, "earthFloorRadius") / kKm;
    p.CLAMPED_TO_FLOOR = flag(a, "clampedToEarthFloor");
    p.FAR_APSE_RADIUS_KM = num(a, "farApse") / kKm;
}

std::unique_ptr<mplOptionT> phasingOption(const char* name, mplPhasingDirection direction,
                                          const Value& s, const Value& a) {
    auto o = std::make_unique<mplOptionT>();
    o->NAME = name;
    o->DIRECTION = direction;
    o->PHASE_ANGLE_DEG = num(s, "phaseAngle") * kRadToDeg;
    o->REVOLUTIONS = static_cast<uint32_t>(num(s, "numRevs"));
    o->TOTAL_DELTA_V_KM_S = num(s, "totalDeltaV") / kKm;
    o->TOTAL_TIME_S = num(s, "totalTime");
    o->SEMI_MAJOR_AXIS_KM = num(s, "phasingSMA") / kKm;
    o->CLAMPED_TO_FLOOR = flag(s, "clampedToEarthFloor");
    o->WITHIN_BUDGET = flag(s, "metDeltaVBudget");
    o->SELECTED = num(s, "phaseAngle") == num(a, "phaseAngle") && num(s, "numRevs") == num(a, "numRevs");
    return o;
}

void writeAnswer(MPLT& plan, const std::string& operation, const Value& a) {
    if (operation == "hohmannTransfer" || operation == "combinedManeuver") {
        const double tof = num(a, "tof");
        plan.ARCS.push_back(arc("transfer", mplArcRole::Transfer, 0.0, tof));
        plan.ARCS.back()->SEMI_MAJOR_AXIS_KM = num(a, "aTransfer") / kKm;
        plan.BURNS.push_back(burn("departure", 0.0, mplAxes::RIC, numbers(a, "dv1_ric", kKm), num(a, "dv1"), 0));
        plan.BURNS.push_back(burn("arrival", tof, mplAxes::RIC, numbers(a, "dv2_ric", kKm), num(a, "dv2"), -1));
        plan.TOTAL_DELTA_V_KM_S = num(a, "totalDeltaV") / kKm;
        plan.TOTAL_TIME_S = tof;
    } else if (operation == "biEllipticTransfer") {
        const double tof1 = num(a, "tof1");
        plan.ARCS.push_back(arc("transfer 1", mplArcRole::Transfer, 0.0, tof1));
        plan.ARCS.back()->SEMI_MAJOR_AXIS_KM = num(a, "aTransfer1") / kKm;
        plan.ARCS.push_back(arc("transfer 2", mplArcRole::Transfer, tof1, num(a, "tof2")));
        plan.ARCS.back()->SEMI_MAJOR_AXIS_KM = num(a, "aTransfer2") / kKm;
        plan.BURNS.push_back(burn("departure", 0.0, mplAxes::RIC, numbers(a, "dv1_ric", kKm), num(a, "dv1"), 0));
        plan.BURNS.push_back(burn("intermediate", tof1, mplAxes::RIC, numbers(a, "dv2_ric", kKm), num(a, "dv2"), 1));
        plan.BURNS.push_back(burn("arrival", num(a, "tof"), mplAxes::RIC, numbers(a, "dv3_ric", kKm), num(a, "dv3"), -1));
        plan.TOTAL_DELTA_V_KM_S = num(a, "totalDeltaV") / kKm;
        plan.TOTAL_TIME_S = num(a, "tof");
    } else if (operation == "planeChange") {
        plan.BURNS.push_back(burn("plane change", 0.0, mplAxes::RIC, numbers(a, "dv_ric", kKm), num(a, "dv"), -1));
        plan.BURNS.back()->TRUE_ANOMALY_DEG = num(a, "optimalTrueAnomaly") * kRadToDeg;
        plan.TOTAL_DELTA_V_KM_S = std::abs(num(a, "dv")) / kKm;
    } else if (operation == "solveLambert" || operation == "solveLambertMinDV") {
        const double tof = num(a, "tof");
        auto t = arc("transfer", mplArcRole::Transfer, 0.0, tof);
        t->REVOLUTIONS = static_cast<uint32_t>(num(a, "revolutions"));
        t->BRANCH = branchOf(a);
        const std::string conic = str(a, "transferConic");
        t->CONIC = conic == "elliptic" ? mplConic::Elliptic
                   : conic == "parabolic" ? mplConic::Parabolic
                   : conic == "hyperbolic" ? mplConic::Hyperbolic
                                           : mplConic::Unspecified;
        t->SEMI_MAJOR_AXIS_KM = num(a, "transferSemiMajorAxis") / kKm;
        t->ECCENTRICITY = num(a, "transferEccentricity");
        t->PERIAPSIS_RADIUS_KM = num(a, "perigeeRadius") / kKm;
        t->APOAPSIS_RADIUS_KM = num(a, "apogeeRadius") / kKm;
        const mplLambertRequestT* l = plan.REQUEST ? plan.REQUEST->LAMBERT.get() : nullptr;
        std::vector<double> r1, r2;
        if (l && l->DEPARTURE) r1 = {l->DEPARTURE->X, l->DEPARTURE->Y, l->DEPARTURE->Z};
        if (l && l->ARRIVAL) r2 = {l->ARRIVAL->X, l->ARRIVAL->Y, l->ARRIVAL->Z};
        t->START_STATE = line(r1, numbers(a, "v1", kKm));
        t->END_STATE = line(r2, numbers(a, "v2", kKm));
        t->STATE_AXES = mplAxes::Inertial;
        t->LAMBERT_Z = num(a, "z");
        t->SOLVER = std::make_unique<mplSolverT>();
        t->SOLVER->CONVERGED = flag(a, "converged");
        t->SOLVER->ITERATIONS = static_cast<uint32_t>(num(a, "iterations"));
        t->SOLVER->STATUS_TEXT = str(a, "status");
        t->SOLVER->RESIDUAL = num(a, "residual");
        t->SOLVER->RESIDUAL_TOLERANCE = num(a, "residualBudget");
        if (has(a, "dv1")) {
            t->DELTA_V_KM_S = num(a, "totalDeltaV") / kKm;
            plan.BURNS.push_back(burn("departure", 0.0, mplAxes::Inertial, numbers(a, "dv1_vec", kKm), num(a, "dv1"), 0));
            plan.BURNS.push_back(burn("arrival", tof, mplAxes::Inertial, numbers(a, "dv2_vec", kKm), num(a, "dv2"), -1));
            plan.TOTAL_DELTA_V_KM_S = num(a, "totalDeltaV") / kKm;
        }
        plan.ARCS.push_back(std::move(t));
        plan.TOTAL_TIME_S = tof;
        const Value& ranked = member(a, "branches");
        for (const Value& c : ranked.items) {
            auto o = std::make_unique<mplOptionT>();
            o->REVOLUTIONS = static_cast<uint32_t>(num(c, "revolutions"));
            o->BRANCH = branchOf(c);
            o->NAME = std::to_string(o->REVOLUTIONS) + " rev" +
                      (o->BRANCH == mplLambertBranch::Low ? " low" : o->BRANCH == mplLambertBranch::High ? " high" : "");
            o->BURN_DELTA_V_KM_S = {num(c, "dv1") / kKm, num(c, "dv2") / kKm};
            o->TOTAL_DELTA_V_KM_S = num(c, "totalDeltaV") / kKm;
            o->SELECTED = o->REVOLUTIONS == static_cast<uint32_t>(num(a, "revolutions")) &&
                          o->BRANCH == branchOf(a);
            plan.OPTIONS.push_back(std::move(o));
        }
    } else if (operation == "phasingManeuver") {
        writePhasing(plan, a);
    } else if (operation == "phasingFromTargetState") {
        writePhasing(plan, a);
        mplPhasingSolutionT& p = *plan.PHASING;
        p.RELATIVE_PHASE_ANGLE_DEG = num(a, "relativePhaseAngle") * kRadToDeg;
        p.CATCH_UP_ANGLE_DEG = num(a, "catchUpAngle") * kRadToDeg;
        p.FALL_BEHIND_ANGLE_DEG = num(a, "fallBehindAngle") * kRadToDeg;
        p.DIRECTION = directionOf(str(a, "direction"));
        p.CHASER = std::make_unique<mplElementsT>();
        p.CHASER->SEMI_MAJOR_AXIS_KM = num(a, "chaserSemiMajorAxis") / kKm;
        p.CHASER->ECCENTRICITY = num(a, "chaserEccentricity");
        p.CHASER->MEAN_ANOMALY_DEG = num(a, "chaserMeanAnomaly") * kRadToDeg;
        p.CHASER->MEAN_ARGUMENT_OF_LATITUDE_DEG = num(a, "chaserMeanArgumentOfLatitude") * kRadToDeg;
        p.TARGET = std::make_unique<mplElementsT>();
        p.TARGET->SEMI_MAJOR_AXIS_KM = num(a, "targetSemiMajorAxis") / kKm;
        p.TARGET->ECCENTRICITY = num(a, "targetEccentricity");
        p.TARGET->MEAN_ANOMALY_DEG = num(a, "targetMeanAnomaly") * kRadToDeg;
        p.TARGET->MEAN_ARGUMENT_OF_LATITUDE_DEG = num(a, "targetMeanArgumentOfLatitude") * kRadToDeg;
        p.RAAN_DIFFERENCE_DEG = num(a, "raanDifference") * kRadToDeg;
        p.INCLINATION_DIFFERENCE_DEG = num(a, "inclinationDifference") * kRadToDeg;
        p.PLANE_ANGLE_DEG = num(a, "planeAngle") * kRadToDeg;
        p.SEMI_MAJOR_AXIS_DIFFERENCE_KM = num(a, "semiMajorAxisDifference") / kKm;
        p.COPLANAR = flag(a, "coplanar");
        p.COPLANAR_TOLERANCE_DEG = num(a, "coplanarTolerance") * kRadToDeg;
        p.NEAR_CIRCULAR = flag(a, "nearCircular");
        p.ECCENTRICITY_TOLERANCE = num(a, "eccentricityTolerance");
        p.CO_ORBITAL = flag(a, "coOrbital");
        p.CO_ORBITAL_TOLERANCE_KM = num(a, "coOrbitalTolerance") / kKm;
        p.CO_ORBITAL_TOLERANCE_FRACTION = num(a, "coOrbitalToleranceFraction");
        p.RECOMMENDED_REVOLUTIONS = static_cast<uint32_t>(num(a, "recommendedRevs"));
        p.REVOLUTIONS_FROM_CALLER = flag(a, "revsFromCaller");
        p.MAX_REVOLUTIONS = static_cast<uint32_t>(num(a, "maxRevs"));
        p.DELTA_V_BUDGET_KM_S = num(a, "deltaVBudget") / kKm;
        p.WITHIN_BUDGET = flag(a, "metDeltaVBudget");
        p.PHASING_RADIUS_KM = num(a, "phasingRadius") / kKm;
        plan.OPTIONS.push_back(phasingOption("catchUp", mplPhasingDirection::CatchUp, member(a, "catchUp"), a));
        plan.OPTIONS.push_back(phasingOption("fallBehind", mplPhasingDirection::FallBehind, member(a, "fallBehind"), a));
    } else if (operation == "computeRoeStateTransition") {
        mplRelativeSolutionT& r = relative(plan);
        r.MODEL_REFERENCE = str(a, "reference");
        const std::string model = str(a, "model");
        r.STM_DYNAMICS = model == "keplerian" ? mplRelativeDynamics::Keplerian
                     : model == "j2" ? mplRelativeDynamics::J2
                     : model == "j2-drag-eccentric" ? mplRelativeDynamics::J2DragEccentric
                     : model == "j2-drag-arbitrary" ? mplRelativeDynamics::J2DragArbitrary
                                                    : mplRelativeDynamics::Unspecified;
        // DYNAMICS: what INITIAL_ROE was propagated with (J2 on or off, the
        // drag model when DRAG was given); none when nothing was propagated.
        const mplRelativeRequestT* q = plan.REQUEST ? plan.REQUEST->RELATIVE.get() : nullptr;
        if (q != nullptr && !q->INITIAL_ROE.empty()) {
            r.DYNAMICS = q->DRAG ? q->DRAG->MODEL
                         : q->DYNAMICS == mplRelativeDynamics::Keplerian ? mplRelativeDynamics::Keplerian
                                                                         : mplRelativeDynamics::J2;
        }
        for (const Value& row : member(a, "stm").items) {
            for (const Value& cell : row.items) r.STATE_TRANSITION.push_back(cell.number);
        }
        if (has(a, "dragColumn")) {
            r.DRAG_COLUMNS = numbers(a, "dragColumn", 1.0);
            r.DRAG_COLUMN_COUNT = 1;
        } else if (has(a, "dragColumns")) {
            for (const Value& row : member(a, "dragColumns").items) {
                for (const Value& cell : row.items) r.DRAG_COLUMNS.push_back(cell.number);
            }
            r.DRAG_COLUMN_COUNT = 3;
        }
        r.INITIAL_ROE = numbers(a, "initialRoe", 1.0);
        r.PROPAGATED_ROE = numbers(a, "propagatedRoe", 1.0);
        plan.TOTAL_TIME_S = num(a, "deltaTime");
    } else if (operation == "planRelativeWaypointMission") {
        mplRelativeSolutionT& r = relative(plan);
        r.MODEL_REFERENCE = str(a, "reference");
        r.DYNAMICS = str(a, "model") == "keplerian" ? mplRelativeDynamics::Keplerian : mplRelativeDynamics::J2;
        plan.SOLVER = std::make_unique<mplSolverT>();
        plan.SOLVER->CONVERGED = flag(a, "converged");
        plan.TOTAL_DELTA_V_KM_S = num(a, "totalDeltaV") / kKm;
        plan.TOTAL_TIME_S = num(a, "totalTime");
        double start = 0.0;
        int index = 0;
        for (const Value& leg : member(a, "legs").items) {
            const double tof = num(leg, "tof");
            const std::string name = "leg " + std::to_string(index + 1);
            auto l = arc(name.c_str(), mplArcRole::Leg, start, tof);
            l->START_STATE = line(numbers(leg, "from", kKm), {});
            l->END_STATE = line(numbers(leg, "to", kKm), numbers(leg, "targetVelocity", kKm));
            l->STATE_AXES = mplAxes::RIC;
            l->DELTA_V_KM_S = num(leg, "totalDeltaV") / kKm;
            l->SOLVER = std::make_unique<mplSolverT>();
            l->SOLVER->CONVERGED = flag(leg, "converged");
            l->SOLVER->ITERATIONS = static_cast<uint32_t>(num(leg, "iterations"));
            l->SOLVER->RESIDUAL = num(leg, "positionError") / kKm;
            plan.ARCS.push_back(std::move(l));
            for (int k = 0; k < 2; ++k) {
                const Value& m = member(leg, k == 0 ? "burn1" : "burn2");
                const std::string burnName = name + (k == 0 ? " departure" : " arrival");
                auto b = burn(burnName.c_str(), k == 0 ? start : start + tof, mplAxes::RIC,
                              numbers(m, "deltaV", kKm), num(m, "magnitude"), k == 0 ? index : -1);
                b->REFERENCE_ORBIT = chiefOut(member(m, "chief"));
                plan.BURNS.push_back(std::move(b));
            }
            start += tof;
            ++index;
        }
        auto trajectory = std::make_unique<mplTrajectoryT>();
        trajectory->AXES = mplAxes::RIC;
        trajectory->STATE_SIZE = 6;
        for (const Value& p : member(a, "trajectory").items) {
            trajectory->OFFSETS_S.push_back(num(p, "time"));
            append3(&trajectory->STATES, p, "position", kKm);
            append3(&trajectory->STATES, p, "velocity", kKm);
        }
        plan.TRAJECTORY = std::move(trajectory);
    } else if (operation == "computeCAM") {
        plan.BURNS.push_back(burn("avoidance", num(a, "optimalBurnTime"), mplAxes::RIC,
                                  numbers(a, "deltaV", kKm), num(a, "magnitude"), -1));
        plan.TOTAL_DELTA_V_KM_S = num(a, "magnitude") / kKm;
        mplRelativeSolutionT& r = relative(plan);
        r.ACHIEVED_MISS_KM = num(a, "achievedMiss") / kKm;
        r.FEASIBLE = flag(a, "feasible");
    } else if (operation == "computeApproach") {
        plan.TOTAL_DELTA_V_KM_S = num(member(a, "leg"), "totalDeltaV") / kKm;
        mplRelativeSolutionT& r = relative(plan);
        r.CORRIDOR_DEVIATION_KM = num(a, "corridorDeviation") / kKm;
        r.WITHIN_CORRIDOR = flag(a, "withinCorridor");
    } else if (operation == "simulateRendezvous") {
        auto r = std::make_unique<mplRendezvousSolutionT>();
        r->MODEL_REFERENCE = str(a, "reference");
        r->MEAN_MOTION_RAD_S = num(a, "meanMotion");
        r->INITIAL_VELOCITY_KM_S = numbers(a, "solvedInitialVelocity", kKm);
        r->KP_PER_S2 = numbers(member(a, "gains"), "kp", 1.0);
        r->KD_PER_S = numbers(member(a, "gains"), "kd", 1.0);
        const Value& phases = member(a, "phases");
        r->DRIFT_END_S = num(phases, "driftEnd");
        r->BRAKE_END_S = num(phases, "brakeEnd");
        r->TOTAL_TIME_S = num(phases, "totalTime");
        const Value& m = member(a, "metrics");
        r->MAX_CONTROL_ACCELERATION_KM_S2 = num(m, "maxControlAccel") / kKm;
        r->SATURATED_STEPS = static_cast<uint32_t>(num(m, "saturatedSteps"));
        r->MAX_POSITION_ERROR_KM = num(m, "maxPositionError") / kKm;
        r->RMS_POSITION_ERROR_KM = num(m, "rmsPositionError") / kKm;
        r->MAX_POSITION_ERROR_DRIFT_KM = num(m, "maxPositionErrorDrift") / kKm;
        r->MAX_POSITION_ERROR_BRAKE_KM = num(m, "maxPositionErrorBrake") / kKm;
        r->MAX_POSITION_ERROR_HOLD_KM = num(m, "maxPositionErrorHold") / kKm;
        r->FINAL_POSITION_ERROR_KM = num(m, "finalPositionError") / kKm;
        r->FINAL_VELOCITY_ERROR_KM_S = num(m, "finalVelocityError") / kKm;
        for (const Value& s : member(a, "trajectory").items) {
            r->SAMPLE_TIME_S.push_back(num(s, "time"));
            const std::string phase = str(s, "phase");
            r->SAMPLE_PHASE.push_back(phase == "drift" ? mplRendezvousPhase::Drift
                                      : phase == "brake" ? mplRendezvousPhase::Brake
                                      : phase == "hold" ? mplRendezvousPhase::Hold
                                                        : mplRendezvousPhase::Unspecified);
            append3(&r->POSITION_KM, s, "position", kKm);
            append3(&r->VELOCITY_KM_S, s, "velocity", kKm);
            append3(&r->REFERENCE_POSITION_KM, s, "referencePosition", kKm);
            append3(&r->REFERENCE_VELOCITY_KM_S, s, "referenceVelocity", kKm);
            append3(&r->REFERENCE_ACCELERATION_KM_S2, s, "referenceAcceleration", kKm);
            append3(&r->CONTROL_ACCELERATION_KM_S2, s, "controlAccel", kKm);
            r->POSITION_ERROR_KM.push_back(num(s, "positionError") / kKm);
            r->VELOCITY_ERROR_KM_S.push_back(num(s, "velocityError") / kKm);
        }
        plan.TOTAL_DELTA_V_KM_S = num(m, "totalDeltaV") / kKm;
        plan.TOTAL_TIME_S = num(phases, "totalTime");
        plan.RENDEZVOUS = std::move(r);
    } else if (operation == "evaluateOrbitGeometry") {
        mplGeometrySolutionT& g = geometry(plan);
        const Value& state = member(a, "state");
        g.STATE = line(numbers(state, "position", kKm), numbers(state, "velocity", kKm));
        const Value& e = member(a, "elements");
        g.ELEMENTS = std::make_unique<mplElementsT>();
        g.ELEMENTS->SEMI_MAJOR_AXIS_KM = num(e, "semiMajorAxis") / kKm;
        g.ELEMENTS->ECCENTRICITY = num(e, "eccentricity");
        g.ELEMENTS->INCLINATION_DEG = num(e, "inclination") * kRadToDeg;
        g.ELEMENTS->RAAN_DEG = num(e, "raan") * kRadToDeg;
        g.ELEMENTS->ARG_OF_PERIAPSIS_DEG = num(e, "argumentOfPeriapsis") * kRadToDeg;
        g.ELEMENTS->TRUE_ANOMALY_DEG = num(e, "trueAnomaly") * kRadToDeg;
        g.ELEMENTS->MEAN_ANOMALY_DEG = num(e, "meanAnomaly") * kRadToDeg;
        g.ELEMENTS->ASCENDING_NODE_TRUE_ANOMALY_DEG = num(e, "ascendingNodeTrueAnomaly") * kRadToDeg;
        g.ELEMENTS->MEAN_MOTION_DEG_S = num(e, "meanMotion") * kRadToDeg;
        g.ELEMENTS->PERIOD_S = num(e, "period");
        g.ELEMENTS->PERIAPSIS_RADIUS_KM = num(e, "periapsisRadius") / kKm;
        g.ELEMENTS->APOAPSIS_RADIUS_KM = num(e, "apoapsisRadius") / kKm;
        g.RADIUS_KM = num(a, "radius") / kKm;
        const Value& ric = member(a, "departureRicBasis");
        append3(&g.RIC_BASIS, ric, "radial", 1.0);
        append3(&g.RIC_BASIS, ric, "inTrack", 1.0);
        append3(&g.RIC_BASIS, ric, "crossTrack", 1.0);
        const Value& vnc = member(a, "departureVncBasis");
        append3(&g.VNC_BASIS, vnc, "velocity", 1.0);
        append3(&g.VNC_BASIS, vnc, "normal", 1.0);
        append3(&g.VNC_BASIS, vnc, "conormal", 1.0);
    } else if (operation == "convertOrbitAnomaly") {
        mplGeometrySolutionT& g = geometry(plan);
        g.ELEMENTS = std::make_unique<mplElementsT>();
        if (plan.REQUEST && plan.REQUEST->GEOMETRY) g.ELEMENTS->ECCENTRICITY = plan.REQUEST->GEOMETRY->ECCENTRICITY;
        g.ELEMENTS->TRUE_ANOMALY_DEG = num(a, "trueAnomaly") * kRadToDeg;
        g.ELEMENTS->MEAN_ANOMALY_DEG = num(a, "meanAnomaly") * kRadToDeg;
        g.ELEMENTS->ECCENTRIC_ANOMALY_DEG = num(a, "eccentricAnomaly") * kRadToDeg;
    } else if (operation == "orbitTimeOfFlight") {
        geometry(plan).TIME_OF_FLIGHT_S = num(a, "seconds");
        plan.TOTAL_TIME_S = num(a, "seconds");
    } else if (operation == "sampleOrbitGeometry") {
        auto trajectory = std::make_unique<mplTrajectoryT>();
        trajectory->AXES = mplAxes::Inertial;
        trajectory->STATE_SIZE = 3;
        trajectory->OFFSETS_S = numbers(a, "offsets", 1.0);
        trajectory->STATES = numbers(a, "positions", kKm);
        plan.TRAJECTORY = std::move(trajectory);
    } else if (operation == "transformDeltaV") {
        mplGeometrySolutionT& g = geometry(plan);
        g.BURN = burn("rotated", 0.0, str(a, "frame") == "ECI" ? mplAxes::Inertial : mplAxes::RIC,
                      numbers(a, "deltaV", kKm), num(a, "magnitude"), -1);
        const Value& basis = member(a, "basis");
        append3(&g.RIC_BASIS, basis, "R", 1.0);
        append3(&g.RIC_BASIS, basis, "I", 1.0);
        append3(&g.RIC_BASIS, basis, "C", 1.0);
    }
}

mplStatus statusOf(const std::string& code) {
    if (code == "invalid-parameter" || code == "malformed-request" || code == "unknown-operation") {
        return mplStatus::InvalidRequest;
    }
    if (code == "no-solution") return mplStatus::NoSolution;
    if (code == "infeasible") return mplStatus::Infeasible;
    if (code == "singular-configuration") return mplStatus::SingularGeometry;
    return mplStatus::Failed;
}

/// Clear what an answer fills, so a request that arrived carrying results
/// cannot leak them into the plan.
void clearAnswer(MPLT& plan) {
    plan.STATUS = mplStatus::Pending;
    plan.ERROR_CODE.clear();
    plan.ERROR_MESSAGE.clear();
    plan.BURNS.clear();
    plan.ARCS.clear();
    plan.TOTAL_DELTA_V_KM_S = 0.0;
    plan.TOTAL_TIME_S = 0.0;
    plan.TOTAL_DELTA_MASS_KG = 0.0;
    plan.SOLVER.reset();
    plan.OPTIONS.clear();
    plan.TRAJECTORY.reset();
    plan.PHASING.reset();
    plan.RELATIVE.reset();
    plan.RENDEZVOUS.reset();
    plan.GEOMETRY.reset();
}

int emit(const MPLT& plan) {
    flatbuffers::FlatBufferBuilder builder(1 << 12);
    FinishMPLBuffer(builder, MPL::Pack(builder, &plan));
    return plugin_push_output_ex("plan", "MPL.fbs", MPLIdentifier(), PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,
                                 "MPL", 0, 0, builder.GetBufferPointer(),
                                 static_cast<uint32_t>(builder.GetSize()));
}

}  // namespace
}  // namespace mpl_bridge
}  // namespace maneuver

extern "C" int plan(void) {
    using namespace maneuver::mpl_bridge;
    plugin_reset_output_state();

    const int32_t index = plugin_find_input_index("request", 0);
    const plugin_input_frame_t* frame =
        index < 0 ? nullptr : plugin_get_input_frame(static_cast<uint32_t>(index));
    if (frame == nullptr || frame->payload == nullptr || frame->payload_length < 8) {
        plugin_set_error("missing-request-input", "Input port \"request\" requires one $MPL FlatBuffer.");
        return 1;
    }
    const uint8_t* bytes = frame->payload;
    size_t length = frame->payload_length;
    // Tolerate a size-prefixed buffer.
    if (length >= 12 && std::memcmp(bytes + 8, "$MPL", 4) == 0 && std::memcmp(bytes + 4, "$MPL", 4) != 0) {
        bytes += 4;
        length -= 4;
    }
    flatbuffers::Verifier::Options options;
    options.max_depth = 64;
    options.max_tables = 10000000;
    flatbuffers::Verifier verifier(bytes, length, options);
    if (!VerifyMPLBuffer(verifier)) {
        plugin_set_error("malformed-request", "Input port \"request\" does not carry a valid $MPL FlatBuffer.");
        return 1;
    }

    MPLT plan;
    GetMPL(bytes)->UnPackTo(&plan);
    clearAnswer(plan);
    plan.PLANNER = std::string("maneuver-planner ") + maneuver::module_version();

    std::string operation;
    Obj params;
    Refusal refusal;
    std::string code;
    std::string message;
    const bool built = buildCommand(plan, &operation, &params, &refusal);
    if (!built || refusal.raised) {
        code = refusal.code.empty() ? "invalid-parameter" : refusal.code;
        message = refusal.message;
    } else {
        const maneuver::PluginInvokeResult result = maneuver::invoke_operation(operation, params.v);
        if (result.ok) {
            maneuver::json_lite::Value answer;
            std::string parseError;
            if (!maneuver::json_lite::parse(result.json, &answer, &parseError)) {
                code = "internal-error";
                message = "The operation's answer could not be read back: " + parseError;
            } else {
                writeAnswer(plan, operation, answer);
                plan.STATUS = mplStatus::Solved;
            }
        } else {
            code = result.error_code;
            message = result.error_message;
        }
    }

    if (!code.empty()) {
        // The structured refusal: STATUS and the reason on the plan itself, and
        // the same reason as the invoke error, so a caller that reads either
        // gets the same diagnosis. Never a trap, never an empty frame.
        plan.STATUS = statusOf(code);
        plan.ERROR_CODE = code;
        plan.ERROR_MESSAGE = message;
        plugin_set_error(code.c_str(), message.c_str());
        emit(plan);
        return 1;
    }
    if (emit(plan) < 0) {
        plugin_set_error("emit-failed", "Failed to emit the $MPL plan frame.");
        return 1;
    }
    return 0;
}
