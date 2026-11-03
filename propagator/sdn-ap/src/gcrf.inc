// -----------------------------------------------------------------------------
// fit's GCRF input frame: IAU 2006/2000A through the pinned ERFA (build.mjs).
//   r_TEME = R3(GAST06 - GMST82) NPB06(TT) r_GCRF
// NPB06 is the classical precession-nutation matrix with frame bias
// (eraPnm06a), GAST06 the IAU 2006/2000A Greenwich apparent sidereal time
// (eraGst06) and GMST82 the angle TEME is defined by (gmst(), the one the
// module's Earth-fixed frames use), so GCRF -> TEME -> Earth-fixed equals
// GCRF -> Earth-fixed by GAST06. UT1 = UTC and the pole at its mean position,
// as without $EOP. TT = UTC + Delta AT + 32.184 s (eraUtctai, eraTaitt with
// ERFA's leap-second table). Velocities take the same rotation: the matrix
// turns at precession-nutation rates (< 1e-10 rad/s, < 0.01 mm/s in LEO).
// -----------------------------------------------------------------------------

#include "erfa_pinned.h"

namespace sdnap {
namespace frames {

/// The GCRF -> TEME matrix at the UTC Julian date whole + frac. Returns ERFA's
/// status: 0 ok, 1 a date beyond ERFA's leap-second table (dubious), -1 refused.
inline int gcrf_to_teme(double whole, double frac, double m[3][3]) {
  double tai1, tai2, tt1, tt2;
  const int j = eraUtctai(whole, frac, &tai1, &tai2);
  if (j < 0) return -1;
  eraTaitt(tai1, tai2, &tt1, &tt2);
  eraPnm06a(tt1, tt2, m);
  const double gast = eraGst06(whole, frac, tt1, tt2, m);
  eraRz(gast - gmst(whole, frac), m);
  return j;
}

inline void apply(const double m[3][3], const double* in, double* out) {
  for (int i = 0; i < 3; ++i) out[i] = m[i][0] * in[0] + m[i][1] * in[1] + m[i][2] * in[2];
}

inline void apply_transpose(const double m[3][3], const double* in, double* out) {
  for (int i = 0; i < 3; ++i) out[i] = m[0][i] * in[0] + m[1][i] * in[1] + m[2][i] * in[2];
}

/// AP (SPEC 16.4): for the branches whose mean elements hold epoch axes,
/// carry the state to TEME of date. The nonresonant long-period branch does
/// not take this correction; xp_init selects that policy once for fit and flight.
/// The rotation is M(t) M(t0)^T, with M linear between 12 h nodes
/// (the matrix turns about 1e-7 rad between them; the shortest nutation term of note is 5 days), held per thread.
inline bool drift_node(int64_t k, double out[3][3]) {
  struct Slot { int64_t key; double m[3][3]; };
  static thread_local Slot cache[64];
  Slot& s = cache[static_cast<uint64_t>(k) % 64];
  if (s.key != k) {
    const double whole = std::floor(static_cast<double>(k) / 2.0), frac = (static_cast<double>(k) - 2.0 * whole) / 2.0;
    if (gcrf_to_teme(whole, frac, s.m) < 0) return false;
    s.key = k;
  }
  std::memcpy(out, s.m, sizeof s.m);
  return true;
}

inline bool drift_matrix(double jd_whole, double jd_frac, double m[3][3]) {
  const double half = 2.0 * jd_whole + 2.0 * jd_frac;
  const double base = std::floor(half);
  const double x = half - base;
  double a[3][3], b[3][3];
  if (!drift_node(static_cast<int64_t>(base), a) || !drift_node(static_cast<int64_t>(base) + 1, b)) return false;
  for (int i = 0; i < 3; ++i)
    for (int j = 0; j < 3; ++j) m[i][j] = (1.0 - x) * a[i][j] + x * b[i][j];
  return true;
}

inline void teme_drift(double epoch_whole, double epoch_frac, double t_minutes, double r[3], double v[3]) {
  double m0[3][3], m1[3][3];
  if (!drift_matrix(epoch_whole, epoch_frac, m0) || !drift_matrix(epoch_whole, epoch_frac + t_minutes / 1440.0, m1)) return;
  double in[3], ri[3], vi[3];
  apply_transpose(m0, r, in);
  apply(m1, in, ri);
  apply_transpose(m0, v, in);
  apply(m1, in, vi);
  for (int i = 0; i < 3; ++i) { r[i] = ri[i]; v[i] = vi[i]; }
}

/// The IAU 2006 frame bias B (GCRS -> mean equator and equinox of J2000, EME2000) as eraBp06 forms it:
/// eraFw2m of the Fukushima-Williams angles at J2000.0 TT (eraPfw06). r_EME2000 = B r_GCRF.
inline void frame_bias(double rb[3][3]) {
  double gamb, phib, psib, epsa;
  eraPfw06(ERFA_DJM0, ERFA_DJM00, &gamb, &phib, &psib, &epsa);
  eraFw2m(gamb, phib, psib, epsa, rb);
}

}  // namespace frames
}  // namespace sdnap
