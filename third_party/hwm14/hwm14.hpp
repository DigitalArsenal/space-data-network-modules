// Horizontal Wind Model 2014 (HWM14), C++ port of the NRL release
// HWM14.123114 (hwm14.f90, 31 Dec 2014) by D. P. Drob and J. T. Emmert.
//
// The port reproduces the reference FORTRAN bit for bit on the same libm:
// real(4) arithmetic stays float, real(8) stays double, expressions keep the
// FORTRAN evaluation order and dot products stay sequential. See README.md for
// provenance and the verification that backs that statement.
//
// Units follow the FORTRAN interface: altitude km, angles degrees, winds m/s,
// time as yyddd plus UT seconds.
#pragma once

#include <array>
#include <cstdint>
#include <vector>

namespace hwm14 {

// Model coefficients, parsed once from the three NRL data files.
struct ModelData;

class Model {
public:
    // Loads the embedded NRL data files after checking their SHA-256.
    Model();
    ~Model();
    Model(const Model&) = delete;
    Model& operator=(const Model&) = delete;

    // Total horizontal wind: quiet time plus, when ap[1] >= 0, the DWM07
    // disturbance wind. w[0] meridional (+north), w[1] zonal (+east).
    // stl, f107a, f107 and ap[0] are accepted and ignored, as in HWM14.
    void hwm14(int iyd, float sec, float alt, float glat, float glon, float stl, float f107a,
               float f107, const float ap[2], float w[2]) const;

    // Quiet-time wind only (HWMQT).
    void hwmqt(int iyd, float sec, float alt, float glat, float glon, float stl, float f107a,
               float f107, const float ap[2], float w[2]) const;

    // Disturbance wind in geographic coordinates (DWM07), ap[1] = 3-hour ap.
    void dwm07(int iyd, float sec, float alt, float glat, float glon, const float ap[2],
               float dw[2]) const;

    // DWM07 with the 3-hour Kp given directly instead of ap. dwm07(ap) is
    // exactly dwm07kp(ap2kp(ap[1])); inputs that carry Kp (for example SDS
    // PRW weather) avoid the ap round trip.
    void dwm07kp(int iyd, float sec, float alt, float glat, float glon, float kp, float dw[2]) const;

    // Disturbance wind in quasi-dipole coordinates (DWM07B).
    void dwm07b(float mlt, float mlat, float kp, float* mmpwind, float* mzpwind) const;

    // Geodetic to quasi-dipole coordinates and the QD base vectors F1, F2.
    void gd2qd(float glat, float glon, float* qlat, float* qlon, float* f1e, float* f1n,
               float* f2e, float* f2n) const;

    // Quasi-dipole magnetic local time (hours), low-precision sun position.
    float mltcalc(float qlat, float qlon, float day, float ut) const;

    // The 3-hour ap to Kp conversion used by DWM07.
    static float ap2kp(float ap);

    // Cubic-spline Kp terms of DWM07.
    static void kpspl3(float kp, float kpterms[3]);

    // High-latitude weighting term of DWM07.
    static float latwgt2(float mlat, float mlt, float kp, float twidth);

    // DWM07 transition width of the high-latitude mask, from the data file.
    float dwmTransitionWidth() const;

private:
    ModelData* d_;
};

// Associated Legendre and vector spherical harmonic basis (ALFBASIS) for
// degree nmax and order mmax at colatitude theta (radians). The arrays are
// column-major (n fastest) with leading dimension ld = rows >= nmax + 1, the
// shape FORTRAN would pass. Exposed for tests.
struct AlfCoefficients {
    int nmax = 0;
    int mmax = 0;
    std::vector<double> anm, bnm, dnm, cm, en, marr, narr;
    AlfCoefficients(int nmaxIn, int mmaxIn);
};
void alfbasis(const AlfCoefficients& c, int nmax, int mmax, double theta, double* P, double* V,
              double* W, int ld);

// SHA-256 of the embedded NRL data files, as lowercase hex.
struct EmbeddedFile {
    const char* name;
    const unsigned char* bytes;
    std::size_t size;
    const char* sha256;
};
const EmbeddedFile* embeddedFiles(std::size_t* count);

}  // namespace hwm14
