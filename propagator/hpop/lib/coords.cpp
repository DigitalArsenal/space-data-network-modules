#include "coords.h"
#include <cmath>
#include <limits>
extern "C" {
#include "erfa.h"
#include "erfam.h"
}

namespace coords {
namespace {
Matrix3x3 invalidMatrix() {
    Matrix3x3 result;
    for (double& value : result.m) value = std::numeric_limits<double>::quiet_NaN();
    return result;
}

Epoch fromUtc(double jdUtc) {
    if (!std::isfinite(jdUtc)) return {jdUtc, jdUtc, jdUtc, jdUtc};
    const double day = std::floor(jdUtc - 0.5) + 0.5;
    const double fraction = jdUtc - day;
    double tai1, tai2, tt1, tt2;
    // Positive ERFA statuses flag future leap-second uncertainty; the last
    // known offset is still usable. Negative statuses indicate invalid dates.
    if (eraUtctai(day, fraction, &tai1, &tai2) < 0 ||
        eraTaitt(tai1, tai2, &tt1, &tt2) != 0) {
        const double nan = std::numeric_limits<double>::quiet_NaN();
        return {nan, nan, nan, nan};
    }
    return {tt1, tt2, day, fraction};
}

bool valid(Frame frame, const Epoch& epoch) {
    return static_cast<unsigned>(frame) <= static_cast<unsigned>(Frame::MOD) &&
           std::isfinite(epoch.tt1) && std::isfinite(epoch.tt2) &&
           std::isfinite(epoch.ut11) && std::isfinite(epoch.ut12);
}

Frame canonical(Frame frame) {
    if (frame == Frame::J2000) return Frame::GCRF;
    if (frame == Frame::ECEF || frame == Frame::PEF) return Frame::ITRF;
    return frame;
}

// One authoritative GCRF-to-frame definition; all pairs compose these bases.
Matrix3x3 frameBasis(Frame frame, const Epoch& epoch) {
    double matrix[3][3];
    switch (canonical(frame)) {
        case Frame::GCRF:
            return Matrix3x3::identity();
        case Frame::MOD:
            eraPmat76(epoch.tt1, epoch.tt2, matrix);
            return Matrix3x3(&matrix[0][0]);
        case Frame::TOD:
            eraPnm80(epoch.tt1, epoch.tt2, matrix);
            return Matrix3x3(&matrix[0][0]);
        case Frame::TEME:
            eraPnm80(epoch.tt1, epoch.tt2, matrix);
            eraRz(eraEqeq94(epoch.tt1, epoch.tt2), matrix);
            return Matrix3x3(&matrix[0][0]);
        case Frame::ITRF:
            eraPnm80(epoch.tt1, epoch.tt2, matrix);
            eraRz(eraGst94(epoch.ut11, epoch.ut12), matrix);
            return Matrix3x3(&matrix[0][0]);
        default:
            return invalidMatrix();
    }
}

bool rotating(Frame frame) {
    return canonical(frame) == Frame::ITRF;
}

double earthRotationRate(const Epoch& epoch) {
    // Derivative of eraGmst82's sidereal-seconds polynomial, plus its
    // fractional-UT1-day term. Coefficients are from ERFA gmst82.c (IAU 1982).
    const double t = ((epoch.ut11 - ERFA_DJ00) + epoch.ut12) / ERFA_DJC;
    const double secular = 8640184.812866 + (2 * 0.093104 - 3 * 6.2e-6 * t) * t;
    return (1 + secular / (ERFA_DJC * ERFA_DAYSEC)) * (ERFA_D2PI / ERFA_DAYSEC);
}
} // namespace

Matrix3x3 getTransformMatrix(Frame from, Frame to, const Epoch& epoch) {
    if (!valid(from, epoch) || !valid(to, epoch)) return invalidMatrix();
    from = canonical(from);
    to = canonical(to);
    if (from == to) return Matrix3x3::identity();
    if (from == Frame::GCRF) return frameBasis(to, epoch);
    if (to == Frame::GCRF) return frameBasis(from, epoch).transpose();
    // This direct pair is the defining ERFA nutation matrix, avoiding a
    // numerical cancellation of the shared precession in the generic chain.
    if ((from == Frame::MOD && to == Frame::TOD) ||
        (from == Frame::TOD && to == Frame::MOD)) {
        double matrix[3][3];
        eraNutm80(epoch.tt1, epoch.tt2, matrix);
        const Matrix3x3 nutation(&matrix[0][0]);
        return from == Frame::MOD ? nutation : nutation.transpose();
    }
    return frameBasis(to, epoch) * frameBasis(from, epoch).transpose();
}

Matrix3x3 getTransformMatrix(Frame from, Frame to, double jdUtc) {
    return getTransformMatrix(from, to, fromUtc(jdUtc));
}

StateVec transform(const StateVec& state, Frame from, Frame to, const Epoch& epoch) {
    const Matrix3x3 matrix = getTransformMatrix(from, to, epoch);
    const Vec3 position = matrix.apply(state.position);
    Vec3 velocity = matrix.apply(state.velocity);
    const Vec3 omega(0, 0, earthRotationRate(epoch));
    if (rotating(to) && !rotating(from)) {
        velocity = velocity - omega.cross(position);
    } else if (rotating(from) && !rotating(to)) {
        velocity = velocity + matrix.apply(omega.cross(state.position));
    }
    return StateVec(position, velocity);
}

StateVec transform(const StateVec& state, Frame from, Frame to, double jdUtc) {
    return transform(state, from, to, fromUtc(jdUtc));
}

Vec3 transformPosition(const Vec3& position, Frame from, Frame to, double jdUtc) {
    return getTransformMatrix(from, to, jdUtc).apply(position);
}

Matrix3x3 gcrfToItrf(double jdUtc, double xp, double yp) {
    double polar[3][3];
    eraPom00(xp * ERFA_DAS2R, yp * ERFA_DAS2R, 0, polar);
    return Matrix3x3(&polar[0][0]) * getTransformMatrix(Frame::GCRF, Frame::ITRF, jdUtc);
}

Matrix3x3 temeToGcrf(double jdUtc) {
    return getTransformMatrix(Frame::TEME, Frame::GCRF, jdUtc);
}
} // namespace coords
