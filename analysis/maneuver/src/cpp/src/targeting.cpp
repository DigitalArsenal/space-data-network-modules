#include "maneuver/targeting.h"
#include "maneuver/math.h"
#include "maneuver/stm.h"
#include "maneuver/transforms.h"
#include "maneuver/propagation.h"
#include "maneuver/constants.h"

#include <cmath>
#include <algorithm>
#include <limits>
#include <stdexcept>
#include <string>

namespace maneuver {

// ===========================================================================
// control-matrix.ts
// ===========================================================================

ControlMatrix6x3 computeControlMatrix(const ClassicalOrbitalElements& chief) {
    double a = chief.semiMajorAxis;
    double e = chief.eccentricity;
    double omega = chief.argumentOfPerigee;

    double nu = trueAnomalyFromMean(chief.meanAnomaly, e);
    double u = omega + nu;
    double n = meanMotion(a, chief.gravitationalParameter);

    double sin_u = std::sin(u);
    double cos_u = std::cos(u);
    double k = 1.0 / (n * a);

    return {{
        {0.0, 2.0 * k, 0.0},
        {-2.0 * k, 0.0, 0.0},
        {sin_u * k, 2.0 * cos_u * k, 0.0},
        {-cos_u * k, 2.0 * sin_u * k, 0.0},
        {0.0, 0.0, cos_u * k},
        {0.0, 0.0, sin_u * k},
    }};
}

ROEVector applyDeltaV(const ROEVector& roe, const Vector3& deltaV,
                      const ClassicalOrbitalElements& chief) {
    ControlMatrix6x3 B = computeControlMatrix(chief);
    ROEVector dROE = matMul6x3_3x1(B, deltaV);
    return addROE(roe, dROE);
}

Vector3 computeApproximateDeltaV(const ROEVector& desiredDROE,
                                 const ClassicalOrbitalElements& chief) {
    double a = chief.semiMajorAxis;
    double e = chief.eccentricity;
    double omega = chief.argumentOfPerigee;

    double nu = trueAnomalyFromMean(chief.meanAnomaly, e);
    double u = omega + nu;
    double n = meanMotion(a, chief.gravitationalParameter);

    double sin_u = std::sin(u);
    double cos_u = std::cos(u);

    double dda = desiredDROE[0];
    double ddlambda = desiredDROE[1];
    double ddix = desiredDROE[4];
    double ddiy = desiredDROE[5];

    double dvI_from_da = (dda * n * a) / 2.0;
    double dvR_from_dlambda = (-ddlambda * n * a) / 2.0;
    double dvC = (ddix * cos_u + ddiy * sin_u) * n * a;

    return {dvR_from_dlambda, dvI_from_da, dvC};
}

// ===========================================================================
// rendezvous.ts — Internal helpers
// ===========================================================================

namespace {

constexpr int DEFAULT_MAX_ITERATIONS = 50;
constexpr double DEFAULT_POSITION_TOLERANCE = 0.1;  // meters
constexpr double JACOBIAN_PERTURBATION = 1e-4;      // m/s

struct PropBurnResult {
    RelativeState arrivalRIC;
    ClassicalOrbitalElements chiefAtArrival;
};

ROEPropagationOptions toPropOptions(const TargetingOptions& opts) {
    ROEPropagationOptions po;
    po.includeJ2 = opts.includeJ2;
    po.includeDrag = opts.includeDrag;
    po.dragConfig = opts.dragConfig;
    return po;
}

PropBurnResult propagateWithBurn(const ROEVector& initialROE,
                                 const Vector3& dv1,
                                 const ClassicalOrbitalElements& chief,
                                 double tof,
                                 const ROEPropagationOptions& propOptions) {
    ROEVector roeAfterDv1 = applyDeltaV(initialROE, dv1, chief);
    auto result =
        propagateROEWithChief(vectorToROE(roeAfterDv1), chief, tof, propOptions);
    RelativeState arrivalRIC = roeToRIC(result.chief, result.roe);
    return {arrivalRIC, result.chief};
}

/// Compute CW initial guess for dv1.
Vector3 computeInitialGuess(const RelativeState& initialState,
                            const Vector3& targetPosition,
                            const ClassicalOrbitalElements& chief,
                            double tof) {
    double n = std::sqrt(chief.gravitationalParameter /
                         (chief.semiMajorAxis * chief.semiMajorAxis *
                          chief.semiMajorAxis));
    double nt = n * tof;
    double snt = std::sin(nt);
    double cnt = std::cos(nt);

    double x0 = initialState.position[0], y0 = initialState.position[1],
           z0 = initialState.position[2];
    double vx0 = initialState.velocity[0], vy0 = initialState.velocity[1],
           vz0 = initialState.velocity[2];
    double xf = targetPosition[0], yf = targetPosition[1],
           zf = targetPosition[2];

    double dx = xf - x0;
    double dy = yf - y0;
    double dz = zf - z0;

    if (std::abs(nt) < 0.1) {
        return {dx / tof - vx0, dy / tof - vy0, dz / tof - vz0};
    }

    double denom_x = 2.0 * (1.0 - cnt);
    double denom_y = 4.0 * snt - 3.0 * nt;

    double dvx = (std::abs(denom_x) > 1e-15) ? (dx * n) / denom_x - vx0 : -vx0;
    double dvy = (std::abs(denom_y) > 1e-15)
                     ? (dy * n) / denom_y -
                           (6.0 * (snt - nt) * x0 * n) / denom_y - vy0
                     : -vy0;
    double dvz = (std::abs(snt) > 1e-15)
                     ? ((dz - z0 * cnt) * n) / snt - vz0
                     : -vz0;

    constexpr double maxDv = 10.0;
    auto clamp = [&](double v) {
        return std::isnan(v) ? 0.0
                             : std::max(-maxDv, std::min(maxDv, v));
    };

    return {clamp(dvx), clamp(dvy), clamp(dvz)};
}

/// Compute arrival position partial derivative via central differences.
Vector3 computeArrivalPositionDerivative(const ROEVector& initialROE,
                                         const Vector3& dv1, int component,
                                         double eps,
                                         const ClassicalOrbitalElements& chief,
                                         double tof,
                                         const ROEPropagationOptions& po) {
    Vector3 dv1Plus = dv1;
    Vector3 dv1Minus = dv1;
    dv1Plus[component] += eps;
    dv1Minus[component] -= eps;

    auto rPlus = propagateWithBurn(initialROE, dv1Plus, chief, tof, po);
    auto rMinus = propagateWithBurn(initialROE, dv1Minus, chief, tof, po);

    double twoEps = 2.0 * eps;
    return {(rPlus.arrivalRIC.position[0] - rMinus.arrivalRIC.position[0]) / twoEps,
            (rPlus.arrivalRIC.position[1] - rMinus.arrivalRIC.position[1]) / twoEps,
            (rPlus.arrivalRIC.position[2] - rMinus.arrivalRIC.position[2]) / twoEps};
}

Matrix3x3 computeJacobian(const ROEVector& initialROE, const Vector3& dv1,
                           const ClassicalOrbitalElements& chief, double tof,
                           const ROEPropagationOptions& po) {
    double eps = JACOBIAN_PERTURBATION;

    Vector3 col0 =
        computeArrivalPositionDerivative(initialROE, dv1, 0, eps, chief, tof, po);
    Vector3 col1 =
        computeArrivalPositionDerivative(initialROE, dv1, 1, eps, chief, tof, po);
    Vector3 col2 =
        computeArrivalPositionDerivative(initialROE, dv1, 2, eps, chief, tof, po);

    // Transpose columns to rows
    return {{
        {col0[0], col1[0], col2[0]},
        {col0[1], col1[1], col2[1]},
        {col0[2], col1[2], col2[2]},
    }};
}

}  // anonymous namespace

// ===========================================================================
// rendezvous.ts — Public API
// ===========================================================================

ManeuverLeg solveRendezvous(const RelativeState& initialState,
                            const Vector3& targetPosition,
                            const ClassicalOrbitalElements& chief, double tof,
                            const TargetingOptions& options) {
    int maxIter = options.maxIterations;
    double posTol = options.positionTolerance;
    ROEPropagationOptions propOptions = toPropOptions(options);

    ROEVector initialROE = roeToVector(ricToROE(chief, initialState));

    Vector3 dv1 =
        computeInitialGuess(initialState, targetPosition, chief, tof);

    bool converged = false;
    int iterations = 0;
    Vector3 finalPosition = ZERO_VECTOR3;
    Vector3 dv2 = ZERO_VECTOR3;
    ClassicalOrbitalElements chiefAtArrival = chief;
    RelativeState arrivalRIC = {ZERO_VECTOR3, ZERO_VECTOR3};

    for (int iter = 0; iter < maxIter; ++iter) {
        iterations = iter + 1;

        auto result =
            propagateWithBurn(initialROE, dv1, chief, tof, propOptions);
        chiefAtArrival = result.chiefAtArrival;
        arrivalRIC = result.arrivalRIC;
        finalPosition = arrivalRIC.position;

        double posError = norm3(sub3(targetPosition, finalPosition));

        if (posError < posTol) {
            converged = true;
            break;
        }

        auto jacobian =
            computeJacobian(initialROE, dv1, chief, tof, propOptions);

        Vector3 positionError = sub3(targetPosition, finalPosition);

        Vector3 dv1Correction;
        try {
            Matrix3x3 jacobianInv = invert3x3(jacobian);
            dv1Correction = matMul3x3_3x1(jacobianInv, positionError);
        } catch (...) {
            dv1Correction = positionError;
        }

        double damping;
        if (iter < 3)
            damping = 0.5;
        else if (iter < 10)
            damping = 0.8;
        else
            damping = 1.0;

        dv1 = add3(dv1, {damping * dv1Correction[0],
                         damping * dv1Correction[1],
                         damping * dv1Correction[2]});
    }

    Vector3 targetVelocity = options.targetVelocity;
    dv2 = sub3(targetVelocity, arrivalRIC.velocity);

    double finalPositionError = norm3(sub3(targetPosition, finalPosition));

    ManeuverLeg leg;
    leg.from = initialState.position;
    leg.to = targetPosition;
    leg.targetVelocity = targetVelocity;
    leg.tof = tof;
    leg.burn1 = {dv1, norm3(dv1), chief};
    leg.burn2 = {dv2, norm3(dv2), chiefAtArrival};
    leg.totalDeltaV = norm3(dv1) + norm3(dv2);
    leg.converged = converged;
    leg.iterations = iterations;
    leg.positionError = finalPositionError;
    return leg;
}

// ===========================================================================
// tof-optimizer.ts
// ===========================================================================

namespace {

constexpr double DEFAULT_MIN_ORBITS = 0.5;
constexpr double DEFAULT_MAX_ORBITS = 3.0;
constexpr double DEFAULT_TOF_TOLERANCE_FRACTION = 0.01;

double evaluateDeltaV(const RelativeState& initialState,
                      const Vector3& targetPosition,
                      const ClassicalOrbitalElements& chief, double tof,
                      const TargetingOptions& options) {
    try {
        ManeuverLeg leg =
            solveRendezvous(initialState, targetPosition, chief, tof, options);
        if (!leg.converged) return std::numeric_limits<double>::infinity();
        return leg.totalDeltaV;
    } catch (...) {
        return std::numeric_limits<double>::infinity();
    }
}

}  // anonymous namespace

ManeuverLeg optimizeTOF(const RelativeState& initialState,
                        const Vector3& targetPosition,
                        const ClassicalOrbitalElements& chief,
                        const TargetingOptions& options) {
    double n = meanMotion(chief.semiMajorAxis, chief.gravitationalParameter);
    double period = TWO_PI / n;

    double minOrbits = options.tofMinOrbits;
    double maxOrbits = options.tofMaxOrbits;
    if (minOrbits <= 0.0) minOrbits = DEFAULT_MIN_ORBITS;
    if (maxOrbits <= 0.0) maxOrbits = DEFAULT_MAX_ORBITS;

    double tofMin = minOrbits * period;
    double tofMax = maxOrbits * period;
    double tolerance = DEFAULT_TOF_TOLERANCE_FRACTION * period;

    constexpr double PHI = 1.6180339887498949;
    constexpr double GOLDEN_RATIO = 1.0 / PHI;

    double a = tofMin;
    double b = tofMax;
    double c = b - (b - a) * GOLDEN_RATIO;
    double d = a + (b - a) * GOLDEN_RATIO;

    double fc =
        evaluateDeltaV(initialState, targetPosition, chief, c, options);
    double fd =
        evaluateDeltaV(initialState, targetPosition, chief, d, options);

    while (std::abs(b - a) > tolerance) {
        if (fc < fd) {
            b = d;
            d = c;
            fd = fc;
            c = b - (b - a) * GOLDEN_RATIO;
            fc = evaluateDeltaV(initialState, targetPosition, chief, c, options);
        } else {
            a = c;
            c = d;
            fc = fd;
            d = a + (b - a) * GOLDEN_RATIO;
            fd = evaluateDeltaV(initialState, targetPosition, chief, d, options);
        }
    }

    double optimalTOF = (a + b) / 2.0;
    return solveRendezvous(initialState, targetPosition, chief, optimalTOF,
                           options);
}

// ===========================================================================
// planner.ts
// ===========================================================================

MissionPlan planMission(const RelativeState& initialState,
                        const std::vector<Waypoint>& waypoints,
                        const ClassicalOrbitalElements& chief,
                        const TargetingOptions& options) {
    if (waypoints.empty()) {
        return {{}, 0.0, 0.0, true};
    }

    std::vector<ManeuverLeg> legs;
    RelativeState currentState = initialState;
    ClassicalOrbitalElements currentChief = chief;
    double totalDeltaV = 0.0;
    double totalTime = 0.0;
    bool allConverged = true;

    for (const auto& waypoint : waypoints) {
        TargetingOptions legOptions = options;
        legOptions.targetVelocity =
            waypoint.hasVelocity ? waypoint.velocity : ZERO_VECTOR3;

        ManeuverLeg leg;
        if (!waypoint.hasTofHint) {
            leg = optimizeTOF(currentState, waypoint.position, currentChief,
                              legOptions);
        } else {
            leg = solveRendezvous(currentState, waypoint.position, currentChief,
                                 waypoint.tofHint, legOptions);
        }

        legs.push_back(leg);
        totalDeltaV += leg.totalDeltaV;
        totalTime += leg.tof;
        allConverged = allConverged && leg.converged;

        currentState.position = waypoint.position;
        currentState.velocity =
            waypoint.hasVelocity ? waypoint.velocity : ZERO_VECTOR3;
        currentChief = leg.burn2.chief;
    }

    return {legs, totalDeltaV, totalTime, allConverged};
}

// ===========================================================================
// trajectory.ts
// ===========================================================================

std::vector<TrajectoryPoint> generateLegTrajectory(
    const ManeuverLeg& leg, const ClassicalOrbitalElements& chief,
    const Vector3& initialPosition, const Vector3& initialVelocity,
    const TargetingOptions& options, int numPoints) {
    ROEPropagationOptions propOptions = toPropOptions(options);

    RelativeState initialRIC = {initialPosition, initialVelocity};
    ROEVector initialROE = roeToVector(ricToROE(chief, initialRIC));
    ROEVector roeAfterDv1 = applyDeltaV(initialROE, leg.burn1.deltaV, chief);

    std::vector<TrajectoryPoint> trajectory;
    trajectory.reserve(numPoints);
    double dt = leg.tof / (numPoints - 1);

    for (int i = 0; i < numPoints; ++i) {
        double t = i * dt;

        if (t == 0.0) {
            RelativeState ricAfterDv1 = roeToRIC(chief, vectorToROE(roeAfterDv1));
            trajectory.push_back({0.0, ricAfterDv1.position, ricAfterDv1.velocity});
        } else {
            auto result =
                propagateROEWithChief(vectorToROE(roeAfterDv1), chief, t, propOptions);
            RelativeState ricAtT = roeToRIC(result.chief, result.roe);
            trajectory.push_back({t, ricAtT.position, ricAtT.velocity});
        }
    }

    return trajectory;
}

std::vector<TrajectoryPoint> generateMissionTrajectory(
    const MissionPlan& plan, const ClassicalOrbitalElements& initialChief,
    const Vector3& initialPosition, const Vector3& initialVelocity,
    const TargetingOptions& options, int pointsPerLeg) {
    if (plan.legs.empty()) return {};

    std::vector<TrajectoryPoint> trajectory;
    double timeOffset = 0.0;
    ClassicalOrbitalElements currentChief = initialChief;
    Vector3 currentPosition = initialPosition;
    Vector3 currentVelocity = initialVelocity;

    for (const auto& leg : plan.legs) {
        auto legTrajectory = generateLegTrajectory(
            leg, currentChief, currentPosition, currentVelocity, options,
            pointsPerLeg);

        for (const auto& point : legTrajectory) {
            trajectory.push_back(
                {timeOffset + point.time, point.position, point.velocity});
        }

        timeOffset += leg.tof;
        currentChief = leg.burn2.chief;
        currentPosition = leg.to;
        currentVelocity = leg.targetVelocity;
    }

    return trajectory;
}

// ===========================================================================
// validation.ts
// ===========================================================================

TargetingValidationResult validateTargetingConfig(
    const ClassicalOrbitalElements& chief, const TargetingOptions& options) {
    if (chief.semiMajorAxis <= 0.0) {
        return {false, TargetingValidationCode::INVALID_CHIEF_ELEMENTS,
                "Semi-major axis must be positive (a=" +
                    std::to_string(chief.semiMajorAxis) + " m)",
                ""};
    }

    if (chief.eccentricity < 0.0 || chief.eccentricity >= 1.0) {
        return {false, TargetingValidationCode::INVALID_CHIEF_ELEMENTS,
                "Eccentricity must be in range [0, 1) (e=" +
                    std::to_string(chief.eccentricity) + ")",
                ""};
    }

    if (chief.gravitationalParameter <= 0.0) {
        return {false, TargetingValidationCode::INVALID_CHIEF_ELEMENTS,
                "Gravitational parameter must be positive",
                ""};
    }

    double incDeg = chief.inclination * RAD_TO_DEG;
    if (std::abs(incDeg) < 0.1 || std::abs(incDeg - 180.0) < 0.1) {
        return {false, TargetingValidationCode::INVALID_CHIEF_ELEMENTS,
                "Near-equatorial orbit not supported (i=" +
                    std::to_string(incDeg) + " deg)",
                "Quasi-nonsingular ROE requires i > 0.1 deg."};
    }

    if (options.includeDrag) {
        if (options.dragConfig.type == DragType::ECCENTRIC &&
            chief.eccentricity < 0.05) {
            return {false, TargetingValidationCode::INVALID_CHIEF_ELEMENTS,
                    "Eccentric drag model requires e >= 0.05 (e=" +
                        std::to_string(chief.eccentricity) + ")",
                    "Switch to 'arbitrary' drag model for near-circular orbits."};
        }
    }

    return {true, TargetingValidationCode::VALID, "", ""};
}

}  // namespace maneuver
