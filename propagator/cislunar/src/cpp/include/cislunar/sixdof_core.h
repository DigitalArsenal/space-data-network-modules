#ifndef SIXDOF_CORE_H
#define SIXDOF_CORE_H

/**
 * 6DOF Rigid Body Dynamics Core
 * ==============================
 * Shared header for all SDN plugins requiring full attitude dynamics.
 *
 * State vector (13 elements):
 *   [0-2]  position      (x, y, z) in inertial frame [m]
 *   [3-5]  velocity      (vx, vy, vz) in inertial frame [m/s]
 *   [6-9]  quaternion    (w, x, y, z) body-to-inertial rotation
 *   [10-12] angular_vel  (p, q, r) in body frame [rad/s]
 *
 * Plus scalar mass (tracked separately for variable-mass systems).
 *
 * Conventions:
 *   - Quaternion: Hamilton convention, scalar-first [w, x, y, z]
 *   - Body frame: X-forward, Y-right, Z-down (aerospace standard)
 *   - Angular velocity: body-frame components (roll=p, pitch=q, yaw=r)
 *   - Inertia tensor: 3x3 symmetric, stored as 6 unique values
 *
 * Extracted and extended from starfield-sdn-plugin's quaternion math.
 * Each plugin copies this header into its own include tree (no cross-linking).
 *
 * C++17, no external dependencies.
 */

#include <array>
#include <cmath>
#include <cstring>

namespace sixdof {

// ============================================================================
// Types
// ============================================================================

using Vec3       = std::array<double, 3>;
using Quat       = std::array<double, 4>;  // [w, x, y, z]
using Mat3       = std::array<std::array<double, 3>, 3>;

/// Symmetric 3x3 inertia tensor — 6 unique values
/// [Ixx, Iyy, Izz, Ixy, Ixz, Iyz]
using InertiaTensor = std::array<double, 6>;

/// Full 6DOF state
struct State {
    Vec3   pos    = {0, 0, 0};        // inertial position [m]
    Vec3   vel    = {0, 0, 0};        // inertial velocity [m/s]
    Quat   quat   = {1, 0, 0, 0};    // body-to-inertial quaternion
    Vec3   omega  = {0, 0, 0};        // body angular velocity [rad/s]
    double mass   = 1.0;              // [kg]
};

/// Forces and torques acting on the body
struct ForcesTorques {
    Vec3 force_inertial = {0, 0, 0};  // total force in inertial frame [N]
    Vec3 force_body     = {0, 0, 0};  // total force in body frame [N]
    Vec3 torque_body    = {0, 0, 0};  // total torque in body frame [N·m]
    double mass_rate    = 0;           // dm/dt [kg/s] (negative for propellant burn)
};

/// 6DOF state derivative (for RK4 integration)
struct StateDeriv {
    Vec3   dpos   = {0, 0, 0};       // = vel
    Vec3   dvel   = {0, 0, 0};       // = force/mass
    Quat   dquat  = {0, 0, 0, 0};   // = 0.5 * q ⊗ ω
    Vec3   domega = {0, 0, 0};       // = I⁻¹(τ - ω × Iω)
    double dmass  = 0;               // = mass_rate
};

// ============================================================================
// Vec3 Operations
// ============================================================================

inline Vec3 v3add(const Vec3& a, const Vec3& b) {
    return {a[0]+b[0], a[1]+b[1], a[2]+b[2]};
}

inline Vec3 v3sub(const Vec3& a, const Vec3& b) {
    return {a[0]-b[0], a[1]-b[1], a[2]-b[2]};
}

inline Vec3 v3scale(const Vec3& v, double s) {
    return {v[0]*s, v[1]*s, v[2]*s};
}

inline double v3dot(const Vec3& a, const Vec3& b) {
    return a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
}

inline Vec3 v3cross(const Vec3& a, const Vec3& b) {
    return {
        a[1]*b[2] - a[2]*b[1],
        a[2]*b[0] - a[0]*b[2],
        a[0]*b[1] - a[1]*b[0]
    };
}

inline double v3norm(const Vec3& v) {
    return std::sqrt(v3dot(v, v));
}

inline double v3normSq(const Vec3& v) {
    return v3dot(v, v);
}

inline Vec3 v3normalized(const Vec3& v) {
    double n = v3norm(v);
    return (n > 1e-15) ? v3scale(v, 1.0/n) : Vec3{0,0,0};
}

inline Vec3 v3zero() { return {0, 0, 0}; }

// ============================================================================
// Quaternion Operations (Hamilton, scalar-first [w, x, y, z])
// ============================================================================

/// Identity quaternion (no rotation)
inline Quat qidentity() { return {1, 0, 0, 0}; }

/// Quaternion norm
inline double qnorm(const Quat& q) {
    return std::sqrt(q[0]*q[0] + q[1]*q[1] + q[2]*q[2] + q[3]*q[3]);
}

/// Normalize quaternion (enforce unit constraint)
inline Quat qnormalize(const Quat& q) {
    double n = qnorm(q);
    if (n < 1e-15) return qidentity();
    double inv = 1.0 / n;
    return {q[0]*inv, q[1]*inv, q[2]*inv, q[3]*inv};
}

/// Quaternion conjugate (= inverse for unit quaternions)
inline Quat qconj(const Quat& q) {
    return {q[0], -q[1], -q[2], -q[3]};
}

/// Quaternion multiply: r = a ⊗ b (Hamilton product)
inline Quat qmul(const Quat& a, const Quat& b) {
    return {
        a[0]*b[0] - a[1]*b[1] - a[2]*b[2] - a[3]*b[3],
        a[0]*b[1] + a[1]*b[0] + a[2]*b[3] - a[3]*b[2],
        a[0]*b[2] - a[1]*b[3] + a[2]*b[0] + a[3]*b[1],
        a[0]*b[3] + a[1]*b[2] - a[2]*b[1] + a[3]*b[0]
    };
}

/// Quaternion addition (for integration, NOT rotation composition)
inline Quat qadd(const Quat& a, const Quat& b) {
    return {a[0]+b[0], a[1]+b[1], a[2]+b[2], a[3]+b[3]};
}

/// Quaternion scalar multiply (for integration)
inline Quat qscale(const Quat& q, double s) {
    return {q[0]*s, q[1]*s, q[2]*s, q[3]*s};
}

/// Rotate vector by quaternion: v' = q ⊗ v ⊗ q*
inline Vec3 qrotate(const Quat& q, const Vec3& v) {
    // Optimized: avoids full quaternion multiply
    double qw = q[0], qx = q[1], qy = q[2], qz = q[3];
    double tx = 2.0 * (qy*v[2] - qz*v[1]);
    double ty = 2.0 * (qz*v[0] - qx*v[2]);
    double tz = 2.0 * (qx*v[1] - qy*v[0]);
    return {
        v[0] + qw*tx + (qy*tz - qz*ty),
        v[1] + qw*ty + (qz*tx - qx*tz),
        v[2] + qw*tz + (qx*ty - qy*tx)
    };
}

/// Rotate vector by quaternion inverse (body→inertial if q is body-to-inertial)
inline Vec3 qrotateInv(const Quat& q, const Vec3& v) {
    return qrotate(qconj(q), v);
}

/// Quaternion from axis-angle
inline Quat qfromAxisAngle(const Vec3& axis, double angle) {
    Vec3 n = v3normalized(axis);
    double ha = angle * 0.5;
    double s = std::sin(ha);
    return {std::cos(ha), n[0]*s, n[1]*s, n[2]*s};
}

/// Extract axis and angle from quaternion
inline void qtoAxisAngle(const Quat& q, Vec3& axis, double& angle) {
    Quat qn = qnormalize(q);
    angle = 2.0 * std::acos(std::min(1.0, std::abs(qn[0])));
    double s = std::sin(angle * 0.5);
    if (s > 1e-10) {
        double inv = 1.0 / s;
        axis = {qn[1]*inv, qn[2]*inv, qn[3]*inv};
    } else {
        axis = {1, 0, 0}; // arbitrary for zero rotation
        angle = 0;
    }
}

/// Quaternion from Euler angles (ZYX convention: yaw→pitch→roll)
inline Quat qfromEulerZYX(double roll, double pitch, double yaw) {
    double cr = std::cos(roll * 0.5),  sr = std::sin(roll * 0.5);
    double cp = std::cos(pitch * 0.5), sp = std::sin(pitch * 0.5);
    double cy = std::cos(yaw * 0.5),   sy = std::sin(yaw * 0.5);
    return {
        cr*cp*cy + sr*sp*sy,
        sr*cp*cy - cr*sp*sy,
        cr*sp*cy + sr*cp*sy,
        cr*cp*sy - sr*sp*cy
    };
}

/// Extract Euler angles (ZYX) from quaternion → [roll, pitch, yaw]
inline Vec3 qtoEulerZYX(const Quat& q) {
    double w = q[0], x = q[1], y = q[2], z = q[3];

    // Roll (x-axis rotation)
    double sinr = 2.0 * (w*x + y*z);
    double cosr = 1.0 - 2.0 * (x*x + y*y);
    double roll = std::atan2(sinr, cosr);

    // Pitch (y-axis rotation) — clamp for gimbal lock
    double sinp = 2.0 * (w*y - z*x);
    double pitch;
    if (std::abs(sinp) >= 1.0)
        pitch = std::copysign(M_PI / 2.0, sinp);
    else
        pitch = std::asin(sinp);

    // Yaw (z-axis rotation)
    double siny = 2.0 * (w*z + x*y);
    double cosy = 1.0 - 2.0 * (y*y + z*z);
    double yaw = std::atan2(siny, cosy);

    return {roll, pitch, yaw};
}

// ============================================================================
// Direction Cosine Matrix (DCM)
// ============================================================================

/// Quaternion to DCM (body-to-inertial)
inline Mat3 qtoDCM(const Quat& q) {
    double w = q[0], x = q[1], y = q[2], z = q[3];
    double xx = x*x, yy = y*y, zz = z*z;
    double xy = x*y, xz = x*z, yz = y*z;
    double wx = w*x, wy = w*y, wz = w*z;
    return {{
        {1-2*(yy+zz), 2*(xy-wz),   2*(xz+wy)},
        {2*(xy+wz),   1-2*(xx+zz), 2*(yz-wx)},
        {2*(xz-wy),   2*(yz+wx),   1-2*(xx+yy)}
    }};
}

/// DCM to quaternion (Shepperd's method — singularity-free)
inline Quat dcmToQuat(const Mat3& m) {
    double tr = m[0][0] + m[1][1] + m[2][2];
    Quat q;
    if (tr > 0) {
        double s = 0.5 / std::sqrt(tr + 1.0);
        q = {0.25/s, (m[2][1]-m[1][2])*s, (m[0][2]-m[2][0])*s, (m[1][0]-m[0][1])*s};
    } else if (m[0][0] > m[1][1] && m[0][0] > m[2][2]) {
        double s = 2.0 * std::sqrt(1.0 + m[0][0] - m[1][1] - m[2][2]);
        q = {(m[2][1]-m[1][2])/s, 0.25*s, (m[0][1]+m[1][0])/s, (m[0][2]+m[2][0])/s};
    } else if (m[1][1] > m[2][2]) {
        double s = 2.0 * std::sqrt(1.0 + m[1][1] - m[0][0] - m[2][2]);
        q = {(m[0][2]-m[2][0])/s, (m[0][1]+m[1][0])/s, 0.25*s, (m[1][2]+m[2][1])/s};
    } else {
        double s = 2.0 * std::sqrt(1.0 + m[2][2] - m[0][0] - m[1][1]);
        q = {(m[1][0]-m[0][1])/s, (m[0][2]+m[2][0])/s, (m[1][2]+m[2][1])/s, 0.25*s};
    }
    return qnormalize(q);
}

/// Matrix-vector multiply
inline Vec3 mat3vec(const Mat3& m, const Vec3& v) {
    return {
        m[0][0]*v[0] + m[0][1]*v[1] + m[0][2]*v[2],
        m[1][0]*v[0] + m[1][1]*v[1] + m[1][2]*v[2],
        m[2][0]*v[0] + m[2][1]*v[1] + m[2][2]*v[2]
    };
}

/// Matrix transpose
inline Mat3 mat3T(const Mat3& m) {
    return {{
        {m[0][0], m[1][0], m[2][0]},
        {m[0][1], m[1][1], m[2][1]},
        {m[0][2], m[1][2], m[2][2]}
    }};
}

// ============================================================================
// Inertia Tensor Operations
// ============================================================================

/// Expand symmetric 6-value inertia to full 3x3 matrix
/// Layout: [Ixx, Iyy, Izz, Ixy, Ixz, Iyz]
inline Mat3 inertiaToMat3(const InertiaTensor& I) {
    return {{
        { I[0], -I[3], -I[4]},
        {-I[3],  I[1], -I[5]},
        {-I[4], -I[5],  I[2]}
    }};
}

/// Create diagonal inertia tensor (principal axes aligned with body)
inline InertiaTensor inertiaDiag(double Ixx, double Iyy, double Izz) {
    return {Ixx, Iyy, Izz, 0, 0, 0};
}

/// Compute I·ω (inertia tensor times angular velocity)
inline Vec3 inertiaTimesOmega(const InertiaTensor& I, const Vec3& w) {
    // I = [[Ixx, -Ixy, -Ixz], [-Ixy, Iyy, -Iyz], [-Ixz, -Iyz, Izz]]
    return {
         I[0]*w[0] - I[3]*w[1] - I[4]*w[2],
        -I[3]*w[0] + I[1]*w[1] - I[5]*w[2],
        -I[4]*w[0] - I[5]*w[1] + I[2]*w[2]
    };
}

/// Solve I·α = τ for angular acceleration α = I⁻¹·τ
/// For diagonal inertia: trivial. For general: uses Cramer's rule.
inline Vec3 inertiaInvTimesVec(const InertiaTensor& I, const Vec3& tau) {
    // Check if nearly diagonal (common for missiles/spacecraft)
    bool diag = (std::abs(I[3]) < 1e-12 && std::abs(I[4]) < 1e-12 && std::abs(I[5]) < 1e-12);
    if (diag) {
        return {
            (std::abs(I[0]) > 1e-15) ? tau[0] / I[0] : 0,
            (std::abs(I[1]) > 1e-15) ? tau[1] / I[1] : 0,
            (std::abs(I[2]) > 1e-15) ? tau[2] / I[2] : 0
        };
    }

    // General case: solve via 3x3 inverse (Cramer's rule)
    Mat3 M = inertiaToMat3(I);
    double det = M[0][0]*(M[1][1]*M[2][2] - M[1][2]*M[2][1])
               - M[0][1]*(M[1][0]*M[2][2] - M[1][2]*M[2][0])
               + M[0][2]*(M[1][0]*M[2][1] - M[1][1]*M[2][0]);
    if (std::abs(det) < 1e-20) return {0, 0, 0};

    double invDet = 1.0 / det;
    Mat3 inv;
    inv[0][0] = (M[1][1]*M[2][2] - M[1][2]*M[2][1]) * invDet;
    inv[0][1] = (M[0][2]*M[2][1] - M[0][1]*M[2][2]) * invDet;
    inv[0][2] = (M[0][1]*M[1][2] - M[0][2]*M[1][1]) * invDet;
    inv[1][0] = (M[1][2]*M[2][0] - M[1][0]*M[2][2]) * invDet;
    inv[1][1] = (M[0][0]*M[2][2] - M[0][2]*M[2][0]) * invDet;
    inv[1][2] = (M[0][2]*M[1][0] - M[0][0]*M[1][2]) * invDet;
    inv[2][0] = (M[1][0]*M[2][1] - M[1][1]*M[2][0]) * invDet;
    inv[2][1] = (M[0][1]*M[2][0] - M[0][0]*M[2][1]) * invDet;
    inv[2][2] = (M[0][0]*M[1][1] - M[0][1]*M[1][0]) * invDet;
    return mat3vec(inv, tau);
}

/// Update inertia for mass change (assumes uniform density change)
/// Scales all inertia components by (new_mass / old_mass)
inline InertiaTensor inertiaScaled(const InertiaTensor& I,
                                    double oldMass, double newMass) {
    if (oldMass < 1e-15) return I;
    double ratio = newMass / oldMass;
    return {I[0]*ratio, I[1]*ratio, I[2]*ratio,
            I[3]*ratio, I[4]*ratio, I[5]*ratio};
}

// ============================================================================
// Quaternion Kinematics
// ============================================================================

/// Quaternion derivative from angular velocity (body frame)
/// q̇ = ½ q ⊗ [0, ωx, ωy, ωz]
inline Quat qdot(const Quat& q, const Vec3& omega) {
    Quat omega_q = {0, omega[0], omega[1], omega[2]};
    Quat result = qmul(q, omega_q);
    return qscale(result, 0.5);
}

// ============================================================================
// Euler's Rotational Equations
// ============================================================================

/// Angular acceleration from Euler's equation:
/// I·ω̇ = τ - ω × (I·ω)
/// Returns ω̇ (angular acceleration in body frame)
inline Vec3 eulerEquation(const InertiaTensor& I,
                           const Vec3& omega,
                           const Vec3& torque) {
    Vec3 Iw = inertiaTimesOmega(I, omega);
    Vec3 gyro = v3cross(omega, Iw);         // ω × Iω (gyroscopic term)
    Vec3 rhs = v3sub(torque, gyro);          // τ - ω × Iω
    return inertiaInvTimesVec(I, rhs);       // I⁻¹(τ - ω × Iω)
}

// ============================================================================
// 6DOF State Derivative
// ============================================================================

/// Compute full 6DOF state derivative
/// Forces can be specified in inertial OR body frame (set the other to zero)
inline StateDeriv computeDerivative(const State& s,
                                     const InertiaTensor& I,
                                     const ForcesTorques& ft) {
    StateDeriv d;

    // Translational: ṗ = v, v̇ = F/m
    d.dpos = s.vel;

    // Total force in inertial frame
    Vec3 F_inertial = ft.force_inertial;
    // Add body-frame forces rotated to inertial
    if (v3normSq(ft.force_body) > 0) {
        Vec3 F_body_inertial = qrotate(s.quat, ft.force_body);
        F_inertial = v3add(F_inertial, F_body_inertial);
    }
    d.dvel = (s.mass > 1e-15) ? v3scale(F_inertial, 1.0 / s.mass) : v3zero();

    // Rotational: q̇ = ½ q ⊗ ω, ω̇ = I⁻¹(τ - ω × Iω)
    d.dquat = qdot(s.quat, s.omega);
    d.domega = eulerEquation(I, s.omega, ft.torque_body);

    // Mass rate
    d.dmass = ft.mass_rate;

    return d;
}

// ============================================================================
// State Arithmetic (for RK4)
// ============================================================================

/// s + d * dt
inline State stateAddScaled(const State& s, const StateDeriv& d, double dt) {
    State r;
    r.pos   = v3add(s.pos, v3scale(d.dpos, dt));
    r.vel   = v3add(s.vel, v3scale(d.dvel, dt));
    r.quat  = qnormalize(qadd(s.quat, qscale(d.dquat, dt)));
    r.omega = v3add(s.omega, v3scale(d.domega, dt));
    r.mass  = s.mass + d.dmass * dt;
    if (r.mass < 0) r.mass = 0;
    return r;
}

/// Weighted sum of derivatives: a + b*s
inline StateDeriv derivAddScaled(const StateDeriv& a, const StateDeriv& b, double s) {
    StateDeriv r;
    r.dpos   = v3add(a.dpos, v3scale(b.dpos, s));
    r.dvel   = v3add(a.dvel, v3scale(b.dvel, s));
    r.dquat  = qadd(a.dquat, qscale(b.dquat, s));
    r.domega = v3add(a.domega, v3scale(b.domega, s));
    r.dmass  = a.dmass + b.dmass * s;
    return r;
}

/// Zero derivative
inline StateDeriv derivZero() { return {}; }

// ============================================================================
// RK4 Integrator
// ============================================================================

/**
 * 4th-order Runge-Kutta step for 6DOF dynamics.
 *
 * @param state     Current state
 * @param inertia   Current inertia tensor (may vary with mass)
 * @param dt        Time step [s]
 * @param forceFn   Callback: (State, double t) → ForcesTorques
 * @param t         Current time [s]
 * @return          New state after dt
 *
 * The force function is called 4 times per step (k1-k4).
 * It should compute ALL forces and torques (gravity, thrust, aero,
 * guidance, disturbances) at the given state and time.
 */
template<typename ForceFn>
State rk4Step(const State& state,
              const InertiaTensor& inertia,
              double dt, double t,
              ForceFn&& forceFn) {

    auto deriv = [&](const State& s, double time) -> StateDeriv {
        ForcesTorques ft = forceFn(s, time);
        // Scale inertia with current mass
        InertiaTensor I = inertiaScaled(inertia, state.mass, s.mass);
        return computeDerivative(s, I, ft);
    };

    StateDeriv k1 = deriv(state, t);
    State s2 = stateAddScaled(state, k1, dt * 0.5);
    StateDeriv k2 = deriv(s2, t + dt * 0.5);
    State s3 = stateAddScaled(state, k2, dt * 0.5);
    StateDeriv k3 = deriv(s3, t + dt * 0.5);
    State s4 = stateAddScaled(state, k3, dt);
    StateDeriv k4 = deriv(s4, t + dt);

    // Weighted average: (k1 + 2*k2 + 2*k3 + k4) / 6
    StateDeriv avg = derivZero();
    avg = derivAddScaled(avg, k1, 1.0/6.0);
    avg = derivAddScaled(avg, k2, 2.0/6.0);
    avg = derivAddScaled(avg, k3, 2.0/6.0);
    avg = derivAddScaled(avg, k4, 1.0/6.0);

    State result = stateAddScaled(state, avg, dt);
    // Re-normalize quaternion (drift prevention)
    result.quat = qnormalize(result.quat);
    return result;
}

// ============================================================================
// Aerodynamic Moment Helpers
// ============================================================================

/// Compute angle of attack and sideslip from body-frame velocity
/// Returns [alpha, beta] in radians
inline std::array<double, 2> aeroAngles(const Quat& q_body_to_inertial,
                                          const Vec3& vel_inertial,
                                          const Vec3& wind_inertial = {0,0,0}) {
    // Velocity relative to air, in body frame
    Vec3 v_air = v3sub(vel_inertial, wind_inertial);
    Vec3 v_body = qrotateInv(q_body_to_inertial, v_air);

    // v_body = [u, v, w] in body frame (X-fwd, Y-right, Z-down)
    double u = v_body[0], v = v_body[1], w = v_body[2];
    double speed_xz = std::sqrt(u*u + w*w);

    double alpha = (speed_xz > 1e-6) ? std::atan2(w, u) : 0;  // angle of attack
    double beta  = (v3norm(v_body) > 1e-6)
                   ? std::asin(v / v3norm(v_body)) : 0;         // sideslip
    return {alpha, beta};
}

/// Compute pitching moment from Cm·q·S·Lref
/// Cm includes: Cm_alpha * alpha + Cm_q * (q * Lref / 2V) + Cm_delta * delta_e
struct AeroMomentCoeffs {
    double Cm_alpha = -2.0;     // pitch stiffness (negative = stable)
    double Cm_q     = -10.0;    // pitch damping
    double Cn_beta  = 0.5;      // yaw stiffness (positive = stable)
    double Cn_r     = -5.0;     // yaw damping
    double Cl_p     = -8.0;     // roll damping
    double Cl_delta = 0.1;      // roll control effectiveness
    double Cm_delta = -0.5;     // pitch control effectiveness (elevator)
    double Cn_delta = 0.3;      // yaw control effectiveness (rudder)
};

/// Compute aerodynamic moments in body frame
/// @param alpha    Angle of attack [rad]
/// @param beta     Sideslip angle [rad]
/// @param omega    Body angular velocity [p,q,r] [rad/s]
/// @param qbar     Dynamic pressure [Pa]
/// @param Sref     Reference area [m²]
/// @param Lref     Reference length (chord or diameter) [m]
/// @param speed    Airspeed [m/s]
/// @param coeffs   Aerodynamic moment coefficients
/// @param controls Control deflections [roll, pitch, yaw] [rad]
inline Vec3 aeroMoments(double alpha, double beta,
                         const Vec3& omega, double qbar,
                         double Sref, double Lref, double speed,
                         const AeroMomentCoeffs& coeffs,
                         const Vec3& controls = {0,0,0}) {
    double qSL = qbar * Sref * Lref;
    double p = omega[0], q = omega[1], r = omega[2];

    // Non-dimensionalized angular rates
    double phat = (speed > 1e-3) ? (p * Lref) / (2.0 * speed) : 0;
    double qhat = (speed > 1e-3) ? (q * Lref) / (2.0 * speed) : 0;
    double rhat = (speed > 1e-3) ? (r * Lref) / (2.0 * speed) : 0;

    // Moment coefficients
    double Cl = coeffs.Cl_p * phat + coeffs.Cl_delta * controls[0];
    double Cm = coeffs.Cm_alpha * alpha + coeffs.Cm_q * qhat
              + coeffs.Cm_delta * controls[1];
    double Cn = coeffs.Cn_beta * beta + coeffs.Cn_r * rhat
              + coeffs.Cn_delta * controls[2];

    return {Cl * qSL, Cm * qSL, Cn * qSL};
}

// ============================================================================
// Convenience: Body-Frame Force Decomposition
// ============================================================================

/// Decompose aerodynamic forces in body frame from CL, CD, alpha
/// Returns force in body frame [X_body, Y_body, Z_body]
/// X_body = -D*cos(α) + L*sin(α)  (along body x-axis)
/// Z_body = -D*sin(α) - L*cos(α)  (along body z-axis, positive down)
inline Vec3 aeroForcesBody(double CL, double CD, double alpha,
                            double qbar, double Sref) {
    double L = CL * qbar * Sref;
    double D = CD * qbar * Sref;
    return {
        -D * std::cos(alpha) + L * std::sin(alpha),
        0, // no side force in symmetric flight
        -D * std::sin(alpha) - L * std::cos(alpha)
    };
}

// ============================================================================
// Coordinate Frame Helpers
// ============================================================================

/// Build a quaternion that points body X-axis along a direction vector
/// with Z-axis roughly pointing down (for initialization)
inline Quat quatFromDirection(const Vec3& dir, const Vec3& up = {0,0,-1}) {
    Vec3 fwd = v3normalized(dir);
    Vec3 right = v3normalized(v3cross(fwd, up));
    Vec3 down = v3cross(right, fwd); // actually "down" if up is {0,0,-1}

    Mat3 dcm = {{
        {fwd[0], right[0], down[0]},
        {fwd[1], right[1], down[1]},
        {fwd[2], right[2], down[2]}
    }};
    return dcmToQuat(dcm);
}

}  // namespace sixdof

#endif  // SIXDOF_CORE_H
