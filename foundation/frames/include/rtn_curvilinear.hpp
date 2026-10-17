// foundation/frames: the RIC (CCSDS RTN) frame of an orbiting reference and
// curvilinear relative coordinates about it, as source shared by modules.
//
// These are the definitions OrbPro's RIC box uses (OrbPro
// packages/wasm-engine/Source/Core/OrbitalState.cpp: ricBasis,
// orbpro_frame_relative_state_ric, curvilinearFromRectilinear,
// rectilinearFromCurvilinear; ric-rtn-curvilinear-20261017), so a module's
// relative-motion series and the box agree number for number.
//
// - RTN (CCSDS 508.0-B-1, the CDM's RTN): from the INERTIAL state of the
//   reference, R = r/|r|, N = (r x v)/|r x v|, T = N x R. RIC names the same
//   axes (radial, in-track, cross-track).
// - Rectilinear RIC of a point: its offset from the reference written in
//   those axes, (x, y, z).
// - Curvilinear RIC about a reference at geocentric distance r0: with
//   p = (r0 + x, y, z), radial = |p| - r0, in-track = r0 * atan2(y, r0 + x)
//   (the in-plane arc, wrapped to +-pi r0), cross-track = r0 * atan2(z,
//   hypot(r0 + x, y)) (the out-of-plane arc).
//
// Header-only, no exceptions, no allocation: include it in a module's single
// translation unit (a build.mjs reads the text). Lengths are in any one unit
// (km or m) used consistently; angles in radians.
#ifndef SDN_FOUNDATION_FRAMES_RTN_CURVILINEAR_HPP
#define SDN_FOUNDATION_FRAMES_RTN_CURVILINEAR_HPP

#include <cmath>

namespace sdn_frames {

// OrbPro's degenerateOrbitPlaneSine: a state whose r and v are parallel to
// this sine has no orbit plane.
constexpr double kDegenerateOrbitPlaneSine = 1.0e-12;

inline double rcDot(const double* a, const double* b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
inline void rcCross(const double* a, const double* b, double* out) {
  const double x = a[1] * b[2] - a[2] * b[1];
  const double y = a[2] * b[0] - a[0] * b[2];
  const double z = a[0] * b[1] - a[1] * b[0];
  out[0] = x;
  out[1] = y;
  out[2] = z;
}
inline bool rcFinite(const double* a, int n) {
  for (int i = 0; i < n; ++i)
    if (!std::isfinite(a[i])) return false;
  return true;
}
inline void rcNormalize(const double* a, double* out) {
  const double m = std::sqrt(rcDot(a, a));
  out[0] = a[0] / m;
  out[1] = a[1] / m;
  out[2] = a[2] / m;
}

// The RIC (RTN) axes of an inertial state: basis[0..2] = R, basis[3..5] = I
// (T), basis[6..8] = C (N), each written in the state's inertial axes. False
// when the state has no orbit plane (zero radius, r parallel to v, non-finite).
inline bool ricBasis(const double* r, const double* v, double* basis) {
  if (!rcFinite(r, 3) || !rcFinite(v, 3)) return false;
  const double radiusSquared = rcDot(r, r);
  if (!(radiusSquared > 0.0)) return false;
  double radial[3], crossTrack[3], inTrack[3];
  rcNormalize(r, radial);
  rcCross(r, v, crossTrack);
  const double sineOfPlaneAngle = std::sqrt(rcDot(crossTrack, crossTrack) / (radiusSquared * rcDot(v, v)));
  if (!(sineOfPlaneAngle > kDegenerateOrbitPlaneSine)) return false;
  rcNormalize(crossTrack, crossTrack);
  rcCross(crossTrack, radial, inTrack);
  rcNormalize(inTrack, inTrack);
  for (int i = 0; i < 3; ++i) {
    basis[i] = radial[i];
    basis[3 + i] = inTrack[i];
    basis[6 + i] = crossTrack[i];
  }
  return rcFinite(basis, 9);
}

// A deputy's state in the chief's rotating RIC frame (orbpro_frame_relative_
// state_ric): position = B^T (r_d - r_c), velocity = B^T (v_d - v_c) - w x
// position with w = |r_c x v_c| / |r_c|^2 about C. out[0..5]. False when the
// chief has no orbit plane.
inline bool relativeStateRic(const double* rc, const double* vc, const double* rd, const double* vd, double* out) {
  double basis[9];
  if (!ricBasis(rc, vc, basis) || !rcFinite(rd, 3) || !rcFinite(vd, 3)) return false;
  const double dr[3] = {rd[0] - rc[0], rd[1] - rc[1], rd[2] - rc[2]};
  const double dv[3] = {vd[0] - vc[0], vd[1] - vc[1], vd[2] - vc[2]};
  for (int k = 0; k < 3; ++k) {
    out[k] = rcDot(basis + 3 * k, dr);
    out[3 + k] = rcDot(basis + 3 * k, dv);
  }
  double h[3];
  rcCross(rc, vc, h);
  const double rate = std::sqrt(rcDot(h, h)) / rcDot(rc, rc);
  if (!std::isfinite(rate)) return false;
  out[3] += rate * out[1];
  out[4] -= rate * out[0];
  return rcFinite(out, 6);
}

// Rectilinear RIC offset -> curvilinear (radius difference, in-plane arc,
// out-of-plane arc) about a reference at radius r0. |p| - r0 is formed as
// (|p|^2 - r0^2) / (|p| + r0) so it keeps its digits next to a large r0.
// False for a point at the center.
inline bool curvilinearFromRectilinear(double r0, const double* offset, double* result) {
  const double px = r0 + offset[0];
  const double py = offset[1];
  const double pz = offset[2];
  const double inPlane = std::hypot(px, py);
  const double radius = std::hypot(inPlane, pz);
  if (!(radius > 0.0)) return false;
  const double squaredSpan = offset[0] * offset[0] + py * py + pz * pz;
  result[0] = (2.0 * r0 * offset[0] + squaredSpan) / (radius + r0);
  result[1] = r0 * std::atan2(py, px);
  result[2] = r0 * std::atan2(pz, inPlane);
  return true;
}

// The inverse: p = (r0 + radial)(cos phi cos theta, cos phi sin theta, sin
// phi), theta = inTrack / r0, phi = crossTrack / r0, returned as p - (r0, 0,
// 0); cos phi cos theta - 1 is written with half-angle sines.
inline void rectilinearFromCurvilinear(double r0, const double* coordinates, double* result) {
  const double radial = coordinates[0];
  const double theta = coordinates[1] / r0;
  const double phi = coordinates[2] / r0;
  const double radius = r0 + radial;
  const double halfTheta = std::sin(0.5 * theta);
  const double halfPhi = std::sin(0.5 * phi);
  const double cosTheta = std::cos(theta);
  const double cosPhi = std::cos(phi);
  const double cosProductLessOne = -2.0 * (halfPhi * halfPhi * cosTheta + halfTheta * halfTheta);
  result[0] = radial * cosPhi * cosTheta + r0 * cosProductLessOne;
  result[1] = radius * cosPhi * std::sin(theta);
  result[2] = radius * std::sin(phi);
}

// d(curvilinear)/d(rectilinear offset) at an offset, r0 held fixed: the
// row-major 3x3 J that carries a rectilinear RIC covariance C to J C J^T.
// False at the center or on the polar axis of the reference's frame (the
// in-plane angle is undefined there).
inline bool curvilinearJacobian(double r0, const double* offset, double* jacobian) {
  const double px = r0 + offset[0];
  const double py = offset[1];
  const double pz = offset[2];
  const double rho2 = px * px + py * py;
  const double rho = std::sqrt(rho2);
  const double radius2 = rho2 + pz * pz;
  const double radius = std::sqrt(radius2);
  if (!(radius > 0.0) || !(rho > 0.0)) return false;
  jacobian[0] = px / radius;
  jacobian[1] = py / radius;
  jacobian[2] = pz / radius;
  jacobian[3] = -r0 * py / rho2;
  jacobian[4] = r0 * px / rho2;
  jacobian[5] = 0.0;
  jacobian[6] = -r0 * pz * px / (rho * radius2);
  jacobian[7] = -r0 * pz * py / (rho * radius2);
  jacobian[8] = r0 * rho / radius2;
  return rcFinite(jacobian, 9);
}

}  // namespace sdn_frames

#endif  // SDN_FOUNDATION_FRAMES_RTN_CURVILINEAR_HPP
