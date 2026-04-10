#include "maneuver/propagation.h"
#include "maneuver/math.h"
#include "maneuver/stm.h"
#include "maneuver/transforms.h"
#include "maneuver/constants.h"

#include <cmath>
#include <stdexcept>
#include <string>

namespace maneuver {

// ===========================================================================
// drag-dispatch.ts
// ===========================================================================

static constexpr double ECCENTRICITY_THRESHOLD = 0.05;

ROEVector propagateWithDrag(const ROEVector& roe,
                            const ClassicalOrbitalElements& chief, double tau,
                            const DragConfig& dragConfig) {
    if (dragConfig.type == DragType::ECCENTRIC) {
        if (chief.eccentricity < ECCENTRICITY_THRESHOLD) {
            throw std::runtime_error(
                "[drag]: Eccentric model requires e >= " +
                std::to_string(ECCENTRICITY_THRESHOLD) +
                " (e=" + std::to_string(chief.eccentricity) +
                "). Use 'arbitrary' model for near-circular orbits.");
        }
        auto result = computeJ2DragSTMEccentric(chief, tau);
        return propagateJ2DragEccentric(result, roe, dragConfig.daDotDrag);
    } else {
        auto result = computeJ2DragSTMArbitrary(chief, tau);
        return propagateJ2DragArbitrary(result, roe, dragConfig.daDotDrag,
                                       dragConfig.dexDotDrag,
                                       dragConfig.deyDotDrag);
    }
}

// ===========================================================================
// propagate.ts
// ===========================================================================

QuasiNonsingularROE propagateROE(const QuasiNonsingularROE& initialROE,
                                 const ClassicalOrbitalElements& chief,
                                 double deltaTime,
                                 const ROEPropagationOptions& options) {
    // Validate orbital elements
    if (chief.semiMajorAxis <= 0.0) {
        throw std::runtime_error(
            "[propagate]: Semi-major axis must be positive (a=" +
            std::to_string(chief.semiMajorAxis) + ")");
    }
    if (chief.eccentricity < 0.0 || chief.eccentricity >= 1.0) {
        throw std::runtime_error(
            "[propagate]: Eccentricity must be in [0, 1) (e=" +
            std::to_string(chief.eccentricity) + ")");
    }
    if (chief.gravitationalParameter <= 0.0) {
        throw std::runtime_error(
            "[propagate]: Gravitational parameter must be positive (mu=" +
            std::to_string(chief.gravitationalParameter) + ")");
    }

    double incDeg = chief.inclination * RAD_TO_DEG;
    if (std::abs(incDeg) < 0.1 || std::abs(incDeg - 180.0) < 0.1) {
        throw std::runtime_error(
            "[propagate]: Near-equatorial orbit not supported for "
            "quasi-nonsingular ROE (i=" +
            std::to_string(incDeg) + " deg).");
    }

    if (deltaTime < 0.0) {
        throw std::runtime_error(
            "[propagate]: Negative deltaTime not allowed (dt=" +
            std::to_string(deltaTime) + ").");
    }

    // Validate drag coupling
    if (options.includeDrag && !options.includeJ2) {
        throw std::runtime_error(
            "[propagate]: Cannot disable J2 when drag is enabled.");
    }

    if (options.includeDrag) {
        if (options.dragConfig.type == DragType::ECCENTRIC &&
            chief.eccentricity < 0.05) {
            throw std::runtime_error(
                "[propagate]: Eccentric drag model requires e >= 0.05 (e=" +
                std::to_string(chief.eccentricity) + ").");
        }
    }

    ROEVector stateVec = roeToVector(initialROE);
    ROEVector propagatedVec;

    if (options.includeDrag) {
        propagatedVec =
            propagateWithDrag(stateVec, chief, deltaTime, options.dragConfig);
    } else if (options.includeJ2) {
        STM6 stm = computeJ2STM(chief, deltaTime);
        propagatedVec = matVecMul6(stm, stateVec);
    } else {
        STM6 stm = computeKeplerianSTM(chief, deltaTime);
        propagatedVec = matVecMul6(stm, stateVec);
    }

    return vectorToROE(propagatedVec);
}

PropagateWithChiefResult propagateROEWithChief(
    const QuasiNonsingularROE& initialROE,
    const ClassicalOrbitalElements& chief, double deltaTime,
    const ROEPropagationOptions& options) {
    QuasiNonsingularROE propagatedROE =
        propagateROE(initialROE, chief, deltaTime, options);

    double n = meanMotion(chief.semiMajorAxis, chief.gravitationalParameter);
    double newM = normalizeAngle(chief.meanAnomaly + n * deltaTime);

    double newOmega = chief.argumentOfPerigee;
    double newRaan = chief.raan;

    if (options.includeJ2) {
        double kappa =
            computeKappa(chief.semiMajorAxis, chief.eccentricity,
                         chief.gravitationalParameter, J2, R_EARTH);
        double cos_i = std::cos(chief.inclination);
        double cos2_i = cos_i * cos_i;
        double Q = 5.0 * cos2_i - 1.0;
        double R = cos_i;

        newOmega =
            normalizeAngle(chief.argumentOfPerigee + kappa * Q * deltaTime);
        newRaan = normalizeAngle(chief.raan - 2.0 * kappa * R * deltaTime);
    }

    double newA = chief.semiMajorAxis;
    double newH = chief.angularMomentum;

    if (options.hasChiefAbsoluteDaDot) {
        newA = chief.semiMajorAxis + options.chiefAbsoluteDaDot * deltaTime;
        newH = std::sqrt(chief.gravitationalParameter * newA *
                         (1.0 - chief.eccentricity * chief.eccentricity));
    }

    ClassicalOrbitalElements updatedChief = chief;
    updatedChief.semiMajorAxis = newA;
    updatedChief.angularMomentum = newH;
    updatedChief.meanAnomaly = newM;
    updatedChief.argumentOfPerigee = newOmega;
    updatedChief.raan = newRaan;

    return {propagatedROE, updatedChief};
}

std::vector<ROETrajectoryPoint> generateROETrajectory(
    const QuasiNonsingularROE& initialROE,
    const ClassicalOrbitalElements& chief, double totalTime, int numSteps,
    const ROEPropagationOptions& options) {
    double dt = totalTime / numSteps;

    std::vector<ROETrajectoryPoint> trajectory;
    trajectory.reserve(numSteps + 1);
    trajectory.push_back({0.0, initialROE, chief});

    QuasiNonsingularROE currentROE = initialROE;
    ClassicalOrbitalElements currentChief = chief;

    for (int i = 1; i <= numSteps; ++i) {
        auto result =
            propagateROEWithChief(currentROE, currentChief, dt, options);
        trajectory.push_back({i * dt, result.roe, result.chief});
        currentROE = result.roe;
        currentChief = result.chief;
    }

    return trajectory;
}

}  // namespace maneuver
