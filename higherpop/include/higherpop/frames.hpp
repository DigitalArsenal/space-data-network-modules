// higherpop/frames.hpp — IAU-2006/2000A Earth-orientation frame chain
//
// GCRF (≈ICRF/J2000 inertial) <-> ITRF (Earth-fixed) via the CIO-based
// transformation of IERS Conventions 2010 / IAU-2006 precession + IAU-2000A
// nutation, exactly as implemented by the IAU SOFA library.
//
// The high-precision series (XY06 ~1600 terms, s06 CIO locator, fundamental
// arguments) are provided by the vendored ERFA library (BSD-3, derived with
// permission from IAU SOFA — see third_party/erfa/). This header is a thin,
// unit-consistent C++ wrapper: it owns time-scale bookkeeping, Earth-orientation
// parameters (EOP), and position/velocity rotation, and delegates the astronomy
// to ERFA so results match SOFA to sub-microarcsecond.
//
// Units: positions km, velocities km/s, angles rad, times as two-part Julian
// dates (TT for the celestial side, UT1 for Earth rotation) — matching ERFA.
//
// Build: compile with the vendored ERFA objects, e.g.
//   clang++ -std=c++17 -Iinclude -Ithird_party/erfa ... third_party/erfa/*.o
// (the umbrella higherpop.hpp does NOT include this file, so the core stays
//  dependency-free; include "higherpop/frames.hpp" explicitly when you need it.)

#ifndef HIGHERPOP_FRAMES_HPP
#define HIGHERPOP_FRAMES_HPP

#include <array>
#include <cmath>
#include "higherpop/vec3.hpp"

extern "C" {
  // ERFA prototypes we use (from third_party/erfa/erfa.h). Declared locally so
  // this header needs only erfa.h on the include path at compile time.
  int    eraCal2jd(int iy, int im, int id, double *djm0, double *djm);
  int    eraDat(int iy, int im, int id, double fd, double *deltat);
  void   eraXy06(double date1, double date2, double *x, double *y);
  double eraS06(double date1, double date2, double x, double y);
  void   eraC2ixys(double x, double y, double s, double rc2i[3][3]);
  double eraEra00(double dj1, double dj2);
  double eraSp00(double date1, double date2);
  void   eraPom00(double xp, double yp, double sp, double rpom[3][3]);
  void   eraC2tcio(double rc2i[3][3], double era, double rpom[3][3], double rc2t[3][3]);
  int    eraGc2gde(double a, double f, double xyz[3], double *elong, double *phi, double *height);
  int    eraGd2gce(double a, double f, double elong, double phi, double height, double xyz[3]);
}

namespace hp {
namespace frames {

constexpr double AS2R   = 4.848136811095359935899141e-6; // arcsec -> rad
constexpr double DJ00   = 2451545.0;                      // J2000.0 JD (TT)
constexpr double DAYSEC = 86400.0;
constexpr double OMEGA_EARTH = 7.292115146706979e-5;      // rad/s, IERS mean (for velocity)
constexpr double WGS84_A_KM = 6378.137;                   // km
constexpr double WGS84_F    = 1.0/298.257223563;

using Mat3 = std::array<std::array<double,3>,3>;

// ---- Earth-orientation parameters for a given epoch -----------------------
// dut1  : UT1-UTC  [s]
// xp,yp : polar motion [arcsec]
// dX,dY : CIP celestial-pole offsets to IAU-2006/2000A [arcsec] (usually tiny)
// lod   : excess length of day [s] (optional, refines the rotation rate)
struct EOP {
  double dut1 = 0.0;
  double xp_arcsec = 0.0, yp_arcsec = 0.0;
  double dX_arcsec = 0.0, dY_arcsec = 0.0;
  double lod = 0.0;
};

// ---- UTC calendar epoch ---------------------------------------------------
struct UTCDate {
  int year, month, day;
  int hour = 0, minute = 0;
  double second = 0.0;
};

// Two-part Julian dates for the two time scales the chain needs.
struct JulianTT_UT1 {
  double tt1, tt2;   // TT (celestial side: precession/nutation, s, sp)
  double ut11, ut12; // UT1 (Earth rotation angle)
};

// Convert a UTC calendar date + EOP into the TT and UT1 two-part JDs ERFA wants.
inline JulianTT_UT1 timescales(const UTCDate& d, const EOP& e) {
  double djmjd0, date;
  eraCal2jd(d.year, d.month, d.day, &djmjd0, &date);
  double utc_frac = (60.0*(60.0*d.hour + d.minute) + d.second) / DAYSEC;
  double dat;
  eraDat(d.year, d.month, d.day, utc_frac, &dat); // TAI-UTC (leap seconds)
  double tai_frac = utc_frac + dat/DAYSEC;
  double tt_frac  = tai_frac + 32.184/DAYSEC;
  double ut1_frac = utc_frac + e.dut1/DAYSEC;
  JulianTT_UT1 t;
  t.tt1 = djmjd0; t.tt2 = date + tt_frac;
  t.ut11 = djmjd0; t.ut12 = date + ut1_frac;
  return t;
}

// ---- The core: GCRF -> ITRF rotation matrix (CIO based) -------------------
// Returns the 3x3 matrix R such that r_ITRF = R * r_GCRF.
inline Mat3 gcrf_to_itrf_matrix(const JulianTT_UT1& t, const EOP& e) {
  double x, y;
  eraXy06(t.tt1, t.tt2, &x, &y);            // CIP X,Y from the IAU-2006 series
  double s = eraS06(t.tt1, t.tt2, x, y);    // CIO locator s
  x += e.dX_arcsec * AS2R;                  // apply observed pole offsets
  y += e.dY_arcsec * AS2R;
  double rc2i[3][3];
  eraC2ixys(x, y, s, rc2i);                 // celestial -> intermediate
  double era = eraEra00(t.ut11, t.ut12);    // Earth rotation angle
  double sp  = eraSp00(t.tt1, t.tt2);       // TIO locator
  double rpom[3][3];
  eraPom00(e.xp_arcsec*AS2R, e.yp_arcsec*AS2R, sp, rpom); // polar motion
  double rc2t[3][3];
  eraC2tcio(rc2i, era, rpom, rc2t);         // full celestial -> terrestrial
  Mat3 R;
  for (int i=0;i<3;++i) for (int j=0;j<3;++j) R[i][j]=rc2t[i][j];
  return R;
}

inline Vec3 matvec(const Mat3& R, const Vec3& v) {
  return Vec3{ R[0][0]*v.x + R[0][1]*v.y + R[0][2]*v.z,
              R[1][0]*v.x + R[1][1]*v.y + R[1][2]*v.z,
              R[2][0]*v.x + R[2][1]*v.y + R[2][2]*v.z };
}
inline Vec3 matTvec(const Mat3& R, const Vec3& v) { // R^T * v
  return Vec3{ R[0][0]*v.x + R[1][0]*v.y + R[2][0]*v.z,
              R[0][1]*v.x + R[1][1]*v.y + R[2][1]*v.z,
              R[0][2]*v.x + R[1][2]*v.y + R[2][2]*v.z };
}

// ---- Convenience position transforms --------------------------------------
inline Vec3 gcrfToItrf(const Vec3& r_gcrf, const UTCDate& d, const EOP& e) {
  return matvec(gcrf_to_itrf_matrix(timescales(d,e), e), r_gcrf);
}
inline Vec3 itrfToGcrf(const Vec3& r_itrf, const UTCDate& d, const EOP& e) {
  return matTvec(gcrf_to_itrf_matrix(timescales(d,e), e), r_itrf);
}

// ---- Position+velocity transforms (account for Earth's rotation) ----------
// v_ITRF = R*v_GCRF - omega x r_ITRF ; v_GCRF = R^T*(v_ITRF + omega x r_ITRF)
struct StatePV { Vec3 r, v; };

inline double rotationRate(const EOP& e) {
  // omega adjusted for excess length of day (lod): fraction of a day slower.
  return OMEGA_EARTH * (1.0 - e.lod/DAYSEC);
}

inline StatePV gcrfToItrf(const StatePV& s, const UTCDate& d, const EOP& e) {
  Mat3 R = gcrf_to_itrf_matrix(timescales(d,e), e);
  Vec3 r_it = matvec(R, s.r);
  Vec3 v_rot = matvec(R, s.v);
  double w = rotationRate(e);
  Vec3 omega{0,0,w};
  Vec3 wxr = cross(omega, r_it);
  return StatePV{ r_it, Vec3{v_rot.x - wxr.x, v_rot.y - wxr.y, v_rot.z - wxr.z} };
}
inline StatePV itrfToGcrf(const StatePV& s, const UTCDate& d, const EOP& e) {
  Mat3 R = gcrf_to_itrf_matrix(timescales(d,e), e);
  double w = rotationRate(e);
  Vec3 omega{0,0,w};
  Vec3 wxr = cross(omega, s.r);
  Vec3 v_inertial_fixed{ s.v.x + wxr.x, s.v.y + wxr.y, s.v.z + wxr.z };
  return StatePV{ matTvec(R, s.r), matTvec(R, v_inertial_fixed) };
}

// ---- Geodetic (ITRF Cartesian <-> lat/lon/height on WGS84) ----------------
struct Geodetic { double lat_rad, lon_rad, height_km; };

inline Geodetic itrfToGeodetic(const Vec3& r_itrf_km) {
  double xyz[3] = { r_itrf_km.x*1000.0, r_itrf_km.y*1000.0, r_itrf_km.z*1000.0 };
  double elong, phi, height_m;
  eraGc2gde(WGS84_A_KM*1000.0, WGS84_F, xyz, &elong, &phi, &height_m);
  return Geodetic{ phi, elong, height_m/1000.0 };
}
inline Vec3 geodeticToItrf(const Geodetic& g) {
  double xyz[3];
  eraGd2gce(WGS84_A_KM*1000.0, WGS84_F, g.lon_rad, g.lat_rad, g.height_km*1000.0, xyz);
  return Vec3{ xyz[0]/1000.0, xyz[1]/1000.0, xyz[2]/1000.0 };
}

} // namespace frames
} // namespace hp

#endif // HIGHERPOP_FRAMES_HPP
