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
struct DriftNodeSlot {
  int64_t key_p1;
  double m[3][3];
};
struct DriftEpochSlot {
  double w, f;
  uint8_t valid;
  double m[3][3];
};
struct alignas(16) DriftSpanSlot {
  alignas(16) double c0[2], c1[2], c2[2];
  alignas(16) double dc0[2], dc1[2], dc2[2];
  double ra[3][3], dr[3][3];
  double w, f;
  int64_t base_p1;
  uint8_t valid;
};
inline thread_local DriftNodeSlot* g_drift_node_cache_ptr = nullptr;
inline DriftNodeSlot* drift_node_cache() {
  if (__builtin_expect(!g_drift_node_cache_ptr, 0)) g_drift_node_cache_ptr = new DriftNodeSlot[2048]{};
  return g_drift_node_cache_ptr;
}
inline thread_local DriftEpochSlot g_drift_epoch_slot{};
inline thread_local DriftSpanSlot g_drift_mat_slot{};
inline thread_local DriftSpanSlot g_drift_vec_slot{};

inline bool drift_node(int64_t k, double out[3][3]) {
  DriftNodeSlot& s = drift_node_cache()[static_cast<uint64_t>(k) & 2047u];
  const int64_t kp1 = k + 1;
  if (s.key_p1 != kp1) {
    const double whole = std::floor(static_cast<double>(k) / 2.0), frac = (static_cast<double>(k) - 2.0 * whole) / 2.0;
    if (gcrf_to_teme(whole, frac, s.m) < 0) return false;
    s.key_p1 = kp1;
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

inline bool drift_epoch_matrix(double epoch_whole, double epoch_frac, double out[3][3]) {
  DriftEpochSlot& s = g_drift_epoch_slot;
  if (!s.valid || s.w != epoch_whole || s.f != epoch_frac) {
    if (!drift_matrix(epoch_whole, epoch_frac, s.m)) return false;
    s.w = epoch_whole;
    s.f = epoch_frac;
    s.valid = 1;
  }
  std::memcpy(out, s.m, sizeof s.m);
  return true;
}

inline bool fill_drift_span(DriftSpanSlot& s, double epoch_whole, double epoch_frac, int64_t bkey) {
  double m0[3][3], a[3][3], b[3][3];
  if (!drift_epoch_matrix(epoch_whole, epoch_frac, m0) || !drift_node(bkey, a) || !drift_node(bkey + 1, b)) return false;
  for (int i = 0; i < 3; ++i) {
    for (int j = 0; j < 3; ++j) {
      const double raij = a[i][0] * m0[j][0] + a[i][1] * m0[j][1] + a[i][2] * m0[j][2];
      const double rbij = b[i][0] * m0[j][0] + b[i][1] * m0[j][1] + b[i][2] * m0[j][2];
      s.ra[i][j] = raij;
      s.dr[i][j] = rbij - raij;
    }
  }
  s.c0[0] = s.ra[0][0]; s.c0[1] = s.ra[1][0];
  s.c1[0] = s.ra[0][1]; s.c1[1] = s.ra[1][1];
  s.c2[0] = s.ra[0][2]; s.c2[1] = s.ra[1][2];
  s.dc0[0] = s.dr[0][0]; s.dc0[1] = s.dr[1][0];
  s.dc1[0] = s.dr[0][1]; s.dc1[1] = s.dr[1][1];
  s.dc2[0] = s.dr[0][2]; s.dc2[1] = s.dr[1][2];
  s.w = epoch_whole;
  s.f = epoch_frac;
  s.base_p1 = bkey + 1;
  s.valid = 1;
  return true;
}

inline bool teme_drift_matrix(double epoch_whole, double epoch_frac, double t_minutes, double R[3][3]) {
  DriftSpanSlot& s = g_drift_mat_slot;
  const double half = 2.0 * epoch_whole + 2.0 * (epoch_frac + t_minutes * (1.0 / 1440.0));
  const double bfloor = std::floor(half);
  const int64_t bkey = static_cast<int64_t>(bfloor);
  if (!s.valid || s.base_p1 != bkey + 1 || s.w != epoch_whole || s.f != epoch_frac) {
    if (!fill_drift_span(s, epoch_whole, epoch_frac, bkey)) return false;
  }
  const double x = half - bfloor;
  const double* pa = &s.ra[0][0];
  const double* pd = &s.dr[0][0];
  double* pr = &R[0][0];
  for (int q = 0; q < 9; ++q) pr[q] = pa[q] + x * pd[q];
  return true;
}

inline void apply_drift(const double R[3][3], double r[3], double v[3]) {
  const double r0 = r[0], r1 = r[1], r2 = r[2];
  const double v0 = v[0], v1 = v[1], v2 = v[2];
#ifdef __wasm_simd128__
  const v128_t col0 = wasm_f64x2_make(R[0][0], R[1][0]);
  const v128_t col1 = wasm_f64x2_make(R[0][1], R[1][1]);
  const v128_t col2 = wasm_f64x2_make(R[0][2], R[1][2]);
  wasm_v128_store(r, wasm_f64x2_add(wasm_f64x2_add(wasm_f64x2_mul(col0, wasm_f64x2_splat(r0)),
                                                   wasm_f64x2_mul(col1, wasm_f64x2_splat(r1))),
                                    wasm_f64x2_mul(col2, wasm_f64x2_splat(r2))));
  wasm_v128_store(v, wasm_f64x2_add(wasm_f64x2_add(wasm_f64x2_mul(col0, wasm_f64x2_splat(v0)),
                                                   wasm_f64x2_mul(col1, wasm_f64x2_splat(v1))),
                                    wasm_f64x2_mul(col2, wasm_f64x2_splat(v2))));
  r[2] = R[2][0] * r0 + R[2][1] * r1 + R[2][2] * r2;
  v[2] = R[2][0] * v0 + R[2][1] * v1 + R[2][2] * v2;
#else
  r[0] = R[0][0] * r0 + R[0][1] * r1 + R[0][2] * r2;
  r[1] = R[1][0] * r0 + R[1][1] * r1 + R[1][2] * r2;
  r[2] = R[2][0] * r0 + R[2][1] * r1 + R[2][2] * r2;
  v[0] = R[0][0] * v0 + R[0][1] * v1 + R[0][2] * v2;
  v[1] = R[1][0] * v0 + R[1][1] * v1 + R[1][2] * v2;
  v[2] = R[2][0] * v0 + R[2][1] * v1 + R[2][2] * v2;
#endif
}

inline void teme_drift(double epoch_whole, double epoch_frac, double t_minutes, double r[3], double v[3]) {
  DriftSpanSlot& s = g_drift_vec_slot;
  const double half = 2.0 * epoch_whole + 2.0 * (epoch_frac + t_minutes * (1.0 / 1440.0));
  const double bfloor = std::floor(half);
  const int64_t bkey = static_cast<int64_t>(bfloor);
  if (__builtin_expect(!s.valid || s.base_p1 != bkey + 1 || s.w != epoch_whole || s.f != epoch_frac, 0)) {
    if (!fill_drift_span(s, epoch_whole, epoch_frac, bkey)) return;
  }
  const double x = half - bfloor;
#ifdef __wasm_simd128__
  const v128_t vx = wasm_f64x2_splat(x);
  const v128_t col0 = wasm_f64x2_add(wasm_v128_load(s.c0), wasm_f64x2_mul(vx, wasm_v128_load(s.dc0)));
  const v128_t col1 = wasm_f64x2_add(wasm_v128_load(s.c1), wasm_f64x2_mul(vx, wasm_v128_load(s.dc1)));
  const v128_t col2 = wasm_f64x2_add(wasm_v128_load(s.c2), wasm_f64x2_mul(vx, wasm_v128_load(s.dc2)));
  const double r0 = r[0], r1 = r[1], r2 = r[2];
  const double v0 = v[0], v1 = v[1], v2 = v[2];
  wasm_v128_store(r, wasm_f64x2_add(wasm_f64x2_add(wasm_f64x2_mul(col0, wasm_f64x2_splat(r0)),
                                                   wasm_f64x2_mul(col1, wasm_f64x2_splat(r1))),
                                    wasm_f64x2_mul(col2, wasm_f64x2_splat(r2))));
  wasm_v128_store(v, wasm_f64x2_add(wasm_f64x2_add(wasm_f64x2_mul(col0, wasm_f64x2_splat(v0)),
                                                   wasm_f64x2_mul(col1, wasm_f64x2_splat(v1))),
                                    wasm_f64x2_mul(col2, wasm_f64x2_splat(v2))));
  const double r20 = s.ra[2][0] + x * s.dr[2][0];
  const double r21 = s.ra[2][1] + x * s.dr[2][1];
  const double r22 = s.ra[2][2] + x * s.dr[2][2];
  r[2] = r20 * r0 + r21 * r1 + r22 * r2;
  v[2] = r20 * v0 + r21 * v1 + r22 * v2;
#else
  double R[3][3];
  const double* pa = &s.ra[0][0];
  const double* pd = &s.dr[0][0];
  double* pr = &R[0][0];
  for (int q = 0; q < 9; ++q) pr[q] = pa[q] + x * pd[q];
  apply_drift(R, r, v);
#endif
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
