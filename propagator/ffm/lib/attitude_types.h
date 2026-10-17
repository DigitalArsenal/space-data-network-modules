// attitude_types.h - Attitude Guidance & Control Type Definitions
// =============================================================================
// Phase 11.2: Attitude Guidance & Control (Basilisk Port)
// Provides attitude representation types (Quaternion, MRP, Euler), guidance
// modes, control laws, and effector interfaces.
// =============================================================================

#pragma once

#include "astrodynamics_types.h"
#include <cmath>
#include <array>

namespace astro {

// =============================================================================
// Attitude Representation Types
// =============================================================================

// -----------------------------------------------------------------------------
// Quaternion (Hamilton convention: scalar-first q = [q0, q1, q2, q3])
// -----------------------------------------------------------------------------

/// Unit quaternion for attitude representation
/// Convention: q = q0 + q1*i + q2*j + q3*k where q0 is scalar part
/// Represents rotation from inertial to body frame: v_B = q * v_N * q^(-1)
struct Quaternion {
    double q0{1.0};     ///< Scalar part (cos(theta/2))
    double q1{0.0};     ///< Vector part x (e_x * sin(theta/2))
    double q2{0.0};     ///< Vector part y (e_y * sin(theta/2))
    double q3{0.0};     ///< Vector part z (e_z * sin(theta/2))

    Quaternion() = default;
    Quaternion(double w, double x, double y, double z) : q0(w), q1(x), q2(y), q3(z) {}

    /// Construct from axis-angle representation
    /// @param axis Unit rotation axis
    /// @param angle Rotation angle (radians)
    static Quaternion fromAxisAngle(const Vec3& axis, double angle) {
        double halfAngle = angle * 0.5;
        double s = std::sin(halfAngle);
        return Quaternion(std::cos(halfAngle), axis.x * s, axis.y * s, axis.z * s);
    }

    /// Construct from Euler angles (3-2-1 / ZYX sequence: yaw-pitch-roll)
    /// @param yaw Rotation about Z axis (radians)
    /// @param pitch Rotation about Y axis (radians)
    /// @param roll Rotation about X axis (radians)
    static Quaternion fromEuler321(double yaw, double pitch, double roll) {
        double cy = std::cos(yaw * 0.5);
        double sy = std::sin(yaw * 0.5);
        double cp = std::cos(pitch * 0.5);
        double sp = std::sin(pitch * 0.5);
        double cr = std::cos(roll * 0.5);
        double sr = std::sin(roll * 0.5);

        return Quaternion(
            cy * cp * cr + sy * sp * sr,
            cy * cp * sr - sy * sp * cr,
            cy * sp * cr + sy * cp * sr,
            sy * cp * cr - cy * sp * sr
        );
    }

    /// Magnitude (should be 1 for unit quaternion)
    double magnitude() const {
        return std::sqrt(q0*q0 + q1*q1 + q2*q2 + q3*q3);
    }

    /// Normalize to unit quaternion
    Quaternion& normalize() {
        double mag = magnitude();
        if (mag > 1e-15) {
            q0 /= mag;
            q1 /= mag;
            q2 /= mag;
            q3 /= mag;
        }
        return *this;
    }

    /// Return normalized copy
    Quaternion normalized() const {
        Quaternion result = *this;
        return result.normalize();
    }

    /// Conjugate (inverse for unit quaternion)
    Quaternion conjugate() const {
        return Quaternion(q0, -q1, -q2, -q3);
    }

    /// Inverse (same as conjugate for unit quaternion)
    Quaternion inverse() const {
        double magSq = q0*q0 + q1*q1 + q2*q2 + q3*q3;
        if (magSq > 1e-15) {
            return Quaternion(q0/magSq, -q1/magSq, -q2/magSq, -q3/magSq);
        }
        return Quaternion();
    }

    /// Quaternion multiplication (Hamilton product)
    Quaternion operator*(const Quaternion& r) const {
        return Quaternion(
            q0*r.q0 - q1*r.q1 - q2*r.q2 - q3*r.q3,
            q0*r.q1 + q1*r.q0 + q2*r.q3 - q3*r.q2,
            q0*r.q2 - q1*r.q3 + q2*r.q0 + q3*r.q1,
            q0*r.q3 + q1*r.q2 - q2*r.q1 + q3*r.q0
        );
    }

    /// Scalar multiplication
    Quaternion operator*(double s) const {
        return Quaternion(q0*s, q1*s, q2*s, q3*s);
    }

    /// Addition
    Quaternion operator+(const Quaternion& r) const {
        return Quaternion(q0+r.q0, q1+r.q1, q2+r.q2, q3+r.q3);
    }

    /// Subtraction
    Quaternion operator-(const Quaternion& r) const {
        return Quaternion(q0-r.q0, q1-r.q1, q2-r.q2, q3-r.q3);
    }

    /// Rotate a vector by this quaternion: v' = q * v * q^(-1)
    Vec3 rotate(const Vec3& v) const {
        // Optimized rotation using Rodrigues' formula
        Vec3 qv(q1, q2, q3);
        Vec3 t = 2.0 * qv.cross(v);
        return v + q0 * t + qv.cross(t);
    }

    /// Get vector part
    Vec3 vectorPart() const {
        return Vec3(q1, q2, q3);
    }

    /// Get rotation angle (radians)
    double angle() const {
        double sinHalfAngle = std::sqrt(q1*q1 + q2*q2 + q3*q3);
        return 2.0 * std::atan2(sinHalfAngle, std::abs(q0));
    }

    /// Get rotation axis (unit vector)
    Vec3 axis() const {
        double sinHalfAngle = std::sqrt(q1*q1 + q2*q2 + q3*q3);
        if (sinHalfAngle < 1e-15) {
            return Vec3(0, 0, 1);  // Arbitrary axis for zero rotation
        }
        return Vec3(q1/sinHalfAngle, q2/sinHalfAngle, q3/sinHalfAngle);
    }

    /// Ensure positive scalar part (short rotation path)
    Quaternion& ensurePositiveScalar() {
        if (q0 < 0) {
            q0 = -q0;
            q1 = -q1;
            q2 = -q2;
            q3 = -q3;
        }
        return *this;
    }

    /// Identity quaternion
    static Quaternion identity() {
        return Quaternion(1.0, 0.0, 0.0, 0.0);
    }
};

inline Quaternion operator*(double s, const Quaternion& q) {
    return q * s;
}

// -----------------------------------------------------------------------------
// Modified Rodrigues Parameters (MRP)
// -----------------------------------------------------------------------------

/// Modified Rodrigues Parameters (Basilisk default attitude representation)
/// sigma = e * tan(theta/4), where e is rotation axis and theta is angle
/// Singularity at theta = +/- 360 degrees, handled via shadow set switching
struct MRP {
    double s1{0.0};     ///< MRP component 1
    double s2{0.0};     ///< MRP component 2
    double s3{0.0};     ///< MRP component 3

    MRP() = default;
    MRP(double x, double y, double z) : s1(x), s2(y), s3(z) {}
    MRP(const Vec3& v) : s1(v.x), s2(v.y), s3(v.z) {}

    /// Construct from axis-angle
    static MRP fromAxisAngle(const Vec3& axis, double angle) {
        double tanQuarterAngle = std::tan(angle * 0.25);
        return MRP(axis.x * tanQuarterAngle,
                   axis.y * tanQuarterAngle,
                   axis.z * tanQuarterAngle);
    }

    /// Get as Vec3
    Vec3 toVec3() const {
        return Vec3(s1, s2, s3);
    }

    /// Magnitude squared
    double magnitudeSq() const {
        return s1*s1 + s2*s2 + s3*s3;
    }

    /// Magnitude
    double magnitude() const {
        return std::sqrt(magnitudeSq());
    }

    /// Check if near singularity (|sigma|^2 > 1 recommended for switching)
    bool nearSingularity(double threshold = 1.0) const {
        return magnitudeSq() > threshold;
    }

    /// Switch to shadow set: sigma_s = -sigma / |sigma|^2
    /// Use when approaching singularity at 360 degrees
    MRP shadowSet() const {
        double sigSq = magnitudeSq();
        if (sigSq < 1e-15) {
            return MRP();  // Near identity, return zero
        }
        return MRP(-s1/sigSq, -s2/sigSq, -s3/sigSq);
    }

    /// Ensure MRP is in inner set (|sigma|^2 <= 1)
    MRP& ensureInnerSet() {
        if (magnitudeSq() > 1.0) {
            *this = shadowSet();
        }
        return *this;
    }

    /// Get rotation angle (radians)
    double angle() const {
        return 4.0 * std::atan(magnitude());
    }

    /// Get rotation axis (unit vector)
    Vec3 axis() const {
        double mag = magnitude();
        if (mag < 1e-15) {
            return Vec3(0, 0, 1);  // Arbitrary
        }
        return Vec3(s1/mag, s2/mag, s3/mag);
    }

    /// MRP addition (composition): sigma12 = sigma1 + sigma2 (Basilisk convention)
    /// Represents successive rotations: first sigma1, then sigma2
    MRP operator+(const MRP& sigma2) const {
        double s1Sq = this->magnitudeSq();
        double s2Sq = sigma2.magnitudeSq();
        Vec3 v1 = this->toVec3();
        Vec3 v2 = sigma2.toVec3();

        double denom = 1.0 + s1Sq * s2Sq - 2.0 * v1.dot(v2);
        if (std::abs(denom) < 1e-15) {
            // Singularity case
            return MRP();
        }

        Vec3 result = ((1.0 - s2Sq) * v1 + (1.0 - s1Sq) * v2 - 2.0 * v2.cross(v1)) / denom;
        return MRP(result);
    }

    /// MRP subtraction (relative attitude): delta_sigma = sigma2 - sigma1
    /// Gives attitude error from sigma1 to sigma2
    MRP operator-(const MRP& sigma1) const {
        return sigma1.inverse() + (*this);
    }

    /// MRP inverse: -sigma represents inverse rotation
    MRP inverse() const {
        return MRP(-s1, -s2, -s3);
    }

    /// Scalar multiplication
    MRP operator*(double s) const {
        return MRP(s1*s, s2*s, s3*s);
    }

    /// Identity MRP (zero rotation)
    static MRP identity() {
        return MRP(0.0, 0.0, 0.0);
    }
};

inline MRP operator*(double s, const MRP& mrp) {
    return mrp * s;
}

// -----------------------------------------------------------------------------
// Euler Angles
// -----------------------------------------------------------------------------

/// Euler angle sequence type
enum class EulerSequence {
    ZYX_321,    ///< Aerospace standard (yaw-pitch-roll)
    ZXZ_313,    ///< Classical mechanics
    XYZ_123,    ///< Roll-pitch-yaw
    ZYZ_323,    ///< Symmetric
    XZX_131,    ///< Symmetric
    YXY_121     ///< Symmetric
};

/// Euler angles container
struct EulerAngles {
    double angle1{0};   ///< First rotation angle (radians)
    double angle2{0};   ///< Second rotation angle (radians)
    double angle3{0};   ///< Third rotation angle (radians)
    EulerSequence sequence{EulerSequence::ZYX_321};

    EulerAngles() = default;
    EulerAngles(double a1, double a2, double a3, EulerSequence seq = EulerSequence::ZYX_321)
        : angle1(a1), angle2(a2), angle3(a3), sequence(seq) {}

    /// Get yaw for ZYX sequence
    double yaw() const { return angle1; }
    /// Get pitch for ZYX sequence
    double pitch() const { return angle2; }
    /// Get roll for ZYX sequence
    double roll() const { return angle3; }
};

// -----------------------------------------------------------------------------
// Direction Cosine Matrix (DCM)
// -----------------------------------------------------------------------------

/// Direction Cosine Matrix for attitude representation
/// Transforms vectors from inertial (N) to body (B) frame: v_B = [BN] * v_N
struct DCM {
    Mat3 R;     ///< 3x3 rotation matrix

    DCM() : R(Mat3::identity()) {}
    DCM(const Mat3& m) : R(m) {}

    /// Transpose (inverse for orthogonal matrix)
    DCM transpose() const {
        return DCM(R.transpose());
    }

    /// Transform vector from N to B frame
    Vec3 transformToBody(const Vec3& v_N) const {
        return R * v_N;
    }

    /// Transform vector from B to N frame
    Vec3 transformToInertial(const Vec3& v_B) const {
        return R.transpose() * v_B;
    }

    /// Matrix multiplication
    DCM operator*(const DCM& other) const {
        return DCM(R * other.R);
    }

    /// Construct from axis and angle
    static DCM fromAxisAngle(const Vec3& axis, double angle) {
        double c = std::cos(angle);
        double s = std::sin(angle);
        double omc = 1.0 - c;
        Vec3 a = axis.normalized();

        Mat3 m;
        m.m[0][0] = c + a.x*a.x*omc;
        m.m[0][1] = a.x*a.y*omc - a.z*s;
        m.m[0][2] = a.x*a.z*omc + a.y*s;
        m.m[1][0] = a.y*a.x*omc + a.z*s;
        m.m[1][1] = c + a.y*a.y*omc;
        m.m[1][2] = a.y*a.z*omc - a.x*s;
        m.m[2][0] = a.z*a.x*omc - a.y*s;
        m.m[2][1] = a.z*a.y*omc + a.x*s;
        m.m[2][2] = c + a.z*a.z*omc;

        return DCM(m);
    }

    /// Identity DCM
    static DCM identity() {
        return DCM();
    }
};

// =============================================================================
// Attitude State & Command Types
// =============================================================================

/// Complete attitude state (attitude + angular velocity)
struct AttitudeState {
    Quaternion quaternion;      ///< Attitude quaternion (N to B)
    Vec3 omega;                 ///< Angular velocity in body frame (rad/s)
    double epoch{0};            ///< Time (Julian date or seconds from epoch)

    AttitudeState() = default;
    AttitudeState(const Quaternion& q, const Vec3& w, double t = 0)
        : quaternion(q), omega(w), epoch(t) {}

    /// Get attitude as MRP
    MRP toMRP() const;  // Forward declaration, implemented in attitude.cpp

    /// Get attitude as Euler angles (ZYX)
    EulerAngles toEuler() const;

    /// Get attitude as DCM
    DCM toDCM() const;
};

/// Attitude reference command (guidance output)
struct AttitudeCommand {
    Quaternion quaternion_R;    ///< Reference attitude quaternion
    Vec3 omega_R;               ///< Reference angular velocity (rad/s, body frame)
    Vec3 omegaDot_R;            ///< Reference angular acceleration (rad/s^2)
    double epoch{0};            ///< Command time

    AttitudeCommand() = default;
    AttitudeCommand(const Quaternion& q, const Vec3& w = Vec3(),
                    const Vec3& wDot = Vec3(), double t = 0)
        : quaternion_R(q), omega_R(w), omegaDot_R(wDot), epoch(t) {}

    /// Get reference as MRP
    MRP toMRP() const;
};

/// Attitude tracking error (for control law input)
struct AttitudeTrackingError {
    MRP sigma_BR;       ///< MRP error from reference (R) to body (B)
    Vec3 omega_BR_B;    ///< Angular velocity error in body frame (rad/s)
    bool valid{false};

    /// Get error magnitude in radians
    double angleMagnitude() const {
        return sigma_BR.angle();
    }

    /// Get angular rate error magnitude
    double rateError() const {
        return omega_BR_B.magnitude();
    }
};

/// Control torque output from attitude control law
struct ControlTorque {
    double Tx{0};       ///< Torque about body X axis (Nm)
    double Ty{0};       ///< Torque about body Y axis (Nm)
    double Tz{0};       ///< Torque about body Z axis (Nm)

    ControlTorque() = default;
    ControlTorque(double x, double y, double z) : Tx(x), Ty(y), Tz(z) {}
    ControlTorque(const Vec3& torque) : Tx(torque.x), Ty(torque.y), Tz(torque.z) {}

    /// Get as Vec3
    Vec3 toVec3() const {
        return Vec3(Tx, Ty, Tz);
    }

    /// Magnitude
    double magnitude() const {
        return std::sqrt(Tx*Tx + Ty*Ty + Tz*Tz);
    }

    /// Add torques
    ControlTorque operator+(const ControlTorque& other) const {
        return ControlTorque(Tx + other.Tx, Ty + other.Ty, Tz + other.Tz);
    }

    /// Scale torque
    ControlTorque operator*(double s) const {
        return ControlTorque(Tx * s, Ty * s, Tz * s);
    }

    /// Saturate torque to maximum
    ControlTorque saturate(double maxTorque) const {
        double mag = magnitude();
        if (mag > maxTorque && mag > 1e-10) {
            double scale = maxTorque / mag;
            return ControlTorque(Tx * scale, Ty * scale, Tz * scale);
        }
        return *this;
    }
};

// =============================================================================
// Attitude Guidance Mode Types
// =============================================================================

/// Guidance mode enumeration
enum class AttitudeGuidanceMode {
    Inertial3D,             ///< Fixed inertial pointing
    HillPoint,              ///< LVLH nadir pointing (Hill frame)
    CelestialTwoBody,       ///< Sun or other body pointing
    VelocityPoint,          ///< Velocity vector alignment
    AttTrackingError,       ///< Direct reference tracking
    SunSafePoint,           ///< Safe mode sun pointing
    LocationPointing,       ///< Ground target tracking
    RasterScan,             ///< Raster scan pattern
    Custom                  ///< User-defined guidance
};

/// Inertial pointing guidance configuration
struct InertialPointingConfig {
    Quaternion reference;       ///< Fixed inertial reference attitude
    bool useBodyAxis{true};     ///< Use body axis constraint
    Vec3 bodyAxis{0, 0, 1};     ///< Body axis to constrain (default: Z/boresight)
    Vec3 inertialVector{0, 0, 1}; ///< Inertial direction to point at
};

/// Nadir (Hill) pointing configuration
struct HillPointConfig {
    Vec3 primaryAxis{0, 0, -1};     ///< Body axis pointing at nadir (default: -Z)
    Vec3 secondaryAxis{1, 0, 0};    ///< Body axis aligned with velocity
    bool levelFlight{true};         ///< Keep secondary axis in orbit plane
    double yawOffset{0};            ///< Yaw offset from velocity (rad)
};

/// Sun pointing configuration
struct SunPointConfig {
    Vec3 solarPanelNormal{0, 0, 1}; ///< Body-frame solar panel normal
    Vec3 constraintAxis{1, 0, 0};   ///< Body axis with rotation freedom
    bool safeMode{false};           ///< If true, use sun-safe constraint logic
    double minSunAngle{0.1};        ///< Minimum sun angle for safe mode (rad)
};

/// Velocity pointing configuration
struct VelocityPointConfig {
    Vec3 bodyAxis{1, 0, 0};         ///< Body axis to align with velocity
    Vec3 constraintAxis{0, 0, 1};   ///< Secondary constraint axis
    bool prograde{true};            ///< True = prograde, false = retrograde
};

/// Ground target pointing configuration
struct TargetPointConfig {
    Vec3 targetLLA;                 ///< Target lat/lon/alt (rad, rad, km)
    Vec3 bodyBoresight{0, 0, 1};    ///< Body frame boresight axis
    Vec3 constraintAxis{0, 1, 0};   ///< Body axis for roll constraint
    bool earthFixed{true};          ///< True if target is Earth-fixed
};

// =============================================================================
// Attitude Control Law Configuration Types
// =============================================================================

/// Control law type enumeration
enum class AttitudeControlLaw {
    MrpFeedback,            ///< MRP-based nonlinear feedback (Basilisk default)
    MrpPD,                  ///< MRP proportional-derivative
    MrpSteering,            ///< MRP steering law with rate constraint
    MrpNonlinear,           ///< Full nonlinear MRP control
    RateServo,              ///< Rate-based servo control
    PRVSteering,            ///< Principal rotation vector steering
    None                    ///< No control (open loop)
};

/// MRP Feedback controller gains (Basilisk-style)
struct MrpFeedbackGains {
    double K{0.1};          ///< Proportional gain (1/s^2) - attitude error
    double P{1.0};          ///< Derivative gain matrix scale (Nm*s/rad)
    double Ki{0.0};         ///< Integral gain (optional, 1/s^3)
    Vec3 Kdiag{1, 1, 1};    ///< Diagonal gain scaling (for asymmetric inertia)
    bool useIntegrator{false}; ///< Enable integral action
    double integratorLimit{0.1}; ///< Anti-windup limit on integrated error

    /// Default gains for quick stabilization
    static MrpFeedbackGains defaultGains() {
        return MrpFeedbackGains{0.1, 1.0, 0.0, Vec3(1,1,1), false, 0.1};
    }

    /// Aggressive gains for fast response
    static MrpFeedbackGains aggressiveGains() {
        return MrpFeedbackGains{0.5, 2.0, 0.01, Vec3(1,1,1), true, 0.05};
    }
};

/// MRP PD controller gains
struct MrpPDGains {
    Vec3 Kp{0.1, 0.1, 0.1};     ///< Proportional gains per axis (Nm/rad)
    Vec3 Kd{1.0, 1.0, 1.0};     ///< Derivative gains per axis (Nm*s/rad)
    double sigma_max{1.0};       ///< MRP saturation limit for shadow set

    static MrpPDGains defaultGains() {
        return MrpPDGains{{0.1, 0.1, 0.1}, {1.0, 1.0, 1.0}, 1.0};
    }
};

/// MRP Steering law configuration (rate-limited slew)
struct MrpSteeringConfig {
    double omega_max{0.1};      ///< Maximum angular rate (rad/s)
    double omega_dot_max{0.01}; ///< Maximum angular acceleration (rad/s^2)
    double K1{0.1};             ///< Steering gain 1
    double K3{1.0};             ///< Steering gain 3
    bool useOmegaLimit{true};   ///< Enforce rate limit
    bool useAccelLimit{true};   ///< Enforce acceleration limit

    static MrpSteeringConfig defaultConfig() {
        return MrpSteeringConfig{0.1, 0.01, 0.1, 1.0, true, true};
    }
};

/// Spacecraft inertia properties for control
struct SpacecraftInertia {
    double Ixx{100.0};      ///< Moment of inertia about X (kg*m^2)
    double Iyy{100.0};      ///< Moment of inertia about Y (kg*m^2)
    double Izz{100.0};      ///< Moment of inertia about Z (kg*m^2)
    double Ixy{0.0};        ///< Product of inertia XY (kg*m^2)
    double Ixz{0.0};        ///< Product of inertia XZ (kg*m^2)
    double Iyz{0.0};        ///< Product of inertia YZ (kg*m^2)

    SpacecraftInertia() = default;
    SpacecraftInertia(double ixx, double iyy, double izz)
        : Ixx(ixx), Iyy(iyy), Izz(izz), Ixy(0), Ixz(0), Iyz(0) {}

    /// Get inertia tensor as 3x3 matrix
    Mat3 toMatrix() const {
        Mat3 I;
        I.m[0][0] = Ixx; I.m[0][1] = Ixy; I.m[0][2] = Ixz;
        I.m[1][0] = Ixy; I.m[1][1] = Iyy; I.m[1][2] = Iyz;
        I.m[2][0] = Ixz; I.m[2][1] = Iyz; I.m[2][2] = Izz;
        return I;
    }

    /// Get diagonal inertia vector
    Vec3 diagonal() const {
        return Vec3(Ixx, Iyy, Izz);
    }

    /// Multiply inertia by angular velocity (I * omega)
    Vec3 operator*(const Vec3& omega) const {
        return Vec3(
            Ixx * omega.x + Ixy * omega.y + Ixz * omega.z,
            Ixy * omega.x + Iyy * omega.y + Iyz * omega.z,
            Ixz * omega.x + Iyz * omega.y + Izz * omega.z
        );
    }

    /// Default inertia (100 kg*m^2 diagonal)
    static SpacecraftInertia defaultInertia() {
        return SpacecraftInertia(100.0, 100.0, 100.0);
    }

    /// CubeSat 3U inertia
    static SpacecraftInertia cubesat3U() {
        return SpacecraftInertia(0.035, 0.035, 0.007);
    }

    /// Small satellite (100 kg class)
    static SpacecraftInertia smallSat100kg() {
        return SpacecraftInertia(50.0, 50.0, 30.0);
    }
};

// =============================================================================
// Attitude Effector Types
// =============================================================================

/// Reaction wheel state
struct ReactionWheelState {
    double Omega{0};            ///< Wheel speed (rad/s)
    double Omega_max{6000 * TWO_PI / 60}; ///< Max wheel speed (rad/s, default 6000 RPM)
    double h{0};                ///< Angular momentum (Nms)
    double h_max{1.0};          ///< Max angular momentum (Nms)
    double torque{0};           ///< Current commanded torque (Nm)
    double torque_max{0.1};     ///< Max torque (Nm)
    Vec3 spinAxis{0, 0, 1};     ///< Spin axis in body frame
    double Js{0.01};            ///< Wheel spin inertia (kg*m^2)

    /// Check if wheel is saturated
    bool isSaturated(double threshold = 0.9) const {
        return std::abs(h) > threshold * h_max;
    }

    /// Get saturation fraction
    double saturationFraction() const {
        return std::abs(h) / h_max;
    }
};

/// Reaction wheel array configuration
struct ReactionWheelArray {
    std::array<ReactionWheelState, 4> wheels;   ///< Up to 4 wheels
    int numWheels{3};                           ///< Active wheel count
    Mat3 wheelMatrix;                           ///< Torque distribution matrix

    /// Standard 3-axis configuration
    static ReactionWheelArray threeAxis() {
        ReactionWheelArray rwa;
        rwa.numWheels = 3;
        rwa.wheels[0].spinAxis = Vec3(1, 0, 0);
        rwa.wheels[1].spinAxis = Vec3(0, 1, 0);
        rwa.wheels[2].spinAxis = Vec3(0, 0, 1);
        return rwa;
    }

    /// Pyramid (4-wheel redundant) configuration
    static ReactionWheelArray pyramid() {
        ReactionWheelArray rwa;
        rwa.numWheels = 4;
        double s = std::sqrt(3.0) / 3.0;
        rwa.wheels[0].spinAxis = Vec3( s,  s, s);
        rwa.wheels[1].spinAxis = Vec3(-s,  s, s);
        rwa.wheels[2].spinAxis = Vec3(-s, -s, s);
        rwa.wheels[3].spinAxis = Vec3( s, -s, s);
        return rwa;
    }
};

/// Thruster configuration for attitude control
struct AttitudeThrusterConfig {
    Vec3 position;              ///< Thruster position in body frame (m)
    Vec3 direction;             ///< Thrust direction (body frame, unit vector)
    double thrust_max{1.0};     ///< Maximum thrust (N)
    double thrust_min{0.0};     ///< Minimum thrust (N, for throttleable)
    double minOnTime{0.01};     ///< Minimum on-time (s)
    double Isp{220.0};          ///< Specific impulse (s)
    bool onOff{true};           ///< True = on/off, false = throttleable

    /// Get torque arm for this thruster
    Vec3 torqueArm() const {
        return position.cross(direction);
    }
};

/// Magnetic torque bar state
struct MagneticTorquerState {
    Vec3 dipole;                ///< Current magnetic dipole moment (A*m^2)
    Vec3 dipole_max{1, 1, 1};   ///< Maximum dipole per axis (A*m^2)
    Vec3 magneticField;         ///< Local magnetic field (T, body frame)

    /// Calculate torque from current dipole and field
    Vec3 torque() const {
        return dipole.cross(magneticField);
    }
};

// =============================================================================
// Attitude Sensor Types
// =============================================================================

/// Star tracker measurement
struct StarTrackerMeasurement {
    Quaternion attitude;        ///< Measured attitude quaternion
    double epoch{0};            ///< Measurement time
    double accuracy{1e-4};      ///< 1-sigma accuracy (rad)
    bool valid{false};          ///< Measurement validity
    bool sunBlinded{false};     ///< True if blinded by sun
    int numStars{0};            ///< Number of stars tracked
};

/// Gyroscope measurement
struct GyroMeasurement {
    Vec3 omega;                 ///< Measured angular velocity (rad/s)
    Vec3 bias;                  ///< Current bias estimate (rad/s)
    double epoch{0};
    double arw{1e-5};           ///< Angle random walk (rad/sqrt(s))
    double rrw{1e-7};           ///< Rate random walk (rad/s/sqrt(s))
    bool valid{false};
};

/// Coarse sun sensor measurement
struct CoarseSunSensorMeasurement {
    Vec3 sunDirection;          ///< Sun direction in body frame (unit vector)
    double intensity{1.0};      ///< Measured intensity (0-1)
    double epoch{0};
    double accuracy{0.05};      ///< 1-sigma accuracy (rad)
    bool valid{false};
    bool inEclipse{false};
};

// =============================================================================
// Attitude Dynamics State
// =============================================================================

/// Complete attitude dynamics state for simulation
struct AttitudeDynamicsState {
    // Attitude state
    Quaternion quaternion;      ///< Attitude (N to B)
    Vec3 omega;                 ///< Angular velocity (rad/s, body frame)

    // Momentum state
    Vec3 angularMomentum;       ///< Total angular momentum (Nms, body frame)

    // Wheel states
    ReactionWheelArray wheels;

    // External torques
    Vec3 externalTorque;        ///< Sum of external torques (Nm)
    Vec3 gravityGradientTorque; ///< Gravity gradient torque (Nm)
    Vec3 aeroTorque;            ///< Aerodynamic torque (Nm)
    Vec3 srpTorque;             ///< Solar radiation pressure torque (Nm)
    Vec3 magneticTorque;        ///< Magnetic torque (Nm)

    // Control state
    ControlTorque commandedTorque;
    AttitudeCommand reference;
    AttitudeTrackingError trackingError;

    // Time
    double epoch{0};
    double dt{0.1};             ///< Time step (s)

    /// Get total system angular momentum (body + wheels)
    Vec3 totalMomentum(const SpacecraftInertia& I) const {
        Vec3 h_body = I * omega;
        Vec3 h_wheels;
        for (int i = 0; i < wheels.numWheels; i++) {
            h_wheels += wheels.wheels[i].spinAxis * wheels.wheels[i].h;
        }
        return h_body + h_wheels;
    }
};

// =============================================================================
// Additional Attitude Guidance Configuration Types
// =============================================================================

/// Celestial two-body pointing configuration
struct CelestialTwoBodyConfig {
    Vec3 bodyAxisPrimary{0, 0, 1};      ///< Body axis to point at celestial body
    Vec3 bodyAxisSecondary{1, 0, 0};    ///< Secondary body axis constraint
    Vec3 celestialBodyDir;               ///< Direction to celestial body (inertial, unit)
    Vec3 secondaryDir{0, 0, 1};          ///< Secondary direction for constraint
    bool trackSun{true};                 ///< True = track sun, false = custom body
};

/// Euler rotation guidance configuration
struct EulerRotationConfig {
    EulerSequence sequence{EulerSequence::ZYX_321};
    Vec3 eulerAngles;                    ///< Target Euler angles (rad)
    Vec3 eulerRates;                     ///< Euler angle rates (rad/s)
    bool timeVarying{false};             ///< If true, rates define continuous rotation
};

/// Optical navigation pointing configuration
struct OpNavPointConfig {
    Vec3 bodyBoresight{0, 0, 1};        ///< Camera boresight axis
    Vec3 targetBodyDir;                  ///< Direction to target body (inertial)
    Vec3 constraintAxis{0, 1, 0};       ///< Roll constraint axis
    double fieldOfView{0.1};            ///< Camera FOV (rad)
};

/// Raster scan configuration
struct RasterScanConfig {
    Vec3 centerDirection;               ///< Scan center direction (inertial)
    double scanWidth{0.1};              ///< Cross-track scan width (rad)
    double scanHeight{0.1};             ///< Along-track scan height (rad)
    double scanRate{0.01};              ///< Scan angular rate (rad/s)
    int numRows{5};                     ///< Number of scan rows
    double rowSpacing{0.02};            ///< Row spacing (rad)
    Vec3 bodyBoresight{0, 0, 1};        ///< Body scan axis
};

/// One-axis solar array tracking configuration
struct OneAxisSolarArrayConfig {
    Vec3 arrayAxis{0, 1, 0};            ///< Array rotation axis (body frame)
    Vec3 arrayNormal{0, 0, 1};          ///< Panel normal at zero angle (body frame)
    Vec3 sunDirection;                   ///< Sun direction (inertial)
    double maxRate{0.05};               ///< Maximum drive rate (rad/s)
};

/// Constrained attitude pointing configuration
struct ConstrainedPointConfig {
    Vec3 primaryAxis{0, 0, 1};          ///< Primary pointing axis (body frame)
    Vec3 primaryTarget;                  ///< Primary pointing target (inertial)
    Vec3 keepOutAxis;                    ///< Axis to keep out of cone
    Vec3 keepOutTarget;                  ///< Keep-out zone center (e.g., sun)
    double keepOutAngle{0.5};           ///< Keep-out half-cone angle (rad)
    double keepInAngle{0};              ///< Keep-in half-cone angle (rad, 0=disabled)
    bool constraintActive{true};
};

/// Small body waypoint guidance configuration
struct SmallBodyWaypointConfig {
    Vec3 waypointPosition;              ///< Waypoint in body-fixed frame (km)
    Vec3 approachDirection;             ///< Approach direction (body-fixed, unit)
    double standoffDistance{1.0};        ///< Standoff distance (km)
    Vec3 bodyBoresight{0, 0, 1};        ///< Instrument boresight axis
    double maxApproachRate{0.001};       ///< Max approach velocity (km/s)
};

/// Rendezvous guidance configuration
struct RendezvousGuidanceConfig {
    Vec3 targetPosition;                 ///< Target position (LVLH, km)
    Vec3 targetVelocity;                 ///< Target velocity (LVLH, km/s)
    double approachConeAngle{0.175};    ///< Approach corridor half-angle (rad)
    bool vBarApproach{true};             ///< V-bar (true) vs R-bar (false)
    Vec3 bodyBoresight{0, 0, 1};        ///< Docking port axis
    double keepOutRadius{0.05};          ///< Keep-out sphere radius (km)
};

/// Attitude maneuver configuration (slew planning)
struct AttManeuverConfig {
    Quaternion startAttitude;            ///< Start attitude
    Quaternion endAttitude;              ///< End attitude
    double slewDuration{60.0};           ///< Desired slew duration (s)
    double maxRate{0.1};                 ///< Maximum angular rate (rad/s)
    double maxAccel{0.01};              ///< Maximum angular acceleration (rad/s^2)
    bool eigenAxisSlew{true};           ///< Use eigenaxis rotation (shortest path)
};

/// Attitude reference correction configuration
struct AttRefCorrectionConfig {
    MRP correctionMRP;                   ///< Correction in MRP
    Vec3 correctionRate;                 ///< Rate correction (rad/s)
    bool additive{true};                 ///< True = add, false = replace
    double fadeTime{10.0};               ///< Fade-in time for correction (s)
};

/// Prescribed rotation configuration
struct PrescribedRotConfig {
    Vec3 rotationAxis{0, 0, 1};         ///< Rotation axis (body frame)
    double rotRate{0.01};               ///< Rotation rate (rad/s)
    double rotAccel{0.001};             ///< Rotation acceleration (rad/s^2)
    double startAngle{0};               ///< Starting angle (rad)
    double endAngle{6.283185307};       ///< Ending angle (rad, default = 2pi)
    bool continuous{true};               ///< True = continuous rotation
};

// =============================================================================
// Additional Attitude Control Configuration Types
// =============================================================================

/// PRV Steering configuration
struct PRVSteeringConfig {
    double omega_max{0.1};              ///< Maximum angular rate (rad/s)
    double K1{0.1};                      ///< Steering gain
    double K3{1.0};                      ///< Rate tracking gain
    bool useRateLimit{true};
};

/// Momentum dumping (wheel desaturation) configuration
struct MomentumDumpingConfig {
    double desatGain{0.01};             ///< Desaturation gain
    double momentumThreshold{0.8};      ///< Wheel saturation threshold (fraction)
    bool useMagneticTorquers{true};     ///< Use mag torquers or thrusters
    Vec3 magneticField;                  ///< Current magnetic field (T, body)
    double maxDipole{1.0};              ///< Max magnetic dipole (A*m^2)
};

/// Three-axis control configuration
struct ThreeAxisControlConfig {
    Vec3 Kp{0.1, 0.1, 0.1};            ///< Proportional gains per axis
    Vec3 Ki{0.001, 0.001, 0.001};       ///< Integral gains per axis
    Vec3 Kd{1.0, 1.0, 1.0};            ///< Derivative gains per axis
    Vec3 integralLimit{0.1, 0.1, 0.1};  ///< Anti-windup limits
    bool useWheels{true};               ///< Allocate to reaction wheels
};

/// Momentum bias stabilization configuration
struct MomentumBiasConfig {
    double biasH{5.0};                  ///< Bias momentum (Nms)
    Vec3 biasAxis{0, 1, 0};             ///< Bias momentum axis (body)
    double rollGain{0.01};              ///< Roll control gain
    double yawGain{0.01};               ///< Yaw control gain
    double pitchGain{0.1};              ///< Pitch control gain
};

/// Dual-spin stabilization configuration
struct DualSpinConfig {
    double platformInertia{50.0};       ///< Platform moment of inertia (kg*m^2)
    double rotorInertia{10.0};          ///< Rotor moment of inertia (kg*m^2)
    double rotorRate{10.0};             ///< Rotor spin rate (rad/s)
    Vec3 spinAxis{0, 0, 1};            ///< Spin axis (body frame)
    double nutationDamperGain{0.1};     ///< Nutation damper gain
};

/// Solar pressure control configuration
struct SolarPressureControlConfig {
    double srpArea{10.0};               ///< SRP effective area (m^2)
    Vec3 srpNormal{0, 0, 1};            ///< SRP panel normal (body)
    double reflectivity{0.5};           ///< Surface reflectivity (0-1)
    double sunDistanceAU{1.0};          ///< Distance from sun (AU)
    double controlGain{0.001};          ///< Control gain for trim attitude
};

// =============================================================================
// Additional Effector Configuration Types
// =============================================================================

/// Reaction wheel jitter configuration
struct ReactionWheelJitterConfig {
    double staticImbalance{1e-6};       ///< Static imbalance (kg*m)
    double dynamicImbalance{1e-7};      ///< Dynamic imbalance (kg*m^2)
    double jitterBandwidth{100.0};      ///< Jitter bandwidth (Hz)
    int numHarmonics{4};
};

/// Variable-speed CMG (VSCMG) state
struct VSCMGState {
    double gimbalAngle{0};              ///< Gimbal angle (rad)
    double gimbalRate{0};               ///< Gimbal rate (rad/s)
    double wheelSpeed{6000 * TWO_PI / 60}; ///< Wheel speed (rad/s)
    Vec3 gimbalAxis{0, 1, 0};           ///< Gimbal axis (body frame)
    Vec3 spinAxis{0, 0, 1};             ///< Wheel spin axis at zero gimbal
    double Js{0.5};                      ///< Wheel spin inertia (kg*m^2)
    double Jt{0.01};                     ///< Gimbal transverse inertia (kg*m^2)
    double maxGimbalRate{1.0};           ///< Maximum gimbal rate (rad/s)
    double maxGimbalTorque{5.0};         ///< Maximum gimbal torque (Nm)
    double maxWheelTorque{0.5};          ///< Maximum wheel acceleration torque (Nm)
};

/// VSCMG array configuration
struct VSCMGArrayConfig {
    std::array<VSCMGState, 4> units;    ///< Up to 4 VSCMGs
    int numUnits{4};                     ///< Active unit count
};

/// Thruster dynamics configuration
struct ThrusterDynamicsConfig {
    double riseTime{0.02};              ///< Thrust rise time (s)
    double fallTime{0.01};              ///< Thrust fall time (s)
    double minImpulse{0.005};           ///< Minimum impulse bit (Ns)
    double steadyStateThrust{1.0};      ///< Steady-state thrust (N)
    double thrustNoise{0.01};           ///< Thrust noise fraction
    double Isp{220.0};                  ///< Specific impulse (s)
    bool isElectric{false};             ///< True for electric propulsion
};

/// Solar array drive assembly (SADA) configuration
struct SolarArrayDriveConfig {
    double driveRate{0.0175};           ///< Drive rate (rad/s, ~1 deg/s)
    double maxAngle{3.14159};           ///< Maximum drive angle (rad)
    double minAngle{-3.14159};          ///< Minimum drive angle (rad)
    double springConstant{0.1};         ///< Flexibility spring constant (Nm/rad)
    double damping{0.01};               ///< Flexibility damping (Nm*s/rad)
    double inertia{5.0};                ///< Array moment of inertia (kg*m^2)
    Vec3 hingeAxis{0, 1, 0};            ///< Hinge axis (body frame)
    double currentAngle{0};             ///< Current drive angle (rad)
};

/// Dual-hinged mechanism configuration
struct DualHingedConfig {
    Vec3 innerHingeAxis{1, 0, 0};       ///< Inner hinge axis (body frame)
    Vec3 outerHingeAxis{0, 1, 0};       ///< Outer hinge axis (body frame)
    double innerAngle{0};               ///< Inner hinge angle (rad)
    double outerAngle{0};               ///< Outer hinge angle (rad)
    double innerSpring{1.0};            ///< Inner hinge spring constant (Nm/rad)
    double outerSpring{1.0};            ///< Outer hinge spring constant (Nm/rad)
    double innerDamping{0.1};           ///< Inner hinge damping
    double outerDamping{0.1};           ///< Outer hinge damping
    double innerInertia{2.0};           ///< Inner body inertia (kg*m^2)
    double outerInertia{1.0};           ///< Outer body inertia (kg*m^2)
    double innerMaxAngle{1.57};         ///< Inner hinge max angle (rad)
    double outerMaxAngle{1.57};         ///< Outer hinge max angle (rad)
};

/// Attitude spinning body effector config (distinct from FlexDynamics SpinningBodyConfig)
struct AttSpinningBodyConfig {
    Vec3 spinAxis{0, 0, 1};             ///< Spin axis (body frame)
    double spinRate{0};                  ///< Current spin rate (rad/s)
    double spinInertia{1.0};            ///< Spin moment of inertia (kg*m^2)
    double transverseInertia{0.5};      ///< Transverse moment of inertia (kg*m^2)
    double maxSpinRate{100.0};           ///< Maximum spin rate (rad/s)
    double motorTorque{0.1};            ///< Motor torque (Nm)
    double friction{0.001};             ///< Bearing friction (Nm*s/rad)
};

}  // namespace astro
