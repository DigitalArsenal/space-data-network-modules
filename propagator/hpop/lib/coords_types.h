// plugins/coords/include/coords_types.h
// =============================================================================
// Coordinate Transform Plugin Types
// =============================================================================
// Defines coordinate frames and data types for transformations between
// various reference frames used in astrodynamics.
// =============================================================================

#pragma once
#include <cstdint>
#include <cmath>

namespace coords {

// =============================================================================
// Coordinate Frames
// =============================================================================

/// Coordinate reference frames supported by this plugin
enum class Frame : uint8_t {
    TEME = 0,   ///< True Equator Mean Equinox (SGP4 native frame)
    GCRF = 1,   ///< Geocentric Celestial Reference Frame (quasi-inertial)
    ITRF = 2,   ///< International Terrestrial Reference Frame (Earth-fixed)
    J2000 = 3,  ///< J2000 inertial (effectively same as GCRF for most purposes)
    ECEF = 4,   ///< Earth-Centered Earth-Fixed (alias for ITRF)
    PEF = 5,    ///< Pseudo Earth Fixed (intermediate frame)
    TOD = 6,    ///< True of Date
    MOD = 7     ///< Mean of Date
};

// =============================================================================
// Vector Types
// =============================================================================

/// 3D vector for position (km) or velocity (km/s)
struct Vec3 {
    double x, y, z;

    /// Default constructor (zero vector)
    Vec3() : x(0.0), y(0.0), z(0.0) {}

    /// Component constructor
    Vec3(double x_, double y_, double z_) : x(x_), y(y_), z(z_) {}

    /// Vector addition
    Vec3 operator+(const Vec3& other) const {
        return Vec3(x + other.x, y + other.y, z + other.z);
    }

    /// Vector subtraction
    Vec3 operator-(const Vec3& other) const {
        return Vec3(x - other.x, y - other.y, z - other.z);
    }

    /// Scalar multiplication
    Vec3 operator*(double s) const {
        return Vec3(x * s, y * s, z * s);
    }

    /// Dot product
    double dot(const Vec3& other) const {
        return x * other.x + y * other.y + z * other.z;
    }

    /// Cross product
    Vec3 cross(const Vec3& other) const {
        return Vec3(
            y * other.z - z * other.y,
            z * other.x - x * other.z,
            x * other.y - y * other.x
        );
    }

    /// Magnitude
    double magnitude() const {
        return std::sqrt(x * x + y * y + z * z);
    }

    /// Normalize (returns unit vector)
    Vec3 normalize() const {
        double mag = magnitude();
        if (mag > 0.0) {
            return Vec3(x / mag, y / mag, z / mag);
        }
        return Vec3(0.0, 0.0, 0.0);
    }
};

// =============================================================================
// Matrix Types
// =============================================================================

/// 3x3 rotation matrix (row-major storage)
///
/// Layout:
///   m[0] m[1] m[2]     Row 0
///   m[3] m[4] m[5]     Row 1
///   m[6] m[7] m[8]     Row 2
struct Matrix3x3 {
    double m[9];

    /// Default constructor (identity matrix)
    Matrix3x3() {
        m[0] = 1.0; m[1] = 0.0; m[2] = 0.0;
        m[3] = 0.0; m[4] = 1.0; m[5] = 0.0;
        m[6] = 0.0; m[7] = 0.0; m[8] = 1.0;
    }

    /// Construct from array (row-major)
    explicit Matrix3x3(const double* data) {
        for (int i = 0; i < 9; ++i) {
            m[i] = data[i];
        }
    }

    /// Get element at (row, col)
    double at(int row, int col) const {
        return m[row * 3 + col];
    }

    /// Set element at (row, col)
    void set(int row, int col, double value) {
        m[row * 3 + col] = value;
    }

    /// Apply rotation to vector: result = M * v
    Vec3 apply(const Vec3& v) const {
        return Vec3(
            m[0] * v.x + m[1] * v.y + m[2] * v.z,
            m[3] * v.x + m[4] * v.y + m[5] * v.z,
            m[6] * v.x + m[7] * v.y + m[8] * v.z
        );
    }

    /// Transpose (inverse for rotation matrices)
    Matrix3x3 transpose() const {
        Matrix3x3 result;
        result.m[0] = m[0]; result.m[1] = m[3]; result.m[2] = m[6];
        result.m[3] = m[1]; result.m[4] = m[4]; result.m[5] = m[7];
        result.m[6] = m[2]; result.m[7] = m[5]; result.m[8] = m[8];
        return result;
    }

    /// Matrix multiplication: result = this * other
    Matrix3x3 operator*(const Matrix3x3& other) const {
        Matrix3x3 result;
        for (int i = 0; i < 3; ++i) {
            for (int j = 0; j < 3; ++j) {
                double sum = 0.0;
                for (int k = 0; k < 3; ++k) {
                    sum += at(i, k) * other.at(k, j);
                }
                result.set(i, j, sum);
            }
        }
        return result;
    }

    /// Create identity matrix
    static Matrix3x3 identity() {
        return Matrix3x3();
    }

    /// Create rotation matrix about X axis
    static Matrix3x3 rotateX(double angle) {
        Matrix3x3 result;
        double c = std::cos(angle);
        double s = std::sin(angle);
        result.m[0] = 1.0; result.m[1] = 0.0; result.m[2] = 0.0;
        result.m[3] = 0.0; result.m[4] = c;   result.m[5] = s;
        result.m[6] = 0.0; result.m[7] = -s;  result.m[8] = c;
        return result;
    }

    /// Create rotation matrix about Y axis
    static Matrix3x3 rotateY(double angle) {
        Matrix3x3 result;
        double c = std::cos(angle);
        double s = std::sin(angle);
        result.m[0] = c;   result.m[1] = 0.0; result.m[2] = -s;
        result.m[3] = 0.0; result.m[4] = 1.0; result.m[5] = 0.0;
        result.m[6] = s;   result.m[7] = 0.0; result.m[8] = c;
        return result;
    }

    /// Create rotation matrix about Z axis
    static Matrix3x3 rotateZ(double angle) {
        Matrix3x3 result;
        double c = std::cos(angle);
        double s = std::sin(angle);
        result.m[0] = c;   result.m[1] = s;   result.m[2] = 0.0;
        result.m[3] = -s;  result.m[4] = c;   result.m[5] = 0.0;
        result.m[6] = 0.0; result.m[7] = 0.0; result.m[8] = 1.0;
        return result;
    }
};

// =============================================================================
// State Vector
// =============================================================================

/// State vector containing position and velocity
struct StateVec {
    Vec3 position;  ///< Position in km
    Vec3 velocity;  ///< Velocity in km/s

    /// Default constructor (zero state)
    StateVec() : position(), velocity() {}

    /// Component constructor
    StateVec(const Vec3& pos, const Vec3& vel) : position(pos), velocity(vel) {}
};

// =============================================================================
// Constants
// =============================================================================

namespace constants {

/// Mathematical constants
constexpr double PI = 3.14159265358979323846;
constexpr double TWOPI = 2.0 * PI;
constexpr double DEG2RAD = PI / 180.0;
constexpr double RAD2DEG = 180.0 / PI;
constexpr double ARCSEC2RAD = PI / (180.0 * 3600.0);

/// Time constants
constexpr double JULIAN_CENTURY = 36525.0;           ///< Days in a Julian century
constexpr double J2000_EPOCH = 2451545.0;            ///< Julian date of J2000.0 epoch (2000-01-01 12:00 TT)
constexpr double MJD_OFFSET = 2400000.5;             ///< Offset from JD to MJD
constexpr double SECONDS_PER_DAY = 86400.0;

/// Earth constants (IAU 1976/1980)
constexpr double EARTH_ROTATION_RATE = 7.292115146706979e-5;  ///< rad/s (WGS84)

}  // namespace constants

}  // namespace coords
