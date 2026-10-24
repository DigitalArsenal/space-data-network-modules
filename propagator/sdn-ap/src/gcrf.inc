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

/// The IAU 2006 frame bias B (GCRS -> mean equator and equinox of J2000, EME2000) as eraBp06 forms it:
/// eraFw2m of the Fukushima-Williams angles at J2000.0 TT (eraPfw06). r_EME2000 = B r_GCRF.
inline void frame_bias(double rb[3][3]) {
  double gamb, phib, psib, epsa;
  eraPfw06(ERFA_DJM0, ERFA_DJM00, &gamb, &phib, &psib, &epsa);
  eraFw2m(gamb, phib, psib, epsa, rb);
}

inline void apply(const double m[3][3], const double* in, double* out) {
  for (int i = 0; i < 3; ++i) out[i] = m[i][0] * in[0] + m[i][1] * in[1] + m[i][2] * in[2];
}

inline void apply_transpose(const double m[3][3], const double* in, double* out) {
  for (int i = 0; i < 3; ++i) out[i] = m[0][i] * in[0] + m[1][i] * in[1] + m[2][i] * in[2];
}

}  // namespace frames
}  // namespace sdnap
